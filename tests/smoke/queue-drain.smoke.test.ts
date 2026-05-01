// tests/smoke/queue-drain.smoke.test.ts
//
// End-to-end smoke for boundedQueueDrain composed against a real Supabase
// branch: real Postgres queue table, real Realtime adapter, real broadcast
// fan-out, real SQL ack. Mirrors watch-table.smoke.test.ts (queue table +
// publication + warm-up window) and broadcast.smoke.test.ts (two clients —
// realtime-js dedupes channels per client by topic).
//
// Skips automatically when EVAL_SUPABASE_PAT or EVAL_HOST_PROJECT_REF is
// missing (matches the rest of the smoke suite).

import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { BroadcastSender } from "../../src/server/broadcast.ts";
import { boundedQueueDrain } from "../../src/server/queue-drain.ts";
import { makeSupabaseAdapter } from "../../src/server/realtime-client.ts";
import { buildBranchPoolerUrl, withBranch } from "../../vendor/foundation/branch.ts";
import { fetchProjectKeys } from "./_helpers/project-keys.ts";
import { ResilientApiClient } from "./_helpers/resilient-api-client.ts";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";
const SHOULD_RUN = !!(PAT && HOST_REF);

interface QueueRowSchema {
  id: string;
  destination: string;
  event_type: string;
  payload: Record<string, unknown>;
}

