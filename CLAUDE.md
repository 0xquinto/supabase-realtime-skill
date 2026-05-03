# supabase-realtime-skill

Agent Skill paired with an MCP server for Supabase Realtime/CDC (Postgres-Changes + Broadcast), deployed as a Supabase Edge Function. Bounded-subscription pattern fits Edge isolate budgets. Eval instrumentation built in.

## Purpose (read first)

The artifact is a **portfolio piece for the Supabase AI Tooling Engineer pivot**. The audience is the supabase/agent-skills maintainers + the JD's hiring panel. What's actually demonstrable: (1) a working bounded-subscription primitive on Supabase Realtime + Broadcast packaged as an MCP server on Edge Function, (2) substrate gotchas pre-wired in the wrapper (the canonical chain: JWT-`setAuth` propagation, `private:true` opt-in, GRANT+RLS for anon-JWT, warm-up window), (3) pre-registered eval thresholds with smoke receipts as the audit trail for those choices, (4) judgment about what to defer (Presence, manifest n=300, upstream-as-PR) with reasoning filed as ADRs.

Items (1) + (2) are the value. Items (3) + (4) are the audit trail that lets a reader trust the value. **Don't conflate the two** — see § Anti-patterns ("process-as-moat", "own-debugging-as-research") for the framings that drift back here without guardrails.

The system under test in the eval harness here is **the `supabase-realtime-skill` artifact itself**, not a model. The 4 metrics in `manifest.json` measure whether the bundle's bounded primitive + worked example hold up under regression. Multi-model coverage is sanity-probe, not headline.

Origin context: [`docs/upstream/`](docs/upstream/README.md) carries the recon, spec, and plan that produced this repo (snapshotted from `supabase-mcp-evals` at SHA `ddacb77`). [`playbook/`](playbook/README.md) carries the methodology backbone. [`docs/spike-findings.md`](docs/spike-findings.md) carries the operational findings from the build.

## Quick start

```bash
bun install
cp .env.example .env                 # populate ANTHROPIC_API_KEY, EVAL_SUPABASE_PAT, EVAL_HOST_PROJECT_REF

bun run test:fast                    # 50 offline tests (~1s)
bun run test:smoke                   # 13 online smoke tests across 8 files (~3-6 min, requires env)
bun run typecheck                    # tsc --noEmit
bun run lint                         # biome check
bun run lint:fix                     # biome check --write
bun run build                        # tsup → dist/{client,server}/index.{js,cjs,d.ts,d.cts}

bun run eval/spike-latency.ts        # n=20 latency check (Phase 1 gate)
bun run eval/runner.ts ci-fast       # fixtures × triage × manifest gate (~$0.50, 5 min)
bun run eval/runner.ts ci-full    # n=100 (~$2-3, 30 min)

# Multi-model probe (default: claude-haiku-4-5):
EVAL_TRIAGE_MODEL=claude-sonnet-4-6 bun run eval/runner.ts ci-full
```

### Release ritual (run only after a `release(vX.Y.Z): ...` PR merges to main)

```bash
git tag vX.Y.Z && git push origin vX.Y.Z         # fires .github/workflows/publish.yml via OIDC
gh run watch $(gh run list --workflow=publish.yml --limit 1 --json databaseId -q '.[0].databaseId')
npm view supabase-realtime-skill@X.Y.Z version dist-tags   # verify publish landed
```

The Edge Function redeploy is a *separate* PR after this — see § "Release-PR vs Edge-redeploy-PR" below for the load-bearing reason.

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
| `fixtures/ci-full/` | 100 (20 seeds + 80 LLM-augmented; spot-checked) |
| `references/` | 11 skill consumer reference pages (linked from SKILL.md) |
| `supabase/functions/mcp/` | Edge Function entry (deploys + live-verified end-to-end on all 5 tools — ADR-0015 + ADR-0016) |
| `supabase/migrations/` | support_tickets schema for the worked example |
| `playbook/` | methodology — see `playbook/README.md` |
| `docs/upstream/` | spec + plan + recon snapshot — see `docs/upstream/README.md` |
| `docs/decisions/` | 16 ADRs (0001-0016); follow `NNNN-<slug>.md` pattern |
| `docs/handoff-YYYY-MM-DD.md` | end-of-session snapshots; latest carries open scope for next session |
| `docs/recon/` | pre-ADR research docs (`YYYY-MM-DD-<topic>-recon.md`); produces evidence the ADR commits on |
| `docs/spike-findings.md` | T7 5s warm-up + T8 .ts-extension reshape + Phase 1 gate-PASSED trail |
| `docs/writeup.md` | the headline narrative |
| `docs/ship-status.md` | v0.1.0-era ship snapshot (historical). Current operator follow-ups live in CLAUDE.md § Status. |

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

