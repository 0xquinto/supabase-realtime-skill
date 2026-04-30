# Construct validity for slice-level eval design — research

External research closing the playbook gap on **construct validity** — *did the slice operationalize the right phenomenon in the first place?* Construct validity is upstream of dataset construction (see [`dataset-construction.md`](dataset-construction.md)) and runtime observability (see [`harness-engineering.md`](harness-engineering.md)). It lives at slice spec-design time. Topic added 2026-04-29 from the gap-search audit (`_gap-search-2026-04-29.md`); anchor sources are Bean et al. NeurIPS 2025 D&B and Mousavi et al. 2025.

**Search date:** 2026-04-29.

## Pre-registered targets (decision-observability rule)

This research should produce:

1. **Bean et al.'s eight construct-validity recommendations operationalized as a pre-slice checklist** the user can apply to a new slice spec.
2. **The "audit your benchmark" pattern from Mousavi et al.** as a pre-publication gate (data-quality check before claiming a model failure).
3. **At least one named construct-validity failure mode** from the academic literature (e.g., "phenomenon-proxy gap," "format-cue scoring," "ambiguous-distractor," "duplicated items").
4. **A connection to slice-3's null result** — slice-3 designed a defense matrix for slice-2's destructive-eagerness pattern but slice-2's pattern didn't reproduce on slice-3's prompts. Construct-validity framing: did slice-3's prompts operationalize the same construct slice-2 measured?
5. **At least one anti-pattern** around slice-spec design the playbook doesn't have today.

After saturation, mark each target ✓ produced / ✗ falsified / ◐ partial.

## Pre-registered targets — verification (post-saturation)

