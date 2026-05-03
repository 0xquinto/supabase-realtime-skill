# Recon: real-world adoption — would a senior Supabase engineer actually use v0.3.0? (2026-05-03)

Pre-ADR recon for the post-v0.3.0 adoption posture. Filed on branch `recon/real-world-adoption`. Mirrors the shape of [`2026-05-02-v1.0.0-ship-surface-recon.md`](2026-05-02-v1.0.0-ship-surface-recon.md). The headline question is direction, not features.

> **Now that the artifact ships disciplined evidence (16 ADRs, FAIL→PASS smoke receipts on real Pro branches, n=100 ci-full at 99/100), is its adoption proposition real — or is it portfolio theater that produced real findings but won't get used?**

The owner pushed back on two earlier framings:

1. **Framing-dishonesty pushback.** Pitching the four findings as "we fixed silent failures supabase-js doesn't catch" overclaims if those findings came up because *our own implementation was flawed in specific composition patterns*, not because we reverse-engineered general supabase-js bugs.
2. **MCP-trajectory pushback.** Demoting MCP-on-Edge from headline to deployment option solves for the current market, not the market the artifact is positioned for. The bet is the trajectory.

Both pushbacks are themselves the load-bearing recon questions.

## Methodology

Five probes, each falsifiable:

- **§ A:** for each of four findings (ADRs 0011, 0013, T7, 0016), tag general / half-general / composition-specific. Sources: supabase/supabase-js issues, supabase/realtime issues, Stack Overflow, official docs. Cutoff: 2026-05-03 via Exa.
- **§ B:** locate closest 3–5 comparables. Sources: `modelcontextprotocol/servers` registry, npm-stat, `supabase/agent-skills` repo structure.
- **§ C:** confidence interval on MCP-on-Edge bet at 6mo / 18mo / 3yr. Sources: MCP SDK download trends, Cloudflare/Vercel/AWS deployment docs, Supabase 2026 changelog, agent-watches-database blog convergence.
- **§ D:** signal thresholds from `tRPC`, `Drizzle ORM`, `@supabase/mcp-server-supabase`. Heuristic: weekly downloads + named consumers + external issue volume.
- **§ E:** README + SKILL.md + dist surface read cold from three personas, with persona signals from package-evaluation literature.

