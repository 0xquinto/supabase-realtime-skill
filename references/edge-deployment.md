# References — Edge Function deployment

Operator setup for running the `supabase-realtime` MCP server on Supabase Edge Functions.

## Prerequisites

- A Supabase project (Pro tier recommended; Free works but has tighter timeout caps)
- Supabase CLI installed: `brew install supabase/tap/supabase`
- The agent's JWT issuance pattern figured out (see § Auth)

## Deploy

```bash
# From your fork of supabase-realtime-skill
supabase functions deploy mcp --project-ref <your-ref>

# Set required env vars
supabase secrets set --project-ref <your-ref> \
  SUPABASE_URL=https://<your-ref>.supabase.co \
  SUPABASE_ANON_KEY=<anon-key>
```

The function is now live at `https://<your-ref>.supabase.co/functions/v1/mcp`.

## Smoke test

```bash
curl -i https://<your-ref>.supabase.co/functions/v1/mcp \
  -H "Authorization: Bearer <anon-key-or-agent-jwt>"
```

Expected: `200 OK` with body `supabase-realtime-skill MCP — transport pending`.

## Auth — the agent's JWT

The MCP server expects an `Authorization: Bearer <jwt>` header on every tool-call. That JWT propagates into:

- The Postgres-Changes subscription (so RLS applies to which rows the agent can see)
- The Realtime broadcast subscription (so channel-level auth applies)

Two issuance patterns work:

1. **Service-level JWT scoped to a workflow.** The agent runs with a long-lived JWT issued by the operator's auth service, scoped to the workflows it's allowed to participate in. RLS policies on watched tables match against the JWT's claims.
2. **Per-invocation JWT minted by the operator.** Every tool-call gets a fresh JWT scoped to that invocation. Higher security, more issuance overhead. Worth it if the agent shouldn't have continuous access to the data substrate.

v1 of the bundle is agnostic to which pattern you pick; the function is a thin pass-through. **Don't have the function elevate to service-role internally** — that's a security bug, not a feature.

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
- `manifest.json` — the deployed eval thresholds
