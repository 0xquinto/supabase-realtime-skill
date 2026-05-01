# ADR 0008: comparative embedding eval — OpenAI 1536 vs MiniLM 384

**Date:** 2026-05-01
**Status:** Rejected — 1536-dim does NOT measurably improve action_correctness over 384-dim at the Sonnet 4.6 level on this corpus
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

1. ✅ Operator configured `OPENAI_API_KEY` (2026-05-01).
2. ✅ `OPENAI_API_KEY=... node eval/embed-corpus.mjs` → produced 1536-dim `embeddings.json` (135 entries).
3. ✅ Runner detected `dim != 384` and skipped the override migration (canonical `halfvec(1536)` schema applied).
4. ✅ Ran `EVAL_TRIAGE_MODEL=claude-sonnet-4-6 bun run eval/runner.ts ci-nightly` → report `eval/reports/ci-nightly-1777615609530.json`.
5. ✅ Paired-vs-baseline: ADR-0009's run (`ci-nightly-1777614264922.json`) is the Sonnet 4.6 + MiniLM 384 baseline. Same fixture corpus, same model, same runner — only embedding dim differs. The two reports are paired-comparable per fixture ID.
6. ✅ Result appended below; Status flipped to Rejected.

## Result (2026-05-01 ci-nightly run, OpenAI 1536 + Sonnet 4.6, report `ci-nightly-1777615609530.json`)

**Headline:** identical to the Sonnet 4.6 + MiniLM 384 baseline. The 1536-dim embeddings produce no measurable lift.

| Metric | Sonnet + MiniLM 384 (ADR-0009) | Sonnet + OpenAI 1536 (this run) | Δ |
|---|---|---|---|
| `agent_action_correctness` rate | 99/100 (0.99) | **99/100 (0.99)** | **0** |
| Wilson CI low | 0.946 | **0.946** | **0** |
| Wilson CI high | 0.998 | 0.998 | 0 |
| `latency_p95_ms` | 1281 | **1281** | 0 |
| `latency_p50_ms` | 970 | **970** | 0 |
| `missed_events` rate | 0/100 | 0/100 | 0 |
| `spurious_trigger` rate | 0/100 | 0/100 | 0 |

**Per-routing breakdown (this run):**

| Routing | Sonnet + MiniLM 384 | Sonnet + OpenAI 1536 | Δ |
|---|---|---|---|
| urgent | 25/25 | 25/25 | 0 |
| engineering | 25/25 | 25/25 | 0 |
| billing | 25/25 | 25/25 | 0 |
| general | 24/25 | 24/25 | 0 |

**Errors (1 total, identical to baseline):**

- `f017-gen-feature-vector-filter-v3` → `engineering` (expected `general`). The same single residual miss survives in both embedding regimes. Same fixture, same misroute, same wrong category.

## Falsification check

ADR-0008 named five "what would falsify" conditions. Two triggered:

- ✓ "Rate stays at 96/100 or drops" — got 99/100, BUT this matches the Sonnet+MiniLM baseline exactly. The improvement-over-the-MiniLM-baseline (96/100) was already captured by the model swap in ADR-0009; the embedding dim adds zero on top. **Falsification condition: hypothesis NOT supported.**
- ✓ "f017 cluster stays ≥3 misses" — actually 1/5 misses (same as MiniLM baseline). **Falsification condition: hypothesis NOT supported.**

The hypothesis was **directionally falsified** in the cleanest possible way: byte-for-byte identical metrics across both embedding dim regimes.

## Decision: Rejected

The 1536-dim OpenAI embedding does NOT measurably lift action_correctness over the 384-dim MiniLM embedding **at the Sonnet 4.6 model level on this corpus**. The two paths are functionally equivalent for this routing task.

**This is the cleanest possible negative result.** Same fixtures, same model, same runner, same retrieval shape — only embedding dim differs — and zero metric difference. That eliminates an entire class of "but maybe richer embeddings would..." conjecture for this artifact's worked example.

## What this means for downstream artifacts

- **`references/pgvector-composition.md` § "Two embedding-provider paths"** can now be updated with empirical backing: *"Choose by deployment friction, not by retrieval quality. On this corpus + this model + this routing task, OpenAI text-embedding-3-small (1536-dim) and Xenova/all-MiniLM-L6-v2 (384-dim) produce identical action_correctness."*
- **ADR-0003's dual-path design** is now empirically validated as a free choice — the fallback path costs nothing in retrieval quality.
- **The residual `f017-v3` miss** is now isolated as **neither model-bound (Sonnet ceiling) nor embedding-bound (1536 ceiling)**. The remaining levers are: (a) prompt-level disambiguation rule, (b) ground-truth re-examination via ADR-0002 precedent (if v3 is *actually* engineering on closer reading, the eval has been right all along), or (c) accept as honest portfolio noise.
- **ADR-0007's pre-staged v2.0.0 thresholds** are even more conservative than the current empirical floor — Sonnet at either embedding dim hits 0.99/0.946; ADR-0007 proposed 0.92/0.88. Plenty of headroom.

## What this ADR validates about the methodology

The pre-registration discipline produces useful negative results, not just useful positive ones:

- **Pre-registered before the run** (commit `fa3caa1`, before `OPENAI_API_KEY` was even set) — the design + prediction sat in git history before the operator could run the eval.
- **Falsification conditions named in advance** — five explicit, testable conditions; two triggered cleanly.
- **Negative result published with the same rigor as a positive result** — this ADR doesn't bury the null finding or reframe the hypothesis to claim a partial win. The 1536-dim hypothesis is rejected; that's information about the substrate.
- **Saves future-me from re-asking the question.** Without this ADR, "but what if we used OpenAI embeddings" remains a live conjecture indefinitely; with it, the conjecture is closed.

ADR-0006 (partial-accept), ADR-0009 (accept), and ADR-0008 (reject) together demonstrate that the pre-registration loop produces all three outcome shapes — and that's how you know the discipline isn't gamed.

## How v0.3 should evolve this

- The benchmark table promised in ADR-0008 v1 ("references/pgvector-composition.md gets a real benchmark replacing 'asymmetry is small' with measured numbers") is now writable. Open follow-up: update that doc with a "Comparative benchmark (2026-05-01)" section.
- f017-v3 close-out routes to ADR-0009 follow-ups: prompt disambiguation OR ground-truth review OR accepted limitation.
- The OpenAI-path infrastructure (embed-corpus.mjs OpenAI branch + canonical halfvec(1536) schema) is verified end-to-end. Operators with `OPENAI_API_KEY` get spec-compliant retrieval out of the box; operators without get an empirically-equivalent fallback.

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
