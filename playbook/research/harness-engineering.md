# Harness engineering — research

External research closing the playbook gap on **how the eval harness itself should be designed and evolved over time** — observability disciplines, agent-loop logging shape, trial-replay support, scaffold-vs-model decomposition, configuration manifests, and the hand-rolled-vs-framework decision (cross-checks ADR 0008).

**Search date:** 2026-04-29.

## Pre-registered targets (decision-observability rule)

This research should produce:

1. **A methodology principle the playbook doesn't have today** — specifically: how should the harness itself evolve over time? Lin et al. arXiv:2604.25850 introduced "observability pillars"; what else is in the literature?
2. **At least one anti-pattern from the literature on harness design** (e.g., "harness leakage," "tool-call instability across runs," "prompt-template drift," "extraction-layer bias").
3. **A concrete observability-or-instrumentation pattern adoptable in our `src/foundation/` code** (logging discipline, transcript shape, trial-replay support, configuration manifest schema).
4. **Cross-check on our hand-rolled-vs-framework decision (ADR 0008):** does the cutting-edge literature endorse hand-rolled harnesses or third-party frameworks for our scale (n=25–100 per cell, 1–5 slices/quarter)?
5. **At least one falsifiable claim about harness design** that we can test in slice-4+ (for decision-observability discipline).

After saturation, mark each target ✓ produced / ✗ falsified / ◐ partial.

---

## Sources

### Source 1: Agentic Harness Engineering: Observability-Driven Automatic Evolution of Coding-Agent Harnesses (Lin et al., Fudan/PKU/Qiji Zhifeng, arXiv:2604.25850, 2026)

**URL:** https://arxiv.org/html/2604.25850v1

**Methodology:** AHE instruments the three stages of any harness-engineering loop — component editing, trajectory inspection, decision making — with three matched "observability pillars": (1) **component observability** gives every editable harness component a file-level representation so the action space is explicit and revertible; (2) **experience observability** distills millions of raw trajectory tokens into a layered, drill-down evidence corpus; (3) **decision observability** pairs every edit with a self-declared prediction, later verified against the next round's task-level outcomes. Components decompose into system prompt, tool descriptions, tool implementations, middleware, and skills, each at a fixed file-system path. Empirical loop: 10 iterations on Terminal-Bench 2.

**Findings:** 10 AHE iterations lift pass@1 on Terminal-Bench 2 from 69.7% → 77.0%, beating the human-designed Codex-CLI harness (71.9%) and beating self-evolving baselines (ACE, TF-GRPO). The frozen evolved harness transfers to SWE-bench-verified at 12% fewer tokens than seed. Anti-pattern surfaced: *"If the same failure class persists across 2+ iterations despite fixes at one component level, that level may be the wrong choice. Rollback the ineffective change and re-approach from a different component level."*

**Applicability to our slices:** Slice-4+ — directly motivates a `decision_observability` field in our slice-spec template (each axis-change gets a pre-registered prediction, verified after the run). Also motivates decomposing supabase-mcp's surface area into component types matching Lin's taxonomy (system prompt, tool description, tool impl, middleware) so that slice findings can recommend changes at named component levels.

**Quote:** *"decision observability pairs every edit with a self-declared prediction, later verified against the next round's task-level outcomes. Together, these pillars turn every edit into a falsifiable contract, so harness evolution proceeds autonomously without collapsing into trial-and-error."*

### Source 2: Holistic Agent Leaderboard (HAL): The Missing Infrastructure for AI Agent Evaluation (Stroebl, Kapoor, Narayanan et al., ICLR 2026 under review)

**URL:** https://openreview.net/pdf/c74cc98588086d5efd7cf146b47b0d5112ab3f90.pdf

**Methodology:** Builds a standardized harness orchestrating parallel evaluations across hundreds of VMs. Three-dimensional analysis spanning models × scaffolds × benchmarks. Validated by 21,730 agent rollouts × 9 models × 9 benchmarks (coding, web, science, customer service) at ~$40K cost. Uses LLM-aided log inspection to surface unreported behaviors. Releases all 2.5B tokens of agent logs.

