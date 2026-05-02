# ADR 0013: private-channel substrate API — close the Broadcast Authorization opt-in gap

**Date:** 2026-05-02
**Status:** Proposed → ready for promotion to Accepted (smoke test FAIL→fix→PASS receipts captured against real Supabase Pro branches; substrate gap confirmed and closed; recon's predicted effects validated against running infrastructure, with one prediction empirically refined). Operator promotes when comfortable.
**Recommender:** Claude Opus 4.7 (assistant)
**Decider:** Diego Gomez (TBD)
**Implementation status (added 2026-05-02):**
- Smoke test: extended in this PR — [`tests/smoke/multi-tenant-rls.smoke.test.ts`](../../tests/smoke/multi-tenant-rls.smoke.test.ts) layer 2 assertions (c) + (d).
- Substrate fix: shipped in this PR — `private?: boolean` added to [`src/types/schemas.ts`](../../src/types/schemas.ts) (BroadcastInputSchema + SubscribeChannelInputSchema) and the advertised `inputSchema` JSON in [`src/server/server.ts`](../../src/server/server.ts); threaded through [`src/server/subscribe.ts`](../../src/server/subscribe.ts) → [`boundedSubscribe`](../../src/server/realtime-client.ts) → [`makeSupabaseBroadcastAdapter`](../../src/server/realtime-client.ts) at channel construction; threaded through [`server.ts`](../../src/server/server.ts) `broadcast_to_channel` handler at channel construction.
- `httpSend()` migration: shipped in this PR — broadcast send-side migrated from implicit-REST-fallback `ch.send({ type: "broadcast", ... })` to explicit `ch.httpSend(event, payload, { timeout: 10_000 })` (saves the SUBSCRIBED handshake roundtrip; silences supabase-js' deprecation warning).
- supabase-js minimum bumped from `^2.45.0` to `^2.88.0` (Dec 2025; carries [supabase-js#1937](https://github.com/supabase/supabase-js/pull/1937) empty-Authorization-header fix and [supabase-js@050687a](https://github.com/supabase/supabase-js/commit/050687a816a5d1d77fa544c91b3944c4b9f0cae5) `httpSend()`).
- FAIL baseline (pre-fix run, 2026-05-02 02:15 PT): `layer 2 summary: own_broadcasts=1, injection_broadcasts=1, b_injection_threw=false`. B's cross-tenant injection succeeded against the public channel; A received B's broadcast — the contract violation. Wallclock: 68s after branch provisioning.
- PASS receipt (post-fix run, 2026-05-02 02:19 PT): `layer 2 summary: own_broadcasts=1, injection_broadcasts=0, b_injection_threw=false`. B's cross-tenant injection rejected by `realtime.messages` INSERT policy; A received only own broadcast. Wallclock: 69s. Both layer-1 (ADR-0011) and layer-2 (this ADR) assertions pass.
- Total: ~6 min of branch-provisioning + ~2 min of test wallclock for the round-trip evidence.

**Note on versioning:** this repo runs **two parallel version streams**: the npm package (`package.json` — currently `0.1.1`; this ADR doesn't propose a version bump because the substrate fix is additive — `private` defaults to `false` for v0.1.x backward compat — but the supabase-js floor bump from `^2.45.0` to `^2.88.0` is technically a peer-dep tightening that might warrant a `0.1.2` patch release; deferred to ADR-0014 along with the worked example) and `manifest.json` eval thresholds (currently `1.0.0`; this ADR does NOT propose a manifest amendment — the `cross_tenant_leakage_rate_max` cell remains deferred per [ADR-0012 § 2](0012-multi-tenant-audit-log-example.md), to be filed against ADR-0014 when the fixture-design pass produces a defensible adversarial corpus).

**Context:** the recon at [`docs/recon/2026-05-01-private-channel-substrate-api-recon.md`](../recon/2026-05-01-private-channel-substrate-api-recon.md) (PR #7, merged) flagged that ADR-0011 closed the JWT-propagation half of multi-tenant RLS (the `setAuth` fix on Postgres-Changes and Broadcast adapters) but left the **substrate-API opt-in** for Broadcast Authorization unaddressed. Without `client.channel(name, { config: { private: true } })`, `realtime.messages` RLS is bypassed entirely — even when JWT is propagating correctly. Cross-tenant injection on broadcast channels remained possible in v0.1.x; the existing `multi-tenant-rls.smoke.test.ts` covered only layer 1 (Postgres-Changes RLS).

This ADR proposes the smallest opt-in API surface that closes the gap, paired with the long-overdue `httpSend()` migration that touches the same call sites.

## What this ADR proposes

A four-part change at five surfaces, validated by a layer-2 extension to the existing multi-tenant smoke test:

1. **`private?: boolean`** added to `BroadcastInputSchema` and `SubscribeChannelInputSchema` (zod) and the advertised `inputSchema` JSON for both tools. **Default: undefined → falsy → public**, preserving v0.1.x behavior for callers who don't opt in.
2. **`private` threaded** through `handleSubscribe` → `boundedSubscribe` → `BroadcastAdapter.subscribe` → `client.channel(name, { config: { private: true } })`.
3. **`private` threaded** through `broadcast_to_channel` handler's inline sender → `client.channel(name, { config: { private: true } })`.
4. **Broadcast send migrated** from the deprecated implicit-REST-fallback (`ch.send({ type: "broadcast", ... })` after `subscribe()`) to the explicit `ch.httpSend(event, payload, opts)`. Saves one websocket roundtrip; silences supabase-js' deprecation warning; failure mode is rejection (translated to `ToolError("UPSTREAM_ERROR")` by `handleBroadcast`'s 3-retry envelope).

The `package.json` floor for `@supabase/supabase-js` is bumped from `^2.45.0` to `^2.88.0` to ensure both `httpSend()` (added 2025-10-08, supabase-js 2.75.0) and the empty-Authorization-header fix from [supabase-js#1937](https://github.com/supabase/supabase-js/pull/1937) (merged 2025-12-16, shipped in supabase-js 2.88.0) are present.

Filed **Proposed** because (a) the fix has been validated end-to-end against real Pro branches but the operator hasn't reviewed the recon's recommended next steps in full, (b) the worked-example follow-up (the demo migration + npm `0.2.0` ship + manifest cell) is deferred to ADR-0014 not folded in here, (c) ADR status discipline says don't mark Accepted until operator decides.

## What changed since the recon

The recon flagged the gap as a *prediction*; this ADR captures the *evidence*. Three resolutions to recon items:

**Recon Q1 — does the substrate-API gap actually surface against real Realtime?** **CONFIRMED.** The pre-fix smoke test produced `injection_broadcasts=1` — B's cross-tenant injection broadcast was received by A's listener. With public channels (no `private: true`), `realtime.messages` RLS was never evaluated; the substrate freely fanned B's send to A. Single attempt, no flake.

**Recon Q2 — does `httpSend()` migration affect the `private` flag's effectiveness?** **NO, they're orthogonal.** The `private` flag is a property of the channel construction (`client.channel(name, { config: { private: true } })`); `httpSend()` is the send method invoked on that channel. Both can be applied independently. ADR-0013 ships them together because they touch the same call site, not because they're coupled.

**Recon Q3 — does `httpSend()` reject with a discriminated error on policy denial?** **REFUTED — substrate behavior is silent filtering, not loud rejection.** The recon's Predicted Effect 2 said `httpSend()` would reject with `Error("...status: 403...")` for B's unauthorized broadcast. The smoke test refutes this: `b_injection_threw=false` post-fix. The actual substrate behavior:
- REST endpoint returns 202 (request accepted)
- INSERT policy on `realtime.messages` denies → row never inserted → no fan-out
- `httpSend()` resolves successfully because REST returned 202

The contract assertion still holds (`injection_broadcasts === 0` — A receives no leaked messages), but the failure mode is **silent**. Operators who expect a thrown error on policy denial will be surprised. ADR-0013 documents this in [`references/multi-tenant-rls.md` § "Failure mode: silent filtering, not loud rejection"](../../references/multi-tenant-rls.md). The recon was wrong; the smoke test corrected the prediction.

**This is the second ADR in the v0.1.x sequence to ship a refined-prediction outcome** — the recon predicted one substrate-level signature, the empirical run produced a different one, and the docs absorb the correction. Same shape ADR-0011 used for the `_getAccessToken` fallback path (which the recon got right); ADR-0013 used for the `httpSend()` rejection contract (which the recon got wrong). Both shapes are pre-registration loop outcomes — the loop's validity doesn't depend on the prediction being correct, just on the empirical run being load-bearing.

## Decisions

### 1. Land the fix as a `0.1.x` additive change, not a `0.2.0` feature

Same rationale as ADR-0011:
- **The substrate gap is a security-shaped bug.** The artifact's CLAUDE.md and reference docs claimed multi-tenant safety; without `private: true`, that claim was technically false on the broadcast leg.
- **Backward-compat is clean.** Pre-fix, `private` was never in the schema; callers who didn't pass it kept getting public channels (correct). Post-fix, `private` defaults to `false`; same callers still get public channels. Only callers who explicitly opt in see new behavior.
- **Version stream discipline.** The two-stream rule (npm vs manifest.json) means an additive substrate change doesn't need a npm minor bump if the API surface is purely additive. The `^2.45.0` → `^2.88.0` peer-dep bump is the one change worth a `0.1.2` patch eventually, but bundling it with the worked-example npm `0.2.0` ship in ADR-0014 is cleaner than a `0.1.2` interim release.

The next ADR (ADR-0014, demo migration + worked-example ship) is the natural home for the npm `0.2.0` headline.

### 2. Smoke test sequence: FAIL run BEFORE fix, PASS run AFTER

Same discipline as ADR-0011: write the smoke-test extension first, run against current code (expects FAIL — public channels skip the RLS gate, cross-tenant injection succeeds), land the substrate fix, re-run (expects PASS — `realtime.messages` policies enforce). Receipts in the implementation-status block above.

The reviewer of PR #7 reinforced this ordering for future ADRs in the series; ADR-0013 followed it without prompting.

### 3. `private` defaults to `false`, not `true`

The recon teed up this decision (option (α) backward-compat vs (β) secure-by-default). ADR-0013 picks **(α) `false`**. Rationale:
- v0.1.x has shipped to npm. Even if no known external consumers exist today, the convention "additive optional, default-safe" is the one this artifact is committing to going forward.
- The audit-log worked example (ADR-0014) explicitly opts in. Documenting "for tenant-isolated channels, set `private: true`" is cheap.
- A future ADR can reverse the default if external usage data justifies it. Reversing the default is a major-version concern (would break callers); committing to default-additive at v0.1.x preserves that future option.

### 4. `httpSend()` migration: bundle with the `private` flag, not separate

Recon recommendation (i). Rationale: same call site, same handler, same evidence base. Splitting into ADR-0013 (`private` flag only) + ADR-0013-bis (`httpSend()` migration) would mean two passes through the broadcast send code with no new evidence between them. The deprecation warning, the saved roundtrip, and the modern explicit pattern all serve the same goal (the artifact's broadcast send works correctly under multi-tenant RLS); bundling them produces one coherent ship.

The smoke test's PASS receipt validates both legs: the `private: true` flag is what activates RLS gating, and `httpSend()` is the path that exercises the gating (REST endpoint → realtime.messages INSERT policy evaluated → silently denied → no fan-out).

### 5. Affirm the additive-tool-versioning convention explicitly

This is the **first additive change to the MCP tool input surface since v0.1.0**. The convention: optional fields with safe defaults; never rename or remove; major-bump the package only on incompatible contract changes. Source: [MCP specification](https://spec.modelcontextprotocol.io/) and [Anthropic — Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents). Future tool-input changes in v0.x.x should follow the same shape; affirmed here so future contributors don't re-litigate the question.

### 6. The `httpSend()` failure-mode wrapper is `try`-shaped, not `if`-shaped

Recon Risk #2 surfaced this: the `.d.ts` declares `Promise<{ success: true } | { success: false; status; error }>` but the runtime only resolves the `success: true` branch (every non-202 calls `Promise.reject(new Error(errorMessage))` per `RealtimeChannel.js:441-447`). ADR-0013's wrapper is:

```ts
try {
  await ch.httpSend(input.event, input.payload, { timeout: 10_000 });
} finally {
  await supabaseClient.removeChannel(ch);
}
```

No `if (!result.success)` branch — that code is dead. `handleBroadcast`'s 3-retry envelope catches the thrown `Error` and translates to `ToolError("UPSTREAM_ERROR")` after exhausting retries. The thrown `error.message` carries either `response.statusText` or `errorBody.error/message` — useful in logs but treated as opaque-upstream-failure by the wrapper (recon recommended this for v0.1.x).

### 7. The substrate's silent-filtering behavior is documented, not changed

ADR-0013 doesn't try to make policy denials throw at the substrate level. That would require either (a) a separate handshake to confirm broadcasts were inserted (adds latency + complexity) or (b) substrate-level changes to supabase-js (out of scope). The contract — `injection_broadcasts === 0` at the listener — is what the smoke test verifies; the failure mode (silent vs loud) is documented in [`references/multi-tenant-rls.md`](../../references/multi-tenant-rls.md) for operators who need an explicit ack.

This is a deliberately narrow scope: "the substrate enforces tenant isolation at the receiver" is what we ship; "the substrate signals send-side authorization status to the caller" is not. Layered acks (receiver echoes back a confirmation broadcast) are the standard pattern for the latter; out of scope for v0.1.x.

## What this ADR doesn't do

- **Doesn't ship the demo migration or npm `0.2.0`.** Both deferred to ADR-0014 — the worked-example schema, the operator-facing docs ramp, the package.json version bump, and the CHANGELOG entry all live there. ADR-0013 is the substrate-correctness ship; ADR-0014 is the worked-example ship.
- **Doesn't add a manifest cell.** Per [ADR-0012 § 2](0012-multi-tenant-audit-log-example.md), the `cross_tenant_leakage_rate_max` cell remains deferred until a fixture-design pass produces a defensible adversarial corpus. The smoke-test receipt is the substrate-correctness evidence; a fake-driven eval against the substrate (without that fixture pass) would be weak signal. Same separation honored as ADR-0011.
- **Doesn't bump npm.** Bug-fix-shaped additive change in `0.1.x`. The next npm release (`0.2.0`) ships with the worked example via ADR-0014.
- **Doesn't address Presence.** Per the recon's open question 4 + ADR-0011's same deferral, Presence stays out of v0.1.x. The same `private: true` flag mechanism applies if Presence is re-scoped in.
- **Doesn't widen `BroadcastSender`'s interface.** Per Decision 6 + recon Risk #2, the `httpSend()` thrown-Error path is wrapped opaquely. A future ADR could widen `BroadcastSender` to surface HTTP status to callers; out of scope here.
- **Doesn't thread `private` through `boundedQueueDrain`.** If a future caller wants to drain a tenant-scoped queue and broadcast to a tenant-private channel, `boundedQueueDrain` would need the flag too. Recon flagged this as an open question; ADR-0013 explicitly defers it. The composition-level concern is ADR-0014's surface (the worked example may or may not need `boundedQueueDrain` — TBD when drafting begins).
- **Doesn't change the channel-registry update in `server.ts`.** The `channelRegistry.push({ ... member_count: 1 })` remains. With `httpSend()`, `member_count: 1` is now even less semantically meaningful (REST send doesn't enroll the sender as a channel member), but the registry is best-effort by design; restructuring is a separate concern. Recon flagged this; ADR-0013 leaves it.

## Consequences

- **The artifact's multi-tenant safety claim is now true at both layers.** ADR-0011 closed the JWT-propagation gap on Postgres-Changes; ADR-0013 closes the substrate-API opt-in gap on Broadcast Authorization. Both legs of `references/multi-tenant-rls.md`'s "Two RLS layers, not one" framing now have empirical receipts.
- **The methodology backbone gains a refined-prediction receipt.** v0.1.x ADR shapes so far: accept (ADR-0001/0002/0003/0005/0009), partial-acceptance (ADR-0006/0007), reject (ADR-0008), predicted-and-confirmed-and-fixed (ADR-0011), proposed-deferral-with-rationale (ADR-0012). ADR-0013 adds **predicted-and-empirically-refined** — the `httpSend()` rejection contract was wrong in the recon, the smoke test produced the corrected contract, the docs absorb the correction. This is the pre-registration loop's whole point: predictions are inputs to evidence, not load-bearing claims.
- **Future broadcast work has a pattern to follow.** The `private` flag is now a first-class input on both broadcast tools; future tool-input changes follow the additive-optional convention affirmed here. The wrapper pattern for `httpSend()` (try/catch, opaque error translation, channel-construction-time `private` flag) is documented in `realtime-client.ts` and `server.ts` for subsequent contributors.
- **The `references/multi-tenant-rls.md` page now covers both layers end-to-end.** Includes the prerequisites (`private: true` + matching `realtime.messages` policies), the silent-filtering failure mode, and the `httpSend()` migration rationale. ADR-0014's worked example will reference this page rather than re-derive the patterns.
- **The supabase-js floor bump (2.45 → 2.88) is a peer-dep tightening.** Existing v0.1.x consumers running supabase-js < 2.88 will get an npm warning on install; not a hard break. The bump is necessary for `httpSend()` and the empty-Auth-header fix; documented in CHANGELOG when ADR-0014 ships `0.2.0`.

## References

- [`docs/recon/2026-05-01-private-channel-substrate-api-recon.md`](../recon/2026-05-01-private-channel-substrate-api-recon.md) — recon that predicted the gap + named the fix shape (PR #7, merged)
- [`docs/decisions/0011-multi-tenant-rls-baseline.md`](0011-multi-tenant-rls-baseline.md) — first-layer RLS substrate fix; this ADR is the second-layer companion
- [`docs/decisions/0012-multi-tenant-audit-log-example.md`](0012-multi-tenant-audit-log-example.md) — substrate-vs-composition split this ADR honors
- [`docs/decisions/0007-pre-stage-v2-manifest-design.md`](0007-pre-stage-v2-manifest-design.md) — manifest expansion pattern; ADR-0014 will amend with `cross_tenant_leakage_rate_max` (deferred from this ADR)
- [`tests/smoke/multi-tenant-rls.smoke.test.ts`](../../tests/smoke/multi-tenant-rls.smoke.test.ts) — extended with layer-2 broadcast assertions; both runs reproducible
- [`references/multi-tenant-rls.md`](../../references/multi-tenant-rls.md) — updated with `private: true` opt-in, canonical `realtime.messages` policy shape, `httpSend()` migration, silent-filtering note
- [Supabase — Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization) — `private: true` opt-in + canonical `realtime.messages` policy patterns
- [supabase-js@050687a](https://github.com/supabase/supabase-js/commit/050687a816a5d1d77fa544c91b3944c4b9f0cae5) — `httpSend()` introduced, 2025-10-08
- [supabase-js#1937](https://github.com/supabase/supabase-js/pull/1937) — empty-Authorization-header fix, merged 2025-12-16, shipped in supabase-js 2.88.0
- [MCP specification](https://spec.modelcontextprotocol.io/) — additive tool-input versioning convention
- [Anthropic — Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — backward-compat conventions
