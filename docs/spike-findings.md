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
