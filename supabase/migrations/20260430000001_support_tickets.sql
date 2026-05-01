-- supabase/migrations/20260430000001_support_tickets.sql
--
-- Worked-example schema for the support-ticket triage agent.
--
-- Embedding column: halfvec(1536) — Supabase Automatic Embeddings shape
-- (OpenAI text-embedding-3-small or equivalent). Production deployments
-- run Automatic Embeddings via pgmq + pg_cron + an Edge Function to
-- populate this column asynchronously on INSERT.
--
-- The bundled eval supports two paths:
--   1. With OPENAI_API_KEY set: spec-compliant 1536-dim flow (no schema override)
--   2. Without OPENAI_API_KEY: local Transformers.js fallback (384-dim);
--      eval/runner.ts applies eval-dim-override-384.sql to ALTER the
--      column type before seeding.
-- See references/pgvector-composition.md for the full provider design.

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
