// tests/fast/queue-drain.test.ts
//
// Fast tests for boundedQueueDrain. One `it` per ci-fast seed fixture
// (fixtures/ci-fast/queue-drain/qd00N-*.json) plus a small set of
// behavior-specific unit tests not directly representable in the fixture
// schema (predicate forwarding, ack-failure bucketing, read_row-failure
// bucketing, dead_letter-callback-throws bucketing).
//
// The fixture runner that lands later (ADR-0010 § Migration step 5)
// re-uses the same fake-adapter + fake-sender shape; this file is the
// implementation-property test, the eval runner is the methodology gate.

import { describe, expect, it, vi } from "vitest";
import type { BroadcastSender } from "../../src/server/broadcast.ts";
import { boundedQueueDrain } from "../../src/server/queue-drain.ts";
import type { ChangeEvent, RealtimeAdapter } from "../../src/server/realtime-client.ts";

// ---------------------------------------------------------------------------
// Fixture-row shape (matches fixtures/ci-fast/queue-drain/*.json)
// ---------------------------------------------------------------------------

interface FixtureRow {
  id: string;
  destination: string;
  event_type: string;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fakes — same shape outbox-forwarder.test.ts uses
// ---------------------------------------------------------------------------

function makeAdapter(): {
  adapter: RealtimeAdapter;
  emit: (row: FixtureRow) => void;
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
        table: "queue",
        schema: "public",
        new: row as unknown as Record<string, unknown>,
        old: null,
        commit_timestamp: new Date().toISOString(),
      }),
  };
}

const readRow = (ev: ChangeEvent) => {
  const row = ev.new as unknown as FixtureRow;
  return { destination: row.destination, event: row.event_type, payload: row.payload };
};

/** Sender that records every send and behaves per a programmable plan. */
function makeSender(plan: {
  permanently_fail_destinations?: string[];
  fail_first_n_attempts_for_row?: { id: string; n: number };
  permanently_fail_row_ids?: string[];
}): { sender: BroadcastSender; sent: Array<{ channel: string; event: string }> } {
  const sent: Array<{ channel: string; event: string }> = [];
  const failingRowAttempts = new Map<string, number>();
  const sender: BroadcastSender = {
    send: async (input) => {
      const rowId = (input.payload as Record<string, unknown>)._row_id as string | undefined;
      if (plan.permanently_fail_destinations?.includes(input.channel)) {
        throw new Error(`destination ${input.channel} unreachable`);
      }
      if (rowId && plan.permanently_fail_row_ids?.includes(rowId)) {
        throw new Error(`row ${rowId} permanently fails`);
      }
      if (rowId && plan.fail_first_n_attempts_for_row?.id === rowId) {
        const seen = failingRowAttempts.get(rowId) ?? 0;
        failingRowAttempts.set(rowId, seen + 1);
        if (seen < plan.fail_first_n_attempts_for_row.n) {
          throw new Error(`transient failure attempt ${seen + 1}`);
        }
      }
      sent.push({ channel: input.channel, event: input.event });
      return { status: "ok" as const };
    },
  };
  return { sender, sent };
}

// ---------------------------------------------------------------------------
// Tests — one per ci-fast seed (qd001…qd007)
// ---------------------------------------------------------------------------

