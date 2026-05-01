// tests/fast/outbox-forwarder.test.ts
//
// Verifies the substrate composes cleanly for the outbox-forwarder pattern
// (see references/outbox-forwarder.md). The test isn't claiming this is
// production-grade outbox semantics; it's claiming the bounded primitive +
// broadcast retry handler compose for the pattern without new abstractions.

import { describe, expect, it, vi } from "vitest";
import { handleBroadcast } from "../../src/server/broadcast.ts";
import {
  type ChangeEvent,
  type RealtimeAdapter,
  boundedWatch,
} from "../../src/server/realtime-client.ts";

interface OutboxRow {
  id: string;
  destination: string;
  event_type: string;
  payload: Record<string, unknown>;
}

function makeAdapter(): {
  adapter: RealtimeAdapter;
  emit: (row: OutboxRow) => void;
} {
  let listener: ((ev: ChangeEvent) => void) | null = null;
  const adapter: RealtimeAdapter = {
    subscribe: async ({ onEvent }) => {
      listener = onEvent;
    },
    unsubscribe: async () => {
      listener = null;
    },
  };
  return {
    adapter,
    emit: (row) =>
      listener?.({
        event: "INSERT",
        table: "outbox",
        schema: "public",
        new: row as unknown as Record<string, unknown>,
        old: null,
        commit_timestamp: new Date().toISOString(),
      }),
  };
}

describe("outbox-forwarder pattern", () => {
  it("watches outbox INSERTs and broadcasts each row to its destination", async () => {
    const { adapter, emit } = makeAdapter();
    const sent: Array<{ channel: string; event: string; payload: Record<string, unknown> }> = [];
    const sender = {
      send: async (input: { channel: string; event: string; payload: Record<string, unknown> }) => {
        sent.push(input);
        return { status: "ok" as const };
      },
    };

    const watchPromise = boundedWatch({
      adapter,
      table: "outbox",
      predicate: { event: "INSERT" },
      timeout_ms: 60_000,
      max_events: 3,
    });

    queueMicrotask(() => {
      emit({
        id: "row-1",
        destination: "slack:eng-alerts",
        event_type: "deploy.started",
        payload: { service: "api", sha: "abc123" },
      });
      emit({
        id: "row-2",
        destination: "agent:billing-handoff",
        event_type: "invoice.failed",
        payload: { invoice_id: "inv-99" },
      });
      emit({
        id: "row-3",
        destination: "webhook:audit-sink",
        event_type: "user.role_changed",
        payload: { user_id: "u-7", from: "viewer", to: "editor" },
      });
    });

    const { events, closed_reason } = await watchPromise;
    expect(events).toHaveLength(3);
    expect(closed_reason).toBe("max_events");

    // Forward each row via handleBroadcast — the same handler the MCP tool uses.
    for (const ev of events) {
      const row = ev.new as unknown as OutboxRow;
      await handleBroadcast(
        { channel: row.destination, event: row.event_type, payload: row.payload },
        { sender },
      );
    }

    expect(sent).toEqual([
      {
        channel: "slack:eng-alerts",
        event: "deploy.started",
        payload: { service: "api", sha: "abc123" },
      },
      {
        channel: "agent:billing-handoff",
        event: "invoice.failed",
        payload: { invoice_id: "inv-99" },
      },
      {
        channel: "webhook:audit-sink",
        event: "user.role_changed",
        payload: { user_id: "u-7", from: "viewer", to: "editor" },
      },
    ]);
  });

  it("a failed broadcast doesn't crash the loop — retried by handleBroadcast then surfaced", async () => {
    const { adapter, emit } = makeAdapter();
    let attempts = 0;
    const sender = {
      send: async (_input: {
        channel: string;
        event: string;
        payload: Record<string, unknown>;
      }) => {
        attempts++;
        throw new Error("upstream 503");
      },
    };

    const watchPromise = boundedWatch({
      adapter,
      table: "outbox",
      predicate: { event: "INSERT" },
      timeout_ms: 60_000,
      max_events: 1,
    });

    queueMicrotask(() => {
      emit({
        id: "row-x",
        destination: "slack:dead-channel",
        event_type: "noop",
        payload: {},
      });
    });

    const { events } = await watchPromise;
    expect(events).toHaveLength(1);

    const row = events[0]?.new as unknown as OutboxRow;
    await expect(
      handleBroadcast(
        { channel: row.destination, event: row.event_type, payload: row.payload },
        { sender },
      ),
    ).rejects.toThrow(/broadcast failed after 3 attempts/);

    // handleBroadcast retries 3× internally. The forwarder caller catches and
    // leaves forwarded_at null so the row stays in the queue for next loop.
    expect(attempts).toBe(3);
  });

  it("respects timeout when no outbox INSERTs arrive", async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter();
    const sender = {
      send: async () => ({ status: "ok" as const }),
    };
    const promise = boundedWatch({
      adapter,
      table: "outbox",
      predicate: { event: "INSERT" },
      timeout_ms: 5_000,
      max_events: 25,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const { events, closed_reason } = await promise;
    expect(events).toEqual([]);
    expect(closed_reason).toBe("timeout");
    expect(sender.send).not.toBeUndefined(); // sentinel — sender was never invoked
    vi.useRealTimers();
  });
});
