import { describe, expect, it } from "vitest";
import type { ChangeEvent, RealtimeAdapter } from "../../src/server/realtime-client.ts";
import { handleWatchTable } from "../../src/server/watch-table.ts";

function fakeAdapter(events: ChangeEvent[]): RealtimeAdapter {
  return {
    subscribe: async ({ onEvent }) => {
      queueMicrotask(() => {
        for (const ev of events) onEvent(ev);
      });
    },
    unsubscribe: async () => {},
  };
}

describe("handleWatchTable", () => {
  it("returns events that match the predicate", async () => {
    const adapter = fakeAdapter([
      {
        event: "INSERT",
        table: "support_tickets",
        schema: "public",
        new: { id: "1" },
        old: null,
        commit_timestamp: "2026-04-30T00:00:00Z",
      },
    ]);
    const result = await handleWatchTable(
      { table: "support_tickets", predicate: { event: "INSERT" }, timeout_ms: 1000, max_events: 1 },
      { adapterFor: () => adapter },
    );
    expect(result.events).toHaveLength(1);
    expect(result.closed_reason).toBe("max_events");
  });

  it("rejects timeout_ms over the 120000 cap with TIMEOUT_EXCEEDED_CAP", async () => {
    await expect(
      handleWatchTable(
        {
          table: "x",
          predicate: { event: "*" },
          timeout_ms: 120_001,
          max_events: 1,
        } as unknown as Parameters<typeof handleWatchTable>[0],
        { adapterFor: () => fakeAdapter([]) },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT_EXCEEDED_CAP" });
  });
});
