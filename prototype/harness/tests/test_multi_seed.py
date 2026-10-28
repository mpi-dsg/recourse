"""Tests for the multi-seed wrapper and CI table emitters."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pandas as pd
import pytest

from recourse_harness.multi_seed import run_driver_multi_seed
from recourse_harness.tables.ci import (
    emit_rq1_baselines_ci,
    emit_rq4_ablation_ci,
    emit_rq5_adv_ci,
    emit_rq8_bondsens_ci,
    emit_rq10_correlated_ci,
    mean_ci95,
    t_critical_975,
)


def test_t_critical_975_matches_tabulated_values() -> None:
    # Spot-check a few rows of the embedded t-table.
    assert t_critical_975(1) == pytest.approx(12.706)
    assert t_critical_975(9) == pytest.approx(2.262)
    assert t_critical_975(49) == pytest.approx(2.010)
    # Large df falls back to the normal approximation.
    assert t_critical_975(10_000) == pytest.approx(1.96)
    # Interpolation between bracketing keys stays within [lo, hi].
    lo, hi = t_critical_975(20), t_critical_975(24)
    mid = t_critical_975(22)
    assert min(lo, hi) <= mid <= max(lo, hi)


def test_mean_ci95_zero_variance_yields_zero_halfwidth() -> None:
    mean, ci, n = mean_ci95([5.0, 5.0, 5.0, 5.0])
    assert mean == pytest.approx(5.0)
    assert ci == pytest.approx(0.0)
    assert n == 4


def test_mean_ci95_singleton_returns_zero_ci() -> None:
    mean, ci, n = mean_ci95([7.0])
    assert mean == 7.0
    assert ci == 0.0
    assert n == 1


def test_mean_ci95_matches_manual_t_formula() -> None:
    samples = [10.0, 12.0, 14.0, 11.0, 13.0]
    n = len(samples)
    mean = sum(samples) / n
    var = sum((s - mean) ** 2 for s in samples) / (n - 1)
    expected_ci = t_critical_975(n - 1) * math.sqrt(var) / math.sqrt(n)
    m, ci, n_out = mean_ci95(samples)
    assert m == pytest.approx(mean)
    assert ci == pytest.approx(expected_ci)
    assert n_out == n


def test_run_driver_multi_seed_writes_combined_parquet(tmp_path: Path) -> None:
    artifact = run_driver_multi_seed(
        "rq1",
        tmp_path,
        config={
            "seed": 0,  # overridden per-seed
            "num_calls": 4,
            "failure_density": 0.5,
            "concurrency": 1,
            "approval_rate": 0.6,
            "repetitions": 2,
            "baselines": ["recourse"],
            "fault_classes": ["NONE"],
            "workloads": ["postgres"],
        },
        base_seeds=[42, 43, 44],
    )

    assert artifact.metrics_path.exists()
    assert artifact.manifest_path.exists()
    frame = pd.read_parquet(artifact.metrics_path)
    # The multi-seed CI uses one independent realized trace per requested seed.
    # Ordinary single-seed drivers retain their configured repetition behavior.
    assert len(frame) == 3
    assert sorted(frame["base_seed"].unique().tolist()) == [42, 43, 44]
    assert sorted(frame["seed"].tolist()) == [42, 43, 44]
    for seed in (42, 43, 44):
        sub = frame[frame["base_seed"] == seed]
        assert sub["seed"].tolist() == [seed]

    manifest = json.loads(artifact.manifest_path.read_text())
    assert manifest["rq"] == "rq1"
    assert manifest["baseSeeds"] == [42, 43, 44]
    assert manifest["realizedSeeds"] == [42, 43, 44]
    assert manifest["sourceConfigRepetitions"] == 2
    assert manifest["perSeedRepetitions"] == 1
    assert manifest["samplesPerCell"] == 3
    assert manifest["statisticalUnit"] == "independent_trace_seed"
    assert manifest["gitCommit"]
    assert isinstance(manifest["gitDirty"], bool)
    assert manifest["configHash"].startswith("sha256:")


def test_run_driver_multi_seed_rejects_duplicate_realized_seeds(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="base_seeds must be unique"):
        run_driver_multi_seed(
            "rq1",
            tmp_path,
            config={
                "num_calls": 1,
                "repetitions": 5,
                "baselines": ["recourse"],
                "fault_classes": ["NONE"],
            },
            base_seeds=[42, 42],
        )


def test_emit_ci_tables_render_pm_macro(tmp_path: Path) -> None:
    # Run a tiny multi-seed sweep so each emitter sees real columns.
    artifact = run_driver_multi_seed(
        "rq8",
        tmp_path / "rq8",
        config={
            "seed": 0,
            "num_calls": 6,
            "failure_density": 0.5,
            "concurrency": 2,
            "approval_rate": 1.0,
            "repetitions": 2,
            "baselines": ["recourse"],
            "fault_classes": ["NONE"],
            "workloads": ["postgres"],
            "adversary_classes": ["NONE"],
            "bond_multipliers": [0.5, 1.0],
        },
        base_seeds=[42, 43],
    )
    frame = pd.read_parquet(artifact.metrics_path)
    target = tmp_path / "table_rq8_bondsens_ci.tex"
    emit_rq8_bondsens_ci(frame, target)
    text = target.read_text()
    assert r"\def\tablerqeightci" in text
    assert r"$\pm$" in text
    # Two bond multipliers => two body rows. The final row in a macro definition
    # ends with ``\\%`` (closing the macro on the same line); count both forms.
    body_rows = [
        line for line in text.splitlines()
        if line.rstrip().endswith(r"\\") or line.rstrip().endswith(r"\\%")
    ]
    assert len(body_rows) == 2


def test_emit_rq1_baselines_ci_includes_all_baselines(tmp_path: Path) -> None:
    artifact = run_driver_multi_seed(
        "rq1",
        tmp_path / "rq1",
        config={
            "num_calls": 4,
            "concurrency": 1,
            "approval_rate": 0.6,
            "repetitions": 2,
            "baselines": ["recourse", "centralized", "atomix"],
            "fault_classes": ["NONE"],
            "workloads": ["postgres"],
        },
        base_seeds=[42, 43],
    )
    frame = pd.read_parquet(artifact.metrics_path)
    target = tmp_path / "table_rq1_baselines_ci.tex"
    emit_rq1_baselines_ci(frame, target)
    text = target.read_text()
    for baseline in ("recourse", "centralized", "atomix"):
        assert baseline in text


def test_emit_rq4_ablation_ci_renders_obj_dash_for_no_settlement_layer(tmp_path: Path) -> None:
    artifact = run_driver_multi_seed(
        "rq4",
        tmp_path / "rq4",
        config={
            "num_calls": 6,
            "concurrency": 2,
            "approval_rate": 0.7,
            "repetitions": 2,
            "baselines": ["oap", "atomix", "centralized", "recourse"],
            "fault_classes": ["NONE"],
            "workloads": ["postgres"],
        },
        base_seeds=[42, 43],
    )
    frame = pd.read_parquet(artifact.metrics_path)
    target = tmp_path / "table_rq4_ablation_ci.tex"
    emit_rq4_ablation_ci(frame, target)
    text = target.read_text()
    # oap/atomix rows should carry the literal --- obj-share marker.
    assert "atomix &" in text
    assert "---" in text


def test_emit_rq5_adv_ci_orders_adversaries_canonically(tmp_path: Path) -> None:
    artifact = run_driver_multi_seed(
        "rq5-adv",
        tmp_path / "rq5adv",
        config={
            "num_calls": 6,
            "concurrency": 2,
            "approval_rate": 1.0,
            "repetitions": 1,
            "baselines": ["recourse"],
            "fault_classes": ["NONE"],
            "workloads": ["postgres"],
            "adversary_classes": [
                "NONE",
                "DISHONEST_CLAIMANT",
                "BOND_STRESS",
            ],
        },
        base_seeds=[42, 43],
    )
    frame = pd.read_parquet(artifact.metrics_path)
    target = tmp_path / "table_rq5_adv_ci.tex"
    emit_rq5_adv_ci(frame, target)
    text = target.read_text()
    # The emitter must respect _ADVERSARY_ORDER even when fewer classes are present.
    none_pos = text.find("NONE &")
    dc_pos = text.find("DISHONEST")
    bs_pos = text.find("BOND")
    assert 0 < none_pos < dc_pos < bs_pos


def test_emit_rq10_correlated_ci_orders_bursts_ascending(tmp_path: Path) -> None:
    artifact = run_driver_multi_seed(
        "rq10",
        tmp_path / "rq10",
        config={
            "num_calls": 8,
            "concurrency": 2,
            "approval_rate": 1.0,
            "repetitions": 1,
            "baselines": ["recourse"],
            "fault_classes": ["NONE"],
            "workloads": ["postgres"],
            "adversary_classes": ["NONE"],
            "bond_multipliers": [10],
            "correlation_prob": 0.3,
            "correlation_burst_sizes": [1, 4, 16],
        },
        base_seeds=[42, 43],
    )
    frame = pd.read_parquet(artifact.metrics_path)
    target = tmp_path / "table_rq10_correlated_ci.tex"
    emit_rq10_correlated_ci(frame, target)
    text = target.read_text()
    # Body rows start with the burst integer; they must appear in ascending order.
    body_rows = [
        line.strip() for line in text.splitlines()
        if line.rstrip().endswith(r"\\") or line.rstrip().endswith(r"\\%")
    ]
    leading = [int(row.split(" ", 1)[0]) for row in body_rows]
    assert leading == sorted(leading)
