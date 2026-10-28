"""Evaluation cell runner."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Any, Mapping

from .adversaries import AdversaryClass
from .baselines import runner_for_baseline
from .faults import FaultClass, inject_fault
from .metrics import metrics_frame
from .traces import Trace, generate_trace


@dataclass(frozen=True)
class Cell:
    workload: str
    baseline: str
    config: Mapping[str, Any]
    fault_class: str
    repetition: int
    adversary_class: str = AdversaryClass.NONE.value


@dataclass(frozen=True)
class RunArtifact:
    metrics_path: Path
    manifest_path: Path


def run_cell(cell: Cell, output_dir: Path) -> RunArtifact:
    output_dir.mkdir(parents=True, exist_ok=True)
    seed = int(cell.config.get("seed", 42)) + cell.repetition
    trace = generate_trace(
        num_calls=int(cell.config.get("num_calls", 3)),
        failure_density=float(cell.config.get("failure_density", 0.5)),
        concurrency=int(cell.config.get("concurrency", 1)),
        seed=seed,
        scope_distribution=_scope_distribution(cell.config),
        workload=cell.workload,
        correlation_prob=float(cell.config.get("correlation_prob", 0.0)),
        correlation_burst_size=int(cell.config.get("correlation_burst_size", 0)),
    )
    trace = _inject_cell_fault(trace, cell.fault_class, seed=seed)
    result = replace(
        runner_for_baseline(
            cell.baseline,
            seed=seed,
            approval_rate=float(cell.config.get("approval_rate", 1.0)),
            adversary_class=cell.adversary_class,
            bond_multiplier=float(cell.config.get("bond_multiplier", 1.0)),
        ).run(trace),
        workload=cell.workload,
        fault_class=cell.fault_class,
        adversary_class=cell.adversary_class,
        correlation_prob=float(cell.config.get("correlation_prob", 0.0)),
        correlation_burst_size=int(cell.config.get("correlation_burst_size", 0)),
    )
    frame = metrics_frame([result])
    metrics_path = output_dir / "metrics.parquet"
    manifest_path = output_dir / "manifest.json"
    frame.to_parquet(metrics_path, index=False)
    manifest_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "cell": asdict(cell),
                "traceId": trace.trace_id,
                "toolVersions": {"harness": "0.1.0"},
            },
            sort_keys=True,
            indent=2,
        )
        + "\n"
    )
    return RunArtifact(metrics_path=metrics_path, manifest_path=manifest_path)


def _inject_cell_fault(trace: Trace, fault_class: str, *, seed: int) -> Trace:
    fault = _coerce_fault(fault_class)
    calls = tuple(inject_fault(call, fault, seed=seed).mutated_call for call in trace.calls)
    return Trace(trace_id=trace.trace_id, calls=calls)


def _coerce_fault(fault_class: str) -> FaultClass:
    try:
        return FaultClass(fault_class)
    except ValueError:
        return FaultClass[fault_class]


def _scope_distribution(config: Mapping[str, Any]) -> dict[str, float] | None:
    raw = config.get("scope_distribution")
    if raw is None:
        return None
    if not isinstance(raw, Mapping):
        raise ValueError("scope_distribution must be a mapping")
    return {str(key): float(value) for key, value in raw.items()}
