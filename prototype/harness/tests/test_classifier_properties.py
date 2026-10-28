"""Property-based fuzz tests for the recourse classifier.

These tests exercise the pure routing predicate `is_settleable` and
`route_claim` across a generated space of (contract, effect receipt,
recovery receipt) triples. They are scoped to the four invariants the
paper's Threats section identifies as needing property-based coverage:

  1. Receipt validity: classifying any well-typed (contract, receipts)
     pair returns one of the four canonical routes and never raises.
  2. Idempotent classification: re-running the classifier on the same
     inputs yields an identical decision (route, payout, predicate).
  3. Monotone scope: tightening a contract's scope can only *reduce* the
     set of receipts that route as `optimistic`. If A's scope strictly
     contains B's, any receipt routed `excluded` under B's narrower
     scope is also non-optimistic under A whenever observed scope no
     longer matches.
  4. Capped payout: payout for an optimistic-route decision is bounded
     above by κ.payoutRule.maxPayout, regardless of harm magnitude.

Strategies mutate a known-valid baseline (the canonical postgres
fixture). This keeps the search space focused on receipts that the
classifier might plausibly admit while still hitting the failure
predicates.
"""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path
from typing import Any, Mapping

import pytest
from hypothesis import HealthCheck, given, settings, strategies as st

from recourse_classifier.eligibility import RuntimeContext
from recourse_classifier.routing import VerifiedObservations, route_claim
from recourse_classifier.settleability import (
    ActionInstance,
    SettlementRoute,
    compute_payout,
    is_settleable,
)


SCHEMAS_DIR = Path(__file__).resolve().parents[2] / "schemas" / "examples"


def _load(name: str) -> dict[str, Any]:
    return json.loads((SCHEMAS_DIR / name).read_text())


# Baseline objects (deep-copied per draw so strategies cannot leak state).
_BASE_CONTRACT = _load("postgres.contract.json")
_BASE_EFFECT = _load("postgres.effect_receipt.json")
_BASE_RECOVERY = _load("postgres.recovery_receipt.json")


# --- strategies ---------------------------------------------------------

ROUTES = {
    SettlementRoute.OPTIMISTIC,
    SettlementRoute.ARBITRATED,
    SettlementRoute.EXCLUDED,
    SettlementRoute.INELIGIBLE,
}

_PROVENANCE_VALUES = ["L0", "L1", "L2", "L3"]
_RECOVERY_OUTCOMES = ["success", "partial", "failure", "inconclusive", "bogus"]


@st.composite
def contracts(draw: st.DrawFn) -> dict[str, Any]:
    """Generate κ contracts by mutating the postgres baseline.

    Mutations target every predicate boundary (eligibility, evidence,
    payout, bond) so the four routing branches all get exercised.
    """

    k = copy.deepcopy(_BASE_CONTRACT)

    # effectClass: occasionally make it non-compensable to force ineligible.
    k["effectClass"] = draw(st.sampled_from(["compensable", "compensable", "irreversible"]))

    # requiredProvenance: vary to exercise evidence checks.
    k["evidenceSchema"]["requiredProvenance"] = draw(st.sampled_from(_PROVENANCE_VALUES))

    # payout cap: keep bounded so we can also reason about overflow.
    max_payout = draw(st.integers(min_value=1, max_value=10**18))
    k["payoutRule"]["maxPayout"] = str(max_payout)

    # bond aggregate exposure must cover maxPayout for eligibility to pass.
    multiplier = draw(st.integers(min_value=1, max_value=10))
    k["bond"]["maxAggregateExposure"] = str(max_payout * multiplier)
    k["bond"]["minAmount"] = str(max_payout * multiplier)

    # deadlines: vary the recovery window to flex RecoveryOK predicate.
    k["deadlines"]["recoverySeconds"] = draw(st.integers(min_value=60, max_value=86_400))

    # scope descriptor tenantId: vary to exercise WithinScope check.
    k["resourceScope"]["descriptor"]["tenantId"] = draw(
        st.sampled_from(["t-7c4e", "t-other", "t-zzzz"])
    )

    return k


@st.composite
def effect_receipts(draw: st.DrawFn, contract: Mapping[str, Any]) -> dict[str, Any]:
    e = copy.deepcopy(_BASE_EFFECT)
    e["contractId"] = contract["contractId"]
    e["schemaVersion"] = contract["schemaVersion"]
    # Vary timestamp around the canonical baseline so we hit recovery_ok.
    e["timestamp"] = draw(st.integers(min_value=1, max_value=2_000_000_000))
    # Occasionally drop providerReceiptHash to exercise evidence check.
    if draw(st.booleans()):
        e["providerReceiptHash"] = ""
    return e


