# ADR 0002: relabel seed `f019-...-sso-redirect` from `general` to `engineering`

**Date:** 2026-04-30
**Status:** Accepted
**Decider:** Diego Gomez
**Context:** ci-full v0.1.1 (post-pgvector) gate fails on `action_correctness.ci_low`; f019 is one of two seed clusters driving the failure. ADR-0001 frames the manifest amendment policy.

## The seed under review

`fixtures/ci-fast/f019-gen-account-sso-redirect.json`:

```json
{
  "id": "f019-gen-account-sso-redirect",
  "ticket": {
    "subject": "SSO login redirects me to a blank page after Okta auth",
    "body": "When I log in via our Okta SSO, the Okta side completes successfully but I land on a blank Supabase page (no error, no dashboard). Hard reload sends me back to the login screen. This started today; my coworker has the same issue. Tried Chrome and Firefox, same result."
  },
  "expected_routing": "general"
}
```

Plus 4 LLM-augmented variations in `fixtures/ci-full/` (`n091`–`n095`).

## What the eval caught

In every ci-full run since pgvector was wired, all 5 f019 trials route to `engineering` (4 trials) or `urgent` (1 trial). The agent — running claude-haiku-4-5 over a 5-shot pgvector retrieval — never picks `general`. Looking at the resolved-corpus neighbors retrieved for these trials, the model is correctly identifying that "two coworkers blocked from logging in" is structurally similar to other service-failure tickets in the corpus.

## Why the original label was wrong

The seed was labeled `general` during ci-fast curation under the assumption that "account/auth flow issues" sit in the same bucket as "rename project," "invite team member," and "find docs." That bundling is wrong on inspection:

- **The customer is actively blocked.** Two coworkers cannot log in. Not a question, not a feature request, not docs — a bug stopping work.
- **The page is broken, not unfamiliar.** "Blank page after auth completes" is server-side: SSO callback is failing or the dashboard route isn't rendering for SSO-authenticated sessions. That's an engineering investigation, not a customer-side question.
- **The other genuine `general` seeds don't share this shape.** f016 ("where are the docs for RLS?"), f018 ("how do I invite a team member?"), f020 ("thanks for the new dashboard") — these are *questions* or *commentary*. f019 is a *bug report*.

The agent's behavior here is a feature, not a flaw. A triage system that routes "two coworkers can't log in" to `general` (along with newsletter signups and feature requests) is misbehaving. The seed label was making the agent look wrong for being right.

## Decision

Update `expected_routing` from `"general"` to `"engineering"` in all 6 affected fixtures (ci-fast `f019-gen-account-sso-redirect.json` + ci-full `n091`–`n095`). Leave the file/id naming with `-gen-` intact — renaming would erase the audit trail of which seeds were originally mislabeled.

Embeddings are not regenerated: the ticket text (subject + body) is unchanged, only the ground-truth label.

## Why this is not threshold gaming

ADR-0001's pre-registration discipline prohibits *changing thresholds* after seeing data. The thresholds in `manifest.json` v1.0.0 are unchanged. What's changing is the *ground truth* against which the eval scores — and only because re-reading the fixture revealed a labeling error any human review would have flagged. The eval's job is to catch this kind of thing.

The honest disclosure path:
- This ADR documents the relabel and the reasoning, in the repo, before re-running the eval.
- The git history preserves the original labels (commit `2b95b35` for ci-fast seeds, `d705b17` for ci-full).
- The writeup will reference this ADR when reporting the post-relabel ci-full results.

## Why f017 stays as-is

The other systematically-failing cluster (f017 "Feature request: pgvector queries with metadata pre-filter that uses HNSW") was also reviewed. It stays `general`. The user is asking about *roadmap and design patterns*, not requesting a fix. The phrase "is this on any roadmap, or is the current advice 'use a generated column + partial index'" is the tell — they're surveying options, not blocked. That f017 is technically dense doesn't change the routing intent. The agent's `engineering` routing is defensible but the seed label is correct: feature requests and roadmap questions go to `general`.

The 5/5 f017 variations will continue to misroute under v0.1.x. That's accepted as honest portfolio noise. v0.2 may revisit via a richer corpus (more `general` examples that *do* contain technical content) or model swap.

## Predicted effect

Pre-relabel ci-full (`eval/reports/ci-full-1777596701118.json`):
- action_correctness: 90/100 = 0.900, CI low 0.826, FAIL on `action_correctness_ci_low_min: 0.85`

Post-relabel prediction:
- action_correctness: 95/100 = 0.950, Wilson CI low at n=100 ≈ 0.89, PASS

If the prediction holds, the v1.0.0 manifest gate FAIL state from ADR-0001 collapses to **only** the Wilson upper-CI ceilings on missed/spurious events (which need n=300 to clear, per ADR-0001). Action correctness would PASS unaided.

If the prediction misses (the agent now over-routes elsewhere), this ADR remains a documented mislabel correction; the gate result reflects a real composition issue, not a label bug.

## References

- ADR-0001 — manifest v1.0.0 pre-registration discipline; explains why thresholds aren't being amended
- `eval/reports/ci-full-1777596701118.json` — the run this ADR responds to
- `fixtures/ci-fast/f019-gen-account-sso-redirect.json` — the seed under review
- `playbook/PLAYBOOK.md` § 9 — pre-registration vs. ground-truth hygiene
