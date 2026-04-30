// tests/smoke/list-channels.smoke.test.ts
//
// list_channels is best-effort. The smoke just asserts: (a) the tool returns
// a well-formed response, (b) channels we joined in this session appear in
// the result via a stubbed registry.
//
// The registry is stubbed (mirrors the channels we just joined) — the
// "real" registry is server-process state that's not in scope for this
// milestone. The value of this smoke is that it exercises the supabase-js
// channel-join path against a real branch end-to-end, even if the registry
// itself is not the SUT here.
//
// Mirrors broadcast/subscribe smoke harness shape:
//  - ResilientApiClient (404-tolerant getBranchDetails post-create)
//  - fetchProjectKeys helper for branch keys
//  - service_role key (RLS bypass; isolates "primitive works" from "RLS
//    configured correctly")

import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { handleListChannels } from "../../src/server/list-channels.ts";
import { withBranch } from "../../vendor/foundation/branch.ts";
import { fetchProjectKeys } from "./_helpers/project-keys.ts";
import { ResilientApiClient } from "./_helpers/resilient-api-client.ts";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";
const SHOULD_RUN = !!(PAT && HOST_REF);

describe.skipIf(!SHOULD_RUN)("list_channels smoke (real branch)", () => {
  it("returns at least the channels we just joined", async () => {
    const apiClient = new ResilientApiClient({
      pat: PAT as string,
      hostProjectRef: HOST_REF as string,
    });
    await withBranch(
      apiClient,
      { name: `smoke-list-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
      async ({ branch, details }) => {
        console.log(
          `[smoke] branch ready: ref=${details.ref} status=${details.status} db_host=${details.db_host}`,
        );

        const branchProjectRef = branch.project_ref ?? details.ref;
        const { serviceRole } = await fetchProjectKeys(PAT as string, branchProjectRef);
        const supabaseUrl = `https://${details.ref}.supabase.co`;
        const supabase = createClient(supabaseUrl, serviceRole);

        const joined: string[] = [];
        for (const name of ["test:a", "test:b"]) {
          const ch = supabase.channel(name);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`subscribe timeout: ${name}`)), 10_000);
            ch.subscribe((s) => {
              console.log(`[smoke] subscribe status=${s} channel=${name}`);
              if (s === "SUBSCRIBED") {
                clearTimeout(timer);
                resolve();
              }
            });
          });
          joined.push(name);
        }

        const result = await handleListChannels(
          {},
          {
            registry: async () =>
              joined.map((name) => ({ name, member_count: 1, last_event_at: null })),
          },
        );
        console.log(`[smoke] result.channels.length=${result.channels.length}`);
        expect(result.channels.map((c) => c.name)).toEqual(expect.arrayContaining(joined));

        for (const ch of supabase.getChannels()) {
          await supabase.removeChannel(ch);
        }
      },
    );
  }, 300_000);
});
