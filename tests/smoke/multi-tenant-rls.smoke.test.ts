// tests/smoke/multi-tenant-rls.smoke.test.ts
//
// Multi-tenant RLS smoke test: provisions one branch with two real auth.users,
// two organizations, two memberships, and a tenant-scoped table with RLS
// policies. Subscribes via the user's forwarded JWT (NOT serviceRole) and
// asserts:
//
//   (a) User A subscribed under JWT_A receives events for rows in tenant_a
//       within 30s. This is the diagnostic — if it fails, the JWT isn't
//       reaching the websocket leg and Realtime is evaluating RLS against
//       the anon claims_role (which has no policy), so the event is dropped.
//
//   (b) User A subscribed under JWT_A does NOT receive events for rows in
//       tenant_b within 5s after a known cross-tenant insert. This is the
//       contract — RLS-enforced cross-tenant isolation.
//
// Pre-fix (current code): assertion (a) FAILS — global.headers.Authorization
// doesn't propagate to the websocket; supabase-js' _getAccessToken falls back
// to supabaseKey (anon), Realtime evaluates RLS against anon, no anon policy
// exists, no events delivered. Assertion (b) vacuously passes.
//
// Post-fix (client.realtime.setAuth(token) called after createClient):
// assertion (a) PASSES (A sees own-tenant events), (b) PASSES (RLS blocks B's).
//
// Cost: one Pro branch (~3min provisioning), runs end-to-end in ~60-90s after
// branch is up. Skips when EVAL_SUPABASE_PAT / EVAL_HOST_PROJECT_REF missing.

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { boundedWatch, makeSupabaseAdapter } from "../../src/server/realtime-client.ts";
import { buildBranchPoolerUrl, withBranch } from "../../vendor/foundation/branch.ts";
import { fetchProjectKeys } from "./_helpers/project-keys.ts";
import { ResilientApiClient } from "./_helpers/resilient-api-client.ts";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";
const SHOULD_RUN = !!(PAT && HOST_REF);

