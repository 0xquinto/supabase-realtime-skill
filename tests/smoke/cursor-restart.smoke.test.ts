// tests/smoke/cursor-restart.smoke.test.ts
//
// Substrate-level GREEN test for ADR-0017's makePostgresCursorStore.
// (The unit-level FAIL→PASS pair was captured in PR #30 against
// makeInMemoryCursorStore; this smoke is GREEN-only at the substrate
// layer — no RED state was authored here, and claiming "FAIL→PASS
// pair" for this file would be discipline-as-headline drift.)
//
// Validates that cursor state survives an "isolate restart" (modeled as
// a lease holder change after lease expiry) against real Postgres.
//
// Requires EVAL_HOST_DB_URL (host project's pooler URL). Skips cleanly when
// absent. The host project's `public` schema is empty by default (per
// CLAUDE.md); the smoke creates and drops its own temp cursor table inline.
//
// Cost: ~10-11s wall (two 1.5s sleeps for lease expiry + ~9 transactions).

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CursorStore, makePostgresCursorStore } from "../../src/server/cursor.ts";

const HOST_DB_URL = process.env.EVAL_HOST_DB_URL;
const SHOULD_RUN = !!HOST_DB_URL;

const W = `cursor-restart-smoke-${Date.now()}`;
const H1 = "isolate-A";
const H2 = "isolate-B";
const TABLE = `realtime_skill_cursors_smoke_${Date.now()}`;

function advance(pk: string, key: string) {
  return {
    last_processed_pk: pk,
    last_processed_at: new Date().toISOString(),
    idempotency_key: key,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let sql: ReturnType<typeof postgres>;
let store: CursorStore;

describe.skipIf(!SHOULD_RUN)("Postgres CursorStore — restart smoke (ADR-0017)", () => {
  beforeAll(async () => {
    sql = postgres(HOST_DB_URL as string, { max: 5 });
    await sql.unsafe(`
      create table if not exists "${TABLE}" (
        watcher_id text primary key,
        last_processed_pk text not null default '',
        last_processed_at timestamptz,
        idempotency_key text not null default '',
        status text not null default 'idle' check (status in ('idle','leased','committed','dlq')),
        lease_holder text,
        heartbeat_at timestamptz,
        lease_expires_at timestamptz,
        attempts integer not null default 0,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
    `);
    store = makePostgresCursorStore({ client: sql, table: TABLE });
  }, 30_000);

  afterAll(async () => {
    if (sql) {
      await sql.unsafe(`drop table if exists "${TABLE}"`);
      await sql.end();
    }
  });

  it("preserves cursor state across an expired-lease takeover (the headline)", async () => {
    // Phase 1: H1 acquires a SHORT lease (1s) and commits 3 events.
    const a1 = await store.acquire(W, H1, 1_000);
    expect(a1.acquired).toBe(true);
    expect(a1.row.status).toBe("leased");
    expect(a1.row.lease_holder).toBe(H1);

    expect((await store.commit(W, H1, advance("pk-001", "k-001"))).ok).toBe(true);
    expect((await store.commit(W, H1, advance("pk-002", "k-002"))).ok).toBe(true);
    const c3 = await store.commit(W, H1, advance("pk-003", "k-003"));
    expect(c3.ok).toBe(true);
    expect(c3.deduped).toBe(false);

    // Phase 2: simulate isolate death — DON'T release; let lease expire.
    await sleep(1_500);

    // Phase 3: H2 acquires (steals expired lease). Cursor state must survive.
    const a2 = await store.acquire(W, H2, 30_000);
    expect(a2.acquired).toBe(true);
    expect(a2.row.lease_holder).toBe(H2);
    expect(a2.row.last_processed_pk).toBe("pk-003"); // SURVIVES RESTART
    expect(a2.row.idempotency_key).toBe("k-003");

    // Phase 4: H2 attempts a non-monotonic commit — must be rejected even
    // though the holder changed (monotonic guard is across-holder).
    const cBad = await store.commit(W, H2, advance("pk-002", "k-replay"));
    expect(cBad.ok).toBe(false);
    expect(cBad.reason).toBe("non_monotonic");

    // Phase 5: H2 commits 2 more events — success, cursor advances normally.
    expect((await store.commit(W, H2, advance("pk-004", "k-004"))).ok).toBe(true);
    expect((await store.commit(W, H2, advance("pk-005", "k-005"))).ok).toBe(true);

    // Phase 6: final state.
    const final = await store.read(W);
    expect(final?.last_processed_pk).toBe("pk-005");
    expect(final?.idempotency_key).toBe("k-005");
    expect(final?.status).toBe("committed");
    expect(final?.lease_holder).toBe(H2);

    // Cleanup for this test (next test uses a different watcher_id).
    expect((await store.release(W, H2, "idle")).ok).toBe(true);
  }, 60_000);

  it("dedups idempotency_key replay across an expired-lease takeover", async () => {
    // The at-least-once recovery story: H1 commits k-1, lease expires before
    // H1 could ack to its action callback's downstream. H2 takes over, sees
    // the same event again (Realtime replay or queue-redrain), tries to
    // commit k-1 — must be deduped, NOT advanced.
    const W2 = `${W}-dedup`;

    const a1 = await store.acquire(W2, H1, 1_000);
    expect(a1.acquired).toBe(true);
    expect((await store.commit(W2, H1, advance("pk-A", "k-A"))).ok).toBe(true);

    await sleep(1_500);

    const a2 = await store.acquire(W2, H2, 30_000);
    expect(a2.acquired).toBe(true);
    expect(a2.row.idempotency_key).toBe("k-A");

    // Same idempotency_key — must dedup (no advance), NOT trip the monotonic
    // guard (which would surface a different reason).
    const replay = await store.commit(W2, H2, advance("pk-A-prime", "k-A"));
    expect(replay.ok).toBe(true);
    expect(replay.deduped).toBe(true);

    // Cursor state unchanged after dedup.
    const after = await store.read(W2);
    expect(after?.last_processed_pk).toBe("pk-A");
    expect(after?.idempotency_key).toBe("k-A");

    // H2 advances normally with a new key.
    expect((await store.commit(W2, H2, advance("pk-B", "k-B"))).ok).toBe(true);
    const final = await store.read(W2);
    expect(final?.last_processed_pk).toBe("pk-B");

    expect((await store.release(W2, H2, "idle")).ok).toBe(true);
  }, 60_000);

  it("denies a fresh holder when lease is still valid", async () => {
    const W3 = `${W}-busy`;

    const a1 = await store.acquire(W3, H1, 30_000);
    expect(a1.acquired).toBe(true);

    // Different holder, lease NOT expired — must fail.
    const a2 = await store.acquire(W3, H2, 30_000);
    expect(a2.acquired).toBe(false);
    expect(a2.row.lease_holder).toBe(H1);

    expect((await store.release(W3, H1, "idle")).ok).toBe(true);
  }, 30_000);
});
