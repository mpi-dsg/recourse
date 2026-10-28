#!/usr/bin/env bash
# Run the three local provider-compatible adapter/compensator benchmarks.
set -euo pipefail

PROTOTYPE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULTS_ROOT="${RECOURSE_RESULTS_ROOT:-$PROTOTYPE_DIR/results}"
PG_PORT="${RECOURSE_PG_PORT:-55432}"
LOCALSTACK_PORT="${RECOURSE_LOCALSTACK_PORT:-54566}"
PG_URL="${RECOURSE_PG_URL:-postgresql://recourse:recourse@localhost:${PG_PORT}/recourse_test}"
LOCALSTACK_URL="${RECOURSE_LOCALSTACK_URL:-http://localhost:${LOCALSTACK_PORT}}"
MANAGE_STACK="${RECOURSE_PROVIDER_MANAGE_STACK:-1}"

case "$RESULTS_ROOT" in
  /*) ;;
  *) RESULTS_ROOT="$PROTOTYPE_DIR/$RESULTS_ROOT" ;;
esac

for provider in postgres git cloud; do
  target="$RESULTS_ROOT/rq-provider-$provider"
  if [[ -e "$target" ]]; then
    echo "refusing non-empty or pre-existing provider output: $target" >&2
    exit 1
  fi
done
if [[ ! -f "$RESULTS_ROOT/rq1/metrics.parquet" ]]; then
  echo "provider emitters require a fresh RQ1 schema at $RESULTS_ROOT/rq1/metrics.parquet" >&2
  exit 1
fi

cleanup() {
  local status=$?
  if [[ "$MANAGE_STACK" == "1" ]]; then
    "$PROTOTYPE_DIR/scripts/integration-down.sh" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

if [[ "$MANAGE_STACK" == "1" ]]; then
  RECOURSE_PG_PORT="$PG_PORT" \
    RECOURSE_LOCALSTACK_PORT="$LOCALSTACK_PORT" \
    "$PROTOTYPE_DIR/scripts/integration-up.sh"
fi

mkdir -p \
  "$RESULTS_ROOT/rq-provider-postgres" \
  "$RESULTS_ROOT/rq-provider-git" \
  "$RESULTS_ROOT/rq-provider-cloud"

echo "[providers] Postgres local sandbox"
RECOURSE_PG_URL="$PG_URL" \
  RECOURSE_BENCH_OUT="$RESULTS_ROOT/rq-provider-postgres/cells.json" \
  bun run "$PROTOTYPE_DIR/runtime-ts/packages/adapter-postgres/bench/provider-postgres.ts"
(
  cd "$PROTOTYPE_DIR/harness"
  RECOURSE_RESULTS_ROOT="$RESULTS_ROOT" \
    uv run python ../scripts/provider-postgres-emit.py
)

echo "[providers] local bare Git repository"
bun run "$PROTOTYPE_DIR/scripts/provider-bench-git.ts" \
  "$RESULTS_ROOT/rq-provider-git/cells.json"
(
  cd "$PROTOTYPE_DIR/harness"
  uv run python ../scripts/provider-bench-git-to-parquet.py \
    "$RESULTS_ROOT/rq-provider-git/cells.json" \
    "$RESULTS_ROOT/rq-provider-git"
)

echo "[providers] LocalStack SSM"
RECOURSE_LOCALSTACK_URL="$LOCALSTACK_URL" \
  bun run "$PROTOTYPE_DIR/scripts/provider-bench-cloud.ts" \
  "$RESULTS_ROOT/rq-provider-cloud/cells.json"
(
  cd "$PROTOTYPE_DIR/harness"
  RECOURSE_RESULTS_ROOT="$RESULTS_ROOT" \
    uv run python ../scripts/provider-bench-cloud-to-parquet.py
)

echo "provider benchmark artifacts: $RESULTS_ROOT"
