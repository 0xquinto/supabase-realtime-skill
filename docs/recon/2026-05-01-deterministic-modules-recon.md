# Recon: deterministic composable modules (2026-05-01)

Pre-draft recon for adding a callable deterministic module on top of the existing `boundedWatch` primitive. Mirrors the shape of [`docs/upstream/recon/2026-05-01-pre-t31-engagement-recon.md`](../upstream/recon/2026-05-01-pre-t31-engagement-recon.md) — evidence first, ADR later. Filed on branch `explore/deterministic-modules`.

## Why this recon, why now

Coming out of the v0.1.x ship, the artifact has **one substrate primitive** (`boundedWatch`) and **one worked example** (the support-ticket triage agent). The `outbox-forwarder` is documented but lives as composition-by-hand in [`references/outbox-forwarder.md`](../../references/outbox-forwarder.md). The thesis the artifact already defends — *agents earn their keep at the boundary, the substrate should swallow the interior of well-defined operations* — extrapolates naturally to a second tier: lifting recurring composition patterns from "documented example" to "callable module with a falsifiable contract."

Two questions this recon has to answer before any drafting starts:

1. **Is the direction novel, derivative, or already commoditized?** Determines whether this is JD signal or table stakes.
2. **What design choices does the module's contract force, and where does the design risk concentrate?** Determines what the ADR has to disclose explicitly rather than hand-wave.

## Internal recon

### The outbox-forwarder is already half-promoted

[`references/outbox-forwarder.md`](../../references/outbox-forwarder.md) + [`tests/fast/outbox-forwarder.test.ts`](../../tests/fast/outbox-forwarder.test.ts) document and test the pattern. The consumer is currently wiring four things by hand:

```ts
while (running()) {
  const { events, closed_reason } = await boundedWatch({ adapter, table: "outbox", ... });
  for (const ev of events) {
    try {
      await handleBroadcast({ channel: row.destination, ... });
      await sql`update outbox set forwarded_at = now() where id = ${row.id}`;
    } catch (err) { /* leave forwarded_at null, retry next loop */ }
  }
  if (closed_reason === "timeout" && shouldDrain()) break;
}
```

The four pieces — loop, drain-condition, post-broadcast UPDATE (the ack), failure semantics — are exactly the load surface a deterministic module would absorb. The reference doc's "Production hardening notes" section already enumerates the v2 surface: `attempts++` for effectively-once, dead-lettering at `attempts >= 5`, ordering caveats, claim-id-based concurrent drain. **That section reads as a module specification waiting to happen.**

### The substrate seam is clean

`boundedWatch` (`src/server/realtime-client.ts:153`) takes a `RealtimeAdapter`. The proposed module composes `boundedWatch` + `handleBroadcast` + a SQL ack behind that same adapter seam — **no new abstraction layer required.** That matches the playbook anti-pattern guard ("no abstractions ahead of evidence"). The module is packaging existing parts under one typed contract.

### ADR-0007 already pre-stages the manifest expansion shape

[`docs/decisions/0007-pre-stage-v2-manifest-design.md`](../decisions/0007-pre-stage-v2-manifest-design.md) locks v2.0.0 at n=300 with tightened gates and explicitly documents the templated expansion pattern. Adding new metrics for a new module = a v2.0.0 amendment with its own per-cell rationale, exactly the loop ADR-0007 describes. **The slot is open.**

### ADR-0004 (T31 reshape) is strengthened by a second module

The reshape's ask is "PR three reference files for warm-up + replica identity + Edge bounded-subscription." A new module + worked example + own ADR becomes a fourth reference, and arguably the strongest because it shows *composition* of the patterns the others document. Improves option (B)'s landing odds materially — but only if the module is shipped against an eval contract, not just documented.

### v1 manifest only measures the triage path

[`manifest.json`](../../manifest.json) v1 has 4 metrics — latency p95, missed_events, spurious_trigger, action_correctness — all scored against the triage worked example. **Adding a module without a metric for it = ungated work**, which the playbook (§ 8) explicitly flags as anti-pattern.

## External research findings

External agent ran a focused pass over: outbox best-practice 2024-2026, prior art for "outbox for LLM agents," MCP/agent-skill design philosophy, Supabase's platform stance. Headlines below; full evidence with source URLs cited inline.

### 1. Transactional outbox — current best practice

