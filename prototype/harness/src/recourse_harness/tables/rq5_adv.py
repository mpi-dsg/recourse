"""RQ5-Adv adversarial-sweep table emitter.

Reports the four worst-case adversary metrics from main.tex IX.H:
    false_acceptance   (claim wrongly settled optimistically)
    false_rejection    (honest claim wrongly rejected)
    residual_loss      (uncompensated harm, $)
    bond_shortfall     (residual_harm - bond_available, summed)
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ._common import fmt_float, fmt_int, tex_escape, write_rows

HEADER = r"% emitted by recourse_harness.tables.rq5_adv -- do not hand-edit"

_ADVERSARY_ORDER = (
    "NONE",
    "DISHONEST_CLAIMANT",
    "ABSENT_CHALLENGER",
    "BOND_STRESS",
    "COLLUDING_CHALLENGERS",
)


def emit_rq5_adv(metrics: pd.DataFrame, output_path: Path) -> Path:
    if "adversary_class" not in metrics.columns:
        raise ValueError("metrics frame is missing 'adversary_class' column")
    recourse_only = metrics[metrics["baseline"] == "recourse"].copy()
    grouped = (
        recourse_only.groupby("adversary_class")[
            ["false_acceptance", "false_rejection", "uncompensated", "under_bond_shortfall"]
        ]
        .mean()
        .reset_index()
    )
    by_name = {row["adversary_class"]: row for _, row in grouped.iterrows()}
    rows: list[str] = []
    for name in _ADVERSARY_ORDER:
        if name not in by_name:
            continue
        row = by_name[name]
        rows.append(
            f"{tex_escape(name)} & "
            f"{fmt_float(float(row['false_acceptance']))} & "
            f"{fmt_float(float(row['false_rejection']))} & "
            f"{fmt_int(float(row['uncompensated']))} & "
            f"{fmt_int(float(row['under_bond_shortfall']))} \\\\"
        )
    return write_rows(output_path, HEADER, rows, "tablerqfiveadv")
