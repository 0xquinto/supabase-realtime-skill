# ADR-0015: Edge Function tool-routing — verification coverage + source-tree-vs-deployed alignment

**Status:** Proposed (2026-05-02). Implementation drafted on `feat/edge-function-tool-routing`. The deno.json bump + smoke extension + reference refresh ship in this PR; promotion to Accepted gates on the post-deploy PASS receipt against the redeployed function with `--no-verify-jwt`.

**Date:** 2026-05-02

**Supersedes:** none. **Composes on top of:** ADR-0011 (Postgres-Changes RLS substrate), ADR-0013 (Broadcast Authorization substrate), ADR-0014 (npm `0.2.0` worked-example ship).

**Related recon:** [`docs/recon/2026-05-02-edge-function-tool-routing-recon.md`](../recon/2026-05-02-edge-function-tool-routing-recon.md). The recon's six explicit decisions are committed on below, with two empirical refinements captured during pre-fix probing.

## Context

The recon called this the "v1.0.0 highest-leverage gap": the README claims "Edge Function deployed and live-verified" but the verification was scoped to JSON-RPC `tools/list` (a metadata round-trip) — `tools/call` against the deployed function was never exercised. CLAUDE.md surfaced the inconsistency directly: repo-layout said "tool-routing pending"; status block said "live-verified." Both were partial truths.

