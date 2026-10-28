"""Pure ex post objective-settleability predicate."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from enum import StrEnum
from typing import Any, Mapping

from .eligibility import RuntimeContext, is_eligible

TOKEN_UNITS_PER_USD = Decimal("1000000")
_PROVENANCE_RANK = {"L0": 0, "L1": 1, "L2": 2, "L3": 3}
_SOURCE_PROVENANCE = {
    "provider-receipt": "L1",
    "snapshot-diff": "L1",
    "cost-explorer": "L1",
    "reflog": "L2",
    "compensator-attested": "L2",
}
_ALLOWED_RECOVERY_OUTCOMES = frozenset({"success", "partial", "failure", "inconclusive"})
_NON_OBJECTIVE_RECOVERY_OUTCOMES = frozenset({"failure", "inconclusive"})
_HEX32_LENGTH = 66


class SettlementRoute(StrEnum):
    INELIGIBLE = "ineligible"
    OPTIMISTIC = "optimistic"
    ARBITRATED = "arbitrated"
    EXCLUDED = "excluded"


class Predicate(StrEnum):
    ELIGIBLE = "Eligible"
    WITHIN_SCOPE = "WithinScope"
    EVIDENCE_OK = "EvidenceOK"
    RECOVERY_OK = "RecoveryOK"
    RESIDUAL_OK = "ResidualOK"
    NO_EXCLUDED = "NoExcluded"
    COMPUTABLE = "Computable"
    COLLATERAL_OK = "CollateralOK"


@dataclass(frozen=True)
class ActionInstance:
    contract: Mapping[str, Any]
    effect_receipt: Mapping[str, Any]
    recovery_receipt: Mapping[str, Any]
    runtime_ctx: RuntimeContext
    observed_scope: Mapping[str, Any] | None = None
    evidence_provenance: str | None = None
    available_collateral: int | None = None
    excluded_harms: frozenset[str] | None = None
    effect_signature_verified: bool = False
    recovery_signature_verified: bool = False
    effect_receipt_digest: str | None = None


@dataclass(frozen=True)
class SettleabilityResult:
    route: SettlementRoute
    failed_predicate: Predicate | None
    reason: str = ""
    payout: int = 0


def is_settleable(sigma: ActionInstance) -> SettleabilityResult:
    eligibility = is_eligible(sigma.contract, sigma.runtime_ctx)
    if not eligibility.passed:
        return SettleabilityResult(
            SettlementRoute.INELIGIBLE,
            Predicate.ELIGIBLE,
            eligibility.reason.value if eligibility.reason else eligibility.detail,
        )

    if not _within_scope(sigma.contract.get("resourceScope", {}), sigma.observed_scope):
        return SettleabilityResult(
            SettlementRoute.EXCLUDED,
            Predicate.WITHIN_SCOPE,
            "effect receipt does not establish a resource within κ.scope",
        )

    if not _evidence_ok(sigma):
        return SettleabilityResult(
            SettlementRoute.ARBITRATED,
            Predicate.EVIDENCE_OK,
            "effect or recovery evidence does not satisfy κ.evidenceSchema",
        )

    if not _recovery_ok(sigma):
        return SettleabilityResult(
            SettlementRoute.ARBITRATED,
            Predicate.RECOVERY_OK,
            "recovery receipt is absent, failed, stale, inconclusive, or malformed",
        )

    if not _residual_ok(sigma):
        return SettleabilityResult(
            SettlementRoute.EXCLUDED,
            Predicate.RESIDUAL_OK,
            "residual measurements include losses outside κ.coveredLossClass",
        )

    if sigma.excluded_harms is None:
        return SettleabilityResult(
            SettlementRoute.ARBITRATED,
            Predicate.NO_EXCLUDED,
            "absence of excluded harm has not been externally verified",
        )

    if sigma.excluded_harms:
        return SettleabilityResult(
            SettlementRoute.EXCLUDED,
            Predicate.NO_EXCLUDED,
            "observed harm includes an excluded class",
        )

    payout = compute_payout(sigma.contract.get("payoutRule", {}), sigma.recovery_receipt)
    if payout is None:
        return SettleabilityResult(
            SettlementRoute.ARBITRATED,
            Predicate.COMPUTABLE,
            "payout cannot be computed from effect and recovery receipts",
        )

    if not _collateral_ok(sigma, payout):
        return SettleabilityResult(
            SettlementRoute.ARBITRATED,
            Predicate.COLLATERAL_OK,
            "computed payout exceeds available collateral",
            payout=payout,
        )

    return SettleabilityResult(SettlementRoute.OPTIMISTIC, None, payout=payout)


def compute_payout(rule: Mapping[str, Any], recovery_receipt: Mapping[str, Any]) -> int | None:
    payout = _compute_uncapped_payout(rule, recovery_receipt.get("residualMeasurements", {}))
    if payout is None:
        return None
    max_payout = _int_or_none(rule.get("maxPayout", payout))
    if max_payout is None or max_payout < 0:
        return None
    return min(payout, max_payout)


def _within_scope(
    contract_scope: Mapping[str, Any], observed_scope: Mapping[str, Any] | None
) -> bool:
    if not isinstance(contract_scope, Mapping) or not isinstance(observed_scope, Mapping):
        return False
    if observed_scope.get("type") != contract_scope.get("type"):
        return False
    expected = contract_scope.get("descriptor", {})
    actual = observed_scope.get("descriptor", {})
    if not isinstance(expected, Mapping) or not isinstance(actual, Mapping):
        return False
    return all(actual.get(key) == value for key, value in expected.items())


def _evidence_ok(sigma: ActionInstance) -> bool:
    effect = sigma.effect_receipt
    recovery = sigma.recovery_receipt
    required = str(sigma.contract.get("evidenceSchema", {}).get("requiredProvenance", "L3"))

    if (
        sigma.effect_signature_verified is not True
        or sigma.recovery_signature_verified is not True
    ):
        return False
    if not _receipt_binding_ok(sigma):
        return False

    for key in ("preStateDigest", "postStateDigest", "resourceId", "signature"):
        if not effect.get(key):
            return False

    if required == "L1" and not effect.get("providerReceiptHash"):
        return False

    provided_provenance = sigma.evidence_provenance
    if provided_provenance is None:
        return False
    if provided_provenance not in {"L0", "L1"}:
        return False
    if not _provenance_satisfies(provided_provenance, required):
        return False

    if not recovery.get("restoreArtifactHash") or not recovery.get("signature"):
        return False

    if provided_provenance == "L0":
        return True

    measurements = recovery.get("residualMeasurements", {})
    if not isinstance(measurements, Mapping):
        return False
    for measurement in measurements.values():
        if not isinstance(measurement, Mapping):
            return False
        source = str(measurement.get("evidenceSource", ""))
        provided = _SOURCE_PROVENANCE.get(source, "L3")
        if not _provenance_satisfies(provided, required):
            return False
    return True


def _receipt_binding_ok(sigma: ActionInstance) -> bool:
    contract_id = str(sigma.contract.get("contractId", ""))
    schema_version = sigma.contract.get("schemaVersion")
    effect = sigma.effect_receipt
    recovery = sigma.recovery_receipt

    if effect.get("schemaVersion") != schema_version or recovery.get("schemaVersion") != schema_version:
        return False
    if str(effect.get("contractId", "")) != contract_id:
        return False
    if str(recovery.get("contractId", "")) != contract_id:
        return False

    effect_hash = str(recovery.get("effectReceiptHash", "")).lower()
    computed_effect_hash = str(sigma.effect_receipt_digest or "").lower()
    if not _is_hex32(effect_hash) or not _is_hex32(computed_effect_hash):
        return False

    return computed_effect_hash == effect_hash


def _provenance_satisfies(provided: str, required: str) -> bool:
    return _PROVENANCE_RANK.get(provided, 99) <= _PROVENANCE_RANK.get(required, -1)


def _recovery_ok(sigma: ActionInstance) -> bool:
    recovery = sigma.recovery_receipt
    if recovery.get("outcome") not in _ALLOWED_RECOVERY_OUTCOMES:
        return False
    if recovery.get("outcome") in _NON_OBJECTIVE_RECOVERY_OUTCOMES:
        return False

    start = _int_or_none(recovery.get("recoveryStartTs"))
    end = _int_or_none(recovery.get("recoveryEndTs"))
    effect_ts = _int_or_none(sigma.effect_receipt.get("timestamp"))
    deadline = _int_or_none(sigma.contract.get("deadlines", {}).get("recoverySeconds"))
    if start is None or end is None or effect_ts is None or deadline is None:
        return False
    return 0 <= effect_ts <= start <= end <= effect_ts + deadline


def _residual_ok(sigma: ActionInstance) -> bool:
    covered = set(sigma.contract.get("coveredLossClass", {}).get("codes", ()))
    residual = sigma.recovery_receipt.get("residualMeasurements", {})
    for code, measurement in residual.items():
        if code not in covered:
            return False
        value = _decimal_or_none(measurement.get("value"))
        if value is None or value < 0:
            return False
    # Boundedness: alleged residual loss must be capped by κ.maxPayout. If the
    # uncapped payout exceeds the cap, the contract did not actually bound the
    # harm — per main.tex §III rule 3 this leaves objective Recourse and
    # routes to excluded rather than arbitration.
    rule = sigma.contract.get("payoutRule", {})
    uncapped = _compute_uncapped_payout(rule, residual)
    if uncapped is not None:
        max_payout = _int_or_none(rule.get("maxPayout", 0)) or 0
        if uncapped > max_payout:
            return False
    return True


def _collateral_ok(sigma: ActionInstance, payout: int) -> bool:
    if payout < 0:
        return False
    available = _int_or_none(sigma.available_collateral)
    if available is None or available < 0:
        return False
    return payout <= available


def _is_hex32(value: str) -> bool:
    return (
        len(value) == _HEX32_LENGTH
        and value.startswith("0x")
        and all(character in "0123456789abcdef" for character in value[2:])
    )


def _compute_uncapped_payout(
    rule: Mapping[str, Any], residual_measurements: Mapping[str, Mapping[str, Any]]
) -> int | None:
    rule_type = str(rule.get("type", ""))
    params = rule.get("params", {})

    if rule_type == "composite":
        total = 0
        components = params.get("components", ())
        if not components:
            return None
        for component in components:
            component_payout = _compute_uncapped_payout(component, residual_measurements)
            if component_payout is None:
                return None
            weight = _decimal_or_none(component.get("weight", 1))
            if weight is None:
                return None
            total += int((Decimal(component_payout) * weight).to_integral_value(ROUND_HALF_UP))
        return total

    if rule_type == "rowCountSchedule":
        value = _first_measurement_value(
            residual_measurements, ("rows_deleted", "rows_modified", "history_bytes_lost")
        )
        per_unit = _decimal_or_none(params.get("perRowUsd"))
        if value is None or per_unit is None:
            return None
        amount = value * per_unit
        minimum = _decimal_or_none(params.get("minPayoutUsd", "0"))
        amount = max(amount, minimum or Decimal("0"))
        return _usd_to_units(amount)

    if rule_type == "downtimeSchedule":
        value = _measurement_value(residual_measurements, "downtime_seconds")
        per_second = _decimal_or_none(params.get("perSecondUsd"))
        if value is None or per_second is None:
            return None
        threshold = _decimal_or_none(params.get("thresholdSeconds", "0")) or Decimal("0")
        billable = max(Decimal("0"), value - threshold)
        return _usd_to_units(billable * per_second)

    if rule_type == "excessSpendSchedule":
        value = _measurement_value(residual_measurements, "excess_spend_usd")
        ratio = _decimal_or_none(params.get("coverageRatio"))
        if value is None or ratio is None:
            return None
        deductible = _decimal_or_none(params.get("deductibleUsd", "0")) or Decimal("0")
        return _usd_to_units(max(Decimal("0"), value - deductible) * ratio)

    return None


def _first_measurement_value(
    measurements: Mapping[str, Mapping[str, Any]], names: tuple[str, ...]
) -> Decimal | None:
    for name in names:
        value = _measurement_value(measurements, name)
        if value is not None:
            return value
    return None


def _measurement_value(measurements: Mapping[str, Mapping[str, Any]], name: str) -> Decimal | None:
    if name not in measurements:
        return None
    return _decimal_or_none(measurements[name].get("value"))


def _decimal_or_none(value: Any) -> Decimal | None:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    return parsed if parsed.is_finite() else None


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _usd_to_units(value: Decimal) -> int:
    return int((value * TOKEN_UNITS_PER_USD).to_integral_value(ROUND_HALF_UP))
