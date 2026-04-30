import { describe, expect, it } from "vitest";
import type { BroadcastAdapter } from "../../src/server/realtime-client.ts";
import { handleSubscribe } from "../../src/server/subscribe.ts";

function fakeAdapter(
  broadcasts: Array<{ event: string; payload: Record<string, unknown> }>,
): BroadcastAdapter {
  return {
    subscribe: async ({ onBroadcast, channel }) => {
      queueMicrotask(() => {
        for (const b of broadcasts) {
          onBroadcast({
            channel,
            event: b.event,
            payload: b.payload,
            received_at: new Date().toISOString(),
          });
        }
      });
    },
    unsubscribe: async () => {},
  };
}

describe("handleSubscribe", () => {
  it("returns broadcasts that match event_filter", async () => {
    const adapter = fakeAdapter([
      { event: "noise", payload: {} },
      { event: "ticket-routed", payload: { id: "1" } },
    ]);
    const result = await handleSubscribe(
      {
        channel: "agent:triage:urgent",
        event_filter: "ticket-routed",
        timeout_ms: 1000,
        max_events: 1,
      },
      { adapterFor: () => adapter },
    );
    expect(result.broadcasts).toHaveLength(1);
    expect(result.broadcasts[0]?.event).toBe("ticket-routed");
    expect(result.closed_reason).toBe("max_events");
  });

  it("returns closed_reason: timeout when no broadcast arrives in time", async () => {
    // adapter that subscribes successfully but never emits
    const idleAdapter: BroadcastAdapter = {
      subscribe: async () => {},
      unsubscribe: async () => {},
    };
    const result = await handleSubscribe(
      {
        channel: "agent:triage:urgent",
        timeout_ms: 1000,
        max_events: 5,
      },
      { adapterFor: () => idleAdapter },
    );
    expect(result.broadcasts).toHaveLength(0);
    expect(result.closed_reason).toBe("timeout");
  });

  it("rejects timeout_ms over the 120000 cap with TIMEOUT_EXCEEDED_CAP", async () => {
    await expect(
      handleSubscribe(
        {
          channel: "x",
          timeout_ms: 120_001,
          max_events: 1,
        } as unknown as Parameters<typeof handleSubscribe>[0],
        { adapterFor: () => fakeAdapter([]) },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT_EXCEEDED_CAP" });
  });
});
