// tests/smoke/subscribe.smoke.test.ts
//
// End-to-end smoke for subscribe_to_channel: arm a bounded subscription via
// the tool against a real Supabase branch, send a broadcast from a SEPARATE
// client a few seconds later, and confirm it arrives.
//
// Skips automatically when EVAL_SUPABASE_PAT or EVAL_HOST_PROJECT_REF is
// missing.
//
// Mirrors broadcast.smoke.test.ts harness shape:
//  - ResilientApiClient (404-tolerant getBranchDetails post-create)
//  - fetchProjectKeys helper for branch keys
//  - service_role key (RLS bypass; isolates "primitive works" from "RLS
//    configured correctly")
//  - TWO supabase clients: one inside makeSupabaseBroadcastAdapter (built
//    via handleSubscribe's adapterFor), one explicit sender. realtime-js
//    dedupes channel handles by topic on a single client, so a same-client
//    sender's `subscribe()` callback would never re-fire — see broadcast
//    smoke test for the same pattern.
//  - 3s setTimeout before sender broadcasts: gives the listener channel
//    time to land SUBSCRIBED + warm up. T13 broadcast smoke uses 5s after
//    the send for receipt; this delay is on the send side, before any
//    receive-side wait, so 3s is the warm-up margin (not the receive margin).

import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { makeSupabaseBroadcastAdapter } from "../../src/server/realtime-client.ts";
import { handleSubscribe } from "../../src/server/subscribe.ts";
import { withBranch } from "../../vendor/foundation/branch.ts";
import { fetchProjectKeys } from "./_helpers/project-keys.ts";
import { ResilientApiClient } from "./_helpers/resilient-api-client.ts";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";
const SHOULD_RUN = !!(PAT && HOST_REF);

describe.skipIf(!SHOULD_RUN)("subscribe_to_channel smoke (real branch)", () => {
  it("receives a broadcast sent in parallel", async () => {
    const apiClient = new ResilientApiClient({
      pat: PAT as string,
      hostProjectRef: HOST_REF as string,
    });
    await withBranch(
      apiClient,
      { name: `smoke-sub-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
      async ({ branch, details }) => {
        console.log(
          `[smoke] branch ready: ref=${details.ref} status=${details.status} db_host=${details.db_host}`,
        );

        const branchProjectRef = branch.project_ref ?? details.ref;
        const { serviceRole } = await fetchProjectKeys(PAT as string, branchProjectRef);
        const supabaseUrl = `https://${details.ref}.supabase.co`;

        // Listener client lives inside the adapter (built by adapterFor).
        // Sender client is a fresh, independent createClient() — separate
        // websocket connection so realtime-js won't dedupe the channel.
        const subPromise = handleSubscribe(
          {
            channel: "test:sub",
            event_filter: "ping",
            timeout_ms: 15_000,
            max_events: 1,
          },
          {
            adapterFor: () =>
              makeSupabaseBroadcastAdapter({ supabaseUrl, supabaseKey: serviceRole }),
          },
        );

        // Send a broadcast 3s later from a DIFFERENT client.
        setTimeout(async () => {
          const sender = createClient(supabaseUrl, serviceRole);
          const ch = sender.channel("test:sub");
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
          await ch.send({ type: "broadcast", event: "ping", payload: { ok: true } });
          console.log("[smoke] sender ch.send returned");
          await sender.removeChannel(ch);
        }, 3_000);

        const result = await subPromise;
        console.log(
          `[smoke] result.broadcasts.length=${result.broadcasts.length} closed_reason=${result.closed_reason}`,
        );
        expect(result.broadcasts.length).toBeGreaterThanOrEqual(1);
        expect(result.broadcasts[0]?.event).toBe("ping");
      },
    );
  }, 300_000);
});
