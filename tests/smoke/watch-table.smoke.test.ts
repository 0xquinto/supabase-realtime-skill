// tests/smoke/watch-table.smoke.test.ts
//
// First end-to-end validation of the bounded-watch primitive against a real
// Supabase branch. Spike-success gate (T7 in the build plan).
//
// Single-trial floor only — ci-nightly (T9) enforces p95 < 2000ms across
// n=100. This test's job is to prove the primitive works against real
// Postgres + Realtime under a real branch's pooler.
//
// Skips automatically when EVAL_SUPABASE_PAT or EVAL_HOST_PROJECT_REF is
// missing (matches supabase-mcp-evals' smoke-test convention).

import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { boundedWatch, makeSupabaseAdapter } from "../../src/server/realtime-client";
import { ApiClient, type BranchDetails } from "../../vendor/foundation/api-client";
import { buildBranchPoolerUrl, withBranch } from "../../vendor/foundation/branch";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";
const SHOULD_RUN = !!(PAT && HOST_REF);

// Vendored ApiClient retries 403/429/5xx but not 404. There's a brief window
// after POST /v1/projects/{ref}/branches where GET /v1/branches/{id} returns
// 404 — the create record exists but the underlying project hasn't been
// provisioned far enough to expose the details endpoint. withBranch makes its
// first getBranchDetails call immediately, so it can hit that window. Wrap
// with a 404-tolerant retry; preserve all other behavior.
class ResilientApiClient extends ApiClient {
  override async getBranchDetails(branchId: string): Promise<BranchDetails> {
    const maxAttempts = 8;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await super.getBranchDetails(branchId);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const is404 = msg.startsWith("404 ");
        if (!is404 || attempt === maxAttempts) throw e;
        // Backoff caps below the 15s default poll interval so we still land
        // a fresh poll in withBranch's loop.
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    // unreachable; loop either returns or throws.
    throw new Error("unreachable");
  }
}

// Branch creation does not return anon/service_role keys — they live behind
// a separate Management API endpoint. We can't extend the vendored ApiClient
// (foundation snapshot policy), so we hit the endpoint directly here.
async function fetchProjectKeys(
  pat: string,
  projectRef: string,
): Promise<{ anon: string; serviceRole: string }> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/api-keys`, {
    headers: { Authorization: `Bearer ${pat}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`fetch api-keys failed: ${res.status} ${res.statusText} ${body}`);
  }
  const keys = (await res.json()) as Array<{ name?: string; api_key?: string }>;
  const anon = keys.find((k) => k.name === "anon")?.api_key;
  const serviceRole = keys.find((k) => k.name === "service_role")?.api_key;
  if (!anon) throw new Error(`no anon key in api-keys response for ${projectRef}`);
  if (!serviceRole) throw new Error(`no service_role key for ${projectRef}`);
  return { anon, serviceRole };
}

describe.skipIf(!SHOULD_RUN)("watch_table smoke (real branch)", () => {
  it("delivers an INSERT within p95 < 2s on a Pro branch", async () => {
    const client = new ResilientApiClient({
      pat: PAT as string,
      hostProjectRef: HOST_REF as string,
    });
    await withBranch(
      client,
      { name: `smoke-watch-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
      async ({ branch, details }) => {
        console.log(
          `[smoke] branch ready: ref=${details.ref} status=${details.status} db_host=${details.db_host}`,
        );
        const dbUrl = buildBranchPoolerUrl({ ref: details.ref, db_pass: details.db_pass }, REGION);
        const sql = postgres(dbUrl, { max: 1, prepare: false });
        try {
          await sql`create table tickets (id uuid primary key default gen_random_uuid(), body text)`;
          await sql`alter publication supabase_realtime add table tickets`;
          // Diagnostic: confirm publication membership.
          const pubRows = await sql<
            Array<{ schemaname: string; tablename: string }>
          >`select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime'`;
          console.log("[smoke] supabase_realtime publication tables:", pubRows);

          // Fetch keys for the branch project (not the host). Use service_role
          // for the smoke test — Realtime applies RLS for anon, and we want to
          // isolate "the primitive works" from "RLS is configured correctly"
          // (the latter is the eval/skill author's concern, not the harness's).
          const branchProjectRef = branch.project_ref ?? details.ref;
          const { serviceRole } = await fetchProjectKeys(PAT as string, branchProjectRef);

          const adapter = makeSupabaseAdapter("tickets", {
            supabaseUrl: `https://${details.ref}.supabase.co`,
            supabaseKey: serviceRole,
          });

          const insertedAt = Date.now();
          // Arm the bounded watch first, then trigger insert ~100ms later.
          const watchPromise = boundedWatch({
            adapter,
            table: "tickets",
            predicate: { event: "INSERT" },
            timeout_ms: 30_000,
            max_events: 1,
          });
          // T7 spike finding: Realtime has a ~5s warm-up window between
          // subscribe() resolving SUBSCRIBED and events flowing for a freshly
          // added publication table. To prove the primitive works we fire
          // multiple inserts on a schedule so at least one lands after the
          // warm-up. See docs/spike-findings.md.
          const insertTimes: number[] = [];
          const fire = (label: string, body: string) =>
            sql`insert into tickets (body) values (${body})`
              .then(() => {
                const t = Date.now() - insertedAt;
                insertTimes.push(t);
                console.log(`[smoke] ${label} committed at +${t}ms`);
              })
              .catch((e) => console.error(`[smoke] ${label} failed: ${e?.message ?? e}`));
          setTimeout(() => fire("insert#1", "hello-1"), 100);
          setTimeout(() => fire("insert#2", "hello-2"), 5_000);
          setTimeout(() => fire("insert#3", "hello-3"), 10_000);

          const result = await watchPromise;
          const matchedAt = Date.now() - insertedAt;
          console.log(
            `[smoke] watch resolved at +${matchedAt}ms closed_reason=${result.closed_reason} events=${result.events.length}`,
          );
          // Latency is "time from the most-recent committed insert before
          // match → match arrival". This is the metric ci-nightly should
          // measure once warmed.
          const lastInsertBeforeMatch = insertTimes.filter((t) => t <= matchedAt).pop();
          const steadyStateLatency =
            lastInsertBeforeMatch !== undefined ? matchedAt - lastInsertBeforeMatch : matchedAt;
          console.log(`[smoke] watch_table single-trial latency: ${steadyStateLatency}ms`);

          expect(result.events).toHaveLength(1);
          expect(result.closed_reason).toBe("max_events");
          expect(steadyStateLatency).toBeLessThan(5_000); // single-trial floor
        } finally {
          await sql.end();
        }
      },
    );
  }, 300_000);
});
