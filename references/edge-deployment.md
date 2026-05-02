# References — Edge Function deployment

Operator setup for running the `supabase-realtime` MCP server on Supabase Edge Functions.

## Prerequisites

- A Supabase project (Pro tier recommended; Free works but has tighter timeout caps)
- Supabase CLI installed: `brew install supabase/tap/supabase`
- The agent's JWT issuance pattern figured out (see § Auth)

## Deploy

```bash
# From your fork of supabase-realtime-skill
supabase functions deploy --no-verify-jwt mcp --project-ref <your-ref>

# Set required env vars
supabase secrets set --project-ref <your-ref> \
  SUPABASE_URL=https://<your-ref>.supabase.co \
  SUPABASE_ANON_KEY=<anon-key>
```

The function is now live at `https://<your-ref>.supabase.co/functions/v1/mcp`.

### Why `--no-verify-jwt`

Supabase's gateway-side JWT verification is incompatible with the asymmetric signing keys introduced post-2025 (per the [Supabase MCP guide](https://supabase.com/docs/guides/getting-started/byo-mcp) and the [matt-fournier MCP template](https://github.com/matt-fournier/supabase-mcp-template)). The function reads the `Authorization` header itself — gateway-side verification is redundant and currently breaks on these keys.

This means the function URL is publicly invocable. The function refuses tool calls without a forwarded JWT in production deploys; consumers should ensure their agent host always sets `Authorization: Bearer <jwt>`.

## Architecture choice — raw `Deno.serve`

The Supabase blessed pattern wraps with [Hono](https://hono.dev/); this artifact uses raw `Deno.serve`. Both work; both are documented runtime-portable hosts for the MCP SDK's `WebStandardStreamableHTTPServerTransport`. The choice trades:

- **Hono**: idiomatic basePath/CORS/health routing; +50KB+ to bundle; another version to track.
- **Raw `Deno.serve`**: smaller bundle; one less dep; explicit URL handling.

Raw is chosen for the v1.0 ship — the transport doesn't care which framework wraps it, and the function's surface (single POST + one GET liveness path) doesn't justify the extra dep. If you need multi-route handling beyond MCP + health, Hono is the documented upgrade path.

## Smoke test

```bash
curl -i https://<your-ref>.supabase.co/functions/v1/mcp/health \
  -H "Authorization: Bearer <anon-key>" \
  -H "Accept: text/plain"
```

Expected: `200 OK` with body `supabase-realtime-skill MCP — ok`.

For a full end-to-end check (`tools/list` + `tools/call` round-trips), run the smoke suite:

```bash
set -a && source .env && set +a && bun run vitest run tests/smoke/edge-deploy.smoke.test.ts
```

This exercises four probes against the deployed function:
- `tools/list` returns all 5 tools with their input schemas
- `GET /health` returns 200 plain-text
- `tools/call describe_table_changes` routes correctly (asserted via structured `INVALID_TABLE` against a guaranteed-not-there table — no host schema dependency)
- `tools/call broadcast_to_channel` returns `{success: true}` on a public channel (exercises `httpSend()` at runtime)

## Auth — JWT-forward-only (v1.0 contract)

The MCP server expects an `Authorization: Bearer <jwt>` header on every tool-call. That JWT propagates into:

- The Postgres-Changes subscription (so RLS applies to which rows the agent can see)
- The Realtime broadcast subscription / send (so channel-level auth applies via `setAuth()` on the websocket leg)

**v1.0 commits explicitly to JWT-forward-only.** The function is a thin pass-through:
- It does NOT mint or refresh tokens.
- It does NOT run an OAuth flow (which would require a Cloudflare Worker proxy at the domain root, since the MCP spec strips path prefixes — see [NAWA's writeup](https://www.trynawa.com/blog/how-we-built-an-mcp-server) for a production deployment that does this).
- It does NOT elevate to service-role internally — that's a security bug, not a feature.

Two issuance patterns work for the operator's side:

1. **Service-level JWT scoped to a workflow.** The agent runs with a long-lived JWT issued by the operator's auth service, scoped to the workflows it's allowed to participate in. RLS policies on watched tables match against the JWT's claims.
2. **Per-invocation JWT minted by the operator.** Every tool-call gets a fresh JWT scoped to that invocation. Higher security, more issuance overhead. Worth it if the agent shouldn't have continuous access to the data substrate.

OAuth/discovery support is a v2 question that depends on Supabase's "Auth support for MCP on Edge Functions is coming soon" landing — or on the operator running a Cloudflare Worker proxy in front of the function URL.

## Cold-start budget

First call to a freshly-deployed (or freshly-cold) Edge Function spends ~200-400ms on isolate startup before the bounded-subscription primitive's wallclock starts. The `latency_to_first_event_ms` p95 < 2000ms threshold absorbs this; you don't need to do anything special.

If you see consistent cold-starts above 600ms, check the bundle size — the function should be < 5MB; if it's larger, something's pulled in `node_modules` accidentally (Edge Functions should only import via `npm:` specifiers or relative paths).

## Wall-clock cap

Supabase Pro Edge Functions cap at 150 seconds. The `watch_table` and `subscribe_to_channel` tools cap `timeout_ms` at 120000 (120s) leaving 30s margin for connection setup, RPC overhead, and any post-event processing the agent does after the bounded subscription returns.

If you raise `timeout_ms`, you're fighting the runtime. Don't.

## Logs

```bash
supabase functions logs mcp --project-ref <your-ref> --tail
```

The MCP server logs structured JSON for every tool-call (input shape, error code, duration). Useful for ad-hoc debugging when a tool returns an unexpected error.

## See also

- `references/rls-implications.md` — what the JWT can see
- `references/predicates.md` — what filters work
- `references/multi-tenant-rls.md` — private-channel Broadcast Authorization (silent RLS denial mode)
- `manifest.json` — the deployed eval thresholds
