# ADR 0017: bounded-watch persistent cursor — restart-safe at-least-once with idempotency-key dedup

**Date:** 2026-05-03
**Status:** Proposed (design locked from [recon 2026-05-03](../recon/2026-05-03-bounded-watch-as-tool-recon.md); FAIL test scaffold lands with this ADR; impl + PASS receipts ship in subsequent PR)
**Recommender:** Claude Opus 4.7 (assistant)
**Decider:** Diego Gomez (will accept after the cursor impl produces FAIL→PASS receipts on the test scaffold)

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

`boundedWatch` gains an optional `cursor?: { store: CursorStore; watcher_id: string; lease_ttl_ms?: number }` parameter. When omitted, behavior is unchanged (current stateless mode). When supplied:

- Before subscribe: `acquire` lease; if not acquired, throw `ToolError('CURSOR_BUSY')`.
- During each event: heartbeat every `heartbeat_interval_ms` (default `lease_ttl_ms / 3`).
- Per event delivered to user action: invoke action; on success, `commit(advance)`; on failure, `attempts++`; if `attempts >= max_attempts`, `release('dlq', reason)`.
- On graceful shutdown / `unsubscribe`: `release('idle')`.

Backward compat: callers that don't pass `cursor` are unaffected. v0.3.x bytes continue to work as today.

## Predicted effect

The FAIL→PASS test discipline (per ADR-0011 / 0013) commits to:

**Predicted FAIL (this PR — captured at filing):**
- `tests/fast/cursor.test.ts` — state-machine test suite (24 cases across 6 describe blocks: read, acquire, heartbeat, commit, release, restart-resume) referencing `makeInMemoryCursorStore()`. Impl is stub (throws `ADR-0017 cursor impl not yet shipped`). **Captured: 24/24 FAIL with that error at `bun run test:fast` on this branch.** Other 50 fast tests + typecheck + lint all PASS — no regression. This is the RED state.

**Predicted PASS (next PR):**
- Same test file, no test changes; `makeInMemoryCursorStore()` impl lands. Expected: 24/24 cases pass. Same code path between FAIL and PASS — only the impl swap.

**Predicted PASS (next-after-next PR):**
- New `tests/smoke/cursor-restart.smoke.test.ts` against a real Pro branch. Spawns a watcher with `cursor` supplied; injects 5 INSERTs; kills the simulated isolate after the 3rd commit; reacquires from a fresh isolate; injects 2 more INSERTs; verifies the user's action callback received exactly 5 distinct events (no duplicates, no gaps), and the cursor row's `last_processed_pk` is the 5th INSERT's PK.

If the predicted-FAIL test scaffold doesn't actually fail at scaffold-time, that's a leak (impl prematurely satisfies — likely indicates the test suite isn't asserting tight enough). If the predicted-PASS doesn't pass at impl-time, the cursor design is wrong and this ADR retracts (Status changes to `Rejected` with the discovery as the rationale).

## Cost ceiling

- **This PR:** ~half day. ADR + types + stub + ~25-case test scaffold confirmed RED. No infrastructure required.
- **Next PR (in-memory PASS):** ~1 day. Pure-TS state machine impl + fast tests green.
- **Next-after-next PR (Postgres + restart smoke):** ~1.5 days + ~$0.10 in branch provisioning. Migration for `realtime_skill_cursors` + Postgres adapter + restart smoke test.

Total: ~3-3.5 days for the cursor layer. Action contract (the next ADR after 0017) and multi-watcher isolate-budget bench are separate ships.

## Out of scope (and why)

- **Action contract typing** (`(event) => Promise<Result>` with `dedupKey` / `onError` / `observe`). Logically related but separable; the cursor underpins the contract, not the other way around. Filed for a follow-up ADR.
- **Multi-watcher isolate-budget bench.** Requires the action contract layer to be runnable; sequenced after that.
- **Postgres-Changes-specific behavior on restart** (e.g., what events does Realtime replay vs. lose during isolate downtime). The cursor handles "what we already committed"; the substrate behavior on reconnect is ADR-0011's territory and stays there.
- **Multi-tenant cursor isolation** — `watcher_id` is operator-chosen and assumed unique per tenant; cross-tenant cursor sharing is operator error, not a substrate-correctness concern. Document but don't enforce.
- **Phase 2 MCP `resources/subscribe` alignment** — recon Fork 3 deferred to the next ADR after this one.

## What this ADR doesn't do

- **Doesn't ship the impl.** Only types + stub + RED test scaffold. The PR after this one ships in-memory impl (PASS).
- **Doesn't change `boundedWatch`'s default behavior.** `cursor` is opt-in; v0.3.x consumers see no API surface change.
- **Doesn't promise the design holds.** The point of FAIL→PASS receipts is that the design is falsifiable. If the in-memory impl can't satisfy the 25 test cases without semantic compromise, the cursor row shape or state machine is wrong and this ADR retracts.

## Status discipline

Filed **Proposed**. Promotion to `Accepted` happens only after: (a) the in-memory impl PR produces a 25/25 PASS receipt, and (b) the operator (Diego) has reviewed both this ADR and the impl PR. Per CLAUDE.md § "ADR status discipline" — no momentum-based acceptance.

## Back-refs

- [`docs/recon/2026-05-03-bounded-watch-as-tool-recon.md`](../recon/2026-05-03-bounded-watch-as-tool-recon.md) — design forks resolved. Fork 1 (cursor vocab + delivery semantics) is the direct predecessor of this ADR's § "Cursor row shape" + "State machine."
- [`docs/recon/2026-05-03-bounded-watch-as-tool-counter-recon.md`](../recon/2026-05-03-bounded-watch-as-tool-counter-recon.md) — adversarial pass that cleared this direction with R4 carve-out (Phase 2 deferral) and R5 constraint (post-framing — primitive headline, framing in body).
- [ADR-0011](0011-jwt-setauth-propagation.md), [ADR-0013](0013-private-channel-broadcast-authorization.md) — the FAIL→fix→PASS smoke-test discipline shape this ADR adopts.
- [RisingWave#25071](https://github.com/risingwavelabs/risingwave/issues/25071) — concrete failure mode (offset advance without consumer-checkpoint) the "cursor advance atomic with commit" rule directly mitigates.
- [Debezium / Kafka consumer offset-commit pattern](https://risingwave.com/blog/cdc-exactly-once-semantics-debezium-risingwave/) — vocabulary and at-least-once + idempotency-key model adopted.
- [ADR-0010](0010-bounded-queue-drain.md) — `boundedQueueDrain` shipped at-least-once semantics with operator-supplied idempotency in v0.2.0; this ADR generalizes that pattern to the watch primitive itself.
