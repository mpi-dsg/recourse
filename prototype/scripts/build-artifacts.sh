#!/usr/bin/env bash
# Build plots and LaTeX table fragments from the most recent RQ run outputs.
# Reads results/<rq>/metrics.parquet and writes results/<rq>/figure_*.{svg,pdf}
# plus results/<rq>/table_*.tex. Idempotent.
set -euo pipefail

cd "$(dirname "$0")/.."

RESULTS_ROOT="${RECOURSE_RESULTS_ROOT:-results}"
case "$RESULTS_ROOT" in
  /*) ABS_RESULTS="$RESULTS_ROOT" ;;
  *) ABS_RESULTS="$(pwd)/$RESULTS_ROOT" ;;
esac

PAPER_DIR="${RECOURSE_PAPER_DIR:-}"

cd harness
uv run python - "$ABS_RESULTS" <<'PY'
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

from recourse_harness.plots import (
    plot_rq1_frontier,
    plot_rq2_funnel,
    plot_rq3_latency,
    plot_rq3_overhead,
    plot_rq4_ablation,
    plot_rq5_confusion,
    plot_rq9_frontier,
)
from recourse_harness.tables import (
    emit_rq1_baselines,
    emit_rq2_predicates,
    emit_rq2_reasons,
    emit_rq3_capital,
    emit_rq4_ablation,
    emit_rq5_routing,
    emit_rq5_adv,
    emit_rq8_bondsens,
    emit_rq9_frontier,
    emit_rq10_correlated,
)

results_root = Path(sys.argv[1])

builders = {
    "rq1": [
        (plot_rq1_frontier, "figure_rq1_frontier"),
        (emit_rq1_baselines, "table_rq1_baselines.tex"),
    ],
    "rq2": [
        (plot_rq2_funnel, "figure_rq2_funnel"),
        (emit_rq2_predicates, "table_rq2_predicates.tex"),
    ],
    "rq2-reasons": [
        (emit_rq2_reasons, "table_rq2_reasons.tex"),
    ],
    "rq3": [
        (plot_rq3_overhead, "figure_rq3_overhead"),
        (plot_rq3_latency, "figure_rq3_latency"),
        (emit_rq3_capital, "table_rq3_capital.tex"),
    ],
    "rq4": [
        (plot_rq4_ablation, "figure_rq4_ablation"),
        (emit_rq4_ablation, "table_rq4_ablation.tex"),
    ],
    "rq5": [
        (plot_rq5_confusion, "figure_rq5_confusion"),
        (emit_rq5_routing, "table_rq5_routing.tex"),
    ],
    "rq5-adv": [
        (emit_rq5_adv, "table_rq5_adv.tex"),
    ],
    "rq8": [
        (emit_rq8_bondsens, "table_rq8_bondsens.tex"),
    ],
    "rq9": [
        (plot_rq9_frontier, "figure_rq9_frontier"),
        (emit_rq9_frontier, "table_rq9_frontier.tex"),
    ],
    "rq10": [
        (emit_rq10_correlated, "table_rq10_correlated.tex"),
    ],
}

for rq, items in builders.items():
    metrics_path = results_root / rq / "metrics.parquet"
    if not metrics_path.exists():
        print(f"skipping {rq}: {metrics_path} not found")
        continue
    metrics = pd.read_parquet(metrics_path)
    for builder, basename in items:
        if basename.endswith(".tex"):
            target = results_root / rq / basename
            builder(metrics, target)
            print(f"wrote {target}")
        else:
            for ext in ("svg", "pdf"):
                target = results_root / rq / f"{basename}.{ext}"
                builder(metrics, target)
                print(f"wrote {target}")
PY

if [ -n "$PAPER_DIR" ]; then
  mkdir -p "$PAPER_DIR/figures" "$PAPER_DIR/tables"
  for rq in rq1 rq2 rq2-reasons rq3 rq4 rq5 rq5-adv rq8 rq9 rq10; do
    src_dir="$ABS_RESULTS/$rq"
    [ -d "$src_dir" ] || continue
    for f in "$src_dir"/figure_*.pdf; do
      [ -e "$f" ] || continue
      cp "$f" "$PAPER_DIR/figures/$(basename "$f")"
    done
    for f in "$src_dir"/table_*.tex; do
      [ -e "$f" ] || continue
      cp "$f" "$PAPER_DIR/tables/$(basename "$f")"
    done
  done
  echo "synced figures and tables to $PAPER_DIR"
fi

