# Recon: ADR-0014 worked-example ship (2026-05-02)

Recon-of-recons for the bundled ship deferred by ADRs 0012 and 0013: the demo migration that promotes the multi-tenant smoke-test schema to a permanent fixture, the npm `0.2.0` release that carries the `private` flag + the `^2.88.0` peer-dep tightening, and the contingent `cross_tenant_leakage_rate_max` manifest cell. Filed on branch `recon/worked-example-ship`. Mirrors the shape of [`2026-05-01-multi-tenant-worked-example-recon.md`](2026-05-01-multi-tenant-worked-example-recon.md) — evidence first, ADR later.

The substrate work this ADR composes on top of is *closed*: ADR-0011 + ADR-0013 both have FAIL→fix→PASS receipts on real Pro branches; both RLS layers (Postgres-Changes + Broadcast Authorization) verified end-to-end under forwarded JWT. The remaining work is composition: schema permanence, npm version, and a fixture-design pass that decides whether a defensible adversarial corpus is reachable at fixture scale.

## Why this recon, why now

The two prior recons (multi-tenant-worked-example, private-channel-substrate-api) produced ADRs 0011/0012/0013 in 36 hours. Both substrate gaps are closed; the remaining scope is a *bundled* ship that ADR-0012 § 2 explicitly named ("substrate-correctness ships with smoke-test receipts; fixture-driven gates ship with the worked example"). This recon's job is to:

1. Re-check what changed under the artifact's feet in 36 hours that affects the ship — primarily the supabase-js floor decision, since `^2.88.0` was pinned in ADR-0013 four days after 2.88.0 itself shipped.
2. Decide whether the contingent manifest cell is reachable. ADR-0012 deferred it on substrate-vs-composition grounds; the test now is whether a defensible cross-tenant adversarial corpus exists at fixture scale.
3. Consolidate the demo migration's surface — what permanent SQL ships, where it lives, what `references/multi-tenant-rls.md` already promises that the migration must back.

Two questions the recon has to answer before any drafting:

1. **Does the supabase-js floor in ADR-0013 (`^2.88.0`, Dec 16 2025) need to move?** Latest stable is 2.105.1 (Apr 28 2026); 17 minor versions of churn between them, including realtime changes that may interact with ADR-0011's `setAuth` pattern.
2. **Is the `cross_tenant_leakage_rate_max` manifest cell ship-shaped or stay-deferred?** Depends on whether a fixture-design pass produces an adversarial corpus that meets the playbook's binary-scoring + Wilson-CI-gated bar.

## Internal recon — delta vs prior recons

### What ADR-0011/0013 receipts already prove (no re-litigating)

- JWT propagation works on both legs: Postgres-Changes RLS (table-level, automatic) + Broadcast Authorization RLS (`realtime.messages` policies + `private: true` opt-in). Smoke test [`tests/smoke/multi-tenant-rls.smoke.test.ts`](../../tests/smoke/multi-tenant-rls.smoke.test.ts) covers both layers in one `it()` block, sharing a single Pro branch.
- The `httpSend()` runtime contract is "throws on non-202 / resolves on 202." `if (!result.success)` is dead code; wrappers are `try/catch`-shaped. ADR-0013 implementation status block carries this as the canonical reading; CLAUDE.md surfaces it as a load-bearing convention.
- `realtime.messages` RLS denial is *silent*: REST returns 202, row filtered out by RLS, no fan-out, sender's `httpSend()` resolves successfully. Tenant isolation is enforced; failure-mode signaling to the caller is not. Documented in [`references/multi-tenant-rls.md`](../../references/multi-tenant-rls.md) § "Failure mode."

These are settled. ADR-0014 builds on them and does not re-derive them.

### What's still transient — the smoke-test schema

`tests/smoke/multi-tenant-rls.smoke.test.ts` constructs `audit_events` + `memberships` + `realtime.messages` policies *inside the test* against a freshly-provisioned Pro branch. The schema is the *de facto* worked example today; the SQL is correct (FAIL→fix→PASS receipts prove it); but it lives only in test code. Two consequences:

