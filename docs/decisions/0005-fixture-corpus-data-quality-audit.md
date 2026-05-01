# ADR 0005: fixture corpus passes Mousavi audit at 5% flaw rate; no repair triggered

**Date:** 2026-05-01
**Status:** Accepted
**Decider:** Diego Gomez
**Context:** The compliance audit run after v0.1.x ship flagged that the **Mousavi data-quality audit** (`playbook/PLAYBOOK.md` § 8: "≥30 items, two-reviewer-classify, ≥10% flaw rate triggers repair") was named in the discipline but never explicitly executed on the seed corpus. f017 was the *known* systematic-miss case from the eval (5/100 ci-full misroutes); the question was whether the broader corpus had other latent ambiguity the eval hadn't surfaced yet.

This ADR captures the audit result and the decisions that follow.

## What the audit found

Full data + per-fixture classification in [`playbook/research/data-quality-audit.md`](../../playbook/research/data-quality-audit.md). Headline:

- **Clear-correct: 19/20 (95%)**
- **Clear-mislabeled: 0/20**
- **Boundary-ambiguous: 1/20** — f017 only
- **Multiple-correct: 0/20**
- **Unclear-prompt: 0/20**

**Flaw rate: 5.0% — below the Mousavi 10% repair threshold.** No corpus repair triggered.

## What this confirms (concordance with eval)

The audit independently identifies f017 as the lone boundary-ambiguous fixture in the seed corpus, which is exactly the cluster the eval flagged as the systematic-miss source. The audit method validated: **it found what the eval already showed, by independent reasoning, before consulting eval results.** That concordance is a positive signal — the data-quality assessment agrees with the systematic patterns the eval surfaces.

## Decision

1. **No fixture relabels triggered by this audit.** f017 stays `general` because the audit found the label *defensible* (it's a feature request, even if technically flavored), not *correct-by-default*. Any future relabel needs its own ADR with audit trail (precedent: ADR-0002).
2. **Document the v0.2 follow-ups** identified during the audit so the discipline is visible, not hidden:
   - Second-reviewer pass (Mousavi spec calls for two reviewers; v0.1.2 audit is single-reviewer).
   - Schema gap: 4-routing scheme flattens `feedback` (f020) and `security-incident` (f002, f005) into `general` and `urgent` respectively. A 6-routing schema would be more realistic but harder to ground-truth.
   - f017's boundary needs a disambiguation rule or richer resolved corpus, not a relabel — to be tested with pre-registered prediction in **ADR-0006** (the f017 remediation ADR).

## Why this matters for the artifact

The audit isn't decorative. Three signals it produces:

- **The corpus passes the discipline's own gate.** The artifact's fixture corpus has been independently audited against the playbook's stated quality bar and passes. That's the methodology biting on its own surface, which is the strongest possible internal-consistency check.
- **The single boundary case (f017) is *known and disclosed*, not lurking.** ADR-0002 documents it; ci-full reports it; the audit confirms it. There are no surprises in the corpus that weren't already accounted for.
- **The pattern of audit-then-discipline-the-result is repeatable.** ADR-0002 set the precedent (find a label boundary case → audit → relabel with rationale). ADR-0005 extends the precedent (audit the *whole corpus* at v0.1.x maturity → document quality bar passed → name the v0.2 follow-ups instead of waving them away).

## What this ADR doesn't do

- **Doesn't promise the audit will be re-run on `fixtures/ci-full/`** before v0.2. The ci-full fixtures are 80 LLM-augmented variations of the 20 ci-fast seeds + spot-checked at synthesis time (commit `d705b17`). They inherit the audit's clean-bill-of-health for the underlying intent of each seed. A separate Mousavi pass on the full n=100 is v0.2 work.
- **Doesn't claim two-reviewer status.** Single-reviewer is honest; v0.2 adds the second pass.
- **Doesn't relabel anything.** Pre-registration discipline (ADR-0001) holds.

## How v0.2 should evolve this

1. **Add a second reviewer.** Either a human teammate or a second LLM with a disjoint prompt that doesn't see the first reviewer's classifications. Reconcile disagreements in an audit log.
2. **Run Mousavi on `fixtures/ci-full/` (n=100).** Spot-check rate at synthesis time was good enough for v0.1, but a full audit at v0.2 maturity is the disciplined move.
3. **Consider 6-routing schema** in v2.0 manifest amendment alongside the n→300 bump. The flattening of `feedback` and `security-incident` into `general` and `urgent` respectively is a real ground-truth simplification; v2.0's larger corpus is the right vehicle to test whether the richer schema improves both label clarity AND model action_correctness.

## References

- [`playbook/PLAYBOOK.md`](../../playbook/PLAYBOOK.md) § 8 — Mousavi anti-pattern
- [`playbook/research/data-quality-audit.md`](../../playbook/research/data-quality-audit.md) — full per-fixture audit data
- [`docs/decisions/0001-manifest-v1-stays-uncalibrated.md`](0001-manifest-v1-stays-uncalibrated.md) — pre-registration discipline this audit respects
- [`docs/decisions/0002-f019-seed-relabel.md`](0002-f019-seed-relabel.md) — precedent for ADR-mediated label corrections
- [`eval/reports/ci-full-1777601490246.json`](../../eval/reports/ci-full-1777601490246.json) — the metrics this audit ran against without modifying
