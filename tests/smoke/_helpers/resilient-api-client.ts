// tests/smoke/_helpers/resilient-api-client.ts
//
// Vendored ApiClient retries 403/429/5xx but not 404. There's a brief window
// after POST /v1/projects/{ref}/branches where GET /v1/branches/{id} returns
// 404 — the create record exists but the underlying project hasn't been
// provisioned far enough to expose the details endpoint. withBranch makes its
// first getBranchDetails call immediately, so it can hit that window. Wrap
// with a 404-tolerant retry; preserve all other behavior.
//
// Extracted from tests/smoke/watch-table.smoke.test.ts so T9 (eval/spike-latency.ts)
// can reuse without copy-paste. Per CLAUDE.md foundation-contract rule: this is
// test-local until T9 confirms shape; only hoist to vendor after that.
//
// vendored ApiClient error format: "<status> <statusText> <body>"
// If the vendor SHA bumps, recheck the is404 string check below.

import { ApiClient, type BranchDetails } from "../../../vendor/foundation/api-client";

export class ResilientApiClient extends ApiClient {
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
