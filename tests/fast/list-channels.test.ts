import { describe, expect, it } from "vitest";
import { handleListChannels } from "../../src/server/list-channels.ts";

describe("handleListChannels", () => {
  it("returns the registry's channels with member counts", async () => {
    const result = await handleListChannels(
      {},
      {
        registry: async () => [
          { name: "agent:triage:urgent", member_count: 2, last_event_at: "2026-04-30T00:00:00Z" },
          { name: "agent:handoff", member_count: 0, last_event_at: null },
        ],
      },
    );
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0]?.name).toBe("agent:triage:urgent");
  });

  it("returns empty list when registry is empty (not an error)", async () => {
    const result = await handleListChannels({}, { registry: async () => [] });
    expect(result.channels).toEqual([]);
  });
});
