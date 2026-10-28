"""RQ9 — Approval-rate frontier table emitter."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ._common import fmt_float, fmt_int, tex_escape, write_rows

HEADER = r"% emitted by recourse_harness.tables.rq9 — do not hand-edit"


def emit_rq9_frontier(metrics: pd.DataFrame, output_path: Path) -> Path:
    """One row per (baseline, approval_rate): coverage and uncompensated residual loss."""
    grouped = (
        metrics.groupby(["baseline", "approval_rate"])[["coverage", "uncompensated"]]
        .mean()
        .reset_index()
        .sort_values(["baseline", "approval_rate"])
    )
    rows: list[str] = []
    for _, row in grouped.iterrows():
        rows.append(
            f"{tex_escape(row['baseline'])} & "
            f"{fmt_float(row['approval_rate'])} & "
            f"{fmt_float(row['coverage'])} & "
            f"{fmt_int(row['uncompensated'])} \\\\"
        )
    return write_rows(output_path, HEADER, rows, "tablerqnine")
