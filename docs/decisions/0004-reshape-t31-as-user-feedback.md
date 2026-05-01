# ADR 0004: reshape T31 as `[User Feedback]` issue, not sub-skill proposal

**Date:** 2026-05-01
**Status:** Proposed (recommendation pending operator decision; not yet accepted)
**Recommender:** Claude Opus 4.7 (assistant)
**Decider:** Diego Gomez (TBD)
**Context:** Plan task T31 (in `docs/upstream/plan/2026-04-30-supabase-realtime-skill-build.md` § Task 31) drafts a proposal-shaped issue for `supabase/agent-skills` framing this artifact as a candidate `realtime` sub-skill. Pre-file recon (see `docs/upstream/recon/2026-05-01-pre-t31-engagement-recon.md`) revealed the maintainer's stated direction is **monolith + references**, not federation. Filing as drafted would ask the maintainer to violate his own published policy and almost certainly get the same closed-without-merge or unanswered treatment as PRs #26, #47, #48, #51, #45, #52, #68, #59.

## The conflict between original T31 and observed reality

T31 frames the artifact as: *"this could fit as a `realtime` sub-skill complementing the broad `supabase` skill that already names Realtime in scope."*

The maintainer (Pedro Rodrigues) closed [PR #26](https://github.com/supabase/agent-skills/pull/26#issuecomment-3812458194) with: *"We're currently developing a single Supabase skill that includes multiple reference files. Given the overlap between several CLI commands and MCP server tools, it makes sense to include both the CLI and the MCP server within the same set of references."*

PR #21 (his own) added 8 separate realtime reference files in Feb 2026; PR #12 (his own) absorbed them all into the single SKILL.md body in April 2026. Direction of travel = **consolidation**.

So T31's original framing fights the observed direction. Spec § 13 success criterion #4 (*"substantive maintainer engagement"*) is satisfied by *any* response (positive, negative, or in-discussion), but the JD-load-bearing read is whether the response is **net-positive in front of a hiring panel that almost certainly includes Greg Richardson** (DX/AI Lead, agent-skills committer, MCP launches owner — see recon § 5).

A "thanks but closed — see our policy in PR #26" response is technically SC#4-satisfying *and* JD-net-negative. We avoid that asymmetry.

## Recommendation (not yet a decision)

Reshape T31 as a [User Feedback] issue using the repo's actual [`user-feedback.md` template](https://github.com/supabase/agent-skills/blob/main/.github/ISSUE_TEMPLATE/user-feedback.md). The issue would:

1. Cites concrete corrections the existing `supabase` SKILL.md body needs in its Realtime trigger surface (the ~5s warm-up window after `subscribe()`; the `replica identity full` requirement for UPDATE event payloads; the bounded-subscription budget that fits Edge Function 150s isolate caps).
2. Cites this artifact's spike findings + worked example as evidence (`docs/spike-findings.md` § T7; `references/replication-identity.md`; `references/edge-deployment.md`).
3. Offers to contribute reference files in the path that actually works — see PR #21 (Pedro's own) and PR #30 (external `tomaspozo`) for the merge pattern.
4. Links the standalone artifact at the bottom as *"here's the deeper pattern I extracted while writing this feedback — happy to discuss whether any of it belongs upstream"* — neither leading with the proposal-shape nor hiding the work.

This **respects their stated process**, **leverages our concrete evidence** (the warm-up window is falsifiable in 90 seconds against a fresh branch), and **gets the artifact in front of gregnr without setting up a no**.

## Decision options still on the table

This ADR is filed in **Proposed** state because the operator has not yet committed. The three live options remain:

- **(A) File T31 as originally drafted** (sub-skill proposal). Recon § 6 estimates ~25% confidence this lands well.
- **(B) Adopt this ADR** (reshape as user-feedback). Recon § 6 estimates ~60% confidence.
- **(C) Don't file at all.** The standalone artifact (npm + Edge deploy + writeup + ADRs + eval discipline) is the deliverable; T31 is optional. Recon § 6 estimates ~40% confidence on the time-tradeoff being worth a different action (e.g., LinkedIn / blog post tagging gregnr organically).

Promote this ADR to **Accepted** if option (B) is chosen, **Rejected** if (A) or (C) is chosen.

## Reshaped issue body (draft, contingent on accepting this ADR)

```markdown
**Title:** [User Feedback] Realtime trigger surface in `supabase` skill — three operational gaps

I've been building agents on top of Supabase Realtime/CDC for the past few weeks (worked example: `support-ticket triage agent` composing CDC + pgvector + Automatic Embeddings + Broadcast over a real Pro branch). Three concrete operational behaviors weren't covered in the current `supabase` SKILL.md Realtime triggers, and they're load-bearing — agents that subscribe-then-immediately-write hit them silently:

**1. ~5-second warm-up window after `subscribe()` resolves SUBSCRIBED**

On a freshly-published table, INSERTs in the first ~5s after `subscribe()` resolves are not delivered. Steady-state latency after warm-up is ~100-200ms. Agents that subscribe and then immediately write their own work miss their own first event. Reproduces against fresh transient branches; the worked-example eval harness uses a long-lived adapter + throwaway warm-up insert/watch pair to absorb this. Reference write-up at https://github.com/0xquinto/supabase-realtime-skill/blob/main/docs/spike-findings.md#T7 and https://github.com/0xquinto/supabase-realtime-skill/blob/main/references/replication-identity.md.

**2. `replica identity full` is required for UPDATE event payloads to carry the old row**

Without it, agents reading `payload.old` on UPDATE events see only PK columns. The current SKILL.md body doesn't surface this; it bites anyone who tries to do diff-based agent reactions (e.g., "react when status transitions from X to Y"). Reference: https://github.com/0xquinto/supabase-realtime-skill/blob/main/references/replication-identity.md.

**3. Bounded-subscription pattern fits Edge Function isolate budgets**

Edge Functions cap wall-clock at 150s. A long-lived realtime subscription doesn't fit; a bounded-subscription pattern (block until N events or timeout, return, optionally loop on new invocation) does. The MCP shape this artifact ships caps `timeout_ms ≤ 120s` for that reason. Worth flagging in the SKILL.md body if Edge Function deployment is a recommended path. Reference: https://github.com/0xquinto/supabase-realtime-skill/blob/main/references/edge-deployment.md.

---

Happy to PR these as additions to the existing `supabase` SKILL.md body (matching the consolidation pattern in PR #12), or as separate reference files following the `realtime-*.md` convention from PR #21 if the structure has shifted. Whichever fits.

**Standalone artifact for context** (extracted from the same investigation; not asking for absorption — just citing as evidence the gaps reproduce in a real worked example):
- Repo: https://github.com/0xquinto/supabase-realtime-skill
- npm: https://www.npmjs.com/package/supabase-realtime-skill
- Live deploy verification: JSON-RPC `tools/list` round-trip transcript in https://github.com/0xquinto/supabase-realtime-skill/blob/main/docs/writeup.md#4-eval-results
- Eval methodology + 4-metric harness: https://github.com/0xquinto/supabase-realtime-skill/blob/main/references/eval-methodology.md

Thanks for reading.
```

## Why this shape works

- **Matches the actual issue template** (`[User Feedback]`), not a proposal template that doesn't exist on the repo.
- **Names three falsifiable behaviors**, not a thesis. Anyone with a Pro project can verify in 5 minutes.
- **Offers PR-shape that lands** (additions to existing SKILL.md body, matching PR #12's consolidation pattern OR separate reference files matching PR #21 convention) — the maintainer picks the shape, we don't force one.
- **Links the standalone artifact at the bottom**, framed as evidence not as a candidate sub-skill. The hiring panel can click through to see the depth without the upstream issue forcing a "yes/no" on their absorption.
- **Doesn't cite MCP discussion #2585**. That discussion has zero replies since April 14; citing it reads as live debate not validation.

## What this doesn't do

- **Doesn't claim sub-skill status.** The recon's evidence on monolith direction is unambiguous; we accept it.
- **Doesn't ask for engagement on the form factor.** The Skill+MCP pairing question is real but unresolved upstream — that's a conversation for elsewhere (MCP-WG itself, Anthropic skills team), not for this issue.
- **Doesn't promise a follow-up if no response.** Spec § 13 and the original T31 had a "post a follow-up at 7 days" plan — drop that. If the issue lands warmly, follow-up shape will be obvious from the response. If it lands coldly, an unprompted bump is more annoying than helpful.

## How v0.2 should evolve this

If the issue gets engagement and PR contribution is welcomed, two next moves:

1. PR the three reference files (or sections in the consolidated SKILL.md body) for the warm-up window, replica identity, and Edge bounded-subscription pattern. Small, scoped, easy to merge.
2. After the PR lands, the standalone artifact's `references/` pages can link upstream as canonical and drop the duplicated content — the artifact becomes "MCP server + worked example + eval harness" while the *pattern documentation* lives upstream where it'll get more eyeballs.

If the issue gets no engagement (which the recon says is plausible — see PR #45, #52 stalled cases), the standalone artifact remains the deliverable. The reshape just minimizes the asymmetry between possible outcomes.

## References

- `docs/upstream/recon/2026-05-01-pre-t31-engagement-recon.md` — the recon that drove this decision
- `docs/upstream/plan/2026-04-30-supabase-realtime-skill-build.md` § Task 31 — the original T31 framing this ADR overrides
- `docs/upstream/spec/2026-04-30-supabase-realtime-skill-design.md` § 13 — success criterion #4 ("substantive maintainer engagement")
- [PR #26 rejection comment](https://github.com/supabase/agent-skills/pull/26#issuecomment-3812458194) — the policy
- [PR #21](https://github.com/supabase/agent-skills/pull/21) / [PR #12](https://github.com/supabase/agent-skills/pull/12) — the create-then-absorb history that establishes monolith direction
