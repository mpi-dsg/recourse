#!/usr/bin/env python3
"""Regression tests for generated local gas and fuzzing summaries."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parent
GENERATOR = SCRIPTS_DIR / "local_test_results.py"


def _gas_report(rows: dict[tuple[str, str], int]) -> str:
    blocks: list[str] = []
    by_contract: dict[str, list[tuple[str, int]]] = {}
    for (contract, function), gas in rows.items():
        by_contract.setdefault(contract, []).append((function, gas))
    for contract, functions in by_contract.items():
        body = "\n".join(
            f"| {function} | {gas} | {gas} | {gas} | {gas} | 1 |"
            for function, gas in functions
        )
        blocks.append(
            textwrap.dedent(
                f"""\
                | src/{contract}.sol:{contract} Contract | | | | | |
                | Function Name | Min | Avg | Median | Max | # Calls |
                {body}
                """
            )
        )
    return "\n".join(blocks)


HAPPY_GAS = _gas_report(
    {
        ("RecourseRegistry", "register"): 100,
        ("BondVault", "postBond"): 200,
        ("ClaimRegistry", "commitReceipts"): 300,
        ("ClaimRegistry", "submitClaim"): 400,
        ("OptimisticPath", "assertResidualLoss"): 500,
        ("MockOptimisticOracleV3", "settle"): 600,
    }
)

DISPUTED_GAS = _gas_report(
    {
        ("RecourseRegistry", "register"): 101,
        ("BondVault", "postBond"): 201,
        ("ClaimRegistry", "commitReceipts"): 301,
        ("ClaimRegistry", "submitClaim"): 401,
        ("OptimisticPath", "assertResidualLoss"): 501,
        ("MockOptimisticOracleV3", "dispute"): 601,
        ("ArbitrablePath", "escalate"): 701,
        ("MockArbitrator", "giveRuling"): 801,
    }
)

FOUNDRY_FUZZ = textwrap.dedent(
    """\
    [PASS] testFuzz_first(uint256) (runs: 7, μ: 1, ~: 1)
    [PASS] testFuzz_second(uint256) (runs: 11, μ: 1, ~: 1)
    [PASS] invariant_alpha() (runs: 3, calls: 15, reverts: 0)
    [PASS] invariant_beta() (runs: 5, calls: 25, reverts: 1)
    Ran 2 test suites: 4 tests passed, 0 failed
    """
)

HYPOTHESIS = textwrap.dedent(
    """\
    tests/test_classifier_properties.py::test_alpha:

      - during generate phase:
        - 7 passing examples, 0 failing examples, 1 invalid examples

      - Stopped because settings.max_examples=7

    tests/test_classifier_properties.py::test_beta:

      - during generate phase:
        - 8 passing examples, 0 failing examples, 2 invalid examples

      - Stopped because settings.max_examples=8
    """
)


class LocalTestResultsTest(unittest.TestCase):
    def _run_generator(
        self, results_root: Path, *, happy_gas: str = HAPPY_GAS
    ) -> subprocess.CompletedProcess[str]:
        logs = results_root.parent / "inputs"
        logs.mkdir(exist_ok=True)
        paths: dict[str, Path] = {}
        for name, content in {
            "happy": happy_gas,
            "disputed": DISPUTED_GAS,
            "foundry": FOUNDRY_FUZZ,
            "hypothesis": HYPOTHESIS,
        }.items():
            path = logs / f"{name}.log"
            path.write_text(content)
            paths[name] = path

        env = os.environ.copy()
        env["RECOURSE_RESULTS_ROOT"] = str(results_root)
        return subprocess.run(
            [
                sys.executable,
                str(GENERATOR),
                "--from-logs",
                "--happy-gas-log",
                str(paths["happy"]),
                "--disputed-gas-log",
                str(paths["disputed"]),
                "--foundry-fuzz-log",
                str(paths["foundry"]),
                "--hypothesis-log",
                str(paths["hypothesis"]),
            ],
            cwd=SCRIPTS_DIR.parent,
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )

    def test_generates_honestly_labelled_call_gas_metrics_and_table(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            results_root = Path(tmp) / "fresh-results"
            completed = self._run_generator(results_root)

            self.assertEqual(completed.returncode, 0, completed.stdout)
            metrics = json.loads(
                (results_root / "anvil-e2e" / "metrics.json").read_text()
            )
            self.assertEqual(
                metrics["measurementKind"], "foundry_gas_report_call_gas"
            )
            self.assertFalse(metrics["isExternalTransactionReceiptGas"])
            self.assertEqual(metrics["happyPath"]["totalCallGas"], 2100)
            self.assertEqual(metrics["disputedPath"]["totalCallGas"], 3608)
            table = (
                results_root / "anvil-e2e" / "table_anvile2e_gas.tex"
            ).read_text()
            self.assertIn("Call-gas; not Anvil/RPC transaction gas", table)
            self.assertIn("settle (finalize + payout)", table)
            self.assertIn("2{,}100", table)
            self.assertIn("3{,}608", table)

    def test_derives_separate_fuzz_units_from_raw_test_output(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            results_root = Path(tmp) / "fresh-results"
            completed = self._run_generator(results_root)

            self.assertEqual(completed.returncode, 0, completed.stdout)
            metrics = json.loads(
                (results_root / "fuzzing" / "metrics.json").read_text()
            )
            self.assertEqual(metrics["hypothesis"]["properties"], 2)
            self.assertEqual(metrics["hypothesis"]["passingExamples"], 15)
            self.assertEqual(metrics["foundry"]["stateless"]["tests"], 2)
            self.assertEqual(metrics["foundry"]["stateless"]["fuzzRuns"], 18)
            self.assertEqual(metrics["foundry"]["stateful"]["invariants"], 2)
            self.assertEqual(metrics["foundry"]["stateful"]["calls"], 40)
            self.assertEqual(metrics["foundry"]["stateful"]["reverts"], 1)
            table = (results_root / "fuzzing" / "table_fuzz.tex").read_text()
            self.assertIn("Hypothesis examples", table)
            self.assertIn("Foundry fuzz runs", table)
            self.assertIn("Foundry invariant calls", table)

    def test_rejects_incomplete_gas_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            results_root = Path(tmp) / "fresh-results"
            completed = self._run_generator(
                results_root,
                happy_gas=HAPPY_GAS.replace(
                    "| settle | 600 | 600 | 600 | 600 | 1 |", ""
                ),
            )

            self.assertNotEqual(completed.returncode, 0)
            self.assertIn(
                "missing gas row MockOptimisticOracleV3.settle", completed.stdout
            )

    def test_makefile_exposes_local_test_results_target(self) -> None:
        makefile = (SCRIPTS_DIR.parent / "Makefile").read_text()

        self.assertIn("local-test-results:", makefile)
        self.assertIn("scripts/local_test_results.py", makefile)

    def test_root_reproduction_invokes_local_test_results_target(self) -> None:
        reproduce = (SCRIPTS_DIR / "reproduce.sh").read_text()

        self.assertIn("make local-test-results", reproduce)


if __name__ == "__main__":
    unittest.main()
