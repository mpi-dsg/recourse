from pathlib import Path

import matplotlib

matplotlib.use("Agg")

import pandas as pd

from recourse_harness.plots import (
    plot_rq1_frontier,
    plot_rq2_funnel,
    plot_rq3_latency,
    plot_rq3_overhead,
    plot_rq4_ablation,
    plot_rq5_confusion,
)


def _fake_metrics() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "baseline": "recourse",
                "workload": "postgres",
                "seed": 42,
                "fault_class": "NONE",
                "actions": 24,
                "coverage": 0.66,
                "gross_harm": 100,
                "recovered": 50,
                "covered": 25,
                "uncompensated": 25,
                "eligibility_rate": 1.0,
                "objective_settlement_rate": 1.0,
                "arbitration_rate": 0.0,
                "routing_correctness": 1.0,
                "false_acceptance": 0.0,
                "false_rejection": 0.0,
                "time_to_recovery": 400.0,
                "time_to_finalization": 0.0,
                "tool_execution_latency_ms": 25.0,
                "throughput_qps": 40.0,
                "bond_avg_locked": 0.0,
                "bond_peak_locked": 0,
                "bond_utilization": 0.0,
                "under_bond_shortfall": 25,
                "payout_without_operator_consent": True,
                "third_party_can_challenge": True,
                "external_history_reconstructable": True,
            },
            {
                "baseline": "none",
                "workload": "postgres",
                "seed": 42,
                "fault_class": "OBS_HIDE_PRESTATE",
                "actions": 24,
                "coverage": 0.66,
                "gross_harm": 200,
                "recovered": 0,
                "covered": 0,
                "uncompensated": 200,
                "eligibility_rate": 0.5,
                "objective_settlement_rate": 0.0,
                "arbitration_rate": 0.5,
                "routing_correctness": 1.0,
                "false_acceptance": 0.0,
                "false_rejection": 0.0,
                "time_to_recovery": 400.0,
                "time_to_finalization": 0.0,
                "tool_execution_latency_ms": 25.0,
                "throughput_qps": 40.0,
                "bond_avg_locked": 0.0,
                "bond_peak_locked": 0,
                "bond_utilization": 0.0,
                "under_bond_shortfall": 200,
                "payout_without_operator_consent": False,
                "third_party_can_challenge": False,
                "external_history_reconstructable": False,
            },
        ]
    )


def test_rq1_frontier(tmp_path: Path) -> None:
    out = plot_rq1_frontier(_fake_metrics(), tmp_path / "rq1.svg")
    assert out.exists()


def test_rq2_funnel(tmp_path: Path) -> None:
    out = plot_rq2_funnel(_fake_metrics(), tmp_path / "rq2.svg")
    assert out.exists()


def test_rq3_overhead(tmp_path: Path) -> None:
    out = plot_rq3_overhead(_fake_metrics(), tmp_path / "rq3o.svg")
    assert out.exists()


def test_rq3_latency(tmp_path: Path) -> None:
    out = plot_rq3_latency(_fake_metrics(), tmp_path / "rq3l.svg")
    assert out.exists()


def test_rq4_ablation(tmp_path: Path) -> None:
    out = plot_rq4_ablation(_fake_metrics(), tmp_path / "rq4.svg")
    assert out.exists()


def test_rq5_confusion(tmp_path: Path) -> None:
    out = plot_rq5_confusion(_fake_metrics(), tmp_path / "rq5.svg")
    assert out.exists()
