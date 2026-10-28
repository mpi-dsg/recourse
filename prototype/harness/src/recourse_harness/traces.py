"""Deterministic synthetic traces for Recourse evaluation cells."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, replace
from typing import Any, Mapping


@dataclass(frozen=True)
class ProposedToolCall:
    schemaVersion: int
    traceId: str
    call_id: str
    workload: str
    action: str
    resource: str
    risky: bool
    requires_human_approval: bool
    ground_truth: str
    gross_harm: int
    residual_harm: int
    payout_hint: int
    concurrency_group: int
    metadata: dict[str, Any]

    @property
    def callId(self) -> str:
        return self.call_id

    def to_wire(self) -> dict[str, Any]:
        return {
            "action": self.action,
            "callId": self.call_id,
            "concurrencyGroup": self.concurrency_group,
            "groundTruth": self.ground_truth,
            "grossHarm": self.gross_harm,
            "metadata": self.metadata,
            "payoutHint": self.payout_hint,
            "requiresHumanApproval": self.requires_human_approval,
            "residualHarm": self.residual_harm,
            "resource": self.resource,
            "risky": self.risky,
            "schemaVersion": self.schemaVersion,
            "traceId": self.traceId,
            "workload": self.workload,
        }

    @classmethod
    def from_wire(cls, data: Mapping[str, Any]) -> "ProposedToolCall":
        return cls(
            schemaVersion=int(data["schemaVersion"]),
            traceId=str(data["traceId"]),
            call_id=str(data["callId"]),
            workload=str(data["workload"]),
            action=str(data["action"]),
            resource=str(data["resource"]),
            risky=bool(data["risky"]),
            requires_human_approval=bool(data["requiresHumanApproval"]),
            ground_truth=str(data["groundTruth"]),
            gross_harm=int(data["grossHarm"]),
            residual_harm=int(data["residualHarm"]),
            payout_hint=int(data["payoutHint"]),
            concurrency_group=int(data["concurrencyGroup"]),
            metadata=dict(data["metadata"]),
        )


@dataclass(frozen=True)
class Trace:
    trace_id: str
    calls: tuple[ProposedToolCall, ...]

    def to_jsonl(self) -> str:
        return "".join(
            json.dumps(call.to_wire(), separators=(",", ":")) + "\n" for call in self.calls
        )

    @classmethod
    def from_jsonl(cls, data: str) -> "Trace":
        calls = tuple(
            ProposedToolCall.from_wire(json.loads(line)) for line in data.splitlines() if line
        )
        trace_id = calls[0].traceId if calls else "trace-empty"
        if any(call.traceId != trace_id for call in calls):
            raise ValueError("mixed trace ids in JSONL input")
        return cls(trace_id=trace_id, calls=calls)


def generate_trace(
    *,
    num_calls: int,
    failure_density: float,
    concurrency: int,
    seed: int,
    scope_distribution: Mapping[str, float] | None = None,
    workload: str | None = None,
    correlation_prob: float = 0.0,
    correlation_burst_size: int = 0,
) -> Trace:
    if num_calls <= 0:
        raise ValueError("num_calls must be positive")
    if not 0.0 <= failure_density <= 1.0:
        raise ValueError("failure_density must be between 0 and 1")
    if concurrency <= 0:
        raise ValueError("concurrency must be positive")
    if not 0.0 <= correlation_prob <= 1.0:
        raise ValueError("correlation_prob must be between 0 and 1")
    if correlation_burst_size < 0:
        raise ValueError("correlation_burst_size must be non-negative")
    actions = {
        "postgres": "delete",
        "git": "force-push",
        "cloud": "set-capacity",
    }
    if workload is not None and workload not in actions:
        raise ValueError(f"unknown workload: {workload}")
    if scope_distribution is not None and not scope_distribution:
        raise ValueError("scope_distribution must not be empty")

    scope = max((scope_distribution or {"tenant": 1.0}).items(), key=lambda item: item[1])[0]
    trace_id = f"trace-{seed:08x}"
    workloads = (workload,) if workload is not None else ("postgres", "git", "cloud")
    calls: list[ProposedToolCall] = []
    failure_count = _failure_count(num_calls, failure_density)
    first_failure_index = num_calls - failure_count
    for i in range(num_calls):
        workload = workloads[i % len(workloads)]
        ground_truth = _ground_truth_for(i, num_calls, failure_density)
        gross = 0
        residual = 0
        payout = 0
        if ground_truth == "will_fail_compensable":
            gross = 700 + seed % 100 + (i - first_failure_index)
            residual = round(gross * 0.4)
            payout = gross - residual
        elif ground_truth == "will_fail_excluded":
            gross = 900 + seed % 100 + (i - first_failure_index)
            residual = gross
        tenant = f"tenant-{i:02d}"
        calls.append(
            ProposedToolCall(
                schemaVersion=1,
                traceId=trace_id,
                call_id=f"{trace_id}-{i:04d}",
                workload=workload,
                action=actions[workload],
                resource=f"{workload}:{tenant}",
                risky=True,
                requires_human_approval=ground_truth in {"policy_violation", "will_fail_excluded"},
                ground_truth=ground_truth,
                gross_harm=gross,
                residual_harm=residual,
                payout_hint=payout,
                concurrency_group=i % max(1, concurrency),
                metadata={"scope": scope, "tenantId": tenant},
            )
        )
    if correlation_prob > 0.0 and correlation_burst_size > 0:
        calls = _apply_correlation_burst(
            calls,
            seed=seed,
            prob=correlation_prob,
            burst_size=correlation_burst_size,
        )
    return Trace(trace_id=trace_id, calls=tuple(calls))


def _apply_correlation_burst(
    calls: list[ProposedToolCall],
    *,
    seed: int,
    prob: float,
    burst_size: int,
) -> list[ProposedToolCall]:
    """Mutate one or more ``burst_size``-aligned windows into correlated failures.

    Models the operational scenario described in RQ10: a bad rollout that
    simultaneously breaks a fixed-size window of in-flight admitted
    actions. The trace is partitioned into back-to-back epochs of length
    ``burst_size`` and each epoch fires an *independent* Bernoulli draw at
    rate ``prob``. When an epoch triggers, every call in that window
    becomes a full-gross-harm compensable failure (no recovery applied).

    Sampling per-epoch (rather than once per trace) keeps the expected
    fraction of impacted calls constant in ``prob`` while letting the
    *peak concurrent shortfall* scale with ``burst_size``, which is the
    signal the RQ10 table is designed to surface.
    """
    if burst_size <= 0 or prob <= 0.0:
        return calls
    mutated = list(calls)
    num_calls = len(calls)
    epoch_index = 0
    start = 0
    while start < num_calls:
        end = min(start + burst_size, num_calls)
        digest = hashlib.sha256(
            f"{seed}:correlation:{epoch_index}".encode("utf-8")
        ).digest()
        draw = int.from_bytes(digest[:8], "big") / float(1 << 64)
        if draw < prob:
            for i in range(start, end):
                call = mutated[i]
                # Synchronous burst: a fixed-magnitude harm per impacted
                # action so the per-window peak lock scales linearly with k.
                # The 700-unit base matches the baseline
                # ``will_fail_compensable`` magnitude so RQ10 lines up
                # with RQ3/RQ8 on the bond scale.
                gross = 700 + (seed % 100) + i
                # Tag every burst victim with the same epoch index so the
                # metric extractor can aggregate per-window (concurrent)
                # bond pressure across the impacted calls.
                metadata = {
                    **call.metadata,
                    "correlationBurstIndex": epoch_index,
                }
                mutated[i] = replace(
                    call,
                    risky=True,
                    requires_human_approval=False,
                    ground_truth="will_fail_compensable",
                    gross_harm=gross,
                    # Full residual: no recovery dampening — this is the
                    # "bad rollout" pathology we want to surface.
                    residual_harm=gross,
                    payout_hint=gross,
                    metadata=metadata,
                )
        epoch_index += 1
        start = end
    return mutated


def _failure_count(num_calls: int, failure_density: float) -> int:
    return max(0, min(num_calls, int(num_calls * failure_density + 0.5)))


def _ground_truth_for(index: int, num_calls: int, failure_density: float) -> str:
    count = _failure_count(num_calls, failure_density)
    if count == 0:
        return "ok"
    first_failure_index = num_calls - count
    if index < first_failure_index:
        return "ok"
    return ("will_fail_compensable", "policy_violation", "will_fail_excluded")[
        (index - first_failure_index) % 3
    ]
