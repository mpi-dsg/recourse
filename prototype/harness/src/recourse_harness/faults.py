"""Pre-registered predicate-failure injection for RQ5."""
from __future__ import annotations

from dataclasses import dataclass, replace
from enum import StrEnum
from typing import Any

from .traces import ProposedToolCall


class FaultClass(StrEnum):
    NONE = "none"
    OBS_HIDE_PRESTATE = "OBS_HIDE_PRESTATE"
    OBS_REMOVE_PROVIDER_SIG = "OBS_REMOVE_PROVIDER_SIG"
    OBS_AMBIGUOUS_RESOURCE = "OBS_AMBIGUOUS_RESOURCE"
    REC_STALE_SNAPSHOT = "REC_STALE_SNAPSHOT"
    REC_INVALID_ARTIFACT = "REC_INVALID_ARTIFACT"
    REC_PARTIAL_FAILURE = "REC_PARTIAL_FAILURE"
    BND_OUT_OF_CAP_LOSS = "BND_OUT_OF_CAP_LOSS"
    BND_DOWNSTREAM_LEAK = "BND_DOWNSTREAM_LEAK"
    CMP_SUBJECTIVE_RULE = "CMP_SUBJECTIVE_RULE"


FAULT_ROUTE_TABLE = {
    FaultClass.NONE: "optimistic",
    FaultClass.OBS_HIDE_PRESTATE: "arbitrated",
    FaultClass.OBS_REMOVE_PROVIDER_SIG: "arbitrated",
    FaultClass.OBS_AMBIGUOUS_RESOURCE: "arbitrated",
    FaultClass.REC_STALE_SNAPSHOT: "arbitrated",
    FaultClass.REC_INVALID_ARTIFACT: "arbitrated",
    FaultClass.REC_PARTIAL_FAILURE: "arbitrated",
    FaultClass.BND_OUT_OF_CAP_LOSS: "excluded",
    FaultClass.BND_DOWNSTREAM_LEAK: "excluded",
    FaultClass.CMP_SUBJECTIVE_RULE: "arbitrated",
}


@dataclass(frozen=True)
class FaultInjection:
    mutated_call: ProposedToolCall
    pre_registered_route: str


def observed_fault_overrides(fault_class: FaultClass) -> dict[str, Any]:
    """Return observed predicate inputs for a fault, not the expected route label."""

    match fault_class:
        case FaultClass.NONE:
            return {}
        case FaultClass.OBS_HIDE_PRESTATE:
            return {"effect_receipt": {"preStateDigest": ""}}
        case FaultClass.OBS_REMOVE_PROVIDER_SIG:
            return {"effect_receipt": {"providerReceiptHash": ""}}
        case FaultClass.OBS_AMBIGUOUS_RESOURCE:
            return {"evidence_provenance": "L3"}
        case FaultClass.REC_STALE_SNAPSHOT:
            return {"recovery_receipt": {"recoveryStartTs": 120, "recoveryEndTs": 121}}
        case FaultClass.REC_INVALID_ARTIFACT:
            return {"recovery_receipt": {"restoreArtifactHash": ""}}
        case FaultClass.REC_PARTIAL_FAILURE:
            return {"recovery_receipt": {"outcome": "failure"}}
        case FaultClass.BND_OUT_OF_CAP_LOSS:
            # Alleged residual loss exceeds the contract's maxPayout cap.
            # Injects a row-count large enough that the uncapped payout under
            # the example postgres rowCountSchedule overruns maxPayout, so
            # ResidualOK (boundedness) fails and the claim routes to excluded.
            return {
                "recovery_receipt": {
                    "residualMeasurements": {
                        "rows_deleted": {
                            "value": "1000000",
                            "evidenceSource": "snapshot-diff",
                        }
                    }
                }
            }
        case FaultClass.BND_DOWNSTREAM_LEAK:
            return {"excluded_harms": ["uncapped_downstream"]}
        case FaultClass.CMP_SUBJECTIVE_RULE:
            return {"evidence_provenance": "L3"}


def inject_fault(call: ProposedToolCall, fault_class: FaultClass, *, seed: int) -> FaultInjection:
    del seed
    route = FAULT_ROUTE_TABLE[fault_class]
    metadata = {**call.metadata, "faultClass": fault_class.value, "faultRoute": route}
    mutated = replace(call, metadata=metadata)
    return FaultInjection(mutated_call=mutated, pre_registered_route=route)
