// In-process transport test. Boots the same Server + WebStandard transport
// the Edge Function uses, fires a JSON-RPC initialize + tools/list via a
// fabricated Request, and asserts the round-trip works. Catches transport-
// wiring regressions before they ship to the Edge Function.

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, expect, it } from "vitest";
import { makeServer } from "../../src/server/server.ts";

const PROTOCOL_VERSION = "2025-03-26";

async function fireMcpRequest(body: unknown): Promise<{ status: number; json: unknown }> {
  const server = makeServer({
    supabaseUrl: "http://localhost:0",
    supabaseAnonKey: "test-anon-key",
  });
  // Stateless: omitting sessionIdGenerator (vs explicit undefined) keeps
  // exactOptionalPropertyTypes happy. enableJsonResponse forces a single
  // JSON response per POST instead of an SSE stream.
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(
      new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      }),
    );
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

describe("Edge Function transport wiring", () => {
  it("responds to initialize with the configured server info", async () => {
    const { status, json } = await fireMcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "fast-test", version: "0.0.0" },
      },
    });
    expect(status).toBe(200);
    expect(json).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        serverInfo: { name: "supabase-realtime", version: "0.1.0" },
        capabilities: { tools: {} },
      },
    });
  });

  it("returns the 5 registered tools on tools/list", async () => {
    const { status, json } = await fireMcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(status).toBe(200);
    const tools = (json as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual([
      "broadcast_to_channel",
      "describe_table_changes",
      "list_channels",
      "subscribe_to_channel",
      "watch_table",
    ]);
  });
});
