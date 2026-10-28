"""Pure recourse-eligibility predicate for ex ante contract admission."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from typing import Any

RECOVERY_OUTCOMES = frozenset({"success", "partial", "failure", "inconclusive"})
EXCLUDED_HARM_CLASSES = frozenset(
    {
        "data_exfiltration",
        "public_disclosure",
        "irreversible_transfer",
        "physical_action",
        "reputation_damage",
        "uncapped_downstream",
    }
)
_PROVENANCE_RANK = {"L0": 0, "L1": 1, "L2": 2, "L3": 3}
_KNOWN_PAYOUT_RULES = frozenset(
    {"rowCountSchedule", "downtimeSchedule", "excessSpendSchedule", "composite"}
)
_OPTIONAL_NONNEGATIVE_PAYOUT_PARAMS = frozenset(
    {"deductibleUsd", "minPayoutUsd", "thresholdSeconds"}
)


class EligibilityFailure(StrEnum):
    NOT_COMPENSABLE = "NOT_COMPENSABLE"
    SCOPE_NOT_CLOSED = "SCOPE_NOT_CLOSED"
    RECOVERY_UNAVAILABLE = "RECOVERY_UNAVAILABLE"
    EVIDENCE_SCHEMA_UNDERSPECIFIED = "EVIDENCE_SCHEMA_UNDERSPECIFIED"
    COVERED_LOSS_INCLUDES_EXCLUDED = "COVERED_LOSS_INCLUDES_EXCLUDED"
    PAYOUT_NOT_TOTAL = "PAYOUT_NOT_TOTAL"
    BOND_INSUFFICIENT_FOR_MAX_EXPOSURE = "BOND_INSUFFICIENT_FOR_MAX_EXPOSURE"


@dataclass(frozen=True)
class EligibilityResult:
    passed: bool
    reason: EligibilityFailure | None = None
    detail: str = ""

    @classmethod
    def pass_(cls) -> "EligibilityResult":
        return cls(passed=True)

    @classmethod
    def fail(cls, reason: EligibilityFailure, detail: str = "") -> "EligibilityResult":
        return cls(passed=False, reason=reason, detail=detail)


@dataclass(frozen=True)
class CompensatorCapability:
    max_snapshot_age_seconds: int
    retention_seconds: int
    auth_policy_hashes: frozenset[str]


@dataclass(frozen=True)
class EvidenceSchemaCapability:
    strongest_provenance: str
    access_policy_hashes: frozenset[str]


@dataclass(frozen=True)
class RuntimeContext:
    """All external facts needed by `is_eligible`, supplied explicitly."""

    closed_scope_contracts: frozenset[str]
    compensators: Mapping[str, CompensatorCapability]
    evidence_schemas: Mapping[str, EvidenceSchemaCapability]
    locked_bonds: Mapping[str, int]
    open_exposure: Mapping[str, int]

    @classmethod
    def empty(cls) -> "RuntimeContext":
        return cls(
            closed_scope_contracts=frozenset(),
            compensators={},
            evidence_schemas={},
            locked_bonds={},
            open_exposure={},
        )

    @classmethod
    def for_contracts(cls, contracts: Sequence[Mapping[str, Any]]) -> "RuntimeContext":
        closed: set[str] = set()
        compensators: dict[str, CompensatorCapability] = {}
        evidence: dict[str, EvidenceSchemaCapability] = {}
        locked: dict[str, int] = {}
        exposure: dict[str, int] = {}

        for contract in contracts:
            contract_id = str(contract["contractId"])
            closed.add(contract_id)

            recovery = contract["recoveryOperator"]
            compensators[str(recovery["compensatorId"])] = CompensatorCapability(
                max_snapshot_age_seconds=int(recovery["freshnessSeconds"]),
                retention_seconds=int(recovery["retentionSeconds"]),
                auth_policy_hashes=frozenset({str(recovery["authPolicyHash"])}),
            )

            evidence_schema = contract["evidenceSchema"]
            evidence[str(evidence_schema["schemaId"])] = EvidenceSchemaCapability(
                strongest_provenance=str(evidence_schema["requiredProvenance"]),
                access_policy_hashes=frozenset({str(evidence_schema["accessPolicyHash"])}),
            )

            locked[contract_id] = int(contract["bond"]["maxAggregateExposure"])
            exposure[contract_id] = 0

        return cls(
            closed_scope_contracts=frozenset(closed),
            compensators=compensators,
            evidence_schemas=evidence,
            locked_bonds=locked,
            open_exposure=exposure,
        )


def is_eligible(
    k: Mapping[str, Any], runtime_ctx: RuntimeContext | Mapping[str, Any]
) -> EligibilityResult:
    """Return whether κ is recourse-eligible under explicit runtime facts."""

    ctx = _coerce_context(runtime_ctx)
    contract_id = str(k.get("contractId", ""))

    if k.get("effectClass") != "compensable":
        return EligibilityResult.fail(
            EligibilityFailure.NOT_COMPENSABLE,
            "only compensable effects can be admitted to recourse",
        )

    if contract_id not in ctx.closed_scope_contracts and "*" not in ctx.closed_scope_contracts:
        return EligibilityResult.fail(
            EligibilityFailure.SCOPE_NOT_CLOSED,
            "resource scope is not declared closed for this action template",
        )

    if not _recovery_available(k, ctx):
        return EligibilityResult.fail(
            EligibilityFailure.RECOVERY_UNAVAILABLE,
            "registered compensator cannot satisfy freshness, retention, or auth preconditions",
        )

    if not _evidence_schema_available(k, ctx):
        return EligibilityResult.fail(
            EligibilityFailure.EVIDENCE_SCHEMA_UNDERSPECIFIED,
            "required evidence schema or provenance is unavailable",
        )

    codes = set(k.get("coveredLossClass", {}).get("codes", ()))
    if codes & EXCLUDED_HARM_CLASSES:
        return EligibilityResult.fail(
            EligibilityFailure.COVERED_LOSS_INCLUDES_EXCLUDED,
            "covered loss codes include non-recoverable or non-measurable harm",
        )

    if not _payout_rule_is_total(k.get("payoutRule", {})):
        return EligibilityResult.fail(
            EligibilityFailure.PAYOUT_NOT_TOTAL,
            "payout rule is not total over schema-valid recovery outcomes",
        )

    if not _bond_covers_exposure(k, ctx):
        return EligibilityResult.fail(
            EligibilityFailure.BOND_INSUFFICIENT_FOR_MAX_EXPOSURE,
            "locked collateral cannot cover admitted aggregate exposure",
        )

    return EligibilityResult.pass_()


def _coerce_context(runtime_ctx: RuntimeContext | Mapping[str, Any]) -> RuntimeContext:
    if isinstance(runtime_ctx, RuntimeContext):
        return runtime_ctx
    return RuntimeContext(
        closed_scope_contracts=frozenset(runtime_ctx.get("closed_scope_contracts", ())),
        compensators=_coerce_compensators(runtime_ctx.get("compensators", {})),
        evidence_schemas=_coerce_evidence_schemas(runtime_ctx.get("evidence_schemas", {})),
        locked_bonds=_coerce_int_mapping(runtime_ctx.get("locked_bonds", {})),
        open_exposure=_coerce_int_mapping(runtime_ctx.get("open_exposure", {})),
    )


def _coerce_compensators(raw: Mapping[str, Any]) -> dict[str, CompensatorCapability]:
    if not isinstance(raw, Mapping):
        return {}
    capabilities: dict[str, CompensatorCapability] = {}
    for compensator_id, capability in raw.items():
        if isinstance(capability, CompensatorCapability):
            capabilities[str(compensator_id)] = capability
            continue
        if not isinstance(capability, Mapping):
            continue
        max_snapshot_age = _int_or_none(capability.get("max_snapshot_age_seconds"))
        retention = _int_or_none(capability.get("retention_seconds"))
        if max_snapshot_age is None or retention is None:
            continue
        capabilities[str(compensator_id)] = CompensatorCapability(
            max_snapshot_age_seconds=max_snapshot_age,
            retention_seconds=retention,
            auth_policy_hashes=frozenset(str(v) for v in capability.get("auth_policy_hashes", ())),
        )
    return capabilities


def _coerce_evidence_schemas(raw: Mapping[str, Any]) -> dict[str, EvidenceSchemaCapability]:
    if not isinstance(raw, Mapping):
        return {}
    capabilities: dict[str, EvidenceSchemaCapability] = {}
    for schema_id, capability in raw.items():
        if isinstance(capability, EvidenceSchemaCapability):
            capabilities[str(schema_id)] = capability
            continue
        if not isinstance(capability, Mapping):
            continue
        capabilities[str(schema_id)] = EvidenceSchemaCapability(
            strongest_provenance=str(capability.get("strongest_provenance", "L3")),
            access_policy_hashes=frozenset(
                str(v) for v in capability.get("access_policy_hashes", ())
            ),
        )
    return capabilities


def _recovery_available(k: Mapping[str, Any], ctx: RuntimeContext) -> bool:
    recovery = k.get("recoveryOperator", {})
    compensator_id = str(recovery.get("compensatorId", ""))
    capability = ctx.compensators.get(compensator_id)
    if capability is None:
        return False

    freshness = _int_or_none(recovery.get("freshnessSeconds"))
    retention = _int_or_none(recovery.get("retentionSeconds"))
    if freshness is None or retention is None:
        return False

    if capability.max_snapshot_age_seconds > freshness:
        return False
    if capability.retention_seconds < retention:
        return False

    auth_hash = str(recovery.get("authPolicyHash", ""))
    return "*" in capability.auth_policy_hashes or auth_hash in capability.auth_policy_hashes


def _evidence_schema_available(k: Mapping[str, Any], ctx: RuntimeContext) -> bool:
    evidence = k.get("evidenceSchema", {})
    capability = ctx.evidence_schemas.get(str(evidence.get("schemaId", "")))
    if capability is None:
        return False

    required = str(evidence.get("requiredProvenance", "L3"))
    if _PROVENANCE_RANK.get(capability.strongest_provenance, 99) > _PROVENANCE_RANK.get(
        required, -1
    ):
        return False

    access_hash = str(evidence.get("accessPolicyHash", ""))
    return "*" in capability.access_policy_hashes or access_hash in capability.access_policy_hashes


def _payout_rule_is_total(rule: Mapping[str, Any]) -> bool:
    if not isinstance(rule, Mapping):
        return False
    rule_type = str(rule.get("type", ""))
    if rule_type not in _KNOWN_PAYOUT_RULES:
        return False

    params = rule.get("params", {})
    if not isinstance(params, Mapping):
        return False
    if bool(params.get("requiresSubjectiveJudgment", False)):
        return False
    if any(
        key in params and not _is_nonnegative_number(params[key])
        for key in _OPTIONAL_NONNEGATIVE_PAYOUT_PARAMS
    ):
        return False

    outcomes = params.get("outcomesCovered")
    if outcomes is not None:
        if not isinstance(outcomes, Sequence) or isinstance(outcomes, (str, bytes)):
            return False
        if set(outcomes) != RECOVERY_OUTCOMES:
            return False

    if rule_type == "composite":
        components = params.get("components", ())
        if (
            not isinstance(components, Sequence)
            or isinstance(components, (str, bytes))
            or not components
        ):
            return False
        return bool(components) and all(
            isinstance(component, Mapping)
            and (
                "weight" not in component
                or _is_nonnegative_number(component["weight"])
            )
            and _payout_rule_is_total(
                {
                    "type": component.get("type"),
                    "params": component.get("params", {}),
                }
            )
            for component in components
        )
    if rule_type == "rowCountSchedule":
        return _has_nonnegative_number(params, "perRowUsd")
    if rule_type == "downtimeSchedule":
        return _has_nonnegative_number(params, "perSecondUsd")
    if rule_type == "excessSpendSchedule":
        return _has_nonnegative_number(params, "coverageRatio")
    return False


def _has_nonnegative_number(values: Mapping[str, Any], key: str) -> bool:
    return key in values and _is_nonnegative_number(values[key])


def _is_nonnegative_number(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return False
    return parsed.is_finite() and parsed >= 0


def _bond_covers_exposure(k: Mapping[str, Any], ctx: RuntimeContext) -> bool:
    contract_id = str(k.get("contractId", ""))
    bond = k.get("bond", {})
    payout = k.get("payoutRule", {})
    max_payout = _int_or_none(payout.get("maxPayout"))
    max_exposure = _int_or_none(bond.get("maxAggregateExposure"))
    min_amount = _int_or_none(bond.get("minAmount")) or 0
    locked = _int_or_none(ctx.locked_bonds.get(contract_id, min_amount))
    open_exposure = _int_or_none(ctx.open_exposure.get(contract_id, 0))
    if max_payout is None or max_exposure is None or locked is None or open_exposure is None:
        return False

    if max_payout <= 0 or max_exposure < max_payout:
        return False
    return locked >= max_exposure and locked - open_exposure >= max_payout


def _coerce_int_mapping(raw: Mapping[str, Any]) -> dict[str, int]:
    if not isinstance(raw, Mapping):
        return {}
    coerced: dict[str, int] = {}
    for key, value in raw.items():
        parsed = _int_or_none(value)
        if parsed is not None:
            coerced[str(key)] = parsed
    return coerced


def _int_or_none(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