describe("boundedQueueDrain — ci-fast seed fixtures", () => {
  it("qd001 clean drain: 3 rows all succeed, all forwarded, max_events trips", async () => {
    const { adapter, emit } = makeAdapter();
    const { sender, sent } = makeSender({});
    const acked: string[] = [];
    const dlq: string[] = [];

    const rows: FixtureRow[] = [
      {
        id: "row-1",
        destination: "slack:eng-deploys",
        event_type: "deploy.started",
        payload: { _row_id: "row-1", service: "api" },
      },
      {
        id: "row-2",
        destination: "slack:eng-deploys",
        event_type: "deploy.completed",
        payload: { _row_id: "row-2", service: "api" },
      },
      {
        id: "row-3",
        destination: "webhook:audit-sink",
        event_type: "user.role_changed",
        payload: { _row_id: "row-3", user_id: "u-7" },
      },
    ];

    const drainPromise = boundedQueueDrain({
      adapter,
      table: "queue",
      read_row: readRow,
      ack: async (ev) => {
        acked.push((ev.new as unknown as FixtureRow).id);
      },
      dead_letter: async (ev) => {
        dlq.push((ev.new as unknown as FixtureRow).id);
      },
      sender,
      timeout_ms: 5000,
      max_events: 3,
    });

    queueMicrotask(() => {
      for (const r of rows) emit(r);
    });

    const result = await drainPromise;

    expect(result.forwarded).toBe(3);
    expect(result.dead_lettered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.closed_reason).toBe("max_events");
    expect(sent).toHaveLength(3);
    expect(acked).toEqual(["row-1", "row-2", "row-3"]);
    expect(dlq).toEqual([]);
  });

  it("qd002 poison row → dead_letter callback fires", async () => {
    const { adapter, emit } = makeAdapter();
    const { sender, sent } = makeSender({
      permanently_fail_destinations: ["slack:channel-was-deleted"],
    });
    const acked: string[] = [];
    const dlq: string[] = [];

    vi.useFakeTimers();
    const drainPromise = boundedQueueDrain({
      adapter,
      table: "queue",
      read_row: readRow,
      ack: async (ev) => {
        acked.push((ev.new as unknown as FixtureRow).id);
      },
      dead_letter: async (ev) => {
        dlq.push((ev.new as unknown as FixtureRow).id);
      },
      sender,
      timeout_ms: 5000,
      max_events: 5,
    });

    queueMicrotask(() => {
      emit({
        id: "row-poison",
        destination: "slack:channel-was-deleted",
        event_type: "deploy.started",
        payload: { _row_id: "row-poison", service: "ghost-svc" },
      });
    });

    // handleBroadcast retries 3× with 200/400ms backoff before throwing.
    // Then we still wait out boundedWatch's timeout before drain returns.
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await drainPromise;

    expect(result.forwarded).toBe(0);
    expect(result.dead_lettered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.closed_reason).toBe("timeout");
    expect(sent).toHaveLength(0);
    expect(acked).toEqual([]);
    expect(dlq).toEqual(["row-poison"]);
    vi.useRealTimers();
  });

  it("qd003 poison row, no DLQ → row counted as failed", async () => {
    const { adapter, emit } = makeAdapter();
    const { sender, sent } = makeSender({
      permanently_fail_destinations: ["webhook:returns-503-forever"],
    });
    const acked: string[] = [];

    vi.useFakeTimers();
    const drainPromise = boundedQueueDrain({
      adapter,
      table: "queue",
      read_row: readRow,
      ack: async (ev) => {
        acked.push((ev.new as unknown as FixtureRow).id);
      },
      // no dead_letter callback
      sender,
      timeout_ms: 5000,
      max_events: 5,
    });

    queueMicrotask(() => {
      emit({
        id: "row-poison",
        destination: "webhook:returns-503-forever",
        event_type: "audit.entry",
        payload: { _row_id: "row-poison", actor: "u-1" },
      });
    });

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await drainPromise;

    expect(result.forwarded).toBe(0);
    expect(result.dead_lettered).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.closed_reason).toBe("timeout");
    expect(sent).toHaveLength(0);
    expect(acked).toEqual([]);
    vi.useRealTimers();
  });

  it("qd004 transient failure → retry-success via handleBroadcast's 3 retries", async () => {
    const { adapter, emit } = makeAdapter();
    const { sender, sent } = makeSender({
      fail_first_n_attempts_for_row: { id: "row-flaky", n: 2 },
    });
    const acked: string[] = [];
    const dlq: string[] = [];

    vi.useFakeTimers();
    const drainPromise = boundedQueueDrain({
      adapter,
      table: "queue",
      read_row: readRow,
      ack: async (ev) => {
        acked.push((ev.new as unknown as FixtureRow).id);
      },
      dead_letter: async (ev) => {
        dlq.push((ev.new as unknown as FixtureRow).id);
      },
      sender,
      timeout_ms: 10_000,
      max_events: 1,
    });

    queueMicrotask(() => {
      emit({
        id: "row-flaky",
        destination: "webhook:flaky-upstream",
        event_type: "billing.invoice_finalized",
        payload: { _row_id: "row-flaky", invoice_id: "inv-123" },
      });
    });

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await drainPromise;

    expect(result.forwarded).toBe(1);
    expect(result.dead_lettered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.closed_reason).toBe("max_events");
    expect(sent).toHaveLength(1);
    expect(acked).toEqual(["row-flaky"]);
    expect(dlq).toEqual([]);
    vi.useRealTimers();
  });

  it("qd005 timeout, no rows arrive → all counters zero, closed_reason=timeout", async () => {
    vi.useFakeTimers();
    const { adapter } = makeAdapter();
    const { sender, sent } = makeSender({});
    const ack = vi.fn(async () => {});

    const drainPromise = boundedQueueDrain({
      adapter,
      table: "queue",
      read_row: readRow,
      ack,
      dead_letter: async () => {},
      sender,
      timeout_ms: 1000,
      max_events: 10,
    });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await drainPromise;

    expect(result.forwarded).toBe(0);
    expect(result.dead_lettered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.closed_reason).toBe("timeout");
    expect(sent).toHaveLength(0);
    expect(ack).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("qd006 max_events cap respected: 5 rows arrive but only 2 drain", async () => {
    const { adapter, emit } = makeAdapter();
    const { sender, sent } = makeSender({});
    const acked: string[] = [];

    const drainPromise = boundedQueueDrain({
      adapter,
      table: "queue",
      read_row: readRow,
      ack: async (ev) => {
        acked.push((ev.new as unknown as FixtureRow).id);
      },
      dead_letter: async () => {},
      sender,
      timeout_ms: 5000,
      max_events: 2,
    });

    queueMicrotask(() => {
      for (let i = 1; i <= 5; i++) {
        emit({
          id: `row-${i}`,
          destination: "agent:triage-handoff",
          event_type: "ticket.created",
          payload: { _row_id: `row-${i}`, ticket_id: `t-${100 + i}` },
        });
      }
    });

    const result = await drainPromise;

    expect(result.forwarded).toBe(2);
    expect(result.dead_lettered).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.closed_reason).toBe("max_events");
    expect(sent).toHaveLength(2);
    expect(acked).toEqual(["row-1", "row-2"]);
  });

  it("qd007 mixed: success + poison → DLQ + success — loop doesn't abort mid-drain", async () => {
    const { adapter, emit } = makeAdapter();
    const { sender, sent } = makeSender({
      permanently_fail_destinations: ["slack:dead-channel"],
    });
    const acked: string[] = [];
    const dlq: string[] = [];

    const drainPromise = boundedQueueDrain({
      adapter,
      table: "queue",
      read_row: readRow,
      ack: async (ev) => {
        acked.push((ev.new as unknown as FixtureRow).id);
      },
      dead_letter: async (ev) => {
        dlq.push((ev.new as unknown as FixtureRow).id);
      },
      sender,
      timeout_ms: 30_000, // long enough for handleBroadcast's retry backoff with real timers
      max_events: 3,
    });

    queueMicrotask(() => {
      emit({
        id: "row-good-1",
        destination: "slack:eng",
        event_type: "deploy.started",
        payload: { _row_id: "row-good-1" },
      });
      emit({
        id: "row-poison",
        destination: "slack:dead-channel",
        event_type: "deploy.started",
        payload: { _row_id: "row-poison" },
      });
      emit({
        id: "row-good-2",
        destination: "slack:eng",
        event_type: "deploy.completed",
        payload: { _row_id: "row-good-2" },
      });
    });

    const result = await drainPromise;

    expect(result.forwarded).toBe(2);
    expect(result.dead_lettered).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.closed_reason).toBe("max_events");
    expect(sent).toHaveLength(2);
    expect(acked).toEqual(["row-good-1", "row-good-2"]);
    expect(dlq).toEqual(["row-poison"]);
  }, 35_000);
});