@st.composite
def recovery_receipts(
    draw: st.DrawFn, contract: Mapping[str, Any], effect: Mapping[str, Any]
) -> dict[str, Any]:
    r = copy.deepcopy(_BASE_RECOVERY)
    r["contractId"] = contract["contractId"]
    r["schemaVersion"] = contract["schemaVersion"]
    # Recompute hash binding.
    r["effectReceiptHash"] = _BASE_RECOVERY["effectReceiptHash"]
    r["outcome"] = draw(st.sampled_from(_RECOVERY_OUTCOMES))

    deadline = int(contract["deadlines"]["recoverySeconds"])
    start_offset = draw(st.integers(min_value=0, max_value=max(deadline, 1)))
    duration = draw(st.integers(min_value=0, max_value=max(deadline, 1)))
    effect_ts = int(effect["timestamp"])
    r["recoveryStartTs"] = effect_ts + start_offset
    r["recoveryEndTs"] = r["recoveryStartTs"] + duration

    # Vary residual measurements to flex payout cap.
    rows = draw(st.integers(min_value=0, max_value=10_000_000))
    downtime = draw(st.integers(min_value=0, max_value=86_400))
    r["residualMeasurements"] = {
        "rows_deleted": {
            "value": str(rows),
            "evidenceSource": "snapshot-diff",
            "artifactHash": _BASE_RECOVERY["residualMeasurements"]["rows_deleted"]["artifactHash"],
        },
        "downtime_seconds": {
            "value": str(downtime),
            "evidenceSource": "provider-receipt",
            "artifactHash": _BASE_RECOVERY["residualMeasurements"]["downtime_seconds"][
                "artifactHash"
            ],
        },
    }
    return r


@st.composite
def instances(draw: st.DrawFn) -> ActionInstance:
    contract = draw(contracts())
    effect = draw(effect_receipts(contract))
    recovery = draw(recovery_receipts(contract, effect))

    # Strategy occasionally drops observed_scope or mismatches it to exercise WithinScope.
    scope_mode = draw(st.sampled_from(["match", "mismatch", "absent"]))
    if scope_mode == "match":
        observed_scope = copy.deepcopy(contract["resourceScope"])
    elif scope_mode == "mismatch":
        observed_scope = {
            "type": contract["resourceScope"]["type"],
            "descriptor": {**contract["resourceScope"]["descriptor"], "tenantId": "intruder"},
        }
    else:
        observed_scope = None

    provenance = draw(st.sampled_from([None, *_PROVENANCE_VALUES]))

    available_collateral = draw(
        st.integers(
            min_value=0,
            max_value=max(int(contract["bond"]["maxAggregateExposure"]), 1),
        )
    )
    excluded_harms = draw(
        st.sampled_from(
            [
                None,
                frozenset(),
                frozenset({"data_exfiltration"}),
            ]
        )
    )

    return ActionInstance(
        contract=contract,
        effect_receipt=effect,
        recovery_receipt=recovery,
        runtime_ctx=RuntimeContext.for_contracts([contract]),
        observed_scope=observed_scope,
        evidence_provenance=provenance,
        available_collateral=available_collateral,
        excluded_harms=excluded_harms,
        effect_signature_verified=draw(st.booleans()),
        recovery_signature_verified=draw(st.booleans()),
        effect_receipt_digest=draw(
            st.sampled_from(
                [
                    recovery["effectReceiptHash"],
                    "0xabab000000000000000000000000000000000000000000000000000000000001",
                    None,
                ]
            )
        ),
    )


# --- properties ---------------------------------------------------------


def _verified_observations(
    sigma: ActionInstance,
) -> VerifiedObservations | None:
    if (
        sigma.observed_scope is None
        or sigma.evidence_provenance is None
        or sigma.available_collateral is None
        or sigma.excluded_harms is None
        or sigma.effect_receipt_digest is None
    ):
        return None
    return VerifiedObservations(
        observed_scope=sigma.observed_scope,
        evidence_provenance=sigma.evidence_provenance,
        available_collateral=sigma.available_collateral,
        excluded_harms=sigma.excluded_harms,
        effect_signature_verified=sigma.effect_signature_verified,
        recovery_signature_verified=sigma.recovery_signature_verified,
        effect_receipt_digest=sigma.effect_receipt_digest,
    )


_SETTINGS = settings(
    max_examples=200,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large],
)


