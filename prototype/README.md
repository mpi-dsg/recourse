# Recourse Prototype

This directory contains the audited Recourse implementation and evaluation artifact. It builds the contract core, runtime SDK, classifier, deterministic harness, local provider-compatible integrations, contract/fuzz evidence, and the checksummed assets used by the paper.

## Prerequisites

Required versions:

- Foundry `forge` 1.3.5.
- Bun 1.3.5.
- uv 0.11.28.
- Python 3.12, resolved through the uv locks.
- Docker with Compose v2 for integration and provider-sandbox reproduction.

The digest-pinned `Dockerfile` supplies the exact CLI versions. Mount the Docker socket when running the full reproduction inside that image.

## Setup

```sh
git submodule update --init --recursive
make setup
```

This runs `scripts/bootstrap.sh`, which checks for `forge`, `bun`, and `uv`; installs Solidity dependencies; runs `bun install`; and syncs the classifier and harness uv environments.

After setup, the release gate is:

```sh
make test-all
```

Run this before any handoff that claims the prototype is green. It is intentionally broader than `make test`: it checks formatting, JSON schemas, shell scripts, ABI freshness, Solidity/TypeScript/Python type checks, all tests, and coverage thresholds.

## Commands

| Target | What it runs |
| --- | --- |
| `make test` | All Foundry suites, all Bun runtime tests, classifier and harness pytest, and script regression tests. |
| `make lint` | Solidity format checks, JSON-schema parse checks, shell/Python script checks, ABI freshness checks, and Python Ruff checks. |
| `make typecheck` | `forge build`, full Bun workspace typecheck, and Python mypy checks. |
| `make coverage` | Foundry coverage, Bun coverage, and pytest coverage with enforced 80% minimums, including Solidity branch coverage. The Solidity coverage target excludes invariant contracts from coverage instrumentation; `make test` still runs them. |
| `make test-all` | Full current gate: lint, typecheck, test, and coverage. |
| `make audit` | Audits all locked Bun and Python dependencies. |
| `make test-integration` | Runs the runtime suite against Docker Postgres and LocalStack, then tears the stack down. |
| `make test-providers` | Generates fresh functional observations from local Postgres, Git, and LocalStack sandboxes. |
| `make validate-paper-claims` | Checks the paper inventory and every generated table/figure against the claim manifest. |
| `make abi` | Exports ABI snapshots for the public contract deployment surface. |
| `make local-test-results` | Runs isolated Foundry E2E gas reports, Foundry fuzz/invariant tests, and Hypothesis properties; writes raw logs, JSON metrics, and LaTeX summaries below `results/`. |
| `make rq1`, `make rq2`, `make rq2-reasons`, `make rq3`, `make rq4`, `make rq5`, `make rq5-adv`, `make rq8`, `make rq9`, `make rq10` | Runs one configured deterministic synthetic harness driver into `results/<rq>/`. |
| `make rq-all` | Runs all configured deterministic synthetic RQ drivers into `results/<rq>/`. |
| `make artifact` | Packages the complete source state and current results with checksums. Refuses a dirty tree unless diagnostic mode is explicit. |
| `make clean` | Removes Foundry output/cache, TS build/dependency artifacts, Python caches, and coverage outputs. |

Set `RECOURSE_RESULTS_ROOT=/absolute/fresh/path` when `make local-test-results`
must write outside the default `prototype/results/` tree. The local gas artifact
is explicitly Foundry gas-report call-gas, not RPC transaction-receipt gas.

The gate covers the implemented local prototype. It does not claim managed-provider provenance or production deployment readiness.

## Test and Coverage Surface

Current tests cover:

- Solidity type construction, EIP-712 parity, registry admission/revocation, bond custody, claim routing/finalization, optimistic settlement, arbitration, and a local E2E payout path.
- TypeScript schema round-trips, receipt digest parity, registry contract-id derivation, signing, verification, evidence storage, adapter lifecycle, memory workload adapters, and compensators. Adapters must provide `recordToChain`; tests reject silent zero-hash commits.
- Python schema validation, cross-language schema parity, eligibility, settleability, routing, deterministic traces, observed fault injection, metrics, baselines, and RQ drivers. RQ5 keeps pre-registered expected routes only as metric labels; the Recourse decision path recomputes routes from classifier inputs.

The gate enforces at least 80% Solidity line, statement, and branch coverage; at least 80% TypeScript line coverage; and at least 80% coverage for both Python projects. Stateful Solidity invariants run in the test target and are excluded only from coverage instrumentation.

## Deployment Status

`contracts/script/DeployBaseSepolia.s.sol` deploys the current core, `scripts/deploy-base-sepolia.sh` is the deployment helper, and `make abi` exports current ABI snapshots. The pinned Base Sepolia addresses are live: their bytecode is independently verified to match current source, and the arbitrator is a mock because Kleros has no Base Sepolia deployment. See `../docs/deployment.md`.

## Reproducibility Status

`scripts/reproduce.sh` is the clean-output entry point. `reproducibility/paper-v1/` freezes the exact aggregate metrics, provider observations, contract/fuzz evidence, and generated assets used by the paper. `scripts/sync-paper-artifacts.sh` verifies checksums before copying them to a paper checkout. See `../docs/reproducibility.md`.
