# References — Outbox forwarder: a non-LLM worked example

> **Promoted (2026-05-01):** the typed-module shape of this pattern lives at [`references/queue-drain.md`](queue-drain.md). It composes the same primitives this page documents (`boundedWatch` + `handleBroadcast` + a SQL ack) with one entry point (`boundedQueueDrain`), an optional `dead_letter` callback, and a manifest-gated eval. Use the module if you want the typed contract surface; the manual composition documented below still works (it's what the module ships *as*) and remains the right reference if you need a non-SQL DLQ shape that doesn't fit a callback (e.g., posting to Redis) — see [ADR-0010 § "What this rejects"](../docs/decisions/0010-bounded-queue-drain.md). 

A second worked example that exercises the bounded-subscription primitive **without** an LLM in the loop. The triage agent (`worked-example.md`) shows the substrate composing with pgvector + LLM routing; this one shows it composing with plain Postgres + Broadcast for fan-out, proving the substrate generalizes beyond AI-shaped use cases.

## The pattern

You have an `outbox` table. Other parts of your system insert "events to forward" into it (status changes, billing webhooks, audit log entries). A forwarder process should:

1. Watch the table for new INSERT events
2. Read each row's destination + payload
3. Fan out to N subscribers (Slack channel, webhook URL, downstream agent) via Realtime broadcast
4. Mark the row as `forwarded_at`

This is the classical [outbox pattern](https://microservices.io/patterns/data/transactional-outbox.html) implemented as a bounded loop on Edge Functions, no long-running worker required.

## The schema

```sql
create table outbox (
  id uuid primary key default gen_random_uuid(),
  destination text not null,           -- channel name, e.g. "slack:eng-alerts"
  event_type text not null,            -- e.g. "deploy.started"
  payload jsonb not null,
  inserted_at timestamptz not null default now(),
  forwarded_at timestamptz             -- null until forwarded
);

alter table outbox replica identity full;     -- so DELETE/UPDATE carry old row
alter publication supabase_realtime add table outbox;
```

Same `replica identity full` + publication setup as the triage example — see `references/replication-identity.md`.

## The forwarder loop

```ts
import { boundedWatch, makeSupabaseAdapter } from "supabase-realtime-skill/server";
import { handleBroadcast } from "supabase-realtime-skill/server/broadcast";
import postgres from "postgres";

async function outboxForwarder(opts: {
  supabaseUrl: string;
  supabaseKey: string;
  databaseUrl: string;
}) {
  const sql = postgres(opts.databaseUrl, { max: 1 });
  while (running()) {
    const adapter = makeSupabaseAdapter("outbox", {
      supabaseUrl: opts.supabaseUrl,
      supabaseKey: opts.supabaseKey,
    });

    const { events, closed_reason } = await boundedWatch({
      adapter,
      table: "outbox",
      predicate: {
        event: "INSERT",
        // forwarded_at is null on insert; the filter is implicit but worth surfacing
      },
      timeout_ms: 60_000,
      max_events: 25,        // small batch — each broadcast is its own retry envelope
    });

    for (const ev of events) {
      const row = ev.new as { id: string; destination: string; event_type: string; payload: Record<string, unknown> };

      try {
        // Reuse handleBroadcast for the same retry/idempotency semantics the
        // MCP tool uses. No need to roll your own.
        await handleBroadcast(
          {
            channel: row.destination,
            event: row.event_type,
            payload: row.payload,
          },
          { sender: yourBroadcastSender },
        );

        await sql`update outbox set forwarded_at = now() where id = ${row.id}`;
      } catch (err) {
        // handleBroadcast already retried 3× with exponential backoff. If it
        // still threw, leave forwarded_at null — the row stays in the queue
        // for a future loop iteration to retry. Optionally write to a
        // dead-letter table after N failures via a `attempts` column.
        console.error(`[outbox] forward failed for ${row.id}:`, err);
      }
    }

    if (closed_reason === "timeout" && shouldDrain()) break;
  }
  await sql.end();
}
```

## What this shows about the substrate

The triage agent uses 4 of the 5 tools (`watch_table`, `broadcast_to_channel`, `subscribe_to_channel` implicitly via the routing handoff, `describe_table_changes` during setup). The outbox forwarder uses just 2 (`watch_table`, `broadcast_to_channel`) — and **all of the same primitives, no special-casing, no new abstractions**. That generalization is the test of whether the substrate is a substrate or just a one-off scaffold for the headline example.

Specifically:

- **Same `boundedWatch`** — no new "outbox watch" variant; the predicate model handles the filter naturally.
- **Same `handleBroadcast`** with its idempotent retry — the forwarder doesn't reinvent reliability; it inherits the MCP tool's retry envelope by reusing the same handler.
- **Same Edge-Function-isolate fit** — the `timeout_ms ≤ 120s` cap means the forwarder loop fits the 150s wall-clock budget without modification.
- **No LLM in the loop** — the routing decision is just `row.destination`, a database column. The substrate doesn't assume agency.

## Comparison: triage agent vs outbox forwarder

| Aspect | Triage agent | Outbox forwarder |
|---|---|---|
| Primary tool | `watch_table` (UPDATE on `embedding`) | `watch_table` (INSERT on row) |
| Retrieval shape | pgvector cosine top-K against resolved corpus | none — destination is a row column |
| Decision logic | LLM routing call | none — payload is forwarded as-is |
| Output side | Write `routing` back + Broadcast | Broadcast + mark `forwarded_at` |
| Fan-out | 1 channel per ticket | 1 channel per outbox row |
| Failure mode | LLM fails → retry call, fall through to default routing | Broadcast fails → row stays unforwarded, retried on next loop |
| Cost per event | LLM token cost + embedding query | Postgres update + 1 broadcast call |
| Latency p95 | ~1.5-2s (LLM-bound) | ~50-150ms (DB write + Realtime delivery) |

The substrate doesn't notice the difference. That's the point.

## Production hardening notes (out of scope for this v0.1.x example)

- **At-least-once vs exactly-once.** The current pattern is at-least-once: if the broadcast succeeds but the `forwarded_at` UPDATE fails, the row gets re-forwarded next loop. Subscribers must be idempotent. v2 design idea: write `forwarded_at` in the same transaction as a `forward_attempts++` increment, and skip rows where `attempts >= 5`.
- **Ordering across destinations.** Broadcasts to different channels don't have ordering guarantees relative to each other (Realtime broadcast is fire-and-forget). If you need cross-destination ordering, you need a per-destination FIFO queue, which is a different shape from this pattern.
- **Backpressure.** A `max_events: 25` per loop caps how fast the forwarder drains. If outbox-insert rate sustainedly exceeds 25/min, you need either a higher cap (subject to the 120s timeout) or multiple Edge-Function isolates running in parallel — coordinate via a `claim_id` UPDATE before processing.
- **Observability.** Wire each forward attempt + outcome to a Realtime broadcast on `agent:outbox:metrics` channel, then a downstream observability agent can subscribe and aggregate. (Yes, that's the substrate eating its own tail. That's by design.)

## Tests

`tests/fast/outbox-forwarder.test.ts` exercises the loop with mocked adapters — no real Supabase, runs in <50ms — verifying:

1. The bounded watch + broadcast sequence composes cleanly when events arrive
2. A failed broadcast leaves the row's `forwarded_at` null (caller can retry)
3. The loop respects `max_events` and `timeout_ms` boundaries the same way the headline triage example does

The test isn't claiming this is production-grade outbox semantics; it's claiming the substrate's compose-shape works for this pattern.

## See also

- [`references/worked-example.md`](worked-example.md) — the triage agent (LLM-driven; pgvector composition)
- [`references/predicates.md`](predicates.md) — the filter ops `watch_table` accepts
- [`references/replication-identity.md`](replication-identity.md) — schema setup for both the triage and outbox patterns
- [`references/edge-deployment.md`](edge-deployment.md) — operator setup for running either as an Edge Function
