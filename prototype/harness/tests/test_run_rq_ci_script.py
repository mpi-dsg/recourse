from __future__ import annotations

from pathlib import Path


def test_ci_report_describes_independent_seed_statistical_unit() -> None:
    script = (
        Path(__file__).resolve().parents[2]
        / "scripts"
        / "run-rq-ci.sh"
    ).read_text()

    assert "independent trace seeds" in script
    assert "5 per-seed repetitions" not in script
