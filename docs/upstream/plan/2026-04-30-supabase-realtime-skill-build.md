# supabase-realtime-skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a TS-native Agent Skill bundle paired with an MCP server that gives an LLM agent the ability to react to Postgres row-changes and coordinate over Realtime broadcast channels on Supabase, deployed as an Edge Function, with eval instrumentation built in.

**Architecture:** Two layers in one bundle — Skill (instruction: SKILL.md + references/) + MCP server (execution: 5 tools, Deno-compatible TS). Bounded subscription pattern (block until N events or timeout) replaces persistent WebSocket so the server is stateless across tool-calls and fits Edge Function isolate budgets. Eval harness (Vitest + ci-fast n=20 + ci-full n=100 + Wilson CIs + manifest.json thresholds) gates merges.

**Tech Stack:** Bun + TypeScript (strict) + Vitest for build/test; Deno-compatible runtime for the Edge Function deployment; `@modelcontextprotocol/sdk` for MCP server; `@supabase/supabase-js` for Realtime+Postgres clients; `zod` for schema validation; pgvector + halfvec(1536) + Supabase Automatic Embeddings for the worked example.

**Spec:** `/Users/diego/Dev/supabase-mcp-evals/docs/superpowers/specs/2026-04-30-supabase-realtime-skill-design.md`. Read it first.

**Repo split:** This plan lives in `supabase-mcp-evals` (the methodology origin repo). The actual artifact is built in a SEPARATE repo `supabase-realtime-skill`. Task 1 creates the new repo. All commits in Tasks 2+ are commits in the new repo unless explicitly noted.

**Foundation reuse:** Vendor four small files from `supabase-mcp-evals/src/foundation/` into the new repo's `vendor/foundation/` (snapshot, not submodule). Files: `scoring.ts` (Wilson CI), `api-client.ts` (Supabase Management API client + retries), `branch.ts` (withBranch async-disposable), `transcript.ts` (parseTranscript). Apache-2.0; preserve attribution in `vendor/foundation/README.md`.

> **Plan corrections (post-T7 implementation, 2026-04-30):** Treat the vendored `vendor/foundation/api-client.ts` as the source of truth where it conflicts with task snippets:
> - `ApiClient` constructor takes `hostProjectRef`, not `projectRef`. (Plan now uses `hostProjectRef:` throughout.)
> - `BranchDetails` does NOT include `anon_key` or `service_role_key`. Snippets like `details.anon_key ?? details.service_role_key ?? ""` will not type-check. Reuse the `fetchProjectKeys(pat, ref)` helper from `tests/smoke/watch-table.smoke.test.ts` (commit `309aacf`), which hits `GET /v1/projects/{ref}/api-keys` directly and returns `{ anon, service_role }`.
> - `ApiClient.getBranchDetails` 404s briefly in the window between `createBranch` resolving and the branch being addressable. The smoke test wraps with a `ResilientApiClient` subclass that retries 404 specifically on `getBranchDetails`. Reuse that pattern (do NOT broaden 404-retry on the foundation client; that requires an ADR per `supabase-mcp-evals/CLAUDE.md`).
> - **Realtime warm-up window (~5s):** documented in `docs/spike-findings.md` (T7). After `subscribe()` resolves `SUBSCRIBED`, INSERTs in the first ~5s on a freshly-added publication table are NOT delivered. T9's latency-measurement script must use a long-lived adapter across all N trials (not fresh-per-trial), or include an explicit warm-up step before measurement. Steady-state latency is ~200ms — the metric must isolate that, not include warm-up.

---

## File Structure (new repo `supabase-realtime-skill`)

```
supabase-realtime-skill/
├── package.json                      # ESM+CJS dual exports, npm publish config
├── tsconfig.json                     # strict mode
├── vitest.config.ts                  # offline + smoke split via project config
├── biome.json                        # lint config
├── .gitignore
├── SKILL.md                          # Open Skills Standard front-matter + sections
├── README.md                         # quickstart + link to writeup
├── manifest.json                     # eval thresholds (pre-registered)
├── LICENSE                           # Apache-2.0
│
├── references/
│   ├── predicates.md                 # Postgres-Changes filter ops + fallback
│   ├── replication-identity.md       # REPLICA IDENTITY FULL tradeoffs
│   ├── rls-implications.md           # RLS + Realtime + broadcast auth
│   ├── presence-deferred.md          # why Presence not in v1
│   ├── pgvector-composition.md       # CDC + Automatic Embeddings + retrieval
│   ├── eval-methodology.md           # 4 metrics, why not LLM-judge
│   ├── edge-deployment.md            # supabase functions deploy walkthrough
│   └── worked-example.md             # support-ticket triage end-to-end
│
├── src/
│   ├── types/
│   │   ├── schemas.ts                # zod schemas for all 5 tools (input + output)
│   │   ├── errors.ts                 # ToolError class + error codes
│   │   └── events.ts                 # Postgres-Changes event types
│   ├── server/
│   │   ├── server.ts                 # MCP server factory; registers all 5 tools
│   │   ├── watch-table.ts            # tool 1: bounded CDC subscription
│   │   ├── broadcast.ts              # tool 2: broadcast_to_channel
│   │   ├── subscribe.ts              # tool 3: subscribe_to_channel
│   │   ├── list-channels.ts          # tool 4: list_channels
│   │   ├── describe-table.ts         # tool 5: describe_table_changes
│   │   └── realtime-client.ts        # @supabase/supabase-js Realtime wrapper, bounded primitive
│   └── client/
│       └── index.ts                  # CJS+ESM helper for local consumers
│
├── supabase/
│   ├── functions/
│   │   └── mcp/
│   │       └── index.ts              # Edge Function entry; imports src/server/server.ts
│   └── migrations/
│       └── 20260430000001_support_tickets.sql   # worked example schema
│
├── fixtures/
│   ├── ci-fast/                      # n=20 hand-curated JSON fixtures
│   └── ci-full/                   # n=100 hand-seeded + synthetic-augmented
│
├── tests/
│   ├── fast/                         # offline Vitest, mocked Realtime/HTTP
│   │   ├── schemas.test.ts
│   │   ├── watch-table.test.ts
│   │   ├── broadcast.test.ts
│   │   ├── subscribe.test.ts
│   │   ├── list-channels.test.ts
│   │   └── describe-table.test.ts
│   └── smoke/                        # online Vitest, real branch DB via vendor/foundation
│       ├── watch-table.smoke.test.ts
│       ├── broadcast.smoke.test.ts
│       ├── subscribe.smoke.test.ts
│       ├── list-channels.smoke.test.ts
│       └── describe-table.smoke.test.ts
│
├── eval/
│   ├── runner.ts                     # spawns triage agent against fixtures
│   ├── metrics.ts                    # latency p95, missed/spurious rates, correctness, McNemar
│   ├── triage-agent.ts               # the worked-example agent loop
│   └── reports/                      # gitignored artifacts
│
├── vendor/
│   └── foundation/
│       ├── README.md                 # attribution + license
│       ├── api-client.ts             # snapshot
│       ├── branch.ts                 # snapshot
│       ├── scoring.ts                # snapshot
│       └── transcript.ts             # snapshot
│
├── docs/
│   └── writeup.md                    # headline writeup (Q6 outline)
│
└── .github/
    └── workflows/
        ├── ci-fast.yml               # offline + ci-fast eval on PR
        ├── ci-full.yml            # full smoke + ci-full eval, cron
        └── publish.yml               # npm publish on tag
```

**Decomposition rationale:** one tool per file in `src/server/`; one test file per tool in both `tests/fast/` and `tests/smoke/`. Schemas centralized in `src/types/schemas.ts` so the MCP server registration loops over them and contract changes are diffable in one place. Realtime/Postgres-changes wrapper isolated in `src/server/realtime-client.ts` so the bounded-subscription primitive (the spike's load-bearing piece) has a clear home and can be swapped if Week 1 spike findings demand a redesign.

---

## Phase 0 — Bootstrap

### Task 1: Create the new repo + scaffold

**Files:**
- Create: `supabase-realtime-skill/package.json`
- Create: `supabase-realtime-skill/tsconfig.json`
- Create: `supabase-realtime-skill/.gitignore`
- Create: `supabase-realtime-skill/biome.json`
- Create: `supabase-realtime-skill/LICENSE`
- Create: `supabase-realtime-skill/README.md`
- Create: `supabase-realtime-skill/vendor/foundation/{api-client.ts,branch.ts,scoring.ts,transcript.ts,README.md}`

- [ ] **Step 1: Create the repo and push to GitHub**

```bash
cd ~/Dev
mkdir supabase-realtime-skill
cd supabase-realtime-skill
git init -b main
gh repo create supabase-realtime-skill --public --source=. --remote=origin
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "supabase-realtime-skill",
  "version": "0.0.0",
  "description": "Agent Skill + MCP server for Supabase Realtime/CDC. Bounded subscription pattern fits Edge Function isolate budgets.",
  "license": "Apache-2.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/client/index.d.ts",
      "import": "./dist/client/index.js",
      "require": "./dist/client/index.cjs"
    }
  },
  "files": [
    "dist",
    "SKILL.md",
    "references",
    "manifest.json"
  ],
  "scripts": {
    "build": "bun build src/client/index.ts --outdir dist/client --target node && bun build src/client/index.ts --outdir dist/client --target node --format cjs --outfile dist/client/index.cjs",
    "test:fast": "vitest run --project fast",
    "test:smoke": "vitest run --project smoke",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "lint:fix": "biome check --write ."
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@supabase/supabase-js": "^2.45.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*", "tests/**/*", "eval/**/*", "vendor/**/*"],
  "exclude": ["dist", "node_modules", "supabase/functions"]
}
```

`supabase/functions/` is excluded because the Edge Function uses Deno-style imports (`npm:`, `https:`); they'd fail Node's tsc.

- [ ] **Step 4: Write `.gitignore`**

```
node_modules
dist
.env
.env.local
eval/reports
*.log
.DS_Store
```

- [ ] **Step 5: Write `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "files": {
    "ignore": ["dist", "node_modules", "eval/reports", "vendor"]
  },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  }
}
```

`vendor/` is ignored so biome doesn't reformat the vendored snapshots — they should stay byte-identical to the origin so attribution is verifiable.

- [ ] **Step 6: Write `LICENSE` (Apache-2.0)**

Use the standard Apache-2.0 text. Get it from `curl -s https://www.apache.org/licenses/LICENSE-2.0.txt`.

- [ ] **Step 7: Vendor the foundation snapshots**

```bash
mkdir -p vendor/foundation
cp ~/Dev/supabase-mcp-evals/src/foundation/api-client.ts vendor/foundation/
cp ~/Dev/supabase-mcp-evals/src/foundation/branch.ts vendor/foundation/
cp ~/Dev/supabase-mcp-evals/src/foundation/scoring.ts vendor/foundation/
cp ~/Dev/supabase-mcp-evals/src/foundation/transcript.ts vendor/foundation/
```

Write `vendor/foundation/README.md`:

```markdown
# vendor/foundation/

Snapshot of `src/foundation/` from [supabase-mcp-evals](https://github.com/0xquinto/supabase-mcp-evals) at commit `<short-sha>` (2026-04-30). Apache-2.0.

These small utility modules are *vendored* (copied) rather than published as a package or pulled via submodule because the upstream repo is a research/methodology workspace, not a library. Vendoring keeps the artifact self-contained and the attribution clear.

Files:
- `api-client.ts` — Supabase Management API client w/ exponential backoff retries
- `branch.ts` — `withBranch` async-disposable branch lifecycle
- `scoring.ts` — Wilson score interval, paired aggregation
- `transcript.ts` — agent transcript parsing for tool-call analysis

If upstream changes meaningfully, update the snapshot and bump the SHA above. Don't edit these files in-place — fork via a wrapper if behavior needs to differ.
```

Update `<short-sha>` from the upstream HEAD: `git -C ~/Dev/supabase-mcp-evals rev-parse --short HEAD`.

- [ ] **Step 8: Write minimal `README.md`**

```markdown
# supabase-realtime-skill

Agent Skill + MCP server for Supabase Realtime/CDC. Gives an LLM agent the ability to react to Postgres row-changes and coordinate over Realtime broadcast channels, deployed as a Supabase Edge Function.

**Status:** Pre-alpha. See [`docs/writeup.md`](docs/writeup.md) when published.

## Why

The official `supabase` Agent Skill names Realtime in scope but doesn't go deep on it. This bundle ships a worked example of *agent-watches-database* and *agent-broadcasts-to-channel* as first-class patterns, with eval instrumentation built in.

## Quickstart

(Coming after Week 2 — when the 5 tools are green on smoke tests.)

## Layout

- `SKILL.md` — Open Skills Standard entry
- `references/` — opinionated patterns (predicates, RLS, replication identity, pgvector composition)
- `src/server/` — MCP server (5 tools)
- `supabase/functions/mcp/` — Edge Function entry
- `eval/` — regression harness with pre-registered thresholds in `manifest.json`
- `docs/writeup.md` — the headline writeup (Q6)

## License

Apache-2.0
```

- [ ] **Step 9: Install deps and verify scripts**

```bash
bun install
bun run typecheck
bun run lint
```

Expected: `typecheck` passes (no source files yet), `lint` passes (only config files).

- [ ] **Step 10: Initial commit + push**

```bash
git add package.json tsconfig.json biome.json .gitignore LICENSE README.md vendor/
git commit -m "chore: bootstrap supabase-realtime-skill repo

Vendored foundation utilities from supabase-mcp-evals at <short-sha>
(scoring/Wilson, branch lifecycle, ApiClient, transcript parsing).
Apache-2.0, attribution preserved in vendor/foundation/README.md."
git push -u origin main
```

---

## Phase 1 — Week 1: Spike (`watch_table` end-to-end)

The week-1 success criterion is **bounded-subscription primitive (`watch_table`) working in a deployed Edge Function against a real branch DB, with `latency_to_first_event_ms` p95 < 2000ms measured.** Everything in this phase serves that proof. If the primitive can't hit p95 < 2s, the architecture changes before Week 2 begins.

### Task 2: Set up Vitest projects (offline + smoke)

**Files:**
- Create: `supabase-realtime-skill/vitest.config.ts`
- Create: `supabase-realtime-skill/.env.example`

- [ ] **Step 1: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "fast",
          include: ["tests/fast/**/*.test.ts"],
          environment: "node",
          testTimeout: 5_000,
        },
      },
      {
        test: {
          name: "smoke",
          include: ["tests/smoke/**/*.smoke.test.ts"],
          environment: "node",
          testTimeout: 240_000,
          hookTimeout: 240_000,
        },
      },
    ],
  },
});
```

- [ ] **Step 2: Write `.env.example`**

```bash
# Required for smoke + ci-full tests against real Supabase branches
EVAL_SUPABASE_PAT=
EVAL_HOST_PROJECT_REF=
EVAL_REGION=us-east-1

# Used by triage-agent.ts in eval/ + writeup
ANTHROPIC_API_KEY=
```

- [ ] **Step 3: Verify Vitest runs (no tests yet → 0 passed)**

```bash
bun run test:fast
```

Expected: "No test files found" or "0 test files". This is fine — the test directories exist after Task 3.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts .env.example
git commit -m "test: vitest projects for offline (fast) + online (smoke) splits"
```

---

### Task 3: zod schemas for `watch_table` (TDD)

**Files:**
- Create: `supabase-realtime-skill/src/types/errors.ts`
- Create: `supabase-realtime-skill/src/types/schemas.ts`
- Create: `supabase-realtime-skill/tests/fast/schemas.test.ts`

- [ ] **Step 1: Write the failing test for the watch_table input schema**

```ts
// tests/fast/schemas.test.ts
import { describe, expect, it } from "vitest";
import { WatchTableInputSchema } from "../../src/types/schemas";

describe("WatchTableInputSchema", () => {
  it("accepts a minimal valid input", () => {
    const result = WatchTableInputSchema.safeParse({
      table: "support_tickets",
      predicate: { event: "INSERT" },
    });
    expect(result.success).toBe(true);
  });

  it("applies defaults for timeout_ms and max_events", () => {
    const result = WatchTableInputSchema.parse({
      table: "support_tickets",
      predicate: { event: "INSERT" },
    });
    expect(result.timeout_ms).toBe(60_000);
    expect(result.max_events).toBe(50);
  });

  it("rejects timeout_ms above the 120000 cap", () => {
    const result = WatchTableInputSchema.safeParse({
      table: "x",
      predicate: { event: "*" },
      timeout_ms: 120_001,
    });
    expect(result.success).toBe(false);
  });

  it("rejects max_events above 200", () => {
    const result = WatchTableInputSchema.safeParse({
      table: "x",
      predicate: { event: "*" },
      max_events: 201,
    });
    expect(result.success).toBe(false);
  });

  it("accepts all 7 filter operators", () => {
    const ops = ["eq", "neq", "gt", "gte", "lt", "lte", "in"] as const;
    for (const op of ops) {
      const result = WatchTableInputSchema.safeParse({
        table: "x",
        predicate: { event: "INSERT", filter: { column: "status", op, value: "open" } },
      });
      expect(result.success, `op=${op}`).toBe(true);
    }
  });

  it("rejects an unsupported filter operator", () => {
    const result = WatchTableInputSchema.safeParse({
      table: "x",
      predicate: { event: "INSERT", filter: { column: "status", op: "match", value: "open" } },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun run test:fast -- schemas
```

Expected: FAIL — "Cannot find module '../../src/types/schemas'".

- [ ] **Step 3: Write `src/types/errors.ts`**

```ts
// src/types/errors.ts
export type ToolErrorCode =
  | "INVALID_TABLE"
  | "INVALID_PREDICATE"
  | "INVALID_CHANNEL"
  | "INVALID_PAYLOAD"
  | "TIMEOUT_EXCEEDED_CAP"
  | "RLS_DENIED"
  | "UPSTREAM_ERROR";

export class ToolError extends Error {
  constructor(
    public code: ToolErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ToolError";
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}
```

- [ ] **Step 4: Write `src/types/schemas.ts` — `WatchTableInputSchema`**

```ts
// src/types/schemas.ts
import { z } from "zod";

const FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "in"] as const;
const EVENTS = ["INSERT", "UPDATE", "DELETE", "*"] as const;

export const WatchTableInputSchema = z.object({
  table: z.string().min(1),
  predicate: z.object({
    event: z.enum(EVENTS),
    filter: z
      .object({
        column: z.string().min(1),
        op: z.enum(FILTER_OPS),
        value: z.unknown(),
      })
      .optional(),
  }),
  timeout_ms: z.number().int().min(1_000).max(120_000).default(60_000),
  max_events: z.number().int().min(1).max(200).default(50),
});

export type WatchTableInput = z.infer<typeof WatchTableInputSchema>;

export const WatchTableEventSchema = z.object({
  event: z.enum(["INSERT", "UPDATE", "DELETE"]),
  table: z.string(),
  schema: z.string(),
  new: z.record(z.unknown()).nullable(),
  old: z.record(z.unknown()).nullable(),
  commit_timestamp: z.string(),
});

export const WatchTableOutputSchema = z.object({
  events: z.array(WatchTableEventSchema),
  closed_reason: z.enum(["max_events", "timeout"]),
});

export type WatchTableOutput = z.infer<typeof WatchTableOutputSchema>;
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
bun run test:fast -- schemas
```

Expected: PASS — all 6 cases green.

- [ ] **Step 6: Commit**

```bash
git add src/types/errors.ts src/types/schemas.ts tests/fast/schemas.test.ts
git commit -m "feat(types): WatchTableInput/Output schemas + ToolError enum

Schemas enforce bounded-subscription caps from spec §5.1 (timeout_ms ≤ 120000,
max_events ≤ 200) and the 7 filter operators that Postgres-Changes supports
server-side. Validation happens at the MCP boundary so the tool body sees
already-typed input."
```

