"""RQ5 routing distribution table emitter."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ._common import fmt_float, tex_escape, write_rows

HEADER = r"% emitted by recourse_harness.tables.rq5 — do not hand-edit"


def emit_rq5_routing(metrics: pd.DataFrame, output_path: Path) -> Path:
    recourse_only = metrics[metrics["baseline"] == "recourse"]
    grouped = (
        recourse_only.groupby("fault_class")[
            ["eligibility_rate", "objective_settlement_rate", "arbitration_rate"]
        ]
        .mean()
        .reset_index()
    )
    rows: list[str] = []
    for _, row in grouped.iterrows():
        ineligible = max(0.0, 1.0 - float(row["eligibility_rate"]))
        objective = float(row["objective_settlement_rate"])
        arbitrated = float(row["arbitration_rate"])
        excluded = max(0.0, 1.0 - (ineligible + objective + arbitrated))
        rows.append(
            f"{tex_escape(row['fault_class'])} & "
            f"{fmt_float(ineligible)} & "
            f"{fmt_float(objective)} & "
            f"{fmt_float(arbitrated)} & "
            f"{fmt_float(excluded)} \\\\"
        )
    return write_rows(output_path, HEADER, rows, "tablerqfive")
