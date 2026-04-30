// tests/smoke/broadcast.smoke.test.ts
//
// End-to-end smoke for broadcast_to_channel: send a message via the tool and
// confirm it arrives on a parallel subscription against a real Supabase branch.
//
// Skips automatically when EVAL_SUPABASE_PAT or EVAL_HOST_PROJECT_REF is
// missing (matches supabase-mcp-evals' smoke convention).
//
// Mirrors watch-table.smoke.test.ts harness shape:
//  - ResilientApiClient (404-tolerant getBranchDetails post-create)
//  - fetchProjectKeys helper for branch keys (NOT details.anon_key — that
//    field doesn't exist on BranchDetails)
//  - service_role key (RLS bypass; isolates "primitive works" from "RLS
//    configured correctly")
//  - 5s wait between send and assertion (T7 finding was for postgres-changes
//    publications; broadcast may be faster, but warm-up margin keeps the
//    test from flaking on cold-start)

import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { type BroadcastSender, handleBroadcast } from "../../src/server/broadcast.ts";
import { withBranch } from "../../vendor/foundation/branch.ts";
import { fetchProjectKeys } from "./_helpers/project-keys.ts";
import { ResilientApiClient } from "./_helpers/resilient-api-client.ts";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";
const SHOULD_RUN = !!(PAT && HOST_REF);

describe.skipIf(!SHOULD_RUN)("broadcast_to_channel smoke (real branch)", () => {
  it("a sent broadcast is received on a parallel subscription", async () => {
    const apiClient = new ResilientApiClient({
      pat: PAT as string,
      hostProjectRef: HOST_REF as string,
    });
    await withBranch(
      apiClient,
      { name: `smoke-bcast-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
      async ({ branch, details }) => {
        console.log(
          `[smoke] branch ready: ref=${details.ref} status=${details.status} db_host=${details.db_host}`,
        );

        const branchProjectRef = branch.project_ref ?? details.ref;
        const { serviceRole } = await fetchProjectKeys(PAT as string, branchProjectRef);

        // Two distinct supabase clients — realtime-js dedupes channel
        // instances by topic on a single client, so the sender's
        // `supabase.channel("test:bcast")` would return the listener's
        // already-subscribed handle and the sender's `subscribe()` callback
        // would never re-fire. Separate clients give us fully independent
        // websocket connections, which is also the realistic shape: in
        // production the listener and the sender are different processes.
        const supabaseUrl = `https://${details.ref}.supabase.co`;
        const listenerClient = createClient(supabaseUrl, serviceRole);
        const senderClient = createClient(supabaseUrl, serviceRole);

        const channel = listenerClient.channel("test:bcast");
        const received: unknown[] = [];
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("subscribe timeout")), 10_000);
          channel
            .on("broadcast", { event: "ping" }, (payload) => received.push(payload))
            .subscribe((status) => {
              console.log(`[smoke] listener subscribe status=${status}`);
              if (status === "SUBSCRIBED") {
                clearTimeout(timer);
                resolve();
              }
            });
        });
        console.log("[smoke] listener subscribed");

        const sender: BroadcastSender = {
          send: async (input) => {
            const ch = senderClient.channel(input.channel);
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("sender subscribe timeout")), 10_000);
              ch.subscribe((s) => {
                console.log(`[smoke] sender subscribe status=${s}`);
                if (s === "SUBSCRIBED") {
                  clearTimeout(timer);
                  resolve();
                }
              });
            });
            await ch.send({ type: "broadcast", event: input.event, payload: input.payload });
            console.log("[smoke] sender ch.send returned");
            await senderClient.removeChannel(ch);
            return { status: "ok" };
          },
        };

        const result = await handleBroadcast(
          { channel: "test:bcast", event: "ping", payload: { hello: "world" } },
          { sender },
        );
        expect(result.success).toBe(true);

        // 5s warm-up margin. T7's 5s finding was for postgres-changes
        // publications; broadcast is a different channel type and may not
        // suffer the same delay, but unverified — keep the wait conservative
        // until a future run confirms <500ms reliability.
        await new Promise((r) => setTimeout(r, 5_000));
        console.log(`[smoke] received.length=${received.length}`);
        expect(received.length).toBeGreaterThanOrEqual(1);
        await listenerClient.removeChannel(channel);
      },
    );
  }, 300_000);
});
