"""RQ10 — Correlated-failure burst sensitivity table emitter.

One row per burst size $k$: average concurrent peak locked bond, bond
utilisation, under-bond shortfall, and uncompensated loss. ``peak_lock``
here is the *concurrent* peak — the sum of bond locked by all calls
inside a single burst window — which is the quantity that scales with
$k$ under the shared-pool semantics modelled in ``baselines._share_correlated_bonds``.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from ._common import fmt_float, fmt_int, write_rows

HEADER = r"% emitted by recourse_harness.tables.rq10 — do not hand-edit"


def emit_rq10_correlated(metrics: pd.DataFrame, output_path: Path) -> Path:
    recourse_only = metrics[metrics["baseline"] == "recourse"]
    grouped = (
        recourse_only.groupby("correlation_burst_size")[
            [
                "bond_peak_concurrent_locked",
                "bond_utilization",
                "concurrent_shortfall",
                "uncompensated",
            ]
        ]
        .mean()
        .reset_index()
        .sort_values("correlation_burst_size")
    )
    rows: list[str] = []
    for _, row in grouped.iterrows():
        rows.append(
            f"{fmt_int(row['correlation_burst_size'])} & "
            f"{fmt_int(row['bond_peak_concurrent_locked'])} & "
            f"{fmt_float(row['bond_utilization'])} & "
            f"{fmt_int(row['concurrent_shortfall'])} & "
            f"{fmt_int(row['uncompensated'])} \\\\"
        )
    return write_rows(output_path, HEADER, rows, "tablerqten")
