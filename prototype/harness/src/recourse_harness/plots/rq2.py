"""RQ2 — Settleability funnel: risky → eligible → settleable."""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

from ._style import apply_paper_style


def plot_rq2_funnel(metrics: pd.DataFrame, output_path: Path) -> Path:
    """Plot a three-stage funnel (proposed risky → eligible → settled objectively).

    The dataframe is expected to carry `eligibility_rate` and
    `objective_settlement_rate`; we collapse over baselines (Recourse only) and
    workloads, reporting one bar per stage.
    """
    apply_paper_style()
    recourse_only = metrics[metrics["baseline"] == "recourse"]
    eligibility_mean = float(recourse_only["eligibility_rate"].mean())
    objective_settlement_mean = float(recourse_only["objective_settlement_rate"].mean())
    stages = ["risky proposed", "eligible κ", "settled objectively"]
    values = [1.0, eligibility_mean, eligibility_mean * objective_settlement_mean]

    fig, ax = plt.subplots()
    bars = ax.bar(stages, values, color=["#cccccc", "#1f77b4", "#d62728"], edgecolor="black", linewidth=0.4)
    for bar, value in zip(bars, values):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            value + 0.02,
            f"{value:.2f}",
            ha="center",
            va="bottom",
            fontsize=7,
        )
    ax.set_ylim(0, 1.1)
    ax.set_ylabel("Fraction of proposed risky actions")
    ax.set_title("RQ2: settleability funnel")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path)
    plt.close(fig)
    return output_path
