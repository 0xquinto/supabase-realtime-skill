# Spike findings — `watch_table` end-to-end (T7)

**Date:** 2026-04-30
**Test:** `tests/smoke/watch-table.smoke.test.ts`
**Status:** PASS — primitive works; one architectural concern surfaced.

## What we proved

Bounded subscription on a fresh Supabase Pro branch:

- create branch (`withBranch`) → ACTIVE_HEALTHY → pooler connection → `create table` + `alter publication supabase_realtime add table tickets` → `boundedWatch` via `makeSupabaseAdapter` (production `@supabase/supabase-js`-backed) → INSERT → event delivered → `closed_reason: "max_events"` → branch teardown.
- Steady-state event-delivery latency: **~197ms** (insert commit → match in the watcher) on a single trial. Comfortably under the spec's 2 s p95 target.

## Concern: ~5 s subscription warm-up window

After `subscribe()` resolves `SUBSCRIBED`, INSERTs fired in the first ~5 s on a freshly-added publication table are **not delivered** to the Realtime client. INSERTs fired after the warm-up are delivered with ~200 ms latency.

Reproduced with `service_role` key (so it's not RLS), and with `public.tickets` confirmed present in `pg_publication_tables` for `supabase_realtime` before the subscribe.

Run-by-run trace from the smoke (single trial, n=1):

```
[smoke] supabase_realtime publication tables: [ { schemaname: 'public', tablename: 'tickets' } ]
[smoke] insert#1 committed at +272ms        # NOT delivered
[smoke] insert#2 committed at +5460ms       # delivered
[smoke] watch resolved at +5657ms           # ~197 ms after #2's commit
```

Likely cause (best guess, not yet confirmed): Realtime tenant config or WAL slot state caches the publication membership and refreshes on a ~5 s cadence, so changes from a *just-added* table only start flowing after the next refresh.

## What this means for the project

1. **ci-full (T9) cannot naively measure `arm-watch → insert@100ms → match` latency** as a single value — the first event of any fresh table will appear to take ~5 s. The metric must be either (a) post-warmup-only or (b) explicitly bucketed cold-vs-warm.
2. **The smoke test now uses a multi-insert pattern** (fire at +100 ms, +5 s, +10 s; measure latency from the most recent committed insert before match). This honestly reflects steady-state behavior and is what ci-full should imitate.
3. **The skill's `references/replication-identity.md`** (or a new `references/realtime-warmup.md`) should document this for skill consumers — agents that subscribe-then-immediately-insert will miss their own first event without a warm-up step.
4. **Possible mitigation in the production `makeSupabaseAdapter`**: insert a "warmup ping" (a no-op publication INSERT by a sidecar table or a sentinel row) before resolving the `subscribe` promise. Defer this until after T9 quantifies the variance — premature optimization without numbers.

## Open questions for week-1 follow-up

- Does the warm-up window also apply when subscribing to a table that was *already* in `supabase_realtime` from project init (e.g., re-subscribing on each tool call rather than on table creation)? If so, the cost is per-tool-call and ci-full's p95 will reflect it directly. If not, the cost is a one-time per-table-add and trivial.
- Is the ~5 s cadence configurable on Supabase Realtime? If so, can the maintainers ship a doc note steering agents around it?

## Test artifact

The smoke is committed in T7 and passes against a real Pro branch. Steady-state latency line proves end-to-end. The pre-warm pattern is a single-trial workaround — ci-full will measure properly.

---

# Spike findings — Edge Function deploy (T8)

**Date:** 2026-04-30
**Task:** T8 — MCP server factory + Edge Function deployment skeleton.
**Status:** BLOCKED — Edge Function bundler rejects the plan-shaped imports. This is the Week 1 spike's red-flag scenario the task description warned about.

## What we proved

The MCP server factory (`src/server/server.ts`) is itself fine: `bun run typecheck`, `bun run lint`, and `bun run test:fast` (13 tests) all pass with the new file in place. The Node-side of the integration is sound.

The break is downstream — `supabase functions deploy mcp` cannot bundle the function.

## The block — Deno's strict module resolver

The Supabase Edge Function bundler (both Docker-based and `--use-api`) is a **strict** Deno graph builder. It refuses two things that the plan-shaped code relies on:

1. **Bare specifiers without an import-map entry.** When `supabase/functions/mcp/index.ts` imports `../../../src/server/server.ts`, the bundler walks into that file and chokes on `import { Server } from "@modelcontextprotocol/sdk/server/index.js"` — the bare `@modelcontextprotocol/sdk/...` specifier isn't `npm:`-prefixed and isn't in the import map, so Deno can't resolve it.
2. **Extensionless relative imports.** Even after adding `npm:`-aliased import-map entries for every bare specifier (`@modelcontextprotocol/sdk/server/index.js`, `@modelcontextprotocol/sdk/types.js`, `@supabase/supabase-js`, `zod`), the bundler then fails on `import { ToolError } from "../types/errors"` inside `src/server/server.ts` — Deno requires `.ts` or `.js` extensions on relative imports.

Exact errors:

```text
# Phase 1 (deno.json with only "supabase-realtime-skill/" mapping):
Caused by: Relative import path "@modelcontextprotocol/sdk/types.js" not prefixed with /
or ./ or ../ and not in import map from "file:///.../src/server/server.ts"
    at file:///.../src/server/server.ts:9:63

# Phase 2 (deno.json extended with npm: aliases for each bare specifier):
Caused by: Module not found "file:///.../src/types/errors".
    at file:///.../src/server/server.ts:10:27
```

The whole `src/` tree uses extensionless imports — that's the project-wide style enabled by `tsconfig.json`'s `moduleResolution: "bundler"` + vitest. Switching wholesale to `.js` extensions would change the source-shape convention for the entire codebase, which is well outside T8's scope and not codified in any spec/ADR.

## Why neither plan workaround applies cleanly

- **`.ts` extensions on relative imports** require `tsc`'s `allowImportingTsExtensions` flag. Verified locally — without it, `tsc` errors `TS5097`. Adding the flag is fine for typecheck, but post-build (when T30 publishes a JS bundle for npm), Node consumers must see `.js` extensions; that requires a rewrite step (e.g., Bun's bundler emits `.js` automatically). This is a real toolchain change, not a one-line edit.
- **`.js` extensions on relative imports** is the canonical TS-dual-mode pattern (Node sees `.js`, TS resolves `.js → .ts` source under `moduleResolution: "bundler"`). Applying it here means touching every relative import in `src/`, `tests/`, and `vendor/`. Doable but invasive.
- **Server-side bundle (`--use-api`)** — same Deno resolver, same failure (verified).

