// src/server/cursor.ts
//
// Persistent cursor for boundedWatch — design per ADR-0017 (Proposed).
//
// State machine: idle → leased → committed | dlq.
// Delivery: at-least-once with idempotency-key dedup (Debezium pattern).
// Cursor advance is ATOMIC with status flip to committed — no time-based
// commit, ever (RisingWave#25071 lesson).
//
// Two CursorStore implementations are planned:
// - makeInMemoryCursorStore (this file): for fast tests + ephemeral flows.
// - makePostgresCursorStore (next PR): production durable store + restart smoke.

export type CursorStatus = "idle" | "leased" | "committed" | "dlq";

export interface CursorRow {
  watcher_id: string;
  last_processed_pk: string;
  last_processed_at: string;
  idempotency_key: string;
  status: CursorStatus;
  lease_holder: string | null;
  heartbeat_at: string | null;
  lease_expires_at: string | null;
  attempts: number;
}

export interface CursorAdvance {
  last_processed_pk: string;
  last_processed_at: string;
  idempotency_key: string;
}

export interface AcquireResult {
  acquired: boolean;
  row: CursorRow;
}

export interface HeartbeatResult {
  ok: boolean;
}

export interface CommitResult {
  ok: boolean;
  deduped: boolean;
  reason?: "non_monotonic" | "wrong_holder" | "no_lease" | "dlq_terminal";
}

export interface ReleaseResult {
  ok: boolean;
}

export interface CursorStore {
  /** Read the current cursor row, or null if no row exists for this watcher_id. */
  read(watcher_id: string): Promise<CursorRow | null>;

  /**
   * Acquire a soft-lock lease. Succeeds from idle, expired-lease, or same-holder
   * (idempotent renewal). Fails when a different holder holds an unexpired lease,
   * or status is dlq (terminal). On success, returns the leased row.
   */
  acquire(watcher_id: string, lease_holder: string, lease_ttl_ms: number): Promise<AcquireResult>;

  /**
   * Refresh heartbeat_at + lease_expires_at. Only valid for the current
   * lease_holder. Fails if no lease or wrong holder.
   */
  heartbeat(watcher_id: string, lease_holder: string): Promise<HeartbeatResult>;

  /**
   * Atomically advance the cursor + flip status to committed. Same-holder only.
   * Monotonic last_processed_pk required (lexicographic compare; operator must
   * choose serialization that sorts correctly — ULID, ISO timestamp, padded int).
   * If idempotency_key matches the current row's idempotency_key, returns
   * { ok: true, deduped: true } with no advance (the dedup case).
   */
  commit(watcher_id: string, lease_holder: string, advance: CursorAdvance): Promise<CommitResult>;

  /**
   * Release the lease and set the next status. 'idle' for graceful return,
   * 'dlq' for terminal failure. Same-holder only.
   */
  release(
    watcher_id: string,
    lease_holder: string,
    status: "idle" | "dlq",
    reason?: string,
  ): Promise<ReleaseResult>;
}

export interface InMemoryCursorStoreConfig {
  /** Injectable for lease-expiry tests. Defaults to () => new Date(). */
  now?: () => Date;
}

/**
 * In-memory CursorStore — for fast tests and stateless-mode-with-cursor flows
 * where durability is not required. Production deployments use the Postgres
 * variant (ships separately with restart-smoke verification).
 *
 * Implements the state machine documented in ADR-0017:
 *   idle → leased → committed | dlq
 * Delivery: at-least-once with idempotency-key dedup.
 * Cursor advance is atomic with status flip to committed.
 */
