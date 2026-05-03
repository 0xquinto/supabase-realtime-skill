// src/server/server.ts
//
// MCP server factory. Stays runtime-neutral: the only Node-isms are inside
// @modelcontextprotocol/sdk's `Server` class itself; we don't reach for
// node:* directly. This file is imported from both Node tests and the
// Deno Edge Function entry, so keep it that way.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { ToolError } from "../types/errors.ts";
import { type BroadcastSender, handleBroadcast } from "./broadcast.ts";
import { type TableIntrospection, handleDescribeTable } from "./describe-table.ts";
import { type ChannelRegistryEntry, handleListChannels } from "./list-channels.ts";
import { makeSupabaseAdapter, makeSupabaseBroadcastAdapter } from "./realtime-client.ts";
import { handleSubscribe } from "./subscribe.ts";
import { handleWatchTable } from "./watch-table.ts";

/**
 * Build a BroadcastSender that uses ch.httpSend (explicit REST-side
 * broadcast send, added supabase-js@050687a 2025-10-08). Threads the
 * `input.private` flag at channel construction so realtime.messages
 * RLS is enforced when the caller opts in.
 *
 * Failure mode: ch.httpSend rejects with Error on non-202 (the .d.ts
 * discriminated `success: false` branch is unreachable at runtime per
 * RealtimeChannel.js:441-447). handleBroadcast's 3-retry envelope
 * catches and translates to ToolError("UPSTREAM_ERROR"). RLS denials
 * are silent — REST returns 202, row is filtered out, no fan-out, no
 * thrown error. See references/multi-tenant-rls.md § "Failure mode".
 *
 * Exported so smoke tests exercise the same code path as production
 * (closes the mirror-vs-real gap; a typo here would surface in tests).
 */
export function makeProductionBroadcastSender(
  client: SupabaseClient,
  registry: ChannelRegistryEntry[],
): BroadcastSender {
  return {
    send: async (input) => {
      const ch = input.private
        ? client.channel(input.channel, { config: { private: true } })
        : client.channel(input.channel);
      try {
        await ch.httpSend(input.event, input.payload, { timeout: 10_000 });
      } finally {
        await client.removeChannel(ch);
      }
      registry.push({
        name: input.channel,
        member_count: 1,
        last_event_at: new Date().toISOString(),
      });
      return { status: "ok" };
    },
  };
}

export interface ServerConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  databaseUrl?: string; // optional; only describe_table_changes needs it
  authToken?: string;
}

const TOOL_DEFS = [
  {
    name: "watch_table",
    description:
      "Bounded subscription to Postgres row-changes. Returns events when max_events arrive or timeout_ms elapses (whichever first).",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        predicate: {
          type: "object",
          properties: {
            event: { enum: ["INSERT", "UPDATE", "DELETE", "*"] },
            filter: {
              type: "object",
              properties: {
                column: { type: "string" },
                op: { enum: ["eq", "neq", "gt", "gte", "lt", "lte", "in"] },
                value: {},
              },
              required: ["column", "op", "value"],
            },
          },
          required: ["event"],
        },
        timeout_ms: { type: "number", minimum: 1000, maximum: 120000, default: 60000 },
        max_events: { type: "number", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["table", "predicate"],
    },
  },
  {
    name: "broadcast_to_channel",
    description:
      "Fire-and-forget broadcast on a Realtime channel. Server retries 5xx idempotently up to 3 times. Set `private: true` to opt in to Broadcast Authorization (gated by realtime.messages RLS); requires the agent's JWT to pass the channel's INSERT policy.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        event: { type: "string" },
        payload: { type: "object" },
        private: {
          type: "boolean",
          description:
            "Opt-in to Realtime Broadcast Authorization (private channel). Defaults to false for v0.1.x backward compatibility.",
        },
      },
      required: ["channel", "event", "payload"],
    },
  },
  {
    name: "subscribe_to_channel",
    description:
      "Bounded subscription to a Realtime broadcast channel. Mirrors watch_table's bounded shape. Set `private: true` to opt in to Broadcast Authorization (subscribe gated by realtime.messages RLS).",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        event_filter: { type: "string" },
        timeout_ms: { type: "number", minimum: 1000, maximum: 120000, default: 60000 },
        max_events: { type: "number", minimum: 1, maximum: 200, default: 50 },
        private: {
          type: "boolean",
          description:
            "Opt-in to Realtime Broadcast Authorization (private channel). Defaults to false for v0.1.x backward compatibility.",
        },
      },
      required: ["channel"],
    },
  },
  {
    name: "list_channels",
    description: "Best-effort listing of channels known to the server registry.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_table_changes",
    description: "Introspects a table's columns, primary key, RLS state, and REPLICA IDENTITY.",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string" } },
      required: ["table"],
    },
  },
];

