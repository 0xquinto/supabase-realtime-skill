# Changelog

All notable changes to `supabase-realtime-skill`. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
follows [SemVer](https://semver.org/) on the npm package surface
(`./` and `./server` exports). Substrate-correctness ADRs that don't
change the published surface ship within the same minor.

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

Initial release. Five MCP tools (`watch_table`, `broadcast_to_channel`, `subscribe_to_channel`, `list_channels`, `describe_table`) + `boundedQueueDrain` deterministic module + bundled eval harness (n=100 ci-full at 99/100 action_correctness on Sonnet 4.6). Edge Function deployed via OIDC Trusted Publisher. ADRs 0001–0010.

[0.2.0]: https://github.com/0xquinto/supabase-realtime-skill/releases/tag/v0.2.0
[0.1.1]: https://github.com/0xquinto/supabase-realtime-skill/releases/tag/v0.1.1
[0.1.0]: https://github.com/0xquinto/supabase-realtime-skill/releases/tag/v0.1.0
