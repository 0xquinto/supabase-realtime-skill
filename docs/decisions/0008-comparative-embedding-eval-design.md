# ADR 0008: comparative embedding eval — OpenAI 1536 vs MiniLM 384 (pre-staged design)

**Date:** 2026-05-01
**Status:** Proposed (design + pre-registered prediction; ships when `OPENAI_API_KEY` is configured and the run completes)
**Decider:** Diego Gomez
**Context:** ADR-0003 introduced the dual-path embedding provider (OpenAI 1536-dim primary; Transformers.js MiniLM 384-dim fallback) to close the spec deviation while preserving zero-deps reproducibility. ADR-0003 § "How v0.2 should evolve this" pre-registered:

> *"Compare retrieval quality: OpenAI 1536 vs all-MiniLM-L6-v2 384 on the same fixtures. The hypothesis is that 1536 lifts f017 (the remaining systematic miss) because deeper semantics distinguish 'feature request about a technical surface' from 'engineering bug.' This belongs in v0.2 as a predicted, falsifiable effect per the playbook discipline."*

This ADR locks the comparative methodology so the result is interpretable when run, and pre-registers the prediction *before* `OPENAI_API_KEY` is configured. Same discipline as ADR-0006: prediction-in-git-history before the result.

## Why the comparison matters

Two latent questions ride on the embedding-dim choice:

1. **Spec compliance:** Does the canonical `halfvec(1536)` substrate (Automatic Embeddings shape) actually retrieve better than the eval's fallback `halfvec(384)` substrate? If yes, the eval-fallback path is a known-degraded comparison; if no, the dim-distinction is cosmetic and 384-dim is "good enough" for retrieval-driven routing.
2. **f017 cluster residual:** ADR-0006 closed 2 of 5 f017 misses via corpus enrichment under MiniLM 384. ADR-0006's Accepted-with-caveats addendum routed the remaining 3 misses to either model swap (task [I]) or richer embeddings. This ADR tests the latter.

Both questions are answered by the same single comparative run.

## Hypothesis

**Primary:** OpenAI text-embedding-3-small (1536-dim, trained on a much larger and more diverse corpus than MiniLM) produces top-K retrieval that better discriminates `general` (feature request) from `engineering` (bug) for the f017 cluster. The mechanism: 1536-dim embeddings encode framing/intent signal more cleanly than 384-dim, so the resolved-corpus's r033/r034/r035 (technically-flavored `general` examples added in ADR-0006) sit closer to f017-v2/v3/v4 in 1536-space than they do in 384-space.

**Secondary (no-regression):** OpenAI embeddings hold or improve `engineering`, `urgent`, `billing` accuracy. The f010 PG-perf-regression drift to `urgent` (from ADR-0006) plausibly reverses if 1536-dim better picks up the engineering-question framing.

## Pre-registered prediction

