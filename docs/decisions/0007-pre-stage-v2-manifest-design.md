# ADR 0007: pre-stage `manifest.json` v2.0.0 — n=300 with tightened CI gates

**Date:** 2026-05-01
**Status:** Proposed (design locked; ships when the n=300 fixture corpus lands)
**Decider:** Diego Gomez
**Amendments:** [ADR-0010](0010-bounded-queue-drain.md) proposes adding `forward_correctness_rate_min` + `forward_correctness_ci_low_min` cells to this manifest (also Proposed — would land atomically with the v0.2.0 npm release).
**Note on versioning:** "v2.0.0" throughout this ADR refers to **`manifest.json` v2.0.0** (the eval-thresholds file), not npm package v2.0.0. The two streams are independently versioned — see [ADR-0001](0001-manifest-v1-stays-uncalibrated.md) for why. Current state: `manifest.json` v1.0.0 ships with npm v0.1.1.
**Context:** ADR-0001 deferred Wilson CI calibration to a `manifest.json` v2.0.0 with rationale: at n=100, the CI upper bounds for `missed_events` and `spurious_trigger` (0.01 and 0.03 respectively) are mathematically unreachable even with a perfectly clean substrate (rate = 0/100 yields Wilson upper ≈ 0.0370 at 95% confidence). The two CI cells stay in FAIL state in v0.1.x by deliberate design — pre-registration discipline holds.

This ADR locks the `manifest.json` v2.0.0 design without yet committing the file (the n=300 fixture corpus and its synthesizer pass need to land first; ADR-0001 estimated cost at $6-9 per nightly run for n=300, plus initial corpus synthesis cost).

## The math against which v2.0.0 is calibrated

Wilson 95% upper bound at p̂ = 0:

| n | Wilson upper at p̂=0 |
|---|---|
| 100 | 0.0370 |
| 200 | 0.0188 |
| **300** | **0.0125** |
| 400 | 0.0094 |
| 500 | 0.0075 |
| 1000 | 0.0038 |

Wilson lower bound at p̂ = 0.94 (representative `action_correctness` rate):

| n | Wilson lower at p̂=0.94 |
|---|---|
| 100 | 0.875 |
| 200 | 0.895 |
| **300** | **0.905** |
| 400 | 0.911 |

n=300 is the smallest tier that **simultaneously**:
1. Brings `missed_events_ci_high` into a reachable range for substrate-clean runs (≤ 0.013 vs current 0.01 target)
2. Brings `action_correctness_ci_low` to ~0.905 at the empirical rate (currently 0.875 at n=100)
3. Stays under a $10 / 90-min cost ceiling per nightly run (linear scaling from current $2-3 / 30 min)

## Decision: v2.0.0 thresholds and rationale per cell

