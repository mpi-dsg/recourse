"""RQ2-reasons — rejection-reason breakdown of the settleability admission.

Parses the per-cell ``rejection_reasons`` column (``label:count`` comma list)
and emits one row per sub-predicate that ever fires plus a final ``admitted``
row that reports the share of calls that cleared the predicate pipeline.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import pandas as pd

from ._common import fmt_float, tex_escape, write_rows

HEADER = r"% emitted by recourse_harness.tables.rq2_reasons — do not hand-edit"

# Stable display order; rows are emitted only when the corresponding
# sub-predicate actually fires at least once in the sweep, so unused
# rows do not clutter the table.
_DISPLAY_ORDER: tuple[str, ...] = (
    "WithinScope",
    "RecoveryAvailable",
    "PayoutTotal",
    "EvidenceSchemaOK",
    "LossClassBounded",
    "BondSufficient",
    "Compensable",
    "Eligible",
    "Unknown",
)
_ADMITTED = "admitted"


def _parse_reasons(cell: object) -> Counter[str]:
    """Decode the ``label:count`` comma-list emitted by ``compute_metrics``."""
    counts: Counter[str] = Counter()
    if not isinstance(cell, str) or not cell:
        return counts
    for entry in cell.split(","):
        entry = entry.strip()
        if not entry or ":" not in entry:
            continue
        label, _, count = entry.rpartition(":")
        try:
            counts[label] += int(count)
        except ValueError:
            continue
    return counts


def emit_rq2_reasons(metrics: pd.DataFrame, output_path: Path) -> Path:
    recourse_only = metrics[metrics["baseline"] == "recourse"]
    aggregate: Counter[str] = Counter()
    for value in recourse_only.get("rejection_reasons", pd.Series(dtype=str)):
        aggregate.update(_parse_reasons(value))

    total = sum(aggregate.values())
    rows: list[str] = []
    if total == 0:
        # Defensive: no rejection-reason data on this sweep; emit a single
        # row so the macro body is non-empty.
        rows.append(f"{tex_escape(_ADMITTED)} & {fmt_float(0.0)} \\\\")
        return write_rows(output_path, HEADER, rows, "tablerqtworeasons")

    admitted_share = aggregate.get(_ADMITTED, 0) / total
    # Rejected sub-predicate rows (in stable display order, only those
    # that actually fired at least once).
    for label in _DISPLAY_ORDER:
        count = aggregate.get(label, 0)
        if count == 0:
            continue
        share = count / total
        rows.append(f"{tex_escape(label)} & {fmt_float(share)} \\\\")
    # Final summary row: share of calls that cleared the pipeline.
    rows.append(f"{tex_escape(_ADMITTED)} & {fmt_float(admitted_share)} \\\\")
    return write_rows(output_path, HEADER, rows, "tablerqtworeasons")
