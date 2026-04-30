// supabase/functions/mcp/index.ts
//
// Deno runtime. Uses npm: specifiers (Supabase Edge Functions support
// these via Deno's npm compat). Must NOT import anything Node-specific.

// For local-dev verification (Week 1 spike) use the relative import:
import { makeServer } from "../../../src/server/server.ts";

// After npm publish in T30, swap to the published package:
// import { makeServer } from "npm:supabase-realtime-skill@latest/dist/server.js";

// SSE/StreamableHTTP transport rewire is the next milestone — see
// docs/spike-findings.md (T8 secondary). For now this entry constructs the
// server to exercise the import graph at deploy time (catches misconfig
// early) and returns a placeholder for non-/sse paths.

// SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_DB_URL are auto-injected by
// the Edge Functions runtime — they're "reserved" only in the sense that
// you can't SET them via `supabase secrets set`. Reading them works fine.
Deno.serve((req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const databaseUrl = Deno.env.get("SUPABASE_DB_URL") ?? undefined;
  const authToken = req.headers.get("Authorization")?.replace(/^Bearer /, "");

  // Construct the server so the full import graph (5 tools + postgres
  // + supabase-js) is exercised at deploy time. Transport wiring lands
  // in a follow-up task.
  makeServer({
    supabaseUrl,
    supabaseAnonKey,
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(authToken ? { authToken } : {}),
  });

  return new Response("supabase-realtime-skill MCP — transport pending", { status: 200 });
});