**Findings:** Identifies 8 numbered evaluation challenges: non-standardized infra, slow eval, error-prone setup, unreported costs, scaffold variance, no scaffold comparisons, shortcut exploitation, undetected catastrophic actions. Concrete unreported behaviors uncovered via log inspection: agents searching HuggingFace for the benchmark instead of solving it; agents misusing credit cards in flight-booking tasks. Counterintuitive finding: "higher reasoning effort reducing accuracy in the majority of runs."

**Applicability to our slices:** Slice-3 onward — endorses our scaffold-vs-model decomposition (HAL's three-dimensional analysis is exactly our axis structure). Slice-4+ should add a "log inspection pass" sub-step where transcripts are LLM-scanned for off-task behaviors not anticipated by the matcher. Cross-check on ADR 0008: HAL is itself a hand-rolled standardized harness, but it argues each project's harness should expose a *common* log/cost schema for cross-comparison.

**Quote:** *"agent evaluation poses fundamentally different challenges. While LLMs respond to prompts with text, agents navigate complex environments over extended time horizons, using tools from browsers to bash shells, often consuming hundreds of thousands of tokens per rollout."*

### Source 3: AI Agents That Matter (Kapoor, Stroebl, Siegel, Nadgir, Narayanan, Princeton, arXiv:2407.01502, 2024 — foundational)

**URL:** https://arxiv.org/pdf/2407.01502

**Methodology:** Empirical analysis of agent benchmarks (HumanEval, WebArena, NovelQA), constructs three new simple baseline agents and measures cost vs. accuracy on a Pareto curve, audits reproducibility of published results, identifies four "levels of generality" requiring different held-out splits.

**Findings:** Five concrete failure modes: (1) accuracy-only optimization → needlessly costly SOTA; (2) cost+accuracy joint optimization yields better designs (DSPy modification reduces cost on HotPotQA at flat accuracy); (3) model-developer vs downstream-developer benchmarking needs are conflated; (4) inadequate or absent holdout sets enable shortcut overfitting; (5) "pervasive shortcomings in the reproducibility" — concrete reproducibility errors found in WebArena/HumanEval evaluations that *inflated* accuracy estimates.

**Foundational justification:** Predates 2025 (the only pre-2025 source admitted) but is cited by every 2025 agent-eval paper this pass surfaced; admitting it as foundational per spec § 5.3 #3.

**Applicability to our slices:** All slices — already aligns with our cost-probe (`cost-quote` hook). Slice-4 should adopt their "agent-developer vs. downstream-developer" distinction: supabase-mcp maintainers are *agent developers*; their users are *downstream developers* — slice findings should explicitly tag which audience the recommendation serves. The hold-out-sample lesson maps to: never tune slice prompts on the same n=25 cell we report Wilson CIs on.

**Quote:** *"many types of overfitting to agent benchmarks are possible. We identify 4 levels of generality of agents and argue that different types of hold-out samples are needed based on the desired level of generality."*

### Source 4: AgentDiagnose: An Open Toolkit for Diagnosing LLM Agent Trajectories (Ou, Guo, Gandhi, Neubig, Yue, CMU, EMNLP 2025 Demos)

**URL:** https://aclanthology.org/2025.emnlp-demos.15.pdf

**Methodology:** Models a trajectory as `T = {(o_i, r_i, a_i)}` (observation, reasoning, action triples). Two modules: (1) automatic scoring of five agentic competencies — backtracking & exploration, task decomposition, observation reading, self-verification, objective quality — *without requiring reference trajectories*; (2) visualization with t-SNE action embeddings, word clouds, state-transition timelines.

**Findings:** Mean Pearson 0.57 with human judgments across 30 manually-annotated trajectories (rising to 0.78 on task decomposition). Filtering NNetNav-Live (46K examples) down to top-6K trajectories by AgentDiagnose scores → fine-tuning Llama-3.1-8B → +0.98 absolute WebArena success at 13% of original data.

**Applicability to our slices:** Foundation — `parseTranscript` should canonicalize to the (o, r, a) triple shape, not custom per-slice. Slice-3 (eagerness-defense) and the planned destructive-actions ablation get a free "self-verification" and "backtracking" axis from this schema, both of which directly tag eagerness behavior.

**Quote:** *"These trajectories can span hundreds or thousands of steps, making it difficult to analyze what drives an agent's success or failure. Existing agent evaluation pipelines focus primarily on whether an agent completes a task successfully... it leaves the agent's decision-making process opaque."*

### Source 5: The Art of Building Verifiers for Computer Use Agents — Universal Verifier (Rosset, Sharma, Zhao, Gonzalez-Fernandez, Awadallah, Microsoft Research, 2026)

**URL:** https://www.microsoft.com/en-us/research/articles/the-art-of-building-verifiers-for-computer-use-agents/

**Methodology:** 96 experiments over weeks building a verifier system (rubric generation + multi-criterion judge). Releases CUAVerifierBench with both process and outcome human labels. Compares against WebVoyager (≥45% FPR) and WebJudge (≥22% FPR).

**Findings:** Five lessons. (1) Rubric design alone accounts for ~half of total Cohen's κ gain; (2) separate process from outcome and controllable from uncontrollable failures (CAPTCHAs, out-of-stock); (3) Universal Verifier reaches human-human κ=0.64 with near-zero FPR; (4) "Verifiers deserve the same rigorous evaluation and iterative improvement we apply to models" — i.e., publish a verifier benchmark; (5) Auto-research agents reach ~70% of expert verifier quality at 5% time cost. Names four rubric anti-patterns: phantom criteria, cascading criteria, conflated process/outcome, conflated controllable/uncontrollable.

**Applicability to our slices:** Slice-3 + slice-4 — directly attacks a hole in our scoring. Our `ToolCallMatcher` is essentially an outcome rubric; we have no process scoring. The phantom-criteria warning matches our "narrow-signature scoring" anti-pattern (slice-2 lesson) — independent confirmation. Slice-4 should split the score into "controllable agent failure" vs. "environment confounder" to avoid penalizing the agent for a Supabase API 5xx.

**Quote:** *"conflating process and outcome leads to reward signals that are either too lenient or too harsh. We further distinguish controllable failures (e.g., reasoning errors, hallucinations) from uncontrollable ones (e.g., CAPTCHAs, out-of-stock items)."*

### Source 6: Why Do Multi-Agent LLM Systems Fail? — MAST (Cemri, Pan, Yang et al., UC Berkeley + Stoica + Zaharia, NeurIPS 2025 D&B)

**URL:** https://openreview.net/pdf/e5dfd95c87e815f4c3773cfb5e9ffc17220fd006.pdf

**Methodology:** 1600+ annotated MAS execution traces across 7 popular MAS frameworks. Failure taxonomy (MAST) developed via inductive coding of 150 traces with expert annotators (κ=0.88). LLM-as-judge pipeline calibrated to high agreement with human annotations.

**Findings:** 14 failure modes in 3 categories: system design issues (44.2%), inter-agent misalignment (32.3%), task verification (23.5%). Failure rates 41%–86.7% across SOTA open-source MAS. Quote-worthy: *"Successful systems all work alike; each failing system has its own problems."* Top single mode: "Disobey Task Specification" (15.7%); also notable for our work: "Step Repetition" (13.2%) — same-action loops, which maps to eagerness/destructive-call probes.

**Applicability to our slices:** Slice-4 (planned A/B) — even if we're single-agent, modes (1.1) Disobey Task Specification, (1.3) Step Repetition, (3.1) Premature Termination, and (3.3) Incorrect Verification map directly to failure classes we already see. Adopt MAST's category-3 ("task verification") modes as named scoring sub-categories.

### Source 7: ReliableEval: A Recipe for Stochastic LLM Evaluation via Method of Moments (Lior, Habba, Levy, Caciularu, Stanovsky, HUJI + Google, EMNLP 2025 Findings)

**URL:** https://aclanthology.org/2025.findings-emnlp.594.pdf

**Methodology:** Defines reliable evaluation as method-of-moments estimation (expected value + variance) over the space of meaning-preserving prompt perturbations. Bounds the probability that a sample of perturbations is representative. Provides a closed-form recipe for estimating the *number* of perturbation resamplings needed per dataset.

**Findings:** GPT-4o, Claude-3.7-Sonnet, DeepSeek-V3, Llama-3.3-70B, Grok-3 all exhibit substantial prompt sensitivity (μ varies 0.27–0.47 on GPQA-style across paraphrases of the *same* task). Critically: *"the number of resamplings required to reliably estimate model performance varies depending on both the model and the dataset."*

**Applicability to our slices:** Slice-3+ — single-prompt scoring is unreliable. Our n=25/cell may be measuring *prompt-formulation noise* as much as the axis under test. Adopt: each task in our seed set gets ≥3 meaning-preserving paraphrases, and the reported rate is the across-paraphrase mean with reported variance.

**Quote:** *"the number of resamplings required to reliably estimate model performance varies depending on both the model and the dataset being evaluated."*

### Source 8: OLMES: A Standard for Language Model Evaluations (Gu, Tafjord, Kuehl, Haddad, Dodge, Hajishirzi, AI2 + UW, NAACL 2025 Findings)

**URL:** https://aclanthology.org/2025.findings-naacl.282.pdf

**Methodology:** Catalogs the implicit "varying factors" across LM eval implementations (prompt formatting, in-context examples, probability normalizations, task formulation, cloze vs. completion). Proposes a fully-documented open standard.

**Findings:** Reproducibility failures even in published numbers stem from undocumented choices, *not* model differences. Their critique of HELM/lm-eval-harness: *"the rationale is not always documented and thus not followed by others in subsequent work."*

**Applicability to our slices:** Cross-check on ADR 0008 — OLMES does *not* argue against hand-rolled harnesses; it argues for a documented configuration manifest. Adopt: every slice run emits a JSON manifest with (model id, model temperature, system_prompt sha256, tool_descriptions sha256, --features set, --read-only flag, foundation commit sha, sample seed). The manifest is the OLMES-style reproducibility contract for our scale.

---

## Synthesis

**Pattern A — Decision observability as the harness-evolution discipline (Lin et al.; Microsoft Verifier).** Each slice change should be a *falsifiable contract*: pre-registered prediction at the spec stage, verified against the post-run rate. We already do directional pre-registration in spec-checklist; tighten it to a `predicted_rate ± tolerance` field per cell. Changes slice-4+ spec template.

**Pattern B — Trajectory shape canonicalization to (observation, reasoning, action) triples (AgentDiagnose; MAST).** `parseTranscript` should canonicalize to this triple form, with optional fields for tool_call_id and tool_result. Doing so unlocks five competency scores (backtracking, decomposition, observation-reading, self-verification, objective quality) with no slice-specific code. Changes `src/foundation/parseTranscript.ts` schema.

**Pattern C — Process / outcome / environment-confounder separation in scoring (Microsoft Verifier; HAL).** Our binary attack-landed score conflates "agent did the bad thing" with "environment let the bad thing succeed." Adopt three score columns: outcome (did the destructive action complete?), process (did the agent intend it?), environment (did Supabase API confound the run with an unrelated 5xx?). Changes `src/foundation/scoring.ts` and downstream slice findings tables.

**Pattern D — Configuration manifest per run (OLMES; HAL).** Every slice rollout writes a manifest JSON with (foundation sha, model id, temperature, --features set, --read-only flag, system_prompt sha256, tool_descriptions sha256, sample seed, judge prompt sha256). Without this, a finding from May is unreplicable in July when supabase-mcp ships a tool-description tweak. Changes `src/foundation/runSample.ts`.

**Pattern E — Stochastic-paraphrase evaluation as the noise floor (ReliableEval).** n=25 trials per cell with one prompt formulation may be measuring prompt noise rather than the axis under test. Each task in the seed set gets ≥3 meaning-preserving paraphrases; cell rate is mean-across-paraphrases with explicit variance reported separately from sampling variance. Changes the slice-4 sample-construction rule.

---

## Pre-registered targets — verification

- **Target 1 (harness-evolution methodology): ✓** — Lin et al. extended by AgentOps (IBM, six-stage pipeline) and HAL (parallel-VM standardized infra) confirm "observability-driven evolution" as the rising frame; AHE's three pillars give us the most concrete schema.
- **Target 2 (anti-pattern): ✓** — multiple distinct ones surfaced: phantom criteria + cascading criteria + process/outcome conflation (Microsoft Verifier); shortcut overfitting + missing holdout sets (Kapoor); single-prompt unreliability (ReliableEval); persistent-failure-at-wrong-component-level (Lin et al.).
- **Target 3 (observability pattern adoptable in foundation/): ✓** — three concrete adoptions: (o, r, a) triple canonicalization in `parseTranscript`, three-column scoring in `scoring`, run manifest in `runSample`.
- **Target 4 (cross-check ADR 0008): ✓** — literature endorses our hand-rolled choice but conditions it on a documented manifest. OLMES explicitly argues frameworks haven't solved reproducibility; HAL is itself hand-rolled. None of the 2025 agent-eval papers found argue against hand-rolled at our scale (n=25–100/cell, 1–5 slices/quarter); the consistent message is "your harness is fine, document the configuration."
- **Target 5 (falsifiable claim for slice-4+): ✓** — *"Adopting decision-observability (per-edit pre-registered predicted rate, verified post-run) reduces the count of slice findings that get reversed by a follow-on probe by ≥50% over 5 slices."* Or: *"Across-paraphrase variance on slice-3 cells is ≥30% of the across-cell delta, meaning at least one of the slice-3 cell-pair conclusions does not survive ReliableEval-style stochastic re-evaluation."*

---

## PLAYBOOK.md back-refs landed from this research

Landed in PLAYBOOK § 8 (anti-patterns) and § 9 (cross-cutting heuristics):

- **§ 8:** Single-prompt cell scoring conflates axis-effect with prompt-formulation noise (Source 7, ReliableEval EMNLP 2025 Findings).
- **§ 8:** Process / outcome / environment-confounder conflation in binary scoring (Source 5, Microsoft Universal Verifier 2026).
- **§ 9:** Run manifest per slice rollout — JSON with foundation sha + model id + temperature + features + read-only flag + content shas + seed (Source 8 OLMES NAACL 2025 + Source 2 HAL ICLR 2026).
- **§ 9:** Trajectory canonicalization to (observation, reasoning, action) triples in `parseTranscript`; unlocks five competency scores with no slice-specific code (Source 4, AgentDiagnose EMNLP 2025 Demos).
- **§ 9:** Cross-check confirms ADR 0008 — hand-rolled harness is endorsed at our scale (Sources 2 + 8); the obligation is documented configuration, not framework adoption.

---

## Background reading (footnote — sources searched but not load-bearing)

- *MCPEval* (Salesforce, EMNLP 2025 Demos, https://aclanthology.org/2025.emnlp-demos.27.pdf) — automated MCP-based eval generation; relevant but generates *tasks*, doesn't change our methodology.
- *HCAST* + *RE-Bench* (METR, 2024–2025) — human-time-calibrated benchmarks; orthogonal to harness engineering.
- *Self-Challenging Language Model Agents* (Zhou et al., FAIR/Meta, 2025) — self-generated training data, not eval methodology.
- *Agent0* (arXiv:2511.16043), *iTool* (arXiv:2501.09766), *MCPVerse* (arXiv:2508.16260), *MCP-Bench*, *Tool Decathlon*, *Gaia2*, *AgentGym*, *Licence to Scale*, *RexBench*, *VeRO*, *Agentic Reasoning* — benchmark/training papers, none change a foundation decision.
- *Catastrophic Cyber Capabilities Benchmark (3CB)* (Apart Research, arXiv:2410.09114) — domain-specific agent eval.
- *Microsoft Taxonomy of Failure Mode in Agentic AI Systems* (whitepaper PDF) — could not extract clean text; excluded as non-load-bearing without verification.
- *Questionable Practices in Machine Learning* (Leech et al., 2024, arXiv:2407.12220) — overlaps with Kapoor on QRPs; redundant.
- *UltraEval* (Tsinghua, 2024) — LLM eval framework, scope mismatch (single-turn).
- *Signal and Noise* (arXiv:2508.13144) — already in `playbook/research/statistical-design.md` background; cross-referenced there, no new harness implication.
- *Unsupervised Cycle Detection in Agentic Applications* (IBM, arXiv:2511.10650) — relevant to MAST's "Step Repetition" mode but production-ops focused, not eval-time.
- *Evaluation is All You Need* (arXiv:2506.04734) — covers strategic overclaiming through evaluation design; partial overlap with Kapoor + ReliableEval.
