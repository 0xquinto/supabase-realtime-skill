# Statistical design for small-n LLM evals — research

External research closing the playbook gap on **multi-trial statistical design for small-n LLM evals** (Wilson CIs and alternatives, sample-size calculation, sequential testing, multiplicity correction). Anchors slice-4 metric defensibility and generalizes to all future slices that report rate metrics with CIs.

**Search date:** 2026-04-29.

## Pre-registered targets (decision-observability rule)

This research should produce:

1. **A citable basis for our Wilson 95% CI choice — or a critique that obsoletes it.** Failure to find either is itself a finding ("the literature doesn't strongly endorse Wilson; we can use it pragmatically without claiming theoretical optimality").
2. **At least one named alternative method** (Bayesian, sequential probability ratio test, BCa bootstrap, Agresti-Coull, etc.) with a one-sentence "use when" condition.
3. **A concrete sample-size calculator pattern** applicable to slice-4's n=25/cell — i.e., for which CI half-widths is n=25 defensible, and for which is it under-powered?
4. **A multiplicity-correction principle** for slice-4's two simultaneous A/B comparisons (4-A and 4-B).
5. **At least one anti-pattern** the playbook doesn't have today (e.g., "reporting point estimates without CIs," "claiming significance with overlapping CIs," "post-hoc N adjustment").

After saturation, mark each target ✓ produced / ✗ falsified / ◐ partial.

---

## Sources

### Source 1: Position: Don't Use the CLT in LLM Evals With Fewer Than a Few Hundred Datapoints (Bowyer, Aitchison, Ivanova; ICML 2025 Spotlight)

**URL:** https://proceedings.mlr.press/v267/bowyer25a.html

**Methodology:** Position paper + simulation study comparing CLT-based intervals (Wald, normal-approx) against frequentist alternatives (Wilson, Clopper-Pearson) and Bayesian (Beta-Binomial posterior) intervals on small-n LLM benchmarks. They sweep n from tens to thousands, measure empirical coverage of nominal-95% intervals across success-probability regimes, and report where CLT under-covers.

**Findings:** CLT/Wald CIs "perform very poorly, usually dramatically underestimating uncertainty" for n below a few hundred. Wilson and Beta-Binomial Bayesian intervals retain near-nominal coverage at small n; the gap is largest when p is near 0 or 1 (exactly our regime — slice-2's 25/25, slice-3's near-saturation cells). They explicitly recommend Wilson or Beta-Binomial as drop-in replacements.

**Applicability to our slices:** Slice-2 (n=25, 25/25), slice-3 (4 cells × 25), slice-4 (n=25/cell). Ratifies our existing Wilson choice; gives us a published basis to cite. Also tells us that for the 25/25 saturation cell, Wilson is preferable to Wald but Clopper-Pearson or Bayesian (Jeffreys/uniform Beta prior) is even tighter at the boundary.

**Quote:** *"CLT-based methods perform very poorly, usually dramatically underestimating uncertainty (i.e. producing error bars that are too small)."*

### Source 2: Adding Error Bars to Evals: A Statistical Approach to Language Model Evaluations (Miller, Anthropic, Nov 2024 — arXiv:2411.00640)

**URL:** https://arxiv.org/abs/2411.00640 ; https://anthropic.com/research/statistical-approach-to-model-evals

**Methodology:** Frontier-lab methodology paper. Models eval questions as i.i.d. draws from a "question universe," derives SEM via CLT, then layers four corrections: (1) cluster-robust SE for grouped questions, (2) variance reduction via resampling per question for CoT or via next-token probabilities for MCQ, (3) **paired-difference analysis** for two-model comparisons (exploits within-question correlation between models, typically 0.3–0.7 on frontier evals), (4) **a priori power analysis** to size n given a target detectable effect.

**Findings:** Paired-difference is "free" variance reduction and should be the default when comparing two models on a shared question list. Power analysis is required to know whether a planned n can detect the effect of interest. Cluster-robust SEs can be 3× larger than naive SEs on real benchmarks.

**Applicability to our slices:** Slice-3 (4 cells, all on the same sample IDs — paired analysis available across cells). Slice-4 (planned n=25/cell A/B — power analysis is the gate). Slice-3 templates with multiple variants per template would call for clustered SEs.

