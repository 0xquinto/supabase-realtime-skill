# References — Composing watch_table + Automatic Embeddings + pgvector

The worked example pattern: a row arrives, gets auto-embedded asynchronously, the agent watches the table for the embedded version, retrieves similar past rows, decides an action, and writes a result back. This page documents how the three pieces compose.

## The three pieces

1. **Postgres-Changes (`watch_table`)** — the agent's notification surface. Row INSERT/UPDATE events stream to the agent through a bounded subscription.
2. **Supabase Automatic Embeddings** — fully async, agent-free. `INSERT` triggers a queue entry → cron worker → Edge Function calls embedding model → writes `halfvec(1536)` back to the row. The agent never sees this loop; it just observes the resulting state.
3. **pgvector (`halfvec` + HNSW)** — the agent's *retrieval* surface. After observing a new row, the agent queries past resolved rows by cosine similarity to the new row's embedding.

## The interaction sequence

```
T0: agent calls watch_table(table=support_tickets, predicate=INSERT)
T1: app inserts a row → ticket lands in DB without embedding yet
T2: agent receives INSERT event (within p95 < 2s of T1)
T3: agent processes: maybe waits for embedding, retrieves similar, routes
T4: agent UPDATEs row.routing
T5: agent broadcast_to_channel(handoff)
```

## Two design choices to highlight

### Why not embed on the agent's side?

Tempting: agent receives ticket, generates embedding inline, queries pgvector, then routes. Rejected because:

- **Latency:** embedding generation adds 100-300ms per call; the bounded subscription is already tight on isolate budget. Pushing embedding off-loop keeps the agent loop fast.
- **Cost:** embedding calls cost 10× the LLM routing call when both run per-ticket. Automatic Embeddings amortizes by batching, retrying, and using cheaper models off the critical path.
- **Idempotency:** Automatic Embeddings is exactly-once via pgmq + advisory locks. Agent-side embedding generation needs the agent to dedupe across retries.

### How the agent handles "embedding not ready yet"

`watch_table` fires on the INSERT at T1 — the embedding is still pending at T2. Two patterns work:

**A — Wait for the embedded UPDATE.** Watch for `event = "UPDATE"` with a filter `embedding is not null` (client-side) or post-filter the events. Adds latency but ensures the retrieval has a query vector.

**B — Tolerate missing embeddings on first INSERT.** If `ticket.embedding` is null, fall back to keyword search or skip retrieval. Less robust but lower latency.

The worked example uses **A** — the agent calls `watch_table` with `predicate.event = "UPDATE"` and filters for `embedding is not null` post-receipt. The trade-off (slower triage but always-grounded retrieval) is documented in `docs/writeup.md` § *Why not X?*.

## Schema requirements

```sql
create extension if not exists vector;

create table <your_table> (
  ...,
  embedding halfvec(1536),  -- dimension matches your embedding model
  ...
);

create index <your_table>_embedding_hnsw
  on <your_table> using hnsw (embedding halfvec_cosine_ops);
```

`halfvec(1536)` is the recommended Supabase Automatic Embeddings shape (April 2026) — half the storage of `vector(1536)` with negligible quality loss. Use HNSW over IVFFlat unless your dataset is >1M rows; HNSW indexes faster and has lower query latency in the typical agent-retrieval range.

### Two embedding-provider paths

The bundled eval harness supports both the spec-default substrate and a zero-deps fallback. `eval/embed-corpus.mjs` picks based on `OPENAI_API_KEY`:

| Provider | Dim | Trigger | Migration path |
|---|---|---|---|
| OpenAI `text-embedding-3-small` | 1536 | `OPENAI_API_KEY` set | canonical migration only — matches Supabase Automatic Embeddings shape |
| Transformers.js `Xenova/all-MiniLM-L6-v2` | 384 | `OPENAI_API_KEY` unset | canonical migration + `eval/migrations/eval-dim-override-384.sql` |

The OpenAI path is the spec-compliant one. Production deployments using Automatic Embeddings get exactly this column shape — `halfvec(1536)` with text-embedding-3-small (or equivalent) populating the column async via pgmq. Cost for the full eval corpus (~152 items × ~150 tokens) is well under $0.001.

The Transformers.js fallback exists so the eval can be reproduced anywhere a transient Supabase branch can be made — no OpenAI key required, no rate-limit dependence, no cost. The override migration drops the HNSW index, ALTERs the column to `halfvec(384)`, and recreates the index. The retrieval *pattern* (`order by embedding <=> $query`) is identical; only dim and provider differ.

The harness pre-computes embeddings into `fixtures/embeddings.json` (with metadata `{ provider, dim, embeddings }`) rather than embedding at trial-time. This makes runs deterministic (same vectors → same retrieval order → same LLM context) and removes embedding-API latency from the substrate measurement.

## See also

- `references/replication-identity.md` — UPDATE events need `REPLICA IDENTITY FULL` if you want the old row.
- Supabase Automatic Embeddings docs: https://supabase.com/docs/guides/ai/automatic-embeddings
