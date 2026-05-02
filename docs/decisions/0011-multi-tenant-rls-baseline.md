# ADR 0011: multi-tenant RLS baseline — close the JWT-`setAuth` gap on Realtime

**Date:** 2026-05-01
**Status:** Accepted (2026-05-02). FAIL→fix→PASS smoke receipts captured against real Pro branches at filing (PR #5 / `f8b4894`); re-verified post-ADR-0014 demo-migration refactor on 2026-05-02 (branch `kizykjdatrwosyyzwgtm`, 78s wall time, own_tenant_events=2 / cross_tenant_events=0 — Layer 1 contract holds under the new `sql.unsafe(migrationSql)` setup path). The worked-example follow-up branch is now ADR-0014 (Accepted same day).
**Recommender:** Claude Opus 4.7 (assistant)
**Decider:** Diego Gomez (Accepted 2026-05-02 in the post-0.2.0 promotion sweep)
**Implementation status (added 2026-05-01):**
- Smoke test: shipped in this PR — [`tests/smoke/multi-tenant-rls.smoke.test.ts`](../../tests/smoke/multi-tenant-rls.smoke.test.ts).
- `setAuth` fix: shipped in this PR — three call sites in [`src/server/realtime-client.ts`](../../src/server/realtime-client.ts) (lines 90-104, 282-289) + [`src/server/server.ts`](../../src/server/server.ts) (lines 119-132).
- FAIL baseline (pre-fix run, 2026-05-01): `events_count=0` after 30s timeout. User A subscribed under JWT_A received zero events — including their own three tenant_a inserts. Confirms the recon's prediction that supabase-js' default `_getAccessToken` falls back to `supabaseKey` (anon key) on the websocket leg.
- PASS receipt (post-fix run, 2026-05-01): `events_count=2/3` own-tenant inserts (the +1166ms `warmup_a1` insert was *dropped by* the documented 5s Realtime warmup window — same window flagged in `docs/spike-findings.md` § T7); both delivered events tagged `tenant_id=tenant_a`; zero cross-tenant events. Both assertions pass — diagnostic (own-tenant events arrive: `≥1`) and contract (cross-tenant events blocked: `===0`).
- Total: ~6 min of branch-provisioning + ~2 min of test wallclock for the round-trip evidence.

**Note on versioning:** this repo runs **two parallel version streams**: the npm package (`package.json` — currently `0.1.1`; this ADR doesn't propose a version bump because the fix is a bug-correction in `0.1.x` shape, not a new feature) and `manifest.json` eval thresholds (currently `1.0.0`; this ADR proposes amending the pre-staged `2.0.0` design from [ADR-0007](0007-pre-stage-v2-manifest-design.md) with one new cell, deferred to ADR-0012's worked-example ship). When this ADR says **"npm v0.1.x"** it means the published package; **"manifest.json v2.0.0"** means the eval-thresholds file. Bare references in older ADRs may conflate the two; first mentions are disambiguated.

**Context:** the recon at [`docs/recon/2026-05-01-multi-tenant-worked-example-recon.md`](../recon/2026-05-01-multi-tenant-worked-example-recon.md) (PR #4, merged) flagged that `src/server/realtime-client.ts` and `src/server/server.ts` plumb the user JWT into `createClient`'s `global.headers.Authorization` — which works for PostgREST — but never call `client.realtime.setAuth(token)`, which is the documented mechanism for propagating the JWT to the Realtime websocket. The recon predicted this would cause RLS on Postgres-Changes to evaluate against the `anon` claims_role even when an authenticated JWT was forwarded. Smoke tests until now used `serviceRole` (RLS bypass) on a single-tenant schema, so the gap never surfaced.

This ADR proposes the smallest possible falsifiable confirmation of that prediction: a multi-tenant smoke test against real Pro branches with two real `auth.users` and two real JWTs, run against current code (FAIL baseline) and again post-fix (PASS receipt).

## What this ADR proposes

A three-line code change at three call sites + a multi-tenant smoke test that demonstrates the bug exists pre-fix and is closed post-fix.

The fix:

```ts
const client: SupabaseClient = createClient(cfg.supabaseUrl, cfg.supabaseKey, clientOpts);
if (cfg.authToken) {
  client.realtime.setAuth(cfg.authToken);
}
```

Applied at:
- `src/server/realtime-client.ts:104` — `makeSupabaseAdapter` (Postgres-Changes adapter, used by `watch_table`)
- `src/server/realtime-client.ts:286` — `makeSupabaseBroadcastAdapter` (Broadcast subscribe adapter, used by `subscribe_to_channel`)
- `src/server/server.ts:131` — shared client for `broadcast_to_channel` send

Filed **Proposed** because (a) the fix has been validated end-to-end against real Pro branches but the operator hasn't reviewed the recon's recommended next steps in full, (b) the worked-example follow-up (audit-log schema + RLS reference page + manifest cell) is deferred to ADR-0012 not folded in here, (c) ADR status discipline says don't mark Accepted until operator decides.

## What changed since the recon

The recon flagged the gap as a *prediction*; this ADR captures the *evidence*. Three resolutions to recon items:

**Recon Q1 — does the JWT-`setAuth` gap actually surface against real Realtime?** **CONFIRMED.** The pre-fix smoke test run produced `events_count=0` after 30s — user A subscribed under their own JWT, with three own-tenant inserts committed during the test window, received zero events. Post-fix run on a fresh branch produced `events_count=2` (the two post-warmup own-tenant events; the +1166ms insert hit the documented 5s Realtime warmup window). Both runs in single attempts, no flakes. The gap is real, not theoretical.

**Recon Q2 — is the precise mechanism "websocket evaluates against anon" or something subtler?** **CONFIRMED as predicted.** The empirical signature (zero events delivered when no anon SELECT policy exists) matches the path the recon traced through `SupabaseClient.ts:307-340, 534-541`: with no persisted session and no caller-supplied `accessToken` callback, `_getAccessToken` falls back to `?? this.supabaseKey`, the anon key gets sent on the websocket, Realtime's RLS evaluator sees `claims_role = anon`, and the absence of an anon policy means rows are filtered out before delivery. Adding a row-level policy granting `anon` SELECT would invert the failure mode to "tenant A also sees tenant B's events" — same root cause, opposite-shaped leak.

**Recon Q3 — is the same fix needed for both Postgres-Changes RLS and Broadcast Authorization RLS?** **YES, addressed at the same time.** Both legs read the JWT off the websocket the same way; both use `setAuth` to override `accessTokenValue` on the underlying `RealtimeClient`. The fix is symmetric — same one-liner at all three call sites. This ADR ships all three together; the worked example in ADR-0012 will exercise both legs in fixtures.

## Decisions

### 1. Land the fix as a `0.1.x` bug-correction, not a `0.2.0` feature

The recon's option (i) — land setAuth as a precondition for the worked example — is what shipped here. Rationale:

- **It's a bug, not a feature.** The artifact already claimed JWT forwarding for RLS in `references/edge-deployment.md` and adjacent docs. The fix makes the existing claim true; it doesn't add a new surface.
- **Backward-compat path is clean.** Pre-fix, `authToken=undefined` worked correctly (no JWT, no override, anon all the way through). Pre-fix, `authToken=<jwt>` broke silently on the Realtime leg. Post-fix, both behave correctly. No caller code change needed.
- **Version stream discipline.** The two-stream rule (npm vs manifest.json) means a small bug-fix doesn't need a npm minor bump if the API surface is unchanged.

The next ADR (ADR-0012, worked-example ship) is the natural home for the npm `0.2.0` headline.

### 2. Smoke test sequence: FAIL run BEFORE fix, PASS run AFTER

Recon recommendation (i) was "land the fix; the smoke test then verifies." The reviewer of PR #4 pushed back: that ordering means the gap goes unverified — the fix is faith-based, not evidence-based. The reviewer's recommended ordering — write smoke test first, run against current code (expects FAIL), then land fix, then re-run (expects PASS) — was adopted and produced the receipts in the implementation-status block above.

This mirrors ADR-0010's n=7 baseline-before-gate pattern. Same discipline, different surface.

### 3. Smoke test schema mirrors production-grade RLS shape

External research in the recon (5 production Supabase apps surveyed) converged on a small set of patterns: `tenant_id` column + `memberships` junction + `SECURITY DEFINER STABLE` helpers + RLS policies via `(select auth.uid())` subselect for plan caching. The smoke test schema uses the same shape — minus the `SECURITY DEFINER` wrapper, since the policy is simple enough that the inline subquery doesn't have a measurable plan-cache cost at the smoke-test fixture size, and including the wrapper would complicate the schema setup without exercising any new substrate behavior. The worked-example ship (ADR-0012) is the place to demonstrate the helper-function pattern with the `references/multi-tenant-rls.md` page.

### 4. The fix doesn't address the no-`Authorization`-header case

Recon open question (5): what happens when an MCP request arrives with no `Authorization` header? Today's behavior post-fix:
- `cfg.authToken` is undefined
- `setAuth` is not called
- Default supabase-js behavior: `_getAccessToken` falls back to anon key
- RLS evaluates against anon — RLS-required tables silently return zero rows

This is identical to pre-fix behavior for the no-token case. The deferred design choice — "loud error vs operator's job" — is left for ADR-0012, where the worked example is the natural place to demonstrate the trade-off (the audit-log shape will need a tenant context, so a missing JWT is unambiguously an error there).

## What this ADR doesn't do

- **Doesn't ship a worked example.** The audit-log schema, the `references/multi-tenant-rls.md` page, the `cross_tenant_leakage_rate_max` manifest cell, and the multi-tenant fixture corpus all live in ADR-0012. This ADR is the bug-fix-with-receipts ship; the worked-example ship is its follow-up.
- **Doesn't change the `manifest.json`.** ADR-0007's pre-staged v2.0.0 design already commits to a templated amendment shape; ADR-0012 will pre-stage one new cell against it. Note this will be the **second** amendment to ADR-0007's v2.0.0 design — ADR-0010's `forward_correctness_rate_min` is the first (currently Proposed → ready for promotion). The amendment loop ADR-0007 set up was always designed to take more than one cell over the artifact's lifecycle; ADR-0012 is the second exercise of that loop, not the first.
- **Doesn't bump npm.** Bug-fix in `0.1.x`. The next npm release (`0.2.0`) ships with the worked example.
- **Doesn't address Presence.** Per the recon's open question 4, Presence stays deferred — the v0.1.x judgment about what to defer holds. Same `setAuth` mechanism would apply if Presence were re-scoped in.

## Consequences

- **The artifact's RLS claim is now true.** Until this ADR, "the function never elevates" + "the agent's JWT is forwarded" were paired claims in `CLAUDE.md` and `references/edge-deployment.md`; the second was technically false on the Realtime leg. Post-fix, both are accurate.
- **The methodology backbone gains a falsified-and-corrected receipt.** v0.1.x has three named ADR outcomes (accept, partial, reject); this ADR adds a fourth shape — *predicted-and-confirmed-and-fixed*. The recon predicted a bug; the smoke test confirmed it; the fix closed it; the receipt is reproducible. That sequence is the entire pre-registration loop in one ship.
- **Future Realtime work has a pattern to follow.** Any new adapter that calls `createClient` with an auth context needs the matching `setAuth` call. The load-bearing comment in `realtime-client.ts:96-103` documents the trap so subsequent contributors don't hit it again.
- **The worked example follow-up is unblocked.** ADR-0012 can now ship `references/multi-tenant-rls.md` + the audit-log schema + manifest amendment + fixtures + the `cross_tenant_leakage_rate_max` cell against a substrate that actually delivers events under RLS.

## References

- [`docs/recon/2026-05-01-multi-tenant-worked-example-recon.md`](../recon/2026-05-01-multi-tenant-worked-example-recon.md) — recon that predicted the bug + named the fix (PR #4, merged)
- [`docs/decisions/0007-pre-stage-v2-manifest-design.md`](0007-pre-stage-v2-manifest-design.md) — manifest expansion pattern; ADR-0012 will amend with `cross_tenant_leakage_rate_max`
- [`docs/decisions/0010-bounded-queue-drain.md`](0010-bounded-queue-drain.md) — sibling ADR using the same FAIL-baseline-before-PASS-gate discipline (n=7 baseline)
- [`tests/smoke/multi-tenant-rls.smoke.test.ts`](../../tests/smoke/multi-tenant-rls.smoke.test.ts) — the smoke test with both runs reproducible
- [Supabase — Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization) — *"To use your own JWT with Realtime make sure to set the token after instantiating the Supabase client and before connecting to a Channel."*
- `node_modules/@supabase/supabase-js/src/SupabaseClient.ts:307-340, 534-541` — the source receipt for the `_getAccessToken` fallback path
