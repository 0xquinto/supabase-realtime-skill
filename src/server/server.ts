// src/server/server.ts
//
// MCP server factory. Stays runtime-neutral: the only Node-isms are inside
// @modelcontextprotocol/sdk's `Server` class itself; we don't reach for
// node:* directly. This file is imported from both Node tests and the
// Deno Edge Function entry, so keep it that way.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ToolError } from "../types/errors";
import { makeSupabaseAdapter } from "./realtime-client";
import { handleWatchTable } from "./watch-table";

export interface ServerConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  authToken?: string;
}

export function makeServer(cfg: ServerConfig): Server {
  const server = new Server(
    { name: "supabase-realtime", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "watch_table",
        description:
          "Bounded subscription to Postgres row-changes. Returns events when max_events arrive or timeout_ms elapses (whichever first). Use when an agent needs to react to a database event.",
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
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      if (req.params.name === "watch_table") {
        const result = await handleWatchTable(req.params.arguments, {
          adapterFor: (table) =>
            makeSupabaseAdapter(table, {
              supabaseUrl: cfg.supabaseUrl,
              supabaseKey: cfg.supabaseAnonKey,
              ...(cfg.authToken ? { authToken: cfg.authToken } : {}),
            }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      throw new ToolError("UPSTREAM_ERROR", `unknown tool: ${req.params.name}`);
    } catch (err) {
      if (err instanceof ToolError) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(err.toJSON()) }],
        };
      }
      throw err;
    }
  });

  return server;
}