## Proposed Week-2 reshape (one-pick)

Pick **one** of these in the next session, then re-apply T8:

1. **Switch the codebase to `.js`-extensioned relative imports.** Touches ~15 files; Bun's bundler already emits `.js`, so post-build the npm package shape is unchanged. Cleanest long-term: removes the Node-vs-Deno asymmetry. ADR-worthy (small-but-permanent style change, codify it).
2. **Build a Deno-shaped wrapper.** Keep `src/server/` Node-only; have `supabase/functions/mcp/` import the *built* output (`../../../dist/server/server.js`) instead of source. Requires running `bun run build` before `supabase functions deploy`. Adds a build step but keeps `src/` shape unchanged. Risk: drifts the spike further from "edit-source-and-deploy" feedback loop.
3. **Vendor `src/server/server.ts` content into the Edge Function entry as a single Deno-native file.** Inline the factory inside `supabase/functions/mcp/index.ts`, drop the `../../../src/` import. Fastest unblock for the spike's GET-200 milestone. Drawback: divergent server logic between Node tests and the Deno deploy — a maintenance hazard the plan was explicitly trying to avoid (one factory, two runtimes).

**Recommendation: option 1.** It's the right end-state, ADR-able, doesn't fork the server factory between Node and Deno, and the cost is mechanical. Option 2 reintroduces a build-before-deploy step that punishes iteration. Option 3 forks the SUT, which sabotages T9-T15's tests.

## What's committed despite the block

