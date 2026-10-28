"""Parsing and rendering for local E2E gas and property-test results."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Sequence


FOUNDRY_FUZZ_SEED = "0x" + hashlib.sha256(
    b"recourse-paper-local-test-results-v1"
).hexdigest()
HYPOTHESIS_SEED = 20260509
HAPPY_TEST = "testFullOptimisticPathPaysClaimant"
DISPUTED_TEST = "testDisputedOptimisticClaimEscalatesAndPaysByArbitration"


@dataclass(frozen=True)
class GasOperation:
    key: str
    label: str
    contract: str
    function: str


COMMON_GAS_OPERATIONS = (
    GasOperation("register", "register", "RecourseRegistry", "register"),
    GasOperation("postBond", "postBond", "BondVault", "postBond"),
    GasOperation(
        "commitReceipts", "commitReceipts", "ClaimRegistry", "commitReceipts"
    ),
    GasOperation("submitClaim", "submitClaim", "ClaimRegistry", "submitClaim"),
    GasOperation(
        "assertResidualLoss",
        "assertResidualLoss",
        "OptimisticPath",
        "assertResidualLoss",
    ),
)
HAPPY_GAS_OPERATIONS = COMMON_GAS_OPERATIONS + (
    GasOperation(
        "settle",
        "settle (finalize + payout)",
        "MockOptimisticOracleV3",
        "settle",
    ),
)
DISPUTED_GAS_OPERATIONS = COMMON_GAS_OPERATIONS + (
    GasOperation("dispute", "dispute", "MockOptimisticOracleV3", "dispute"),
    GasOperation("escalate", "escalate", "ArbitrablePath", "escalate"),
    GasOperation(
        "giveRuling",
        "giveRuling (rule + payout)",
        "MockArbitrator",
        "giveRuling",
    ),
)
TABLE_GAS_KEYS = (
    "register",
    "postBond",
    "commitReceipts",
    "submitClaim",
    "assertResidualLoss",
    "dispute",
    "settle",
    "escalate",
    "giveRuling",
)

_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*m")
_CONTRACT_HEADER = re.compile(
    r"^\|\s*(?:[^|]*:)?(?P<contract>[A-Za-z_][A-Za-z0-9_]*)\s+Contract\s*\|"
)
_GAS_ROW = re.compile(
    r"^\|\s*(?P<function>[A-Za-z_][A-Za-z0-9_]*)\s*"
    r"\|\s*(?P<minimum>\d+)\s*"
    r"\|\s*(?P<average>\d+)\s*"
    r"\|\s*(?P<median>\d+)\s*"
    r"\|\s*(?P<maximum>\d+)\s*"
    r"\|\s*(?P<calls>\d+)\s*\|"
)
_STATELESS_RESULT = re.compile(
    r"^\[PASS\]\s+(?P<name>testFuzz_[^(]+)\([^)]*\)\s+"
    r"\(runs:\s*(?P<runs>\d+),",
    re.MULTILINE,
)
_INVARIANT_RESULT = re.compile(
    r"^\[PASS\]\s+(?P<name>invariant_[^(]+)\(\)\s+"
    r"\(runs:\s*(?P<runs>\d+),\s*calls:\s*(?P<calls>\d+),\s*"
    r"reverts:\s*(?P<reverts>\d+)\)",
    re.MULTILINE,
)
_HYPOTHESIS_BLOCK = re.compile(
    r"^(?P<name>\S+::test_[A-Za-z0-9_]+):\s*$"
    r"(?P<body>.*?)(?=^\S+::test_[A-Za-z0-9_]+:\s*$|\Z)",
    re.MULTILINE | re.DOTALL,
)
_HYPOTHESIS_EXAMPLES = re.compile(
    r"(?P<passing>\d+)\s+passing examples,\s+"
    r"(?P<failing>\d+)\s+failing examples,\s+"
    r"(?P<invalid>\d+)\s+invalid examples"
)


class EvidenceError(ValueError):
    """Raised when raw test output cannot support the requested summary."""


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def _format_number(value: int | None) -> str:
    if value is None:
        return "---"
    return f"{value:,}".replace(",", "{,}")


def parse_gas_report(output: str) -> dict[tuple[str, str], dict[str, int]]:
    """Parse function rows from a Foundry gas report."""
    current_contract: str | None = None
    parsed: dict[tuple[str, str], dict[str, int]] = {}
    for raw_line in _ANSI_ESCAPE.sub("", output).splitlines():
        line = raw_line.lstrip()
        header = _CONTRACT_HEADER.match(line)
        if header:
            current_contract = header.group("contract")
            continue
        row = _GAS_ROW.match(line)
        if row and current_contract:
            parsed[(current_contract, row.group("function"))] = {
                "minimum": int(row.group("minimum")),
                "average": int(row.group("average")),
                "median": int(row.group("median")),
                "maximum": int(row.group("maximum")),
                "calls": int(row.group("calls")),
            }
    if not parsed:
        raise EvidenceError("Foundry gas report contained no function rows")
    return parsed


def _gas_path(
    output: str,
    *,
    test_name: str,
    operations: Sequence[GasOperation],
) -> dict[str, object]:
    rows = parse_gas_report(output)
    measured: list[dict[str, object]] = []
    for operation in operations:
        key = (operation.contract, operation.function)
        if key not in rows:
            raise EvidenceError(
                f"missing gas row {operation.contract}.{operation.function}"
            )
        row = rows[key]
        if row["calls"] != 1:
            raise EvidenceError(
                f"expected one call for {operation.contract}.{operation.function}, "
                f"found {row['calls']}"
            )
        measured.append(
            {
                "contract": operation.contract,
                "function": operation.function,
                "gas": row["median"],
                "key": operation.key,
                "label": operation.label,
                "reportStatistic": "median",
            }
        )
    return {
        "operations": measured,
        "test": test_name,
        "totalCallGas": sum(int(item["gas"]) for item in measured),
    }


def gas_metrics(happy_output: str, disputed_output: str) -> dict[str, object]:
    """Build machine-readable E2E call-gas metrics from isolated reports."""
    return {
        "disputedPath": _gas_path(
            disputed_output,
            test_name=DISPUTED_TEST,
            operations=DISPUTED_GAS_OPERATIONS,
        ),
        "happyPath": _gas_path(
            happy_output,
            test_name=HAPPY_TEST,
            operations=HAPPY_GAS_OPERATIONS,
        ),
        "isExternalTransactionReceiptGas": False,
        "measurementKind": "foundry_gas_report_call_gas",
        "notes": {
            "scope": (
                "Median call gas reported by Foundry for one externally invoked "
                "operation in each isolated E2E test on Foundry's in-process EVM. "
                "Despite the legacy anvil-e2e directory name, no Anvil JSON-RPC "
                "transactions are submitted. These are not signed transaction "
                "receipts and exclude deployments, test-harness execution, token "
                "preparation, and view calls."
            ),
            "settle": (
                "MockOptimisticOracleV3.settle includes the internal optimistic "
                "finalization callback and BondVault payout."
            ),
            "giveRuling": (
                "MockArbitrator.giveRuling includes ArbitrablePath.rule, the "
                "ClaimRegistry arbitration callback, and BondVault payout."
            ),
            "totalCallGas": "Sum of the listed call-gas rows; not whole-test gas.",
        },
        "schemaVersion": 1,
    }


def parse_foundry_fuzz(output: str) -> dict[str, object]:
    """Derive stateless and stateful Foundry counts from passing result lines."""
    if re.search(r"^\[FAIL", output, re.MULTILINE):
        raise EvidenceError("Foundry fuzz output contains a failing test")
    stateless = [
        {"name": match.group("name"), "runs": int(match.group("runs"))}
        for match in _STATELESS_RESULT.finditer(output)
    ]
    invariants = [
        {
            "calls": int(match.group("calls")),
            "name": match.group("name"),
            "reverts": int(match.group("reverts")),
            "runs": int(match.group("runs")),
        }
        for match in _INVARIANT_RESULT.finditer(output)
    ]
    if not stateless:
        raise EvidenceError("Foundry output contained no passing stateless fuzz tests")
    if not invariants:
        raise EvidenceError("Foundry output contained no passing invariants")
    return {
        "seed": FOUNDRY_FUZZ_SEED,
        "stateful": {
            "calls": sum(int(item["calls"]) for item in invariants),
            "invariants": len(invariants),
            "reverts": sum(int(item["reverts"]) for item in invariants),
            "runs": sum(int(item["runs"]) for item in invariants),
            "tests": invariants,
        },
        "stateless": {
            "fuzzRuns": sum(int(item["runs"]) for item in stateless),
            "tests": len(stateless),
            "testResults": stateless,
        },
    }


def parse_hypothesis(output: str) -> dict[str, object]:
    """Derive per-property example counts from Hypothesis statistics."""
    properties: list[dict[str, object]] = []
    for block in _HYPOTHESIS_BLOCK.finditer(output):
        counts = list(_HYPOTHESIS_EXAMPLES.finditer(block.group("body")))
        if not counts:
            continue
        properties.append(
            {
                "failingExamples": sum(
                    int(match.group("failing")) for match in counts
                ),
                "invalidExamples": sum(
                    int(match.group("invalid")) for match in counts
                ),
                "name": block.group("name").rsplit("::", 1)[1],
                "passingExamples": sum(
                    int(match.group("passing")) for match in counts
                ),
            }
        )
    if not properties:
        raise EvidenceError("pytest output contained no Hypothesis property statistics")
    return {
        "failingExamples": sum(
            int(item["failingExamples"]) for item in properties
        ),
        "invalidExamples": sum(
            int(item["invalidExamples"]) for item in properties
        ),
        "passingExamples": sum(
            int(item["passingExamples"]) for item in properties
        ),
        "properties": len(properties),
        "propertyResults": properties,
        "seed": HYPOTHESIS_SEED,
    }


def fuzz_metrics(foundry_output: str, hypothesis_output: str) -> dict[str, object]:
    """Build machine-readable property-test metrics without mixing units."""
    return {
        "foundry": parse_foundry_fuzz(foundry_output),
        "hypothesis": parse_hypothesis(hypothesis_output),
        "notes": {
            "units": (
                "Hypothesis examples, Foundry stateless fuzz runs, and Foundry "
                "stateful invariant calls are reported separately and must not "
                "be added into one execution count."
            )
        },
        "schemaVersion": 1,
    }


def _gas_by_key(path_metrics: Mapping[str, object]) -> dict[str, int]:
    operations = path_metrics["operations"]
    assert isinstance(operations, list)
    return {str(item["key"]): int(item["gas"]) for item in operations}


def render_gas_table(metrics: Mapping[str, object]) -> str:
    happy_path = metrics["happyPath"]
    disputed_path = metrics["disputedPath"]
    assert isinstance(happy_path, Mapping)
    assert isinstance(disputed_path, Mapping)
    happy = _gas_by_key(happy_path)
    disputed = _gas_by_key(disputed_path)
    labels = {
        operation.key: operation.label
        for operation in (*HAPPY_GAS_OPERATIONS, *DISPUTED_GAS_OPERATIONS)
    }
    rows = [
        f"  {labels[key]:<29} & {_format_number(happy.get(key)):>13} "
        f"& {_format_number(disputed.get(key)):>13} \\\\"
        for key in TABLE_GAS_KEYS
    ]
    rows.append(
        f"  total listed call-gas         & "
        f"{_format_number(int(happy_path['totalCallGas'])):>13} & "
        f"{_format_number(int(disputed_path['totalCallGas'])):>13} \\\\%"
    )
    return "\n".join(
        [
            "% Auto-generated by scripts/local_test_results.py from isolated",
            "% Foundry in-process E2E reports. Call-gas; not Anvil/RPC transaction gas.",
            "% Totals sum listed operation calls and exclude deployment and test-harness gas.",
            r"\def\tablerqsix{%",
            *rows,
            "}",
            "",
        ]
    )


def render_fuzz_table(metrics: Mapping[str, object]) -> str:
    hypothesis = metrics["hypothesis"]
    foundry = metrics["foundry"]
    assert isinstance(hypothesis, Mapping)
    assert isinstance(foundry, Mapping)
    stateless = foundry["stateless"]
    stateful = foundry["stateful"]
    assert isinstance(stateless, Mapping)
    assert isinstance(stateful, Mapping)
    return "\n".join(
        [
            "% Auto-generated by scripts/local_test_results.py from pytest and Foundry output.",
            "% Counts retain distinct units; they are not summed across rows.",
            "% Columns: layer/unit, properties, executions, failures or reverts.",
            r"\def\tablefuzz{%",
            "  Hypothesis examples          & "
            f"{int(hypothesis['properties']):3d} & "
            f"{_format_number(int(hypothesis['passingExamples'])):>10} & "
            f"{_format_number(int(hypothesis['failingExamples'])):>6} \\\\",
            "  Foundry fuzz runs            & "
            f"{int(stateless['tests']):3d} & "
            f"{_format_number(int(stateless['fuzzRuns'])):>10} & "
            "     0 \\\\",
            "  Foundry invariant calls      & "
            f"{int(stateful['invariants']):3d} & "
            f"{_format_number(int(stateful['calls'])):>10} & "
            f"{_format_number(int(stateful['reverts'])):>6} \\\\%",
            "}",
            "",
        ]
    )


def _copy_log(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.resolve() != destination.resolve():
        shutil.copyfile(source, destination)


def render_from_logs(
    *,
    results_root: Path,
    happy_log: Path,
    disputed_log: Path,
    foundry_fuzz_log: Path,
    hypothesis_log: Path,
) -> tuple[dict[str, object], dict[str, object]]:
    gas_dir = results_root / "anvil-e2e"
    fuzz_dir = results_root / "fuzzing"
    gas = gas_metrics(happy_log.read_text(), disputed_log.read_text())
    fuzz = fuzz_metrics(foundry_fuzz_log.read_text(), hypothesis_log.read_text())

    _copy_log(happy_log, gas_dir / "happy_path_forge.log")
    _copy_log(disputed_log, gas_dir / "disputed_path_forge.log")
    _copy_log(foundry_fuzz_log, fuzz_dir / "forge_run.log")
    _copy_log(hypothesis_log, fuzz_dir / "hypothesis_run.log")
    _write_json(gas_dir / "metrics.json", gas)
    (gas_dir / "table_anvile2e_gas.tex").write_text(render_gas_table(gas))
    _write_json(fuzz_dir / "metrics.json", fuzz)
    (fuzz_dir / "table_fuzz.tex").write_text(render_fuzz_table(fuzz))
    return gas, fuzz
