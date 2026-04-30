# Portfolio-redesign reconnaissance — 2026-04-30

Six recons (one pre-branch trigger + four forked agents + one direct sweep) that informed the pivot from "evidence-track slice on supabase-mcp" to "MCP-on-Edge-Functions Agent Skill in an empty niche." Captured here so the decision trail is auditable.

**Branch:** `feat/portfolio-redesign`
**Why this exists:** the prior portfolio direction (build evals on supabase-mcp) was anchored on what was already in this repo, not on the actual landscape. This recon corrected that.

---

## Recon 0 — Eval-suite-niche scan (the recon that triggered the pivot)

**Question:** is anyone already running serious public evals on the Supabase MCP server? If so, the "evidence-track slice on supabase-mcp" portfolio direction is redundant.

**Context:** dispatched *before* this branch existed, while the working assumption was still "ship slice-4 + maintainer-recommendations doc as headline." The findings here are what forced the entire portfolio redesign.

**Verdict: Crowded — multiple serious public efforts exist.**

**Concrete prior art found:**

- **InsForge MCPMark** (v1 + v2) — published numbers on Supabase MCP: Pass⁴ 33.33%, Pass@4 66.67%, Pass@1 47.62%. Not a one-off; an active benchmark with multiple versions and explicit Supabase coverage.
- **`supabase/braintrust-agent-eval`** (March 2026) — *first-party*. Supabase ships their own A/B harness comparing agent behavior with vs without the MCP server, wired to Braintrust. This is what "eval-first as product instrumentation" looks like in their stack today.
- **mcp.run March Madness** — community bracket benchmarking MCP servers, Supabase included.
- **Generic MCP frameworks that include Supabase coverage:** MCPMark, MCP-Bench, LiveMCPBench, MCP-Atlas. Not Supabase-specialized but the SUT is in scope.

**Implications that broke the prior direction:**

1. The "outside auditor running evals on the supabase-mcp" framing competes head-on with `braintrust-agent-eval`, which is *first-party and already shipping*. A candidate framing themself as the eval-builder reads as redundant rather than complementary.
2. Whatever methodology this repo's playbook + 6 research passes synthesized is not a unique contribution to the eval space — it is *adjacent* to a well-funded first-party effort, and the headline value isn't methodology novelty.
3. The on-direction reframe is **building artifacts that consume eval discipline as instrumentation**, not building eval suites that audit existing artifacts. That single inversion drove the rest of the redesign (recons 1–5).

**What this recon retracted:**

- "Evidence-track slice on supabase-mcp as headline" — drop
- "Maintainer-recommendations doc" — demote to opportunistic side artifact
- "Playbook + 6 research passes as portfolio narrative" — reframe as discipline backbone, not headline

---

## Recon 1 — Supabase-adjacent MCP server space

**Question:** which Supabase-adjacent MCP server niches are saturated, partial, or empty?

**Verdict:**

- **Empty:** Realtime/subscriptions MCP (no published serious entry); Auth/RLS-policy management MCP (no dedicated server)
- **Partial:** pgvector-RAG MCP for Supabase (~10 weak attempts but no canonical Supabase-native entry)
- **Saturated, avoid:** Storage MCP (2 production-ready entries), Migration/schema (official + Postgres-MCP-Pro), Branching (official), Edge Function management (official), Edge Function BYO templates (3+ competing), Dashboard-assistant style (Supabase official)

**Top recommendation from this recon:** Realtime MCP — the only genuinely empty niche with both customer-facing appeal and Postgres/realtime depth.

---

## Recon 2 — Supabase ecosystem AI tooling broader

**Question:** where is Supabase's AI gravity? What's their product direction in 2026?

**Three dominant themes:**