- `src/server/server.ts` — the MCP server factory. Compiles, lints, has matching foundation imports. Not exercised by any test yet (T11 will be its fast-test); reachable via the eval harness once a deployable Edge Function exists.
- `supabase/functions/mcp/index.ts` — Deno entry as the plan specifies. Currently undeployable (see above).
- `supabase/functions/mcp/deno.json` — minimal import map. Will need expansion after option-1/2/3 is chosen.
- `biome.json` — `supabase/functions` added to ignore so biome doesn't lint Deno-shaped code as Node.

## Secondary concern (deferred): SSEServerTransport is deprecated and Node-only

`@modelcontextprotocol/sdk@1.29.0`'s `SSEServerTransport` constructor is `(_endpoint: string, res: ServerResponse, options?: ...)` — it requires a Node `ServerResponse` from `node:http`. The plan code passes `new Response()` (web-standard `Response`), which won't typecheck or run. The SDK also marks SSE as deprecated in favor of `StreamableHTTPServerTransport`.

This bites only after the bundle resolver is fixed. When T8 is re-attempted, the entry should use `StreamableHTTPServerTransport` (or a Deno-native SSE shim wrapping the server's `connect`+`send`). For the GET-200 milestone alone, the `if (url.pathname.endsWith("/sse"))` branch can be deleted entirely — it's not exercised by the smoke-call.

## Resolution (2026-04-30)

**T8 deploy concern: RESOLVED.** Edge Function deploys; `curl https://<ref>.functions.supabase.co/mcp` returns HTTP/2 200.

The reshape used **`.ts` extensions, not `.js`**. The "Proposed Week-2 reshape" Option 1 above was directionally right (one extension across the board) but wrong on which extension. A first attempt with `.js` failed at deploy time:

```text
Module not found "file:///.../src/server/server.js"
```

Deno's resolver does not fake-resolve `.js` to `.ts` source the way `tsc` does under `moduleResolution: "bundler"` (or the way Node ESM + a TS loader does post-build). Deno requires the file to exist at the imported extension. Since the on-disk source is `.ts`, the imports must be `.ts`.

What the corrected reshape ships:

- All relative imports across `src/`, `vendor/`, `tests/`, `supabase/functions/` use explicit `.ts` extensions.
- `tsconfig.json` adds `allowImportingTsExtensions: true` (satisfied by the existing `tsc --noEmit` typecheck script; emission goes through `bun build`, which rewrites `.ts` to `.js` automatically).
- `supabase/functions/mcp/deno.json` carries `npm:`-aliased entries for `@modelcontextprotocol/sdk/server/index.js`, `@modelcontextprotocol/sdk/types.js`, `@supabase/supabase-js`, and `zod`. Relative imports inside `src/` need no map entries — Deno walks the file tree.
- The `/sse` branch is deleted from the Edge Function entry (the secondary concern above). `StreamableHTTPServerTransport` rewire remains deferred to a later task.

The original analysis above is preserved as the trail of reasoning — Option 1's *cost* assessment ("touches ~15 files; mechanical") was accurate; only the extension choice needed correction.

---

# Phase 1 spike-success gate — PASSED (2026-04-30)

All five gate items from the plan §1531-1541 verified:

| # | Gate item | Result |
|---|---|---|
| 1 | `bun run test:fast` — schemas + watch-table + realtime-client | 13/13 pass, 189ms |
| 2 | `bun run test:smoke` — single-trial against a real Pro branch | 1/1 pass, 32.3s wallclock; steady-state latency **98 ms** |
| 3 | `bun run eval/spike-latency.ts` — n=20 long-lived-subscription trials | **p50 145.9 ms / p95 438.1 ms / p99 708.5 ms** — PASS (4.6× under the 2000 ms threshold) |
| 4 | Edge Function deploys + `GET /functions/v1/mcp` returns 200 | Deployed to host project; `curl` returns HTTP/2 200 |
| 5 | `references/predicates.md` + `references/replication-identity.md` committed | Done |

The architecture (long-lived Realtime subscription on Supabase Pro branch via service_role key, exposed as a bounded primitive through an Edge Function MCP server) is viable. Proceed to Phase 2 — mechanical scale-out of the remaining four tools.

## Methodology constraints carried forward

Two findings from the spike change how Phase 2/3 work must be designed:

1. **Subscription warm-up window (T7).** Any test or eval that times "subscribe → insert → match" from a fresh subscription must either (a) discard the first event after subscribe-resolve, or (b) bake a warm-up insert into setup. The spike-latency eval's long-lived design is the canonical pattern; Phase 2 smoke tests should follow it where they need to measure latency rather than just functional correctness.

2. **`.ts`-extension import discipline (T8).** Every new file under `src/`, `vendor/`, `tests/`, `supabase/functions/` must import relatively with `.ts`. Bare specifiers stay bare; deno.json gets a new `npm:` alias when a new bare specifier shows up. Worked example: the four tools added in Phase 2 will each need the matching alias if they pull in new SDK surface area.

## Headroom

The 4.6× p95 headroom (438 ms vs 2000 ms threshold) means Phase 2 can layer a few hundred ms of additional work per tool call (RLS check, schema introspection, Edge Function cold-start tax) without breaching the spec target. There's no engineering pressure to optimize the bounded primitive itself; the budget is for the surrounding tool surface.

---

# T8 secondary concern resolved (2026-04-30, post-build)

**Concern from Phase 1 (line 106):** SSE transport deprecated and Node-only; entry returned a placeholder body for non-`/sse` paths and constructed `makeServer` only to exercise the import graph. POST tool-calls didn't round-trip end-to-end.

**Resolution.** Wired `WebStandardStreamableHTTPServerTransport` (SDK 1.29) into `supabase/functions/mcp/index.ts`. Stateless mode (`sessionIdGenerator` omitted), `enableJsonResponse: true` for single-shot JSON responses matching the bounded tool-call shape. Each request builds a fresh `Server + Transport` pair, runs one JSON-RPC exchange via `transport.handleRequest(req)`, then tears both down in a `finally`. GET `/` and GET `/health` stay on a cheap text liveness response so uptime probes don't pay the connect/teardown tax.

Auxiliary fixes that surfaced during the rewire:

- **Deno's strict typecheck** flagged the `(req) =>` parameter on `setRequestHandler(CallToolRequestSchema, ...)` as TS7006 implicit-any. tsc accepted it via inference; Deno didn't. Added an explicit `req: CallToolRequest` annotation in `src/server/server.ts` (using the SDK's exported `Infer`-derived type). Both checkers pass now.
- **Zod peer-version mismatch.** `@modelcontextprotocol/sdk@1.29.0` peer-requires `zod ^3.25 || ^4.0`; the import_map pinned `zod@3.23.0`. Bumped to `3.25.76` (the version already installed via npm) — silences the deno peer-dep warning.
- **`exactOptionalPropertyTypes: true` rejects `{ field: undefined }` literals.** The Edge Function file isn't in the tsc graph so it slipped through there; the new `tests/fast/transport.test.ts` (which IS) caught it. Switched both files to omit `sessionIdGenerator` entirely. Same runtime behavior.

**In-process verification.** `tests/fast/transport.test.ts` boots a fresh Server + Transport, fires JSON-RPC `initialize` and `tools/list` via fabricated `Request` objects, and asserts both round-trip cleanly. This catches transport-wiring drift before deploy. 35/35 fast tests pass.

**Live-deploy verification** (POST `Authorization: Bearer <jwt>` with a JSON-RPC `tools/call` body) is the operator's next step — see `docs/ship-status.md` item 3.

---

# T7-Edge — `watch_table` warm-up distribution on the deployed Edge Function (2026-05-02)

**Spike:** [`eval/spike-edge-warmup.ts`](../eval/spike-edge-warmup.ts) — n=20 trials, fresh table per trial, multi-INSERT schedule (+100ms / +5s / +10s), drives JSON-RPC `tools/call watch_table` against the deployed function URL with `timeout_ms: 30_000, max_events: 1`. Service-role bearer (matches the canonical npm-side smoke). Required by ADR-0016 risk mitigation per [v1.0.0 ship-surface recon](recon/2026-05-02-v1.0.0-ship-surface-recon.md) § "Adversarial pass" Risk #1: size the smoke wall budget against the *measured* p99, not against the npm-side T7 ~5s precedent.

**Run:** [`logs/spike-edge-warmup/1777757720.json`](../logs/spike-edge-warmup/1777757720.json), 65.4s wallclock, ~$0 (host project Pro instance, no `withBranch` provisioning).

## Headline distribution

| Metric | Value |
|---|---|
| Delivered | **20/20** (100%) |
| Bucket: n0 (warm path, <5s) | 13/20 (65%) |
| Bucket: n1 (post-warm-up, 5-10s) | 7/20 (35%) |
| Bucket: n2 (>10s) | 0/20 |
| p50 wall | 709ms |
| p95 wall | 5486ms |
| p99 wall | 5490ms |
| **Recommended Edge smoke wall budget** | **12,000ms** (p99 × 1.5 floored at 12s) |

Bimodal distribution: either the per-request Edge isolate's subscribe handshake completes fast enough that INSERT@+100ms (n0) lands post-SUBSCRIBED (~700ms wall), or it falls through to n1 at +5s (~5.45s wall). 0/20 trials needed n2; the +10s INSERT is observable safety margin, not load-bearing.

This matches the npm-side T7 finding ("~5s warm-up window") cleanly — Edge adds ~150-200ms of network/transport on top, but the dominant cost is the same Realtime warm-up on a freshly-published table.

## Sub-findings (worth their own follow-ups)

### 1. Single-INSERT@+100ms is unsafe on Edge

First-pass spike used a single INSERT at +100ms post-call-dispatch. **17/20 trials timed out at 30s** (some with anon JWT, some with service_role — auth is not the variable). The per-request Edge subscribe handshake exceeds 100ms in the cold-isolate path, so the row commits pre-SUBSCRIBED and Postgres-Changes drops it. The function holds the subscription open until `timeout_ms`, then returns `closed_reason: timeout` with 0 events.

Mitigation in the spike: multi-INSERT schedule (+100ms / +5s / +10s) — at least one INSERT is guaranteed to land post-SUBSCRIBED for typical Edge cold-start budgets. **The v1.0.0 watch_table Edge smoke MUST use the multi-INSERT schedule** (mirrors `tests/smoke/watch-table.smoke.test.ts:87-89`); single-shot INSERT designs will flake in consumer hands.

### 2. `new: {}` + 401 unless GRANT + RLS chain is applied (root-cause pinned)

First-pass spike output showed every delivered event with `new: null`. Diagnostic probe ([`eval/probe-edge-payload.ts`](../eval/probe-edge-payload.ts)) decomposed this:

| Variant | Auth | Table setup | Result |
|---|---|---|---|
| C | service_role (legacy JWT) | bare `CREATE TABLE` | events=1, `new: {}`, `errors: ["Error 401: Unauthorized"]` |
| D | service_role (legacy JWT) | `+ GRANT SELECT` | events=1, **`new: { id, body, n }`**, `errors: null` |
| E | service_role (legacy JWT) | `+ GRANT + RLS policy using(true)` | events=1, **`new: { id, body, n }`**, `errors: null` |
| F | anon (legacy JWT) | `+ GRANT SELECT` (no RLS) | **events=0** — no event delivery to anon at all |
| G | anon (legacy JWT) | `+ GRANT + RLS policy using(true)` | events=1, **`new: { id, body, n }`**, `errors: null` |
| (asym) | new `sb_secret_*` | bare | websocket protocol error 1002 (broker rejects upgrade) |

**Root cause:** the host project's Realtime broker authorizes the row payload separately from PostgREST. Without `GRANT SELECT` to the agent's role on the source table, the broker delivers the event metadata but replaces the row with `errors: ["Error 401: Unauthorized"]`. For service_role, GRANT alone is sufficient (RLS-bypass). For anon (the consumer contract), GRANT alone delivers zero events — RLS must be enabled with at least one permissive `select` policy for events to reach the channel at all. The new asymmetric `sb_secret_*` keys don't authenticate against the Realtime websocket handshake (separate finding; [supabase-js#2029](https://github.com/supabase/supabase-js/pull/2029)-shaped territory but distinct from the warm-up bug).

**Why this wasn't caught earlier:** branches via `withBranch` get auto-grants on table creation (Supabase branch provisioning hook); `support_tickets` (used in ADR-0014's worked example) was created via migration which auto-grants; `tests/smoke/watch-table.smoke.test.ts` doesn't inspect `new` content so it silently passed. Direct `sql.unsafe(create table ...)` against the host project (the spike's shape) doesn't auto-grant — that's the gap.