describe.skipIf(!SHOULD_RUN)("multi-tenant RLS smoke (real branch, two tenants)", () => {
  it("tenant A's JWT sees own-tenant events and not cross-tenant events", async () => {
    const client = new ResilientApiClient({
      pat: PAT as string,
      hostProjectRef: HOST_REF as string,
    });
    await withBranch(
      client,
      { name: `smoke-mt-rls-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
      async ({ branch, details }) => {
        console.log(
          `[smoke] branch ready: ref=${details.ref} status=${details.status} db_host=${details.db_host}`,
        );
        const dbUrl = buildBranchPoolerUrl({ ref: details.ref, db_pass: details.db_pass }, REGION);
        const sql = postgres(dbUrl, { max: 1, prepare: false });

        try {
          // ---------- Schema with RLS ----------
          // memberships table: user ↔ tenant. RLS policy: users see own
          // memberships only.
          await sql`
              create table memberships (
                user_id uuid references auth.users(id) on delete cascade,
                tenant_id uuid not null,
                primary key (user_id, tenant_id)
              )
            `;
          await sql`alter table memberships enable row level security`;
          await sql`
              create policy "users see own memberships" on memberships
                for select to authenticated
                using (user_id = (select auth.uid()))
            `;

          // audit_events table: tenant-scoped. RLS policy: authenticated
          // users see only events for tenants they are a member of. NO
          // policy for anon — under the bug (anon claims_role on websocket),
          // anon will see nothing and assertion (a) below will FAIL.
          await sql`
              create table audit_events (
                id uuid primary key default gen_random_uuid(),
                tenant_id uuid not null,
                event_type text not null,
                payload jsonb not null default '{}',
                created_at timestamptz not null default now()
              )
            `;
          await sql`create index on audit_events (tenant_id)`;
          await sql`alter table audit_events enable row level security`;
          await sql`
              create policy "tenant members can read audit_events" on audit_events
                for select to authenticated
                using (
                  tenant_id in (
                    select tenant_id from memberships where user_id = (select auth.uid())
                  )
                )
            `;
          await sql`alter publication supabase_realtime add table audit_events`;

          // ---------- Two real users + JWTs ----------
          const branchProjectRef = branch.project_ref ?? details.ref;
          const { anon, serviceRole } = await fetchProjectKeys(PAT as string, branchProjectRef);
          const supabaseUrl = `https://${details.ref}.supabase.co`;

          // Service-role client for admin operations (createUser, inserts).
          const admin = createClient(supabaseUrl, serviceRole, {
            auth: { persistSession: false, autoRefreshToken: false },
          });

          const tenantA = crypto.randomUUID();
          const tenantB = crypto.randomUUID();
          const passwordA = `smoke-test-pass-A-${crypto.randomUUID()}`;
          const passwordB = `smoke-test-pass-B-${crypto.randomUUID()}`;
          const emailA = `tenant-a-${Date.now()}@example.com`;
          const emailB = `tenant-b-${Date.now()}@example.com`;

          const { data: userAData, error: userAErr } = await admin.auth.admin.createUser({
            email: emailA,
            password: passwordA,
            email_confirm: true,
          });
          if (userAErr || !userAData.user) {
            throw new Error(`createUser A failed: ${userAErr?.message}`);
          }
          const userA = userAData.user;

          const { data: userBData, error: userBErr } = await admin.auth.admin.createUser({
            email: emailB,
            password: passwordB,
            email_confirm: true,
          });
          if (userBErr || !userBData.user) {
            throw new Error(`createUser B failed: ${userBErr?.message}`);
          }
          const userB = userBData.user;

          // Memberships: A → tenantA, B → tenantB.
          await sql`
              insert into memberships (user_id, tenant_id)
              values (${userA.id}::uuid, ${tenantA}::uuid),
                     (${userB.id}::uuid, ${tenantB}::uuid)
            `;
          console.log(
            `[smoke] users: A=${userA.id.slice(0, 8)} (tenant_a=${tenantA.slice(0, 8)}), B=${userB.id.slice(0, 8)} (tenant_b=${tenantB.slice(0, 8)})`,
          );

          // Sign in as user A to get a real JWT (not the anon key).
          const authClientA = createClient(supabaseUrl, anon, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const { data: sessionA, error: signinAErr } = await authClientA.auth.signInWithPassword({
            email: emailA,
            password: passwordA,
          });
          if (signinAErr || !sessionA.session) {
            throw new Error(`signIn A failed: ${signinAErr?.message}`);
          }
          const jwtA = sessionA.session.access_token;
          console.log(`[smoke] JWT A obtained (length=${jwtA.length})`);

          // ---------- Subscribe under JWT A's identity ----------
          // Pass anon as supabaseKey + JWT_A as authToken — mirrors the
          // production Edge Function flow where the function passes its
          // own anon key plus the forwarded user JWT.
          const adapterA = makeSupabaseAdapter("audit_events", {
            supabaseUrl,
            supabaseKey: anon,
            authToken: jwtA,
            subscribeTimeoutMs: 15_000,
          });

          const t0 = Date.now();
          const watchPromise = boundedWatch({
            adapter: adapterA,
            table: "audit_events",
            predicate: { event: "INSERT" },
            timeout_ms: 30_000,
            max_events: 5,
          });

          // Realtime warm-up: T7 finding says 5s warm-up window. We fire
          // a sequence of inserts on a schedule so at least one lands
          // post-warmup.
          const insertTimers: ReturnType<typeof setTimeout>[] = [];
          const fireInsert = (
            label: string,
            tenantId: string,
            eventType: string,
            delayMs: number,
          ) =>
            new Promise<void>((resolve) => {
              insertTimers.push(
                setTimeout(async () => {
                  try {
                    await sql`
                        insert into audit_events (tenant_id, event_type, payload)
                        values (${tenantId}::uuid, ${eventType}, ${JSON.stringify({ label })}::jsonb)
                      `;
                    const elapsed = Date.now() - t0;
                    console.log(
                      `[smoke] insert ${label} (tenant=${tenantId.slice(0, 8)}) committed at +${elapsed}ms`,
                    );
                  } catch (e) {
                    console.error(`[smoke] insert ${label} failed:`, e);
                  }
                  resolve();
                }, delayMs),
              );
            });

          // Insert plan: tenant_b inserts (cross-tenant) and tenant_a
          // inserts (own-tenant) on a staggered schedule. boundedWatch
          // collects up to 5 events or until 30s timeout.
          //
          // Under the bug: ZERO events arrive at A's listener (anon role,
          // no policy). max_events never reached, closed_reason = "timeout".
          //
          // Under the fix: 3 tenant_a inserts arrive (events for own
          // tenant), tenant_b inserts blocked by RLS. Result.events.length
          // should be exactly 3 (A's three own-tenant events), all with
          // tenant_id === tenantA.
          void fireInsert("warmup_a1", tenantA, "warmup", 1_000);
          void fireInsert("cross_b1", tenantB, "should-not-leak-to-A", 6_000);
          void fireInsert("own_a1", tenantA, "audit", 8_000);
          void fireInsert("cross_b2", tenantB, "should-not-leak-to-A", 10_000);
          void fireInsert("own_a2", tenantA, "audit", 12_000);

          const result = await watchPromise;
          const elapsed = Date.now() - t0;
          console.log(
            `[smoke] watch resolved at +${elapsed}ms closed_reason=${result.closed_reason} events_count=${result.events.length}`,
          );
          for (const ev of result.events) {
            const newRow = ev.new as Record<string, unknown>;
            console.log(
              `[smoke]   event tenant_id=${String(newRow.tenant_id).slice(0, 8)} event_type=${newRow.event_type}`,
            );
          }

          // ---------- Assertions ----------

          // Assertion (a) — the DIAGNOSTIC. Under bug: zero events. Under
          // fix: at least one own-tenant event arrived. We require ≥1
          // (not exactly 3) to absorb warmup-window jitter on the first
          // tenant_a insert.
          const ownTenantEvents = result.events.filter(
            (ev) => (ev.new as Record<string, unknown>).tenant_id === tenantA,
          );
          const crossTenantEvents = result.events.filter(
            (ev) => (ev.new as Record<string, unknown>).tenant_id === tenantB,
          );

          console.log(
            `[smoke] assertion summary: own_tenant_events=${ownTenantEvents.length}, cross_tenant_events=${crossTenantEvents.length}`,
          );

          // Assertion (b) — the CONTRACT. Cross-tenant events MUST NOT
          // reach A's listener under any code path. Vacuously passes
          // under the bug; falsifies the fix if violated.
          expect(crossTenantEvents).toHaveLength(0);

          // Assertion (a) — the DIAGNOSTIC. At least one own-tenant
          // event must arrive. FAILS under the bug; PASSES after fix.
          expect(ownTenantEvents.length).toBeGreaterThanOrEqual(1);

          for (const t of insertTimers) clearTimeout(t);
        } finally {
          await sql.end();
        }
      },
    );
  }, 360_000);
});
