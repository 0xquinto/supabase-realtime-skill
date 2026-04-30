-- supabase/migrations/20260430000001_support_tickets.sql
--
-- Worked-example schema for the support-ticket triage agent.
-- Uses Supabase Automatic Embeddings (April 2026 GA) to populate the
-- embedding column asynchronously via pgmq + pg_cron + an Edge Function.
-- We don't manage that pipeline here — we assume the operator has run
-- `select supabase_automatic_embeddings.enable(...)` separately.

create extension if not exists vector;

create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  subject text not null,
  body text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved')),
  routing text check (routing in ('urgent', 'engineering', 'billing', 'general')),
  embedding halfvec(1536),
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