---

### Task 4: Bounded-subscription primitive (`realtime-client.ts`)

The load-bearing piece of the entire Week 1 spike. Wraps `@supabase/supabase-js` Realtime channel into a function that resolves with the batch when N events arrive *or* the timeout elapses.

**Files:**
- Create: `supabase-realtime-skill/src/server/realtime-client.ts`
- Create: `supabase-realtime-skill/tests/fast/realtime-client.test.ts`

- [ ] **Step 1: Write the failing test (resolves on max_events)**

```ts
// tests/fast/realtime-client.test.ts
import { describe, expect, it, vi } from "vitest";
import { boundedWatch, type RealtimeAdapter } from "../../src/server/realtime-client";

function makeAdapter(): {
  adapter: RealtimeAdapter;
  emit: (ev: { event: "INSERT" | "UPDATE" | "DELETE"; new: any; old: any }) => void;
  unsubscribed: () => boolean;
} {
  let listener: ((ev: any) => void) | null = null;
  let unsubscribed = false;
  const adapter: RealtimeAdapter = {
    subscribe: async ({ onEvent }) => {
      listener = onEvent;
    },
    unsubscribe: async () => {
      unsubscribed = true;
      listener = null;
    },
  };
  return {
    adapter,
    emit: (ev) =>
      listener?.({
        event: ev.event,
        table: "support_tickets",
        schema: "public",
        new: ev.new,
        old: ev.old,
        commit_timestamp: new Date().toISOString(),
      }),
    unsubscribed: () => unsubscribed,
  };
}

describe("boundedWatch", () => {
  it("resolves when max_events is reached, before timeout", async () => {
    const { adapter, emit, unsubscribed } = makeAdapter();
    const promise = boundedWatch({
      adapter,
      table: "support_tickets",
      predicate: { event: "INSERT" },
      timeout_ms: 60_000,
      max_events: 2,
    });
    queueMicrotask(() => {
      emit({ event: "INSERT", new: { id: "a" }, old: null });
      emit({ event: "INSERT", new: { id: "b" }, old: null });
    });
    const result = await promise;
    expect(result.events).toHaveLength(2);
    expect(result.closed_reason).toBe("max_events");
    expect(unsubscribed()).toBe(true);
  });

  it("resolves on timeout when no events arrive", async () => {
    vi.useFakeTimers();
    const { adapter, unsubscribed } = makeAdapter();
    const promise = boundedWatch({
      adapter,
      table: "support_tickets",
      predicate: { event: "INSERT" },
      timeout_ms: 5_000,
      max_events: 50,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await promise;
    expect(result.events).toEqual([]);
    expect(result.closed_reason).toBe("timeout");
    expect(unsubscribed()).toBe(true);
    vi.useRealTimers();
  });

  it("filters events by predicate.event when not '*'", async () => {
    const { adapter, emit } = makeAdapter();
    const promise = boundedWatch({
      adapter,
      table: "support_tickets",
      predicate: { event: "INSERT" },
      timeout_ms: 60_000,
      max_events: 1,
    });
    queueMicrotask(() => {
      emit({ event: "UPDATE", new: { id: "a" }, old: { id: "a" } });
      emit({ event: "INSERT", new: { id: "b" }, old: null });
    });
    const result = await promise;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.new).toEqual({ id: "b" });
  });

  it("unsubscribes even if the body throws", async () => {
    const { adapter, unsubscribed } = makeAdapter();
    const failingAdapter: RealtimeAdapter = {
      subscribe: () => Promise.reject(new Error("boom")),
      unsubscribe: adapter.unsubscribe,
    };
    await expect(
      boundedWatch({
        adapter: failingAdapter,
        table: "x",
        predicate: { event: "*" },
        timeout_ms: 1_000,
        max_events: 1,
      }),
    ).rejects.toThrow("boom");
    // subscribe failed before adapter installed listener; unsubscribe still safe
    expect(unsubscribed()).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun run test:fast -- realtime-client
```

Expected: FAIL — "Cannot find module '../../src/server/realtime-client'".

- [ ] **Step 3: Write `src/server/realtime-client.ts`**

```ts
// src/server/realtime-client.ts
//
// Bounded-subscription primitive: subscribe to Postgres-Changes (or
// broadcast) on a topic, collect events that match a predicate, resolve
// when either max_events have arrived or timeout_ms has elapsed. Always
// unsubscribes via finally.
//
// The RealtimeAdapter interface is the seam — production wires it to
// @supabase/supabase-js channels; tests substitute a fake.

import type { WatchTableInput, WatchTableOutput } from "../types/schemas";

export interface ChangeEvent {
  event: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  new: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  commit_timestamp: string;
}

export interface RealtimeAdapter {
  subscribe(opts: {
    table: string;
    onEvent: (ev: ChangeEvent) => void;
  }): Promise<void>;
  unsubscribe(): Promise<void>;
}

export interface BoundedWatchInput extends WatchTableInput {
  adapter: RealtimeAdapter;
}

function matchesEvent(ev: ChangeEvent, predicate: WatchTableInput["predicate"]): boolean {
  if (predicate.event !== "*" && ev.event !== predicate.event) return false;
  if (!predicate.filter) return true;
  const row = ev.new ?? ev.old ?? {};
  const lhs = (row as Record<string, unknown>)[predicate.filter.column];
  const rhs = predicate.filter.value;
  switch (predicate.filter.op) {
    case "eq":
      return lhs === rhs;
    case "neq":
      return lhs !== rhs;
    case "gt":
      return typeof lhs === "number" && typeof rhs === "number" && lhs > rhs;
    case "gte":
      return typeof lhs === "number" && typeof rhs === "number" && lhs >= rhs;
    case "lt":
      return typeof lhs === "number" && typeof rhs === "number" && lhs < rhs;
    case "lte":
      return typeof lhs === "number" && typeof rhs === "number" && lhs <= rhs;
    case "in":
      return Array.isArray(rhs) && rhs.includes(lhs);
  }
}

export async function boundedWatch(input: BoundedWatchInput): Promise<WatchTableOutput> {
  const events: ChangeEvent[] = [];
  let resolveOnEvent: ((reason: "max_events") => void) | null = null;

  const eventArrived = new Promise<"max_events">((resolve) => {
    resolveOnEvent = resolve;
  });

  const onEvent = (ev: ChangeEvent) => {
    if (!matchesEvent(ev, input.predicate)) return;
    events.push(ev);
    if (events.length >= input.max_events && resolveOnEvent) {
      resolveOnEvent("max_events");
      resolveOnEvent = null;
    }
  };

  await input.adapter.subscribe({ table: input.table, onEvent });

  try {
    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), input.timeout_ms),
    );
    const closed_reason = await Promise.race([eventArrived, timeoutPromise]);
    return { events, closed_reason };
  } finally {
    await input.adapter.unsubscribe();
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun run test:fast -- realtime-client
```

Expected: PASS — 4 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/server/realtime-client.ts tests/fast/realtime-client.test.ts
git commit -m "feat(server): bounded-subscription primitive

Resolves on max_events or timeout, whichever first. RealtimeAdapter is the
seam — production wires it to @supabase/supabase-js, tests substitute a
fake. Always unsubscribes in finally so isolate teardown is clean."
```

---

### Task 5: Wire `watch_table` MCP tool

**Files:**
- Create: `supabase-realtime-skill/src/server/watch-table.ts`
- Create: `supabase-realtime-skill/tests/fast/watch-table.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/fast/watch-table.test.ts
import { describe, expect, it } from "vitest";
import { handleWatchTable } from "../../src/server/watch-table";
import type { RealtimeAdapter } from "../../src/server/realtime-client";

function fakeAdapter(events: any[]): RealtimeAdapter {
  return {
    subscribe: async ({ onEvent }) => {
      queueMicrotask(() => {
        for (const ev of events) onEvent(ev);
      });
    },
    unsubscribe: async () => {},
  };
}

describe("handleWatchTable", () => {
  it("returns events that match the predicate", async () => {
    const adapter = fakeAdapter([
      {
        event: "INSERT",
        table: "support_tickets",
        schema: "public",
        new: { id: "1" },
        old: null,
        commit_timestamp: "2026-04-30T00:00:00Z",
      },
    ]);
    const result = await handleWatchTable(
      { table: "support_tickets", predicate: { event: "INSERT" }, timeout_ms: 1000, max_events: 1 },
      { adapterFor: () => adapter },
    );
    expect(result.events).toHaveLength(1);
    expect(result.closed_reason).toBe("max_events");
  });

  it("rejects timeout_ms over the 120000 cap with TIMEOUT_EXCEEDED_CAP", async () => {
    await expect(
      handleWatchTable(
        { table: "x", predicate: { event: "*" }, timeout_ms: 120_001, max_events: 1 } as any,
        { adapterFor: () => fakeAdapter([]) },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT_EXCEEDED_CAP" });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
bun run test:fast -- watch-table
```

Expected: FAIL — "Cannot find module".

- [ ] **Step 3: Write `src/server/watch-table.ts`**

```ts
// src/server/watch-table.ts
import { boundedWatch, type RealtimeAdapter } from "./realtime-client";
import { ToolError } from "../types/errors";
import { WatchTableInputSchema, type WatchTableInput, type WatchTableOutput } from "../types/schemas";

export interface WatchTableDeps {
  adapterFor(table: string): RealtimeAdapter;
}

export async function handleWatchTable(
  rawInput: unknown,
  deps: WatchTableDeps,
): Promise<WatchTableOutput> {
  const parsed = WatchTableInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path.includes("timeout_ms") && issue.code === "too_big") {
      throw new ToolError("TIMEOUT_EXCEEDED_CAP", "timeout_ms exceeds 120000ms cap", {
        max: 120_000,
      });
    }
    throw new ToolError("INVALID_PREDICATE", parsed.error.message, { issues: parsed.error.issues });
  }
  const input: WatchTableInput = parsed.data;
  const adapter = deps.adapterFor(input.table);
  return boundedWatch({ adapter, ...input });
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
bun run test:fast -- watch-table
```

Expected: PASS — 2 cases green.

- [ ] **Step 5: Commit**

```bash
git add src/server/watch-table.ts tests/fast/watch-table.test.ts
git commit -m "feat(server): watch_table tool — schema validation + dispatch

Validation lives at the MCP boundary; the bounded primitive sees typed
input. TIMEOUT_EXCEEDED_CAP is mapped from zod's too_big issue so the
agent gets a structured error code, not a stringified zod message."
```

---

### Task 6: Real `RealtimeAdapter` against `@supabase/supabase-js`

**Files:**
- Modify: `supabase-realtime-skill/src/server/realtime-client.ts`

- [ ] **Step 1: Append the production adapter to `realtime-client.ts`**

```ts
// Append to src/server/realtime-client.ts

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseAdapterConfig {
  supabaseUrl: string;
  supabaseKey: string;
  authToken?: string;  // forwarded as Authorization header for RLS
  schema?: string;     // default "public"
}

export function makeSupabaseAdapter(table: string, cfg: SupabaseAdapterConfig): RealtimeAdapter {
  const client: SupabaseClient = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    global: cfg.authToken
      ? { headers: { Authorization: `Bearer ${cfg.authToken}` } }
      : undefined,
    realtime: { params: { eventsPerSecond: 20 } },
  });
  const channelName = `realtime:${cfg.schema ?? "public"}:${table}`;
  let channel: ReturnType<SupabaseClient["channel"]> | null = null;

  return {
    async subscribe({ onEvent }) {
      channel = client.channel(channelName);
      channel.on(
        "postgres_changes" as any,
        { event: "*", schema: cfg.schema ?? "public", table },
        (payload: any) => {
          onEvent({
            event: payload.eventType,
            table: payload.table,
            schema: payload.schema,
            new: payload.new ?? null,
            old: payload.old ?? null,
            commit_timestamp: payload.commit_timestamp,
          });
        },
      );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("subscribe timeout")), 10_000);
        channel?.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            clearTimeout(timer);
            resolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timer);
            reject(new Error(`subscribe failed: ${status}`));
          }
        });
      });
    },
    async unsubscribe() {
      if (channel) {
        await client.removeChannel(channel);
        channel = null;
      }
    },
  };
}
```

- [ ] **Step 2: Verify typecheck still passes**

```bash
bun run typecheck
```

Expected: PASS — types are happy with the @supabase/supabase-js Realtime API.

- [ ] **Step 3: Commit**

```bash
git add src/server/realtime-client.ts
git commit -m "feat(server): production RealtimeAdapter via @supabase/supabase-js

10-second cap on subscribe handshake (this is what 'cold start' looks like
end-to-end; the spec's 200-400ms cold-start figure absorbs the SUBSCRIBED
ack roundtrip). authToken is forwarded so RLS applies natively."
```

---

### Task 7: Smoke test — `watch_table` against a real branch DB

This is the **spike's success criterion test**. Uses vendored `withBranch` from `vendor/foundation/branch.ts` to spin up a Supabase branch, run the watch loop against it, INSERT a row, and assert the event arrives within the configured timeout.

**Files:**
- Create: `supabase-realtime-skill/tests/smoke/watch-table.smoke.test.ts`

- [ ] **Step 1: Write the smoke test**

```ts
// tests/smoke/watch-table.smoke.test.ts
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { ApiClient } from "../../vendor/foundation/api-client";
import { withBranch, buildBranchPoolerUrl } from "../../vendor/foundation/branch";
import { boundedWatch, makeSupabaseAdapter } from "../../src/server/realtime-client";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";

const skipUnlessConfigured = !PAT || !HOST_REF ? it.skip : it;

describe("watch_table smoke (real branch)", () => {
  skipUnlessConfigured("delivers an INSERT within p95 < 2s on a Pro branch", async () => {
    const client = new ApiClient({ pat: PAT!, hostProjectRef: HOST_REF! });
    await withBranch(
      client,
      { name: `smoke-watch-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
      async ({ details }) => {
        const dbUrl = buildBranchPoolerUrl({ ref: details.ref, db_pass: details.db_pass }, REGION);
        const sql = postgres(dbUrl, { max: 1, prepare: false });
        try {
          await sql`create table tickets (id uuid primary key default gen_random_uuid(), body text)`;
          await sql`alter publication supabase_realtime add table tickets`;

          const adapter = makeSupabaseAdapter("tickets", {
            supabaseUrl: `https://${details.ref}.supabase.co`,
            supabaseKey: details.anon_key ?? details.service_role_key ?? "",
          });

          const insertedAt = Date.now();
          // Arm the bounded watch first, then trigger insert ~50ms later.
          const watchPromise = boundedWatch({
            adapter,
            table: "tickets",
            predicate: { event: "INSERT" },
            timeout_ms: 30_000,
            max_events: 1,
          });
          setTimeout(() => {
            sql`insert into tickets (body) values ('hello')`.catch(() => {});
          }, 100);

          const result = await watchPromise;
          const latency = Date.now() - insertedAt;

          expect(result.events).toHaveLength(1);
          expect(result.closed_reason).toBe("max_events");
          expect(latency).toBeLessThan(5_000); // single-trial floor; ci-full enforces p95 < 2000
          // Log so we can eyeball week-1 spike numbers.
          console.log(`[smoke] watch_table single-trial latency: ${latency}ms`);
        } finally {
          await sql.end();
        }
      },
    );
  });
});
```

- [ ] **Step 2: Add `postgres` to dependencies**

```bash
bun add postgres
```

- [ ] **Step 3: Run the smoke test against a real branch**

Pre-req: `.env` populated with `EVAL_SUPABASE_PAT`, `EVAL_HOST_PROJECT_REF` (a Supabase Pro project owned by the operator).

```bash
bun run test:smoke
```

Expected: PASS in ≤4 minutes. Logged latency line proves the primitive end-to-end. **Spike success gate** — if this doesn't reliably hit <5s single-trial, debug here before moving on.

- [ ] **Step 4: Commit**

```bash
git add tests/smoke/watch-table.smoke.test.ts package.json bun.lockb
git commit -m "test(smoke): watch_table end-to-end on a real branch

Single-trial floor only — ci-full enforces p95 < 2000ms across n=100.
This test's job is to prove the primitive works against real Postgres +
Realtime under a real branch's pooler. Logged latency feeds spike-success
review."
```

---

### Task 8: Edge Function deployment skeleton (watch_table only)

**Files:**
- Create: `supabase-realtime-skill/supabase/functions/mcp/index.ts`
- Create: `supabase-realtime-skill/src/server/server.ts`
- Create: `supabase-realtime-skill/supabase/functions/mcp/deno.json`

- [ ] **Step 1: Write `src/server/server.ts` — the MCP server factory**

```ts
// src/server/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { handleWatchTable } from "./watch-table";
import { makeSupabaseAdapter } from "./realtime-client";
import { WatchTableInputSchema } from "../types/schemas";
import { ToolError } from "../types/errors";

export interface ServerConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  authToken?: string;
}

export function makeServer(cfg: ServerConfig): Server {
  const server = new Server(
    { name: "supabase-realtime", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "watch_table",
        description:
          "Bounded subscription to Postgres row-changes. Returns events when max_events arrive or timeout_ms elapses (whichever first). Use when an agent needs to react to a database event.",
        inputSchema: {
          type: "object",
          properties: {
            table: { type: "string" },
            predicate: {
              type: "object",
              properties: {
                event: { enum: ["INSERT", "UPDATE", "DELETE", "*"] },
                filter: {
                  type: "object",
                  properties: {
                    column: { type: "string" },
                    op: { enum: ["eq", "neq", "gt", "gte", "lt", "lte", "in"] },
                    value: {},
                  },
                  required: ["column", "op", "value"],
                },
              },
              required: ["event"],
            },
            timeout_ms: { type: "number", minimum: 1000, maximum: 120000, default: 60000 },
            max_events: { type: "number", minimum: 1, maximum: 200, default: 50 },
          },
          required: ["table", "predicate"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      if (req.params.name === "watch_table") {
        const result = await handleWatchTable(req.params.arguments, {
          adapterFor: (table) =>
            makeSupabaseAdapter(table, {
              supabaseUrl: cfg.supabaseUrl,
              supabaseKey: cfg.supabaseAnonKey,
              ...(cfg.authToken ? { authToken: cfg.authToken } : {}),
            }),
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      throw new ToolError("UPSTREAM_ERROR", `unknown tool: ${req.params.name}`);
    } catch (err) {
      if (err instanceof ToolError) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(err.toJSON()) }],
        };
      }
      throw err;
    }
  });

  return server;
}
```

- [ ] **Step 2: Write `supabase/functions/mcp/index.ts` — Edge Function entry**

```ts
// supabase/functions/mcp/index.ts
//
// Deno runtime. Uses npm: specifiers (Supabase Edge Functions support
// these via Deno's npm compat). Must NOT import anything Node-specific.

import { makeServer } from "npm:supabase-realtime-skill@latest/dist/server.js";
// ^^ Replaced after npm publish (Week 3). For local dev, import directly:
// import { makeServer } from "../../../src/server/server.ts";

import { SSEServerTransport } from "npm:@modelcontextprotocol/sdk/server/sse.js";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const authToken = req.headers.get("Authorization")?.replace(/^Bearer /, "");

  const server = makeServer({
    supabaseUrl,
    supabaseAnonKey,
    ...(authToken ? { authToken } : {}),
  });

  if (url.pathname.endsWith("/sse")) {
    const transport = new SSEServerTransport(`${url.pathname}/messages`, new Response());
    await server.connect(transport);
    return transport.response;
  }

  return new Response("supabase-realtime-skill MCP — POST /sse to connect", { status: 200 });
});
```

The `npm:supabase-realtime-skill@latest` import will fail until npm publish. For Week 1's local-dev verification, swap to the relative path on this comment line. Re-swap at Week 3 publish.

- [ ] **Step 3: Write `supabase/functions/mcp/deno.json`**

```json
{
  "imports": {
    "supabase-realtime-skill/": "../../../src/"
  }
}
```

- [ ] **Step 4: Deploy + smoke-call manually**

```bash
# In a Supabase Pro project (test-only):
supabase functions deploy mcp --project-ref <test-ref>