@_SETTINGS
@given(instances())
def test_receipt_validity_never_crashes(sigma: ActionInstance) -> None:
    """The classifier always returns one of the four canonical routes."""

    result = is_settleable(sigma)
    assert result.route in ROUTES
    # route_claim wraps is_settleable; the two must agree.
    decision = route_claim(
        sigma.contract,
        sigma.effect_receipt,
        sigma.recovery_receipt,
        runtime_ctx=sigma.runtime_ctx,
        observations=_verified_observations(sigma),
    )
    assert decision.route in ROUTES
    # Payouts are non-negative integers.
    assert isinstance(result.payout, int)
    assert result.payout >= 0


@_SETTINGS
@given(instances())
def test_classification_is_idempotent(sigma: ActionInstance) -> None:
    """Re-running the classifier yields the same decision."""

    first = is_settleable(sigma)
    second = is_settleable(sigma)
    assert first == second

    observations = _verified_observations(sigma)
    a = route_claim(
        sigma.contract,
        sigma.effect_receipt,
        sigma.recovery_receipt,
        runtime_ctx=sigma.runtime_ctx,
        observations=observations,
    )
    b = route_claim(
        sigma.contract,
        sigma.effect_receipt,
        sigma.recovery_receipt,
        runtime_ctx=sigma.runtime_ctx,
        observations=observations,
    )
    assert a == b


@_SETTINGS
@given(instances())
def test_monotone_scope_ineligible_persists(sigma: ActionInstance) -> None:
    """If σ is `excluded` for failing WithinScope under a *narrow* scope, then
    further narrowing observed_scope (an even tighter mismatch) cannot make
    it `optimistic`.

    Formally: let scope A ⊃ scope B (A wider). Anything that fails to match
    B also fails to match A's descriptor when A's descriptor was the
    strictly narrower one in the first place. We exercise this by adding
    extra descriptor keys to the contract scope (narrowing) — observed
    scope cannot newly match a narrower contract scope.
    """

    base = is_settleable(sigma)

    # Build a narrowed contract: add an extra descriptor key the observed
    # scope cannot satisfy. This must not promote any non-optimistic
    # decision to optimistic.
    narrowed = copy.deepcopy(dict(sigma.contract))
    narrowed["resourceScope"]["descriptor"]["extraDimension"] = "unsatisfiable-value"
    sigma_narrowed = replace(
        sigma,
        contract=narrowed,
        runtime_ctx=RuntimeContext.for_contracts([narrowed]),
    )
    narrowed_result = is_settleable(sigma_narrowed)

    # If the base was not optimistic, narrowing scope cannot make it
    # optimistic. (Narrowing the contract scope can only fail WithinScope
    # harder, never make a mismatch into a match.)
    if base.route != SettlementRoute.OPTIMISTIC:
        assert narrowed_result.route != SettlementRoute.OPTIMISTIC


@_SETTINGS
@given(instances())
def test_capped_payout_for_optimistic_route(sigma: ActionInstance) -> None:
    """For any decision (especially optimistic), payout ≤ maxPayout."""

    result = is_settleable(sigma)
    max_payout = int(sigma.contract["payoutRule"].get("maxPayout", 0))
    assert result.payout <= max_payout, (
        f"payout {result.payout} exceeds maxPayout {max_payout} on route {result.route}"
    )

    # Sanity: compute_payout (the lower-level function) also respects the cap.
    direct = compute_payout(sigma.contract["payoutRule"], sigma.recovery_receipt)
    if direct is not None:
        assert direct <= max_payout


# --- direct sanity tests (non-fuzz) -------------------------------------


def test_baseline_postgres_routes_optimistic() -> None:
    """Sanity: the canonical postgres fixture still routes optimistically."""

    contract = copy.deepcopy(_BASE_CONTRACT)
    sigma = ActionInstance(
        contract=contract,
        effect_receipt=copy.deepcopy(_BASE_EFFECT),
        recovery_receipt=copy.deepcopy(_BASE_RECOVERY),
        runtime_ctx=RuntimeContext.for_contracts([contract]),
        observed_scope=copy.deepcopy(contract["resourceScope"]),
        evidence_provenance="L1",
        available_collateral=int(contract["bond"]["maxAggregateExposure"]),
        excluded_harms=frozenset(),
        effect_signature_verified=True,
        recovery_signature_verified=True,
        effect_receipt_digest=_BASE_RECOVERY["effectReceiptHash"],
    )
    result = is_settleable(sigma)
    assert result.route == SettlementRoute.OPTIMISTIC


@pytest.mark.parametrize("route", list(ROUTES))
def test_route_enum_values_are_strings(route: SettlementRoute) -> None:
    """Defensive: ensure routing enum projects to the four expected labels."""

    assert str(route.value) in {"optimistic", "arbitrated", "excluded", "ineligible"}
