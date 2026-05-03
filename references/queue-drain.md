# References — `boundedQueueDrain`: deterministic queue/outbox draining

A typed deterministic module that composes [`watch_table`](predicates.md)'s body (`boundedWatch`) + `broadcast_to_channel`'s body (`handleBroadcast`, with its 3-retry envelope) + a caller-supplied SQL-ack callback. **One drain pass.** Bounded by `timeout_ms` and `max_events` so it fits Edge Function isolate budgets.

Promoted from the [outbox-forwarder pattern](outbox-forwarder.md) per [ADR-0010](../docs/decisions/0010-bounded-queue-drain.md). The pattern still works composed by hand; this module is the same shape with one entry point and a falsifiable contract.

## ⚠ Contract surface

> **At-least-once.** Each row may be forwarded more than once if the broadcast succeeds but the ack callback fails. **Subscribers MUST be idempotent.** To upgrade to effectively-once, run a consumer-side inbox table (out of scope for `v1.0.0`).

> **Per-aggregate ordering only.** Realtime broadcast is fire-and-forget. Broadcasts to different channels have no relative ordering; broadcasts to the same channel arrive in insert order. If you need cross-destination ordering, you need a per-destination FIFO queue — that's a different module.

> **Default replica identity is enough.** Outbox/queue tables are typically INSERT-only; `payload.new` carries the row, no `replica identity full` required. This is a deliberate divergence from `watch_table`'s prerequisites — see [`replication-identity.md`](replication-identity.md).

## The schema

```sql
create table queue (
  id uuid primary key default gen_random_uuid(),
  destination text not null,           -- channel name, e.g. "slack:eng-alerts"
  event_type text not null,            -- e.g. "deploy.started"
  payload jsonb not null,
  inserted_at timestamptz not null default now(),
  forwarded_at timestamptz             -- null until forwarded; ack writes now() here
);

alter publication supabase_realtime add table queue;
```

For dead-letter persistence (optional but strongly recommended in production):

```sql
create table queue_dlq (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null,             -- the queue.id that failed
  payload jsonb not null,
  error text,
  failed_at timestamptz not null default now()
);
```

## The drain loop

```ts
import { boundedQueueDrain, makeSupabaseAdapter } from "supabase-realtime-skill/server";
import { handleBroadcast, type BroadcastSender } from "supabase-realtime-skill/server";
import postgres from "postgres";

async function drainOnce(opts: {
  supabaseUrl: string;
  supabaseKey: string;
  databaseUrl: string;
  sender: BroadcastSender;
}) {
  const sql = postgres(opts.databaseUrl, { max: 1 });
  try {
    const adapter = makeSupabaseAdapter("queue", {
      supabaseUrl: opts.supabaseUrl,
      supabaseKey: opts.supabaseKey,
    });

    const result = await boundedQueueDrain({
      adapter,
      table: "queue",
      // predicate defaults to { event: "INSERT" } — override here if you also want UPDATEs.
      read_row: (ev) => {
        const row = ev.new as { destination: string; event_type: string; payload: Record<string, unknown> };
        return { destination: row.destination, event: row.event_type, payload: row.payload };
      },
      ack: async (ev) => {
        const id = (ev.new as { id: string }).id;
        await sql`update queue set forwarded_at = now() where id = ${id}`;
      },
      // Optional but recommended in production. Persist failed-after-N rows
      // so the operator has a place to triage them. Without this, failed rows
      // stay un-acked and will be re-forwarded on every drain loop forever.
      //
      // Transaction is load-bearing: under at-least-once semantics, an INSERT
      // → UPDATE pair without `sql.begin` can leave the row newly-DLQ'd in
      // queue_dlq AND still un-acked in `queue` if the second statement fails.
      // The next drain loop would then double-DLQ the same source_id. Either
      // wrap both writes in one transaction (below) or add a unique index on
      // queue_dlq.source_id and use `INSERT ... ON CONFLICT DO NOTHING`.
      dead_letter: async (ev, _row, err) => {
        const row = ev.new as { id: string; payload: unknown };
        await sql.begin(async (tx) => {
          await tx`insert into queue_dlq (source_id, payload, error)
                   values (${row.id}, ${JSON.stringify(row.payload)}::jsonb, ${String(err)})`;
          await tx`update queue set forwarded_at = now() where id = ${row.id}`;
        });
      },
      sender: opts.sender,
      timeout_ms: 60_000,
      max_events: 25,
    });

    // result: { forwarded, dead_lettered, failed, closed_reason }
    // forwarded     — broadcast OK + ack OK
    // dead_lettered — broadcast failed all retries + dead_letter callback OK
    // failed        — read_row threw, broadcast failed without DLQ, DLQ callback threw,
    //                 OR ack threw post-broadcast. Row stays un-acked; will re-drain.
    // closed_reason — "max_events" | "timeout"
    return result;
  } finally {
    await sql.end();
  }
}
```

The categories partition the events array — `forwarded + dead_lettered + failed === events.length`. No double-counting.

