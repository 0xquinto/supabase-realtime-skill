# Counter-recon: real-world adoption — does the home run survive an adversarial pass? (2026-05-03)

Adversarial counter-pass to [`2026-05-03-real-world-adoption-recon.md`](2026-05-03-real-world-adoption-recon.md). Same branch (`recon/real-world-adoption`), filed unstaged. The original recon scored 3-for-3 — both pushbacks landed, MCP-on-Edge bet validated, discipline-as-moat declared the actual headline. **The framing-dishonesty pushback that exposed confirmation bias on the four findings should also be turned on the recon itself.** This counter-recon's job: test whether the home run survives when the prior is "you got the answer you wanted."

> **Was the recon itself overfit to the commissioner's pre-loaded framings, and would honest evidence shift any of its six Decisions?**

## Methodology

Five counter-claims, each with explicit refutation evidence searched for *first*, then steelman-back evidence searched for second, then calibrated. Sources: official Supabase docs (postgres-changes guide, realtime authorization, GRANT-flip changelog FAQ), MCP directory data (MCPFind 7,245-server index), Cloudflare iMARS internal-deployment writeup, npm/Mozilla package-selection literature (arxiv:2204.04562, PkgPulse health scores), GitHub issue/PR state (`gh api`). Cutoff: 2026-05-03 via Exa + WebFetch + `gh api`.

Asymmetric: I'm trying to *break* the original recon. If a counter-claim is weak, that's calibration, not failure.

## Findings

### Counter-claim 1 — "the four findings are MORE general than § A admits"

**Restated:** § A tagged ADR-0011 + T7 as `general`, ADR-0013 + finding 4 as `half-general`. The implicit framing: silent-filtering contract on broadcast denial is *novel* (not in public docs), n=20 Edge warm-up distribution is *novel*, 7-variant GRANT/RLS probe table is the *cleanest empirical decomposition*. Counter: all four findings — including the supposedly-novel sub-findings — are documentable from official Supabase docs as of 2026-05-01.

**Refutation evidence found:**