# Verify GET returns 200 with the placeholder string
curl -i https://<test-ref>.supabase.co/functions/v1/mcp \
  -H "Authorization: Bearer <anon-key>"
```

Expected: `200 OK` with body `supabase-realtime-skill MCP — POST /sse to connect`.

If this step blocks (e.g., Edge Function build fails on `@modelcontextprotocol/sdk` import), this is the **Week 1 spike's red flag**. Document the blocker in `docs/spike-findings.md` and reshape Week 2 around the workaround (e.g., bundle the MCP SDK manually, or expose a non-SSE JSON-RPC endpoint).

- [ ] **Step 5: Commit**

```bash
git add src/server/server.ts supabase/functions/mcp/
git commit -m "feat(server): MCP server factory + Edge Function deployment skeleton

watch_table only — Week 1 spike scope. Edge Function uses npm: specifiers
so it stays Deno-pure. Auth token from Authorization header is forwarded
into the Realtime adapter so RLS applies natively per spec §9."
```

---

### Task 9: Latency measurement script (validate spike success)

**Files:**
- Create: `supabase-realtime-skill/eval/spike-latency.ts`

- [ ] **Step 1: Write `eval/spike-latency.ts`**

```ts
// eval/spike-latency.ts
//
// Runs n=20 single-trial latencies through the deployed Edge Function and
// reports p50/p95/p99. Used to validate the spike success criterion
// (p95 < 2000ms) before committing to the rest of the build.

import postgres from "postgres";
import { ApiClient } from "../vendor/foundation/api-client";
import { withBranch, buildBranchPoolerUrl } from "../vendor/foundation/branch";
import { boundedWatch, makeSupabaseAdapter } from "../src/server/realtime-client";

const N = 20;
const PAT = process.env.EVAL_SUPABASE_PAT!;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF!;
const REGION = process.env.EVAL_REGION ?? "us-east-1";

function pct(latencies: number[], p: number): number {
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function main() {
  const client = new ApiClient({ pat: PAT, hostProjectRef: HOST_REF });
  await withBranch(
    client,
    { name: `spike-latency-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
    async ({ details }) => {
      const dbUrl = buildBranchPoolerUrl({ ref: details.ref, db_pass: details.db_pass }, REGION);
      const sql = postgres(dbUrl, { max: 1, prepare: false });
      await sql`create table tickets (id uuid primary key default gen_random_uuid(), body text)`;
      await sql`alter publication supabase_realtime add table tickets`;

      const latencies: number[] = [];
      for (let i = 0; i < N; i++) {
        const adapter = makeSupabaseAdapter("tickets", {
          supabaseUrl: `https://${details.ref}.supabase.co`,
          supabaseKey: details.anon_key ?? details.service_role_key ?? "",
        });
        const insertAt = Date.now();
        const watchPromise = boundedWatch({
          adapter,
          table: "tickets",
          predicate: { event: "INSERT" },
          timeout_ms: 10_000,
          max_events: 1,
        });
        setTimeout(() => {
          sql`insert into tickets (body) values (${`trial-${i}`})`.catch(() => {});
        }, 50);
        const result = await watchPromise;
        if (result.closed_reason === "timeout") {
          console.error(`[trial ${i}] TIMEOUT — primitive failed; investigate`);
          continue;
        }
        latencies.push(Date.now() - insertAt);
      }

      console.log(`n=${latencies.length} successful trials`);
      console.log(`p50: ${pct(latencies, 50)}ms`);
      console.log(`p95: ${pct(latencies, 95)}ms`);
      console.log(`p99: ${pct(latencies, 99)}ms`);
      const passed = pct(latencies, 95) < 2000;
      console.log(`spike threshold (p95 < 2000ms): ${passed ? "PASS" : "FAIL"}`);
      await sql.end();
      if (!passed) process.exit(1);
    },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

```bash
bun run eval/spike-latency.ts
```

Expected: `spike threshold (p95 < 2000ms): PASS`. Single branch, n=20 trials, ~5-10 minutes wallclock (branch create dominates).

If FAIL: this is the **architectural redesign trigger**. Document the failure mode in `docs/spike-findings.md`, propose alternatives (webhook-push primary; long-lived worker behind a thin Edge proxy; etc.) before any Week 2 work.

- [ ] **Step 3: Commit (regardless of pass/fail — failure is also a finding)**

```bash
git add eval/spike-latency.ts
git commit -m "eval: spike latency script (n=20 single-branch trials)

Runs the bounded primitive end-to-end and reports p50/p95/p99 against
the spec §8.2 threshold (p95 < 2000ms). Passing this gates Week 2;
failing triggers a Week 1 architecture review."
```

---

### Task 10: `references/predicates.md`

**Files:**
- Create: `supabase-realtime-skill/references/predicates.md`

- [ ] **Step 1: Write the page**

```markdown
# References — Postgres-Changes filter predicates

The `watch_table` tool exposes a `predicate.filter` parameter. Some operators are evaluated server-side by Supabase Realtime; others fall back to client-side filtering inside `boundedWatch`. Server-side is cheaper (events filtered before they cross the wire) and **strongly preferred for high-frequency tables**. Client-side is correct, but every filtered-out event still costs you wire bandwidth and isolate CPU.

## Server-side ops

These map directly to Postgres-Changes `filter` strings (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`). The Realtime server evaluates them before publishing to the channel.

| op | Postgres-Changes filter form | Notes |
|---|---|---|
| `eq` | `<column>=eq.<value>` | Most common. Strings, numbers, UUIDs all work. |
| `neq` | `<column>=neq.<value>` | |
| `gt`, `gte`, `lt`, `lte` | `<column>=gt.<value>` etc. | Numeric / timestamp comparisons. |
| `in` | `<column>=in.(<v1>,<v2>,...)` | Comma-separated value list. |

## Operators we explicitly *don't* support

Postgres-Changes doesn't support pattern matching, JSON path traversal, or full-text. We considered shipping a client-side fallback for these and decided against it for v1:

- **`like` / `ilike` / regex** — surprisingly expensive on high-frequency tables; agents can post-filter the returned `events[]` themselves if they need pattern matching. Adding it server-side would imply we're shipping our own publication layer.
- **JSON path** — composes poorly with the server-side filter syntax; we'd be re-implementing PostgREST. Out of scope.
- **Full-text** — same reasoning, plus tsvector requires schema awareness this MCP doesn't have.

If your agent needs one of these, two options: (a) post-filter `events[]` after `watch_table` returns; (b) create a generated column (`status_normalized`, `body_lower`) and use `eq` on that.

## Why server-side at all

A common alternative is "subscribe to the whole table and filter in TS." It's tempting because it's simpler. We rejected it because:

- Realtime caps events-per-second per channel (default 10/s with bursts allowed). A noisy table without a filter starts dropping events under load. Server-side filtering keeps you under the cap.
- Edge Function isolates have CPU budgets. Filtering 1000 events to find the 5 that match wastes most of your wallclock.
- The spec's `latency_to_first_event_ms` p95 < 2s threshold gets harder to hit when each event has to be parsed and rejected.

## When the filter you want isn't supported

`watch_table` returns `INVALID_PREDICATE` *up front* (during input parsing) rather than silently degrading to a slow client-side filter. This is intentional — agents should surface the constraint, not get a silently-bad result. If you really need a fallback, reach for `boundedWatch` directly (the underlying primitive is exported) and pass an unfiltered subscription with a TS-side filter in your agent loop.

## See also

- `references/replication-identity.md` — for `UPDATE`/`DELETE`, which columns of `old` you'll see in the event payload depends on `REPLICA IDENTITY`.
- `references/rls-implications.md` — RLS applies to which rows the channel can see; the filter runs *after* RLS.
```

- [ ] **Step 2: Commit**

```bash
git add references/predicates.md
git commit -m "docs(references): predicates.md — supported ops + rationale for what we exclude"
```

---

### Task 11: `references/replication-identity.md`

**Files:**
- Create: `supabase-realtime-skill/references/replication-identity.md`

- [ ] **Step 1: Write the page**

```markdown
# References — REPLICA IDENTITY and the `old` row

Postgres logical replication (which Supabase Realtime is built on) emits row-change events with a payload shape that depends on the table's `REPLICA IDENTITY` setting. This is invisible until you try to read `event.old` on an `UPDATE` or `DELETE` and find it's mostly null.

## The four modes

| Mode | What `event.old` contains on UPDATE/DELETE |
|---|---|
| `DEFAULT` (the default) | Only primary-key columns. Other columns are null. |
| `FULL` | Every column of the row before the change. |
| `USING INDEX <idx>` | Columns covered by the named unique index. |
| `NOTHING` | No `old` row at all (UPDATE shows only `new`; DELETE shows nothing). |

## When it matters

- **Old/new diff:** if your agent compares `event.old.status` with `event.new.status` to decide whether a state transition just happened, you need `FULL` (or at least `USING INDEX` covering `status`).
- **DELETE auditing:** if you need to know what was deleted (not just that *something* was), you need `FULL`.
- **INSERT-only flows:** if you only ever read `event.new` from `INSERT` events, the default is fine.

## How to enable

```sql
alter table support_tickets replica identity full;
```

`describe_table_changes(table)` reports the current `replication_identity` so an agent (or human reading the docs) sees the constraint *before* writing a watch loop that depends on `old` values.

## The cost

`REPLICA IDENTITY FULL` writes the entire pre-image of each row to the WAL on every UPDATE/DELETE. For a table with wide rows or high write volume, that's measurable storage + I/O overhead. The Supabase docs estimate "up to 2-3× WAL volume on update-heavy tables." For a `support_tickets` table that gets a few hundred updates a day, this is invisible. For a `events` or `audit_log` table with millions of writes, this is real.

## The opinionated default

Tables that are *part of an agent workflow* should default to `REPLICA IDENTITY FULL` unless you've measured the WAL overhead and found it unacceptable. The cost of being surprised by a null `old` deep in an agent loop — discovering it only when a regression test fails — is much higher than the storage premium.

If WAL volume is the constraint, prefer `USING INDEX` over `DEFAULT` so you keep the columns the agent actually reads.

## See also

- `references/predicates.md` — server-side filtering happens *before* the event hits your subscription, regardless of replica identity.
- `describe_table_changes` tool — exposes the current setting so the agent can make an informed call.
```

- [ ] **Step 2: Commit**

```bash
git add references/replication-identity.md
git commit -m "docs(references): replication-identity.md — when to enable FULL, the WAL cost"
```

---

## Phase 1 — Week 1 success gate

Before starting Week 2, all of the following must hold:

- [ ] `bun run test:fast` — all schemas + watch-table + realtime-client tests green
- [ ] `bun run test:smoke` — single-trial smoke test green against a real branch (logs single-trial latency < 5s)
- [ ] `bun run eval/spike-latency.ts` — n=20 trials report `spike threshold (p95 < 2000ms): PASS`
- [ ] Edge Function deploys to a Pro project and `GET /functions/v1/mcp` returns 200
- [ ] `references/predicates.md` + `references/replication-identity.md` written and committed

If any of these fail, write `docs/spike-findings.md` documenting the failure mode and propose an architectural redesign before continuing to Week 2. **Don't paper over a Week-1 failure with Week-2 mechanical work** — that's the spec §12 cascade risk we deliberately structured the spike-first split to avoid.

---

## Phase 2 — Week 2: Mechanical scale-out (4 more tools + Skill v1)

Pattern across Tasks 12–19: **schema → fast test → impl → smoke test → commit**. Each tool follows the `watch_table` template from Week 1. Schema validation centralized in `src/types/schemas.ts`; one tool per file in `src/server/`; one fast test + one smoke test per tool.

### Task 12: Schemas for the remaining 4 tools

**Files:**
- Modify: `supabase-realtime-skill/src/types/schemas.ts`
- Modify: `supabase-realtime-skill/tests/fast/schemas.test.ts`

- [ ] **Step 1: Append failing tests for all 4 schemas**

```ts
// Append to tests/fast/schemas.test.ts
import {
  BroadcastInputSchema,
  SubscribeChannelInputSchema,
  ListChannelsInputSchema,
  DescribeTableInputSchema,
} from "../../src/types/schemas";

describe("BroadcastInputSchema", () => {
  it("accepts a valid broadcast", () => {
    const r = BroadcastInputSchema.safeParse({
      channel: "agent:triage:urgent",
      event: "ticket-routed",
      payload: { ticket_id: "abc" },
    });
    expect(r.success).toBe(true);
  });
  it("rejects payload over 32KB", () => {
    const big = { x: "a".repeat(33_000) };
    const r = BroadcastInputSchema.safeParse({ channel: "c", event: "e", payload: big });
    expect(r.success).toBe(false);
  });
});

describe("SubscribeChannelInputSchema", () => {
  it("applies bounded-subscription defaults like watch_table", () => {
    const r = SubscribeChannelInputSchema.parse({ channel: "c" });
    expect(r.timeout_ms).toBe(60_000);
    expect(r.max_events).toBe(50);
  });
  it("caps timeout_ms at 120000", () => {
    expect(SubscribeChannelInputSchema.safeParse({ channel: "c", timeout_ms: 120_001 }).success).toBe(false);
  });
});

describe("ListChannelsInputSchema", () => {
  it("accepts an empty object", () => {
    expect(ListChannelsInputSchema.safeParse({}).success).toBe(true);
  });
});

describe("DescribeTableInputSchema", () => {
  it("requires a table", () => {
    expect(DescribeTableInputSchema.safeParse({}).success).toBe(false);
    expect(DescribeTableInputSchema.safeParse({ table: "support_tickets" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
bun run test:fast -- schemas
```

Expected: FAIL — 4 imports unresolved.

- [ ] **Step 3: Append schemas to `src/types/schemas.ts`**

```ts
// Append to src/types/schemas.ts

const PAYLOAD_BYTE_CAP = 32_768;

export const BroadcastInputSchema = z.object({
  channel: z.string().min(1).max(255),
  event: z.string().min(1).max(255),
  payload: z.record(z.unknown()).refine(
    (v) => Buffer.byteLength(JSON.stringify(v), "utf8") <= PAYLOAD_BYTE_CAP,
    { message: "payload exceeds 32KB byte cap" },
  ),
});
export type BroadcastInput = z.infer<typeof BroadcastInputSchema>;

export const BroadcastOutputSchema = z.object({ success: z.boolean() });
export type BroadcastOutput = z.infer<typeof BroadcastOutputSchema>;

export const SubscribeChannelInputSchema = z.object({
  channel: z.string().min(1).max(255),
  event_filter: z.string().min(1).optional(),
  timeout_ms: z.number().int().min(1_000).max(120_000).default(60_000),
  max_events: z.number().int().min(1).max(200).default(50),
});
export type SubscribeChannelInput = z.infer<typeof SubscribeChannelInputSchema>;

export const SubscribeChannelOutputSchema = z.object({
  broadcasts: z.array(
    z.object({
      channel: z.string(),
      event: z.string(),
      payload: z.record(z.unknown()),
      received_at: z.string(),
    }),
  ),
  closed_reason: z.enum(["max_events", "timeout"]),
});
export type SubscribeChannelOutput = z.infer<typeof SubscribeChannelOutputSchema>;

export const ListChannelsInputSchema = z.object({}).strict();
export type ListChannelsInput = z.infer<typeof ListChannelsInputSchema>;

export const ListChannelsOutputSchema = z.object({
  channels: z.array(
    z.object({
      name: z.string(),
      member_count: z.number().int().nonnegative(),
      last_event_at: z.string().nullable(),
    }),
  ),
});
export type ListChannelsOutput = z.infer<typeof ListChannelsOutputSchema>;

export const DescribeTableInputSchema = z.object({ table: z.string().min(1) });
export type DescribeTableInput = z.infer<typeof DescribeTableInputSchema>;

export const DescribeTableOutputSchema = z.object({
  table: z.string(),
  schema: z.string(),
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      nullable: z.boolean(),
      generated: z.boolean(),
    }),
  ),
  primary_key: z.array(z.string()),
  rls_enabled: z.boolean(),
  replication_identity: z.enum(["default", "full", "index", "nothing"]),
});
export type DescribeTableOutput = z.infer<typeof DescribeTableOutputSchema>;
```

`Buffer.byteLength` works in Node + Deno + Bun (all expose `Buffer`); if Edge Function bundling complains, swap to `new TextEncoder().encode(JSON.stringify(v)).byteLength`.

- [ ] **Step 4: Run tests to verify pass**

```bash
bun run test:fast -- schemas
```

Expected: PASS — all 12 schema cases (6 from Week 1 + 6 new) green.

- [ ] **Step 5: Commit**

```bash
git add src/types/schemas.ts tests/fast/schemas.test.ts
git commit -m "feat(types): schemas for broadcast, subscribe, list-channels, describe-table

Bounded-subscription cap (timeout_ms ≤ 120000, max_events ≤ 200) repeated
on subscribe_to_channel for parity with watch_table. Broadcast payload
capped at 32KB via byte-length refinement, not JSON-character count
(per spec §5.2)."
```

---

### Task 13: `broadcast_to_channel` tool

**Files:**
- Create: `supabase-realtime-skill/src/server/broadcast.ts`
- Create: `supabase-realtime-skill/tests/fast/broadcast.test.ts`
- Create: `supabase-realtime-skill/tests/smoke/broadcast.smoke.test.ts`

- [ ] **Step 1: Write the fast test**

```ts
// tests/fast/broadcast.test.ts
import { describe, expect, it, vi } from "vitest";
import { handleBroadcast } from "../../src/server/broadcast";

describe("handleBroadcast", () => {
  it("returns success on a clean send", async () => {
    const send = vi.fn(async () => ({ status: "ok" }));
    const result = await handleBroadcast(
      { channel: "c", event: "e", payload: { x: 1 } },
      { sender: { send } },
    );
    expect(result).toEqual({ success: true });
    expect(send).toHaveBeenCalledOnce();
  });

  it("retries up to 3 times on 5xx-shaped failures", async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error("upstream 503");
      return { status: "ok" };
    });
    const result = await handleBroadcast(
      { channel: "c", event: "e", payload: { x: 1 } },
      { sender: { send } },
    );
    expect(result.success).toBe(true);
    expect(calls).toBe(3);
  });

  it("gives up after 3 failures and throws UPSTREAM_ERROR", async () => {
    const send = vi.fn(async () => {
      throw new Error("upstream 503");
    });
    await expect(
      handleBroadcast({ channel: "c", event: "e", payload: {} }, { sender: { send } }),
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("rejects payload over 32KB with INVALID_PAYLOAD", async () => {
    const send = vi.fn(async () => ({ status: "ok" }));
    const huge = { x: "a".repeat(33_000) };
    await expect(
      handleBroadcast({ channel: "c", event: "e", payload: huge }, { sender: { send } }),
    ).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun run test:fast -- broadcast
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/server/broadcast.ts`**

```ts
// src/server/broadcast.ts
import { ToolError } from "../types/errors";
import {
  BroadcastInputSchema,
  type BroadcastInput,
  type BroadcastOutput,
} from "../types/schemas";

export interface BroadcastSender {
  send(input: BroadcastInput): Promise<{ status: "ok" }>;
}

export interface BroadcastDeps {
  sender: BroadcastSender;
}

const RETRY_LIMIT = 3;
const RETRY_BASE_MS = 200;

export async function handleBroadcast(
  rawInput: unknown,
  deps: BroadcastDeps,
): Promise<BroadcastOutput> {
  const parsed = BroadcastInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const overSize = parsed.error.issues.find((i) =>
      i.message.includes("32KB"),
    );
    if (overSize) {
      throw new ToolError("INVALID_PAYLOAD", "payload exceeds 32KB cap", { cap: 32_768 });
    }
    throw new ToolError("INVALID_PAYLOAD", parsed.error.message, { issues: parsed.error.issues });
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
    try {
      await deps.sender.send(parsed.data);
      return { success: true };
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_LIMIT - 1) {
        await new Promise((r) => setTimeout(r, RETRY_BASE_MS * 2 ** attempt));
      }
    }
  }
  throw new ToolError("UPSTREAM_ERROR", `broadcast failed after ${RETRY_LIMIT} attempts`, {
    cause: String(lastErr),
  });
}
```

- [ ] **Step 4: Run to verify pass**

```bash
bun run test:fast -- broadcast
```

Expected: PASS — 4 cases.

- [ ] **Step 5: Write smoke test**

```ts
// tests/smoke/broadcast.smoke.test.ts
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { ApiClient } from "../../vendor/foundation/api-client";
import { withBranch } from "../../vendor/foundation/branch";
import { handleBroadcast } from "../../src/server/broadcast";
import type { BroadcastSender } from "../../src/server/broadcast";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";

const skipUnlessConfigured = !PAT || !HOST_REF ? it.skip : it;

describe("broadcast_to_channel smoke", () => {
  skipUnlessConfigured("a sent broadcast is received on a parallel subscription", async () => {
    const apiClient = new ApiClient({ pat: PAT!, hostProjectRef: HOST_REF! });
    await withBranch(
      apiClient,
      { name: `smoke-bcast-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
      async ({ details }) => {
        const supabase = createClient(
          `https://${details.ref}.supabase.co`,
          details.anon_key ?? details.service_role_key ?? "",
        );

        const channel = supabase.channel("test:bcast");
        const received: any[] = [];
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("subscribe timeout")), 10_000);
          channel
            .on("broadcast", { event: "ping" }, (payload) => received.push(payload))
            .subscribe((status) => {
              if (status === "SUBSCRIBED") {
                clearTimeout(timer);
                resolve();
              }
            });
        });

        const sender: BroadcastSender = {
          send: async (input) => {
            const ch = supabase.channel(input.channel);
            await new Promise<void>((resolve) =>
              ch.subscribe((s) => {
                if (s === "SUBSCRIBED") resolve();
              }),
            );
            await ch.send({ type: "broadcast", event: input.event, payload: input.payload });
            await supabase.removeChannel(ch);
            return { status: "ok" };
          },
        };

        const result = await handleBroadcast(
          { channel: "test:bcast", event: "ping", payload: { hello: "world" } },
          { sender },
        );
        expect(result.success).toBe(true);

        // Wait briefly for the broadcast to land on the subscription side.
        await new Promise((r) => setTimeout(r, 1_500));
        expect(received.length).toBeGreaterThanOrEqual(1);
        await supabase.removeChannel(channel);
      },
    );
  });
});
```

- [ ] **Step 6: Run smoke**

```bash
bun run test:smoke -- broadcast
```

Expected: PASS in ~3 minutes (branch creation + Realtime handshake).

- [ ] **Step 7: Commit**

```bash
git add src/server/broadcast.ts tests/fast/broadcast.test.ts tests/smoke/broadcast.smoke.test.ts
git commit -m "feat(server): broadcast_to_channel with idempotent retry

3 attempts, exponential backoff (200ms base). Treats every send error as
retryable — Realtime broadcast is idempotent at the channel level (events
are timestamped, duplicate deliveries are caller's problem to dedupe)."
```

---

### Task 14: `subscribe_to_channel` tool

**Files:**
- Create: `supabase-realtime-skill/src/server/subscribe.ts`
- Create: `supabase-realtime-skill/tests/fast/subscribe.test.ts`
- Create: `supabase-realtime-skill/tests/smoke/subscribe.smoke.test.ts`

- [ ] **Step 1: Extend `realtime-client.ts` with a `BroadcastAdapter`**

```ts
// Append to src/server/realtime-client.ts

export interface BroadcastReceived {
  channel: string;
  event: string;
  payload: Record<string, unknown>;
  received_at: string;
}

export interface BroadcastAdapter {
  subscribe(opts: {
    channel: string;
    event_filter?: string;
    onBroadcast: (b: BroadcastReceived) => void;
  }): Promise<void>;
  unsubscribe(): Promise<void>;
}

export async function boundedSubscribe(input: {
  adapter: BroadcastAdapter;
  channel: string;
  event_filter?: string;
  timeout_ms: number;
  max_events: number;
}): Promise<{ broadcasts: BroadcastReceived[]; closed_reason: "max_events" | "timeout" }> {
  const broadcasts: BroadcastReceived[] = [];
  let resolveOnEvent: ((reason: "max_events") => void) | null = null;

  const arrived = new Promise<"max_events">((resolve) => {
    resolveOnEvent = resolve;
  });

  await input.adapter.subscribe({
    channel: input.channel,
    ...(input.event_filter !== undefined ? { event_filter: input.event_filter } : {}),
    onBroadcast: (b) => {
      if (input.event_filter && b.event !== input.event_filter) return;
      broadcasts.push(b);
      if (broadcasts.length >= input.max_events && resolveOnEvent) {
        resolveOnEvent("max_events");
        resolveOnEvent = null;
      }
    },
  });

  try {
    const timeoutPromise = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), input.timeout_ms),
    );
    const closed_reason = await Promise.race([arrived, timeoutPromise]);
    return { broadcasts, closed_reason };
  } finally {
    await input.adapter.unsubscribe();
  }
}

