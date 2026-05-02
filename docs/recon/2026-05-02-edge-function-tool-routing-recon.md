# Recon: Edge Function tool-routing — the v1.0.0 highest-leverage gap (2026-05-02)

Pre-ADR recon for what I called the "highest-leverage single thing" in the v1.0.0 roadmap conversation: closing the gap between the README's "MCP server on Edge" claim and what's actually verified end-to-end on the deployed runtime. Filed on branch `recon/edge-function-tool-routing`. Mirrors the shape of [`2026-05-02-worked-example-ship-recon.md`](2026-05-02-worked-example-ship-recon.md) — evidence first, ADR later.

The headline finding inverts the framing:

> **The routing code is already wired** in `src/server/server.ts:188-247` (a `CallToolRequestSchema` switch covering all five tools). What's not verified is `tools/call` against the *deployed* function on real Edge runtime — only `tools/list` (a metadata round-trip) has been live-checked. Plus the deployed function pins `@supabase/supabase-js@2.45.0` in `supabase/functions/mcp/deno.json`: 43 minor versions behind the npm package's `^2.88.0` floor, 60 behind latest stable (2.105.1). Production code paths use `httpSend()`, added in 2.75.0 (Oct 2025) — the deployed runtime literally cannot execute `broadcast_to_channel`'s production sender.

So "Edge Function tool-routing" isn't an *implementation* gap — it's a *verification* gap and a *dependency-currency* gap. Different kind of work than the headline suggests.

## Why this recon, why now

CLAUDE.md repo-layout table line 52: `supabase/functions/mcp/ — Edge Function entry (deploys; tool-routing pending)`. CLAUDE.md status block line 177: "Edge Function deployed and live-verified (JSON-RPC `tools/list` round-trips)". Two claims that, side-by-side, are subtly inconsistent: "tool-routing pending" but "live-verified" — verified for *what*?

Reading the code dispels the contradiction in one direction (routing is wired), but surfaces another problem (verification scope). For a credible v1.0.0 ship, the README's "Deploy the MCP server as an Edge Function (live-verified)" needs an asterisk-free reading: every tool in the `tools/list` response must round-trip through `tools/call` on the deployed function, against the same supabase-js floor consumers install.

Three questions this recon has to answer before any drafting:

1. **What's actually verified end-to-end on the deployed runtime today?** Live `tools/list` only, per `tests/smoke/edge-deploy.smoke.test.ts` and commit `9abd676`. No `tools/call` smoke against the live function exists.
2. **Is the deployed function running the same code paths as npm consumers?** No. `deno.json` pins `npm:@supabase/supabase-js@2.45.0`; npm package floor is `^2.88.0`. The deployed runtime cannot exercise `httpSend()` (added 2.75.0) which is what `broadcast_to_channel` uses in production code.
3. **Is the architectural pattern blessed by Supabase, or rolled-our-own?** Mostly blessed. Supabase shipped an official "Build and deploy MCP servers" guide (verified live 2026-05-02) using the same `WebStandardStreamableHTTPServerTransport` we use. They wrap with Hono; we use raw `Deno.serve`. Both work; theirs is the documented path.

## Internal recon

### Tool routing IS wired — `src/server/server.ts:188-247`

`makeServer()` registers two request handlers on the `Server` instance: `ListToolsRequestSchema` (returns `TOOL_DEFS` with five entries) and `CallToolRequestSchema` (a switch over `req.params.name` covering `watch_table`, `broadcast_to_channel`, `subscribe_to_channel`, `list_channels`, `describe_table_changes`). Each case wires to the corresponding handler module — `handleWatchTable`, `handleBroadcast`, etc. The `default` case throws `ToolError("UPSTREAM_ERROR", "unknown tool: ${name}")`.

The Edge Function entry at `supabase/functions/mcp/index.ts` calls `makeServer(cfg)` then `transport.handleRequest(req)` against `WebStandardStreamableHTTPServerTransport`. The MCP SDK's transport handles JSON-RPC routing internally — `tools/list` and `tools/call` both go through `transport.handleRequest`, which dispatches to the `Server`'s registered handlers.

**This is correct, complete, and wired.** What's stale is the description of it as "pending."

### What `tests/smoke/edge-deploy.smoke.test.ts` actually verifies

Two `it()` blocks:
1. POST `/functions/v1/mcp` with JSON-RPC `tools/list` → expects 5 tool entries with their input schemas + descriptions.
2. GET `/functions/v1/mcp/health` → expects `200 OK` plain-text liveness.

