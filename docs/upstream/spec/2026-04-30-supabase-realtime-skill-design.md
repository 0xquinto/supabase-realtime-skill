# supabase-realtime-skill — design spec

**Date:** 2026-04-30
**Branch context:** `feat/portfolio-redesign` of `supabase-mcp-evals`
**Target repo (separate, to be created):** `supabase-realtime-skill` (standalone, published to GitHub + npm)
**Audience:** AI Tooling Engineer hiring panel at Supabase, then agent-system builders shipping production AI features on Supabase
**Recon trail:** [`docs/superpowers/recon/2026-04-30-portfolio-redesign-recon.md`](../recon/2026-04-30-portfolio-redesign-recon.md) (six recons; Recon 0 triggered the pivot, Recon 5 validated novelty)

---

## 1. Goal

Ship a TS-native **Agent Skill bundle paired with an MCP server** that gives an LLM agent the ability to **react to Postgres row-changes and coordinate over Realtime broadcast channels** on Supabase, deployed as an Edge Function, with eval instrumentation built in.

The headline pattern is **agent-watches-database**: the agent calls `watch_table` like any other tool, blocks for a bounded interval (timeout-fit for Edge Function isolate budgets), and receives matching row-changes when they happen — without any persistent WebSocket state across tool-calls.

This is a portfolio artifact for the AI Tooling Engineer JD (https://jobs.ashbyhq.com/supabase/14a99b8b-444b-4d28-b4fd-6fa8e71bcb4e). It demonstrates depth across the JD's hidden-weight bullets: MCP + Agent Skills together, Edge Functions deploy, eval-as-instrumentation, pgvector composition, judgment via writeup. Scope: ~3 weeks of focused work.

## 2. Why this artifact

Captured fully in the recon file. Compressed:

- **Eval-suite niche is crowded** (Recon 0): InsForge MCPMark v1/v2 publishes Supabase MCP numbers; Supabase ships first-party `braintrust-agent-eval` (March 2026). Building another eval suite is redundant.
- **Realtime/CDC artifact niche is empty** (Recon 1, 4, 5): no Supabase-native CDC MCP, no in-flight `supabase/agent-skills` proposal mentions Realtime/CDC at depth, no published artifact ships a Skill+MCP paired form factor. The official `supabase` skill names Realtime in scope but provides no dedicated sub-skill.
- **The on-direction reframe** (Recon 2): build artifacts that *consume* eval discipline as instrumentation, not eval suites that audit existing artifacts. Makes Supabase a platform for AI-native workflows.
- **JD weight uplift** (Recon 3): plain Realtime MCP server scored 45/90 against JD bullets; Skill+MCP paired on Edge Functions with eval instrumentation scored 70/90. The +25 points come from agent-skills as first-class, Edge Functions deploy explicitly, and tests/benchmarks signal.
- **Skill+MCP paired form factor is itself an open MCP-WG design question** (Recon 5, April 14 2026 office hours, `modelcontextprotocol/modelcontextprotocol#2585`). Pedro Rodrigues from Supabase was in the room. Shipping a worked-example pair contributes to that discussion rather than duplicating prior art.

## 3. Constraints (non-negotiable)

These come out of the locked recon decisions and must shape every architectural choice below.

- **TypeScript-native.** Deno-compatible for Edge Functions; CJS+ESM dual exports for the Skill helper library when consumed locally.
- **Open Skills Standard.** Skill bundle uses `SKILL.md` + `references/<topic>.md` layout matching `supabase/agent-skills` conventions.
- **Edge Functions runtime.** Deno isolate, no Node-only modules, wall-clock timeout ≤150s on Pro tier (cap our subscriptions at 120s to leave margin), cold-start budget matters.
- **Bounded subscription pattern, not persistent WebSocket.** `watch_table` and `subscribe_to_channel` block for ≤`timeout_ms` and return either when `max_events` matching events arrive or the timeout elapses. No state persists across tool-calls.
- **Server-side filters where Realtime supports them** (`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`); client-side fallback for the rest, documented in `references/predicates.md`.
- **Eval instrumentation is a first-class part of the bundle, not an afterthought.** Pre-registered metrics + thresholds in `manifest.json`; Wilson CIs on every reported rate; ci-fast (n=20) and ci-nightly (n=100) tiers.
- **Differentiate on depth, opinionated patterns, and worked agent examples** — not on broader scope (the official `supabase` skill already has broader coverage). The headline is *what an agent should do with these primitives*, not just *what the primitives are*.
- **Worked example must compose pgvector** (Automatic Embeddings substrate). This closes the JD's pgvector signal without overlapping Supabase's existing Automatic Embeddings flow.

## 4. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                    supabase-realtime-skill bundle                     │
│                                                                       │
│  ┌─────────────────────────────┐    ┌───────────────────────────┐    │
│  │  Skill (instruction layer)  │    │  MCP server (execution)   │    │
│  │  - SKILL.md                 │◄───┤  - 5 tools                │    │
│  │  - references/*.md          │    │  - Deno-compatible TS     │    │
│  │  - opinionated patterns     │    │  - bounded subscription   │    │
│  └─────────────────────────────┘    │  - Postgres-Changes /     │    │
│                                     │    Broadcast clients      │    │
│                                     └────────────┬──────────────┘    │
│                                                  │                    │
│  ┌──────────────────────────────────────────────▼─────────────────┐  │
│  │       Eval harness (Vitest + n=20/100 fixtures + manifest.json) │  │
│  │  - tool-level specs (offline + smoke against branch DB)         │  │
│  │  - worked-example regression (support-ticket triage agent)      │  │
│  │  - 4 pre-registered metrics with Wilson CIs                     │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ deploys to
                                    ▼
                      ┌─────────────────────────┐
                      │ Supabase Edge Function  │
                      │ (single MCP endpoint)   │
                      └─────────────────────────┘
```

Two layers, one bundle.

**Skill layer (instruction):** the *when* and *why*. `SKILL.md` declares trigger conditions (when an agent should reach for these tools); `references/*.md` carry the depth (predicate semantics, RLS implications, deferred Presence rationale, eval methodology, worked-example walkthrough).

**MCP server (execution):** the *how*. Five tools with strict input/output contracts. Deno-compatible TS so it runs unchanged in an Edge Function. The bounded-subscription pattern lives here.

**Eval harness:** layered. Tool-level Vitest specs gate the build (any tool regression = red CI). The worked-example regression suite reports the four pre-registered metrics with Wilson CIs and `manifest.json` thresholds — regression *blocks merge*.

The split is deliberate. The Skill teaches the agent; the MCP server lets it act; the harness keeps both honest. The JD line *"MCP, agent skills, and other interfaces"* reads as if the team treats them as separable but composable. This bundle ships a worked example of that composition.

## 5. Tool surface (5 tools)

Locked in brainstorm Q5. Presence deferred to v2 with rationale page in `references/presence-deferred.md`.

### 5.1 `watch_table(table, predicate, timeout_ms, max_events) → events[]`

Blocks until `max_events` matching row-changes are observed *or* `timeout_ms` elapses. Returns the batch of events received.

**Inputs:**
- `table: string` — schema-qualified or unqualified table name. Validated against `describe_table_changes` schema.
- `predicate: { event: 'INSERT' | 'UPDATE' | 'DELETE' | '*'; filter?: { column: string; op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in'; value: unknown } }`
- `timeout_ms: number` — bounded. Default 60000. Min 1000. **Max 120000** (leaves 30s margin under Pro's 150s isolate cap).
- `max_events: number` — bounded. Default 50. Min 1. **Max 200**.

**Output:** `{ events: { event, table, schema, new: Record<string, unknown> | null, old: Record<string, unknown> | null, commit_timestamp: string }[]; closed_reason: 'max_events' | 'timeout' }`

**Errors:**
- `INVALID_TABLE` — table doesn't exist or RLS blocks read access for the agent's role
- `INVALID_PREDICATE` — column or operator not supported by Postgres-Changes filters; falls back to client-side filter only when `references/predicates.md` flags the case
- `TIMEOUT_EXCEEDED_CAP` — agent passed `timeout_ms > 120000`

### 5.2 `broadcast_to_channel(channel, event, payload) → { success: boolean }`

Fire-and-forget broadcast. No retries from the agent's side; the server retries idempotently up to N=3 on 5xx.

**Inputs:**
- `channel: string` — channel name; namespace prefixing recommended (`agent:<workflow>:<step>`)
- `event: string` — event type identifier
- `payload: Record<string, unknown>` — JSON-serializable, ≤32KB

### 5.3 `subscribe_to_channel(channel, event_filter, timeout_ms, max_events) → broadcasts[]`

The receiving side, mirrors `watch_table`'s bounded shape.

**Inputs:** same shape as 5.1, but on a Broadcast channel rather than a table.

**Output:** `{ broadcasts: { channel, event, payload, received_at }[]; closed_reason: 'max_events' | 'timeout' }`

### 5.4 `list_channels() → channels[]`

Discoverability. Returns active channels the agent has presence-read access to (per RLS / channel auth).

**Output:** `{ channels: { name, member_count, last_event_at }[] }`

### 5.5 `describe_table_changes(table) → schema`

Schema introspection so the agent knows what columns it'll receive in `watch_table` events. Closes the "agent doesn't know schema until first call" gap.

**Output:** `{ table, schema, columns: { name, type, nullable, generated }[]; primary_key: string[]; rls_enabled: boolean; replication_identity: 'default' | 'full' | 'index' | 'nothing' }`

The `replication_identity` field is load-bearing for `UPDATE`/`DELETE` events: Postgres-Changes only emits the *new* row by default; consumers needing the *old* row need `REPLICA IDENTITY FULL`. The Skill's `references/replication-identity.md` page explains when to enable it and the storage cost.

## 6. Skill layer

### 6.1 `SKILL.md`

Front-matter + sections following `supabase/agent-skills` conventions.

```yaml
---
name: supabase-realtime
description: Use when an agent needs to react to Postgres row-changes or coordinate over Realtime broadcast channels on Supabase. Provides bounded subscription tools that fit Edge Function timeout budgets.
license: Apache-2.0
---
```

**Sections:**

1. **When to reach for this skill** — three triggers: (a) agent needs to act on a database event, (b) agent needs to fan out a result to other agents, (c) agent is the receiving side of a multi-agent workflow. Each trigger lists negative cases ("don't reach for this if X").
2. **Core pattern: bounded subscription** — one paragraph + the canonical loop. Explicitly contrasts with persistent WebSocket and explains why the bounded shape is the right primitive in agent context.
3. **Tools at a glance** — table mapping triggers to tools.
4. **Worked example: support-ticket triage** — link to `references/worked-example.md`.
5. **References** — pointer list to all `references/*.md`.

### 6.2 `references/`

```
references/
├── predicates.md          # which Postgres-Changes filter ops work, when to use client-side fallback
├── replication-identity.md # when to enable REPLICA IDENTITY FULL, storage tradeoffs
├── rls-implications.md    # RLS interactions with Postgres-Changes, broadcast auth, common pitfalls
├── presence-deferred.md   # why Presence is not in v1; the design questions left open
├── pgvector-composition.md # composing watch_table + Automatic Embeddings + pgvector retrieval
├── eval-methodology.md    # the 4 metrics, why these and not LLM-judge; cites this repo's playbook
└── worked-example.md      # support-ticket triage agent, end-to-end with code
```

Each page is self-contained and ≤2000 words. Depth carriers, not summaries.

## 7. Worked example: support-ticket triage agent

The worked example exists for two reasons: it carries the writeup's narrative weight (Q6 outline § 2), and it doubles as the regression-suite SUT (§ 8).

**Scenario.** A SaaS app has a `support_tickets` table. New tickets get auto-embedded via Supabase Automatic Embeddings (writes a `halfvec(1536)` to `embedding` column). The triage agent watches for new tickets, retrieves the top-K most-similar past resolved tickets via pgvector, decides routing (`urgent | engineering | billing | general`), writes the routing back to the row, and broadcasts a `ticket-routed` event so a downstream human-handoff agent picks it up.

**Schema.**

```sql
create table support_tickets (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null,
  subject text not null,
  body text not null,
  status text not null default 'open',
  routing text,
  embedding halfvec(1536),  -- populated by Automatic Embeddings
  created_at timestamptz default now()
);

create index on support_tickets using hnsw (embedding halfvec_cosine_ops);
alter table support_tickets replica identity full;  -- for UPDATE old-row payloads
```

**Agent loop (illustrative).**

```ts
// 1. Bounded watch for new tickets
const events = await mcp.call('watch_table', {
  table: 'support_tickets',
  predicate: { event: 'INSERT' },
  timeout_ms: 60000,
  max_events: 10,
});

for (const ev of events.events) {
  const ticket = ev.new;

  // 2. Retrieve K=5 most-similar past resolved tickets via pgvector
  const similar = await pg.query(
    `select id, subject, routing
     from support_tickets
     where status = 'resolved' and embedding is not null
     order by embedding <=> $1
     limit 5`,
    [ticket.embedding],
  );

  // 3. Decide routing (LLM call with the 5 examples in context)
  const routing = await llm.routeTicket(ticket, similar);

  // 4. Write routing back
  await pg.query(`update support_tickets set routing = $1 where id = $2`, [routing, ticket.id]);

  // 5. Broadcast for downstream handoff
  await mcp.call('broadcast_to_channel', {
    channel: `agent:triage:${routing}`,
    event: 'ticket-routed',
    payload: { ticket_id: ticket.id, routing, customer_id: ticket.customer_id },
  });
}
```

This composition is the headline. It uses **3 of the 5 tools** (`watch_table`, `broadcast_to_channel`, `describe_table_changes` implicitly via Skill guidance), the **pgvector retrieval-on-trigger pattern**, and **Automatic Embeddings as substrate** — all in one fixture. That same fixture grounds the regression suite.

## 8. Eval instrumentation

Locked in brainstorm Q3 as **C — layered, with pre-registered thresholds.**

### 8.1 Layer 1: tool-level Vitest

Each MCP tool gets:

- **Offline specs** (`tests/fast/`) — fabricated SDK messages, mocked HTTP. Asserts input validation, error mapping, payload shape. Runs in <2s per tool. Required to pass on every PR.
- **Smoke specs** (`tests/smoke/`) — real branch DB created via this repo's `ApiClient` + `withBranch`. Asserts end-to-end behavior against an actual Postgres + Realtime instance. Skips automatically when `EVAL_SUPABASE_PAT` / `EVAL_HOST_PROJECT_REF` missing.

Tool-level red CI = merge blocked. No exceptions.

### 8.2 Layer 2: worked-example regression suite

The support-ticket triage agent (§ 7) runs against fixture corpora and reports four metrics, each with Wilson 95% CI.

**Fixtures.** Two tiers in `fixtures/`:

- `fixtures/ci-fast/` — n=20, runs on every PR. Hand-curated for breadth (one fixture per routing category × happy-path/edge-case axis).
- `fixtures/ci-nightly/` — n=100, runs daily on `main`. Sampled from a synthetic-augmented corpus seeded by hand-labels (per playbook lesson — never synthetic-only).

Each fixture: `{ id, ticket: { subject, body }, expected_routing, ground_truth_top_k_ids }`.

**The 4 metrics.**

| Metric | Definition | Pre-registered threshold |
|---|---|---|
| `latency_to_first_event_ms` | p95 from fixture `INSERT` to agent's `watch_table` returning the row | **p95 < 2000ms** on Supabase Pro pooler |
| `missed_events_rate` | Fraction of fixture inserts the agent never observed (timeout closed before the event arrived) | **< 1%** at n≥100 with Wilson CI upper bound also <1% |
| `spurious_trigger_rate` | Fraction of agent actions taken when no qualifying event fired (over-eagerness in CDC domain) | **< 2%** with Wilson CI upper bound <3% |
| `agent_action_correctness` | Did the agent route to the labeled `expected_routing`? | **≥ 90%** at n≥100 with Wilson CI lower bound ≥85% |

These thresholds are *pre-registered* — committed into `manifest.json` and version-controlled. Per the playbook lesson (slice-3, codified from arXiv:2604.25850): every recommendation ships with a falsifiable predicted effect. Threshold *changes* require a versioned manifest bump explained in the PR body, not silent edits.

**Statistical design notes** (per `playbook/PLAYBOOK.md` § 9):

- All cross-version comparisons are **paired** (same fixture IDs, McNemar's test for binary metrics). Not Welch's t-test.
- ci-fast n=20 is too small for a non-paired design; only valid here because it's paired and we treat it as a *gate*, not a hypothesis test.
- ci-nightly n=100 + paired = MDE ~0.10 on `agent_action_correctness`. Sufficient to catch a 10-point regression with α=0.05 / β=0.20.

### 8.3 Why these 4 metrics, and not LLM-judge

Direct lift from `playbook/PLAYBOOK.md` § 8 anti-pattern *"LLM-judge without ground-truth alignment."* The four metrics above are computed against either deterministic ground truth (events that did or didn't fire — observed by the harness, not judged) or hand-labeled ground truth (`expected_routing` per fixture). LLM-judge enters only as a side-channel `routing_explanation_quality` advisory, not as a gate.

This is documented in `references/eval-methodology.md` as a **`> Why not LLM-judge as a gate?`** aside. JD signal: judgment about fragile/gimmicky.

## 9. Edge Functions deployment

Single Edge Function endpoint `mcp/`. Bundled as a Deno-compatible TS module via `npm:@modelcontextprotocol/sdk` (Deno-compatible from supabase/mcp-on-edge templates).

**Operational pattern.**

- `Authorization: Bearer <session-jwt>` propagates the agent's calling identity into Postgres via `auth.uid()` — RLS applies to `watch_table` reads natively.
- Each tool-call is a single isolate invocation. No state is preserved between calls. The bounded-subscription primitive is what makes this stateless deployment possible.
- Cold-start cost is amortized: the Realtime client connection establishment happens inside the isolate's first 200-400ms; subscription wall-clock starts thereafter. The harness's `latency_to_first_event_ms` p95 threshold (2000ms) is set to absorb cold-start.

**`references/edge-deployment.md`** carries the operator setup: `supabase functions deploy mcp`, expected env vars, JWT issuance pattern for agent identity.

## 10. Repo layout

Standalone repo `supabase-realtime-skill`:

```
supabase-realtime-skill/
├── SKILL.md
├── README.md
├── package.json              # ESM+CJS dual exports for the helper library
├── manifest.json             # eval thresholds (pre-registered, version-controlled)
├── references/
│   ├── predicates.md
│   ├── replication-identity.md
│   ├── rls-implications.md
│   ├── presence-deferred.md
│   ├── pgvector-composition.md
│   ├── eval-methodology.md
│   ├── edge-deployment.md
│   └── worked-example.md
├── src/
│   ├── server/               # MCP server: 5 tools, schemas, Deno-compatible
│   ├── client/               # TS helper for consuming the bundle locally (CJS+ESM)
│   └── types/                # shared zod schemas + TS types
├── supabase/
│   └── functions/
│       └── mcp/
│           └── index.ts      # Edge Function entry, imports src/server/
├── fixtures/
│   ├── ci-fast/              # n=20 hand-curated
│   └── ci-nightly/           # n=100 hand-seeded + synthetic-augmented
├── tests/
│   ├── fast/                 # offline Vitest, mocked HTTP/SDK
│   └── smoke/                # online Vitest, real branch DB
├── eval/
│   ├── runner.ts             # spawns agent loop against fixtures, reports metrics
│   ├── metrics.ts            # Wilson CI, McNemar, threshold checks
│   └── reports/              # gitignored output dir; ci-nightly artifacts uploaded elsewhere
├── docs/
│   └── writeup.md            # the headline writeup (Q6 outline)
└── .github/workflows/        # ci-fast on PR, ci-nightly cron, npm publish on tag
```

**Reuse from `supabase-mcp-evals`:** the eval harness (`src/foundation/`) is repurposed as the eval backbone — `ApiClient`, `withBranch`, `runSample`, `aggregateRate`, `wilsonInterval`, `parseTranscript`, `ToolCallMatcher`. The standalone repo declares this repo as the *origin* of the methodology in `references/eval-methodology.md` and links to specific files (e.g. `playbook/PLAYBOOK.md` § 9 for statistical design heuristics, `playbook/research/construct-validity.md` for Bean's 8). Discipline backbone, cited; not headline narrative.

## 11. Writeup

Locked in brainstorm Q6 — persona is **agent-system builder**, with **Supabase platform engineer asides**. Lives at `docs/writeup.md` in the standalone repo.

**Outline** (≤4000 words target):

1. **The pattern** (1-2 paragraphs) — agent-watches-DB as a primitive; why Edge Functions makes it deployable; why Skill+MCP paired is the right shape (links to `modelcontextprotocol/modelcontextprotocol#2585`).
2. **Worked example walkthrough** — the support-ticket triage agent end-to-end with code. Reads as the *user's* tutorial, not the candidate's resume.
3. **`> Why not X?` asides** scattered through:
   - Why not persistent WebSocket?
   - Why bounded subscription with timeout caps?
   - Why Presence deferred to v2?
   - Why pgvector via Automatic Embeddings substrate, not a custom embedding flow?
   - Why these 4 metrics and not LLM-judge?
4. **Eval results** — the 4 metrics on the worked example, with Wilson CIs and `manifest.json` thresholds; pre-registered direction/magnitude per the playbook lesson; one paragraph on what the numbers *don't* tell you (construct-validity caveat per Bean's checklist).
5. **What's not in v1 and why** — Presence, server-side WebSocket auth, custom-channel-broker patterns. Each gets a sentence on the design question that needs to be settled before shipping.

The writeup *is* the JD's "judgment about fragile/gimmicky" signal (Recon 3 hidden weight). Every aside is a chance to name something tried and rejected. The `>` callouts make them skimmable.

## 12. Three-week scope (spike-first)

The shape is **spike-first**: Week 1 proves the load-bearing architectural assumption (bounded-subscription primitive working inside an Edge Function against a real branch DB) before any of the mechanical work depends on it. If the spike hits a snag — Edge Functions cold-start eats too much budget, Realtime client reconnect fights the bounded shape, RLS auth-context propagation needs a workaround — that's a Week 1 finding that triggers a real redesign, not a Week 2 cascade.

| Week | Deliverables |
|---|---|
| **Week 1 — spike + adjacent docs** | (a) Bounded-subscription primitive end-to-end against a real branch DB: `watch_table` only, deployed as an Edge Function, measured `latency_to_first_event_ms` p95 against §8.2's 2000ms threshold. (b) `references/predicates.md` + `references/replication-identity.md` written *as the constraints are discovered*, not after — these inform the primitive's design. **Success = primitive works in production-shaped deployment; if it doesn't, redesign before Week 2.** |
| **Week 2 — mechanical scale-out** | The other 4 tools (`broadcast_to_channel`, `subscribe_to_channel`, `list_channels`, `describe_table_changes`) with shared zod schemas + offline Vitest + smoke specs; full Edge Function deployment skeleton + JWT auth wiring; `references/rls-implications.md`; `SKILL.md` v1; `references/presence-deferred.md`. By end of week: all 5 tools green on offline + smoke. |
| **Week 3 — worked example + eval + writeup + ship** | Worked example: support-ticket triage agent + Automatic Embeddings setup + pgvector retrieval; `references/pgvector-composition.md` + `references/worked-example.md` + `references/eval-methodology.md` + `references/edge-deployment.md`; eval runner + ci-fast n=20 + ci-nightly n=100 (hand-seeded + synthetic-augmented); `manifest.json` thresholds; CI integration (PR + nightly); `docs/writeup.md`; npm publish; post-launch upstream issue on `supabase/agent-skills`. |

**Why spike-first** (recon-5 confirms no one ships this — no public reference implementation to copy):
- The novel primitive is `watch_table` end-to-end inside an Edge Function. If this doesn't work cleanly, every other deliverable inherits the breakage.
- The mechanical work (4 tools + scaffolding + remaining reference pages) is bounded by typing speed; the spike is bounded by reality.
- Week 1 deliverables look lighter by *count*, but the success criterion is measurable (primitive works; p95 < 2s) — progress is evidenced by the primitive, not by volume.
- Worst case (spike fails): Week 1's discoveries reshape the architecture (e.g., webhook-push as primary pattern, or thin Edge Function proxy to a long-lived Realtime worker). Better to absorb that early than discover it in Week 2 with 4 tools already mis-shaped.

**Out of scope for v1** (named, with reasons, in `references/presence-deferred.md` + writeup § 5):

- Presence tools (semantics for *agents* vs human users not settled)
- Server-side WebSocket auth (depends on JWT issuance pattern beyond agent identity)
- Custom-channel-broker (overlaps Broadcast; would need a clear differentiation story)
- LLM-judge integration (anti-pattern per playbook; advisory only)

## 13. Success criteria

The artifact ships well if all four hold:

1. **Tool-level CI green and stable** for ≥1 week on `main` after launch.
2. **All 4 metric thresholds met** on the ci-nightly suite at n=100.
3. **Writeup demonstrates ≥5 named tradeoffs** (the `> Why not X?` asides) with concrete reasoning.
4. **Upstream issue opened on `supabase/agent-skills`** proposing this as a sub-skill, with at least one substantive maintainer response (positive, negative, or in-discussion all count — what we want is signal that a Supabase engineer engaged with the artifact).

Of these, #4 is the JD-load-bearing one. #1-3 prove the artifact works; #4 proves the artifact lands.

## 14. Risks and unknowns

- **Edge Function timeout cap may be tighter than 150s in practice.** Mitigation: 120000ms (120s) `timeout_ms` cap leaves 30s margin; runtime check returns `TIMEOUT_EXCEEDED_CAP` rather than failing late.
- **Realtime Postgres-Changes filter expressiveness is narrower than full SQL.** Mitigation: `references/predicates.md` lists what works server-side and what falls back client-side; `watch_table` validates and rejects upfront.
- **Replication identity caveat may surprise users.** Mitigation: `describe_table_changes` exposes `replication_identity` so the agent (or human reading the docs) sees the constraint before hitting it.
- **3-week budget assumes no Edge Function runtime surprises.** Mitigation: Week 1 ends with a working bounded subscription against a real branch — if that slips, scope can shed the second worked example fixture tier without losing the headline.
- **Visibility risk: artifact ships but Supabase team doesn't notice.** Mitigation: post-launch upstream issue on `supabase/agent-skills` (success criterion #4) creates a direct signal channel; recon 5 confirmed Pedro Rodrigues is actively engaged on adjacent threads.

## 15. Non-goals

- **Not** a generic agent-watches-database framework. Supabase-native is the differentiator.
- **Not** a competitor to `braintrust-agent-eval` or InsForge MCPMark. The eval instrumentation here serves the bundle's regression suite, not external auditing.
- **Not** a research methodology contribution. The playbook + research in this `supabase-mcp-evals` repo is the discipline backbone, cited not headlined.
- **Not** a multi-skill bundle. v1 covers Realtime/CDC + Broadcast only. Auth/RLS and pgvector get their own potential skills later, in separate artifacts.
