#!/usr/bin/env bash
# Deploy the Recourse contract core to Base Sepolia.
#
# Requires:
#   - PRIVATE_KEY            funded Base Sepolia deployer key (Hex32, with 0x).
#   - RECOURSE_PIN_ADDRESSES set to 1 to overwrite deployments/base-sepolia/addresses.json.
#
# Optional env overrides; defaults match real Circle USDC and real UMA OOv3:
#   - BASE_SEPOLIA_RPC_URL                RPC endpoint used by Foundry
#   - BASE_SEPOLIA_RPC_LABEL              safe label pinned to addresses.json
#   - RECOURSE_BOND_ASSET                ERC-20 collateral
#   - UMA_OO_BASE_SEPOLIA                UMA Optimistic Oracle V3
#   - ERC792_ARBITRATOR_BASE_SEPOLIA     real ERC-792 backend; if unset a
#                                        MockArbitrator is deployed in the
#                                        same broadcast (Kleros is not on
#                                        Base Sepolia as of May 2026).
#
# Idempotency: re-running this script broadcasts a fresh deployment with new
# addresses. Pin them by exporting RECOURSE_PIN_ADDRESSES=1.
set -euo pipefail

cd "$(dirname "$0")/.."

: "${PRIVATE_KEY:?PRIVATE_KEY must be exported (Base Sepolia deployer key)}"

RPC_URL="${BASE_SEPOLIA_RPC_URL:-https://sepolia.base.org}"
RPC_LABEL="${BASE_SEPOLIA_RPC_LABEL:-base-sepolia}"
BROADCAST_FILE="contracts/broadcast/DeployBaseSepolia.s.sol/84532/run-latest.json"
ADDR_OUT="deployments/base-sepolia/addresses.json"
RECEIPTS_OUT="deployments/base-sepolia/receipts.json"

mkdir -p "$(dirname "$ADDR_OUT")"

echo "[deploy] simulating..."
( cd contracts && forge script script/DeployBaseSepolia.s.sol:DeployBaseSepolia \
    --rpc-url "$RPC_URL" \
    --private-key "$PRIVATE_KEY" )

echo "[deploy] broadcasting..."
( cd contracts && forge script script/DeployBaseSepolia.s.sol:DeployBaseSepolia \
    --rpc-url "$RPC_URL" \
    --private-key "$PRIVATE_KEY" \
    --broadcast )

if [ ! -f "$BROADCAST_FILE" ]; then
  echo "[deploy] error: broadcast artifact not found at $BROADCAST_FILE" >&2
  exit 1
fi

if [ "${RECOURSE_PIN_ADDRESSES:-0}" = "1" ]; then
  echo "[deploy] writing pinned addresses to $ADDR_OUT"
  python3 - "$BROADCAST_FILE" "$ADDR_OUT" "$RPC_LABEL" <<'PY'
import json, os, sys
from pathlib import Path

broadcast_path = Path(sys.argv[1])
addr_out = Path(sys.argv[2])
rpc_label = sys.argv[3]

broadcast = json.loads(broadcast_path.read_text())
tx_block_number = None
contracts: dict[str, str] = {}
for tx in broadcast.get("transactions", []):
    name = tx.get("contractName")
    addr = tx.get("contractAddress")
    if not (name and addr):
        continue
    contracts[name] = addr

receipts = broadcast.get("receipts", [])
if receipts:
    tx_block_number = max(int(r.get("blockNumber", "0x0"), 16) for r in receipts)

addresses = {
    "schemaVersion": 1,
    "chainId": broadcast.get("chain", 84532),
    "rpcEndpointLabel": rpc_label,
    "deployedAt": broadcast.get("timestamp"),
    "blockNumber": tx_block_number,
    "commit": os.environ.get("RECOURSE_DEPLOY_COMMIT", ""),
    "contracts": contracts,
    "notes": "ERC792 arbitrator is a MockArbitrator deployed in the same broadcast because Kleros L2 is not deployed on Base Sepolia. UMA OOv3 and USDC are live.",
}
addr_out.write_text(json.dumps(addresses, indent=2, sort_keys=True) + "\n")
print(f"wrote {addr_out}")
PY
  echo "[deploy] extracting machine-readable receipts to $RECEIPTS_OUT"
  python3 scripts/deployment_receipts.py "$BROADCAST_FILE" --output "$RECEIPTS_OUT" >/dev/null
fi

echo "[deploy] done."
