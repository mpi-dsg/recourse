from __future__ import annotations

from dataclasses import replace

import pytest

from recourse_harness.faults import FAULT_ROUTE_TABLE, FaultClass, inject_fault
from recourse_harness.traces import generate_trace


def _compensable_call():
    trace = generate_trace(num_calls=3, failure_density=0.5, concurrency=2, seed=42)
    return trace.calls[1]


@pytest.mark.parametrize("fault_class", [f for f in FaultClass if f is not FaultClass.NONE])
def test_fault_injectors_are_deterministic_and_pre_registered(fault_class: FaultClass) -> None:
    call = _compensable_call()

    first = inject_fault(call, fault_class, seed=123)
    second = inject_fault(call, fault_class, seed=123)

    assert first == second
    assert first.pre_registered_route == FAULT_ROUTE_TABLE[fault_class]
    assert first.mutated_call.metadata["faultClass"] == fault_class.value


def test_none_fault_records_expected_route_without_mutating_business_fields() -> None:
    call = _compensable_call()
    injection = inject_fault(call, FaultClass.NONE, seed=123)

    assert injection.mutated_call == replace(
        call,
        metadata={**call.metadata, "faultClass": "none", "faultRoute": "optimistic"},
    )
    assert injection.pre_registered_route == FAULT_ROUTE_TABLE[FaultClass.NONE]
