// eval/runner.ts
//
// CLI entrypoint: spawns the triage agent over fixtures, computes
// aggregated metrics, checks against manifest.json thresholds, exits
// non-zero on regression.
//
// Usage:
//   bun run eval/runner.ts ci-fast       # ci-fast/n=20 fixtures
//   bun run eval/runner.ts ci-nightly    # ci-nightly/n=100 fixtures
//
// Single transient branch per run (cost-bounded). All fixtures execute
// against that branch sequentially; the branch is torn down by withBranch's
// finalizer regardless of outcome.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { fetchProjectKeys } from "../tests/smoke/_helpers/project-keys.ts";
import { ResilientApiClient } from "../tests/smoke/_helpers/resilient-api-client.ts";
import { buildBranchPoolerUrl, withBranch } from "../vendor/foundation/branch.ts";
import { type ThresholdConfig, checkThresholds, computeMetrics } from "./metrics.ts";
import { type TriageInput, type TriageResult, triageOne } from "./triage-agent.ts";

interface Fixture {
  id: string;
  ticket: { subject: string; body: string };
  expected_routing: string;
  ground_truth_top_k_ids?: string[];
}

interface Manifest {
  version: string;
  thresholds: ThresholdConfig;
}

type Tier = "ci-fast" | "ci-nightly";

async function loadFixtures(tier: Tier): Promise<Fixture[]> {
  const dir = join("fixtures", tier);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const fixtures: Fixture[] = [];
  for (const f of files) {
    const raw = await readFile(join(dir, f), "utf-8");
    fixtures.push(JSON.parse(raw) as Fixture);
  }
  return fixtures;
}

async function main(): Promise<void> {
  // Env reads inside main() (not module-scope) so unrelated typecheck/lint
  // paths don't blow up when the env is not configured.
  const PAT = process.env.EVAL_SUPABASE_PAT;
  const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
  const REGION = process.env.EVAL_REGION ?? "us-east-1";
  if (!PAT || !HOST_REF) {
    console.error("EVAL_SUPABASE_PAT and EVAL_HOST_PROJECT_REF are required");
    process.exit(2);
  }

  // Type-guarded tier validation — `as` cast on argv is unsafe.
  const arg = process.argv[2] ?? "ci-fast";
  if (arg !== "ci-fast" && arg !== "ci-nightly") {
    console.error(`unknown tier: ${arg}`);
    process.exit(2);
  }
  const tier: Tier = arg;

  // Manifest is in-repo and version-controlled, so the cast is acceptable.
  // A zod schema would be overkill for v1.
  const manifest = JSON.parse(await readFile("manifest.json", "utf-8")) as Manifest;
  const thresholds: ThresholdConfig = manifest.thresholds;

  const fixtures = await loadFixtures(tier);
  console.log(`[runner] tier=${tier} n=${fixtures.length}`);

  // ResilientApiClient retries the post-create 404 window on getBranchDetails
  // (see tests/smoke/_helpers/resilient-api-client.ts).
  const apiClient = new ResilientApiClient({ pat: PAT, hostProjectRef: HOST_REF });

  const outcomes: TriageResult[] = await withBranch(
    apiClient,
    {
      name: `eval-${tier}-${Date.now()}`,
      region: REGION,
      pollTimeoutMs: 240_000,
      pollIntervalMs: 15_000,
    },
    async ({ branch, details }) => {
      const dbUrl = buildBranchPoolerUrl({ ref: details.ref, db_pass: details.db_pass }, REGION);

      // Apply migrations.
      const migration = await readFile(
        "supabase/migrations/20260430000001_support_tickets.sql",
        "utf-8",
      );
      const sql = postgres(dbUrl, { max: 1, prepare: false });
      try {
        await sql.unsafe(migration);
      } finally {
        await sql.end();
      }

      // Branch projects don't ship anon/service_role keys on the create or
      // getBranchDetails responses — fetch them via the api-keys endpoint.
      // service_role bypasses RLS so we measure the primitive, not policy.
      const keys = await fetchProjectKeys(PAT, branch.project_ref ?? details.ref);
      const supabaseUrl = `https://${details.ref}.supabase.co`;
      const supabaseKey = keys.serviceRole;

      const results: TriageResult[] = [];
      for (const fixture of fixtures) {
        const input: TriageInput = {
          fixture: {
            id: fixture.id,
            ticket: fixture.ticket,
            expected_routing: fixture.expected_routing,
          },
          supabaseUrl,
          supabaseKey,
          databaseUrl: dbUrl,
        };
        const result = await triageOne(input);
        console.log(
          `[trial ${fixture.id}] observed=${result.observed} correct=${result.correct} latency=${result.latency_ms}`,
        );
        results.push(result);
      }
      return results;
    },
  );

  const metrics = computeMetrics(outcomes);
  const check = checkThresholds(metrics, thresholds);

  await mkdir("eval/reports", { recursive: true });
  const reportPath = `eval/reports/${tier}-${Date.now()}.json`;
  await writeFile(
    reportPath,
    JSON.stringify({ tier, manifest_version: manifest.version, metrics, check, outcomes }, null, 2),
  );

  console.log("\n=== Aggregated metrics ===");
  console.log(JSON.stringify(metrics, null, 2));
  console.log(`\nThresholds: ${check.pass ? "PASS" : "FAIL"}`);
  if (!check.pass) {
    console.log(`Failures: ${check.failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
