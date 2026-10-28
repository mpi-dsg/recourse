#!/usr/bin/env python3
"""Generate local E2E call-gas and property-test summaries from raw output."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from typing import Mapping, Sequence

from local_test_results_lib import (
    DISPUTED_TEST,
    FOUNDRY_FUZZ_SEED,
    HAPPY_TEST,
    HYPOTHESIS_SEED,
    EvidenceError,
    render_from_logs,
)


PROTOTYPE_ROOT = Path(__file__).resolve().parents[1]
CONTRACTS_ROOT = PROTOTYPE_ROOT / "contracts"
HARNESS_ROOT = PROTOTYPE_ROOT / "harness"
FOUNDRY_FUZZ_RUNS = 256
FOUNDRY_INVARIANT_RUNS = 256
FOUNDRY_INVARIANT_DEPTH = 500

GAS_COMMANDS = {
    "happyPath": [
        "forge",
        "test",
        "--match-contract",
        "E2ETest",
        "--match-test",
        HAPPY_TEST,
        "--gas-report",
        "-vv",
    ],
    "disputedPath": [
        "forge",
        "test",
        "--match-contract",
        "E2ETest",
        "--match-test",
        DISPUTED_TEST,
        "--gas-report",
        "-vv",
    ],
}
FOUNDRY_FUZZ_COMMAND = [
    "forge",
    "test",
    "--match-contract",
    "^(RecourseFuzzTest|RecourseInvariantTest)$",
    "--fuzz-runs",
    str(FOUNDRY_FUZZ_RUNS),
    "--fuzz-seed",
    FOUNDRY_FUZZ_SEED,
    "-vv",
]
HYPOTHESIS_COMMAND = [
    "uv",
    "run",
    "pytest",
    "-q",
    "tests/test_classifier_properties.py",
    "--hypothesis-show-statistics",
    f"--hypothesis-seed={HYPOTHESIS_SEED}",
]


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--from-logs",
        action="store_true",
        help="render existing logs instead of executing Foundry and pytest",
    )
    parser.add_argument("--happy-gas-log", type=Path)
    parser.add_argument("--disputed-gas-log", type=Path)
    parser.add_argument("--foundry-fuzz-log", type=Path)
    parser.add_argument("--hypothesis-log", type=Path)
    return parser.parse_args()


def _results_root() -> Path:
    configured = os.environ.get("RECOURSE_RESULTS_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    return PROTOTYPE_ROOT / "results"


def _run_logged(
    command: Sequence[str],
    *,
    cwd: Path,
    destination: Path,
    extra_env: Mapping[str, str] | None = None,
) -> None:
    environment = os.environ.copy()
    if extra_env:
        environment.update(extra_env)
    completed = subprocess.run(
        command,
        cwd=cwd,
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(completed.stdout)
    if completed.returncode != 0:
        raise EvidenceError(
            f"command failed ({completed.returncode}): {' '.join(command)}; "
            f"see {destination}"
        )


def collect(results_root: Path) -> tuple[dict[str, object], dict[str, object]]:
    """Execute the pinned local tests, retain logs, and render their summaries."""
    gas_dir = results_root / "anvil-e2e"
    fuzz_dir = results_root / "fuzzing"
    happy_log = gas_dir / "happy_path_forge.log"
    disputed_log = gas_dir / "disputed_path_forge.log"
    foundry_log = fuzz_dir / "forge_run.log"
    hypothesis_log = fuzz_dir / "hypothesis_run.log"

    _run_logged(
        GAS_COMMANDS["happyPath"], cwd=CONTRACTS_ROOT, destination=happy_log
    )
    _run_logged(
        GAS_COMMANDS["disputedPath"], cwd=CONTRACTS_ROOT, destination=disputed_log
    )
    _run_logged(
        FOUNDRY_FUZZ_COMMAND,
        cwd=CONTRACTS_ROOT,
        destination=foundry_log,
        extra_env={
            "FOUNDRY_FUZZ_RUNS": str(FOUNDRY_FUZZ_RUNS),
            "FOUNDRY_INVARIANT_DEPTH": str(FOUNDRY_INVARIANT_DEPTH),
            "FOUNDRY_INVARIANT_RUNS": str(FOUNDRY_INVARIANT_RUNS),
        },
    )
    _run_logged(
        HYPOTHESIS_COMMAND, cwd=HARNESS_ROOT, destination=hypothesis_log
    )
    return render_from_logs(
        results_root=results_root,
        happy_log=happy_log,
        disputed_log=disputed_log,
        foundry_fuzz_log=foundry_log,
        hypothesis_log=hypothesis_log,
    )


def _provided_logs(arguments: argparse.Namespace) -> tuple[Path, Path, Path, Path]:
    provided = (
        arguments.happy_gas_log,
        arguments.disputed_gas_log,
        arguments.foundry_fuzz_log,
        arguments.hypothesis_log,
    )
    if any(path is None for path in provided):
        raise EvidenceError("--from-logs requires all four log arguments")
    happy, disputed, foundry, hypothesis = provided
    assert happy is not None
    assert disputed is not None
    assert foundry is not None
    assert hypothesis is not None
    return happy, disputed, foundry, hypothesis


def main() -> int:
    arguments = _arguments()
    results_root = _results_root()
    try:
        if arguments.from_logs:
            happy_log, disputed_log, foundry_log, hypothesis_log = _provided_logs(
                arguments
            )
            gas, fuzz = render_from_logs(
                results_root=results_root,
                happy_log=happy_log,
                disputed_log=disputed_log,
                foundry_fuzz_log=foundry_log,
                hypothesis_log=hypothesis_log,
            )
        else:
            gas, fuzz = collect(results_root)
    except (EvidenceError, OSError) as error:
        print(f"local-test-results: {error}", file=sys.stderr)
        return 1

    happy = gas["happyPath"]
    disputed = gas["disputedPath"]
    foundry = fuzz["foundry"]
    hypothesis = fuzz["hypothesis"]
    assert isinstance(happy, Mapping)
    assert isinstance(disputed, Mapping)
    assert isinstance(foundry, Mapping)
    assert isinstance(hypothesis, Mapping)
    stateful = foundry["stateful"]
    stateless = foundry["stateless"]
    assert isinstance(stateful, Mapping)
    assert isinstance(stateless, Mapping)
    print(f"wrote local test results under {results_root}")
    print(
        "call-gas totals: "
        f"happy={happy['totalCallGas']} disputed={disputed['totalCallGas']}"
    )
    print(
        "property tests: "
        f"hypothesis={hypothesis['passingExamples']} examples, "
        f"foundry={stateless['fuzzRuns']} fuzz runs, "
        f"{stateful['calls']} invariant calls"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
