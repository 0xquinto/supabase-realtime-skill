# supabase-realtime-skill

Agent Skill paired with an MCP server for Supabase Realtime/CDC (Postgres-Changes + Broadcast), deployed as a Supabase Edge Function. Bounded-subscription pattern fits Edge isolate budgets. Eval instrumentation built in.

## Purpose (read first)

The artifact is a **portfolio piece for the Supabase AI Tooling Engineer pivot**. The audience is the supabase/agent-skills maintainers + the JD's hiring panel. The signals are: (1) a real Skill+MCP composition, (2) opinionated patterns shipped with worked examples, (3) eval discipline that gates merges, (4) judgment about what to defer (Presence) and why.

The system under test in the eval harness here is **the `supabase-realtime-skill` artifact itself**, not a model. The 4 metrics in `manifest.json` measure whether the bundle's bounded primitive + worked example hold up under regression. Multi-model coverage is sanity-probe, not headline.

Origin context: [`docs/upstream/`](docs/upstream/README.md) carries the recon, spec, and plan that produced this repo (snapshotted from `supabase-mcp-evals` at SHA `ddacb77`). [`playbook/`](playbook/README.md) carries the methodology backbone. [`docs/spike-findings.md`](docs/spike-findings.md) carries the operational findings from the build.

## Quick start

```bash
bun install
cp .env.example .env                 # populate ANTHROPIC_API_KEY, EVAL_SUPABASE_PAT, EVAL_HOST_PROJECT_REF

bun run test:fast                    # 33 offline tests (~1s)
bun run test:smoke                   # 5 online smoke tests against real branches (~3 min, requires env)
bun run typecheck                    # tsc --noEmit
bun run lint                         # biome check
bun run lint:fix                     # biome check --write
bun run build                        # tsup → dist/{client,server}/index.{js,cjs,d.ts,d.cts}

bun run eval/spike-latency.ts        # n=20 latency check (Phase 1 gate)
bun run eval/runner.ts ci-fast       # fixtures × triage × manifest gate (~$0.50, 5 min)
bun run eval/runner.ts ci-nightly    # n=100 (~$2-3, 30 min)

# Multi-model probe (default: claude-haiku-4-5):
EVAL_TRIAGE_MODEL=claude-sonnet-4-6 bun run eval/runner.ts ci-nightly
```

Operator setup: [`references/edge-deployment.md`](references/edge-deployment.md). Requires Supabase Pro + a dedicated host project + a fine-grained PAT.

## Repo layout

| Path | What lives there |
|---|---|
| `src/server/` | MCP server factory + 5 tool handlers (watch_table, broadcast, subscribe, list_channels, describe_table) + bounded primitives + production adapters |
| `src/types/` | zod schemas (5 input + 5 output) + `ToolError` |
| `src/client/index.ts` | npm consumer barrel (boundedWatch + schemas + types) |
| `src/server/index.ts` | npm consumer barrel for server-side use (`./server` subpath) |
| `vendor/foundation/` | snapshotted from supabase-mcp-evals at SHA `fceeec7`. **Don't edit** without an ADR. |
| `tests/fast/` | offline tests (mocked adapters, fabricated payloads) |
| `tests/smoke/` | online tests (real branches via `withBranch`, real Postgres) |
| `tests/smoke/_helpers/` | `ResilientApiClient`, `fetchProjectKeys` — reused by `eval/` |
| `eval/` | spike-latency, triage-agent, metrics, runner, synthesize-fixtures |
| `fixtures/ci-fast/` | 20 hand-curated tickets — the merge gate |
| `fixtures/ci-nightly/` | 100 (20 seeds + 80 LLM-augmented; spot-checked) |
| `references/` | 9 skill consumer reference pages (linked from SKILL.md) |
| `supabase/functions/mcp/` | Edge Function entry (deploys; tool-routing pending) |
| `supabase/migrations/` | support_tickets schema for the worked example |
| `playbook/` | methodology — see `playbook/README.md` |
| `docs/upstream/` | spec + plan + recon snapshot — see `docs/upstream/README.md` |
| `docs/spike-findings.md` | T7 5s warm-up + T8 .ts-extension reshape + Phase 1 gate-PASSED trail |
| `docs/writeup.md` | the headline narrative |
| `docs/ship-status.md` | what's done + 5 follow-ups awaiting operator action |

