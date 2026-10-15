"""Statistics for matched (paired) controller comparisons.

Decision rule for one comparison (controller vs reference, same network/scenario/demand/seed):
  d_i = metric(controller, seed i) - metric(reference, seed i)  for every seed where BOTH runs completed
  - n < 5 pairs                      -> 'insufficient_pairs' (no test)
  - all d_i == 0                     -> 'identical' (no test: the runs produced the same value)
  - Shapiro-Wilk on d (alpha 0.05):  p >= 0.05 -> paired t-test is the primary test
                                     p <  0.05 -> Wilcoxon signed-rank (exact when possible) is primary
  - always also: exact sign-flip permutation test of the mean difference (sensitivity check)
Effect size: Cohen's d_z = mean(d) / sd(d). The 95 % CI of the mean difference is t-based.
Multiple comparisons: Holm-Bonferroni over a family of primary p-values (analyze_evaluation uses one
family per matrix stage: every network x scenario x comparison x metric of that stage).
Choosing the test after a normality pre-test is a pragmatic rule, not an exact procedure; the
permutation p-value is distribution-free and is reported alongside as the sensitivity check.
Shapiro-Wilk has little power at n = 10, so a non-rejection is weak evidence of normality; the
permutation p-value is reported for every comparison for that reason.
"""
from __future__ import annotations
import itertools, math
import numpy as np
from scipy import stats as st

MIN_PAIRS = 5


def describe(values) -> dict:
    x = np.asarray([v for v in values if v is not None and math.isfinite(v)], dtype=float)
    n = len(x)
    if n == 0:
        return {"n": 0, "mean": None, "sd": None, "ci_low": None, "ci_high": None, "median": None}
    mean = float(x.mean())
    if n == 1:
        return {"n": 1, "mean": mean, "sd": None, "ci_low": None, "ci_high": None, "median": mean}
    sd = float(x.std(ddof=1))
    h = float(st.t.ppf(0.975, n - 1)) * sd / math.sqrt(n)
    return {"n": n, "mean": mean, "sd": sd, "ci_low": mean - h, "ci_high": mean + h, "median": float(np.median(x))}


def permutation_p(d) -> float:
    """Exact two-sided sign-flip permutation test of mean(d) = 0 (2^n sign patterns; n <= 20)."""
    d = np.asarray(d, dtype=float)
    n = len(d)
    if n > 20:
        rng = np.random.default_rng(0)
        signs = rng.choice([-1.0, 1.0], size=(100_000, n))
    else:
        signs = np.array(list(itertools.product([-1.0, 1.0], repeat=n)))
    observed = abs(d.mean())
    means = np.abs((signs * d).mean(axis=1))
    return float(np.mean(means >= observed - 1e-12))


def paired_test(controller, reference) -> dict:
    """controller/reference: equal-length sequences aligned by seed (None = missing)."""
    pairs = [(c, r) for c, r in zip(controller, reference)
             if c is not None and r is not None and math.isfinite(c) and math.isfinite(r)]
    out = {"n_pairs": len(pairs), "mean_diff": None, "diff_ci_low": None, "diff_ci_high": None, "sd_diff": None,
           "ref_mean": None, "rel_change_pct": None, "effect_size_dz": None, "normality_p": None, "test": None,
           "p_value": None, "p_permutation": None, "p_t": None, "p_wilcoxon": None}
    if not pairs:
        out["test"] = "insufficient_pairs"
        return out
    c = np.array([p[0] for p in pairs]); r = np.array([p[1] for p in pairs]); d = c - r
    out["ref_mean"] = float(r.mean())
    out["mean_diff"] = float(d.mean())
    out["rel_change_pct"] = float(d.mean() / r.mean() * 100) if r.mean() != 0 else None
    if len(d) < MIN_PAIRS:
        out["test"] = "insufficient_pairs"
        return out
    if np.allclose(d, 0):
        out.update(test="identical", sd_diff=0.0, diff_ci_low=0.0, diff_ci_high=0.0, effect_size_dz=0.0, p_value=1.0,
                   p_permutation=1.0)
        return out
    desc = describe(d)
    out.update(sd_diff=desc["sd"], diff_ci_low=desc["ci_low"], diff_ci_high=desc["ci_high"])
    out["effect_size_dz"] = float(d.mean() / desc["sd"]) if desc["sd"] else None
    out["normality_p"] = float(st.shapiro(d).pvalue) if len(np.unique(d)) > 2 else None
    out["p_t"] = float(st.ttest_rel(c, r).pvalue)
    try:
        out["p_wilcoxon"] = float(st.wilcoxon(d, zero_method="wilcox").pvalue)
    except ValueError:
        out["p_wilcoxon"] = None
    out["p_permutation"] = permutation_p(d)
    if out["normality_p"] is not None and out["normality_p"] >= 0.05:
        out["test"], out["p_value"] = "paired_t", out["p_t"]
    else:
        out["test"], out["p_value"] = "wilcoxon_signed_rank", out["p_wilcoxon"]
        if out["p_value"] is None:
            out["test"], out["p_value"] = "permutation_sign_flip", out["p_permutation"]
    return out


def holm(pvalues: list) -> list:
    """Holm-Bonferroni adjusted p-values (None entries are skipped and returned as None)."""
    idx = [i for i, p in enumerate(pvalues) if p is not None]
    m = len(idx)
    adjusted = [None] * len(pvalues)
    running = 0.0
    for rank, i in enumerate(sorted(idx, key=lambda i: pvalues[i])):
        running = max(running, min(1.0, (m - rank) * pvalues[i]))
        adjusted[i] = running
    return adjusted


def verdict(t: dict, lower_is_better: bool | None, practical_pct: float, alpha: float = 0.05) -> str:
    if t["test"] == "insufficient_pairs":
        return "insufficient pairs"
    if t["test"] == "identical":
        return "identical results"
    p = t.get("p_adjusted")
    if p is None or p >= alpha:
        return "no significant difference"
    rel = t.get("rel_change_pct")
    if lower_is_better is None or rel is None:
        return "significant difference"
    better = (t["mean_diff"] < 0) == lower_is_better
    size = "practically relevant" if abs(rel) >= practical_pct else f"small (<{practical_pct:g} %)"
    return f"significantly {'better' if better else 'worse'}, {size}"
