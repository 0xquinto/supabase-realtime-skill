// src/foundation/branch.ts
//
// Per-sample branch lifecycle. Async-disposable pattern: create, poll
// until ACTIVE_HEALTHY (or fail), yield BranchContext to the body, then
// always tear down — even on exception.
//
// Identity (id, name) comes from POST /v1/projects/{ref}/branches and
// is preserved across polls. Readiness comes from GET /v1/branches/{id}
// (different endpoint, different shape, no id/name field) — see
// docs/decisions/0009-branch-api-shapes.md if/when it lands.

import type { ApiClient, BranchDetails, BranchRecord } from "./api-client";

const READY_STATUSES = new Set(["ACTIVE_HEALTHY", "ACTIVE", "READY"]);
const FAILED_STATUSES = new Set(["FAILED", "INACTIVE"]);

export interface BranchContext {
  branch: BranchRecord;
  details: BranchDetails;
}

export interface WithBranchOptions {
  name: string;
  region?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

// Construct a Supavisor pooler URL from branch details + region.
// BranchDetails.db_host is db.<ref>.supabase.co — IPv6-only (CLAUDE.md
// non-obvious pattern); the pooler host aws-1-<region>.pooler.supabase.com:6543
// with user postgres.<ref> is IPv4-routable.
export function buildBranchPoolerUrl(
  details: { ref: string; db_pass: string | undefined },
  region: string,
): string {
  if (!details.ref) throw new Error("buildBranchPoolerUrl: details.ref is required");
  if (!details.db_pass) throw new Error("buildBranchPoolerUrl: details.db_pass is required");
  const host = `aws-1-${region}.pooler.supabase.com`;
  const user = `postgres.${details.ref}`;
  const pwd = encodeURIComponent(details.db_pass);
  return `postgresql://${user}:${pwd}@${host}:6543/postgres`;
}

export async function withBranch<T>(
  client: ApiClient,
  opts: WithBranchOptions,
  body: (ctx: BranchContext) => Promise<T>,
): Promise<T> {
  const pollIntervalMs = opts.pollIntervalMs ?? 15_000;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 180_000;

  const branch = await client.createBranch({
    name: opts.name,
    ...(opts.region ? { region: opts.region } : {}),
  });

  try {
    const started = Date.now();
    let details = await client.getBranchDetails(branch.id);
    while (!READY_STATUSES.has(details.status ?? "")) {
      if (FAILED_STATUSES.has(details.status ?? "")) {
        throw new Error(`branch ${branch.id} entered failed status ${details.status}`);
      }
      if (Date.now() - started > pollTimeoutMs) {
        throw new Error(`branch ${branch.id} did not become ready within ${pollTimeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      details = await client.getBranchDetails(branch.id);
    }

    return await body({ branch, details });
  } finally {
    await client.deleteBranch(branch.id).catch(() => {
      console.warn(`branch ${branch.id} teardown failed (continuing)`);
    });
  }
}