Pre-staged file (not yet committed as `manifest.json` — will replace v1.0.0 at the v0.2 release):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "version": "2.0.0",
  "registered_at": "<TBD: date the n=300 ci-nightly corpus + first run land>",
  "comment": "Pre-registered eval thresholds. Changes require versioned bump explained in PR body. v2.0.0 amendments documented in docs/decisions/0007-pre-stage-v2-manifest-design.md.",
  "thresholds": {
    "latency_p95_ms_max": 2000,
    "missed_events_rate_max": 0.005,
    "missed_events_ci_high_max": 0.015,
    "spurious_trigger_rate_max": 0.005,
    "spurious_trigger_ci_high_max": 0.015,
    "action_correctness_rate_min": 0.92,
    "action_correctness_ci_low_min": 0.88
  },
  "fixture_tiers": {
    "ci-fast": { "n": 20, "trigger": "every PR" },
    "ci-nightly": { "n": 300, "trigger": "daily on main" }
  },
  "statistical_design": {
    "comparison": "paired (same fixture IDs, McNemar's test on binary metrics)",
    "ci_method": "Wilson",
    "ci_confidence": 0.95,
    "rationale": "playbook/PLAYBOOK.md § 9; CI bounds calibrated against n=300 in docs/decisions/0007-pre-stage-v2-manifest-design.md"
  }
}
```

### Per-cell rationale

| Cell | v1 → v2 | Rationale |
|---|---|---|
| `latency_p95_ms_max` | 2000 → 2000 | No change. Phase 1 spike was 438ms; v0.1.x runs ~1500-1750ms (with eval overhead). 2000ms cap is still ~15% headroom; tighter would penalize transient branch warmup variance, which isn't a substrate finding. |
| `missed_events_rate_max` | 0.01 → 0.005 | Tightened. Substrate at n=300 should be measurably cleaner than substrate at n=100; if rate exceeds 0.005 (≥2 misses out of 300), that's a real signal worth gating on. |
| `missed_events_ci_high_max` | 0.01 → 0.015 | Loosened. Mechanical: Wilson upper at n=300, p̂=0 is 0.0125, so 0.015 gives ~20% cushion. Tightening to 0.013 would trigger FAIL on any single missed event in 300 trials, which over-penalizes ordinary Realtime jitter. **Rationale named explicitly:** the gate measures "substrate is clean to within 2σ at sustained n=300," not "zero events ever missed in any single run." |
| `spurious_trigger_rate_max` | 0.02 → 0.005 | Tightened. Same shape as `missed_events_rate_max`. The current 0.02 was set with v1's loose CI gates; under v2 we hold rate AND CI to the same 0.005/0.015 standard. |
| `spurious_trigger_ci_high_max` | 0.03 → 0.015 | Tightened. Same Wilson-upper math as missed_events. |
| `action_correctness_rate_min` | 0.90 → 0.92 | Tightened. ADR-0006 (if accepted) brings v0.1.x to ~0.97; v2.0.0 ships with 0.92 as the new floor. If ADR-0006 is rejected, this stays at 0.90 in v2.0.0. **This cell is conditional on ADR-0006 outcome.** |
| `action_correctness_ci_low_min` | 0.85 → 0.88 | Tightened. Wilson lower at n=300, p̂=0.94 is ~0.905; at p̂=0.92 is ~0.883. Setting floor to 0.88 keeps a small cushion. If ADR-0006 is rejected, this stays at 0.85 in v2.0.0. |

### What this ADR commits to

1. **n=300 is the v2.0.0 ci-nightly tier.** Cost-bounded at <$10 / <90 min per run.
2. **CI gates are kept tight, not loosened.** The discipline is calibration-by-bumping-n, not gate-relaxation. v1.0.0's stay-in-FAIL signal is preserved as the precedent.
3. **`action_correctness` thresholds are conditional on ADR-0006.** Two-track design avoids the anti-pattern of raising the floor *because* a single intervention happened to land — the floor only goes up if the intervention's effect is durable across the larger n=300 corpus.
4. **`latency_p95_ms_max` doesn't change.** Substrate latency is independent of fixture corpus size; the v1.0.0 cap is well-calibrated.

### What this ADR doesn't do

- **Doesn't ship the file.** `manifest.json` stays at v1.0.0 until the n=300 corpus + first ci-nightly run land. The pre-staged JSON above is the design intent; the actual file will be committed atomically with the n=300 corpus to preserve pre-registration semantics (the runner consumes whatever `manifest.json` says at run time).
- **Doesn't auto-trigger the n=300 corpus synthesis.** That's a follow-up work item with its own cost ceiling. Synthesizer would generate 80×3 = 240 LLM-augmented variations from the existing 20 ci-fast seeds (matching the v0.1.x synthesis pattern at commit `d705b17` but at 3× scale).
- **Doesn't promise CI bounds will be met first try.** v1.0.0 honestly shipped with a FAIL; v2.0.0 might too if the substrate has a real rare-event miss at n=300 that didn't surface at n=100. That's the discipline working.

## Migration path (v1.0.0 → v2.0.0)

Steps to ship v2.0.0:

1. Run synthesizer at n=300 (240 new variations + 60 existing) — cost ~$0.80 in LLM calls + ~10 min wallclock.
2. Spot-check 30 of the 240 new fixtures (10% sample, manual inspection for label clarity per ADR-0005's Mousavi extension).
3. Embed the new fixtures via `node eval/embed-corpus.mjs` (or via OpenAI 1536 if `OPENAI_API_KEY` set per ADR-0003).
4. Run ci-nightly once at n=300 against the v1.0.0 manifest (still in FAIL state) to establish empirical baseline.
5. Commit `manifest.json` v2.0.0 atomically with the n=300 fixture corpus + this ADR's status flipped to Accepted with the actual run results in the addendum.
6. Re-run ci-nightly against v2.0.0 manifest. The gate either passes (substrate is clean enough that the new tightened bounds are met) or stays in FAIL with documented rationale (just like v1.0.0). Either is honest.

## Consequences

- **The artifact has a written, versioned, pre-staged calibration loop.** v1.0.0 → v2.0.0 isn't a hand-wave; it's a specific design with per-cell rationale, ready to ship when the corpus is ready.
- **The "manifest gate stays in FAIL" story has a clean v2 close.** Once n=300 lands, the FAIL state in v1 is contextualized as the pre-registration discipline working as intended, not as ducked methodology.
- **Future calibration is templated.** v2.0.0 → v3.0.0 (if ever) would follow the same pattern: pre-stage in an ADR, lock per-cell rationale, ship atomically with the corpus change.

## References

- [`docs/decisions/0001-manifest-v1-stays-uncalibrated.md`](0001-manifest-v1-stays-uncalibrated.md) — the v1 FAIL that this ADR's v2 design closes
- [`docs/decisions/0006-f017-cluster-remediation.md`](0006-f017-cluster-remediation.md) — `action_correctness` thresholds in v2 are conditional on this outcome
- [`manifest.json`](../../manifest.json) — v1.0.0; v2.0.0 will replace this when the n=300 corpus lands
- [`playbook/PLAYBOOK.md`](../../playbook/PLAYBOOK.md) § 9 — statistical-design discipline (paired McNemar, Wilson CIs, gate-discipline-via-versioned-bump)
- [`references/eval-methodology.md`](../../references/eval-methodology.md) — public framing of the 4-metric design
