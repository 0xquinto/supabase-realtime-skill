// tests/smoke/multi-tenant-rls.smoke.test.ts
//
// Multi-tenant RLS smoke test: provisions one branch with two real auth.users,
// two memberships, a tenant-scoped audit_events table, and (for the broadcast
// half) realtime.messages RLS policies gating private-channel subscribe and
// send. Subscribes via the user's forwarded JWT (NOT serviceRole) and asserts
// two layers:
//
// LAYER 1 — Postgres-Changes RLS (ADR-0011):
//   (a) User A subscribed under JWT_A receives events for rows in tenant_a
//       within 30s. Diagnostic — if it fails, the JWT isn't reaching the
//       websocket leg and Realtime is evaluating RLS against anon claims_role.
//   (b) User A subscribed under JWT_A does NOT receive events for rows in
//       tenant_b. Contract — RLS-enforced cross-tenant isolation.
//
// LAYER 2 — Broadcast Authorization RLS (ADR-0013):
//   (c) User A subscribed to `tenant:<tenantA>:audit-feed` as a private
//       channel receives a broadcast that user A sent to that channel.
//       Diagnostic — confirms the realtime.messages RLS policy admits the
//       authorized path.
//   (d) User B trying to broadcast to `tenant:<tenantA>:audit-feed` is
//       rejected by realtime.messages RLS (no membership in tenant_a).
//       Contract — substrate enforces cross-tenant injection prevention.
//
// Pre-fix for layer 1: setAuth gap → assertion (a) FAILS.
// Pre-fix for layer 2: public channels (no `private: true` opt-in) → cross-
//   tenant inject succeeds, assertion (d) FAILS.
//
// Post-fix for both layers: all four assertions PASS.
//
// Cost: one Pro branch (~3min provisioning), runs end-to-end in ~90-120s
// after branch is up. Skips when EVAL_SUPABASE_PAT / EVAL_HOST_PROJECT_REF
// missing.

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { type BroadcastSender, handleBroadcast } from "../../src/server/broadcast.ts";
import {
  boundedSubscribe,
  boundedWatch,
  makeSupabaseAdapter,
  makeSupabaseBroadcastAdapter,
} from "../../src/server/realtime-client.ts";
import { buildBranchPoolerUrl, withBranch } from "../../vendor/foundation/branch.ts";
import { fetchProjectKeys } from "./_helpers/project-keys.ts";
import { ResilientApiClient } from "./_helpers/resilient-api-client.ts";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";
const SHOULD_RUN = !!(PAT && HOST_REF);