**Headline:** The pattern is mature and converging on a small set of operational truths: log-based CDC beats polling for ordering and overhead, `FOR UPDATE SKIP LOCKED` is the de-facto polling primitive when you do poll, idempotency lives at the consumer (inbox table), DLQ is mandatory not optional. Credible critique worth confronting: **CDC + `pg_logical_emit_message()` is increasingly recommended *instead of* an outbox table** ([Decodable](https://www.decodable.co/blog/revisiting-the-outbox-pattern)) because it removes the table entirely and writes events to the WAL directly.

**Pushback on our framing:** "Transactional outbox" may be the wrong frame for half the use cases agents care about. Outbox specifically solves the dual-write problem between a service's DB and a downstream broker. If the worked example is "drain a queue and act on each row," that's closer to **competing-consumers / work-queue** — outbox-shaped but not outbox-proper. Calling the module `boundedOutboxDrain` ties it to the dual-write framing; calling it `boundedQueueDrain` covers more ground including pgmq.

**Implication:** The contract has three load-bearing decisions the module can't avoid:
- (a) drain semantics — at-least-once is the only honest default; effectively-once requires a consumer-side inbox table with a retention window (this is a *contract* surface, not a hidden detail);
- (b) ordering is per-aggregate, not global — module should expose `aggregate_id` as a first-class concept or explicitly disclaim ordering;
- (c) DLQ is part of the primitive, not an afterthought.

Replication-identity `FULL` is **not** required for this module (outbox is INSERT-only; default identity is enough) — a useful divergence from `watch_table`'s prerequisites and a docs-clarity opportunity.

### 2. Has anyone built "outbox for LLM agents" yet?

**Headline:** Not as a named primitive in any agent framework. Closest neighbors are durable-execution platforms (Inngest, Temporal, LangGraph checkpointing) — which solve agent *workflow* durability, a different problem — and one MCP curio (`mcp_agent_mail`) using inbox/outbox terminology for inter-agent coordination. **Bounded primitive + CDC-style drain + falsifiable eval contract appears to be unclaimed ground.**

Mapped neighbors:
- [Inngest "Durable Execution"](https://www.inngest.com/blog/durable-execution-key-to-harnessing-ai-agents) — `step.run` caches results so retries are safe. Complementary, not overlapping: makes agent code durable, not the substrate the agent observes.
- [LangGraph durable execution](https://www.langchain.com/blog/on-agent-frameworks-and-agent-observability) — same shape as Inngest, no outbox.
- [mcp-agent (lastmile-ai)](https://github.com/lastmile-ai/mcp-agent) — Temporal-backed pause/resume. Workflow-level.
- [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) — agent-to-agent coordination. Different problem.
- [AgentKit by Inngest](https://github.com/inngest/agent-kit) — multi-agent routing. Routing ≠ event drainage.

**Implication:** The unclaimed angle is **substrate-side determinism with a falsifiable contract** — not "make the agent loop durable" (Inngest owns that) and not "coordinate agents" (AgentKit/mcp_agent_mail). What's missing from existing implementations is the eval-gated contract: nobody else is shipping bounded primitives with Wilson-CI-gated regression tests. **That is the JD signal.**

**Caveat:** Recent (Q1-Q2 2026) launches from Restate / Hatchet / Cloudflare Durable Objects' agent offerings not exhaustively audited. A 5-min refresh search is worth doing before the ADR lands.

### 3. MCP tool design philosophy — explicit Anthropic cover

**Headline:** Anthropic has published the "deterministic interior, agentic boundary" thesis explicitly. Direct quote from [Anthropic, "Writing tools for agents"](https://www.anthropic.com/engineering/writing-tools-for-agents):

> *"Tools are a new kind of software which reflects a contract between deterministic systems and non-deterministic agents."*

Same post recommends *"a few thoughtful tools targeting specific high-impact workflows"* over wrapping every API endpoint, and uses a worked `schedule_event` example: prefer one tool that internally orchestrates `list_users` + `list_events` + `create_event` over exposing all three. **This is the principle the proposed module operationalizes — the ADR can cite the `schedule_event` example almost verbatim.**

Adjacent posts:
- [Anthropic, "Code execution with MCP"](https://www.anthropic.com/engineering/code-execution-with-mcp) — agents should compose typed primitives via code; introduces the "skill-module" pattern explicitly. The higher-order layer this design is reaching for.
- [Anthropic, "Equipping agents with Skills"](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — build skills *incrementally* by identifying gaps via evaluation. Aligns with promote-on-evidence.

**Implication:** The design has explicit Anthropic-published cover. Where to push *harder* than the published guidance: Anthropic's posts don't prescribe how to *prove* the consolidation was the right choice. The manifest-gated eval is the missing rigor — not a contradiction of the guidance, a test of it. **Re-frame the ADR as "operationalizing Anthropic's stated principle for Supabase substrate" — not as "this is unprecedented."**

### 4. Supabase-native outbox — platform stance

**Headline:** Supabase has shipped queueing infrastructure ([Supabase Queues / pgmq, GA Dec 2024](https://supabase.com/blog/supabase-queues)) and CDC primitives (Realtime, plus a [pg-to-external CDC pipeline](https://github.com/orgs/supabase/discussions/41231) in private alpha as of Dec 2025), but **has not published an opinion on the transactional outbox pattern specifically**, and crucially has not recommended pairing pgmq with Realtime/Postgres-Changes. The Queues blog never mentions "outbox."

The [supabase/agent-skills repo](https://github.com/supabase/agent-skills) currently has two skills: `supabase` (broad) and `supabase-postgres-best-practices`. **No CDC, Realtime, outbox, or async-pattern-specific skill.** This is a concrete gap.

**Implication:** Supabase has the substrate (pgmq + Realtime + WAL) but no opinionated composition. The new module can be *the* Supabase-native composition primitive, with a clean choice point: poll an outbox table via `boundedWatch` (CDC-style, what the repo already does), OR consume a pgmq queue with the same bounded contract. Doing both — one module, two adapters — is the most defensible move because it aligns with Supabase's existing direction *and* serves users who already have outbox tables.

## Design decisions the ADR has to make explicitly

In rough order of how much they affect the rest:

1. **Naming / scope.** `boundedOutboxDrain` (narrow, ties to dual-write framing) vs. `boundedQueueDrain` (broader, covers pgmq + outbox + work-queue). External research argues for the broader frame. Decision needs to land before any code shape.

2. **Adapter strategy.** Single-adapter (outbox-table-via-`boundedWatch`) shipped first, pgmq adapter as v0.3? Or both adapters at v0.2 to avoid locking in the wrong abstraction? Risk of single-adapter: discovering pgmq needs a different shape later. Risk of dual-adapter: shipping abstraction ahead of evidence (playbook anti-pattern).

3. **Drain-semantics contract.** At-least-once is the honest default. Effectively-once via consumer-side inbox table is the operator's responsibility — but the module's docs need to call this out *as part of the contract*, not as production-hardening footnote. The current `references/outbox-forwarder.md` § "Production hardening notes" buries this; the module promotion is the chance to surface it.

4. **DLQ in the primitive vs. the operator's job.** External research says DLQ is mandatory not optional. Concrete options: (a) module accepts a `dead_letter_table` parameter and writes failed-after-N rows there; (b) module surfaces a structured "DLQ candidate" return so the operator handles persistence; (c) operator's responsibility entirely (current state). Anti-pattern guard: don't ship DLQ logic before having a fixture that demonstrates poison-row behavior.

5. **Ordering disclosure.** Per-aggregate, not global. Module either exposes `aggregate_id` as first-class or disclaims ordering explicitly. The `references/outbox-forwarder.md` "ordering across destinations" note already disclaims; the module's typed contract should make this enforceable, not just documented.

6. **Manifest extension.** What metric(s) does the module add to v2.0.0? Candidates discussed below.

## Falsifiable predicted effect (draft)

Per playbook § 8, no recommendation without a falsifiable predicted effect. External research suggests this shape:

> **Agents handed `boundedQueueDrain` produce correct ack-and-retry behavior at a higher binary rate than agents handed raw `watch_table` + `describe_table` and instructed to roll their own loop, on a fixture set with deliberately injected poison rows, transient failures, and idempotency-key collisions.**

Properties this predicted effect has:
- **Binary scoring** (per-fixture: did the drain leave correct end-state? yes/no). Matches playbook § 8.
- **Falsifiable in both directions.** If agents already do fine with raw primitives, the module isn't earning its keep — that's an informative null. If the module wins, it's evidence the consolidation was correct.
- **Wilson-CI gateable** at n=100 (ci-nightly) and n=300 (v2.0.0) the same way the existing `action_correctness` is.
- **Requires new fixtures.** Existing `fixtures/ci-fast/` is triage-shaped; new fixtures need to exercise outbox/queue patterns. Cost: similar to v0.1 corpus synthesis (~$0.50 in LLM calls + spot-check).

Plausible candidate metric names for the v2.0.0 manifest:
- `forward_correctness_rate_min` — broadcast received with right destination + payload.
- `ack_durability_rate_min` — no row stuck unforwarded after N drain loops with retries available.
- `at_least_once_holds_rate_min` — no row forwarded zero times under N concurrent drainers (requires fixture infra for concurrent agents).

The ADR should pick **one** primary metric to gate on plus optionally one secondary, not all three. Multi-metric gating without paired CI math drifts toward the LLM-judge-as-gate anti-pattern.

## Where design risk concentrates

1. **Naming locks in framing.** The choice between "outbox" and "queue" affects the module's whole API surface and what evidence has to come with it.
2. **Effectively-once vs at-least-once contract** has to be exposed honestly. Hiding it = silent footgun for operators who assume idempotent-by-default. Past sharp-edges work in this codebase (replication-identity, warm-up window) was specifically about not hiding contracts.
3. **DLQ semantics** can't be hand-waved as "operator's job" — agents will hit poison rows in any realistic workload, and the module either has a story or doesn't.
4. **WAL / replication-identity prerequisites differ** from `watch_table` (less strict for outbox-INSERT). SKILL.md must call this out, otherwise operators carry forward `replica identity full` as universal advice.
5. **Anthropic's "skill modules with eval contracts"** is unclaimed territory. Good for JD signal, slightly risky for design — no precedent to lean on for the manifest design. ADR-0007's templated expansion is the closest internal anchor.

## What this means for the next step

**Direction:** derivative on the underlying pattern (transactional outbox is 6+ years old, well-trod) but **novel on the composition** — bounded primitive + CDC-style drain + falsifiable eval contract + Anthropic-shaped skill packaging is a combination nobody seems to have shipped. Anthropic's own published guidance reads like a brief for this work; lean into "operationalizing the stated principle" rather than novelty claims.

**Recommended ADR pre-loads:**
- Name the module `boundedQueueDrain` (not `boundedOutboxDrain`). Justify with the work-queue-vs-outbox distinction from external research.
- Ship single-adapter (outbox-table-via-`boundedWatch`) for v0.2; pre-stage pgmq adapter as a follow-up, mirroring how ADR-0007 pre-stages the v2.0.0 manifest. Don't ship dual-adapter abstraction ahead of evidence.
- DLQ option (a) — module accepts optional `dead_letter_table` parameter. Concrete fixture demonstrates it. No DLQ logic in the module before a fixture exists.
- One primary manifest metric (`forward_correctness_rate_min`), gated at v2.0.0. ADR explicitly defers the others as "candidate amendments if the primary metric proves too coarse."
- Cite the Anthropic `schedule_event` example explicitly. Frame the manifest as the missing rigor on Anthropic's stated principle.

These are recommendations, not decisions — the ADR will be filed as **Proposed**, per ADR status discipline (don't mark Accepted until the operator decides + the eval lands).

**Open questions deferred to the ADR pass:**
- Restate / Hatchet / Cloudflare DO's recent agent offerings — needs a 5-min refresh search.
- Whether `pg_logical_emit_message()` is available on Supabase Pro — affects whether the no-table CDC variant is a viable alternative shape.
- Whether the supabase/agent-skills maintainers have an unpublished design doc that would change positioning.

**→ Refresh executed:** [`playbook/research/2026-05-01-deterministic-modules-external-refresh.md`](../../playbook/research/2026-05-01-deterministic-modules-external-refresh.md) captures the searches run, what landed in ADR-0010, and what's still open.

## References

**Internal:**
- [`references/outbox-forwarder.md`](../../references/outbox-forwarder.md) — current pattern documentation
- [`tests/fast/outbox-forwarder.test.ts`](../../tests/fast/outbox-forwarder.test.ts) — current pattern test
- [`src/server/realtime-client.ts`](../../src/server/realtime-client.ts) — `boundedWatch` source + adapter seam
- [`manifest.json`](../../manifest.json) — v1.0.0 thresholds
- [`docs/decisions/0001-manifest-v1-stays-uncalibrated.md`](../decisions/0001-manifest-v1-stays-uncalibrated.md) — pre-registration discipline precedent
- [`docs/decisions/0004-reshape-t31-as-user-feedback.md`](../decisions/0004-reshape-t31-as-user-feedback.md) — T31 framing this work strengthens
- [`docs/decisions/0007-pre-stage-v2-manifest-design.md`](../decisions/0007-pre-stage-v2-manifest-design.md) — manifest expansion pattern
- [`playbook/PLAYBOOK.md`](../../playbook/PLAYBOOK.md) § 8 — anti-patterns guard

**External (primary weight):**
- [Anthropic — Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — the deterministic-contract quote + `schedule_event` example
- [Anthropic — Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) — skill-module pattern
- [Anthropic — Equipping agents with Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — incremental skill build via evaluation
- [Decodable — Revisiting the Outbox Pattern](https://www.decodable.co/blog/revisiting-the-outbox-pattern) — CDC-vs-outbox-table critique
- [event-driven.io — Push-based outbox](https://event-driven.io/en/push_based_outbox_pattern_with_postgres_logical_replication/) — log-based replication tradeoffs
- [Debezium Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html) — canonical schema + ordering semantics
- [Inngest — Durable Execution](https://www.inngest.com/blog/durable-execution-key-to-harnessing-ai-agents) — adjacent / complementary primitive
- [Supabase Queues blog](https://supabase.com/blog/supabase-queues) — platform queueing stance
- [supabase/agent-skills repo](https://github.com/supabase/agent-skills) — current skill catalog gap
