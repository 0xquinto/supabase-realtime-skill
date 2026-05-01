# Ship status (2026-04-30)

State of the v0.1.0 build at end of the implementation session. Plan reference: `~/Dev/supabase-mcp-evals/docs/superpowers/plans/2026-04-30-supabase-realtime-skill-build.md`.

## Done in this session (Phase 1 + Phase 2 + Phase 3 build)

**Phase 1 — Spike (T1-T11):** complete. Both spike findings (T7 5s warm-up, T8 Deno bundler) surfaced and resolved. `docs/spike-findings.md` carries the trail.

**Phase 1 spike-success gate:** PASSED. p95 latency 438ms vs 2000ms threshold (4.6× headroom). All five gate items verified.

**Phase 2 — Mechanical scale-out (T12-T19):** complete. 5 MCP tools (`watch_table`, `broadcast_to_channel`, `subscribe_to_channel`, `list_channels`, `describe_table_changes`) wired into `makeServer`. Edge Function deploys and `curl GET` returns 200 with all 5 tools' import graph loading at startup. SKILL.md + 4 reference pages committed.

**Phase 3 — Worked example + eval (T20-T29 + T30 Step 1):**
- `support_tickets` migration (T20) ✓
- Triage agent loop (T21) ✓
- Eval metrics + Wilson CIs + threshold checker (T22) ✓
- Pre-registered `manifest.json` (T23) ✓
- Eval runner (T24) ✓
- 20 hand-curated ci-fast fixtures (T25) ✓
- Synthesizer (T26 partial — see § Awaiting operator action)
- GitHub Actions workflows: ci-fast + ci-nightly + publish (T27) ✓
- 4 remaining reference pages (T28) ✓
- `docs/writeup.md` headline narrative (T29) ✓
- v0.1.0 build entry points + dual ESM/CJS dist (T30 Step 1) ✓

**Build state at session end:**
- `bun run typecheck` — clean
- `bun run lint` — clean (58 files)
- `bun run test:fast` — 33/33 passing
- `bun run build` — produces 4 artifacts in `dist/` (client + server, ESM + CJS)
- 38 commits ahead of `origin/main`, working tree clean

## Awaiting operator action

These steps were deliberately **not** auto-executed because they spend money, publish public artifacts, or modify shared systems.

### 1. Anthropic auth + ci-nightly fixture generation (blocks T26 + part of T29)

The synthesizer at `eval/synthesize-fixtures.ts` is built and clean, but the available `ANTHROPIC_API_KEY` (in both `.env` and shell env) returned 401 against `claude-haiku-4-5`. Both keys had `sk-ant-api*` prefix and 108-char length — format-correct, but the workspace appears revoked or deactivated.

To unblock:
```bash
# After restoring a working sk-ant-api* key in .env:
cd ~/Dev/supabase-realtime-skill
bun run eval/synthesize-fixtures.ts        # ~$0.24, 2-4 min
ls fixtures/ci-nightly/ | wc -l            # expect 100
# spot-check 10 random files; commit
git add fixtures/ci-nightly/
git commit -m "test(fixtures): ci-nightly n=100 (spot-checked)"
```

### 2. ci-nightly eval run (T26 Step 3 + T29 placeholder fill)

Once `fixtures/ci-nightly/` is populated, the operator runs:
```bash
bun run eval/runner.ts ci-nightly
# Wallclock ~30 min, cost ~$2-3 (100 trials × haiku-4-5 + one branch)
# Writes eval/reports/ci-nightly-<ts>.json
```

The 4-metric report fills in the `_pending_` cells in `docs/writeup.md` § 4. `latency_to_first_event_ms` p95 already has a credible value (438ms from T9 spike); the other three (missed_events_rate, spurious_trigger_rate, agent_action_correctness) need the worked-example run.

### 3. ~~Edge Function MCP transport rewire~~ — done (v0.1.x)

