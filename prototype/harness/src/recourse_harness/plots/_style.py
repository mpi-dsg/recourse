"""Shared matplotlib style for IEEE-column figures."""

from __future__ import annotations

import matplotlib as mpl

IEEE_COLUMN_WIDTH_INCHES = 3.3
IEEE_FIG_HEIGHT_INCHES = 2.1

BASELINE_COLOURS: dict[str, str] = {
    "none": "#777777",
    "human": "#1f77b4",
    "oap": "#9467bd",
    "atomix": "#2ca02c",
    "auth_plus_local": "#17becf",
    "centralized": "#ff7f0e",
    "recourse": "#d62728",
}


def apply_paper_style() -> None:
    mpl.rcParams.update(
        {
            "figure.figsize": (IEEE_COLUMN_WIDTH_INCHES, IEEE_FIG_HEIGHT_INCHES),
            "font.family": "serif",
            "font.serif": ["DejaVu Serif"],
            "font.size": 8,
            "axes.labelsize": 8,
            "axes.titlesize": 9,
            "legend.fontsize": 7,
            "xtick.labelsize": 7,
            "ytick.labelsize": 7,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.grid": True,
            "grid.alpha": 0.25,
            "grid.linewidth": 0.5,
            "lines.linewidth": 1.2,
            "lines.markersize": 4,
            "svg.fonttype": "none",
            "savefig.dpi": 300,
            "savefig.bbox": "tight",
        }
    )


def colour_for(baseline: str) -> str:
    return BASELINE_COLOURS.get(baseline, "#444444")
