from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path

import pytest

from recourse_classifier.eligibility import (
    EligibilityFailure,
    RuntimeContext,
    is_eligible,
)

SCHEMAS_DIR = Path(__file__).resolve().parents[2] / "schemas"
EXAMPLES_DIR = SCHEMAS_DIR / "examples"


def _load_contract(name: str = "postgres.contract.json") -> dict:
    return json.loads((EXAMPLES_DIR / name).read_text())


def _all_contracts() -> list[dict]:
    return [
        _load_contract("postgres.contract.json"),
        _load_contract("git.contract.json"),
        _load_contract("cloud.contract.json"),
    ]


def _assert_failed(contract: dict, ctx: RuntimeContext, reason: EligibilityFailure) -> None:
    result = is_eligible(contract, ctx)
    assert not result.passed
    assert result.reason == reason


@pytest.mark.parametrize(
    "example_name",
    ["postgres.contract.json", "git.contract.json", "cloud.contract.json"],
)
def test_example_contracts_are_eligible_for_matching_runtime(example_name: str) -> None:
    contracts = _all_contracts()
    contract = _load_contract(example_name)
    result = is_eligible(contract, RuntimeContext.for_contracts(contracts))
    assert result.passed
    assert result.reason is None


def test_plain_mapping_runtime_context_is_coerced() -> None:
    contract = _load_contract()
    typed_ctx = RuntimeContext.for_contracts([contract])
    compensator = typed_ctx.compensators[contract["recoveryOperator"]["compensatorId"]]
    evidence = typed_ctx.evidence_schemas[contract["evidenceSchema"]["schemaId"]]
    mapping_ctx = {
        "closed_scope_contracts": typed_ctx.closed_scope_contracts,
        "compensators": {
            contract["recoveryOperator"]["compensatorId"]: {
                "max_snapshot_age_seconds": compensator.max_snapshot_age_seconds,
                "retention_seconds": compensator.retention_seconds,
                "auth_policy_hashes": compensator.auth_policy_hashes,
            }
        },
        "evidence_schemas": {
            contract["evidenceSchema"]["schemaId"]: {
                "strongest_provenance": evidence.strongest_provenance,
                "access_policy_hashes": evidence.access_policy_hashes,
            }
        },
        "locked_bonds": typed_ctx.locked_bonds,
        "open_exposure": typed_ctx.open_exposure,
    }

    result = is_eligible(contract, mapping_ctx)

    assert result.passed


def test_fails_when_scope_is_not_closed_under_action_channels() -> None:
    contract = _load_contract()
    ctx = replace(RuntimeContext.for_contracts([contract]), closed_scope_contracts=frozenset())
    _assert_failed(contract, ctx, EligibilityFailure.SCOPE_NOT_CLOSED)


def test_fails_when_effect_class_is_not_compensable() -> None:
    contract = _load_contract()
    contract["effectClass"] = "excluded"
    _assert_failed(contract, RuntimeContext.for_contracts([contract]), EligibilityFailure.NOT_COMPENSABLE)


def test_fails_when_recovery_operator_is_unavailable() -> None:
    contract = _load_contract()
    ctx = replace(RuntimeContext.for_contracts([contract]), compensators={})
    result = is_eligible(contract, ctx)

    assert not result.passed
    assert result.reason == EligibilityFailure.RECOVERY_UNAVAILABLE


def test_fails_when_evidence_schema_is_not_available_at_required_provenance() -> None:
    contract = _load_contract()
    ctx = replace(RuntimeContext.for_contracts([contract]), evidence_schemas={})
    _assert_failed(contract, ctx, EligibilityFailure.EVIDENCE_SCHEMA_UNDERSPECIFIED)


def test_fails_when_covered_loss_includes_excluded_harm() -> None:
    contract = _load_contract()
    contract["coveredLossClass"]["codes"] = ["rows_deleted", "data_exfiltration"]
    _assert_failed(
        contract,
        RuntimeContext.for_contracts([_load_contract()]),
        EligibilityFailure.COVERED_LOSS_INCLUDES_EXCLUDED,
    )


def test_fails_when_payout_rule_is_not_total_over_recovery_outcomes() -> None:
    contract = _load_contract()
    contract["payoutRule"] = copy.deepcopy(contract["payoutRule"])
    contract["payoutRule"]["params"]["outcomesCovered"] = ["success", "partial"]
    _assert_failed(
        contract, RuntimeContext.for_contracts([contract]), EligibilityFailure.PAYOUT_NOT_TOTAL
    )


def test_malformed_payout_outcomes_fail_closed() -> None:
    contract = _load_contract()
    contract["payoutRule"] = copy.deepcopy(contract["payoutRule"])
    contract["payoutRule"]["params"]["outcomesCovered"] = 4

    _assert_failed(
        contract,
        RuntimeContext.for_contracts([contract]),
        EligibilityFailure.PAYOUT_NOT_TOTAL,
    )


@pytest.mark.parametrize(
    "payout_rule",
    [
        {
            "type": "rowCountSchedule",
            "maxPayout": "100",
            "params": {"perRowUsd": "not-a-number"},
        },
        {
            "type": "rowCountSchedule",
            "maxPayout": "100",
            "params": {"perRowUsd": "-0.01"},
        },
        {
            "type": "downtimeSchedule",
            "maxPayout": "100",
            "params": {"perSecondUsd": -1},
        },
        {
            "type": "excessSpendSchedule",
            "maxPayout": "100",
            "params": {"coverageRatio": float("nan")},
        },
        {
            "type": "composite",
            "maxPayout": "100",
            "params": {
                "components": [
                    {
                        "type": "rowCountSchedule",
                        "weight": -1,
                        "params": {"perRowUsd": "0.01"},
                    }
                ]
            },
        },
    ],
)
def test_fails_when_payout_parameters_are_non_numeric_or_negative(
    payout_rule: dict,
) -> None:
    contract = _load_contract()
    contract["payoutRule"] = payout_rule

    _assert_failed(
        contract,
        RuntimeContext.for_contracts([contract]),
        EligibilityFailure.PAYOUT_NOT_TOTAL,
    )


def test_fails_when_locked_bond_cannot_cover_max_aggregate_exposure() -> None:
    contract = _load_contract()
    ctx = replace(
        RuntimeContext.for_contracts([contract]),
        locked_bonds={contract["contractId"]: int(contract["bond"]["maxAggregateExposure"]) - 1},
    )
    _assert_failed(
        contract,
        ctx,
        EligibilityFailure.BOND_INSUFFICIENT_FOR_MAX_EXPOSURE,
    )


def test_malformed_numeric_contract_values_fail_closed() -> None:
    contract = _load_contract()
    contract["payoutRule"] = copy.deepcopy(contract["payoutRule"])
    contract["payoutRule"]["maxPayout"] = "not-an-int"

    _assert_failed(
        contract,
        RuntimeContext.for_contracts([_load_contract()]),
        EligibilityFailure.BOND_INSUFFICIENT_FOR_MAX_EXPOSURE,
    )


def test_malformed_mapping_runtime_context_fails_closed() -> None:
    contract = _load_contract()
    ctx = {
        "closed_scope_contracts": {contract["contractId"]},
        "compensators": "not-a-mapping",
        "evidence_schemas": "not-a-mapping",
        "locked_bonds": "not-a-mapping",
        "open_exposure": "not-a-mapping",
    }

    result = is_eligible(contract, ctx)

    assert not result.passed
    assert result.reason == EligibilityFailure.RECOVERY_UNAVAILABLE
