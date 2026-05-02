// eval/spike-edge-warmup.ts
//
// Edge Function warm-up distribution spike (T7-Edge).
//
// Question: when watch_table is invoked through the deployed Edge Function
// against a freshly-published table, what's the distribution of the wall-time
// from `tools/call watch_table` dispatch to first-event response, with one
// INSERT fired at +100ms post-dispatch?
//
// Required by ADR-0016 risk mitigation (recon
// docs/recon/2026-05-02-v1.0.0-ship-surface-recon.md § "Adversarial pass"
// Risk #1): the v1.0.0 watch_table Edge smoke's wall budget must be sized
// to the p99 of this distribution + margin, otherwise the smoke is
// flake-tolerant rather than reliability-bound.
//
// METHODOLOGY (fresh table per trial + multi-INSERT schedule — mirrors
// tests/smoke/watch-table.smoke.test.ts:87-89 because that's what the v1.0.0
// Edge smoke will actually fire; sizing the wall budget against this shape
// gives an honest upper bound):
//
//   For each of N_TRIALS trials:
//     1. CREATE TABLE spike_<i>_<ts> + ALTER PUBLICATION supabase_realtime
//        ADD TABLE (the act that arms the warm-up window)
//     2. Dispatch JSON-RPC `tools/call watch_table` against the deployed
//        Edge Function URL with { timeout_ms: 30_000, max_events: 1 }
//     3. Schedule INSERTs at +100ms (n=0), +5_000ms (n=1), +10_000ms (n=2)
//        via separate postgres() conn — at least one is guaranteed to land
//        post-SUBSCRIBE_READY for typical Edge cold-start + warm-up budgets
//     4. Await the call response. Measure wall = response_at - dispatched_at,
//        and which n was delivered (event payload.new.n)
//     5. Categorize: delivered_n0 (warm path, sub-5s) | delivered_n1 (5-10s) |
//        delivered_n2 (>10s) | timeout (>30s) | error
//     6. ALTER PUBLICATION DROP + DROP TABLE
//
// First-pass single-INSERT@+100ms design surfaced 2/17 delivered, 15/17 timeout
// — the per-request Edge subscribe handshake + warm-up window exceeds 100ms,
// so single-shot INSERTs land pre-SUBSCRIBED and Postgres-Changes drops them.
// That's a real finding (captured in docs/spike-findings.md § T7-Edge), but
// it doesn't size the smoke. Multi-INSERT does.
//
// Output: JSON log with full per-trial data + p50/p95/p99 of wall_ms and
// a recommended Edge smoke wall budget (clamp(p99 * 1.5, 30_000)).
//
// Cost: ~$1 of Pro project time (20 trials × ~7s each + DDL overhead).
//
// Operator setup:
//   - EVAL_SUPABASE_PAT, EVAL_HOST_PROJECT_REF (existing env)
//   - EVAL_HOST_DB_URL (NEW — direct postgres URL for the host project's
//     DB; required for DDL + INSERT without going through `withBranch`).
//     Format: postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
//   - Edge Function deployed to host project (per references/edge-deployment.md)
//
// Run:
//   set -a && source .env && set +a && bun run eval/spike-edge-warmup.ts
//
// Exits 0 on completion (this is a measurement, not a gate — operator
// reads the histogram and sizes the smoke wall budget). Exits 1 if every
// trial errored (substrate is broken; not a measurement worth keeping).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import postgres from "postgres";
import { fetchProjectKeys } from "../tests/smoke/_helpers/project-keys.ts";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const HOST_DB_URL = process.env.EVAL_HOST_DB_URL;

if (!PAT || !HOST_REF || !HOST_DB_URL) {
  console.error(
    "[spike-edge-warmup] missing one of EVAL_SUPABASE_PAT, EVAL_HOST_PROJECT_REF, EVAL_HOST_DB_URL",
  );
  console.error(
    "[spike-edge-warmup]   EVAL_HOST_DB_URL is the host project's pooler URL — copy from the Supabase dashboard.",
  );
  process.exit(2);
}

const N_TRIALS = 20;
const CALL_TIMEOUT_MS = 30_000;
const INSERT_SCHEDULE_MS = [100, 5_000, 10_000] as const;
const TABLE_PREFIX = `spike_warmup_${Date.now()}`;
const PACE_BETWEEN_TRIALS_MS = 500;

type DeliveredOutcome = "delivered_n0" | "delivered_n1" | "delivered_n2";

