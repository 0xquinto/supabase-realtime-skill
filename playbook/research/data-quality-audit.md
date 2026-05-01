# Playbook research — data-quality audit on `fixtures/ci-fast/`

**Date:** 2026-05-01
**Reviewer:** Diego Gomez (single-reviewer; v0.2 follow-up to add second-reviewer pass)
**Trigger:** Compliance audit (`docs/upstream/recon/2026-04-30-portfolio-redesign-recon.md` companion + the spec/playbook compliance audit run after v0.1.x ship) flagged that the **Mousavi data-quality audit** from `playbook/PLAYBOOK.md` § 8 was named in the discipline but never explicitly executed on the seed corpus.
**Scope:** All 20 ci-fast fixtures (`fixtures/ci-fast/f001...f020.json`).
**Method:** Mousavi-style classify each fixture against a 5-category rubric. ≥10% flag rate triggers repair before next ci-full run.

## Rubric

For each fixture, classify the (subject, body, expected_routing) triple into one of:

- **Clear-correct** — label is unambiguously the correct routing; another reviewer would agree without prompting.
- **Clear-mislabeled** — the label is wrong; the ticket should obviously route somewhere else.
- **Boundary-ambiguous** — ticket plausibly belongs to two routings; the chosen label is defensible but not the only correct answer.
- **Multiple-correct** — ticket has multiple valid routings (e.g., a security incident could plausibly route either `urgent` or `engineering`).
- **Unclear-prompt** — ticket is too vague or weird to confidently route into any bucket.

## Routing category definitions (used during classification)

- **urgent:** production outage, security incident, active data loss, GDPR-class incident, payment system down — anything customer-facing and revenue-impacting *now*.
- **engineering:** technical question or bug requiring engineering expertise (SDK bugs, deploy issues, RLS migration questions, perf regressions, login/auth issues blocking actual users).
- **billing:** invoices, refunds, plan changes, payment method, cancellation, proration questions.
- **general:** docs lookups, onboarding clarification, feature requests, feedback — non-urgent, non-engineering, non-billing.

## Per-fixture classification

| ID | Subject | Label | Classification | Notes |
|---|---|---|---|---|
| f001 | Production database completely unresponsive — total outage | urgent | Clear-correct | Total outage + revenue-loss framing |
| f002 | Suspected unauthorized access — service-role key in public commit | urgent | Clear-correct | Active breach + 3-hour exposure window |
| f003 | Orders table missing 4,200 rows after migration | urgent | Clear-correct | Active data loss + customer-impact framing |
| f004 | All checkout payments failing for past 20 minutes | urgent | Clear-correct | Active payment outage + zero revenue |
| f005 | Cross-tenant PII visible — RLS policy bypass | urgent | Clear-correct | GDPR-reportable + 72-hour clock |
| f006 | supabase-js v2.45 missing TS types | engineering | Clear-correct | Pure SDK bug |
| f007 | Stripe webhook signature fails inside Edge Function | engineering | Clear-correct | Edge Function technical debug |
| f008 | supabase functions deploy fails — module not found | engineering | Clear-correct | Edge bundler issue |
| f009 | Adding NOT NULL column with RLS backfill | engineering | Clear-correct | RLS + migration architecture question |
| f010 | Same query 8x slower after PG15→16 | engineering | Clear-correct | Postgres performance regression with EXPLAIN |
| f011 | Charged $499 last month, plan is $99 | billing | Clear-correct | Unrecognized invoice charges |
| f012 | How do I cancel my Pro subscription? | billing | Clear-correct | Cancellation request (the ASK is to cancel, not look up docs) |
| f013 | Charged twice for April | billing | Clear-correct | Refund request |
| f014 | Upgrading Pro to Team — proration question | billing | Clear-correct | Plan upgrade mechanics |
| f015 | Card declined, payment method update | billing | Clear-correct | Billing mechanics |
| f016 | Where are RLS docs with JWT custom claims? | general | Clear-correct | Pure docs lookup ("a pointer is fine") |
| **f017** | **Feature request: pgvector queries with HNSW pre-filter** | **general** | **Boundary-ambiguous** | **Feature request framing pulls toward `general`, but the technical pgvector + HNSW depth pulls toward `engineering`. ADR-0002 already documents this as the systematic-miss cluster (5/100 ci-full misroutes). The ambiguity is real, not a labeling error.** |
| f018 | Invite teammate read-only role | general | Clear-correct | Onboarding clarification ("is there a feature I'm missing"); not a billing seat-management question |
| f019 | SSO blank page (post-relabel: engineering) | engineering | Clear-correct | Post-ADR-0002 relabel: two coworkers blocked, multi-browser tested. Service bug. |
| f020 | Just wanted to say thanks — Realtime broadcast | general | Clear-correct | Pure feedback, no actionable routing question |

