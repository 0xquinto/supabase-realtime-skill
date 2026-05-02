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
//   - JSON-RPC tools/call dispatches to describe_table_changes (no Realtime)
//   - JSON-RPC tools/call dispatches to broadcast_to_channel (httpSend path)
//   - The transport correctly handles the WebStandardStreamableHTTP shape
//     (Accept: application/json, text/event-stream)
//
// Skips automatically when EVAL_HOST_PROJECT_REF or EVAL_SUPABASE_PAT is
// missing — same convention as the other smoke tests.
//
// Requires the function to have been deployed to the host project (see
// references/edge-deployment.md for the deploy command).

import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { fetchProjectKeys } from "./_helpers/project-keys.ts";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const HOST_DB_URL = process.env.EVAL_HOST_DB_URL;
const SHOULD_RUN = !!(PAT && HOST_REF);
// watch_table E2E smoke needs DDL + INSERT against the host project, gated
// separately. Without it the smoke skips with a clear message rather than
// running against a misconfigured environment.
const SHOULD_RUN_WATCH = SHOULD_RUN && !!HOST_DB_URL;

const EXPECTED_TOOLS = [
  "watch_table",
  "broadcast_to_channel",
  "subscribe_to_channel",
  "list_channels",
  "describe_table_changes",
] as const;

type JsonRpcResponse = {
  jsonrpc: string;
  id: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
    tools?: Array<{ name: string; description: string; inputSchema: unknown }>;
  };
  error?: { code: number; message: string };
};

async function callJsonRpc(
  fnUrl: string,
  bearer: string,
  body: { method: string; params: unknown; id: number },
): Promise<{ status: number; body: JsonRpcResponse }> {
  const res = await fetch(fnUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: body.id,
      method: body.method,
      params: body.params,
    }),
  });
  const json = (await res.json()) as JsonRpcResponse;
  return { status: res.status, body: json };
}