- A consumer of the npm package who reads the README and wants to "see the demo" has nowhere to look that isn't a test file. The reference page (`references/multi-tenant-rls.md`) explains *what* the policies do but doesn't ship the SQL itself.
- `supabase/migrations/` carries `support_tickets` (the triage example) and the queue-drain `queue` table; nothing for multi-tenant. Adding a migration is the natural next step; the SQL transcribes from the smoke test almost verbatim.

The migration's *job*: be the canonical artifact a consumer can `supabase db push` against to instantiate the worked example end-to-end. The smoke test stays as the regression gate; the migration is the published surface.

### What the v0.2.0 npm bump actually carries

Three additive items, all already merged on `main`:

1. **`private: z.boolean().default(false)`** on `BroadcastInputSchema` + `SubscribeChannelInputSchema` (ADR-0013). Caller-visible; advertised in the MCP `inputSchema` JSON; first MCP-tool-surface evolution since `0.1.0`.
2. **`@supabase/supabase-js` floor `^2.45.0` → `^2.88.0`** (ADR-0013). Closes `httpSend` availability + empty-Authorization-header fix.
3. **Demo migration** (this ADR) — net new in `0.2.0`.

The npm consumer story for `0.2.0` is "additive — `private` defaults to falsy, existing `0.1.x` callers see no behavior change; the demo migration is opt-in (consumer chooses to apply it or not)." No major bump warranted; the additive-MCP-versioning convention from ADR-0013 § 6 holds.

### What ADR-0010 (boundedQueueDrain) means for the worked example

`boundedQueueDrain` already composes `boundedWatch` + `handleBroadcast`. The multi-tenant audit-log shape is a natural fit: tenant-scoped queue drains into tenant-private channel. ADR-0013's open question § "Whether the `private` flag belongs only on `BroadcastInput`/`SubscribeChannelInput` or also on `boundedQueueDrain`" is the same threading question this ADR has to answer. Recommend threading it through — same pattern as ADR-0013's `subscribe()` call site, low cost, and the worked example *uses* `boundedQueueDrain` end-to-end.

## External research findings

One narrow probe was load-bearing: the supabase-js floor. The fixture-design pass on adversarial corpora is contingent on the manifest-cell decision and is run only if the decision tilts toward "ship."

### supabase-js — 17 minor versions of drift since the `^2.88.0` floor

**Headline:** ADR-0013 pinned `^2.88.0` on 2025-12-16. Latest stable as of 2026-04-28 is **2.105.1**; v3.0.0 is being staged (3.0.0-next.18 published 2026-04-30). The 17 minor versions in between include realtime protocol/behavior changes that warrant explicit consideration before ADR-0014 either holds or moves the floor.

