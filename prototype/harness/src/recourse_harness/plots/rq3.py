"""RQ3 — Performance, latency, capital cost."""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

from ._style import apply_paper_style, colour_for


def plot_rq3_overhead(metrics: pd.DataFrame, output_path: Path) -> Path:
    """Per-baseline tool-execution latency bar chart."""
    apply_paper_style()
    grouped = (
        metrics.groupby("baseline")["tool_execution_latency_ms"].mean().reset_index()
    )
    fig, ax = plt.subplots()
    ax.bar(
        grouped["baseline"],
        grouped["tool_execution_latency_ms"],
        color=[colour_for(b) for b in grouped["baseline"]],
        edgecolor="black",
        linewidth=0.4,
    )
    ax.set_ylabel("Tool-execution latency (ms)")
    ax.set_title("RQ3: tool-execution overhead")
    ax.tick_params(axis="x", rotation=30)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path)
    plt.close(fig)
    return output_path


def plot_rq3_latency(metrics: pd.DataFrame, output_path: Path) -> Path:
    """Per-baseline claim-finalisation latency bar chart."""
    apply_paper_style()
    grouped = (
        metrics.groupby("baseline")["time_to_finalization"].mean().reset_index()
    )
    fig, ax = plt.subplots()
    ax.bar(
        grouped["baseline"],
        grouped["time_to_finalization"],
        color=[colour_for(b) for b in grouped["baseline"]],
        edgecolor="black",
        linewidth=0.4,
    )
    ax.set_ylabel("Claim finalisation (s)")
    ax.set_title("RQ3: claim finalisation latency")
    ax.tick_params(axis="x", rotation=30)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path)
    plt.close(fig)
    return output_path
