# Changelog

All notable changes to `supabase-realtime-skill`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
follows [SemVer](https://semver.org/) on the npm package surface
(`./` and `./server` exports). Substrate-correctness ADRs that don't
change the published surface ship within the same minor.

## [0.3.0] — 2026-05-03

The "E2E smoke surface" release. Closes the four sub-items ADR-0015 deferred:
end-to-end smoke coverage of `watch_table` + `subscribe_to_channel` against the
deployed Edge Function, an MCP SDK floor regression gate, and the warm-up
distribution spike that backs the smoke wall budgets. **No consumer-API
changes from `0.2.0`** — additive substrate work + dependency-floor tightening
on the dev/runtime side.

Per ADR-0016 recon Decision 4: "v1.0.0 = both [smoke surface + manifest n=300]
shipped within the same calendar week, otherwise the smoke PR is `0.3.0` and
v1.0.0 stays unclaimed." Manifest n=300 is deferred to ADR-0017; this release
is `0.3.0` accordingly.

### Added

- **`watch_table` E2E smoke** (`tests/smoke/edge-deploy.smoke.test.ts`) — applies the GRANT + RLS chain on a freshly-published table, dispatches `tools/call watch_table`, fires multi-INSERT schedule (+100ms / +5s / +10s), asserts populated `event.new` payload. 12s wall budget (1.5× the spike's 5.3s p99). ADR-0016.
- **`subscribe_to_channel` E2E smoke** — opens a broadcast channel via the deployed function, an external `createClient` instance fires three broadcasts (+500ms / +3s / +6s), asserts the receiver got at least one with `payload.from === "external-sender"`. 10s wall budget. ADR-0016.
- **MCP SDK floor regression gate** (`tests/fast/sdk-floor.test.ts`) — reads the resolved `@modelcontextprotocol/sdk` version, fails the fast-test gate if it drops below `1.27.1` (the version that landed [PR #1580](https://github.com/modelcontextprotocol/typescript-sdk/pull/1580) — the `WebStandardStreamableHTTPServerTransport.onerror` fix). Mechanical but load-bearing: existing smokes don't deliberately fault the transport, so without this a regex regression in `package.json` could silently re-enable error-swallowing. ADR-0016.
- **Edge warm-up distribution spike** (`eval/spike-edge-warmup.ts`) — 20-trial measurement of the cold-start handshake on the deployed function. Drives the smoke wall-budget choice and pinned the GRANT + RLS chain root cause. JSON logs committed under `logs/spike-edge-warmup/`. ADR-0016.
- **Edge payload diagnostic probe** (`eval/probe-edge-payload.ts`) — five-variant matrix (auth × GRANT × RLS) that pinned why anon-JWT subscriptions deliver `new: null/empty` without the chain. Trail-of-evidence; not a regression gate.
- **Smoke receipt provenance** (`logs/smoke-edge-deploy/`) — committed vitest output for ADR-promotion smoke runs (mirrors the spike-latency + spike-edge-warmup pattern). The receipts cited in ADR-0016 are no longer ephemeral.

### Changed

- **`@modelcontextprotocol/sdk` floor `^1.0.0` → `^1.27.1`** in `package.json` (landed in `0.2.x` cycle via PR #18 / ADR-0016). 1.27.1 carries the WebStandardStreamableHTTPServerTransport `onerror` fix (PR #1580). Without this, transport-layer errors in the deployed function get silently swallowed instead of bubbling to the JSON-RPC error envelope.
- **`tests/smoke/edge-deploy.smoke.test.ts`** — `watch_table` smoke now logs `delivered_n=N` alongside wall time so an operator scanning CI output can spot warm-up window drift (if `n=2` becomes habitual instead of `n=0`/`n=1`, the budget needs a fresh spike).

### Operator follow-up

- **Edge Function redeploy after this tag publishes.** `supabase/functions/mcp/deno.json` still pins `npm:supabase-realtime-skill@^0.2.0/server` — that's deliberate (the `0.3.0` version doesn't exist on npm until this tag triggers the publish workflow). Post-publish, bump the `deno.json` import range to `^0.3.0`, regen `deno.lock` (`cd supabase/functions/mcp && rm -f deno.lock && deno cache --reload index.ts`), and run `SUPABASE_ACCESS_TOKEN=$EVAL_SUPABASE_PAT supabase functions deploy --no-verify-jwt mcp --project-ref $EVAL_HOST_PROJECT_REF`. Source-tree-vs-deployed alignment stays intact (ADR-0015) — the function continues running `0.2.x` until the redeploy lands.

## [0.2.0] — 2026-05-02

The "worked example ships" release. Bundles the demo migration that
backs `references/multi-tenant-rls.md`, the additive `private` flag
threaded through `boundedQueueDrain`, and the substrate-correctness
fixes from ADRs 0011 + 0013.

### Added

- **Demo migration** (`supabase/migrations/20260502000001_multi_tenant_audit_demo.sql`) — `audit_events` + `memberships` tables, `public.user_tenant_ids()` SECURITY DEFINER STABLE helper, two `realtime.messages` RLS policies (subscribe-time + send-time gates). Apply with `supabase db push` to instantiate the multi-tenant audit-log worked example end-to-end. ADR-0014.
- **`boundedQueueDrain` `private?: boolean` parameter** (`src/server/queue-drain.ts`). Threads through to `handleBroadcast`'s broadcast leg. Default `false` preserves v0.1.x behavior. The forward leg of a tenant-scoped audit log → tenant-private channel composition is the canonical use case. ADR-0014.
- **`private?: boolean` on `BroadcastInput` + `SubscribeChannelInput`** (`src/types/schemas.ts`). Defaults to `false`; when `true`, the substrate constructs the channel with `config: { private: true }` so `realtime.messages` policies are evaluated. ADR-0013.
- **`makeProductionBroadcastSender` factory** (`src/server/server.ts`). Wraps the production supabase client with `httpSend()` semantics; `try/catch`-shaped per the runtime contract documented in ADR-0013 (the typed `success: false` branch is unreachable at runtime).
- **`references/multi-tenant-rls.md`** — operator deep dive on the two RLS layers, canonical policies, silent-filtering failure mode, scaling story. ADR-0012.
- **CHANGELOG.md** — this file. First version.

### Changed

- **`@supabase/supabase-js` floor `^2.45.0` → `^2.88.0`**. 2.88.0 (Dec 16 2025) carries `httpSend()` (added 2.75.0, Oct 2025) and the empty-Authorization-header REST fix ([supabase-js#1937](https://github.com/supabase/supabase-js/pull/1937)). Caret range is semver-equivalent to the `>=2.88.0 <3.0.0` bracket ADR-0014 commits on; ADR-0014 § "supabase-js floor" carries the rationale for not arbitrarily bumping to the latest 2.x. ADR-0013 / ADR-0014.
- **JWT propagation through to the Realtime websocket** (`src/server/realtime-client.ts`). `setAuth(authToken)` is now called on both `makeSupabaseAdapter` (Postgres-Changes leg) and `makeSupabaseBroadcastAdapter` (Broadcast leg) after `createClient`. Without this, `supabase-js`'s default `_getAccessToken` falls back to the anon key for the websocket, even when `global.headers.Authorization` is set. RLS on Postgres-Changes silently evaluated against `anon` claims_role pre-fix. ADR-0011.
- **Broadcast send migrated to `httpSend()`** (`src/server/server.ts`). Saves one websocket subscribe roundtrip and silences `supabase-js`'s deprecation warning on the implicit `send()`-falls-back-to-REST path. Wrapper is `try/catch`-shaped per the runtime contract. ADR-0013.

### Fixed

- **Cross-tenant broadcast injection on private channels** (silent until ADR-0013). Pre-fix: the substrate accepted broadcast sends to any channel name regardless of JWT membership because the channel was constructed without `private: true`, skipping `realtime.messages` RLS. Post-fix: `realtime.messages` INSERT policy gates the send when callers opt in via `private: true`. ADR-0013.
- **Cross-tenant Postgres-Changes leakage under forwarded JWT** (silent until ADR-0011). Pre-fix: even with `global.headers.Authorization` set to the user's JWT, the websocket evaluated against the anon key, and table RLS effectively didn't apply. Post-fix: `setAuth(jwt)` aligns the websocket with the forwarded JWT identity. ADR-0011.

### Deferred

- **`cross_tenant_leakage_rate_max` manifest cell.** ADR-0014 § "Manifest cell" defers on substrate-vs-composition (ADR-0012 § 2) + proxy-gap grounds. Substrate-correctness ships with smoke-test receipts (ADRs 0011 + 0013); fixture-driven gates need a hand-curated adversarial corpus that LLM augmentation likely doesn't produce at fixture scale (one scenario × 100, not 100 scenarios). Future ADR can revisit.

## [0.1.1] — 2026-05-01

Patch. Internal cleanup; no consumer-visible changes.

## [0.1.0] — 2026-05-01

Initial release. Five MCP tools (`watch_table`, `broadcast_to_channel`, `subscribe_to_channel`, `list_channels`, `describe_table_changes`) + `boundedQueueDrain` deterministic module + bundled eval harness (n=100 ci-full at 99/100 action_correctness on Sonnet 4.6). Edge Function deployed via OIDC Trusted Publisher. ADRs 0001–0010.

[0.3.0]: https://github.com/0xquinto/supabase-realtime-skill/releases/tag/v0.3.0
[0.2.0]: https://github.com/0xquinto/supabase-realtime-skill/releases/tag/v0.2.0
[0.1.1]: https://github.com/0xquinto/supabase-realtime-skill/releases/tag/v0.1.1
[0.1.0]: https://github.com/0xquinto/supabase-realtime-skill/releases/tag/v0.1.0
