# Contributing

Thanks for improving Recourse. Keep changes small, tested, and tied to current source, schemas, and reproducibility claims.

## Setup

```sh
git submodule update --init --recursive
make -C prototype setup
```

## Validation

Before opening a pull request, run:

```sh
make -C prototype test-all
make -C prototype audit
```

For narrower changes, run the relevant target first:

- Contracts: `make -C prototype test-contracts`
- TypeScript runtime: `make -C prototype test-ts`
- Python classifier and harness: `make -C prototype test-py`
- Coverage gate: `make -C prototype coverage`

## Project Rules

- Do not commit secrets, private RPC URLs, private keys, ordinary generated `results/`, coverage output, local deployments, dependency directories, or local paper copies. The deliberately frozen evidence under `prototype/reproducibility/` is the exception.
- Schema changes are breaking. Update `prototype/SCHEMA_VERSIONS.md`, JSON schemas, TypeScript typed data, Solidity typehashes, fixtures, and parity tests together.
- Keep deterministic fixtures reproducible. If a fixture changes, document how to regenerate it.
- Keep provider-compatible local evidence clearly separated from managed-provider or L0/L1 provenance claims.
- Use Conventional Commits for commit messages.
