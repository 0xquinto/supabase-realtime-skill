# ADR 0010: `boundedQueueDrain` — promote outbox-forwarder from documented pattern to deterministic module

**Date:** 2026-05-01
**Status:** Proposed (recon-driven; design not yet built or eval-gated)
**Recommender:** Claude Opus 4.7 (assistant)
**Decider:** Diego Gomez (TBD)
**Context:** v0.1.x ships **one substrate primitive** (`boundedWatch`) and **one worked example** (the support-ticket triage agent). The outbox-forwarder pattern lives as composition-by-hand in [`references/outbox-forwarder.md`](../../references/outbox-forwarder.md) — documented and tested ([`tests/fast/outbox-forwarder.test.ts`](../../tests/fast/outbox-forwarder.test.ts)) but not promoted to a callable module. This ADR proposes promoting it to `boundedQueueDrain`: a typed, deterministic module composing `boundedWatch` + `handleBroadcast` + a SQL ack behind the existing adapter seam, plus a v2.0.0 manifest amendment that gates the module on a falsifiable contract.

Pre-recon at [`docs/recon/2026-05-01-deterministic-modules-recon.md`](../recon/2026-05-01-deterministic-modules-recon.md) supplied the evidence base (internal seams + external prior art). This ADR locks the design choices the recon flagged but did not decide.

## What this ADR proposes

A new module `boundedQueueDrain(opts)` exported from `supabase-realtime-skill/server`, plus a v2.0.0 manifest cell `forward_correctness_rate_min` gating its eval contract. Single-adapter at v0.2 (outbox-table-via-`boundedWatch`); pgmq adapter pre-staged as v0.3. DLQ surfaced as an optional `dead_letter_table` parameter. Filed **Proposed** because (a) the eval fixtures haven't been built, (b) the manifest amendment is a v2.0.0 amendment that's already pre-staged in ADR-0007 but hasn't shipped, and (c) the operator hasn't decided whether v0.2's headline ships against a primary metric of `forward_correctness_rate_min` or whether to defer the module to v0.3 entirely.

## The thesis being operationalized

Anthropic's "Writing tools for agents" post states the principle directly:

> *"Tools are a new kind of software which reflects a contract between deterministic systems and non-deterministic agents."*

The same post advocates *"a few thoughtful tools targeting specific high-impact workflows"* over per-endpoint wrapping, and uses a worked `schedule_event` example: prefer one tool that internally orchestrates `list_users` + `list_events` + `create_event` over exposing all three primitives separately.

The artifact already operationalizes this on the read side (`watch_table` is a bounded composition over Realtime + filter + safety budget). `boundedQueueDrain` extends the same shape to the **drain-and-act** side: rather than asking agents to compose `boundedWatch` + `handleBroadcast` + a SQL ack themselves and risk per-implementation footguns (skipping the ack, failing-open on retry, ordering surprises across destinations), the substrate ships one typed contract that swallows the interior.

The novelty isn't the principle — Anthropic published it. The novelty is **packaging it on the Supabase substrate with a falsifiable manifest gate**, which the recon's external survey found unclaimed across the durable-execution / agent-framework neighborhood.

## What changed since the recon

The recon flagged three open questions for the ADR pass to refresh. Quick refresh sweep done 2026-05-01; durable record at [`playbook/research/2026-05-01-deterministic-modules-external-refresh.md`](../../playbook/research/2026-05-01-deterministic-modules-external-refresh.md).

**Q1 — Restate / Hatchet / Cloudflare DO recent (Q1-Q2 2026) agent offerings.** Three findings:

- **Cloudflare Project Think + `Agent.runFiber()`** ([PR #1256, Apr 4 2026](https://github.com/cloudflare/agents/pull/1256); [Project Think launch, Apr 15 2026](https://blog.cloudflare.com/project-think/)) shipped durable execution baked into the base Agent class on Cloudflare Durable Objects — LLM streams that survive eviction, durable cross-DO RPC, persistent sessions. **Larger than the recon assumed.** Still workflow-level (the agent's *loop* is durable), not substrate-level (the database events the agent *observes* are not what's being made durable). The orthogonality holds: Cloudflare makes the agent's reasoning durable; this artifact makes the substrate the agent observes deterministic. They compose.
- **Restate** released v1.6.0 (Jan 30) and shipped integrations with the [OpenAI Agents SDK](https://github.com/openai/openai-agents-python/pull/2359) and [pydantic-ai](https://github.com/pydantic/pydantic-ai/pull/5041), introducing `@durable_function_tool` — making **tool calls** durable. That's tool-side, not substrate-side, and complementary: a `boundedQueueDrain` invocation could itself be wrapped in a Restate-durable tool with no surface conflict. Worth name-checking; doesn't change the design.
- **Hatchet** ([@v0.83.30](https://github.com/hatchet-dev/hatchet/releases/tag/v0.83.30); [MCP runtime PR #3255, Mar 12 2026](https://github.com/hatchet-dev/hatchet/pull/3255)) is the closest neighbor — a durable PG-backed task queue with an MCP endpoint exposing queue metrics to agents. Hatchet is the broker; agents observe it. This artifact's value is the inverse: a primitive on Supabase substrate the user already has, no new broker to adopt. Different positioning.

**Q2 — `pg_logical_emit_message` availability on Supabase Pro.** Not authoritatively confirmed in the sweep. It's a standard Postgres function (no extension required), Supabase Pro grants the privileges needed for `pg_create_logical_replication_slot`, so the function is **likely available** but verification is left to v0.3 if the no-table CDC variant is pursued. **Not load-bearing for v0.2.** ADR-0007's manifest expansion holds independent of this.

**Q3 — `supabase/agent-skills` maintainer's unpublished design direction.** Unknowable without operator outreach (T31 / ADR-0004). This ADR doesn't depend on upstream alignment; if T31 / option (B) lands, this module's reference page can be PR'd as a fourth reference file.

## Decisions

### 1. Naming: `boundedQueueDrain` (not `boundedOutboxDrain`)

External research is unambiguous: "transactional outbox" is one specific use case (dual-write between a service DB and a downstream broker); the module's actual surface covers any pattern shaped like *"watch a table for new rows, act on each, ack the row."* That includes outbox-proper, work queues, pgmq draining, audit-log forwarding, and several others. Tying the name to "outbox" misframes the contract.

The pattern shipped in `references/outbox-forwarder.md` already crosses this line — it's documentation of an outbox-shaped use, but the substrate it composes (`boundedWatch` + `handleBroadcast` + SQL ack) is queue-drain-shaped, not outbox-specific.

**Trade-off:** "Outbox" has more SEO and is the term enterprise architects search for; "queue drain" is more precise but less Google-able. The reference page can lead with "outbox-shaped patterns" in its examples while the module name reflects the broader contract — matches how Anthropic's `schedule_event` example works in their post (the tool name reflects the use case the agent reasons about; the implementation orchestrates lower-level primitives).

### 2. Adapter strategy: single-adapter v0.2, pgmq pre-staged as v0.3

The recon flagged the dual-adapter risk: shipping abstraction ahead of evidence (playbook anti-pattern). Pick: v0.2 ships one adapter only — `boundedWatch`-over-outbox-table — because (a) the existing reference + tests already validate this shape, (b) there's no second adapter consumer asking for the abstraction yet, (c) the playbook's pre-registration discipline says "promote on evidence, not on speculation."

pgmq adapter is pre-staged as a v0.3 follow-up the same way ADR-0007 pre-stages the v2.0.0 manifest: design intent locked, ship-trigger is a concrete consumer asking for it. The pre-staging avoids "we couldn't see this coming" if pgmq adoption turns out to want a different module shape — explicit deferral with rationale beats hidden coupling.

**Risk consciously accepted:** if pgmq's drain shape demands different module ergonomics (e.g., visibility-timeout semantics that don't map to outbox-table claim windows), v0.3 may need to ship a second module rather than a second adapter. The recon's argument for `boundedQueueDrain`-as-name partially hedges this — the name accommodates either path.

### 3. DLQ surface: optional `dead_letter_table` parameter (option (a) from the recon)

External research consensus: DLQ is mandatory, not optional, in any production-grade queue-drain pattern. But the playbook is equally clear: don't ship logic before there's a fixture demonstrating its behavior.

Compromise: the v0.2 module *accepts* a `dead_letter_table` parameter and, if provided, writes failed-after-N-attempts rows to it; if not provided, behavior is the current at-least-once-with-retry pattern (rows stay unforwarded, retried next loop). The v0.2 ship requires **a fixture exercising the DLQ path** — at minimum one fixture row that's deliberately poison (e.g., destination channel that doesn't exist or payload that fails handler validation), with assertion that it lands in the DLQ table after N attempts. No DLQ logic merges before that fixture exists.

**What this rejects:** option (b) (return a structured "DLQ candidate" for the operator to handle) introduces an ergonomics break that complicates the loop. Option (c) (operator's responsibility entirely) leaves the load-bearing reliability surface unspecified and is what the current `references/outbox-forwarder.md` does — promoting the module without picking up DLQ would not earn its keep.

### 4. Drain-semantics contract: at-least-once is the documented default; surface it in docs, not (yet) in the type system

The current `references/outbox-forwarder.md` § "Production hardening notes" buries the at-least-once truth as a footnote. The recon (§ "Where design risk concentrates" item 2) calls hidden semantics the top sharp-edges risk for this module — operators who assume idempotent-by-default get burned silently. Fix: surface the contract explicitly in (a) the typedoc comment on `BoundedQueueDrainOptions`, (b) the reference page's first paragraph, and (c) `SKILL.md`'s description of the module.

```ts
type BoundedQueueDrainOptions = {
  // ... adapter, table, etc ...
  /**
   * IMPORTANT: this module is at-least-once. Each row may be forwarded
   * more than once if the broadcast succeeds but the ack UPDATE fails.
   * Subscribers MUST be idempotent. To upgrade to effectively-once, the
   * operator runs a consumer-side inbox table — see
   * references/queue-drain-semantics.md.
   */
}
```

**What this rejects:** an earlier draft considered a required literal field `semantics: "at-least-once"` to force operator acknowledgment at the call site. That's friction without information gain at v0.2 (a required field with one allowed value the type system can't help reject). Defer the literal-typed approach to **the moment** v0.3 introduces a second value (e.g., `"effectively-once"`) — at that point a discriminated union earns its keep. Until then, docs-side discipline carries the contract.

This matches the codebase's existing sharp-edges work (replication-identity, warm-up window): those are documented contract surfaces, not type-enforced ones. Consistency with prior shapes is a small but real JD-signal point.

### 5. Ordering: per-aggregate, disclaimed in the contract

Realtime broadcast is fire-and-forget; broadcasts to different channels have no ordering guarantees relative to each other. For destinations that must observe events in order, the operator runs a per-destination FIFO queue, which is a different module shape entirely.

The module's docs name this directly. The typed contract does not enforce per-aggregate ordering — there's no `aggregate_id` argument in v0.2 — because adding it ahead of a fixture that exercises the ordering-violation path would be (again) abstraction ahead of evidence. v0.3 may add ordering guarantees if a fixture demonstrates the failure mode.

### 6. Manifest amendment: one primary metric, gated at v2.0.0

`forward_correctness_rate_min` is the primary metric. The fixture asks: did the drain leave the queue in the correct end-state (all forwardable rows forwarded; all poison rows in DLQ; no dupes that the broadcast handler wouldn't catch)? Binary per fixture. Wilson-CI gateable on the same n=300 corpus that ADR-0007 pre-stages.

**Pre-staged manifest cells (amendments to ADR-0007's v2.0.0 design — numeric thresholds tentative):**

| Cell | v2.0.0 (current ADR-0007) | v2.0.0 with this ADR amendment (tentative) | Rationale |
|---|---|---|---|
| `forward_correctness_rate_min` | (not defined) | 0.95 *(tentative)* | Substrate composition + handler retry envelope should leave at most ~5% of fixtures in incorrect end-state under realistic poison-row injection. Tighter than `action_correctness` because the work is mechanical (no LLM-judgment-call surface). **No baseline run yet** — number is a target, not yet evidence-backed. |
| `forward_correctness_ci_low_min` | (not defined) | 0.92 *(tentative)* | Wilson lower at n=300, p̂=0.95 ≈ 0.918. Setting floor at 0.92 keeps a small cushion. **Mechanical math holds; the rate it gates against is the tentative cell above.** |

**Calibration discipline (mirrors ADR-0007 § "action_correctness conditional on ADR-0006"):** the `0.95 / 0.92` numbers are *targets* for the pre-staged design, not committed thresholds. The actual cells lock at the moment the v0.2 baseline run lands at n=100 (Migration step 5), at which point this ADR amendment moves to a status update with the empirical p̂ replacing the tentative target. If the baseline reveals the substrate is meaningfully cleaner or dirtier, the threshold cell moves accordingly — same loop ADR-0001 documented for v1.0.0 → v2.0.0.

Single primary metric chosen deliberately. The recon's other candidates (`ack_durability_rate_min`, `at_least_once_holds_rate_min`) are deferred as **candidate follow-up amendments** if `forward_correctness_rate_min` proves too coarse. Multi-metric gating without paired CI math drifts toward LLM-judge-as-gate (anti-pattern; playbook § 8).

### 7. Replication-identity prerequisites: documented divergence from `watch_table`

Outbox tables are INSERT-only. `replica identity full` is **not required** for `boundedQueueDrain` (default identity carries enough info — `payload.new` has the row). This is a useful divergence from `watch_table`'s prerequisites. The reference page must surface this explicitly so operators don't carry forward `replica identity full` as universal advice from the triage example.

This is also an opportunity to retroactively clarify [`references/replication-identity.md`](../../references/replication-identity.md) — the page currently presents `replica identity full` as a near-universal requirement; the queue-drain pattern is the counterexample that makes the docs more precise.

## Predicted effect (falsifiable, per playbook § 8)

> **Agents handed `boundedQueueDrain` produce correct ack-and-DLQ behavior at a higher binary rate than agents handed raw `watch_table` + instructed to compose the loop themselves, on a fixture set with deliberately injected poison rows, transient broadcast failures, and idempotency-key collisions.**

Properties:
- **Binary scoring** per fixture (correct end-state? yes/no).
- **Falsifiable in both directions.** If agents already handle raw-primitive composition fine, the module isn't earning its keep — informative null. If the module wins, it's evidence the consolidation was correct *and* aligned with Anthropic's published guidance.
- **Wilson-CI gateable** at n=100 (ci-nightly) and n=300 (v2.0.0) on the same fixture infrastructure.
- **Requires new fixtures.** Existing `fixtures/ci-fast/` is triage-shaped. New fixtures for queue-drain need ~20 hand-curated seeds covering: clean drain, poison-row → DLQ, transient broadcast failure → retry-success, idempotency-key collision → no double-forward, drain-condition timeout. Cost: similar to v0.1 corpus synthesis (~$0.50 in LLM calls + spot-check).

## What this ADR commits to (when promoted to Accepted)

1. Promote `references/outbox-forwarder.md` to a module-shaped reference (`references/queue-drain.md`), adding the typed contract surface (semantics literal, optional `dead_letter_table`, replica-identity divergence note).
2. Ship `boundedQueueDrain` from `src/server/queue-drain.ts`, exporting from `supabase-realtime-skill/server`. Reuse `boundedWatch` + `handleBroadcast` + the existing adapter seam — **no new abstraction layer**.
3. Build 20-fixture seed corpus for `forward_correctness_rate_min`, including poison-row injection.
4. Amend ADR-0007's pre-staged v2.0.0 manifest with the two new cells. Pre-staging discipline is preserved; the file ships atomically with the n=300 corpus.
5. Run `ci-nightly` once at n=100 against the new metric to establish empirical baseline before v2.0.0 lands.

## What this ADR doesn't do

- **Doesn't ship the module.** Status is Proposed. No code lands until operator decides.
- **Doesn't ship pgmq adapter.** Pre-staged as v0.3 follow-up.
- **Doesn't ship effectively-once semantics.** v0.2 is at-least-once only; the literal-type design accommodates v0.3 expansion.
- **Doesn't auto-trigger n=300 corpus synthesis.** That's still ADR-0007's commit, with the new cells as an amendment.
- **Doesn't depend on T31/ADR-0004 outcome.** The module ships independent of upstream `supabase/agent-skills` engagement; if T31 lands, the new reference is the fourth file in the PR.

## Where design risk concentrates

Re-stating from the recon, with explicit mitigations:

1. **Naming locks framing** → mitigated by picking `boundedQueueDrain` (broader) and letting the docs lead with outbox-shaped examples.
2. **Effectively-once vs at-least-once contract** → mitigated by surfacing as required literal field, not a hidden default.
3. **DLQ semantics** → mitigated by shipping optional `dead_letter_table` *with* a fixture, never logic-without-fixture.
4. **Replication-identity divergence** → mitigated by docs upgrade (and the divergence is a clarity win for `replication-identity.md` page).
5. **Eval-gated skill modules unclaimed territory** → still risky; ADR-0007's templated expansion is the closest internal anchor, Anthropic's published guidance is the external one. Both cited.

## Migration / how to apply

When this ADR is Accepted:

1. **Fixture work first.** Build the 20-fixture seed corpus in `fixtures/ci-fast/queue-drain/` matching the existing ci-fast pattern. Spot-check 10/20 manually. Ungated work (no code yet) is low risk.
2. **Module implementation.** `src/server/queue-drain.ts` — small file, composes existing primitives. `src/server/index.ts` exports `boundedQueueDrain`. `tests/fast/queue-drain.test.ts` covers the loop with mocked adapters. `tests/smoke/queue-drain.smoke.test.ts` exercises against a real branch.
3. **Reference page.** Promote `references/outbox-forwarder.md` to `references/queue-drain.md` with the typed contract surface. Update `SKILL.md` to link the new page. Cross-link from the old page (or redirect via README note) for any external links.
4. **Manifest amendment.** Append `forward_correctness_rate_min` + `forward_correctness_ci_low_min` to ADR-0007's pre-staged v2.0.0. Don't ship `manifest.json` yet — atomic ship with n=300 corpus is preserved.
5. **Eval baseline run.** `bun run eval/runner.ts ci-nightly` at n=100 against v1 manifest + the new cells (advisory — they won't gate at n=100 because of the same Wilson-bound math ADR-0001 documented).
6. **Status flip.** This ADR Accepted, ADR-0007 amendment noted, release as v0.2.0.

## Consequences

- **The artifact ships a second deterministic module**, validating the "promote on evidence" pattern as repeatable rather than one-off.
- **The eval contract grows** with the module, sustaining the playbook discipline (no ungated work).
- **The Anthropic-published thesis is operationalized end-to-end**: deterministic interior, agentic boundary, falsifiable contract.
- **T31 / ADR-0004 option (B) lands stronger** — the upstream feedback would be backed by *two* worked modules, not one.
- **Pre-registration loop runs in all three outcomes** — Proposed (now), Accepted (if operator decides + eval lands), Rejected (if the predicted effect doesn't reproduce). The pre-registration discipline is the test.

## References

**Internal:**
- [`docs/recon/2026-05-01-deterministic-modules-recon.md`](../recon/2026-05-01-deterministic-modules-recon.md) — the recon this ADR draws from
- [`references/outbox-forwarder.md`](../../references/outbox-forwarder.md) — current pattern doc that this module promotes
- [`tests/fast/outbox-forwarder.test.ts`](../../tests/fast/outbox-forwarder.test.ts) — current pattern test
- [`src/server/realtime-client.ts`](../../src/server/realtime-client.ts) — `boundedWatch` source + adapter seam
- [`docs/decisions/0001-manifest-v1-stays-uncalibrated.md`](0001-manifest-v1-stays-uncalibrated.md) — pre-registration precedent
- [`docs/decisions/0004-reshape-t31-as-user-feedback.md`](0004-reshape-t31-as-user-feedback.md) — upstream framing this work strengthens
- [`docs/decisions/0007-pre-stage-v2-manifest-design.md`](0007-pre-stage-v2-manifest-design.md) — manifest amendment pattern
- [`playbook/PLAYBOOK.md`](../../playbook/PLAYBOOK.md) § 8 — anti-patterns (no-abstractions-ahead-of-evidence; falsifiable predicted effect)

**External (primary weight):**
- [Anthropic — Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — the deterministic-contract quote + `schedule_event` example this module operationalizes
- [Anthropic — Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) — skill-module pattern
- [Anthropic — Equipping agents with Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — incremental skill build via evaluation
- [Cloudflare PR #1256 — Agent.runFiber()](https://github.com/cloudflare/agents/pull/1256) — workflow-side durability (orthogonal)
- [Cloudflare — Project Think](https://blog.cloudflare.com/project-think/) — durable agents launch
- [Restate v1.6.0 release](https://github.com/restatedev/restate/releases/tag/v1.6.0) — workflow-level durability
- [Restate × OpenAI Agents SDK PR #2359](https://github.com/openai/openai-agents-python/pull/2359) — `@durable_function_tool` (tool-side durability)
- [Hatchet MCP runtime PR #3255](https://github.com/hatchet-dev/hatchet/pull/3255) — closest neighbor (broker-side; different positioning)
- [Decodable — Revisiting the Outbox Pattern](https://www.decodable.co/blog/revisiting-the-outbox-pattern) — CDC-vs-outbox-table critique informing the naming
- [Debezium Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html) — canonical schema + ordering semantics
- [Supabase Queues / pgmq blog](https://supabase.com/blog/supabase-queues) — platform queueing stance (informs v0.3 pre-stage)
