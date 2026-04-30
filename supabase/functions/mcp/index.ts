// supabase/functions/mcp/index.ts
//
// Deno runtime. Uses npm: specifiers (Supabase Edge Functions support
// these via Deno's npm compat). Must NOT import anything Node-specific.

// For local-dev verification (Week 1 spike) use the relative import:
import { makeServer } from "../../../src/server/server.ts";

// After npm publish in T30, swap to the published package:
// import { makeServer } from "npm:supabase-realtime-skill@latest/dist/server.js";

// SSE transport deferred — see docs/spike-findings.md (T8 secondary).

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const authToken = req.headers.get("Authorization")?.replace(/^Bearer /, "");

  // Construct the server so the import graph is exercised at deploy time
  // (catches misconfig early). Transport rewire is the next milestone.
  makeServer({
    supabaseUrl,
    supabaseAnonKey,
    ...(authToken ? { authToken } : {}),
  });

  return new Response("supabase-realtime-skill MCP — transport pending", { status: 200 });
});