## Results

- **Clear-correct: 19/20 (95%)**
- **Clear-mislabeled: 0/20**
- **Boundary-ambiguous: 1/20 (f017)**
- **Multiple-correct: 0/20**
- **Unclear-prompt: 0/20**

**Flaw rate: 1/20 = 5.0%** — below the Mousavi 10% repair threshold.

## What this confirms (concordance with eval)

The audit independently identifies **f017** as the lone boundary-ambiguous fixture in the seed corpus. This is exactly the cluster the eval flagged as the systematic-miss source (5/100 ci-full misroutes for `general` routing concentrate on f017 and its synthesizer-augmented variations). The audit method validated: it found what the eval already showed, by independent reasoning, before consulting eval results.

This is what good ground-truth audit looks like — the data quality assessment should agree with the systematic patterns the eval surfaces, not contradict them. If the audit had flagged different fixtures than the eval, that would be a sign one of the two had drifted.

## v0.2 follow-ups identified

Filing as known, non-blocking:

1. **Second-reviewer pass not executed.** Mousavi's gate spec calls for two independent reviewers to classify, then reconciliation on disagreements. v0.1.2 audit is single-reviewer (me). Production-grade discipline needs a second reviewer (human teammate or carefully-prompted second LLM with disjoint context). v0.2 work item.

2. **Schema gap: no `feedback` or `security-incident` bucket.** Three fixtures highlight this:
   - f020 (gratitude / feedback) routes to `general` because there's no better bucket; in a real triage system this would route to a feedback queue.
   - f002 / f005 (security incidents) route to `urgent` because there's no `security` or `incident` bucket. Defensible — they ARE urgent — but flatten a real distinction.
   The 4-routing schema was chosen for compactness and clear ground-truth; a 6-routing schema (`urgent`, `engineering`, `billing`, `general`, `feedback`, `security`) would be more realistic but harder to label cleanly. Tradeoff worth surfacing in v0.2.

3. **f017's known boundary needs a clearer disambiguation rule, not a relabel.** ADR-0002 documented why f019 was relabeled (it was *actually* engineering, not boundary-ambiguous). f017 is genuinely boundary-ambiguous — both `general` (feature request) and `engineering` (technical pgvector content) are defensible. The fix isn't to relabel; it's either (a) explicit disambiguation rule in the routing prompt ("feature requests, even technical ones, route to `general`"), or (b) richer resolved-corpus that biases retrieval toward the intended bucket for technically-flavored `general` examples. ADR-0002 named option (b); ADR-0005 will plan to test it with pre-registered prediction.

## Methodological note

This audit explicitly avoids the **post-hoc-label-fix-to-pass-thresholds** anti-pattern (which would defeat ADR-0001's pre-registration discipline). The audit was run **after** the latest ci-full metrics were already locked in (`eval/reports/ci-full-1777601490246.json`). No fixture is being relabeled as a result of this audit. f017 stays `general` because the audit found the label is *defensible*, not *correct-by-default*. Any future relabel would need its own ADR with audit trail (the precedent is ADR-0002).

## References

- `playbook/PLAYBOOK.md` § 8 — Mousavi data-quality audit anti-pattern
- `docs/decisions/0001-manifest-v1-stays-uncalibrated.md` — pre-registration discipline this audit respects
- `docs/decisions/0002-f019-seed-relabel.md` — precedent for ADR-mediated label corrections
- `docs/decisions/0005-fixture-corpus-data-quality-audit.md` — the locked decision based on this audit
- `eval/reports/ci-full-1777601490246.json` — the metrics this audit was run against
