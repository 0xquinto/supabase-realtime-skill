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
bun run build                        # bun bundler → dist/{client,server}/index.{js,cjs}

bun run eval/spike-latency.ts        # n=20 latency check (Phase 1 gate)
bun run eval/runner.ts ci-fast       # fixtures × triage × manifest gate (~$0.50, 5 min)
bun run eval/runner.ts ci-nightly    # n=100 (~$2-3, 30 min)
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
| `fixtures/ci-nightly/` | 100 (20 seeds + 80 LLM-augmented; spot-checked) — currently empty pending T26 |
| `references/` | 8 skill consumer reference pages (linked from SKILL.md) |
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

Deno's bundler (used by `supabase functions deploy`) doesn't fake-resolve `.js` to `.ts` source the way `tsc --moduleResolution: "bundler"` does. The codebase uses explicit `.ts` extensions throughout (`from "./foo.ts"` not `from "./foo"` and not `from "./foo.js"`). `tsconfig.json` has `allowImportingTsExtensions: true` (satisfied by `tsc --noEmit`); `bun build` rewrites to `.js` in published output. See `docs/spike-findings.md` § Resolution.

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

## Where to put new info

| Kind | Lives in |
|---|---|
| New design (v0.2 etc.) | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` |
| Implementation plan for a spec | `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` |
| Operational finding from a spike | append to `docs/spike-findings.md` |
| Skill consumer reference | `references/<topic>.md` (linked from `SKILL.md`) |
| External research closing a playbook gap | `playbook/research/<topic>.md` (mirror supabase-mcp-evals' pre-registered targets pattern) |
| Architecture decision | `docs/decisions/NNNN-<slug>.md` (currently empty — first ADR is your call) |
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

Build complete (T1-T30 Step 1). Five operator follow-ups in `docs/ship-status.md`:
1. Restore Anthropic auth → run `eval/synthesize-fixtures.ts`
2. Run `eval/runner.ts ci-nightly` → fill 3 `_pending_` cells in `docs/writeup.md` § 4
3. Wire `StreamableHTTPServerTransport` in `supabase/functions/mcp/index.ts`
4. Push to GitHub remote + tag `v0.1.0` → publish to npm
5. File issue on `supabase/agent-skills`

39+ commits on local `main`, no remote configured.
