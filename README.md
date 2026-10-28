# Recourse

Prototype for *Bonded Recourse for Smart-Contract Settlement of Compensable Agent Side Effects* (BCCA 2026).

This repository contains the prototype, evaluation harness, frozen paper evidence, and reproduction workflow. The paper source is maintained in a separate checkout and is synchronized from the checksummed bundle under `prototype/reproducibility/paper-v1/`.

## Current Status

Implemented and audited:

- Canonical schemas plus TypeScript/Solidity EIP-712 and κ-ID parity.
- A Foundry contract core with tested registry, collateral, receipt-commitment, deadline, optimistic, arbitration-interface, and payout state transitions.
- TypeScript receipt, adapter, compensator, and evidence-store packages.
- A pure Python eligibility/settleability classifier that fails closed on missing verified observations.
- Deterministic synthetic RQ drivers, independent-seed confidence intervals, local Postgres/Git/LocalStack integration runs, generated contract/fuzz evidence, and a checksummed paper bundle.
- Exact toolchain and container pins, dependency audits, claim-to-artifact validation, and a one-command reproduction gate.

Important limits:

- The provider-compatible runs use local Docker Postgres, a local bare Git repository, and LocalStack. They are not managed-provider or L0/L1 evidence.
- The on-chain v1 stores evidence hashes and enforces capped claimant requests; receipt authentication and payout computation occur in the runtime.
- The Base Sepolia deployment is live and bytecode-verified to match current source; its arbitrator is a mock because Kleros has no Base Sepolia deployment. It is a public-testnet deployment, not an audited production deployment.

## Repository Layout

| Path | Status | Purpose |
| --- | --- | --- |
| `prototype/contracts/` | Implemented local core | Foundry project for registry, vault, claims, optimistic path, arbitrable path, mocks, and E2E tests. |
| `prototype/runtime-ts/` | Implemented local runtime | Bun workspace for receipts, evidence, adapters, compensators, signing, and verification. |
| `prototype/classifier/` | Implemented local predicates | uv project with eligibility, settleability, routing, schema validation, and parity tests. |
| `prototype/harness/` | Implemented synthetic harness | uv project with traces, faults, metrics, baselines, deterministic RQ drivers, and tests. |
| `prototype/schemas/` | Implemented v1 | Canonical JSON schemas and fixtures shared by Solidity, TypeScript, and Python. |
| `prototype/fixtures/` | Implemented | Deterministic workload and κ-contract fixtures. |
| `prototype/deployments/` | Implemented | Current ABI snapshots and a bytecode-verified, live Base Sepolia record. |
| `prototype/reproducibility/` | Implemented | Paper claim manifest and checksummed frozen evidence. |
| `docs/` | Implemented | Architecture, development, deployment, and reproduction instructions. |

## Quickstart

```sh
git submodule update --init --recursive
make -C prototype setup
make -C prototype audit
make -C prototype test-all
```

`test-all` runs formatting, schema/ABI checks, static type checks, tests, invariants, and enforced coverage thresholds. `audit` checks the locked Bun and Python dependency graphs. For the full paper workflow, use `prototype/scripts/reproduce.sh`; it also runs service-backed integration tests, all RQs, independent-seed CIs, local provider sandboxes, contract/fuzz evidence generation, and artifact validation.

## Documentation

- `prototype/README.md`: local setup and command reference.
- `docs/architecture.md`: architecture, data flow, and file-to-paper map.
- `docs/development.md`: local workflow, gates, coverage, and known gate limits.
- `docs/deployment.md`: deployment status and Base Sepolia limitations.
- `docs/reproducibility.md`: clean-checkout reproduction, frozen evidence, paper synchronization, and validation.

## Contributing

Use the repo toolchain and run `make -C prototype test-all` before opening a pull request. Changes to schemas, receipt hashing, or contract IDs must update `prototype/SCHEMA_VERSIONS.md`, TypeScript typed data, Solidity typehashes, and parity fixtures together.

## Citation

If you use this code or data, please cite our paper:

```bibtex
@inproceedings{bindschaedler2026recourse,
  title     = {Bonded Recourse for Smart-Contract Settlement of Compensable Agent Side Effects},
  author    = {Bindschaedler, Laurent and Botha, Quentin and Siebenbrunner, Christoph},
  booktitle = {Proceedings of the IEEE International Conference on Blockchain Computing and Applications (BCCA)},
  year      = {2026}
}
```

## License

Released under the [MIT License](LICENSE).

## Source Index

| Area | Entry points |
| --- | --- |
| Contract core | `prototype/contracts/src/RecourseRegistry.sol`, `BondVault.sol`, `ClaimRegistry.sol`, `OptimisticPath.sol`, `ArbitrablePath.sol`, `Types.sol`, `Eip712Recourse.sol` |
| Contract tests | `prototype/contracts/test/*.t.sol`, `prototype/contracts/test/mocks/*.sol` |
| Deployment | `prototype/contracts/script/DeployBaseSepolia.s.sol`, `prototype/scripts/export-abi.sh`, `prototype/deployments/base-sepolia/` |
| TypeScript runtime | `prototype/runtime-ts/packages/receipts`, `adapter-sdk`, `evidence-store`, `adapter-postgres`, `adapter-git`, `adapter-cloud`, `compensator-sdk`, `compensators/*` |
| Python classifier | `prototype/classifier/src/recourse_classifier`, `prototype/classifier/tests` |
| Python harness | `prototype/harness/src/recourse_harness`, `prototype/harness/tests` |
| Operations | `prototype/Makefile`, `prototype/scripts/bootstrap.sh`, `run-rq.sh`, `snapshot-results.sh`, `check-coverage-summary.py` |
