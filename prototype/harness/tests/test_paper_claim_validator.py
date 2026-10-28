from __future__ import annotations

import json
import subprocess
import sys
from copy import deepcopy
from pathlib import Path

import pytest

PROTOTYPE_DIR = Path(__file__).resolve().parents[2]
VALIDATOR = PROTOTYPE_DIR / "scripts" / "validate-paper-claims.py"


@pytest.fixture
def valid_claim_fixture(tmp_path: Path) -> tuple[Path, Path, Path, dict]:
    repo_root = tmp_path / "repo"
    paper_dir = tmp_path / "paper"
    (repo_root / "results").mkdir(parents=True)
    (paper_dir / "tables").mkdir(parents=True)
    (repo_root / "config.json").write_text("{}\n")
    result = repo_root / "results" / "table_a.tex"
    destination = paper_dir / "tables" / "table_a.tex"
    result.write_text("same bytes\n")
    destination.write_text("same bytes\n")
    manifest = {
        "schemaVersion": 1,
        "paperInventory": {
            "tables": ["tables/table_a.tex"],
            "figures": [],
        },
        "claims": [
            {
                "id": "table-a",
                "kind": "table",
                "status": "reproducible",
                "sources": ["repo:config.json"],
                "command": "make table-a",
                "result": "repo:results/table_a.tex",
                "paperDestination": "tables/table_a.tex",
                "statisticalUnit": "deterministic_trace_seed",
                "verificationMode": "byte_equal",
            }
        ],
    }
    manifest_path = tmp_path / "claims.json"
    manifest_path.write_text(json.dumps(manifest))
    return repo_root, paper_dir, manifest_path, manifest


def _write_manifest(path: Path, manifest: dict) -> None:
    path.write_text(json.dumps(manifest))


def _run_validator(
    repo_root: Path,
    paper_dir: Path,
    manifest_path: Path,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(VALIDATOR),
            "--manifest",
            str(manifest_path),
            "--repo-root",
            str(repo_root),
            "--paper-dir",
            str(paper_dir),
        ],
        check=False,
        capture_output=True,
        text=True,
    )


def test_valid_manifest_and_matching_artifact_pass(
    valid_claim_fixture: tuple[Path, Path, Path, dict],
) -> None:
    repo_root, paper_dir, manifest_path, _ = valid_claim_fixture

    completed = _run_validator(repo_root, paper_dir, manifest_path)

    assert completed.returncode == 0, completed.stderr
    assert "validated 1 claims" in completed.stdout


def test_missing_source_fails(
    valid_claim_fixture: tuple[Path, Path, Path, dict],
) -> None:
    repo_root, paper_dir, manifest_path, manifest = valid_claim_fixture
    manifest["claims"][0]["sources"] = ["repo:missing.json"]
    _write_manifest(manifest_path, manifest)

    completed = _run_validator(repo_root, paper_dir, manifest_path)

    assert completed.returncode == 1
    assert "source does not exist" in completed.stderr


def test_project_scoped_source_resolves_from_prototype_parent(
    valid_claim_fixture: tuple[Path, Path, Path, dict],
) -> None:
    repo_root, paper_dir, manifest_path, manifest = valid_claim_fixture
    project_source = repo_root.parent / "project-source.html"
    project_source.write_text("<html></html>\n")
    manifest["claims"][0]["sources"] = ["project:project-source.html"]
    _write_manifest(manifest_path, manifest)

    completed = _run_validator(repo_root, paper_dir, manifest_path)

    assert completed.returncode == 0, completed.stderr


def test_missing_command_fails(
    valid_claim_fixture: tuple[Path, Path, Path, dict],
) -> None:
    repo_root, paper_dir, manifest_path, manifest = valid_claim_fixture
    manifest["claims"][0]["command"] = ""
    _write_manifest(manifest_path, manifest)

    completed = _run_validator(repo_root, paper_dir, manifest_path)

    assert completed.returncode == 1
    assert "command must be a non-empty string" in completed.stderr


def test_duplicate_paper_destination_fails(
    valid_claim_fixture: tuple[Path, Path, Path, dict],
) -> None:
    repo_root, paper_dir, manifest_path, manifest = valid_claim_fixture
    duplicate = deepcopy(manifest["claims"][0])
    duplicate["id"] = "table-a-copy"
    manifest["claims"].append(duplicate)
    _write_manifest(manifest_path, manifest)

    completed = _run_validator(repo_root, paper_dir, manifest_path)

    assert completed.returncode == 1
    assert "duplicate paperDestination" in completed.stderr


