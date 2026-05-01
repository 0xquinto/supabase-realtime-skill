// tests/smoke/edge-deploy.smoke.test.ts
//
// End-to-end transport verification against the LIVE Edge Function deployment.
// Complements tests/fast/transport.test.ts (which exercises the in-process
// round-trip) by hitting the actually-deployed function URL with real
// JSON-RPC over HTTPS.
//
// Validates:
//   - The deployed function is reachable
//   - JSON-RPC tools/list returns all 5 tools with their input schemas
//   - The transport correctly handles the WebStandardStreamableHTTP shape
//     (Accept: application/json, text/event-stream)
//
// Skips automatically when EVAL_HOST_PROJECT_REF or EVAL_SUPABASE_PAT is
// missing — same convention as the other smoke tests.
//
// Requires the function to have been deployed to the host project (see
// docs/writeup.md § 4 "Live-deploy verification" for the deploy command).

import { describe, expect, it } from "vitest";
import { fetchProjectKeys } from "./_helpers/project-keys.ts";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const SHOULD_RUN = !!(PAT && HOST_REF);

const EXPECTED_TOOLS = [
  "watch_table",
  "broadcast_to_channel",
  "subscribe_to_channel",
  "list_channels",
  "describe_table_changes",
] as const;

describe.skipIf(!SHOULD_RUN)("Edge Function MCP transport (live deploy)", () => {
  it("responds to JSON-RPC tools/list with all 5 tools and their schemas", async () => {
    const ref = HOST_REF as string;
    const keys = await fetchProjectKeys(PAT as string, ref);
    const fnUrl = `https://${ref}.supabase.co/functions/v1/mcp`;

    const res = await fetch(fnUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${keys.anon}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    expect(res.ok, `function returned HTTP ${res.status}`).toBe(true);

    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result?: { tools: Array<{ name: string; description: string; inputSchema: unknown }> };
      error?: { code: number; message: string };
    };

    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.error).toBeUndefined();
    expect(body.result?.tools, "tools array missing in JSON-RPC result").toBeDefined();

    const tools = body.result?.tools ?? [];
    const toolNames = tools.map((t) => t.name).sort();
    expect(toolNames).toEqual([...EXPECTED_TOOLS].sort());

    // Every tool must carry an input schema (proving the transport doesn't
    // strip schema metadata in transit — a real risk noted in T8 spike work).
    for (const tool of tools) {
      expect(tool.inputSchema, `tool ${tool.name} missing inputSchema`).toBeDefined();
      expect(tool.description, `tool ${tool.name} missing description`).toBeTruthy();
    }
  }, 30_000);

  it("liveness probe returns 200 on GET /health", async () => {
    const ref = HOST_REF as string;
    const keys = await fetchProjectKeys(PAT as string, ref);
    const fnUrl = `https://${ref}.supabase.co/functions/v1/mcp/health`;

    // Supabase Edge Functions gate all requests through the platform
    // gateway; pass apikey so we hit the function logic, not the gateway.
    // Accept: text/plain matches the function's plain-text liveness response;
    // omitting it triggers the gateway's content-negotiation 406 because the
    // MCP transport advertises text/event-stream by default.
    const res = await fetch(fnUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${keys.anon}`,
        apikey: keys.anon,
        Accept: "text/plain",
      },
    });
    expect(res.status, `liveness probe returned HTTP ${res.status}`).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/supabase-realtime-skill MCP/);
  }, 15_000);
});
