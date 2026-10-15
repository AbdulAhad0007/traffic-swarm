import math
import numpy as np
import pytest

stats = pytest.importorskip("experiments.tools.stats", reason="needs numpy + scipy (experiments/requirements-analysis.txt)")


def test_describe_ci_matches_t_interval():
    d = stats.describe([1.0, 2.0, 3.0, 4.0])
    assert d["mean"] == 2.5 and d["n"] == 4
    half = 3.182446305284263 * d["sd"] / 2          # t(0.975, 3)
    assert d["ci_low"] == pytest.approx(2.5 - half) and d["ci_high"] == pytest.approx(2.5 + half)
    assert stats.describe([None, 5.0])["ci_low"] is None


def test_holm_adjustment():
    assert stats.holm([0.01, 0.04, 0.03, None]) == pytest.approx([0.03, 0.06, 0.06, None], nan_ok=True)
    assert stats.holm([0.5, 0.9]) == [1.0, 1.0]           # 2 x 0.5 = 1.0, monotone thereafter


def test_permutation_exact_extreme():
    # all 6 differences positive: only 2 of 64 sign patterns are as extreme -> p = 2/64
    assert stats.permutation_p([1, 2, 3, 4, 5, 6]) == pytest.approx(2 / 64)


def test_paired_test_rules():
    ref = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]
    better = [r - 2 + 0.1 * ((i * 7) % 5) for i, r in enumerate(ref)]
    t = stats.paired_test(better, ref)
    assert t["n_pairs"] == 10 and t["mean_diff"] < 0 and t["test"] in ("paired_t", "wilcoxon_signed_rank")
    assert t["p_value"] < 0.01 and t["effect_size_dz"] < 0
    assert stats.paired_test(ref, ref)["test"] == "identical"
    assert stats.paired_test([1, None, 3], [1, 2, None])["test"] == "insufficient_pairs"
    skewed = [r + (30 if i == 0 else 0.1 * i) for i, r in enumerate(ref)]     # one huge outlier -> non-normal
    t2 = stats.paired_test(skewed, ref)
    assert t2["normality_p"] < 0.05 and t2["test"] == "wilcoxon_signed_rank"


def test_verdicts_separate_statistical_and_practical_significance():
    t = {"test": "paired_t", "p_adjusted": 0.001, "mean_diff": -1.0, "rel_change_pct": -2.0}
    assert stats.verdict(t, True, 5) == "significantly better, small (<5 %)"
    t["rel_change_pct"] = -12.0
    assert stats.verdict(t, True, 5) == "significantly better, practically relevant"
    t["p_adjusted"] = 0.2
    assert stats.verdict(t, True, 5) == "no significant difference"