**Consumer-facing implication:** the bounded-watch primitive depends on consumers having configured their tables with the RLS + GRANT chain that PostgREST + Realtime expect. This is the standard Supabase contract, but it's worth surfacing in `references/` because consumers driven through agents may not realize a table they "own" needs explicit GRANT to receive postgres-changes row data via Realtime when subscribed under anon JWT.

**Spike fix:** [`eval/spike-edge-warmup.ts:198-217`](../eval/spike-edge-warmup.ts) now applies `enable row level security` + `create policy ... using (true)` + `grant select on ... to anon, authenticated, service_role` after `CREATE TABLE`. Re-run with the chain shows `new` populated and 12s wall-budget recommendation unchanged. Bucket distribution shifts: n0 ratio drops from 65% to 30% — the RLS evaluation adds ~100-200ms per event, pushing more trials past the warm-up threshold. p99 unchanged within margin (5322ms vs 5490ms first pass).

**Smoke shape:** ADR-0016's watch_table Edge smoke must apply this chain on the temp table before subscribing, otherwise it'd silently pass on `events.length === 1` while the row data is 401-stripped. See "Methodology consequences" below.

### 3. Anon-JWT path validated via probe (RLS-policy required)

Probe variant G (anon JWT + GRANT + RLS-enabled + `select using(true)` policy) delivered 1/1 with populated `new`. Variant F (anon JWT + GRANT alone, RLS-disabled) delivered **zero events** — Realtime requires the policy gate to deliver postgres-changes events to anon at all. This pins the consumer contract: `watch_table` consumers using anon JWT need both RLS-enabled AND a permissive `select` policy on the source table.