1. **"Make Supabase a platform for AI-native workflows"** — agents and AI features run *on* Supabase, not just *against* it. Recent: Edge Functions AI API, MCP-on-Edge-Functions (`mcp-lite`, `byo-mcp`), Automatic embeddings, Platform Kit (April 2026). The JD names this verbatim: "MCP on Edge Functions", "agents running on Edge Functions".
2. **"Make agents work *correctly* against Supabase"** — agent-correctness as a product axis. April 2026 blog "AI Agents Know About Supabase. They Don't Always Use It Right." Product responses: MCP server, Agent Skills (Jan-Apr 2026, 2k stars, only 2 skills shipped), AI Prompts (curated for 7+ AI editors), Dashboard Assistant `load_knowledge` lazy-loading.
3. **"Eval-first as a stated team value"** — JD elevates "eval-first mindset" to lead paragraph. `braintrust-agent-eval` (March 2026) is A/B tied to product outcomes (control = no MCP, treatment = with MCP). They want eval *as product instrumentation*, not eval as research artifact.

**Verdict:** the on-direction artifact shape is "helps developers ship AI features *on* Supabase faster and more correctly," not "evaluates Supabase from the outside." A pure eval suite competing with `braintrust-agent-eval` reads as redundant. The unfilled gravity is in MCP-on-Edge-Functions / agents-on-Edge-Functions / Agent Skills (2 shipped, ecosystem waiting for community contributions).

---

## Recon 3 — AI Tooling Engineer JD reread

**Question:** what does the JD literally ask for, bullet by bullet, and which artifact shape best demonstrates the requirements at depth?

**JD verbatim (newer version, April 27 2026):** captured in full in the recon agent's report. Lead paragraph: "AI Tooling Engineer with strong expertise in JavaScript/TypeScript to help shape how developers and agents build with Supabase. ... You'll combine product thinking, strong engineering fundamentals, and an eval-first mindset to build reliable tools, interfaces, and abstractions."

**Notable JD revisions vs older mirror:** team has explicitly broadened scope beyond MCP. Older bullet "Develop and maintain Supabase's AI tools like our MCP server" replaced with "Build and maintain Supabase's AI tooling, including surfaces such as **MCP, agent skills, and other interfaces**." Edge Functions deploy named. Dashboard assistant elevated to "self-serve product."

**Hidden weight (bullets that imply more than they say):**

1. *"Eval-first by building evaluation frameworks, instrumentation, feedback loops across real use cases"* — actually means evals embedded as continuous instrumentation in production AI surfaces, closer to Braintrust-style observability + A/B + regression suite wired into product surfaces. The user's existing `supabase-mcp-evals` repo is *adjacent* but offline-only.
2. *"MCP on Edge Functions, vector embeddings, agents running on Edge Functions"* — actually means deeply understanding Edge Functions runtime constraints (Deno, no Node modules, cold-start budgets, isolate limits) and how those interact with MCP server design (long-lived vs serverless), embeddings (model-loading cost), and agent loops (timeout-bounded).
3. *"Strong judgment about... fragile or gimmicky"* — actually means publicly demonstrate taste via prose where the candidate names what was tried-and-rejected. Carried by the writeup, not the code.

**Artifact scoring rubric (1–10 per JD bullet, summed to /90):**

| Artifact | R1 MCP/skills | R2 Dashboard | R3 Eval-instr | R4 Docs-to-agents | R5 Edge Fns | R6 TS ecosys | R7 pgvector | R8 Tests/bench | R9 Judgment | **Total** |
|---|---|---|---|---|---|---|---|---|---|---|
| A — Eval suite for supabase-mcp | 4 | 1 | 7 | 2 | 1 | 6 | 2 | 8 | 5 | **36** |
| B — pgvector-RAG MCP server | 8 | 2 | 4 | 6 | 6 | 9 | 10 | 7 | 6 | **58** |
| C — Realtime/CDC MCP server | 8 | 3 | 4 | 2 | 6 | 8 | 1 | 7 | 6 | **45** |
| D — Auth/RLS-policy MCP server | 8 | 2 | 4 | 3 | 5 | 8 | 1 | 7 | 6 | **44** |
| E — PRs to supabase-mcp + writeup | 6 | 1 | 5 | 4 | 3 | 6 | 3 | 6 | 7 | **41** |
| **F — MCP-on-Edge-Functions Agent Skill starter** (proposed) | **9** | 4 | 7 | 8 | **10** | 9 | 6 | 9 | 8 | **70** |
| G — Dashboard-assistant Postgres debugger (proposed) | 7 | **9** | 8 | 5 | 9 | 8 | 7 | 8 | 8 | **69** |

