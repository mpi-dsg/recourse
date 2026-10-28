"""Metric extraction for Recourse evaluation run results."""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any, Mapping

import pandas as pd


@dataclass(frozen=True)
class ActionDecision:
    call_id: str
    risky: bool
    executed: bool
    required_human_approval: bool
    eligible: bool
    route: str
    gross_harm: int
    residual_harm: int
    payout_amount: int
    bond_available: int
    # True only when this action actually passed through and received human
    # approval. This is baseline-specific; it must not be inferred from the
    # proposal's policy flag.
    used_human_approval: bool = False
    recovery_latency_ms: int = 0
    finalization_latency_ms: int = 0
    tool_latency_ms: int = 0
    expected_route: str | None = None
    # Sub-predicate rejection-reason label for the recourse admission step.
    # ``"admitted"`` when the call cleared the predicate pipeline and routed
    # optimistically; otherwise the task-facing sub-predicate label
    # (e.g., ``"EvidenceSchemaOK"``). ``None`` for baselines other than
    # ``recourse`` which lack a predicate-pipeline admission stage.
    rejection_reason: str | None = None
    # Correlated-burst group index when the call was impacted by an RQ10
    # correlation event. ``None`` for ordinary calls; identical across all
    # calls in the same burst window so concurrent peak-lock and shortfall
    # can be aggregated per window.
    correlation_group: int | None = None


@dataclass(frozen=True)
class RunResult:
    baseline: str
    workload: str
    seed: int
    actions: tuple[ActionDecision, ...]
    functional_flags: Mapping[str, bool]
    fault_class: str = "none"
    adversary_class: str = "NONE"
    bond_multiplier: float = 1.0
    approval_rate: float = 1.0
    correlation_prob: float = 0.0
    correlation_burst_size: int = 0


def compute_metrics(result: RunResult) -> dict[str, Any]:
    risky = [a for a in result.actions if a.risky]
    executed_no_approval = [a for a in risky if a.executed and not a.used_human_approval]
    eligible = [a for a in risky if a.eligible]
    settled = [a for a in result.actions if a.executed and a.route in {"optimistic", "arbitrated"}]
    optimistic = [a for a in settled if a.route == "optimistic"]
    arbitrated = [a for a in settled if a.route == "arbitrated"]
    routed = [a for a in result.actions if a.expected_route is not None]
    false_accepts = [a for a in routed if a.route == "optimistic" and a.expected_route != "optimistic"]
    false_rejects = [a for a in routed if a.route != "optimistic" and a.expected_route == "optimistic"]
    gross = sum(a.gross_harm for a in result.actions)
    residual = sum(a.residual_harm for a in result.actions)
    recovered = sum(max(0, a.gross_harm - a.residual_harm) for a in result.actions)
    covered = sum(min(a.residual_harm, a.payout_amount, a.bond_available) for a in result.actions)
    uncompensated = max(0, residual - covered)
    tool_latency_ms = sum(a.tool_latency_ms for a in result.actions)
    # Aggregate per-cell rejection reasons into a deterministic, sorted
    # ``label:count`` comma-separated string. Empty when no decision carried
    # a rejection-reason label (e.g., non-recourse baselines).
    reason_counts = Counter(
        a.rejection_reason for a in result.actions if a.rejection_reason is not None
    )
    rejection_reasons = ",".join(
        f"{label}:{count}" for label, count in sorted(reason_counts.items())
    )
    # Per-correlation-window aggregates (RQ10): concurrent bond locked and
    # uncovered residual across the calls in a single burst window. Zero
    # for cells without RQ10-style correlated bursts.
    burst_bonds: dict[int, int] = defaultdict(int)
    burst_residuals: dict[int, int] = defaultdict(int)
    for action in result.actions:
        if action.correlation_group is None:
            continue
        burst_bonds[action.correlation_group] += int(action.bond_available)
        burst_residuals[action.correlation_group] += int(action.residual_harm)
    bond_peak_concurrent = max(burst_bonds.values(), default=0)
    concurrent_shortfall = max(
        (
            max(0, burst_residuals[g] - burst_bonds[g])
            for g in burst_bonds
        ),
        default=0,
    )
    row: dict[str, Any] = {
        "baseline": result.baseline,
        "workload": result.workload,
        "seed": result.seed,
        "fault_class": result.fault_class,
        "adversary_class": result.adversary_class,
        "bond_multiplier": float(result.bond_multiplier),
        "approval_rate": float(result.approval_rate),
        "correlation_prob": float(result.correlation_prob),
        "correlation_burst_size": int(result.correlation_burst_size),
        "actions": len(result.actions),
        "coverage": _ratio(len(executed_no_approval), len(risky)),
        "gross_harm": gross,
        "recovered": recovered,
        "covered": covered,
        "uncompensated": uncompensated,
        "eligibility_rate": _ratio(len(eligible), len(risky)),
        "objective_settlement_rate": _ratio(len(optimistic), len(settled)),
        "arbitration_rate": _ratio(len(arbitrated), len(settled)),
        "routing_correctness": _ratio(sum(a.route == a.expected_route for a in routed), len(routed)) if routed else 1.0,
        "false_acceptance": _ratio(len(false_accepts), len(routed)),
        "false_rejection": _ratio(len(false_rejects), len(routed)),
        "time_to_recovery": _avg(a.recovery_latency_ms for a in result.actions),
        "time_to_finalization": _avg(a.finalization_latency_ms for a in result.actions),
        "tool_execution_latency_ms": _avg(a.tool_latency_ms for a in result.actions),
        "throughput_qps": _ratio(len(result.actions) * 1000, tool_latency_ms),
        "bond_avg_locked": _avg(a.bond_available for a in result.actions),
        "bond_peak_locked": max((a.bond_available for a in result.actions), default=0),
        "bond_peak_concurrent_locked": bond_peak_concurrent,
        "bond_utilization": _ratio(covered, sum(a.bond_available for a in result.actions)),
        "under_bond_shortfall": sum(max(0, a.residual_harm - a.bond_available) for a in result.actions),
        "concurrent_shortfall": concurrent_shortfall,
        "rejection_reasons": rejection_reasons,
    }
    row.update(result.functional_flags)
    return row


def metrics_frame(results: list[RunResult]) -> pd.DataFrame:
    return pd.DataFrame([compute_metrics(result) for result in results])


def _ratio(num: int | float, den: int | float) -> float:
    return 0.0 if den == 0 else float(num) / float(den)


def _avg(values) -> float:
    items = list(values)
    return 0.0 if not items else float(sum(items)) / float(len(items))
