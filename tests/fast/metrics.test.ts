import { describe, expect, it } from "vitest";
import { type TriageOutcome, checkThresholds, computeMetrics, pct } from "../../eval/metrics.ts";

const out = (
  observed: boolean,
  latency_ms: number | null,
  agent_action_taken: boolean,
  correct: boolean,
): TriageOutcome => ({
  fixture_id: "x",
  observed,
  latency_ms,
  agent_action_taken,
  routing_chosen: null,
  expected_routing: "urgent",
  correct,
});

describe("pct", () => {
  it("returns a sane p95", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(pct(arr, 95)).toBe(95);
  });
});

describe("computeMetrics", () => {
  it("computes all 4 metrics with Wilson CIs", () => {
    const outcomes = [
      out(true, 1500, true, true),
      out(true, 1800, true, true),
      out(true, 1900, true, false),
      out(false, null, false, false), // missed
      out(true, 1700, true, true), // spurious would be agent_action_taken without observed=true
    ];
    const m = computeMetrics(outcomes);
    expect(m.latency_p95_ms).toBeGreaterThan(0);
    expect(m.missed_events.rate).toBeCloseTo(0.2, 2);
    expect(m.missed_events.ci_low).toBeGreaterThan(0);
    expect(m.missed_events.ci_high).toBeLessThan(1);
    expect(m.spurious_trigger.rate).toBe(0); // observed=false + action=false in our fixture
    expect(m.action_correctness.rate).toBeCloseTo(3 / 4, 2); // 3 correct / 4 with action
  });
});

describe("checkThresholds", () => {
  it("returns pass:false when any threshold fails", () => {
    const failingMetrics = {
      latency_p95_ms: 3000, // > 2000 threshold
      latency_p50_ms: 1500,
      missed_events: { rate: 0, ci_low: 0, ci_high: 0, successes: 0, trials: 100 },
      spurious_trigger: { rate: 0, ci_low: 0, ci_high: 0, successes: 0, trials: 100 },
      action_correctness: { rate: 0.95, ci_low: 0.9, ci_high: 0.99, successes: 95, trials: 100 },
    };
    const result = checkThresholds(failingMetrics);
    expect(result.pass).toBe(false);
    expect(result.failures).toContain("latency_p95_ms");
  });
});
