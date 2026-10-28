from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path

from recourse_classifier.eligibility import RuntimeContext
from recourse_classifier.routing import FaultDescriptor, VerifiedObservations, route_claim
from recourse_classifier.settleability import Predicate, SettlementRoute

SCHEMAS_DIR = Path(__file__).resolve().parents[2] / "schemas"
EXAMPLES_DIR = SCHEMAS_DIR / "examples"


def _load(name: str) -> dict:
    return json.loads((EXAMPLES_DIR / name).read_text())


def _verified_observations(
    contract: dict,
    recovery: dict,
    *,
    provenance: str | None = None,
) -> VerifiedObservations:
    return VerifiedObservations(
        observed_scope=copy.deepcopy(contract["resourceScope"]),
        evidence_provenance=provenance
        or contract["evidenceSchema"]["requiredProvenance"],
        available_collateral=int(contract["bond"]["maxAggregateExposure"]),
        excluded_harms=frozenset(),
        effect_signature_verified=True,
        recovery_signature_verified=True,
        effect_receipt_digest=recovery["effectReceiptHash"],
    )


def test_route_claim_without_verified_observations_fails_closed() -> None:
    contract = _load("postgres.contract.json")
    effect = _load("postgres.effect_receipt.json")
    recovery = _load("postgres.recovery_receipt.json")

    decision = route_claim(
        contract,
        effect,
        recovery,
        runtime_ctx=RuntimeContext.for_contracts([contract]),
    )

    assert decision.route != SettlementRoute.OPTIMISTIC


def test_route_claim_is_deterministic_and_pure() -> None:
    contract = _load("postgres.contract.json")
    effect = _load("postgres.effect_receipt.json")
    recovery = _load("postgres.recovery_receipt.json")
    ctx = RuntimeContext.for_contracts([contract])
    before = copy.deepcopy((contract, effect, recovery))

    observations = _verified_observations(contract, recovery)

    first = route_claim(
        contract, effect, recovery, runtime_ctx=ctx, observations=observations
    )
    second = route_claim(
        contract, effect, recovery, runtime_ctx=ctx, observations=observations
    )

    assert first == second
    assert first.route == SettlementRoute.OPTIMISTIC
    assert (contract, effect, recovery) == before


def test_route_claim_uses_fault_observations_but_ignores_ground_truth_label() -> None:
    contract = _load("postgres.contract.json")
    effect = _load("postgres.effect_receipt.json")
    recovery = _load("postgres.recovery_receipt.json")
    ctx = RuntimeContext.for_contracts([contract])
    fault = FaultDescriptor(
        fault_class="OBS_HIDE_PRESTATE",
        observed_overrides={"effect_receipt": {"preStateDigest": None}},
        pre_registered_route=SettlementRoute.EXCLUDED,
    )

    decision = route_claim(
        contract,
        effect,
        recovery,
        fault,
        runtime_ctx=ctx,
        observations=_verified_observations(contract, recovery),
    )

    assert decision.route == SettlementRoute.ARBITRATED
    assert decision.ground_truth_route == SettlementRoute.EXCLUDED


def test_route_claim_rejects_receipts_bound_to_a_different_contract() -> None:
    contract = _load("postgres.contract.json")
    effect = _load("postgres.effect_receipt.json")
    recovery = _load("postgres.recovery_receipt.json")
    effect["contractId"] = "0x2222222222222222222222222222222222222222222222222222222222222222"

    decision = route_claim(
        contract,
        effect,
        recovery,
        runtime_ctx=RuntimeContext.for_contracts([contract]),
        observations=_verified_observations(contract, recovery),
    )

    assert decision.route == SettlementRoute.ARBITRATED
    assert decision.failed_predicate == Predicate.EVIDENCE_OK


def test_route_claim_rejects_recovery_for_a_different_effect_receipt_hash() -> None:
    contract = _load("postgres.contract.json")
    effect = _load("postgres.effect_receipt.json")
    recovery = _load("postgres.recovery_receipt.json")
    observations = replace(
        _verified_observations(contract, recovery),
        effect_receipt_digest="0xabab000000000000000000000000000000000000000000000000000000000001",
    )

    decision = route_claim(
        contract,
        effect,
        recovery,
        runtime_ctx=RuntimeContext.for_contracts([contract]),
        observations=observations,
    )

    assert decision.route == SettlementRoute.ARBITRATED
    assert decision.failed_predicate == Predicate.EVIDENCE_OK


def test_route_claim_requires_external_signature_verification() -> None:
    contract = _load("postgres.contract.json")
    effect = _load("postgres.effect_receipt.json")
    recovery = _load("postgres.recovery_receipt.json")
    observations = replace(
        _verified_observations(contract, recovery),
        recovery_signature_verified=False,
    )

    decision = route_claim(
        contract,
        effect,
        recovery,
        runtime_ctx=RuntimeContext.for_contracts([contract]),
        observations=observations,
    )

    assert decision.route == SettlementRoute.ARBITRATED
    assert decision.failed_predicate == Predicate.EVIDENCE_OK


def test_l2_adapter_attestation_routes_to_arbitration() -> None:
    contract = _load("postgres.contract.json")
    contract["evidenceSchema"]["requiredProvenance"] = "L2"
    effect = _load("postgres.effect_receipt.json")
    recovery = _load("postgres.recovery_receipt.json")

    decision = route_claim(
        contract,
        effect,
        recovery,
        runtime_ctx=RuntimeContext.for_contracts([contract]),
        observations=_verified_observations(contract, recovery, provenance="L2"),
    )

    assert decision.route == SettlementRoute.ARBITRATED
    assert decision.failed_predicate == Predicate.EVIDENCE_OK


def test_unknown_provenance_level_fails_closed() -> None:
    contract = _load("postgres.contract.json")
    contract["evidenceSchema"]["requiredProvenance"] = "L3"
    effect = _load("postgres.effect_receipt.json")
    recovery = _load("postgres.recovery_receipt.json")

    decision = route_claim(
        contract,
        effect,
        recovery,
        runtime_ctx=RuntimeContext.for_contracts([contract]),
        observations=_verified_observations(contract, recovery, provenance="L3"),
    )

    assert decision.route == SettlementRoute.ARBITRATED
    assert decision.failed_predicate == Predicate.EVIDENCE_OK


def test_l0_public_replay_may_route_optimistically() -> None:
    contract = _load("postgres.contract.json")
    contract["evidenceSchema"]["requiredProvenance"] = "L0"
    effect = _load("postgres.effect_receipt.json")
    recovery = _load("postgres.recovery_receipt.json")

    decision = route_claim(
        contract,
        effect,
        recovery,
        runtime_ctx=RuntimeContext.for_contracts([contract]),
        observations=_verified_observations(contract, recovery, provenance="L0"),
    )

    assert decision.route == SettlementRoute.OPTIMISTIC


def test_route_claim_without_external_runtime_context_is_ineligible() -> None:
    contract = _load("postgres.contract.json")
    effect = _load("postgres.effect_receipt.json")
    recovery = _load("postgres.recovery_receipt.json")

    decision = route_claim(
        contract,
        effect,
        recovery,
        observations=_verified_observations(contract, recovery),
    )

    assert decision.route == SettlementRoute.INELIGIBLE
    assert decision.failed_predicate == Predicate.ELIGIBLE
