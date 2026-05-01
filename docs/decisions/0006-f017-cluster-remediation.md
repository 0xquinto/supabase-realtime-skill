# ADR 0006: f017 cluster remediation — enrich resolved-corpus with technically-flavored `general` examples

**Date:** 2026-05-01
**Status:** Proposed (pre-registered prediction; result will be appended after ci-nightly run)
**Decider:** Diego Gomez
**Context:** ADR-0002 documented the f019 seed relabel and named two v0.2 paths to address the f017 cluster (the remaining 5/100 systematic-miss source in ci-nightly):

> *"Plausible v0.2 paths: richer resolved corpus with technically-flavored `general` examples that bias retrieval correctly, or model swap from haiku-4-5 to a stronger router."*

This ADR pre-registers and tests path #1.

ADR-0005's data-quality audit confirmed f017 is genuinely **boundary-ambiguous**, not mislabeled. The label `general` is defensible (it's a feature request); the fix isn't to relabel, it's to give retrieval better signal so the LLM has stronger contextual evidence the routing is `general`.

## Hypothesis

If the resolved-corpus contains general-routed feature requests with **deep technical content semantically near f017's topic**, then top-K nearest-neighbor retrieval for f017 will surface them as evidence the routing should be `general`, not `engineering`. The LLM, seeing similar tickets resolved as `general`, should bias its decision accordingly.

The current resolved-corpus has 8 `general` examples but **none with deep technical surface near f017's pgvector / HNSW / Edge-Function infrastructure topics**. r026 ("Feature request: read-only API keys") and r031 ("When will Presence support land") are tonally feature-request-ish but topically distant. Top-K for f017 currently pulls in `engineering` tickets like r017 ("RLS policy migration") because semantic similarity prioritizes topical overlap over framing tone.

## Intervention

Add three new `general` resolved-corpus entries (r033, r034, r035) — each a "Feature request: <technical Postgres/Edge/Realtime topic>" with the same conversational shape as f017 (technical depth + roadmap-ish question + non-urgent framing):

- **r033** — "Feature request: native HNSW + tag filter optimization for vector search" (semantically near f017)
- **r034** — "Feature request: Edge Function cold-start optimization for embedding model loading" (technical Edge surface)
- **r035** — "Feature request: Realtime broadcast with at-least-once delivery semantics" (technical Realtime surface)

Three rather than one: r033 directly mirrors f017's topic so it's the dominant retrieval target; r034 + r035 are present so the bias generalizes beyond a single-fixture overfit (i.e., other f017-like synthesizer variations should also pull in r034 or r035 if they shift slightly off-topic).

The existing 8/8/8/8 routing balance becomes 8/8/8/11. The asymmetry is small and intentional — see "Predicted side effects" below.

## Pre-registered prediction

**Primary:** f017 cluster misroute count drops from 5/100 → ≤2/100. Equivalently: ci-nightly `agent_action_correctness` rises from 94/100 (rate 0.94, CI low 0.875) to ≥97/100 (rate ≥0.97, CI low ≥0.92). **Falsifiable.**

**Secondary (no-regression):** Other routings hold steady or improve. Per-routing `urgent` stays at 25/25, `engineering` stays at 29/30 (or improves to 30/30 if any f017-adjacent engineering misroutes shift correctly), `billing` stays at 25/25.

**Predicted side effect:** The 8 → 11 `general` corpus expansion may pull a small number of borderline `engineering` tickets toward `general` (the asymmetric retrieval probability biases marginally). I expect **at most 1/100** such drift across the rest of the corpus. If drift is ≥2/100, this ADR is effectively traded one bug for another and the intervention has not improved the artifact.

**What would falsify the hypothesis:**

- ✗ f017 cluster stays at ≥4/100 misroutes → corpus enrichment alone insufficient; needs prompt-level disambiguation rule or model swap
- ✗ Other routings drop ≥2/100 → asymmetric retrieval bias is too aggressive; constrain by also enriching other buckets or backing off to 2 new `general` entries
- ✗ Overall accuracy stays at 94/100 with no internal redistribution → embedding similarity isn't the bottleneck; routing decision isn't actually using top-K signal the way I assumed

## Methodology guardrails (anti-pattern checks)

- **Pre-registration honored:** This ADR is committed BEFORE the eval runs. Result will be appended to a Status: Accepted (or Rejected) addendum after ci-nightly completes.
- **No fixture relabeling:** f017 stays `general`. The intervention is corpus enrichment, not ground-truth modification.
- **No threshold modification:** `manifest.json` v1.0.0 is unchanged. The intervention either improves measured `agent_action_correctness` against the existing gates or it doesn't.
- **Falsifiable failure modes named in advance:** Three explicit "what would falsify" conditions above. If the result hits any of them, this ADR closes as Rejected (not "soft success / partial improvement").

## Steps

1. ✅ Add r033, r034, r035 to `fixtures/resolved-corpus.json` (commit-ready).
2. ✅ Re-run `node eval/embed-corpus.mjs` to regenerate `fixtures/embeddings.json` with 135 entries.
3. ✅ Commit ADR-0006 + corpus update + new embeddings together so the pre-registration is git-history verifiable.
4. ⏳ Run `bun run eval/runner.ts ci-nightly` against the existing fixture corpus (n=100, no fixture changes — only the resolved-corpus retrieval target changes).
5. ⏳ Append result to ADR-0006 as Accepted (if predicted lift hit) or Rejected (if any falsification condition triggered).

## Result (TO BE APPENDED POST-RUN)

*This section will be filled in honestly after ci-nightly completes. Either:*

> **Accepted (2026-05-01):** ci-nightly `agent_action_correctness` rose from 94/100 to X/100, CI low Y. f017 cluster misroutes dropped from 5/100 to Z/100. Other routings: [delta breakdown]. Side-effect drift: [n]/100. Hypothesis confirmed; corpus enrichment is the right v0.2 lever.

*OR*

> **Rejected (2026-05-01):** ci-nightly `agent_action_correctness` came in at X/100. [Which falsification condition triggered.] Hypothesis not supported; the v0.2 work needs a different lever (likely model swap per ADR-0002 path #2, or prompt-level disambiguation).

## How v0.3 should evolve this regardless of result

- If accepted: the v0.2 manifest amendment (ADR-0001's deferred work) can also bump the per-routing tracker to per-cluster (f017-cluster, f019-cluster, etc.) so future regressions surface faster.
- If rejected: try ADR-0002's path #2 (model swap to Sonnet 4.6) — covered by the [I] multi-model probe task already on the board.
- Either way: ADR-0005's v0.2 follow-up (run Mousavi audit on full n=100) should land before any further corpus changes.

## References

- [`docs/decisions/0001-manifest-v1-stays-uncalibrated.md`](0001-manifest-v1-stays-uncalibrated.md) — pre-registration discipline
- [`docs/decisions/0002-f019-seed-relabel.md`](0002-f019-seed-relabel.md) — names this v0.2 path
- [`docs/decisions/0005-fixture-corpus-data-quality-audit.md`](0005-fixture-corpus-data-quality-audit.md) — confirms f017 is boundary-ambiguous, not mislabeled
- [`fixtures/resolved-corpus.json`](../../fixtures/resolved-corpus.json) — corpus modified by this ADR
- [`fixtures/embeddings.json`](../../fixtures/embeddings.json) — regenerated for the new entries
- [`eval/reports/`](../../eval/reports/) — ci-nightly run report will land here when step 4 completes
