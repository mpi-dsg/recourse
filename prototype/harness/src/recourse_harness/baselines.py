"""Deterministic baseline runners with a shared output schema."""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from decimal import Decimal
from typing import Any

from recourse_classifier.eligibility import EligibilityFailure, RuntimeContext
from recourse_classifier.routing import (
    FaultDescriptor,
    RoutingDecision,
    VerifiedObservations,
    route_claim,
)
from recourse_classifier.settleability import Predicate

from .adversaries import AdversaryClass, AdversaryContext, apply_adversary
from .faults import FaultClass, observed_fault_overrides
from .metrics import ActionDecision, RunResult
from .traces import ProposedToolCall, Trace

BASELINE_NAMES = ("none", "human", "oap", "atomix", "auth_plus_local", "centralized", "recourse")
TOKEN_UNITS_PER_USD = Decimal("1000000")
_RECOVERY_BASELINES = frozenset({"atomix", "auth_plus_local", "centralized", "recourse"})
_BONDED_BASELINES = frozenset({"centralized", "recourse"})

# Task-facing sub-predicate labels used in the RQ2-reasons breakdown.
# Both the ex ante eligibility failures (``EligibilityFailure``) and the ex
# post settleability predicates (``Predicate``) collapse onto this shared
# vocabulary so a single column in the metrics frame can express *why* a
# call was rejected, regardless of which stage of the pipeline rejected it.
_ADMITTED_LABEL = "admitted"
_PREDICATE_LABELS: dict[str, str] = {
    # Ex ante eligibility (is_eligible) failure reasons.
    EligibilityFailure.NOT_COMPENSABLE.value: "Compensable",
    EligibilityFailure.SCOPE_NOT_CLOSED.value: "WithinScope",
    EligibilityFailure.RECOVERY_UNAVAILABLE.value: "RecoveryAvailable",
    EligibilityFailure.EVIDENCE_SCHEMA_UNDERSPECIFIED.value: "EvidenceSchemaOK",
    EligibilityFailure.COVERED_LOSS_INCLUDES_EXCLUDED.value: "LossClassBounded",
    EligibilityFailure.PAYOUT_NOT_TOTAL.value: "PayoutTotal",
    EligibilityFailure.BOND_INSUFFICIENT_FOR_MAX_EXPOSURE.value: "BondSufficient",
    # Ex post settleability (is_settleable) predicates.
    Predicate.WITHIN_SCOPE.value: "WithinScope",
    Predicate.EVIDENCE_OK.value: "EvidenceSchemaOK",
    Predicate.RECOVERY_OK.value: "RecoveryAvailable",
    Predicate.RESIDUAL_OK.value: "LossClassBounded",
    Predicate.NO_EXCLUDED.value: "LossClassBounded",
    Predicate.COMPUTABLE.value: "PayoutTotal",
    Predicate.COLLATERAL_OK.value: "BondSufficient",
}


