from __future__ import annotations

import os
import subprocess
from pathlib import Path


def test_run_rq_all_works_from_repository_root_and_includes_every_rq(
    tmp_path: Path,
) -> None:
    prototype_dir = Path(__file__).resolve().parents[2]
    repository_root = prototype_dir.parent
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    call_log = tmp_path / "uv-calls.log"
    uv_stub = bin_dir / "uv"
    uv_stub.write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$*" >> "$UV_CALL_LOG"\n'
        "exit 0\n"
    )
    uv_stub.chmod(0o755)
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "UV_CALL_LOG": str(call_log),
        "RECOURSE_RQ_OUTPUT_DIR": str(tmp_path / "results"),
    }

    completed = subprocess.run(
        ["./prototype/scripts/run-rq.sh", "all"],
        cwd=repository_root,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    calls = call_log.read_text().splitlines()
    assert len(calls) == 10
    assert any(" rq5-adv " in f" {call} " for call in calls)


def test_run_rq_all_honors_results_root(tmp_path: Path) -> None:
    prototype_dir = Path(__file__).resolve().parents[2]
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    call_log = tmp_path / "uv-calls.log"
    uv_stub = bin_dir / "uv"
    uv_stub.write_text(
        "#!/bin/sh\n"
        'printf "%s\\n" "$*" >> "$UV_CALL_LOG"\n'
        "exit 0\n"
    )
    uv_stub.chmod(0o755)
    results_root = tmp_path / "fresh-results"
    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "UV_CALL_LOG": str(call_log),
        "RECOURSE_RESULTS_ROOT": str(results_root),
    }

    completed = subprocess.run(
        [str(prototype_dir / "scripts" / "run-rq.sh"), "all"],
        cwd=prototype_dir,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    calls = call_log.read_text().splitlines()
    assert len(calls) == 10
    assert all(str(results_root) in call for call in calls)


def test_reproduction_defers_paper_writes_until_validated_sync() -> None:
    prototype_dir = Path(__file__).resolve().parents[2]
    reproduce = (prototype_dir / "scripts" / "reproduce.sh").read_text()

    unset_index = reproduce.index("unset RECOURSE_PAPER_DIR")
    ci_index = reproduce.index("./scripts/run-rq-ci.sh")
    sync_index = reproduce.index("./scripts/sync-paper-artifacts.sh sync")

    assert unset_index < ci_index < sync_index
