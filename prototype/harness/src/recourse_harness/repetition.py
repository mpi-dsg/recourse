"""Reporting policy for repetition counts."""
from __future__ import annotations

from dataclasses import dataclass
from random import Random
from statistics import mean, median

BOOTSTRAP_REPETITIONS = 10_000


@dataclass(frozen=True)
class RepetitionSummary:
    kind: str
    display: str
    resampling_unit: str | None = None


def summarize_repetitions(values: list[float], *, min_reps_for_ci: int = 10) -> RepetitionSummary:
    if not values:
        raise ValueError("values must not be empty")
    if len(values) < min_reps_for_ci:
        return RepetitionSummary(
            kind="median_range",
            display=f"{median(values):.3f} ({min(values):.3f}-{max(values):.3f})",
        )
    ci_half_width = _bootstrap_half_width(values)
    return RepetitionSummary(
        kind="mean_ci",
        display=f"{mean(values):.3f} ± {ci_half_width:.3f}",
        resampling_unit="trace_seed",
    )


def _bootstrap_half_width(values: list[float]) -> float:
    rng = Random(0)
    count = len(values)
    means = []
    for _ in range(BOOTSTRAP_REPETITIONS):
        means.append(sum(values[rng.randrange(count)] for _ in range(count)) / count)
    means.sort()
    lower = means[int(0.025 * (BOOTSTRAP_REPETITIONS - 1))]
    upper = means[int(0.975 * (BOOTSTRAP_REPETITIONS - 1))]
    return (upper - lower) / 2
