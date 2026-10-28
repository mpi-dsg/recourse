"""Run an RQ across independent trace seeds for confidence intervals.

Ordinary single-seed runs retain their configured repetition count and the
``base seed + repetition`` schedule in ``runner.run_cell``. This wrapper
deliberately executes one repetition for each requested seed, so every row
entering a confidence interval has a unique independent trace seed. The
manifest records that statistical unit and the realized seed schedule.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

import pandas as pd

from .drivers import ensure_fresh_output_dir, run_driver

DEFAULT_BASE_SEEDS: tuple[int, ...] = tuple(range(42, 52))  # 42..51 inclusive


@dataclass(frozen=True)
class MultiSeedArtifact:
    metrics_path: Path
    manifest_path: Path
    per_seed_dirs: tuple[Path, ...]


def run_driver_multi_seed(
    rq: str,
    output_dir: Path,
    *,
    config: Mapping[str, Any],
    base_seeds: Sequence[int] = DEFAULT_BASE_SEEDS,
    keep_per_seed: bool = True,
) -> MultiSeedArtifact:
    """Run ``run_driver`` at each ``base_seed`` and aggregate the parquets.

    Each base-seed run writes into ``output_dir / "seed-<n>"``. The combined
    frame is written to ``output_dir / "metrics.parquet"`` with a ``base_seed``
    column injected for every row, and a ``multi_seed_manifest.json`` records
    the sweep configuration, realized seeds, and statistical unit.

    ``keep_per_seed=False`` deletes the per-seed cell directories after
    aggregation (the metrics parquets are read into memory before deletion).
    The aggregated parquet is always preserved.
    """

    if not base_seeds:
        raise ValueError("base_seeds must be non-empty")
    realized_seeds = [int(seed) for seed in base_seeds]
    if len(realized_seeds) != len(set(realized_seeds)):
        raise ValueError("base_seeds must be unique")
    ensure_fresh_output_dir(output_dir)

    per_seed_dirs: list[Path] = []
    frames: list[pd.DataFrame] = []
    artifacts_total = 0
    git_commits: set[str] = set()
    git_dirty = False
    for seed in realized_seeds:
        seed_dir = output_dir / f"seed-{seed}"
        per_seed_config = dict(config)
        per_seed_config["seed"] = int(seed)
        # Each row entering the CI is one independent trace seed. The ordinary
        # single-seed driver still honors its configured repetition count.
        per_seed_config["repetitions"] = 1
        artifact = run_driver(rq, seed_dir, config=per_seed_config)
        frame = pd.read_parquet(artifact.metrics_path)
        frame["base_seed"] = int(seed)
        frames.append(frame)
        per_seed_dirs.append(seed_dir)
        manifest = json.loads(artifact.manifest_path.read_text())
        artifacts_total += int(manifest.get("artifacts", 0))
        git_commits.add(str(manifest.get("gitCommit", "unknown")))
        git_dirty = git_dirty or bool(manifest.get("gitDirty", True))

    combined = pd.concat(frames, ignore_index=True)
    metrics_path = output_dir / "metrics.parquet"
    combined.to_parquet(metrics_path, index=False)

    manifest_path = output_dir / "multi_seed_manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "rq": rq,
                "baseSeeds": realized_seeds,
                "realizedSeeds": realized_seeds,
                "seedSchedule": [
                    {"baseSeed": seed, "realizedSeed": seed}
                    for seed in realized_seeds
                ],
                "statisticalUnit": "independent_trace_seed",
                "sourceConfigRepetitions": int(config.get("repetitions", 1)),
                "perSeedRepetitions": 1,
                "perCellRepetitions": 1,
                "samplesPerCell": len(realized_seeds),
                "totalArtifacts": artifacts_total,
                "config": dict(config),
                "configHash": _config_hash(dict(config)),
                "gitCommit": (
                    next(iter(git_commits))
                    if len(git_commits) == 1
                    else "mixed"
                ),
                "gitDirty": git_dirty,
            },
            sort_keys=True,
            indent=2,
        )
        + "\n"
    )

    if not keep_per_seed:
        for seed_dir in per_seed_dirs:
            shutil.rmtree(seed_dir, ignore_errors=True)

    return MultiSeedArtifact(
        metrics_path=metrics_path,
        manifest_path=manifest_path,
        per_seed_dirs=tuple(per_seed_dirs),
    )


def _config_hash(config: Mapping[str, Any]) -> str:
    """Stable SHA-256 over a deterministic JSON encoding of the config."""
    encoded = json.dumps(_jsonable(config), sort_keys=True).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _jsonable(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)
