# ADR 0009: multi-model probe — Sonnet 4.6 closes residual f017 misses + side-effect drift

**Date:** 2026-05-01
**Status:** Accepted (result-driven; recommends Sonnet 4.6 as the canonical eval model going forward)
**Decider:** Diego Gomez
**Context:** ADR-0006 was Accepted with caveats — corpus enrichment (r033/r034/r035) closed 2 of 5 f017 cluster misses but left 3 residual. ADR-0006's "What v0.2 should do" routed the residual close-out to one of: model swap (this ADR), more corpus entries, or prompt disambiguation. ADR-0006 also flagged a 1/100 side-effect drift (f010 PG-perf-regression → `urgent` instead of `engineering`).

This ADR captures the multi-model probe result: same fixture corpus + same enriched resolved-corpus (post-ADR-0006), only the routing model changed from `claude-haiku-4-5` to `claude-sonnet-4-6` via the new `EVAL_TRIAGE_MODEL` env override (committed in `dbaff31`).

## Headline result

| Metric | Haiku 4.5 (post-ADR-0006, run `1777613764488`) | Sonnet 4.6 (this run, `1777614264922`) | Δ |
|---|---|---|---|
| `agent_action_correctness` rate | 96/100 (0.96) | **99/100 (0.99)** | **+3 pp** |
| Wilson CI low | 0.902 | **0.946** | **+4.4 pp** |
| Wilson CI high | 0.984 | 0.998 | tighter |
| `latency_p95_ms` | 1300 | **1281** | -19ms (parity) |
| `latency_p50_ms` | 1046 | 970 | -76ms |
| `missed_events` rate | 0/100 | 0/100 | unchanged |
| `spurious_trigger` rate | 0/100 | 0/100 | unchanged |

**Per-routing breakdown:**

| Routing | Haiku 4.5 | Sonnet 4.6 | Δ |
|---|---|---|---|
| urgent | 25/25 | 25/25 | held |
| engineering | 24/25 | **25/25** | **+1** (f010 drift fixed) |
| billing | 25/25 | 25/25 | held |
| general | 22/25 | **24/25** | **+2** (closed 2 of 3 residual f017 misses) |

**Errors (1 total under Sonnet):**

- `f017-gen-feature-vector-filter-v3` → `engineering` (expected `general`). The single remaining f017-cluster miss. v3 is the most aggressively engineering-flavored variation in the synthesizer's pgvector-feature-request family.

## Two distinct findings

### 1. Sonnet closes 2 of 3 residual f017 misses

ADR-0006's enriched corpus + Sonnet's stronger semantic discrimination together close 4 of 5 f017 cluster misses (was 5/5 misrouted in v0.1.x baseline, now 1/5 after both interventions). Sonnet alone (without corpus enrichment) was not measured in this probe, so the **interaction effect** is unconfirmed — but the directional reading is unambiguous: model capacity matters here, and Haiku 4.5 is at its discrimination ceiling for the trickiest f017 variations.

### 2. Sonnet fixes the f010 PG-perf-regression drift

Haiku post-ADR-0006 sent f010 to `urgent` (8x query slowdown could be read as urgent if you stretch). Sonnet correctly routes it to `engineering`. This is **not** a corpus effect (no engineering examples were added between runs) — it's pure model capacity: Sonnet better recognizes "8x slowdown after upgrade" as a diagnostic engineering question rather than an active outage.

The combined effect is that the side-effect drift ADR-0006 named as "1/100 allowed" is now zero, AND the primary intervention's residual f017 misses drop from 3 to 1.

## Decision

