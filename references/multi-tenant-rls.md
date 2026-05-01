# References — multi-tenant RLS + Realtime: the deep dive

Companion to [`references/rls-implications.md`](rls-implications.md). That page is the summary of "what does the skill assume about RLS"; this page is the operator's guide for "I'm building a multi-tenant app and want to wire `watch_table` + `broadcast_to_channel` correctly."

## ⚠ Two RLS layers, not one

Supabase Realtime evaluates RLS on **two independently-configured surfaces**. Confusing them is the #1 source of "events not arriving" bugs in multi-tenant deployments.

| Surface | Where RLS lives | Configured by | Affects |
|---|---|---|---|
| **Postgres-Changes** | RLS policies on the *underlying table* | `alter table X enable row level security; create policy ...` | `watch_table` deliveries — clients only get events for rows they could `SELECT` |
| **Broadcast / Presence Authorization** | RLS policies on `realtime.messages` | `create policy ... on realtime.messages` + client connects with `private: true` | `broadcast_to_channel` / `subscribe_to_channel` deliveries — clients only get messages for topics they're authorized for |

Both layers consume the same JWT, but:
- Postgres-Changes is automatic — enable RLS on the table and Realtime applies it server-side per-subscriber. No client-side change needed.
- Broadcast Authorization requires `private: true` on the channel config and explicit policies on `realtime.messages`. **Default is public.**

If you only configure one and assume the other is covered, you have a leak. Worked example below configures both.

## The `setAuth` requirement — the gap PR #5 closed

