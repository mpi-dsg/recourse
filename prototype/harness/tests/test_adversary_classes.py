"""Unit tests for the four adversarial behaviour classes."""

from __future__ import annotations

from recourse_harness.adversaries import (
    AdversaryClass,
    AdversaryContext,
    apply_adversary,
)
from recourse_harness.baselines import runner_for_baseline
from recourse_harness.faults import FaultClass
from recourse_harness.metrics import ActionDecision, compute_metrics
from recourse_harness.traces import ProposedToolCall, generate_trace


def _compensable_recourse_decision() -> tuple[ActionDecision, ProposedToolCall]:
    """Build a (decision, call) pair for a healthy compensable claim."""
    trace = generate_trace(
        num_calls=6,
        failure_density=0.5,
        concurrency=2,
        seed=42,
        workload="postgres",
    )
    # Use a call whose ground_truth is "will_fail_compensable" (first failure slot).
    call = next(c for c in trace.calls if c.ground_truth == "will_fail_compensable")
    # Inject the NONE fault so faultRoute metadata is set to "optimistic".
    from recourse_harness.faults import inject_fault

    call = inject_fault(call, FaultClass.NONE, seed=42).mutated_call
    # Build a baseline decision via the recourse runner so we hit the real
    # routing code path, then read the single ActionDecision back.
    result = runner_for_baseline("recourse", seed=42).run(
        trace.__class__(trace.trace_id, (call,))
    )
    return result.actions[0], call


def test_dishonest_claimant_routes_to_arbitrated_and_zeroes_payout() -> None:
    decision, call = _compensable_recourse_decision()
    assert decision.route == "optimistic"  # sanity: honest path

    ctx = AdversaryContext(AdversaryClass.DISHONEST_CLAIMANT, seed=42)
    mutated = apply_adversary(decision, call, ctx)

    assert mutated.route == "arbitrated"
    assert mutated.payout_amount == 0
    # Bond stays escrowed (slashed) -- locked >= original.
    assert mutated.bond_available >= decision.bond_available
    # Expected route remains the honest "optimistic" so this surfaces as a
    # false-rejection in compute_metrics (the dispute won, claimant slashed).
    assert mutated.expected_route == "optimistic"


def test_absent_challenger_lets_arbitrated_claims_settle_optimistically() -> None:
    # Build an arbitrated-expected call: OBS_HIDE_PRESTATE pre-registers
    # the "arbitrated" route.
    trace = generate_trace(
        num_calls=6,
        failure_density=0.5,
        concurrency=2,
        seed=7,
        workload="postgres",
    )
    call = next(c for c in trace.calls if c.ground_truth == "will_fail_compensable")
    from recourse_harness.faults import inject_fault

    call = inject_fault(call, FaultClass.OBS_HIDE_PRESTATE, seed=7).mutated_call
    result = runner_for_baseline("recourse", seed=7).run(
        trace.__class__(trace.trace_id, (call,))
    )
    decision = result.actions[0]
    assert decision.expected_route == "arbitrated"
    assert decision.route == "arbitrated"

    ctx = AdversaryContext(AdversaryClass.ABSENT_CHALLENGER, seed=7)
    mutated = apply_adversary(decision, call, ctx)

    # With no challenger online, the optimistic window closes wrongly --
    # the route flips to "optimistic" while expected stays "arbitrated".
    assert mutated.route == "optimistic"
    assert mutated.expected_route == "arbitrated"
    assert mutated.payout_amount > 0

    # And compute_metrics flags this as false acceptance.
    from dataclasses import replace as dc_replace
    rerun = dc_replace(result, actions=(mutated,), adversary_class="ABSENT_CHALLENGER")
    row = compute_metrics(rerun)
    assert row["false_acceptance"] > 0.0


def test_bond_stress_caps_payout_and_surfaces_shortfall_deterministically() -> None:
    decision, call = _compensable_recourse_decision()
    ctx_a = AdversaryContext(AdversaryClass.BOND_STRESS, seed=99)
    ctx_b = AdversaryContext(AdversaryClass.BOND_STRESS, seed=99)
    mutated_a = apply_adversary(decision, call, ctx_a)
    mutated_b = apply_adversary(decision, call, ctx_b)

    # Determinism: same seed/inputs -> same mutation.
    assert mutated_a == mutated_b

    # The contract either falls into the correlated overrun bucket (payout
    # capped) or stays untouched.  Either way, the result is deterministic
    # and never *increases* the bond.
    assert mutated_a.bond_available <= decision.bond_available
    assert mutated_a.payout_amount <= decision.payout_amount


def test_colluding_challengers_pushes_optimistic_into_arbitration() -> None:
    decision, call = _compensable_recourse_decision()
    assert decision.route == "optimistic"
    assert decision.expected_route == "optimistic"

    # Sweep a few seeds so we observe both arms of the worst-case branch:
    # half should be captured (payout = 0), half overruled by arbitrator
    # (payout preserved).
    captured = 0
    overruled = 0
    for seed in range(40):
        ctx = AdversaryContext(AdversaryClass.COLLUDING_CHALLENGERS, seed=seed)
        m = apply_adversary(decision, call, ctx)
        assert m.route == "arbitrated"
        if m.payout_amount == 0:
            captured += 1
        else:
            overruled += 1
    # Both arms must be exercised (this is the load-bearing arbitrator
    # guarantee from main.tex IX.H).
    assert captured > 0
    assert overruled > 0


def test_adversary_none_is_identity() -> None:
    decision, call = _compensable_recourse_decision()
    ctx = AdversaryContext(AdversaryClass.NONE, seed=1)
    assert apply_adversary(decision, call, ctx) == decision


def test_non_recourse_baselines_ignore_adversary_class() -> None:
    trace = generate_trace(num_calls=6, failure_density=0.5, concurrency=2, seed=42)
    a = runner_for_baseline("centralized", seed=1, adversary_class="DISHONEST_CLAIMANT").run(trace)
    b = runner_for_baseline("centralized", seed=1, adversary_class="NONE").run(trace)
    # Adversaries only target the recourse routing surface; centralized
    # baseline output should be identical (modulo recorded adversary tag).
    assert a.actions == b.actions
