from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from recourse_harness.drivers import run_driver
from recourse_harness.runner import Cell, run_cell


def test_cell_runner_writes_metrics_and_manifest(tmp_path: Path) -> None:
    cell = Cell(
        workload="postgres",
        baseline="recourse",
        config={"seed": 42, "num_calls": 4, "failure_density": 0.5, "concurrency": 2},
        fault_class="none",
        repetition=0,
    )

    artifact = run_cell(cell, tmp_path)

    assert artifact.metrics_path.exists()
    assert artifact.manifest_path.exists()
    frame = pd.read_parquet(artifact.metrics_path)
    manifest = json.loads(artifact.manifest_path.read_text())
    assert len(frame) == 1
    assert manifest["cell"]["baseline"] == "recourse"
    assert manifest["cell"]["workload"] == "postgres"
    assert manifest["schemaVersion"] == 1
    assert frame["workload"].tolist() == ["postgres"]


def test_rq5_driver_exercises_fault_table(tmp_path: Path) -> None:
    artifact = run_driver(
        "rq5",
        tmp_path,
        config={"seed": 42, "num_calls": 3, "repetitions": 1, "baselines": ["recourse"]},
    )

    frame = pd.read_parquet(artifact.metrics_path)
    manifest = json.loads(artifact.manifest_path.read_text())

    assert {"none", "OBS_HIDE_PRESTATE", "BND_DOWNSTREAM_LEAK"}.issubset(set(frame["fault_class"]))
    assert (frame["false_acceptance"] >= 0).all()
    assert (frame["routing_correctness"] == 1.0).all()
    assert manifest["gitCommit"]
    assert manifest["schemaVersions"]["claim"] == 1
    assert len(manifest["seedHash"]) == 64
    assert manifest["rpcEndpoint"] == "local-synthetic"
    assert manifest["toolVersions"]["harness"] == "0.1.0"


def test_driver_offsets_repetition_seed_once(tmp_path: Path) -> None:
    run_driver(
        "rq1",
        tmp_path,
        config={
            "seed": 123,
            "num_calls": 1,
            "repetitions": 2,
            "baselines": ["recourse"],
            "fault_classes": ["none"],
        },
    )

    first = json.loads((tmp_path / "postgres-recourse-none-c1-r0" / "manifest.json").read_text())
    second = json.loads((tmp_path / "postgres-recourse-none-c1-r1" / "manifest.json").read_text())

    assert first["cell"]["config"]["seed"] == 123
    assert first["traceId"] == "trace-0000007b"
    assert second["cell"]["config"]["seed"] == 123
    assert second["traceId"] == "trace-0000007c"


def test_driver_redacts_credentialed_rpc_endpoint(tmp_path: Path) -> None:
    artifact = run_driver(
        "rq1",
        tmp_path,
        config={
            "seed": 42,
            "num_calls": 1,
            "repetitions": 1,
            "baselines": ["recourse"],
            "rpc_endpoint": "https://example.invalid/v2/secret-token?api_key=secret",
        },
    )

    manifest = json.loads(artifact.manifest_path.read_text())

    assert manifest["rpcEndpoint"] == "https://example.invalid"


def test_driver_refuses_nonempty_output_directory(tmp_path: Path) -> None:
    stale = tmp_path / "old-cell"
    stale.mkdir()
    (stale / "metrics.parquet").write_text("stale")

    with pytest.raises(FileExistsError, match="output directory is not empty"):
        run_driver(
            "rq1",
            tmp_path,
            config={
                "seed": 42,
                "num_calls": 1,
                "repetitions": 1,
                "baselines": ["recourse"],
                "fault_classes": ["none"],
            },
        )

    assert (stale / "metrics.parquet").read_text() == "stale"


@pytest.mark.parametrize(
    "config",
    [
        {"repetitions": 0, "baselines": ["recourse"]},
        {"repetitions": 1, "baselines": []},
        {"repetitions": 1, "baselines": ["recourse"], "fault_classes": []},
    ],
)
def test_driver_rejects_empty_experiment_config(tmp_path: Path, config: dict) -> None:
    with pytest.raises(ValueError):
        run_driver("rq1", tmp_path, config=config)


@pytest.mark.parametrize("rq", ["rq1", "rq2", "rq3", "rq4", "rq5"])
def test_minimal_rq_driver_writes_deterministic_artifacts(tmp_path: Path, rq: str) -> None:
    first_dir = tmp_path / "first" / rq
    second_dir = tmp_path / "second" / rq

    first = run_driver(
        rq,
        first_dir,
        config={"seed": 42, "num_calls": 3, "repetitions": 1, "baselines": ["recourse"]},
    )
    second = run_driver(
        rq,
        second_dir,
        config={"seed": 42, "num_calls": 3, "repetitions": 1, "baselines": ["recourse"]},
    )

    assert pd.read_parquet(first.metrics_path).to_dict("records") == pd.read_parquet(
        second.metrics_path
    ).to_dict("records")
    assert json.loads(first.manifest_path.read_text()) == json.loads(
        second.manifest_path.read_text()
    )
