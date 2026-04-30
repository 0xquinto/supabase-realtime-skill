# Upstream context (ported from `supabase-mcp-evals`)

These three files were copied verbatim from `supabase-mcp-evals` at SHA `ddacb77` (2026-04-30) so this repo carries the load-bearing context without depending on the parent repo being on disk.

| File | Origin path in supabase-mcp-evals | What it is |
|---|---|---|
| `recon/2026-04-30-portfolio-redesign-recon.md` | `docs/superpowers/recon/2026-04-30-portfolio-redesign-recon.md` | 4-fork landscape recon that picked Realtime/CDC as the niche and the Skill+MCP form factor |
| `spec/2026-04-30-supabase-realtime-skill-design.md` | `docs/superpowers/specs/2026-04-30-supabase-realtime-skill-design.md` | The design spec — five tools, bounded subscription, eval methodology |
| `plan/2026-04-30-supabase-realtime-skill-build.md` | `docs/superpowers/plans/2026-04-30-supabase-realtime-skill-build.md` | The 31-task implementation plan executed in this repo (T1-T30 done; T26 Step 3 + T30 Steps 2-4 + T31 await operator action — see `docs/ship-status.md`) |

The plan in particular has been **patched in the upstream repo** (commit `ddacb77`) to fix three bugs the Phase 1 spike surfaced: `projectRef` → `hostProjectRef`, `fetchProjectKeys` helper pattern, and the Realtime ~5s warm-up methodology constraint for T9. The copy here reflects those patches.

## Why these are under `docs/upstream/` instead of root

The spec and plan describe *how this repo was built*. They're historical context, not live design docs. Treating them as upstream provenance — like a vendored snapshot — keeps the root namespace clean for the artifact itself.

If a future task amends the design (e.g., v0.2 reshapes the Skill surface), write a new spec under `docs/superpowers/specs/` and let this `upstream/` snapshot stay frozen.
