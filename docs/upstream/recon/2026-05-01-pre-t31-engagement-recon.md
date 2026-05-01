# Pre-T31 engagement recon — `supabase/agent-skills`

**Date:** 2026-05-01
**Author:** Diego Gomez
**Trigger:** Operator declined to file T31 (the upstream-issue task in `docs/upstream/plan/2026-04-30-supabase-realtime-skill-build.md` § Task 31) without first verifying it would actually accomplish spec § 13 success criterion #4 ("substantive maintainer engagement"). This recon snapshots the upstream repo state + community signal + JD overlap as of 2026-05-01 to support that decision.

This complements the original `2026-04-30-portfolio-redesign-recon.md` — the earlier recon set the strategic thesis (empty niche, Skill+MCP form factor, depth over breadth); this one stress-tests whether the upstream-issue lever still holds given live evidence.

## 1. `supabase/agent-skills` repo state

**Repo:** [supabase/agent-skills](https://github.com/supabase/agent-skills) — 2,028 ⭐, 133 forks, MIT, created 2026-01-16, last push 2026-04-30.

**Skills currently shipped — exactly two, both Supabase-authored:**

- [`skills/supabase`](https://github.com/supabase/agent-skills/tree/main/skills/supabase) — single SKILL.md (8.8 KB), one reference file (`skill-feedback.md`). Description trigger explicitly names *"Supabase products (Database, Auth, Edge Functions, Realtime, Storage, Vectors, Cron, Queues)..."* — so Realtime is already in scope.
- [`skills/supabase-postgres-best-practices`](https://github.com/supabase/agent-skills/tree/main/skills/supabase-postgres-best-practices) — 31 reference files in 8 categories.

No sub-skill split for Realtime / Auth / Storage / etc. exists.

**Critical history — the realtime references were created and then absorbed:**

- [PR #21](https://github.com/supabase/agent-skills/pull/21) (merged 2026-02-06, by `Rodriguespn` / Pedro Rodrigues, Supabase) added 8 realtime reference files: `realtime-broadcast-basics.md`, `realtime-broadcast-database.md`, `realtime-patterns-{cleanup,debugging,errors}.md`, `realtime-postgres-changes.md`, `realtime-presence-tracking.md`, `realtime-setup-{auth,channels}.md`.
- [PR #12](https://github.com/supabase/agent-skills/pull/12) (merged 2026-04-05) consolidated all references into the single `supabase` SKILL.md body. Tree on main has **zero** standalone realtime reference files now.

**The maintainer's stated direction in writing — load-bearing for T31 strategy:**

[PR #26](https://github.com/supabase/agent-skills/pull/26) (`jorgoose`, 2026-01-28) proposed a `supabase-cli` sub-skill. Closed by Rodriguespn ([comment](https://github.com/supabase/agent-skills/pull/26#issuecomment-3812458194)) with:

> *"We're currently developing a single Supabase skill that includes multiple reference files. Given the overlap between several CLI commands and MCP server tools, it makes sense to include both the CLI and the MCP server within the same set of references."*

This is policy. T31 as currently drafted ("propose this as a `realtime` sub-skill complementing the broad `supabase` skill") asks the maintainers to violate it.

**External-contribution pattern — substantive proposals: 100% rejected or stalled:**

| PR | Author | Topic | Outcome |
|---|---|---|---|
| [#26](https://github.com/supabase/agent-skills/pull/26) | jorgoose | `supabase-cli` sub-skill | Closed Jan 2026 with policy comment above |
| [#47](https://github.com/supabase/agent-skills/pull/47) | mattrossman | Braintrust eval PoC | Closed without merge, no engagement |
| [#48](https://github.com/supabase/agent-skills/pull/48) | qvad | YugabyteDB skill | Closed, no engagement |
| [#51](https://github.com/supabase/agent-skills/pull/51) | mdvnavy | schema improvements | Closed, no comments |
| [#45](https://github.com/supabase/agent-skills/pull/45) | ahorn720 | auth flow checklist | **Open 2 months, zero maintainer reply** |
| [#52](https://github.com/supabase/agent-skills/pull/52) | saltcod | edge function embeddings | **Open, only one drive-by comment, zero maintainer engagement** |

External PRs that DID land were all small (typo fixes, MIT license, GiST docs, dependabot). PRs from Pedro / Greg make up ~58 of 66 PRs ever.

**Issues:** 7 open, mostly user-feedback-template bug reports against existing skill content ([#70](https://github.com/supabase/agent-skills/issues/70), [#63](https://github.com/supabase/agent-skills/issues/63), [#50](https://github.com/supabase/agent-skills/issues/50)). External proposal issues [#68 SkillClaw](https://github.com/supabase/agent-skills/issues/68) and [#59 her-skill](https://github.com/supabase/agent-skills/issues/59) sit at **zero comments**.

**Discussions are disabled on the repo** — so CONTRIBUTING.md's prescribed *"open a Discussion first"* escalation path doesn't actually exist.

**Maintainers — only two ship code:** [gregnr](https://github.com/gregnr) (Greg Richardson, "DX / AI Lead @supabase", owns MCP launches) and [Rodriguespn](https://github.com/Rodriguespn) (Pedro Rodrigues, Supabase). Both Supabase employees.

## 2. MCP discussion #2585 sentiment

[MCP Discussion #2585](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2585) is the **April 14, 2026 office hours notes** for the "Skills Over MCP Interest Group" working through the Skills Extension SEP (PR #69). **Zero replies since posting.**

The IG is debating script execution over MCP ([Issue #64](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/64)), zipped skill directories ([#61](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/61)), and resource-template skill discovery ([#57](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/57)). Sentiment is "cautiously optimistic with acknowledged tensions" — the SEP intentionally separates skill distribution from MCP tool management.

**There is no consensus answer to "is Skill+MCP pairing a product shape."** Citing this discussion in T31 reads as live debate, not validation.

## 3. Downstream pain signal

**Near-zero specific demand for "agent watches database" / bounded subscription patterns.** What exists:

- GitHub issue search for `"supabase realtime subscribe agent"` / `"agent watch database changes"` / `"postgres-changes agent"`: **zero relevant hits** (one Chinese-language issue [agent-nexus #12](https://github.com/Jiayiyan-OPC/agent-nexus/issues/12) about removing a realtime subscription).
- `"Supabase realtime agent"` returns mostly application-layer issues — chat apps showing AI processing status, live-update UIs, progress bars. These are *frontend* realtime use cases, not *agent-as-subscriber*. Examples: [rikky-hermanto/personal-finance #75](https://github.com/rikky-hermanto/personal-finance/issues/75), [OpenDCAI/Mycel #267](https://github.com/OpenDCAI/Mycel/issues/267), [kjswalls/v0-anchor #121](https://github.com/kjswalls/v0-anchor/issues/121).
- npm: `@intentsolutionsio/supabase-pack` and `@intentsolutionsio/supabase-skill-md-pack` exist as competing skill bundles ("30 skills covering ... realtime subscriptions"), but no `supabase-realtime`-specific skill on npm with download signal. Bounded-subscription primitive is novel in the search space.
- community.supabase.com: no indexed results for "realtime agent claude".
- [Supabase blog post](https://supabase.com/blog/supabase-agent-skills) "AI Agents Know About Supabase. They Don't Always Use It Right" — framing is correctness on existing Supabase usage, not novel agent patterns.

**Honest assessment:** the "agent watches database" pattern this artifact pioneers is **not a pain point users are asking for in writing.** That doesn't make it wrong — it can be a thesis-leading proposal — but it can't be defended via "this answers a queue of GitHub issues."

## 4. Catalog direction

**Strongly monolith, not federation.** Evidence:

- [PR #26 rejection comment](https://github.com/supabase/agent-skills/pull/26#issuecomment-3812458194) is unambiguous policy.
- PR #21 added separate realtime reference files; PR #12 (next major consolidation, same maintainer) absorbed them into the single SKILL.md body. **Direction of travel is consolidation, not splitting.**
- Current `supabase` SKILL.md `description` already lists Realtime as an explicit trigger.
- Sister repo [supabase-community/supabase-plugin](https://github.com/supabase-community/supabase-plugin) is also single-plugin.
- Recent commits (last 60 days, all by gregnr / Rodriguespn): release-please workflow, marketplace integration, doc link fixes, Data API instructions. **No signaling of sub-skill plans.**

The JD says *"build and maintain Supabase's AI tooling, including surfaces such as MCP, agent skills, and other interfaces"* — they want the *system* to grow, but the grow-pattern is references-in-monolith, not standalone sub-skill repos.

## 5. JD overlap

[JD on Accel jobs board](https://jobs.accel.com/companies/supabase-2/jobs/76445193-ai-tooling-engineer) responsibilities literally are this artifact's pitch:

- *"Build and maintain Supabase's AI tooling, including surfaces such as MCP, agent skills..."*
- *"Drive an eval-first approach by building and improving evaluation frameworks, instrumentation, and feedback loops"*
- *"Build tools for customers to incorporate AI, including MCP on Edge Functions and vector embeddings"*

**Hiring panel almost certainly includes Greg Richardson** (gregnr — DX/AI Lead, owns MCP launches per [his Twitter](https://x.com/ggrdson), one of two committers on agent-skills). Probability that the agent-skills maintainer IS the hiring manager or panel member is very high.

JD names "MCP on Edge Functions" + "vector embeddings" specifically — your artifact ships both. **Thesis-fit for the role is exceptional.**

## 6. Three options ranked by confidence

**(A) File T31 now as drafted — confidence 25%.** Asks the maintainer to violate his stated policy. Almost certainly closed-without-merge or unanswered. Either outcome is *negative* signal in front of the hiring panel — it advertises that you didn't read the room.

**(B) Reshape T31 then file — confidence 60%.** Don't propose a new sub-skill. File an issue using their actual `[User Feedback]` template ([template](https://github.com/supabase/agent-skills/blob/main/.github/ISSUE_TEMPLATE/user-feedback.md)) citing concrete corrections to the existing `supabase` SKILL.md realtime trigger surface (the ~5s warm-up window from T7 and the `replica identity full` requirement are concrete, falsifiable, and demonstrably missing from the current SKILL.md body). Cite the worked example + spike findings as evidence. Offer to contribute reference files (the merge path that actually works — see PR #21 from Pedro and PR #30 from external `tomaspozo` that landed). Link the standalone artifact as: *"Here's the deeper pattern I extracted while writing the user feedback — happy to discuss whether any of it belongs upstream."* Matches stated process AND keeps the artifact as a portfolio piece without forcing them into a "no" position.

**(C) Don't file; spend the time elsewhere — confidence 40%.** Standalone artifact (npm + Edge deploy + worked example + eval harness + ADRs) IS the deliverable. The hiring panel can read the README. T31's marginal value is "shows you engaged with the maintainer community"; its marginal risk is "the engagement gets quietly closed and that becomes the most public artifact of your work." Better uses of the time: (1) reshape the LinkedIn / blog post tagging gregnr organically (lower-risk channel, no maintainer-assent needed), (2) actively discover & comment-with-substance on the existing open issues to build context, then file (B) with relationship pre-built.

## Verdict

Option **(B)**, with a hard lean. See `docs/decisions/0004-reshape-t31-as-user-feedback.md` for the locked-in decision and the reshaped issue body draft.

## Sources

- [supabase/agent-skills repo](https://github.com/supabase/agent-skills)
- [PR #26 rejection comment (the policy)](https://github.com/supabase/agent-skills/pull/26#issuecomment-3812458194)
- [PR #12 consolidation](https://github.com/supabase/agent-skills/pull/12)
- [PR #21 realtime references](https://github.com/supabase/agent-skills/pull/21)
- [MCP Discussion #2585](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2585)
- [AI Tooling Engineer JD on Accel](https://jobs.accel.com/companies/supabase-2/jobs/76445193-ai-tooling-engineer)
- [Greg Richardson GitHub](https://github.com/gregnr) / [Pedro Rodrigues GitHub](https://github.com/Rodriguespn)
- [User-feedback issue template](https://github.com/supabase/agent-skills/blob/main/.github/ISSUE_TEMPLATE/user-feedback.md)
