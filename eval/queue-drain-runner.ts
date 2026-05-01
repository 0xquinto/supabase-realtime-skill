// eval/queue-drain-runner.ts
//
// Runs the queue-drain fixtures (fixtures/ci-fast/queue-drain/qd*.json)
// against the same fake adapter/sender stack the fast tests use, computes
// the `forward_correctness` rate + Wilson 95% CI, and reports against the
// `forward_correctness_rate_min` threshold pre-staged in ADR-0010.
//
// Why a fake-driven runner here (not a real-branch runner like eval/runner.ts):
// the queue-drain composition's correctness doesn't depend on real Realtime
// timing — it depends on the partition property (forwarded + dead_lettered
// + failed = events.length, with the right bucket per row given the
// broadcast plan). Real-branch testing is what tests/smoke/queue-drain.smoke
// covers; the fake-driven eval gives the methodology gate's binary signal
// in <5s at $0 cost. A future real-branch runner can extend this for
// latency metrics + n=100/n=300 corpora.
//
// Usage:
//   bun run eval/queue-drain-runner.ts            # runs ci-fast seeds
//
// Exits non-zero if forward_correctness_rate falls below the threshold.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BroadcastSender } from "../src/server/broadcast.ts";
import { boundedQueueDrain } from "../src/server/queue-drain.ts";
import type { ChangeEvent, RealtimeAdapter } from "../src/server/realtime-client.ts";
import { aggregateRate } from "../vendor/foundation/scoring.ts";

// ---------------------------------------------------------------------------
// Fixture schema (matches fixtures/ci-fast/queue-drain/qd*.json)
// ---------------------------------------------------------------------------

interface FixtureRow {
  id: string;
  destination: string;
  event_type: string;
  payload: Record<string, unknown>;
}

type BroadcastBehavior =
  | "always_success"
  | "always_fail"
  | { permanently_fail_destinations: string[] }
  | { fail_first_n_attempts_for_row: string; n: number }
  | { permanently_fail_row: string };

interface Fixture {
  id: string;
  description: string;
  drain_config: {
    timeout_ms: number;
    max_events: number;
    dead_letter_provided: boolean;
  };
  rows_arriving: FixtureRow[];
  broadcast_behavior: BroadcastBehavior;
  expected_end_state: {
    forwarded: number;
    dead_lettered: number;
    failed: number;
    closed_reason_one_of: Array<"max_events" | "timeout">;
  };
}

interface FixtureOutcome {
  fixture_id: string;
  pass: boolean;
  observed: {
    forwarded: number;
    dead_lettered: number;
    failed: number;
    closed_reason: "max_events" | "timeout";
  };
  expected: Fixture["expected_end_state"];
  reason: string | null;
  duration_ms: number;
}

// ---------------------------------------------------------------------------
// Fakes — same shape as tests/fast/queue-drain.test.ts
// ---------------------------------------------------------------------------

function makeAdapter(): {
  adapter: RealtimeAdapter;
  emit: (row: FixtureRow) => void;
} {
  let listener: ((ev: ChangeEvent) => void) | null = null;
  const adapter: RealtimeAdapter = {
    subscribe: async ({ onEvent }) => {
      listener = onEvent;
    },
    unsubscribe: async () => {
      listener = null;
    },
  };
  return {
    adapter,
    emit: (row) =>
      listener?.({
        event: "INSERT",
        table: "queue",
        schema: "public",
        new: { ...(row as unknown as Record<string, unknown>), _row_id: row.id },
        old: null,
        commit_timestamp: new Date().toISOString(),
      }),
  };
}

function makeSender(plan: BroadcastBehavior): BroadcastSender {
  const failingRowAttempts = new Map<string, number>();
  return {
    send: async (input) => {
      const rowId = (input.payload as Record<string, unknown>)._row_id as string | undefined;
      if (plan === "always_fail") {
        throw new Error("always_fail plan");
      }
      if (typeof plan === "object") {
        if ("permanently_fail_destinations" in plan) {
          if (plan.permanently_fail_destinations.includes(input.channel)) {
            throw new Error(`destination ${input.channel} unreachable`);
          }
        } else if ("permanently_fail_row" in plan) {
          if (rowId === plan.permanently_fail_row) {
            throw new Error(`row ${rowId} permanently fails`);
          }
        } else if ("fail_first_n_attempts_for_row" in plan) {
          if (rowId === plan.fail_first_n_attempts_for_row) {
            const seen = failingRowAttempts.get(rowId) ?? 0;
            failingRowAttempts.set(rowId, seen + 1);
            if (seen < plan.n) {
              throw new Error(`transient failure attempt ${seen + 1}`);
            }
          }
        }
      }
      return { status: "ok" as const };
    },
  };
}

// ---------------------------------------------------------------------------
// One trial
// ---------------------------------------------------------------------------

