---
name: supabase-realtime
description: Use when an agent needs to react to Postgres row-changes or coordinate over Realtime broadcast channels on Supabase. Provides bounded subscription tools that fit Edge Function timeout budgets.
license: Apache-2.0
---

# supabase-realtime

Tools and patterns for an LLM agent to **react to database events** and **coordinate over broadcast channels** on Supabase Realtime, deployed as a Supabase Edge Function.

## When to reach for this skill

Three triggers, each with what *not* to do.

### 1. The agent needs to act on a database event

For example: a new ticket arrives in `support_tickets` and the agent should triage it. Use `watch_table` with `predicate.event = "INSERT"`.

**Don't** use this for state the agent already wrote — `watch_table` is for changes the agent didn't cause. If the agent just inserted a row and wants to know it was inserted, that's a return value, not a subscription.

### 2. The agent needs to fan out a result to other agents

For example: triage agent decides routing, then signals a downstream handoff agent. Use `broadcast_to_channel`.

**Don't** use broadcast as a queue — Realtime broadcast is fire-and-forget; messages aren't durable. If the receiving agent might be offline, write the work to a real queue (`pgmq`) and trigger that side via `watch_table` on the queue table.

### 3. The agent is the receiving side of a multi-agent workflow

Use `subscribe_to_channel`. Mirrors `watch_table`'s bounded shape — block until N events or timeout.

**Don't** subscribe with a high `max_events` and `timeout_ms` "just in case" — Edge Function isolates have wall-clock budgets. Spec a tight bound; the pattern is *bounded* subscription, not persistent.

## Core pattern: bounded subscription

The tool blocks for at most `timeout_ms` *or* until `max_events` matching events arrive — whichever first. Then returns the batch. This is the right primitive for agent loops because:

- It maps cleanly to a single MCP tool-call (no streaming protocol)
- It fits Edge Function isolate budgets (caps timeout at 120s, well under the 150s wall-clock limit)
- It composes with normal agent loops: call → process batch → call again

The canonical loop:

```ts
while (still_relevant) {
  const { events, closed_reason } = await mcp.call("watch_table", {
    table: "support_tickets",
    predicate: { event: "INSERT" },
    timeout_ms: 60000,
    max_events: 10,
  });
  for (const ev of events) await processEvent(ev);
  if (closed_reason === "timeout" && shouldStop()) break;
}
```

Why not a persistent WebSocket? The agent's tool-call boundary *is* the natural checkpoint. Persistent connections fight the Edge Function model and force you into long-lived workers, which is a different deployment shape and a different operational surface.

## Tools at a glance

| Trigger | Tool |
|---|---|
| React to a database event | `watch_table` |
| Send a coordination signal | `broadcast_to_channel` |
| Receive a coordination signal | `subscribe_to_channel` |
| Discover what channels are active | `list_channels` |
| Inspect a table's schema and replication settings | `describe_table_changes` |

Five tools. No Presence in v1 — see `references/presence-deferred.md` for why.

## Worked example: support-ticket triage

A SaaS app has a `support_tickets` table. Tickets get auto-embedded via Supabase Automatic Embeddings (writes a `halfvec(1536)` to `embedding`). The triage agent watches for new tickets, retrieves the most-similar past resolved tickets via pgvector, decides routing, writes the routing back, and broadcasts a `ticket-routed` event so a downstream handoff agent picks it up.

End-to-end walkthrough with code in `references/worked-example.md`.

## References

- [`predicates.md`](references/predicates.md) — supported filter ops, why others are excluded
- [`replication-identity.md`](references/replication-identity.md) — when to enable `REPLICA IDENTITY FULL`
- [`rls-implications.md`](references/rls-implications.md) — RLS + Realtime + broadcast auth
- [`presence-deferred.md`](references/presence-deferred.md) — design questions left open for v2
- [`pgvector-composition.md`](references/pgvector-composition.md) — composing CDC + Automatic Embeddings + retrieval
- [`eval-methodology.md`](references/eval-methodology.md) — the 4 metrics, why not LLM-judge
- [`edge-deployment.md`](references/edge-deployment.md) — operator setup
- [`worked-example.md`](references/worked-example.md) — support-ticket triage end-to-end (LLM + pgvector)
- [`outbox-forwarder.md`](references/outbox-forwarder.md) — non-LLM worked example (substrate generalizes beyond AI use cases)
