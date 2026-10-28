from pathlib import Path

import pandas as pd

from recourse_harness.tables import (
    emit_rq1_baselines,
    emit_rq2_predicates,
    emit_rq2_reasons,
    emit_rq3_capital,
    emit_rq4_ablation,
    emit_rq5_routing,
    emit_rq10_correlated,
)
from recourse_harness.tables._common import fmt_float, fmt_int, tex_escape


def _fake_metrics() -> pd.DataFrame:
    return pd.DataFrame(
        [
            {
                "baseline": "recourse",
                "workload": "postgres",
                "fault_class": "NONE",
                "gross_harm": 100,
                "recovered": 50,
                "covered": 25,
                "uncompensated": 25,
                "eligibility_rate": 1.0,
                "objective_settlement_rate": 1.0,
                "arbitration_rate": 0.0,
                "false_acceptance": 0.0,
                "bond_avg_locked": 1.0,
                "bond_peak_locked": 2,
                "bond_utilization": 3,
                "under_bond_shortfall": 4,
            },
            {
                "baseline": "auth_plus_local",
                "workload": "postgres",
                "fault_class": "OBS_HIDE_PRESTATE",
                "gross_harm": 200,
                "recovered": 0,
                "covered": 0,
                "uncompensated": 200,
                "eligibility_rate": 0.5,
                "objective_settlement_rate": 0.0,
                "arbitration_rate": 0.5,
                "false_acceptance": 0.0,
                "bond_avg_locked": 0.0,
                "bond_peak_locked": 0,
                "bond_utilization": 0,
                "under_bond_shortfall": 200,
            },
        ]
    )


def test_tex_escape_handles_special_chars() -> None:
    assert tex_escape("auth_plus_local") == r"auth\_plus\_local"
    assert tex_escape("a & b") == r"a \& b"


def test_fmt_helpers() -> None:
    assert fmt_int(3.6) == "4"
    assert fmt_float(0.123) == "0.12"


def test_rq1_table(tmp_path: Path) -> None:
    out = emit_rq1_baselines(_fake_metrics(), tmp_path / "t1.tex")
    body = out.read_text()
    assert r"\tablerqone" in body
    assert r"auth\_plus\_local" in body


def test_rq2_table(tmp_path: Path) -> None:
    out = emit_rq2_predicates(_fake_metrics(), tmp_path / "t2.tex")
    body = out.read_text()
    assert r"\tablerqtwo" in body


def test_rq3_table(tmp_path: Path) -> None:
    out = emit_rq3_capital(_fake_metrics(), tmp_path / "t3.tex")
    body = out.read_text()
    assert r"\tablerqthree" in body


def test_rq4_table(tmp_path: Path) -> None:
    out = emit_rq4_ablation(_fake_metrics(), tmp_path / "t4.tex")
    body = out.read_text()
    assert r"\tablerqfour" in body


def test_rq5_table(tmp_path: Path) -> None:
    out = emit_rq5_routing(_fake_metrics(), tmp_path / "t5.tex")
    body = out.read_text()
    assert r"\tablerqfive" in body


def test_rq2_reasons_table_emits_admitted_and_rejection_rows(tmp_path: Path) -> None:
    metrics = pd.DataFrame(
        [
            {"baseline": "recourse", "rejection_reasons": "admitted:8,EvidenceSchemaOK:2"},
            {"baseline": "recourse", "rejection_reasons": "RecoveryAvailable:5,admitted:5"},
            # A non-recourse row is filtered out by the emitter.
            {"baseline": "human", "rejection_reasons": ""},
        ]
    )
    out = emit_rq2_reasons(metrics, tmp_path / "t2r.tex")
    body = out.read_text()
    assert r"\tablerqtworeasons" in body
    # Each fired sub-predicate gets a row plus the admitted summary row.
    assert "RecoveryAvailable" in body
    assert "EvidenceSchemaOK" in body
    assert "admitted" in body


def test_rq10_table_groups_by_burst_size(tmp_path: Path) -> None:
    metrics = pd.DataFrame(
        [
            {
                "baseline": "recourse",
                "correlation_burst_size": 1,
                "bond_peak_concurrent_locked": 7700,
                "bond_utilization": 0.1,
                "concurrent_shortfall": 0,
                "uncompensated": 3000,
            },
            {
                "baseline": "recourse",
                "correlation_burst_size": 16,
                "bond_peak_concurrent_locked": 7700,
                "bond_utilization": 0.6,
                "concurrent_shortfall": 4500,
                "uncompensated": 9000,
            },
        ]
    )
    out = emit_rq10_correlated(metrics, tmp_path / "t10.tex")
    body = out.read_text()
    assert r"\tablerqten" in body
    assert "1 & 7700" in body
    assert "16 & 7700" in body
