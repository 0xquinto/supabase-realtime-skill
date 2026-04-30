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

1. **ci-nightly (T9) cannot naively measure `arm-watch → insert@100ms → match` latency** as a single value — the first event of any fresh table will appear to take ~5 s. The metric must be either (a) post-warmup-only or (b) explicitly bucketed cold-vs-warm.
2. **The smoke test now uses a multi-insert pattern** (fire at +100 ms, +5 s, +10 s; measure latency from the most recent committed insert before match). This honestly reflects steady-state behavior and is what ci-nightly should imitate.
3. **The skill's `references/replication-identity.md`** (or a new `references/realtime-warmup.md`) should document this for skill consumers — agents that subscribe-then-immediately-insert will miss their own first event without a warm-up step.
4. **Possible mitigation in the production `makeSupabaseAdapter`**: insert a "warmup ping" (a no-op publication INSERT by a sidecar table or a sentinel row) before resolving the `subscribe` promise. Defer this until after T9 quantifies the variance — premature optimization without numbers.

## Open questions for week-1 follow-up

- Does the warm-up window also apply when subscribing to a table that was *already* in `supabase_realtime` from project init (e.g., re-subscribing on each tool call rather than on table creation)? If so, the cost is per-tool-call and ci-nightly's p95 will reflect it directly. If not, the cost is a one-time per-table-add and trivial.
- Is the ~5 s cadence configurable on Supabase Realtime? If so, can the maintainers ship a doc note steering agents around it?

## Test artifact

The smoke is committed in T7 and passes against a real Pro branch. Steady-state latency line proves end-to-end. The pre-warm pattern is a single-trial workaround — ci-nightly will measure properly.

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
