// tests/fast/bounded-watch-cursor-integration.test.ts
//
// Integration tests for ADR-0017's optional cursor parameter on boundedWatch.
// Mirrors the FAIL→PASS shape: this PR adds the integration, this file
// validates the lease + filter + commit + release behavior end-to-end at
// the unit level (mock CursorStore + mock RealtimeAdapter).
//
// Substrate-level validation of the underlying CursorStore lives in
// tests/smoke/cursor-restart.smoke.test.ts (PR #31).

import { describe, expect, it, vi } from "vitest";
import { type CursorStore, makeInMemoryCursorStore } from "../../src/server/cursor.ts";
import {
  BoundedWatchCursorError,
  type ChangeEvent,
  type RealtimeAdapter,
  boundedWatch,
} from "../../src/server/realtime-client.ts";

const TABLE = "support_tickets";
const W = "watcher-int";
const H1 = "isolate-A";
const H2 = "isolate-B";

function makeAdapter(): {
  adapter: RealtimeAdapter;
  emit: (ev: ChangeEvent) => void;
  waitForSubscribe: () => Promise<void>;
  unsubscribed: () => boolean;
} {
  let listener: ((ev: ChangeEvent) => void) | null = null;
  let unsubscribed = false;
  let resolveSubscribed: (() => void) | null = null;
  const subscribed = new Promise<void>((r) => {
    resolveSubscribed = r;
  });
  const adapter: RealtimeAdapter = {
    subscribe: async ({ onEvent }) => {
      listener = onEvent;
      resolveSubscribed?.();
    },
    unsubscribe: async () => {
      unsubscribed = true;
      listener = null;
    },
  };
  return {
    adapter,
    emit: (ev) => listener?.(ev),
    waitForSubscribe: () => subscribed,
    unsubscribed: () => unsubscribed,
  };
}

function makeAdapterThatFailsToSubscribe(): RealtimeAdapter {
  return {
    subscribe: async () => {
      throw new Error("subscribe boom");
    },
    unsubscribe: async () => {},
  };
}

function makeEvent(pk: string): ChangeEvent {
  return {
    event: "INSERT",
    table: TABLE,
    schema: "public",
    new: { id: pk, body: `row-${pk}` },
    old: null,
    commit_timestamp: "2026-05-03T00:00:00Z",
  };
}

const pkFromId = (ev: ChangeEvent) => String((ev.new as { id: string }).id);

describe("boundedWatch — cursor integration (stateless mode unchanged)", () => {
  it("works without cursor — original behavior preserved", async () => {
    const { adapter, emit, waitForSubscribe } = makeAdapter();
    const promise = boundedWatch({
      adapter,
      table: TABLE,
      predicate: { event: "*" },
      max_events: 2,
      timeout_ms: 5_000,
    });
    await waitForSubscribe();
    emit(makeEvent("pk-1"));
    emit(makeEvent("pk-2"));
    const out = await promise;
    expect(out.events).toHaveLength(2);
    expect(out.closed_reason).toBe("max_events");
  });
});

describe("boundedWatch — cursor lease acquisition", () => {
  it("acquires the lease before subscribing", async () => {
    const store = makeInMemoryCursorStore();
    const { adapter, emit, waitForSubscribe } = makeAdapter();
    const promise = boundedWatch({
      adapter,
      table: TABLE,
      predicate: { event: "*" },
      max_events: 1,
      timeout_ms: 5_000,
      cursor: { store, watcher_id: W, lease_holder: H1, pkExtractor: pkFromId },
    });
    await waitForSubscribe();
    emit(makeEvent("pk-1"));
    await promise;
    // After release-to-idle, status is "idle" (not "leased")
    const row = await store.read(W);
    expect(row?.status).toBe("idle");
    expect(row?.lease_holder).toBeNull();
    expect(row?.last_processed_pk).toBe("pk-1");
  });

  it("throws CURSOR_BUSY when a different holder owns an unexpired lease", async () => {
    const store = makeInMemoryCursorStore();
    await store.acquire(W, H2, 30_000); // H2 holds the lease

    const { adapter } = makeAdapter();
    await expect(
      boundedWatch({
        adapter,
        table: TABLE,
        predicate: { event: "*" },
        max_events: 1,
        timeout_ms: 5_000,
        cursor: { store, watcher_id: W, lease_holder: H1, pkExtractor: pkFromId },
      }),
    ).rejects.toMatchObject({
      code: "CURSOR_BUSY",
      name: "BoundedWatchCursorError",
    });
  });

  it("throws CURSOR_DLQ when the cursor is in dlq (terminal)", async () => {
    const store = makeInMemoryCursorStore();
    await store.acquire(W, H1, 30_000);
    await store.release(W, H1, "dlq", "max_attempts");

    const { adapter } = makeAdapter();
    await expect(
      boundedWatch({
        adapter,
        table: TABLE,
        predicate: { event: "*" },
        max_events: 1,
        timeout_ms: 5_000,
        cursor: { store, watcher_id: W, lease_holder: H1, pkExtractor: pkFromId },
      }),
    ).rejects.toMatchObject({ code: "CURSOR_DLQ" });
  });
});