Out of scope: talking to real users (the recon's whole point is hypotheses cheap enough to validate later); drafting blog/README rewrites; building `boundedReplay`.

## Findings

### § A — Honesty audit on the four "silent failure" findings

| Finding | Verdict | Key citations | Honest framing |
|---|---|---|---|
| **1. `setAuth` JWT propagation (ADR-0011)** | **GENERAL** | [supabase-js#1304](https://github.com/supabase/supabase-js/issues/1304) (Nov 2024, comments span 2024-2026 on supabase-js@2.57.4 / ^2.80.0 / ^2.100.1); [#1797](https://github.com/supabase/supabase-js/issues/1797) (Oct 2025); [supabase#35195](https://github.com/supabase/supabase/issues/35195) (Apr 2025); [supabase-js#1826](https://github.com/supabase/supabase-js/pull/1826) merged Oct 31 2025 but reports persist; [be620bd1](https://github.com/supabase/supabase-js/commit/be620bd1f5f36a0cc9514b7696371de8da494645) Dec 3 2025 manual-token-preservation fix for issue #1904 | Known supabase-js trap, heavily reported since 2024. The artifact's contribution is a regression-gated smoke for *our* multi-tenant composition, not the discovery. |
| **2. `private: true` opt-in + silent filtering (ADR-0013)** | **HALF-GENERAL** | Opt-in: [supabase-js#1274](https://github.com/supabase/supabase-js/issues/1274) (Sep 2024); [supabase/realtime#1111](https://github.com/supabase/realtime/issues/1111) (Aug 2024); [supabase#35302](https://github.com/supabase/supabase/issues/35302). Silent-filtering contract: NOT in [official Realtime Authorization docs](https://supabase.com/docs/guides/realtime/authorization) | The opt-in half is general. The silent-filtering-not-loud-rejection contract (REST 202 + RLS-dropped row, no thrown error) is **genuinely novel** — appears nowhere in public docs or supabase-js issues. Two findings smushed into one. |
| **3. ~5s warm-up window (T7)** | **GENERAL** | [supabase-js#1599](https://github.com/supabase/supabase-js/issues/1599) (Aug 2025, identical reproducer); [supabase/realtime#281 / #282](https://github.com/supabase/realtime/issues/282) (Aug 2022, original); [supabase-js#2029](https://github.com/supabase/supabase-js/pull/2029) candidate fix **OPEN, not merged**; [supabase/realtime 02165bc](https://github.com/supabase/realtime/commit/02165bcf869137f1bd704fc9ffebb7f0a5eea1b8) Nov 2025 — Supabase's own test uses busy-wait workaround | Reported since 2022, currently unfixed. Artifact's novel contribution is the n=20 Edge distribution (p99 5322ms, 12s wall budget) — no public p99 measurement existed. |
| **4. GRANT + RLS chain for anon-JWT payload (ADR-0016 sub-finding)** | **HALF-GENERAL** | Substrate general: [SO #77561812](https://stackoverflow.com/questions/77561812/supabase-realtime-payload-new-empty) (Nov 2023); [supabase#38115](https://github.com/supabase/supabase/issues/38115) ("6 hours of hell"); [supabase/realtime#1107](https://github.com/supabase/realtime/issues/1107). The Apr 2026 [GRANT-default-flip changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) makes this *more* general going forward | Substrate is general (heavily reported). The seven-variant probe table on Edge isolates is the cleanest empirical decomposition we located in public docs — that's a methodology contribution wrapped around a known gotcha. |

**Headline of § A:** the owner's pushback **lands**. "We fixed 4 silent failures supabase-js doesn't catch" is overclaim. The honest reframing:

> *"Supabase Realtime has 4 well-known traps that bite multi-tenant agent compositions. We shipped pre-registered smoke gates so they don't regress in our composition, plus 2 sub-findings (silent-filtering contract on broadcast denial; n=20 Edge warm-up distribution + 7-variant GRANT/RLS probe table) that aren't in public docs."*

The discipline backbone — pre-registration loop + ADRs + FAIL→PASS smoke pattern — is the actual headline. The four findings are evidence the discipline produced, not the news. Reframe is required.

### § B — Existing landscape

#### Closest direct comparable: `@supabase/mcp-server-supabase`

The official Supabase MCP server: **84.9K weekly downloads** ([npm](https://www.npmjs.com/package/@supabase/mcp-server-supabase)), **2,615 stars** on [supabase-community/supabase-mcp](https://github.com/supabase-community/supabase-mcp), v0.7.0, hosted variant at `mcp.supabase.com/mcp` since [Oct 10 2025](https://supabase.com/changelog/39434-supabase-remote-mcp-server). Per [PopularAiTools.ai](https://popularaitools.ai/blog/supabase-mcp-server-review/), 832K all-time downloads since Apr 2025 launch.

**Crucially: it's the inverse shape.** Tools are `list_tables`, `apply_migration`, `execute_sql`, `get_logs`, `create_branch` — "AI-assistant-manages-Supabase-platform" (Cursor/Claude/Windsurf). Zero overlap with `watch_table` / `boundedWatch` / `subscribe_to_channel`. Supabase's own README explicitly disclaims production agent use: *"Don't connect to production. Use the MCP server with a development project."*

**This is the strongest signal that the artifact has positioning room.** The official server explicitly disclaims the agent-watches-production-data niche. The artifact owns it unopposed at the npm layer.

#### Other comparables

- [`postgres-mcp` (Apr 2025)](https://registry.npmjs.org/postgres-mcp), [`@neverinfamous/postgres-mcp`](https://github.com/neverinfamous/postgres-mcp), [`Quegenx/supabase-mcp-server`](https://github.com/Quegenx/supabase-mcp-server) — SQL-shaped or platform-mgmt-shaped, no agent-runtime CDC primitive.
- **RxJS `bufferTime` / `bufferCount`** — `boundedWatch` is essentially `bufferTime(timeout_ms, null, max_events)` over a Realtime subscription expressed as a one-shot Promise. Conceptual prior art established; not packaged on Supabase.
- **Kafka consumer poll loop** — same `poll(timeout, max_records)` semantics; production-scale prior art.
- **Streamkap / Drasi+Dapr / pg-logical-replication / Estuary** — production CDC tooling at heavy infra tier (Kafka + Debezium, Kubernetes + KEDA). Different cost/complexity.

The bounded-primitive shape exists in adjacent ecosystems but isn't packaged as an agent runtime primitive on top of Supabase.

#### `supabase/agent-skills` upstream structure (T31 context)

[`supabase/agent-skills`](https://github.com/supabase/agent-skills) — **2,021 stars, 132 forks, MIT**, created Jan 16 2026. Two skills shipped (`supabase`, `supabase-postgres-best-practices`). Structure is rigid: `skills/{skill-name}/SKILL.md` + `references/_sections.md` + prefix-disciplined files. [AGENTS.md is explicit](https://github.com/supabase/agent-skills/blob/main/AGENTS.md): *"Skills should only contain essential files. Do NOT create: README.md, INSTALLATION_GUIDE.md, QUICK_REFERENCE.md, CHANGELOG.md."*

This is hostile structure for the artifact's current shape (README + CHANGELOG + unstructured `references/` + `docs/decisions/` + `playbook/` etc.). Per ADR-0004's framing, the realistic upstream play is feedback-shape engagement, not as-drafted PR.

**Headline of § B:** the artifact has **real positioning room** — no direct npm competitor at agent-watches-Supabase-data niche on Edge. The closest comparable (`@supabase/mcp-server-supabase`) explicitly disclaims this use case. Conceptual primitive is established (RxJS, Kafka) but not packaged. Upstream `agent-skills` is a real submission target requiring reshape.

### § C — Trajectory check

#### MCP adoption velocity

[`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk): **34.4M weekly downloads** as of Mar 30 2026, 46K dependents, 78 versions. [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers): **82,768 stars**. [TS SDK](https://github.com/modelcontextprotocol/typescript-sdk): 12,318 stars, 160 contributors, v2 pre-alpha for Q1 2026. **MCP is not Claude-Desktop-only in mid-2026.** 6-month bet is high-confidence right.

#### Production deployment shape

Three surfaces, in adoption order:

1. **Cloudflare Workers** — overwhelming presence. [Official Agents SDK](https://developers.cloudflare.com/agents/guides/build-mcp-server/) (`McpAgent` + Durable Objects), [`cloudflare/mcp`](https://github.com/cloudflare/mcp) (378 stars, "Code Mode"). Multiple production case studies. Current MCP-on-edge winner.
2. **Supabase Edge Functions** — [BYO-MCP docs](https://supabase.com/docs/guides/getting-started/byo-mcp) updated Apr 30 2026 (four days before this recon). Documented shape is `WebStandardStreamableHTTPServerTransport` + Edge Function — **exactly the artifact's deployment shape**. The trajectory bet is no longer speculative; Supabase published the pattern as a documented option simultaneous with this recon.
3. **AWS / GCP / containers** — heavier enterprise surface; SOC 2 / HIPAA paths.

#### Supabase 2026 agent direction

From the [Supabase changelog](https://supabase.com/changelog):

- **Mar 5 2026:** "Supabase is now an official Claude connector"; [Postgres Best Practices for AI Agents skill](https://github.com/supabase/agent-skills) shipped.
- **Mar 28 2026:** [BKND joins Supabase to build "Lite offering for agentic" workloads](https://supabase.com/changelog/43465-developer-update-march-2026) — explicit agent-shape hire.
- **Apr 28 2026:** GRANT-default-flip on new tables — makes finding 4 *more* relevant going forward, not less.

Supabase's stated 2026 direction is agents. The artifact is positioned **with** the trajectory, not orthogonal.

#### "Agent watches database" pattern visibility

Multiple 2026 blog posts converge:

- [Streamkap (2026)](https://streamkap.com/resources-and-guides/event-driven-agent-orchestration/) — CDC → router → agent dispatcher.
- [Tianpan (Apr 16 2026)](https://tianpan.co/blog/2026-04-16-proactive-agents-event-driven-scheduled-automation) — *"Event-driven agents reduce latency 70-90% vs polling, zero compute cost while idle."*
- [Drasi+Dapr writeup (Apr 5 2026)](https://medium.com/@mgaurang123/i-built-an-ai-agent-that-watches-your-database-and-acts-on-its-own-66a40a0ce4b2) — calls the pattern "ambient agent."
- [DEV.to (Apr 19 2026)](https://dev.to/practiceoverflow/event-driven-agents-why-direct-cdc-just-killed-the-kafka-debezium-kafka-stack-4kgo) — *"If you're building an agent that makes >5 decisions/sec against mutable data, default to streaming substrate."*
- [Knowlee (Apr 30 2026)](https://www.knowlee.ai/blog/heartbeat-patterns-proactive-ai-agents) — signal-based heartbeats with database row inserts as dominant pattern.

**The pattern is having its moment in 2026 H1.** The artifact is named-correctly for this conversation; the question is visibility.

#### Confidence interval

| Horizon | Bet | Confidence | Anchor evidence |
|---|---|---|---|
| 6 months | MCP on Edge is a real production shape | **High** | 34.4M weekly SDK downloads; Apr 30 2026 BYO-MCP docs; Cloudflare Agents SDK |
| 18 months | Agent-watches-database becomes default for reactive workflows | **Medium-high** | Multiple 2026 blog convergence; Supabase agentic-hire; agent-skills repo growth |
| 3 years | MCP-on-Edge displaces request/response REST as default agent integration | **Medium** *(conjecture)* — depends on v2 SDK landing cleanly + Anthropic/OpenAI roadmap stability |

**The owner's MCP-trajectory pushback lands.** Demoting MCP-on-Edge would solve for the current market (Cursor/Claude-Desktop) rather than the 18-month market the artifact is positioned for. Keep MCP-on-Edge as headline. Tighten framing to "the deployment shape Supabase is documenting + Cloudflare is winning at scale" rather than implying universal adoption today.

### § D — Adoption-pattern audit

Three reference comparables, with adoption signals.

| Library | Stars | Weekly DL | Status | Inflection point |
|---|---|---|---|---|
| **tRPC** | 39,971 | 3.1M (`@trpc/server`) | v11.17.0 (Apr 2026), mature | create-t3-app default + Theo Browne evangelism (~2022, v9.x) |
| **Drizzle ORM** | 33K+ | ~1.4M | **v0.45.2 — still v0.x by design** | create-t3-app integration + Cloudflare D1/Workers (2024-2025) |
| **`@supabase/mcp-server-supabase`** | 2,615 | 84.9K | v0.7.0, pre-1.0 with breaking-changes disclaimer | Apr 2025 launch + Cursor/Windsurf/Claude integration; remote MCP (Oct 2025) collapsed onboarding |

**Drizzle proves serious adoption at v0.x is fine.** v1.0 is not the gate.

#### Senior-engineer adoption signal heuristic

Synthesis from [PkgPulse "Myth of Production-Ready" (Mar 2026)](https://www.pkgpulse.com/blog/myth-of-production-ready-npm-packages), [HN evaluation threads](https://news.ycombinator.com/item?id=47833736), and the comparables:

1. **Solves a real problem** — dominant signal. Stars and downloads are downstream.
2. **Maintenance velocity** — last release within 3 months for infra-layer.
3. **Issue response time** — last 5 issues triaged within 2 weeks.
4. **TypeScript-native** `.d.ts`.
5. **A named consumer or worked example** — Drizzle's create-t3-app, supabase-mcp's Cursor. **First named consumer is the most-load-bearing single signal.**
6. **Stars** are a disqualifier ("brand new toy") but largely vanity per 2026 HN consensus.

#### Threshold targets for `supabase-realtime-skill@1.0.0`

Working backward from comparables:

| Signal | Floor (real adoption) | Aspirational (month-6 post-1.0) |
|---|---|---|
| Weekly downloads | 100 | 500+ |
| GitHub stars | 30 | 100+ |
| **External issues filed** | **1** | **3+** |
| Named consumer (blog post / demo / talk citing the artifact) | 0 (it's the trigger) | 1 |
| External PR contribution | 0 | 1 |

**The most predictively useful number is "external issues filed."** First unsolicited "I tried X, it didn't work" is worth more than 100 stars. **Stars are vanity; external issues are the leading "this is in someone's stack" signal.**

The owner's stated plan (blog post + community engagement) matches the comparable pattern — every adopted comparable had a triggering blog post or talk. **The blog post needs to be the kind a senior engineer forwards to a colleague**: narrow technical, not portfolio-pitch.

Recommended blog shapes (conjecture):

- **Shape A:** "We measured the 5-second Realtime warm-up window distribution on 20 Edge isolates" + the GRANT+RLS 7-variant probe table.
- **Shape B:** "What `realtime.messages` RLS denial actually looks like: silent filtering, not 403" — pins ADR-0013's novel sub-finding.

**Reject:** "Introducing supabase-realtime-skill v1.0.0" — that's a press release, not a senior-engineer-reads-it post.

### § E — Three-persona simulation

Reading README + SKILL.md cold against three personas.

**Persona 1: Senior eng at Series B, 3yr supabase-js, evaluating for customer-support agent.** Lands on bounded-primitive differentiator + the mermaid diagram. Bounces on: README's "16 ADRs" + "v1.0.0 stays unclaimed" framing reads as portfolio-shaped / in-active-development; eval-results table front-loads internal scaffolding before hello-world; missing 5-minute "agent watches my support_tickets" demo (it's in `references/worked-example.md`, +1 click). **Predicted (conjecture):** evaluates → defers → forgets in 2 weeks unless pulled back by external citation.

**Persona 2: IC at larger company evaluating MCP, hasn't used Supabase.** Lands on 5-tools surface + curl/JSON-RPC deploy snippet. Bounces on: artifact is Supabase-bound (not portable to vanilla Postgres + wal2json); no comparison with Cloudflare's `McpAgent` for the deployment-decision question. **Predicted:** bounces if not on Supabase. If on Supabase, evaluates favorably.

**Persona 3: Indie dev, weekend project, wants CDC.** Lands on `boundedWatch` snippet + Edge Function deploy snippet. Bounces on: Pro project required (she's on Free); operator-grade `references/edge-deployment.md` setup chain (PAT, host project ref, dedicated Pro instance, 4 env vars). **Predicted:** bounces on Pro. If on Pro, ships in a weekend.

**Headline of § E:** the README is good for the operator + portfolio-review audiences. It's not yet good for the "fresh adopter, 30-second decision" audience. The persona literature ([PkgPulse 2026](https://www.pkgpulse.com/blog/how-to-evaluate-npm-package-health), HN evaluation threads) converges on **30 seconds for value prop, 5 minutes for hello-world, 1 hour for first integration**. The artifact hits 30s and 1h cleanly. It misses the 5min middle. Adding a 5-minute hello-world panel above the eval-results table closes the gap; demote 16-ADRs framing to a "Background" section.

The persona signals are conjecture (no direct adopter quotes for this artifact yet — see § Methodology / out-of-scope), to be validated by talking to 3-5 real users post-v1.0.

## Decisions

Each numbered, each with a falsifiable predicted effect.

### 1. Reframe the four-findings pitch as "regression-gated traps + two novel sub-findings"

The owner's framing-dishonesty pushback lands per § A. Honest pitch:

- ADR-0011 + T7 + finding-4: known supabase-js / Realtime traps (heavily reported since 2022-2024); contribution is regression-gated smoke for *our* multi-tenant composition.
- ADR-0013's silent-filtering contract + Spike T7-Edge n=20 distribution + 7-variant GRANT/RLS probe: **genuinely novel**, nowhere in public docs.
- The discipline backbone (pre-registration loop + ADRs + FAIL→PASS smoke) is the actual headline. Findings are evidence the discipline produced, not the news.

**Falsifiable predicted effect:** if reframed README + blog post lands the honest framing, external feedback within 90 days cites the *silent-filtering* and/or *Edge warm-up distribution* sub-findings. If feedback uniformly cites "you fixed silent failures," the reframe failed and we're still selling overclaim.

### 2. Keep MCP-on-Edge as headline; tighten framing to "trajectory" not "current state"

§ C evidence is unambiguous: 34.4M weekly SDK downloads + Apr 30 2026 BYO-MCP docs + Cloudflare investment. 6-month bet high-confidence right; 18-month bet medium-high.

**Falsifiable predicted effect:** by 2026-11-04 (6 months out), ≥1 of: (a) Supabase publishes a Realtime-shaped MCP server pattern in their docs; (b) `supabase/agent-skills` adds a realtime-shaped skill; (c) `@supabase/mcp-server-supabase` adds a `subscribe_to_realtime`-shaped tool. Zero of these in 6 months → trajectory pace slower than predicted; demote to deployment-option framing.

### 3. README adds a 5-minute hello-world panel; demotes ADR-portfolio framing

§ E friction map: missing middle is the 5-minute hello-world agent-loop demo. Eval-results table is correct content but wrong placement for fresh adopters.

**Falsifiable predicted effect:** README reshape per § E + blog post by month-3 post-v1.0 → by month-6: weekly downloads ≥ 100, stars ≥ 30, external issues ≥ 1. Any threshold missed → README/blog landed wrong audience.

### 4. The blog post is technical-narrow, not portfolio-shaped

§ D: every adopted comparable had a triggering technical post. Natural shapes: A (warm-up distribution + 7-variant probe) or B (silent-filtering contract). **Reject** "Introducing v1.0.0."

**Falsifiable predicted effect:** technical-narrow shape predicts ≥100 upvotes + 30 comments on HN/r/Supabase. Press-release shape predicts ≤30 upvotes — below the noise floor. Technical-narrow lands and gets ≤30 upvotes → audience for the finding doesn't exist or post couldn't reach them.

### 5. Hold the upstream `supabase/agent-skills` submission as feedback-shape

§ B confirms structure rigidity. ADR-0004's framing is right; as-drafted PR rejected on shape alone.

**Falsifiable predicted effect:** opening a discussion (not PR) within 90 days yields maintainer engagement signal (comment, "interesting, but," "we'd consider X if Y") rather than auto-close. Auto-close → ADR-0004's framing was correct and we skip; or unexpected acceptance → we underestimated structure flexibility.

### 6. Adoption inflection target: external issues filed, not stars

§ D heuristic. Stars are vanity; weekly downloads are lagging; external issues filed are the leading signal of integration-shaped traction.

**Falsifiable predicted effect:** by month-6 post-v1.0, external issues filed ≥ 1. Zero issues with ≥100 stars → portfolio-shaped traction without integration-shaped traction.

## Recommendations

Gated on the decisions above.

**Pre-1.0 / this branch's natural follow-up:**

1. Reshape README per § E. Add 5-minute hello-world panel above eval-results. Demote eval table + 16-ADRs to a "Methodology" section below worked example. Current content is correct; placement is the issue.
2. Honesty edit: replace "we fixed silent failures supabase-js doesn't catch" with § A reframing.

**v1.0 ship surface (no scope additions, just framing):**

3. The v1.0 ADR's rationale should explicitly own the trajectory framing per Decision 2 — cite Apr 30 2026 BYO-MCP docs as the trajectory anchor.

**Post-1.0 community engagement:**

4. Blog post first (Shape A or B). Aim for HN front page or r/Supabase weekly thread. Track upvotes / comments / referral traffic to npm.
5. Open an issue (not PR) in `supabase/agent-skills` with discussion shape. Capture maintainer signal first.
6. Track external issues filed as load-bearing metric. Weekly download counts are noisy until ~month-6; star counts are vanity.

**Out of scope for this recon:** building `boundedReplay`; talking to 3-5 real users (defer until post-v1.0); reshaping for upstream submission (gated on Decision 5's signal).

## ADR-shaped follow-ups

- **ADR-0017 (or v1.0.0 ADR amendment):** commit on Decision 2 — trajectory framing for MCP-on-Edge as load-bearing rationale for v1.0 ship surface.
- **ADR-0018 (post-v1.0 README reshape):** commit on Decisions 1 + 3 — README adds 5-minute hello-world; four-findings reframes to "regression-gated + two novel sub-findings."
- **ADR-0019 (blog post + community engagement):** commit on Decisions 4 + 6 — blog shape, target metrics, issue-not-PR upstream play. Filed only if 0018 lands first.

Decision 5 (upstream-as-feedback) is **already filed** as ADR-0004 (Proposed). This recon affirms the existing framing; promote ADR-0004 to Accepted with this recon's evidence in the rationale, no new ADR needed.

## Where direction risk concentrates — adversarial pass

**Counter-framing 1: "the trajectory bet is right but the artifact is too late."** Cloudflare's `McpAgent` has a 6-month head start and 100x deployment volume. By the time supabase-realtime-skill is the visible Supabase + MCP-on-Edge reference, Cloudflare has shipped its own equivalent.

Response: the bet isn't "be the only MCP-on-Edge" — it's "be the *Supabase-native* one." Cloudflare's `McpAgent` doesn't ship Realtime/CDC primitives. Risk: low to medium (Supabase customers prefer Supabase-native).

**Counter-framing 2: "if 3 of 4 findings are general, the artifact's value is just discipline, not findings."** That's harder to pitch to senior engineers — "we ran disciplined evals on a known set of substrate gotchas" doesn't move them like "we found 4 silent failures" would.

Response: **lands. Methodology IS the actual headline.** Reframe per Decision 1 absorbs this. The artifact's pitch needs to internalize that the methodology backbone is the differentiator from every other MCP-on-Supabase npm package — none ship pre-registered eval thresholds, FAIL→PASS smoke receipts, or 16 ADRs. **The discipline is the moat.** Pitch accordingly.

**Counter-framing 3: "personas 2 and 3 dominate; persona 1 is the wrong target."** Realistic adopter is *only* persona 1 (Supabase senior engineer building agents). That's a narrow audience; thresholds in Decision 6 may be optimistic.

Response: **lands partially.** The audience IS narrow — Supabase Pro + multi-tenant agent + reactive workload is a tight intersection. Floors in Decision 6 already account (100 weekly DL / 30 stars / 1 external issue). The deeper steelman: **the artifact's primary value is JD-pivot evidence, not external adoption.** Per CLAUDE.md § Purpose, the audience is "supabase/agent-skills maintainers + JD's hiring panel." External adoption is upside-tracking, not gating. The recon's "is it adoption-real?" framing is itself slightly misframed — the right framing is "is the JD-pivot evidence strong enough that external adoption doesn't have to carry the weight?" Yes.

## What this means for the next step

**Direction:** the artifact's adoption proposition is *real but narrower than the discipline-headline implies*. The owner's two pushbacks both lead to honest framing reshapes:

- Four findings: reframe as "regression-gated traps + two novel sub-findings" (not "4 silent failures").
- MCP-on-Edge: keep as headline; tighten to "trajectory at 18 months" not "current state."

The README needs a 5-minute hello-world panel; the blog post needs to be technical-narrow; the upstream play stays as feedback-shape. **The discipline backbone is the actual moat — that's the JD-pivot evidence and it's strong as-is.**

The pivot doesn't depend on external adoption. That's the stronger reading the recon arrives at: external adoption is upside-tracking, the JD-pivot evidence is already shipped at v0.3.0.

These are recommendations, not decisions — ADRs (0017/0018/0019) get filed as **Proposed** per status discipline.

## References

**Internal:**
- [`docs/recon/2026-05-02-v1.0.0-ship-surface-recon.md`](2026-05-02-v1.0.0-ship-surface-recon.md) — recon shape this doc mirrors.
- [`docs/decisions/0004-reshape-t31-as-user-feedback.md`](../decisions/0004-reshape-t31-as-user-feedback.md) — upstream submission framing.
- [`docs/decisions/0011-multi-tenant-rls-baseline.md`](../decisions/0011-multi-tenant-rls-baseline.md), [`0013-private-channel-broadcast-authorization.md`](../decisions/0013-private-channel-broadcast-authorization.md), [`0016-v1.0.0-ship-surface.md`](../decisions/0016-v1.0.0-ship-surface.md).
- [`docs/spike-findings.md`](../spike-findings.md) § T7 + T7-Edge.
- [`README.md`](../../README.md), [`SKILL.md`](../../SKILL.md), [`references/multi-tenant-rls.md`](../../references/multi-tenant-rls.md) — § E persona simulation source.

**External — § A honesty audit:**
- [supabase-js#1304](https://github.com/supabase/supabase-js/issues/1304), [#1797](https://github.com/supabase/supabase-js/issues/1797), [#1599](https://github.com/supabase/supabase-js/issues/1599), [#1274](https://github.com/supabase/supabase-js/issues/1274), [#1826 PR](https://github.com/supabase/supabase-js/pull/1826), [#2029 PR](https://github.com/supabase/supabase-js/pull/2029), [be620bd1 commit](https://github.com/supabase/supabase-js/commit/be620bd1f5f36a0cc9514b7696371de8da494645).
- [supabase/realtime#281 / #282](https://github.com/supabase/realtime/issues/282), [#1107](https://github.com/supabase/realtime/issues/1107), [#1111](https://github.com/supabase/realtime/issues/1111), [02165bc commit](https://github.com/supabase/realtime/commit/02165bcf869137f1bd704fc9ffebb7f0a5eea1b8).
- [supabase/supabase#35195](https://github.com/supabase/supabase/issues/35195), [#35302](https://github.com/supabase/supabase/issues/35302), [#38115](https://github.com/supabase/supabase/issues/38115).
- [Stack Overflow #77561812](https://stackoverflow.com/questions/77561812/supabase-realtime-payload-new-empty), [Realtime Authorization docs](https://supabase.com/docs/guides/realtime/authorization), [Apr 2026 GRANT-default-flip changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).

**External — § B landscape:**
- [`@supabase/mcp-server-supabase` npm](https://www.npmjs.com/package/@supabase/mcp-server-supabase), [`supabase-community/supabase-mcp` GitHub](https://github.com/supabase-community/supabase-mcp), [Remote MCP changelog Oct 10 2025](https://supabase.com/changelog/39434-supabase-remote-mcp-server).
- [`supabase/agent-skills`](https://github.com/supabase/agent-skills), [AGENTS.md](https://github.com/supabase/agent-skills/blob/main/AGENTS.md).
- [`postgres-mcp`](https://registry.npmjs.org/postgres-mcp), [`@neverinfamous/postgres-mcp`](https://github.com/neverinfamous/postgres-mcp), [`Quegenx/supabase-mcp-server`](https://github.com/Quegenx/supabase-mcp-server).
- [RxJS bufferTime/bufferCount SO thread](https://stackoverflow.com/questions/53248669/rxjs-receiving-data-in-batches-of-time-max), [`kibae/pg-logical-replication`](https://github.com/kibae/pg-logical-replication).

**External — § C trajectory:**
- [`@modelcontextprotocol/sdk` npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk), [`modelcontextprotocol/servers`](https://github.com/modelcontextprotocol/servers), [`modelcontextprotocol/typescript-sdk`](https://github.com/modelcontextprotocol/typescript-sdk).
- [Cloudflare Agents Build a Remote MCP server](https://developers.cloudflare.com/agents/guides/build-mcp-server/), [`cloudflare/mcp`](https://github.com/cloudflare/mcp).
- [Supabase BYO-MCP docs Apr 30 2026](https://supabase.com/docs/guides/getting-started/byo-mcp), [Supabase Developer Update March 2026](https://supabase.com/changelog/43465-developer-update-march-2026).
- [Streamkap event-driven agent orchestration](https://streamkap.com/resources-and-guides/event-driven-agent-orchestration/), [Tianpan proactive agents Apr 16 2026](https://tianpan.co/blog/2026-04-16-proactive-agents-event-driven-scheduled-automation), [Drasi+Dapr writeup](https://medium.com/@mgaurang123/i-built-an-ai-agent-that-watches-your-database-and-acts-on-its-own-66a40a0ce4b2), [DEV.to direct CDC Apr 19 2026](https://dev.to/practiceoverflow/event-driven-agents-why-direct-cdc-just-killed-the-kafka-debezium-kafka-stack-4kgo), [Knowlee heartbeat patterns Apr 30 2026](https://www.knowlee.ai/blog/heartbeat-patterns-proactive-ai-agents).

**External — § D adoption-pattern audit:**
- [`@trpc/server` npm](https://www.npmjs.com/package/@trpc/server), [Drizzle 2026 writeup](https://www.paulserban.eu/blog/post/drizzle-orm-explained-what-it-is-why-it-exists-and-who-its-for/), [Drizzle vs Prisma 2026 benchmarks](https://tech-insider.org/drizzle-vs-prisma-2026/).
- [PkgPulse: Myth of Production-Ready (Mar 2026)](https://www.pkgpulse.com/blog/myth-of-production-ready-npm-packages), [PkgPulse: How to Evaluate npm Package Health](https://www.pkgpulse.com/blog/how-to-evaluate-npm-package-health).
- [HN: 0 major version](https://news.ycombinator.com/item?id=47753073), [HN: stars are vanity](https://news.ycombinator.com/item?id=47833736), [PopularAiTools.ai supabase-mcp review (Mar 2026)](https://popularaitools.ai/blog/supabase-mcp-server-review/).
