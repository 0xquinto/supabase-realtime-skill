// src/server/cursor.ts
//
// Persistent cursor for boundedWatch — design per ADR-0017 (Proposed).
//
// IMPORTANT — this module ships the RED test scaffold for the FAIL→PASS
// discipline (per CLAUDE.md § "FAIL→fix→PASS smoke-test discipline").
// The state machine + types are committed; the in-memory impl is a stub
// that throws so the test suite at tests/fast/cursor.test.ts fails
// meaningfully on every assertion. Impl lands in the next PR.
//
// State machine: idle → leased → committed | dlq.
// Delivery: at-least-once with idempotency-key dedup (Debezium pattern).
// Cursor advance is ATOMIC with status flip to committed — no time-based
// commit, ever (RisingWave#25071 lesson).

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
 * variant.
 *
 * STUB: throws on every method to guarantee the FAIL state of the test
 * scaffold. Real impl lands in the next PR per ADR-0017's predicted-PASS
 * commitment.
 */
export function makeInMemoryCursorStore(_config: InMemoryCursorStoreConfig = {}): CursorStore {
  const notImplemented = (method: string): never => {
    throw new Error(
      `cursor.${method}: ADR-0017 cursor impl not yet shipped — RED test scaffold only. See docs/decisions/0017-bounded-watch-cursor.md.`,
    );
  };

  return {
    read: async (_watcher_id) => notImplemented("read"),
    acquire: async (_watcher_id, _lease_holder, _ttl) => notImplemented("acquire"),
    heartbeat: async (_watcher_id, _lease_holder) => notImplemented("heartbeat"),
    commit: async (_watcher_id, _lease_holder, _advance) => notImplemented("commit"),
    release: async (_watcher_id, _lease_holder, _status, _reason) => notImplemented("release"),
  };
}
