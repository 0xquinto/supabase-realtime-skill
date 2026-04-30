# Gap-search audit — 2026-04-29

**Purpose:** Per spec § 4.6, validate the research-pass topic list (originally A–D) before locking it. Single forked-agent search across 2025–2026 LLM eval methodology pitfalls. Audit trail for the discipline check.

**Outcome:** Topic E added (Construct validity for slice-level eval design). No re-scoping of A–D.

---

## Searches run (via `web_search_advanced_exa`, category `"research paper"`)

1. `LLM evaluation harness common mistakes 2025`, startPublishedDate `2025-01-01`, n=10
2. `agent evaluation methodology pitfalls 2025`, startPublishedDate `2025-01-01`, n=10
3. `LLM benchmark failure modes agent`, startPublishedDate `2025-01-01`, n=10, includeText `["agent"]`

All searches returned ≥3 results from 2025+; no fallback widening to 2024 was needed.

---

## Top 5 methodology gaps surfaced

### Gap 1 — Construct validity (the wrong proxy for the intended phenomenon)

A 29-reviewer audit of 445 LLM benchmarks (Bean et al., NeurIPS 2025 D&B) found pervasive construct-validity failures: vague phenomenon definitions ("safety", "robustness", "reasoning"), task operationalisations that don't actually probe the named construct, and metric choices that score surface form rather than capability. The "Garbage In, Reasoning Out" audit (Mousavi et al., 2025) reinforces from the dataset side — substantial fractions of "model errors" on SocialIQa, FauxPas-EAI, ToMi are actually data errors. **Coverage:** partially D (versioning/contamination overlap) and partially A (observability nudges toward log-level signals); neither A nor D explicitly tackles "does your metric measure the named construct?"

### Gap 2 — Configuration sensitivity / reproducibility under "subtle" harness variations

"Evaluation is All You Need" (Sun et al., 2025) shows DeepSeek-R1-Distill scores swing dramatically with knobs harness authors rarely document: dataset version, instruction position, MCQA option order, tensor-parallelism settings, sampling temperature. "Right Answer, Wrong Score" (ACL 2025) demonstrates the answer-extraction layer alone (RegEx vs. logprob vs. xFinder vs. human) systematically biases comparisons. **Coverage:** Topic A (harness engineering) — fits cleanly.

### Gap 3 — Higher reasoning effort / scaffolding can decrease accuracy (counter-intuitive scaffold effects)

Holistic Agent Leaderboard (HAL, ICLR 2026 submission) ran 21,730 agent rollouts across 9 models × 9 benchmarks and found higher reasoning effort *reduced* accuracy in the majority of runs, plus pathological behaviours invisible to end-to-end scoring (agents searching HuggingFace for the benchmark instead of solving it; misusing payment instruments in flight-booking tasks). **Coverage:** Topic A (harness logging discipline) + Topic B (academic backbone for agent-eagerness file).

### Gap 4 — Post-hoc selection bias and metric misuse in autonomous/agentic eval pipelines

"The More You Automate, the Less You See" (Luo, Kasirzadeh, Shah, CMU 2025) catalogs four failure modes specific to autonomous AI-scientist / agent-research pipelines: inappropriate benchmark selection, data leakage, metric misuse, post-hoc selection bias (cherry-picking). Mitigation recommended: mandatory submission of trace logs and code, not just final outputs. **Coverage:** Topic C (multiplicity correction) + Topic A (trace-log mandate).

### Gap 5 — Human-judgment / ecological-validity gap (narrow metrics → superficial improvement)

"Moving LLM evaluation forward" (Polonioli, Frontiers AI 2025) and HAL argue current eval ecosystems (Chatbot Arena, narrow factuality benchmarks) reward superficial wins. **Coverage:** Topic D (real-trace seeding) + Topic B (agentic ecological validity).

---

## Strongest 5 sources

- **Bean et al., NeurIPS 2025 Datasets & Benchmarks Track** — Systematic review of 445 LLM benchmarks by 29 expert reviewers, surfacing recurring construct-validity failures and providing eight actionable recommendations. https://openreview.net/pdf/5e50cba825c86cf5d8a7c4148c1a7241d89c15ca.pdf
- **HAL team, ICLR 2026 submission** — Holistic Agent Leaderboard: 21,730 agent rollouts × 9 models × 9 benchmarks; standardized harness, scaffold-vs-model decomposition, pathological agent behaviours found via LLM-aided log inspection. https://openreview.net/pdf/c74cc98588086d5efd7cf146b47b0d5112ab3f90.pdf
- **Luo, Kasirzadeh, Shah, CMU 2025** — "The More You Automate, the Less You See." Four failure modes in autonomous AI-scientist / agent eval pipelines + trace-log-submission mitigation. https://arxiv.org/html/2509.08713v1
- **Sun et al., 2025 (DeepSeek-R1-Distill audit)** — Subtle, undocumented evaluation knobs (dataset version, instruction position, MCQA option order, TP setting) cause large score swings. https://arxiv.org/html/2506.04734v1
- **Mousavi, Cecchinato, Hornikova, Riccardi, 2025 (Garbage In, Reasoning Out)** — Substantial fractions of "model errors" on three reasoning benchmarks are data errors; high scores often reflect format-cue alignment. https://arxiv.org/html/2506.23864v1

Honourable mention: **Right Answer, Wrong Score (ACL 2025)** — answer-extractor sensitivity. https://openreview.net/pdf/df04e31f91d74926adcae6d98578fda8dbd51fe3.pdf

---

## Decision

**Topic E added.** Light, narrow-scope new file `playbook/research/construct-validity.md` (~150–250 lines). Anchor sources: Bean et al. + Mousavi et al. Position in order: after D (since the order C → A → B → D → E preserves "deep first" and "construct validity precedes everything except the harness" doesn't actually require it run early — the spec document only locks the topic list, not slice timelines).

**No re-scoping of A–D.** HAL and Luo et al. cited as primary sources within A and B respectively; not a reason to expand A or B.

**Plan + spec amended inline** before Phase 1 (this commit). Topic E added to the spec's topics table, file paths, and order. Plan does not yet have Topic E phase tasks — these will be added inline during execution since Topic E follows the same shape as Topic D.
