# supabase-realtime-skill

Agent Skill + MCP server for Supabase Realtime/CDC. Gives an LLM agent the ability to react to Postgres row-changes and coordinate over Realtime broadcast channels, deployed as a Supabase Edge Function.

**Status:** Pre-alpha. See [`docs/writeup.md`](docs/writeup.md) when published.

## Why

The official `supabase` Agent Skill names Realtime in scope but doesn't go deep on it. This bundle ships a worked example of *agent-watches-database* and *agent-broadcasts-to-channel* as first-class patterns, with eval instrumentation built in.

## Quickstart

(Coming after Week 2 — when the 5 tools are green on smoke tests.)

## Layout

- `SKILL.md` — Open Skills Standard entry
- `references/` — opinionated patterns (predicates, RLS, replication identity, pgvector composition)
- `src/server/` — MCP server (5 tools)
- `supabase/functions/mcp/` — Edge Function entry
- `eval/` — regression harness with pre-registered thresholds in `manifest.json`
- `docs/writeup.md` — the headline writeup (Q6)

## License

Apache-2.0
