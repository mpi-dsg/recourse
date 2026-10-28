from __future__ import annotations

import pandas as pd

from recourse_harness.metrics import ActionDecision, RunResult, compute_metrics, metrics_frame


def _run_result() -> RunResult:
    return RunResult(
        baseline="recourse",
        workload="postgres",
        seed=42,
        actions=(
            ActionDecision(
                call_id="a",
                risky=True,
                executed=True,
                required_human_approval=False,
                eligible=True,
                route="optimistic",
                gross_harm=1000,
                residual_harm=400,
                payout_amount=300,
                bond_available=250,
                recovery_latency_ms=1200,
                finalization_latency_ms=3000,
                tool_latency_ms=25,
            ),
            ActionDecision(
                call_id="b",
                risky=True,
                executed=False,
                required_human_approval=True,
                eligible=False,
                route="ineligible",
                gross_harm=0,
                residual_harm=0,
                payout_amount=0,
                bond_available=0,
                tool_latency_ms=10,
            ),
        ),
        functional_flags={
            "payout_without_operator_consent": True,
            "third_party_can_challenge": True,
            "external_history_reconstructable": True,
        },
    )


def test_known_run_result_produces_expected_metrics_row() -> None:
    row = compute_metrics(_run_result())

    assert row["coverage"] == 0.5
    assert row["gross_harm"] == 1000
    assert row["recovered"] == 600
    assert row["covered"] == 250
    assert row["uncompensated"] == 150
    assert row["eligibility_rate"] == 0.5
    assert row["objective_settlement_rate"] == 1.0
    assert row["arbitration_rate"] == 0.0
    assert row["routing_correctness"] == 1.0
    assert row["false_acceptance"] == 0.0
    assert row["false_rejection"] == 0.0
    assert row["throughput_qps"] == 2000 / 35
    assert row["payout_without_operator_consent"] is True
    assert row["third_party_can_challenge"] is True
    assert row["external_history_reconstructable"] is True


def test_metrics_frame_uses_stable_column_schema() -> None:
    frame = metrics_frame([_run_result()])

    assert isinstance(frame, pd.DataFrame)
    assert list(frame["baseline"]) == ["recourse"]
    assert "under_bond_shortfall" in frame.columns
    assert "throughput_qps" in frame.columns
