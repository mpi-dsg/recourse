"""Run the schemas parity verifier as part of the test suite."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

PARITY = Path(__file__).resolve().parents[2] / "schemas" / "verify_parity.py"


def test_schemas_in_parity_with_ts_and_sol() -> None:
    result = subprocess.run(
        [sys.executable, str(PARITY)], capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stdout + result.stderr
