"""Minimal deterministic RQ drivers."""

from __future__ import annotations

import hashlib
import json
import platform
import subprocess
from urllib.parse import urlsplit
from pathlib import Path
from typing import Any, Mapping

import pandas as pd

from .adversaries import AdversaryClass
from .faults import FaultClass
from .runner import Cell, RunArtifact, run_cell

RQ_NAMES = {"rq1", "rq2", "rq2-reasons", "rq3", "rq4", "rq5", "rq5-adv", "rq8", "rq9", "rq10"}


def run_driver(rq: str, output_dir: Path, *, config: Mapping[str, Any]) -> RunArtifact:
    if rq not in RQ_NAMES:
        raise ValueError(f"unknown RQ: {rq}")
    ensure_fresh_output_dir(output_dir)
    artifacts = []
    repetitions = int(config.get("repetitions", 1))
    baselines = tuple(config.get("baselines", ["recourse"]))
    fault_classes = _fault_classes_for(rq, config)
    adversary_classes = _adversary_classes_for(config)
    # Multi-workload and concurrency sweeps: support a list when provided,
    # otherwise fall back to a single value drawn from the legacy single-value
    # config keys. Per-repetition seed offsetting introduces real variance
    # across reps instead of repeating an identical deterministic trace.
    workloads = tuple(config.get("workloads", [config.get("workload", "postgres")]))
    concurrencies = tuple(config.get("concurrencies", [config.get("concurrency", 1)]))
    # Sensitivity-sweep axes: when `bond_multipliers` / `approval_rates` are
    # absent the driver falls back to the scalar config keys, preserving the
    # cell-id format used by RQ1–RQ5.
    bond_multipliers = tuple(
        config.get("bond_multipliers", [config.get("bond_multiplier", 1.0)])
    )
    approval_rates = tuple(
        config.get("approval_rates", [config.get("approval_rate", 1.0)])
    )
    # Correlated-failure burst sweep (RQ10): when ``correlation_burst_sizes``
    # is absent the scalar ``correlation_burst_size`` carries through, which
    # collapses to a no-op when ``correlation_prob == 0``.
    correlation_burst_sizes = tuple(
        config.get(
            "correlation_burst_sizes",
            [config.get("correlation_burst_size", 0)],
        )
    )
    correlation_prob = float(config.get("correlation_prob", 0.0))
    base_seed = int(config.get("seed", 42))
    if repetitions <= 0:
        raise ValueError("repetitions must be positive")
    if not baselines:
        raise ValueError("at least one baseline is required")
    if not fault_classes:
        raise ValueError("at least one fault class is required")
    if not workloads:
        raise ValueError("at least one workload is required")
    if not concurrencies:
        raise ValueError("at least one concurrency value is required")
    if not adversary_classes:
        raise ValueError("at least one adversary class is required")
    if not bond_multipliers:
        raise ValueError("at least one bond_multiplier is required")
    if not approval_rates:
        raise ValueError("at least one approval_rate is required")
    if not correlation_burst_sizes:
        raise ValueError("at least one correlation_burst_size is required")

    sweep_bond = len(bond_multipliers) > 1 or "bond_multipliers" in config
    sweep_approval = len(approval_rates) > 1 or "approval_rates" in config
    sweep_correlation = (
        len(correlation_burst_sizes) > 1 or "correlation_burst_sizes" in config
    )

    for workload in workloads:
        for concurrency in concurrencies:
            for bond_multiplier in bond_multipliers:
                for approval_rate in approval_rates:
                    for burst_size in correlation_burst_sizes:
                        for repetition in range(repetitions):
                            for baseline in baselines:
                                for fault_class in fault_classes:
                                    for adversary_class in adversary_classes:
                                        cell = Cell(
                                            workload=str(workload),
                                            baseline=str(baseline),
                                            config={
                                                "seed": base_seed,
                                                "num_calls": int(config.get("num_calls", 3)),
                                                "failure_density": float(
                                                    config.get("failure_density", 0.5)
                                                ),
                                                "concurrency": int(concurrency),
                                                "approval_rate": float(approval_rate),
                                                "bond_multiplier": float(bond_multiplier),
                                                "scope_distribution": config.get(
                                                    "scope_distribution"
                                                ),
                                                "correlation_prob": correlation_prob,
                                                "correlation_burst_size": int(burst_size),
                                            },
                                            fault_class=fault_class,
                                            repetition=repetition,
                                            adversary_class=adversary_class,
                                        )
                                        adv_suffix = (
                                            ""
                                            if adversary_class == AdversaryClass.NONE.value
                                            else f"-{adversary_class}"
                                        )
                                        bond_suffix = (
                                            f"-b{_fmt_axis(bond_multiplier)}" if sweep_bond else ""
                                        )
                                        approval_suffix = (
                                            f"-a{_fmt_axis(approval_rate)}" if sweep_approval else ""
                                        )
                                        correlation_suffix = (
                                            f"-k{_fmt_axis(burst_size)}"
                                            if sweep_correlation
                                            else ""
                                        )
                                        cell_id = (
                                            f"{workload}-{baseline}-{fault_class}-c{concurrency}"
                                            f"{bond_suffix}{approval_suffix}{correlation_suffix}"
                                            f"-r{repetition}{adv_suffix}"
                                        )
                                        artifacts.append(run_cell(cell, output_dir / cell_id))
    frames = [pd.read_parquet(artifact.metrics_path) for artifact in artifacts]
    metrics_path = output_dir / "metrics.parquet"
    manifest_path = output_dir / "manifest.json"
    pd.concat(frames, ignore_index=True).to_parquet(metrics_path, index=False)
    manifest_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "rq": rq,
                "config": dict(config),
                "artifacts": len(artifacts),
                "gitCommit": _git_commit(),
                "gitDirty": _git_dirty(),
                "schemaVersions": {
                    "recourseContract": 1,
                    "effectReceipt": 1,
                    "recoveryReceipt": 1,
                    "claim": 1,
                },
                "seedHash": _seed_hash(int(config.get("seed", 42))),
                "contractAddresses": dict(config.get("contract_addresses", {})),
                "rpcEndpoint": _rpc_endpoint_label(config),
                "rpcBlockHeight": config.get("rpc_block_height"),
                "budgetFileHash": config.get("budget_file_hash"),
                "toolVersions": {"python": platform.python_version(), "harness": "0.1.0"},
            },
            sort_keys=True,
            indent=2,
        )
        + "\n"
    )
    return RunArtifact(metrics_path=metrics_path, manifest_path=manifest_path)


