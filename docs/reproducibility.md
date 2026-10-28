# Reproducibility

The repository supports two distinct operations:

1. Rebuild the paper exactly from the checksummed observations that were used to write it.
2. Re-run the implementation on a clean output directory and compare every deterministic or stable functional metric with those frozen observations.

Keeping those operations separate is important. Synthetic traces, confidence intervals, contract gas, and functional provider outcomes are deterministic under the pinned environment. Wall-clock provider latency is an observed measurement and will vary across machines. Raw timing observations remain in the provider artifacts for profiling, but the paper-facing tables exclude them so every numerical result printed in the paper can be reproduced exactly.

## Pinned environment

The audited toolchain is:

- Foundry 1.3.5;
- Bun 1.3.5;
- uv 0.11.28;
- Python 3.12 from the uv lock;
- digest-pinned Ubuntu 24.04, Postgres 16, and LocalStack 4.0 images.

JavaScript and Python transitive dependencies are locked. `make audit` checks the lock graphs for published vulnerabilities. `scripts/bootstrap.sh` rejects different Forge, Bun, or uv versions instead of silently changing the environment.

From a source checkout:

```sh
git submodule update --init --recursive
make -C prototype setup
make -C prototype audit
make -C prototype test-all
```

The container build is pinned by digest:

```sh
cd prototype
docker build -t recourse:repro .
docker run --rm \
  -v "$PWD":/work \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -w /work \
  recourse:repro ./scripts/reproduce.sh
```

The Docker socket is required because the reproduction creates isolated Postgres and LocalStack services.

## Full clean-output reproduction

Run:

```sh
cd prototype
./scripts/reproduce.sh
```

The script refuses a pre-existing output directory. It then:

1. verifies the pinned toolchains and locked dependencies;
2. runs lint, schema/ABI checks, type checks, unit tests, fuzz tests, invariants, and coverage thresholds;
3. runs Docker-backed integration tests;
4. generates all single-seed synthetic RQs;
5. generates 10 independent-seed confidence intervals;
6. executes the local Postgres, bare-Git, and LocalStack benchmarks;
7. generates κ-registration, E2E gas, fuzz, table, plot, and architecture artifacts;
8. compares every paper-facing table and every stable provider outcome with the frozen paper evidence;
9. optionally synchronizes and compiles a paper checkout.

Configuration:

```sh
RECOURSE_RESULTS_ROOT=/absolute/fresh/output \
RECOURSE_PG_PORT=55434 \
RECOURSE_LOCALSTACK_PORT=54567 \
RECOURSE_ANVIL_PORT=58545 \
RECOURSE_PAPER_DIR=/absolute/paper/checkout \
./scripts/reproduce.sh
```

Choose unused ports when another local project is running the default services.

### Local contract gas and property-test evidence

The focused source-controlled command is:

```sh
RECOURSE_RESULTS_ROOT=/absolute/fresh/output \
  make -C prototype local-test-results
```

It retains raw Foundry and pytest logs and writes machine-readable JSON plus
LaTeX summaries under `anvil-e2e/` and `fuzzing/`. The E2E gas rows are median
call-gas from isolated tests on Foundry's in-process EVM. Despite the legacy
`anvil-e2e/` name, this command does not submit Anvil JSON-RPC transactions:
the values are not external transaction-receipt gas and exclude deployments,
test-harness execution, token preparation, and view calls. Each path total is
only the sum of its listed operation calls.

The fuzz summary keeps Hypothesis examples, Foundry stateless fuzz runs, and
Foundry stateful invariant calls as separate statistical units. Pinned seeds
and explicit Foundry run/depth settings make repeated summaries deterministic;
the unlike units are never added into one execution count.

## Exact paper assets

`prototype/reproducibility/paper-v1/` is the source-controlled evidence bundle. It includes:

- aggregate Parquet metrics and manifests for every synthetic RQ;
- one-sample-per-seed CI metrics for seeds 42--51;
- raw local-provider cell records, aggregate metrics, and manifests;
- κ registration, E2E gas, and fuzz summaries;
- generated LaTeX tables and plots;
- the architecture PNG;
- `provenance.json` and `CHECKSUMS.sha256`.

To reproduce the paper's generated files byte-for-byte:

```sh
cd prototype
RECOURSE_PAPER_DIR=/absolute/paper/checkout \
  ./scripts/sync-paper-artifacts.sh sync
```

To perform a read-only equality check:

```sh
RECOURSE_PAPER_DIR=/absolute/paper/checkout \
  ./scripts/sync-paper-artifacts.sh check

make validate-paper-claims \
  RECOURSE_PAPER_DIR=/absolute/paper/checkout
```

The claim manifest inventories every generated paper table and figure and maps each headline number or limitation to source, command, statistical unit, and frozen evidence.

Replacing the frozen evidence is deliberately explicit:

```sh
RECOURSE_RESULTS_ROOT=/absolute/audited/results \
RECOURSE_ARCHITECTURE_PNG=/absolute/audited/results/figure_architecture.png \
RECOURSE_REPLACE_FROZEN=1 \
./scripts/freeze-paper-artifacts.sh
```

Review the resulting checksum, provenance, paper, and claim-manifest diffs together.

## Statistical unit

Single-seed tables use base seed 42 and five deterministic derived trace seeds,
42 through 46, per configured cell. These five traces support descriptive
aggregation only; the paper does not treat them as independent inferential
samples.

Confidence intervals use base seeds 42 through 51 with one realized trace per base seed. Student-$t$ two-sided 95% intervals therefore use $n=10$ and 9 degrees of freedom. `scripts/run-rq-ci.sh` records the base-to-realized seed schedule and rejects pseudoreplicated output.

## Provider evidence boundary

The three provider-compatible benchmarks are:

- Docker Postgres 16;
- a local bare Git repository;
- LocalStack 4.0 SSM.

Their artifacts set `providerBacked=false` and `providerCompatibleSandbox=true`. The adapters sign EIP-712 receipts, but the frozen run does not establish a provider-controlled signature or authenticated public-state replay. These observations are L2 evidence and cannot support a managed-provider, L1, or L0 claim.

## Base Sepolia record

`deployments/base-sepolia/` retains the current broadcast and normalized receipts. The expected read-only verifier result is `current-source-match` (exit code 0): every deployed contract's on-chain bytecode matches the current build artifacts by hash, checked without any private key:

```sh
python3 scripts/verify_base_sepolia.py
```

No private key is required. A source change that alters any deployed contract's bytecode requires a fresh broadcast and a new verification artifact to keep this classification current.

## Snapshot hygiene

`make artifact` packages the complete source state, submodule revisions, frozen evidence, optional paper checkout, and current results with checksums. It refuses a dirty tree by default. Diagnostic snapshots are permitted only through the script's explicit dirty-mode option and record that state in their manifest.