The **GRANT chain is in the canonical [Postgres Changes quickstart](https://supabase.com/docs/guides/realtime/postgres-changes)** (last updated 2026-05-01, two days before this counter-recon). Step 2 of the quickstart explicitly shows the three-statement chain:

```sql
GRANT SELECT ON public.todos TO anon;       -- step 1: grant
alter table "todos" enable row level security; -- step 2: RLS
create policy "Allow anonymous access" ...   -- step 3: policy
```

Plus an explicit **"Private schemas"** section: *"You can listen to tables in your private schemas by granting table SELECT permissions to the database role found in your access token."* The recon called the artifact's 7-variant probe table "the cleanest empirical decomposition we located in public docs." That overstates: the canonical quickstart already prescribes the chain; the artifact's contribution is the *empirical decomposition* (which combinations actually surface payloads), not the *existence* of the chain.

**Steelman back:**

Two pieces hold up under refutation pressure.

1. **The silent-filtering contract on broadcast RLS denial is genuinely absent** from the [Realtime Authorization docs](https://supabase.com/docs/guides/realtime/authorization). Verified via WebFetch: *"no, this page does not document what happens when a broadcast send is denied by RLS policy. The document explains how to create RLS policies that authorize broadcast sends, but it contains no information about failure modes, error visibility, or what senders observe when their broadcasts are denied."* The original recon's claim survives.

2. **n=20 Edge warm-up p99 distribution is still novel.** [supabase-js#1599](https://github.com/supabase/supabase-js/issues/1599) reports the bug as "1-3 seconds" — no public p50/p95/p99 measurement on Edge isolates exists. The artifact's `eval/spike-edge-warmup.ts` measurement (referenced in CLAUDE.md status) is the only public p99 data point.

**Verdict: partially supported.** The 7-variant decomposition is a rephrasing of documented chain mechanics (less novel than § A claims); the silent-filtering contract and Edge p99 distribution remain genuinely novel. **Two-of-four → one-and-a-half-of-four.** The original recon's reframing ("regression-gated traps + 2 novel sub-findings") needs further compression to "regression-gated traps + 1 novel substrate finding (silent broadcast filter) + 1 novel methodology finding (Edge p99 distribution)." The 7-variant table is methodology demonstration, not novel decomposition.

### Counter-claim 2 — "MCP-on-Edge is having a moment, but Cloudflare already won the category"

**Restated:** § C declared 6mo high / 18mo medium-high / 3yr medium confidence on MCP-on-Edge. Counter: Cloudflare's `McpAgent` already owns the category at production scale; Supabase is a fast-follower at best, and the artifact has a 6-12 month head-start window before Supabase ships its own canonical Realtime-MCP server.

**Refutation evidence found:**

[MCPFind cloud category](https://mcpfind.org/blog/host-mcp-server-remotely-cloudflare-cloud-run): of 7,245 servers indexed across 21 categories, **Cloudflare's own MCP server sits at 3,566 stars — the top of the cloud category, average 61.87 stars across 158 entries.** The directory explicitly declares: *"Cloudflare Workers is the most validated remote hosting path in the MCP community today."*

[Cloudflare iMARS writeup (2026-04-20)](https://techflowdaily.com/the-ai-engineering-stack-we-built-internally-on-the-platform-we-ship/): **3,683 internal Cloudflare engineers (60.1%) actively use AI coding tools running on internal MCP servers built on Cloudflare's own platform.** Eleven months of sustained internal investment. This is production-scale precedent at one company that exceeds the entire combined Supabase MCP user base today.

[supabase/agent-skills repository state](https://github.com/supabase/agent-skills): 11 open issues, **zero of them realtime-shaped.** Top issue topics: pg_uuidv7 extension availability, RLS recursion guidance, edge function JWT validation, password reset auth flow. No "add a Realtime/CDC skill" request from the community — the demand signal § B implied isn't visible in the upstream's own issue tracker.

[supabase-community/supabase-mcp issue tracker](https://github.com/supabase-community/supabase-mcp): 2 open issues. Neither requests `subscribe_to_realtime`. The Decision-2 "falsifiable predicted effect" — that ≥1 of (a) Supabase ships realtime-shaped MCP doc, (b) agent-skills adds realtime-shaped skill, (c) supabase-mcp adds `subscribe_to_realtime` — has zero current demand signal in either upstream's issue tracker.

**Steelman back:**

The artifact's positioning is **Supabase-native**, and Cloudflare's `McpAgent` is **substrate-agnostic** (Workers + Durable Objects, no Postgres-Changes primitive). A Supabase customer building an agent that watches their own Postgres has a real reason to prefer the Supabase-native path. The recon's response to its own counter-framing 1 ("be the *Supabase-native* one") holds against the broad MCP-on-Edge data.

[Supabase BYO-MCP docs Apr 30 2026](https://supabase.com/docs/guides/getting-started/byo-mcp) document the `WebStandardStreamableHTTPServerTransport` + Edge Function pattern *exactly as the artifact ships it* — that's a tailwind, not a headwind. If Supabase intended to ship a canonical Realtime-MCP themselves, they'd cannibalize their own BYO doc; the BYO posture suggests "we'll let third parties fill this niche for now."

**Verdict: partially supported.** Cloudflare won the **broad** MCP-on-Edge category at scale; the Supabase-native niche is real but narrow. The recon's 6mo bet is high-confidence right *for the deployment shape*, not for the artifact specifically. The 18mo bet is overconfident: it depends on Supabase NOT shipping a canonical wrapper, and the [BKND acquisition (Feb 2026)](https://github.com/supabase/supabase/commit/21e9126fbf72fac607b63fe8bd84aaa7cab2494b) explicitly hires for "agentic Lite offering" — that's the kind of team that ships canonical wrappers. **Concrete adjustment: tighten Decision 2's 18mo claim to "medium" not "medium-high."**

### Counter-claim 3 — "zero npm competition means the niche doesn't matter"

**Restated:** § B claimed `@supabase/mcp-server-supabase`'s 84.9K weekly DL + production-disclaimer leaves the artifact "unopposed at the npm layer" in the agent-watches-production-data niche. Counter: empty niche = unattractive niche.

**Refutation evidence found:**

[Hacker News thread "Lessons from a year of Postgres CDC in production" (item=46332784)](https://news.ycombinator.com/item?id=46332784): the thread is about **PeerDB / Sequin / Debezium** for ETL-shaped CDC (Postgres → Kafka, Postgres → Postgres, Postgres → search index). **Zero comments mention "AI agent" as a CDC consumer.** The production CDC conversation in 2026 is shaped around ETL, not agent triggers.

[SynapticRelay (2026-03-30)](https://synapticrelay.com/articles/integrating-agents-pull-model-vs-webhooks): production-agent infra writeup explicitly recommends **polling over both webhooks and CDC for agent workers behind NAT/firewalls** — *"polling usually wins because it matches the actual network topology and security model of autonomous workers."* The "default to streaming substrate" claim from [DEV.to (Apr 19 2026)](https://dev.to/practiceoverflow/event-driven-agents-why-direct-cdc-just-killed-the-kafka-debezium-kafka-stack-4kgo) is a single blog post, not a converged industry stance.

[Sequin (sequinstream)](https://github.com/sequinstream/sequin): 30 contributors, MIT, Postgres-CDC-to-streams. Their landing page lists Kafka / SQS / Elasticsearch / HTTP endpoints — **AI agents not in the headline use case list.** PeerDB, similarly, is positioned for analytics replication. The closest production tooling targets ETL, not agent runtime.

**Steelman back:**

The 2026 H1 blog convergence § C cites is real — Streamkap, Tianpan, Drasi+Dapr, DEV.to, Knowlee all converged on "agent watches database" within Apr 2026 alone. The pattern is named-correctly even if production deployment hasn't caught up. And the artifact's primitive (`boundedWatch`) is *exactly* the bridge an agent-watches-database deployment needs that ETL tools don't provide (ETL tools dump to a queue; the agent still has to poll the queue).

The "zero competition" framing is also overdetermined: **`@supabase/mcp-server-supabase`'s 84.9K weekly downloads explicitly chose the platform-management shape because that's where Cursor/Windsurf/Claude integration lives — that's a market shape decision, not a "we tried agent-watches-data and abandoned" decision.** The original recon's reading of the inverse-shape evidence is fair.

**Verdict: inconclusive.** Cannot determine from public evidence whether agent-watches-CDC is a structurally unattractive niche or just an early-stage one. The blog convergence is real; the production volume isn't. The artifact's bet here is *correctly identified* as a trajectory bet, but Decision 6's adoption thresholds (100 DL / 30 stars / 1 external issue by month-6) **are calibrated against a non-empty niche assumption that has only blog-shape evidence.** If the niche stays sub-commercial, those thresholds will not be met regardless of artifact quality. **Concrete adjustment: Decision 6's "if zero issues" branch should explicitly distinguish between (a) artifact didn't reach the audience and (b) audience for the niche doesn't exist yet — these are very different operator decisions.**

### Counter-claim 4 — "discipline is not a moat for npm adoption"

**Restated:** Original recon's final adversarial pass concluded "the discipline is the moat" because no comparable ships pre-registered eval thresholds + 16 ADRs + FAIL→PASS smoke. Counter: discipline is invisible to most adopters and has no precedent as an adoption driver.

**Refutation evidence found:**

[arxiv:2204.04562 (Mozilla Foundation, 2022)](https://arxiv.org/abs/2204.04562) — "What are the characteristics of highly-selected packages? A case study on the npm ecosystem." Survey of 118 JS developers + regression analysis on 2,527 packages. **Result:** *"highly-selected packages tend to be correlated by the number of downloads, stars, and how large the package's readme file is."* README **size** is the documentation factor that correlates with selection — not depth, not ADR count, not methodology rigor. Discipline-as-moat has no empirical precedent in this paper.

[PkgPulse 2026 health score breakdown](https://www.pkgpulse.com/blog/npm-packages-best-health-scores-2026): documentation is **a sub-component of "Community" (25% of total)**, alongside stars-growth-rate, ecosystem integrations, and discussion activity. Documentation depth doesn't appear as a top-level dimension — release cadence, issue response, security, downloads dominate. The packages cited as 90+ scoring (Vite 97, Vitest 96, Drizzle 94, Zod 94, Tailwind 96, Hono 95) won via **maintenance velocity + ecosystem integration + named consumers**, not via ADR discipline. None of them ship 16 ADRs.

[Stack Overflow Developer Survey 2025](https://survey.stackoverflow.co/2025/): top adoption drivers are personal productivity / availability of better alternatives. Top *deal-breakers*: security/privacy, prohibitive pricing, availability of better alternatives. **"Documentation depth" or "methodology rigor" doesn't appear as either a driver or a deal-breaker.**

**Steelman back:**

The original recon's claim was narrower than "discipline drives adoption broadly." It was: discipline is the differentiator from *every other MCP-on-Supabase npm package*, given that none of them ship pre-registered eval thresholds. That's a relative claim about a small comparable set, not a universal one. **For the JD-pivot audience (supabase/agent-skills maintainers + hiring panel), discipline is observable and load-bearing — that audience is engineering-mature and reads ADRs.** § E persona 1 (senior engineer at Series B) was an external-adoption persona; the JD-pivot audience is internal/recruiter-shaped, and discipline-as-moat *for that audience* survives this counter-claim.

The recon's response to its own counter-framing 3 already absorbed this: *"the artifact's primary value is JD-pivot evidence, not external adoption."* The discipline-as-moat claim is correctly scoped to the JD-pivot audience, not the broad npm-adopter audience.

**Verdict: supported, but narrower than § D / § synthesis frames it.** Discipline does not drive broad npm adoption; the empirical literature on package selection is unambiguous. The original recon's discipline-as-moat claim survives only when scoped to the JD-pivot audience (which CLAUDE.md § Purpose explicitly names) — for the senior-engineer-evaluating-for-customer-support-agent persona § E describes, discipline is a tiebreaker at best, not a primary driver. **Concrete adjustment: Decision 1's "the discipline backbone is the actual headline" framing needs an audience-scoped qualifier — "headline for the portfolio audience; tiebreaker for the adopter audience."**

### Counter-claim 5 — "the GRANT-flip is a headwind, not a tailwind"

**Restated:** § A claimed *"the [Apr 2026 GRANT-default-flip changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) makes [finding 4] *more* general going forward."* The implicit framing: as the GRANT chain becomes more visible to all Supabase users, the artifact's 7-variant probe table becomes more relevant. Counter: Supabase will document this in their official docs within 1-3 months, removing the artifact's tailwind.

**Refutation evidence found (decisive):**

The GRANT-flip changelog **explicitly does NOT touch the realtime schema or the Realtime payload-visibility chain.** Verified via direct quote from the changelog FAQ:

> **"Does this affect tables in the storage, auth, realtime, or custom schemas?"**
> **"No. The change touches default privileges in the public schema. Tables in storage, auth, realtime, and any custom schemas you expose via the Data API keep their current grants and their current defaults."**

The flip is about Data API (PostgREST/GraphQL) exposure of `public.*` tables to `anon`/`authenticated`/`service_role`. The artifact's finding 4 chain is about **Realtime payload visibility under anon JWT** — same underlying primitive (Postgres GRANTs), but a *different* role-permission chain that the flip changelog FAQ explicitly excludes.

This means the original recon's framing is wrong in BOTH directions:
1. **Refutes original recon's claim that the flip is a tailwind** — the flip doesn't change the Realtime chain at all.
2. **Refutes my own counter-claim** that "Supabase will document this within 90 days" — the flip is for a different chain entirely; it doesn't trigger the realtime documentation update I predicted.

**Steelman back (now defending what's left):**

There is a *secondary* tailwind: the GRANT-flip increases overall ecosystem awareness of GRANT mechanics. Senior engineers reading the flip changelog learn that "explicit GRANTs are now load-bearing" and may then notice the related (different) Realtime chain. That's a soft signal, not a documentation-replacement risk.

The [Postgres Changes quickstart](https://supabase.com/docs/guides/realtime/postgres-changes) was last updated **2026-05-01** and already shows the GRANT chain as step 2 of the quickstart (verified above). So the chain *is* documented for the canonical case (`anon` + `public.*`); the artifact's contribution is the empirical decomposition of the **7 GRANT-and-RLS combinations** (anon-grant + RLS off, anon-grant + RLS on + permissive policy, etc.) — that's not in the quickstart, and won't be without an explicit doc effort.

**Verdict: refuted in both directions.** The original recon's "GRANT-flip is a tailwind" framing is wrong (different chain). My counter-claim's "Supabase docs the chain in 90 days" prediction is also wrong (flip doesn't trigger Realtime doc updates). **Net effect on the original recon: § A finding 4's tailwind claim should be removed entirely; the empirical 7-variant decomposition stands on its own merits without needing a regulatory tailwind.** This is the most surprising finding of the counter-pass — both sides were wrong about the flip's relevance to Realtime.

## Synthesis — net effect on the original recon's six Decisions

| Decision | Survives? | What changes |
|---|---|---|
| **1.** Reframe four-findings pitch | **Yes, with compression.** | "2 novel sub-findings" → "1 novel substrate (silent broadcast filter) + 1 novel methodology (Edge p99 distribution)." Drop the 7-variant probe table from "novel" claims; reframe as methodology demonstration. |
| **2.** MCP-on-Edge as headline / trajectory framing | **Yes, slightly tightened.** | 18mo bet drops from medium-high → medium. The BKND-hire signal raises the "Supabase ships canonical Realtime-MCP within 12mo" probability. The Cloudflare-won-the-broad-category data sharpens the "Supabase-native niche, not MCP-on-Edge broadly" framing. |
| **3.** README adds 5-min hello-world | **Yes, untouched.** | § E friction-map is independent of the counter-claims; no new evidence shifts it. |
| **4.** Blog post is technical-narrow | **Yes, with shape adjustment.** | Shape A ("warm-up distribution + 7-variant probe") leaned heavier on the 7-variant probe than counter-claim 1 supports. Shape B (silent-filtering contract) becomes the load-bearing-shape recommendation. Shape A drops the probe table to a supporting role. |
| **5.** Hold upstream as feedback-shape | **Yes, untouched.** | ADR-0004 framing was correctly identified; agent-skills issue tracker shows no realtime-shaped demand from the community, which strengthens (not weakens) the discussion-not-PR posture. |
| **6.** Adoption inflection on external issues | **Survives, but recalibrated.** | "Zero issues with ≥100 stars" branch needs a sub-distinction: (a) didn't reach the audience vs (b) niche has no audience yet. These are different operator decisions and the recon's binary framing flattens them. |

**No Decision collapses.** Two tighten (1, 2), two get sub-distinctions (4, 6), two are untouched (3, 5).

## Confidence calibration — was the original recon overconfident?

Three honest yeses, one no.

1. **Yes, on § A novelty claims.** The "two novel sub-findings" framing was generous. The 7-variant GRANT/RLS probe table is methodology demonstration, not novel decomposition — the canonical postgres-changes quickstart already prescribes the chain. The recon should have caught this; it didn't because the recon was *commissioned to validate two pre-loaded pushbacks*, not to falsify the artifact's discoveries.

2. **Yes, on § C 18mo trajectory confidence.** "Medium-high" was based on present-state signals (BYO-MCP docs published Apr 30) without weighing the BKND-acquisition signal (Feb 2026) as raising the "Supabase ships canonical Realtime-MCP within 12mo" probability. The recon noticed the BKND signal in passing but didn't update on it.

3. **Yes, on § A finding-4 tailwind framing.** The GRANT-flip explicitly excludes Realtime per the changelog FAQ. The recon got this backwards — citing it as a tailwind when it's neutral. This is a clean confirmation-bias artifact: the recon had a "show the artifact is timely" goal and pattern-matched the flip without checking the FAQ.

4. **No, on § B / § C / § E directional claims.** Supabase is genuinely positioned with the agent trajectory (the BYO-MCP doc, the agent-skills repo, the BKND hire all line up); the artifact has real positioning room at the agent-watches-CDC niche; the persona analysis is fair. The directional reads survive.

**Net:** the recon was ~10-15% overconfident on the artifact's novelty-of-findings claim, ~5-10% overconfident on the 18mo trajectory bet, neutral on direction. Not a 3-for-3 home run; closer to **2.5-for-3, with one specific framing error (GRANT-flip tailwind) that needs correction in any blog post.**

## What changes for the next ADR cycle

1. **Don't cite the GRANT-flip as a tailwind for finding 4.** The changelog FAQ explicitly excludes Realtime. Any blog post that frames it that way will be caught by attentive readers and undermine the artifact's credibility-via-discipline thesis. **Hard correction needed in the v1.0.0 ADR (ADR-0016) rationale and any pre-blog drafts.**

2. **Compress the "novel sub-findings" claim from 2 to 1.5.** The silent-filtering contract on broadcast denial is genuinely novel. The Edge p99 distribution is genuinely novel as a measurement. The 7-variant GRANT/RLS probe table is *methodology demonstration on documented mechanics* — keep it as evidence of discipline-applied, not as a finding-shaped contribution.

3. **Audience-scope the discipline-as-moat claim.** "Discipline is the moat for the JD-pivot audience" is supported. "Discipline is the moat for npm adoption" is unsupported by the empirical package-selection literature (arxiv:2204.04562, PkgPulse, SO Survey 2025). The README and any blog should not conflate these.

4. **The 18mo MCP-on-Edge bet has a named risk**: BKND-shipped canonical Realtime-MCP. The recon noted this in passing; it deserves explicit treatment in ADR-0017 (the trajectory-framing ADR) as a risk to monitor. Concrete trigger: if `supabase-community/supabase-mcp` adds a `subscribe_to_realtime` tool *after* 2026-05-03, the artifact's positioning room shrinks materially within 6 months, not 12-18.

5. **No ADR collapses; no Decision is reversed.** The counter-pass produces calibration adjustments, not a redirect. The artifact's adoption proposition is *real and narrower than even the original recon's narrower-reading admitted* — the JD-pivot path remains the load-bearing audience; external adoption stays upside-tracking.

## References

**Internal:**
- [`docs/recon/2026-05-03-real-world-adoption-recon.md`](2026-05-03-real-world-adoption-recon.md) — the recon this counter-pass tests.
- [`CLAUDE.md`](../../CLAUDE.md) § Purpose — "the audience is supabase/agent-skills maintainers + JD's hiring panel."
- [`docs/decisions/0004-reshape-t31-as-user-feedback.md`](../decisions/0004-reshape-t31-as-user-feedback.md) — confirmed by zero realtime-shaped demand in upstream issue tracker.

**External — counter-claim 1:**
- [Postgres Changes guide (2026-05-01)](https://supabase.com/docs/guides/realtime/postgres-changes) — canonical GRANT-chain quickstart + private-schemas section.
- [Realtime Authorization docs (2026-05-01)](https://supabase.com/docs/guides/realtime/authorization) — verified via WebFetch: silent-filtering contract NOT documented.
- [supabase-js#1599](https://github.com/supabase/supabase-js/issues/1599) — warm-up bug report ("1-3 seconds"), no public p99 distribution.

**External — counter-claim 2:**
- [MCPFind cloud category (2026-04-24)](https://mcpfind.org/blog/host-mcp-server-remotely-cloudflare-cloud-run) — Cloudflare top of cloud category at 3,566 stars; 158 servers; avg 61.87 stars.
- [Cloudflare iMARS internal-MCP writeup (2026-04-20)](https://techflowdaily.com/the-ai-engineering-stack-we-built-internally-on-the-platform-we-ship/) — 3,683 internal Cloudflare engineers (60.1%) on internal MCP infrastructure.
- [supabase/agent-skills issues (2026-05-02)](https://github.com/supabase/agent-skills/issues) — verified via `gh api`, 11 open issues, zero realtime-shaped.
- [supabase-community/supabase-mcp issues (2026-05-02)](https://github.com/supabase-community/supabase-mcp/issues) — verified via `gh api`, 2 open issues, no `subscribe_to_realtime` request.
- [BKND joins Supabase (2026-02-04 commit)](https://github.com/supabase/supabase/commit/21e9126fbf72fac607b63fe8bd84aaa7cab2494b) — agentic-Lite hire signal.

**External — counter-claim 3:**
- [HN "Lessons from a year of Postgres CDC in production"](https://news.ycombinator.com/item?id=46332784) — thread shape: ETL not agents.
- [SynapticRelay polling-vs-webhooks-for-agents (2026-03-30)](https://synapticrelay.com/articles/integrating-agents-pull-model-vs-webhooks) — production agent infra recommends polling for NAT/firewall reasons.
- [Sequin (sequinstream)](https://github.com/sequinstream/sequin) — production CDC tool, ETL-shaped use cases, AI agents not in headline list.

**External — counter-claim 4:**
- [arxiv:2204.04562 (Mozilla)](https://arxiv.org/abs/2204.04562) — npm package selection: downloads + stars + README size correlate with selection. No discipline factor.
- [PkgPulse health scores 2026](https://www.pkgpulse.com/blog/npm-packages-best-health-scores-2026) — top-90 packages win on maintenance velocity + ecosystem + named consumers; none ship 16 ADRs.
- [Stack Overflow Developer Survey 2025](https://survey.stackoverflow.co/2025/) — top adoption drivers + deal-breakers don't include documentation depth or methodology rigor.

**External — counter-claim 5:**
- [GRANT-default-flip changelog FAQ (2026-04-28)](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) — *"Does this affect tables in the storage, auth, realtime, or custom schemas? No."* Decisive.
