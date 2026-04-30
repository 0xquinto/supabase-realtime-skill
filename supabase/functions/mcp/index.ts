// supabase/functions/mcp/index.ts
//
// Deno runtime. Uses npm: specifiers (Supabase Edge Functions support
// these via Deno's npm compat). Must NOT import anything Node-specific.
//
// Per-request stateless MCP. Each invocation builds a fresh
// Server + WebStandardStreamableHTTPServerTransport pair and runs one
// JSON-RPC exchange. The Edge Function isolate caps wall-clock at 150s,
// matching the bounded-subscription tool-call shape.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { makeServer } from "../../../src/server/server.ts";

// After npm publish, swap the makeServer import to:
// import { makeServer } from "npm:supabase-realtime-skill@latest/dist/server.js";

// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_DB_URL are auto-injected by
// the Edge Functions runtime — they're "reserved" only in the sense that
// you can't SET them via `supabase secrets set`. Reading them works fine.
Deno.serve(async (req) => {
  // Liveness probe — answer GET / cheaply without spinning up a Server.
  // The MCP transport responds to GET on the streaming endpoint with SSE,
  // so we keep liveness on a separate path.
  const url = new URL(req.url);
  if (req.method === "GET" && (url.pathname === "/" || url.pathname.endsWith("/health"))) {
    return new Response("supabase-realtime-skill MCP — ok", { status: 200 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL") ?? undefined;
  const authToken = req.headers.get("Authorization")?.replace(/^Bearer /, "");

  const server = makeServer({
    supabaseUrl,
    supabaseAnonKey,
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(authToken ? { authToken } : {}),
  });

  // Stateless: omitting sessionIdGenerator disables session tracking.
  // enableJsonResponse: true returns a single JSON response per POST instead
  // of opening an SSE stream — simpler match for the bounded tool-call model.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
});
