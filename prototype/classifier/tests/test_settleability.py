from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path
from typing import Any, Callable, Mapping, cast

import pytest

from recourse_classifier.eligibility import RuntimeContext
from recourse_classifier.settleability import (
    ActionInstance,
    Predicate,
    SettlementRoute,
    compute_payout,
    is_settleable,
)

SCHEMAS_DIR = Path(__file__).resolve().parents[2] / "schemas"
EXAMPLES_DIR = SCHEMAS_DIR / "examples"


def _load(name: str) -> dict:
    return json.loads((EXAMPLES_DIR / name).read_text())


def _nominal_instance() -> ActionInstance:
    contract = _load("postgres.contract.json")
    return ActionInstance(
        contract=contract,
        effect_receipt=_load("postgres.effect_receipt.json"),
        recovery_receipt=_load("postgres.recovery_receipt.json"),
        runtime_ctx=RuntimeContext.for_contracts([contract]),
        observed_scope=copy.deepcopy(contract["resourceScope"]),
        evidence_provenance="L1",
        available_collateral=int(contract["bond"]["maxAggregateExposure"]),
        excluded_harms=frozenset(),
        effect_signature_verified=True,
        recovery_signature_verified=True,
        effect_receipt_digest=_load("postgres.recovery_receipt.json")["effectReceiptHash"],
    )


def test_nominal_failed_action_is_objectively_settleable() -> None:
    result = is_settleable(_nominal_instance())
    assert result.route == SettlementRoute.OPTIMISTIC
    assert result.failed_predicate is None
    assert result.payout > 0


@pytest.mark.parametrize(
    ("name", "mutate", "route", "predicate"),
    [
        (
            "eligible",
            lambda s: replace(
                s,
                runtime_ctx=replace(s.runtime_ctx, closed_scope_contracts=frozenset()),
            ),
            SettlementRoute.INELIGIBLE,
            Predicate.ELIGIBLE,
        ),
        (
            "within_scope",
            lambda s: replace(
                s,
                observed_scope={
                    "type": "postgres-table",
                    "descriptor": {
                        "database": "tenant_main",
                        "schema": "public",
                        "table": "records",
                        "tenantId": "other-tenant",
                    },
                },
            ),
            SettlementRoute.EXCLUDED,
            Predicate.WITHIN_SCOPE,
        ),
        (
            "evidence_ok",
            lambda s: replace(
                s,
                effect_receipt={
                    k: v for k, v in s.effect_receipt.items() if k != "providerReceiptHash"
                },
            ),
            SettlementRoute.ARBITRATED,
            Predicate.EVIDENCE_OK,
        ),
        (
            "recovery_ok",
            lambda s: replace(
                s,
                recovery_receipt={
                    **s.recovery_receipt,
                    "recoveryEndTs": s.effect_receipt["timestamp"]
                    + s.contract["deadlines"]["recoverySeconds"]
                    + 1,
                },
            ),
            SettlementRoute.ARBITRATED,
            Predicate.RECOVERY_OK,
        ),
        (
            "recovery_failure",
            lambda s: replace(
                s,
                recovery_receipt={
                    **s.recovery_receipt,
                    "outcome": "failure",
                },
            ),
            SettlementRoute.ARBITRATED,
            Predicate.RECOVERY_OK,
        ),
        (
            "residual_ok",
            lambda s: replace(
                s,
                recovery_receipt={
                    **s.recovery_receipt,
                    "residualMeasurements": {
                        **s.recovery_receipt["residualMeasurements"],
                        "reputation_damage": {
                            "value": "1",
                            "evidenceSource": "provider-receipt",
                        },
                    },
                },
            ),
            SettlementRoute.EXCLUDED,
            Predicate.RESIDUAL_OK,
        ),
        (
            "no_excluded",
            lambda s: replace(s, excluded_harms=frozenset({"data_exfiltration"})),
            SettlementRoute.EXCLUDED,
            Predicate.NO_EXCLUDED,
        ),
        (
            "no_excluded_unverified",
            lambda s: replace(s, excluded_harms=None),
            SettlementRoute.ARBITRATED,
            Predicate.NO_EXCLUDED,
        ),
        (
            "computable",
            lambda s: replace(
                s,
                recovery_receipt={**s.recovery_receipt, "residualMeasurements": {}},
            ),
            SettlementRoute.ARBITRATED,
            Predicate.COMPUTABLE,
        ),
        (
            "collateral_ok",
            lambda s: replace(s, available_collateral=1),
            SettlementRoute.ARBITRATED,
            Predicate.COLLATERAL_OK,
        ),
        (
            "collateral_unverified",
            lambda s: replace(s, available_collateral=None),
            SettlementRoute.ARBITRATED,
            Predicate.COLLATERAL_OK,
        ),
    ],
)
def test_failed_predicate_routes_to_expected_non_optimistic_path(
    name: str,
    mutate: Callable[[ActionInstance], ActionInstance],
    route: SettlementRoute,
    predicate: Predicate,
) -> None:
    result = is_settleable(mutate(_nominal_instance()))
    assert result.route == route, name
    assert result.failed_predicate == predicate


@pytest.mark.parametrize("bad_value", ["NaN", "Infinity", "-Infinity"])
def test_non_finite_residual_measurements_are_not_settleable(bad_value: str) -> None:
    instance = _nominal_instance()
    measurements = copy.deepcopy(instance.recovery_receipt["residualMeasurements"])
    first_code = next(iter(measurements))
    measurements[first_code]["value"] = bad_value

    result = is_settleable(
        replace(
            instance,
            recovery_receipt={**instance.recovery_receipt, "residualMeasurements": measurements},
        )
    )

    assert result.route == SettlementRoute.EXCLUDED
    assert result.failed_predicate == Predicate.RESIDUAL_OK


def test_malformed_recovery_timestamps_route_to_recovery_failure() -> None:
    instance = _nominal_instance()

    result = is_settleable(
        replace(
            instance,
            recovery_receipt={**instance.recovery_receipt, "recoveryEndTs": "not-an-int"},
        )
    )

    assert result.route == SettlementRoute.ARBITRATED
    assert result.failed_predicate == Predicate.RECOVERY_OK


def test_malformed_observed_scope_fails_closed() -> None:
    result = is_settleable(
        replace(
            _nominal_instance(),
            observed_scope=cast(Mapping[str, Any], "not-a-mapping"),
        )
    )

    assert result.route == SettlementRoute.EXCLUDED
    assert result.failed_predicate == Predicate.WITHIN_SCOPE


def test_malformed_available_collateral_fails_closed() -> None:
    result = is_settleable(
        replace(
            _nominal_instance(),
            available_collateral=cast(int, "not-an-integer"),
        )
    )

    assert result.route == SettlementRoute.ARBITRATED
    assert result.failed_predicate == Predicate.COLLATERAL_OK


def test_compute_payout_rejects_malformed_max_payout_without_throwing() -> None:
    instance = _nominal_instance()

    payout = compute_payout(
        {**instance.contract["payoutRule"], "maxPayout": "not-an-int"},
        instance.recovery_receipt,
    )

    assert payout is None


def test_settleability_does_not_mutate_input_receipts() -> None:
    instance = _nominal_instance()
    effect_before = copy.deepcopy(instance.effect_receipt)
    recovery_before = copy.deepcopy(instance.recovery_receipt)

    is_settleable(instance)

    assert instance.effect_receipt == effect_before
    assert instance.recovery_receipt == recovery_before
