# Base Sepolia Deployment Artifacts

This directory holds the deployment artifact for the Base Sepolia target.

Current state:

- `abi/*.json` contains ABI snapshots exported from the current local contract source.
- `addresses.example.json` documents the expected shape of a pinned deployment record.
- `addresses.json` pins the current Base Sepolia deployment record.
- `receipts.json` is the normalized, machine-readable extraction of all eight
  Foundry broadcast receipts. Its totals are 7,876,242 execution gas and
  317,769 L1 gas; these are sums of per-transaction receipt fields, not
  cumulative estimates.

## Source status

The pinned deployment is current and **verified to match current source**.
A read-only verifier compares on-chain bytecode against the locally compiled
build artifacts by hash, without needing any private key, and confirms all
six deployed contracts match.

Run the read-only comparison against the pinned block:

```sh
cd prototype
python3 scripts/verify_base_sepolia.py
```

The verifier emits JSON and exits `0` for the expected
`current-source-match` classification, `2` for an
`obsolete-source-mismatch` (if a future redeploy is needed after a source
change), and `1` for an RPC/artifact error. It performs no transactions and
needs no key.

Run the deployment-tool regression tests with:

```sh
cd prototype
python3 -m unittest -v scripts/test_deployment_artifacts.py
```

To regenerate the normalized receipt artifact from a Foundry broadcast:

```sh
cd prototype
python3 scripts/deployment_receipts.py \
  contracts/broadcast/DeployBaseSepolia.s.sol/84532/run-latest.json \
  --output deployments/base-sepolia/receipts.json
```

The pinned record should include:

- chain id and network label;
- commit hash;
- deployer address;
- block number;
- contract addresses;
- bond asset address and decimals;
- UMA Optimistic Oracle V3 address;
- deployed `ArbitrablePath` wrapper address and ERC-792 arbitrator backend address;
- whether the arbitrator is real or mocked.

Current limitation: `addresses.json` uses live Base Sepolia USDC and UMA OOv3, but the ERC-792 backend is a deployed `MockArbitrator`. Do not describe it as a live Kleros-backed deployment.

For registered κ records, `disputeRoute.arbitrator` should point at the deployed
`ArbitrablePath` wrapper. The wrapper stores and calls the ERC-792 backend.

`ClaimRegistry.getReceiptRecord(contractId, jobId)` exposes the committed
effect-evidence hash, and submitted claims must bind to that same hash. The
raw evidence CID remains in the off-chain evidence store; it cannot be made
discoverable from a bytes32-only v1 claim without a schema/API change.
