#!/usr/bin/env bash
# Run a single research question end-to-end against the deterministic harness.
# Loads the per-RQ config from harness/configs/<rq>/sweep.yaml and the shared
# budgets from harness/configs/budgets.yaml.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROTOTYPE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$PROTOTYPE_DIR"

RQ="${1:-}"
case "$RQ" in
  all)
    BASE_OUT="${RECOURSE_RQ_OUTPUT_DIR:-${RECOURSE_RESULTS_ROOT:-results}}"
    for rq in rq1 rq2 rq2-reasons rq3 rq4 rq5 rq5-adv rq8 rq9 rq10; do
      RECOURSE_RQ_OUTPUT_DIR="$BASE_OUT/$rq" "$SCRIPT_DIR/run-rq.sh" "$rq"
    done
    exit 0
    ;;
  rq1|rq2|rq2-reasons|rq3|rq4|rq5|rq5-adv|rq8|rq9|rq10)
    ;;
  *)
    echo "usage: $0 rq1|rq2|rq2-reasons|rq3|rq4|rq5|rq5-adv|rq8|rq9|rq10|all" >&2
    exit 2
    ;;
esac

OUT="${RECOURSE_RQ_OUTPUT_DIR:-${RECOURSE_RESULTS_ROOT:-results}/$RQ}"
case "$OUT" in
  /*) OUTPUT_ARG="$OUT" ;;
  *) OUTPUT_ARG="../$OUT" ;;
esac

CONFIG_ARG="../harness/configs/$RQ/sweep.yaml"
BUDGETS_ARG="../harness/configs/budgets.yaml"

cd harness
uv run python - "$RQ" "$OUTPUT_ARG" "$CONFIG_ARG" "$BUDGETS_ARG" <<'PY'
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import yaml

from recourse_harness.drivers import run_driver

rq = sys.argv[1]
output_dir = Path(sys.argv[2])
config_path = Path(sys.argv[3])
budgets_path = Path(sys.argv[4])

with config_path.open("r", encoding="utf-8") as fh:
    config = yaml.safe_load(fh)
with budgets_path.open("rb") as fh:
    budget_bytes = fh.read()
budget_file_hash = "sha256:" + hashlib.sha256(budget_bytes).hexdigest()

config = dict(config)
config["budget_file_hash"] = budget_file_hash

artifact = run_driver(rq, output_dir, config=config)
print(f"metrics={artifact.metrics_path}")
print(f"manifest={artifact.manifest_path}")
PY
