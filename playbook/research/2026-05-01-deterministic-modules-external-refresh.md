# External research refresh — deterministic modules / `boundedQueueDrain` (2026-05-01)

**Purpose:** Durable record of the 5-min refresh sweep that fed ADR-0010. Mirrors the supabase-mcp-evals pre-registered-targets pattern: searches run, what was checked, what landed in the ADR, and what's still open. Audit trail so the ADR's external-claims section can be re-derived without re-running the searches.

> **Note on versioning:** bare `v0.2` / `v0.3` references in this doc are **npm package** versions; `v2.0.0` references are the **`manifest.json`** eval-thresholds file. Two parallel streams — disambiguation at [ADR-0010 § Note on versioning](../../docs/decisions/0010-bounded-queue-drain.md).

**Frame:** Pre-recon ([`docs/recon/2026-05-01-deterministic-modules-recon.md`](../../docs/recon/2026-05-01-deterministic-modules-recon.md)) flagged three open questions for "the ADR pass to refresh." This file captures that refresh.

---

## Three questions the recon deferred to this refresh

1. Restate / Hatchet / Cloudflare Durable Objects' recent (Q1-Q2 2026) agent offerings — anyone shipped a queue-drain primitive specifically?
2. Is `pg_logical_emit_message()` available on Supabase Pro? (Affects whether the no-table CDC variant is a viable v0.3 alternative shape.)
3. Has the supabase/agent-skills maintainer published unreleased design intent that would change positioning?

