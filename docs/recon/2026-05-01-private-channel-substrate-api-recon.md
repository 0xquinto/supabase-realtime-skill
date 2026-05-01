# Recon: private-channel substrate API (2026-05-01)

Pre-draft recon for the **second** load-bearing pre-condition of the multi-tenant audit-log worked example deferred in [ADR-0012](../decisions/0012-multi-tenant-audit-log-example.md). ADR-0011 closed the JWT-`setAuth` gap on the Realtime websocket leg (Postgres-Changes RLS now evaluates against the user's JWT). This recon scopes the **Broadcast Authorization** half: the substrate API for sending and subscribing on `private: true` channels under forwarded JWTs, plus the modernization question raised by `httpSend()` (added to `realtime-js` in October 2025). Filed on branch `recon/private-channel-substrate-api`. Mirrors the shape of [`docs/recon/2026-05-01-multi-tenant-worked-example-recon.md`](2026-05-01-multi-tenant-worked-example-recon.md) — evidence first, ADR later.

## Why this recon, why now

ADR-0011 verified that the Postgres-Changes leg of multi-tenant RLS works under forwarded JWT after the `setAuth` fix. The smoke test ([`tests/smoke/multi-tenant-rls.smoke.test.ts`](../../tests/smoke/multi-tenant-rls.smoke.test.ts)) covers exactly one of the two RLS layers documented in [`references/multi-tenant-rls.md`](../../references/multi-tenant-rls.md): table-level RLS on the WAL→subscriber path. The other layer — Broadcast Authorization on `realtime.messages` — is *unexercised* in current code. The current `broadcast_to_channel` and `subscribe_to_channel` handlers default to **public** channels (`supabaseClient.channel(name)` with no `config.private` flag). Under a public channel, `realtime.messages` RLS is bypassed by the substrate; tenant isolation on the broadcast leg is not a property the substrate enforces.

Two questions this recon has to answer before any drafting:

1. **What's the right surface for opting in to private channels?** Per-tool input flag (`private: true` in `BroadcastInput` / `SubscribeChannelInput`)? Server-config-level flag (all channels are private)? Auto-detection by topic shape (`tenant:*` ⇒ private)?
2. **Should we migrate broadcast send to `httpSend()` while we're touching the call site?** The implicit `send()`-falls-back-to-REST path now logs a deprecation warning in installed supabase-js; an explicit `httpSend()` call is the recommended modern pattern. The recon should make a recommendation but not pre-empt the ADR.

## Internal recon

### Three call sites need touching, all the same shape as ADR-0011

The `private` flag belongs on `client.channel(name, { config: { private: true } })` per the `RealtimeChannelOptions` type in `node_modules/@supabase/realtime-js/dist/main/RealtimeChannel.d.ts:11-35`. Three places construct channels in the server:

- **`src/server/server.ts:155`** — `broadcast_to_channel` handler. Inline `supabaseClient.channel(input.channel)` inside the `BroadcastSender.send` closure. Subscribes-then-sends over the websocket; this is the path that needs the `private` flag *and* the `httpSend()` migration question.
- **`src/server/realtime-client.ts:122`** — `makeSupabaseAdapter`'s `subscribe()` method. `client.channel(channelName)` for Postgres-Changes; takes the topic string `realtime:${schema}:${table}`. Note: this is the **Postgres-Changes** path, not Broadcast — `private: true` does NOT apply to Postgres-Changes (Postgres-Changes auth is table-RLS-driven, GA April 2026 covers Broadcast Authorization specifically). This call site is *out of scope* for this ADR; flagging only to avoid confusion.
- **`src/server/realtime-client.ts:297`** — `makeSupabaseBroadcastAdapter`'s `subscribe()` method. `client.channel(name)` for Broadcast subscribe. This IS in scope.

So the surface area is **two** call sites that need a `private` opt-in: `broadcast_to_channel` send-side and `subscribe_to_channel` receive-side. Symmetric with the setAuth fix's two-broadcast-call-sites + one-postgres-changes-site shape, just narrower.

### Current MCP tool input schemas don't carry a `private` field

`src/types/schemas.ts:42-50` (`BroadcastInputSchema`) and `:56-61` (`SubscribeChannelInputSchema`) define `channel`, `event`, `payload`, `event_filter`, `timeout_ms`, `max_events`. No channel-config knobs. Adding `private?: boolean` to both schemas is the minimal change.

The `inputSchema` JSON in `src/server/server.ts:62-75` and `:77-90` (advertised to MCP clients via `tools/list`) doesn't carry `private` either. Adding it requires both the zod schema update and the JSON-schema update — the two are kept in sync by hand, no codegen.

### Backward-compat for v0.1.x consumers — additive only

The npm package shipped `0.1.0` and `0.1.1` ([CLAUDE.md] status block). External consumers calling `broadcast_to_channel` today don't pass a `private` field — the call works against public channels with no auth, no `realtime.messages` policy required. If `private` is added as **optional, defaulting to `false`**, existing v0.1.x callers see no behavior change.

The MCP tool-versioning convention from the wider MCP ecosystem (per [MCP spec](https://spec.modelcontextprotocol.io/) and [Anthropic — Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)): add optional fields with safe defaults; never rename or remove a field; major-bump the package only if the input contract becomes incompatible. This change is additive — npm minor (`0.2.0`) is the natural carrier for the worked example, but the `private` flag itself is `0.1.x`-compatible if shipped standalone.

### `tests/smoke/multi-tenant-rls.smoke.test.ts` doesn't exercise broadcast

The existing multi-tenant smoke test inserts into `audit_events` (table-RLS-tested) but never broadcasts. The Broadcast Authorization leg has zero smoke-test coverage today. The recon's recommendation: extend the same test (or sibling `tests/smoke/multi-tenant-broadcast.smoke.test.ts`) with a private-channel subscribe + cross-tenant broadcast → assert tenant-isolation contract. Same FAIL→fix→PASS sequence ADR-0011 used.

### `tests/smoke/broadcast.smoke.test.ts` exists but uses public channels

The existing broadcast smoke test sends + receives on a public channel — verifies the substrate plumbing works at all. It does NOT assert auth-related behavior; it can't, because public channels skip `realtime.messages` RLS. Worth a brief pass to confirm it doesn't regress when the `private` flag is added with default `false` (it shouldn't — additive change).

## External research findings

External agent ran focused passes via Exa (2026-anchored queries — re-run after correcting stale "2025" date qualifiers) over: Supabase Broadcast Authorization patterns, `private: true` channel config under MCP, `httpSend()` migration discourse, and prior art for multi-tenant broadcast under forwarded JWT.

### 1. `private: true` is the documented opt-in gate for Broadcast Authorization

**Headline:** the `realtime.messages` RLS policies only fire when the channel is constructed with `config: { private: true }`. Public channels skip the auth gate entirely.

From [Supabase — Realtime Authorization (Broadcast)](https://supabase.com/docs/guides/realtime/authorization):

> *"Realtime Authorization is opt-in via the `private` flag in the channel options. When set to true, RLS policies on the `realtime.messages` table are evaluated for every operation."*

The `RealtimeChannelOptions` type confirms (`node_modules/@supabase/realtime-js/dist/main/RealtimeChannel.d.ts:11-35`):

```ts
export type RealtimeChannelOptions = {
  config: {
    broadcast?: { self?: boolean; ack?: boolean; replay?: ReplayOption };
    presence?: { key?: string; enabled?: boolean };
    /** defines if the channel is private or not and if RLS policies will be used to check data */
    private?: boolean;
  };
};
```

Operationally:
- `private: true` ⇒ on subscribe, Realtime evaluates `realtime.messages` RLS with `realtime.topic()` set to the channel name and `auth.uid()` from the JWT. Subscribe is rejected (no SUBSCRIBED state) if no policy passes.
- `private: false` (default) ⇒ no policy evaluation, anyone with the anon key can subscribe and send.
- The check is per-channel-join, not per-message — Supabase caches the policy result for the connection lifetime ([Supabase blog — Broadcast and Presence Authorization](https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization)).

**Implication:** the `private` flag is a hard prerequisite for any tenant-isolation contract on the broadcast leg. Without it, the substrate can't enforce — at all.

### 2. `httpSend()` is the modern explicit-REST broadcast send (added Oct 2025)

**Headline:** `httpSend()` was added to `realtime-js` in October 2025 ([supabase-js@050687a](https://github.com/supabase/realtime-js/commit/050687a)) as the explicit REST-side broadcast send. The implicit `send()`-falls-back-to-REST path now logs a deprecation warning in installed supabase-js:

> *"Realtime send() is automatically falling back to REST API. This behavior will be deprecated in the future. Please use httpSend() explicitly for REST delivery."*

**Verified against installed supabase-js**: `package.json` declares `"@supabase/supabase-js": "^2.45.0"`; `node_modules/@supabase/realtime-js/dist/main/RealtimeChannel.d.ts:355-363` exposes `httpSend(event, payload, opts?: { timeout?: number })`. Returns `Promise<{ success: true } | { success: false; status: number; error: string }>` — typed return discriminated by `success`.

The pattern shift:

```ts
// Old (current code in server.ts:155-168) — subscribe-then-send via WebSocket
const ch = supabaseClient.channel(input.channel);
await new Promise((resolve, reject) => { /* wait for SUBSCRIBED */ });
await ch.send({ type: "broadcast", event, payload });
await supabaseClient.removeChannel(ch);

// New — explicit REST, no subscribe roundtrip
const ch = supabaseClient.channel(input.channel, { config: { private: true } });
const result = await ch.httpSend(event, payload, { timeout: 10_000 });
if (!result.success) throw new Error(`broadcast failed: ${result.status} ${result.error}`);
```

`httpSend()` does NOT require `subscribe()` to resolve first. It hits the REST endpoint directly. Saves one websocket roundtrip (the SUBSCRIBED handshake — measured at 200-400ms cold-start in the `eval/spike-latency.ts` baseline). For a fire-and-forget broadcast inside an Edge Function isolate, this is the better fit.

**Caveat — empty Authorization header bug:** [GH issue supabase/realtime-js#1590](https://github.com/supabase/realtime-js/issues/1590) tracked an empty-Authorization-header bug in the REST fallback path; closed Apr 2026 by [PR #1937](https://github.com/supabase/realtime-js/pull/1937), shipped in `@supabase/realtime-js` ≥ that release. Our `^2.45.0` supabase-js range pulls a new-enough `realtime-js` for the fix. ADR should pin a minimum supabase-js version explicitly to avoid silent regression on older installs.

**Implication:** migrating to `httpSend()` is a small win (one less roundtrip, deprecation-warning gone, modern explicit pattern) and a precondition for any future `httpSend`-only feature work. Recommend folding the migration into the same ADR as the `private` flag — they touch the same call site, both serve the worked example, and splitting them would mean two PRs against the same handler.

### 3. Subscribe-side keeps the WebSocket — `httpSend` doesn't replace `.on(...).subscribe()`

**Headline:** `httpSend()` is send-side only. There's no REST subscribe equivalent — receiving broadcasts still requires the WebSocket connection + `channel.on('broadcast', { event: '*' }, handler).subscribe()` flow. The `subscribe_to_channel` MCP tool's substrate (`makeSupabaseBroadcastAdapter`) doesn't change shape, just gains the `private: true` opt-in on `client.channel(name, { config: { private: true } })`.

So the asymmetry is:
- **Send side** (broadcast_to_channel): opt-in `private` + opt-in `httpSend` (recommended) ⇒ no WebSocket subscription needed, REST roundtrip only.
- **Receive side** (subscribe_to_channel): opt-in `private` ⇒ WebSocket subscription with Authorization-checked join, then long-poll for events.

This asymmetry is fine — `boundedSubscribe` is already shaped around the WebSocket-subscribe model. The change is one config flag at channel construction time.

### 4. `realtime.messages` RLS policy patterns are well-documented

**Headline:** the canonical `realtime.messages` policy reads `realtime.topic()` (returns the channel name being joined / sent-to) and matches it against tenant context derived from `auth.uid()`. Production examples converge on a `SECURITY DEFINER STABLE` helper to avoid per-event sequential scans on the memberships table.

Canonical shape from [Supabase — Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization) and [Supabase blog](https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization):

```sql
-- Helper: returns array of tenant_ids the JWT identity is a member of
create or replace function public.user_tenant_ids()
returns uuid[]
language sql
security definer
stable
as $$
  select array_agg(tenant_id)
  from public.memberships
  where user_id = (select auth.uid())
$$;

-- Subscribe policy: user can join tenant:{id}:audit-feed if they're a member
create policy "tenant members can subscribe to audit feed"
on realtime.messages for select
to authenticated
using (
  (string_to_array(realtime.topic(), ':'))[1] = 'tenant'
  and ((string_to_array(realtime.topic(), ':'))[2])::uuid = any (public.user_tenant_ids())
);

-- Send policy: same gate (broadcast send and receive both check this table)
create policy "tenant members can broadcast to audit feed"
on realtime.messages for insert
to authenticated
with check (
  (string_to_array(realtime.topic(), ':'))[1] = 'tenant'
  and ((string_to_array(realtime.topic(), ':'))[2])::uuid = any (public.user_tenant_ids())
);
```

Two notes from the production pattern:
- `realtime.topic()` is **only available inside `realtime.messages` policies** — it returns the topic string of the channel the connection is subscribing/sending to. Don't try to use it in table-RLS policies.
- The `SECURITY DEFINER STABLE` helper matters: without it, the policy re-runs the membership lookup per-message under load. Cached per-connection by Realtime, but the cost still accrues during the hot path of channel join.

**Implication:** the worked-example schema in ADR-0014 (or whichever ADR ships the demo migration) needs both this helper function and the two `realtime.messages` policies. The recon doesn't pre-empt that scope; flagging only that the schema is non-trivial — three tables (`memberships`, `audit_events`, the `realtime.messages` policies) + one helper function.

### 5. Channel name shape encodes the tenant context

**Headline:** the convention across production Supabase apps using Broadcast Authorization is to encode the tenant ID into the channel name itself (`tenant:${tenantId}:${feed}`), then parse it back out in the RLS policy via `string_to_array(realtime.topic(), ':')`. This is what `realtime.topic()` is for.

Pattern from [Supabase docs](https://supabase.com/docs/guides/realtime/authorization) + 4 production apps surveyed in the multi-tenant recon:

- Channel name: `tenant:${tenantId}:audit-feed`, `tenant:${tenantId}:cursors`, `org:${orgId}:notifications`, etc.
- RLS policy parses the topic, extracts the tenant identifier, checks membership.
- The MCP tool layer (this artifact) doesn't enforce the convention — it accepts any string as `channel`. Caller's job to construct topology-correct names.

**Implication:** the substrate API doesn't need to know about tenant-channel-name conventions. The `private: true` flag is the only substrate-level concern; the topic-naming convention is operator/caller-side. `references/multi-tenant-rls.md` already documents this pattern (lines 90-130, "Channel topology under tenant isolation"). ADR doesn't need to repeat it — just confirm the substrate stays naming-agnostic.

## Design decisions the ADR has to make explicitly

In rough order of how much they affect the rest:

1. **Where does the `private` flag live?**
   - **(a) Per-call input field** on `BroadcastInput` and `SubscribeChannelInput`. Caller decides per-call. Most flexible; matches MCP norm of stateless tool calls.
   - **(b) Server config field** in `ServerConfig`. All channels are private (or all public). Simple, but commits the deployment to one shape — can't mix public and private channels in the same Edge Function.
   - **(c) Auto-detect** by topic prefix (`tenant:*` or `private:*` ⇒ private). Magical; brittle; rejected by analogy to ADR-0008's predicate-DSL non-magic.
   - **Recommend (a)** — per-call optional flag, default `false`. Keeps the substrate stateless and matches the additive-MCP-versioning convention. Mixed deployments stay possible.

2. **`httpSend()` migration: now or later?**
   - **(i) Now**, folded into the same ADR. Same call site, same handler, same PR.
   - **(ii) Later** as a separate ADR-0014. Smaller surface per change, clearer FAIL→fix→PASS receipts.
   - **Recommend (i)**. Splitting them means touching the broadcast handler twice, and the `httpSend()` migration is *informed by* the `private` flag work (the `private` flag goes on `client.channel(name, { config: { private: true } })`, which is the constructor `httpSend` runs against). Bundling them keeps the handler's shape coherent across the change.

3. **Default value for `private`.**
   - **(α) `false`** — backward-compat default. Existing v0.1.x callers see no behavior change.
   - **(β) `true`** — secure-by-default. Breaks v0.1.x callers using public channels.
   - **Recommend (α)**. Backward-compat wins; the worked example explicitly opts in. Documenting "for tenant-isolated channels, set `private: true`" is cheap; breaking existing callers to flip the default is not.

4. **Send-side: keep `send()` or migrate to `httpSend()`?**
   - **(I) Keep `send()` (current).** Subscribe-then-send-then-unsubscribe via WebSocket. Deprecation warning logged on every send.
   - **(II) Migrate to `httpSend()`.** Explicit REST. No subscribe roundtrip. No deprecation warning.
   - **Recommend (II)**. The `boundedQueueDrain` + `broadcast_to_channel` + worked-example combination broadcasts at higher volume than v0.1.x — every saved roundtrip compounds. The deprecation warning in logs would also be visible in any operator's deploy.

5. **Smoke-test sequencing.** Mirror ADR-0011's FAIL→fix→PASS shape:
   - Write extension to `multi-tenant-rls.smoke.test.ts` (or new `multi-tenant-broadcast.smoke.test.ts`) that subscribes to `tenant:${tenantA}:feed` as user A under JWT_A, broadcasts a message tagged tenant_a, asserts received; broadcasts a message tagged tenant_b on `tenant:${tenantB}:feed`, asserts NOT received by user A.
   - Run against current code — expect FAIL (current code uses public channels; cross-tenant broadcast leaks because there's no RLS gate).
   - Land `private` + `httpSend` migration. Re-run — expect PASS.
   - **Recommend** this exact ordering, same reason as ADR-0011: skip the FAIL run and the fix is faith-based.

6. **MCP `inputSchema` JSON update.** The advertised tool schema in `tools/list` needs the `private` field added. Caller-visible change. Versioning consequence: this is the first public-API change to the MCP tool surface since v0.1.0. Pure addition (optional field) — backward-compat, no major bump needed. ADR should explicitly note this is the first exercise of additive tool versioning.

## Falsifiable predicted effect (draft)

Per playbook § 8, no recommendation without a falsifiable predicted effect. This recon names two:

> **Predicted effect 1** — under current code (public channels), a smoke test that broadcasts to `tenant:${tenantB}:feed` while user A is subscribed to `tenant:${tenantA}:feed` shows **leakage = 0** (the channel names differ, so subscribers don't see each other's messages — irrelevant of RLS). This means the *bare* leakage assertion isn't a sufficient falsifier; the test must also broadcast on `tenant:${tenantA}:feed` from a JWT that has no tenant_a membership and assert that broadcast is **rejected by the substrate** (REST 403 or websocket policy violation). Without `private: true`, the rejection doesn't happen — the broadcast succeeds and user A sees the cross-tenant injection. Pre-fix: cross-tenant injection succeeds. Post-fix: cross-tenant injection is rejected by `realtime.messages` RLS.

> **Predicted effect 2** — `httpSend()` returns `{ success: true }` for an authorized broadcast, and `{ success: false, status: 403, ... }` for an unauthorized one (when `private: true` is set and the JWT fails the `realtime.messages` policy). The discriminated return type makes the failure mode legible to the caller without exception-throwing.

Properties:
- **Binary scoring** per fixture. Each fixture asserts: own-tenant broadcast succeeds AND is received; cross-tenant broadcast injection is rejected by the substrate.
- **Falsifiable in both directions.** Without `private: true`, cross-tenant injection succeeds (FAIL). With `private: true` but no `realtime.messages` policy, own-tenant broadcast is rejected (also FAIL — over-correction). Both failure modes are informative.
- **Wilson-CI gateable** at the same n=100 / n=300 schedule as ADR-0010 / ADR-0011 if extended to a fixture corpus (deferred — see § "Where design risk concentrates").
- **Smoke-test-only is sufficient for the substrate-correctness ship.** Fixture corpus extension lives with the worked-example ship (ADR-0014); the substrate fix can ship with smoke-test receipts alone (same shape ADR-0011 used).

## Where design risk concentrates

1. **The substrate-correctness ship and the eval-corpus ship are separable.** Same trap ADR-0012 surfaced: drafting momentum can roll a substrate-correctness fix into a fixture-design pass that has different evidence requirements. The substrate fix needs smoke-test receipts (ADR-0011's shape); the manifest cell needs a hand-curated fixture corpus with cross-tenant injection adversarial pairs. ADR should ship the substrate fix and **defer fixture design to ADR-0014** (the demo migration + worked-example PR). Otherwise this ADR becomes a substrate-vs-composition omnibus and the cross-tenant-leakage manifest cell deferral from ADR-0012 just shifts surface.

2. **`httpSend()` failure-mode surface is wider than `send()`.** The discriminated return type (`{ success: true } | { success: false; status; error }`) means callers must handle non-throwing failures. The current `BroadcastSender.send` interface returns `Promise<{ status: "ok" }>` — implicit "throws on failure." Migrating to `httpSend()` requires either (i) wrapping `httpSend` to throw on `success: false`, or (ii) widening the `BroadcastSender` interface. (i) is simpler; (ii) is more honest about the substrate's actual failure modes. Recommend (i) for backward-compat in v0.1.x, with a TODO to revisit at v0.3.0 — the wider interface is a v0.3.0 concern, not v0.2.0.

3. **`realtime.messages` policies require careful policy-cache reasoning.** The Supabase docs note the policy result is cached per-connection — i.e., for the lifetime of a WebSocket. For a long-running Edge Function isolate that doesn't close the connection between requests, this means a stale policy decision could persist. Edge Function isolate model says one isolate ≈ one request, so this *shouldn't* manifest — but the worked example needs to demonstrate the assumption holds. Add to `references/multi-tenant-rls.md` if not already there (line 130-150 covers Edge Function isolate boundaries; verify the policy-cache claim is included).

4. **Dual MCP-tool-versioning concerns.** The `inputSchema` JSON in `server.ts:62-90` advertises tool schemas to clients. Adding `private?: boolean` is an additive change to the tool surface — first such change since v0.1.0. The recon's recommended convention (additive optional, default-safe) is on solid ground per [MCP spec](https://spec.modelcontextprotocol.io/) and Anthropic's tool-versioning guidance, but ADR-0013 should explicitly affirm the convention so future tool-input changes follow the same shape. Without the explicit affirmation, future contributors will hit the question fresh each time.

5. **Backward-compat for active v0.1.x consumers — but there aren't any yet.** The npm package shipped `0.1.0` and `0.1.1`; no known external consumers in production. The backward-compat reasoning is *theoretical* for v0.1.x users that don't exist; the real concern is establishing the *convention* for when external consumers *do* show up. ADR should frame the additive-default convention as the convention going forward, not as a response to existing-consumer churn.

6. **Smoke-test branch cost.** The multi-tenant-broadcast smoke test will need a fresh Pro branch (~3min provisioning) per run. If extended to its own file rather than folded into `multi-tenant-rls.smoke.test.ts`, that's two branches per `bun run test:smoke` invocation. Recommend folding into the existing test (extend the same branch with `realtime.messages` policies + the broadcast assertions) — same branch, same test, +30-60s wall time. Avoids doubling branch cost.

## What this means for the next step

**Direction:** narrow substrate ship — the second of the two RLS layers documented in `references/multi-tenant-rls.md`, paralleling ADR-0011's first layer. Bundles the `httpSend()` migration in the same change because they touch the same call site and the modernization is overdue. Defers the fixture corpus and manifest cell to ADR-0014 (the demo migration + npm `0.2.0` ship).

**Recommended ADR pre-loads:**

- **Sequence the smoke-test extension BEFORE the substrate change.** Same FAIL→fix→PASS discipline as ADR-0011. Write the cross-tenant-broadcast assertion against current code first (expects FAIL — public channels skip the RLS gate, cross-tenant injection succeeds), then land `private` + `httpSend()` (and the matching `realtime.messages` policies in the test fixture), then re-run (expects PASS).
- **Ship the `private` flag and `httpSend()` migration together** — same call site, same handler, same PR. Splitting means two passes through the broadcast handler against the same evidence base.
- **Keep the `private` default at `false`.** Backward-compat for the (theoretical, but soon-to-be-real) v0.1.x consumer base. Worked example explicitly opts in.
- **Pin minimum `@supabase/supabase-js` version** to one carrying the empty-Authorization-header fix from PR #1937 (Apr 2026). Add to `package.json` engines or peerDependencies; documented in ADR with the GH issue link.
- **Defer the fixture corpus + manifest cell to ADR-0014.** Same separation ADR-0012 already ratified between substrate-correctness and fixture-design evidence requirements. The substrate fix ships with smoke-test receipts; the fixture-driven gate ships with the demo migration.
- **File `references/multi-tenant-rls.md` updates** for the `private: true` opt-in, the canonical `realtime.messages` policy shape, and the `httpSend()` migration. The reference page already has the section structure; this ADR adds substrate detail to existing § 2 ("Two RLS layers") and § "Channel topology under tenant isolation."
- **Affirm the additive-tool-versioning convention** explicitly in the ADR. First exercise of MCP tool surface evolution since v0.1.0; future tool-input changes should follow the same convention. Cite [MCP spec](https://spec.modelcontextprotocol.io/) and [Anthropic — Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents).
- **Frame the ADR as "closing the second-layer RLS substrate gap"** — paired with ADR-0011's first-layer ship. Same substrate-correctness frame; not a new feature.

These are recommendations, not decisions — the ADR will be filed as **Proposed**, per ADR status discipline.

**Open questions deferred to the ADR pass:**

- Whether to wrap `httpSend()`'s `{ success: false; status; error }` return into a thrown `ToolError` (preserving the v0.1.x `BroadcastSender` interface) or to widen the `BroadcastSender` interface to surface the discriminated return. Recon recommendation is (i) wrap-and-throw for v0.1.x, but the ADR should commit explicitly.
- Whether the `private` flag belongs only on `BroadcastInput` / `SubscribeChannelInput` or also on `boundedQueueDrain` (which composes `boundedWatch` + `handleBroadcast`). If a future caller wants to drain a tenant-scoped queue and broadcast to a tenant-private channel, the `private` flag needs to thread through `boundedQueueDrain` too. ADR should commit on whether this threading is in scope for v0.2.0 or deferred.
- Whether `subscribe_to_channel`'s smoke-test extension should also assert the *negative* case (subscribe attempt with insufficient JWT claims is rejected by the substrate at SUBSCRIBED-handshake time, not silent-empty). The negative case is more rigorous; the positive case is what ADR-0011 already covers analogously. Recommend including both.
- Whether the existing public-channel default in `tests/smoke/broadcast.smoke.test.ts` should be updated to assert *backward-compat* (private: false explicitly) or left as-is (no flag, default behavior). Either is fine; the test exists to verify the substrate plumbing works at all, not to gate on flag-default semantics.
- Whether the `httpSend()` migration breaks the existing channel-registry update in `server.ts:170-174` (which records `member_count: 1` after a broadcast). With `httpSend()` there's no member-count semantics — the REST send doesn't enroll the sender as a channel member. The registry update may need to be dropped or restructured. ADR should commit.

## References

**Internal:**
- [`docs/recon/2026-05-01-multi-tenant-worked-example-recon.md`](2026-05-01-multi-tenant-worked-example-recon.md) — recon shape this doc mirrors; predicted the JWT-`setAuth` gap that ADR-0011 closed
- [`docs/decisions/0011-multi-tenant-rls-baseline.md`](../decisions/0011-multi-tenant-rls-baseline.md) — first-layer RLS substrate fix (Postgres-Changes); this recon is the second-layer companion
- [`docs/decisions/0012-multi-tenant-audit-log-example.md`](../decisions/0012-multi-tenant-audit-log-example.md) — deferred the substrate-vs-composition split this recon honors
- [`docs/decisions/0007-pre-stage-v2-manifest-design.md`](../decisions/0007-pre-stage-v2-manifest-design.md) — manifest expansion pattern; ADR-0014 will amend with `cross_tenant_leakage_rate_max` (deferred from this ADR)
- [`references/multi-tenant-rls.md`](../../references/multi-tenant-rls.md) — already documents two RLS layers + channel topology; ADR-0013 adds the substrate-API detail
- [`src/server/server.ts:151-180`](../../src/server/server.ts) — `broadcast_to_channel` handler; first call site
- [`src/server/realtime-client.ts:279-335`](../../src/server/realtime-client.ts) — `makeSupabaseBroadcastAdapter`; second call site
- [`src/types/schemas.ts:42-61`](../../src/types/schemas.ts) — `BroadcastInputSchema` + `SubscribeChannelInputSchema`; needs `private?: boolean` addition
- [`tests/smoke/multi-tenant-rls.smoke.test.ts`](../../tests/smoke/multi-tenant-rls.smoke.test.ts) — existing smoke test; recommend extending in-place
- [`tests/smoke/broadcast.smoke.test.ts`](../../tests/smoke/broadcast.smoke.test.ts) — existing public-channel smoke test; verify no regression under additive change

**External (Supabase substrate):**
- [Supabase — Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization) — `private: true` opt-in; canonical `realtime.messages` policy patterns
- [Supabase — Broadcast and Presence Authorization (blog)](https://supabase.com/blog/supabase-realtime-broadcast-and-presence-authorization) — GA Apr 2024 walkthrough; per-connection policy cache mechanism
- [Supabase — Realtime Authorization changelog](https://supabase.com/changelog/22484-realtime-broadcast-and-presence-authorization) — release notes + flow diagram
- [Supabase — Realtime channels reference](https://supabase.com/docs/reference/javascript/subscribe) — channel options including `config.private`

**External (`httpSend` + REST migration):**
- [supabase-js@050687a](https://github.com/supabase/realtime-js/commit/050687a) — `httpSend()` introduced (Oct 2025)
- [GH realtime-js#1590](https://github.com/supabase/realtime-js/issues/1590) — empty Authorization header bug in REST fallback (closed Apr 2026)
- [GH realtime-js#1937](https://github.com/supabase/realtime-js/pull/1937) — fix shipping in `@supabase/realtime-js` ≥ that release; pin in ADR

**External (MCP tool versioning convention):**
- [MCP specification](https://spec.modelcontextprotocol.io/) — tool input schema evolution norms (additive optional fields preferred)
- [Anthropic — Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — tool API design discipline; backward-compat conventions