Releases material to this artifact (extracted from [supabase-js CHANGELOG](https://raw.githubusercontent.com/supabase/supabase-js/master/CHANGELOG.md)):

| Version | Date | Realtime change | ADR-0014 implication |
|---|---|---|---|
| 2.91.0 | 2026-01-20 | **Default serializer to 2.0.0** (#2034) | Protocol-level. Wire format change; smoke tests are the canonical regression gate. |
| 2.93.0 | 2026-01-26 | Generic overload for `postgres_changes` event type (#1984); heartbeat for initial connection error (#1746) | Type-only + connection-resilience improvements. |
| 2.93.1 | 2026-01-27 | **Revert** validate table filter in postgres_changes event dispatch (#2060) | Reverts a 2.90.1 fix that regressed something — caller-invisible. |
| 2.95.0 | 2026-02-05 | `removeChannel` when unsubscribe successfully (#2091) | Cleanup-pattern change; could interact with our channel-removal sequencing. |
| 2.98.0 | 2026-02-26 | **Patch channel join payloads with resolved access token before flushing send buffer** (#2136) | Directly relevant to ADR-0011's `setAuth` pattern. Likely a *silent improvement* to the same gap; worth verifying smoke tests stay green. |
| 2.100.0 | 2026-03-23 | **Use phoenix's js lib inside realtime-js** (#2119) | Significant internal refactor; protocol surface unchanged but timing characteristics may shift. |
| 2.101.0 | 2026-03-30 | **Block setting `postgres_changes` event listener after joining** (#2201); add `copyBindings` (#2197) | Late-binding pattern is rejected; our `boundedSubscribe` registers listeners *before* `subscribe()` so this is no-op for us. Worth confirming. |
| 2.103.3 | 2026-04-16 | **Throw Error objects instead of bare strings** (#2256) | Aligns with ADR-0013's try/catch wrapper shape. Strict improvement for our error-handling. |
| 2.105.0 | 2026-04-27 | **Realtime deferred disconnect** (#2282) | Changes channel-disconnect lifecycle. Could affect short-lived Edge isolate cleanup. |
| 2.105.1 | 2026-04-28 | **Surface real Error on transport-level CHANNEL_ERROR** (#2299) | Diagnostic-only — better error messages on subscribe failure. |

**The two highest-leverage items:**

- **2.98.0 access-token patch on channel join.** Description matches the exact gap ADR-0011 closed manually (`setAuth` before subscribe). The substrate may now do this internally, which would make our `setAuth` calls *redundant but harmless*. Worth a smoke-test pass on 2.105.x before committing.
- **2.91.0 default serializer 2.0.0.** Wire-format change. The substrate ought to negotiate transparently, but a smoke-test re-run is the only honest evidence.

**v3.0.0 staging.** 18 prereleases out (3.0.0-next.0 → next.18). The recon does not investigate v3 in detail — it's pre-stable, no ADR-0014 commitment is wise on a moving target. ADR-0014 should explicitly bracket the floor as `>=2.88.0 <3.0.0` (or the more idiomatic `^2.x` shape) to keep v3 out of scope until it's released and proven.

**Implication for ADR-0014:**

Three plausible floor decisions, in order of conservatism:

- **(α) Hold at `^2.88.0`.** Safe; proven; but 17 minors of drift means real consumers default to versions we've never run smoke tests against.
- **(β) Bump to `^2.105.x` (latest stable as of recon).** Captures all post-floor improvements; requires re-running ADR-0011 + ADR-0013 smoke receipts on 2.105.x as evidence the bump is safe. Cost: one Pro branch + ~5min wall time.
- **(γ) Bracket: `>=2.88.0 <3.0.0`.** Acknowledges drift exists but doesn't claim a specific upper bound is verified. Range is honest; bound is mechanical (v3 is staging).

**Recommend (β) with smoke-test receipts**, falling back to (γ) if a smoke run on 2.105.x surfaces any regression. Stay-at-(α) is the weakest option — it ships a floor that's already four months out of date *and* is a worse signal to consumers than (γ).

### Fixture-design pass on adversarial cross-tenant corpora — deferred contingent

Per the recon's own framing (and ADR-0012 § 2), the manifest cell is reachable *only if* a defensible adversarial corpus is constructible at fixture scale. The fixture-design pass is the load-bearing input here. This recon does not pre-empt it; it stages the question:

- The smoke test already exercises one adversarial pair (B subscribes to A's tenant feed, A's broadcast must not reach B). That's *one* fixture, in test code, not a corpus.
- The playbook's binary-scoring rule is satisfiable: each fixture asserts "no cross-tenant event reaches the wrong listener; no cross-tenant injection succeeds." Easy to score 0/1.
- The Wilson-CI-gated rule wants n=100 (ci-full) or n=300 (v2.0.0). At p̂=0, n=100 → upper 0.0298; n=300 → upper 0.0125. Tight gate at v2.0.0 scale.
- **The risk:** adversarial fixtures generated by LLM-augmentation are likely to all look the same — "pair of tenants, A subscribes, B injects, assert no leakage." 100 such fixtures don't cover 100 *adversarial scenarios*; they cover one scenario 100 times. That's the proxy gap ADR-0012 § 2 named.

**The Exa pass for adversarial-corpus design is recommended *if* ADR-0014 tilts toward shipping the manifest cell**, and skipped if ADR-0014 defers it. Either outcome is honest; the fixture-design pass is the gate, not a foregone conclusion.

This recon's tentative read: **defer the manifest cell to a future ADR**. The substrate is already proven via smoke-test receipts; the demo migration + npm bump are the *guaranteed* parts of `0.2.0`; rolling in a fixture-driven gate that covers the same proxy ground would dilute the signal. Per ADR-0012 § 2, deferred ≠ failure. Worth filing the deferral with rationale rather than running a fixture-design pass that ADR-0014 may then reject.

## Design decisions ADR-0014 has to make explicitly

In rough order of effect:

1. **Demo migration scope.**
   - **(a)** Promote schema (audit_events + memberships) only; leave `realtime.messages` policies separate.
   - **(b)** Promote schema + `realtime.messages` policies + `user_tenant_ids()` SECURITY DEFINER helper. Full worked example as one migration.
   - **(c)** Promote everything, plus a sample data row (`INSERT INTO memberships ...`).
   - **Recommend (b)**. (a) is incomplete (no Broadcast Authorization gate ships); (c) is overreach (sample data is consumer-specific). The migration's job is to ship the *substrate* the worked example demonstrates, not to populate it.

2. **supabase-js floor.** See § "External research findings — supabase-js." Recommend **(β) `^2.105.x`** with re-verified smoke-test receipts on 2.105.x.

3. **Manifest cell `cross_tenant_leakage_rate_max`.** Recommend **defer**. Rationale: substrate-vs-composition split (ADR-0012 § 2) + proxy-gap risk on LLM-augmented adversarial fixtures. Future ADR can revisit when fixture-design produces a defensible corpus.

4. **`boundedQueueDrain` `private` threading.** Recommend **thread it through** — same shape as ADR-0013's tool-side threading; closes the open question ADR-0013 deferred. Low cost; closes a real gap (drain a tenant-scoped queue + broadcast to a tenant-private channel is the worked-example flow).

5. **npm bump shape.**
   - **(i) `0.2.0`** with all three items (private flag, supabase-js floor, demo migration). Single ship.
   - **(ii) Split:** `0.2.0` for ADR-0013's `private` flag now (already on `main`); separate `0.3.0` for the demo migration + floor bump.
   - **Recommend (i)**. The worked example IS the headline of `0.2.0`; splitting just creates two smaller releases that each carry less story. The handoff (line 104) recommends the same.

6. **Worked-example shape: confirm or revisit.** The 2026-05-01 recon recommended **(a) multi-tenant audit log → tenant-private broadcast channel**. Both ADR-0011 and ADR-0013 receipts ship against exactly that schema. Revisiting now would invalidate the receipts. **Confirm (a)**; (b) collaborative editing and (c) outbox-to-Slack are not in scope for ADR-0014.

7. **CHANGELOG + README.** First "real" CHANGELOG entry (0.1.x notes were terse). Worth a section on the additive `private` flag, the floor bump rationale, the demo migration link. README needs a one-paragraph "see the demo" pointer to the new migration.

## Falsifiable predicted effect (draft)

The substrate-correctness ADRs (0011, 0013) had clean predicted effects (binary leakage assertion). ADR-0014 is a *composition* ship — its predicted effect needs to match the composition phenomenon, not the substrate.

> **An external consumer of `supabase-realtime-skill@0.2.0` who runs `supabase db push` with the v0.2.0 demo migration applied, then invokes `boundedQueueDrain` with two tenants (A, B) and asserts that A's queue events never broadcast to B's channel under realistic JWT propagation, observes zero cross-tenant leakage in the steady-state run.**

Properties:
- **Smoke-test-shaped, not fixture-shaped.** This is what the existing multi-tenant smoke test already asserts; ADR-0014's job is to make that assertion *reproducible from the published artifact*, not from test code.
- **Falsifiable in two directions:** if the migration is incomplete (missing helper or policy), the post-fix smoke test fails; if the npm package's `private` threading is wrong, leakage shows up under `boundedQueueDrain`.
- **No new fixture corpus required for the substrate-correctness assertion.** The fixture corpus is the manifest cell's evidence base, which ADR-0014 defers per (3) above.

If ADR-0014 ends up *not* deferring the manifest cell, the falsifiable effect would extend to: "across n=100 fixture pairs covering same-table same-tenant baseline, same-table cross-tenant, broadcast same-tenant, broadcast cross-tenant, nested membership, observed cross-tenant leakage rate ≤ Wilson upper bound at gate threshold." Same predicted effect as the 2026-05-01 recon § "Falsifiable predicted effect," scaled to whatever n the ADR commits on.

## Where design risk concentrates

1. **Floor-bump regression risk.** Bumping `^2.88.0` → `^2.105.x` is a 17-minor-version jump. The smoke tests are the canonical regression gate; the cost is one Pro branch + 5min. The risk of *not* re-verifying is silent breakage on a version a consumer will hit by default (`npm install` resolves to the latest matching minor).

2. **Manifest-cell deferral discipline.** Same trap ADR-0012 surfaced: drafting momentum can roll a substrate-correctness ship into a fixture-design pass that has different evidence requirements. ADR-0014 should *explicitly* defer with rationale (substrate-vs-composition + proxy-gap), not silently skip.

3. **Demo migration / smoke test divergence.** The smoke test constructs SQL ad-hoc; the migration is permanent. If the smoke test evolves and the migration doesn't (or vice versa), the worked example silently rots. **The smoke test should `\\i supabase/migrations/<file>.sql`-equivalent the migration** — i.e., apply the migration as part of test setup rather than re-defining the schema inline. This is a separate refactor; ADR-0014 should commit on whether to include it.

4. **`boundedQueueDrain` `private` threading is silent if the caller doesn't opt in.** If a consumer uses `boundedQueueDrain` without setting `private: true`, the broadcast leg is public and tenant isolation isn't enforced — silent at the substrate, loud only on a multi-tenant smoke test the consumer hasn't written. The reference page (`references/multi-tenant-rls.md`) and the ADR should both call this out: **the worked example demonstrates the safe shape; consumers who deviate carry the risk**.

5. **CHANGELOG drift.** `package.json` ships a `version` field; CHANGELOG.md does not exist in the repo (verified — `ls CHANGELOG.md` returns nothing). 0.2.0 is the right time to introduce one; otherwise consumers don't have a canonical place to read the "what changed" story for floor bumps + the additive flag + the migration.

6. **Backward-compat assertions are theoretical.** The 0.1.x npm package is published but has no known external production consumers. The "additive change preserves callers" reasoning is correct *and* unverifiable — there's nothing to break. ADR-0014 should frame the additive convention as the convention going forward, not as a response to existing-consumer churn (same framing ADR-0013 § "Backward-compat for active v0.1.x consumers — but there aren't any yet" used).

## What this means for the next step

**Direction:** narrow composition ship — promote the smoke-test schema to a permanent migration; move the supabase-js floor to a verified-recent stable; thread `private` through `boundedQueueDrain`; defer the manifest cell with rationale; open a CHANGELOG. All in one PR (handoff line 104 recommends bundling, this recon agrees).

**Recommended ADR pre-loads:**

- **Sequence smoke-test re-run on 2.105.x BEFORE the floor bump.** Same FAIL→PASS-style discipline ADR-0011 used, but inverted: expect PASS on 2.105.x; if it fails, fall back to (γ) `>=2.88.0 <3.0.0` and document why.
- **Promote the smoke-test SQL to `supabase/migrations/<timestamp>_multi_tenant_audit_demo.sql`** — three tables (`audit_events`, `memberships` with junction shape) + `realtime.messages` SELECT/INSERT policies + `public.user_tenant_ids()` SECURITY DEFINER STABLE helper.
- **Refactor smoke test to apply the migration as setup**, not re-define the schema inline. Separate commit, same PR. Closes risk (3).
- **Thread `private?: boolean` through `boundedQueueDrain`'s public API.** Default `false`; same additive-MCP-versioning convention.
- **Defer `cross_tenant_leakage_rate_max` manifest cell explicitly** — file a separate sub-decision in ADR-0014 § "deferrals," same pattern as ADR-0012 § 2. Reason: substrate-vs-composition split + proxy-gap risk on adversarial fixtures.
- **File CHANGELOG.md** at repo root with `0.1.0` / `0.1.1` retroactive entries (terse) + `0.2.0` proper entry. README pointer to demo migration.
- **Frame the ADR as "shipping the worked example"** — not "introducing a new feature." All substrate work is done; ADR-0014 packages it for external consumption.

These are recommendations, not decisions — ADR will be filed as **Proposed**, per ADR status discipline.

**Open questions deferred to the ADR pass:**

- Whether the smoke-test re-run on 2.105.x should test ADR-0011's `setAuth` pattern explicitly (does 2.98.0's "patch channel join payloads with resolved access token" make our `setAuth` calls redundant?). Recommend yes — if redundant, document; if still needed, document. Either way, the receipts move from "verified on 2.88.0" to "verified on 2.105.x."
- Whether to add a `useDemoMigration: boolean` knob anywhere — probably no; consumers either apply the migration or don't, that's a `supabase db push` decision, not a runtime config.
- Whether to mirror the `boundedWatch` `private` threading (Postgres-Changes leg) for symmetry, even though Postgres-Changes RLS doesn't use the `private` flag. Recommend no — would advertise a knob with no effect on that leg, confusing the contract.
- Whether ADR-0014 also needs to update the MCP `inputSchema` JSON for `boundedQueueDrain`'s `private` threading. ADR-0013 already updated it for `BroadcastInput` + `SubscribeChannelInput`; same convention applies.
- Whether to release `0.2.0` *before* the manifest-cell decision is made, or *after*. Recommend before — the substrate ship is independently valuable; the manifest cell is a separate evidence stream.

## References

**Internal:**
- [`docs/recon/2026-05-01-multi-tenant-worked-example-recon.md`](2026-05-01-multi-tenant-worked-example-recon.md) — first recon in the multi-tenant arc; recommended candidate (a) audit-log shape; this recon confirms.
- [`docs/recon/2026-05-01-private-channel-substrate-api-recon.md`](2026-05-01-private-channel-substrate-api-recon.md) — second recon; produced ADR-0013; deferred fixture corpus + manifest cell to ADR-0014 (this work).
- [`docs/decisions/0011-multi-tenant-rls-baseline.md`](../decisions/0011-multi-tenant-rls-baseline.md) — Postgres-Changes RLS substrate fix; receipts on Pro branches.
- [`docs/decisions/0012-multi-tenant-audit-log-example.md`](../decisions/0012-multi-tenant-audit-log-example.md) — substrate-vs-composition split § 2; canonical writeup of the deferral discipline this ADR honors.
- [`docs/decisions/0013-private-channel-broadcast-authorization.md`](../decisions/0013-private-channel-broadcast-authorization.md) — Broadcast Authorization substrate fix + `httpSend` migration + supabase-js floor pin.
- [`references/multi-tenant-rls.md`](../../references/multi-tenant-rls.md) — operator deep dive; ADR-0014's demo migration is the SQL backing this page's policies.
- [`tests/smoke/multi-tenant-rls.smoke.test.ts`](../../tests/smoke/multi-tenant-rls.smoke.test.ts) — current home of the schema; ADR-0014 promotes to permanent migration.
- [`docs/handoff-2026-05-02.md`](../handoff-2026-05-02.md) § "What's actually next" — names the three ADR-0014 items + sequencing recommendation.

**External (supabase-js drift):**
- [supabase-js CHANGELOG](https://raw.githubusercontent.com/supabase/supabase-js/master/CHANGELOG.md) — primary source for the 17-minor-version drift; releases 2.88.0 through 2.105.1 reviewed.
- [supabase-js#2136](https://github.com/supabase/supabase-js/pull/2136) — 2.98.0 patch channel join payloads with resolved access token; potentially redundant with ADR-0011's `setAuth` pattern.
- [supabase-js#2034](https://github.com/supabase/supabase-js/pull/2034) — 2.91.0 default serializer 2.0.0; protocol-level wire format change.
- [supabase-js#2119](https://github.com/supabase/supabase-js/pull/2119) — 2.100.0 use phoenix's js lib inside realtime-js; significant internal refactor.
- [supabase-js#2256](https://github.com/supabase/supabase-js/pull/2256) — 2.103.3 throw Error objects instead of bare strings; aligns with ADR-0013 try/catch wrapper shape.
- [supabase-js v3.0.0-next staging](https://www.npmjs.com/package/@supabase/supabase-js?activeTab=versions) — 18 prereleases on the v3 line; out of ADR-0014 scope.

**External (Anthropic — already cited in prior recons):**
- [Anthropic — Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — additive tool-versioning convention; matches `private` flag default-`false` shape.
