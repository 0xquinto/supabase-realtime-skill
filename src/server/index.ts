// src/server/index.ts
//
// Server factory surface. For code that wants the full MCP `makeServer`
// (e.g., the Edge Function entry once it imports via `npm:`) or wants to
// assemble a custom server out of the per-tool handlers.
//
// Sibling subpath: `supabase-realtime-skill` root (see src/client/index.ts)
// re-exports the bounded-subscription primitive + schemas + errors for
// consumers that don't need the MCP scaffolding.

// --- Server factory --------------------------------------------------------
export { makeServer } from "./server.ts";
export type { ServerConfig } from "./server.ts";

// --- Production adapters (also re-exported from client) --------------------
// Custom-server consumers wire these into their own `makeServer`-equivalent.
export { makeSupabaseAdapter, makeSupabaseBroadcastAdapter } from "./realtime-client.ts";

// --- Per-tool handlers + their Deps interfaces -----------------------------
// For consumers building a custom server who want the validation +
// retry + bounded-loop logic without the MCP-Server wiring.
export { handleWatchTable } from "./watch-table.ts";
export type { WatchTableDeps } from "./watch-table.ts";

export { handleBroadcast } from "./broadcast.ts";
export type { BroadcastDeps, BroadcastSender } from "./broadcast.ts";

export { handleSubscribe } from "./subscribe.ts";
export type { SubscribeDeps } from "./subscribe.ts";

export { handleListChannels } from "./list-channels.ts";
export type { ListChannelsDeps, ChannelRegistryEntry } from "./list-channels.ts";

export { handleDescribeTable } from "./describe-table.ts";
export type { DescribeTableDeps, TableIntrospection } from "./describe-table.ts";
