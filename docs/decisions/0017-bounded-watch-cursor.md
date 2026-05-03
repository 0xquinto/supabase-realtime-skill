# ADR 0017: bounded-watch persistent cursor — restart-safe at-least-once with idempotency-key dedup

**Date:** 2026-05-03
**Status:** Proposed (unit-level FAIL→PASS captured in PR #30 — `a06b49b` 24/24 RED → `831d5f3` 24/24 GREEN; substrate-level GREEN captured in this PR — `tests/smoke/cursor-restart.smoke.test.ts` 3/3 PASS in 10.97s against real host Postgres, see [`logs/smoke-cursor-restart/2026-05-03-pr-cursor-postgres-adapter.txt`](../../logs/smoke-cursor-restart/2026-05-03-pr-cursor-postgres-adapter.txt). Awaiting operator review for Accepted promotion.)
**Recommender:** Claude Opus 4.7 (assistant)
**Decider:** Diego Gomez (will promote to Accepted after operator review of this PR)

## Context

The current `boundedWatch` (`src/server/realtime-client.ts`) handles substrate gotchas correctly (RLS payload stripping, warm-up window, private-channel auth, single-client dedup, GRANT chain) but is **stateless**: an isolate restart loses queue state, and any side effects already applied by a user's action callback are at risk of re-application or loss.

The recon at [`docs/recon/2026-05-03-bounded-watch-as-tool-recon.md`](../recon/2026-05-03-bounded-watch-as-tool-recon.md) identified persistent state as the load-bearing engineering ship that elevates `boundedWatch` from "demo-shape wrapper" to "deterministic agent tool." Five decision-forks were resolved with citations from CDC, durable-execution, MCP-spec, and competitor literature; the counter-recon cleared with one architectural carve-out (R4 → next-ADR Phase 2 deferral) and accepted constraints (R1/R2/R3/R5).

This ADR commits Phase 1: the cursor state machine + persistence contract.

## What this ADR proposes

### 1. Cursor row shape

```ts
{
  watcher_id: string,           // operator-chosen, stable across restarts
  last_processed_pk: string,    // monotonic; serialized JSON for composite PKs
  last_processed_at: string,    // ISO 8601; commit-timestamp from Realtime payload
  idempotency_key: string,      // most-recent committed key — for dedup on retry
  status: 'idle' | 'leased' | 'committed' | 'dlq',
  lease_holder: string | null,  // isolate identifier; null when idle
  heartbeat_at: string | null,  // ISO 8601; null when idle
  lease_expires_at: string | null,  // ISO 8601; null when idle
  attempts: number,             // current-event retry count; resets on commit
}
```

Rationale: vocabulary adopts Debezium's "offset-after-commit" pattern (recon Fork 1). Idempotency key is computed by the user's action contract `dedupKey: (row) => string` callback; the cursor stores the most-recently-committed value to dedup retries that arrive after a successful commit but before the lease releases.

### 2. State machine

States: `idle → leased → committed | dlq`. Lease is the soft-lock; commit is the cursor-advance event; dlq is the terminal failure state.

Transitions (the state machine the test scaffold codifies):

- **`acquire(watcher_id, lease_holder, lease_ttl_ms)`** → `leased`
  - From `idle`: succeeds; sets `lease_holder`, `heartbeat_at = now()`, `lease_expires_at = now() + ttl`.
  - From `leased` by same holder: idempotent renewal; updates `heartbeat_at`, `lease_expires_at`.
  - From `leased` by different holder where `lease_expires_at > now()`: fails (`{ acquired: false }`).
  - From `leased` by different holder where `lease_expires_at <= now()`: succeeds (steals expired lease).
  - From `dlq`: fails (terminal state; operator must reset).

- **`heartbeat(watcher_id, lease_holder)`** → `leased`
  - Same-holder: refreshes `heartbeat_at`, `lease_expires_at`.
  - Different-holder or no-lease: fails (`{ ok: false }`).

- **`commit(watcher_id, lease_holder, advance)`** → `committed`
  - Same-holder, monotonic `last_processed_pk`: succeeds; advances cursor; resets `attempts` to 0.
  - Same-holder, same `idempotency_key` as current cursor row: succeeds with `{ deduped: true }`, no advance.
  - Same-holder, non-monotonic `last_processed_pk` (regression): fails (`{ ok: false, reason: 'non_monotonic' }`).
  - Different-holder or no-lease: fails.
  - **Cursor advance is atomic with status flip to `committed`** — RisingWave#25071 lesson, no time-based commit.

- **`release(watcher_id, lease_holder, status, reason?)`** → `idle | dlq`
  - Same-holder: succeeds; clears `lease_holder`, `heartbeat_at`, `lease_expires_at`; sets `status` to `idle` or `dlq`.
  - Different-holder: fails.

### 3. Persistence contract (the seam)

```ts
interface CursorStore {
  read(watcher_id: string): Promise<CursorRow | null>
  acquire(watcher_id: string, lease_holder: string, lease_ttl_ms: number): Promise<{ acquired: boolean; row: CursorRow }>
  heartbeat(watcher_id: string, lease_holder: string): Promise<{ ok: boolean }>
  commit(watcher_id: string, lease_holder: string, advance: { last_processed_pk: string; last_processed_at: string; idempotency_key: string }): Promise<{ ok: boolean; deduped: boolean; reason?: string }>
  release(watcher_id: string, lease_holder: string, status: 'idle' | 'dlq', reason?: string): Promise<{ ok: boolean }>
}
```

Two implementations ship together:
- **`makeInMemoryCursorStore()`** — for fast tests; pure JS Map; no DB dependency. Fake clock injectable for lease-expiry tests.
- **`makePostgresCursorStore({ client, table })`** — for production; backed by a `realtime_skill_cursors` table; uses `SELECT … FOR UPDATE SKIP LOCKED` for `acquire` to avoid conflict storms when multiple isolates try to steal expired leases.

The fast test suite (this PR's scaffold) targets the in-memory implementation. The Postgres implementation lands with its own restart smoke test in the next PR.

### 4. Migration shape (cursor → SDK boundary)

> **As-shipped semantics differ — see § 5 "Why batch-shape, not per-event" amendment for the integration that landed in PR #32.** Per-event commit (originally drafted in this section) requires the action contract layer; the cursor wires into `boundedWatch` at batch-shape granularity instead.

`boundedWatch` gains an optional `cursor?: BoundedWatchCursorConfig` parameter where:
```ts
interface BoundedWatchCursorConfig {
  store: CursorStore;
  watcher_id: string;
  lease_holder: string;          // unique per isolate; caller supplies
  lease_ttl_ms?: number;         // default 30_000
  heartbeat_interval_ms?: number;  // default lease_ttl_ms / 3, floor 1s
  pkExtractor: (event: ChangeEvent) => string;
  idempotencyExtractor?: (event: ChangeEvent) => string;  // defaults to pkExtractor
}
```

When omitted, behavior is unchanged (current stateless mode). When supplied (**batch-shape integration as shipped — see § "Why batch-shape, not per-event" below**):

- Before subscribe: `acquire` lease; if busy or `dlq`, throw `BoundedWatchCursorError({ code: "CURSOR_BUSY" | "CURSOR_DLQ" })`.
- During event collection: events whose `pkExtractor(ev) <= cursor.last_processed_pk` are filtered out (defensive against substrate replay during reconnect).
- During event collection: a heartbeat timer fires `store.heartbeat(watcher_id, lease_holder)` at `heartbeat_interval_ms` cadence so a long-running call (`timeout_ms > lease_ttl_ms`) doesn't lose its lease mid-flight. Heartbeat failures are silenced — commit will surface a real `wrong_holder` if the lease was actually lost.
- On `subscribe` failure: `release('dlq', "subscribe_failed")` then re-throw. If `release` itself throws, the original subscribe error wins (best-effort release).
- On graceful exit (max_events / timeout): if events were collected, find the lexicographically-highest PK among them, `commit({ last_processed_pk, last_processed_at, idempotency_key })`. Then `release('idle')`. If no events, no commit (cursor unchanged); `release('idle')`.
- On commit returning `{ ok: false, reason }`: throw `BoundedWatchCursorError({ code: "CURSOR_COMMIT_FAILED", reason })` AFTER best-effort `release('idle')`. The lease never leaks; commit failure is visible to the caller.

Backward compat: callers that don't pass `cursor` are unaffected. v0.3.x bytes continue to work as today.

**Error envelope:**
- `CURSOR_BUSY` — different holder owns an unexpired lease. Caller can back off and retry.
- `CURSOR_DLQ` — terminal failure state on the cursor. Operator must inspect + manually reset.
- `CURSOR_COMMIT_FAILED` — commit returned `!ok`; `reason` carries `non_monotonic | wrong_holder | no_lease | dlq_terminal`. Lease has been released best-effort; caller surfaces to its action contract.

### 5. Why batch-shape, not per-event (amendment 2026-05-03)

The original migration shape above mentioned "per-event commit" semantics: invoke a user action callback per event, commit on success, retry / DLQ on failure. **That requires a user action callback, which `boundedWatch` does not currently have** — `boundedWatch` is a batch collector ("give me up to N events in T seconds, return the batch"). Per-event semantics presuppose the action contract layer (a separate ADR after 0017).

This PR ships **batch-shape integration**: cursor advances at the end of `boundedWatch`'s call (not per event). Semantics:
- Restart-safe at the batch boundary: caller invokes `boundedWatch({ cursor })` repeatedly; each call resumes where the previous one left off (skipping any substrate-replayed events).
- At-most-once *delivery* to the caller (caller's batch is what was committed); at-least-seen *advance* (cursor records the high-water mark of what was returned).
- Soft-lock with heartbeat: an in-flight `boundedWatch` extends its lease at `heartbeat_interval_ms` cadence (default `lease_ttl_ms / 3`, floor 1s), so a long `timeout_ms` doesn't drop the lease mid-call. The lease is still time-bounded — if the isolate dies, the lease expires and another holder can steal it (preserving `last_processed_pk`).
- Tightly-coupled commit + release: commit and release are paired in an inner `try/finally` so the lease is always released, even if commit throws or returns `!ok`. A `CURSOR_COMMIT_FAILED` error then surfaces to the caller — the lease never leaks past the call.

The per-event commit shape (with the action contract) lands in a follow-up ADR. The cursor row schema + state machine + persistence contract are unchanged between batch-shape and per-event-shape; the call-site integration is the only thing that differs.

Operators who want per-event commit semantics today can call `boundedWatch({ cursor })` with `max_events: 1` in a loop — each iteration commits the one event seen. That's the forward-compatible shim until the action contract ships.

## Predicted effect

The FAIL→PASS test discipline (per ADR-0011 / 0013) commits to:

**FAIL receipt (commit `a06b49b`, 2026-05-03 ~10:00 PT):**
- `tests/fast/cursor.test.ts` — state-machine test suite (24 cases across 6 describe blocks: read, acquire, heartbeat, commit, release, restart-resume) referencing `makeInMemoryCursorStore()`. Impl was stub (throws `ADR-0017 cursor impl not yet shipped`). **Captured: 24/24 FAIL with that error at `bun run test:fast`.** 50 pre-existing fast tests + typecheck + lint all PASS — no regression.

**PASS receipt (this same PR, 2026-05-03 ~10:08 PT):**
- Same test file, ZERO test changes; `makeInMemoryCursorStore()` impl shipped. **Captured: 74/74 fast tests PASS (50 pre-existing + 24 cursor cases).** Typecheck PASS, lint PASS, total wall ~1.43s. The same code path that emitted "ADR-0017 cursor impl not yet shipped" 24 times now emits 24 green checks — only the impl swapped between RED and GREEN.

**Substrate-level PASS receipt (this PR, 2026-05-03 ~10:23 PT):**
- `tests/smoke/cursor-restart.smoke.test.ts` against the host project's Postgres. Three cases, **3/3 PASS in 10.97s**:
  - "preserves cursor state across an expired-lease takeover (the headline)" — H1 commits 3 events with TTL=1s, lease expires, H2 acquires (steals), reads `last_processed_pk = "pk-003"` (preserved across simulated restart), non-monotonic commit rejected, H2 advances normally, final state correct.
  - "dedups idempotency_key replay across an expired-lease takeover" — H1 commits k-A, expires, H2 takes over, replays k-A → `deduped: true` no advance. The at-least-once recovery story validated against real Postgres.
  - "denies a fresh holder when lease is still valid" — H1 holds 30s lease, H2 acquire returns `acquired: false` with H1 still on the row.
- Receipt at [`logs/smoke-cursor-restart/2026-05-03-pr-cursor-postgres-adapter.txt`](../../logs/smoke-cursor-restart/2026-05-03-pr-cursor-postgres-adapter.txt).

The in-memory FAIL→PASS pair (PR #30) validates the state-machine logic at the unit level; the Postgres restart-smoke pair (this PR) validates it at the substrate level. Both are GREEN with no design amendments needed. ADR-0017 promotes to Accepted on operator review.

## Cost ceiling

- **PR #30 (in-memory):** ~1.5h wall. ADR + types + stub + 24-case scaffold + in-memory impl + FAIL→PASS receipts in single round-trip.
- **This PR (Postgres + restart smoke):** ~1.5h wall + $0 in branch provisioning (smoke uses host project, no `withBranch`). Migration + Postgres adapter + `tests/smoke/cursor-restart.smoke.test.ts` (3/3 PASS, 10.97s).
- **Original estimates** in PR #30: ~half-day for in-memory + ~1.5 days for Postgres. Actual: ~3h total. The state machine was tight enough that both implementations were direct translations from the design.

Action contract (the next ADR after 0017) and multi-watcher isolate-budget bench are separate ships. Threading `cursor` into `boundedWatch`'s subscription loop is its own PR (the ADR explicitly defers).

## Out of scope (and why)

- **Action contract typing** (`(event) => Promise<Result>` with `dedupKey` / `onError` / `observe`). Logically related but separable; the cursor underpins the contract, not the other way around. Filed for a follow-up ADR.
- **Multi-watcher isolate-budget bench.** Requires the action contract layer to be runnable; sequenced after that.
- **Postgres-Changes-specific behavior on restart** (e.g., what events does Realtime replay vs. lose during isolate downtime). The cursor handles "what we already committed"; the substrate behavior on reconnect is ADR-0011's territory and stays there.
- **Multi-tenant cursor isolation** — `watcher_id` is operator-chosen and assumed unique per tenant; cross-tenant cursor sharing is operator error, not a substrate-correctness concern. Document but don't enforce.
- **Phase 2 MCP `resources/subscribe` alignment** — recon Fork 3 deferred to the next ADR after this one.

## What this ADR doesn't do

- **Doesn't wire the cursor into `boundedWatch` yet.** `CursorStore` is a standalone primitive; threading the optional `cursor?: { store, watcher_id, lease_ttl_ms }` parameter into `boundedWatch`'s subscription loop is the next PR.
- **Doesn't change `boundedWatch`'s default behavior.** `cursor` is opt-in; v0.3.x consumers see no API surface change.
- **Doesn't bench multi-watcher isolate budget.** Separate ship after action contract.

## Status discipline

Filed **Proposed**. Both promotion gates have produced GREEN receipts:
- (a) Unit-level: PR #30 captured 24/24 RED (`a06b49b`) → 24/24 GREEN (`831d5f3`).
- (b) Substrate-level: this PR captured 3/3 GREEN against real host Postgres (10.97s wall).

Awaiting operator (Diego) review of both PRs to promote to `Accepted`. Per CLAUDE.md § "ADR status discipline" — no momentum-based acceptance, even when both predicted receipts land.

## Back-refs

- [`docs/recon/2026-05-03-bounded-watch-as-tool-recon.md`](../recon/2026-05-03-bounded-watch-as-tool-recon.md) — design forks resolved. Fork 1 (cursor vocab + delivery semantics) is the direct predecessor of this ADR's § "Cursor row shape" + "State machine."
- [`docs/recon/2026-05-03-bounded-watch-as-tool-counter-recon.md`](../recon/2026-05-03-bounded-watch-as-tool-counter-recon.md) — adversarial pass that cleared this direction with R4 carve-out (Phase 2 deferral) and R5 constraint (post-framing — primitive headline, framing in body).
- [ADR-0011](0011-jwt-setauth-propagation.md), [ADR-0013](0013-private-channel-broadcast-authorization.md) — the FAIL→fix→PASS smoke-test discipline shape this ADR adopts.
- [RisingWave#25071](https://github.com/risingwavelabs/risingwave/issues/25071) — concrete failure mode (offset advance without consumer-checkpoint) the "cursor advance atomic with commit" rule directly mitigates.
- [Debezium / Kafka consumer offset-commit pattern](https://risingwave.com/blog/cdc-exactly-once-semantics-debezium-risingwave/) — vocabulary and at-least-once + idempotency-key model adopted.
- [ADR-0010](0010-bounded-queue-drain.md) — `boundedQueueDrain` shipped at-least-once semantics with operator-supplied idempotency in v0.2.0; this ADR generalizes that pattern to the watch primitive itself.
