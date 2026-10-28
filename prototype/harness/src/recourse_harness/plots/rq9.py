"""RQ9 — Uncompensated loss vs approval rate, one line per baseline."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import pandas as pd

from ._style import apply_paper_style, colour_for


def plot_rq9_frontier(metrics: pd.DataFrame, output_path: Path) -> Path:
    """One line per baseline, x = approval rate, y = uncompensated residual loss.

    Recourse and centralized share the bonded-coverage curve; none and oap share
    the uncovered curve; human is the gating curve whose coverage scales with
    approval rate. This encoding makes the bonded-coverage gap read off the
    y-axis directly at any fixed approval rate.
    """
    apply_paper_style()

    grouped = (
        metrics.groupby(["baseline", "approval_rate"])[["uncompensated"]]
        .mean()
        .reset_index()
        .sort_values(["baseline", "approval_rate"])
    )

    fig, ax = plt.subplots()
    # Draw order: solid lines first (centralized, none, human), then dashed
    # over-plots for the pairs that overlap them (recourse on centralized,
    # oap on none). Distinct markers + linestyles let the reader see all five
    # baselines even though loss values are pairwise identical.
    styles: dict[str, dict[str, Any]] = {
        "centralized": dict(marker="s", linestyle="-", linewidth=2.0, markersize=6),
        "recourse": dict(marker="o", linestyle="--", linewidth=1.2, markersize=4),
        "none": dict(marker="v", linestyle="-", linewidth=2.0, markersize=6),
        "oap": dict(marker="^", linestyle="--", linewidth=1.2, markersize=4),
        "human": dict(marker="D", linestyle="-", linewidth=1.5, markersize=5),
    }
    draw_order = ["centralized", "recourse", "none", "oap", "human"]
    for baseline in draw_order:
        frame = grouped[grouped["baseline"] == baseline]
        if frame.empty:
            continue
        frame = frame.sort_values("approval_rate")
        ax.plot(
            frame["approval_rate"],
            frame["uncompensated"],
            color=colour_for(baseline),
            label=baseline,
            **styles[baseline],
        )
    ax.set_xlabel("Approval rate")
    ax.set_ylabel("Uncompensated residual loss (units)")
    ax.set_title("RQ9: uncompensated loss vs approval rate")
    ax.set_xlim(-0.02, 1.02)
    ax.set_ylim(bottom=0)
    ax.grid(True, alpha=0.3)
    ax.legend(loc="upper left", fontsize=8, frameon=False)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path, bbox_inches="tight")
    plt.close(fig)
    return output_path