def ensure_fresh_output_dir(output_dir: Path) -> None:
    """Create an output directory or accept it only when it is empty."""
    if output_dir.exists() and any(output_dir.iterdir()):
        raise FileExistsError(f"output directory is not empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)


def _fmt_axis(value: float) -> str:
    """Format a sweep-axis value for use inside a result directory name."""
    return f"{float(value):g}".replace(".", "p").replace("-", "n")


def _fault_classes_for(rq: str, config: Mapping[str, Any]) -> list[str]:
    configured = config.get("fault_classes")
    if configured is not None:
        return [str(fault) for fault in configured]
    if rq == "rq5":
        return [fault.value for fault in FaultClass]
    if rq == "rq5-adv":
        return [FaultClass.NONE.value]
    return [str(config.get("fault_class", FaultClass.NONE.value))]


def _adversary_classes_for(config: Mapping[str, Any]) -> list[str]:
    configured = config.get("adversary_classes")
    if configured is None:
        return [AdversaryClass.NONE.value]
    return [str(adv) for adv in configured]


def _seed_hash(seed: int) -> str:
    return hashlib.sha256(str(seed).encode("utf-8")).hexdigest()


def _rpc_endpoint_label(config: Mapping[str, Any]) -> str:
    explicit = config.get("rpc_endpoint_label")
    if explicit:
        return str(explicit)
    endpoint = str(config.get("rpc_endpoint", "local-synthetic"))
    parsed = urlsplit(endpoint)
    if not parsed.scheme or not parsed.hostname:
        return endpoint
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{parsed.hostname}{port}"


def _git_commit() -> str:
    repo = _repo_root()
    if repo is None:
        return "unknown"
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo,
        check=False,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def _git_dirty() -> bool:
    repo = _repo_root()
    if repo is None:
        return True
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=repo,
        check=False,
        capture_output=True,
        text=True,
    )
    return result.returncode != 0 or bool(result.stdout.strip())


def _repo_root() -> Path | None:
    for parent in Path(__file__).resolve().parents:
        if (parent / ".git").exists():
            return parent
    return None
