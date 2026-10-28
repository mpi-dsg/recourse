"""RQ1 baseline summary table emitter."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ._common import fmt_int, tex_escape, write_rows

HEADER = r"% emitted by recourse_harness.tables.rq1 — do not hand-edit"


def emit_rq1_baselines(metrics: pd.DataFrame, output_path: Path) -> Path:
    grouped = (
        metrics.groupby(["workload", "baseline"])[
            ["gross_harm", "recovered", "covered", "uncompensated"]
        ]
        .mean()
        .reset_index()
    )
    rows: list[str] = []
    for _, row in grouped.iterrows():
        rows.append(
            f"{tex_escape(row['workload'])} & {tex_escape(row['baseline'])} & "
            f"{fmt_int(row['gross_harm'])} & "
            f"{fmt_int(row['recovered'])} & "
            f"{fmt_int(row['covered'])} & "
            f"{fmt_int(row['uncompensated'])} \\\\"
        )
    return write_rows(output_path, HEADER, rows, "tablerqone")
