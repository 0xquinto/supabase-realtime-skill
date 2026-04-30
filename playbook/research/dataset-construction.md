# Adversarial dataset construction methodology — research

External research closing the playbook gap on **dataset construction methodology** (versioning, real-trace seeding, ASR floors, train-vs-test contamination). Narrowly scoped to *construction methodology*, not adversarial *content* (the latter is covered in [`prompt-injection.md`](prompt-injection.md)).

**Search date:** 2026-04-29.

## Pre-registered targets (decision-observability rule)

This research should produce:

1. **Dataset versioning principles** for evolving eval datasets.
2. **Real-trace seeding methodology** (one source minimum from a recent (2025+) paper that codifies the pattern slice-1 used ad-hoc).
3. **Train-vs-test contamination risks** specific to LLM eval datasets (and how to detect them).
4. **ASR (attack success rate) floor methodology** — the Carlini "Attacker Moves Second" principle in primary form, plus any 2025+ extensions.
5. **At least one anti-pattern** around dataset construction the playbook doesn't have today.

After saturation, mark each target ✓ produced / ✗ falsified / ◐ partial.

## Pre-registered targets — verification (post-saturation)

- **Target 1** (dataset versioning principles): ✓ — three converging recommendations (SemVer + content-hash + manifest; stability tags; eval-factsheet header).
- **Target 2** (real-trace seeding methodology): ✓ — practitioner tier (Latitude / LangChain) + academic tier (TRAIL OpenTelemetry traces, SWE-rebench automated pipeline).
- **Target 3** (train-vs-test contamination risks): ✓ — DyePack provable detection + dynamic-by-construction + co-occurrence audits (SOCRATES dropped 80% → 5%).
- **Target 4** (ASR floor methodology): ✓ — Carlini 2019 primary + "Attacker Moves Second" ICLR 2026 LLM operationalization + PandaGuard cheap matrix template.
- **Target 5** (anti-pattern not in playbook today): ✓ — four candidates, ranked; top three landed in PLAYBOOK.

---

## Sources

### Source 1 — Carlini, Athalye, Papernot et al., 2019. *On Evaluating Adversarial Robustness.* (Primary form, "Attacker Moves Second" foundational)

URL: https://nicholas.carlini.com/papers/2019_howtoeval.pdf

Defenses must be evaluated against *adaptive* attacks designed with the defense in mind, not against fixed test sets or pre-computed attack strings. **Behavior change:** every "attack success rate" the playbook reports has to be paired with a stated attacker-model and adaptation budget — otherwise the number is a *floor* (best-case for the defender, worst-case for the eval).

### Source 2 — ICLR 2026 submission. *The Attacker Moves Second: Stronger Adaptive Attacks Bypass Defenses Against LLM Jailbreaks and Prompt Injections.*

URL: https://openreview.net/pdf/7855aef1ec24a6c34096532b64736e455004920c.pdf

Modernizes Carlini-2019 specifically for LLM jailbreak / prompt-injection evals. Bypasses 12 recent defenses with >90% ASR by tuning gradient descent, RL, random search, and human-guided exploration; **the majority originally reported near-zero ASR**. **Behavior change:** the playbook should treat any single-attack ASR as a lower bound and require defense evaluations to commit attack-side compute to optimization, not just enumerate fixed strings.

### Source 3 — Cheng, Wang, Moayeri, Feizi (UMD), EMNLP 2025. *DyePack: Provably Flagging Test Set Contamination in LLMs Using Backdoors.*

URL: https://aclanthology.org/2025.emnlp-main.776.pdf

Mixes backdoor "dye-pack" samples with the test set; multiple backdoors with stochastic targets give exact false-positive rate when accusing a model of training on the benchmark. Detects contamination *without access to logits, loss, or weights* — guaranteed FPR as low as 0.000073% on MMLU-Pro. **Behavior change:** when a slice publishes a benchmark dataset (or borrows one), there is now a deployable provable-contamination check.

### Source 4 — Chen et al., EMNLP 2025. *Benchmarking LLMs Under Data Contamination: A Survey from Static to Dynamic Evaluation.*

URL: https://aclanthology.org/2025.emnlp-main.511.pdf

Cross-cutting survey: catalogs contamination-mitigation techniques on static benchmarks and proposes design principles for *dynamic* benchmarks (continuous regeneration, time-bounded items, freshness audits). **Behavior change:** gives the playbook the dynamic-vs-static framing and the "evolving-dataset" anti-pattern (static benchmarks decay into contamination by default).

### Source 5 — Tang et al., ACL 2025. *EvoWiki: Evaluating LLMs on Evolving Knowledge.*

URL: https://aclanthology.org/2025.acl-long.47.pdf

