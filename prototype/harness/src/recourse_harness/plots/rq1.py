"""RQ1 — Autonomy coverage versus uncompensated residual loss."""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

from ._style import apply_paper_style, colour_for


def plot_rq1_frontier(metrics: pd.DataFrame, output_path: Path) -> Path:
    """Plot autonomy coverage (x) versus uncompensated residual loss (y) per baseline.

    A baseline that sits closer to the bottom-right has more autonomy with less
    residual loss; the upper-left is the conservative-but-leaky region.
    """
    apply_paper_style()

    grouped = (
        metrics.groupby("baseline")[["coverage", "uncompensated"]]
        .mean()
        .reset_index()
    )
    fig, ax = plt.subplots()
    for _, row in grouped.iterrows():
        ax.scatter(
            row["coverage"],
            row["uncompensated"],
            color=colour_for(row["baseline"]),
            label=row["baseline"],
            s=42,
            edgecolor="black",
            linewidth=0.4,
        )
        ax.annotate(
            row["baseline"],
            (row["coverage"], row["uncompensated"]),
            xytext=(3, 3),
            textcoords="offset points",
            fontsize=6,
        )
    ax.set_xlabel("Autonomous coverage")
    ax.set_ylabel("Uncompensated residual loss (units)")
    ax.set_title("RQ1: autonomy vs uncompensated residual loss")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path)
    plt.close(fig)
    return output_path
