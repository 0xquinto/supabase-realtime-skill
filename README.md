# supabase-realtime-skill

Agent Skill + MCP server for Supabase Realtime/CDC. Gives an LLM agent a bounded primitive for reacting to Postgres row-changes and coordinating over Realtime broadcast channels, deployed as a Supabase Edge Function.

The headline pattern is **agent-watches-database**: the agent calls a tool that blocks until either `max_events` arrive *or* `timeout_ms` elapses, then returns the batch. No streaming protocol, no persistent connection across tool-calls — fits MCP's request/response shape and Edge Function isolate budgets (Pro caps wall-clock at 150s).

Full writeup: [`docs/writeup.md`](docs/writeup.md). Skill entry: [`SKILL.md`](SKILL.md).

## Quick start

Install:

```bash
npm install supabase-realtime-skill        # or: bun add supabase-realtime-skill
```

Use the bounded primitive directly (Node):

```ts
import { boundedWatch, makeSupabaseAdapter } from "supabase-realtime-skill/server";

const adapter = makeSupabaseAdapter("support_tickets", {
  supabaseUrl: process.env.SUPABASE_URL!,
  supabaseKey: process.env.SUPABASE_ANON_KEY!,
});

const { events } = await boundedWatch({
  adapter,
  table: "support_tickets",
  predicate: { event: "INSERT" },
  timeout_ms: 60_000,
  max_events: 10,
});
```

Deploy the MCP server as an Edge Function:

```bash
supabase functions deploy mcp --project-ref <your-project>
# Function URL responds to MCP JSON-RPC over StreamableHTTP.
```

## What's in the box

| Tool | Shape |
|---|---|
| `watch_table` | bounded subscription to Postgres row-changes |
| `broadcast_to_channel` | fire-and-forget broadcast, idempotent retry on 5xx |
| `subscribe_to_channel` | bounded subscription to a Broadcast channel |
| `list_channels` | best-effort registry listing |
| `describe_table_changes` | introspect columns, PK, RLS state, REPLICA IDENTITY |

## Eval

Pre-registered thresholds in [`manifest.json`](manifest.json) gate merges via [`eval/runner.ts`](eval/runner.ts). Latest ci-nightly (n=100): substrate clean (0 missed, 0 spurious, p95 1520ms); composition has a known label-boundary gap on `general` routing (87% accuracy). See [`docs/writeup.md`](docs/writeup.md) § 4 for the full breakdown.

## Layout

- [`SKILL.md`](SKILL.md) — Open Skills Standard entry; three triggers + tools at a glance
- [`references/`](references/) — 8 opinionated patterns (predicates, RLS, replication identity, pgvector composition, eval methodology, edge deployment, presence-deferred, worked example)
- [`src/server/`](src/server/) — MCP server (5 tools) + bounded primitives
- [`src/client/`](src/client/) — npm consumer barrel
- [`supabase/functions/mcp/`](supabase/functions/mcp/) — Edge Function entry (WebStandardStreamableHTTP transport)
- [`eval/`](eval/) — regression harness with pre-registered thresholds
- [`docs/writeup.md`](docs/writeup.md) — the headline writeup
- [`docs/spike-findings.md`](docs/spike-findings.md) — operational findings from the spike (5s warm-up, Deno bundler `.ts` extension)
- [`playbook/`](playbook/) — eval methodology backbone

## License

Apache-2.0
