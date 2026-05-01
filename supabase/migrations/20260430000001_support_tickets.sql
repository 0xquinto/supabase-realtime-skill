-- supabase/migrations/20260430000001_support_tickets.sql
--
-- Worked-example schema for the support-ticket triage agent.
--
-- Embeddings: 384-dim halfvec via the all-MiniLM-L6-v2 local model
-- (Transformers.js / sentence-transformers). Pre-computed by
-- `eval/embed-corpus.ts` and inserted by the runner. The composition
-- pattern (CDC → embed → pgvector retrieval → action) is identical to
-- the Supabase Automatic Embeddings + OpenAI 1536-dim flow described
-- in references/pgvector-composition.md; only the embedding provider
-- differs. This dim is chosen so the eval has zero external API
-- dependencies.

create extension if not exists vector;

create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  subject text not null,
  body text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  routing text check (routing in ('urgent', 'engineering', 'billing', 'general')),
  embedding halfvec(384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index support_tickets_embedding_hnsw
  on support_tickets using hnsw (embedding halfvec_cosine_ops);

create index support_tickets_status_idx on support_tickets (status);

-- Enable replica identity full so UPDATE events carry the old row.
alter table support_tickets replica identity full;

-- Add to the realtime publication so Postgres-Changes can stream events.
alter publication supabase_realtime add table support_tickets;

-- RLS scaffolding (no policies in v1; ops can add per their JWT model).
alter table support_tickets enable row level security;