describe.skipIf(!SHOULD_RUN)("Edge Function MCP transport (live deploy)", () => {
  it("responds to JSON-RPC tools/list with all 5 tools and their schemas", async () => {
    const ref = HOST_REF as string;
    const keys = await fetchProjectKeys(PAT as string, ref);
    const fnUrl = `https://${ref}.supabase.co/functions/v1/mcp`;

    const { status, body } = await callJsonRpc(fnUrl, keys.anon, {
      method: "tools/list",
      params: {},
      id: 1,
    });

    expect(status, `function returned HTTP ${status}`).toBe(200);
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

  // tools/call coverage probes (ADR-0015).
  //
  // Schema-independent by design: the host project's public schema may be
  // empty (host is a deploy/eval target, not a worked-example fixture), so
  // describe_table_changes is exercised against a randomly-named table that
  // is guaranteed not to exist. The structured INVALID_TABLE error is the
  // PASS shape — it proves tool routing, DB connectivity (SUPABASE_DB_URL
  // auto-injection), and error mapping all work end-to-end without depending
  // on host state.
  //
  // broadcast_to_channel exercises makeProductionBroadcastSender → ch.httpSend
  // at runtime against a public (private: false) channel. This is a
  // forward-looking regression gate: if a future deno.json bump regresses to
  // a supabase-js version that lacks httpSend, this test catches it.

  it("tools/call describe_table_changes routes to handler and returns INVALID_TABLE for missing table", async () => {
    const ref = HOST_REF as string;
    const keys = await fetchProjectKeys(PAT as string, ref);
    const fnUrl = `https://${ref}.supabase.co/functions/v1/mcp`;

    const ghostTable = `__realtime_skill_smoke_${Date.now()}__`;
    const { status, body } = await callJsonRpc(fnUrl, keys.anon, {
      method: "tools/call",
      params: {
        name: "describe_table_changes",
        arguments: { table: ghostTable },
      },
      id: 2,
    });

    expect(status, `function returned HTTP ${status}`).toBe(200);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(2);
    expect(body.error, `JSON-RPC error: ${JSON.stringify(body.error)}`).toBeUndefined();
    expect(body.result?.isError, "tool must surface INVALID_TABLE via isError envelope").toBe(true);
    expect(body.result?.content?.[0]?.type).toBe("text");

    const text = body.result?.content?.[0]?.text ?? "";
    const payload = JSON.parse(text) as { code: string; message: string };
    expect(payload.code).toBe("INVALID_TABLE");
    expect(payload.message).toContain(ghostTable);
  }, 30_000);

  it("tools/call broadcast_to_channel returns success on a public channel", async () => {
    const ref = HOST_REF as string;
    const keys = await fetchProjectKeys(PAT as string, ref);
    const fnUrl = `https://${ref}.supabase.co/functions/v1/mcp`;

    // Public channel (private: false). Exercises makeProductionBroadcastSender
    // → ch.httpSend() at runtime. If the deployed deno.json pin is below
    // supabase-js 2.75.0, httpSend doesn't exist and this throws.
    const channelName = `edge-smoke-${Date.now()}`;
    const { status, body } = await callJsonRpc(fnUrl, keys.anon, {
      method: "tools/call",
      params: {
        name: "broadcast_to_channel",
        arguments: {
          channel: channelName,
          event: "smoke",
          payload: { from: "edge-deploy.smoke.test.ts" },
        },
      },
      id: 3,
    });

    expect(status, `function returned HTTP ${status}`).toBe(200);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(3);
    expect(
      body.error,
      `JSON-RPC error (likely httpSend missing at deployed supabase-js): ${JSON.stringify(body.error)}`,
    ).toBeUndefined();
    expect(
      body.result?.isError,
      `tool returned isError=true; content: ${body.result?.content?.[0]?.text}`,
    ).not.toBe(true);

    const text = body.result?.content?.[0]?.text ?? "";
    const payload = JSON.parse(text) as { success: boolean };
    expect(payload.success).toBe(true);
  }, 30_000);

  // tools/call watch_table E2E (ADR-0016 — closes the deferred-from-ADR-0015
  // verification gap).
  //
  // Spike: docs/spike-findings.md § T7-Edge sized this against measured
  // distribution. p99 wall 5322ms with the GRANT + RLS chain in place;
  // 12_000ms wall budget gives 2.25× headroom over p99, well within the
  // 30s smoke ceiling and the Edge isolate's 150s wall cap.
  //
  // The spike's two load-bearing findings shape this smoke:
  //   1. Single-INSERT@+100ms is unsafe — per-request subscribe handshake
  //      exceeds 100ms, so the row commits pre-SUBSCRIBED and Postgres-Changes
  //      drops it. Multi-INSERT schedule (+100ms / +5s / +10s, mirroring
  //      tests/smoke/watch-table.smoke.test.ts:87-89) is mandatory.
  //   2. Anon JWT subscriptions on the host project return `new: {}` +
  //      `errors: 401` unless the table has RLS enabled with a permissive
  //      `select using (true)` policy AND `grant select` to anon. Without
  //      the chain, `events.length === 1` would silently pass while the
  //      row data is 401-stripped. We assert on populated `new` content to
  //      catch chain regressions in the substrate.
  it.skipIf(!SHOULD_RUN_WATCH)(
    "tools/call watch_table delivers an INSERT event end-to-end on a fresh table",
    async () => {
      const ref = HOST_REF as string;
      const keys = await fetchProjectKeys(PAT as string, ref);
      const fnUrl = `https://${ref}.supabase.co/functions/v1/mcp`;
      const sql = postgres(HOST_DB_URL as string, { max: 1, prepare: false });
      const table = `__realtime_skill_watch_smoke_${Date.now()}__`;

      // Hoisted so finally can clear pending timers if try throws before
      // they're scheduled. clearTimeout on undefined/empty array is no-op.
      const insertTimers: ReturnType<typeof setTimeout>[] = [];
      let publicationAdded = false;
      let tableCreated = false;

      try {
        await sql.unsafe(
          `create table ${table} (id uuid primary key default gen_random_uuid(), n int)`,
        );
        tableCreated = true;
        // The chain. See spike-findings § T7-Edge sub-finding 2.
        await sql.unsafe(`alter table ${table} enable row level security`);
        await sql.unsafe(`create policy "${table}_read" on ${table} for select using (true)`);
        await sql.unsafe(`grant select on ${table} to anon, authenticated, service_role`);
        await sql.unsafe(`alter publication supabase_realtime add table ${table}`);
        publicationAdded = true;

        // Dispatch the JSON-RPC tools/call. The function holds the
        // subscription open until either max_events or timeout_ms.
        const t0 = performance.now();
        const callPromise = callJsonRpc(fnUrl, keys.anon, {
          method: "tools/call",
          params: {
            name: "watch_table",
            arguments: {
              table,
              predicate: { event: "INSERT" },
              timeout_ms: 12_000,
              max_events: 1,
            },
          },
          id: 4,
        });

        // Multi-INSERT schedule. The +100ms INSERT may land pre-SUBSCRIBED
        // and be dropped; +5s and +10s are the safety net. The function
        // returns on first delivered event.
        for (const [idx, offset] of [
          [0, 100],
          [1, 5_000],
          [2, 10_000],
        ] as const) {
          insertTimers.push(
            setTimeout(() => {
              sql.unsafe(`insert into ${table} (n) values (${idx})`).catch((e: Error) => {
                console.warn(`[smoke] insert n=${idx} failed: ${e.message}`);
              });
            }, offset),
          );
        }

        const { status, body } = await callPromise;
        const wall = performance.now() - t0;
        for (const t of insertTimers) clearTimeout(t);
        console.log(`[smoke] watch_table E2E wall=${wall.toFixed(0)}ms`);

        expect(status, `function returned HTTP ${status}`).toBe(200);
        expect(body.jsonrpc).toBe("2.0");
        expect(body.id).toBe(4);
        expect(body.error, `JSON-RPC error: ${JSON.stringify(body.error)}`).toBeUndefined();
        expect(
          body.result?.isError,
          `tool returned isError=true; content: ${body.result?.content?.[0]?.text}`,
        ).not.toBe(true);

        const text = body.result?.content?.[0]?.text ?? "";
        const out = JSON.parse(text) as {
          events: Array<{
            event: string;
            table: string;
            new: { n?: number; id?: string } | null;
          }>;
          closed_reason: string;
        };
        expect(out.closed_reason).toBe("max_events");
        expect(out.events).toHaveLength(1);
        const event = out.events[0];
        expect(event?.event).toBe("INSERT");
        expect(event?.table).toBe(table);
        // The chain regression check: if `new` comes back as null/empty
        // here, the GRANT + RLS chain isn't applying for some reason and
        // the smoke would otherwise silently pass on count alone.
        expect(event?.new, "new payload empty/null — likely GRANT+RLS chain broken").toBeTruthy();
        expect(typeof event?.new?.n).toBe("number");
        expect([0, 1, 2]).toContain(event?.new?.n);
      } finally {
        for (const t of insertTimers) clearTimeout(t);
        if (publicationAdded) {
          await sql
            .unsafe(`alter publication supabase_realtime drop table ${table}`)
            .catch((e: Error) => console.warn(`[smoke] publication drop failed: ${e.message}`));
        }
        if (tableCreated) {
          await sql
            .unsafe(`drop table if exists ${table}`)
            .catch((e: Error) => console.warn(`[smoke] table drop failed: ${e.message}`));
        }
        await sql.end();
      }
    },
    30_000,
  );
});
