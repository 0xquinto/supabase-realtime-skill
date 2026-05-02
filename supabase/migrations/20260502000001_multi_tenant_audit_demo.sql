-- supabase/migrations/20260502000001_multi_tenant_audit_demo.sql
--
-- Worked-example schema for the multi-tenant audit-log demo. Promoted from
-- tests/smoke/multi-tenant-rls.smoke.test.ts (which still applies this file
-- as setup — see ADR-0014). Demonstrates the substrate-correctness fixes
-- shipped in ADR-0011 (Postgres-Changes RLS under forwarded JWT) and
-- ADR-0013 (Broadcast Authorization on private channels).
--
-- Two RLS layers are exercised by this schema:
--
--   Layer 1 — Postgres-Changes RLS (table-level, automatic):
--     `audit_events` has RLS enabled with a policy that admits authenticated
--     users only for tenants they're a member of via `memberships`. When a
--     consumer subscribes via Postgres-Changes under a forwarded user JWT,
--     Realtime evaluates this policy server-side and filters rows before
--     dispatching events. Cross-tenant events never leave the database.
--
--   Layer 2 — Broadcast Authorization RLS (`realtime.messages`):
--     Two policies on `realtime.messages` (one for SELECT — subscribe-time
--     gate; one for INSERT — send-time gate) match the JWT identity against
--     `public.user_tenant_ids()` and the `tenant:<uuid>:audit-feed` topic
--     shape. Both policies require `private: true` on the channel — public
--     channels skip the gate entirely.
--
-- Operators reading this should also read references/multi-tenant-rls.md
-- for the full operational model (channel topology, scaling story, silent-
-- filtering failure mode).

-- ---------- memberships (junction table) ----------
-- Production deployments may carry richer fields (role, joined_at, etc.).
-- Demo keeps it minimal: just the user ↔ tenant edge.

create table memberships (
  user_id uuid references auth.users(id) on delete cascade,
  tenant_id uuid not null,
  primary key (user_id, tenant_id)
);

alter table memberships enable row level security;

create policy "users see own memberships" on memberships
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------- audit_events (tenant-scoped event log) ----------
-- Tenant-scoped: every row carries `tenant_id`. RLS policy admits only
-- authenticated users whose `auth.uid()` is a member of the row's tenant.
-- No anon policy — under the pre-ADR-0011 setAuth gap, websocket evaluation
-- against anon claims_role would see zero rows, which is the bug.

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  event_type text not null,
  payload jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index on audit_events (tenant_id);

alter table audit_events enable row level security;

create policy "tenant members can read audit_events" on audit_events
  for select to authenticated
  using (
    tenant_id in (
      select tenant_id from memberships where user_id = (select auth.uid())
    )
  );

-- Add to the realtime publication so Postgres-Changes can stream events.
alter publication supabase_realtime add table audit_events;

-- ---------- user_tenant_ids() helper ----------
-- SECURITY DEFINER STABLE so the membership lookup runs once per connection
-- (Realtime caches per-connection policy results — see Supabase blog on
-- Broadcast and Presence Authorization). Without this helper, the
-- realtime.messages policies below would re-run the membership lookup per
-- broadcast under load.

create or replace function public.user_tenant_ids()
returns uuid[]
language sql
security definer
stable
as $$
  select coalesce(array_agg(tenant_id), '{}')
  from public.memberships
  where user_id = (select auth.uid())
$$;

-- ---------- realtime.messages RLS — Layer 2 ----------
-- Topic shape: `tenant:<uuid>:audit-feed`. Both policies parse the topic
-- via realtime.topic() (only available inside realtime.messages policies),
-- extract the tenant uuid, and check membership.
--
-- SELECT policy is the subscribe-time gate: rejects channel join if the
-- JWT identity isn't a member of the topic's tenant.
--
-- INSERT policy is the send-time gate: rejects broadcast if the JWT
-- identity isn't a member. Note: when this policy denies, the substrate
-- does NOT throw an error to the sender — REST returns 202, the row is
-- filtered out by RLS, no fan-out occurs. Documented in
-- references/multi-tenant-rls.md § "Failure mode".

create policy "tenant members can subscribe to audit feed"
  on realtime.messages for select
  to authenticated
  using (
    (string_to_array(realtime.topic(), ':'))[1] = 'tenant'
    and ((string_to_array(realtime.topic(), ':'))[2])::uuid = any (public.user_tenant_ids())
  );

create policy "tenant members can broadcast to audit feed"
  on realtime.messages for insert
  to authenticated
  with check (
    (string_to_array(realtime.topic(), ':'))[1] = 'tenant'
    and ((string_to_array(realtime.topic(), ':'))[2])::uuid = any (public.user_tenant_ids())
  );
