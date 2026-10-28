"""Pure claim-routing module used by the RQ5 harness."""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Mapping

from .eligibility import RuntimeContext
from .settleability import ActionInstance, Predicate, SettlementRoute, is_settleable


@dataclass(frozen=True)
class FaultDescriptor:
    fault_class: str
    observed_overrides: Mapping[str, Any] | None = None
    pre_registered_route: SettlementRoute | str | None = None


@dataclass(frozen=True)
class VerifiedObservations:
    """External facts verified before the pure routing decision is evaluated."""

    observed_scope: Mapping[str, Any]
    evidence_provenance: str
    available_collateral: int
    excluded_harms: frozenset[str]
    effect_signature_verified: bool
    recovery_signature_verified: bool
    effect_receipt_digest: str


@dataclass(frozen=True)
class RoutingDecision:
    route: SettlementRoute
    failed_predicate: Predicate | None
    reason: str
    payout: int
    ground_truth_route: SettlementRoute | None = None


def route_claim(
    k: Mapping[str, Any],
    o: Mapping[str, Any],
    r: Mapping[str, Any],
    fault_descriptor: FaultDescriptor | None = None,
    *,
    runtime_ctx: RuntimeContext | None = None,
    observations: VerifiedObservations | None = None,
) -> RoutingDecision:
    """Route a residual claim using receipts and independently verified runtime facts."""

    contract = copy.deepcopy(dict(k))
    effect = copy.deepcopy(dict(o))
    recovery = copy.deepcopy(dict(r))
    observed_scope = (
        copy.deepcopy(observations.observed_scope) if observations is not None else None
    )
    evidence_provenance = (
        observations.evidence_provenance if observations is not None else None
    )
    available_collateral = (
        observations.available_collateral if observations is not None else None
    )
    excluded_harms = observations.excluded_harms if observations is not None else None
    effect_signature_verified = (
        observations.effect_signature_verified if observations is not None else False
    )
    recovery_signature_verified = (
        observations.recovery_signature_verified if observations is not None else False
    )
    effect_receipt_digest = (
        observations.effect_receipt_digest if observations is not None else None
    )
    ground_truth_route: SettlementRoute | None = None

    if fault_descriptor is not None:
        ground_truth_route = _coerce_route(fault_descriptor.pre_registered_route)
        overrides = fault_descriptor.observed_overrides or {}
        _merge_if_present(contract, overrides.get("contract"))
        _merge_if_present(effect, overrides.get("effect_receipt"))
        _merge_if_present(recovery, overrides.get("recovery_receipt"))
        if "observed_scope" in overrides:
            observed_scope = copy.deepcopy(overrides["observed_scope"])
        if "evidence_provenance" in overrides:
            evidence_provenance = overrides["evidence_provenance"]
        if "available_collateral" in overrides:
            available_collateral = overrides["available_collateral"]
        if "excluded_harms" in overrides:
            excluded_harms = frozenset(overrides["excluded_harms"])
        if "effect_signature_verified" in overrides:
            effect_signature_verified = bool(overrides["effect_signature_verified"])
        if "recovery_signature_verified" in overrides:
            recovery_signature_verified = bool(overrides["recovery_signature_verified"])
        if "effect_receipt_digest" in overrides:
            effect_receipt_digest = overrides["effect_receipt_digest"]

    ctx = runtime_ctx or RuntimeContext.empty()
    result = is_settleable(
        ActionInstance(
            contract=contract,
            effect_receipt=effect,
            recovery_receipt=recovery,
            runtime_ctx=ctx,
            observed_scope=observed_scope,
            evidence_provenance=evidence_provenance,
            available_collateral=available_collateral,
            excluded_harms=excluded_harms,
            effect_signature_verified=effect_signature_verified,
            recovery_signature_verified=recovery_signature_verified,
            effect_receipt_digest=effect_receipt_digest,
        )
    )
    return RoutingDecision(
        route=result.route,
        failed_predicate=result.failed_predicate,
        reason=result.reason,
        payout=result.payout,
        ground_truth_route=ground_truth_route,
    )


def _merge_if_present(target: dict[str, Any], patch: Any) -> None:
    if patch is None:
        return
    for key, value in dict(patch).items():
        if isinstance(value, Mapping) and isinstance(target.get(key), dict):
            _merge_if_present(target[key], value)
        else:
            target[key] = copy.deepcopy(value)


def _coerce_route(route: SettlementRoute | str | None) -> SettlementRoute | None:
    if route is None:
        return None
    return route if isinstance(route, SettlementRoute) else SettlementRoute(str(route))