export function makeServer(cfg: ServerConfig): Server {
  const server = new Server(
    { name: "supabase-realtime", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  const channelRegistry: ChannelRegistryEntry[] = [];

  // Build options conditionally — `exactOptionalPropertyTypes: true` rejects
  // assigning `undefined` to an optional field. Same pattern as
  // makeSupabaseAdapter / makeSupabaseBroadcastAdapter.
  const clientOpts: Parameters<typeof createClient>[2] = {};
  if (cfg.authToken) {
    clientOpts.global = { headers: { Authorization: `Bearer ${cfg.authToken}` } };
  }
  // Concurrent broadcasts to the same channel could collide on this shared
  // client (channel-name reuse). Acceptable for v1 single-tenant deploys;
  // worth revisiting if we open multi-tenant.
  const supabaseClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, clientOpts);
  // global.headers.Authorization doesn't propagate to the Realtime websocket;
  // setAuth is required for Broadcast Authorization on private channels to
  // evaluate RLS against the user's JWT instead of the anon claims_role.
  // See src/server/realtime-client.ts for the load-bearing comment + smoke
  // test in tests/smoke/multi-tenant-rls.smoke.test.ts.
  if (cfg.authToken) {
    supabaseClient.realtime.setAuth(cfg.authToken);
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

  server.setRequestHandler(CallToolRequestSchema, async (req: CallToolRequest) => {
    try {
      let result: unknown;
      switch (req.params.name) {
        case "watch_table":
          result = await handleWatchTable(req.params.arguments, {
            adapterFor: (table) =>
              makeSupabaseAdapter(table, {
                supabaseUrl: cfg.supabaseUrl,
                supabaseKey: cfg.supabaseAnonKey,
                ...(cfg.authToken ? { authToken: cfg.authToken } : {}),
              }),
          });
          break;
        case "broadcast_to_channel": {
          result = await handleBroadcast(req.params.arguments, {
            sender: makeProductionBroadcastSender(supabaseClient, channelRegistry),
          });
          break;
        }
        case "subscribe_to_channel":
          result = await handleSubscribe(req.params.arguments, {
            adapterFor: () =>
              makeSupabaseBroadcastAdapter({
                supabaseUrl: cfg.supabaseUrl,
                supabaseKey: cfg.supabaseAnonKey,
                ...(cfg.authToken ? { authToken: cfg.authToken } : {}),
              }),
          });
          break;
        case "list_channels":
          result = await handleListChannels(req.params.arguments, {
            registry: async () => channelRegistry.slice(),
          });
          break;
        case "describe_table_changes": {
          if (!cfg.databaseUrl) {
            throw new ToolError(
              "UPSTREAM_ERROR",
              "describe_table_changes requires databaseUrl in ServerConfig",
            );
          }
          // Narrow once for the closure — TS keeps `cfg.databaseUrl` widened to
          // `string | undefined` inside the async callback below.
          const dbUrl = cfg.databaseUrl;
          result = await handleDescribeTable(req.params.arguments, {
            introspect: async (table) => {
              const sql = postgres(dbUrl, { max: 1, prepare: false });
              try {
                return await pgIntrospectInline(sql, table);
              } finally {
                await sql.end();
              }
            },
          });
          break;
        }
        default:
          throw new ToolError("UPSTREAM_ERROR", `unknown tool: ${req.params.name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      if (err instanceof ToolError) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify(err.toJSON()) }] };
      }
      throw err;
    }
  });

  return server;
}

// Inline introspection helper (same logic as the smoke test). Lives here
// rather than describe-table.ts so describe-table stays Realtime-pure.
// Duplication is intentional per plan T17 — flag for a future ADR if it grows.
async function pgIntrospectInline(
  sql: ReturnType<typeof postgres>,
  table: string,
): Promise<TableIntrospection | null> {
  const cols = await sql<
    { column_name: string; data_type: string; nullable: boolean; generated: boolean }[]
  >`
    select column_name, data_type, is_nullable = 'YES' as nullable, is_generated = 'ALWAYS' as generated
    from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by ordinal_position
  `;
  if (cols.length === 0) return null;
  const pk = await sql<{ column_name: string }[]>`
    select kcu.column_name from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu using (constraint_schema, constraint_name)
    where tc.table_schema = 'public' and tc.table_name = ${table} and tc.constraint_type = 'PRIMARY KEY'
    order by kcu.ordinal_position
  `;
  const rls = await sql<{ relrowsecurity: boolean }[]>`
    select c.relrowsecurity from pg_class c join pg_namespace n on c.relnamespace = n.oid
    where n.nspname = 'public' and c.relname = ${table}
  `;
  const ri = await sql<{ relreplident: string }[]>`
    select c.relreplident from pg_class c join pg_namespace n on c.relnamespace = n.oid
    where n.nspname = 'public' and c.relname = ${table}
  `;
  const map: Record<string, "default" | "full" | "index" | "nothing"> = {
    d: "default",
    f: "full",
    i: "index",
    n: "nothing",
  };
  const replKey = ri[0]?.relreplident ?? "d";
  const replication_identity = map[replKey] ?? "default";
  return {
    schema: "public",
    columns: cols.map((c) => ({
      name: c.column_name,
      type: c.data_type,
      nullable: c.nullable,
      generated: c.generated,
    })),
    primary_key: pk.map((r) => r.column_name),
    rls_enabled: rls[0]?.relrowsecurity ?? false,
    replication_identity,
  };
}