Reading the source dispelled the contradiction in one direction (`src/server/server.ts:188-247` wires a `CallToolRequestSchema` switch covering all five tools; routing is not pending — it's complete). Reading `supabase/functions/mcp/deno.json` surfaced the second gap: `@supabase/supabase-js@2.45.0` (Jul 2024) — 43 minor versions behind the npm package's `^2.88.0` floor, 60 behind latest stable (2.105.1). Production code paths use `httpSend()` (added 2.75.0 per CLAUDE.md / our prior reading); on 2.45.0, `httpSend` should not exist and `broadcast_to_channel` should fail at runtime.

Pre-fix probing inverted the recon's predicted FAIL→PASS shape (see § "Empirical refinement"). What stays load-bearing: tools/call coverage was zero on the deployed function before this ADR; alignment between source-tree config (`deno.json`) and what consumers actually deploy was loose; the function imported the source tree directly rather than the published npm package.

## Decisions

### 1. Bring `supabase/functions/mcp/deno.json` into supabase-js currency — `^2.105.1`

**Bump `@supabase/supabase-js@2.45.0` → `@supabase/supabase-js@^2.105.1`.** Regenerated `deno.lock` resolves `realtime-js@2.105.1` (the version of `realtime-js` that ships `httpSend` and the empty-`Authorization` REST header fix from supabase-js#1937). `^2.105.1` matches the latest stable at filing; the caret allows minor / patch movement up to 3.0.

Caret rather than exact pin because the npm package's package.json declares `^2.88.0` — the function's deno.json should pick the latest matching, not a version older than the floor consumers see. `^2.105.1` is the explicit-current-version-at-deploy; the resolver picks newer 2.x as released.

`deno check index.ts` passes after the bump.

### 2. Add `tools/call` end-to-end smoke against the live function

**Extend `tests/smoke/edge-deploy.smoke.test.ts`** with two new `it()` blocks:

- **`tools/call describe_table_changes`**: probes a guaranteed-not-there table (random suffix `__realtime_skill_smoke_${Date.now()}__`) and asserts the structured `INVALID_TABLE` error wrapped in `isError: true`. Schema-independent by design — the host project's `public` schema is not guaranteed to contain `support_tickets`. The error shape proves: tool routing works, DB connectivity works (`SUPABASE_DB_URL` auto-injection), error envelope works.
- **`tools/call broadcast_to_channel`**: sends a small payload to a public channel (private: false). Asserts `{success: true}` from the wire. Exercises `makeProductionBroadcastSender` → `ch.httpSend()` at runtime — the load-bearing path.

Pre-fix run (current deployment, deno.json claiming `@supabase/supabase-js@2.45.0`): all 4 `it()` blocks PASS in 7.67s wall. See § "Empirical refinement" for what this finding implies.

Post-fix run (deno.json bumped to `^2.105.1` + redeploy with `--no-verify-jwt`): expected to PASS.

The smoke is now a forward-looking regression gate: any future deno.json regression below the supabase-js floor would surface as a `broadcast_to_channel` FAIL.

### 3. Stay with raw `Deno.serve` (don't adopt Hono)

**Reject** the Supabase blessed pattern's Hono wrapper for v1.0. The `WebStandardStreamableHTTPServerTransport` is framework-agnostic; Hono adds 50KB+ to the bundle and another version to track. Single POST + one GET liveness path doesn't justify the extra dep. Document the choice in `references/edge-deployment.md` § "Architecture choice" so future reviewers see the deliberate tilt.

If the function ever grows multi-route surface beyond MCP + health, Hono is the documented upgrade path.

### 4. Adopt `--no-verify-jwt` in the documented deploy command

**Change the documented deploy command** to `supabase functions deploy --no-verify-jwt mcp --project-ref <ref>`. Rationale: Supabase's gateway-side JWT verification is incompatible with the post-2025 asymmetric signing keys (per [Supabase byo-mcp guide](https://supabase.com/docs/guides/getting-started/byo-mcp) + [matt-fournier/supabase-mcp-template](https://github.com/matt-fournier/supabase-mcp-template)). The function reads the `Authorization` header itself; gateway verification is redundant and currently breaking.

Implication: the function URL is publicly invocable. The function refuses tool calls without a forwarded JWT in production deploys; consumers should ensure their agent host always sets `Authorization: Bearer <jwt>`. This is the same auth model in v1.0 as v0.x — the deploy command flag is the only change.

### 5. Edge Function consumes the published npm package, not the source tree

**Swap `supabase/functions/mcp/index.ts:12`** from:
```ts
import { makeServer } from "../../../src/server/server.ts";
```
to:
```ts
import { makeServer } from "supabase-realtime-skill/server";
```

with the import map entry in `deno.json`:
```json
"supabase-realtime-skill/server": "npm:supabase-realtime-skill@^0.2.0/server"
```

Three properties this resolves:
- The deployed function exercises the same code consumers install via `npm install supabase-realtime-skill` — no source-tree-vs-deployed drift.
- Operators don't need a `git clone` to deploy — `supabase functions deploy` against a fork or against a cloned-deploy-target works identically.
- Version stream is explicit: `^0.2.0` floors the package version; subsequent npm releases (0.3.0, 0.4.0, ...) require an explicit deno.json bump + redeploy.

The `^0.2.0` floor is set to the most recently published version. It implicitly carries the `^2.88.0` supabase-js peer floor declared in the package's own `package.json`; the deno.json's explicit `^2.105.1` pin overrides upward (Deno's npm compat dedupes to the explicit pin).

`deno cache index.ts` resolved cleanly after the swap; `deno check index.ts` passes.

### 6. Refresh `references/edge-deployment.md`

**Five changes** to bring the operator-facing reference page current:
- `"transport pending"` → `"ok"` (drift artifact predating commit `9abd676`).
- Deploy command now includes `--no-verify-jwt` with rationale paragraph.
- New "§ Architecture choice — raw `Deno.serve`" section documenting the Hono trade-off.
- New "§ Auth — JWT-forward-only (v1.0 contract)" section explicitly committing to JWT-forward-only as the v1.0 auth model. OAuth/discovery is v2.
- "§ Smoke test" section now references the full smoke suite (4 probes) with the canonical run command.

## Empirical refinement — what pre-fix probing surfaced that the recon didn't predict

The recon predicted a clean FAIL→PASS shape: pre-fix `broadcast_to_channel` should fail because `httpSend` doesn't exist at supabase-js@2.45.0. **It didn't.** The pre-fix smoke run at HEAD showed:

- `tools/list` (existing): PASS
- `GET /health` (existing): PASS
- `tools/call describe_table_changes` (new): initially FAIL with `INVALID_TABLE: table not found: support_tickets` — but the failure cause was *the host project's public schema being empty*, not a routing or DB connectivity issue. The recon assumed `support_tickets` was applied to the host project; a direct `information_schema.tables` query returned `[]`. Fix: refactor the smoke to use a `Date.now()`-suffixed table name and assert the structured `INVALID_TABLE` error envelope. After refactor: PASS.
- `tools/call broadcast_to_channel` (new): PASS, returning `{success: true}`. Anomaly relative to recon's prediction.

The broadcast anomaly has two candidate explanations and one outright unknown:

1. **Deployed bundle predates current deno.json.** The function may have last been deployed (and bundled) with a different supabase-js version. Edge Functions don't auto-redeploy on source change — the live runtime is whatever `supabase functions deploy` last published. `git log -p` against `supabase/functions/mcp/deno.json` shows the 2.45.0 pin landed in commit `2135168`; if the most recent deploy used a stale checkout, the deployed bundle could be on a newer version.
2. **Deno's npm compat resolution differs from what `deno.lock` reports.** The lock claims `realtime-js@2.10.2` (no `httpSend`); empirical behavior says `httpSend` works. There may be a layer of npm dedupe / resolution at Edge bundling that picks a different version than the lock claims.
3. **Unknown.** Without `supabase functions logs` for the deployed bundle's specific commit, we can't fully account for the gap.

This anomaly is *resolved by the post-fix redeploy*: once `deno.json` floors `^2.105.1` and the function is redeployed with `--no-verify-jwt` from the bumped `feat/edge-function-tool-routing` branch, the deployed bundle's supabase-js version is known. Going forward, the smoke test gates the floor — any regression below `^2.88.0`-equivalent surfaces as a `broadcast_to_channel` FAIL. The anomaly itself stays documented here as evidence that source-tree-vs-deployed alignment was loose pre-fix.

This is not a substrate-correctness ADR (no broken behavior to fix). It's a verification-coverage ADR with a source-tree-config alignment ride-along. The ADR-0011 / 0013 FAIL→fix→PASS pattern doesn't fit; the receipts are different.

## Falsifiable predicted effect

> **An external consumer of `supabase-realtime-skill@^0.2.0` who runs `supabase functions deploy --no-verify-jwt mcp` against a Pro project, then exercises JSON-RPC `tools/call` for `describe_table_changes` (against any table, valid or invalid) + `broadcast_to_channel` (against a public channel) on the deployed URL, observes both calls return non-error responses (or for `describe_table_changes` against a missing table, a structured `INVALID_TABLE` error wrapped in `isError: true`), with `broadcast_to_channel` returning `{success: true}` and the broadcast actually fanning out (verified by a separate `subscribe_to_channel` listener — not in this ADR's smoke).**

Properties:
- **Smoke-test-shaped.** Same shape as ADR-0011/0013 evidence; receipt is `tests/smoke/edge-deploy.smoke.test.ts` 4/4 PASS.
- **Falsifiable in five named directions:**
  - If `deno.json` regresses below supabase-js@2.75.0, `broadcast_to_channel` throws because `httpSend()` doesn't exist (substrate currency gap).
  - If the import in `index.ts` doesn't resolve under `npm:` after publish, the function fails to boot (deploy currency gap; deno cache catches this pre-deploy).
  - If `--no-verify-jwt` isn't set, post-2025 keys cause gateway rejection before our handler runs (auth flow gap).
  - If the agent's JWT isn't forwarded (or `setAuth` isn't called inside `makeServer`), `broadcast_to_channel` works for public channels but `private: true` calls fail at the `realtime.messages` policy (RLS gap; ADR-0011/0013 proven on the npm package, but not yet re-verified on Edge — out of scope for v1.0 unless smoke is extended).
  - If `WebStandardStreamableHTTPServerTransport` at MCP SDK 1.29.0 has a subtle regression vs 1.25.3 in tools/call routing, the transport returns -32601 ("Method not found") (SDK regression — low-confidence-but-real risk).
- **No new fixture corpus needed.** Same shape as the existing tools/list block, just extended.
- **Cost:** ~$3-5 for one Pro project + one Edge deploy + one smoke run. Not a manifest cell; not a fixture corpus.

## Implementation status

**Implemented in this PR (`feat/edge-function-tool-routing`):**
- `supabase/functions/mcp/deno.json` — supabase-js bump `2.45.0` → `^2.105.1`; `supabase-realtime-skill/server` import map entry pointing at `npm:supabase-realtime-skill@^0.2.0/server`. `deno.lock` regenerated.
- `supabase/functions/mcp/index.ts` — import swap from source tree to npm package. Comment updated to reflect the published-artifact contract.
- `tests/smoke/edge-deploy.smoke.test.ts` — two new `it()` blocks; helper `callJsonRpc` extracted to dedupe the JSON-RPC POST shape.
- `references/edge-deployment.md` — five edits per Decision 6.

**Pre-fix smoke receipt (current deployment, current host project state):**
- 4/4 PASS, 7.67s wall. Receipt captured 2026-05-02. See § "Empirical refinement" for the anomaly the receipt surfaced.

**Post-fix smoke receipt:**
- Pending operator redeploy. Once `supabase functions deploy --no-verify-jwt mcp --project-ref <ref>` lands with the bumped deno.json + npm-import-swap source, re-run the smoke. Expected: 4/4 PASS, with the deployed bundle's supabase-js version now matching `deno.lock`.

**Out of scope:**
- Extending smoke to `watch_table` (requires publication + INSERT during the smoke window — adds 30-60s wall time). Future ADR.
- Extending smoke to `subscribe_to_channel` end-to-end against a real broadcast (requires a separate sender). Future ADR.
- Re-verifying ADR-0011 / ADR-0013 substrate correctness on the deployed function (the npm package smoke covers this; Edge re-verification is a v2 hardening question).
- Bumping the MCP SDK pin (1.29.0 → latest stable). Supabase docs use 1.25.3; both ship `WebStandardStreamableHTTPServerTransport`. Worth a sanity check, not load-bearing for v1.0.

## Risks / Open questions

1. **`--no-verify-jwt` makes the function publicly invocable.** Anyone with the function URL can POST. The function's handler reads `Authorization` and refuses tool calls without a forwarded JWT in production; consumers must ensure agents set the header. v1.0 ships this; v2 may revisit if Supabase's "Auth support for MCP on Edge Functions is coming soon" lands.

2. **`npm:supabase-realtime-skill@^0.2.0/server` resolution under Deno's npm compat.** First post-deploy boot is the actual proof. `deno cache` resolved cleanly locally; `deno check` passes. The Edge runtime's npm compat may differ subtly — if so, the function fails to boot and the smoke fails fast.

3. **The "tool-routing pending" CLAUDE.md wording is documentation drift.** Once the post-fix PASS lands and the ADR is promoted, the CLAUDE.md status block needs to flip to "live-verified end-to-end including tools/call." Currency commit, mirrors `b5078a0` + `043cc75`.

4. **Source-tree-vs-deployed alignment is now binary.** Pre-fix: the function imported source directly, so any local change was effectively the deployed contract for whoever last ran `supabase functions deploy` from this checkout. Post-fix: the function imports `supabase-realtime-skill@^0.2.0`. If we want to ship a behavior change, we publish a new npm version and bump the deno.json caret. This is correct (alignment) but constrains dev velocity — every Edge-affecting change is now an npm release. Acceptable for v1.0; flag if it bites.

5. **The empirical anomaly (broadcast working at "claimed 2.45.0") stays unexplained at filing time.** The post-fix redeploy resolves the practical impact (deployed version is known + smoke gates the floor going forward), but the *why* of the anomaly is not closed. Future investigation if it bites — most likely candidate is "deployed bundle predates current deno.json checkout."

6. **The smoke's `broadcast_to_channel` probe doesn't verify fan-out** — it asserts the sender returns `{success: true}` but doesn't subscribe a listener to confirm receipt. ADR-0013's "silent RLS denial" failure mode (REST returns 202, row dropped, no error) means a public channel send can succeed at the wire even if Realtime drops it server-side. The smoke is a tool-routing gate, not a fan-out gate. Out of scope; future ADR if needed.

## References

**Internal:**
- [`docs/recon/2026-05-02-edge-function-tool-routing-recon.md`](../recon/2026-05-02-edge-function-tool-routing-recon.md) — pre-ADR research; 6 explicit decisions committed on above.
- [`docs/decisions/0011-multi-tenant-rls-baseline.md`](0011-multi-tenant-rls-baseline.md) — substrate-correctness FAIL→fix→PASS pattern; this ADR diverges (verification-coverage shape).
- [`docs/decisions/0013-private-channel-broadcast-authorization.md`](0013-private-channel-broadcast-authorization.md) — `^2.88.0` floor pin; this ADR raises the deno.json deploy-side ceiling without changing the package floor.
- [`docs/decisions/0014-worked-example-ship.md`](0014-worked-example-ship.md) — npm `0.2.0` version stream; this ADR consumes it via the deno.json import map.
- [`src/server/server.ts:188-247`](../../src/server/server.ts) — the actually-wired `CallToolRequestSchema` switch.
- [`supabase/functions/mcp/index.ts`](../../supabase/functions/mcp/index.ts) — Edge Function entry; npm-import-swap target.
- [`supabase/functions/mcp/deno.json`](../../supabase/functions/mcp/deno.json) — the bump landing zone.
- [`tests/smoke/edge-deploy.smoke.test.ts`](../../tests/smoke/edge-deploy.smoke.test.ts) — extended smoke; 4/4 PASS pre-fix.
- [`references/edge-deployment.md`](../../references/edge-deployment.md) — operator-facing reference; refreshed.

**External:**
- [Supabase Docs — Deploy MCP servers](https://supabase.com/docs/guides/getting-started/byo-mcp) — the blessed pattern (Hono + `--no-verify-jwt`).
- [matt-fournier/supabase-mcp-template](https://github.com/matt-fournier/supabase-mcp-template) — community template; `--no-verify-jwt` rationale.
- [MCP TypeScript SDK — WebStandardStreamableHTTPServerTransport](https://ts.sdk.modelcontextprotocol.io/v2/classes/_modelcontextprotocol_server.server_streamableHttp.WebStandardStreamableHTTPServerTransport.html) — runtime-portable transport contract.
- [supabase-js#1937](https://github.com/supabase/supabase-js/pull/1937) — empty-Authorization fix at 2.88.0; deno.json bump pulls this in.
- [supabase-js#1599](https://github.com/supabase/supabase-js/issues/1599) + [PR #2029](https://github.com/supabase/supabase-js/pull/2029) — premature-SUBSCRIBED bug; **PR #2029 is OPEN as of 2026-05-02, not merged at any 2.x version**. T7 5s warm-up workaround stays load-bearing on Edge.
