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

const PAYLOAD_BYTE_CAP = 32_768;

export const BroadcastInputSchema = z.object({
  channel: z.string().min(1).max(255),
  event: z.string().min(1).max(255),
  payload: z
    .record(z.unknown())
    .refine((v) => new TextEncoder().encode(JSON.stringify(v)).byteLength <= PAYLOAD_BYTE_CAP, {
      message: "payload exceeds 32KB byte cap",
    }),
  // Opt-in to Realtime Broadcast Authorization. When true, the substrate
  // constructs the channel with `private: true`, which gates send via
  // realtime.messages RLS. Default false preserves v0.1.x behavior.
  private: z.boolean().default(false),
});
export type BroadcastInput = z.infer<typeof BroadcastInputSchema>;

export const BroadcastOutputSchema = z.object({ success: z.boolean() });
export type BroadcastOutput = z.infer<typeof BroadcastOutputSchema>;

export const SubscribeChannelInputSchema = z.object({
  channel: z.string().min(1).max(255),
  event_filter: z.string().min(1).optional(),
  timeout_ms: z.number().int().min(1_000).max(120_000).default(60_000),
  max_events: z.number().int().min(1).max(200).default(50),
  // Opt-in to Realtime Broadcast Authorization. When true, subscribe is
  // gated by realtime.messages RLS at SUBSCRIBED-handshake time.
  // Default false preserves v0.1.x behavior.
  private: z.boolean().default(false),
});
export type SubscribeChannelInput = z.infer<typeof SubscribeChannelInputSchema>;

export const SubscribeChannelOutputSchema = z.object({
  broadcasts: z.array(
    z.object({
      channel: z.string(),
      event: z.string(),
      payload: z.record(z.unknown()),
      received_at: z.string(),
    }),
  ),
  closed_reason: z.enum(["max_events", "timeout"]),
});
export type SubscribeChannelOutput = z.infer<typeof SubscribeChannelOutputSchema>;

export const ListChannelsInputSchema = z.object({}).strict();
export type ListChannelsInput = z.infer<typeof ListChannelsInputSchema>;

export const ListChannelsOutputSchema = z.object({
  channels: z.array(
    z.object({
      name: z.string(),
      member_count: z.number().int().nonnegative(),
      last_event_at: z.string().nullable(),
    }),
  ),
});
export type ListChannelsOutput = z.infer<typeof ListChannelsOutputSchema>;

export const DescribeTableInputSchema = z.object({ table: z.string().min(1) });
export type DescribeTableInput = z.infer<typeof DescribeTableInputSchema>;

export const DescribeTableOutputSchema = z.object({
  table: z.string(),
  schema: z.string(),
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      nullable: z.boolean(),
      generated: z.boolean(),
    }),
  ),
  primary_key: z.array(z.string()),
  rls_enabled: z.boolean(),
  replication_identity: z.enum(["default", "full", "index", "nothing"]),
});
export type DescribeTableOutput = z.infer<typeof DescribeTableOutputSchema>;