**Verdict:** F (MCP-on-Edge-Functions Agent Skill starter) and G (dashboard-assistant Postgres debugger) score ~70/90. Plain MCP servers (B/C/D) cap at ~58. Eval-suite (A) scores 36.

---

## Synthesis (locked decision)

**Artifact shape: F — MCP-on-Edge-Functions Agent Skill starter.**

**Niche: Realtime/CDC** (Postgres row-changes + broadcast + presence as agent tools). Empty per recon 1; on-direction per recon 2; uplifted from 45 → ~70 when shipped as F-shape per recon 3.

**The +25-point uplift from "plain Realtime MCP server" to "Realtime Agent Skill bundle deployed on Edge Functions"** comes from JD bullets that reorder the gravity in the newer JD: agent-skills as first-class, Edge Functions deploy explicitly, dashboard-assistant adjacency, stress testing / load-bearing for streaming.

**What this retracts from prior session:**

- "Build evidence-grade slice on supabase-mcp" — saturated, off-direction, drop
- "Maintainer-recommendations doc + upstream PR series as headline" — caps at 41/90, demote to side artifact
- The existing `supabase-mcp-evals` repo + playbook + 6 research passes — *don't pretend this is evidence*; reframe as a research artifact (methodology synthesis) and repurpose `src/foundation/` as the eval-instrumentation backbone of the new headline

**What this locks:**

- Headline: a TS-native Realtime/CDC Agent Skill bundle that deploys as an MCP server on Supabase Edge Functions, with eval instrumentation built in, published to npm, paired with one writeup
- ~3 weeks scope
- Side artifacts (opportunistic, not required): 1–2 PRs to `supabase-community/supabase-mcp` if recon surfaces them; one "Contributing to the Supabase agent ecosystem" writeup

**Recon 4 result (Realtime Skill niche check):** confirmed empty.

- Only 2 official skills shipped in `supabase/agent-skills` (~2k stars): `supabase` (broad) and `supabase-postgres-best-practices`. The broad `supabase` skill *names Realtime in scope* but provides no dedicated sub-skill or detailed reference folder.
- One community entry surfaced: `leonaaardob/lb-supabase-skill` (0 stars, Feb 2026, generic-docs bundle). Not a serious entry.
- GitHub searches for `"agent skill" supabase realtime` and `"postgres CDC" "agent skill"` returned 0 focused results.

**Sharper recon-4 insight:** the strongest form factor is **Skill + MCP server paired**, not either alone:

- Skill = *instruction layer* (when to use Realtime, opinionated patterns, RLS implications)
- MCP = *execution layer* (subscribe / broadcast / presence as tool calls)
- JD pairs them verbatim: "MCP, agent skills, and other interfaces"

**Differentiation note:** because the official `supabase` skill already names Realtime in scope, the new artifact differentiates on **depth, opinionated patterns, and worked agent examples** (e.g. "agent watches `feedback_submissions` table and triggers on insert"), not on broader coverage.

---

## Recon 5 — Novelty validation (post-brainstorm lock)

**Question:** before writing the spec, is the *specific* artifact concept (CDC-as-agent-tool + Skill + pgvector retrieval-on-trigger + Edge-Functions bounded subscription) novel, or is there prior art that would force a redesign?

**Method:** four targeted searches (not a forked recon — direct WebSearch + WebFetch on the highest-leverage spots) after the prior session compaction lost the in-flight Recon-5 fork.

**Findings by dimension:**

