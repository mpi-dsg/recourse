#!/usr/bin/env python3
"""
Emit metrics.parquet + manifest.json + table_provider_cloud.tex for the
rq-provider-cloud experiment.

Reads:
  prototype/results/rq-provider-cloud/cells.json   (produced by the bun bench)
  prototype/results/rq1/metrics.parquet            (column schema to mirror)

Writes:
  prototype/results/rq-provider-cloud/metrics.parquet
  prototype/results/rq-provider-cloud/manifest.json
  prototype/results/rq-provider-cloud/table_provider_cloud.tex

Set PAPER_TABLES_DIR to also copy the table into a paper checkout.

Usage:
  uv run --with pyarrow python prototype/scripts/provider-bench-cloud-to-parquet.py
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

import pyarrow as pa
import pyarrow.parquet as pq


def _path_from_env(name: str, default: Path) -> Path:
    return Path(os.environ.get(name, default)).expanduser().resolve()


def _endpoint_label(value: object) -> str | None:
    if value is None:
        return None
    endpoint = str(value)
    parsed = urlsplit(endpoint)
    if not parsed.scheme or not parsed.hostname:
        return endpoint
    port = f":{parsed.port}" if parsed.port else ""
    return f"{parsed.scheme}://{parsed.hostname}{port}"


PROTO = _path_from_env("RECOURSE_PROTOTYPE_DIR", Path(__file__).resolve().parents[1])
RESULTS_ROOT = _path_from_env("RECOURSE_RESULTS_ROOT", PROTO / "results")
RESULTS = RESULTS_ROOT / "rq-provider-cloud"
CELLS = RESULTS / "cells.json"
# Mirror the synthetic RQ1 schema through the Postgres local-sandbox artifact.
RQ_REF = RESULTS_ROOT / "rq-provider-postgres" / "metrics.parquet"
OUT_PARQUET = RESULTS / "metrics.parquet"
OUT_MANIFEST = RESULTS / "manifest.json"
OUT_TABLE = RESULTS / "table_provider_cloud.tex"

PAYOUT_PER_CHANGE = 10
BOND_MAX = 1000


def _copy_table_if_requested(source: Path) -> Path | None:
    table_dir = os.environ.get("PAPER_TABLES_DIR")
    if not table_dir:
        return None
    target = Path(table_dir).expanduser() / source.name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return target


def render_table(gross_harm: int, recovered: int, residual: int) -> str:
    """Render only deterministic functional outcomes for the paper."""
    return (
        "% emitted by scripts/provider-bench-cloud-to-parquet.py — do not hand-edit\n"
        "\\def\\tableprovidercloud{%\n"
        f"  Cloud-local & {gross_harm} & {recovered} & {residual} \\\\%\n"
        "}\n"
    )


def main() -> int:
    if not CELLS.exists():
        print(f"missing {CELLS}", file=sys.stderr)
        return 1

    cells_doc = json.loads(CELLS.read_text())
    cells = cells_doc["cells"]

    ref_schema = pq.read_schema(RQ_REF)
    # Drop local/provider markers and append them explicitly after the common
    # RQ1-compatible columns.
    marker_columns = {"provider_backed", "provider_compatible_sandbox"}
    ref_fields = [f for f in ref_schema if f.name not in marker_columns]
    ref_columns = [f.name for f in ref_fields]

    admitted_cells = [c for c in cells if c["admitted"]]
    set_cells = [c for c in admitted_cells if c["action"] == "set-parameter"]
    delete_cells = [c for c in admitted_cells if c["action"] == "delete-parameter"]
    rejected_cells = [c for c in cells if not c["admitted"]]

    actions = len(cells)
    gross_harm = sum(int(c["gross_harm_changes"]) for c in cells)
    recovered = sum(int(c["recovered_changes"]) for c in cells)
    residual = sum(int(c["residual_harm_changes"]) for c in cells)
    bond_shortfall = sum(int(c["bond_shortfall"]) for c in cells)
    covered = residual - bond_shortfall
    uncompensated = bond_shortfall

    coverage = (recovered + covered) / gross_harm if gross_harm > 0 else 0.0

    eligibility_rate = (
        len(admitted_cells) / max(1, sum(1 for c in cells if c["expected_admitted"]))
    )
    # Objective settlement rate: of admitted cells with an attempted recovery,
    # how many settled to a "success" or "partial" outcome.
    rec_attempts = [c for c in admitted_cells if c["recovery_outcome"] in ("success", "partial", "failure")]
    settled = [c for c in rec_attempts if c["recovery_outcome"] in ("success", "partial")]
    objective_settlement_rate = len(settled) / max(1, len(rec_attempts))

    # Routing correctness: admitted matches expected_admitted.
    routing_correct = sum(
        1 for c in cells if c["admitted"] == c["expected_admitted"]
    )
    routing_correctness = routing_correct / max(1, len(cells))

    admitted_latencies = [float(c["sign_provider_latency_ms"]) for c in admitted_cells]
    avg_latency_ms = (
        sum(admitted_latencies) / len(admitted_latencies)
        if admitted_latencies else 0.0
    )

    bond_locked_total = sum(int(c["bond_locked"]) for c in cells)
    bond_peak_locked = max((int(c["bond_locked"]) for c in cells), default=0)
    bond_avg_locked = bond_locked_total / max(1, len(cells))
    bond_utilization = (
        bond_peak_locked / BOND_MAX if BOND_MAX > 0 else 0.0
    )

    false_acceptance = sum(
        1 for c in cells if c["admitted"] and not c["expected_admitted"]
    ) / max(1, len(cells))
    false_rejection = sum(
        1 for c in cells if (not c["admitted"]) and c["expected_admitted"]
    ) / max(1, len(cells))

    throughput_qps = 1000.0 / avg_latency_ms if avg_latency_ms > 0 else 0.0

    avg_recovery_ms = (
        sum(float(c["recovery_latency_ms"]) for c in admitted_cells)
        / max(1, len(admitted_cells))
    )

    row = {
        "baseline": "recourse",
        "workload": "cloud",
        "seed": 42,
        "fault_class": "LOCAL_SANDBOX",
        "adversary_class": "NONE",
        "bond_multiplier": 1.0,
        "approval_rate": 1.0,
        "correlation_prob": 0.0,
        "correlation_burst_size": 0,
        "actions": actions,
        "coverage": coverage,
        "gross_harm": gross_harm,
        "recovered": recovered,
        "covered": covered,
        "uncompensated": uncompensated,
        "eligibility_rate": eligibility_rate,
        "objective_settlement_rate": objective_settlement_rate,
        "arbitration_rate": 0.0,
        "routing_correctness": routing_correctness,
        "false_acceptance": false_acceptance,
        "false_rejection": false_rejection,
        "time_to_recovery": avg_recovery_ms,
        "time_to_finalization": avg_latency_ms + avg_recovery_ms,
        "tool_execution_latency_ms": avg_latency_ms,
        "throughput_qps": throughput_qps,
        "bond_avg_locked": bond_avg_locked,
        "bond_peak_locked": bond_peak_locked,
        "bond_peak_concurrent_locked": bond_peak_locked,
        "bond_utilization": bond_utilization,
        "under_bond_shortfall": bond_shortfall,
        "concurrent_shortfall": 0,
        "rejection_reasons": json.dumps(
            Counter(
                str(c["rejected_reason"])
                for c in rejected_cells
                if c.get("rejected_reason")
            ),
            sort_keys=True,
        ),
        "payout_without_operator_consent": False,
        "third_party_can_challenge": False,
        "external_history_reconstructable": False,
    }

    missing = [c for c in ref_columns if c not in row]
    extra = [c for c in row if c not in ref_columns]
    assert not missing and not extra, f"schema mismatch missing={missing} extra={extra}"

    arrays = []
    fields = []
    for f in ref_fields:
        val = row[f.name]
        arrays.append(pa.array([val], type=f.type))
        fields.append(f)
    arrays.append(pa.array([False], type=pa.bool_()))
    fields.append(pa.field("provider_backed", pa.bool_()))
    arrays.append(pa.array([True], type=pa.bool_()))
    fields.append(pa.field("provider_compatible_sandbox", pa.bool_()))
    table = pa.Table.from_arrays(arrays, schema=pa.schema(fields))
    pq.write_table(table, OUT_PARQUET)

    receipt_hashes = {
        c["cell_id"]: c["receipt_hash"]
        for c in cells
        if c["receipt_hash"]
    }
    ssm_versions = {
        c["cell_id"]: c["ssm_version_after"]
        for c in cells
        if c["ssm_version_after"] is not None
    }

    # Probe LocalStack version (best-effort).
    try:
        v = subprocess.run(
            ["docker", "exec", "lscloud", "cat", "/etc/localstack-version"],
            check=True, capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except Exception:
        try:
            v = subprocess.run(
                ["docker", "inspect", "--format", "{{.Config.Image}}", "lscloud"],
                check=True, capture_output=True, text=True, timeout=5,
            ).stdout.strip()
        except Exception as e:
            v = f"unknown ({e})"

    try:
        harness_commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(PROTO),
            check=True, capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except Exception:
        harness_commit = "unknown"

    cells_bytes = CELLS.read_bytes()
    cells_hash = "sha256:" + hashlib.sha256(cells_bytes).hexdigest()

    manifest = {
        "schemaVersion": 1,
        "rq": "rq-provider-cloud",
        "providerBacked": False,
        "providerCompatibleSandbox": True,
        "provider": {
            "kind": "cloud",
            "service": "ssm",
            "image": "localstack/localstack:4.0",
            "version": v,
            "endpoint": _endpoint_label(cells_doc.get("endpoint")),
            "environment": "local-docker-emulator",
        },
        "harness": {
            "gitCommit": harness_commit,
            "benchScript": "scripts/provider-bench-cloud.ts",
            "emitter": "scripts/provider-bench-cloud-to-parquet.py",
            "cellsHash": cells_hash,
        },
        "config": {
            "bond_max": BOND_MAX,
            "payout_per_change": PAYOUT_PER_CHANGE,
            "allowed_prefix": "/recourse/test/",
            "seeded_parameters": 10,
        },
        "schemaVersions": {
            "claim": 1,
            "effectReceipt": 1,
            "recourseContract": 1,
            "recoveryReceipt": 1,
        },
        "totals": {
            "cells": len(cells),
            "admitted": len(admitted_cells),
            "rejected": len(rejected_cells),
            "set_parameter": len(set_cells),
            "delete_parameter": len(delete_cells),
            "gross_harm_changes": gross_harm,
            "recovered_changes": recovered,
            "residual_harm_changes": residual,
            "avg_sign_provider_latency_ms": avg_latency_ms,
            "avg_recovery_latency_ms": avg_recovery_ms,
            "bond_peak_locked": bond_peak_locked,
            "bond_utilization": bond_utilization,
            "total_wall_clock_ms": cells_doc.get("totalWallClockMs", 0),
        },
        "perCell": [
            {
                "cellId": c["cell_id"],
                "scenario": c["scenario"],
                "action": c["action"],
                "admitted": c["admitted"],
                "rejectionKind": c.get("rejection_kind"),
                "grossHarmChanges": c["gross_harm_changes"],
                "recoveredChanges": c["recovered_changes"],
                "residualHarmChanges": c["residual_harm_changes"],
                "signProviderLatencyMs": c["sign_provider_latency_ms"],
                "recoveryLatencyMs": c["recovery_latency_ms"],
                "bondLocked": c["bond_locked"],
                "preValue": c["pre_value"],
                "postValue": c["post_value"],
                "preVersion": c["pre_version"],
                "postVersion": c["post_version"],
                "ssmVersionAfter": c["ssm_version_after"],
                "receiptHash": c["receipt_hash"],
                "recoveryOutcome": c["recovery_outcome"],
            }
            for c in cells
        ],
        "receiptHashes": receipt_hashes,
        "ssmVersionsAfter": ssm_versions,
    }
    OUT_MANIFEST.write_text(json.dumps(manifest, indent=2, sort_keys=True))

    # The paper table contains only deterministic functional outcomes.
    # Host-dependent timings remain available in metrics.parquet and manifest.json.
    tex = render_table(gross_harm, recovered, residual)
    OUT_TABLE.write_text(tex)
    paper_table = _copy_table_if_requested(OUT_TABLE)

    print(f"wrote {OUT_PARQUET}")
    print(f"wrote {OUT_MANIFEST}")
    print(f"wrote {OUT_TABLE}")
    if paper_table is not None:
        print(f"copied {paper_table}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
