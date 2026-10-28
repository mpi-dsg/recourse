"""Confidence-interval helpers and table emitters for the multi-seed sweep.

Single-seed tables retain the repetitions configured for their deterministic
run. CI tables consume a frame from ``run_driver_multi_seed`` containing one
independent realized trace for each of N seeds (default 10), and report
``mean +/- t_{0.975, df=n-1} * (s / sqrt(n))`` for the headline metrics.

Each emitter writes a separate ``\\tablerq<x>ci`` macro so the paper can
include both the legacy single-seed table and the new CI table side-by-side
without macro collisions.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Iterable, Sequence

import pandas as pd

from ._common import tex_escape, write_rows

# Two-sided 97.5% critical values for Student's t at common degrees of
# freedom. We embed a small table so the harness does not pick up a SciPy
# dependency for this single use. The default 10-seed sweep uses df=9;
# 1..30 covers smaller sweeps and the remaining rows support callers with
# larger explicit independent-seed sets.
_T_975: dict[int, float] = {
    1: 12.706,
    2: 4.303,
    3: 3.182,
    4: 2.776,
    5: 2.571,
    6: 2.447,
    7: 2.365,
    8: 2.306,
    9: 2.262,
    10: 2.228,
    11: 2.201,
    12: 2.179,
    13: 2.160,
    14: 2.145,
    15: 2.131,
    16: 2.120,
    17: 2.110,
    18: 2.101,
    19: 2.093,
    20: 2.086,
    24: 2.064,
    29: 2.045,
    39: 2.023,
    49: 2.010,
    59: 2.001,
    99: 1.984,
    199: 1.972,
    499: 1.965,
}


def t_critical_975(df: int) -> float:
    """Two-sided 97.5% Student-t critical value (95% CI half-width factor).

    Falls back to the normal-approximation 1.96 when ``df >= 500`` and
    linearly interpolates between tabulated rows otherwise. ``df < 1`` is
    treated as df=1 (the widest tabulated CI), which is the safe direction.
    """
    if df < 1:
        df = 1
    if df in _T_975:
        return _T_975[df]
    keys = sorted(_T_975)
    if df >= keys[-1]:
        return 1.96
    # Linear interpolation between bracketing keys.
    lo = max(k for k in keys if k <= df)
    hi = min(k for k in keys if k > df)
    span = hi - lo
    if span == 0:
        return _T_975[lo]
    weight = (df - lo) / span
    return _T_975[lo] + weight * (_T_975[hi] - _T_975[lo])


def mean_ci95(values: Iterable[float]) -> tuple[float, float, int]:
    """Return ``(mean, half_width_95ci, n)`` for the supplied samples."""
    samples = [float(v) for v in values]
    n = len(samples)
    if n == 0:
        return 0.0, 0.0, 0
    mean = sum(samples) / n
    if n == 1:
        return mean, 0.0, 1
    var = sum((v - mean) ** 2 for v in samples) / (n - 1)
    stderr = math.sqrt(var) / math.sqrt(n)
    return mean, t_critical_975(n - 1) * stderr, n


def _fmt_int_ci(mean: float, half: float) -> str:
    """Format an integer-valued mean with an integer half-width CI."""
    return f"{int(round(mean))} $\\pm$ {int(round(half))}"


def _fmt_float_ci(mean: float, half: float, *, digits: int = 2) -> str:
    return f"{mean:.{digits}f} $\\pm$ {half:.{digits}f}"


def _aggregate_groups(
    metrics: pd.DataFrame,
    group_cols: Sequence[str],
    metric_cols: Sequence[str],
) -> pd.DataFrame:
    """Compute mean + 95% CI half-width for each metric within each group.

    Returns a long-format frame with columns
    ``[*group_cols, "metric", "mean", "ci95", "n"]`` so emitters can index by
    ``(group, metric)`` without re-grouping.
    """
    rows: list[dict] = []
    for keys, sub in metrics.groupby(list(group_cols), sort=False):
        if not isinstance(keys, tuple):
            keys = (keys,)
        for metric in metric_cols:
            mean, ci, n = mean_ci95(sub[metric].tolist())
            row: dict = {col: key for col, key in zip(group_cols, keys)}
            row.update({"metric": metric, "mean": mean, "ci95": ci, "n": n})
            rows.append(row)
    return pd.DataFrame(rows)


# ── RQ1 ────────────────────────────────────────────────────────────────────

_HEADER_RQ1 = (
    r"% emitted by recourse_harness.tables.ci.emit_rq1_baselines_ci -- "
    r"do not hand-edit"
)

_HEADER_RQ4 = (
    r"% emitted by recourse_harness.tables.ci.emit_rq4_ablation_ci -- "
    r"do not hand-edit"
)

_NO_SETTLEMENT_LAYER = frozenset({"oap", "atomix", "auth_plus_local", "none", "human"})


def emit_rq4_ablation_ci(metrics: pd.DataFrame, output_path: Path) -> Path:
    """RQ4 ablation table with 95% CIs.

    Mirrors ``recourse_harness.tables.rq4.emit_rq4_ablation``: baselines
    without an on-chain settlement layer render obj-settlement share as
    ``---`` because the classifier-would-be-route is undefined there.
    """
    metric_cols = [
        "uncompensated",
        "objective_settlement_rate",
        "false_acceptance",
        "bond_utilization",
    ]
    agg = _aggregate_groups(metrics, ["baseline"], metric_cols)
    by_name = {
        baseline: {row["metric"]: row for _, row in sub.iterrows()}
        for baseline, sub in agg.groupby("baseline", sort=False)
    }
    rows: list[str] = []
    for baseline in sorted(by_name):
        m = by_name[baseline]
        obj_cell = (
            "---"
            if baseline in _NO_SETTLEMENT_LAYER
            else _fmt_float_ci(
                m["objective_settlement_rate"]["mean"],
                m["objective_settlement_rate"]["ci95"],
            )
        )
        rows.append(
            f"{tex_escape(baseline)} & "
            f"{_fmt_int_ci(m['uncompensated']['mean'], m['uncompensated']['ci95'])} & "
            f"{obj_cell} & "
            f"{_fmt_float_ci(m['false_acceptance']['mean'], m['false_acceptance']['ci95'])} & "
            f"{_fmt_float_ci(m['bond_utilization']['mean'], m['bond_utilization']['ci95'])} \\\\"
        )
    return write_rows(output_path, _HEADER_RQ4, rows, "tablerqfourci")


def emit_rq1_baselines_ci(metrics: pd.DataFrame, output_path: Path) -> Path:
    metric_cols = ["gross_harm", "recovered", "covered", "uncompensated"]
    agg = _aggregate_groups(metrics, ["workload", "baseline"], metric_cols)
    rows: list[str] = []
    for (workload, baseline), sub in agg.groupby(["workload", "baseline"], sort=False):
        by_metric = {row["metric"]: row for _, row in sub.iterrows()}
        cells = [
            _fmt_int_ci(by_metric[m]["mean"], by_metric[m]["ci95"])
            for m in metric_cols
        ]
        rows.append(
            f"{tex_escape(workload)} & {tex_escape(baseline)} & "
            + " & ".join(cells)
            + " \\\\"
        )
    return write_rows(output_path, _HEADER_RQ1, rows, "tablerqoneci")


# ── RQ5-Adv ────────────────────────────────────────────────────────────────

_HEADER_RQ5_ADV = (
    r"% emitted by recourse_harness.tables.ci.emit_rq5_adv_ci -- do not hand-edit"
)

_ADVERSARY_ORDER = (
    "NONE",
    "DISHONEST_CLAIMANT",
    "ABSENT_CHALLENGER",
    "BOND_STRESS",
    "COLLUDING_CHALLENGERS",
)


def emit_rq5_adv_ci(metrics: pd.DataFrame, output_path: Path) -> Path:
    recourse_only = metrics[metrics["baseline"] == "recourse"].copy()
    metric_cols = [
        "false_acceptance",
        "false_rejection",
        "uncompensated",
        "under_bond_shortfall",
    ]
    agg = _aggregate_groups(recourse_only, ["adversary_class"], metric_cols)
    by_name = {
        adv: {row["metric"]: row for _, row in sub.iterrows()}
        for adv, sub in agg.groupby("adversary_class", sort=False)
    }
    rows: list[str] = []
    for name in _ADVERSARY_ORDER:
        if name not in by_name:
            continue
        m = by_name[name]
        rows.append(
            f"{tex_escape(name)} & "
            f"{_fmt_float_ci(m['false_acceptance']['mean'], m['false_acceptance']['ci95'])} & "
            f"{_fmt_float_ci(m['false_rejection']['mean'], m['false_rejection']['ci95'])} & "
            f"{_fmt_int_ci(m['uncompensated']['mean'], m['uncompensated']['ci95'])} & "
            f"{_fmt_int_ci(m['under_bond_shortfall']['mean'], m['under_bond_shortfall']['ci95'])} \\\\"
        )
    return write_rows(output_path, _HEADER_RQ5_ADV, rows, "tablerqfiveadvci")


# ── RQ8 ────────────────────────────────────────────────────────────────────

_HEADER_RQ8 = (
    r"% emitted by recourse_harness.tables.ci.emit_rq8_bondsens_ci -- "
    r"do not hand-edit"
)


def emit_rq8_bondsens_ci(metrics: pd.DataFrame, output_path: Path) -> Path:
    recourse_only = metrics[metrics["baseline"] == "recourse"].copy()
    metric_cols = [
        "bond_avg_locked",
        "uncompensated",
        "bond_utilization",
        "under_bond_shortfall",
    ]
    agg = _aggregate_groups(recourse_only, ["bond_multiplier"], metric_cols)
    agg = agg.sort_values(["bond_multiplier", "metric"])
    rows: list[str] = []
    for mult, sub in agg.groupby("bond_multiplier", sort=True):
        m = {row["metric"]: row for _, row in sub.iterrows()}
        rows.append(
            f"{float(mult):.2f} & "
            f"{_fmt_int_ci(m['bond_avg_locked']['mean'], m['bond_avg_locked']['ci95'])} & "
            f"{_fmt_int_ci(m['uncompensated']['mean'], m['uncompensated']['ci95'])} & "
            f"{_fmt_float_ci(m['bond_utilization']['mean'], m['bond_utilization']['ci95'])} & "
            f"{_fmt_int_ci(m['under_bond_shortfall']['mean'], m['under_bond_shortfall']['ci95'])} \\\\"
        )
    return write_rows(output_path, _HEADER_RQ8, rows, "tablerqeightci")


# ── RQ10 ───────────────────────────────────────────────────────────────────

_HEADER_RQ10 = (
    r"% emitted by recourse_harness.tables.ci.emit_rq10_correlated_ci -- "
    r"do not hand-edit"
)


def emit_rq10_correlated_ci(metrics: pd.DataFrame, output_path: Path) -> Path:
    recourse_only = metrics[metrics["baseline"] == "recourse"].copy()
    metric_cols = [
        "bond_peak_concurrent_locked",
        "bond_utilization",
        "concurrent_shortfall",
        "uncompensated",
    ]
    agg = _aggregate_groups(
        recourse_only, ["correlation_burst_size"], metric_cols
    )
    rows: list[str] = []
    for burst, sub in agg.groupby("correlation_burst_size", sort=True):
        m = {row["metric"]: row for _, row in sub.iterrows()}
        rows.append(
            f"{int(burst)} & "
            f"{_fmt_int_ci(m['bond_peak_concurrent_locked']['mean'], m['bond_peak_concurrent_locked']['ci95'])} & "
            f"{_fmt_float_ci(m['bond_utilization']['mean'], m['bond_utilization']['ci95'])} & "
            f"{_fmt_int_ci(m['concurrent_shortfall']['mean'], m['concurrent_shortfall']['ci95'])} & "
            f"{_fmt_int_ci(m['uncompensated']['mean'], m['uncompensated']['ci95'])} \\\\"
        )
    return write_rows(output_path, _HEADER_RQ10, rows, "tablerqtenci")