1. **Sonnet 4.6 is the canonical eval model going forward** (i.e., ADR-0007's pre-staged v2.0.0 manifest assumes Sonnet 4.6 unless overridden). Haiku 4.5 stays usable for cost-bounded reproductions but the headline metrics in `docs/writeup.md` and `manifest.json` v2.0.0 reflect the Sonnet substrate.
2. **`EVAL_TRIAGE_MODEL` env override stays** so reproducibility costs are operator-controllable. CI runs in `.github/workflows/ci-fast.yml` continue to default to whatever the runner picks (currently haiku via the env-default).
3. **f017-v3 remaining miss** routes to v0.3 work as a known and disclosed limitation. With Sonnet at 99/100 and CI low 0.946, the artifact's substrate has hit its current ceiling on this corpus. Closing v3 specifically would need either: (a) ADR-0008's OpenAI 1536 embedding lift if and when run, OR (b) prompt-level disambiguation (cheaper, more brittle), OR (c) acceptance that f017-v3 IS borderline-`engineering` and a future ground-truth review may relabel it (precedent: ADR-0002).

## ADR-0007 calibration check

ADR-0007 pre-staged v2.0.0 manifest with conditional thresholds:

> *"`action_correctness_rate_min`: 0.90 → 0.92. Tightened. ADR-0006 (if accepted) brings v0.1.x to ~0.97; v2.0.0 ships with 0.92 as the new floor. If ADR-0006 is rejected, this stays at 0.90 in v2.0.0."*

ADR-0006 brought v0.1.x to 0.96 (not the projected ~0.97). Sonnet brings it to 0.99. **The 0.92 threshold in ADR-0007 is even more conservative than Sonnet's actual rate.** Optionally tighten the v2.0.0 threshold to 0.95 (still below Sonnet's CI low of 0.946); leaving at 0.92 keeps room for synthesizer variance at n=300. v2.0.0 PR body should resolve this when ADR-0007 ships.

Equivalent for `action_correctness_ci_low_min`: ADR-0007 proposed 0.88, Sonnet hits 0.946, even more headroom. Tightening to 0.92 in v2.0.0 stays below the Sonnet floor.

## What this ADR validates about the substrate

The same fixture corpus + same eval harness + same retrieval substrate gave:

- 87/100 with Haiku 4.5, original triage prompt, recency-proxy "retrieval"
- 90/100 with Haiku 4.5, after wiring real pgvector retrieval
- 94/100 with Haiku 4.5, after the f019 ground-truth relabel (ADR-0002)
- 96/100 with Haiku 4.5, after the f017 corpus enrichment (ADR-0006)
- **99/100 with Sonnet 4.6**, this ADR

Each step is a **discrete, attributable, methodology-honest improvement**. Each step has its own ADR, its own pre-registered prediction (where applicable), its own honest pass/fail. The substrate isn't being tuned by waving hands — every gain has a paper trail.

This is what eval-first discipline produces: a calibration sequence where each move's effect is measurable and isolable.

## What this ADR doesn't do

- **Doesn't claim Sonnet 4.6 is universally "the right" model.** It's the right model *for this corpus on this routing task*. Smaller-model deployments have their own tradeoffs (cost per call ~3-4× higher with Sonnet). The dual-config preserves both options.
- **Doesn't run the interaction probe** (Sonnet 4.6 + un-enriched resolved-corpus). That would isolate "how much of the lift is model vs corpus." Out of scope for v0.1.x; documented as v0.3 question if anyone asks.
- **Doesn't change the writeup's headline narrative.** Sonnet's 99/100 lifts the table but not the story — the story is the discipline of pre-registration → measure → honest report → ADR. Sonnet's lift is a single data point in that discipline, not the discipline itself.

## Updated metrics for downstream artifacts

- `docs/writeup.md` § 4 should add a row to the comparison table: "post-multi-model-probe (Sonnet 4.6): 99/100, CI low 0.946, p95 1281ms."
- `README.md` Eval results table should update to Sonnet's 99/100 / 0.946 / 1281ms (and note "with Sonnet 4.6; Haiku 4.5 results in ADR-0009").
- ADR-0007's threshold cells should be flipped from "conditional on ADR-0006" to "validated by ADR-0009; floors hold with Sonnet 4.6 + corpus enrichment."

## References

- [`docs/decisions/0006-f017-cluster-remediation.md`](0006-f017-cluster-remediation.md) — corpus enrichment that gave us the 96/100 baseline
- [`docs/decisions/0007-pre-stage-v2-manifest-design.md`](0007-pre-stage-v2-manifest-design.md) — v2.0.0 thresholds that this ADR's result validates as conservative
- [`docs/decisions/0008-comparative-embedding-eval-design.md`](0008-comparative-embedding-eval-design.md) — pre-staged eval that could close the residual f017-v3 miss if 1536-dim embeddings help
- [`eval/triage-agent.ts`](../../eval/triage-agent.ts) — `EVAL_TRIAGE_MODEL` env override added in `dbaff31`
- [`eval/reports/ci-full-1777614264922.json`](../../eval/reports/) — Sonnet result (file lives in local working tree; `eval/reports/` is gitignored)
- [`eval/reports/ci-full-1777613764488.json`](../../eval/reports/) — Haiku post-ADR-0006 baseline (same gitignore caveat)
