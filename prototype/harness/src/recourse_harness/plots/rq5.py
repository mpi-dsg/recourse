"""RQ5 — Routing confusion across predicate-failure classes."""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

from ._style import apply_paper_style

ROUTES = ["ineligible", "optimistic", "arbitrated", "excluded"]

_EXPECTED_ROUTE_FOR_FAULT = {
    "none": "optimistic",
    "OBS_HIDE_PRESTATE": "arbitrated",
    "OBS_REMOVE_PROVIDER_SIG": "arbitrated",
    "OBS_AMBIGUOUS_RESOURCE": "arbitrated",
    "REC_STALE_SNAPSHOT": "arbitrated",
    "REC_INVALID_ARTIFACT": "arbitrated",
    "REC_PARTIAL_FAILURE": "arbitrated",
    "BND_OUT_OF_CAP_LOSS": "excluded",
    "BND_DOWNSTREAM_LEAK": "excluded",
    "CMP_SUBJECTIVE_RULE": "arbitrated",
}


def plot_rq5_confusion(metrics: pd.DataFrame, output_path: Path) -> Path:
    """Confusion matrix: expected route per fault class versus observed router behaviour.

    For the synthetic harness the routing classifier is deterministic, so the
    matrix is mostly diagonal. The plot exists so the same code path produces
    the figure once provider-backed runs widen the distribution.
    """
    apply_paper_style()
    recourse_only = metrics[metrics["baseline"] == "recourse"].copy()
    if recourse_only.empty:
        recourse_only = metrics.copy()

    matrix = np.zeros((len(_EXPECTED_ROUTE_FOR_FAULT), len(ROUTES)))
    fault_classes = list(_EXPECTED_ROUTE_FOR_FAULT.keys())
    for i, fault in enumerate(fault_classes):
        expected = _EXPECTED_ROUTE_FOR_FAULT[fault]
        subset = recourse_only[recourse_only["fault_class"] == fault]
        if subset.empty:
            continue
        objective = float(subset["objective_settlement_rate"].mean())
        arbitrated = float(subset["arbitration_rate"].mean())
        eligibility = float(subset["eligibility_rate"].mean())
        ineligible = 1.0 - eligibility
        excluded = max(0.0, 1.0 - (objective + arbitrated + ineligible))
        # Re-express on the categorical route axis.
        if expected == "optimistic":
            matrix[i] = [ineligible, objective, arbitrated, excluded]
        else:
            matrix[i] = [ineligible, objective, arbitrated, excluded]

    fig, ax = plt.subplots(figsize=(4.4, 3.2))
    im = ax.imshow(matrix, aspect="auto", cmap="Reds", vmin=0, vmax=1)
    ax.set_xticks(range(len(ROUTES)))
    ax.set_xticklabels(ROUTES, rotation=30)
    ax.set_yticks(range(len(fault_classes)))
    ax.set_yticklabels(fault_classes, fontsize=6)
    ax.set_xlabel("observed route")
    ax.set_ylabel("injected fault class")
    ax.set_title("RQ5: routing confusion matrix")
    fig.colorbar(im, ax=ax, shrink=0.7).set_label("fraction", fontsize=7)
    for i in range(matrix.shape[0]):
        for j in range(matrix.shape[1]):
            value = matrix[i, j]
            if value >= 0.05:
                ax.text(
                    j,
                    i,
                    f"{value:.2f}",
                    ha="center",
                    va="center",
                    color="white" if value > 0.5 else "black",
                    fontsize=6,
                )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(output_path)
    plt.close(fig)
    return output_path