**Quote:** *"A two-sample test ignores the hidden structure inside eval data. Since the question list is shared across models, conducting a paired-differences test lets us eliminate the variance in question difficulty and focus on the variance in responses."*

### Source 3: Towards More Rigorous Evaluations of Language Models (ICLR Blogposts 2025)

**URL:** https://iclr-blogposts.github.io/2025/blog/towards-more-rigorous-llm-evals/

**Methodology:** Worked re-analysis of Mirzadeh et al. GSM-Symbolic (n=100/dataset, 25 models, 50 reseeded variants). Authors apply Wilson score CIs, Clopper-Pearson CIs (robustness check), Fisher's exact test for per-model paired-proportion comparisons, and **Wilcoxon signed-rank** for the paired-across-models test. They explicitly handle the non-independence of model variants by curating two independent subsets of 7 models.

**Findings:** The original paper's "non-negligible variance" claim collapses under a Binomial-variance baseline: the observed spread sits inside the Wilson 95% CI for n=100 in every case. Only 3/25 models show a statistically significant per-model decline; aggregate decline is significant only at p≈0.05, not 0.01. Re-uses Clopper-Pearson as a robustness sensitivity (qualitatively unchanged → Wilson is fine).

**Applicability to our slices:** Slice-3 (per-cell Wilson on n=25); slice-4 (Fisher's exact for the A/B head-to-head per cell, signed-rank if pairing across multiple models is desired). Demonstrates the **exact** workflow we should mirror: Wilson per cell + Clopper-Pearson sensitivity + Fisher's exact for the A/B test.

**Quote:** *"The observed variability ... falls well within the Wilson score CIs of GSM8K performance ... under the i.i.d. Bernoulli assumption, the expected variation is actually larger than what is observed."*

### Source 4: Don't Pass@k: A Bayesian Framework for Large Language Model Evaluation (anonymous, ICLR 2026 under review)

**URL:** https://openreview.net/pdf/e61dcd78327a074f8f201ecab36ce3855b474d71.pdf

**Methodology:** Replaces pass@k / avg@N point estimates with a Dirichlet-Multinomial posterior over success probability. Reports posterior mean + credible intervals; evaluates on AIME'24/'25, HMMT'25, BrUMO'25 plus simulations with known ground-truth p. Provides a closed-form decision rule for "is model A better than B" via posterior tail probability.

**Findings:** Under uniform prior the Bayesian posterior mean is order-equivalent to avg@N (Pass@1), so adopting Bayesian credible intervals costs nothing in ranking but adds principled uncertainty. Faster convergence to stable rankings than pass@k; pass@k is unstable when trials are limited and compute-constrained — exactly slice-3/4's regime.

**Applicability to our slices:** Slice-3 / slice-4 — gives us the "use when" condition for choosing Bayesian over Wilson: when we want a posterior tail probability for "A>B" rather than a frequentist p-value, or when we want to integrate a weakly-informative prior (e.g., from slice-1/2 results) into slice-4.

### Source 5: METR's GPT-5 Evaluation + RE-Bench / HCAST (METR, 2025)

**URL:** https://evaluations.metr.org/gpt-5-report/ ; https://metr.org/AI_R_D_Evaluation_Report.pdf ; https://metr.org/hcast.pdf

**Methodology:** Frontier-lab autonomy/capability evals with **explicit confidence intervals** on every reported number, **bootstrap** (HCAST uses task-stratified bootstrap to handle heterogeneous task difficulty/length), multiple seeds per task, and a "time horizon" metric (50% success time horizon) reported with 95% CIs derived from the bootstrap distribution. Sample sizes are tiny per task (typically 2–8 attempts); they aggregate across tasks rather than within-task.

**Findings:** Industry standard for agent evals is **stratified bootstrap CIs**, not Wilson — because agent benchmarks have heterogeneous tasks with different difficulty distributions, and bootstrap accommodates that natively. METR explicitly notes that small per-task n means single-task claims are weak; they only make claims at the aggregate level.

**Applicability to our slices:** Slice-3, slice-4 — if we ever stratify by sample type (e.g., destructive vs. read-only sub-cells), bootstrap CIs are the industry-standard answer. Also: explicit guidance that single-cell claims at n=25 are weak and aggregation is required to make confident statements.

### Source 6: The More You Automate, the Less You See: Hidden Pitfalls of AI Scientist Systems (Luo, Kasirzadeh, Shah; CMU; NeurIPS 2025 AI4Science Spotlight)

**URL:** https://arxiv.org/html/2509.08713v1

**Methodology:** Controlled experiments isolating four failure modes in AI-scientist systems: inappropriate benchmark selection, data leakage, metric misuse, and **post-hoc selection bias**. They run two prominent open-source AI-scientist systems on contrived benchmarks where each failure mode can be detected from trace logs.

**Findings:** Post-hoc selection bias is the dominant failure: the system runs many experiments, then selects/reports the most favorable one without correcting for multiplicity. They argue trace logs (not just final reports) must be reviewed to detect this. Maps directly to our slice-4 risk if we run multiple A/B contrasts and report the significant one.

**Applicability to our slices:** Slice-4 (two simultaneous A/B comparisons — 4-A and 4-B). Pre-registration + multiplicity correction (Bonferroni, Holm, or Benjamini-Hochberg) is the mitigation. Also slice-3 retroactively if we ever look at multiple sub-metrics.

**Quote:** *"Post-hoc selection bias ... can be easily overlooked in practice ... access to trace logs and code from the full automated workflow enables far more effective detection."*

---

## Synthesis

**Pattern 1 — Wilson is the right *default*; Bayesian/Clopper-Pearson are the right *boundary* tools.** Bowyer (Source 1) ratifies Wilson for n in the low double-digits; the ICLR blogpost (Source 3) demonstrates the exact pattern on n=100 binomial proportions with Clopper-Pearson as a sensitivity check. **For slice-4's n=25/cell, keep Wilson 95% as the headline interval, but add a Clopper-Pearson sensitivity for any saturated cell (k=0 or k=n) where Wilson's normal-approx skeleton is weakest.** When we want a posterior probability for "A>B," switch to Beta-Binomial Bayesian (Source 4).

**Pattern 2 — Paired analysis across cells is "free variance reduction" for slice-3/4.** Source 2 (Anthropic) shows paired-difference testing can substantially shrink the SE on a model-vs-model comparison when the same questions are scored. Slice-3 (4 cells × same 25 sample IDs) and slice-4 A/B (same samples, different `--features` configs) **must** use paired tests (McNemar's exact test for binary outcomes, or Wilcoxon signed-rank if we accumulate multiple metrics). Reporting a two-sample CI when paired data is available is a methodological waste.

**Pattern 3 — n=25/cell is defensible for *large* effects only; pre-register the minimum detectable effect.** Source 1 + Source 2's power-analysis section converge: at n=25 per arm, a two-proportion Wilson test has ~80% power to detect an absolute difference of ~0.30–0.40 (e.g., 80% → 40% destructive rate). It is **under-powered** for differences below ~0.20. Slice-2 (25/25) and slice-3's saturation cells are fine because the effect is enormous (1.0 vs. 0.0). **Slice-4 must pre-register the minimum detectable effect (MDE) and either accept ≥0.30 MDE or budget more samples.**

**Pattern 4 — Two simultaneous A/B comparisons require multiplicity correction.** Source 6 (Luo/Kasirzadeh/Shah) is the canonical recent citation for post-hoc selection bias in AI/agent research. With slice-4's 4-A and 4-B contrasts, the family-wise error rate at uncorrected α=0.05 is ~1−(0.95)²≈0.10. **Apply Bonferroni (α=0.025 per test) as the simple default, or Holm-Bonferroni for slightly higher power; if slice-4 grows to ≥4 contrasts, switch to Benjamini-Hochberg FDR control.** Pre-register both the contrasts and the correction in the slice-4 doc *before* running.

**Pattern 5 — Always report point estimate + CI + n; never report a point estimate alone.** Source 3 (ICLR Blogposts) demolishes the GSM-Symbolic paper's claims precisely because the original authors reported point estimates and standard deviations without CIs, leading them to over-interpret expected Binomial variance as a meaningful signal. Source 5 (METR) and Source 2 (Anthropic) make the same recommendation. For our findings docs, the reporting unit must be `<rate> [<lo>, <hi>] (Wilson 95%, n=<N>)`.

---

## Pre-registered targets — verification

- **Target 1 (Wilson basis or critique): ✓** — Bowyer et al. 2025 (Source 1) is the citable basis; Wilson is recommended over CLT/Wald for small-n binomial in LLM evals.
- **Target 2 (named alternative): ✓** — Beta-Binomial Bayesian (uniform/Jeffreys prior) per Sources 1 & 4; **use when** we want a posterior tail probability for "A>B" or want to incorporate prior evidence from earlier slices. Clopper-Pearson **use when** k=0 or k=n (saturated cell). Stratified bootstrap (Source 5) **use when** we aggregate across heterogeneous sub-tasks.
- **Target 3 (sample-size calculator): ◐** — partial. From Source 2's power formulas + standard two-proportion power: n=25/cell gives ~80% power for absolute difference ≥0.30 at p₁=0.5, but only ~40% power for difference 0.15. n=25 is defensible for slice-2/3 saturation regimes (effect > 0.5) and **under-powered** for any contrast targeting < 0.20 absolute. No bespoke sample-size calculator paper found, but Source 2's formulas + standard binomial power tables suffice.
- **Target 4 (multiplicity correction): ✓** — Source 6 establishes post-hoc selection bias as a named anti-pattern; Bonferroni / Holm / BH-FDR are the standard corrections. Pre-registration + Bonferroni at 0.025/test for slice-4's two A/Bs.
- **Target 5 (anti-pattern): ✓** — multiple new ones surfaced: (a) reporting SD/range instead of CI on a binomial proportion (Source 3 demolishes Mirzadeh on this); (b) post-hoc selection bias from running many contrasts (Source 6); (c) using CLT/Wald CIs at small n (Source 1); (d) ignoring paired structure in same-sample comparisons (Source 2).

---

## PLAYBOOK.md back-refs landed from this research

Landed in PLAYBOOK § 8 (anti-patterns) and § 9 (cross-cutting heuristics):

- **§ 8:** Reporting standard deviation or min-max range instead of a confidence interval on a binomial proportion (Source 3, ICLR Blogposts 2025).
- **§ 8:** Using CLT-based / Wald confidence intervals on small-n LLM evaluations (Source 1, Bowyer et al. ICML 2025).
- **§ 8:** Running multiple A/B contrasts and reporting only the significant one without multiplicity correction — post-hoc selection bias (Source 6, Luo et al. NeurIPS 2025 AI4Science).
- **§ 9:** When the same sample IDs are scored under two configs (paired data), use a paired test (McNemar / Wilcoxon signed-rank) rather than two-sample. Source 2, Miller / Anthropic 2024.
- **§ 9:** n=25/cell is defensible for absolute effects ≥ ~0.30; for contrasts targeting < 0.20 absolute, budget ≥ ~100/cell. Pre-register the minimum detectable effect before running. Source 2, Miller / Anthropic 2024.

---

## Background reading (footnote — sources searched but not load-bearing)

- Kreutzer et al. 2025 "Déjà Vu" (Cohere/Google) — multilingual eval rigor checklist; not statistical-design-specific.
- MetaBench (ICLR 2025) — sparse benchmark construction via IRT; orthogonal to our small-n reliability question.
- "Signal and Noise: A Framework for Reducing Uncertainty" (Heineman et al., arXiv:2508.13144) — proposes signal-to-noise ratio for benchmark *design*; relevant if we ever build our own benchmark, but not for slice-4 reporting.
- Anwar et al. "Foundational Challenges in Assuring Alignment" — broad survey, not statistical-design-focused.
- LM-Polygraph (TACL 2025) — uncertainty quantification *of LLM outputs*, not of eval rates; different problem.
- Anthropic Sabotage Evaluations (2024) — eval design template, no novel statistical method beyond Source 2.
- "Awes, Laws, and Flaws From Today's LLM Research" (de Wynter, ACL 2025 Findings) — sociology of research practice; not statistical methodology.
- "On Measuring LLMs Performance with Inferential Statistics" (MDPI 2025) — generalist tutorial, no novel principle beyond Sources 1–3.
