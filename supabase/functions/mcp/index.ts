// supabase/functions/mcp/index.ts
//
// Deno runtime. Uses npm: specifiers (Supabase Edge Functions support
// these via Deno's npm compat). Must NOT import anything Node-specific.

// For local-dev verification (Week 1 spike) use the relative import:
import { makeServer } from "../../../src/server/server.ts";

// After npm publish in T30, swap to the published package:
// import { makeServer } from "npm:supabase-realtime-skill@latest/dist/server.js";

import { SSEServerTransport } from "npm:@modelcontextprotocol/sdk/server/sse.js";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const authToken = req.headers.get("Authorization")?.replace(/^Bearer /, "");

  const server = makeServer({
    supabaseUrl,
    supabaseAnonKey,
    ...(authToken ? { authToken } : {}),
  });

  if (url.pathname.endsWith("/sse")) {
    const transport = new SSEServerTransport(`${url.pathname}/messages`, new Response());
    await server.connect(transport);
    return transport.response;
  }

  return new Response("supabase-realtime-skill MCP — POST /sse to connect", { status: 200 });
});
