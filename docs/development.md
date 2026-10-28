# Development

This guide documents the local commands that are valid for the current implementation. The gate covers the implemented local prototype: contracts, runtime packages, classifier predicates, and deterministic harness.

## Setup

From the repository root:

```sh
make -C prototype setup
```

The setup script checks required CLIs, installs Foundry dependencies, installs Bun dependencies, and syncs the Python uv projects.

## Gate Commands

Run the normal test suite:

```sh
make -C prototype test
```

Run the full current repository gate:

```sh
make -C prototype test-all
```

`test-all` runs:

- `make lint`
- `make typecheck`
- `make test`
- `make coverage`

## Target Details

| Target | Scope | Notes |
| --- | --- | --- |
| `lint` | Solidity formatting, JSON schemas, scripts, ABI snapshots, and Python files | Uses `forge fmt --check`, `python3 -m json.tool`, `bash -n`, Python bytecode compilation, `forge inspect` ABI diffs, and `uv run --extra dev ruff check`. |
| `typecheck-contracts` | Solidity | Runs `forge build`. |
| `typecheck-ts` | TypeScript runtime workspace | Runs `bun run typecheck` across all workspace packages. |
| `typecheck-py` | Python classifier and harness | Runs mypy with missing third-party imports ignored. |
| `coverage-contracts` | Solidity | Runs `forge coverage --ir-minimum --exclude-tests --no-match-contract ".*Invariant.*" --no-match-coverage "script/.*"` and enforces 80% line, statement, and branch minimums on the production contract core. Invariants still run under `test-contracts`; they are excluded from coverage to keep the gate bounded. Foundry may emit coverage-analysis warnings while still returning success. |
| `coverage-ts` | TypeScript runtime workspace | Runs `bun test --coverage` and enforces 80% line minimum. |
| `coverage-py` | Python classifier and harness | Runs pytest coverage with term-missing reports and `PY_COVERAGE_MIN` fail-under, default 80. |
| `abi` | Deployment artifacts | Exports ABI snapshots for the public contract surface. |
| `audit` | Locked dependencies | Runs Bun audit and pinned pip-audit against both uv lock exports. |
| `test-integration` | Local services | Runs the runtime suite against Docker Postgres and LocalStack and always tears them down. |
| `test-providers` | Local workload sandboxes | Generates 20-cell Postgres, Git, and cloud observations under a fresh results root. |
| `validate-paper-claims` | Paper provenance | Checks the full generated-asset inventory and frozen evidence parity. |
| `artifact` | Reproducibility | Builds an ignored tarball with docs, schemas, deployments, and current results. |
| `rq-all` | Synthetic evaluation | Runs all configured deterministic RQ driver outputs under `prototype/results/<rq>/`. |

## Gate Limits

The gate enforces 80% minimum Solidity line, statement, and branch coverage; 80% TypeScript line coverage; and 80% coverage for both Python projects. Invariant tests run under `test-contracts` but are excluded from coverage instrumentation to keep the coverage pass bounded.

The RQ drivers are deterministic synthetic models. The service-backed tests and benchmarks exercise local provider-compatible environments only. Neither surface is a substitute for managed-provider provenance or production traffic.

## Task Workflow

1. Write a failing test for the change.
2. Implement the minimum code needed to pass.
3. Run the narrow suite, then `make -C prototype test-all`.
4. Commit with a Conventional Commits prefix.

Before changing receipt or κ schemas, update `prototype/SCHEMA_VERSIONS.md`, TypeScript typed data/contract-id hashing, Solidity typehashes, and the EIP-712 fixture together.