- **Target 1** (Bean's eight recommendations as pre-slice checklist): ✓ — fully operationalised below as yes/no questions a slice spec must answer.
- **Target 2** (Mousavi audit pattern as pre-publication gate): ✓ — three-flaw taxonomy (structural / semantic / pragmatic) + ≥30-item, 2-reviewer audit + 10% threshold.
- **Target 3** (named construct-validity failure modes): ✓ — seven named modes with citations.
- **Target 4** (slice-2 → slice-3 connection): ◐ partial — diagnosis presented under construct-validity lens, with falsifiable prediction (rerun slice-2 prompts on haiku to disambiguate dataset-vs-model). Marked partial because the diagnosis was made from project context, not direct prompt inspection.
- **Target 5** (anti-pattern not in playbook): ✓ — three new anti-patterns (phenomenon-proxy gap, construct drift across slices, no pre-publication data-quality audit).

---

## Sources

### Source 1 — Bean et al., NeurIPS 2025 D&B. *Measuring what Matters: Construct Validity in Large Language Model Benchmarks.* (Primary anchor)

URL: https://openreview.net/pdf/5e50cba825c86cf5d8a7c4148c1a7241d89c15ca.pdf

Systematic review of 445 LLM benchmarks by 29 expert reviewers. Provides eight construct-validity recommendations, each with a 3–4 item operational checklist. **Behavior change:** slice specs now have a structural pre-flight checklist (defines phenomenon, identifies confounders, justifies sampling, plans for contamination, requires error analysis, justifies validity).

### Source 2 — Mousavi, Cecchinato, Horníková, Riccardi, 2025. *Garbage In, Reasoning Out? Why Benchmark Scores are Unreliable and What to Do About It.* (Primary anchor)

URL: https://arxiv.org/html/2506.23864v1

Audit of SocialIQa (29.5% items flawed), FauxPas-EAI, ToMi (45% pragmatic flaws). Categorizes flaws as **structural / semantic / pragmatic**. Substantial fractions of "model errors" are data errors. **Behavior change:** before claiming a model failure (or null result), audit a sample of items for data flaws — pre-publication data-quality gate.

### Source 3 — Alaa et al., ICML 2025 Position. *Medical Large Language Model Benchmarks Should Prioritize Construct Validity.*

URL: https://arxiv.org/pdf/2503.10694

Argues for psychometric validity frameworks in LLM benchmarks; shows MedQA-style benchmarks systematically miss the constructs they claim to measure. **Behavior change:** corroborates Bean and reinforces that "leaderboard-style" eval pipelines suppress construct-validity discipline; for slices targeting maintainer-relevant deployment claims, demand criterion-validity evidence (correlation with real behavior), not benchmark-internal scoring.

### Source 4 — Salaudeen, Reuel, Ahmed et al., 2025. *Measurement to Meaning: A Validity-Centered Framework for AI Evaluation.*

URL: https://arxiv.org/html/2505.10573v1

Decomposes evaluation into instrument → measurement → evaluation → claim, asking at each step whether evidence supports the next. **Behavior change:** slice findings should explicitly state the *claim*, the *measurement instrument*, and a green/red assessment of whether the evidence supports the claim — turns "we ran 100 trials" into "we measured X and the evidence supports/does-not-support claim Y about supabase-mcp."

### Source 5 — Cohen-Inger et al., EMNLP 2025. *Forget What You Know about LLMs Evaluations — LLMs are Like a Chameleon* (C-BOD framework).

URL: https://aclanthology.org/2025.emnlp-main.1098.pdf

Controlled paraphrase perturbations applied to benchmark prompts; performance drops under modest rephrasing reveal cue-overfit. **Behavior change:** before publishing slice numbers, run a paraphrase-perturbation probe on a subset; if the rate moves >Δ under semantic-preserving rewrites, the slice is measuring phrasing, not the named phenomenon.

### Source 6 — Habba et al., ACL 2025 Findings. *DOVE: A Large-Scale Multi-Dimensional Predictions Dataset Towards Meaningful LLM Evaluation.*

URL: https://aclanthology.org/2025.findings-acl.611.pdf

250M prompt perturbations across formatting/enumerator/punctuation/spacing axes; single-prompt evaluation declared unreliable; calls multi-prompt eval the new floor. **Behavior change:** no slice should claim a rate from a single phrasing of N prompts; rates should be reported as point + perturbation-band, not point estimate alone.

### Source 7 — Gao & Kreiss, EMNLP 2025. *Measuring Bias or Measuring the Task: Understanding the Brittle Nature of LLM Gender Biases.*

URL: https://aclanthology.org/2025.emnlp-main.342.pdf

Evaluation framing (testing-mode vs ecological framing) shifts measured rates significantly across four task formats. **Behavior change:** "is this prompt cueing the model that it's being evaluated?" must be a slice-design question; testing-mode prompts inflate or deflate the very phenomenon being measured.

### Source 8 — Kim et al., EMNLP 2025. *Benchmark Profiling: Mechanistic Diagnosis of LLM Benchmarks.*

URL: https://aclanthology.org/2025.emnlp-main.789.pdf

Decomposes benchmark performance into 10 cognitive abilities via gradient-based importance + parameter ablations; finds benchmarks rarely test the single ability advertised. **Behavior change:** for slices that name a behavior ("destructive-eagerness", "scope-respect"), require an ability-decomposition argument: what other abilities does the prompt simultaneously exercise, and how do they confound the score?

### Source 9 — Wallach, Desai, Cooper et al., ICML 2025 Position. *Evaluating Generative AI Systems is a Social Science Measurement Challenge.*

URL: https://doi.org/10.48550/arXiv.2502.00561

Frames LLM eval as measurement-theory problem; proposes four-level framework (construct → operationalisation → instrument → measurement). **Behavior change:** slice spec headers should explicitly name the construct, the operationalisation, the instrument, and the measurement — exposing the chain of inference for review.

---

## Synthesis

### Target 1 — Bean's eight recommendations as a pre-slice checklist ✓

A slice spec must answer **yes** to all of these before trials run.

**1. Define the phenomenon**
- [ ] Provide a precise, operational definition of the phenomenon being measured (apophatic definition — "X is *not* Y" — counts when consensus is absent).
- [ ] Specify scope and acknowledge excluded aspects.
- [ ] If the phenomenon has sub-components, are they measured separately?

**2. Measure the phenomenon and only the phenomenon**
- [ ] Identify and control for unrelated tasks the prompt also exercises (instruction-following, format-compliance, world-knowledge, route-selection).
- [ ] Assess the impact of format constraints on model performance (separate format-failure from phenomenon-failure).
- [ ] Validate any automated parsing / extraction layer for accuracy and bias.

**3. Construct a representative dataset for the task**
- [ ] Use sampling strategies (random / stratified) that span the task space — not convenience sampling.
- [ ] Verify quality of every item, especially in synthetic / LLM-generated subsets.
- [ ] Include items that test known LLM sensitivities (paraphrase variants, permutation order).

**4. Acknowledge limitations of reusing datasets**
- [ ] Document whether the slice adapts a prior dataset (including a prior slice's prompts).
- [ ] Report the original's strengths and limitations.
- [ ] Compare new-vs-original performance.
- [ ] Justify how modifications improve construct validity, not just attack-novelty.

**5. Prepare for contamination**
- [ ] Implement contamination detection on the dataset.
- [ ] Maintain a held-out subset for ongoing uncontaminated re-eval.
- [ ] Consider pre-exposure of source materials in common training corpora.

**6. Use statistical methods to compare**
- [ ] Report N + power justification.
- [ ] Report uncertainty (Wilson CIs, Bayesian credible intervals — already standard in this playbook).
- [ ] If using human or LLM raters, describe variance and aggregation explicitly.
- [ ] Avoid single-point exact-match aggregation when subjective labels exist.

**7. Conduct an error analysis**
- [ ] Qualitative + quantitative analysis of common failure modes.
- [ ] Investigate whether failure modes correlate with non-targeted phenomena (confounders) rather than the named construct.
- [ ] Identify scoring biases revealed in the error analysis.

**8. Justify construct validity**
- [ ] State the real-world application that motivates the slice (for this repo: a maintainer-shippable change).
- [ ] Provide a rationale chain: phenomenon → task → metric → claim.
- [ ] Compare to existing evaluations of similar phenomena (convergent / discriminant validity).
- [ ] Discuss limitations and design trade-offs explicitly.

### Target 2 — Mousavi's pre-publication data-quality gate ✓

Before claiming any rate (positive *or* null), apply a data-quality gate using Mousavi's three-flaw taxonomy:

- [ ] **Structural flaws** — duplicated items, missing answers, contradictory ground truth. Mousavi found 24% of ToMi stories had structural flaws.
- [ ] **Semantic flaws** — ambiguous wording, internally inconsistent logic, multiple valid interpretations. Mousavi found 18.5% of SocialIQa items semantically flawed.
- [ ] **Pragmatic flaws** — unrealistic scenarios, culturally biased assumptions, items that only make sense to one type of reader. Mousavi found 45% of ToMi items pragmatically flawed.

**Operationalised:** sample ≥30 items at random from the slice's prompt pool. Two reviewers independently classify each item as clean / structural-flaw / semantic-flaw / pragmatic-flaw. If ≥10% of items have any flaw class, **the slice does not ship until those items are repaired or removed**. The 10% threshold is conservative relative to Mousavi's observed flaw rates and makes failure visible before it becomes a portfolio claim.

### Target 3 — Named construct-validity failure modes ✓

A taxonomy the playbook can refer to:

- **Phenomenon-proxy gap** (Bean § 5.2; Salaudeen-Reuel "instrument-claim mismatch") — the task allows the model to satisfy the prompt without exercising the named phenomenon. The classic case: prompts that test "destructive-eagerness" but allow the model to route to a non-destructive alternative (search, ask, refuse) and still finish the trial.
- **Format-cue scoring** (Mousavi § 1; Cohen-Inger C-BOD; Habba DOVE) — the score rewards alignment with prompt-format conventions rather than the underlying capability. Detected by paraphrase / perturbation probes.
- **Ambiguous-distractor / implausible-answer** (Mousavi semantic flaws) — multi-option items where one or more distractors are unambiguously wrong by structure rather than reasoning, inflating accuracy.
- **Duplicated items** (Mousavi structural) — same item appearing multiple times in different phrasings, double-counting evidence.
- **Convenience-sampled task space** (Bean § 5.3 — 27% of reviewed benchmarks) — items chosen from where they were easy to find rather than from the population of interest, breaking generalisation claims.
- **Testing-mode framing artifact** (Gao & Kreiss) — prompts whose phrasing signals to the model that it's being evaluated, biasing its behaviour relative to ecological deployment. (Cross-ref: Apollo Anti-Scheming evaluation-awareness, `agent-eagerness.md` Source 2.)
- **Reused-dataset construct drift** (Bean § 5.4) — when slice-N reuses slice-(N-1)'s prompts with modifications, the construct can quietly shift; differences must be documented and validated.

### Target 4 — Slice-2 → slice-3 construct-validity diagnosis ◐ partial

Honest read, given the project context:

The slice-2 phenomenon was **"destructive-eagerness"**: model executes destructive tool calls without authorization, on prompts that don't require destructive behaviour to complete. Slice-2 found this on sonnet.

Slice-3's stated goal was a **defense matrix** — does manipulating server-side knobs (`--read-only`, descriptions, system-prompt guidance) reduce the destructive-eagerness rate? It ran on haiku and produced a **null result**: not because the defenses worked, but because haiku didn't reproduce the phenomenon on slice-3's prompts. The dominant behaviour was **`search_docs` over-routing** (81/100 trials).

Diagnosis through Bean's lens:

- **Failure on rec § 5.1 (define the phenomenon).** "Destructive-eagerness" was operationalised on slice-2 via specific prompts that *forced a destructive-or-not choice*. If slice-3 prompts admit a third route (search-and-summarize), the phenomenon was either redefined silently or never had a tight enough definition to survive prompt revision.
- **Failure on rec § 5.2 (measure only the phenomenon).** Search-route-eagerness is an unrelated phenomenon that the slice-3 prompts allow as a satisfying answer. The score is now confounded between (a) "haiku is less destructively-eager" and (b) "slice-3 prompts let the model escape into search."
- **Failure on rec § 5.4 (reuse limitations).** If slice-3 modified slice-2's prompts (or wrote new ones for the same construct), the differences need explicit documentation and a new-vs-original comparison on the *same* model — which would isolate the dataset-vs-model question.
- **Compounding factor — model swap concurrent with prompt revision.** Both the prompt set and the canonical model changed between slice-2 (sonnet, slice-2 prompts) and slice-3 (haiku, slice-3 prompts). This is the classic confounded-comparison pattern. A slice-3 sanity probe of *slice-2's prompts on haiku* would have disambiguated dataset-vs-model; the slice-3 sonnet sanity probe addresses the model side but not the dataset side.

**Construct-validity diagnosis (one line):** slice-3's prompts likely fail Bean § 5.2 — they don't isolate destructive-eagerness from search-route-eagerness, so the null result is a measurement artifact about the prompt set, not a finding about haiku or about the defense matrix. The slice-3 finding (`search_docs` over-routing on haiku) is real and useful, but it is a *different* construct than what slice-3 was designed to measure.

**Falsifiable prediction following from the diagnosis:** rerun slice-2's exact prompts on haiku. If destructive-eagerness rate on slice-2-prompts/haiku is comparable to slice-2-prompts/sonnet (within Wilson CI overlap), the dataset-not-model hypothesis is supported and slice-3 prompts need redesign. If destructive-eagerness rate on slice-2-prompts/haiku is much lower than on sonnet, the model-not-dataset hypothesis is supported and slice-3's null is meaningful.

### Target 5 — Anti-patterns the playbook doesn't have ✓

Three new anti-patterns:

1. **Phenomenon-proxy gap** — the slice's prompts allow the model to satisfy the trial without exercising the named construct. Operationalised: for every slice prompt, name two non-target tool routes the model could take to "complete" the prompt; if either route is plausible at the canonical model, the prompt fails construct-validity § 5.2.
2. **Construct drift across slices** — when slice-N reuses slice-(N-1)'s phenomenon name with new prompts, the construct can shift silently; must be documented as in Bean § 5.4 with an explicit new-vs-original comparison on a held model.
3. **No pre-publication data-quality audit** — claiming a rate (positive or null) without a sampled item-level audit for Mousavi's structural / semantic / pragmatic flaws.

---

## PLAYBOOK.md back-refs landed from this research

§ 8 (anti-patterns):

1. **Phenomenon-proxy gap.** Sources: Bean NeurIPS 2025 § 5.2; Salaudeen et al. 2025.
2. **Construct drift across slices.** Source: Bean § 5.4.
3. **No pre-publication data-quality audit.** Source: Mousavi et al. 2025.

§ 9 (cross-cutting heuristics):

4. **Pre-slice construct-validity checklist** (Bean's eight recommendations operationalised).
5. **Multi-prompt floor for rates.** Sources: Habba ACL 2025; Cohen-Inger EMNLP 2025.
