from __future__ import annotations

from pathlib import Path

import pytest

from recourse_harness.traces import Trace, generate_trace


FIXTURE = Path(__file__).parent / "fixtures" / "trace_seed42.jsonl"


def test_seeded_trace_matches_checked_in_jsonl_fixture() -> None:
    trace = generate_trace(
        num_calls=3,
        failure_density=0.5,
        concurrency=2,
        scope_distribution={"tenant": 1.0},
        seed=42,
    )

    assert trace.to_jsonl() == FIXTURE.read_text()


def test_trace_jsonl_round_trips_without_reordering() -> None:
    original = generate_trace(num_calls=5, failure_density=0.4, concurrency=3, seed=7)

    parsed = Trace.from_jsonl(original.to_jsonl())

    assert parsed == original
    assert [call.call_id for call in parsed.calls] == [call.call_id for call in original.calls]


def test_trace_jsonl_rejects_mixed_trace_ids() -> None:
    first = generate_trace(num_calls=1, failure_density=0.5, concurrency=1, seed=1)
    second = generate_trace(num_calls=1, failure_density=0.5, concurrency=1, seed=2)

    with pytest.raises(ValueError, match="mixed trace ids"):
        Trace.from_jsonl(first.to_jsonl() + second.to_jsonl())


def test_failure_density_and_workload_parameters_change_trace_shape() -> None:
    no_failures = generate_trace(num_calls=4, failure_density=0.0, concurrency=2, seed=11)
    all_failures = generate_trace(num_calls=4, failure_density=1.0, concurrency=2, seed=11)
    thirty_percent = generate_trace(num_calls=10, failure_density=0.3, concurrency=2, seed=11)
    half_failures = generate_trace(num_calls=6, failure_density=0.5, concurrency=2, seed=11)
    git_only = generate_trace(
        num_calls=4,
        failure_density=0.5,
        concurrency=2,
        seed=11,
        workload="git",
    )

    assert {call.ground_truth for call in no_failures.calls} == {"ok"}
    assert "ok" not in {call.ground_truth for call in all_failures.calls}
    assert sum(call.ground_truth != "ok" for call in thirty_percent.calls) == 3
    assert {call.ground_truth for call in half_failures.calls[-3:]} == {
        "will_fail_compensable",
        "policy_violation",
        "will_fail_excluded",
    }
    assert {call.workload for call in git_only.calls} == {"git"}
    assert {call.action for call in git_only.calls} == {"force-push"}


@pytest.mark.parametrize(
    "kwargs",
    [
        {"num_calls": 0, "failure_density": 0.5, "concurrency": 1, "seed": 1},
        {"num_calls": 1, "failure_density": -0.1, "concurrency": 1, "seed": 1},
        {"num_calls": 1, "failure_density": 1.1, "concurrency": 1, "seed": 1},
        {"num_calls": 1, "failure_density": 0.5, "concurrency": 0, "seed": 1},
        {
            "num_calls": 1,
            "failure_density": 0.5,
            "concurrency": 1,
            "seed": 1,
            "workload": "unknown",
        },
        {
            "num_calls": 1,
            "failure_density": 0.5,
            "concurrency": 1,
            "seed": 1,
            "correlation_prob": -0.1,
            "correlation_burst_size": 2,
        },
        {
            "num_calls": 1,
            "failure_density": 0.5,
            "concurrency": 1,
            "seed": 1,
            "correlation_prob": 0.3,
            "correlation_burst_size": -1,
        },
    ],
)
def test_generate_trace_rejects_invalid_configuration(kwargs: dict) -> None:
    with pytest.raises(ValueError):
        generate_trace(**kwargs)


def test_correlation_burst_tags_victims_with_shared_group_index() -> None:
    """A triggered correlation epoch must tag every victim with the epoch index."""
    # Sweep a few seeds to find one that triggers under p=1.0 (always triggers).
    trace = generate_trace(
        num_calls=8,
        failure_density=0.0,
        concurrency=2,
        seed=7,
        workload="postgres",
        correlation_prob=1.0,
        correlation_burst_size=4,
    )
    tagged = [c for c in trace.calls if "correlationBurstIndex" in c.metadata]
    # 8 calls / burst_size 4 = 2 epochs, both fire at p=1.0.
    assert len(tagged) == 8
    epoch_indices = {c.metadata["correlationBurstIndex"] for c in tagged}
    assert epoch_indices == {0, 1}
    # All burst victims become compensable failures with full residual.
    for call in tagged:
        assert call.ground_truth == "will_fail_compensable"
        assert call.residual_harm == call.gross_harm


def test_correlation_burst_is_a_noop_when_disabled() -> None:
    """Default ``correlation_*`` arguments must not mutate the trace."""
    without = generate_trace(
        num_calls=8,
        failure_density=0.5,
        concurrency=2,
        seed=7,
        workload="postgres",
    )
    with_zero = generate_trace(
        num_calls=8,
        failure_density=0.5,
        concurrency=2,
        seed=7,
        workload="postgres",
        correlation_prob=0.0,
        correlation_burst_size=8,
    )
    assert without == with_zero