describe.skipIf(!SHOULD_RUN)("boundedQueueDrain smoke (real branch)", () => {
  it("drains a queue row end-to-end: SQL insert → broadcast received → SQL ack persisted", async () => {
    const apiClient = new ResilientApiClient({
      pat: PAT as string,
      hostProjectRef: HOST_REF as string,
    });
    await withBranch(
      apiClient,
      { name: `smoke-qdrain-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
      async ({ branch, details }) => {
        console.log(
          `[smoke] branch ready: ref=${details.ref} status=${details.status} db_host=${details.db_host}`,
        );
        const dbUrl = buildBranchPoolerUrl({ ref: details.ref, db_pass: details.db_pass }, REGION);
        const sql = postgres(dbUrl, { max: 1, prepare: false });

        const branchProjectRef = branch.project_ref ?? details.ref;
        const { serviceRole } = await fetchProjectKeys(PAT as string, branchProjectRef);
        const supabaseUrl = `https://${details.ref}.supabase.co`;

        // Two clients — realtime-js dedupes channels by topic per client.
        // The broadcast listener and the broadcast sender must use distinct
        // clients (same gotcha broadcast.smoke.test.ts documents).
        const listenerClient = createClient(supabaseUrl, serviceRole);
        const senderClient = createClient(supabaseUrl, serviceRole);

        const insertTimers: ReturnType<typeof setTimeout>[] = [];
        try {
          // 1. Schema: queue table + publication. Default replica identity is
          //    enough for the queue-drain pattern (INSERT-only; payload.new
          //    carries the row). This is the documented divergence from
          //    watch_table's REPLICA IDENTITY FULL prerequisite — see
          //    references/replication-identity.md (pending update post
          //    queue-drain.md reference page).
          await sql`create table queue (
            id uuid primary key default gen_random_uuid(),
            destination text not null,
            event_type text not null,
            payload jsonb not null,
            forwarded_at timestamptz
          )`;
          await sql`alter publication supabase_realtime add table queue`;

          const adapter = makeSupabaseAdapter("queue", {
            supabaseUrl,
            supabaseKey: serviceRole,
          });

          // 2. Listener subscribes to the broadcast channel the row will
          //    target. Subscribed before the drain runs so the warm-up
          //    happens in parallel with boundedWatch's own warm-up.
          const targetChannel = "smoke:qdrain-target";
          const channel = listenerClient.channel(targetChannel);
          const received: Array<{ event: string; payload: unknown }> = [];
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("listener subscribe timeout")), 10_000);
            channel
              .on("broadcast", { event: "*" }, (msg) =>
                received.push({ event: msg.event, payload: msg.payload }),
              )
              .subscribe((status) => {
                console.log(`[smoke] listener subscribe status=${status}`);
                if (status === "SUBSCRIBED") {
                  clearTimeout(t);
                  resolve();
                }
              });
          });

          // 3. Sender wired the same shape broadcast.smoke.test.ts uses.
          const sender: BroadcastSender = {
            send: async (input) => {
              const ch = senderClient.channel(input.channel);
              await new Promise<void>((resolve, reject) => {
                const t = setTimeout(() => reject(new Error("sender subscribe timeout")), 10_000);
                ch.subscribe((s) => {
                  if (s === "SUBSCRIBED") {
                    clearTimeout(t);
                    resolve();
                  }
                });
              });
              await ch.send({ type: "broadcast", event: input.event, payload: input.payload });
              await senderClient.removeChannel(ch);
              return { status: "ok" };
            },
          };

          // 4. Fire multiple inserts to absorb the ~5s warm-up (T7 finding).
          //    boundedQueueDrain wraps boundedWatch, which has the same
          //    warm-up. We arm with max_events=1 so the first delivered
          //    event wins; the others stay in the queue (un-acked).
          const startedAt = Date.now();
          const fire = (label: string, body: Record<string, unknown>) =>
            sql`insert into queue (destination, event_type, payload) values (${targetChannel}, ${"qdrain.test"}, ${JSON.stringify(body)}::jsonb)`
              .then(() => {
                console.log(`[smoke] ${label} inserted at +${Date.now() - startedAt}ms`);
              })
              .catch((e) => console.error(`[smoke] ${label} insert failed: ${e?.message ?? e}`));
          insertTimers.push(setTimeout(() => fire("ins#1", { trial: 1 }), 500));
          insertTimers.push(setTimeout(() => fire("ins#2", { trial: 2 }), 5_500));
          insertTimers.push(setTimeout(() => fire("ins#3", { trial: 3 }), 10_500));

          // 5. Drain. ack callback persists forwarded_at via SQL UPDATE.
          //    Captured ids let us verify post-drain that the ack actually
          //    landed in Postgres (not just that the counter incremented).
          const ackedIds: string[] = [];
          const result = await boundedQueueDrain({
            adapter,
            table: "queue",
            read_row: (ev) => {
              const row = ev.new as unknown as QueueRowSchema;
              return {
                destination: row.destination,
                event: row.event_type,
                payload: row.payload,
              };
            },
            ack: async (ev) => {
              const id = (ev.new as unknown as QueueRowSchema).id;
              await sql`update queue set forwarded_at = now() where id = ${id}`;
              ackedIds.push(id);
            },
            sender,
            timeout_ms: 30_000,
            max_events: 1,
          });
          console.log(
            `[smoke] drain returned at +${Date.now() - startedAt}ms forwarded=${result.forwarded} dlq=${result.dead_lettered} failed=${result.failed} closed_reason=${result.closed_reason}`,
          );

          expect(result.forwarded).toBe(1);
          expect(result.dead_lettered).toBe(0);
          expect(result.failed).toBe(0);
          expect(result.closed_reason).toBe("max_events");
          expect(ackedIds).toHaveLength(1);

          // 6. Verify the SQL ack actually persisted (not just the counter).
          const ackedRows =
            await sql`select forwarded_at from queue where id = ${ackedIds[0] as string}`;
          const firstRow = ackedRows[0] as { forwarded_at: Date | null } | undefined;
          expect(firstRow?.forwarded_at).not.toBeNull();

          // 7. Listener receives the broadcast within a generous margin.
          //    Broadcast delivery is typically <500ms steady-state; allow
          //    5s of slack for cold-start and the second sender-channel
          //    subscribe handshake.
          await new Promise((r) => setTimeout(r, 5_000));
          console.log(`[smoke] listener received.length=${received.length}`);
          expect(received.length).toBeGreaterThanOrEqual(1);
          expect(received[0]?.event).toBe("qdrain.test");

          await listenerClient.removeChannel(channel);
        } finally {
          for (const t of insertTimers) clearTimeout(t);
          await sql.end();
        }
      },
    );
  }, 300_000);
});