// ---------------------------------------------------------------------------
// Behavior-specific unit tests not directly representable in the fixture schema
// ---------------------------------------------------------------------------

describe("boundedQueueDrain — module-property tests", () => {
  it("predicate defaults to { event: 'INSERT' } when not provided", async () => {
    const { adapter, emit } = makeAdapter();
    const { sender, sent } = makeSender({});

    const drainPromise = boundedQueueDrain({
      adapter,
      table: "queue",
      // no predicate
      read_row: readRow,
      ack: async () => {},
      sender,
      timeout_ms: 5000,
      max_events: 1,
    });

    queueMicrotask(() => {
      emit({
        id: "row-1",
        destination: "slack:any",
        event_type: "x",
        payload: { _row_id: "row-1" },
      });
    });

    const result = await drainPromise;
    expect(result.forwarded).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("ack-failure post-broadcast → bucketed as failed (at-least-once contract)", async () => {
    const { adapter, emit } = makeAdapter();
    const { sender, sent } = makeSender({});

    const drainPromise = boundedQueueDrain({
      adapter,
      table: "queue",
      read_row: readRow,
      ack: async () => {
        throw new Error("storage layer down");
      },
      sender,
      timeout_ms: 5000,
      max_events: 1,
    });

    queueMicrotask(() => {
      emit({
        id: "row-1",
        destination: "slack:any",
        event_type: "x",
        payload: { _row_id: "row-1" },
      });
    });

    const result = await drainPromise;
    expect(result.forwarded).toBe(0);
    expect(result.dead_lettered).toBe(0);
    expect(result.failed).toBe(1);
    expect(sent).toHaveLength(1); // broadcast did succeed; row will be re-forwarded next loop
  });

  it("read_row throwing → bucketed as failed without attempting broadcast", async () => {
    const { adapter, emit } = makeAdapter();
    const { sender, sent } = makeSender({});

    const drainPromise = boundedQueueDrain({
      adapter,
      table: "queue",
      read_row: () => {
        throw new Error("malformed row schema");
      },
      ack: async () => {},
      sender,
      timeout_ms: 5000,
      max_events: 1,
    });

    queueMicrotask(() => {
      emit({
        id: "row-bad",
        destination: "slack:any",
        event_type: "x",
        payload: { _row_id: "row-bad" },
      });
    });

    const result = await drainPromise;
    expect(result.failed).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("dead_letter callback throwing → bucketed as failed (no double-counting in DLQ)", async () => {
    const { adapter, emit } = makeAdapter();
    const { sender } = makeSender({
      permanently_fail_destinations: ["slack:dead"],
    });

    vi.useFakeTimers();
    const drainPromise = boundedQueueDrain({
      adapter,
      table: "queue",
      read_row: readRow,
      ack: async () => {},
      dead_letter: async () => {
        throw new Error("DLQ table full");
      },
      sender,
      timeout_ms: 5000,
      max_events: 1,
    });

    queueMicrotask(() => {
      emit({
        id: "row-poison",
        destination: "slack:dead",
        event_type: "x",
        payload: { _row_id: "row-poison" },
      });
    });

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await drainPromise;
    expect(result.dead_lettered).toBe(0);
    expect(result.failed).toBe(1);
    vi.useRealTimers();
  });
});