describe("boundedWatch — cursor watermark filter (substrate replay defense)", () => {
  it("filters events whose pk <= cursor.last_processed_pk", async () => {
    // Pre-populate the cursor with last_processed_pk = "pk-005"
    const store = makeInMemoryCursorStore();
    await store.acquire(W, H1, 30_000);
    await store.commit(W, H1, {
      last_processed_pk: "pk-005",
      last_processed_at: "2026-05-03T00:00:00Z",
      idempotency_key: "k-005",
    });
    await store.release(W, H1, "idle");

    const { adapter, emit, waitForSubscribe } = makeAdapter();
    const promise = boundedWatch({
      adapter,
      table: TABLE,
      predicate: { event: "*" },
      max_events: 5,
      timeout_ms: 1_000,
      cursor: { store, watcher_id: W, lease_holder: H2, pkExtractor: pkFromId },
    });
    await waitForSubscribe();
    // Substrate replay (rare but possible): pk-003 + pk-004 + pk-006 + pk-007
    emit(makeEvent("pk-003"));
    emit(makeEvent("pk-004"));
    emit(makeEvent("pk-006"));
    emit(makeEvent("pk-007"));
    const out = await promise;
    // Only pk-006 + pk-007 should survive the filter (003/004 are <= 005).
    expect(out.events.map(pkFromId)).toEqual(["pk-006", "pk-007"]);
  });

  it("does not filter when no prior cursor state (empty watermark)", async () => {
    const store = makeInMemoryCursorStore();
    const { adapter, emit, waitForSubscribe } = makeAdapter();
    const promise = boundedWatch({
      adapter,
      table: TABLE,
      predicate: { event: "*" },
      max_events: 3,
      timeout_ms: 1_000,
      cursor: { store, watcher_id: W, lease_holder: H1, pkExtractor: pkFromId },
    });
    await waitForSubscribe();
    emit(makeEvent("pk-001"));
    emit(makeEvent("pk-002"));
    emit(makeEvent("pk-003"));
    const out = await promise;
    expect(out.events).toHaveLength(3);
  });
});

