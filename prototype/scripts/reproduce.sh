#!/usr/bin/env bash
# Reproduce and validate every result used by the Recourse paper.
set -euo pipefail

PROTOTYPE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
FROZEN_DIR="${RECOURSE_FROZEN_ARTIFACTS_DIR:-$PROTOTYPE_DIR/reproducibility/paper-v1}"
PAPER_DIR="${RECOURSE_PAPER_DIR:-}"
unset RECOURSE_PAPER_DIR
PG_PORT="${RECOURSE_PG_PORT:-55432}"
LOCALSTACK_PORT="${RECOURSE_LOCALSTACK_PORT:-54566}"
ANVIL_PORT="${RECOURSE_ANVIL_PORT:-${ANVIL_PORT:-8545}}"

if [[ -n "${RECOURSE_RESULTS_ROOT:-}" ]]; then
  case "$RECOURSE_RESULTS_ROOT" in
    /*) RESULTS_ROOT="$RECOURSE_RESULTS_ROOT" ;;
    *) RESULTS_ROOT="$PROTOTYPE_DIR/$RECOURSE_RESULTS_ROOT" ;;
  esac
  if [[ -e "$RESULTS_ROOT" ]]; then
    echo "refusing pre-existing reproduction output: $RESULTS_ROOT" >&2
    echo "choose a fresh RECOURSE_RESULTS_ROOT" >&2
    exit 1
  fi
  mkdir -p "$RESULTS_ROOT"
else
  RESULTS_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/recourse-reproduction.XXXXXX")"
fi

cleanup() {
  local status=$?
  RECOURSE_PG_PORT="$PG_PORT" \
    RECOURSE_LOCALSTACK_PORT="$LOCALSTACK_PORT" \
    "$PROTOTYPE_DIR/scripts/integration-down.sh" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT INT TERM

cd "$PROTOTYPE_DIR"

echo "[reproduce] output: $RESULTS_ROOT"
echo "[reproduce] 1/13 bootstrap pinned toolchains"
./scripts/bootstrap.sh

echo "[reproduce] 2/13 dependency audit"
make audit

echo "[reproduce] 3/13 lint, typecheck, tests, invariants, and coverage"
make test-all

echo "[reproduce] 4/13 service-backed integration tests"
make test-integration \
  RECOURSE_PG_PORT="$PG_PORT" \
  RECOURSE_LOCALSTACK_PORT="$LOCALSTACK_PORT"

echo "[reproduce] 5/13 deterministic synthetic RQs"
RECOURSE_RESULTS_ROOT="$RESULTS_ROOT" ./scripts/run-rq.sh all

echo "[reproduce] 6/13 independent-seed confidence intervals"
RECOURSE_RESULTS_ROOT="$RESULTS_ROOT" ./scripts/run-rq-ci.sh

echo "[reproduce] 7/13 synthetic tables and diagnostic plots"
RECOURSE_RESULTS_ROOT="$RESULTS_ROOT" ./scripts/build-artifacts.sh

echo "[reproduce] 8/13 local provider-compatible sandboxes"
RECOURSE_RESULTS_ROOT="$RESULTS_ROOT" \
  RECOURSE_PG_PORT="$PG_PORT" \
  RECOURSE_LOCALSTACK_PORT="$LOCALSTACK_PORT" \
  ./scripts/run-provider-benchmarks.sh

echo "[reproduce] 9/13 kappa-catalogue registration"
RECOURSE_RESULTS_ROOT="$RESULTS_ROOT" \
  ANVIL_PORT="$ANVIL_PORT" \
  ./scripts/run-k-contracts.sh

echo "[reproduce] 10/13 isolated contract gas and property evidence"
RECOURSE_RESULTS_ROOT="$RESULTS_ROOT" make local-test-results

echo "[reproduce] 11/13 architecture figure"
./scripts/render-architecture-figure.sh "$RESULTS_ROOT/figure_architecture.png"

echo "[reproduce] 12/13 compare fresh outputs with frozen paper evidence"
(
  cd harness
  uv run python ../scripts/validate-reproduced-results.py \
    --results "$RESULTS_ROOT" \
    --frozen "$FROZEN_DIR"
)

echo "[reproduce] 13/13 optional paper synchronization and compilation"
if [[ -n "$PAPER_DIR" ]]; then
  RECOURSE_PAPER_DIR="$PAPER_DIR" ./scripts/sync-paper-artifacts.sh sync
  make validate-paper-claims RECOURSE_PAPER_DIR="$PAPER_DIR"
  make -C "$PAPER_DIR" check
else
  echo "[reproduce] RECOURSE_PAPER_DIR is unset; paper sync/check skipped"
fi

echo "[reproduce] OK"
echo "[reproduce] fresh results retained at: $RESULTS_ROOT"