@dataclass(frozen=True)
class BaselineRunner:
    name: str
    seed: int = 0
    approval_rate: float = 1.0
    adversary_class: str = AdversaryClass.NONE.value
    bond_multiplier: float = 1.0

    def run(self, trace: Trace) -> RunResult:
        decisions = tuple(self._decision(call) for call in trace.calls)
        # RQ10 correlated-burst sharing: when multiple calls land in the same
        # correlation window they represent a shared physical bond pool
        # (one contract, k concurrent claims). The per-call bond cap is
        # divided across the window — peak lock stays at the pool ceiling
        # while shortfall scales with k. This pass only fires for the
        # recourse baseline; other baselines have no bond surface.
        if self.name == "recourse":
            decisions = _share_correlated_bonds(decisions)
        # Adversaries only target the recourse routing surface; other
        # baselines lack the optimistic/arbitrated channel by design.
        if self.name == "recourse" and self.adversary_class != AdversaryClass.NONE.value:
            ctx = AdversaryContext.from_str(self.adversary_class, seed=self.seed)
            mutated: list[ActionDecision] = []
            for call, decision in zip(trace.calls, decisions):
                siblings = tuple(
                    d for d, c in zip(decisions, trace.calls)
                    if c.concurrency_group == call.concurrency_group and c.call_id != call.call_id
                )
                mutated.append(apply_adversary(decision, call, ctx, siblings=siblings))
            decisions = tuple(mutated)
        return RunResult(
            baseline=self.name,
            workload=trace.calls[0].workload if trace.calls else "unknown",
            seed=self.seed,
            actions=decisions,
            functional_flags={
                "payout_without_operator_consent": self.name == "recourse",
                "third_party_can_challenge": self.name == "recourse",
                "external_history_reconstructable": self.name in {"centralized", "recourse"},
            },
            adversary_class=self.adversary_class,
            bond_multiplier=float(self.bond_multiplier),
            approval_rate=float(self.approval_rate),
        )

    def _decision(self, call: ProposedToolCall) -> ActionDecision:
        expected_route = call.metadata.get("faultRoute")
        # Human approval is part of the HUMAN baseline and of the common
        # centralized/Recourse admission policy. NONE and the local baselines
        # must not inherit that gate: doing so would make the uncovered
        # baseline a partially protected system.
        approval_required = (
            (self.name == "human" and call.risky)
            or (
                self.name in _BONDED_BASELINES
                and call.requires_human_approval
            )
        )
        approved = (not approval_required) or _approval_pass(
            self.seed, call.call_id, self.approval_rate
        )
        eligible = self.name not in {"oap", "auth_plus_local"} or call.ground_truth != "policy_violation"
        executed = eligible and approved
        used_human_approval = approval_required and approved and executed
        rejection_reason: str | None = None
        if self.name == "none":
            route = "none"
            payout = 0
            bond = 0
        elif not eligible:
            route = "ineligible"
            payout = 0
            bond = 0
        elif not executed:
            route = "ineligible"
            payout = 0
            bond = 0
        elif self.name == "centralized" and call.ground_truth == "will_fail_compensable":
            route = "optimistic"
            payout = call.payout_hint
            bond = call.payout_hint
        elif self.name in {"atomix", "auth_plus_local"}:
            route = "local"
            payout = 0
            bond = 0
        elif self.name == "recourse":
            route, payout, bond, rejection_reason = _recourse_route(
                call, bond_multiplier=self.bond_multiplier
            )
        else:
            route = "ineligible" if not executed else "optimistic"
            payout = 0
            bond = 0
        supports_recovery = self.name in _RECOVERY_BASELINES
        residual_harm = (
            call.residual_harm if supports_recovery else call.gross_harm
        ) if executed else 0
        burst_index = call.metadata.get("correlationBurstIndex")
        correlation_group = int(burst_index) if burst_index is not None else None
        return ActionDecision(
            call_id=call.call_id,
            risky=call.risky,
            executed=executed,
            required_human_approval=approval_required,
            eligible=eligible,
            route=route,
            gross_harm=call.gross_harm if executed else 0,
            residual_harm=residual_harm,
            payout_amount=payout,
            bond_available=bond,
            used_human_approval=used_human_approval,
            recovery_latency_ms=(
                1200
                if executed and supports_recovery and call.gross_harm
                else 0
            ),
            finalization_latency_ms=3000 if payout else 0,
            tool_latency_ms=25,
            expected_route=str(expected_route) if expected_route is not None else None,
            rejection_reason=rejection_reason,
            correlation_group=correlation_group,
        )


def runner_for_baseline(
    baseline: str,
    *,
    seed: int = 0,
    approval_rate: float = 1.0,
    adversary_class: str = AdversaryClass.NONE.value,
    bond_multiplier: float = 1.0,
) -> BaselineRunner:
    if baseline not in BASELINE_NAMES:
        raise ValueError(f"unknown baseline: {baseline}")
    if bond_multiplier < 0:
        raise ValueError("bond_multiplier must be non-negative")
    return BaselineRunner(
        name=baseline,
        seed=seed,
        approval_rate=approval_rate,
        adversary_class=adversary_class,
        bond_multiplier=float(bond_multiplier),
    )


def _approval_pass(seed: int, call_id: str, approval_rate: float) -> bool:
    """Deterministic per-call coin flip for the human-approval gate."""
    rate = max(0.0, min(1.0, float(approval_rate)))
    if rate >= 1.0:
        return True
    if rate <= 0.0:
        return False
    digest = hashlib.sha256(f"{seed}:{call_id}".encode("utf-8")).digest()
    # Map the first 8 bytes to a [0, 1) draw.
    draw = int.from_bytes(digest[:8], "big") / float(1 << 64)
    return draw < rate