describe.skipIf(!SHOULD_RUN)("multi-tenant RLS smoke (real branch, two tenants)", () => {
  it("layer 1 (Postgres-Changes RLS): tenant A's JWT sees own-tenant events and not cross-tenant events", async () => {
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

          // ---------- Layer 2 setup: realtime.messages RLS for Broadcast Auth ----------
          // Helper: tenant_ids the JWT identity is a member of. SECURITY
          // DEFINER STABLE so the membership lookup is evaluated once per
          // connection (cached), not per message. This is the canonical
          // pattern documented in references/multi-tenant-rls.md.
          await sql`
              create or replace function public.user_tenant_ids()
              returns uuid[]
              language sql
              security definer
              stable
              as $$
                select coalesce(array_agg(tenant_id), '{}')
                from public.memberships
                where user_id = (select auth.uid())
              $$
            `;

          // SELECT policy: subscribe-time gate. User can join a topic shaped
          // `tenant:<uuid>:audit-feed` iff they're a member of that tenant.
          await sql`
              create policy "tenant members can subscribe to audit feed"
                on realtime.messages for select
                to authenticated
                using (
                  (string_to_array(realtime.topic(), ':'))[1] = 'tenant'
                  and ((string_to_array(realtime.topic(), ':'))[2])::uuid = any (public.user_tenant_ids())
                )
            `;

          // INSERT policy: send-time gate. Same shape — user can broadcast
          // to a tenant feed iff they're a member.
          await sql`
              create policy "tenant members can broadcast to audit feed"
                on realtime.messages for insert
                to authenticated
                with check (
                  (string_to_array(realtime.topic(), ':'))[1] = 'tenant'
                  and ((string_to_array(realtime.topic(), ':'))[2])::uuid = any (public.user_tenant_ids())
                )
            `;

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

          // Sign in user B too — needed for layer-2 (broadcast auth) where
          // B attempts a cross-tenant injection under their own JWT.
          const authClientB = createClient(supabaseUrl, anon, {
            auth: { persistSession: false, autoRefreshToken: false },
          });
          const { data: sessionB, error: signinBErr } = await authClientB.auth.signInWithPassword({
            email: emailB,
            password: passwordB,
          });
          if (signinBErr || !sessionB.session) {
            throw new Error(`signIn B failed: ${signinBErr?.message}`);
          }
          const jwtB = sessionB.session.access_token;
          console.log(`[smoke] JWT B obtained (length=${jwtB.length})`);

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

          // ===================================================================
          // LAYER 2 — Broadcast Authorization RLS (ADR-0013)
          //
          // Same branch, same users. Pre-fix the MCP primitives
          // (makeSupabaseBroadcastAdapter, handleBroadcast) construct
          // channels WITHOUT `private: true`, so realtime.messages RLS is
          // bypassed and B's cross-tenant injection leaks to A's listener.
          // Post-fix the `private` flag is threaded through both legs and
          // the substrate enforces.
          //
          // Test code is identical pre-fix and post-fix — zod's default
          // strips unknown fields, so passing `private: true` in the input
          // is silently ignored pre-fix and respected post-fix. The
          // production code is what changes; the test is the gate.
          // ===================================================================

          const audit_topic = `tenant:${tenantA}:audit-feed`;

          // A's listener: subscribe to A's tenant audit feed via the
          // production primitive. Pre-fix: public channel (no RLS gate at
          // subscribe). Post-fix: private channel (subscribe RLS evaluated;
          // A passes because A is a member of tenant_a).
          const broadcastAdapterA = makeSupabaseBroadcastAdapter({
            supabaseUrl,
            supabaseKey: anon,
            authToken: jwtA,
            subscribeTimeoutMs: 15_000,
          });

          const subscribePromise = boundedSubscribe({
            adapter: broadcastAdapterA,
            channel: audit_topic,
            timeout_ms: 20_000,
            max_events: 5,
            private: true,
          });

          // Give A's subscribe a moment to ack SUBSCRIBED before either
          // sender fires. boundedSubscribe doesn't expose a "subscribed"
          // signal; relying on the documented Realtime warmup window.
          await new Promise((r) => setTimeout(r, 6_000));

          // A's authorized broadcast: build a sender that mirrors the
          // production server.ts shape, parameterized by JWT. Pre-fix:
          // public channel, send goes through. Post-fix: private channel,
          // send goes through (A is a member). Both runs: A receives.
          // Sender factory: mirrors the production server.ts shape but
          // parameterized by JWT. Uses httpSend (post-ADR-0013) so the
          // sender exercises the same REST-side path the production
          // handler uses, threading the `private` flag at channel
          // construction time.
          const buildSender = (jwt: string): BroadcastSender => {
            return {
              send: async (input) => {
                const senderClient = createClient(supabaseUrl, anon, {
                  auth: { persistSession: false, autoRefreshToken: false },
                });
                senderClient.realtime.setAuth(jwt);
                const ch = input.private
                  ? senderClient.channel(input.channel, { config: { private: true } })
                  : senderClient.channel(input.channel);
                try {
                  await ch.httpSend(input.event, input.payload, { timeout: 10_000 });
                } finally {
                  await senderClient.removeChannel(ch);
                }
                return { status: "ok" };
              },
            };
          };

          const senderA = buildSender(jwtA);
          const senderB = buildSender(jwtB);

          // A's authorized send: should be received by A's listener.
          await handleBroadcast(
            {
              channel: audit_topic,
              event: "own",
              payload: { from: "A" },
              private: true,
            },
            { sender: senderA },
          );
          console.log("[smoke] A's authorized broadcast sent");

          // B's cross-tenant injection: pre-fix succeeds and leaks to A;
          // post-fix rejected by realtime.messages INSERT policy. We catch
          // because handleBroadcast retries 3× then throws ToolError.
          let bInjectionThrew = false;
          try {
            await handleBroadcast(
              {
                channel: audit_topic,
                event: "injection",
                payload: { from: "B" },
                private: true,
              },
              { sender: senderB },
            );
            console.log("[smoke] B's cross-tenant broadcast send returned (NO error)");
          } catch (err) {
            bInjectionThrew = true;
            console.log(
              `[smoke] B's cross-tenant broadcast threw (expected post-fix): ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          // Wait for any pending broadcasts to flush to A's listener.
          await new Promise((r) => setTimeout(r, 4_000));

          const subscribeResult = await subscribePromise;
          const ownBroadcasts = subscribeResult.broadcasts.filter((b) => b.event === "own");
          const injectionBroadcasts = subscribeResult.broadcasts.filter(
            (b) => b.event === "injection",
          );
          console.log(
            `[smoke] layer 2 summary: own_broadcasts=${ownBroadcasts.length}, injection_broadcasts=${injectionBroadcasts.length}, b_injection_threw=${bInjectionThrew}`,
          );

          // Assertion (c) — DIAGNOSTIC: A receives A's own authorized
          // broadcast. Both pre-fix and post-fix should pass; if it fails
          // pre-fix the smoke harness is broken in some unrelated way; if
          // it fails post-fix the realtime.messages SELECT policy isn't
          // admitting A.
          expect(ownBroadcasts.length).toBeGreaterThanOrEqual(1);

          // Assertion (d) — CONTRACT: B's cross-tenant injection MUST NOT
          // reach A's listener. FAILS pre-fix (public channels skip RLS,
          // injection leaks); PASSES post-fix (substrate rejects at the
          // INSERT policy on realtime.messages, B's send throws, nothing
          // delivered to A).
          expect(injectionBroadcasts).toHaveLength(0);
        } finally {
          await sql.end();
        }
      },
    );
  }, 360_000);
});