describe("boundedWatch — commit + release on graceful exit", () => {
  it("commits the highest-PK event seen at end of batch", async () => {
    const store = makeInMemoryCursorStore();
    const { adapter, emit, waitForSubscribe } = makeAdapter();
    const promise = boundedWatch({
      adapter,
      table: TABLE,
      predicate: { event: "*" },
      max_events: 3,
      timeout_ms: 1_000,
      cursor: { store, watcher_id: W, lease_holder: H1, pkExtractor: pkFromId },
    });
    await waitForSubscribe();
    // Out-of-order: highest PK is pk-3, not the last emitted.
    emit(makeEvent("pk-2"));
    emit(makeEvent("pk-3"));
    emit(makeEvent("pk-1"));
    await promise;

    const row = await store.read(W);
    expect(row?.last_processed_pk).toBe("pk-3");
    expect(row?.idempotency_key).toBe("pk-3"); // defaults to pkExtractor
    expect(row?.status).toBe("idle"); // released after commit
  });

  it("uses idempotencyExtractor when supplied", async () => {
    const store = makeInMemoryCursorStore();
    const { adapter, emit, waitForSubscribe } = makeAdapter();
    const idempExtract = (ev: ChangeEvent) => `idemp-${pkFromId(ev)}`;
    const promise = boundedWatch({
      adapter,
      table: TABLE,
      predicate: { event: "*" },
      max_events: 1,
      timeout_ms: 1_000,
      cursor: {
        store,
        watcher_id: W,
        lease_holder: H1,
        pkExtractor: pkFromId,
        idempotencyExtractor: idempExtract,
      },
    });
    await waitForSubscribe();
    emit(makeEvent("pk-9"));
    await promise;

    const row = await store.read(W);
    expect(row?.idempotency_key).toBe("idemp-pk-9");
    expect(row?.last_processed_pk).toBe("pk-9");
  });

  it("does NOT commit when batch has zero events (releases lease only)", async () => {
    const store = makeInMemoryCursorStore();
    const commitSpy = vi.spyOn(store, "commit");
    const { adapter } = makeAdapter();
    const out = await boundedWatch({
      adapter,
      table: TABLE,
      predicate: { event: "*" },
      max_events: 5,
      timeout_ms: 50, // short timeout, no events
      cursor: { store, watcher_id: W, lease_holder: H1, pkExtractor: pkFromId },
    });
    expect(out.events).toHaveLength(0);
    expect(out.closed_reason).toBe("timeout");
    expect(commitSpy).not.toHaveBeenCalled();
    const row = await store.read(W);
    expect(row?.status).toBe("idle"); // released, but no commit
    expect(row?.last_processed_pk).toBe(""); // unchanged
  });
});

describe("boundedWatch — release(dlq) on subscribe failure", () => {
  it("releases the lease to dlq when adapter.subscribe throws", async () => {
    const store = makeInMemoryCursorStore();
    const adapter = makeAdapterThatFailsToSubscribe();
    await expect(
      boundedWatch({
        adapter,
        table: TABLE,
        predicate: { event: "*" },
        max_events: 1,
        timeout_ms: 5_000,
        cursor: { store, watcher_id: W, lease_holder: H1, pkExtractor: pkFromId },
      }),
    ).rejects.toThrow("subscribe boom");

    const row = await store.read(W);
    expect(row?.status).toBe("dlq");
  });
});

describe("boundedWatch — restart resume across calls", () => {
  it("preserves cursor across two boundedWatch calls", async () => {
    const store: CursorStore = makeInMemoryCursorStore();

    // First batch: pk-1, pk-2, pk-3
    const { adapter: a1, emit: emit1, waitForSubscribe: wait1 } = makeAdapter();
    const p1 = boundedWatch({
      adapter: a1,
      table: TABLE,
      predicate: { event: "*" },
      max_events: 3,
      timeout_ms: 1_000,
      cursor: { store, watcher_id: W, lease_holder: H1, pkExtractor: pkFromId },
    });
    await wait1();
    emit1(makeEvent("pk-1"));
    emit1(makeEvent("pk-2"));
    emit1(makeEvent("pk-3"));
    await p1;

    // Second batch (different holder, simulating restart): pk-2 (replay), pk-3 (replay), pk-4, pk-5
    const { adapter: a2, emit: emit2, waitForSubscribe: wait2 } = makeAdapter();
    const p2 = boundedWatch({
      adapter: a2,
      table: TABLE,
      predicate: { event: "*" },
      max_events: 5,
      timeout_ms: 1_000,
      cursor: { store, watcher_id: W, lease_holder: H2, pkExtractor: pkFromId },
    });
    await wait2();
    emit2(makeEvent("pk-2"));
    emit2(makeEvent("pk-3"));
    emit2(makeEvent("pk-4"));
    emit2(makeEvent("pk-5"));
    const out2 = await p2;

    // pk-2 + pk-3 are replays — filtered out. Only pk-4 + pk-5 surface.
    expect(out2.events.map(pkFromId)).toEqual(["pk-4", "pk-5"]);

    const row = await store.read(W);
    expect(row?.last_processed_pk).toBe("pk-5");
  });
});