**Action item:** ADR-0016's smoke uses anon JWT (matches consumer contract); table setup applies the full RLS + policy + GRANT chain to mirror what consumer-side migrations produce. service_role-bearer smoke variant is unnecessary for v1.0.0 — the probe data is the validation receipt.

## Methodology consequences for ADR-0016

1. **Smoke wall budget = 12s** — covers p99 + comfortable margin, well within the Edge isolate's 150s ceiling and the spec's 30s smoke-test tradition. Spike re-run with the GRANT+RLS chain confirms the recommendation unchanged.
2. **Multi-INSERT schedule is mandatory** — single-shot INSERTs at +100ms will flake. Mirror `watch-table.smoke.test.ts:87-89` exactly.
3. **Smoke MUST apply the GRANT + RLS chain** before subscribing. Sequence: `create table` → `replica identity full` (optional, only matters if smoke ever tests UPDATE/DELETE `old`) → `enable row level security` → `create policy ... using (true)` → `grant select on ... to anon, authenticated, service_role` → `alter publication supabase_realtime add table`. Without the chain, `events.length === 1` passes vacuously while `new: {}` carries 401.
4. **Smoke asserts on populated `new`** — once the chain is in place, `payload.new` carries the row. The smoke should assert `event.new.body === <expected>` (or whatever sentinel column it inserts) to detect future regressions where the chain breaks.
5. **Smoke uses anon JWT** — matches consumer contract; probe variant G is the validation receipt.

## What the spike does NOT prove

- **Cold-start variance under no warm isolate.** All 20 trials ran consecutively; the host project's Edge isolate stayed warm. Real consumer behavior (one-off `watch_table` invocations spaced minutes apart) may see longer p99. Out-of-scope for the v1.0.0 ship; v2 hardening could add a "minute-spaced trial" variant if cold-start tax becomes load-bearing.
- **Concurrent watch_table calls.** Spike serializes trials. Each call provisions a fresh per-request server, but Realtime broker behavior under concurrent subscribes-on-the-same-table is unmeasured.
- **Anon-JWT-with-RLS-policy delivery success rate.** See sub-finding #3.