interface TrialResult {
  n: number;
  table: string;
  outcome: DeliveredOutcome | "timeout" | "error";
  wall_ms: number;
  insert_offsets_ms: Array<number | null>;
  delivered_n: number | null;
  closed_reason: "max_events" | "timeout" | null;
  events_returned: number;
  http_status: number | null;
  error_message: string | null;
}

interface SpikeLog {
  timestamp: string;
  host_ref: string;
  function_url: string;
  n_trials: number;
  insert_schedule_ms: readonly number[];
  call_timeout_ms: number;
  trials: TrialResult[];
  delivered: {
    count: number;
    wall_ms: number[];
    by_bucket: Record<DeliveredOutcome, number>;
  };
  timeouts: number;
  errors: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  recommended_smoke_wall_budget_ms: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo] as number;
  const frac = pos - lo;
  return (sorted[lo] as number) * (1 - frac) + (sorted[hi] as number) * frac;
}

type JsonRpcResponse = {
  jsonrpc: string;
  id: number;
  result?: {
    content?: Array<{ type: string; text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
};

async function dispatchWatchCall(
  fnUrl: string,
  bearer: string,
  table: string,
  id: number,
): Promise<{ status: number; body: JsonRpcResponse }> {
  const res = await fetch(fnUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: "watch_table",
        arguments: {
          table,
          predicate: { event: "INSERT" },
          timeout_ms: CALL_TIMEOUT_MS,
          max_events: 1,
        },
      },
    }),
  });
  const json = (await res.json()) as JsonRpcResponse;
  return { status: res.status, body: json };
}

async function runTrial(
  fnUrl: string,
  bearer: string,
  sql: postgres.Sql,
  n: number,
): Promise<TrialResult> {
  const table = `${TABLE_PREFIX}_${n}`;
  const result: TrialResult = {
    n,
    table,
    outcome: "error",
    wall_ms: Number.NaN,
    insert_offsets_ms: INSERT_SCHEDULE_MS.map(() => null),
    delivered_n: null,
    closed_reason: null,
    events_returned: 0,
    http_status: null,
    error_message: null,
  };

  let tableCreated = false;
  let publicationAdded = false;
  const insertTimers: Array<ReturnType<typeof setTimeout>> = [];

  try {
    await sql.unsafe(
      `create table ${table} (id uuid primary key default gen_random_uuid(), n int)`,
    );
    tableCreated = true;

    // Probe T7-Edge surfaced: postgres-changes events on this host project
    // arrive with `new: {}` + `errors: ["Error 401: Unauthorized"]` unless
    // the table has a permissive RLS policy + GRANT SELECT to the agent's
    // role. Realtime broker authorizes the row payload separately from
    // PostgREST. RLS-disabled-with-GRANT delivers zero events to anon JWTs;
    // RLS-enabled-with-policy-using(true) is the consumer-shaped chain.
    // See docs/spike-findings.md § T7-Edge sub-finding "GRANT + RLS chain".
    await sql.unsafe(`alter table ${table} enable row level security`);
    await sql.unsafe(`create policy "${table}_read" on ${table} for select using (true)`);
    await sql.unsafe(`grant select on ${table} to anon, authenticated, service_role`);
    await sql.unsafe(`alter publication supabase_realtime add table ${table}`);
    publicationAdded = true;

    // Trial measurement starts the moment we dispatch the JSON-RPC call.
    const t0 = performance.now();
    const callPromise = dispatchWatchCall(fnUrl, bearer, table, 1000 + n);

    // Schedule INSERTs at the configured offsets. INSERT.n carries the
    // schedule index so the response payload tells us which one was
    // delivered (i.e., which one landed post-SUBSCRIBED).
    let insertError: Error | null = null;
    INSERT_SCHEDULE_MS.forEach((offset, idx) => {
      insertTimers.push(
        setTimeout(() => {
          sql
            .unsafe(`insert into ${table} (n) values (${idx})`)
            .then(() => {
              result.insert_offsets_ms[idx] = performance.now() - t0;
            })
            .catch((e: Error) => {
              if (!insertError) insertError = e;
            });
        }, offset),
      );
    });

    const { status, body } = await callPromise;
    for (const t of insertTimers) clearTimeout(t);
    const t1 = performance.now();
    result.wall_ms = t1 - t0;
    result.http_status = status;

    if (insertError) {
      result.outcome = "error";
      result.error_message = `INSERT failed: ${(insertError as Error).message}`;
      return result;
    }

    if (status !== 200) {
      result.outcome = "error";
      result.error_message = `HTTP ${status}: ${JSON.stringify(body).slice(0, 200)}`;
      return result;
    }

    if (body.error) {
      result.outcome = "error";
      result.error_message = `JSON-RPC error: ${body.error.message}`;
      return result;
    }

    const text = body.result?.content?.[0]?.text ?? "{}";
    const payload = JSON.parse(text) as {
      events?: Array<{ new?: { n?: number } | null }>;
      closed_reason?: "max_events" | "timeout";
    };
    result.events_returned = payload.events?.length ?? 0;
    result.closed_reason = payload.closed_reason ?? null;

    if (body.result?.isError) {
      result.outcome = "error";
      result.error_message = `tool isError envelope: ${text.slice(0, 200)}`;
      return result;
    }

    if (result.closed_reason === "max_events" && result.events_returned >= 1) {
      // With the GRANT + RLS chain in place, `new` is populated and we can
      // read INSERT.n directly. Fall back to time-based bucketing if `new.n`
      // is somehow absent (defensive — the chain change is what makes this
      // reliable).
      const deliveredN = payload.events?.[0]?.new?.n;
      let bucket: DeliveredOutcome;
      if (typeof deliveredN === "number" && deliveredN >= 0 && deliveredN <= 2) {
        result.delivered_n = deliveredN;
        bucket = `delivered_n${deliveredN}` as DeliveredOutcome;
      } else {
        const wall = result.wall_ms;
        if (wall < (INSERT_SCHEDULE_MS[0] + INSERT_SCHEDULE_MS[1]) / 2) {
          bucket = "delivered_n0";
          result.delivered_n = 0;
        } else if (wall < (INSERT_SCHEDULE_MS[1] + INSERT_SCHEDULE_MS[2]) / 2) {
          bucket = "delivered_n1";
          result.delivered_n = 1;
        } else {
          bucket = "delivered_n2";
          result.delivered_n = 2;
        }
      }
      result.outcome = bucket;
    } else if (result.closed_reason === "timeout") {
      result.outcome = "timeout";
    } else {
      result.outcome = "error";
      result.error_message = `unexpected response shape: closed_reason=${result.closed_reason} events=${result.events_returned}`;
    }
  } catch (e: unknown) {
    for (const t of insertTimers) clearTimeout(t);
    result.error_message = e instanceof Error ? e.message : String(e);
  } finally {
    if (publicationAdded) {
      await sql
        .unsafe(`alter publication supabase_realtime drop table ${table}`)
        .catch((e: Error) => {
          console.warn(`[spike-edge-warmup] trial ${n} publication drop failed: ${e.message}`);
        });
    }
    if (tableCreated) {
      await sql.unsafe(`drop table if exists ${table}`).catch((e: Error) => {
        console.warn(`[spike-edge-warmup] trial ${n} table drop failed: ${e.message}`);
      });
    }
  }

  return result;
}

