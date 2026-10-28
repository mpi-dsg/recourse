from __future__ import annotations

import pytest

from recourse_harness.repetition import summarize_repetitions


def test_repetition_policy_reports_median_range_below_minimum_reps() -> None:
    summary = summarize_repetitions([1, 2, 3, 4, 5, 6, 7, 8, 9], min_reps_for_ci=10)

    assert summary.kind == "median_range"
    assert summary.display == "5.000 (1.000-9.000)"


def test_repetition_policy_reports_bootstrap_ci_at_minimum_reps() -> None:
    summary = summarize_repetitions([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], min_reps_for_ci=10)

    assert summary.kind == "mean_ci"
    assert summary.display.startswith("5.500 ± ")
    assert summary.resampling_unit == "trace_seed"


def test_repetition_policy_rejects_empty_inputs() -> None:
    with pytest.raises(ValueError, match="values must not be empty"):
        summarize_repetitions([])
