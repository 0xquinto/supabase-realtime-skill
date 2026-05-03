// src/server/cursor.ts
//
// Persistent cursor for boundedWatch — design per ADR-0017 (Proposed).
//
// State machine: idle → leased → committed | dlq.
// Delivery: at-least-once with idempotency-key dedup (Debezium pattern).
// Cursor advance is ATOMIC with status flip to committed — no time-based
// commit, ever (RisingWave#25071 lesson).
//
// Two CursorStore implementations:
// - makeInMemoryCursorStore: for fast tests + ephemeral flows (in-process Map).
// - makePostgresCursorStore: production durable store backed by the
//   realtime_skill_cursors table (see supabase/migrations/20260503000001_*).
//   Uses transactional SELECT … FOR UPDATE so concurrent isolates can't
//   race lease acquisition.

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

// ---------------------------------------------------------------------------
// Postgres-backed CursorStore — production durable store.
// ---------------------------------------------------------------------------

// Minimal subset of the postgres-js Sql interface we use. Defining this here
// avoids a hard `import postgres` in the server bundle (postgres-js is a smoke-
// test-side dependency, not an Edge runtime one). Operators who want this
// adapter will already have postgres-js available in their stack.
interface PgSql {
  // Tagged template — postgres-js spec returns rows as a Promise-like array.
  // The `unknown` row type forces operators to validate at the callsite.
  // biome-ignore lint/suspicious/noExplicitAny: postgres-js' tag returns a thenable that resolves to row arrays
  (strings: TemplateStringsArray, ...values: any[]): Promise<unknown[]> & { [key: string]: any };
  // Identifier escaping helper: sql(tableName) interpolates as a quoted identifier.
  // biome-ignore lint/suspicious/noExplicitAny: postgres-js' identifier helper accepts strings and returns an opaque marker
  (value: string): any;
  // Transactional helper. The callback receives a transaction-bound sql instance.
  begin<T>(callback: (tx: PgSql) => Promise<T>): Promise<T>;
}

export interface PostgresCursorStoreConfig {
  /** A postgres-js Sql instance (created via `postgres(connectionUrl)`). */
  client: PgSql;
  /** Cursor table name. Must match the migration's table (default: realtime_skill_cursors). */
  table: string;
  /** Injectable for tests. Defaults to () => new Date(). */
  now?: () => Date;
}

interface DbCursorRow {
  watcher_id: string;
  last_processed_pk: string | null;
  last_processed_at: Date | string | null;
  idempotency_key: string | null;
  status: CursorStatus;
  lease_holder: string | null;
  heartbeat_at: Date | string | null;
  lease_expires_at: Date | string | null;
  attempts: number;
}

function tsToIso(value: Date | string | null): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function dbRowToCursorRow(row: DbCursorRow): CursorRow {
  return {
    watcher_id: row.watcher_id,
    last_processed_pk: row.last_processed_pk ?? "",
    last_processed_at: tsToIso(row.last_processed_at) ?? "",
    idempotency_key: row.idempotency_key ?? "",
    status: row.status,
    lease_holder: row.lease_holder,
    heartbeat_at: tsToIso(row.heartbeat_at),
    lease_expires_at: tsToIso(row.lease_expires_at),
    attempts: row.attempts,
  };
}

/**
 * Production CursorStore backed by Postgres. Wraps every state transition in
 * an explicit transaction with `SELECT … FOR UPDATE` so concurrent isolates
 * can't race lease acquisition. Schema: see
 * supabase/migrations/20260503000001_realtime_skill_cursors.sql.
 */