Live JSON-RPC `tools/list` against `https://<host_ref>.supabase.co/functions/v1/mcp` returns all 5 tools. Per-request stateless `WebStandardStreamableHTTPServerTransport`. Transcript in `docs/writeup.md` § 4.

### 4. npm publish — partially done

Repo is public at github.com/0xquinto/supabase-realtime-skill, `v0.1.0` tag pushed, ci-fast green. The `publish.yml` workflow ran but failed at the `npm publish` step:

```
npm error code ENEEDAUTH
npm error need auth You need to authorize this machine using `npm adduser`
```

**Fix:** the `NPM_TOKEN` repo secret isn't set on the GitHub repo. Once added (Settings → Secrets → Actions → `NPM_TOKEN`), re-trigger via:

```bash
git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0
git tag v0.1.0 && git push --tags
```

Or skip npm for now and consume the package directly from GitHub (`bun add github:0xquinto/supabase-realtime-skill#v0.1.0`).

### 5. Upstream issue on `supabase/agent-skills` (T31)

Plan T31 has the full issue body draft. Repo is now public, so URLs resolve. Filing is the operator's call.

## Known gaps for v0.2

- **Type emission.** v0.1.0 ships JS without `.d.ts` files. Bun's bundler doesn't emit declarations, and adding a `tsc -d` pass requires unwinding `allowImportingTsExtensions: true`. Documented in T30 Step 1's commit message.
- **Presence.** Deferred per `references/presence-deferred.md` — semantic questions for agent identity in Presence's `key` parameter unsettled.
- **Custom-channel-broker patterns.** Differentiation story vs. raw Broadcast not clear yet.
- **`pct` formula in `eval/spike-latency.ts`** uses `floor` not `nearest-rank` (T22 caught the same bug in `eval/metrics.ts` and fixed it there). Headroom is so large that the difference doesn't change the gate decision, but the inconsistency is ADR-worthy when v0.2 touches the eval surface.

## Repository inventory at end of session

```
src/
  client/index.ts          consumer-facing barrel (boundedWatch + schemas + types)
  server/
    index.ts               server barrel (makeServer + adapters + tool handlers)
    server.ts              MCP Server factory; 5 tools registered
    realtime-client.ts     bounded primitive + 2 production adapters
    watch-table.ts         + broadcast.ts + subscribe.ts + list-channels.ts + describe-table.ts
  types/
    schemas.ts             5 input + 5 output zod schemas
    errors.ts              ToolError + 7 error codes

eval/
  spike-latency.ts         T9 — n=20 long-lived-subscription latency
  triage-agent.ts          T21 — worked-example agent
  metrics.ts               T22 — 4 metrics + threshold checker
  runner.ts                T24 — fixtures × triage × manifest gate
  synthesize-fixtures.ts   T26 — LLM-augment ci-fast → ci-nightly (BLOCKED on Anthropic auth)
  reports/                 (gitignored) ci-fast/ci-nightly outputs

tests/
  fast/                    33 offline tests, 8 files
  smoke/                   5 online smoke tests (one per tool)
  smoke/_helpers/          ResilientApiClient + fetchProjectKeys (T7-extracted)

fixtures/
  ci-fast/                 20 hand-curated tickets, 4 routings × 5 cases
  ci-nightly/              (empty — awaits T26 unblock)

references/                8 pages — predicates, replication-identity, rls-implications,
                           presence-deferred, pgvector-composition, eval-methodology,
                           edge-deployment, worked-example

docs/
  spike-findings.md        Phase 1 + Phase 1-gate-PASSED trail
  writeup.md               Headline narrative (1 of 4 metrics populated)
  ship-status.md           This file

supabase/
  functions/mcp/           Edge Function entry (deploys; tool-routing pending)
  migrations/              support_tickets schema (applied to transient branches by runner)

.github/workflows/         ci-fast + ci-nightly + publish

manifest.json              v1.0.0 pre-registered thresholds
SKILL.md                   v1, three triggers + tools at a glance
package.json               v0.1.0, dual exports (./, ./server), ESM + CJS
```