def _share_correlated_bonds(
    decisions: tuple[ActionDecision, ...],
) -> tuple[ActionDecision, ...]:
    """Divide the bond cap across calls inside the same correlation window.

    Models the physical bond-pool semantics for RQ10: a burst window
    represents a single contract under multiple concurrent claims. The
    shared pool ceiling is taken as the *maximum* per-call bond computed
    by ``_recourse_route`` within the window (each call would otherwise
    carry the same individual contract's collateral), and split equally
    across the ``k`` claimants. Payouts are capped at the new per-claim
    share so ``compute_metrics`` reflects both the lower covered amount
    and the residual that becomes an under-bond shortfall.
    """
    groups: dict[int, list[int]] = {}
    for index, decision in enumerate(decisions):
        if decision.correlation_group is None:
            continue
        groups.setdefault(decision.correlation_group, []).append(index)
    if not groups:
        return decisions

    mutated = list(decisions)
    for indices in groups.values():
        k = len(indices)
        if k <= 1:
            continue
        pool = max(mutated[i].bond_available for i in indices)
        share = pool // k
        for i in indices:
            current = mutated[i]
            new_bond = min(current.bond_available, share)
            new_payout = min(current.payout_amount, new_bond)
            mutated[i] = replace(
                current,
                bond_available=new_bond,
                payout_amount=new_payout,
            )
    return tuple(mutated)


def _recourse_route(
    call: ProposedToolCall, *, bond_multiplier: float = 1.0
) -> tuple[str, int, int, str]:
    contract, effect, recovery = _classifier_inputs(call, bond_multiplier=bond_multiplier)
    fault = _fault_class(call)
    decision = route_claim(
        contract,
        effect,
        recovery,
        FaultDescriptor(
            fault_class=fault.value,
            observed_overrides=observed_fault_overrides(fault),
            pre_registered_route=call.metadata.get("faultRoute"),
        ),
        runtime_ctx=RuntimeContext.for_contracts([contract]),
        observations=VerifiedObservations(
            observed_scope=contract["resourceScope"],
            evidence_provenance=contract["evidenceSchema"]["requiredProvenance"],
            available_collateral=int(contract["bond"]["maxAggregateExposure"]),
            excluded_harms=frozenset(),
            effect_signature_verified=True,
            recovery_signature_verified=True,
            effect_receipt_digest=recovery["effectReceiptHash"],
        ),
    )
    route = str(decision.route)
    reason = _classify_rejection_reason(decision)
    if route == "excluded":
        return route, 0, 0, reason
    payout = decision.payout if route == "optimistic" else _measurement_units(call)
    # The bond locked per contract is `maxPayout * bond_multiplier` — varying it
    # widens or narrows the protocol's residual-loss coverage envelope.
    base_bond = _measurement_units(call)
    scaled_bond = int(round(base_bond * bond_multiplier))
    bond = scaled_bond if route in {"optimistic", "arbitrated"} else 0
    return route, payout, bond, reason


def _classify_rejection_reason(decision: RoutingDecision) -> str:
    """Map a routing decision onto a task-facing sub-predicate label.

    Optimistic routes are reported as ``"admitted"`` so the per-cell metrics
    frame can report both the eligibility rate (admitted / total) and the
    per-sub-predicate rejection share in a single column. Anything else is
    keyed on the failed predicate; an ex ante eligibility failure exposes
    the inner ``EligibilityFailure`` via ``RoutingDecision.reason``.
    """
    if str(decision.route) == "optimistic":
        return _ADMITTED_LABEL
    if decision.failed_predicate is None:
        return "Unknown"
    predicate_value = str(decision.failed_predicate.value)
    if predicate_value == Predicate.ELIGIBLE.value:
        # ``settleability.is_settleable`` writes the inner EligibilityFailure
        # value into ``reason`` when the eligibility predicate is the one to
        # fail; map it through the shared label vocabulary.
        eligibility_reason = decision.reason or ""
        return _PREDICATE_LABELS.get(eligibility_reason, "Eligible")
    return _PREDICATE_LABELS.get(predicate_value, predicate_value)


