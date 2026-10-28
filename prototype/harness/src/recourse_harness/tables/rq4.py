"""RQ4 ablation deltas table emitter."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ._common import fmt_float, fmt_int, tex_escape, write_rows

HEADER = r"% emitted by recourse_harness.tables.rq4 — do not hand-edit"


def emit_rq4_ablation(metrics: pd.DataFrame, output_path: Path) -> Path:
    grouped = (
        metrics.groupby("baseline")[
            ["uncompensated", "objective_settlement_rate", "false_acceptance", "bond_utilization"]
        ]
        .mean()
        .reset_index()
    )
    rows: list[str] = []
    # Baselines without an on-chain settlement layer have no defined
    # objective-settlement share; we render them as N/A. Recording the
    # classifier's would-be route there would mis-suggest a settlement event.
    _NO_SETTLEMENT_LAYER = {"oap", "atomix", "auth_plus_local", "none", "human"}
    for _, row in grouped.iterrows():
        baseline = row["baseline"]
        if baseline in _NO_SETTLEMENT_LAYER:
            obj_cell = "---"
        else:
            obj_cell = fmt_float(row["objective_settlement_rate"])
        rows.append(
            f"{tex_escape(baseline)} & "
            f"{fmt_int(row['uncompensated'])} & "
            f"{obj_cell} & "
            f"{fmt_float(row['false_acceptance'])} & "
            f"{fmt_float(row['bond_utilization'])} \\\\"
        )
    return write_rows(output_path, HEADER, rows, "tablerqfour")
