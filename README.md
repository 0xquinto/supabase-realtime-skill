# supabase-realtime-skill

[![npm](https://img.shields.io/npm/v/supabase-realtime-skill.svg)](https://www.npmjs.com/package/supabase-realtime-skill)
[![ci-fast](https://github.com/0xquinto/supabase-realtime-skill/actions/workflows/ci-fast.yml/badge.svg)](https://github.com/0xquinto/supabase-realtime-skill/actions/workflows/ci-fast.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Agent Skill + MCP server that gives an LLM agent a **bounded primitive for reacting to Postgres row-changes** (and coordinating over Realtime broadcast channels) on Supabase. Deploys as an Edge Function. Ships pre-registered eval thresholds and four ADRs documenting the load-bearing tradeoffs.

The headline pattern is **agent-watches-database**: the agent calls a tool that blocks until either `max_events` arrive *or* `timeout_ms` elapses, then returns the batch. No streaming protocol, no persistent connection across tool-calls — fits MCP's request/response shape and Edge Function isolate budgets (Pro caps wall-clock at 150s; this caps tool timeout at 120s).

```mermaid
sequenceDiagram
  autonumber
  participant Agent
  participant MCP as MCP Tool<br/>(watch_table)
  participant Realtime as Supabase Realtime
  participant PG as Postgres

  Agent->>MCP: call watch_table<br/>{table, predicate, timeout_ms, max_events}
  MCP->>Realtime: subscribe(topic)
  Realtime-->>MCP: SUBSCRIBED ack
  Note over MCP,Realtime: bounded loop:<br/>collect events that match predicate<br/>until max_events OR timeout
  PG->>Realtime: row INSERT/UPDATE/DELETE
  Realtime-->>MCP: postgres_changes event
  PG->>Realtime: ...more events...
  Realtime-->>MCP: postgres_changes event
  alt max_events reached
    MCP-->>MCP: closed_reason = "max_events"
  else timeout_ms elapsed
    MCP-->>MCP: closed_reason = "timeout"
  end
  MCP->>Realtime: unsubscribe (always — finally)
  MCP-->>Agent: { events[], closed_reason }
  Agent->>Agent: process batch, decide next call
  Note over Agent: loop: call again, or stop
```

The "boundary" is the tool-call return — that's the natural checkpoint for an agent loop. Persistent WebSocket fights this model; bounded subscription embraces it.

The full narrative — what was tried, what failed, what landed, with the eval numbers — is in [`docs/writeup.md`](docs/writeup.md).

## Why this exists

Supabase's product direction in 2026 is *"agents running on Supabase, not just against."* Edge Functions, Automatic Embeddings, Agent Skills, MCP-on-Edge — all 2026 moves. The substrate to make agents react to Postgres CDC, with a shape that fits the Edge Function isolate model and respects RLS, didn't exist. This is that substrate.

This isn't a kitchen-sink wrapper. It's five tools, two primitives, one worked example, four eval metrics — opinionated and tight, with the surface area documented in nine references.

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

const { events, closed_reason } = await boundedWatch({
  adapter,
  table: "support_tickets",
  predicate: { event: "INSERT" },
  timeout_ms: 60_000,
  max_events: 10,
});
// events: Array<{ event, table, schema, new, old, commit_timestamp }>
// closed_reason: "max_events" | "timeout" | "error"
```

Deploy the MCP server as an Edge Function (live-verified):

```bash
supabase functions deploy mcp --project-ref <your-project>

# Verify with a JSON-RPC tools/list:
curl -X POST "https://<project-ref>.supabase.co/functions/v1/mcp" \
  -H "Authorization: Bearer <anon_or_service_role_key>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# → returns all 5 tools with input schemas
```

See [`references/edge-deployment.md`](references/edge-deployment.md) for full operator setup.

## What's in the box

| Tool | Shape |
|---|---|
| `watch_table` | bounded subscription to Postgres row-changes (INSERT / UPDATE / DELETE / *) |
| `broadcast_to_channel` | fire-and-forget broadcast on a Realtime channel; idempotent retry on 5xx |
| `subscribe_to_channel` | bounded subscription to a Broadcast channel (mirrors `watch_table`'s shape) |
| `list_channels` | best-effort registry listing |
| `describe_table_changes` | introspect columns, PK, RLS state, REPLICA IDENTITY |

All five over `WebStandardStreamableHTTPServerTransport` (MCP SDK 1.29+), per-request stateless. Five tools, intentionally tight — see [`SKILL.md`](SKILL.md) for what *not* to use them for.

## Eval results (latest ci-nightly, n=100, post-ADR-0009 with Sonnet 4.6)

| Metric | Result | Threshold (manifest v1.0.0) | Status |
|---|---|---|---|
| `latency_to_first_event_ms` p95 | **1281 ms** | ≤ 2000 ms | ✅ PASS |
| `missed_events_rate` | **0/100** (Wilson upper 0.0370) | rate ≤ 0.005, CI upper ≤ 0.01 | rate PASS, CI mechanically unreachable at n=100 — see ADR-0001 |
| `spurious_trigger_rate` | **0/100** (Wilson upper 0.0370) | rate ≤ 0.01, CI upper ≤ 0.03 | rate PASS, CI same as above |
| `agent_action_correctness` | **99/100, CI low 0.946** | rate ≥ 0.90, CI low ≥ 0.85 | ✅ PASS rate AND CI low |

Calibration sequence (each step in its own ADR; honest, attributable, isolable):

| Run | Model | Intervention | Rate | CI low |
|---|---|---|---|---|
| v0.1.0 baseline | Haiku 4.5 | recency proxy "retrieval" | 87/100 | 0.79 |
| v0.1.1 | Haiku 4.5 | real pgvector wiring | 90/100 | 0.83 |
| v0.1.2 (post-ADR-0002) | Haiku 4.5 | f019 ground-truth relabel | 94/100 | 0.875 |
| v0.1.3 (post-ADR-0006) | Haiku 4.5 | resolved-corpus enrichment | 96/100 | 0.902 |
| **v0.1.4 (post-ADR-0009)** | **Sonnet 4.6** | model swap | **99/100** | **0.946** |

Pre-registered in [`manifest.json`](manifest.json) at v1.0.0; gated via [`eval/runner.ts`](eval/runner.ts); v2.0.0 amendment to bump n→300 deferred per [ADR-0001](docs/decisions/0001-manifest-v1-stays-uncalibrated.md).

Run on demand (locally):

```bash
EVAL_SUPABASE_PAT=... EVAL_HOST_PROJECT_REF=... ANTHROPIC_API_KEY=... \
  bun run eval/runner.ts ci-nightly
# Cost ~$2-3, ~30 min wallclock against a transient Pro branch.
# Override the routing model with EVAL_TRIAGE_MODEL=claude-sonnet-4-6
# (default haiku-4-5).
```

Or via GitHub Actions (`workflow_dispatch`, requires the three secrets set on the repo):

```bash
gh workflow run ci-nightly.yml -R 0xquinto/supabase-realtime-skill
```

The cron schedule was dropped (`b49a1fc`) — daily runs against a substrate that doesn't change daily are cost burn for no signal. Methodology evidence is the workflow file + the run-on-demand path, not a calendar trigger.

Methodology: 4 metrics, binary scoring, Wilson 95% CIs, McNemar paired-test comparisons. No LLM-as-judge as a gate. See [`references/eval-methodology.md`](references/eval-methodology.md).

## Decisions + findings

The judgment trail. Each ADR carries a falsifiable predicted effect or a documented constraint. The calibration sequence above is one ADR per step — every gain attributable to one named intervention with its own paper trail. See [`docs/decisions/`](docs/decisions/) for the live index.

- [ADR-0001 — manifest v1 stays uncalibrated](docs/decisions/0001-manifest-v1-stays-uncalibrated.md). Wilson CI bounds at n=100 are mechanically unreachable; resist the urge to retroactively soften the gate. v2.0.0 amendment deferred to a versioned bump.
- [ADR-0002 — f019 seed relabel](docs/decisions/0002-f019-seed-relabel.md). The eval caught a mislabeled fixture (service-bug bucketed as `general`); relabeled with audit trail before re-running ci-nightly.
- [ADR-0003 — dual-path embedding provider](docs/decisions/0003-dual-path-embedding-provider.md). Canonical schema stays spec-compliant `halfvec(1536)` with OpenAI; eval falls through to `halfvec(384)` Transformers.js when `OPENAI_API_KEY` unset. Closes the spec deviation.
- [ADR-0004 — reshape T31 as user-feedback (proposed)](docs/decisions/0004-reshape-t31-as-user-feedback.md). Pre-T31 recon found the upstream maintainer's policy is monolith + references, not federation. Reshape pending operator decision.
- [ADR-0005 — Mousavi data-quality audit](docs/decisions/0005-fixture-corpus-data-quality-audit.md). Per-fixture audit on the 20 ci-fast seeds; 5% flaw rate (only f017 boundary-ambiguous), below the 10% repair threshold. Concordant with the eval's systematic-miss findings.
- [ADR-0006 — f017 cluster remediation](docs/decisions/0006-f017-cluster-remediation.md). Pre-registered prediction → ran → magnitude predictions missed by 1pp; hypothesis directionally supported. Honest "Accepted with caveats."
- [ADR-0007 — pre-staged v2.0.0 manifest design](docs/decisions/0007-pre-stage-v2-manifest-design.md). n=300 with tightened CI gates. Locks the calibration loop's next move without yet shipping the file.
- [ADR-0008 — comparative embedding eval (REJECTED)](docs/decisions/0008-comparative-embedding-eval-design.md). OpenAI 1536 vs MiniLM 384 paired-McNemar — byte-for-byte identical metrics at the Sonnet 4.6 model level. Hypothesis cleanly falsified; ADR-0003's dual-path is now empirically validated as a free choice.
- [ADR-0009 — multi-model probe result](docs/decisions/0009-multi-model-probe-result.md). Sonnet 4.6 closes 2 of 3 residual f017 misses + reverses ADR-0006's f010 drift. 99/100, CI low 0.946. Validates ADR-0007's pre-staged v2.0.0 thresholds as conservative.

Operational findings from the spike — 5s Realtime warm-up window, Deno bundler `.ts` extension policy, vitest workspace gotcha — live in [`docs/spike-findings.md`](docs/spike-findings.md).

The pre-T31 recon (whether to file the upstream issue) lives in [`docs/upstream/recon/2026-05-01-pre-t31-engagement-recon.md`](docs/upstream/recon/2026-05-01-pre-t31-engagement-recon.md). The Mousavi audit data lives in [`playbook/research/data-quality-audit.md`](playbook/research/data-quality-audit.md).

## Layout

- [`SKILL.md`](SKILL.md) — Open Skills Standard entry; three triggers + tools at a glance
- [`references/`](references/) — 9 opinionated patterns (predicates, RLS, replication identity, pgvector composition, eval methodology, edge deployment, presence-deferred, worked example, outbox forwarder)
- [`src/server/`](src/server/) — MCP server (5 tools) + bounded primitives + production adapters
- [`src/client/`](src/client/) — npm consumer barrel (boundedWatch + schemas + types)
- [`supabase/functions/mcp/`](supabase/functions/mcp/) — Edge Function entry (`WebStandardStreamableHTTPServerTransport`)
- [`eval/`](eval/) — regression harness with pre-registered thresholds + synthesizer + triage agent
- [`fixtures/`](fixtures/) — 20 hand-curated ci-fast seeds + 100 ci-nightly (20 seeds × 5 LLM-augmented variations)
- [`docs/writeup.md`](docs/writeup.md) — the headline narrative
- [`docs/decisions/`](docs/decisions/) — ADRs (see directory for the live index)
- [`docs/upstream/`](docs/upstream/README.md) — recon + spec + plan that produced this repo
- [`playbook/`](playbook/) — eval methodology backbone

## Engineering polish

- Dual ESM + CJS publish via `tsup` with `.d.ts` and `.d.cts` declarations
- npm publish via [OIDC Trusted Publisher](https://docs.npmjs.com/trusted-publishers/) (no `NPM_TOKEN` secret in CI; sigstore-signed provenance attestation on every release)
- ci-fast (PR-blocking) + ci-nightly (manual `workflow_dispatch`) split — full CI in [`.github/workflows/`](.github/workflows/)
- Strict TypeScript (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noExplicitAny`)

## License

Apache-2.0. See [LICENSE](LICENSE).

---

**Related work in this portfolio:** [`supabase-mcp-evals`](https://github.com/0xquinto/supabase-mcp-evals) — the methodology research repo whose `playbook/` is the methodology backbone for this artifact's eval discipline. The two repos share the playbook + foundation slices but ship independent artifacts.
