# References — Eval methodology

This page documents *why* the eval harness measures what it measures and *what it deliberately doesn't*. The methodology is lifted from the [`supabase-mcp-evals`](https://github.com/0xquinto/supabase-mcp-evals) repo's playbook; this page summarizes the load-bearing decisions.

## The four metrics

| Metric | What it catches |
|---|---|
| `latency_to_first_event_ms` (p95) | Subscription handshake regressions, Realtime backend latency, Edge Function cold-start blow-up |
| `missed_events_rate` | Bounded-subscription correctness — events that fired but weren't observed within timeout |
| `spurious_trigger_rate` | Over-eagerness in CDC domain — agent took action when no qualifying event fired |
| `agent_action_correctness` | End-to-end value — given a real event, did the agent do the right thing |

The four are deliberately layered. The first three test the *primitive*; the fourth tests the *worked example as a system*. A regression in any of the first three tells you "the substrate is broken." A regression in the fourth tells you "the substrate works but the agent's reasoning got worse."

## Pre-registered thresholds

Thresholds live in `manifest.json`, version-controlled. Per the playbook lesson (slice-3, codified from arXiv:2604.25850 — *decision observability*): every recommendation ships with a falsifiable predicted effect.

Threshold *changes* require a versioned manifest bump explained in the PR body. This is the discipline that makes the eval harness a real gate rather than a vanity number.

## Statistical design

- **Paired comparisons.** Cross-version diffs use the same fixture IDs across runs and McNemar's test on binary outcomes. Not Welch's t-test (which assumes independent samples).
- **ci-fast (n=20)** is too small for a non-paired design. It's only valid here because it's paired *and* we treat it as a *gate*, not a hypothesis test.
- **ci-full (n=100)** + paired = MDE ~0.10 on `agent_action_correctness`. Sufficient to catch a 10-point regression with α=0.05 / β=0.20. Smaller regressions need more N.

## > Why not LLM-judge as a gate?

Tempting: have a smarter LLM judge each routing decision and report a quality score. Rejected for two reasons.

**LLM-judge without ground truth is fragile.** Without a hand-labeled answer key, the judge's score is just *another LLM's opinion*. When it disagrees with the routing model, you can't tell whether the routing improved or the judge got worse. The `agent_action_correctness` metric is computed against `expected_routing` — a hand label, not another model.

**Threshold pass/fail must be deterministic.** A judge LLM has stochastic output. Two runs of the same trial can give different scores. Pass/fail thresholds need stable inputs to be meaningful gates.

LLM-judge enters the harness only as a side-channel `routing_explanation_quality` advisory. Never as a gate.

## > Why not just measure latency?

Tempting because latency is cheap to measure and easy to explain. Rejected because latency alone doesn't catch correctness regressions: an agent that consistently routes everything to "general" hits perfect latency and is worthless.

The four metrics together capture: speed (latency), reliability (missed_events), restraint (spurious_trigger), and value (correctness). Drop any one and a regression class becomes invisible.

## > Why not Likert-scale quality scores?

Per the [supabase-mcp-evals playbook § 8 anti-patterns](https://github.com/0xquinto/supabase-mcp-evals/blob/main/playbook/PLAYBOOK.md): Likert scales (1-5 helpfulness ratings, etc.) are noisy at low N, hard to compare across model versions, and tend to drift. Binary outcomes (correct / not correct) compose with paired tests. Cross-cell comparisons are interpretable.

## See also

- `manifest.json` — the live thresholds
- `eval/metrics.ts` — implementation
- [supabase-mcp-evals/playbook/PLAYBOOK.md](https://github.com/0xquinto/supabase-mcp-evals/blob/main/playbook/PLAYBOOK.md) — the methodology origin
- [supabase-mcp-evals/playbook/research/construct-validity.md](https://github.com/0xquinto/supabase-mcp-evals/blob/main/playbook/research/construct-validity.md) — Bean's 8 construct-validity recommendations
