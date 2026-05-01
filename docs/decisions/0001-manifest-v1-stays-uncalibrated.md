# ADR 0001: manifest v1.0.0 stays uncalibrated; v2.0.0 recalibrates with the gate-failure data

**Date:** 2026-04-30
**Status:** Accepted
**Decider:** Diego Gomez
**Context:** First v0.1.0 ci-full run completed; pre-registered manifest gate FAILED.

## Context

`manifest.json` v1.0.0 was registered before the v0.1.0 ci-full run with these thresholds:

| Threshold | Value | Reasoning at registration time |
|---|---|---|
| `latency_p95_ms_max` | 2000 | 4.6× headroom over Phase 1 spike result (438ms) |
| `missed_events_rate_max` | 0.01 | Substrate ought to be near-zero |
| `missed_events_ci_high_max` | 0.01 | Wilson upper CI must agree with point estimate |
| `spurious_trigger_rate_max` | 0.02 | Same shape as missed events, slightly looser |
| `spurious_trigger_ci_high_max` | 0.03 | Same shape |
| `action_correctness_rate_min` | 0.90 | Industry-typical triage agent baseline |
| `action_correctness_ci_low_min` | 0.85 | 5pp slack below the point-estimate floor |

The first ci-full run (n=100, single transient branch, ~30 min wallclock) produced:

| Metric | Result | Threshold check |
|---|---|---|
| latency p95 | 1520ms | PASS (24% headroom) |
| missed_events rate | 0/100 = 0.0 | PASS |
| missed_events CI high | **0.0370** | **FAIL** (vs 0.01) |
| spurious_trigger rate | 0/100 = 0.0 | PASS |
| spurious_trigger CI high | **0.0370** | **FAIL** (vs 0.03) |
| action_correctness rate | **0.87** | **FAIL** (vs 0.90) |
| action_correctness CI low | **0.79** | **FAIL** (vs 0.85) |

Gate failed on four cells across two distinct root causes.

## Two root causes

### Root cause A: Wilson upper-CI thresholds were unreachable at n=100

At n=100 with 0 successes, the 95% Wilson upper bound is mathematically **0.0370** — independent of which API/runtime/agent is being tested. Closed-form lower bound:

```
upper_bound = (z² + 2·n·p̂ + z·√(z² + 4·n·p̂·(1-p̂))) / (2·(n + z²))
            = 3.84 / (2·103.84)
            ≈ 0.0185 + cushion ≈ 0.0370 at p̂=0
```

To bring `missed_events_ci_high_max` under 0.01, n must be ≥ ~370. To bring `spurious_trigger_ci_high_max` under 0.03, n must be ≥ ~125. The pre-registered values were aspirational — they reflect what we'd want at scale, not what's reachable at n=100.

This is a **methodology miss**, not a substrate finding. The point estimates (rate = 0/100 for both) say the substrate is clean. The CI half of the gate was uncalibrated against the fixture-tier sizing.

### Root cause B: action_correctness 87% is a real composition gap

13/100 fixtures misrouted. All 13 errors concentrate in 3 of 5 `general` seeds (f016 docs lookup, f017 feature request, f019 SSO question), and the agent systematically routes those to `engineering` or `urgent` across every variation:

| Routing | Correct | Total |
|---|---|---|
| urgent | 25 | 25 |
| engineering | 25 | 25 |
| billing | 25 | 25 |
| **general** | **12** | **25** |

The agent's calls are defensible — "general" seed labels overlap with "engineering" for technically-flavored questions. This is a **label-boundary issue** in the seed fixtures (and possibly the triage prompt), not random model noise. v0.2 will either tighten seed-label criteria (drop the technical-flavored `general` fixtures or relabel them) or add an explicit fallback rule in the triage prompt ("default to general for non-incident, non-billing, non-blocking-engineering questions").

## Decision

**1. Manifest v1.0.0 is NOT amended retroactively.**

Pre-registration discipline is the load-bearing piece of the eval methodology (see `playbook/PLAYBOOK.md` § 9). Lowering thresholds after seeing the data — even when the change is mechanically defensible — destroys the disclosure value. The v1.0.0 manifest stays as registered. The gate stays in FAIL state for the v0.1.0 release.

**2. v2.0.0 manifest will recalibrate via versioned bump, with rationale in the PR body.**

Two amendments planned:

- **Bump `ci-full.n` from 100 → 300.** This makes `missed_events_ci_high_max: 0.01` mechanically reachable (Wilson upper bound at n=300, p̂=0 is ~0.012, just above; n=400 yields ~0.0093). Also tightens `spurious_trigger` upper bound to ~0.012.
- **Either keep CI bounds as-is** (relying on the n bump) **or relax them** (`missed_events_ci_high_max: 0.04`, `spurious_trigger_ci_high_max: 0.04`) **with explicit rationale.** Relaxing without rationale is anti-pattern; the rationale here is "100 trials is the right cost ceiling for a daily nightly run; CI tightness is a function of n, not substrate quality."

The choice between the two depends on whether ci-full cost (~$2-3 at n=100, scaling roughly linearly) is acceptable at $6-9 per run. v0.2 design pass decides.

**3. action_correctness FAIL is a composition fix, not a manifest amendment.**

The 0.90 / 0.85 thresholds stay. v0.2 work item is fixing the `general` label boundary in the seed fixtures (or the triage prompt) until the gate passes. If after seed-relabel work the realistic ceiling for the worked example is 0.85 instead of 0.90, that's a separate v2.0.0 manifest amendment with its own rationale.

## Consequences

- **v0.1.0 ships with a documented gate FAIL.** The writeup (`docs/writeup.md` § 4) is honest about this. Portfolio-wise, "the methodology bit me as designed" is a stronger signal than a clean pass would have been.
- **The 4-metric `manifest.json` becomes a working artifact, not just a static design document.** v2.0.0 demonstrates the calibration loop: pre-register → run → measure phenomenon-vs-proxy gap → bump version with rationale.
- **The label-boundary issue is a v0.2 unblock for hitting 0.90 + 0.85.** If post-fix the gate still fails, the manifest amendment story has to be made explicit rather than implicit.

## Alternatives considered

**Silently lower `missed_events_ci_high_max` to 0.04 and `spurious_trigger_ci_high_max` to 0.04 in v1.0.0.** Rejected: defeats pre-registration. Even if mechanically defensible, the change would not be disclosed in a way that survives churn.

**Ship v0.1.0 only after re-running ci-full at n=300.** Rejected: cost (~$6-9) and wallclock (~90 min) for a run whose substrate-finding outcome is already known from the n=100 result. Better to spend the budget on v0.2's seed-fix verification.

**Drop CI-half thresholds entirely and gate only on point estimates.** Rejected: Wilson CIs are the discipline that distinguishes "0/100 might mean substrate clean OR small sample" from "100/300 is statistically clean." Removing CI gating removes the methodology's teeth.

## References

- `manifest.json` v1.0.0 — the pre-registered file
- `eval/reports/ci-full-1777590748222.json` — the run that produced this finding
- `eval/metrics.ts` — Wilson CI implementation (verified against scipy.stats.binomtest in spec)
- `playbook/PLAYBOOK.md` § 9 — statistical design choices (paired McNemar, Wilson CIs, why CI gating matters)
- `references/eval-methodology.md` — Bean's construct-validity checklist (phenomenon-proxy gap)
- `docs/writeup.md` § 4 — the public framing