export function makeInMemoryCursorStore(config: InMemoryCursorStoreConfig = {}): CursorStore {
  const now = config.now ?? (() => new Date());
  const rows = new Map<string, CursorRow>();

  const leaseExpired = (row: CursorRow): boolean => {
    if (!row.lease_expires_at) return true;
    return Date.parse(row.lease_expires_at) <= now().getTime();
  };

  const emptyRow = (watcher_id: string): CursorRow => ({
    watcher_id,
    last_processed_pk: "",
    last_processed_at: "",
    idempotency_key: "",
    status: "idle",
    lease_holder: null,
    heartbeat_at: null,
    lease_expires_at: null,
    attempts: 0,
  });

  return {
    async read(watcher_id) {
      return rows.get(watcher_id) ?? null;
    },

    async acquire(watcher_id, lease_holder, lease_ttl_ms) {
      const ts = now();
      const expiresAt = new Date(ts.getTime() + lease_ttl_ms).toISOString();
      const heartbeatAt = ts.toISOString();
      const existing = rows.get(watcher_id);

      if (!existing) {
        const row: CursorRow = {
          ...emptyRow(watcher_id),
          status: "leased",
          lease_holder,
          heartbeat_at: heartbeatAt,
          lease_expires_at: expiresAt,
        };
        rows.set(watcher_id, row);
        return { acquired: true, row };
      }

      if (existing.status === "dlq") {
        return { acquired: false, row: existing };
      }

      // Same holder: idempotent renewal
      if (existing.lease_holder === lease_holder) {
        const row: CursorRow = {
          ...existing,
          status: "leased",
          lease_holder,
          heartbeat_at: heartbeatAt,
          lease_expires_at: expiresAt,
        };
        rows.set(watcher_id, row);
        return { acquired: true, row };
      }

      // Different holder with valid (unexpired) lease: deny
      if (existing.lease_holder !== null && !leaseExpired(existing)) {
        return { acquired: false, row: existing };
      }

      // No lease OR expired lease: steal (preserves cursor state)
      const row: CursorRow = {
        ...existing,
        status: "leased",
        lease_holder,
        heartbeat_at: heartbeatAt,
        lease_expires_at: expiresAt,
      };
      rows.set(watcher_id, row);
      return { acquired: true, row };
    },

    async heartbeat(watcher_id, lease_holder) {
      const existing = rows.get(watcher_id);
      if (!existing || existing.lease_holder !== lease_holder) {
        return { ok: false };
      }

      // Compute the original ttl from the existing lease window so
      // heartbeat extends by the same duration (not by a hardcoded value).
      const originalTtl =
        existing.heartbeat_at && existing.lease_expires_at
          ? Date.parse(existing.lease_expires_at) - Date.parse(existing.heartbeat_at)
          : 0;
      const ts = now();
      const row: CursorRow = {
        ...existing,
        heartbeat_at: ts.toISOString(),
        lease_expires_at: new Date(ts.getTime() + originalTtl).toISOString(),
      };
      rows.set(watcher_id, row);
      return { ok: true };
    },

    async commit(watcher_id, lease_holder, advance) {
      const existing = rows.get(watcher_id);
      if (existing?.status === "dlq") {
        return { ok: false, deduped: false, reason: "dlq_terminal" };
      }
      if (!existing || existing.lease_holder === null) {
        return { ok: false, deduped: false, reason: "no_lease" };
      }
      if (existing.lease_holder !== lease_holder) {
        return { ok: false, deduped: false, reason: "wrong_holder" };
      }

      // Dedup: same idempotency_key as last commit → no advance, ok+deduped.
      if (existing.idempotency_key !== "" && existing.idempotency_key === advance.idempotency_key) {
        return { ok: true, deduped: true };
      }

      // Monotonic guard (lexicographic). Empty existing pk = first commit, allow.
      if (
        existing.last_processed_pk !== "" &&
        advance.last_processed_pk <= existing.last_processed_pk
      ) {
        return { ok: false, deduped: false, reason: "non_monotonic" };
      }

      // Atomic advance + status flip + attempts reset.
      const row: CursorRow = {
        ...existing,
        last_processed_pk: advance.last_processed_pk,
        last_processed_at: advance.last_processed_at,
        idempotency_key: advance.idempotency_key,
        status: "committed",
        attempts: 0,
      };
      rows.set(watcher_id, row);
      return { ok: true, deduped: false };
    },

    async release(watcher_id, lease_holder, status, _reason) {
      const existing = rows.get(watcher_id);
      if (!existing || existing.lease_holder !== lease_holder) {
        return { ok: false };
      }
      const row: CursorRow = {
        ...existing,
        status,
        lease_holder: null,
        heartbeat_at: null,
        lease_expires_at: null,
      };
      rows.set(watcher_id, row);
      return { ok: true };
    },
  };
}
