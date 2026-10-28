"""Adversarial behaviour classes layered on top of FaultClass routing.

These model byzantine actors *after* routing has been determined by the
predicate pipeline.  They are deliberately orthogonal to ``FaultClass``: a
cell sweep iterates ``(fault_class x adversary_class)`` and the adversary
mutates per-action outcomes (route, payout, bond, residual harm) so the
existing metric extractor (``metrics.compute_metrics``) reports
false-acceptance, false-rejection, residual loss, and bond shortfall.

All behaviours are deterministic given the cell seed.  Where modelling the
full multi-party game is impractical (e.g., n-of-m colluding challengers),
we encode the *worst-case* bound from main.tex §IX.H "Threats to Validity"
and NOTE-comment the choice next to the implementation.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Iterable

from .metrics import ActionDecision
from .traces import ProposedToolCall


class AdversaryClass(StrEnum):
    """Adversarial behaviour layered over the baseline predicate pipeline."""

    NONE = "NONE"
    # Claimant inflates the alleged residual loss and signs the inflated
    # figure with a valid EIP-712 signature over forged pre-state.
    DISHONEST_CLAIMANT = "DISHONEST_CLAIMANT"
    # No honest challenger comes online within the optimistic window.
    ABSENT_CHALLENGER = "ABSENT_CHALLENGER"
    # Correlated concurrent claims exceed the bond cap; the contract must
    # apply pro-rata.
    BOND_STRESS = "BOND_STRESS"
    # The challenger network is Sybil/captured and votes against honest
    # claims.  The arbitrator-side guarantee is the only thing standing.
    COLLUDING_CHALLENGERS = "COLLUDING_CHALLENGERS"


# Inflation factor used by DISHONEST_CLAIMANT.  Empirically tuned so that
# the inflated residual exceeds the bond cap (which equals payout_hint by
# construction in baselines._classifier_inputs) — this is what turns the
# attack into a measurable bond shortfall.
_DISHONEST_INFLATION = 4


@dataclass(frozen=True)
class AdversaryContext:
    """Resolved adversary metadata available to the recourse runner."""

    adversary_class: AdversaryClass
    seed: int

    @classmethod
    def from_str(cls, name: str | None, *, seed: int) -> "AdversaryContext":
        if name is None or name == "":
            return cls(AdversaryClass.NONE, seed=seed)
        try:
            return cls(AdversaryClass(str(name)), seed=seed)
        except ValueError:
            return cls(AdversaryClass[str(name)], seed=seed)


def _adversary_rand(ctx: AdversaryContext, *, call_id: str, salt: str) -> float:
    """Deterministic [0, 1) draw keyed on (seed, call_id, salt)."""
    digest = hashlib.sha256(
        f"{ctx.seed}|{ctx.adversary_class.value}|{call_id}|{salt}".encode("utf-8")
    ).digest()
    return int.from_bytes(digest[:8], "big") / float(1 << 64)


def apply_adversary(
    decision: ActionDecision,
    call: ProposedToolCall,
    ctx: AdversaryContext,
    *,
    siblings: Iterable[ActionDecision] = (),
) -> ActionDecision:
    """Return a possibly mutated decision reflecting the adversary's behaviour.

    Only the *recourse* baseline should call this; other baselines lack the
    optimistic/arbitrated routing surface that the adversaries target.
    ``siblings`` is the set of decisions in the same concurrency group; it
    is consulted only by BOND_STRESS for pro-rata accounting.
    """
    if ctx.adversary_class is AdversaryClass.NONE:
        return decision
    if call.ground_truth == "ok" and ctx.adversary_class is not AdversaryClass.DISHONEST_CLAIMANT:
        # Adversaries that need an open claim no-op on benign actions; the
        # claim never reaches the optimistic window.
        return decision
    if ctx.adversary_class is AdversaryClass.DISHONEST_CLAIMANT:
        return _apply_dishonest(decision, call, ctx)
    if ctx.adversary_class is AdversaryClass.ABSENT_CHALLENGER:
        return _apply_absent_challenger(decision, call, ctx)
    if ctx.adversary_class is AdversaryClass.BOND_STRESS:
        return _apply_bond_stress(decision, call, ctx, siblings)
    if ctx.adversary_class is AdversaryClass.COLLUDING_CHALLENGERS:
        return _apply_colluding(decision, call, ctx)
    return decision


def _apply_dishonest(
    decision: ActionDecision, call: ProposedToolCall, ctx: AdversaryContext
) -> ActionDecision:
    """Inflated residual signed over forged pre-state.

    Modelled outcomes (main.tex §III.E + §IX.G):
      * If a challenger disputes (default), the predicate detects the
        forgery and routes to ``arbitrated``; the claimant is slashed.  We
        encode the slash as zero payout with bond fully locked.
      * If the optimistic window closes without a dispute (composes with
        ABSENT_CHALLENGER) the inflated payout settles — measured as a
        false-acceptance plus bond shortfall.
    """
    if decision.route not in {"optimistic", "arbitrated"}:
        return decision
    inflated_residual = decision.residual_harm * _DISHONEST_INFLATION
    return replace(
        decision,
        route="arbitrated",
        # Slashed: claimant gets no payout, the bond stays escrowed.
        payout_amount=0,
        # Residual on the books reflects the *true* (un-inflated) harm.
        residual_harm=decision.residual_harm,
        # Expected route was optimistic for a honest compensable claim;
        # forced arbitration shows up as a (correct) false-rejection from
        # the claimant's perspective.
        expected_route="optimistic",
        # Keep bond visible so bond_utilization captures the lock.
        bond_available=max(decision.bond_available, inflated_residual),
    )


def _apply_absent_challenger(
    decision: ActionDecision, call: ProposedToolCall, ctx: AdversaryContext
) -> ActionDecision:
    """Optimistic window expires with no challenger online.

    Worst case (main.tex §IX.H, threat T-AC) is two-armed:
      1. An objectively-wrong claim that *should* have been arbitrated
         settles optimistically because no challenger ever disputed it.
      2. Even an honest optimistic-eligible claim composes badly with a
         dishonest claimant: with no challenger, the inflated figure
         would settle.  We encode the worst-case bound by inflating the
         payout to the claimant's inflated figure (same factor as
         DISHONEST_CLAIMANT), producing a measurable false-acceptance
         and bond shortfall even when faultClass=NONE.
    """
    if decision.expected_route is None:
        return decision
    if decision.expected_route != "optimistic":
        # Arm 1: arbitrated-expected claim settles optimistically anyway.
        payout = max(decision.payout_amount, decision.residual_harm)
        return replace(
            decision,
            route="optimistic",
            payout_amount=payout,
            bond_available=max(decision.bond_available, payout),
        )
    # Arm 2 (composition with a latent dishonest claimant): inflated
    # payout settles optimistically because no challenger files.
    if decision.route != "optimistic":
        return decision
    inflated = decision.residual_harm * _DISHONEST_INFLATION
    return replace(
        decision,
        payout_amount=max(decision.payout_amount, inflated),
        # Bond is fixed by the contract; the *excess* loss is the shortfall.
        bond_available=decision.bond_available,
        # Keep expected_route="optimistic" so this scores as bond shortfall
        # / uncompensated rather than false-acceptance (route matches
        # expected). The residual_harm field carries the inflated figure
        # so under_bond_shortfall fires.
        residual_harm=max(decision.residual_harm, inflated),
    )


def _apply_bond_stress(
    decision: ActionDecision,
    call: ProposedToolCall,
    ctx: AdversaryContext,
    siblings: Iterable[ActionDecision],
) -> ActionDecision:
    """Correlated concurrent claims overrun the per-contract bond cap.

    NOTE: modelling true cross-claim pro-rata in a synthetic harness needs
    a multi-claim contract instance; the bond cap is itself per-contract
    in the prototype.  We encode the *worst-case bound* by halving the
    available bond against the residual (i.e., two correlated claimants
    competing for the same cap) and recording the shortfall.
    """
    if decision.route not in {"optimistic", "arbitrated"}:
        return decision
    # Deterministic correlation: half the calls share the same overrun
    # bucket; the other half see proportional shortfall.
    correlated = _adversary_rand(ctx, call_id=call.call_id, salt="bond") < 0.5
    if not correlated:
        return decision
    capped_bond = max(0, decision.bond_available // 2)
    capped_payout = min(decision.payout_amount, capped_bond)
    # siblings reserved for future multi-claim pro-rata; consume to keep
    # the signature stable.
    _ = list(siblings)
    return replace(
        decision,
        bond_available=capped_bond,
        payout_amount=capped_payout,
    )


def _apply_colluding(
    decision: ActionDecision, call: ProposedToolCall, ctx: AdversaryContext
) -> ActionDecision:
    """Sybil / captured challenger network votes against honest claims.

    Worst case bound (main.tex §IX.H, threat T-CC): every honest
    optimistic-eligible claim is challenged and pushed to arbitration.
    Half of those (the captured fraction) are then *wrongly rejected* by
    the colluding panel — that's the false-rejection signal.  The
    remaining half survive because the arbitrator-side check is
    load-bearing — this is exactly the guarantee the threats section
    relies on.
    """
    if decision.route != "optimistic" or decision.expected_route != "optimistic":
        return decision
    flipped = _adversary_rand(ctx, call_id=call.call_id, salt="collude") < 0.5
    if not flipped:
        # Honest arbitrator overrules: route to arbitrated but pay out.
        return replace(decision, route="arbitrated")
    # Captured arbitrator: wrong rejection — no payout despite valid claim.
    return replace(
        decision,
        route="arbitrated",
        payout_amount=0,
    )
