// eval/metrics.ts
//
// Pure metric computations. wilsonInterval reused from vendor/foundation.

import { aggregateRate } from "../vendor/foundation/scoring.ts";

export interface TriageOutcome {
  fixture_id: string;
  observed: boolean;
  latency_ms: number | null;
  agent_action_taken: boolean;
  routing_chosen: string | null;
  expected_routing: string;
  correct: boolean;
}

export interface RateMetric {
  successes: number;
  trials: number;
  rate: number;
  ci_low: number;
  ci_high: number;
}

export interface AggregatedMetrics {
  latency_p95_ms: number;
  latency_p50_ms: number;
  missed_events: RateMetric;
  spurious_trigger: RateMetric;
  action_correctness: RateMetric;
}

export function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest-rank: ceil(p/100 * n), converted to 0-indexed and clamped.
  const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  const idx = Math.min(sorted.length - 1, rank);
  return sorted[idx] ?? 0;
}

export function computeMetrics(outcomes: TriageOutcome[]): AggregatedMetrics {
  const observed = outcomes.filter((o) => o.observed);
  const latencies = observed.map((o) => o.latency_ms).filter((ms): ms is number => ms != null);

  const missed = outcomes.map((o) => !o.observed);
  const missedAgg = aggregateRate(missed, 0.95);

  // spurious = action_taken without an observed event
  const spurious = outcomes.map((o) => o.agent_action_taken && !o.observed);
  const spuriousAgg = aggregateRate(spurious, 0.95);

  // correctness denominator: only trials where the agent took action
  const acted = outcomes.filter((o) => o.agent_action_taken);
  const correct = acted.map((o) => o.correct);
  const correctAgg = aggregateRate(correct, 0.95);

  return {
    latency_p95_ms: pct(latencies, 95),
    latency_p50_ms: pct(latencies, 50),
    missed_events: missedAgg,
    spurious_trigger: spuriousAgg,
    action_correctness: correctAgg,
  };
}

export interface ThresholdConfig {
  latency_p95_ms_max: number;
  missed_events_rate_max: number;
  missed_events_ci_high_max: number;
  spurious_trigger_rate_max: number;
  spurious_trigger_ci_high_max: number;
  action_correctness_rate_min: number;
  action_correctness_ci_low_min: number;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  latency_p95_ms_max: 2000,
  missed_events_rate_max: 0.01,
  missed_events_ci_high_max: 0.01,
  spurious_trigger_rate_max: 0.02,
  spurious_trigger_ci_high_max: 0.03,
  action_correctness_rate_min: 0.9,
  action_correctness_ci_low_min: 0.85,
};

export function checkThresholds(
  m: AggregatedMetrics,
  cfg: ThresholdConfig = DEFAULT_THRESHOLDS,
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (m.latency_p95_ms > cfg.latency_p95_ms_max) failures.push("latency_p95_ms");
  if (m.missed_events.rate > cfg.missed_events_rate_max) failures.push("missed_events.rate");
  if (m.missed_events.ci_high > cfg.missed_events_ci_high_max)
    failures.push("missed_events.ci_high");
  if (m.spurious_trigger.rate > cfg.spurious_trigger_rate_max)
    failures.push("spurious_trigger.rate");
  if (m.spurious_trigger.ci_high > cfg.spurious_trigger_ci_high_max)
    failures.push("spurious_trigger.ci_high");
  if (m.action_correctness.rate < cfg.action_correctness_rate_min)
    failures.push("action_correctness.rate");
  if (m.action_correctness.ci_low < cfg.action_correctness_ci_low_min)
    failures.push("action_correctness.ci_low");
  return { pass: failures.length === 0, failures };
}
