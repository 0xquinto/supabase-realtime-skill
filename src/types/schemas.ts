import { z } from "zod";

const FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in"] as const;
const EVENTS = ["INSERT", "UPDATE", "DELETE", "*"] as const;

export const WatchTableInputSchema = z.object({
  table: z.string().min(1),
  predicate: z.object({
    event: z.enum(EVENTS),
    filter: z
      .object({
        column: z.string().min(1),
        op: z.enum(FILTER_OPS),
        value: z.unknown(),
      })
      .optional(),
  }),
  timeout_ms: z.number().int().min(1_000).max(120_000).default(60_000),
  max_events: z.number().int().min(1).max(200).default(50),
});

export type WatchTableInput = z.infer<typeof WatchTableInputSchema>;

export const WatchTableEventSchema = z.object({
  event: z.enum(["INSERT", "UPDATE", "DELETE"]),
  table: z.string(),
  schema: z.string(),
  new: z.record(z.unknown()).nullable(),
  old: z.record(z.unknown()).nullable(),
  commit_timestamp: z.string(),
});

export const WatchTableOutputSchema = z.object({
  events: z.array(WatchTableEventSchema),
  closed_reason: z.enum(["max_events", "timeout"]),
});

export type WatchTableOutput = z.infer<typeof WatchTableOutputSchema>;