Worked example of dynamic versioning: dataset auto-updates from Wikipedia, items are tagged stable / evolved / uncharted; designed so contamination of a v1 snapshot doesn't bleed into v2 evaluation. **Behavior change:** gives the playbook a concrete versioning tag-set (stable/evolved/uncharted) for slice datasets that grow over time.

### Source 6 — Badertdinov et al. (Nebius), May 2025. *SWE-rebench: An Automated Pipeline for Task Collection and Decontaminated Evaluation of Software Engineering Agents.*

URL: https://arxiv.org/abs/2505.20411

Automated pipeline that continuously extracts real interactive SWE tasks from GitHub. 21,000+ Python-based interactive tasks; freshness-by-construction defeats cutoff-date contamination. **Behavior change:** real-trace seeding is now codified as a *pipeline*, not a one-shot exercise; the cost of staying contamination-free is amortized by automation.

### Source 7 — Latitude blog, 2026. *AI Evaluation for ML Engineers: Production-Based Eval Methodology.*

URL: https://latitude.so/blog/ai-evaluation-for-ml-engineers

Engineering writeup of the trace-to-eval flywheel: review 50–100 production traces → failure-mode taxonomy → 20–50 examples per failure mode → quarterly hygiene (remove non-representative sessions, add new failures) → "70% production-sampled / 30% curated adversarial" target mix. **Behavior change:** the playbook gains a maintainable seed-dataset hygiene cadence and a concrete ratio anchor.

### Source 8 — LangChain blog, March 2026. *Agent Evaluation Readiness Checklist.*

URL: https://www.langchain.com/blog/agent-evaluation-readiness-checklist

Practitioner checklist: manually review 20–50 real agent traces *before* building any eval infra; ensure dataset structure matches eval level (run/trace/thread); sources = dogfooding + adapted external benchmarks + hand-written behavior tests; trace-to-dataset flywheel. **Behavior change:** complements Latitude's quantitative ratio with a qualitative "before-you-build" gate.

### Source 9 — Cluver et al., 2025. *TRAIL: Trace Reasoning and Agentic Issue Localization.*

URL: https://arxiv.org/html/2505.08638v1

148 human-annotated traces from SWE-bench / GAIA, OpenTelemetry-formatted, taxonomized error types. Frontier LLMs score ~11% on trace-debugging. **Behavior change:** confirms that hand-annotated trace items are scarce enough to be *the* limiting resource; codifies the OpenTelemetry-shaped trace as a portable data format — slices that record traces in this shape can be merged with TRAIL.

### Source 10 — Yang et al. (DeepMind/UCL/TAU), ACL Findings 2025. *Do LLMs Perform Latent Multi-Hop Reasoning Without Exploiting Shortcuts?*

URL: https://aclanthology.org/2025.findings-acl.205.pdf

Constructs SOCRATES by *removing* test queries where the head and answer entities co-occurred during training — capability scores drop from **80% (with shortcut-exposed items) to 5%** (shortcut-free) on some relation types. **Behavior change:** a new dataset-construction anti-pattern — "co-occurrence shortcuts inflate scores" — that is both empirically large and easy to introduce by accident.

### Source 11 — Shen et al. (Beijing-AISI), May 2025. *PandaGuard: Systematic Evaluation of LLM Safety against Jailbreaking Attacks.*

URL: https://arxiv.org/pdf/2505.13862

Modular framework: 19 attack methods × 12 defenses × 49 LLMs × multiple judges; 3B+ tokens. **Behavior change:** provides the methodological template for an attack/defense matrix slice (slice-3-style) — explicit attacker/defender/judge separation as plugin axes.

### Source 12 — Eval Factsheets, Dec 2025. (arXiv:2512.04062)

URL: https://arxiv.org/html/2512.04062v1

Adapts Datasheets-for-Datasets / Model-Cards into a structured questionnaire for *evaluations themselves*. **Behavior change:** gives the playbook a citable schema for documenting what a slice measured, against what dataset version, with what attacker model. Foundational anchor: Gebru et al., "Datasheets for Datasets" (CACM 2021, arXiv:1803.09010).

---

## Synthesis

### Target 1 — Dataset versioning principles ✓

Three converging recommendations:

- **SemVer + content-hash + manifest** (Eval Factsheets, Data Provenance Standards): every slice dataset gets a SemVer tag, a content hash (SHA-256), and a manifest of constituent items with their per-item provenance.
- **Tag items by stability state** (EvoWiki): stable / evolved / uncharted. For our MCP-style harness this maps to "behavior the docs guarantee" / "behavior that has changed in supabase-mcp main since dataset cut" / "newly added tools or scenarios."
- **Document the evaluation, not just the data** (Eval Factsheets): the schema captures *what was measured*, *how it was scored*, *with what attacker*, separately from the dataset itself. Slice-1 and slice-2's findings docs would benefit from a 1-page Eval Factsheet header.