`secrets.X` is forbidden in job-level `if:` (security restriction). For workflows that should skip cleanly when eval secrets are absent, use a first step that writes `secrets=true|false` to `$GITHUB_OUTPUT`, then gate subsequent steps on `steps.have.outputs.secrets == 'true'`. Pattern lives in `.github/workflows/ci-full.yml` + `ci-fast.yml`'s eval job.

### npm publish uses OIDC, not `NPM_TOKEN`

`.github/workflows/publish.yml` declares `permissions: id-token: write` and runs `npm publish` with no `NODE_AUTH_TOKEN`. npm and GitHub do an OIDC handshake (Trusted Publisher, GA July 2025). Don't add an `NPM_TOKEN` repo secret. Requires Node ≥ 24 (for prebundled npm ≥ 11.5.1).

### ADR status discipline

Don't mark an ADR `Accepted` until the operator explicitly decides. `Proposed` is the safe default for design choices the operator hasn't ruled on. The pre-registration loop's whole point is that outcomes (accept / partial / reject) come from evidence + operator judgment, not from drafting momentum.

### npm tag judgment ≠ project milestone label

ADRs sometimes label a milestone "vX.Y.Z ship surface" (project narrative). That label does NOT determine the npm tag. Cut the npm tag against what the recon's fallback path actually specified — ADR-0016's recon explicitly said "v1.0.0 = both [smoke surface + manifest n=300] shipped within the same calendar week, otherwise the smoke PR is `0.3.0` and v1.0.0 stays unclaimed." When drafting a release PR, re-read the recon's tag-decision row before settling on a number; project narrative ≠ SemVer event.

### Branch + commit conventions

Branch names use a functional prefix: `recon/<topic>`, `fix/<topic>`, `feat/<topic>`, `docs/<topic>`. **Don't** use `adr-NNNN-<topic>` — the ADR number lives in the commit/PR title, not the branch name.

### FAIL→fix→PASS smoke-test discipline (substrate-correctness ships)

Substrate-correctness ADRs (ADR-0011, ADR-0013 pattern) follow a strict sequence: (1) write smoke test extension against current code; (2) run, capture **FAIL** receipt with concrete numbers; (3) land the substrate fix; (4) re-run, capture **PASS** receipt. Same test code both runs — only production source changes between them. Skipping (2) makes the fix faith-based; the receipts are what move the ADR from `Proposed` to ready-for-Accepted.

### Substrate-vs-composition split (ADR-0012 § 2)

Substrate-correctness fixes ship with smoke-test receipts on real Pro branches. Fixture-driven manifest gates ship with worked examples. **Don't roll the latter into the former** — fake-driven evals against substrate-only changes are weak signal (proxy gap). When in doubt, defer the manifest cell and ship the substrate fix narrow.

### `httpSend()` runtime contract ≠ `.d.ts` declaration

`RealtimeChannel.httpSend()`'s declared return type is `Promise<{success: true} | {success: false; status; error}>`, but the runtime (`RealtimeChannel.js:411-448`) only resolves `{success: true}` on HTTP 202 — every other status calls `Promise.reject(new Error(errorMessage))`. The discriminated `success: false` branch is unreachable. Wrappers must be `try/catch`-shaped, never `if (!result.success)`-shaped. See `makeProductionBroadcastSender` in `src/server/server.ts` for the pattern.

### `realtime.messages` RLS denial is silent

When a private-channel broadcast send is denied by `realtime.messages` INSERT policy, the substrate does NOT throw. REST returns 202 (request accepted), the row is filtered out by RLS, no fan-out, sender's `httpSend()` resolves successfully. Receiver simply never sees the message. **Tenant isolation is enforced; failure-mode signaling to the caller is not.** If you need an explicit "broadcast was authorized" signal, layer your own ack on top. Documented in `references/multi-tenant-rls.md` § "Failure mode".

### Postgres-Changes row payload requires GRANT + RLS chain (anon-JWT silent strip)

For `watch_table` consumers using anon JWT, Realtime broker authorizes the row payload separately from PostgREST. Without the full chain, events are delivered with `new: {}` + `errors: ["Error 401: Unauthorized"]` — `events.length === 1` passes, but row data is stripped. The chain after `create table`:

```sql
alter table <t> enable row level security;
create policy "<t>_read" on <t> for select using (true);
grant select on <t> to anon, authenticated, service_role;
alter publication supabase_realtime add table <t>;
```