| Metric | Current (MiniLM 384, post-ADR-0006) | Predicted (OpenAI 1536) | Falsifies if |
|---|---|---|---|
| `agent_action_correctness` rate | 96/100 (0.96) | **≥98/100 (≥0.98)** | rate < 0.97 |
| Wilson CI low | 0.902 | **≥0.93** | CI low < 0.90 |
| f017 cluster misroutes | 3/5 | **≤1/5** | ≥3/5 misses (no improvement) |
| f010-eng drift to urgent | 1/100 | **0 or 1** (allowed) | ≥2/100 (regression) |
| Other routings | urgent 25/25, eng 24/25 (sans f010), bill 25/25 | hold or improve | any drops ≥2/100 from current |
| Latency p95 | 1300ms | **≤1500ms** | >1500ms (the OpenAI embedding API call adds ~80-150ms per query, but it's amortized — embedding is pre-computed at corpus load, not per-trial) |

**What would falsify:**

- ✗ Rate stays at 96/100 or drops → embedding dim isn't the bottleneck; residual f017 misses are model-capacity-bound, not retrieval-bound (routes the close to task [I] confirmation)
- ✗ f017 cluster stays ≥3 misses → 1536-dim doesn't add discrimination signal for this specific boundary; needs prompt-level disambiguation
- ✗ Other routings drop ≥2/100 → 1536-dim shifts the retrieval landscape in ways that hurt non-f017 cases; corpus enrichment may need rebalancing under 1536-dim

## Methodology

The comparison is paired-by-fixture (McNemar's test on binary `correct` per trial):

1. Generate two `embeddings.json` files:
   - `fixtures/embeddings-openai-1536.json` — produced by `OPENAI_API_KEY=sk-... node eval/embed-corpus.mjs`
   - `fixtures/embeddings-minilm-384.json` — already exists as `fixtures/embeddings.json` (committed in `a367a5c`)
2. Run ci-nightly twice against the SAME fixture corpus (n=100), swapping `embeddings.json` between runs:
   - Run A: copy `embeddings-minilm-384.json` → `embeddings.json`, run ci-nightly, archive report.
   - Run B: copy `embeddings-openai-1536.json` → `embeddings.json`, run `eval/migrations/eval-dim-override-384.sql` removed (i.e., schema goes to canonical `halfvec(1536)`), run ci-nightly, archive report.
3. Compute paired McNemar statistic on per-fixture `correct` deltas. Significance at α=0.05 with the playbook's Wilson CI.
4. Append the result here as Accepted (lift confirmed) or Rejected (lift not measurable / wrong direction).

## Cost + wall-clock estimate

| Step | Cost | Wall-clock |
|---|---|---|
| Generate OpenAI embeddings for 155 corpus items | <$0.001 | ~30s |
| ci-nightly run A (MiniLM, baseline) | $2-3 | ~30 min |
| ci-nightly run B (OpenAI 1536) | $2-3 | ~30 min |
| **Total marginal** | **~$5-6** | **~1h** |

Within the cost ceiling for a v0.2 methodology study.

## Steps

1. ⏳ User configures `OPENAI_API_KEY` (one-time; this ADR's prerequisite).
2. ⏳ `OPENAI_API_KEY=... node eval/embed-corpus.mjs` → produces 1536-dim `embeddings.json`.
3. ⏳ Skip the `eval/migrations/eval-dim-override-384.sql` step (runner detects `dim != 384` and uses canonical schema).
4. ⏳ Run `bun run eval/runner.ts ci-nightly` → archive report as `eval/reports/ci-nightly-openai-<ts>.json`.
5. ⏳ For paired comparison, also re-run with current MiniLM embeddings → archive as `eval/reports/ci-nightly-minilm-<ts>.json`. (Or use ADR-0006's existing report `ci-nightly-1777613764488.json` as the MiniLM baseline if no source variation occurred between runs.)
6. ⏳ Append result to this ADR; Status: Accepted or Rejected per falsification table above.

## What this ADR doesn't do

- **Doesn't run the eval.** Pre-staged design only. The actual run is one operator action (set `OPENAI_API_KEY`) + one bash command.
- **Doesn't change `manifest.json`.** The comparison is methodology-internal; gate thresholds are unchanged. If 1536-dim raises rate to 0.98+, ADR-0007's v2.0.0 design (which already proposes `action_correctness_rate_min: 0.92`) gets the corroborating evidence to ship as-is.
- **Doesn't claim 1536-dim is "the right" choice** for the bundled artifact. The value is in the comparison data, not in switching defaults. Operators with `OPENAI_API_KEY` already get the 1536-dim path automatically; operators without continue to get the zero-deps 384-dim fallback. ADR-0003's dual-path design stays.

## How v0.3 should use the result

If 1536-dim lift is confirmed (≥0.98):
- `references/pgvector-composition.md` § "Two embedding-provider paths" gets a real benchmark table replacing the current "asymmetry is small" claim with measured numbers.
- ADR-0007's v2.0.0 manifest threshold for `action_correctness_rate_min: 0.92` is corroborated as conservative; consider tightening to 0.95 in a future v3.0.0.

If 1536-dim lift is NOT confirmed (rate stays at 0.96 or drops):
- ADR-0006's residual 3 f017 misses route to model swap (task [I] result, separate ADR) or prompt disambiguation. Embedding dim is ruled out as the lever.
- `references/pgvector-composition.md` benchmark section documents the negative result honestly: "1536-dim does not measurably improve action_correctness over 384-dim on this corpus; choose by deployment friction, not by retrieval quality."

## References

- [`docs/decisions/0003-dual-path-embedding-provider.md`](0003-dual-path-embedding-provider.md) — origin of this comparison; pre-registered "v0.2 should evolve this" item that this ADR is now executing.
- [`docs/decisions/0006-f017-cluster-remediation.md`](0006-f017-cluster-remediation.md) — Accepted with caveats; routes the residual f017 close-out to either this ADR or task [I].
- [`docs/decisions/0007-pre-stage-v2-manifest-design.md`](0007-pre-stage-v2-manifest-design.md) — v2.0.0 thresholds that get corroborated/refuted by this comparison.
- [`eval/embed-corpus.mjs`](../../eval/embed-corpus.mjs) — dual-provider script; OpenAI path is already wired and tested.
- [`fixtures/embeddings.json`](../../fixtures/embeddings.json) — current MiniLM 384 corpus; will be temporarily swapped during the comparison run.
- [`references/pgvector-composition.md`](../../references/pgvector-composition.md) — public-facing doc that gets a benchmark table once this ADR resolves.
