// src/client/index.ts
//
// Consumer-facing library surface. For code that wants the bounded
// subscription primitive (and its production adapters) without spinning up
// the full MCP server. Re-exports schemas + error class so consumers can
// validate inputs and pattern-match on tool errors.
//
// Sibling subpath: `supabase-realtime-skill/server` (see src/server/index.ts)
// re-exports the MCP `makeServer` factory and per-tool handlers for code
// that wants to build its own server.

// --- Bounded primitive + adapters ------------------------------------------
export {
  boundedWatch,
  boundedSubscribe,
  makeSupabaseAdapter,
  makeSupabaseBroadcastAdapter,
} from "../server/realtime-client.ts";

export type {
  RealtimeAdapter,
  BroadcastAdapter,
  ChangeEvent,
  BroadcastReceived,
  SupabaseAdapterConfig,
  BoundedWatchInput,
} from "../server/realtime-client.ts";

// --- Schemas (Zod) + inferred types ----------------------------------------
export {
  WatchTableInputSchema,
  WatchTableEventSchema,
  WatchTableOutputSchema,
  BroadcastInputSchema,
  BroadcastOutputSchema,
  SubscribeChannelInputSchema,
  SubscribeChannelOutputSchema,
  ListChannelsInputSchema,
  ListChannelsOutputSchema,
  DescribeTableInputSchema,
  DescribeTableOutputSchema,
} from "../types/schemas.ts";

export type {
  WatchTableInput,
  WatchTableOutput,
  BroadcastInput,
  BroadcastOutput,
  SubscribeChannelInput,
  SubscribeChannelOutput,
  ListChannelsInput,
  ListChannelsOutput,
  DescribeTableInput,
  DescribeTableOutput,
} from "../types/schemas.ts";

// --- Errors ----------------------------------------------------------------
export { ToolError } from "../types/errors.ts";
export type { ToolErrorCode } from "../types/errors.ts";
