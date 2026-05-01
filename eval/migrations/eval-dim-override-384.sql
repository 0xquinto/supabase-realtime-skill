-- eval/migrations/eval-dim-override-384.sql
--
-- Eval-only schema override applied by eval/runner.ts when the eval
-- runs with the local Transformers.js fallback (384-dim) instead of
-- the spec-default OpenAI 1536-dim path. NOT applied in production.
--
-- The canonical migration creates `embedding halfvec(1536)` to match
-- Supabase Automatic Embeddings + spec § 7. When OPENAI_API_KEY is
-- absent, embed-corpus.mjs generates 384-dim vectors via the local
-- Xenova/all-MiniLM-L6-v2 model; this override resizes the column +
-- HNSW index so the seed inserts and pgvector cosine queries work.
--
-- Run order: canonical migration → this override → resolved-corpus
-- seed → trial loop. See ADR-0003.

drop index if exists support_tickets_embedding_hnsw;

alter table support_tickets
  alter column embedding type halfvec(384) using null;

create index support_tickets_embedding_hnsw
  on support_tickets using hnsw (embedding halfvec_cosine_ops);