## Non-obvious conventions (the load-bearing ones)

These came out of the spike. Future work must respect them or it'll regress.

### `.ts` extensions on ALL relative imports

Deno's bundler (used by `supabase functions deploy`) doesn't fake-resolve `.js` to `.ts` source the way `tsc --moduleResolution: "bundler"` does. The codebase uses explicit `.ts` extensions throughout (`from "./foo.ts"` not `from "./foo"` and not `from "./foo.js"`). `tsconfig.json` has `allowImportingTsExtensions: true` (satisfied by `tsc --noEmit`); `tsup` (the npm-package builder, configured via `tsup.config.ts`) rewrites `.ts` → `.js` in the published output and emits matching `.d.ts`/`.d.cts` declarations. See `docs/spike-findings.md` § Resolution.

**If you add a new file**, every import in it (and every import OF it) needs `.ts`. Bare specifiers (`@modelcontextprotocol/sdk/server/index.js`) stay bare.

### Vitest 2.x workspace via `vitest.workspace.ts`

`test.projects` in `vitest.config.ts` is **vitest 3.x syntax** and silently exits 0 on vitest 2.x ("No test files found"). This bit T2. Don't use it.

### Realtime ~5s warm-up window

After `subscribe()` resolves SUBSCRIBED on a freshly-published table, INSERTs in the first ~5s are **not delivered**. Steady-state latency after warm-up: ~100-200ms. Methodology consequence: latency-sensitive tests/evals **must** use a long-lived adapter and discard the first event (or fire a warm-up insert). `eval/spike-latency.ts` is the canonical pattern; `tests/smoke/watch-table.smoke.test.ts` uses a multi-insert variant. See `docs/spike-findings.md` (T7) and `references/replication-identity.md` (operational note).

### Smoke tests use `ResilientApiClient` + `fetchProjectKeys` + `serviceRole` key

- `vendor/foundation/api-client.ts` doesn't retry post-create 404s on `getBranchDetails`. Wrap with `ResilientApiClient` from `tests/smoke/_helpers/resilient-api-client.ts`.
- `BranchDetails` does NOT have `anon_key` or `service_role_key` fields. Use `fetchProjectKeys(PAT, branch.project_ref ?? details.ref)` from `tests/smoke/_helpers/project-keys.ts` to hit `/v1/projects/{ref}/api-keys`. Returns `{ anon, serviceRole }`.
- Smoke tests use `serviceRole` (RLS bypass). Production tool calls forward the agent's JWT (the function never elevates).

### Strict TS knobs that bite

- `exactOptionalPropertyTypes: true` rejects `{ field: undefined }` literals. Build options conditionally — see `makeSupabaseAdapter` in `src/server/realtime-client.ts` for the pattern.
- `noUncheckedIndexedAccess: true` — `arr[idx]` is `T | undefined`. Don't paper over with `!`; use `?? fallback` or a guard.
- `noExplicitAny` (biome) — type-narrow with discriminators. The Anthropic SDK pattern: `block?.type === "text" ? block.text : ""`.

### Smoke broadcast gotcha (single-client channel dedup)

A single `createClient` instance dedupes channels by topic. Subscribing twice to the same topic from one client → the second `.subscribe()` callback never fires. T13 lost 5 minutes to this. Use **two separate `createClient` instances** for sender + listener in broadcast smoke tests.

### Don't put `process.env.X!` at module scope in eval scripts

The `!` triggers on import — fails typecheck-driven imports, fails CI runs without the env. Move env reads inside `main()` with explicit checks + `process.exit(2)`.

### Vendored foundation policy

