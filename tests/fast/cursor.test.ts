// tests/fast/cursor.test.ts
//
// RED test scaffold for ADR-0017 (Proposed). Asserts the cursor state-machine
// invariants documented in docs/decisions/0017-bounded-watch-cursor.md.
//
// Until the impl lands (next PR), the stub at src/server/cursor.ts throws on
// every method. Every test in this file SHOULD FAIL with that error — that's
// the deliberate RED state of the FAIL→fix→PASS discipline (per CLAUDE.md).
// When the impl ships, no tests in this file change; they all turn green.
//
// State machine recap:
//   idle → leased → committed | dlq
// Delivery: at-least-once with idempotency-key dedup.
// Cursor advance is ATOMIC with status flip to committed (RisingWave#25071).

import { describe, expect, it } from "vitest";
import { type CursorStore, makeInMemoryCursorStore } from "../../src/server/cursor.ts";

const W1 = "watcher-1";
const W2 = "watcher-2";
const H1 = "holder-1";
const H2 = "holder-2";

function freshStore(now?: () => Date): CursorStore {
  return makeInMemoryCursorStore(now ? { now } : {});
}

function advance(pk: string, key: string, at?: string) {
  return {
    last_processed_pk: pk,
    last_processed_at: at ?? "2026-05-03T00:00:00Z",
    idempotency_key: key,
  };
}

describe("CursorStore — read", () => {
  it("returns null for an unknown watcher_id (no row exists)", async () => {
    const store = freshStore();
    const row = await store.read(W1);
    expect(row).toBeNull();
  });
});

describe("CursorStore — acquire", () => {
  it("succeeds from no-row state (creates new row, sets lease_holder)", async () => {
    const store = freshStore();
    const r = await store.acquire(W1, H1, 30_000);
    expect(r.acquired).toBe(true);
    expect(r.row.lease_holder).toBe(H1);
    expect(r.row.status).toBe("leased");
  });

  it("idempotent for same holder — renews heartbeat + expires_at", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    const r = await store.acquire(W1, H1, 30_000);
    expect(r.acquired).toBe(true);
    expect(r.row.lease_holder).toBe(H1);
  });

  it("fails when a different holder owns an unexpired lease", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    const r = await store.acquire(W1, H2, 30_000);
    expect(r.acquired).toBe(false);
  });

  it("succeeds (steals) when a different holder's lease is expired", async () => {
    let nowMs = Date.parse("2026-05-03T00:00:00Z");
    const store = freshStore(() => new Date(nowMs));
    await store.acquire(W1, H1, 1_000);
    nowMs += 5_000;
    const r = await store.acquire(W1, H2, 30_000);
    expect(r.acquired).toBe(true);
    expect(r.row.lease_holder).toBe(H2);
  });

  it("fails when status is dlq (terminal)", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    await store.release(W1, H1, "dlq", "max_attempts");
    const r = await store.acquire(W1, H1, 30_000);
    expect(r.acquired).toBe(false);
  });

  it("isolates watchers — acquire on W1 does not affect W2", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    const r = await store.acquire(W2, H1, 30_000);
    expect(r.acquired).toBe(true);
  });
});

describe("CursorStore — heartbeat", () => {
  it("succeeds for the current lease_holder", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    const r = await store.heartbeat(W1, H1);
    expect(r.ok).toBe(true);
  });

  it("fails for a different holder", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    const r = await store.heartbeat(W1, H2);
    expect(r.ok).toBe(false);
  });

  it("fails when no lease is held", async () => {
    const store = freshStore();
    const r = await store.heartbeat(W1, H1);
    expect(r.ok).toBe(false);
  });

  it("extends lease_expires_at into the future", async () => {
    let nowMs = Date.parse("2026-05-03T00:00:00Z");
    const store = freshStore(() => new Date(nowMs));
    await store.acquire(W1, H1, 10_000);
    nowMs += 5_000;
    await store.heartbeat(W1, H1);
    nowMs += 7_000;
    const r = await store.acquire(W1, H2, 30_000);
    expect(r.acquired).toBe(false);
  });
});

