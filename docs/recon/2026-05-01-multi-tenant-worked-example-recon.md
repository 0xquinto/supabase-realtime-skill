# Recon: multi-tenant RLS-shaped worked example (2026-05-01)

Pre-draft recon for a third worked example that exercises the skill at *real-app shape*: multi-tenant Supabase project, RLS-enforced channel/table topology, agent operating under a forwarded user JWT (not `serviceRole`). Mirrors the shape of [`docs/recon/2026-05-01-deterministic-modules-recon.md`](2026-05-01-deterministic-modules-recon.md) — evidence first, ADR later. Filed on branch `recon/multi-tenant-worked-example`.

## Why this recon, why now

The artifact's two existing worked examples — the `support_tickets` triage agent and the `boundedQueueDrain` outbox forwarder — both demonstrate substrate primitives but operate in a **single-tenant world**: smoke tests use `serviceRole` (RLS bypass), schema has no tenant isolation, the MCP server's claimed "forwards the agent's JWT" is plumbed but never end-to-end verified. A senior engineer at a Supabase consumer (Notion, Linear, Discord-shape) reading the artifact today would flag four credibility gaps:

1. **No RLS-shaped worked example.** Production claims JWT forwarding; no example demonstrates it.
2. **No tenant-isolation contract.** No worked answer to "how do I keep tenant A's broadcasts from leaking to tenant B."
3. **Worked examples are toy.** Triage + queue-drain demonstrate the substrate but neither *looks like* a thing in a real product.
4. **No ops/scale story.** Existing eval is fixture-shaped; nothing about multi-tenant load shape.

This recon focuses on (1) + (2) + (3). (4) is out of scope — addressed by manifest calibration (ADR-0007 → n=300) and a future production-load study.

Two questions this recon has to answer before any drafting starts:

1. **Does the existing JWT-forwarding code actually work end-to-end against RLS?** Or is the claim pre-validated only at the PostgREST layer, with a gap on the Realtime websocket leg?
2. **What's the right *shape* for the worked example?** "Multi-tenant audit log → broadcast to tenant Slack channel" is the leading candidate; is there a stronger fit?

## Internal recon

### The JWT-forwarding plumbing is half-wired

`src/server/realtime-client.ts:90-91` (and `:272-273` for the broadcast adapter) sets `Authorization: Bearer <authToken>` in the `createClient` global headers. `supabase/functions/mcp/index.ts:36-43` reads the request `Authorization` header and forwards it through to `makeServer`. So the JWT *gets to* the `createClient` call.