Q3 is unknowable without operator outreach (it's an "is there a doc you haven't published" question). Filed open. The refresh below addresses Q1 + Q2 only.

---

## Searches run (via `mcp__claude_ai_Exa__web_search_advanced_exa`, 2026-05-01)

| # | Query | Filter | n | Tool result file |
|---|---|---|---|---|
| 1 | `Restate durable execution AI agents announcement 2026 features` | `startPublishedDate=2026-01-01`, `enableSummary=true` | 5 | `tool-results/toolu_01KbQV5UhJ3Ccm1bTFMoGod3.json` |
| 2 | `Hatchet workflow engine AI agent durable queue announcement 2026` | `startPublishedDate=2026-01-01`, `enableSummary=true` | 5 | `tool-results/toolu_01TiDDRSiwiy7agBiZVHSmy4.json` |
| 3 | `Cloudflare Durable Objects AI agents primitive 2026` | `startPublishedDate=2026-01-01`, `enableSummary=true` | 5 | `tool-results/toolu_01HpomeEyGVDuYAh7joqa8E9.json` |
| 4 | `pg_logical_emit_message Postgres logical replication function support Supabase` | `enableSummary=true` | 5 | `tool-results/toolu_016UYZGSN3hFHuyEyQWzbuDs.json` |

Tool result JSONs are session-scratch and not checked in; the headlines + URLs below are the durable record.

---

## Findings — Q1 (Restate / Hatchet / Cloudflare DO)

### Cloudflare — biggest delta against the recon

The recon's "5-min refresh worth doing" caveat was right. Cloudflare shipped two material things in Q1-Q2 2026:

- **[PR #1256 — `cloudflare/agents` "Unified fiber architecture: durable execution baked into Agent"](https://github.com/cloudflare/agents/pull/1256)** (2026-04-04, threepointone, merged) — Adds `Agent.runFiber(name, fn)` to the base Agent class. Survives DO eviction, code deploys, alarm timeouts. Stores durable execution rows in `cf_agents_runs`, AsyncLocalStorage-based checkpointing (`stash`), `onFiberRecovered` hooks. Makes durable LLM streaming a built-in: set `durableStreaming = true` and chat turns survive eviction with provider-aware recovery (OpenAI server-side `store: true`, Anthropic synthetic continuation, Workers AI inline).
- **[Project Think](https://blog.cloudflare.com/project-think/)** (2026-04-15 launch) — Cloudflare's branded durable-AI-agents push. Crash recovery + checkpointing + automatic keepalive, sub-agents with isolated SQLite state, persistent tree-structured sessions with forking/compaction/full-text search, sandboxed code execution (codemode + npm resolution), self-authored extensions.
- **[PR #1029 — `keepAlive()`](https://github.com/cloudflare/agents/pull/1029)** (2026-03-01, threepointone, merged) — Earlier piece of the same arc. 30s heartbeat to prevent ~70-140s idle eviction during long-running work.

**Read against the ADR:** Workflow-side durability, not substrate-side. Cloudflare is making the *agent's reasoning loop* durable; this artifact is making *the database events the agent observes* deterministic and bounded. They compose orthogonally — a `runFiber()`-wrapped agent could call `boundedQueueDrain` from inside its fiber and gain both kinds of durability. **The orthogonality is the thesis the ADR leans on**, not a hand-wave.

What's bigger than the recon assumed: Cloudflare named the pattern (`runFiber`) and shipped it as a single primitive on a single class. That's evidence that "deterministic primitive on a managed substrate" is the right packaging shape — Cloudflare did exactly that for the workflow layer; the ADR proposes the analogue for the substrate layer.

### Restate — closest neighbor on the tool-side

- **[Restate v1.6.0](https://github.com/restatedev/restate/releases/tag/v1.6.0)** (2026-01-30) — Pause/resume invocations, restart from journal prefix, idempotent deployment registration, Azure Blob + GCS snapshot support. Workflow-level. Same neighborhood as Inngest.
- **[Restate v1.6.1](https://github.com/restatedev/restate/releases/tag/v1.6.1)** (2026-02-10) — Memory + stability fixes; lazy loading on replay; periodic GC; OTEL_RESOURCE_ATTRIBUTES support. Bug-fix release.
- **[OpenAI Agents SDK PR #2359 — Restate integration docs](https://github.com/openai/openai-agents-python/pull/2359)** (2026-01-23) — `DurableRunner` persists LLM responses; `@durable_function_tool` decorator makes tool execution durable; `restate_context().run_typed()` for retry/persistence/replay; HTTP endpoint for agent invocation. Tool-side durability.
- **[pydantic-ai PR #5041 — Restate integration page](https://github.com/pydantic/pydantic-ai/pull/5041)** (2026-04-10) — External-package integration (not built-in). Durable sessions, resilient HITL, durable RPC.
- **[LinkedIn — "Deep research agents with Restate"](https://www.linkedin.com/posts/restatedev_deep-research-agents-with-restate-restate-activity-7444400761028984834-ZRf6)** (2026-03-30) — Sub-agents as RPC handlers; durable orchestrator plans + worker results.

**Read against the ADR:** Tool-side durability (`@durable_function_tool`) is genuinely complementary — a `boundedQueueDrain` invocation could itself be wrapped as a Restate-durable tool with no surface conflict. Worth name-checking; doesn't change the design. Restate has not shipped a substrate-side queue-drain primitive.

### Hatchet — closest neighbor on the broker-side

- **[gregfurman/hatchet (fork) — README](https://github.com/gregfurman/hatchet)** (2026-01-26 fork from hatchet-dev/hatchet) — "Run Background Tasks at Scale." Durable PG-backed task queue, observability, real-time dashboard, CLI. Most directly outbox-shaped neighbor.
- **[Hatchet PR #3255 — MCP runtime API](https://github.com/hatchet-dev/hatchet/pull/3255)** (2026-03-12) — `POST /api/mcp-runtime` exposing live Hatchet data (runs, workers, workflows, queue metrics) to agents. Read tools: `list_workflows`, `list_runs`, `get_run`, `search_runs`, `get_queue_metrics`, `list_workers`. Optional write tools (env-gated): `cancel_run`, `replay_run`. Tenant-scoped via JWT.
- **[Hatchet v0.83.30 release](https://github.com/hatchet-dev/hatchet/releases/tag/v0.83.30)** (2026-04-21) — CLI release; install + verify; SBOM artifacts. No new agent-pattern content.
- **[Hatchet @ Go pkg.go.dev v0.83.25](https://pkg.go.dev/github.com/hatchet-dev/hatchet@v0.83.25)** (2026-04-27) — Durable queues, task chaining, retries/backoff, dashboards.

**Read against the ADR:** Hatchet is the closest shape match — durable PG-backed task queue, agents observe it via MCP. But Hatchet is a **separate platform you adopt** (Hatchet's own DB or cloud, Hatchet's own workers, Hatchet's own runtime). This artifact's positioning is the inverse: **a primitive on Supabase substrate the user already has**, no new platform. Different value proposition, same neighborhood. The ADR cites Hatchet PR #3255 specifically to acknowledge the closest-neighbor relationship without conflating the positionings.

### Headline against the recon's claim

The recon stated: *"Bounded primitive + CDC-style drain + falsifiable eval contract appears to be unclaimed ground."* The refresh confirms this. Cloudflare/Restate/Hatchet all ship workflow-level or broker-level durability; **none ship a substrate-side bounded primitive on a managed BaaS substrate with a manifest-gated eval contract**. The unclaimed-ground claim survives the refresh.

---

## Findings — Q2 (`pg_logical_emit_message` on Supabase Pro)

Search returned standard Postgres docs + Supabase replication-setup pages but **no authoritative confirmation** that `pg_logical_emit_message()` is callable on Supabase Pro:

- [PostgreSQL 15 Architecture — Logical Replication](https://www.postgresql.org/docs/15/logical-replication-architecture.html) — `pg_logical_emit_message` is "a function used by logical replication to emit a logical decoding message to the output plugin." Not described as a user-facing utility for general use. Standard Postgres function (no extension required).
- [Supabase Docs — Setup external replication](https://supabase.com/docs/guides/database/postgres/setup-replication-external) — Documents `pg_create_logical_replication_slot('example_slot', 'pgoutput')` as callable on Supabase. **Does not mention `pg_logical_emit_message`.**
- [Supabase Docs — Replication overview](https://supabase.com/docs/guides/database/replication) — General replication intro.
- [Supabase Realtime — Postgres CDC](https://supabase.com/docs/guides/realtime/postgres-cdc) — Standard subscribe/publication setup.
- [Supabase GH discussion #20925](https://github.com/orgs/supabase/discussions/20925) — Issues replicating to other DBs with CDC tools (community thread).

**Indirect evidence:** Supabase Pro grants the privileges to create logical replication slots (`pg_create_logical_replication_slot` is documented as callable). `pg_logical_emit_message` is part of standard Postgres core (no extension required, function-level GRANT not typically restricted). **Most likely available**, but the search did not return a Supabase doc page or community confirmation that nails this down.

**Read against the ADR:** Not load-bearing for v0.2 (the proposed module composes `boundedWatch` + `handleBroadcast` + SQL ack, no `pg_logical_emit_message` involvement). Treated as an open verification for the **v0.3 no-table CDC variant** if that path is pursued. ADR-0010 § "What changed since the recon" point 4 documents this as a v0.3-only verification.

**Recommended verification when v0.3 is pursued:** 60-second test on a fresh Supabase Pro branch — `select pg_logical_emit_message(true, 'test', 'hello');` against an active logical slot. If it returns a LSN, it's available. If it errors with permission-denied or function-not-found, it's not. Cheaper than guessing.

---

## What landed in ADR-0010 (the contract this file underwrites)

ADR-0010 cites exactly five external URLs from this refresh in its "What changed since the recon" section + References:

1. [`cloudflare/agents` PR #1256](https://github.com/cloudflare/agents/pull/1256) — for orthogonality framing
2. [Cloudflare Project Think](https://blog.cloudflare.com/project-think/) — for "durable AI agents launch" context
3. [Restate v1.6.0 release](https://github.com/restatedev/restate/releases/tag/v1.6.0) — for workflow-level durability framing
4. [OpenAI Agents SDK PR #2359](https://github.com/openai/openai-agents-python/pull/2359) — for `@durable_function_tool` (tool-side complement)
5. [Hatchet PR #3255](https://github.com/hatchet-dev/hatchet/pull/3255) — for closest-neighbor disclosure

The other URLs in this file (Restate v1.6.1, pydantic-ai #5041, Hatchet release pages, the Cloudflare `keepAlive` PR, the Postgres replication architecture page) are evidence that supports the ADR's claims but were not cited individually. They live here as the audit trail: if a reader wants to verify "Cloudflare's durable-agent push is bigger than just one PR" or "Restate's tool-side durability is real and not just a marketing post," the supporting links are above.

---

## What's still open

- **Q3 from the recon** — whether `supabase/agent-skills` maintainers have unpublished design intent. Unknowable without operator outreach. Tracked under T31 / [ADR-0004](../../docs/decisions/0004-reshape-t31-as-user-feedback.md).
- **Q2 verification** — `pg_logical_emit_message` on Supabase Pro. Cheap to verify when v0.3 is pursued; not blocking v0.2.
- **The Restate / pydantic-ai integration is "third-party not built-in"** ([PR #5041](https://github.com/pydantic/pydantic-ai/pull/5041) — review comment noted this). Doesn't change the ADR but worth noting for any v0.3 framing of "durable tool wrappers vs deterministic primitives."

---

## References

**ADR + recon:**
- [ADR-0010 — `boundedQueueDrain`](../../docs/decisions/0010-bounded-queue-drain.md) — the decision this refresh underwrites
- [Recon 2026-05-01](../../docs/recon/2026-05-01-deterministic-modules-recon.md) — the deferred-questions source

**External (full URL list):**
- [Cloudflare Agents PR #1256 — runFiber](https://github.com/cloudflare/agents/pull/1256)
- [Cloudflare Agents PR #1029 — keepAlive](https://github.com/cloudflare/agents/pull/1029)
- [Cloudflare — Project Think](https://blog.cloudflare.com/project-think/)
- [youngju.dev — Cloudflare Agents + DO guide](https://www.youngju.dev/blog/ai-platform/2026-04-12-cloudflare-agents-durable-objects-guide.en)
- [Restate v1.6.0 release](https://github.com/restatedev/restate/releases/tag/v1.6.0)
- [Restate v1.6.1 release](https://github.com/restatedev/restate/releases/tag/v1.6.1)
- [OpenAI Agents SDK × Restate — PR #2359](https://github.com/openai/openai-agents-python/pull/2359)
- [pydantic-ai × Restate — PR #5041](https://github.com/pydantic/pydantic-ai/pull/5041)
- [Restate — Deep research agents (LinkedIn)](https://www.linkedin.com/posts/restatedev_deep-research-agents-with-restate-restate-activity-7444400761028984834-ZRf6)
- [Hatchet (fork README — gregfurman)](https://github.com/gregfurman/hatchet)
- [Hatchet PR #3255 — MCP runtime](https://github.com/hatchet-dev/hatchet/pull/3255)
- [Hatchet v0.83.30 release](https://github.com/hatchet-dev/hatchet/releases/tag/v0.83.30)
- [Hatchet @ pkg.go.dev v0.83.25](https://pkg.go.dev/github.com/hatchet-dev/hatchet@v0.83.25)
- [PostgreSQL 15 — Logical Replication Architecture](https://www.postgresql.org/docs/15/logical-replication-architecture.html)
- [Supabase Docs — Setup external replication](https://supabase.com/docs/guides/database/postgres/setup-replication-external)
- [Supabase Realtime — Postgres CDC](https://supabase.com/docs/guides/realtime/postgres-cdc)

**Supplementary URLs cited by ADR-0010, sourced from the recon (not from this 2026-05-01 refresh sweep — included here so the audit trail is self-contained):**
- [Anthropic — Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — the deterministic-contract quote + `schedule_event` example
- [Anthropic — Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) — skill-module pattern
- [Anthropic — Equipping agents with Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — incremental skill build via evaluation
- [Decodable — Revisiting the Outbox Pattern](https://www.decodable.co/blog/revisiting-the-outbox-pattern) — CDC-vs-outbox-table critique informing the naming
- [Debezium Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html) — canonical schema + ordering semantics
- [Inngest — Durable Execution](https://www.inngest.com/blog/durable-execution-key-to-harnessing-ai-agents) — adjacent / complementary primitive (workflow-side)
- [event-driven.io — Push-based outbox](https://event-driven.io/en/push_based_outbox_pattern_with_postgres_logical_replication/) — log-based replication tradeoffs
- [Supabase Queues / pgmq blog](https://supabase.com/blog/supabase-queues) — platform queueing stance (informs v0.3 pre-stage)
- [supabase/agent-skills repo](https://github.com/supabase/agent-skills) — current skill catalog gap (relevant to T31 / ADR-0004)
