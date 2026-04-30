// eval/spike-latency.ts
//
// Week-1 spike threshold (spec §8.2): does INSERT → Realtime event delivery
// hold p95 < 2000ms across n=20 trials on a real Supabase Pro branch? PASS
// → proceed to Phase 2. FAIL → architectural redesign.
//
// METHODOLOGY (corrected per T7 finding in docs/spike-findings.md):
//
// The naive "fresh adapter per trial" design fails — Realtime has a ~5s
// warm-up window after subscribe() resolves SUBSCRIBED on a freshly-added
// publication table where INSERTs are dropped. Every trial in that window
// times out or arrives 5s late.
//
// Corrected design: ONE long-lived subscription. Do a warmup INSERT to
// punch through the warm-up window, then fire n=20 INSERTs sequentially
// against the same subscription. Each trial measures performance.now()
// from INSERT commit to matching event receive.
//
// Run:
//   bun run eval/spike-latency.ts
//
// Exits 0 on PASS, 1 on FAIL. Writes a JSON log to logs/spike-latency/<unix-ts>.json.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import postgres from "postgres";
import { makeSupabaseAdapter } from "../src/server/realtime-client.ts";
import type { ChangeEvent } from "../src/server/realtime-client.ts";
import { fetchProjectKeys } from "../tests/smoke/_helpers/project-keys.ts";
import { ResilientApiClient } from "../tests/smoke/_helpers/resilient-api-client.ts";
import { buildBranchPoolerUrl, withBranch } from "../vendor/foundation/branch.ts";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";

if (!PAT || !HOST_REF) {
  console.error("[spike-latency] missing EVAL_SUPABASE_PAT or EVAL_HOST_PROJECT_REF");
  process.exit(2);
}

const N_TRIALS = 20;
const P95_THRESHOLD_MS = 2000;
const TRIAL_TIMEOUT_MS = 5_000;
const WARMUP_TIMEOUT_MS = 8_000;
const PACE_MS = 200;

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  // Linear-interpolated quantile (R-7 / Excel default).
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo] as number;
  const frac = pos - lo;
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac;
}

interface TrialResult {
  n: number;
  latency_ms: number | null; // null = timeout
  insert_committed_ms: number;
  event_received_ms: number | null;
}

interface SpikeLog {
  timestamp: string;
  branchRef: string;
  n_trials: number;
  threshold_p95_ms: number;
  trials: TrialResult[];
  latencies: number[]; // successful trials only
  timeouts: number;
  p50: number;
  p95: number;
  p99: number;
  passed: boolean;
  warmup: {
    delivered: boolean;
    latency_ms: number | null;
  };
}

