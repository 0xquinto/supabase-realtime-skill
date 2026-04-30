// src/foundation/scoring.ts
//
// Wilson score interval + per-cell aggregation. Pure functions; trivial
// to test. Wilson is preferred over normal-approximation because it
// gives sane bounds at extremes (0/N and N/N), which slice-3's null
// cells need.

const Z_FOR_CONFIDENCE: Record<number, number> = {
  0.9: 1.6449,
  0.95: 1.96,
  0.99: 2.5758,
};

export interface RateResult {
  successes: number;
  trials: number;
  rate: number;
  ci_low: number;
  ci_high: number;
}

export function wilsonInterval(
  successes: number,
  trials: number,
  confidence: 0.9 | 0.95 | 0.99,
): [number, number] {
  if (successes > trials) {
    throw new Error(`successes (${successes}) > trials (${trials})`);
  }
  if (trials === 0) return [0, 0];
  const z = Z_FOR_CONFIDENCE[confidence];
  if (z === undefined) {
    throw new Error(`unsupported confidence ${confidence}; use 0.9 / 0.95 / 0.99`);
  }
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function aggregateRate(trials: boolean[], confidence: 0.9 | 0.95 | 0.99): RateResult {
  const total = trials.length;
  const successes = trials.filter(Boolean).length;
  const rate = total === 0 ? 0 : successes / total;
  const [ci_low, ci_high] = wilsonInterval(successes, total, confidence);
  return { successes, trials: total, rate, ci_low, ci_high };
}