Notes: GRANT alone (RLS-disabled) delivers zero events to anon — RLS must be enabled with at least one permissive `select` policy. service_role bypasses RLS so GRANT alone suffices for service_role-bearer flows. Branches via `withBranch` get auto-grants on table creation, which is why `tests/smoke/watch-table.smoke.test.ts` doesn't apply the chain explicitly. Direct `sql.unsafe(create table ...)` against the host project (the spike + the new Edge `watch_table` smoke) does NOT auto-grant. Pinned via 7-variant probe in `eval/probe-edge-payload.ts`; documented in `docs/spike-findings.md` § T7-Edge sub-finding 2; sized smoke wall budget in ADR-0016.

### Loading `.env` for smoke / eval scripts

Bun doesn't auto-source `.env` into `process.env` for `vitest run` invocations. Pattern: `set -a && source .env && set +a && bun run vitest run <path>`. Without this, smoke tests skip silently (`SHOULD_RUN=false`) instead of running.

### `SupabaseClient` generic mismatch under `exactOptionalPropertyTypes`

`createClient(url, key, opts)` infers `SupabaseClient<any, "public", "public", any, any>`; module boundaries that accept the bare `SupabaseClient` type don't unify under `exactOptionalPropertyTypes: true`. Cast to bare `SupabaseClient` (no generic) at the boundary — pattern lives in `tests/smoke/multi-tenant-rls.smoke.test.ts`.

### `@supabase/supabase-js` floor is `^2.88.0` (Dec 2025)

Below this, `ch.httpSend()` doesn't exist (added 2.75.0, Oct 2025) and the empty-`Authorization`-header REST bug (supabase-js#1937) bites. ADR-0013 pinned the floor; don't relax it without an ADR.

### Supabase CLI deploy auth env var

The Supabase CLI reads `SUPABASE_ACCESS_TOKEN`, not `EVAL_SUPABASE_PAT` (which is what `.env` and the smoke-test harness use). For `supabase functions deploy`, prefix the env: `SUPABASE_ACCESS_TOKEN=$EVAL_SUPABASE_PAT supabase functions deploy --no-verify-jwt mcp --project-ref $EVAL_HOST_PROJECT_REF`. Sourcing `.env` alone is necessary but not sufficient.

### Direct pushes to `main` are blocked

The session harness denies `git push` to `main` — every change ships through a PR, even tiny doc-only follow-ups (CLAUDE.md currency sweeps, handoff docs). Pattern: branch off, commit locally, push the branch, open the PR, merge with `gh pr merge --squash --delete-branch`. Don't try to amend-and-force-push to main as a shortcut.

### Host project's `public` schema is empty by default

The host project (`EVAL_HOST_PROJECT_REF`) doesn't auto-apply `supabase/migrations/`. Smoke tests that run against the host project (not via `withBranch`) must be schema-independent — assert against guaranteed-not-there ghost tables (`__realtime_skill_smoke_${Date.now()}__` pattern in `tests/smoke/edge-deploy.smoke.test.ts`) or create + drop a temp table inline. Don't assume `support_tickets` exists.

### Edge Function `/health` curl needs both `Authorization` AND `apikey` headers

The Supabase platform gateway returns 406 on `GET /functions/v1/mcp/health` if only `Authorization` is set, because the MCP transport advertises `text/event-stream` by default and the gateway negotiates content type via `apikey`. Pattern documented in `tests/smoke/edge-deploy.smoke.test.ts:108-114` and `references/edge-deployment.md` § Smoke test.

### Deno lock regen after `deno.json` changes

When bumping any version in `supabase/functions/mcp/deno.json`: `cd supabase/functions/mcp && rm -f deno.lock && deno cache --reload index.ts && deno check index.ts`. Without this, `deno.lock` and the deployed bundle can drift (source-tree-vs-deployed alignment was the ADR-0015 anomaly).

### Release-PR vs Edge-redeploy-PR are always two separate PRs

The `npm:supabase-realtime-skill@^X.Y.Z/server` import range in `supabase/functions/mcp/deno.json` cannot be bumped in the same PR as the `package.json` version bump — the new npm version doesn't exist until the tag fires the publish workflow, so `deno cache --reload` would fail at lock-regen time. Pattern: (1) `feat/vX.Y.Z-tag` PR bumps `package.json` + CHANGELOG only; (2) merge → run the § "Release ritual" block above (`git tag` → publish workflow → `npm view`); (3) `feat/edge-redeploy-vX.Y.Z` PR bumps `deno.json` and **composes with § "Deno lock regen" above** (`rm -f deno.lock && deno cache --reload index.ts && deno check index.ts`); (4) operator runs `supabase functions deploy` after merge; (5) commit smoke receipt to `logs/smoke-edge-deploy/`. The v0.3.0 ship loop (PRs #23 / #24 / #25) is the reference shape.