**The gap:** for `@supabase/supabase-js` Realtime, the websocket handshake uses `client.realtime.setAuth(token)` to set the JWT used in RLS policy evaluation, NOT the `global.headers.Authorization` value. The current code may therefore evaluate RLS against the *anon* claims_role on the websocket leg, even though PostgREST calls would use the user's JWT. Quoting Supabase's [Realtime Authorization docs](https://supabase.com/docs/guides/realtime/authorization): *"To use your own JWT with Realtime make sure to set the token after instantiating the Supabase client and before connecting to a Channel."*

**Source-level confirmation** (verified against installed `@supabase/supabase-js`): `SupabaseClient.ts:307-340` wires `realtime.accessToken = this._getAccessToken.bind(this)` when no caller-supplied `accessToken` callback is passed. `_getAccessToken` (`SupabaseClient.ts:534-541`) calls `this.auth.getSession()` and returns `data.session?.access_token ?? this.supabaseKey`. In the Edge Function context — no persisted session, no `signInWith*` call — `auth.getSession()` resolves to no session, so `_getAccessToken` falls back to `this.supabaseKey` (the **anon key**) for the websocket. `realtime.setAuth(token)` is the documented override; it sets `accessTokenValue` on the underlying `RealtimeClient` (`RealtimeClient.ts:475`), short-circuiting the fallback. So the precise diagnosis is "websocket uses `supabaseKey` because the default `_getAccessToken` falls back," not "no JWT plumbing at all" — load-bearing for what the smoke test asserts.

**Why this hasn't surfaced:** all smoke tests use `serviceRole` (bypasses RLS); fast tests use mocked adapters (no real Realtime). The first multi-tenant smoke test with two real JWTs would either confirm the gap or rule it out. **This is the highest-leverage thing the worked example would catch.**

### Schema has no tenant-isolation precedent yet

`supabase/migrations/` carries `support_tickets` (the triage example's schema) and the queue-drain example's `queue` table. Neither has a `tenant_id` / `org_id` column or RLS policies. SKILL.md doesn't currently say anything about RLS prerequisites. Adding a multi-tenant worked example needs a new migration and a SKILL.md addition — both small, both load-bearing.

### `references/replication-identity.md` already disclaims one half of the substrate

The existing reference page covers replica identity; it doesn't cover RLS layering. Worth extending (or filing a sibling page `references/multi-tenant-rls.md`) with the operational model the worked example demonstrates.

### ADR-0010's `forward_correctness_rate_min` doesn't cover this gap

ADR-0010's manifest cell measures "boundedQueueDrain produces correct end-state given fixture inputs." It says nothing about RLS isolation. A multi-tenant worked example would need a new manifest cell (or a new metric in v2.0.0) — `tenant_isolation_rate_min` or similar. Same templated-expansion shape ADR-0007 already pre-stages for ADR-0010.

## External research findings

External agent ran a focused pass via Exa over: Supabase Realtime + RLS production patterns, multi-tenant SaaS RLS playbooks, MCP-server-with-tenant-isolation prior art, real apps shipping Supabase Realtime + multi-tenancy, agent-under-RLS-vs-service-role discourse. Headlines below; full evidence with source URLs cited inline.

### 1. Supabase Realtime has TWO RLS layers, not one

**Headline:** Postgres-Changes and Broadcast/Presence authorization use *different* RLS mechanisms. They're independently configurable; the worked example must address both or pick one and disclose the omission.

- **Postgres-Changes** respects RLS on the *underlying table* automatically — clients only get events for rows they could `SELECT` ([Supabase docs](https://supabase.com/docs/guides/realtime/postgres-changes#private-schemas)). The check happens in the WAL→RLS→subscriber path; no client-side configuration needed beyond a non-`service_role` JWT.
- **Broadcast and Presence** authorization (GA Apr 2024, [changelog](https://supabase.com/changelog/22484-realtime-broadcast-and-presence-authorization)) uses RLS policies on the `realtime.messages` table. Client must instantiate channel with `private: true`. Policy reads `realtime.topic()` + `auth.uid()` + JWT claims. Quote from [Supabase blog](https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization): *"Realtime checks RLS policies against your database on Channel subscription, so expect a small latency increase initially, but will be cached on the server so all messages will pass from client to server to clients with minimal latency."*

**Implication:** the worked example should demonstrate both layers — Postgres-Changes for the audit-log table read leg, Broadcast Authorization for the destination-channel write leg. The two RLS layers are independently configurable but consume the same JWT. Single end-to-end story, two RLS surfaces.

### 2. Postgres-Changes has a stated scale ceiling

**Headline:** Supabase's own docs ([Postgres-Changes scaling note](https://supabase.com/docs/guides/realtime/postgres-changes)) recommend *"using Realtime server-side only and then re-stream the changes to your clients using a Realtime Broadcast"* at high subscription counts, because change events are processed on a single thread and every event is RLS-checked per subscriber. *"If you have 100 users subscribed to a table where you make a single insert, it will then trigger 100 reads."*

**Implication:** the artifact's pattern (agent watches Postgres-Changes directly) has a scale ceiling. The worked example should include a "when this pattern stops scaling" disclosure — either in `references/multi-tenant-rls.md` or in the example's own page. The bounded-subscription primitive's whole point is "fits Edge Function isolate budgets," which already implies a per-isolate limit; the multi-tenant case is the place to make that scaling story explicit.

This is also a *positive* signal for the design: the bounded-subscription primitive is the natural fit for the "server-side Realtime → re-stream via Broadcast" pattern Supabase recommends. The Edge Function consumes Postgres-Changes server-side, then broadcasts to a per-tenant private channel. **That topology IS the recommended scaling shape.** Worth foregrounding.

### 3. Production Supabase apps converge on a small set of RLS patterns

**Headline:** Across [SalesSheet.ai](https://salessheets.ai/blog/realtime-crm-supabase), [merchi.ai](https://merchi.ai/blog/multi-tenant-from-day-one-and-why-it-s-worth-the-pain-building-merchi-ai-chapter-6), [IssueCapture](https://dev.to/issuecapture/row-level-security-in-supabase-multi-tenant-saas-from-day-one-4lon), [COOARD](https://mrhaseeb.com/case-studies/cooard-salon-platform), [ai-freelancer-ops](https://github.com/lachezarat/ai-freelancer-ops), [SupabaseMultiTenancyTemplate](https://github.com/0Itsuki0/SupabaseMultiTenancyTemplate), and [Social Animal's multi-tenant guide](https://socialanimal.dev/blog/multi-tenant-nextjs-supabase-rls-production/), the dominant pattern is:

- `tenant_id` (or `org_id` / `account_id`) column on every tenant-scoped table, with an index
- `memberships` (or `team_members`) junction table linking `auth.users` ↔ tenants with a `role` column
- RLS policies that read `auth.uid()` and check membership via subquery — wrapped in `SECURITY DEFINER STABLE` helper functions for performance
- `service_role` reserved for server-only Stripe webhooks / system jobs / admin tools — never exposed to clients
- JWT custom claims (`tenant_id` in `app_metadata`) via Auth Hook for the simple-tenancy case; junction-table lookup for the multi-tenant-membership case

**The "echo prevention + dedup window" pattern** ([SalesSheet.ai writeup](https://salessheets.ai/blog/realtime-crm-supabase)) is the most non-obvious operational learning: when an authenticated client writes a row and also subscribes to the table, it receives the change event for its own write, which can clobber optimistic UI state. SalesSheet's solution: track which row IDs the session has written within the last 3 seconds and skip self-events. **This is a real-app concern that toy worked examples skip; including it would substantially raise the demo's credibility.**

**Implication:** the worked example schema should mirror this shape (`tenant_id` column + `memberships` table + RLS policies via `SECURITY DEFINER` helper) — what production apps actually run, not a stripped-down demo. Echo prevention is worth a paragraph in the reference page even if the example doesn't fully implement it.

### 4. MCP-multi-tenant has converging prior art — but not for Realtime/CDC specifically

**Headline:** Several mature MCP-server-with-RLS implementations exist; none target Supabase Realtime / CDC. This is the gap.

Mapped neighbors:
- [ChatForest "MCP Multi-Tenant Architecture"](https://chatforest.com/guides/mcp-multi-tenant-patterns/) — comprehensive guide; recommends pooled model with JWT-claims tenant ID + RLS at DB layer + per-tenant credential vault. Generic Postgres, not Supabase-specific.
- [pgEdge postgres-mcp](https://github.com/pgEdge/pgedge-postgres-mcp) — per-user PostgreSQL connections with RLS pass-through. Generic Postgres.
- [kd444/enterprise-postgres-mcp](https://github.com/kd444/enterprise-postgres-mcp) — read-only role + RLS + JWT auth. Generic Postgres.
- [aws-samples/sample-bedrock-agentcore-multitenant](https://github.com/aws-samples/sample-bedrock-agentcore-multitenant) — AgentCore Runtime + Cognito JWT + Aurora RLS. AWS-stack specific.
- [Microsoft mcp-for-beginners Lab 2](https://www.mintlify.com/microsoft/mcp-for-beginners/labs/02-security) — Azure Entra ID + Postgres RLS + retail schema. Microsoft-stack specific.
- [Inventiple production MCP for Postgres](https://www.inventiple.com/blog/mcp-server-postgres-architecture) — read-only DB user + RLS pass-through + JWT-mapped Postgres role.

**None of these cover the Realtime / Broadcast Authorization layer.** Postgres-Changes RLS is the well-trod ground; multi-tenant Broadcast over private channels is unclaimed in agent-skill territory.

**Implication:** the artifact occupies a real gap — "agent observing a multi-tenant Realtime changefeed AND broadcasting to a tenant-private channel, all under forwarded JWT." None of the mapped neighbors cover both legs together. The supabase/agent-skills repo currently has zero RLS-specific or Realtime-specific skills (verified in [the deterministic-modules recon § 4](2026-05-01-deterministic-modules-recon.md)) — same gap as the queue-drain work, different axis.

### 5. Agent-under-RLS vs service-role is an active discourse

**Headline:** Multiple recent posts (Q1-Q2 2026) name the "agent with service-role credentials" pattern as a footgun. Headline incident from [Tianpan, "Agent Authorization in Production"](https://tianpan.co/blog/2026-04-09-agent-authorization-production-service-account-footgun): *"One retailer gave their AI ordering agent a service account. Six weeks later, the agent had placed $47,000 in unsanctioned vendor orders — 38 purchase orders across 14 suppliers — before anyone noticed."*

Recurring themes across [Blaxel](https://blaxel.ai/blog/multi-tenant-isolation-ai-agents), [Luminity Digital](https://luminitydigital.com/the-identity-problem-agents-create/), [Tianpan on cross-tenant leakage](https://tianpan.co/blog/2026-04-10-cross-tenant-data-leakage-llm-infrastructure), and [Tianpan on RAG RLS](https://tianpan.co/blog/2026-04-17-vector-store-access-control-rag-rls):

- Service accounts → ambient authority → permissions accumulate silently
- Workload identity federation > long-lived API keys
- "Permission preservation": agents must inherit user's permission scope, not service's
- "Backend services, not the language model, should resolve tenant context. That prevents the LLM context window from becoming a cross-tenant data exfiltration path." (Blaxel)
- Database-layer RLS is stronger than app-layer filtering precisely because it survives bugs in LLM-generated queries

**Implication:** the artifact's existing "the function never elevates" claim aligns with this discourse exactly — but the worked example is what *demonstrates* the alignment. Cite Tianpan's $47k retailer incident as the failure mode the substrate prevents; cite Anthropic's "deterministic interior, agentic boundary" thesis (already cited in the queue-drain recon) for the design discipline.

There's also a Postgres-specific gotcha worth flagging from [Tianpan's RAG RLS post](https://tianpan.co/blog/2026-04-17-vector-store-access-control-rag-rls): connection pool contamination — if a connection's session variable wasn't reset, the next request runs against the wrong tenant. *"Always reset session variables before returning connections to the pool; use `DISCARD ALL` or explicit resets."* **This is an operational concern the worked example needs a position on.** For our Edge Function isolate model (one drain per invocation, fresh client per call), connection pool contamination shouldn't apply — the isolate-per-request boundary already provides session isolation. Worth stating explicitly.

## Design decisions the ADR has to make explicitly

In rough order of how much they affect the rest:

1. **Worked-example shape.** Three candidates from the research:
   - **(a) Multi-tenant audit log** — `audit_events` table with `tenant_id`; agent watches changes via Postgres-Changes; broadcasts notable events to `tenant:{id}:audit-feed` private channel. Leading candidate: covers both RLS layers, mirrors a real B2B SaaS surface, fits the existing "agent observes DB → reacts" mental model.
   - **(b) Multi-tenant collaborative editing** — cursor positions / typing indicators via Broadcast on per-document private channels. Strong "Notion-shape" demo, but Postgres-Changes barely involved; weaker substrate-coverage.
   - **(c) Multi-tenant outbox-to-Slack** — extends the existing `boundedQueueDrain` example with tenant scoping. High composition value (third leaf in the comparison table), but fewer net new RLS surfaces.
   - Recommend **(a)**; (c) as a stretch follow-up if the audit-log shape lands cleanly.

2. **Tenancy model.** Single-tenant-per-user (JWT carries `tenant_id` claim, simple RLS) vs. multi-tenant-membership (junction table, user can have multiple tenant memberships). External research says (b) is the production-grade shape; (a) is the demo shape. Recommendation: **ship (b)** — junction-table is what a Notion engineer expects; settling for (a) reads as "didn't go all the way."

3. **JWT propagation fix.** Current code sets `global.headers.Authorization` but may not call `client.realtime.setAuth(token)`. Decision: (i) add `setAuth` call to `makeSupabaseAdapter` and `makeBroadcastSender`, (ii) ship the worked example without it and document the gap, or (iii) defer until smoke test confirms the gap. **Recommend (i)** — it's a small fix that closes a real gap; the multi-tenant smoke test then verifies both paths.

4. **Falsifiable predicted effect.** Two plausible shapes:
   - **(α) Tenant isolation rate:** zero cross-tenant leakage events across N fixtures with two-tenant configurations. Binary scoring per fixture (any leak = FAIL). Wilson-CI-gated at n=100/n=300.
   - **(β) JWT-forwarding correctness:** for each fixture pair (tenant A, tenant B), the agent operating as tenant A only observes/broadcasts to tenant A's surface. Same shape as (α) but per-pair instead of per-fixture.
   - Recommend **(α)** for simplicity — keeps the manifest cell shape uniform with `forward_correctness_rate_min`.

5. **Smoke test infrastructure.** Existing `tests/smoke/_helpers/` provisions a single branch; the multi-tenant test needs two real tenants with two JWTs. Two options:
   - **(i)** One branch, two `auth.users`, two organizations in `public.organizations`, one membership each. Smoke test logs in as each in turn via `signInWithPassword` to get real JWTs.
   - **(ii)** Two branches. Heavier, no point — RLS is enforced at the row level, not the database level.
   - Recommend **(i)**.

6. **Manifest extension.** New cell `tenant_isolation_rate_min` (or rename to `cross_tenant_leakage_rate_max` for symmetry with `missed_events_rate_max`). Pre-stage in ADR-0007 v2.0.0 design at the same time as `forward_correctness_rate_min`. Gating tightness is deferred to the ADR — see open question 3 below. The argument for "0/N at any tier, no Wilson cushion" is that any leak is a critical bug; the argument against is ADR-0001's "FAIL-by-design at small n" precedent (Wilson upper at p̂=0, n=20 ≈ 0.16 — not a real gate at the ci-fast tier). Both arguments are strong; ADR-0011 should commit, this recon shouldn't.

## Falsifiable predicted effect (draft)

Per playbook § 8, no recommendation without a falsifiable predicted effect. External research suggests this shape:

> **An agent operating under a forwarded user JWT, given the multi-tenant skill primitives (`watch_table` + `broadcast_to_channel` + `boundedQueueDrain`), produces zero observable cross-tenant data leakage across an n-fixture corpus where each fixture pairs a "tenant A operator" with a "tenant B injection" and asserts that no event from B reaches A's listener nor vice versa.**

Properties this predicted effect has:
- **Binary scoring** (per-fixture: did any event cross tenants? yes/no). Matches playbook § 8.
- **Falsifiable in both directions.** If `setAuth` isn't called, leakage shows up immediately on the Realtime websocket leg; if `realtime.messages` RLS isn't configured, leakage shows up on the Broadcast leg. If everything's wired right, leakage stays 0. Both outcomes are informative.
- **Wilson-CI gateable** at n=100 (ci-full) and n=300 (v2.0.0). At n=300, p̂=0 → upper bound 0.0125 → tight gate.
- **Requires new fixtures.** `fixtures/ci-fast/multi-tenant/` directory, ~7-15 fixtures covering: same-table same-tenant baseline (no leakage expected), same-table cross-tenant (leakage forbidden), broadcast same-channel same-tenant, broadcast same-channel-name different-tenant (forbidden), nested membership (user A in tenants X+Y, user B in tenant Y only — A sees Y, B doesn't see X). Cost: similar to v0.1 corpus synthesis (~$0.50 in LLM calls + spot-check, mostly hand-curated).

Plausible candidate metric names for the v2.0.0 manifest:
- `cross_tenant_leakage_rate_max` (recommended — symmetric with `missed_events_rate_max`)
- `tenant_isolation_rate_min` (alternative — symmetric with `action_correctness_rate_min`)

## Where design risk concentrates

1. **The JWT-`setAuth` gap.** If real Realtime client behavior diverges from "global.headers picks up JWT for websocket too," the existing artifact's RLS-claim is wrong. The multi-tenant worked example is the shortest path to confirmation; can't be worked around or deferred. **Highest priority of the design risks listed here.**
2. **Two RLS layers documented as one.** Easy to write a reference page that conflates Postgres-Changes RLS with Broadcast Authorization RLS. They use the same JWT but configure differently and fail differently. Reference page must keep them distinct.
3. **`realtime.messages` RLS performance.** Cached per-connection — the policy-eval cost lives at channel join, not per-event. But policies that join through `memberships` need a `SECURITY DEFINER STABLE` helper or every connection pays a sequential scan. External research is consistent on this; the worked example needs the helper.
4. **Connection pool contamination is a non-issue here, but operators may carry the worry forward.** Address explicitly in `references/multi-tenant-rls.md`: "Edge Function isolates are per-request; session variables don't survive across invocations; no `DISCARD ALL` discipline required." Otherwise operators reading the artifact who came from a long-lived-pool world will assume there's a hidden footgun.
5. **Tenancy model conflation in fixtures.** Fixtures need to encode (tenant_id, user_id, JWT, expected_visibility) tuples cleanly. Existing fixture shape is row-oriented; multi-tenant fixtures need an "actors" structure. Fixture schema will diverge from `fixtures/ci-fast/queue-drain/qd*.json`.
6. **Anthropic-published cover for "agents under RLS" doesn't exist with the same explicitness as for the deterministic-substrate thesis.** The closest cover is the workload-identity / ambient-authority discourse cited above — useful but not Anthropic-stamped. Frame the design around "operationalizing well-known production-engineering hygiene for the Supabase substrate" rather than "applying a stated principle."

## What this means for the next step

**Direction:** derivative on the underlying patterns (multi-tenant RLS is mature; JWT-forwarding is mature) but **novel on the composition** — agent operating under forwarded JWT, both Postgres-Changes RLS and Broadcast-Authorization RLS exercised in one worked example, eval-gated against a `cross_tenant_leakage_rate_max` cell, all in the supabase/agent-skills shape. None of the mapped neighbors cover all three legs together for the Supabase substrate.

**Recommended ADR pre-loads:**

- **Sequence the smoke test BEFORE the `setAuth` fix.** Falsifiable shape: write the two-tenant smoke test against current code first (expects FAIL — anon-claims-role evaluation lets cross-tenant events leak); then land `setAuth` in `makeSupabaseAdapter` + `makeBroadcastSender`; then re-run (expects PASS). This produces a baseline-before-gate trail that mirrors ADR-0010's n=7 baseline pattern. Skipping the FAIL run means the gap goes unverified; the fix is then a faith-based change, not an evidence-based one.
- Ship the multi-tenant audit-log worked example (option (a) above), with junction-table tenancy (option 2.b above), demonstrating both Postgres-Changes RLS *and* Broadcast Authorization RLS.
- **Sketch the multi-tenant fixture schema in ADR-0011's body** before the manifest cell name lands. Tuple shape `(tenant_id, user_id, JWT, expected_visibility)` per fixture, with at minimum the five scenarios named in § "Falsifiable predicted effect" (same-table baseline, same-table cross-tenant, broadcast same-tenant, broadcast cross-tenant, nested membership). Mirror how ADR-0010 sketched `qd*.json` shape inline. Without this, the manifest cell name precedes the fixture infra and the gate is un-runnable.
- Pre-stage `cross_tenant_leakage_rate_max` in ADR-0007's v2.0.0 manifest design alongside `forward_correctness_rate_min` — same templated-amendment shape.
- File `references/multi-tenant-rls.md` covering the two RLS layers, the JWT-`setAuth` requirement, the connection-pool-contamination non-issue, the Postgres-Changes scale ceiling (and where the bounded primitive fits in the recommended re-stream pattern).
- Frame the ADR as "closing the substrate-claim gap on RLS" — not as "a new feature." The artifact already claims JWT forwarding; this work *verifies* it.

These are recommendations, not decisions — the ADR will be filed as **Proposed**, per ADR status discipline (don't mark Accepted until the operator decides + the eval lands).

**Open questions deferred to the ADR pass:**

- Whether the JWT-`setAuth` fix needs a backward-compatibility path (probably not — current behavior is broken when authToken is set, just silently degrades to anon claims_role).
- Whether to address the echo-prevention pattern (SalesSheet.ai writeup) inside this worked example or defer to a separate ADR.
- Whether `cross_tenant_leakage_rate_max` should gate at n=20 (ci-fast) or only at n=100 (ci-full). Tight gate at small-n is mechanically meaningful here because *any* leak = FAIL, unlike `action_correctness` where small-n CI bounds are unreachable. Cross-references decision (6) above — the recon doesn't pick.
- Whether the worked example should cover Presence too, or stick to Postgres-Changes + Broadcast. (Recommend stick — Presence in the JD-pivot context was already deferred per the v0.1.x "judgment about what to defer" framing.)
- **What's the contract when an MCP request arrives with no `Authorization` header?** Today `realtime-client.ts:90-91` makes the header conditional (`if (cfg.authToken)`); after the `setAuth` fix, the same conditional applies. RLS-required tables would then return zero rows under anon claims — silent-empty failure. ADR should commit on whether `makeSupabaseAdapter` errors loudly when `authToken` is missing on an RLS-required table (caller's responsibility to opt out for public-read shapes), or whether silent-empty is acceptable as the operator's-job framing. Tianpan's "permission preservation" framing (cited above) makes this a real design choice, not a corner case.

## References

**Internal:**
- [`docs/recon/2026-05-01-deterministic-modules-recon.md`](2026-05-01-deterministic-modules-recon.md) — recon shape this doc mirrors
- [`src/server/realtime-client.ts`](../../src/server/realtime-client.ts) — JWT-forwarding plumbing (lines 90-91, 272-273)
- [`supabase/functions/mcp/index.ts`](../../supabase/functions/mcp/index.ts) — Edge Function reads `Authorization` header, forwards to `makeServer`
- [`docs/decisions/0007-pre-stage-v2-manifest-design.md`](../decisions/0007-pre-stage-v2-manifest-design.md) — manifest expansion pattern; new cell pre-stages here
- [`docs/decisions/0010-bounded-queue-drain.md`](../decisions/0010-bounded-queue-drain.md) — sibling worked-example ADR; same templated shape this work would follow
- [`tests/smoke/_helpers/`](../../tests/smoke/_helpers/) — branch provisioning + key fetch; needs a two-tenants helper layered on top
- [`references/replication-identity.md`](../../references/replication-identity.md) — companion reference page; this work would file `references/multi-tenant-rls.md` alongside

**External (primary weight):**
- [Supabase — Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization) — `private: true` channels + `realtime.messages` RLS
- [Supabase — Realtime Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes) — Postgres-Changes RLS pass-through + scale ceiling
- [Supabase — Broadcast and Presence Authorization (blog)](https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization) — GA Apr 2024 walkthrough + policy-cache mechanism
- [Supabase — Realtime Authorization changelog](https://supabase.com/changelog/22484-realtime-broadcast-and-presence-authorization) — release notes + flow diagram

**External (multi-tenant Supabase production patterns):**
- [SalesSheet.ai — Building Real-Time CRM Collaboration with Supabase Realtime](https://salessheets.ai/blog/realtime-crm-supabase) — dedup window + echo prevention + cache-invalidation-over-direct-state-patching
- [merchi.ai — Multi-Tenant from Day One](https://merchi.ai/blog/multi-tenant-from-day-one-and-why-it-s-worth-the-pain-building-merchi-ai-chapter-6) — JWT app_metadata + middleware + RLS triple-lock
- [Social Animal — Multi-Tenant Next.js Supabase RLS Guide](https://socialanimal.dev/blog/multi-tenant-nextjs-supabase-rls-production/) — junction table + index-on-tenant-id + 50ms→8s incident
- [DesignRevision — Supabase RLS Guide](https://designrevision.com/blog/supabase-row-level-security) — Realtime RLS via underlying-table policies
- [DEV — Row-Level Security in Supabase: Multi-Tenant SaaS from Day One](https://dev.to/issuecapture/row-level-security-in-supabase-multi-tenant-saas-from-day-one-4lon) — security definer helper for membership lookups
- [COOARD case study](https://mrhaseeb.com/case-studies/cooard-salon-platform) — SECURITY DEFINER `get_my_salon_id()` helper pattern
- [SupabaseMultiTenancyTemplate](https://github.com/0Itsuki0/SupabaseMultiTenancyTemplate) — production-grade RLS template
- [ai-freelancer-ops](https://github.com/lachezarat/ai-freelancer-ops) — Supabase + Stripe + Edge-Functions + RLS portfolio piece
- [Techbuddies — PostgreSQL RLS for Multi-Tenant SaaS](https://www.techbuddies.io/2026/02/04/how-to-implement-postgresql-row-level-security-for-multi-tenant-saas-2/) — `app.current_tenant` GUC pattern + USING vs WITH CHECK

**External (MCP multi-tenant prior art):**
- [ChatForest — MCP Multi-Tenant Architecture](https://chatforest.com/guides/mcp-multi-tenant-patterns/) — pooled model + JWT claims + per-tenant credential vault
- [pgEdge postgres-mcp — Row-Level Security guide](https://github.com/pgEdge/pgedge-postgres-mcp/blob/main/docs/advanced/row-level-security.md) — per-user PG connections + session-variable RLS
- [kd444/enterprise-postgres-mcp](https://github.com/kd444/enterprise-postgres-mcp) — read-only role + RLS + JWT auth
- [aws-samples/sample-bedrock-agentcore-multitenant](https://github.com/aws-samples/sample-bedrock-agentcore-multitenant) — Cognito JWT + AgentCore + Aurora RLS
- [Microsoft mcp-for-beginners — Lab 2 Security & Multi-Tenancy](https://www.mintlify.com/microsoft/mcp-for-beginners/labs/02-security) — Entra ID + Postgres RLS reference implementation
- [Inventiple — Production MCP for Postgres](https://www.inventiple.com/blog/mcp-server-postgres-architecture) — read-only + RLS pass-through

**External (agent-under-RLS discourse):**
- [Tianpan — Agent Authorization in Production](https://tianpan.co/blog/2026-04-09-agent-authorization-production-service-account-footgun) — $47k retailer incident; service-account ambient-authority anti-pattern
- [Tianpan — Cross-Tenant Data Leakage in Shared LLM Infrastructure](https://tianpan.co/blog/2026-04-10-cross-tenant-data-leakage-llm-infrastructure) — RLS-as-strong-default + connection-pool contamination + memory-leak audit test
- [Tianpan — Vector Store Access Control: The RLS Problem Most RAG Teams Skip](https://tianpan.co/blog/2026-04-17-vector-store-access-control-rag-rls) — pgvector + RLS + permission preservation
- [Blaxel — Multi-tenant isolation for AI agents](https://blaxel.ai/blog/multi-tenant-isolation-ai-agents) — three storage models (pool/bridge/silo); LLM should never resolve tenant context
- [Luminity Digital — The Identity Problem Agents Create](https://luminitydigital.com/the-identity-problem-agents-create/) — workload identity federation > long-lived service accounts
- [learnwithparam — User and session models for multi-tenant AI agents](https://www.learnwithparam.com/blog/user-session-models-multi-tenant-ai-agents) — three-level scope (tenant/user/session) + tenant guard pattern
- [FraiseQL — Multi-Tenancy Architecture](https://fraiseql.dev/guides/multi-tenancy/) — JWT inject pattern + `SET LOCAL app.tenant_id` + cross-tenant audit test

**External (Anthropic — already cited in queue-drain recon):**
- [Anthropic — Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — deterministic interior, agentic boundary
- [Anthropic — Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) — skill-module pattern
