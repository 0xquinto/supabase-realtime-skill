# References — RLS + Realtime + broadcast auth

Three places RLS interacts with this skill:

## 1. `watch_table` reads honor table RLS

Realtime's Postgres-Changes subscription runs *as the JWT identity attached to the WebSocket connection*. The MCP server forwards the agent's `Authorization: Bearer <jwt>` header into the Realtime client config, which propagates to `auth.uid()` in RLS policies.

What this means in practice:

- If a policy says `using (auth.uid() = user_id)`, the agent only sees row-changes for rows that pass that check.
- If RLS is *disabled* on the table, the agent sees every change. That's fine for internal tables but a trap on user-facing tables.
- If RLS is *enabled* but no policy applies, the agent sees nothing. Silent. The `missed_events_rate` metric in the eval harness catches this — `describe_table_changes` reports `rls_enabled: true` so you can investigate.

The opinionated default: **always enable RLS on tables that an agent watches**, with a policy that reflects the agent's intended scope. Surfacing this constraint in `describe_table_changes` is intentional.

## 2. Broadcast channels can require auth

By default, broadcast channels are open. Anyone with the project's `anon` key can `subscribe` and `send`. For agent workflows, this is usually wrong — the agent's coordination channel shouldn't be readable by every user of the app.

Lock down with channel-level Realtime auth: require a JWT to subscribe, and check claims in a Postgres-side policy. The Supabase docs cover the mechanism (Realtime Authorization, GA April 2026); the design of the JWT issuance pattern is your call. v1 of this skill assumes the agent runs with a service-level JWT scoped to its workflow's channels.

## 3. The Edge Function deployment forwards the caller's JWT

When the MCP server is deployed as an Edge Function, the agent's tool-call arrives with `Authorization: Bearer <agent-jwt>`. The function forwards that header into both the Postgres-Changes client (for `watch_table`) and the Realtime broadcast client (for `broadcast_to_channel` / `subscribe_to_channel`).

This means the *agent's* identity is what gates access — not the Edge Function's service role. The function is a thin pass-through for auth.

Two operational implications:

- **The agent must hold a usable JWT** scoped to the workflow it's executing. Issuance is the operator's problem; `references/edge-deployment.md` documents the pattern v1 assumes.
- **The function never elevates.** If the agent's JWT can't read the table, neither can the function. There's no "service role escape hatch" — that would be a security bug, not a feature.

## Common pitfalls

- "I added an RLS policy and now `watch_table` sees nothing" — check that the policy matches the JWT identity the agent is running as. Use `select auth.uid()` in a quick `psql` session to confirm.
- "I locked down a broadcast channel and `subscribe_to_channel` returns no events" — ensure the agent's JWT carries the claim the channel-level policy checks.
- "INSERT events have no `old` row" — that's not an RLS thing, it's `REPLICA IDENTITY`. See `references/replication-identity.md`.
