"""RQ8 — Bond multiplier sensitivity table emitter."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ._common import fmt_float, fmt_int, write_rows

HEADER = r"% emitted by recourse_harness.tables.rq8 — do not hand-edit"


def emit_rq8_bondsens(metrics: pd.DataFrame, output_path: Path) -> Path:
    """One row per bond multiplier: locked bond, uncompensated loss, utilisation, shortfall."""
    recourse_only = metrics[metrics["baseline"] == "recourse"]
    grouped = (
        recourse_only.groupby("bond_multiplier")[
            ["bond_avg_locked", "uncompensated", "bond_utilization", "under_bond_shortfall"]
        ]
        .mean()
        .reset_index()
        .sort_values("bond_multiplier")
    )
    rows: list[str] = []
    for _, row in grouped.iterrows():
        rows.append(
            f"{fmt_float(row['bond_multiplier'])} & "
            f"{fmt_int(row['bond_avg_locked'])} & "
            f"{fmt_int(row['uncompensated'])} & "
            f"{fmt_float(row['bond_utilization'])} & "
            f"{fmt_int(row['under_bond_shortfall'])} \\\\"
        )
    return write_rows(output_path, HEADER, rows, "tablerqeight")
