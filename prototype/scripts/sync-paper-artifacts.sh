#!/usr/bin/env bash
# Verify the frozen evidence bundle and reproduce the paper's generated assets.
set -euo pipefail

PROTOTYPE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
FREEZE_ROOT="${RECOURSE_FROZEN_ARTIFACTS_DIR:-$PROTOTYPE_DIR/reproducibility/paper-v1}"
PAPER_DIR="${RECOURSE_PAPER_DIR:-}"
MODE="${1:-sync}"

if [[ "$MODE" != "sync" && "$MODE" != "check" ]]; then
  echo "usage: $0 [sync|check]" >&2
  exit 2
fi
if [[ -z "$PAPER_DIR" ]]; then
  echo "RECOURSE_PAPER_DIR is required" >&2
  exit 2
fi

(
  cd "$FREEZE_ROOT"
  shasum -a 256 -c CHECKSUMS.sha256
)

declare -a TABLE_SOURCES=(
  "results/rq1/table_rq1_baselines.tex"
  "results/rq4/table_rq4_ablation.tex"
  "results/rq5/table_rq5_routing.tex"
  "results/rq5-adv/table_rq5_adv.tex"
  "results/rq8/table_rq8_bondsens.tex"
  "results/rq10/table_rq10_correlated.tex"
  "results/rq-provider-postgres/table_provider_postgres.tex"
  "results/rq-provider-git/table_provider_git.tex"
  "results/rq-provider-cloud/table_provider_cloud.tex"
  "results/k-contracts/table_k_catalogue.tex"
  "results/anvil-e2e/table_anvile2e_gas.tex"
)
declare -a FIGURE_SOURCES=(
  "figures/figure_architecture.png"
)

sync_one() {
  local relative=$1
  local target_dir=$2
  local source="$FREEZE_ROOT/$relative"
  local target
  target="$PAPER_DIR/$target_dir/$(basename "$relative")"
  if [[ "$MODE" == "check" ]]; then
    cmp --silent "$source" "$target" || {
      echo "paper artifact differs: $target" >&2
      return 1
    }
  else
    mkdir -p "$PAPER_DIR/$target_dir"
    cp "$source" "$target"
  fi
}

for artifact in "${TABLE_SOURCES[@]}"; do
  sync_one "$artifact" tables
done
for artifact in "${FIGURE_SOURCES[@]}"; do
  sync_one "$artifact" figures
done

if [[ "$MODE" == "check" ]]; then
  echo "paper artifacts match: $FREEZE_ROOT"
else
  echo "paper artifacts synced from: $FREEZE_ROOT"
fi
