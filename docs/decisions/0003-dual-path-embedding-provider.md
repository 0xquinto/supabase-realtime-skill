# ADR 0003: dual-path embedding provider — OpenAI primary, Transformers.js fallback

**Date:** 2026-04-30
**Status:** Accepted
**Decider:** Diego Gomez
**Context:** Spec § 3 + § 7 require pgvector composition with Supabase Automatic Embeddings substrate (`halfvec(1536)`). The bundled eval needs to run end-to-end without imposing an external API key requirement on the operator. Earlier session iterations deviated to Transformers.js + `halfvec(384)`; ADR validation flagged this as a letter-of-spec gap.

## The two requirements that pull in opposite directions

1. **Spec-compliance.** § 3 names "Worked example must compose pgvector (Automatic Embeddings substrate)" as a non-negotiable constraint. § 7 schema declares `embedding halfvec(1536)` — the OpenAI text-embedding-3-small / Automatic Embeddings dimension. Production deployments use this shape via pgmq + cron + Edge-Function-per-row embedding.
2. **Eval reproducibility.** The harness should run on any operator's machine with `EVAL_SUPABASE_PAT` + `EVAL_HOST_PROJECT_REF` and no further secrets. Wiring Automatic Embeddings on a transient branch needs pgmq + an embedding-callback Edge Function — operationally heavy and per-branch-setup-fragile. Requiring `OPENAI_API_KEY` is also a real friction (the user invoking this artifact may not have one).

Earlier in this session, requirement #2 won unilaterally: the migration was changed to `halfvec(384)` and `eval/embed-corpus.mjs` used Transformers.js with no OpenAI path. The validation step flagged that as a letter-of-spec gap.

## Decision

Both. The canonical migration matches spec; the eval supports two providers with the override applied conditionally.

**Canonical migration** (`supabase/migrations/20260430000001_support_tickets.sql`):

```sql
create table support_tickets (
  ...,
  embedding halfvec(1536),  -- spec-compliant; matches Automatic Embeddings
  ...
);
```

**Eval-only override** (`eval/migrations/eval-dim-override-384.sql`):

```sql
drop index if exists support_tickets_embedding_hnsw;
alter table support_tickets alter column embedding type halfvec(384) using null;
create index support_tickets_embedding_hnsw
  on support_tickets using hnsw (embedding halfvec_cosine_ops);
```

**Embed-corpus generator** (`eval/embed-corpus.mjs`):

| Trigger | Provider | Dim |
|---|---|---|
| `OPENAI_API_KEY` set | OpenAI text-embedding-3-small | 1536 |
| `OPENAI_API_KEY` unset | Transformers.js Xenova/all-MiniLM-L6-v2 | 384 |

Output format encodes the choice as metadata: `{ provider: string, dim: number, embeddings: { id: number[] } }`.

**Runner** (`eval/runner.ts`) reads the `dim` from `fixtures/embeddings.json` and applies the override migration only if `dim !== 1536`.

## Why this is the right shape

- **Spec letter restored.** A user with `OPENAI_API_KEY` set runs the exact substrate the spec describes — `halfvec(1536)` with OpenAI embeddings on the production-shape schema. No deviations from § 7.
- **Eval still reproducible without keys.** A user without `OPENAI_API_KEY` falls through to Transformers.js. The override migration is small (drop index, alter column, recreate index) and isolated under `eval/migrations/`, so it's clear it's an eval-only deviation, not a production schema choice.
- **Honest disclosure.** The `embeddings.json` file carries metadata about which provider produced it, so reviewers can see at a glance which path generated the cached vectors. The runner logs it on every trial.
- **Composition pattern is identical.** Both paths run `order by embedding <=> $query` against the same HNSW index. Only the dim and the embedding model differ. The agent loop, the resolved-corpus seeding, the per-trial flow — unchanged.
- **Cost asymmetry is small.** OpenAI for 152 corpus items is well under $0.001; the only reason to prefer the fallback is friction-free reproducibility, not cost.

## What this doesn't do

- **No live Automatic Embeddings setup.** The runner doesn't bring up pgmq + cron + an embedding Edge Function on the transient branch; the OpenAI path still pre-computes embeddings via `embed-corpus.mjs` and seeds them statically. Live Automatic Embeddings is v0.2 territory (it's a 200-line operator setup, not a 10-line eval setup). The composition pattern is identical either way; only the population mechanism varies.
- **Doesn't auto-detect provider mid-run.** Pre-computed `embeddings.json` is the source of truth — the runner can't switch providers without a fresh `node eval/embed-corpus.mjs`. That's deliberate: the cache and the schema must be in agreement, and detection-after-the-fact is a category of bug worth not having.

## How v0.2 should evolve this

1. Add a small Edge Function that wraps OpenAI embeddings; call it from the runner via pg_net to demonstrate the live Automatic Embeddings flow on transient branches. Per-branch setup cost in seconds, not minutes.
2. Compare retrieval quality: OpenAI 1536 vs all-MiniLM-L6-v2 384 on the same fixtures. The hypothesis is that 1536 lifts f017 (the remaining systematic miss) because deeper semantics distinguish "feature request about a technical surface" from "engineering bug." This belongs in v0.2 as a *predicted, falsifiable* effect per the playbook discipline.
3. Document the two-provider tradeoff in `references/pgvector-composition.md` with a real benchmark.

## References

- ADR-0001 — manifest pre-registration policy (this ADR doesn't change manifest)
- ADR-0002 — f019 seed relabel (orthogonal — about ground truth, not substrate)
- `references/pgvector-composition.md` § "Two embedding-provider paths" — operator-facing version of this decision
- Spec § 3 + § 7 — the constraints this ADR resolves
