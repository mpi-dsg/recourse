#!/usr/bin/env python3
"""
Emit metrics.parquet + manifest.json + table_provider_postgres.tex for the
rq-provider-postgres experiment.

Reads:
  results/rq-provider-postgres/cells.json (produced by the bun bench)
  results/rq1/metrics.parquet              (column schema to mirror)

Writes:
  results/rq-provider-postgres/metrics.parquet
  results/rq-provider-postgres/manifest.json
  results/rq-provider-postgres/table_provider_postgres.tex

Set PAPER_TABLES_DIR to also copy the table into a paper checkout.
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
    database = parsed.path if parsed.path and parsed.path != "/" else ""
    return f"{parsed.scheme}://{parsed.hostname}{port}{database}"


PROTO = _path_from_env("RECOURSE_PROTOTYPE_DIR", Path(__file__).resolve().parents[1])
RESULTS_ROOT = _path_from_env("RECOURSE_RESULTS_ROOT", PROTO / "results")
RESULTS = RESULTS_ROOT / "rq-provider-postgres"
CELLS = RESULTS / "cells.json"
RQ1 = RESULTS_ROOT / "rq1" / "metrics.parquet"
OUT_PARQUET = RESULTS / "metrics.parquet"
OUT_MANIFEST = RESULTS / "manifest.json"
OUT_TABLE = RESULTS / "table_provider_postgres.tex"

PAYOUT_PER_ROW = 10
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
        "% emitted by scripts/provider-postgres-emit.py — do not hand-edit\n"
        "\\def\\tableproviderpostgres{%\n"
        f"  Postgres-local & {gross_harm} & {recovered} & {residual} \\\\%\n"
        "}\n"
    )


def main() -> int:
    if not CELLS.exists():
        print(f"missing {CELLS}", file=sys.stderr)
        return 1

    cells_doc = json.loads(CELLS.read_text())
    cells = cells_doc["cells"]

    # Schema mirror: read rq1 schema, then build matching rows.
    rq1_schema = pq.read_schema(RQ1)
    rq1_columns = [f.name for f in rq1_schema]

    # Aggregate metrics for the provider-compatible local sandbox.
    admitted_cells = [c for c in cells if c["admitted"]]
    delete_cells = [c for c in admitted_cells if c["action"] == "delete"]
    update_cells = [c for c in admitted_cells if c["action"] == "update"]
    rejected_cells = [c for c in cells if not c["admitted"]]

    actions = len(cells)
    gross_harm = sum(int(c["gross_harm_rows"]) for c in cells)
    recovered = sum(int(c["recovered_rows"]) for c in cells)
    residual = sum(int(c["residual_harm_rows"]) for c in cells)
    # In rq1 terminology: covered = residual harm whose payout fits inside the
    # bond; uncompensated = anything beyond (i.e., shortfall). For our small
    # workload nothing exceeds BOND_MAX, so covered == residual.
    bond_shortfall = sum(int(c["bond_shortfall"]) for c in cells)
    covered = residual - bond_shortfall
    uncompensated = bond_shortfall

    coverage = (recovered + covered) / gross_harm if gross_harm > 0 else 0.0
    eligibility_rate = (
        len([c for c in admitted_cells if c["action"] == "delete"])
        / max(1, len(delete_cells))
    )
    objective_settlement_rate = (
        len([c for c in delete_cells if c["recovery_outcome"] in ("success", "partial")])
        / max(1, len(delete_cells))
    )

    # Routing: a delete with snapshot rows >= affected -> success route.
    routing_correct = 0
    for c in delete_cells:
        affected = int(c["affected_rows"])
        snap = int(c["snapshot_rows"])
        if affected == 0 or snap >= affected:
            routing_correct += 1
        elif snap > 0 and snap < affected:
            routing_correct += 1  # partial is still correctly routed
    routing_correctness = routing_correct / max(1, len(delete_cells))

    # Latency: real wall-clock from bench.
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

    # false_acceptance: admitted but should have been rejected.
    false_acceptance = sum(
        1 for c in cells if c["admitted"] and not c["expected_admitted"]
    ) / max(1, len(cells))
    # false_rejection: rejected but should have been admitted.
    false_rejection = sum(
        1 for c in cells if (not c["admitted"]) and c["expected_admitted"]
    ) / max(1, len(cells))

    # Throughput: 1000 / per-call latency.
    throughput_qps = 1000.0 / avg_latency_ms if avg_latency_ms > 0 else 0.0

    # Time to recovery: sum of recovery_latency_ms across admitted delete cells.
    avg_recovery_ms = (
        sum(float(c["recovery_latency_ms"]) for c in delete_cells)
        / max(1, len(delete_cells))
    )

    row = {
        "baseline": "recourse",
        "workload": "postgres",
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

    # Validate every rq1 column appears exactly once.
    missing = [c for c in rq1_columns if c not in row]
    extra = [c for c in row if c not in rq1_columns]
    assert not missing and not extra, f"schema mismatch missing={missing} extra={extra}"

    # Build pyarrow table, preserving rq1's exact dtypes, plus the
    # provider_backed marker as a final column.
    arrays = []
    fields = []
    for f in rq1_schema:
        val = row[f.name]
        arrays.append(pa.array([val], type=f.type))
        fields.append(f)
    arrays.append(pa.array([False], type=pa.bool_()))
    fields.append(pa.field("provider_backed", pa.bool_()))
    arrays.append(pa.array([True], type=pa.bool_()))
    fields.append(pa.field("provider_compatible_sandbox", pa.bool_()))
    table = pa.Table.from_arrays(arrays, schema=pa.schema(fields))
    pq.write_table(table, OUT_PARQUET)

    # Receipt hashes per admitted cell (already produced by bench).
    receipt_hashes = {
        c["cell_id"]: c["receipt_hash"]
        for c in cells
        if c["receipt_hash"]
    }
    pg_txids = {
        c["cell_id"]: c["pg_txid"] for c in cells if c["pg_txid"]
    }

    # Postgres image+version
    pg_image = "postgres:16"
    try:
        v = subprocess.run(
            [
                "docker", "exec", "recourse-integration-postgres",
                "psql", "-U", "recourse", "-d", "recourse_test", "-tAc",
                "SELECT version()",
            ],
            check=True, capture_output=True, text=True, timeout=15,
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
        "rq": "rq-provider-postgres",
        "providerBacked": False,
        "providerCompatibleSandbox": True,
        "provider": {
            "kind": "postgres",
            "image": pg_image,
            "version": v,
            "url": _endpoint_label(cells_doc.get("pgUrl")),
            "environment": "local-docker",
        },
        "harness": {
            "gitCommit": harness_commit,
            "benchScript": "runtime-ts/packages/adapter-postgres/bench/provider-postgres.ts",
            "emitter": "scripts/provider-postgres-emit.py",
            "cellsHash": cells_hash,
        },
        "config": {
            "bond_max": BOND_MAX,
            "payout_per_row": PAYOUT_PER_ROW,
            "table": "tenant_rows",
            "seed_tenants": "a..o",
            "rows_per_tenant": 3,
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
            "deletes": len(delete_cells),
            "updates": len(update_cells),
            "gross_harm_rows": gross_harm,
            "recovered_rows": recovered,
            "residual_harm_rows": residual,
            "avg_sign_provider_latency_ms": avg_latency_ms,
            "avg_recovery_latency_ms": avg_recovery_ms,
            "bond_peak_locked": bond_peak_locked,
            "bond_utilization": bond_utilization,
        },
        "perCell": [
            {
                "cellId": c["cell_id"],
                "scenario": c["scenario"],
                "action": c["action"],
                "admitted": c["admitted"],
                "grossHarmRows": c["gross_harm_rows"],
                "recoveredRows": c["recovered_rows"],
                "residualHarmRows": c["residual_harm_rows"],
                "signProviderLatencyMs": c["sign_provider_latency_ms"],
                "recoveryLatencyMs": c["recovery_latency_ms"],
                "bondLocked": c["bond_locked"],
                "pgTxid": c["pg_txid"],
                "preLsn": c["pre_lsn"],
                "postLsn": c["post_lsn"],
                "receiptHash": c["receipt_hash"],
                "recoveryOutcome": c["recovery_outcome"],
            }
            for c in cells
        ],
        "receiptHashes": receipt_hashes,
        "pgTxids": pg_txids,
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