Neither block calls `tools/call`. The README's "live-verified" claim covers *transport reachability + tool-list metadata round-trip*, not actual tool execution end-to-end.

### `deno.json` is 43 minors behind floor, 60 behind latest stable

```json
"@supabase/supabase-js": "npm:@supabase/supabase-js@2.45.0"
```

vs. `package.json`'s `"@supabase/supabase-js": "^2.88.0"`. The Edge Function deployment runs supabase-js 2.45.0; consumers `npm install`ing the package resolve to `^2.88.0` minimum, more likely the latest stable 2.x.

Specific code paths broken at 2.45.0:

- **`broadcast_to_channel`** uses `makeProductionBroadcastSender` which calls `ch.httpSend(...)` (added supabase-js 2.75.0, Oct 2025). On 2.45.0, `httpSend` doesn't exist; the call throws at runtime.
- **`watch_table`** subscribes to Postgres-Changes via the websocket. The premature-`SUBSCRIBED` warm-up window we documented as T7 in `spike-findings.md` is tracked upstream as [supabase-js#1599](https://github.com/supabase/supabase-js/issues/1599) with a candidate fix at [PR #2029](https://github.com/supabase/supabase-js/pull/2029). **PR #2029 is OPEN as of 2026-05-02 (not merged at any 2.x version);** the bug is unfixed at upstream HEAD. Bumping the deno.json pin doesn't fix this — but keeps us aligned with the upstream once the fix lands. The smoke-test multi-insert pattern + `eval/spike-latency.ts` warmup-discard remain load-bearing in the meantime.
- **The Authorization header empty-string bug** ([#1937](https://github.com/supabase/supabase-js/pull/1937), MERGED at 2.88.0, Dec 2025) bites if the agent's JWT is missing, which it shouldn't be in production but does happen in dev.

The `httpSend()` gap is *not theoretical* — it's a guaranteed silent failure for any consumer who deploys the current `supabase/functions/mcp/index.ts` and calls `broadcast_to_channel` from an agent. The Authorization-header fix is a defensive bonus. The premature-SUBSCRIBED issue stays open and is unaffected by this work.

### `references/edge-deployment.md` carries one drift artifact

Line 32: `Expected: 200 OK with body 'supabase-realtime-skill MCP — transport pending'.`

The actual body the function returns at `index.ts:26` is `"supabase-realtime-skill MCP — ok"`. The "transport pending" wording predates the MCP transport rewire (commit 9abd676). Operator-visible drift in a reference page — same currency-fix shape we just applied to README + SKILL.md, missed in PR #11.

### Edge Function entry imports `../../../src/server/server.ts`, not the published package

`supabase/functions/mcp/index.ts:12`:
```ts
import { makeServer } from "../../../src/server/server.ts";
```

with a comment at line 14:
```ts
// After npm publish, swap the makeServer import to:
// import { makeServer } from "npm:supabase-realtime-skill@latest/dist/server.js";
```

Today the deployed function consumes the source tree, not the npm package. The "swap to npm:" path is a `// TODO`. For a v1.0 ship that says "deploy the same artifact you install," the import has to swap. Until then, every Edge Function deploy is `git clone` + `supabase functions deploy`, which is the development pattern, not the production one.

## External research findings

External sweep via Exa over MCP-on-Supabase-Edge production patterns, `WebStandardStreamableHTTPServerTransport` deployments, and supabase-js Realtime/Edge interop history. Headlines below; primary sources cited inline.

### 1. Supabase has an official "Build and deploy MCP servers" guide

**Headline:** [Supabase docs — "Deploy MCP servers"](https://supabase.com/docs/guides/getting-started/byo-mcp), verified live 2026-05-02 (recent, exact publish date not visible from the page). The canonical pattern. Uses the same `WebStandardStreamableHTTPServerTransport` we use, with one architectural difference (Hono wrapper) and one auth caveat (`--no-verify-jwt` required).

The reference code from the docs:

```ts
import { McpServer } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from 'npm:@modelcontextprotocol/sdk@1.25.3/server/webStandardStreamableHttp.js'
import { Hono } from 'npm:hono@^4.9.7'

const app = new Hono()
const server = new McpServer({ name: 'mcp', version: '0.1.0' })

server.registerTool('add', { ... }, ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
}))

app.all('*', async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport()
  await server.connect(transport)
  return transport.handleRequest(c.req.raw)
})

Deno.serve(app.fetch)
```

Differences from our `supabase/functions/mcp/index.ts`:

1. **Hono wrapper** — they route via `app.all('*', ...)`; we go straight to `Deno.serve`. Both work; Hono is the documented blessed path. Hono adds basePath handling (matters for the Supabase CLI local-dev path prefix issue) and more idiomatic CORS / health routes.
2. **MCP SDK pinned at 1.25.3** — we're at 1.29.0 in `deno.json`. Both should ship `WebStandardStreamableHTTPServerTransport`. Worth confirming our 1.29.0 actually exports the same class shape.
3. **`McpServer` (high-level)** — they use `McpServer.registerTool()` with zod inputSchemas. We use the lower-level `Server` class with manual `setRequestHandler(CallToolRequestSchema, ...)`. Both work; theirs is more ergonomic. Doesn't matter for v1.0; matters if we ever want to publish a tutorial.
4. **`supabase functions deploy --no-verify-jwt mcp`** — required because Supabase's gateway JWT verification is "incompatible with the new asymmetric signing keys (post-2025)" per [matt-fournier/supabase-mcp-template](https://github.com/matt-fournier/supabase-mcp-template). The Supabase guide explicitly says "Auth support for MCP on Edge Functions is coming soon."

**Implication:** the artifact's existing pattern is *correct in shape* but not aligned with the blessed path on two surfaces:
- Hono vs raw `Deno.serve` (cosmetic, no contract-level difference)
- `--no-verify-jwt` flag in the deploy command (we use the default; we should re-verify our deploy works under post-2025 asymmetric keys, or commit explicitly to `--no-verify-jwt`)

### 2. Supabase Edge runtime has historic Realtime websocket pain — mostly fixed, but version-pinning matters

**Headline:** Pre-2024, npm-imported websocket libraries on Supabase Edge Functions threw `TypeError: upgradeHttpRaw may only be used with Deno.serve` ([supabase/edge-runtime#300](https://github.com/supabase/edge-runtime/issues/300)). Fixed in edge-runtime 1.43.0 (Apr 2024). May 2025: realtime-js bumps caused boot errors on Edge — `Cannot find module '...realtime-js/2.11.9/dist/module/RealtimeClient'` ([supabase-js#1433](https://github.com/supabase/supabase-js/issues/1433)). Workaround: explicit version pin.

**Implication:** the "Realtime works on Edge Functions" claim is true in 2026 but historically fragile. Our deno.json pin (2.45.0) was likely chosen during the spike to avoid one of these regressions. Bumping to ^2.105.x means re-running our smoke against a newer pin; the risk surface is real but well-trod.

### 3. Premature-SUBSCRIBED fix matters specifically for `watch_table`

**Headline:** [supabase-js#1599](https://github.com/supabase/supabase-js/issues/1599) — "Premature SUBSCRIBED status for postgres_changes signals incorrect readiness." Filed Aug 2025. Candidate fix at [PR #2029](https://github.com/supabase/supabase-js/pull/2029) ("wait for postgres_changes system ready before emitting SUBSCRIBED") opened Jan 2026 — **OPEN as of 2026-05-02, not merged at any 2.x version**. The bug remains unfixed upstream at HEAD.

The bug: client emits `SUBSCRIBED` after Stage 1 (Phoenix channel join, fast). Stage 2 (Realtime → Postgres → publication → replication slot, slow, several seconds) hadn't finished yet. INSERTs in the post-SUBSCRIBED-pre-stage-2-ready window were silently missed.

**The same bug we pre-discovered as the "Realtime ~5s warm-up window"** in `docs/spike-findings.md` (T7) and worked around with the `eval/spike-latency.ts` adapter pattern. Our smoke tests use a multi-insert schedule for exactly this reason.

**Implication:** the 5s warm-up bug is unfixed at every supabase-js 2.x version including 2.105.x. Our Edge `watch_table` exhibits the warm-up-window behavior; bumping the deno.json pin does NOT address this. The T7 5s-warm-up note in `spike-findings.md` stays current; the smoke-test multi-insert pattern + `eval/spike-latency.ts` warmup-discard pattern remain the load-bearing workaround. The recon raises this only as evidence that we and Supabase have the same understanding of the bug; the pin bump's rationale leans on `httpSend()` (genuinely added 2.75.0) and the empty-Authorization fix (#1937, genuinely merged 2.88.0), not on this still-open issue.

### 4. NAWA built a 1500-line production MCP server on Supabase Edge — five lessons

**Headline:** [How We Built an MCP Server That Lets Claude Manage YouTube Comments](https://www.trynawa.com/blog/how-we-built-an-mcp-server) (NAWA, Mar 2026). Production deployment: 10 tools, OAuth via Cloudflare Worker proxy. Five lessons matter for our 1.0:

1. **MCP spec strips your path.** OAuth endpoints must live at the domain root. Supabase Edge Functions live at `<ref>.supabase.co/functions/v1/<name>`. If you need OAuth/discovery, add a Cloudflare Worker proxy. **For our use case (JWT forwarded by the operator), this doesn't apply** — we don't do OAuth discovery. Worth a callout in the v1.0 reference page.
2. **PostgREST silent insert failures on column-name typos.** Not relevant to our surface; we don't use PostgREST inside the MCP function.
3. **Cloudflare Worker query-builder chain order.** Not relevant.
4. **PKCE is mandatory for OAuth-using MCP servers.** Not relevant; we don't run OAuth.
5. **Token rotation on refresh.** Not relevant.

**Implication:** the NAWA pattern's auth complexity is *avoidable for our shape* because we forward the operator's JWT rather than running an OAuth flow. v1.0 should explicitly commit to "JWT-forward-only" as the v1.0 auth contract; OAuth/discovery is a v2 question that would require a Cloudflare Worker proxy or wait for "Auth support for MCP on Edge Functions" (Supabase's "coming soon" claim).

### 5. `WebStandardStreamableHTTPServerTransport` documented contract

**Headline:** the SDK's transport class (verified via [SDK source](https://github.com/modelcontextprotocol/typescript-sdk/blob/327243ce/packages/server/src/server/streamableHttp.ts) + [docs page](https://ts.sdk.modelcontextprotocol.io/v2/classes/_modelcontextprotocol_server.server_streamableHttp.WebStandardStreamableHTTPServerTransport.html)) is documented as runtime-portable: "works on any runtime that supports Web Standards: Node.js 18+, Cloudflare Workers, Deno, Bun, etc."

`enableJsonResponse: true` is the documented mode for stateless JSON-only response (no SSE). The reference example `jsonResponseStreamableHttp.ts` matches our pattern. `sessionIdGenerator: undefined` (which we use implicitly via not passing it) is the documented stateless mode.

**Implication:** our transport configuration is correct per the SDK's documented contract. No re-architecture needed at the transport layer.

### 6. Helper libraries exist — `mcp-lite`, `Rodriguespn/supabase-mcp-handler`, `mcp-handler`

**Headline:** Multiple community libraries provide higher-level "deploy MCP on Supabase Edge in 10 lines" helpers. None are required (the SDK works directly), but they're the documented ecosystem path. Worth knowing they exist — *not* worth adopting one for v1.0 (vendoring more deps is the wrong direction for a tight skill).

## Six explicit decisions ADR-0015 (or whatever) has to make

In rough order of effect:

1. **Bring `supabase/functions/mcp/deno.json` into supabase-js currency.** Recommend bump to `^2.105.x` (or at minimum `^2.88.0` to match the npm package floor). Without this, `broadcast_to_channel` is broken on the deployed function. Mechanical change; ~30min including a redeploy + smoke pass.

2. **Add `tools/call` end-to-end smoke against the live function.** Extend `tests/smoke/edge-deploy.smoke.test.ts` with at least: (a) `describe_table_changes` (no Realtime needed, pure SQL introspection — easiest first verification), (b) `broadcast_to_channel` (exercises `httpSend()` at runtime — the load-bearing claim). Maybe (c) `watch_table` against a public-channel-no-RLS table (exercises Postgres-Changes on Edge).

3. **Hono or stay raw `Deno.serve`.** The Supabase blessed pattern uses Hono; ours uses raw. Recommend **stay raw** for v1.0 — fewer deps, simpler bundle, the `WebStandardStreamableHTTPServerTransport` doesn't care which framework wraps it. Document the choice in `references/edge-deployment.md` so reviewers can see we picked it deliberately.

4. **`--no-verify-jwt` policy.** Supabase docs says required; matt-fournier template says required because of post-2025 asymmetric signing keys. Recommend **adopt explicitly**: change the documented deploy command in `references/edge-deployment.md` to `supabase functions deploy --no-verify-jwt mcp`, AND document why (gateway JWT verification incompatible; the function reads the Authorization header itself for the agent's JWT). The smoke test should run against a `--no-verify-jwt` deploy.

5. **Edge Function should consume the published npm package, not the source tree.** Swap `index.ts:12` from `import { makeServer } from "../../../src/server/server.ts"` to `import { makeServer } from "npm:supabase-realtime-skill@^0.2.0/server"`. Resolves: (a) the deployed function exercises the same code consumers install; (b) operators don't need a `git clone` to deploy; (c) version drift between source tree and deployed function is impossible.

6. **`references/edge-deployment.md` reference-page refresh.** Two known stale strings (`"transport pending"` line 32; auth-pattern paragraph predates ADR-0011's setAuth fix). Plus a new section: "JWT-forward-only — what v1.0 commits to, what v2 might add." Keeps the reference page faithful to the deployed function's actual behavior.

## Falsifiable predicted effect (draft)

Per playbook § 8, no recommendation without a falsifiable predicted effect. The substrate-correctness ADRs (0011, 0013) had clean smoke-shaped predicted effects; this recon's effect is a *deployment-correctness* assertion at the live URL.

> **An external consumer of `supabase-realtime-skill@0.3.0` (the next version after this work lands) who runs `supabase functions deploy --no-verify-jwt mcp` against a Pro project, then exercises JSON-RPC `tools/call` for `describe_table_changes` + `broadcast_to_channel` against the deployed URL with a forwarded user JWT, observes both calls return non-error responses, with `broadcast_to_channel` actually fanning out the message (verified by a separate `subscribe_to_channel` listener).**

Properties:
- **Smoke-test-shaped, not fixture-shaped.** Mirrors the ADR-0011/0013 evidence pattern.
- **Falsifiable in five named directions:**
  - If `deno.json` is still pinned at 2.45.0, `broadcast_to_channel` throws because `httpSend()` doesn't exist (substrate currency gap)
  - If the import in `index.ts` doesn't resolve under `npm:` after publish, the function fails to boot (deploy currency gap)
  - If `--no-verify-jwt` isn't set, post-2025 keys cause gateway rejection before our handler runs (auth flow gap)
  - If the agent's JWT isn't forwarded (or `setAuth` isn't called), `broadcast_to_channel` works for public channels but `private: true` calls fail at the `realtime.messages` policy (RLS gap; ADR-0011/0013 proven on the npm package, but not yet re-verified on Edge)
  - If `WebStandardStreamableHTTPServerTransport` at MCP SDK 1.29.0 has a subtle regression vs 1.25.3 in `tools/call` routing, the transport returns -32601 ("Method not found") (SDK regression — low-confidence-but-real risk)
- **No new fixture corpus needed.** Same shape as `tests/smoke/edge-deploy.smoke.test.ts`'s existing tools/list block, just extended with tools/call assertions.
- **Cost: ~$3-5** for one Pro project + one Edge deploy + one smoke run. Not a manifest cell; not a fixture corpus.

## Where design risk concentrates

1. **The deno.json bump is a multi-year jump.** Same risk as the recon's prior § "supabase-js drift" — but worse, because we go from 2.45 (Jul 2024) to 2.105 (Apr 2026), ~21 months. Realtime websocket internals refactored multiple times in that window (phoenix js refactor, default serializer 2.0.0, deferred disconnect, etc.). Smoke is the canonical regression gate.

2. **Hono adoption is a real dependency surface decision.** Adopting it would simplify routing but adds 50KB+ to the bundle and another version to track. Recon's tilt: stay raw. ADR commits.

3. **`--no-verify-jwt` makes the function publicly invocable.** Without gateway verification, anyone who knows the function URL can POST. Our handler reads the Authorization header and refuses tool calls without a JWT (today, soft-fails to anon claims; post-fix, would error cleanly). v1.0 should commit on whether the Edge Function returns 401 on missing Authorization or accepts anon-claims operation.

4. **The "consume the published package" swap is harder than it looks.** `npm:supabase-realtime-skill@0.2.0/server` resolves to the package's `./server` export (`./dist/server/index.js`). Verified the export exists in `package.json`. But the bundled `dist/server/index.js` may have transitive deps that resolve differently in Deno's npm compat than in Node. The first deploy after this swap is the actual proof.

5. **The "tool-routing pending" CLAUDE.md wording is a documentation drift artifact.** Once we close the verification gap, the wording needs to flip to "live-verified end-to-end including tools/call." Currency commit, mirror of `b5078a0` + `043cc75`.

6. **Auth-flow framing in the reference page.** v0.x pre-T31 we said "agnostic to which JWT pattern you pick." For v1.0 we should commit: JWT-forward-only is the v1.0 contract; OAuth/discovery is v2 (per the NAWA pattern, requires a Cloudflare Worker proxy until Supabase ships the "coming soon" auth support). This is a real downscope of the agnostic framing.

## What this means for the next step

**Direction:** narrow Edge-runtime currency + verification ship. Not a substrate change (the substrate is correct); not a worked-example ship (the worked examples are correct). Closes the gap between README claims and live deployment behavior.

**Recommended ADR pre-loads:**

- **Sequence smoke extension before deno.json bump.** Same FAIL→PASS-style discipline ADR-0011 used. Write the `tools/call describe_table_changes` smoke against the *current* deployed function (expect pre-fix to PASS — describe_table doesn't touch Realtime); then write `tools/call broadcast_to_channel` (expect pre-fix to FAIL because httpSend doesn't exist at 2.45.0); land the deno.json bump + redeploy; re-run (expect both PASS).
- **Bump `supabase/functions/mcp/deno.json`** `@supabase/supabase-js@2.45.0` → `@supabase/supabase-js@2.105.x` (or floor at `^2.88.0`). Update `deno.lock`. Redeploy.
- **Adopt `--no-verify-jwt` in the documented deploy command.** Update `references/edge-deployment.md` § "Deploy" to include the flag + a one-paragraph rationale (post-2025 asymmetric keys + we read Authorization in-function).
- **Swap the `index.ts` import** to `npm:supabase-realtime-skill@^0.2.0/server`. Test: redeploy, verify `tools/list` still works, then verify `tools/call`.
- **Stay with raw `Deno.serve`** (not Hono). Document the choice in `references/edge-deployment.md` § "Architecture choice" — bundle size, fewer deps, transport doesn't care.
- **Refresh `references/edge-deployment.md`** for the documentation drift artifacts (`"transport pending"` → `"ok"`; auth-pattern paragraph; new "JWT-forward-only v1.0 contract" section).
- **Frame the ADR as "closing the deployment-verification gap"** — not "implementing tool-routing." Routing is wired; what's missing is the receipt that it works on Edge.

These are recommendations, not decisions — ADR will be filed as **Proposed**, per ADR status discipline.

**Open questions deferred to the ADR pass:**

- Whether v1.0 should ship a *companion* Edge Function migration (i.e., a third migration file for the demo's MCP-call wiring), or whether the existing two demo migrations + the deploy command in the reference page is sufficient.
- Whether the smoke extension exercises `watch_table` or only the easier two (`describe_table_changes` + `broadcast_to_channel`). `watch_table` requires a publication + an INSERT during the smoke window — adds 30-60s wall time but tests the real Realtime path.
- Whether to bump the MCP SDK pin (`@modelcontextprotocol/sdk@1.29.0` → latest stable). The Supabase docs use 1.25.3; both should ship `WebStandardStreamableHTTPServerTransport`. Worth a sanity check but not load-bearing.
- Whether `subscribe_to_channel` end-to-end against a real broadcast also belongs in the smoke (would require a separate sender). Adds rigor; adds wall time.
- Whether the refresh of `references/edge-deployment.md` includes the new "JWT-forward-only contract" section as part of this PR or splits to a follow-up. Lean toward bundling — the reference page is the surface a v1.0 consumer reads.
- Whether to call the next ADR `0015` or fold this into a "v1.0 release manifest" composite ADR with the other roadmap items (Presence, dead_letter_table, manifest n=300). The ADR-0011 / ADR-0013 pattern was one ADR per substrate-correctness fix; this might be one ADR per v1.0 surface decision.

## References

**Internal:**
- [`docs/recon/2026-05-02-worked-example-ship-recon.md`](2026-05-02-worked-example-ship-recon.md) — recon shape this doc mirrors; same delta-analysis pattern; first to surface the supabase-js drift.
- [`docs/decisions/0011-multi-tenant-rls-baseline.md`](../decisions/0011-multi-tenant-rls-baseline.md) — substrate-correctness FAIL→fix→PASS pattern this recon imports.
- [`docs/decisions/0014-worked-example-ship.md`](../decisions/0014-worked-example-ship.md) — npm `0.2.0` version stream; this recon proposes `0.3.0` as the v1.0 staging version.
- [`src/server/server.ts:188-247`](../../src/server/server.ts) — the actually-wired CallToolRequestSchema switch; routing-is-wired evidence.
- [`supabase/functions/mcp/index.ts`](../../supabase/functions/mcp/index.ts) — Edge Function entry; needs the npm-package import swap + `--no-verify-jwt` rationale.
- [`supabase/functions/mcp/deno.json`](../../supabase/functions/mcp/deno.json) — supabase-js pin at 2.45.0 (43 minors behind floor; 60 behind latest stable).
- [`tests/smoke/edge-deploy.smoke.test.ts`](../../tests/smoke/edge-deploy.smoke.test.ts) — current verification scope (`tools/list` only); the smoke extension target.
- [`references/edge-deployment.md`](../../references/edge-deployment.md) — operator-facing reference; carries `"transport pending"` drift artifact.
- [`docs/spike-findings.md`](../../docs/spike-findings.md) — T7 5s warm-up note; stays current (upstream PR #2029 is open, not merged).

**External (Supabase blessed pattern):**
- [Supabase Docs — Deploy MCP servers](https://supabase.com/docs/guides/getting-started/byo-mcp) — official guide, verified live 2026-05-02. Hono + `WebStandardStreamableHTTPServerTransport` + `--no-verify-jwt`.
- [matt-fournier/supabase-mcp-template](https://github.com/matt-fournier/supabase-mcp-template) — community template; documents the `--no-verify-jwt` rationale (post-2025 asymmetric keys).
- [Rodriguespn/supabase-mcp-handler](https://github.com/Rodriguespn/supabase-mcp-handler) — mcp-lite-based helper for Supabase Edge.

**External (MCP SDK transport):**
- [MCP TypeScript SDK — WebStandardStreamableHTTPServerTransport](https://ts.sdk.modelcontextprotocol.io/v2/classes/_modelcontextprotocol_server.server_streamableHttp.WebStandardStreamableHTTPServerTransport.html) — class docs.
- [MCP SDK — streamableHttp.ts](https://github.com/modelcontextprotocol/typescript-sdk/blob/327243ce/packages/server/src/server/streamableHttp.ts) — source; runtime-portable contract.
- [MCP TypeScript SDK — server.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md) — `enableJsonResponse: true` + stateless mode.

**External (supabase-js + Edge interop history):**
- [supabase-js#2029](https://github.com/supabase/supabase-js/pull/2029) — candidate fix for the premature-SUBSCRIBED bug; **OPEN as of 2026-05-02, not merged**. Tracks the same upstream issue as our T7 5s-warm-up spike finding; deno.json bump does not address this.
- [supabase-js#1599](https://github.com/supabase/supabase-js/issues/1599) — premature-SUBSCRIBED bug report; matches our T7 finding.
- [supabase-js#1559](https://github.com/supabase/supabase-js/issues/1559) — Node.js websocket race (browser/Deno fine; Node only).
- [supabase-js#1937](https://github.com/supabase/supabase-js/pull/1937) — empty-Authorization-header fix (2.88.0); the floor pin already in `package.json`.
- [supabase-js#1433](https://github.com/supabase/supabase-js/issues/1433) — May 2025 realtime-js boot error on Edge; explicit-version-pin workaround.
- [supabase/edge-runtime#300](https://github.com/supabase/edge-runtime/issues/300) — Apr 2024 websocket-via-npm-compat bug; fixed in edge-runtime 1.43.0.

**External (production MCP-on-Edge prior art):**
- [NAWA — How We Built an MCP Server That Lets Claude Manage YouTube Comments](https://www.trynawa.com/blog/how-we-built-an-mcp-server) — 1500-line production deployment; Cloudflare Worker proxy for OAuth; five lessons learned.
- [casys.ai — MCP Server in Production: The Complete TypeScript Guide](https://www.casys.ai/blog/mcp-server-guide) — production discipline (rate limiting, observability, concurrency); Deno-compatible.
- [Supabase Edge Functions in Deno: A Production Guide](https://dev.to/kanta13jp1/supabase-edge-functions-in-deno-a-production-guide-5d95) — 18-functions-in-prod operator perspective; cold-start budget, memory limits, secrets pattern.
