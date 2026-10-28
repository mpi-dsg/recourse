# Fixtures

Reproducible workload state for the integration harness. Each fixture is
deterministic so `seed_hash` lines in RQ manifests stay stable across reruns.

| Workload | File | Loaded by |
| --- | --- | --- |
| Postgres | `postgres/seed.sql` | `make integration-up` and `scripts/integration-up.sh` use docker-compose; this file is read on-demand by integration tests / `reproduce.sh`. |
| Git | `git/seed.sh` | Bash script that creates a deterministic bare repo at `$RECOURSE_GIT_BARE`. Run as `bash fixtures/git/seed.sh`. |
| Cloud | `cloud/seed.json` | JSON manifest of SSM Parameter Store entries. Loaded by `LocalStackSsmCloudClient.seed()` in tests and `reproduce.sh`. |
| κ contracts | `k-contracts/*.json` | Curated recourse-contract catalogue validated by `scripts/validate-k-contracts.py` and registered by `scripts/run-k-contracts.sh`. |

Fixture identifiers are content-addressed (`seed_hash`); the harness manifest
records both the file path and its SHA-256.