async function main(): Promise<void> {
  const wallStart = Date.now();
  const fnUrl = `https://${HOST_REF as string}.supabase.co/functions/v1/mcp`;
  const keys = await fetchProjectKeys(PAT as string, HOST_REF as string);

  console.log(`[spike-edge-warmup] function URL: ${fnUrl}`);
  console.log(
    `[spike-edge-warmup] trials: ${N_TRIALS}, insert schedule: [${INSERT_SCHEDULE_MS.map((o) => `+${o}ms`).join(", ")}]`,
  );
  console.log(
    "[spike-edge-warmup] bearer: service_role; tables created with RLS + policy + GRANT chain",
  );
  console.log(
    "[spike-edge-warmup]   (probe T7-Edge: GRANT alone delivers events but 401-strips row data;",
  );
  console.log(
    "[spike-edge-warmup]   RLS-enabled-with-policy-using(true) is the consumer-shaped chain)",
  );

  const sql = postgres(HOST_DB_URL as string, { max: 1, prepare: false });
  const trials: TrialResult[] = [];

  try {
    // Defensive cleanup: drop any spike_warmup_* tables from a prior killed run.
    // Without this, the host project's public schema accumulates DDL detritus.
    const stale = await sql<Array<{ tablename: string }>>`
      select tablename from pg_tables
      where schemaname = 'public' and tablename like 'spike_warmup_%'
    `;
    for (const { tablename } of stale) {
      await sql
        .unsafe(`alter publication supabase_realtime drop table ${tablename}`)
        .catch(() => {});
      await sql.unsafe(`drop table if exists ${tablename}`).catch(() => {});
    }
    if (stale.length > 0) {
      console.log(`[spike-edge-warmup] cleaned up ${stale.length} stale spike tables`);
    }

    for (let i = 0; i < N_TRIALS; i++) {
      const result = await runTrial(fnUrl, keys.serviceRole, sql, i);
      trials.push(result);
      const wallStr = Number.isFinite(result.wall_ms) ? `${result.wall_ms.toFixed(0)}ms` : "n/a";
      const insertsStr = result.insert_offsets_ms
        .map((o, idx) => (o !== null ? `n${idx}@+${o.toFixed(0)}ms` : `n${idx}@-`))
        .join(",");
      console.log(
        `[spike-edge-warmup] trial #${i}: ${result.outcome} wall=${wallStr} inserts=[${insertsStr}] closed_reason=${result.closed_reason ?? "n/a"} ${result.error_message ? `(${result.error_message})` : ""}`,
      );
      if (i + 1 < N_TRIALS) {
        await new Promise((r) => setTimeout(r, PACE_BETWEEN_TRIALS_MS));
      }
    }
  } finally {
    await sql.end();
  }

  const delivered = trials.filter((t): t is TrialResult & { outcome: DeliveredOutcome } =>
    t.outcome.startsWith("delivered_"),
  );
  const deliveredWalls = delivered.map((t) => t.wall_ms).sort((a, b) => a - b);
  const timeouts = trials.filter((t) => t.outcome === "timeout").length;
  const errors = trials.filter((t) => t.outcome === "error").length;

  const byBucket: Record<DeliveredOutcome, number> = {
    delivered_n0: 0,
    delivered_n1: 0,
    delivered_n2: 0,
  };
  for (const t of delivered) byBucket[t.outcome]++;

  const p50 = quantile(deliveredWalls, 0.5);
  const p95 = quantile(deliveredWalls, 0.95);
  const p99 = quantile(deliveredWalls, 0.99);

  // Smoke wall budget = 1.5x p99, floored at 12s (matches the slowest INSERT
  // offset + 2s headroom), capped at 30s (the watch-table.smoke ceiling). If
  // p99 > 20s, the operator should reshape the smoke (longer budget, retry
  // envelope, or different probe shape) — that's an ADR-0016 decision the
  // spike informs.
  const recommended = Number.isFinite(p99)
    ? Math.min(30_000, Math.max(12_000, Math.ceil((p99 * 1.5) / 1000) * 1000))
    : 30_000;

  const log: SpikeLog = {
    timestamp: new Date().toISOString(),
    host_ref: HOST_REF as string,
    function_url: fnUrl,
    n_trials: N_TRIALS,
    insert_schedule_ms: INSERT_SCHEDULE_MS,
    call_timeout_ms: CALL_TIMEOUT_MS,
    trials,
    delivered: { count: delivered.length, wall_ms: deliveredWalls, by_bucket: byBucket },
    timeouts,
    errors,
    p50_ms: p50,
    p95_ms: p95,
    p99_ms: p99,
    recommended_smoke_wall_budget_ms: recommended,
  };

  const logPath = resolve(
    process.cwd(),
    `logs/spike-edge-warmup/${Math.floor(Date.now() / 1000)}.json`,
  );
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, `${JSON.stringify(log, null, 2)}\n`);

  console.log("");
  console.log("=== Spike-edge-warmup results ===");
  console.log(`  function URL: ${fnUrl}`);
  console.log(
    `  trials: ${N_TRIALS} (delivered: ${delivered.length}, timeouts: ${timeouts}, errors: ${errors})`,
  );
  console.log(
    `  delivered by bucket: n0(<5s)=${byBucket.delivered_n0}, n1(5-10s)=${byBucket.delivered_n1}, n2(>10s)=${byBucket.delivered_n2}`,
  );
  console.log(`  p50 wall: ${p50.toFixed(0)}ms`);
  console.log(`  p95 wall: ${p95.toFixed(0)}ms`);
  console.log(`  p99 wall: ${p99.toFixed(0)}ms`);
  console.log(`  recommended Edge smoke wall budget: ${recommended}ms`);
  console.log(`  log: ${logPath}`);
  console.log(`  wallclock: ${((Date.now() - wallStart) / 1000).toFixed(1)}s`);
  console.log("");
  console.log("  Operator next step: append findings to docs/spike-findings.md § T7-Edge,");
  console.log("  then size the watch_table Edge smoke wall budget per the recommendation.");

  // Exit 1 only if EVERY trial failed — that's a substrate signal, not a
  // measurement. Otherwise exit 0 (the histogram is the deliverable).
  process.exit(delivered.length === 0 && timeouts === 0 ? 1 : 0);
}

await main();
