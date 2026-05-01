# References — Worked example: support-ticket triage agent

End-to-end walkthrough of the worked example referenced in `SKILL.md`. The agent watches `support_tickets`, retrieves similar past resolved tickets via pgvector, decides routing, writes the routing back, and broadcasts a downstream signal.

## The schema

See `supabase/migrations/20260430000001_support_tickets.sql`. Highlights:

- `embedding halfvec(1536)` populated by Supabase Automatic Embeddings (production; async; agent never triggers it). The bundled eval supports a zero-deps fallback path that swaps to `halfvec(384)` via `eval/migrations/eval-dim-override-384.sql` and a local Transformers.js model — see `references/pgvector-composition.md` § "Two embedding-provider paths".
- HNSW index on the embedding for fast similarity search
- `replica identity full` so UPDATE events carry the old row
- Added to `supabase_realtime` publication

## The agent loop

```ts
import { boundedWatch, makeSupabaseAdapter } from "supabase-realtime-skill/server";

async function triageLoop(supabaseUrl: string, supabaseKey: string, sql: postgres.Sql) {
  while (true) {
    const adapter = makeSupabaseAdapter("support_tickets", { supabaseUrl, supabaseKey });
    const { events, closed_reason } = await boundedWatch({
      adapter,
      table: "support_tickets",
      predicate: { event: "UPDATE", filter: { column: "embedding", op: "neq", value: null } },
      timeout_ms: 60_000,
      max_events: 10,
    });

    for (const ev of events) {
      const ticket = ev.new;
      if (!ticket || !ticket.embedding) continue;

      // Retrieve 5 most-similar past resolved tickets
      const similar = await sql<{ subject: string; routing: string }[]>`
        select subject, routing from support_tickets
        where status = 'resolved' and routing is not null and id != ${ticket.id as string}
        order by embedding <=> ${ticket.embedding as any}::halfvec
        limit 5
      `;

      // LLM routing decision (your own implementation)
      const routing = await routeWithLlm(ticket, similar);

      // Write routing back
      await sql`update support_tickets set routing = ${routing} where id = ${ticket.id as string}`;

      // Broadcast for downstream handoff
      await broadcastTo(`agent:triage:${routing}`, "ticket-routed", {
        ticket_id: ticket.id,
        routing,
        customer_id: ticket.customer_id,
      });
    }

    if (closed_reason === "timeout" && shouldStop()) break;
  }
}
```

## Why watch UPDATE, not INSERT

A new ticket's INSERT fires *before* Automatic Embeddings populates `embedding`. If the agent retrieves on INSERT, the query vector is null and pgvector returns garbage.

The pattern above watches for **the UPDATE that lands when Automatic Embeddings writes the embedding back**. The filter `embedding != null` ensures the agent only fires when the row is retrieval-ready. Latency added: ~1-3 seconds (the embedding pipeline's own p95). For a triage workflow that's fine; for stricter SLAs, see `references/pgvector-composition.md` for the alternative B pattern (tolerate null embeddings, fall back to keyword search).

## Eval shape

This worked example doubles as the regression-suite SUT (`eval/runner.ts`). The 4 metrics in `manifest.json` are computed against this loop running over fixtures in `fixtures/ci-fast/` and `fixtures/ci-nightly/`. The eval harness:

1. Generates embeddings for all fixtures + a hand-curated 32-row resolved-ticket corpus via `node eval/embed-corpus.mjs` (one-time; cached in `fixtures/embeddings.json`).
2. On each transient branch: applies the migration, seeds the resolved corpus rows with their embeddings, fires a throwaway warm-up insert+watch pair to absorb the T7 5-second window, then runs each fixture as a trial.
3. Per trial: arms `watch_table` for INSERT, inserts the new ticket WITH its pre-computed embedding, receives the event, runs the pgvector cosine query against the seeded resolved corpus (`order by embedding <=>`), passes top-5 into the LLM routing decision, writes routing back, returns telemetry.

See `references/eval-methodology.md` for the metric definitions; see `references/pgvector-composition.md` for the design rationale.

## What this composition demonstrates

- Three of the five tools wired together (`watch_table`, `broadcast_to_channel`, with `describe_table_changes` implicit during setup)
- pgvector retrieval composed with Automatic Embeddings substrate
- The bounded-subscription pattern in production: watch with timeout, process the batch, loop
- Cross-agent coordination via Broadcast (the `agent:triage:<routing>` channel naming convention)

## See also

- `references/pgvector-composition.md` — the embedding/retrieval interaction in detail
- `references/eval-methodology.md` — how the metrics are computed
- `docs/writeup.md` — the headline narrative around this composition
