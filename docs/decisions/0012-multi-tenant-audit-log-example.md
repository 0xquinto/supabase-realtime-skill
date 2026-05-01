# ADR 0012: multi-tenant RLS — consumer reference page + scope-honest deferrals

**Date:** 2026-05-01
**Status:** Proposed → ready for promotion to Accepted (consumer reference page shipped; SKILL.md pointer added; deferred items named with rationale). Operator promotes when comfortable.
**Recommender:** Claude Opus 4.7 (assistant)
**Decider:** Diego Gomez (TBD)
**Implementation status (added 2026-05-01):**
- Reference page: shipped in this PR — [`references/multi-tenant-rls.md`](../../references/multi-tenant-rls.md).
- SKILL.md cross-link: shipped in this PR.
- Manifest amendment: **deferred — see § 2 below for rationale.** ADR-0007's pre-staged v2.0.0 design is unchanged.
- Substrate API change for private-channel Broadcast support: **deferred to ADR-0013** — the existing substrate doesn't expose `{ config: { private: true } }` on its `BroadcastSender` / `BroadcastAdapter` shapes. Adding it is a real API change that merits its own ADR.
- Permanent demo migration / npm `0.2.0` release: **deferred** — see § 4 below.

**Context:** the recon at [`docs/recon/2026-05-01-multi-tenant-worked-example-recon.md`](../recon/2026-05-01-multi-tenant-worked-example-recon.md) (PR #4, merged) recommended five pre-loads for this branch. ADR-0011 (PR #5, merged) shipped the bug-fix-with-receipts leg — `setAuth` propagation closed, falsifiable smoke test in place. This ADR ships the documentation + scope-honest deferrals leg, and explicitly does not paper over the methodology questions the recon raised but couldn't fully resolve.

The recon proposed a `cross_tenant_leakage_rate_max` manifest cell. After drafting the eval, the substrate-vs-composition split made the cell a weak signal — see § 2. Honest scope is to ship the reference page now and revisit the eval once a stronger angle exists.

## What this ADR proposes

A documentation + cross-link ship that captures the patterns the artifact now operationalizes, and an honest naming of three deferrals (manifest cell, private-channel substrate API, demo migration / npm release).

Filed **Proposed** because: (a) the deferrals are the operator's call — alternative scopes are defensible, (b) the reference page is large enough that operator review is non-trivial, (c) ADR status discipline says don't mark Accepted until operator decides + the deferrals don't unwind into "actually let's just ship them now."

## Decisions

### 1. Ship `references/multi-tenant-rls.md` as the consumer-facing artifact

`references/rls-implications.md` (38 lines) is a high-level summary of "what does the skill assume about RLS" — kept intact. The new `references/multi-tenant-rls.md` (~250 lines) is the deep dive specifically for "I'm building a multi-tenant app and want to wire `watch_table` + `broadcast_to_channel` correctly."

**Coverage breakdown:**

| Section | Why it's there |
|---|---|
| ⚠ Two RLS layers | The #1 source of "events not arriving" bugs. Postgres-Changes RLS (table policies, automatic) ≠ Broadcast Authorization RLS (`realtime.messages` policies, requires `private: true`). |
| The `setAuth` requirement | Names the gap PR #5 closed + the source-anchored mechanism (`SupabaseClient.ts:307-340, 534-541`). Avoids the failure mode where a future contributor builds an adapter and re-introduces the bug. |
| Production-grade schema shape | Synthesizes the 5-app survey from the recon — `memberships` junction + `(select auth.uid())` subselect + `SECURITY DEFINER STABLE` helper. Consumers can copy this and have a working starting point. |
| Channel topology under tenant isolation | The agent-side code pattern (`tenant:${id}:audit-feed` channel naming) + the matching `realtime.messages` RLS policy. Substrate doesn't enforce; consumer's job; reference shows the pattern. |
| Scale shape | Postgres-Changes' single-thread bottleneck + the recommended re-stream-via-Broadcast pattern. **Crucially names the bounded primitive as the recommended-re-stream-shape**, not as a limitation. |
| Common pitfalls | Echo prevention (SalesSheet.ai pattern), connection-pool-contamination non-issue for Edge isolates, no-`Authorization`-header behavior, `auth.uid()` vs `(select auth.uid())` performance. |
| Worked example: end-to-end | Points at the PR #5 smoke test as the live receipt. Reader can clone + run. |

This page closes the "no RLS-shaped worked example" credibility gap the recon named (gap #2 of 4 in § "Why this recon, why now").

### 2. Defer the `cross_tenant_leakage_rate_max` manifest cell

**The problem the recon didn't fully reckon with:** "cross-tenant leakage" can mean two different things:

| Layer | What "leakage" means | How to test |
|---|---|---|
| **Substrate** | Realtime delivers an event to a client whose JWT shouldn't have seen it | Smoke test against real Supabase Pro branch (see PR #5) |
| **Composition** | Consumer code (the agent's Edge Function) routes a tenant_a event to a tenant_b channel | Fake-driven eval with adversarial fixtures |

The substrate side is the falsifiable receipt. PR #5's smoke test demonstrates the bug, the fix, and the contract — `events_count=0` → `events_count=2/3 own-tenant, 0 cross-tenant`. That **is** the methodology evidence.

The composition side is harder. Tenant routing is ultimately string interpolation on the consumer's `read_row` callback: `channel: \`tenant:${row.tenant_id}:audit-feed\``. A fake-driven eval where the test harness writes the routing logic correctly will always pass — there's no falsifiable signal. To get one, the eval would need:

- Adversarial `read_row` implementations (does the substrate allow them?)
- Fixtures with malformed `tenant_id` values
- Partial-batch failure shapes that test substrate-level batching/no-batching guarantees

That's a real eval, but it tests substrate batching properties (which `boundedQueueDrain`'s existing fast tests already cover) rather than tenant-isolation-specifically. **Adding `cross_tenant_leakage_rate_max` for composition correctness would be a re-labeling of work the queue-drain eval already does, not a new methodology contribution.**

Honest cell deferred. ADR-0007's pre-staged v2.0.0 design unchanged. If a stronger angle emerges (e.g., a fuzz-style runner that generates adversarial consumer compositions), this ADR can be amended; for now, the smoke test is the binding evidence.

This is a "predicted-and-revisited" ADR shape — the recon proposed the cell, drafting revealed the proxy-gap, ADR honest-defers. Different from the simpler "predicted-and-confirmed" pattern of ADR-0011.

### 3. Defer the private-channel Broadcast substrate API change to ADR-0013

PR #5's reviewer noted that today's `BroadcastSender` / `BroadcastAdapter` shapes don't expose `{ config: { private: true } }` on the channel — the substrate currently only operates on public Broadcast channels. For multi-tenant Broadcast Authorization to work end-to-end (RLS gating on `realtime.messages` for per-tenant channels), the substrate needs to support private-channel mode.

This is a substrate API change, not a documentation change. Concretely:

- `BroadcastSender.send` needs an optional `private?: boolean` flag, propagating to `client.channel(name, { config: { private: true } })`
- `BroadcastAdapter.subscribe` symmetric
- The MCP tool definitions for `broadcast_to_channel` / `subscribe_to_channel` need to accept and forward the flag
- The MCP server's shared client doesn't change shape — `setAuth` already handles JWT propagation

That's a real API surface change with backward-compat questions (default to public for v0.1.x consumers, opt-in to private). Merits its own ADR + smoke test demonstrating the Broadcast Authorization leg works end-to-end.

`references/multi-tenant-rls.md` documents the channel-topology + RLS pattern as if `private: true` were already supported, because (a) it's about to be in ADR-0013, (b) the consumer wiring is the same with or without substrate support — the difference is whether the skill's `broadcast_to_channel` tool can opt-in.

### 4. Defer the permanent demo migration + npm `0.2.0` release

The recon recommended shipping a permanent `audit_events` migration in `supabase/migrations/`. This branch ships the schema as part of the smoke test (ephemeral), which is the falsifiable evidence; a permanent migration is a different artifact (a "bootstrap this and play" demo). Two reasons to defer:

- **Scope discipline.** The portfolio piece is at "ship documentation + ADR + smoke test" stage; adding a runnable demo app is a real product surface that deserves its own design. Conflating ADR-0012's documentation ship with a demo-app ship buries each in the other.
- **npm release coupling.** If we ship a demo migration that consumers are expected to use, that probably wants to align with an npm `0.2.0` release. The release headline ("multi-tenant patterns + worked example") is a stronger story when paired with substrate API additions (private-channel support per ADR-0013) — not when it's just docs + the substrate fix from ADR-0011.

**Recommended sequence:** ADR-0011 (bug fix) → ADR-0012 (this, docs + scope honesty) → ADR-0013 (private-channel substrate API + smoke test extension) → ADR-0014 (demo migration + npm `0.2.0` release headline).

That's three more ADRs for the multi-tenant story. Each one ships one falsifiable thing. None of them are dependency-blocked by this ADR; the order can shift if operator priority changes.

## What this ADR doesn't do

- **Doesn't ship code in `src/`.** Pure documentation + ADR. The substrate is unchanged from PR #5's state.
- **Doesn't add a manifest cell.** § 2 is the rationale.
- **Doesn't ship a private-channel API change.** § 3 is the rationale.
- **Doesn't bump npm.** § 4 is the rationale.
- **Doesn't update existing reference pages.** `references/rls-implications.md` (the high-level summary) is unchanged; `references/multi-tenant-rls.md` is additive. Cross-link added in SKILL.md.

## What changed since the recon

The recon's recommended pre-loads (PR #4 § "What this means for the next step") were six items. Disposition of each:

| Pre-load | Disposition |
|---|---|
| Sequence smoke test BEFORE setAuth fix | ✅ shipped in PR #5 (ADR-0011) |
| Multi-tenant audit-log worked example with junction-table tenancy | ⚠ partial — schema documented in `references/multi-tenant-rls.md`; smoke-test shape lives in PR #5; permanent migration deferred to ADR-0014 |
| Two-tenant smoke test asserting zero cross-tenant leakage | ✅ shipped in PR #5 — covers Postgres-Changes leg; Broadcast leg deferred to ADR-0013 |
| Pre-stage `cross_tenant_leakage_rate_max` in ADR-0007 v2.0.0 | ❌ deferred — § 2 names the proxy-gap that surfaced during drafting |
| File `references/multi-tenant-rls.md` | ✅ shipped in this PR |
| Frame as "closing the substrate-claim gap on RLS" | ✅ ADR-0011 + this ADR's preamble do this together |

5/6 of the recon's pre-loads land across PRs #5 + this PR. The 6th (manifest cell) is honestly deferred with rationale — playbook § 8 anti-pattern guard ("Recommending a change without a falsifiable predicted effect") is the discipline working as intended.

## Consequences

- **The reference page closes the documentation credibility gap from the recon.** A consumer reading the artifact today has a clear path: skim `rls-implications.md` for the summary, deep-dive into `multi-tenant-rls.md` when wiring an actual multi-tenant deployment.
- **The methodology trail gets a new shape: predicted-and-revisited.** ADR-0010 is "predicted-and-confirmed-with-baseline." ADR-0011 is "predicted-and-confirmed-and-fixed." This ADR is "predicted-and-on-revisit-deferred-with-rationale." All three are honest forms; the third one is the hardest to ship because the temptation is always to force the cell in to keep momentum. Resisting that is the discipline.
- **Three follow-up ADRs are now named on the roadmap.** ADR-0013 (private-channel API), ADR-0014 (demo migration + npm `0.2.0`), and a future revisit-the-manifest-cell branch if a strong angle emerges. The roadmap is concrete, not vague.
- **The `cross_tenant_leakage_rate_max` slot stays open in ADR-0007's v2.0.0 design until evidence supports filling it.** That's the manifest-cell discipline ADR-0007 itself codified — only ship cells with falsifiable predicted effects, never as labels.

## References

- [`docs/recon/2026-05-01-multi-tenant-worked-example-recon.md`](../recon/2026-05-01-multi-tenant-worked-example-recon.md) — recon (PR #4, merged) that recommended this branch's work
- [`docs/decisions/0011-multi-tenant-rls-baseline.md`](0011-multi-tenant-rls-baseline.md) — sibling ADR (PR #5, merged) shipping the bug-fix-with-receipts
- [`references/multi-tenant-rls.md`](../../references/multi-tenant-rls.md) — the consumer reference page shipped in this PR
- [`references/rls-implications.md`](../../references/rls-implications.md) — high-level summary, unchanged
- [`docs/decisions/0007-pre-stage-v2-manifest-design.md`](0007-pre-stage-v2-manifest-design.md) — manifest expansion pattern; unchanged by this ADR
- [`docs/decisions/0010-bounded-queue-drain.md`](0010-bounded-queue-drain.md) — first amendment to ADR-0007's v2.0.0 design; this ADR honestly does not add a second
- [`tests/smoke/multi-tenant-rls.smoke.test.ts`](../../tests/smoke/multi-tenant-rls.smoke.test.ts) — falsifiable receipt for the substrate leg, referenced by `references/multi-tenant-rls.md` § "Worked example: end-to-end"
- [`playbook/PLAYBOOK.md`](../../playbook/PLAYBOOK.md) § 8 — anti-pattern guard ("Recommending a change without a falsifiable predicted effect") that motivates § 2's deferral
