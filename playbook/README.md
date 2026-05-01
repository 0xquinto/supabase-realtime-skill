# Playbook (ported from `supabase-mcp-evals`)

These files were copied verbatim from `supabase-mcp-evals` at SHA `ddacb77` (2026-04-30):

- `PLAYBOOK.md` — methodology synthesized from the LLM evals YouTube playlist (the discipline backbone for this repo's eval methodology)
- `PLAYLIST.md` — index of source videos
- `research/*.md` — 7 topic files closing identified playbook gaps:
  - `agent-eagerness.md`
  - `construct-validity.md` (Bean's 8 — referenced from `references/eval-methodology.md`)
  - `dataset-construction.md`
  - `harness-engineering.md`
  - `prompt-injection.md`
  - `statistical-design.md` (Wilson CIs, McNemar's test, MDE)
  - `_gap-search-2026-04-29.md` (audit of the gap-search that produced the topics above)

`playbook/notes/` (33 per-video notes) was deliberately not ported — the synthesis lives in `PLAYBOOK.md`. If you need a specific note, it's at `~/Dev/supabase-mcp-evals/playbook/notes/`.

## When to read which

- **Designing or sizing a slice/eval:** `PLAYBOOK.md` § 8 (anti-patterns) + § 9 (statistical-design heuristics) + `research/construct-validity.md` Target 1 (Bean's 8 checklist).
- **Adding a metric to `eval/metrics.ts`:** `PLAYBOOK.md` § 9 + `research/statistical-design.md`.
- **Generating fixtures:** `research/dataset-construction.md` (note: the lesson "synthetic data before a hand-crafted seed" is why `fixtures/ci-fast/` is hand-curated and `fixtures/ci-full/` is hand-seed + LLM-augmented).
- **Eval harness design questions:** `research/harness-engineering.md`.

## Cleanup pass policy

If new research supersedes a `PLAYBOOK.md` bullet, the cleanup pass is part of the work, not an afterthought. Document the AMEND in the relevant `research/<topic>.md` file's back-refs section. (Pattern from `supabase-mcp-evals` PR #7.)
