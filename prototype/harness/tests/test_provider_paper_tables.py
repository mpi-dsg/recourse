from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import pytest


PROTOTYPE_DIR = Path(__file__).resolve().parents[2]


def _load_script(filename: str) -> ModuleType:
    path = PROTOTYPE_DIR / "scripts" / filename
    spec = importlib.util.spec_from_file_location(filename.removesuffix(".py"), path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    ("filename", "macro", "label"),
    [
        (
            "provider-postgres-emit.py",
            "tableproviderpostgres",
            "Postgres-local",
        ),
        (
            "provider-bench-git-to-parquet.py",
            "tableprovidergit",
            "Git-local",
        ),
        (
            "provider-bench-cloud-to-parquet.py",
            "tableprovidercloud",
            "Cloud-local",
        ),
    ],
)
def test_provider_paper_table_contains_only_deterministic_outcomes(
    filename: str,
    macro: str,
    label: str,
) -> None:
    module = _load_script(filename)

    rendered = module.render_table(33, 16, 17)

    assert f"\\def\\{macro}" in rendered
    assert f"{label} & 33 & 16 & 17 \\\\%" in rendered
    assert rendered.count("&") == 3
