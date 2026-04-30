# References — Postgres-Changes filter predicates

The `watch_table` tool exposes a `predicate.filter` parameter. Some operators are evaluated server-side by Supabase Realtime; others fall back to client-side filtering inside `boundedWatch`. Server-side is cheaper (events filtered before they cross the wire) and **strongly preferred for high-frequency tables**. Client-side is correct, but every filtered-out event still costs you wire bandwidth and isolate CPU.

## Server-side ops

These map directly to Postgres-Changes `filter` strings (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`). The Realtime server evaluates them before publishing to the channel.

| op | Postgres-Changes filter form | Notes |
|---|---|---|
| `eq` | `<column>=eq.<value>` | Most common. Strings, numbers, UUIDs all work. |
| `neq` | `<column>=neq.<value>` | |
| `gt`, `gte`, `lt`, `lte` | `<column>=gt.<value>` etc. | Numeric / timestamp comparisons. |
| `in` | `<column>=in.(<v1>,<v2>,...)` | Comma-separated value list. |

## Operators we explicitly *don't* support

Postgres-Changes doesn't support pattern matching, JSON path traversal, or full-text. We considered shipping a client-side fallback for these and decided against it for v1:

- **`like` / `ilike` / regex** — surprisingly expensive on high-frequency tables; agents can post-filter the returned `events[]` themselves if they need pattern matching. Adding it server-side would imply we're shipping our own publication layer.
- **JSON path** — composes poorly with the server-side filter syntax; we'd be re-implementing PostgREST. Out of scope.
- **Full-text** — same reasoning, plus tsvector requires schema awareness this MCP doesn't have.

If your agent needs one of these, two options: (a) post-filter `events[]` after `watch_table` returns; (b) create a generated column (`status_normalized`, `body_lower`) and use `eq` on that.

## Why server-side at all

A common alternative is "subscribe to the whole table and filter in TS." It's tempting because it's simpler. We rejected it because:

- Realtime caps events-per-second per channel (default 10/s with bursts allowed). A noisy table without a filter starts dropping events under load. Server-side filtering keeps you under the cap.
- Edge Function isolates have CPU budgets. Filtering 1000 events to find the 5 that match wastes most of your wallclock.
- The spec's `latency_to_first_event_ms` p95 < 2s threshold gets harder to hit when each event has to be parsed and rejected.

## When the filter you want isn't supported

`watch_table` returns `INVALID_PREDICATE` *up front* (during input parsing) rather than silently degrading to a slow client-side filter. This is intentional — agents should surface the constraint, not get a silently-bad result. If you really need a fallback, reach for `boundedWatch` directly (the underlying primitive is exported) and pass an unfiltered subscription with a TS-side filter in your agent loop.

## See also

- `references/replication-identity.md` — for `UPDATE`/`DELETE`, which columns of `old` you'll see in the event payload depends on `REPLICA IDENTITY`.
- `references/rls-implications.md` — RLS applies to which rows the channel can see; the filter runs *after* RLS.
