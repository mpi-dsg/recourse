# Deployment

The repository contains deployment tooling for the current source and a live Base Sepolia record whose bytecode is independently verified to match current source.

## Current State

- `prototype/deployments/base-sepolia/` contains ABI snapshots, docs, an address-record template, and `addresses.json`.
- `addresses.json` pins chain id, block number, contract addresses, external backends, and the current deployment's `current-source-match` classification.
- `receipts.json` derives all eight transaction receipts and the 7.88M execution-gas total (plus 318k L1 data gas) from the Foundry broadcast artifact.
- `prototype/contracts/script/DeployBaseSepolia.s.sol` deploys the contract core.
- `prototype/scripts/deploy-base-sepolia.sh` simulates, broadcasts, and optionally pins a sanitized address record.
- `make -C prototype abi` exports ABI snapshots under `prototype/deployments/base-sepolia/abi/`.
- `verify_base_sepolia.py` compares pinned bytecode with current build artifacts and checks the live UMA default-identifier configuration without sending a transaction.

## Target Stack

The Base Sepolia stack is:

- `RecourseRegistry`
- `BondVault`
- `ClaimRegistry`
- `OptimisticPath` against UMA Optimistic Oracle V3
- `ArbitrablePath` against a deployed `MockArbitrator`

The current source compiles and passes local unit, fuzz, invariant, and end-to-end tests against deterministic mocks.

## Deployment Limits

Do not describe the pinned addresses as a production deployment:

- it is a public testnet deployment, not an audited production deployment;
- its arbitrator is a publicly controllable mock, not Kleros or another live dispute-resolution service, because Kleros has no Base Sepolia deployment;
- it validates correctness and gas cost, not mainnet adversarial pressure, real collateral economics, or contested-dispute volume.

The expected verifier result is exit code `0`, meaning `current-source-match`:

```sh
cd prototype
python3 scripts/verify_base_sepolia.py
```

## Secrets

Do not commit RPC URLs, deployer private keys, API keys, or funded account material. Deployment commands should read secrets from environment variables.

## Command

The deployment helper reads secrets from the environment, passes only the RPC URL to Foundry, and writes only `BASE_SEPOLIA_RPC_LABEL` into `addresses.json`:

```sh
cd prototype
PRIVATE_KEY="$PRIVATE_KEY" \
BASE_SEPOLIA_RPC_URL="$BASE_SEPOLIA_RPC_URL" \
BASE_SEPOLIA_RPC_LABEL="base-sepolia" \
RECOURSE_PIN_ADDRESSES=1 \
./scripts/deploy-base-sepolia.sh
```

Required environment:

- `PRIVATE_KEY`: deployer key consumed by Foundry.
- `BASE_SEPOLIA_RPC_URL`: RPC endpoint passed to Foundry. Do not commit it.
- `BASE_SEPOLIA_RPC_LABEL`: non-secret label stored in deployment metadata.
- `RECOURSE_PIN_ADDRESSES=1`: overwrite `prototype/deployments/base-sepolia/addresses.json` after broadcast.

Optional environment:

- `RECOURSE_BOND_ASSET`: ERC-20 collateral address, defaults to Base Sepolia test USDC.
- `UMA_OO_BASE_SEPOLIA`: UMA Optimistic Oracle V3 address, defaults to the live Base Sepolia address.
- `ERC792_ARBITRATOR_BASE_SEPOLIA`: ERC-792-compatible backend. If unset, the script deploys `MockArbitrator`.

For κ records that should use the wrapper, set `disputeRoute.arbitrator` to the deployed `ArbitrablePath` address. The wrapper itself stores the backend arbitrator address.