Until [PR #5 / commit `2026-05-01`](https://github.com/0xquinto/supabase-realtime-skill/pull/5), the artifact's `makeSupabaseAdapter` and `makeSupabaseBroadcastAdapter` factories set `Authorization: Bearer <jwt>` in the `createClient` global headers but never called `client.realtime.setAuth(jwt)`. PostgREST queries used the JWT correctly; the Realtime websocket fell back to the anon key (per `SupabaseClient.ts:307-340, 534-541`'s `_getAccessToken` path). RLS evaluated against `anon` — silent zero-event delivery if no anon policy existed; cross-tenant leak if an anon policy permitted reads.

**Post-fix:** all three call sites in this artifact now call `client.realtime.setAuth(authToken)` after `createClient`. If you're building your own `RealtimeAdapter` or wiring `@supabase/supabase-js` outside this skill, do the same. The Supabase docs say it directly: *"To use your own JWT with Realtime make sure to set the token after instantiating the Supabase client and before connecting to a Channel."*

`tests/smoke/multi-tenant-rls.smoke.test.ts` is the empirical receipt: pre-fix run produced `events_count=0` after 30s; post-fix run delivers own-tenant events and blocks cross-tenant ones.

## Production-grade schema shape

External research (5 production Supabase apps surveyed in [recon PR #4](https://github.com/0xquinto/supabase-realtime-skill/pull/4)) converges on the same skeleton:

```sql
-- Tenants (org/account/workspace — pick your noun)
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- Junction: users ↔ tenants. Users can belong to many tenants.
create table memberships (
  user_id uuid references auth.users(id) on delete cascade,
  organization_id uuid references organizations(id) on delete cascade,
  role text not null default 'member',
  primary key (user_id, organization_id)
);
create index on memberships (user_id);
create index on memberships (organization_id);

-- A tenant-scoped event table (your audit log, queue, whatever)
create table audit_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid references organizations(id) not null,
  event_type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on audit_events (organization_id);

alter publication supabase_realtime add table audit_events;
```

Then the RLS layer. Use a `SECURITY DEFINER STABLE` helper so the membership lookup runs once per query, not once per row:

```sql
-- Helper: SECURITY DEFINER bypasses RLS on memberships itself (which has its
-- own RLS); STABLE lets the planner cache the result within a query. Without
-- this, the inline subquery in the policy below pays a sequential scan per
-- row evaluation — fine at fixture scale, painful at production scale.
create or replace function private.user_organizations()
returns setof uuid
language sql
security definer
stable
as $$
  select organization_id from public.memberships where user_id = (select auth.uid())
$$;

alter table audit_events enable row level security;
alter table memberships enable row level security;

create policy "members can read tenant events"
  on audit_events for select
  to authenticated
  using (organization_id in (select * from private.user_organizations()));

create policy "users see own memberships"
  on memberships for select
  to authenticated
  using (user_id = (select auth.uid()));
```

Two patterns worth calling out:
- **`(select auth.uid())` not `auth.uid()`** — the subselect lets Postgres cache the JWT lookup once per query instead of recomputing per row. Documented on the [Supabase RLS performance page](https://supabase.com/docs/guides/database/postgres/row-level-security) under "Wrap functions in select."
- **`SECURITY DEFINER` on `private.user_organizations`** — bypasses RLS on `memberships` *only inside the helper*, so the audit-events policy can use it without recursing through memberships' own RLS. Don't grant `EXECUTE` on this helper to client-facing roles unless you mean to.

## Channel topology under tenant isolation

For Broadcast Authorization, channel naming + RLS policies on `realtime.messages` work together:

```sql
-- Allow members to subscribe to / send to broadcasts on their tenant's channel
create policy "tenant members can read tenant broadcasts"
  on realtime.messages for select
  to authenticated
  using (
    exists (
      select 1 from public.memberships
      where user_id = (select auth.uid())
        and ('tenant:' || organization_id::text || ':audit-feed') = (select realtime.topic())
        and realtime.messages.extension = 'broadcast'
    )
  );

create policy "tenant members can send tenant broadcasts"
  on realtime.messages for insert
  to authenticated
  with check (
    exists (
      select 1 from public.memberships
      where user_id = (select auth.uid())
        and ('tenant:' || organization_id::text || ':audit-feed') = (select realtime.topic())
        and realtime.messages.extension = 'broadcast'
    )
  );
```

Channel names embed the tenant id (`tenant:abc123:audit-feed`) and the policy enforces that the subscriber's memberships include that exact tenant. **The channel name is the load-bearing identifier — get it wrong on the client and the policy denies the subscribe.**

For the agent-side (in your Edge Function or backend code):

```ts
import { handleBroadcast } from "supabase-realtime-skill/server";

await handleBroadcast(
  {
    channel: `tenant:${organizationId}:audit-feed`,
    event: "deploy.completed",
    payload: { actor: userId, env: "production" },
  },
  { sender: yourSenderImpl },
);
```

The substrate doesn't enforce tenant scoping on channel names — that's the consumer's job. A composition-side eval gating consumer routing correctness (`cross_tenant_leakage_rate_max` candidate cell) is *deferred per [ADR-0012 § 2](../docs/decisions/0012-multi-tenant-audit-log-example.md)* — the substrate-side falsifiable receipt is the smoke test cited below; a fake-driven composition eval is in the ADR's roadmap, not yet shipped.

## Scale shape: where Postgres-Changes hits its ceiling

[Supabase's own docs](https://supabase.com/docs/guides/realtime/postgres-changes) flag this:

> *"If you have 100 users subscribed to a table where you make a single insert, it will then trigger 100 reads: one for each user. […] Database changes are processed on a single thread to maintain the change order."*

For 10k+ concurrent client subscribers, Postgres-Changes is the wrong shape. Their recommended pattern:

> *"Use Realtime server-side only and then re-stream the changes to your clients using a Realtime Broadcast."*

**The bounded-subscription primitive in this artifact IS that recommended pattern.** An Edge Function isolate consumes Postgres-Changes server-side via `boundedWatch`, then broadcasts to per-tenant private channels via `handleBroadcast`. Each tenant has one private channel; thousands of clients can subscribe to that channel via the Broadcast layer (which scales to many subscribers per channel).

```
┌─────────────────────────────────────────────────────────────────────┐
│  Edge Function isolate (one per drain pass, server-side)            │
│  ┌────────────────────┐    ┌────────────────────────────────────┐   │
│  │ boundedWatch        │───▶│ handleBroadcast                    │   │
│  │ on audit_events     │    │ to "tenant:${orgId}:audit-feed"    │   │
│  │ (Postgres-Changes,  │    │ (Broadcast, scales per-channel)    │   │
│  │  RLS via            │    └────────────────────────────────────┘   │
│  │  service_role)      │                  │                          │
│  └────────────────────┘                   ▼                          │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
                                   ▼ Realtime tenant Broadcast layer
            ┌──────────────────────┴──────────────────────┐
            ▼                                             ▼
       Tenant A clients                              Tenant B clients
   (subscribe with private:true,                 (subscribe with private:true,
    JWT carrying membership                       JWT carrying membership
    in tenant A; realtime.messages                in tenant B; realtime.messages
    RLS gates the join)                           RLS gates the join)
```

In this topology, the Edge Function uses `service_role` (it's server-side, not user-scoped) to read Postgres-Changes — RLS is bypassed there because the function is the trusted re-broadcaster. The **Broadcast** layer is where per-tenant RLS gates fan-out. That's the inversion that buys scale: read RLS once server-side, fan out via Broadcast where RLS is cached per-connection.

If your tenant count or per-tenant message volume is small (say <1k concurrent subscribers per tenant, <1k events/sec per tenant), the direct-Postgres-Changes-with-user-JWT pattern (what this artifact's smoke test demonstrates) is simpler and works. The re-stream pattern is the upgrade path when direct subscriptions hit the database thread bottleneck.

## Common pitfalls

### Echo prevention

Documented thoroughly in [SalesSheet.ai's writeup](https://salessheets.ai/blog/realtime-crm-supabase). When an authenticated client writes a row AND subscribes to the table, it receives the change event for its own write — which can clobber optimistic UI state. Solutions in production:

- **Track recent self-writes:** maintain a 3-second window of row IDs the current session has written; skip events for those IDs.
- **Cache invalidation over direct state patching:** when an event arrives, invalidate the relevant query cache and refetch — RLS-filtered, complete row, all consistent. Costs one extra request per event; eliminates partial-payload bugs.

The skill itself doesn't mediate this — it's a consumer concern. But the bounded primitives don't *prevent* either pattern; they're orthogonal.

### Connection pool contamination is NOT an issue for Edge Function isolates

[Tianpan's RAG RLS post](https://tianpan.co/blog/2026-04-17-vector-store-access-control-rag-rls) flags a real concern for connection-pool-backed apps: if a session variable wasn't reset before a connection was returned to the pool, the next request runs against the wrong tenant's data. Production incidents have happened.

**This doesn't apply to the Edge Function model.** Each function invocation is a fresh isolate; session state doesn't survive across requests. There's no shared pool to contaminate. If you're running this skill outside Edge Functions in a long-lived backend with a connection pool, that's where the discipline (`DISCARD ALL` before connection return; explicit session resets) matters. The artifact's reference deployment shape — Edge Function isolate per request — is contamination-immune by construction.

### What happens with no `Authorization` header

Today's behavior:
- `cfg.authToken` is undefined → `setAuth` is not called → supabase-js' `_getAccessToken` falls back to the anon key → RLS evaluates as `anon`
- Tables with no anon policies return zero rows → `watch_table` silently delivers nothing → looks like "the agent isn't seeing events"

**For multi-tenant deployments, treat a missing `Authorization` header as an error**, not a fallback to anon. Either:
- Require the header in your Edge Function entry (return 401 if missing)
- Document the expectation in your tool wrapper layer
- Wrap `makeSupabaseAdapter` in a thin layer that throws on `!authToken` for RLS-required tables

The artifact ships the lower-level primitive without enforcing this — operator chooses the policy. ADR-0011 § 4 is the design rationale.

### Don't use `auth.uid()` directly in policies on hot tables

Use `(select auth.uid())` instead. The subselect form gets cached once per query plan; the bare form re-evaluates the JWT lookup per row. At fixture scale you won't notice; at 100k+ rows in a single SELECT plan, you'll see a 10-100× slowdown.

## Worked example: end-to-end

The smoke test [`tests/smoke/multi-tenant-rls.smoke.test.ts`](../tests/smoke/multi-tenant-rls.smoke.test.ts) provisions:
- One Supabase Pro branch
- Two `auth.users` (tenant A's user, tenant B's user) created via `auth.admin.createUser` with `email_confirm: true`
- Two `memberships` entries
- The `audit_events` table with RLS policies above
- Two real JWTs (via `signInWithPassword`)

Then it subscribes as user A under their JWT, fires three own-tenant + two cross-tenant inserts, and asserts (a) own-tenant events arrive, (b) cross-tenant events are blocked. The receipt lives in [ADR-0011](../docs/decisions/0011-multi-tenant-rls-baseline.md).

A composition-side eval (consumer code keeping tenant isolation across batches, mixed-tenant events, adversarial `read_row` shapes) is named in the roadmap but not yet shipped — see [ADR-0012 § 2](../docs/decisions/0012-multi-tenant-audit-log-example.md) for the deferral rationale and [the recon](../docs/recon/2026-05-01-multi-tenant-worked-example-recon.md) § "Falsifiable predicted effect" for the proposed fixture shape.

## See also

- [`references/rls-implications.md`](rls-implications.md) — the high-level summary; this page is the deep dive
- [`references/edge-deployment.md`](edge-deployment.md) — operator setup that this page assumes
- [`references/queue-drain.md`](queue-drain.md) — the bounded primitive composition; layers cleanly with multi-tenant when channel names embed `tenant_id`
- [ADR-0011](../docs/decisions/0011-multi-tenant-rls-baseline.md) — the `setAuth` fix that closed the original gap
- [ADR-0012](../docs/decisions/0012-multi-tenant-audit-log-example.md) — this page's design context + the eval that gates the composition
- [Supabase — Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization) — the primary docs for Broadcast Authorization