### Target 2 — Real-trace seeding methodology ✓

Two-tier consensus:

- **Practitioner / engineering tier** (Latitude, LangChain): manual review of 20–50 production traces *before* infrastructure; build a failure-mode taxonomy; seed 20–50 items per mode; maintain a roughly 70/30 mix of production-sampled and curated-adversarial; review quarterly. This codifies the slice-1 ad-hoc pattern.
- **Academic tier** (TRAIL, SWE-rebench): hand-annotated traces are scarce, expensive, and best stored in **OpenTelemetry / `openinference`-compatible JSON** so they can pool across projects. TRAIL's 148 items represent ~the upper bound of one team's hand-annotation budget; everything beyond that should be automated extraction (SWE-rebench-style) or borrowed.

### Target 3 — Train-vs-test contamination ✓

Three actionable techniques:

- **DyePack** (EMNLP 2025): inject stochastic backdoor samples with known triggers; if a model emits the backdoor target on the trigger, it trained on your test set. Provable FPR, no logits required.
- **Dynamic-by-construction** (Static-to-Dynamic survey, EvoWiki, SWE-rebench): items are regenerated past the model's cutoff date; "is this in the training corpus?" becomes provably "no" for items dated after cutoff.
- **Co-occurrence audits** (SOCRATES): even items the model didn't memorize verbatim can be solved by training-time co-occurrence between input and target entities. Removing these shortcuts dropped SOCRATES capability scores from 80% to 5% in places — implying *the magnitude of the inflation is benchmark-deciding*.

### Target 4 — ASR floor methodology ✓

Carlini's 2019 paper is the primary; the *operationalization for LLMs* now lives in **"The Attacker Moves Second" (ICLR 2026)**:

- Defenses evaluated against fixed attack strings or weak optimizers report systematically optimistic ASRs (12 of 12 went from "near-zero" to ">90%" under adaptive attack).
- Therefore: ASR is a **lower bound** unless the eval commits attack-side compute to gradient descent / RL / random search / human-guided exploration *configured against the specific defense*.
- PandaGuard (2025) is the cheap operationalization — 19 attacks × 12 defenses with documented compute budgets; a slice that reports just one attack should call its number "ASR-floor" not "ASR."

### Target 5 — At least one new anti-pattern ✓

Four candidates, ranked by playbook fit:

1. **Co-occurrence shortcut leakage** (SOCRATES, ACL Findings 2025) — items inadvertently solvable by training-time co-occurrence between input and target rather than the named capability. Most playbook-fit: cleanly distinguishes from existing "narrow-signature scoring" (slice-2 lesson, which is about *attack* signature, not *training-data* shortcut).
2. **Static-benchmark contamination decay** (Static-to-Dynamic survey, EMNLP 2025) — a benchmark frozen at version 1.0 silently becomes worthless as models train on internet-scraped versions. Distinct from "synthetic-before-handcrafted-seed" because it applies to hand-crafted seeds *too*.
3. **Single-attack ASR reported as ASR** (Attacker-Moves-Second, ICLR 2026) — reporting one attack's success rate without committing adaptive-attack compute. Defenses that look strong are usually weak.
4. **Undocumented evaluation methodology** (Eval Factsheets, arXiv:2512.04062) — slice findings without a Datasheet-style header are the eval-side equivalent of un-versioned datasets.

---

## PLAYBOOK.md back-refs landed from this research

§ 8 (anti-patterns):

1. **Co-occurrence shortcut leakage in eval items.** Sources: SOCRATES ACL Findings 2025.
2. **Static-benchmark contamination decay.** Sources: Static-to-Dynamic survey EMNLP 2025; EvoWiki ACL 2025.
3. **Single-attack ASR reported as ASR.** Sources: Carlini 2019; Attacker-Moves-Second ICLR 2026.

§ 9 (cross-cutting heuristics):

4. **Existing "Real-trace seed adversarial registries" bullet AMENDED** (per spec § 4.4 — supersede where literature contradicts/refines): the principle bullet was merged with the new "Real-trace seeding cadence" finding to give a single bullet that pairs the slice-1 lesson with the LangChain/Latitude 2026 quantified cadence (20–50 traces, 70/30 mix, quarterly refresh). Justification: two adjacent bullets making the same point at different abstraction levels is redundancy; the literature's contribution is the numbers, not a separate principle.
5. **Eval Factsheet header per slice.** Source: Eval Factsheets arXiv:2512.04062 + Gebru et al. CACM 2021.