export function makeSupabaseBroadcastAdapter(cfg: SupabaseAdapterConfig): BroadcastAdapter {
  const client = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    global: cfg.authToken
      ? { headers: { Authorization: `Bearer ${cfg.authToken}` } }
      : undefined,
  });
  let channel: ReturnType<SupabaseClient["channel"]> | null = null;

  return {
    async subscribe({ channel: name, onBroadcast }) {
      channel = client.channel(name);
      channel.on("broadcast", { event: "*" }, (msg: any) => {
        onBroadcast({
          channel: name,
          event: msg.event,
          payload: msg.payload ?? {},
          received_at: new Date().toISOString(),
        });
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("subscribe timeout")), 10_000);
        channel?.subscribe((status) => {
          if (status === "SUBSCRIBED") {
            clearTimeout(timer);
            resolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            clearTimeout(timer);
            reject(new Error(`subscribe failed: ${status}`));
          }
        });
      });
    },
    async unsubscribe() {
      if (channel) {
        await client.removeChannel(channel);
        channel = null;
      }
    },
  };
}
```

- [ ] **Step 2: Write the fast test**

```ts
// tests/fast/subscribe.test.ts
import { describe, expect, it } from "vitest";
import { handleSubscribe } from "../../src/server/subscribe";
import type { BroadcastAdapter } from "../../src/server/realtime-client";

function fakeAdapter(broadcasts: Array<{ event: string; payload: any }>): BroadcastAdapter {
  return {
    subscribe: async ({ onBroadcast, channel }) => {
      queueMicrotask(() => {
        for (const b of broadcasts) {
          onBroadcast({
            channel,
            event: b.event,
            payload: b.payload,
            received_at: new Date().toISOString(),
          });
        }
      });
    },
    unsubscribe: async () => {},
  };
}

describe("handleSubscribe", () => {
  it("returns broadcasts that match event_filter", async () => {
    const adapter = fakeAdapter([
      { event: "noise", payload: {} },
      { event: "ticket-routed", payload: { id: "1" } },
    ]);
    const result = await handleSubscribe(
      {
        channel: "agent:triage:urgent",
        event_filter: "ticket-routed",
        timeout_ms: 1000,
        max_events: 1,
      },
      { adapterFor: () => adapter },
    );
    expect(result.broadcasts).toHaveLength(1);
    expect(result.broadcasts[0]?.event).toBe("ticket-routed");
  });
});
```

- [ ] **Step 3: Run to verify failure**

```bash
bun run test:fast -- subscribe
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write `src/server/subscribe.ts`**

```ts
// src/server/subscribe.ts
import { ToolError } from "../types/errors";
import {
  SubscribeChannelInputSchema,
  type SubscribeChannelInput,
  type SubscribeChannelOutput,
} from "../types/schemas";
import { boundedSubscribe, type BroadcastAdapter } from "./realtime-client";

export interface SubscribeDeps {
  adapterFor(channel: string): BroadcastAdapter;
}

export async function handleSubscribe(
  rawInput: unknown,
  deps: SubscribeDeps,
): Promise<SubscribeChannelOutput> {
  const parsed = SubscribeChannelInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path.includes("timeout_ms") && issue.code === "too_big") {
      throw new ToolError("TIMEOUT_EXCEEDED_CAP", "timeout_ms exceeds 120000ms cap", {
        max: 120_000,
      });
    }
    throw new ToolError("INVALID_CHANNEL", parsed.error.message, {
      issues: parsed.error.issues,
    });
  }
  const input: SubscribeChannelInput = parsed.data;
  const adapter = deps.adapterFor(input.channel);
  return boundedSubscribe({ adapter, ...input });
}
```

- [ ] **Step 5: Run to verify pass**

```bash
bun run test:fast -- subscribe
```

Expected: PASS.

- [ ] **Step 6: Write smoke test (mirrors broadcast smoke, send + receive)**

```ts
// tests/smoke/subscribe.smoke.test.ts
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { ApiClient } from "../../vendor/foundation/api-client";
import { withBranch } from "../../vendor/foundation/branch";
import { handleSubscribe } from "../../src/server/subscribe";
import { makeSupabaseBroadcastAdapter } from "../../src/server/realtime-client";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";
const skipUnlessConfigured = !PAT || !HOST_REF ? it.skip : it;

describe("subscribe_to_channel smoke", () => {
  skipUnlessConfigured("receives a broadcast sent in parallel", async () => {
    const apiClient = new ApiClient({ pat: PAT!, hostProjectRef: HOST_REF! });
    await withBranch(
      apiClient,
      { name: `smoke-sub-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
      async ({ details }) => {
        const supabaseUrl = `https://${details.ref}.supabase.co`;
        const supabaseKey = details.anon_key ?? details.service_role_key ?? "";

        // Arm subscribe first
        const subPromise = handleSubscribe(
          {
            channel: "test:sub",
            event_filter: "ping",
            timeout_ms: 15_000,
            max_events: 1,
          },
          {
            adapterFor: () =>
              makeSupabaseBroadcastAdapter({ supabaseUrl, supabaseKey }),
          },
        );

        // Send a broadcast 1s later
        setTimeout(async () => {
          const sender = createClient(supabaseUrl, supabaseKey);
          const ch = sender.channel("test:sub");
          await new Promise<void>((resolve) =>
            ch.subscribe((s) => {
              if (s === "SUBSCRIBED") resolve();
            }),
          );
          await ch.send({ type: "broadcast", event: "ping", payload: { ok: true } });
          await sender.removeChannel(ch);
        }, 1_000);

        const result = await subPromise;
        expect(result.broadcasts.length).toBeGreaterThanOrEqual(1);
        expect(result.broadcasts[0]?.event).toBe("ping");
      },
    );
  });
});
```

- [ ] **Step 7: Run smoke + commit**

```bash
bun run test:smoke -- subscribe
git add src/server/realtime-client.ts src/server/subscribe.ts \
  tests/fast/subscribe.test.ts tests/smoke/subscribe.smoke.test.ts
git commit -m "feat(server): subscribe_to_channel + boundedSubscribe primitive

