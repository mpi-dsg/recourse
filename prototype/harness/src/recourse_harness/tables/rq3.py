"""RQ3 bond capital + transaction cost table emitter."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ._common import fmt_float, fmt_int, tex_escape, write_rows

HEADER = r"% emitted by recourse_harness.tables.rq3 — do not hand-edit"


def emit_rq3_capital(metrics: pd.DataFrame, output_path: Path) -> Path:
    grouped = (
        metrics.groupby("workload")[
            ["bond_avg_locked", "bond_peak_locked", "bond_utilization", "under_bond_shortfall"]
        ]
        .mean()
        .reset_index()
    )
    rows: list[str] = []
    for _, row in grouped.iterrows():
        rows.append(
            f"{tex_escape(row['workload'])} & "
            f"{fmt_int(row['bond_avg_locked'])} & "
            f"{fmt_int(row['bond_peak_locked'])} & "
            f"{fmt_float(row['bond_utilization'])} & "
            f"{fmt_int(row['under_bond_shortfall'])} \\\\"
        )
    return write_rows(output_path, HEADER, rows, "tablerqthree")
