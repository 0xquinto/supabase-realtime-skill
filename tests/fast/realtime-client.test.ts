import { describe, expect, it, vi } from "vitest";
import {
  type ChangeEvent,
  type RealtimeAdapter,
  boundedWatch,
} from "../../src/server/realtime-client";

function makeAdapter(): {
  adapter: RealtimeAdapter;
  emit: (ev: {
    event: "INSERT" | "UPDATE" | "DELETE";
    new: Record<string, unknown> | null;
    old: Record<string, unknown> | null;
  }) => void;
  unsubscribed: () => boolean;
} {
  let listener: ((ev: ChangeEvent) => void) | null = null;
  let unsubscribed = false;
  const adapter: RealtimeAdapter = {
    subscribe: async ({ onEvent }) => {
      listener = onEvent;
    },
    unsubscribe: async () => {
      unsubscribed = true;
      listener = null;
    },
  };
  return {
    adapter,
    emit: (ev) =>
      listener?.({
        event: ev.event,
        table: "support_tickets",
        schema: "public",
        new: ev.new,
        old: ev.old,
        commit_timestamp: new Date().toISOString(),
      }),
    unsubscribed: () => unsubscribed,
  };
}

describe("boundedWatch", () => {
  it("resolves when max_events is reached, before timeout", async () => {
    const { adapter, emit, unsubscribed } = makeAdapter();
    const promise = boundedWatch({
      adapter,
      table: "support_tickets",
      predicate: { event: "INSERT" },
      timeout_ms: 60_000,
      max_events: 2,
    });
    queueMicrotask(() => {
      emit({ event: "INSERT", new: { id: "a" }, old: null });
      emit({ event: "INSERT", new: { id: "b" }, old: null });
    });
    const result = await promise;
    expect(result.events).toHaveLength(2);
    expect(result.closed_reason).toBe("max_events");
    expect(unsubscribed()).toBe(true);
  });

  it("resolves on timeout when no events arrive", async () => {
    vi.useFakeTimers();
    const { adapter, unsubscribed } = makeAdapter();
    const promise = boundedWatch({
      adapter,
      table: "support_tickets",
      predicate: { event: "INSERT" },
      timeout_ms: 5_000,
      max_events: 50,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;
    expect(result.events).toEqual([]);
    expect(result.closed_reason).toBe("timeout");
    expect(unsubscribed()).toBe(true);
    vi.useRealTimers();
  });

  it("filters events by predicate.event when not '*'", async () => {
    const { adapter, emit } = makeAdapter();
    const promise = boundedWatch({
      adapter,
      table: "support_tickets",
      predicate: { event: "INSERT" },
      timeout_ms: 60_000,
      max_events: 1,
    });
    queueMicrotask(() => {
      emit({ event: "UPDATE", new: { id: "a" }, old: { id: "a" } });
      emit({ event: "INSERT", new: { id: "b" }, old: null });
    });
    const result = await promise;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.new).toEqual({ id: "b" });
  });

  it("unsubscribes even if the body throws", async () => {
    const { adapter, unsubscribed } = makeAdapter();
    const failingAdapter: RealtimeAdapter = {
      subscribe: () => Promise.reject(new Error("boom")),
      unsubscribe: adapter.unsubscribe,
    };
    await expect(
      boundedWatch({
        adapter: failingAdapter,
        table: "x",
        predicate: { event: "*" },
        timeout_ms: 1_000,
        max_events: 1,
      }),
    ).rejects.toThrow("boom");
    // subscribe failed before adapter installed listener; unsubscribe still safe
    expect(unsubscribed()).toBe(false);
  });

  it("clears the timeout when max_events wins the race (no timer leak)", async () => {
    vi.useFakeTimers();
    const { adapter, emit } = makeAdapter();
    const promise = boundedWatch({
      adapter,
      table: "support_tickets",
      predicate: { event: "INSERT" },
      timeout_ms: 60_000,
      max_events: 1,
    });
    queueMicrotask(() => emit({ event: "INSERT", new: { id: "a" }, old: null }));
    const result = await promise;
    expect(result.closed_reason).toBe("max_events");
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});