describe("CursorStore — commit", () => {
  it("advances cursor + flips to committed on first commit", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    const r = await store.commit(W1, H1, advance("pk-001", "k-001"));
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(false);
    const row = await store.read(W1);
    expect(row?.last_processed_pk).toBe("pk-001");
    expect(row?.idempotency_key).toBe("k-001");
    expect(row?.status).toBe("committed");
  });

  it("dedups when same idempotency_key arrives twice", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    await store.commit(W1, H1, advance("pk-001", "k-001"));
    const r = await store.commit(W1, H1, advance("pk-001", "k-001"));
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);
  });

  it("rejects non-monotonic last_processed_pk regression", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    await store.commit(W1, H1, advance("pk-002", "k-002"));
    const r = await store.commit(W1, H1, advance("pk-001", "k-003"));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("non_monotonic");
  });

  it("fails for a different holder", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    const r = await store.commit(W1, H2, advance("pk-001", "k-001"));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("wrong_holder");
  });

  it("fails when no lease is held", async () => {
    const store = freshStore();
    const r = await store.commit(W1, H1, advance("pk-001", "k-001"));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("no_lease");
  });

  it("monotonic check uses lexicographic order (operator owns serialization)", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    await store.commit(W1, H1, advance("000010", "k-1"));
    const r = await store.commit(W1, H1, advance("000020", "k-2"));
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(false);
  });

  it("resets attempts to 0 on successful commit", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    await store.commit(W1, H1, advance("pk-001", "k-001"));
    const row = await store.read(W1);
    expect(row?.attempts).toBe(0);
  });
});

describe("CursorStore — release", () => {
  it("releases to idle when status='idle' (clears lease)", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    const r = await store.release(W1, H1, "idle");
    expect(r.ok).toBe(true);
    const row = await store.read(W1);
    expect(row?.status).toBe("idle");
    expect(row?.lease_holder).toBeNull();
    expect(row?.heartbeat_at).toBeNull();
    expect(row?.lease_expires_at).toBeNull();
  });

  it("releases to dlq when status='dlq' (terminal)", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    const r = await store.release(W1, H1, "dlq", "max_attempts_exceeded");
    expect(r.ok).toBe(true);
    const row = await store.read(W1);
    expect(row?.status).toBe("dlq");
  });

  it("fails for a different holder", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    const r = await store.release(W1, H2, "idle");
    expect(r.ok).toBe(false);
  });

  it("fails when no lease is held", async () => {
    const store = freshStore();
    const r = await store.release(W1, H1, "idle");
    expect(r.ok).toBe(false);
  });
});

describe("CursorStore — restart resume (the headline behavior)", () => {
  it("after release-to-idle and re-acquire, last_processed_pk is preserved", async () => {
    const store = freshStore();
    await store.acquire(W1, H1, 30_000);
    await store.commit(W1, H1, advance("pk-005", "k-005"));
    await store.release(W1, H1, "idle");
    const r = await store.acquire(W1, H2, 30_000);
    expect(r.acquired).toBe(true);
    expect(r.row.last_processed_pk).toBe("pk-005");
    expect(r.row.idempotency_key).toBe("k-005");
  });

  it("after expired-lease steal, last_processed_pk survives", async () => {
    let nowMs = Date.parse("2026-05-03T00:00:00Z");
    const store = freshStore(() => new Date(nowMs));
    await store.acquire(W1, H1, 1_000);
    await store.commit(W1, H1, advance("pk-007", "k-007"));
    nowMs += 5_000;
    const r = await store.acquire(W1, H2, 30_000);
    expect(r.acquired).toBe(true);
    expect(r.row.last_processed_pk).toBe("pk-007");
  });
});