export function makePostgresCursorStore(config: PostgresCursorStoreConfig): CursorStore {
  const { client, table } = config;
  const now = config.now ?? (() => new Date());

  return {
    async read(watcher_id) {
      const rows = (await client`
        select * from ${client(table)} where watcher_id = ${watcher_id}
      `) as DbCursorRow[];
      return rows.length > 0 ? dbRowToCursorRow(rows[0] as DbCursorRow) : null;
    },

    async acquire(watcher_id, lease_holder, lease_ttl_ms) {
      return await client.begin<AcquireResult>(async (sql) => {
        // Idempotent first-create. Concurrent first-creates: one wins, the
        // other gets DO NOTHING and proceeds to FOR UPDATE on the winner's row.
        await sql`
          insert into ${sql(table)} (watcher_id, status, attempts)
          values (${watcher_id}, 'idle', 0)
          on conflict (watcher_id) do nothing
        `;

        const lockedRows = (await sql`
          select * from ${sql(table)} where watcher_id = ${watcher_id} for update
        `) as DbCursorRow[];
        const existing = lockedRows[0] as DbCursorRow;

        if (existing.status === "dlq") {
          return { acquired: false, row: dbRowToCursorRow(existing) };
        }

        const sameHolder = existing.lease_holder === lease_holder;
        const expired =
          existing.lease_expires_at === null ||
          new Date(existing.lease_expires_at).getTime() <= now().getTime();
        const noLease = existing.lease_holder === null;

        if (sameHolder || noLease || expired) {
          const ts = now();
          const expiresAt = new Date(ts.getTime() + lease_ttl_ms);
          const updated = (await sql`
            update ${sql(table)} set
              status = 'leased',
              lease_holder = ${lease_holder},
              heartbeat_at = ${ts.toISOString()},
              lease_expires_at = ${expiresAt.toISOString()},
              updated_at = ${ts.toISOString()}
            where watcher_id = ${watcher_id}
            returning *
          `) as DbCursorRow[];
          return { acquired: true, row: dbRowToCursorRow(updated[0] as DbCursorRow) };
        }

        return { acquired: false, row: dbRowToCursorRow(existing) };
      });
    },

    async heartbeat(watcher_id, lease_holder) {
      return await client.begin<HeartbeatResult>(async (sql) => {
        const lockedRows = (await sql`
          select * from ${sql(table)} where watcher_id = ${watcher_id} for update
        `) as DbCursorRow[];
        const existing = lockedRows[0] as DbCursorRow | undefined;

        if (!existing || existing.lease_holder !== lease_holder) {
          return { ok: false };
        }

        const originalTtlMs =
          existing.heartbeat_at && existing.lease_expires_at
            ? new Date(existing.lease_expires_at).getTime() -
              new Date(existing.heartbeat_at).getTime()
            : 0;
        const ts = now();
        const newExpiresAt = new Date(ts.getTime() + originalTtlMs);

        await sql`
          update ${sql(table)} set
            heartbeat_at = ${ts.toISOString()},
            lease_expires_at = ${newExpiresAt.toISOString()},
            updated_at = ${ts.toISOString()}
          where watcher_id = ${watcher_id}
        `;
        return { ok: true };
      });
    },

    async commit(watcher_id, lease_holder, advance) {
      return await client.begin<CommitResult>(async (sql) => {
        const lockedRows = (await sql`
          select * from ${sql(table)} where watcher_id = ${watcher_id} for update
        `) as DbCursorRow[];
        const existing = lockedRows[0] as DbCursorRow | undefined;

        if (existing?.status === "dlq") {
          return { ok: false, deduped: false, reason: "dlq_terminal" };
        }
        if (!existing || existing.lease_holder === null) {
          return { ok: false, deduped: false, reason: "no_lease" };
        }
        if (existing.lease_holder !== lease_holder) {
          return { ok: false, deduped: false, reason: "wrong_holder" };
        }

        const existingKey = existing.idempotency_key ?? "";
        if (existingKey !== "" && existingKey === advance.idempotency_key) {
          return { ok: true, deduped: true };
        }

        const existingPk = existing.last_processed_pk ?? "";
        if (existingPk !== "" && advance.last_processed_pk <= existingPk) {
          return { ok: false, deduped: false, reason: "non_monotonic" };
        }

        const ts = now();
        await sql`
          update ${sql(table)} set
            last_processed_pk = ${advance.last_processed_pk},
            last_processed_at = ${advance.last_processed_at},
            idempotency_key = ${advance.idempotency_key},
            status = 'committed',
            attempts = 0,
            updated_at = ${ts.toISOString()}
          where watcher_id = ${watcher_id}
        `;
        return { ok: true, deduped: false };
      });
    },

    async release(watcher_id, lease_holder, status, _reason) {
      return await client.begin<ReleaseResult>(async (sql) => {
        const lockedRows = (await sql`
          select * from ${sql(table)} where watcher_id = ${watcher_id} for update
        `) as DbCursorRow[];
        const existing = lockedRows[0] as DbCursorRow | undefined;

        if (!existing || existing.lease_holder !== lease_holder) {
          return { ok: false };
        }

        const ts = now();
        await sql`
          update ${sql(table)} set
            status = ${status},
            lease_holder = null,
            heartbeat_at = null,
            lease_expires_at = null,
            updated_at = ${ts.toISOString()}
          where watcher_id = ${watcher_id}
        `;
        return { ok: true };
      });
    },
  };
}