## Composing it in an Edge Function

Edge Functions cap wall-clock at 150s. The bounded drain pass fits in that budget. Pattern:

```ts
import { serve } from "https://deno.land/std/http/server.ts";
import { drainOnce } from "./drain-once.ts";

serve(async () => {
  const result = await drainOnce({...});
  return Response.json({
    forwarded: result.forwarded,
    dead_lettered: result.dead_lettered,
    failed: result.failed,
    closed_reason: result.closed_reason,
  });
});
```

Schedule the function via [Supabase Cron](https://supabase.com/docs/guides/cron) (every 1-5 min depending on queue rate) or trigger it from a webhook. Don't run it as a long-lived loop — that fights the Edge Function model.

## Tuning `max_events` and `timeout_ms`

- **`max_events`**: cap on rows drained per pass. The remaining rows stay in the queue and get drained next pass. Set roughly to `(your_per_pass_budget_seconds * expected_throughput_per_second) / safety_factor`. The fast tests use values from 1 (single-row scenarios) to 25 (the realistic outbox-forwarder example). Hard ceiling: 200 (boundedWatch's own `max_events` cap).
- **`timeout_ms`**: how long the drain waits for new rows before closing. If the queue is sustained (always non-empty), `closed_reason` will be `max_events` and `timeout_ms` is just a safety net — set it to ~80% of your wall-clock budget. If the queue is bursty, set it lower so idle periods don't waste isolate time.

## Handling backpressure

If queue insert-rate sustainedly exceeds drain-rate, you have two options:

1. **Run multiple Edge Function isolates in parallel.** Each drain pass needs to pick up a disjoint set of rows. Add a `claim_id` UUID column; before processing, `update queue set claim_id = ${myClaimId} where claim_id is null and id = ${row.id}` and skip rows where the update returned 0 rows. Different drainers won't fight over the same row.
2. **Increase `max_events`** up to the 200 ceiling. Diminishing returns past ~50 because handleBroadcast's per-row latency dominates.

Option 1 is the better long-term shape; option 2 is the cheaper short-term lever.

## What this shows about the substrate

This module reuses 100% of the primitives the triage agent uses (`boundedWatch` + `handleBroadcast`) — **no special-casing, no new abstraction layer**. That generalization is the test of whether the substrate is a substrate or just one-off scaffolding for the headline example.

The two worked examples differ on what's in the loop, not what's *underneath* the loop:

| Aspect | Triage agent | Queue drainer |
|---|---|---|
| Primary primitive | `boundedWatch` (UPDATE on `embedding`) | `boundedWatch` (INSERT on row) |
| Decision logic | LLM routing call | None — destination is a row column |
| Output side | Write `routing` back + Broadcast | Broadcast + ack via SQL UPDATE |
| Cost per event | LLM token cost + embedding query | 1 SQL UPDATE + 1 broadcast call |
| Latency p95 | ~1.5-2s (LLM-bound) | ~50-150ms (SQL + broadcast) |
| Manifest gate | `action_correctness_rate_min` | `forward_correctness_rate_min` (ADR-0010, pre-staged) |

## Comparison: the older outbox-forwarder pattern

[`outbox-forwarder.md`](outbox-forwarder.md) documents the same pattern composed by hand. That page now opens with a status note pointing here. The composition-by-hand version still works — it's what `boundedQueueDrain` shipped *as*, before the module promotion. Use the module if you want the typed contract surface and the manifest gate; use the manual composition if you need a different DLQ shape (e.g., write to Redis instead of SQL) and don't want the callback indirection.

## Tests

- **Fast (mocked):** [`tests/fast/queue-drain.test.ts`](../tests/fast/queue-drain.test.ts) — 11 tests covering 7 fixture-shaped scenarios (`fixtures/ci-fast/queue-drain/qd00*.json`) plus 4 module-property tests (predicate default, ack-failure bucketing, read_row-throw bucketing, DLQ-callback-throw bucketing). Runs in ~1s.
- **Smoke (real branch):** [`tests/smoke/queue-drain.smoke.test.ts`](../tests/smoke/queue-drain.smoke.test.ts) — exercises the production adapter end-to-end against a real Supabase Pro branch. Skips when `EVAL_SUPABASE_PAT`/`EVAL_HOST_PROJECT_REF` are missing.

## See also

- [`outbox-forwarder.md`](outbox-forwarder.md) — the manual-composition predecessor
- [`worked-example.md`](worked-example.md) — the LLM-driven worked example that uses the same primitives
- [`predicates.md`](predicates.md) — the filter ops the underlying `watch_table` accepts
- [`replication-identity.md`](replication-identity.md) — schema setup; the queue-drain pattern is the documented "default identity is enough" exception
- [`edge-deployment.md`](edge-deployment.md) — operator setup
- [`eval-methodology.md`](eval-methodology.md) — the manifest gate pattern; queue-drain extends this with `forward_correctness_rate_min`
- [ADR-0010](../docs/decisions/0010-bounded-queue-drain.md) — the design decisions this page documents