`vendor/foundation/` is a snapshot. **Don't edit it.** If a slice needs new behavior, write a test-local subclass (like `ResilientApiClient`) or open an ADR. Same policy as supabase-mcp-evals.

### GH Actions: gate on secrets via step output, not job-level `if:`

`secrets.X` is forbidden in job-level `if:` (security restriction). For workflows that should skip cleanly when eval secrets are absent, use a first step that writes `secrets=true|false` to `$GITHUB_OUTPUT`, then gate subsequent steps on `steps.have.outputs.secrets == 'true'`. Pattern lives in `.github/workflows/ci-nightly.yml` + `ci-fast.yml`'s eval job.

### npm publish uses OIDC, not `NPM_TOKEN`

`.github/workflows/publish.yml` declares `permissions: id-token: write` and runs `npm publish` with no `NODE_AUTH_TOKEN`. npm and GitHub do an OIDC handshake (Trusted Publisher, GA July 2025). Don't add an `NPM_TOKEN` repo secret. Requires Node ≥ 24 (for prebundled npm ≥ 11.5.1).

### ADR status discipline

Don't mark an ADR `Accepted` until the operator explicitly decides. `Proposed` is the safe default for design choices the operator hasn't ruled on. The pre-registration loop's whole point is that outcomes (accept / partial / reject) come from evidence + operator judgment, not from drafting momentum.

## Where to put new info

| Kind | Lives in |
|---|---|
| New design (v0.2 etc.) | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` |
| Implementation plan for a spec | `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` |
| Operational finding from a spike | append to `docs/spike-findings.md` |
| Skill consumer reference | `references/<topic>.md` (linked from `SKILL.md`) |
| External research closing a playbook gap | `playbook/research/<topic>.md` (mirror supabase-mcp-evals' pre-registered targets pattern) |
| Architecture decision | `docs/decisions/NNNN-<slug>.md` (see directory for filed ADRs) |
| Engineering tactics | commit messages |

## Anti-patterns (from `playbook/PLAYBOOK.md` § 8)

- Likert scales (use binary)
- Generic off-the-shelf metrics ("conciseness", "hallucination")
- LLM-judge without ground-truth alignment
- LLM-judge as a gate (advisory only)
- End-to-end-only scoring
- Synthetic data before a hand-crafted seed (why `fixtures/ci-fast/` is hand-only)
- Heavy frameworks (we're plain TS + Bun + raw SDKs + zod)
- **Recommending a change without a falsifiable predicted effect** (`manifest.json` is the worked answer here)
- **Phenomenon-proxy gap** ([`playbook/research/construct-validity.md`](playbook/research/construct-validity.md) Target 4): the eval must measure the phenomenon, not a proxy for it. The 4 metrics here measure substrate (3) + composition (1); they don't claim to measure "agent quality" abstractly.

## Status

v0.1.x shipped. Latest ci-nightly: **99/100 action_correctness, CI low 0.946** (Sonnet 4.6, ADR-0009); Haiku 4.5 hits 96/100 post-f019-relabel (ADR-0006). Manifest gate passes on rate AND CI low; mechanical Wilson upper-CI bounds remain until n=300 (v2.0.0 manifest, ADR-0007).

**Shipped:** npm package published as `supabase-realtime-skill` (`v0.1.0` + `v0.1.1` via OIDC Trusted Publisher); Edge Function deployed and live-verified (JSON-RPC `tools/list` round-trips); 9 ADRs filed exercising the pre-registration loop in all three outcomes (accept/partial/reject).

**CI:** `ci-fast` runs every push (typecheck + lint + 33 fast tests, ~1 min, free). `ci-nightly` is **manual-only** (`workflow_dispatch`) — daily cron was dropped on 2026-05-01 (~$60-90/mo of API spend reproducing identical numbers; methodology evidence is the workflow file + on-demand trigger).

**Operator follow-ups:**
1. T31 — file issue on `supabase/agent-skills` (decide: as-drafted, reshape per ADR-0004, or skip).
2. (Optional) Set `EVAL_*` repo secrets if scheduled `ci-nightly` is ever re-enabled.
