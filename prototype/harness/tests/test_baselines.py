from __future__ import annotations

from dataclasses import replace

import pytest

from recourse_harness.baselines import BASELINE_NAMES, runner_for_baseline
from recourse_harness.metrics import compute_metrics
from recourse_harness.traces import generate_trace


@pytest.mark.parametrize("baseline", BASELINE_NAMES)
def test_baselines_are_deterministic_and_metrics_compatible(baseline: str) -> None:
    trace = generate_trace(num_calls=6, failure_density=0.5, concurrency=2, seed=42)
    runner = runner_for_baseline(baseline, seed=99, approval_rate=0.5)

    first = runner.run(trace)
    second = runner.run(trace)

    assert first == second
    row = compute_metrics(first)
    assert row["baseline"] == baseline
    assert row["actions"] == 6
    assert 0 <= row["coverage"] <= 1


def test_recourse_baseline_does_not_route_from_expected_label() -> None:
    trace = generate_trace(num_calls=3, failure_density=0.5, concurrency=2, seed=42)
    call = trace.calls[1]
    mislabeled = replace(call, metadata={**call.metadata, "faultRoute": "excluded"})

    result = runner_for_baseline("recourse").run(trace.__class__(trace.trace_id, (mislabeled,)))
    decision = result.actions[0]

    assert decision.expected_route == "excluded"
    assert decision.route == "optimistic"


def test_recourse_baseline_records_rejection_reasons_on_admission() -> None:
    """Admitted calls record ``"admitted"``; non-recourse baselines stay ``None``."""
    from recourse_harness.faults import FaultClass, inject_fault

    trace = generate_trace(num_calls=3, failure_density=0.5, concurrency=2, seed=42)
    # Inject NONE so admission passes; routing should be optimistic.
    calls = tuple(
        inject_fault(c, FaultClass.NONE, seed=42).mutated_call for c in trace.calls
    )
    recourse_result = runner_for_baseline("recourse", seed=42).run(
        trace.__class__(trace.trace_id, calls)
    )
    reasons = {a.rejection_reason for a in recourse_result.actions}
    assert reasons == {"admitted"}

    # OBS_HIDE_PRESTATE forces an EvidenceSchemaOK rejection on compensable calls.
    bad = tuple(
        inject_fault(c, FaultClass.OBS_HIDE_PRESTATE, seed=42).mutated_call
        for c in trace.calls
    )
    arbitrated_result = runner_for_baseline("recourse", seed=42).run(
        trace.__class__(trace.trace_id, bad)
    )
    arbitrated_reasons = {a.rejection_reason for a in arbitrated_result.actions}
    # At least one call should be flagged with EvidenceSchemaOK as the failed
    # sub-predicate (depending on the call's ground_truth — "ok" calls have no
    # residual to evidence so they may admit; the compensable ones reject).
    assert "EvidenceSchemaOK" in arbitrated_reasons

    # Non-recourse baselines do not record a sub-predicate label.
    other = runner_for_baseline("none").run(trace)
    assert all(a.rejection_reason is None for a in other.actions)


def test_baselines_apply_only_their_documented_recovery_capabilities() -> None:
    trace = generate_trace(
        num_calls=3,
        failure_density=1.0,
        concurrency=1,
        seed=42,
        workload="postgres",
    )
    compensable = trace.calls[0]
    assert compensable.ground_truth == "will_fail_compensable"

    decisions = {
        baseline: runner_for_baseline(
            baseline,
            seed=42,
            approval_rate=1.0,
        ).run(trace).actions[0]
        for baseline in BASELINE_NAMES
    }

    for baseline in ("none", "human", "oap"):
        decision = decisions[baseline]
        assert decision.residual_harm == compensable.gross_harm
        assert decision.recovery_latency_ms == 0
        assert decision.payout_amount == 0
        assert decision.bond_available == 0

    for baseline in ("atomix", "auth_plus_local", "centralized", "recourse"):
        decision = decisions[baseline]
        assert decision.residual_harm == compensable.residual_harm
        assert decision.recovery_latency_ms == 1200

    for baseline in ("atomix", "auth_plus_local"):
        assert decisions[baseline].payout_amount == 0
        assert decisions[baseline].bond_available == 0

    for baseline in ("centralized", "recourse"):
        assert decisions[baseline].payout_amount > 0
        assert decisions[baseline].bond_available > 0


def test_authorization_baselines_alone_reject_policy_violations() -> None:
    trace = generate_trace(
        num_calls=3,
        failure_density=1.0,
        concurrency=1,
        seed=42,
        workload="postgres",
    )
    assert trace.calls[1].ground_truth == "policy_violation"

    decisions = {
        baseline: runner_for_baseline(
            baseline,
            seed=42,
            approval_rate=1.0,
        ).run(trace).actions[1]
        for baseline in ("none", "oap", "atomix", "auth_plus_local")
    }

    for baseline in ("none", "atomix"):
        assert decisions[baseline].eligible is True
        assert decisions[baseline].executed is True

    for baseline in ("oap", "auth_plus_local"):
        assert decisions[baseline].eligible is False
        assert decisions[baseline].executed is False


def test_none_and_local_baselines_do_not_inherit_human_approval_gate() -> None:
    trace = generate_trace(
        num_calls=3,
        failure_density=1.0,
        concurrency=1,
        seed=42,
        workload="postgres",
    )
    assert trace.calls[2].ground_truth == "will_fail_excluded"

    for baseline in ("none", "oap", "atomix", "auth_plus_local"):
        result = runner_for_baseline(
            baseline,
            seed=42,
            approval_rate=0.0,
        ).run(trace)
        excluded = result.actions[2]
        assert excluded.executed is True
        assert excluded.required_human_approval is False
        assert excluded.used_human_approval is False


def test_human_baseline_tracks_actual_approval_use_and_has_zero_coverage() -> None:
    trace = generate_trace(
        num_calls=3,
        failure_density=1.0,
        concurrency=1,
        seed=42,
        workload="postgres",
    )
    result = runner_for_baseline(
        "human",
        seed=42,
        approval_rate=1.0,
    ).run(trace)

    assert all(action.executed for action in result.actions)
    assert all(action.required_human_approval for action in result.actions)
    assert all(action.used_human_approval for action in result.actions)
    assert compute_metrics(result)["coverage"] == 0.0


def test_centralized_and_recourse_share_approval_recovery_and_payout_semantics() -> None:
    trace = generate_trace(
        num_calls=3,
        failure_density=1.0,
        concurrency=1,
        seed=42,
        workload="postgres",
    )

    for approval_rate in (0.0, 1.0):
        centralized = runner_for_baseline(
            "centralized",
            seed=42,
            approval_rate=approval_rate,
        ).run(trace)
        recourse = runner_for_baseline(
            "recourse",
            seed=42,
            approval_rate=approval_rate,
        ).run(trace)

        centralized_metrics = compute_metrics(centralized)
        recourse_metrics = compute_metrics(recourse)
        for metric in ("gross_harm", "recovered", "covered", "uncompensated", "coverage"):
            assert centralized_metrics[metric] == recourse_metrics[metric]

        for index in (1, 2):
            assert (
                centralized.actions[index].used_human_approval
                == recourse.actions[index].used_human_approval
            )