## Where to put new info

| Kind | Lives in |
|---|---|
| Pre-ADR research (closing a gap before deciding) | `docs/recon/YYYY-MM-DD-<topic>-recon.md` |
| Architecture decision (commits the design + falsifiable predicted effect) | `docs/decisions/NNNN-<slug>.md` |
| Operational finding from a spike | append to `docs/spike-findings.md` |
| Skill consumer reference | `references/<topic>.md` (linked from `SKILL.md`) |
| External research closing a playbook gap | `playbook/research/<topic>.md` (mirror supabase-mcp-evals' pre-registered targets pattern) |
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
- **Process-as-moat (the "discipline-as-headline" drift).** Pitching discipline / pre-registration / ADR backbone as the value-prop. Process produces evidence; it isn't itself the value. **Test:** swap "discipline" for "process" — if the sentence still reads as value-prop, it's drift. Trips: *"the discipline backbone is the differentiator."* Doesn't: *"the bounded primitive handles substrate gotchas correctly."* Provenance: 2026-05-03 self-review (PR #27 + CLAUDE.md § Purpose history).
- **Own-debugging-as-research (the "we found N silent failures" drift).** Pitching bugs we hit in our own composition as findings. Substrate behavior the docs name (even scattered) was already there; we ran into it. **Test:** if docs name the behavior, it's a tool we built (not a finding). If we measured a distribution / contract / boundary the docs don't quantify, that's a methodology contribution — separate category, call it that. Trips: *"we found 4 silent failures."* Doesn't: *"a wrapper pre-wires the substrate gotchas."* Methodology-contribution shape (also doesn't trip): *"n=20 p99 distribution of the warm-up window — measured, not discovered."* Provenance: 3 of 4 ADR-0011 / 0013 / T7 / 0016 "findings" are documented gotchas; the warm-up p99 measurement and silent-filtering contract are methodology contributions.

## Status

v0.3.0 shipped (E2E smoke surface, ADR-0016 — fully verified end-to-end on `0.3.0` bytes after Edge redeploy on 2026-05-03). Latest ci-full: **99/100 action_correctness, CI low 0.946** (Sonnet 4.6, ADR-0009); Haiku 4.5 hits 96/100 post-f019-relabel (ADR-0006). Manifest gate passes on rate AND CI low; mechanical Wilson upper-CI bounds remain until n=300 (v2.0.0 manifest, ADR-0007).

**Shipped:** npm package published as `supabase-realtime-skill` (`v0.1.0` + `v0.1.1` + `v0.2.0` + `v0.3.0` via OIDC Trusted Publisher); Edge Function deployed and live-verified end-to-end on all 5 tools (JSON-RPC `tools/list` + `tools/call` for `describe_table_changes`, `broadcast_to_channel`, `watch_table`, `subscribe_to_channel`; ADR-0015 + ADR-0016); 16 ADRs filed exercising the pre-registration loop in five outcome shapes: accept (0001/0002/0003/0005/0009/0010/0011/0013/0014/0015/0016), partial-accept (0006/0007), reject (0008), proposed-deferral (0004/0012), predicted-and-empirically-refined (0013/0015/0016).

**CI:** `ci-fast` runs every push (typecheck + lint + 50 fast tests, ~1 min, free). `ci-full` is **manual-only** (`workflow_dispatch`) — daily cron was dropped on 2026-05-01 (~$60-90/mo of API spend reproducing identical numbers; methodology evidence is the workflow file + on-demand trigger). The tier was renamed from `ci-nightly` → `ci-full` on 2026-05-01 to stop the name from claiming a schedule it doesn't have; same workflow, same fixtures, just an honest label.

**Operator follow-ups:**
1. T31 — file issue on `supabase/agent-skills` (decide: as-drafted, reshape per ADR-0004, or skip).
2. (Optional) Set `EVAL_*` repo secrets if `ci-full` is invoked on demand. `EVAL_HOST_DB_URL` is required for the Edge `watch_table` smoke (`tests/smoke/edge-deploy.smoke.test.ts`) — host project's pooler URL. Skips cleanly if absent.
3. **Manifest v2.0.0 / n=300** is the next natural ship — ADR-0017 (or ADR-0007 amendment) when the corpus expansion lands. v1.0.0 tag is gated on this per [`recon`](docs/recon/2026-05-02-v1.0.0-ship-surface-recon.md) Decision 4. The smoke surface (ADR-0016) shipped as `0.3.0` per the recon's fallback path; v1.0.0 stays unclaimed until the manifest expansion lands and a soak window confirms `0.3.x` in the wild.
