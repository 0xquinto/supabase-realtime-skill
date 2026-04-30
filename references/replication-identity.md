# References — REPLICA IDENTITY and the `old` row

Postgres logical replication (which Supabase Realtime is built on) emits row-change events with a payload shape that depends on the table's `REPLICA IDENTITY` setting. This is invisible until you try to read `event.old` on an `UPDATE` or `DELETE` and find it's mostly null.

## The four modes

| Mode | What `event.old` contains on UPDATE/DELETE |
|---|---|
| `DEFAULT` (the default) | Only primary-key columns. Other columns are null. |
| `FULL` | Every column of the row before the change. |
| `USING INDEX <idx>` | Columns covered by the named unique index. |
| `NOTHING` | No `old` row at all (UPDATE shows only `new`; DELETE shows nothing). |

## When it matters

- **Old/new diff:** if your agent compares `event.old.status` with `event.new.status` to decide whether a state transition just happened, you need `FULL` (or at least `USING INDEX` covering `status`).
- **DELETE auditing:** if you need to know what was deleted (not just that *something* was), you need `FULL`.
- **INSERT-only flows:** if you only ever read `event.new` from `INSERT` events, the default is fine.

## How to enable

```sql
alter table support_tickets replica identity full;
```

`describe_table_changes(table)` reports the current `replication_identity` so an agent (or human reading the docs) sees the constraint *before* writing a watch loop that depends on `old` values.

## The cost

`REPLICA IDENTITY FULL` writes the entire pre-image of each row to the WAL on every UPDATE/DELETE. For a table with wide rows or high write volume, that's measurable storage + I/O overhead. The Supabase docs estimate "up to 2-3× WAL volume on update-heavy tables." For a `support_tickets` table that gets a few hundred updates a day, this is invisible. For an `events` or `audit_log` table with millions of writes, this is real.

## The opinionated default

Tables that are *part of an agent workflow* should default to `REPLICA IDENTITY FULL` unless you've measured the WAL overhead and found it unacceptable. The cost of being surprised by a null `old` deep in an agent loop — discovering it only when a regression test fails — is much higher than the storage premium.

If WAL volume is the constraint, prefer `USING INDEX` over `DEFAULT` so you keep the columns the agent actually reads.

## Realtime warm-up window (operational note)

There's a separate, related operational gotcha that surfaces when you add a table to `supabase_realtime` and immediately subscribe: events fired in the first ~5s after `subscribe()` resolves are not delivered. This is a Realtime tenant-side cache refresh, not a replication-identity issue, but it bites the same code path (subscribe-then-write loops). If you need to ingest events from a freshly-published table, fire one warm-up insert before timing real work. See `docs/spike-findings.md` (T7) for the empirical trace.

## See also

- `references/predicates.md` — server-side filtering happens *before* the event hits your subscription, regardless of replica identity.
- `describe_table_changes` tool — exposes the current setting so the agent can make an informed call.