async function main(): Promise<void> {
  const wallStart = Date.now();
  const client = new ResilientApiClient({ pat: PAT as string, hostProjectRef: HOST_REF as string });

  let exitCode = 1;
  await withBranch(
    client,
    {
      name: `spike-latency-${Date.now()}`,
      region: REGION,
      pollTimeoutMs: 240_000,
      pollIntervalMs: 15_000,
    },
    async ({ branch, details }) => {
      console.log(
        `[spike-latency] branch ready: ref=${details.ref} status=${details.status} db_host=${details.db_host}`,
      );
      const dbUrl = buildBranchPoolerUrl({ ref: details.ref, db_pass: details.db_pass }, REGION);
      const sql = postgres(dbUrl, { max: 1, prepare: false });

      // Event log shared between the realtime callback and the trial loop.
      // Each entry: { receivedAt: performance.now(), n: payload.new.n }.
      const eventLog: Array<{ receivedAt: number; n: number }> = [];
      // Notifier woken on every event; trial loop awaits this then re-scans.
      let wake: (() => void) | null = null;
      const onEvent = (ev: ChangeEvent) => {
        if (ev.event !== "INSERT") return;
        const row = ev.new;
        if (!row || typeof row.n !== "number") return;
        eventLog.push({ receivedAt: performance.now(), n: row.n });
        if (wake) {
          const w = wake;
          wake = null;
          w();
        }
      };

      const adapter = makeSupabaseAdapter("tickets", {
        supabaseUrl: `https://${details.ref}.supabase.co`,
        // Branch projects inherit the host project's keys via the Realtime
        // URL — see watch-table.smoke.test.ts. service_role bypasses RLS so
        // we measure the primitive, not policy config.
        supabaseKey: (await fetchProjectKeys(PAT as string, branch.project_ref ?? details.ref))
          .serviceRole,
      });

      const trials: TrialResult[] = [];
      const warmup: SpikeLog["warmup"] = { delivered: false, latency_ms: null };

      try {
        await sql`create table tickets (id uuid primary key default gen_random_uuid(), body text, n int)`;
        await sql`alter publication supabase_realtime add table tickets`;
        const pubRows = await sql<
          Array<{ schemaname: string; tablename: string }>
        >`select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime'`;
        console.log("[spike-latency] supabase_realtime publication tables:", pubRows);

        await adapter.subscribe({ table: "tickets", onEvent });
        console.log("[spike-latency] subscribed; firing warmup");

        // ---- Warmup: punches through Realtime's ~5s warm-up window. ----
        const warmupN = -1;
        const warmupT0 = performance.now();
        await sql`insert into tickets (body, n) values (${"warmup"}, ${warmupN})`;
        const warmupCommit = performance.now();
        const warmupReceived = await waitForEvent(eventLog, warmupN, WARMUP_TIMEOUT_MS, (cb) => {
          wake = cb;
        });
        if (warmupReceived !== null) {
          warmup.delivered = true;
          warmup.latency_ms = warmupReceived - warmupCommit;
          console.log(
            `[spike-latency] warmup delivered: latency=${warmup.latency_ms.toFixed(1)}ms (insert→event)`,
          );
        } else {
          console.warn(
            `[spike-latency] warmup NOT delivered within ${WARMUP_TIMEOUT_MS}ms — continuing anyway`,
          );
        }
        // Discard pre-warmup elapsed for ergonomics.
        void warmupT0;

        // ---- Trials ----
        for (let i = 0; i < N_TRIALS; i++) {
          const t0 = performance.now();
          await sql`insert into tickets (body, n) values (${`trial-${i}`}, ${i})`;
          const insertCommittedAt = performance.now();
          const receivedAt = await waitForEvent(eventLog, i, TRIAL_TIMEOUT_MS, (cb) => {
            wake = cb;
          });
          const latency = receivedAt !== null ? receivedAt - insertCommittedAt : null;
          trials.push({
            n: i,
            latency_ms: latency,
            insert_committed_ms: insertCommittedAt - t0,
            event_received_ms: receivedAt !== null ? receivedAt - t0 : null,
          });
          if (latency !== null) {
            console.log(
              `[spike-latency] trial #${i}: latency=${latency.toFixed(1)}ms insert_commit=${(insertCommittedAt - t0).toFixed(1)}ms`,
            );
          } else {
            console.warn(
              `[spike-latency] trial #${i}: TIMEOUT (no event with n=${i} within ${TRIAL_TIMEOUT_MS}ms)`,
            );
          }
          await sleep(PACE_MS);
        }
      } finally {
        await adapter.unsubscribe().catch((e) => {
          console.warn(`[spike-latency] unsubscribe failed: ${e?.message ?? e}`);
        });
        await sql.end();
      }

      const successful = trials.map((t) => t.latency_ms).filter((v): v is number => v !== null);
      const sorted = [...successful].sort((a, b) => a - b);
      const p50 = quantile(sorted, 0.5);
      const p95 = quantile(sorted, 0.95);
      const p99 = quantile(sorted, 0.99);
      const timeouts = trials.length - successful.length;

      // Gate: p95 must be a finite number AND under threshold AND we must
      // have at least 95% of trials succeed (otherwise p95 is meaningless).
      const passed =
        Number.isFinite(p95) &&
        p95 < P95_THRESHOLD_MS &&
        successful.length >= Math.ceil(N_TRIALS * 0.95);

      const log: SpikeLog = {
        timestamp: new Date().toISOString(),
        branchRef: details.ref,
        n_trials: N_TRIALS,
        threshold_p95_ms: P95_THRESHOLD_MS,
        trials,
        latencies: successful,
        timeouts,
        p50,
        p95,
        p99,
        passed,
        warmup,
      };

      const logPath = resolve(
        process.cwd(),
        `logs/spike-latency/${Math.floor(Date.now() / 1000)}.json`,
      );
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);

      console.log("");
      console.log("=== Spike-latency results ===");
      console.log(`  branch: ${details.ref}`);
      console.log(`  n: ${N_TRIALS} (successful: ${successful.length}, timeouts: ${timeouts})`);
      console.log(
        `  warmup delivered: ${warmup.delivered} (${warmup.latency_ms?.toFixed(1) ?? "n/a"}ms)`,
      );
      console.log(`  p50: ${p50.toFixed(1)}ms`);
      console.log(`  p95: ${p95.toFixed(1)}ms`);
      console.log(`  p99: ${p99.toFixed(1)}ms`);
      console.log(`  log: ${logPath}`);
      console.log(`  spike threshold (p95 < ${P95_THRESHOLD_MS}ms): ${passed ? "PASS" : "FAIL"}`);
      console.log(`  wallclock: ${((Date.now() - wallStart) / 1000).toFixed(1)}s`);

      exitCode = passed ? 0 : 1;
    },
  );

  process.exit(exitCode);
}

/**
 * Wait until eventLog contains an entry with the given `n`, OR timeoutMs
 * elapses. Returns the receivedAt timestamp (performance.now() ms) of the
 * matching event, or null on timeout.
 *
 * Pattern: register waker BEFORE checking eventLog so we never miss an
 * event that lands between check and register. If event already present,
 * return synchronously. Otherwise wait for waker or timeout.
 */
async function waitForEvent(
  eventLog: Array<{ receivedAt: number; n: number }>,
  targetN: number,
  timeoutMs: number,
  registerWaker: (cb: () => void) => void,
): Promise<number | null> {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    // Register the waker FIRST (before scanning) to avoid the race where an
    // event lands between scan and register and we sleep through it.
    let resolveWait: (() => void) | null = null;
    const waitPromise = new Promise<void>((resolve) => {
      resolveWait = resolve;
    });
    registerWaker(() => {
      if (resolveWait) {
        const r = resolveWait;
        resolveWait = null;
        r();
      }
    });
    const hit = eventLog.find((e) => e.n === targetN);
    if (hit) return hit.receivedAt;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remaining);
    });
    await Promise.race([waitPromise, timeoutPromise]);
    if (timer) clearTimeout(timer);
    // Re-scan — either we got woken by an event, or we hit the deadline.
    // The next loop iteration will re-check eventLog and decide.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

await main();