def _classifier_inputs(
    call: ProposedToolCall, *, bond_multiplier: float = 1.0
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    units = _measurement_units(call)
    code = _loss_code(call.workload)
    max_payout = max(1, units)
    bond_amount = max(1, int(round(units * bond_multiplier)))
    contract = {
        "schemaVersion": 1,
        "contractId": f"contract:{call.call_id}",
        "operator": "operator",
        "actionTemplate": {"tool": call.workload, "action": call.action},
        "resourceScope": {
            "type": _scope_type(call.workload),
            "descriptor": _resource_descriptor(call),
        },
        "effectClass": "compensable",
        "recoveryOperator": {
            "compensatorId": f"{call.workload}-compensator",
            "freshnessSeconds": 60,
            "retentionSeconds": 3600,
            "authPolicyHash": "auth",
        },
        "coveredLossClass": {"codes": [code], "excludeList": []},
        "payoutRule": _payout_rule(call.workload, max_payout),
        "bond": {
            "asset": "USDC",
            "minAmount": str(bond_amount),
            "maxAggregateExposure": str(bond_amount),
        },
        "evidenceSchema": {
            "schemaId": "schema:l1",
            "requiredProvenance": "L1",
            "accessPolicyHash": "access",
        },
        "deadlines": {"recoverySeconds": 60, "submissionSeconds": 300, "livenessSeconds": 600},
        "disputeRoute": {"arbitrator": "erc792", "evidenceGroupId": "1"},
    }
    effect = {
        "schemaVersion": 1,
        "contractId": contract["contractId"],
        "jobId": call.call_id,
        "intentHash": "intent",
        "paramsHash": "params",
        "resourceId": call.resource,
        "preStateDigest": "pre",
        "postStateDigest": "post",
        "providerReceiptHash": "provider",
        "timestamp": 0,
        "adapterAddress": "adapter",
        "signature": "sig",
    }
    # The synthetic harness models prior signature verification. Bind the
    # recovery receipt to the exact modeled effect payload so the fail-closed
    # classifier still receives an independently supplied 32-byte digest.
    effect_receipt_digest = "0x" + hashlib.sha256(
        json.dumps(effect, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    recovery = {
        "schemaVersion": 1,
        "contractId": contract["contractId"],
        "effectReceiptHash": effect_receipt_digest,
        "compensatorAddress": "compensator",
        "restoreArtifactHash": "restore",
        "outcome": "partial" if units else "success",
        "residualMeasurements": {
            code: {
                "value": _measurement_value(call.workload, units),
                "evidenceSource": "snapshot-diff",
            }
        },
        "recoveryStartTs": 10,
        "recoveryEndTs": 11,
        "signature": "sig",
    }
    return contract, effect, recovery


def _fault_class(call: ProposedToolCall) -> FaultClass:
    raw = call.metadata.get("faultClass", FaultClass.NONE.value)
    try:
        return FaultClass(str(raw))
    except ValueError:
        return FaultClass[str(raw)]


def _measurement_units(call: ProposedToolCall) -> int:
    if _fault_class(call) is not FaultClass.NONE:
        return max(1, call.payout_hint)
    return max(0, call.payout_hint)


def _measurement_value(workload: str, units: int) -> str:
    if workload == "cloud":
        return str(Decimal(units) / TOKEN_UNITS_PER_USD)
    return str(units)


def _payout_rule(workload: str, max_payout: int) -> dict[str, Any]:
    if workload == "cloud":
        return {
            "type": "excessSpendSchedule",
            "params": {"coverageRatio": "1"},
            "maxPayout": str(max_payout),
        }
    return {
        "type": "rowCountSchedule",
        "params": {"perRowUsd": "0.000001"},
        "maxPayout": str(max_payout),
    }


def _loss_code(workload: str) -> str:
    return {
        "postgres": "rows_deleted",
        "git": "history_bytes_lost",
        "cloud": "excess_spend_usd",
    }[workload]


def _scope_type(workload: str) -> str:
    return {
        "postgres": "postgres-table",
        "git": "git-ref",
        "cloud": "cloud-resource",
    }[workload]


def _resource_descriptor(call: ProposedToolCall) -> dict[str, str]:
    if call.workload == "postgres":
        return {"table": call.resource}
    if call.workload == "git":
        return {"ref": call.resource}
    return {"resourceId": call.resource}