def test_declared_checksum_mismatch_fails(
    valid_claim_fixture: tuple[Path, Path, Path, dict],
) -> None:
    repo_root, paper_dir, manifest_path, manifest = valid_claim_fixture
    manifest["claims"][0]["checksum"] = "sha256:" + "0" * 64
    _write_manifest(manifest_path, manifest)

    completed = _run_validator(repo_root, paper_dir, manifest_path)

    assert completed.returncode == 1
    assert "checksum mismatch" in completed.stderr


def test_unexpected_paper_table_fails(
    valid_claim_fixture: tuple[Path, Path, Path, dict],
) -> None:
    repo_root, paper_dir, manifest_path, _ = valid_claim_fixture
    (paper_dir / "tables" / "stale.tex").write_text("stale\n")

    completed = _run_validator(repo_root, paper_dir, manifest_path)

    assert completed.returncode == 1
    assert "unexpected paper table" in completed.stderr
    assert "tables/stale.tex" in completed.stderr


def test_unexpected_paper_figure_fails(
    valid_claim_fixture: tuple[Path, Path, Path, dict],
) -> None:
    repo_root, paper_dir, manifest_path, _ = valid_claim_fixture
    (paper_dir / "figures").mkdir()
    (paper_dir / "figures" / "stale.pdf").write_bytes(b"stale\n")

    completed = _run_validator(repo_root, paper_dir, manifest_path)

    assert completed.returncode == 1
    assert "unexpected paper figure" in completed.stderr
    assert "figures/stale.pdf" in completed.stderr


def test_figure_inventory_requires_matching_claim(
    valid_claim_fixture: tuple[Path, Path, Path, dict],
) -> None:
    repo_root, paper_dir, manifest_path, manifest = valid_claim_fixture
    (paper_dir / "figures").mkdir()
    (paper_dir / "figures" / "architecture.png").write_bytes(b"figure")
    manifest["paperInventory"]["figures"] = ["figures/architecture.png"]
    _write_manifest(manifest_path, manifest)

    completed = _run_validator(repo_root, paper_dir, manifest_path)

    assert completed.returncode == 1
    assert (
        "paper inventory figure has no claim: figures/architecture.png"
        in completed.stderr
    )


def test_paper_result_byte_difference_fails(
    valid_claim_fixture: tuple[Path, Path, Path, dict],
) -> None:
    repo_root, paper_dir, manifest_path, _ = valid_claim_fixture
    (paper_dir / "tables" / "table_a.tex").write_text("different\n")

    completed = _run_validator(repo_root, paper_dir, manifest_path)

    assert completed.returncode == 1
    assert "differs from result" in completed.stderr


def test_unsupported_claim_requires_machine_readable_reason(
    valid_claim_fixture: tuple[Path, Path, Path, dict],
) -> None:
    repo_root, paper_dir, manifest_path, manifest = valid_claim_fixture
    claim = manifest["claims"][0]
    claim["status"] = "unsupported"
    claim["verificationMode"] = "unsupported"
    _write_manifest(manifest_path, manifest)

    completed = _run_validator(repo_root, paper_dir, manifest_path)

    assert completed.returncode == 1
    assert "unsupportedReason" in completed.stderr


def test_unsupported_claim_can_still_require_artifact_byte_equality(
    valid_claim_fixture: tuple[Path, Path, Path, dict],
) -> None:
    repo_root, paper_dir, manifest_path, manifest = valid_claim_fixture
    claim = manifest["claims"][0]
    claim["status"] = "unsupported"
    claim["unsupportedReason"] = {
        "code": "stale_claim",
        "detail": "Artifact parity is independent from empirical support.",
    }
    _write_manifest(manifest_path, manifest)

    completed = _run_validator(repo_root, paper_dir, manifest_path)

    assert completed.returncode == 0, completed.stderr


def test_makefile_target_runs_validator(
    valid_claim_fixture: tuple[Path, Path, Path, dict],
) -> None:
    repo_root, paper_dir, manifest_path, _ = valid_claim_fixture

    completed = subprocess.run(
        [
            "make",
            "validate-paper-claims",
            f"PYTHON={sys.executable}",
            f"PAPER_CLAIMS_MANIFEST={manifest_path}",
            f"PAPER_CLAIMS_REPO_ROOT={repo_root}",
            f"RECOURSE_PAPER_DIR={paper_dir}",
        ],
        cwd=PROTOTYPE_DIR,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