async function runFixture(fixture: Fixture): Promise<FixtureOutcome> {
  const { adapter, emit } = makeAdapter();
  const sender = makeSender(fixture.broadcast_behavior);

  const start = Date.now();
  const drainPromise = boundedQueueDrain({
    adapter,
    table: "queue",
    read_row: (ev) => {
      const row = ev.new as unknown as FixtureRow;
      return { destination: row.destination, event: row.event_type, payload: row.payload };
    },
    ack: async () => {},
    ...(fixture.drain_config.dead_letter_provided ? { dead_letter: async () => {} } : {}),
    sender,
    timeout_ms: fixture.drain_config.timeout_ms,
    max_events: fixture.drain_config.max_events,
  });

  // Emit all rows on the next microtask, matching the fast-test pattern.
  queueMicrotask(() => {
    for (const r of fixture.rows_arriving) emit(r);
  });

  const result = await drainPromise;
  const duration = Date.now() - start;

  const expected = fixture.expected_end_state;
  const reasons: string[] = [];
  if (result.forwarded !== expected.forwarded) {
    reasons.push(`forwarded ${result.forwarded} != expected ${expected.forwarded}`);
  }
  if (result.dead_lettered !== expected.dead_lettered) {
    reasons.push(`dead_lettered ${result.dead_lettered} != expected ${expected.dead_lettered}`);
  }
  if (result.failed !== expected.failed) {
    reasons.push(`failed ${result.failed} != expected ${expected.failed}`);
  }
  if (!expected.closed_reason_one_of.includes(result.closed_reason)) {
    reasons.push(
      `closed_reason ${result.closed_reason} not in [${expected.closed_reason_one_of.join(", ")}]`,
    );
  }

  return {
    fixture_id: fixture.id,
    pass: reasons.length === 0,
    observed: {
      forwarded: result.forwarded,
      dead_lettered: result.dead_lettered,
      failed: result.failed,
      closed_reason: result.closed_reason,
    },
    expected,
    reason: reasons.length > 0 ? reasons.join("; ") : null,
    duration_ms: duration,
  };
}

// ---------------------------------------------------------------------------
// Aggregate + threshold check
// ---------------------------------------------------------------------------

interface QueueDrainMetrics {
  forward_correctness: {
    successes: number;
    trials: number;
    rate: number;
    ci_low: number;
    ci_high: number;
  };
}

interface QueueDrainThresholds {
  forward_correctness_rate_min: number;
  forward_correctness_ci_low_min: number;
}

// Tentative targets per ADR-0010 § 6 (numeric thresholds locked at v0.2.0
// baseline run; this is that run). The targets are 0.95 / 0.92 mirroring
// the ADR; treated as "advisory at n=7" because the seed corpus is too
// small to gate on (mechanical Wilson floor at n=7, p̂=1.0 is ~0.65).
// Real gate at n=100 (ci-nightly tier) once the corpus is synthesized.
const TENTATIVE_THRESHOLDS: QueueDrainThresholds = {
  forward_correctness_rate_min: 0.95,
  forward_correctness_ci_low_min: 0.92,
};

function computeMetrics(outcomes: FixtureOutcome[]): QueueDrainMetrics {
  const passes = outcomes.map((o) => o.pass);
  const agg = aggregateRate(passes, 0.95);
  return { forward_correctness: agg };
}

function checkThresholds(
  metrics: QueueDrainMetrics,
  cfg: QueueDrainThresholds,
): { pass: boolean; failures: string[]; advisory: string[] } {
  const failures: string[] = [];
  const advisory: string[] = [];
  // Rate is the binary gate; CI is the discipline gate.
  if (metrics.forward_correctness.rate < cfg.forward_correctness_rate_min) {
    failures.push(
      `forward_correctness.rate (${metrics.forward_correctness.rate.toFixed(3)}) < ${cfg.forward_correctness_rate_min}`,
    );
  }
  if (metrics.forward_correctness.ci_low < cfg.forward_correctness_ci_low_min) {
    advisory.push(
      `forward_correctness.ci_low (${metrics.forward_correctness.ci_low.toFixed(3)}) < ${cfg.forward_correctness_ci_low_min} — mechanically expected at n=${metrics.forward_correctness.trials}; gate moves to ci-nightly tier`,
    );
  }
  return { pass: failures.length === 0, failures, advisory };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function loadFixtures(dir: string): Promise<Fixture[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json") && f !== "README.md").sort();
  const fixtures: Fixture[] = [];
  for (const f of files) {
    const raw = await readFile(join(dir, f), "utf-8");
    fixtures.push(JSON.parse(raw) as Fixture);
  }
  return fixtures;
}

async function main(): Promise<void> {
  const dir = "fixtures/ci-fast/queue-drain";
  const fixtures = await loadFixtures(dir);
  console.log(`[queue-drain-runner] tier=ci-fast n=${fixtures.length}`);

  const outcomes: FixtureOutcome[] = [];
  for (const fixture of fixtures) {
    const o = await runFixture(fixture);
    console.log(
      `[trial ${o.fixture_id}] ${o.pass ? "PASS" : "FAIL"} duration=${o.duration_ms}ms` +
        (o.reason ? ` reason=${o.reason}` : ""),
    );
    outcomes.push(o);
  }

  const metrics = computeMetrics(outcomes);
  const check = checkThresholds(metrics, TENTATIVE_THRESHOLDS);

  await mkdir("eval/reports", { recursive: true });
  const reportPath = `eval/reports/queue-drain-ci-fast-${Date.now()}.json`;
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        tier: "ci-fast",
        runner: "queue-drain-fake-driven",
        thresholds: TENTATIVE_THRESHOLDS,
        metrics,
        check,
        outcomes,
      },
      null,
      2,
    ),
  );

  console.log("\n=== Aggregated metrics ===");
  console.log(JSON.stringify(metrics, null, 2));
  console.log(`\nReport written to ${reportPath}`);
  console.log(`\nThresholds: ${check.pass ? "PASS" : "FAIL"}`);
  for (const a of check.advisory) console.log(`  advisory: ${a}`);
  if (!check.pass) {
    for (const f of check.failures) console.log(`  failure: ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
