#!/usr/bin/env bash
# Orchestrate the κ-contract catalogue registration end to end.
#
#   1. Validate every fixture under fixtures/k-contracts/ against the v1 JSON
#      schema (fail loud).
#   2. Start a fresh Anvil instance.
#   3. Run RegisterFixtures.s.sol --broadcast.
#   4. Tear down Anvil.
#
# The script writes:
#   - results/k-contracts/registration.json
#   - results/k-contracts/table_k_catalogue.tex
#   - results/k-contracts/snippet.tex
# and re-syncs the catalogue table into the paper repo if it is present.

set -euo pipefail

PROTOTYPE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
CONTRACTS_DIR="${PROTOTYPE_DIR}/contracts"
RESULTS_ROOT="${RECOURSE_RESULTS_ROOT:-${PROTOTYPE_DIR}/results}"
case "${RESULTS_ROOT}" in
    /*) ;;
    *) RESULTS_ROOT="${PROTOTYPE_DIR}/${RESULTS_ROOT}" ;;
esac
RESULTS_DIR="${RESULTS_ROOT}/k-contracts"
STAGING_DIR="${PROTOTYPE_DIR}/results/.k-contracts-staging"
PAPER_TABLES_DIR="${PAPER_TABLES_DIR:-}"

# Foundry's canonical Anvil account 0 — never a real key.
TEST_PRIVATE_KEY=${PRIVATE_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}
ANVIL_PORT=${ANVIL_PORT:-8545}
ANVIL_RPC="http://127.0.0.1:${ANVIL_PORT}"

cleanup() {
    if [[ -n "${ANVIL_PID:-}" ]] && kill -0 "${ANVIL_PID}" 2>/dev/null; then
        kill "${ANVIL_PID}" 2>/dev/null || true
        wait "${ANVIL_PID}" 2>/dev/null || true
    fi
    if [[ -d "${STAGING_DIR}" ]]; then
        if command -v trash >/dev/null 2>&1; then
            trash "${STAGING_DIR}"
        else
            rm -rf -- "${STAGING_DIR}"
        fi
    fi
}
trap cleanup EXIT

if [[ -e "${STAGING_DIR}" ]]; then
    echo "refusing pre-existing κ staging directory: ${STAGING_DIR}" >&2
    exit 1
fi
mkdir -p "${RESULTS_DIR}" "${STAGING_DIR}"

echo "[1/4] Validating κ-contract fixtures..."
"${PROTOTYPE_DIR}/scripts/validate-k-contracts.py"

echo "[2/4] Starting fresh Anvil on port ${ANVIL_PORT}..."
if curl -fsS -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    "${ANVIL_RPC}" > /dev/null 2>&1; then
    echo "Port ${ANVIL_PORT} already has a JSON-RPC service. Stop it or set ANVIL_PORT." >&2
    exit 1
fi
anvil --port "${ANVIL_PORT}" --silent > "${RESULTS_DIR}/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in {1..30}; do
    if curl -fsS -X POST -H 'content-type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
        "${ANVIL_RPC}" > /dev/null 2>&1; then
        break
    fi
    sleep 0.1
done

echo "[3/4] Running RegisterFixtures.s.sol against ${ANVIL_RPC}..."
(
    cd "${CONTRACTS_DIR}"
    PRIVATE_KEY="${TEST_PRIVATE_KEY}" \
        RECOURSE_K_RESULTS_DIR="../results/.k-contracts-staging" \
        forge script script/RegisterFixtures.s.sol \
        --rpc-url "${ANVIL_RPC}" --broadcast --slow
)

# Pretty-print the registration JSON
python3 -c "
import json, sys
p='${STAGING_DIR}/registration.json'
d=json.load(open(p))
open(p,'w').write(json.dumps(d, indent=2)+'\n')
"

cp \
    "${STAGING_DIR}/registration.json" \
    "${STAGING_DIR}/table_k_catalogue.tex" \
    "${STAGING_DIR}/snippet.tex" \
    "${RESULTS_DIR}/"

if [[ -n "${PAPER_TABLES_DIR}" && -d "${PAPER_TABLES_DIR}" ]]; then
    cp "${RESULTS_DIR}/table_k_catalogue.tex" "${PAPER_TABLES_DIR}/table_k_catalogue.tex"
    echo "[4/4] Synced table_k_catalogue.tex → ${PAPER_TABLES_DIR}/"
elif [[ -n "${PAPER_TABLES_DIR}" ]]; then
    echo "[4/4] Paper tables dir not found at ${PAPER_TABLES_DIR}; skipping sync"
else
    echo "[4/4] PAPER_TABLES_DIR not set; skipping paper sync"
fi

echo "Done. See ${RESULTS_DIR}/{registration.json,table_k_catalogue.tex,snippet.tex}."