1. **MCP server exposing Postgres CDC / LISTEN-NOTIFY as agent tools** — *Empty.* `Postgres MCP Pro` and `pgEdge Postgres MCP` are query/admin servers; neither exposes change-streams. No published serious entry.
2. **`supabase/agent-skills` repo issues** — *No proposal in flight.* Visible open issues are infrastructure (uuid_generate_v7, RLS recursion, SKILL.md/CLAUDE.md duplication, lifecycle management). No issue mentions Realtime, CDC, Postgres Changes, LISTEN/NOTIFY, "agent watches", or row-level subscription. No first-party plan, no community proposal.
3. **Supabase Automatic Embeddings overlap** — *Substrate, not competitor.* Automatic Embeddings is "fully asynchronous, agent-free" — insert → trigger → pgmq queue → pg_cron → Edge Function → write `halfvec(1536)` back to row. The agent never sees it; scope is embedding generation only, not retrieval, not change-notification. Our pattern puts the agent **in** the loop. The two **compose**: Automatic Embeddings populates the embedded substrate; our Skill+MCP lets the agent react to changes and retrieve over those embeddings.
4. **Skills-Over-MCP April 14 2026 office hours** (modelcontextprotocol/modelcontextprotocol#2585) — *Open design space.* No discussion of CDC/event-streaming/database patterns as agent surfaces. No consensus on Skill+MCP **co-shipping** as a standard form factor (Peter Alexander pushed back on baking tool descriptions into skills; Google's team raised the question). Pedro Rodrigues from Supabase was in the room and raised abstract metadata concerns — no in-flight Realtime skill mentioned.

**Adjacent prior art that exists (does not block):**

- **Drasi (Microsoft)** — generic CDC engine, not Supabase-native, not an MCP/skill
- **Agentbase `data_change` trigger primitive** — generic agent-framework, not Supabase
- **TimescaleDB "Agentic Postgres"** (Oct 2025) — different DB
- **tianpan.co April 2026 blog**, **Medium "I Built an AI Agent That Watches Your Database"** (April 2026, Drasi-based) — concept essays, no shipped artifact

**Verdict: NOVEL — proceed.** The agent-watches-database *pattern* has adjacent published essays, but no one ships:
- Supabase-native (uses Realtime not raw logical replication)
- Skill + MCP **paired** form factor (literally an *open design question* per April 14 office hours)
- Edge Functions deployment with bounded-subscription pattern (timeout-fit for isolate budgets)
- pgvector composition (retrieval-on-trigger built into the worked example)
- Eval instrumentation built in (latency-of-first-event, missed-events, spurious-trigger, action-correctness)
- Open Skills Standard (`SKILL.md` + `references/`)

None of the adjacent prior art combines these.

**Strongest differentiation lever:** the Skill+MCP paired form factor is *itself* an open design question per the April 14 2026 office hours. Shipping a worked-example pair is a contribution to that conversation, not a duplicate of anything. Pedro Rodrigues from Supabase was in that room — visibility is built in.

**Constraints carried forward into spec:**

- Worked example must include pgvector composition (closes JD pgvector gap, demonstrates Automatic Embeddings interop without overlapping it)
- Bounded subscription, not persistent WebSocket, for Edge Functions fit
- Eval instrumentation (4 metrics above) must be a first-class part of the artifact, not an afterthought
- Differentiate on depth + opinionated patterns + worked agent examples, since broad `supabase` skill already names Realtime in scope

---

## Sources

- Recon 0 forked agent: `agentId: abfce8f004541d614` (eval-suite-niche scan; pre-branch — triggered the redesign)
- Recon 1 forked agent: `agentId: a4cae00a17880fad0` (Supabase-adjacent MCP server saturation map)
- Recon 2 forked agent: `agentId: a865918503a454592` (Supabase ecosystem AI tooling broader)
- Recon 3 forked agent: `agentId: ac2af116a4f805905` (JD reread; retry — first attempt rate-limited)
- Recon 4 forked agent: `agentId: ae6e0643676e67a25` (Realtime Agent Skill niche)
- Recon 5: direct WebSearch/WebFetch sweep (no forked agent — prior fork lost to session compaction). Sources cited inline above: pulsemcp.com, github.com/crystaldba/postgres-mcp, github.com/supabase/agent-skills/issues, supabase.com/docs/guides/ai/automatic-embeddings, github.com/modelcontextprotocol/modelcontextprotocol/discussions/2585.

Distilled returns kept in agent transcripts at `/private/tmp/claude-501/.../tasks/<agentId>.output`; synthesis lives here.