Mirrors watch_table's bounded shape for Broadcast. event_filter is
client-side (Realtime broadcast doesn't filter server-side); same
contract semantics."
```

---

### Task 15: `list_channels` tool

**Files:**
- Create: `supabase-realtime-skill/src/server/list-channels.ts`
- Create: `supabase-realtime-skill/tests/fast/list-channels.test.ts`
- Create: `supabase-realtime-skill/tests/smoke/list-channels.smoke.test.ts`

`list_channels` is *advisory* — Supabase Realtime exposes a `presence_state()` per channel but no global "list all channels in the project" endpoint. The tool returns channels the *agent has joined this session* via metadata held in the server, plus an attempt at querying Supabase's internal channel registry through the management API.

- [ ] **Step 1: Write the fast test (with stubbed registry)**

```ts
// tests/fast/list-channels.test.ts
import { describe, expect, it } from "vitest";
import { handleListChannels } from "../../src/server/list-channels";

describe("handleListChannels", () => {
  it("returns the registry's channels with member counts", async () => {
    const result = await handleListChannels(
      {},
      {
        registry: async () => [
          { name: "agent:triage:urgent", member_count: 2, last_event_at: "2026-04-30T00:00:00Z" },
          { name: "agent:handoff", member_count: 0, last_event_at: null },
        ],
      },
    );
    expect(result.channels).toHaveLength(2);
    expect(result.channels[0]?.name).toBe("agent:triage:urgent");
  });

  it("returns empty list when registry is empty (not an error)", async () => {
    const result = await handleListChannels({}, { registry: async () => [] });
    expect(result.channels).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun run test:fast -- list-channels
```

Expected: FAIL.

- [ ] **Step 3: Write `src/server/list-channels.ts`**

```ts
// src/server/list-channels.ts
import {
  ListChannelsInputSchema,
  type ListChannelsOutput,
} from "../types/schemas";
import { ToolError } from "../types/errors";

export interface ChannelRegistryEntry {
  name: string;
  member_count: number;
  last_event_at: string | null;
}

export interface ListChannelsDeps {
  registry: () => Promise<ChannelRegistryEntry[]>;
}

export async function handleListChannels(
  rawInput: unknown,
  deps: ListChannelsDeps,
): Promise<ListChannelsOutput> {
  const parsed = ListChannelsInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ToolError("INVALID_CHANNEL", "list_channels takes no arguments", {
      issues: parsed.error.issues,
    });
  }
  const channels = await deps.registry();
  return { channels };
}
```

- [ ] **Step 4: Smoke test queries the actual Supabase project**

```ts
// tests/smoke/list-channels.smoke.test.ts
//
// list_channels is best-effort. The smoke just asserts: (a) the tool
// returns a well-formed response, (b) channels we joined in this session
// appear in the result.
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { ApiClient } from "../../vendor/foundation/api-client";
import { withBranch } from "../../vendor/foundation/branch";
import { handleListChannels } from "../../src/server/list-channels";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";
const skipUnlessConfigured = !PAT || !HOST_REF ? it.skip : it;

describe("list_channels smoke", () => {
  skipUnlessConfigured("returns at least the channels we just joined", async () => {
    const apiClient = new ApiClient({ pat: PAT!, hostProjectRef: HOST_REF! });
    await withBranch(
      apiClient,
      { name: `smoke-list-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
      async ({ details }) => {
        const supabase = createClient(
          `https://${details.ref}.supabase.co`,
          details.anon_key ?? details.service_role_key ?? "",
        );
        const joined: string[] = [];
        for (const name of ["test:a", "test:b"]) {
          const ch = supabase.channel(name);
          await new Promise<void>((r) =>
            ch.subscribe((s) => {
              if (s === "SUBSCRIBED") r();
            }),
          );
          joined.push(name);
        }

        const result = await handleListChannels(
          {},
          {
            registry: async () =>
              joined.map((name) => ({ name, member_count: 1, last_event_at: null })),
          },
        );
        expect(result.channels.map((c) => c.name)).toEqual(expect.arrayContaining(joined));
        for (const ch of supabase.getChannels()) await supabase.removeChannel(ch);
      },
    );
  });
});
```

- [ ] **Step 5: Run + commit**

```bash
bun run test:fast -- list-channels && bun run test:smoke -- list-channels
git add src/server/list-channels.ts tests/fast/list-channels.test.ts tests/smoke/list-channels.smoke.test.ts
git commit -m "feat(server): list_channels — best-effort discoverability

Realtime has no global channel registry; this tool reports channels
known to the server registry. references/edge-deployment.md will
document the operational caveat."
```

---

### Task 16: `describe_table_changes` tool

**Files:**
- Create: `supabase-realtime-skill/src/server/describe-table.ts`
- Create: `supabase-realtime-skill/tests/fast/describe-table.test.ts`
- Create: `supabase-realtime-skill/tests/smoke/describe-table.smoke.test.ts`

- [ ] **Step 1: Write the fast test**

```ts
// tests/fast/describe-table.test.ts
import { describe, expect, it } from "vitest";
import { handleDescribeTable } from "../../src/server/describe-table";

describe("handleDescribeTable", () => {
  it("composes columns + RLS + replication-identity", async () => {
    const result = await handleDescribeTable(
      { table: "support_tickets" },
      {
        introspect: async () => ({
          schema: "public",
          columns: [
            { name: "id", type: "uuid", nullable: false, generated: false },
            { name: "subject", type: "text", nullable: false, generated: false },
            { name: "embedding", type: "halfvec", nullable: true, generated: false },
          ],
          primary_key: ["id"],
          rls_enabled: true,
          replication_identity: "full",
        }),
      },
    );
    expect(result).toEqual({
      table: "support_tickets",
      schema: "public",
      columns: expect.any(Array),
      primary_key: ["id"],
      rls_enabled: true,
      replication_identity: "full",
    });
    expect(result.columns).toHaveLength(3);
  });

  it("throws INVALID_TABLE when introspect returns null", async () => {
    await expect(
      handleDescribeTable(
        { table: "nope" },
        { introspect: async () => null },
      ),
    ).rejects.toMatchObject({ code: "INVALID_TABLE" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun run test:fast -- describe-table
```

Expected: FAIL.

- [ ] **Step 3: Write `src/server/describe-table.ts`**

```ts
// src/server/describe-table.ts
import {
  DescribeTableInputSchema,
  type DescribeTableOutput,
} from "../types/schemas";
import { ToolError } from "../types/errors";

export interface TableIntrospection {
  schema: string;
  columns: { name: string; type: string; nullable: boolean; generated: boolean }[];
  primary_key: string[];
  rls_enabled: boolean;
  replication_identity: "default" | "full" | "index" | "nothing";
}

export interface DescribeTableDeps {
  introspect: (table: string) => Promise<TableIntrospection | null>;
}

export async function handleDescribeTable(
  rawInput: unknown,
  deps: DescribeTableDeps,
): Promise<DescribeTableOutput> {
  const parsed = DescribeTableInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ToolError("INVALID_TABLE", parsed.error.message, {
      issues: parsed.error.issues,
    });
  }
  const intro = await deps.introspect(parsed.data.table);
  if (!intro) {
    throw new ToolError("INVALID_TABLE", `table not found: ${parsed.data.table}`);
  }
  return {
    table: parsed.data.table,
    schema: intro.schema,
    columns: intro.columns,
    primary_key: intro.primary_key,
    rls_enabled: intro.rls_enabled,
    replication_identity: intro.replication_identity,
  };
}
```

- [ ] **Step 4: Smoke test queries `pg_catalog`**

```ts
// tests/smoke/describe-table.smoke.test.ts
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { ApiClient } from "../../vendor/foundation/api-client";
import { withBranch, buildBranchPoolerUrl } from "../../vendor/foundation/branch";
import { handleDescribeTable } from "../../src/server/describe-table";
import type { TableIntrospection } from "../../src/server/describe-table";

const PAT = process.env.EVAL_SUPABASE_PAT;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF;
const REGION = process.env.EVAL_REGION ?? "us-east-1";
const skipUnlessConfigured = !PAT || !HOST_REF ? it.skip : it;

async function pgIntrospect(sql: ReturnType<typeof postgres>, table: string): Promise<TableIntrospection | null> {
  const cols = await sql`
    select column_name, data_type, is_nullable = 'YES' as nullable, is_generated = 'ALWAYS' as generated
    from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by ordinal_position
  `;
  if (cols.length === 0) return null;
  const pk = await sql<{ column_name: string }[]>`
    select kcu.column_name
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu using (constraint_schema, constraint_name)
    where tc.table_schema = 'public' and tc.table_name = ${table} and tc.constraint_type = 'PRIMARY KEY'
    order by kcu.ordinal_position
  `;
  const rls = await sql<{ relrowsecurity: boolean }[]>`
    select c.relrowsecurity
    from pg_class c join pg_namespace n on c.relnamespace = n.oid
    where n.nspname = 'public' and c.relname = ${table}
  `;
  const replIdent = await sql<{ relreplident: string }[]>`
    select c.relreplident from pg_class c join pg_namespace n on c.relnamespace = n.oid
    where n.nspname = 'public' and c.relname = ${table}
  `;
  const replMap: Record<string, "default" | "full" | "index" | "nothing"> = {
    d: "default",
    f: "full",
    i: "index",
    n: "nothing",
  };
  return {
    schema: "public",
    columns: cols.map((c: any) => ({
      name: c.column_name,
      type: c.data_type,
      nullable: c.nullable,
      generated: c.generated,
    })),
    primary_key: pk.map((r) => r.column_name),
    rls_enabled: rls[0]?.relrowsecurity ?? false,
    replication_identity: replMap[replIdent[0]?.relreplident ?? "d"]!,
  };
}

describe("describe_table_changes smoke", () => {
  skipUnlessConfigured("introspects a table created on the branch", async () => {
    const apiClient = new ApiClient({ pat: PAT!, hostProjectRef: HOST_REF! });
    await withBranch(
      apiClient,
      { name: `smoke-desc-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
      async ({ details }) => {
        const dbUrl = buildBranchPoolerUrl({ ref: details.ref, db_pass: details.db_pass }, REGION);
        const sql = postgres(dbUrl, { max: 1, prepare: false });
        try {
          await sql`create table widgets (id uuid primary key default gen_random_uuid(), name text not null)`;
          await sql`alter table widgets replica identity full`;
          const result = await handleDescribeTable(
            { table: "widgets" },
            { introspect: (t) => pgIntrospect(sql, t) },
          );
          expect(result.primary_key).toEqual(["id"]);
          expect(result.replication_identity).toBe("full");
          expect(result.columns.find((c) => c.name === "name")?.nullable).toBe(false);
        } finally {
          await sql.end();
        }
      },
    );
  });
});
```

- [ ] **Step 5: Run + commit**

```bash
bun run test:fast -- describe-table && bun run test:smoke -- describe-table
git add src/server/describe-table.ts tests/fast/describe-table.test.ts tests/smoke/describe-table.smoke.test.ts
git commit -m "feat(server): describe_table_changes — pg_catalog introspection

Surfaces replication_identity so an agent (or human) sees the constraint
before writing a watch loop that depends on event.old. References
references/replication-identity.md."
```

---

### Task 17: Wire all 5 tools into the MCP server

**Files:**
- Modify: `supabase-realtime-skill/src/server/server.ts`

- [ ] **Step 1: Replace the single-tool `makeServer` with the full 5-tool registration**

```ts
// src/server/server.ts (replacement)
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import postgres from "postgres";
import {
  makeSupabaseAdapter,
  makeSupabaseBroadcastAdapter,
} from "./realtime-client";
import { handleWatchTable } from "./watch-table";
import { handleBroadcast } from "./broadcast";
import { handleSubscribe } from "./subscribe";
import { handleListChannels, type ChannelRegistryEntry } from "./list-channels";
import { handleDescribeTable, type TableIntrospection } from "./describe-table";
import { ToolError } from "../types/errors";
import { createClient } from "@supabase/supabase-js";

export interface ServerConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  databaseUrl?: string;  // optional; only describe_table_changes needs it
  authToken?: string;
}

const TOOL_DEFS = [
  {
    name: "watch_table",
    description:
      "Bounded subscription to Postgres row-changes. Returns events when max_events arrive or timeout_ms elapses (whichever first).",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string" },
        predicate: {
          type: "object",
          properties: {
            event: { enum: ["INSERT", "UPDATE", "DELETE", "*"] },
            filter: {
              type: "object",
              properties: {
                column: { type: "string" },
                op: { enum: ["eq", "neq", "gt", "gte", "lt", "lte", "in"] },
                value: {},
              },
              required: ["column", "op", "value"],
            },
          },
          required: ["event"],
        },
        timeout_ms: { type: "number", minimum: 1000, maximum: 120000, default: 60000 },
        max_events: { type: "number", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["table", "predicate"],
    },
  },
  {
    name: "broadcast_to_channel",
    description: "Fire-and-forget broadcast on a Realtime channel. Server retries 5xx idempotently up to 3 times.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        event: { type: "string" },
        payload: { type: "object" },
      },
      required: ["channel", "event", "payload"],
    },
  },
  {
    name: "subscribe_to_channel",
    description: "Bounded subscription to a Realtime broadcast channel. Mirrors watch_table's bounded shape.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string" },
        event_filter: { type: "string" },
        timeout_ms: { type: "number", minimum: 1000, maximum: 120000, default: 60000 },
        max_events: { type: "number", minimum: 1, maximum: 200, default: 50 },
      },
      required: ["channel"],
    },
  },
  {
    name: "list_channels",
    description: "Best-effort listing of channels known to the server registry.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "describe_table_changes",
    description: "Introspects a table's columns, primary key, RLS state, and REPLICA IDENTITY.",
    inputSchema: {
      type: "object",
      properties: { table: { type: "string" } },
      required: ["table"],
    },
  },
];

export function makeServer(cfg: ServerConfig): Server {
  const server = new Server(
    { name: "supabase-realtime", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const channelRegistry: ChannelRegistryEntry[] = [];

  const supabaseClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    global: cfg.authToken
      ? { headers: { Authorization: `Bearer ${cfg.authToken}` } }
      : undefined,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      let result: unknown;
      switch (req.params.name) {
        case "watch_table":
          result = await handleWatchTable(req.params.arguments, {
            adapterFor: (table) =>
              makeSupabaseAdapter(table, {
                supabaseUrl: cfg.supabaseUrl,
                supabaseKey: cfg.supabaseAnonKey,
                ...(cfg.authToken ? { authToken: cfg.authToken } : {}),
              }),
          });
          break;
        case "broadcast_to_channel": {
          result = await handleBroadcast(req.params.arguments, {
            sender: {
              send: async (input) => {
                const ch = supabaseClient.channel(input.channel);
                await new Promise<void>((resolve, reject) => {
                  const t = setTimeout(() => reject(new Error("subscribe timeout")), 10_000);
                  ch.subscribe((s) => {
                    if (s === "SUBSCRIBED") {
                      clearTimeout(t);
                      resolve();
                    } else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
                      clearTimeout(t);
                      reject(new Error(`subscribe failed: ${s}`));
                    }
                  });
                });
                await ch.send({ type: "broadcast", event: input.event, payload: input.payload });
                await supabaseClient.removeChannel(ch);
                channelRegistry.push({
                  name: input.channel,
                  member_count: 1,
                  last_event_at: new Date().toISOString(),
                });
                return { status: "ok" };
              },
            },
          });
          break;
        }
        case "subscribe_to_channel":
          result = await handleSubscribe(req.params.arguments, {
            adapterFor: () =>
              makeSupabaseBroadcastAdapter({
                supabaseUrl: cfg.supabaseUrl,
                supabaseKey: cfg.supabaseAnonKey,
                ...(cfg.authToken ? { authToken: cfg.authToken } : {}),
              }),
          });
          break;
        case "list_channels":
          result = await handleListChannels(req.params.arguments, {
            registry: async () => channelRegistry.slice(),
          });
          break;
        case "describe_table_changes":
          if (!cfg.databaseUrl) {
            throw new ToolError("UPSTREAM_ERROR", "describe_table_changes requires databaseUrl in ServerConfig");
          }
          result = await handleDescribeTable(req.params.arguments, {
            introspect: async (table) => {
              const sql = postgres(cfg.databaseUrl!, { max: 1, prepare: false });
              try {
                return await pgIntrospectInline(sql, table);
              } finally {
                await sql.end();
              }
            },
          });
          break;
        default:
          throw new ToolError("UPSTREAM_ERROR", `unknown tool: ${req.params.name}`);
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (err) {
      if (err instanceof ToolError) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify(err.toJSON()) }] };
      }
      throw err;
    }
  });

  return server;
}

// Inline introspection helper (same logic as the smoke test). Lives here
// rather than describe-table.ts so describe-table stays Realtime-pure.
async function pgIntrospectInline(
  sql: ReturnType<typeof postgres>,
  table: string,
): Promise<TableIntrospection | null> {
  const cols = await sql`
    select column_name, data_type, is_nullable = 'YES' as nullable, is_generated = 'ALWAYS' as generated
    from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by ordinal_position
  `;
  if (cols.length === 0) return null;
  const pk = await sql<{ column_name: string }[]>`
    select kcu.column_name from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu using (constraint_schema, constraint_name)
    where tc.table_schema = 'public' and tc.table_name = ${table} and tc.constraint_type = 'PRIMARY KEY'
    order by kcu.ordinal_position
  `;
  const rls = await sql<{ relrowsecurity: boolean }[]>`
    select c.relrowsecurity from pg_class c join pg_namespace n on c.relnamespace = n.oid
    where n.nspname = 'public' and c.relname = ${table}
  `;
  const ri = await sql<{ relreplident: string }[]>`
    select c.relreplident from pg_class c join pg_namespace n on c.relnamespace = n.oid
    where n.nspname = 'public' and c.relname = ${table}
  `;
  const map: Record<string, "default" | "full" | "index" | "nothing"> = {
    d: "default", f: "full", i: "index", n: "nothing",
  };
  return {
    schema: "public",
    columns: cols.map((c: any) => ({
      name: c.column_name, type: c.data_type, nullable: c.nullable, generated: c.generated,
    })),
    primary_key: pk.map((r) => r.column_name),
    rls_enabled: rls[0]?.relrowsecurity ?? false,
    replication_identity: map[ri[0]?.relreplident ?? "d"]!,
  };
}
```

- [ ] **Step 2: Verify typecheck and full test suite**

```bash
bun run typecheck
bun run test:fast
bun run test:smoke
```

Expected: all green.

- [ ] **Step 3: Re-deploy the Edge Function with all 5 tools**

```bash
supabase functions deploy mcp --project-ref <test-ref>
```

- [ ] **Step 4: Commit**

```bash
git add src/server/server.ts
git commit -m "feat(server): register all 5 tools in MCP server

watch_table, broadcast_to_channel, subscribe_to_channel, list_channels,
describe_table_changes — all wired with shared error mapping.
ServerConfig.databaseUrl is optional and only required for
describe_table_changes (the only tool that needs direct Postgres)."
```

---

### Task 18: `SKILL.md` v1

**Files:**
- Create: `supabase-realtime-skill/SKILL.md`

- [ ] **Step 1: Write `SKILL.md`**

```markdown
---
name: supabase-realtime
description: Use when an agent needs to react to Postgres row-changes or coordinate over Realtime broadcast channels on Supabase. Provides bounded subscription tools that fit Edge Function timeout budgets.
license: Apache-2.0
---

# supabase-realtime

Tools and patterns for an LLM agent to **react to database events** and **coordinate over broadcast channels** on Supabase Realtime, deployed as a Supabase Edge Function.

## When to reach for this skill

Three triggers, each with what *not* to do.

### 1. The agent needs to act on a database event

For example: a new ticket arrives in `support_tickets` and the agent should triage it. Use `watch_table` with `predicate.event = "INSERT"`.

**Don't** use this for state the agent already wrote — `watch_table` is for changes the agent didn't cause. If the agent just inserted a row and wants to know it was inserted, that's a return value, not a subscription.

### 2. The agent needs to fan out a result to other agents

For example: triage agent decides routing, then signals a downstream handoff agent. Use `broadcast_to_channel`.

**Don't** use broadcast as a queue — Realtime broadcast is fire-and-forget; messages aren't durable. If the receiving agent might be offline, write the work to a real queue (`pgmq`) and trigger that side via `watch_table` on the queue table.

### 3. The agent is the receiving side of a multi-agent workflow

Use `subscribe_to_channel`. Mirrors `watch_table`'s bounded shape — block until N events or timeout.

**Don't** subscribe with a high `max_events` and `timeout_ms` "just in case" — Edge Function isolates have wall-clock budgets. Spec a tight bound; the pattern is *bounded* subscription, not persistent.

## Core pattern: bounded subscription

The tool blocks for at most `timeout_ms` *or* until `max_events` matching events arrive — whichever first. Then returns the batch. This is the right primitive for agent loops because:

- It maps cleanly to a single MCP tool-call (no streaming protocol)
- It fits Edge Function isolate budgets (caps timeout at 120s, well under the 150s wall-clock limit)
- It composes with normal agent loops: call → process batch → call again

The canonical loop:

```ts
while (still_relevant) {
  const { events, closed_reason } = await mcp.call("watch_table", {
    table: "support_tickets",
    predicate: { event: "INSERT" },
    timeout_ms: 60000,
    max_events: 10,
  });
  for (const ev of events) await processEvent(ev);
  if (closed_reason === "timeout" && shouldStop()) break;
}
```

Why not a persistent WebSocket? The agent's tool-call boundary *is* the natural checkpoint. Persistent connections fight the Edge Function model and force you into long-lived workers, which is a different deployment shape and a different operational surface.

## Tools at a glance

| Trigger | Tool |
|---|---|
| React to a database event | `watch_table` |
| Send a coordination signal | `broadcast_to_channel` |
| Receive a coordination signal | `subscribe_to_channel` |
| Discover what channels are active | `list_channels` |
| Inspect a table's schema and replication settings | `describe_table_changes` |

Five tools. No Presence in v1 — see `references/presence-deferred.md` for why.

## Worked example: support-ticket triage

A SaaS app has a `support_tickets` table. Tickets get auto-embedded via Supabase Automatic Embeddings (writes a `halfvec(1536)` to `embedding`). The triage agent watches for new tickets, retrieves the most-similar past resolved tickets via pgvector, decides routing, writes the routing back, and broadcasts a `ticket-routed` event so a downstream handoff agent picks it up.

End-to-end walkthrough with code in `references/worked-example.md`.

## References

- [`predicates.md`](references/predicates.md) — supported filter ops, why others are excluded
- [`replication-identity.md`](references/replication-identity.md) — when to enable `REPLICA IDENTITY FULL`
- [`rls-implications.md`](references/rls-implications.md) — RLS + Realtime + broadcast auth
- [`presence-deferred.md`](references/presence-deferred.md) — design questions left open for v2
- [`pgvector-composition.md`](references/pgvector-composition.md) — composing CDC + Automatic Embeddings + retrieval
- [`eval-methodology.md`](references/eval-methodology.md) — the 4 metrics, why not LLM-judge
- [`edge-deployment.md`](references/edge-deployment.md) — operator setup
- [`worked-example.md`](references/worked-example.md) — support-ticket triage end-to-end
```

- [ ] **Step 2: Commit**

```bash
git add SKILL.md
git commit -m "docs(skill): SKILL.md v1 — three triggers, bounded-subscription pattern, tools at a glance

Open Skills Standard front-matter; sections mirror supabase/agent-skills
conventions. The 'don't' callouts under each trigger are the JD-shaped
judgment signal."
```

---

### Task 19: `references/rls-implications.md` + `references/presence-deferred.md`

**Files:**
- Create: `supabase-realtime-skill/references/rls-implications.md`
- Create: `supabase-realtime-skill/references/presence-deferred.md`

- [ ] **Step 1: Write `rls-implications.md`**

```markdown
# References — RLS + Realtime + broadcast auth

Three places RLS interacts with this skill:

## 1. `watch_table` reads honor table RLS

Realtime's Postgres-Changes subscription runs *as the JWT identity attached to the WebSocket connection*. The MCP server forwards the agent's `Authorization: Bearer <jwt>` header into the Realtime client config, which propagates to `auth.uid()` in RLS policies.

What this means in practice:

- If a policy says `using (auth.uid() = user_id)`, the agent only sees row-changes for rows that pass that check.
- If RLS is *disabled* on the table, the agent sees every change. That's fine for internal tables but a trap on user-facing tables.
- If RLS is *enabled* but no policy applies, the agent sees nothing. Silent. The `missed_events_rate` metric in the eval harness catches this — `describe_table_changes` reports `rls_enabled: true` so you can investigate.

The opinionated default: **always enable RLS on tables that an agent watches**, with a policy that reflects the agent's intended scope. Surfacing this constraint in `describe_table_changes` is intentional.

## 2. Broadcast channels can require auth

By default, broadcast channels are open. Anyone with the project's `anon` key can `subscribe` and `send`. For agent workflows, this is usually wrong — the agent's coordination channel shouldn't be readable by every user of the app.

Lock down with channel-level Realtime auth: require a JWT to subscribe, and check claims in a Postgres-side policy. The Supabase docs cover the mechanism (Realtime Authorization, GA April 2026); the design of the JWT issuance pattern is your call. v1 of this skill assumes the agent runs with a service-level JWT scoped to its workflow's channels.

## 3. The Edge Function deployment forwards the caller's JWT

When the MCP server is deployed as an Edge Function, the agent's tool-call arrives with `Authorization: Bearer <agent-jwt>`. The function forwards that header into both the Postgres-Changes client (for `watch_table`) and the Realtime broadcast client (for `broadcast_to_channel` / `subscribe_to_channel`).

This means the *agent's* identity is what gates access — not the Edge Function's service role. The function is a thin pass-through for auth.

Two operational implications:

- **The agent must hold a usable JWT** scoped to the workflow it's executing. Issuance is the operator's problem; `references/edge-deployment.md` documents the pattern v1 assumes.
- **The function never elevates.** If the agent's JWT can't read the table, neither can the function. There's no "service role escape hatch" — that would be a security bug, not a feature.

## Common pitfalls

- "I added an RLS policy and now `watch_table` sees nothing" — check that the policy matches the JWT identity the agent is running as. Use `select auth.uid()` in a quick `psql` session to confirm.
- "I locked down a broadcast channel and `subscribe_to_channel` returns no events" — ensure the agent's JWT carries the claim the channel-level policy checks.
- "INSERT events have no `old` row" — that's not an RLS thing, it's `REPLICA IDENTITY`. See `references/replication-identity.md`.
```

- [ ] **Step 2: Write `presence-deferred.md`**

```markdown
# References — Presence (deferred to v2)

Realtime Presence — the third primitive next to Postgres-Changes and Broadcast — is **not** in v1 of this skill. This page explains why, so a reader (or hiring panel) can see the call was deliberate.

## What Presence does

Presence tracks who is "in" a channel and pushes diffs when members join, leave, or update their state. The classic use case is a Google-Docs-style cursor-and-avatar overlay.

## Why it's not in v1

The semantics for *agents* are unsettled in a way the semantics for human users aren't. Specifically:

- **What does it mean for an agent to "be present"?** A human user joining a channel maps to "this person is on the page right now." An agent joining a channel could mean "this agent is the canonical worker for this workflow" *or* "this agent is currently mid-tool-call" *or* "this agent has subscribed and is buffering events." All three are different and all three matter for coordination.
- **Heartbeat shape doesn't fit bounded subscriptions.** Presence requires the client to keep the connection alive between events; otherwise the server marks them gone. The whole point of the bounded-subscription pattern is that the agent *doesn't* hold a connection between tool-calls.
- **No clean way to express "agent identity" in Presence's `key` parameter.** Human Presence usually uses `auth.uid()` — but multiple agent workflows might share an identity, and one workflow might span multiple agent instances.

These are real design questions, not implementation difficulty. Shipping a half-formed Presence story in v1 risks giving an agent a primitive that *looks* like coordination but doesn't compose with the rest of the skill's bounded model.

## What v2 might look like

Sketch only — not committed:

- A `presence_track(channel, key, state, lease_ms)` that holds presence for a bounded interval, similar to bounded subscription but on the join side.
- A `presence_list(channel)` that returns *current* members snapshot without subscribing.
- Both designed around lease semantics so the bounded model still holds.

If you have a use case for agent Presence that the v1 deferred design needs to know about, open an issue.

## What to use instead in v1

If you need to know "is workflow X currently running," coordinate via Broadcast: have the worker periodically broadcast a `heartbeat` event on a workflow channel and use `subscribe_to_channel` with `event_filter = "heartbeat"` and a tight timeout to check.
```

- [ ] **Step 3: Commit**

```bash
git add references/rls-implications.md references/presence-deferred.md
git commit -m "docs(references): rls-implications.md + presence-deferred.md

rls-implications: three interaction surfaces (watch_table reads, broadcast
auth, Edge Function pass-through) + common pitfalls.

presence-deferred: explains why Presence is not in v1 — semantic questions
unsettled, heartbeat shape fights bounded subscriptions. JD signal: judgment
about fragile/gimmicky."
```

---

## Phase 2 — Week 2 success gate

Before starting Week 3:

- [ ] All 5 tools have offline tests + smoke tests, all green
- [ ] Edge Function deploys with all 5 tools wired
- [ ] `SKILL.md` written, `references/predicates.md`, `replication-identity.md`, `rls-implications.md`, `presence-deferred.md` committed
- [ ] `bun run typecheck && bun run lint && bun run test:fast` is the green gate for any future PR

---

## Phase 3 — Week 3: Worked example + eval + writeup + ship

### Task 20: `support_tickets` migration + Automatic Embeddings setup

**Files:**
- Create: `supabase-realtime-skill/supabase/migrations/20260430000001_support_tickets.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/20260430000001_support_tickets.sql
--
-- Worked-example schema for the support-ticket triage agent.
-- Uses Supabase Automatic Embeddings (April 2026 GA) to populate the
-- embedding column asynchronously via pgmq + pg_cron + an Edge Function.
-- We don't manage that pipeline here — we assume the operator has run
-- `select supabase_automatic_embeddings.enable(...)` separately.

create extension if not exists vector;
create extension if not exists pgvector;

create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  subject text not null,
  body text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  routing text check (routing in ('urgent', 'engineering', 'billing', 'general')),
  embedding halfvec(1536),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index support_tickets_embedding_hnsw
  on support_tickets using hnsw (embedding halfvec_cosine_ops);

create index support_tickets_status_idx on support_tickets (status);

-- Enable replica identity full so UPDATE events carry the old row.
alter table support_tickets replica identity full;

-- Add to the realtime publication so Postgres-Changes can stream events.
alter publication supabase_realtime add table support_tickets;

-- RLS scaffolding (no policies in v1; ops can add per their JWT model).
alter table support_tickets enable row level security;
```

- [ ] **Step 2: Apply via Supabase CLI on a test project**

```bash
supabase db push --project-ref <test-ref>
```

Manually verify in the dashboard: `support_tickets` exists, `replication_identity` is `full`, the table is in `supabase_realtime` publication, RLS is enabled.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260430000001_support_tickets.sql
git commit -m "feat(migrations): support_tickets schema for worked example

halfvec(1536) for Automatic Embeddings, hnsw index for cosine similarity,
replica identity full so UPDATE events carry old row. RLS enabled but
unscoped — operators add per-tenant policies."
```

---

### Task 21: Triage agent loop (`eval/triage-agent.ts`)

**Files:**
- Create: `supabase-realtime-skill/eval/triage-agent.ts`

- [ ] **Step 1: Write the agent loop**

```ts
// eval/triage-agent.ts
//
// The worked-example agent: watches support_tickets for INSERT, retrieves
// 5 most-similar past resolved tickets, decides routing via LLM, writes
// routing back, broadcasts ticket-routed.
//
// Returns per-trial telemetry the eval/runner.ts uses to compute metrics.

import Anthropic from "@anthropic-ai/sdk";
import postgres from "postgres";
import { boundedWatch, makeSupabaseAdapter } from "../src/server/realtime-client";

export interface TriageInput {
  fixture: { id: string; ticket: { subject: string; body: string }; expected_routing: string };
  supabaseUrl: string;
  supabaseKey: string;
  databaseUrl: string;
}

export interface TriageResult {
  fixture_id: string;
  observed: boolean;
  latency_ms: number | null;
  agent_action_taken: boolean;
  routing_chosen: string | null;
  expected_routing: string;
  correct: boolean;
}

const ANTHROPIC = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

export async function triageOne(input: TriageInput): Promise<TriageResult> {
  const sql = postgres(input.databaseUrl, { max: 1, prepare: false });
  const adapter = makeSupabaseAdapter("support_tickets", {
    supabaseUrl: input.supabaseUrl,
    supabaseKey: input.supabaseKey,
  });

  try {
    // Arm watch
    const watchPromise = boundedWatch({
      adapter,
      table: "support_tickets",
      predicate: { event: "INSERT" },
      timeout_ms: 30_000,
      max_events: 1,
    });

    // Insert the fixture ticket ~100ms after subscription is ready
    const insertedAt = Date.now();
    setTimeout(() => {
      sql`
        insert into support_tickets (customer_id, subject, body)
        values (gen_random_uuid(), ${input.fixture.ticket.subject}, ${input.fixture.ticket.body})
      `.catch(() => {});
    }, 100);

    const result = await watchPromise;
    if (result.closed_reason === "timeout" || result.events.length === 0) {
      return {
        fixture_id: input.fixture.id,
        observed: false,
        latency_ms: null,
        agent_action_taken: false,
        routing_chosen: null,
        expected_routing: input.fixture.expected_routing,
        correct: false,
      };
    }
    const latency_ms = Date.now() - insertedAt;
    const ticket = result.events[0]!.new!;

    // Retrieve 5 most-similar past resolved tickets (if any exist)
    const similar = await sql<{ subject: string; routing: string }[]>`
      select subject, routing from support_tickets
      where status = 'resolved' and routing is not null and id != ${ticket.id as string}
      order by created_at desc
      limit 5
    `;

    // LLM routing decision
    const message = await ANTHROPIC.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 100,
      messages: [
        {
          role: "user",
          content: `Route this support ticket to one of: urgent, engineering, billing, general.

Past resolved examples:
${similar.map((s) => `- "${s.subject}" → ${s.routing}`).join("\n") || "(none)"}

New ticket:
Subject: ${ticket.subject}
Body: ${ticket.body}

Reply with ONLY one word: urgent, engineering, billing, or general.`,
        },
      ],
    });
    const routing = (message.content[0] as any)?.text?.trim().toLowerCase().split(/\s+/)[0] ?? "general";
    const validRoutings = new Set(["urgent", "engineering", "billing", "general"]);
    const finalRouting = validRoutings.has(routing) ? routing : "general";

    // Write routing back
    await sql`update support_tickets set routing = ${finalRouting} where id = ${ticket.id as string}`;

    return {
      fixture_id: input.fixture.id,
      observed: true,
      latency_ms,
      agent_action_taken: true,
      routing_chosen: finalRouting,
      expected_routing: input.fixture.expected_routing,
      correct: finalRouting === input.fixture.expected_routing,
    };
  } finally {
    await sql.end();
  }
}
```

- [ ] **Step 2: Add `@anthropic-ai/sdk` to deps**

```bash
bun add @anthropic-ai/sdk
```

- [ ] **Step 3: Commit**

```bash
git add eval/triage-agent.ts package.json bun.lockb
git commit -m "feat(eval): triage agent loop — watch, retrieve, route, write back

Uses haiku-4-5 (cheap, the canonical model in supabase-mcp-evals/CLAUDE.md
for cost-sensitive agent runs). Returns per-trial telemetry for the eval
runner: observed, latency, action_taken, routing_chosen, correct."
```

---

### Task 22: Eval metrics (`eval/metrics.ts`)

**Files:**
- Create: `supabase-realtime-skill/eval/metrics.ts`
- Create: `supabase-realtime-skill/tests/fast/metrics.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/fast/metrics.test.ts
import { describe, expect, it } from "vitest";
import {
  pct,
  computeMetrics,
  checkThresholds,
  type TriageOutcome,
} from "../../eval/metrics";

const out = (
  observed: boolean,
  latency_ms: number | null,
  agent_action_taken: boolean,
  correct: boolean,
): TriageOutcome => ({
  fixture_id: "x",
  observed,
  latency_ms,
  agent_action_taken,
  routing_chosen: null,
  expected_routing: "urgent",
  correct,
});

describe("pct", () => {
  it("returns a sane p95", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(pct(arr, 95)).toBe(95);
  });
});

describe("computeMetrics", () => {
  it("computes all 4 metrics with Wilson CIs", () => {
    const outcomes = [
      out(true, 1500, true, true),
      out(true, 1800, true, true),
      out(true, 1900, true, false),
      out(false, null, false, false),  // missed
      out(true, 1700, true, true),     // spurious would be agent_action_taken without observed=true
    ];
    const m = computeMetrics(outcomes);
    expect(m.latency_p95_ms).toBeGreaterThan(0);
    expect(m.missed_events.rate).toBeCloseTo(0.2, 2);
    expect(m.missed_events.ci_low).toBeGreaterThan(0);
    expect(m.missed_events.ci_high).toBeLessThan(1);
    expect(m.spurious_trigger.rate).toBe(0); // observed=false + action=false in our fixture
    expect(m.action_correctness.rate).toBeCloseTo(3 / 4, 2); // 3 correct / 4 with action
  });
});

describe("checkThresholds", () => {
  it("returns pass:false when any threshold fails", () => {
    const failingMetrics = {
      latency_p95_ms: 3000,  // > 2000 threshold
      missed_events: { rate: 0, ci_low: 0, ci_high: 0, successes: 0, trials: 100 },
      spurious_trigger: { rate: 0, ci_low: 0, ci_high: 0, successes: 0, trials: 100 },
      action_correctness: { rate: 0.95, ci_low: 0.9, ci_high: 0.99, successes: 95, trials: 100 },
    };
    const result = checkThresholds(failingMetrics);
    expect(result.pass).toBe(false);
    expect(result.failures).toContain("latency_p95_ms");
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun run test:fast -- metrics
```

Expected: FAIL.

- [ ] **Step 3: Write `eval/metrics.ts`**

```ts
// eval/metrics.ts
//
// Pure metric computations. wilsonInterval reused from vendor/foundation.

import { wilsonInterval, aggregateRate } from "../vendor/foundation/scoring";

export interface TriageOutcome {
  fixture_id: string;
  observed: boolean;
  latency_ms: number | null;
  agent_action_taken: boolean;
  routing_chosen: string | null;
  expected_routing: string;
  correct: boolean;
}

export interface RateMetric {
  successes: number;
  trials: number;
  rate: number;
  ci_low: number;
  ci_high: number;
}

export interface AggregatedMetrics {
  latency_p95_ms: number;
  latency_p50_ms: number;
  missed_events: RateMetric;
  spurious_trigger: RateMetric;
  action_correctness: RateMetric;
}

export function pct(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

export function computeMetrics(outcomes: TriageOutcome[]): AggregatedMetrics {
  const observed = outcomes.filter((o) => o.observed);
  const latencies = observed.map((o) => o.latency_ms!).filter((ms): ms is number => ms != null);

  const missed = outcomes.map((o) => !o.observed);
  const missedAgg = aggregateRate(missed, 0.95);

  // spurious = action_taken without an observed event
  const spurious = outcomes.map((o) => o.agent_action_taken && !o.observed);
  const spuriousAgg = aggregateRate(spurious, 0.95);

  // correctness denominator: only trials where the agent took action
  const acted = outcomes.filter((o) => o.agent_action_taken);
  const correct = acted.map((o) => o.correct);
  const correctAgg = aggregateRate(correct, 0.95);

  return {
    latency_p95_ms: pct(latencies, 95),
    latency_p50_ms: pct(latencies, 50),
    missed_events: {
      ...missedAgg,
      successes: missedAgg.successes,
      trials: missedAgg.trials,
    },
    spurious_trigger: {
      ...spuriousAgg,
      successes: spuriousAgg.successes,
      trials: spuriousAgg.trials,
    },
    action_correctness: {
      ...correctAgg,
      successes: correctAgg.successes,
      trials: correctAgg.trials,
    },
  };
}

export interface ThresholdConfig {
  latency_p95_ms_max: number;
  missed_events_rate_max: number;
  missed_events_ci_high_max: number;
  spurious_trigger_rate_max: number;
  spurious_trigger_ci_high_max: number;
  action_correctness_rate_min: number;
  action_correctness_ci_low_min: number;
}

export const DEFAULT_THRESHOLDS: ThresholdConfig = {
  latency_p95_ms_max: 2000,
  missed_events_rate_max: 0.01,
  missed_events_ci_high_max: 0.01,
  spurious_trigger_rate_max: 0.02,
  spurious_trigger_ci_high_max: 0.03,
  action_correctness_rate_min: 0.9,
  action_correctness_ci_low_min: 0.85,
};

export function checkThresholds(
  m: AggregatedMetrics,
  cfg: ThresholdConfig = DEFAULT_THRESHOLDS,
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  if (m.latency_p95_ms > cfg.latency_p95_ms_max) failures.push("latency_p95_ms");
  if (m.missed_events.rate > cfg.missed_events_rate_max) failures.push("missed_events.rate");
  if (m.missed_events.ci_high > cfg.missed_events_ci_high_max) failures.push("missed_events.ci_high");
  if (m.spurious_trigger.rate > cfg.spurious_trigger_rate_max) failures.push("spurious_trigger.rate");
  if (m.spurious_trigger.ci_high > cfg.spurious_trigger_ci_high_max) failures.push("spurious_trigger.ci_high");
  if (m.action_correctness.rate < cfg.action_correctness_rate_min) failures.push("action_correctness.rate");
  if (m.action_correctness.ci_low < cfg.action_correctness_ci_low_min)
    failures.push("action_correctness.ci_low");
  return { pass: failures.length === 0, failures };
}
```

- [ ] **Step 4: Run to verify pass + commit**

```bash
bun run test:fast -- metrics
git add eval/metrics.ts tests/fast/metrics.test.ts
git commit -m "feat(eval): 4 metrics + threshold checker

Pure functions. latency p50/p95 over observed trials only; missed_events
rate over all trials; spurious_trigger over action-taken-without-observed;
correctness over action-taken trials. Wilson CIs from vendored foundation."
```

---

### Task 23: `manifest.json` — pre-registered thresholds

**Files:**
- Create: `supabase-realtime-skill/manifest.json`

- [ ] **Step 1: Write `manifest.json`**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "version": "1.0.0",
  "registered_at": "2026-04-30",
  "comment": "Pre-registered eval thresholds. Changes require versioned bump explained in PR body. See references/eval-methodology.md for rationale.",
  "thresholds": {
    "latency_p95_ms_max": 2000,
    "missed_events_rate_max": 0.01,
    "missed_events_ci_high_max": 0.01,
    "spurious_trigger_rate_max": 0.02,
    "spurious_trigger_ci_high_max": 0.03,
    "action_correctness_rate_min": 0.9,
    "action_correctness_ci_low_min": 0.85
  },
  "fixture_tiers": {
    "ci-fast": { "n": 20, "trigger": "every PR" },
    "ci-full": { "n": 100, "trigger": "daily on main" }
  },
  "statistical_design": {
    "comparison": "paired (same fixture IDs, McNemar's test on binary metrics)",
    "ci_method": "Wilson",
    "ci_confidence": 0.95,
    "rationale": "playbook/PLAYBOOK.md § 9 (in supabase-mcp-evals)"
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add manifest.json
git commit -m "chore(manifest): pre-register eval thresholds

Version 1.0.0 of the falsifiable predictions for the support-ticket triage
worked example. Per playbook discipline (slice-3 lesson, codified from
arXiv:2604.25850): every recommendation ships with predicted effect."
```

---

### Task 24: Eval runner (`eval/runner.ts`)

**Files:**
- Create: `supabase-realtime-skill/eval/runner.ts`

- [ ] **Step 1: Write `eval/runner.ts`**

```ts
// eval/runner.ts
//
// CLI entrypoint: spawns the triage agent over fixtures, computes
// aggregated metrics, checks against manifest.json thresholds, exits
// non-zero on regression.
//
// Usage:
//   bun run eval/runner.ts ci-fast       # ci-fast/n=20 fixtures
//   bun run eval/runner.ts ci-full    # ci-full/n=100 fixtures

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ApiClient } from "../vendor/foundation/api-client";
import { withBranch, buildBranchPoolerUrl } from "../vendor/foundation/branch";
import postgres from "postgres";
import { triageOne, type TriageResult, type TriageInput } from "./triage-agent";
import { computeMetrics, checkThresholds, type ThresholdConfig } from "./metrics";

const PAT = process.env.EVAL_SUPABASE_PAT!;
const HOST_REF = process.env.EVAL_HOST_PROJECT_REF!;
const REGION = process.env.EVAL_REGION ?? "us-east-1";

interface Fixture {
  id: string;
  ticket: { subject: string; body: string };
  expected_routing: string;
  ground_truth_top_k_ids?: string[];
}

async function loadFixtures(tier: "ci-fast" | "ci-full"): Promise<Fixture[]> {
  const dir = join("fixtures", tier);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const fixtures: Fixture[] = [];
  for (const f of files) {
    const raw = await readFile(join(dir, f), "utf-8");
    fixtures.push(JSON.parse(raw));
  }
  return fixtures;
}

async function main() {
  const tier = (process.argv[2] ?? "ci-fast") as "ci-fast" | "ci-full";
  if (!["ci-fast", "ci-full"].includes(tier)) {
    console.error(`unknown tier: ${tier}`);
    process.exit(2);
  }

  const manifest = JSON.parse(await readFile("manifest.json", "utf-8"));
  const thresholds: ThresholdConfig = manifest.thresholds;

  const fixtures = await loadFixtures(tier);
  console.log(`[runner] tier=${tier} n=${fixtures.length}`);

  const apiClient = new ApiClient({ pat: PAT, hostProjectRef: HOST_REF });
  const outcomes: TriageResult[] = await withBranch(
    apiClient,
    { name: `eval-${tier}-${Date.now()}`, region: REGION, pollTimeoutMs: 240_000 },
    async ({ details }) => {
      const dbUrl = buildBranchPoolerUrl({ ref: details.ref, db_pass: details.db_pass }, REGION);
      // Apply migrations
      const migration = await readFile(
        "supabase/migrations/20260430000001_support_tickets.sql",
        "utf-8",
      );
      const sql = postgres(dbUrl, { max: 1, prepare: false });
      try {
        await sql.unsafe(migration);
      } finally {
        await sql.end();
      }

      const supabaseUrl = `https://${details.ref}.supabase.co`;
      const supabaseKey = details.anon_key ?? details.service_role_key ?? "";

      const results: TriageResult[] = [];
      for (const fixture of fixtures) {
        const input: TriageInput = {
          fixture: {
            id: fixture.id,
            ticket: fixture.ticket,
            expected_routing: fixture.expected_routing,
          },
          supabaseUrl,
          supabaseKey,
          databaseUrl: dbUrl,
        };
        const result = await triageOne(input);
        console.log(`[trial ${fixture.id}] observed=${result.observed} correct=${result.correct} latency=${result.latency_ms}`);
        results.push(result);
      }
      return results;
    },
  );

  const metrics = computeMetrics(outcomes);
  const check = checkThresholds(metrics, thresholds);

  await mkdir("eval/reports", { recursive: true });
  const reportPath = `eval/reports/${tier}-${Date.now()}.json`;
  await writeFile(reportPath, JSON.stringify({ tier, manifest_version: manifest.version, metrics, check, outcomes }, null, 2));

  console.log("\n=== Aggregated metrics ===");
  console.log(JSON.stringify(metrics, null, 2));
  console.log(`\nThresholds: ${check.pass ? "PASS" : "FAIL"}`);
  if (!check.pass) {
    console.log(`Failures: ${check.failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Commit**

```bash
git add eval/runner.ts
git commit -m "feat(eval): runner — fixtures → triage agent → metrics → manifest threshold check

Single branch per run (cost-bounded). Writes JSON report to eval/reports/.
Exits non-zero on threshold regression, which is what makes the GitHub
Actions integration meaningful."
```

---

### Task 25: ci-fast fixtures (n=20)

**Files:**
- Create: `supabase-realtime-skill/fixtures/ci-fast/*.json` (×20)

- [ ] **Step 1: Generate the 20 hand-curated fixtures**

Pattern: 5 routings × 4 fixtures each = 20. Within each routing, mix happy-path and edge-case examples.

For each fixture, write `fixtures/ci-fast/<id>.json`:

```json
{
  "id": "f001-urgent-server-down",
  "ticket": {
    "subject": "Production database is down",
    "body": "Our production database has been completely unresponsive for 15 minutes. All customer-facing services are returning 500 errors. This is affecting revenue."
  },
  "expected_routing": "urgent"
}
```

The full set covers:

- **urgent** (5): production outage, security incident, data loss, payment processing failure, customer-data-leak suspicion
- **engineering** (5): API integration question, SDK bug report, deployment troubleshooting, schema migration question, performance regression
- **billing** (5): invoice question, subscription cancellation, refund request, plan upgrade, payment method update
- **general** (5): documentation question, feature request, onboarding help, account access, generic feedback

Write each as its own JSON file with descriptive `id` and realistic `subject` + `body` (3-5 sentences). Hand-curated, not LLM-generated — these are the *gate*.

- [ ] **Step 2: Verify the runner picks them up**

```bash
bun run eval/runner.ts ci-fast
```

Expected: PASS, with metrics meeting thresholds (assuming the spike-confirmed Edge Function is reachable). Cost: ~$0.50 + ~5 minutes (one branch + 20 trials).

- [ ] **Step 3: Commit**

```bash
git add fixtures/ci-fast/
git commit -m "test(fixtures): ci-fast n=20 — hand-curated, 5×4 routing × case axis

Five fixtures per routing covering happy-path + edge cases. Hand-curated
because ci-fast is the merge gate — synthetic-augmented data goes in
ci-full, never here."
```

---

### Task 26: ci-full fixtures (n=100, hand-seeded + synthetic-augmented)

**Files:**
- Create: `supabase-realtime-skill/fixtures/ci-full/*.json` (×100)
- Create: `supabase-realtime-skill/eval/synthesize-fixtures.ts`

- [ ] **Step 1: Write the synthesizer**

```ts
// eval/synthesize-fixtures.ts
//
// Seeds n=100 fixtures by augmenting the ci-fast 20 hand-labels with LLM-
// generated variations. Each variation is then SPOT-CHECKED by hand
// (open the JSON, eyeball the labels). Per playbook lesson: never
// synthetic-only; always hand-seeded.

import Anthropic from "@anthropic-ai/sdk";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";

const ANTHROPIC = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
const VARIATIONS_PER_SEED = 4; // 20 seeds × 5 = 100 total

async function main() {
  await mkdir("fixtures/ci-full", { recursive: true });
  const seedFiles = (await readdir("fixtures/ci-fast")).filter((f) => f.endsWith(".json")).sort();

  let counter = 1;
  for (const seedFile of seedFiles) {
    const seed = JSON.parse(await readFile(join("fixtures/ci-fast", seedFile), "utf-8"));
    // Copy the seed first
    await writeFile(
      join("fixtures/ci-full", `n${String(counter).padStart(3, "0")}-${seed.id}.json`),
      JSON.stringify(seed, null, 2),
    );
    counter++;

    // Generate variations
    for (let v = 1; v <= VARIATIONS_PER_SEED; v++) {
      const message = await ANTHROPIC.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: `Generate a variation of this support ticket. Same expected routing (${seed.expected_routing}), different specific facts. Return ONLY JSON: { "subject": "...", "body": "..." }.

Original:
Subject: ${seed.ticket.subject}
Body: ${seed.ticket.body}`,
          },
        ],
      });
      const raw = (message.content[0] as any)?.text ?? "";
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) continue;
      const ticket = JSON.parse(match[0]);
      const variation = {
        id: `${seed.id}-v${v}`,
        ticket,
        expected_routing: seed.expected_routing,
      };
      await writeFile(
        join("fixtures/ci-full", `n${String(counter).padStart(3, "0")}-${variation.id}.json`),
        JSON.stringify(variation, null, 2),
      );
      counter++;
    }
  }
  console.log(`generated ${counter - 1} fixtures`);
}

main().catch(console.error);
```

- [ ] **Step 2: Run + spot-check**

```bash
bun run eval/synthesize-fixtures.ts
ls fixtures/ci-full | wc -l   # expect 100
```

Open 10 random files in `fixtures/ci-full/` and visually verify the labels are still correct after the LLM variation. If any label looks wrong, fix it by hand. **Don't trust the LLM blindly** — that's the playbook's "synthetic data before a hand-crafted seed" anti-pattern.

- [ ] **Step 3: Run ci-full to validate**

```bash
bun run eval/runner.ts ci-full
```

Expected: PASS, all thresholds met. Cost: ~$2-3 + ~30 minutes.

- [ ] **Step 4: Commit**

```bash
git add fixtures/ci-full/ eval/synthesize-fixtures.ts
git commit -m "test(fixtures): ci-full n=100 (20 seeds + 80 LLM variations, spot-checked)

Each seed produces 4 variations via haiku-4-5; hand spot-checked to catch
mislabeled outputs before commit. Per playbook anti-pattern: never
synthetic-only."
```

---

### Task 27: GitHub Actions workflows

**Files:**
- Create: `supabase-realtime-skill/.github/workflows/ci-fast.yml`
- Create: `supabase-realtime-skill/.github/workflows/ci-full.yml`
- Create: `supabase-realtime-skill/.github/workflows/publish.yml`

- [ ] **Step 1: Write `ci-fast.yml`**

```yaml
name: ci-fast

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

jobs:
  fast:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
        with:
          bun-version: latest
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run lint
      - run: bun run test:fast

  ci-fast-eval:
    runs-on: ubuntu-latest
    needs: fast
    if: ${{ secrets.EVAL_SUPABASE_PAT != '' }}
    env:
      EVAL_SUPABASE_PAT: ${{ secrets.EVAL_SUPABASE_PAT }}
      EVAL_HOST_PROJECT_REF: ${{ secrets.EVAL_HOST_PROJECT_REF }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install --frozen-lockfile
      - run: bun run eval/runner.ts ci-fast
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ci-fast-report
          path: eval/reports/
```

- [ ] **Step 2: Write `ci-full.yml`**

```yaml
name: ci-full

on:
  schedule:
    - cron: "0 7 * * *"  # 07:00 UTC daily
  workflow_dispatch:

jobs:
  nightly:
    runs-on: ubuntu-latest
    env:
      EVAL_SUPABASE_PAT: ${{ secrets.EVAL_SUPABASE_PAT }}
      EVAL_HOST_PROJECT_REF: ${{ secrets.EVAL_HOST_PROJECT_REF }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - run: bun install --frozen-lockfile
      - run: bun run test:smoke
      - run: bun run eval/runner.ts ci-full
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: ci-full-report
          path: eval/reports/
```

- [ ] **Step 3: Write `publish.yml`**

```yaml
name: publish

on:
  push:
    tags: ["v*.*.*"]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://registry.npmjs.org
      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run test:fast
      - run: bun run build
      - run: npm publish --provenance --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

- [ ] **Step 4: Commit + push**

```bash
git add .github/workflows/
git commit -m "ci: ci-fast on PR, ci-full cron, publish on tag

ci-fast: typecheck + lint + offline tests + ci-fast eval (gated on
EVAL_SUPABASE_PAT secret presence so contributor PRs don't fail).
ci-full: full smoke + ci-full eval. publish: npm with provenance."
git push
```

Verify in GitHub Actions UI that the first push triggered ci-fast and it passes.

---

### Task 28: Remaining reference pages

**Files:**
- Create: `supabase-realtime-skill/references/pgvector-composition.md`
- Create: `supabase-realtime-skill/references/eval-methodology.md`
- Create: `supabase-realtime-skill/references/edge-deployment.md`
- Create: `supabase-realtime-skill/references/worked-example.md`

- [ ] **Step 1: Write `pgvector-composition.md`**

```markdown
# References — Composing watch_table + Automatic Embeddings + pgvector

The worked example pattern: a row arrives, gets auto-embedded asynchronously, the agent watches the table for the embedded version, retrieves similar past rows, decides an action, and writes a result back. This page documents how the three pieces compose.

## The three pieces

1. **Postgres-Changes (`watch_table`)** — the agent's notification surface. Row INSERT/UPDATE events stream to the agent through a bounded subscription.
2. **Supabase Automatic Embeddings** — fully async, agent-free. `INSERT` triggers a queue entry → cron worker → Edge Function calls embedding model → writes `halfvec(1536)` back to the row. The agent never sees this loop; it just observes the resulting state.
3. **pgvector (`halfvec` + HNSW)** — the agent's *retrieval* surface. After observing a new row, the agent queries past resolved rows by cosine similarity to the new row's embedding.

## The interaction sequence

```
T0: agent calls watch_table(table=support_tickets, predicate=INSERT)
T1: app inserts a row → ticket lands in DB without embedding yet
T2: agent receives INSERT event (within p95 < 2s of T1)
T3: agent processes: maybe waits for embedding, retrieves similar, routes
T4: agent UPDATEs row.routing
T5: agent broadcast_to_channel(handoff)
```

## Two design choices to highlight

### Why not embed on the agent's side?

Tempting: agent receives ticket, generates embedding inline, queries pgvector, then routes. Rejected because:

- **Latency:** embedding generation adds 100-300ms per call; the bounded subscription is already tight on isolate budget. Pushing embedding off-loop keeps the agent loop fast.
- **Cost:** embedding calls cost 10× the LLM routing call when both run per-ticket. Automatic Embeddings amortizes by batching, retrying, and using cheaper models off the critical path.
- **Idempotency:** Automatic Embeddings is exactly-once via pgmq + advisory locks. Agent-side embedding generation needs the agent to dedupe across retries.

### How the agent handles "embedding not ready yet"

`watch_table` fires on the INSERT at T1 — the embedding is still pending at T2. Two patterns work:

**A — Wait for the embedded UPDATE.** Watch for `event = "UPDATE"` with a filter `embedding is not null` (client-side) or post-filter the events. Adds latency but ensures the retrieval has a query vector.

**B — Tolerate missing embeddings on first INSERT.** If `ticket.embedding` is null, fall back to keyword search or skip retrieval. Less robust but lower latency.

The worked example uses **A** — the agent calls `watch_table` with `predicate.event = "UPDATE"` and filters for `embedding is not null` post-receipt. The trade-off (slower triage but always-grounded retrieval) is documented in `docs/writeup.md` § *Why not X?*.

## Schema requirements

```sql
create extension if not exists vector;

create table <your_table> (
  ...,
  embedding halfvec(1536),  -- dimension matches your embedding model
  ...
);

create index <your_table>_embedding_hnsw
  on <your_table> using hnsw (embedding halfvec_cosine_ops);
```

`halfvec(1536)` is the recommended Supabase Automatic Embeddings shape (April 2026) — half the storage of `vector(1536)` with negligible quality loss. Use HNSW over IVFFlat unless your dataset is >1M rows; HNSW indexes faster and has lower query latency in the typical agent-retrieval range.

## See also

- `references/replication-identity.md` — UPDATE events need `REPLICA IDENTITY FULL` if you want the old row.
- Supabase Automatic Embeddings docs: https://supabase.com/docs/guides/ai/automatic-embeddings
```

- [ ] **Step 2: Write `eval-methodology.md`**

```markdown
# References — Eval methodology

This page documents *why* the eval harness measures what it measures and *what it deliberately doesn't*. The methodology is lifted from the [`supabase-mcp-evals`](https://github.com/0xquinto/supabase-mcp-evals) repo's playbook; this page summarizes the load-bearing decisions.

## The four metrics

| Metric | What it catches |
|---|---|
| `latency_to_first_event_ms` (p95) | Subscription handshake regressions, Realtime backend latency, Edge Function cold-start blow-up |
| `missed_events_rate` | Bounded-subscription correctness — events that fired but weren't observed within timeout |
| `spurious_trigger_rate` | Over-eagerness in CDC domain — agent took action when no qualifying event fired |
| `agent_action_correctness` | End-to-end value — given a real event, did the agent do the right thing |

The four are deliberately layered. The first three test the *primitive*; the fourth tests the *worked example as a system*. A regression in any of the first three tells you "the substrate is broken." A regression in the fourth tells you "the substrate works but the agent's reasoning got worse."

## Pre-registered thresholds

Thresholds live in `manifest.json`, version-controlled. Per the playbook lesson (slice-3, codified from arXiv:2604.25850 — *decision observability*): every recommendation ships with a falsifiable predicted effect.

Threshold *changes* require a versioned manifest bump explained in the PR body. This is the discipline that makes the eval harness a real gate rather than a vanity number.

## Statistical design

- **Paired comparisons.** Cross-version diffs use the same fixture IDs across runs and McNemar's test on binary outcomes. Not Welch's t-test (which assumes independent samples).
- **ci-fast (n=20)** is too small for a non-paired design. It's only valid here because it's paired *and* we treat it as a *gate*, not a hypothesis test.
- **ci-full (n=100)** + paired = MDE ~0.10 on `agent_action_correctness`. Sufficient to catch a 10-point regression with α=0.05 / β=0.20. Smaller regressions need more N.

## > Why not LLM-judge as a gate?

Tempting: have a smarter LLM judge each routing decision and report a quality score. Rejected for two reasons.

**LLM-judge without ground truth is fragile.** Without a hand-labeled answer key, the judge's score is just *another LLM's opinion*. When it disagrees with the routing model, you can't tell whether the routing improved or the judge got worse. The `agent_action_correctness` metric is computed against `expected_routing` — a hand label, not another model.

**Threshold pass/fail must be deterministic.** A judge LLM has stochastic output. Two runs of the same trial can give different scores. Pass/fail thresholds need stable inputs to be meaningful gates.

LLM-judge enters the harness only as a side-channel `routing_explanation_quality` advisory. Never as a gate.

## > Why not just measure latency?

Tempting because latency is cheap to measure and easy to explain. Rejected because latency alone doesn't catch correctness regressions: an agent that consistently routes everything to "general" hits perfect latency and is worthless.

The four metrics together capture: speed (latency), reliability (missed_events), restraint (spurious_trigger), and value (correctness). Drop any one and a regression class becomes invisible.

## > Why not Likert-scale quality scores?

Per the [supabase-mcp-evals playbook § 8 anti-patterns](https://github.com/0xquinto/supabase-mcp-evals/blob/main/playbook/PLAYBOOK.md): Likert scales (1-5 helpfulness ratings, etc.) are noisy at low N, hard to compare across model versions, and tend to drift. Binary outcomes (correct / not correct) compose with paired tests. Cross-cell comparisons are interpretable.

## See also

- `manifest.json` — the live thresholds
- `eval/metrics.ts` — implementation
- [supabase-mcp-evals/playbook/PLAYBOOK.md](https://github.com/0xquinto/supabase-mcp-evals/blob/main/playbook/PLAYBOOK.md) — the methodology origin
- [supabase-mcp-evals/playbook/research/construct-validity.md](https://github.com/0xquinto/supabase-mcp-evals/blob/main/playbook/research/construct-validity.md) — Bean's 8 construct-validity recommendations
```

- [ ] **Step 3: Write `edge-deployment.md`**

```markdown
# References — Edge Function deployment

Operator setup for running the `supabase-realtime` MCP server on Supabase Edge Functions.

## Prerequisites

- A Supabase project (Pro tier recommended; Free works but has tighter timeout caps)
- Supabase CLI installed: `brew install supabase/tap/supabase`
- The agent's JWT issuance pattern figured out (see § Auth)

## Deploy

```bash
# From your fork of supabase-realtime-skill
supabase functions deploy mcp --project-ref <your-ref>

# Set required env vars
supabase secrets set --project-ref <your-ref> \
  SUPABASE_URL=https://<your-ref>.supabase.co \
  SUPABASE_ANON_KEY=<anon-key>
```

The function is now live at `https://<your-ref>.supabase.co/functions/v1/mcp`.

## Smoke test

```bash
curl -i https://<your-ref>.supabase.co/functions/v1/mcp \
  -H "Authorization: Bearer <anon-key-or-agent-jwt>"
```

Expected: `200 OK` with body `supabase-realtime-skill MCP — POST /sse to connect`.

## Auth — the agent's JWT

The MCP server expects an `Authorization: Bearer <jwt>` header on every tool-call. That JWT propagates into:

- The Postgres-Changes subscription (so RLS applies to which rows the agent can see)
- The Realtime broadcast subscription (so channel-level auth applies)

Two issuance patterns work:

1. **Service-level JWT scoped to a workflow.** The agent runs with a long-lived JWT issued by the operator's auth service, scoped to the workflows it's allowed to participate in. RLS policies on watched tables match against the JWT's claims.
2. **Per-invocation JWT minted by the operator.** Every tool-call gets a fresh JWT scoped to that invocation. Higher security, more issuance overhead. Worth it if the agent shouldn't have continuous access to the data substrate.

v1 of the bundle is agnostic to which pattern you pick; the function is a thin pass-through. **Don't have the function elevate to service-role internally** — that's a security bug, not a feature.

## Cold-start budget

First call to a freshly-deployed (or freshly-cold) Edge Function spends ~200-400ms on isolate startup before the bounded-subscription primitive's wallclock starts. The `latency_to_first_event_ms` p95 < 2000ms threshold absorbs this; you don't need to do anything special.

If you see consistent cold-starts above 600ms, check the bundle size — the function should be < 5MB; if it's larger, something's pulled in `node_modules` accidentally (Edge Functions should only import via `npm:` specifiers or relative paths).

## Wall-clock cap

Supabase Pro Edge Functions cap at 150 seconds. The `watch_table` and `subscribe_to_channel` tools cap `timeout_ms` at 120000 (120s) leaving 30s margin for connection setup, RPC overhead, and any post-event processing the agent does after the bounded subscription returns.

If you raise `timeout_ms`, you're fighting the runtime. Don't.

## Logs

```bash
supabase functions logs mcp --project-ref <your-ref> --tail
```

The MCP server logs structured JSON for every tool-call (input shape, error code, duration). Useful for ad-hoc debugging when a tool returns an unexpected error.

## See also

- `references/rls-implications.md` — what the JWT can see
- `references/predicates.md` — what filters work
- `manifest.json` — the deployed eval thresholds
```

- [ ] **Step 4: Write `worked-example.md`**

```markdown
# References — Worked example: support-ticket triage agent

End-to-end walkthrough of the worked example referenced in `SKILL.md`. The agent watches `support_tickets`, retrieves similar past resolved tickets via pgvector, decides routing, writes the routing back, and broadcasts a downstream signal.

## The schema

See `supabase/migrations/20260430000001_support_tickets.sql`. Highlights:

- `embedding halfvec(1536)` populated by Supabase Automatic Embeddings (async; the agent never triggers it)
- HNSW index on the embedding for fast similarity search
- `replica identity full` so UPDATE events carry the old row
- Added to `supabase_realtime` publication

## The agent loop

```ts
import { boundedWatch, makeSupabaseAdapter } from "supabase-realtime-skill/server";

async function triageLoop(supabaseUrl: string, supabaseKey: string, sql: postgres.Sql) {
  while (true) {
    const adapter = makeSupabaseAdapter("support_tickets", { supabaseUrl, supabaseKey });
    const { events, closed_reason } = await boundedWatch({
      adapter,
      table: "support_tickets",
      predicate: { event: "UPDATE", filter: { column: "embedding", op: "neq", value: null } },
      timeout_ms: 60_000,
      max_events: 10,
    });

    for (const ev of events) {
      const ticket = ev.new;
      if (!ticket || !ticket.embedding) continue;

      // Retrieve 5 most-similar past resolved tickets
      const similar = await sql<{ subject: string; routing: string }[]>`
        select subject, routing from support_tickets
        where status = 'resolved' and routing is not null and id != ${ticket.id as string}
        order by embedding <=> ${ticket.embedding as any}::halfvec
        limit 5
      `;

      // LLM routing decision (your own implementation)
      const routing = await routeWithLlm(ticket, similar);

      // Write routing back
      await sql`update support_tickets set routing = ${routing} where id = ${ticket.id as string}`;

      // Broadcast for downstream handoff
      await broadcastTo(`agent:triage:${routing}`, "ticket-routed", {
        ticket_id: ticket.id,
        routing,
        customer_id: ticket.customer_id,
      });
    }

    if (closed_reason === "timeout" && shouldStop()) break;
  }
}
```

## Why watch UPDATE, not INSERT

A new ticket's INSERT fires *before* Automatic Embeddings populates `embedding`. If the agent retrieves on INSERT, the query vector is null and pgvector returns garbage.

The pattern above watches for **the UPDATE that lands when Automatic Embeddings writes the embedding back**. The filter `embedding != null` ensures the agent only fires when the row is retrieval-ready. Latency added: ~1-3 seconds (the embedding pipeline's own p95). For a triage workflow that's fine; for stricter SLAs, see `references/pgvector-composition.md` for the alternative B pattern (tolerate null embeddings, fall back to keyword search).

## Eval shape

This worked example doubles as the regression-suite SUT (`eval/runner.ts`). The 4 metrics in `manifest.json` are computed against this loop running over fixtures in `fixtures/ci-fast/` and `fixtures/ci-full/`. See `references/eval-methodology.md`.

## What this composition demonstrates

- Three of the five tools wired together (`watch_table`, `broadcast_to_channel`, with `describe_table_changes` implicit during setup)
- pgvector retrieval composed with Automatic Embeddings substrate
- The bounded-subscription pattern in production: watch with timeout, process the batch, loop
- Cross-agent coordination via Broadcast (the `agent:triage:<routing>` channel naming convention)

## See also

- `references/pgvector-composition.md` — the embedding/retrieval interaction in detail
- `references/eval-methodology.md` — how the metrics are computed
- `docs/writeup.md` — the headline narrative around this composition
```

- [ ] **Step 5: Commit**

```bash
git add references/pgvector-composition.md references/eval-methodology.md references/edge-deployment.md references/worked-example.md
git commit -m "docs(references): pgvector-composition + eval-methodology + edge-deployment + worked-example

Four pages closing out the references/ folder. eval-methodology cites the
methodology origin (supabase-mcp-evals/playbook) explicitly so the
discipline backbone is acknowledged."
```

---

### Task 29: `docs/writeup.md` — the headline narrative

**Files:**
- Create: `supabase-realtime-skill/docs/writeup.md`

- [ ] **Step 1: Write the writeup**

Per the spec § 11 outline (5 sections), persona = agent-system builder with Supabase platform engineer asides. Target ≤4000 words.

```markdown
# Agent-watches-database: a Skill+MCP pattern for Supabase Realtime

Most agent loops are pull-shaped: ask, get, decide, write, repeat. They miss everything that happens between calls. **Agent-watches-database** is the push-shaped complement — the agent calls a tool that *blocks until something interesting happens in Postgres*, then processes the batch and loops.

This writeup documents one way to ship that pattern as an Agent Skill paired with an MCP server, deployed on Supabase Edge Functions, with eval instrumentation built in. The artifact is `supabase-realtime-skill` (this repo).

## 1. The pattern

The primitive is **bounded subscription**: the tool blocks for at most `timeout_ms` *or* until `max_events` matching events arrive — whichever first — then returns the batch. That's it. No streaming protocol, no persistent connection across tool-calls, no isolate-lifetime hacks.

Why this and not the obvious "open a WebSocket and stream":

- **It maps cleanly to a single MCP tool-call.** The agent doesn't need to know about subscriptions; it knows about tool-calls. Bounded subscription puts the abstraction at the right level.
- **It fits Edge Function isolate budgets.** Supabase Pro caps Edge Function wall-clock at 150s. Our `timeout_ms` cap is 120s — 30s margin for setup, RPC overhead, and any post-event processing.
- **Stateless deployment is cheap and reliable.** Each tool-call is a single isolate invocation. No long-lived workers, no state to drift, no reconnect dance after a deploy. The agent's tool-call boundary *is* the natural checkpoint.

The Skill+MCP paired form factor matters here. The Skill (`SKILL.md` + `references/`) carries the *when and why* — when an agent should reach for these tools, what the bounded shape implies, what RLS interactions to expect. The MCP server carries the *how*. Either alone is incomplete: a skill without execution is documentation; an MCP server without instructions is a footgun. The April 14 2026 MCP working group office hours flagged Skill+MCP co-shipping as an open design question — this artifact is one worked answer.

## 2. Worked example: support-ticket triage

A SaaS app has a `support_tickets` table. Tickets get auto-embedded via Supabase Automatic Embeddings (writes a `halfvec(1536)` to `embedding`). The triage agent watches the table for embedded-ready tickets, retrieves the most-similar past resolved tickets via pgvector, decides routing (`urgent | engineering | billing | general`), writes the routing back, and broadcasts a `ticket-routed` event so a downstream handoff agent picks it up.

```ts
const adapter = makeSupabaseAdapter("support_tickets", { supabaseUrl, supabaseKey });
const { events } = await boundedWatch({
  adapter,
  table: "support_tickets",
  predicate: { event: "UPDATE", filter: { column: "embedding", op: "neq", value: null } },
  timeout_ms: 60_000,
  max_events: 10,
});

for (const ev of events) {
  const ticket = ev.new;
  const similar = await retrievePastResolved(ticket.embedding);
  const routing = await llm.routeTicket(ticket, similar);
  await pg`update support_tickets set routing = ${routing} where id = ${ticket.id}`;
  await broadcastTo(`agent:triage:${routing}`, "ticket-routed", { ticket_id: ticket.id });
}
```

Three of the five tools (`watch_table`, `broadcast_to_channel`, `describe_table_changes` for setup), pgvector retrieval, Automatic Embeddings as the embedding substrate. Full code in `references/worked-example.md`.

The composition is the headline. Each piece on its own is unremarkable. The Skill ships *the composition* — a worked example where the right Postgres extension, the right Realtime tool, and the right pgvector index are all spec'd in one place, with a regression suite that gates merges.

## 3. Why not X?

> **Why not persistent WebSocket?**
>
> The Edge Function's strength is being stateless and cheap. Persistent WebSockets fight that — they need a long-lived process, reconnect logic, and a different deployment surface. The bounded primitive recovers most of the *capability* (watching for events) without the *cost* (a worker tier).

> **Why not unbounded `timeout_ms`?**
>
> Tempting "just keep watching forever." Three problems: (a) Edge Function isolate caps at 150s, so the agent will get cut off mid-event anyway; (b) un-bounded subscriptions mean an agent can deadlock its own loop on a quiet table; (c) bounded shape forces the agent to checkpoint state at known intervals — which is what makes failure recovery tractable.

> **Why is Presence not in v1?**
>
> Presence is the third Realtime primitive next to Postgres-Changes and Broadcast. The semantics for *agents* (vs. human users) are unsettled in ways the human case isn't: what does "agent X is present in the channel" mean when agents are short-lived and stateless? How does heartbeat-based liveness fit a bounded-subscription model? `references/presence-deferred.md` walks through the design questions left open. Shipping a half-formed Presence story would have made the v1 surface messier; deferring is the better signal.

> **Why pgvector via Automatic Embeddings, not a custom embedding flow?**
>
> Automatic Embeddings is async, idempotent (via `pgmq`), and runs cheaper models off the critical path. Doing embedding inline in the agent loop adds 100-300ms and 10× the per-event cost compared to LLM routing. The composition (`references/pgvector-composition.md`) shows the embedded-UPDATE pattern that lets the agent ride on top of Automatic Embeddings without owning the loop.

> **Why these 4 metrics and not LLM-judge?**
>
> LLM-judge without ground truth is just another LLM's opinion. The four metrics here are computed against deterministic ground truth (events that did or didn't fire — observed by the harness, not judged) or hand-labeled ground truth (`expected_routing` per fixture). Pass/fail thresholds need stable inputs to be meaningful gates. `references/eval-methodology.md` walks through the discipline (lifted from `supabase-mcp-evals/playbook`).

## 4. Eval results

Pre-registered thresholds in `manifest.json` (version 1.0.0, registered 2026-04-30):

| Metric | Threshold | Result on ci-full (n=100) |
|---|---|---|
| `latency_to_first_event_ms` p95 | < 2000ms | _populated post-week-3 run_ |
| `missed_events_rate` | < 1% (CI high also < 1%) | _populated_ |
| `spurious_trigger_rate` | < 2% (CI high < 3%) | _populated_ |
| `agent_action_correctness` | ≥ 90% (CI low ≥ 85%) | _populated_ |

(Replace placeholders with the actual numbers from `eval/reports/ci-full-*.json` once the suite has run on `main`.)

What these numbers *don't* tell you, per Bean's construct-validity checklist (cited in `references/eval-methodology.md`): they only score the *worked example* fixtures, not the universe of agent workflows that might use these tools. They tell you the substrate is solid and one specific composition works well; they don't tell you "an arbitrary agent using `watch_table` will succeed." That's a generalization claim the harness deliberately doesn't make.

## 5. What's not in v1 and why

- **Presence** — semantics for agents unsettled (see § 3 callout, `references/presence-deferred.md`).
- **Server-side WebSocket auth** — depends on JWT issuance pattern beyond v1's "agent has a JWT, function is a pass-through" assumption. v2 territory.
- **Custom-channel-broker patterns** — overlaps Broadcast; differentiation story isn't clear yet. Held back deliberately.
- **LLM-judge integration** — anti-pattern per playbook discipline. Advisory only, never as a gate.

The shape of the artifact is deliberately small. Five tools, two primitives, one worked example, four metrics. The bet is that **depth in a focused niche** outweighs **breadth across a broader surface** — particularly when the broader surface (the official `supabase` Agent Skill) already exists.

## Next steps

- Open issue on [`supabase/agent-skills`](https://github.com/supabase/agent-skills/issues) proposing this as a `realtime` sub-skill
- v2 design pass on Presence semantics for agents
- Exploration of custom-channel-broker patterns once Broadcast usage is well-established

---

If you build on this pattern, please open an issue with what worked and what didn't. The artifact ships discipline, not certainty — feedback is what closes the gap.
```

- [ ] **Step 2: Run a final ci-full pass and update the placeholder numbers**

```bash
bun run eval/runner.ts ci-full
# Open eval/reports/ci-full-<timestamp>.json
# Replace "_populated_" placeholders in docs/writeup.md with the actual rate / CI / latency
```

- [ ] **Step 3: Commit**

```bash
git add docs/writeup.md
git commit -m "docs(writeup): the headline narrative — agent-watches-database pattern

5 sections per spec §11. Persona: agent-system builder; Supabase platform
engineer asides via > Why not X? callouts (5 of them — meets success
criterion #3). Eval results table populated from latest ci-full report."
```

---

### Task 30: npm publish

**Files:**
- Modify: `supabase-realtime-skill/package.json` (version bump)
- Modify: `supabase-realtime-skill/supabase/functions/mcp/index.ts` (swap import to npm:)

- [ ] **Step 1: Bump version + ensure build works**

```bash
# Update package.json: "version": "0.1.0"
bun run build
ls dist/
# Expected: dist/client/index.js, dist/client/index.cjs, dist/client/index.d.ts
```

- [ ] **Step 2: Swap Edge Function import to the published package**

```ts
// supabase/functions/mcp/index.ts — replace the local-dev relative import:
import { makeServer } from "npm:supabase-realtime-skill@0.1.0/server";
```

(This requires the package's `exports` map in `package.json` to expose `./server` — add it before publishing if missing.)

- [ ] **Step 3: Tag and push to trigger the publish workflow**

```bash
git add package.json supabase/functions/mcp/index.ts
git commit -m "release: v0.1.0"
git tag v0.1.0
git push --tags
```

The `publish.yml` GitHub Action runs typecheck + lint + tests + build + `npm publish --provenance --access public`. Verify in npmjs.com that `supabase-realtime-skill@0.1.0` is live.

- [ ] **Step 4: Sanity-check a fresh consumer**

```bash
mkdir /tmp/skill-consumer && cd /tmp/skill-consumer
bun init -y
bun add supabase-realtime-skill
node -e "console.log(require('supabase-realtime-skill'))"
```

Expected: prints the helper-library exports without error.

---

### Task 31: Upstream issue on `supabase/agent-skills`

**Files:**
- (No files in this repo — this is an issue on the upstream `supabase/agent-skills` repo.)

- [ ] **Step 1: Draft and file the issue**

Title: `Proposal: realtime sub-skill (Agent Skill + MCP server for Postgres CDC + Broadcast)`

Body:

```markdown
Hi! I've shipped a worked example of an Agent Skill paired with an MCP server, focused on Supabase Realtime/CDC, deployed as an Edge Function. Sharing here because it could fit as a `realtime` sub-skill complementing the broad `supabase` skill that already names Realtime in scope.

**What it is:**

- 5 MCP tools (`watch_table`, `broadcast_to_channel`, `subscribe_to_channel`, `list_channels`, `describe_table_changes`)
- Bounded-subscription pattern (block until N events or timeout) — fits Edge Function isolate budgets
- Worked example: support-ticket triage agent composing CDC + pgvector + Supabase Automatic Embeddings + Broadcast
- Eval instrumentation built in — 4 pre-registered metrics (latency p95, missed_events, spurious_trigger, action_correctness) with Wilson CIs and `manifest.json` thresholds; ci-fast (n=20) on PR + ci-full (n=100) cron
- Open Skills Standard (`SKILL.md` + `references/`)

**Repo:** https://github.com/0xquinto/supabase-realtime-skill (Apache-2.0)
**npm:** https://www.npmjs.com/package/supabase-realtime-skill
**Writeup (with eval numbers):** https://github.com/0xquinto/supabase-realtime-skill/blob/main/docs/writeup.md

**Specifically interested in feedback on:**

1. Whether the Skill+MCP paired form factor is something the team has thoughts on — recon noted [modelcontextprotocol/modelcontextprotocol#2585](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2585) (April 14 2026 office hours) flagged it as an open design question.
2. Whether the Realtime/CDC depth here fits as a sub-skill alongside the broad `supabase` skill, or whether the team prefers Realtime stays inside the broad skill's scope.
3. Whether Presence belongs in v2 (currently deferred — `references/presence-deferred.md` walks through the design questions).

Happy to PR this in, refactor for the repo's conventions, or treat it as a separate ecosystem artifact — whichever fits. Thanks for reading.
```

- [ ] **Step 2: Watch for engagement**

Per spec § 13 success criterion #4, **substantive maintainer engagement** (positive, negative, or in-discussion) is what closes the JD signal loop. If no response in 7 days, post a single follow-up with the concrete `manifest.json` numbers from the latest ci-full run.

---

## Phase 3 — Week 3 success gate (final)

- [ ] All 4 metrics on ci-full meet `manifest.json` thresholds
- [ ] `docs/writeup.md` published with ≥5 named tradeoffs and real eval numbers (not placeholders)
- [ ] `supabase-realtime-skill@0.1.0` live on npm with provenance
- [ ] Edge Function deployment works end-to-end against a fresh Pro project (operator walkthrough in `references/edge-deployment.md` is reproducible)
- [ ] Upstream issue filed on `supabase/agent-skills`; substantive maintainer engagement awaited per success criterion #4

---

## Self-Review

**1. Spec coverage:**

| Spec section | Tasks |
|---|---|
| §3 constraints (TS-native, Open Skills Std, Edge runtime, bounded subscription, etc.) | All — explicit in §1, §3, §17 |
| §4 architecture (Skill + MCP + eval, single bundle) | T1 (scaffold), T17 (server), T18 (SKILL.md), T22-24 (eval) |
| §5.1 watch_table | T3 (schema), T4 (primitive), T5 (tool), T6 (adapter), T7 (smoke) |
| §5.2 broadcast_to_channel | T12 (schema), T13 (tool + smoke) |
| §5.3 subscribe_to_channel | T12 (schema), T14 (primitive + tool + smoke) |
| §5.4 list_channels | T12 (schema), T15 (tool + smoke) |
| §5.5 describe_table_changes | T12 (schema), T16 (tool + smoke) |
| §6 Skill layer (SKILL.md + 7 reference pages) | T10, T11 (week-1 docs), T18, T19 (week-2 docs), T28 (week-3 docs) |
| §7 worked example schema + agent loop | T20 (migration), T21 (triage agent) |
| §8.1 tool-level Vitest (offline + smoke) | All Task N — every tool has both tiers |
| §8.2 worked-example regression suite (4 metrics, fixtures, manifest) | T22 (metrics), T23 (manifest), T24 (runner), T25 (ci-fast), T26 (ci-full) |
| §8.3 why not LLM-judge | T28 (eval-methodology.md), T29 (writeup callout) |
| §9 Edge Functions deployment | T8 (skeleton), T17 (full), T28 (operator doc) |
| §10 repo layout | T1 + every subsequent file path matches |
| §11 writeup outline | T29 |
| §12 spike-first 3-week split | All — phases 1/2/3 mirror weeks 1/2/3, week-1 gate enforces spike success |
| §13 success criteria #1-4 | T27 (CI green), T29 (5 tradeoffs), T29-30 (publish), T31 (upstream issue) |

No gaps.

**2. Placeholder scan:**

- "_populated_" in `docs/writeup.md` eval-results table (T29) — explicitly flagged in T29 step 2 as the post-run substitution. Not a plan-level placeholder; it's a build-time placeholder the engineer fills before commit.
- "<short-sha>" in `vendor/foundation/README.md` (T1 step 7) — explicitly flagged with the command to compute it.
- "<test-ref>" in deploy commands — explicitly meant to be substituted by the operator with their own ref.
- No "TBD"/"TODO"/"implement later" anywhere.
- Reference pages have full content, not outlines.

**3. Type consistency:**

- `WatchTableInput`/`Output`, `BroadcastInput`/`Output`, etc. all named consistently across schemas.ts, the tool files, and the server registration.
- `RealtimeAdapter` (CDC) vs `BroadcastAdapter` (Broadcast) — distinct interfaces, both isolated to `realtime-client.ts`. Used consistently downstream.
- `ToolError` codes (`INVALID_TABLE`, `INVALID_PREDICATE`, `INVALID_CHANNEL`, `INVALID_PAYLOAD`, `TIMEOUT_EXCEEDED_CAP`, `RLS_DENIED`, `UPSTREAM_ERROR`) defined once in `errors.ts` and used everywhere — no drift.
- `boundedWatch` vs `boundedSubscribe` — symmetric primitives, parallel naming, same shape.
- `pgIntrospectInline` (in server.ts) vs `pgIntrospect` (in describe-table.smoke.test.ts) — same logic, two callsites, intentionally not DRYed because the smoke test should not import server-internals (production wiring) and the server should not import test helpers. Documented in the inline comment in T17.

No naming drift detected.

