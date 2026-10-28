#!/usr/bin/env python3
"""Convert provider-bench-git JSON into the rq-provider-git artifacts.

Emits:
  prototype/results/rq-provider-git/metrics.parquet  (mirrors rq1 schema, +provider_backed)
  prototype/results/rq-provider-git/manifest.json
  prototype/results/rq-provider-git/table_provider_git.tex

Usage:
  uv run --with pandas --with pyarrow \
      python prototype/scripts/provider-bench-git-to-parquet.py <input.json> <outdir>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
from collections import Counter
from pathlib import Path

import pandas as pd


RQ1_COLUMNS = [
    "baseline",
    "workload",
    "seed",
    "fault_class",
    "adversary_class",
    "bond_multiplier",
    "approval_rate",
    "correlation_prob",
    "correlation_burst_size",
    "actions",
    "coverage",
    "gross_harm",
    "recovered",
    "covered",
    "uncompensated",
    "eligibility_rate",
    "objective_settlement_rate",
    "arbitration_rate",
    "routing_correctness",
    "false_acceptance",
    "false_rejection",
    "time_to_recovery",
    "time_to_finalization",
    "tool_execution_latency_ms",
    "throughput_qps",
    "bond_avg_locked",
    "bond_peak_locked",
    "bond_peak_concurrent_locked",
    "bond_utilization",
    "under_bond_shortfall",
    "concurrent_shortfall",
    "rejection_reasons",
    "payout_without_operator_consent",
    "third_party_can_challenge",
    "external_history_reconstructable",
]


def build_row(baseline: str, cells: list[dict]) -> dict:
    """Aggregate provider-bench cells into a single metrics row.

    The rq1 schema is a per-(workload, baseline, seed, fault_class) summary; we
    treat the entire 20-cell bench as one trial under the chosen baseline label.
    """
    actions = len(cells)
    gross = sum(c["grossHarmBytes"] for c in cells)
    recovered = sum(c["recoveredBytes"] for c in cells)
    residual = sum(c["residualBytes"] for c in cells)
    rejected = [c for c in cells if c["outcome"] == "adapter-rejected"]
    accepted = [c for c in cells if c["outcome"] != "adapter-rejected"]
    in_scope = [c for c in cells if c["classifierLabel"] == "in-scope"]
    over_scope = [c for c in cells if c["classifierLabel"] == "over-scope"]

    routing_correct = sum(1 for c in cells if c["routingCorrect"])
    routing_correctness = routing_correct / actions if actions else 0.0
    # In this bench each over-scope cell *should* be rejected; in-scope should
    # be accepted. Compute false accept/reject against that ground truth.
    false_acceptance = (
        sum(1 for c in over_scope if c["outcome"] != "adapter-rejected") / len(over_scope)
        if over_scope
        else 0.0
    )
    false_rejection = (
        sum(1 for c in in_scope if c["outcome"] == "adapter-rejected") / len(in_scope)
        if in_scope
        else 0.0
    )

    eligible_for_recovery = [c for c in accepted]
    eligibility_rate = len(eligible_for_recovery) / actions if actions else 0.0
    objective_settlements = sum(
        1 for c in eligible_for_recovery if c["outcome"] == "applied-recovered"
    )
    objective_settlement_rate = (
        objective_settlements / len(eligible_for_recovery) if eligible_for_recovery else 0.0
    )
    arbitration_rate = (
        sum(1 for c in eligible_for_recovery if c["outcome"] == "compensator-failed")
        / len(eligible_for_recovery)
        if eligible_for_recovery
        else 0.0
    )

    coverage = (recovered / gross) if gross else 1.0
    covered = recovered
    uncompensated = max(0, residual)

    latencies = [c["totalLatencyMs"] for c in cells]
    tool_latency = statistics.mean(latencies) if latencies else 0.0
    total_wall_ms = sum(latencies)
    throughput_qps = (actions / (total_wall_ms / 1000.0)) if total_wall_ms > 0 else 0.0

    # Recovery time: mean total latency for cells that successfully recovered.
    recovered_lats = [c["totalLatencyMs"] for c in cells if c["outcome"] == "applied-recovered"]
    time_to_recovery = statistics.mean(recovered_lats) / 1000.0 if recovered_lats else 0.0
    # Finalization = end-to-end including the signing/record-to-chain stub.
    time_to_finalization = tool_latency / 1000.0

    # Bond accounting. Each cell exposes residualBytes against a per-cell
    # max of 100kB (BOND_MAX_BYTES in the driver). We report avg locked bytes
    # as the residual ledger size, peak as max residual, and utilization as
    # mean per-cell utilization.
    locked = [c["residualBytes"] for c in cells]
    bond_avg_locked = statistics.mean(locked) if locked else 0.0
    bond_peak_locked = max(locked) if locked else 0
    bond_utilization = statistics.mean(c["bondUtilization"] for c in cells) if cells else 0.0
    # Under-bond shortfall: residual that exceeds bondMaxBytes (none here, but
    # report honestly).
    bond_max = 100_000
    under_bond_shortfall = sum(max(0, c["residualBytes"] - bond_max) for c in cells)

    return {
        "baseline": baseline,
        "workload": "git",
        "seed": 0,
        "fault_class": "LOCAL_SANDBOX",
        "adversary_class": "NONE",
        "bond_multiplier": 1.0,
        "approval_rate": 1.0,
        "correlation_prob": 0.0,
        "correlation_burst_size": 0,
        "actions": actions,
        "coverage": coverage,
        "gross_harm": gross,
        "recovered": covered,
        "covered": covered,
        "uncompensated": uncompensated,
        "eligibility_rate": eligibility_rate,
        "objective_settlement_rate": objective_settlement_rate,
        "arbitration_rate": arbitration_rate,
        "routing_correctness": routing_correctness,
        "false_acceptance": false_acceptance,
        "false_rejection": false_rejection,
        "time_to_recovery": time_to_recovery,
        "time_to_finalization": time_to_finalization,
        "tool_execution_latency_ms": tool_latency,
        "throughput_qps": throughput_qps,
        "bond_avg_locked": bond_avg_locked,
        "bond_peak_locked": int(bond_peak_locked),
        "bond_peak_concurrent_locked": int(bond_peak_locked),
        "bond_utilization": bond_utilization,
        "under_bond_shortfall": int(under_bond_shortfall),
        "concurrent_shortfall": 0,
        "rejection_reasons": json.dumps(
            Counter(str(c.get("error") or "adapter-scope") for c in rejected),
            sort_keys=True,
        ),
        # This local benchmark does not submit claims or exercise the public
        # contract/challenge path.
        "payout_without_operator_consent": False,
        "third_party_can_challenge": False,
        "external_history_reconstructable": False,
        "provider_backed": False,
        "provider_compatible_sandbox": True,
    }


def render_table(gross: int, recovered: int, residual: int) -> str:
    """Render only deterministic functional outcomes for the paper."""
    return (
        "% emitted by prototype/scripts/provider-bench-git-to-parquet.py — do not hand-edit\n"
        "\\def\\tableprovidergit{%\n"
        f"  Git-local & {gross} & {recovered} & {residual} \\\\%\n"
        "}\n"
    )


def write_table(rows: list[dict], cells: list[dict], outdir: Path) -> Path:
    """Emit the deterministic Git local-sandbox table fragment."""
    row = rows[0]  # we only emit the recourse baseline row
    body = render_table(
        row["gross_harm"],
        row["recovered"],
        row["uncompensated"],
    )
    path = outdir / "table_provider_git.tex"
    path.write_text(body)
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input_json")
    ap.add_argument("outdir")
    args = ap.parse_args()

    payload = json.loads(Path(args.input_json).read_text())
    cells = payload["cells"]
    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    # We emit a single aggregated row labeled "recourse"; the row carries the
    # whole-bench numbers and the provider_backed flag distinguishes it from
    # the synthetic rq1 metrics file.
    rows = [build_row("recourse", cells)]

    df = pd.DataFrame(rows)
    # Re-order columns to match rq1 then append provider_backed last.
    ordered = [c for c in RQ1_COLUMNS if c in df.columns] + [
        c for c in df.columns if c not in RQ1_COLUMNS
    ]
    df = df[ordered]
    parquet_path = outdir / "metrics.parquet"
    df.to_parquet(parquet_path, index=False)

    # Manifest with environment + per-cell receipt hashes.
    receipt_hashes = [
        {
            "cellId": c["cellId"],
            "effectReceiptHash": c["effectReceiptHash"],
            "recoveryOutcome": c["recoveryOutcome"],
            "recoveryReceiptVerified": c["recoveryReceiptVerified"],
        }
        for c in cells
    ]

    input_bytes = Path(args.input_json).read_bytes()
    input_hash = "sha256:" + hashlib.sha256(input_bytes).hexdigest()

    manifest = {
        "schemaVersion": 1,
        "rq": "rq-provider-git",
        "providerBacked": False,
        "providerCompatibleSandbox": True,
        "environment": "local-bare-git",
        "workload": "git",
        "artifacts": 3,
        "cells": len(cells),
        "blocked": [],
        "fixture": payload["fixture"],
        "env": payload["env"],
        "bondMaxBytes": payload["bondMaxBytes"],
        "inputJsonHash": input_hash,
        "receipts": receipt_hashes,
        "tableEntry": {
            "gross_harm_bytes": rows[0]["gross_harm"],
            "recovered_bytes": rows[0]["recovered"],
            "residual_bytes": rows[0]["uncompensated"],
            "tool_execution_latency_ms": rows[0]["tool_execution_latency_ms"],
        },
    }
    (outdir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")

    table_path = write_table(rows, cells, outdir)

    print(f"wrote {parquet_path}")
    print(f"wrote {outdir / 'manifest.json'}")
    print(f"wrote {table_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
