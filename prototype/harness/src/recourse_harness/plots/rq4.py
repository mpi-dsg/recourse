"""RQ4 — Design ablation comparison."""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

from ._style import apply_paper_style


def plot_rq4_ablation(metrics: pd.DataFrame, output_path: Path) -> Path:
    """Grouped bars of uncompensated loss and objective-settlement share per baseline."""
    apply_paper_style()
    grouped = (
        metrics.groupby("baseline")[["uncompensated", "objective_settlement_rate"]]
        .mean()
        .reset_index()
    )
    x = range(len(grouped))
    width = 0.4

    fig, ax = plt.subplots()
    bars_loss = ax.bar(
        [i - width / 2 for i in x],
        grouped["uncompensated"],
        width=width,
        label="uncompensated",
        color="#d62728",
        edgecolor="black",
        linewidth=0.4,
    )
    ax2 = ax.twinx()
    bars_obj = ax2.bar(
        [i + width / 2 for i in x],
        grouped["objective_settlement_rate"],
        width=width,
        label="objective share",
        color="#1f77b4",
        edgecolor="black",
        linewidth=0.4,
        alpha=0.7,
    )
    ax.set_xticks(list(x))
    ax.set_xticklabels(grouped["baseline"], rotation=30)
    ax.set_ylabel("Uncompensated loss (units)")
    ax2.set_ylabel("Objective settlement share")
    ax.set_title("RQ4: ablation comparison")
    handles = [bars_loss, bars_obj]
    labels = [str(h.get_label() or "") for h in handles]
    ax.legend(handles, labels, loc="upper right", fontsize=6)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path)
    plt.close(fig)
    return output_path
