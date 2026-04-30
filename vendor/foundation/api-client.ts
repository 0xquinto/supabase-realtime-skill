// src/foundation/api-client.ts
//
// Supabase Management API client. Wraps fetch with bearer auth and
// retry-with-jitter backoff on 403/429/5xx (the slice-2 mid-run
// hardening — ~60 req/min/account rate limit).
//
// Two response shapes you'll meet in this API:
// - POST /v1/projects/{ref}/branches  → BranchRecord (id, name, status, project_ref, ...)
// - GET  /v1/branches/{branchId}      → BranchDetails (ref, status, db_host, db_pass, jwt_secret, ...)
// They overlap on `status` but otherwise are distinct; a slice typically
// needs BOTH (id+name from create, db creds from getBranchDetails).

const SUPABASE_API_BASE = "https://api.supabase.com";
const RETRYABLE_STATUS = new Set([403, 429, 502, 503, 504]);

export interface ApiClientOptions {
  pat: string;
  hostProjectRef: string;
  baseUrl?: string;
  baseDelayMs?: number;
  maxAttempts?: number;
}

// Returned from POST /v1/projects/{ref}/branches and GET /v1/projects/{ref}/branches.
export interface BranchRecord {
  id: string;
  name: string;
  status?: string;
  project_ref?: string;
  parent_project_ref?: string;
  is_default?: boolean;
  persistent?: boolean;
}

// Returned from GET /v1/branches/{branchId}.
export interface BranchDetails {
  ref: string;
  status?: string;
  db_host?: string;
  db_port?: number;
  db_user?: string;
  db_pass?: string;
  jwt_secret?: string;
  postgres_version?: string;
}

interface CreateBranchInput {
  name: string;
  region?: string;
}

export class ApiClient {
  private readonly pat: string;
  private readonly hostProjectRef: string;
  private readonly baseUrl: string;
  private readonly baseDelayMs: number;
  private readonly maxAttempts: number;

  constructor(opts: ApiClientOptions) {
    this.pat = opts.pat;
    this.hostProjectRef = opts.hostProjectRef;
    this.baseUrl = opts.baseUrl ?? SUPABASE_API_BASE;
    this.baseDelayMs = opts.baseDelayMs ?? 2000;
    this.maxAttempts = opts.maxAttempts ?? 6;
  }

  async createBranch(input: CreateBranchInput): Promise<BranchRecord> {
    const url = `${this.baseUrl}/v1/projects/${this.hostProjectRef}/branches`;
    const body = JSON.stringify({
      branch_name: input.name,
      ...(input.region ? { region: input.region } : {}),
    });
    const res = await this.requestWithRetry(url, { method: "POST", body });
    return (await res.json()) as BranchRecord;
  }

  async getBranchDetails(branchId: string): Promise<BranchDetails> {
    const url = `${this.baseUrl}/v1/branches/${branchId}`;
    const res = await this.requestWithRetry(url, { method: "GET" });
    return (await res.json()) as BranchDetails;
  }

  async deleteBranch(branchId: string): Promise<void> {
    const url = `${this.baseUrl}/v1/branches/${branchId}`;
    await this.requestWithRetry(url, { method: "DELETE" });
  }

  async listBranches(): Promise<BranchRecord[]> {
    const url = `${this.baseUrl}/v1/projects/${this.hostProjectRef}/branches`;
    const res = await this.requestWithRetry(url, { method: "GET" });
    return (await res.json()) as BranchRecord[];
  }

  async getProjectRegion(projectRef: string): Promise<string> {
    const url = `${this.baseUrl}/v1/projects/${projectRef}`;
    const res = await this.requestWithRetry(url, { method: "GET" });
    const data = (await res.json()) as { region?: string };
    if (!data.region) throw new Error(`no region in project ${projectRef} response`);
    return data.region;
  }

  private async requestWithRetry(url: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.pat}`,
      "Content-Type": "application/json",
      ...((init.headers as Record<string, string>) ?? {}),
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const res = await fetch(url, { ...init, headers });
      if (res.ok) return res;
      if (!RETRYABLE_STATUS.has(res.status)) {
        const text = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText}: ${text}`);
      }
      lastError = new Error(`${res.status} ${res.statusText}`);
      if (attempt === this.maxAttempts) break;
      const baseBackoff = this.baseDelayMs * 2 ** (attempt - 1);
      const jitter = baseBackoff * (0.5 + Math.random() * 0.5);
      await new Promise((r) => setTimeout(r, Math.min(jitter, 32_000)));
    }
    throw lastError instanceof Error ? lastError : new Error("retry exhausted");
  }
}
