import { describe, expect, it } from "vitest";
import {
  BroadcastInputSchema,
  DescribeTableInputSchema,
  ListChannelsInputSchema,
  SubscribeChannelInputSchema,
  WatchTableInputSchema,
} from "../../src/types/schemas.ts";

describe("WatchTableInputSchema", () => {
  it("accepts a minimal valid input", () => {
    const result = WatchTableInputSchema.safeParse({
      table: "support_tickets",
      predicate: { event: "INSERT" },
    });
    expect(result.success).toBe(true);
  });

  it("applies defaults for timeout_ms and max_events", () => {
    const result = WatchTableInputSchema.parse({
      table: "support_tickets",
      predicate: { event: "INSERT" },
    });
    expect(result.timeout_ms).toBe(60_000);
    expect(result.max_events).toBe(50);
  });

  it("rejects timeout_ms above the 120000 cap", () => {
    const result = WatchTableInputSchema.safeParse({
      table: "x",
      predicate: { event: "*" },
      timeout_ms: 120_001,
    });
    expect(result.success).toBe(false);
  });

  it("rejects max_events above 200", () => {
    const result = WatchTableInputSchema.safeParse({
      table: "x",
      predicate: { event: "*" },
      max_events: 201,
    });
    expect(result.success).toBe(false);
  });

  it("accepts all 7 filter operators", () => {
    const ops = ["eq", "neq", "gt", "gte", "lt", "lte", "in"] as const;
    for (const op of ops) {
      const result = WatchTableInputSchema.safeParse({
        table: "x",
        predicate: { event: "INSERT", filter: { column: "status", op, value: "open" } },
      });
      expect(result.success, `op=${op}`).toBe(true);
    }
  });

  it("rejects an unsupported filter operator", () => {
    const result = WatchTableInputSchema.safeParse({
      table: "x",
      predicate: { event: "INSERT", filter: { column: "status", op: "match", value: "open" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("BroadcastInputSchema", () => {
  it("accepts a valid broadcast", () => {
    const r = BroadcastInputSchema.safeParse({
      channel: "agent:triage:urgent",
      event: "ticket-routed",
      payload: { ticket_id: "abc" },
    });
    expect(r.success).toBe(true);
  });
  it("rejects payload over 32KB", () => {
    const big = { x: "a".repeat(33_000) };
    const r = BroadcastInputSchema.safeParse({ channel: "c", event: "e", payload: big });
    expect(r.success).toBe(false);
  });
});

describe("SubscribeChannelInputSchema", () => {
  it("applies bounded-subscription defaults like watch_table", () => {
    const r = SubscribeChannelInputSchema.parse({ channel: "c" });
    expect(r.timeout_ms).toBe(60_000);
    expect(r.max_events).toBe(50);
  });
  it("caps timeout_ms at 120000", () => {
    expect(
      SubscribeChannelInputSchema.safeParse({ channel: "c", timeout_ms: 120_001 }).success,
    ).toBe(false);
  });
});

describe("ListChannelsInputSchema", () => {
  it("accepts an empty object", () => {
    expect(ListChannelsInputSchema.safeParse({}).success).toBe(true);
  });
});

describe("DescribeTableInputSchema", () => {
  it("requires a table", () => {
    expect(DescribeTableInputSchema.safeParse({}).success).toBe(false);
    expect(DescribeTableInputSchema.safeParse({ table: "support_tickets" }).success).toBe(true);
  });
});
