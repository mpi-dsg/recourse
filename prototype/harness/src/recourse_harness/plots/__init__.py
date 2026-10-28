"""Matplotlib-based plot generators for the RQ result parquet files."""

from .rq1 import plot_rq1_frontier
from .rq2 import plot_rq2_funnel
from .rq3 import plot_rq3_overhead, plot_rq3_latency
from .rq4 import plot_rq4_ablation
from .rq5 import plot_rq5_confusion
from .rq9 import plot_rq9_frontier

__all__ = [
    "plot_rq1_frontier",
    "plot_rq2_funnel",
    "plot_rq3_overhead",
    "plot_rq3_latency",
    "plot_rq4_ablation",
    "plot_rq5_confusion",
    "plot_rq9_frontier",
]
