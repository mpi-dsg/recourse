"""RQ2 settleability predicates table emitter."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ._common import fmt_float, tex_escape, write_rows

HEADER = r"% emitted by recourse_harness.tables.rq2 — do not hand-edit"


def emit_rq2_predicates(metrics: pd.DataFrame, output_path: Path) -> Path:
    recourse_only = metrics[metrics["baseline"] == "recourse"]
    grouped = (
        recourse_only.groupby("workload")[
            ["eligibility_rate", "objective_settlement_rate", "arbitration_rate"]
        ]
        .mean()
        .reset_index()
    )
    rows: list[str] = []
    for _, row in grouped.iterrows():
        # κ-shorthand and (o,r)-shorthand columns are placeholders for the LaTeX
        # column layout; the substantive numbers are eligibility / objective / arb.
        rows.append(
            f"{tex_escape(row['workload'])} & "
            f"{fmt_float(row['eligibility_rate'])} & "
            f"{fmt_float(row['objective_settlement_rate'])} & "
            f"{fmt_float(row['arbitration_rate'])} & "
            f"{fmt_float(1.0 - row['eligibility_rate'])} \\\\"
        )
    return write_rows(output_path, HEADER, rows, "tablerqtwo")
