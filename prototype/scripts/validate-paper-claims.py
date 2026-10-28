#!/usr/bin/env python3
"""Validate the paper claim/provenance manifest against repository artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path, PurePosixPath
from typing import Any

_REQUIRED_CLAIM_FIELDS = (
    "id",
    "kind",
    "status",
    "sources",
    "command",
    "result",
    "paperDestination",
    "statisticalUnit",
    "verificationMode",
)
_VALID_STATUSES = frozenset({"reproducible", "unsupported"})
_VALID_VERIFICATION_MODES = frozenset(
    {"byte_equal", "checksum", "source_only", "unsupported"}
)


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--paper-dir", required=True, type=Path)
    return parser.parse_args()


def _safe_relative_path(value: str, *, field: str, errors: list[str]) -> str | None:
    path_text = value.split("#", 1)[0]
    relative = PurePosixPath(path_text)
    if not path_text or relative.is_absolute() or ".." in relative.parts:
        errors.append(f"{field} must be a safe relative path: {value!r}")
        return None
    return path_text


def _resolve_reference(
    reference: str,
    *,
    repo_root: Path,
    paper_dir: Path,
    field: str,
    errors: list[str],
) -> Path | None:
    if ":" not in reference:
        errors.append(
            f"{field} must use repo:, project:, or paper: prefix: {reference!r}"
        )
        return None
    scope, value = reference.split(":", 1)
    relative = _safe_relative_path(value, field=field, errors=errors)
    if relative is None:
        return None
    if scope == "repo":
        return repo_root / relative
    if scope == "project":
        return repo_root.parent / relative
    if scope == "paper":
        return paper_dir / relative
    errors.append(f"{field} has unknown scope {scope!r}: {reference!r}")
    return None


def _claim_label(claim: dict[str, Any], index: int) -> str:
    claim_id = claim.get("id")
    return str(claim_id) if claim_id else f"claims[{index}]"


def _validate_claim(
    claim: Any,
    *,
    index: int,
    repo_root: Path,
    paper_dir: Path,
    errors: list[str],
) -> None:
    if not isinstance(claim, dict):
        errors.append(f"claims[{index}] must be an object")
        return
    label = _claim_label(claim, index)
    for field in _REQUIRED_CLAIM_FIELDS:
        if field not in claim:
            errors.append(f"{label}: missing required field {field}")

    sources = claim.get("sources")
    if not isinstance(sources, list) or not sources:
        errors.append(f"{label}: sources must be a non-empty list")
    else:
        for source in sources:
            if not isinstance(source, str):
                errors.append(f"{label}: source must be a string")
                continue
            source_path = _resolve_reference(
                source,
                repo_root=repo_root,
                paper_dir=paper_dir,
                field=f"{label}.sources",
                errors=errors,
            )
            if source_path is not None and not source_path.exists():
                errors.append(f"{label}: source does not exist: {source}")

    command = claim.get("command")
    if not isinstance(command, str) or not command.strip():
        errors.append(f"{label}: command must be a non-empty string")

    status = claim.get("status")
    if status not in _VALID_STATUSES:
        errors.append(f"{label}: invalid status {status!r}")
    verification_mode = claim.get("verificationMode")
    if verification_mode not in _VALID_VERIFICATION_MODES:
        errors.append(f"{label}: invalid verificationMode {verification_mode!r}")
    if status == "unsupported":
        reason = claim.get("unsupportedReason")
        if (
            not isinstance(reason, dict)
            or not isinstance(reason.get("code"), str)
            or not reason["code"].strip()
            or not isinstance(reason.get("detail"), str)
            or not reason["detail"].strip()
        ):
            errors.append(
                f"{label}: unsupportedReason must contain non-empty code and detail"
            )
    elif verification_mode == "unsupported":
        errors.append(f"{label}: reproducible status cannot use unsupported verificationMode")

    statistical_unit = claim.get("statisticalUnit")
    if not isinstance(statistical_unit, str) or not statistical_unit.strip():
        errors.append(f"{label}: statisticalUnit must be a non-empty string")

    destination = claim.get("paperDestination")
    destination_path: Path | None = None
    if not isinstance(destination, str):
        errors.append(f"{label}: paperDestination must be a string")
    else:
        relative = _safe_relative_path(
            destination,
            field=f"{label}.paperDestination",
            errors=errors,
        )
        if relative is not None:
            destination_path = paper_dir / relative
            if not destination_path.exists():
                errors.append(f"{label}: paper destination does not exist: {destination}")

    result = claim.get("result")
    result_path: Path | None = None
    if not isinstance(result, str) or not result.strip():
        errors.append(f"{label}: result must be a non-empty scoped path")
    else:
        result_path = _resolve_reference(
            result,
            repo_root=repo_root,
            paper_dir=paper_dir,
            field=f"{label}.result",
            errors=errors,
        )

    checksum = claim.get("checksum")
    if checksum is not None:
        if (
            not isinstance(checksum, str)
            or not checksum.startswith("sha256:")
            or len(checksum) != len("sha256:") + 64
        ):
            errors.append(f"{label}: checksum must be sha256:<64 lowercase hex chars>")
        elif result_path is None or not result_path.is_file():
            errors.append(f"{label}: checksum result does not exist: {result}")
        else:
            expected = checksum.removeprefix("sha256:")
            actual = hashlib.sha256(result_path.read_bytes()).hexdigest()
            if actual != expected:
                errors.append(
                    f"{label}: checksum mismatch for {result}: expected {expected}, got {actual}"
                )

    if verification_mode == "byte_equal":
        if result_path is None or not result_path.is_file():
            errors.append(f"{label}: byte_equal result does not exist: {result}")
        elif destination_path is None or not destination_path.is_file():
            errors.append(f"{label}: byte_equal paper destination is not a file")
        elif result_path.read_bytes() != destination_path.read_bytes():
            errors.append(f"{label}: paper destination differs from result")
    elif verification_mode == "checksum" and checksum is None:
        errors.append(f"{label}: checksum verificationMode requires checksum")


def validate_manifest(
    manifest: Any,
    *,
    repo_root: Path,
    paper_dir: Path,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(manifest, dict):
        return ["manifest root must be an object"]
    if manifest.get("schemaVersion") != 1:
        errors.append("schemaVersion must equal 1")

    inventory = manifest.get("paperInventory")
    if not isinstance(inventory, dict):
        errors.append("paperInventory must be an object")
        expected_tables: list[str] = []
        expected_figures: list[str] = []
    else:
        raw_tables = inventory.get("tables")
        if not isinstance(raw_tables, list) or not all(
            isinstance(item, str) for item in raw_tables
        ):
            errors.append("paperInventory.tables must be a list of paths")
            expected_tables = []
        else:
            expected_tables = list(raw_tables)
        raw_figures = inventory.get("figures")
        if not isinstance(raw_figures, list) or not all(
            isinstance(item, str) for item in raw_figures
        ):
            errors.append("paperInventory.figures must be a list of paths")
            expected_figures = []
        else:
            expected_figures = list(raw_figures)

    claims = manifest.get("claims")
    if not isinstance(claims, list) or not claims:
        errors.append("claims must be a non-empty list")
        claims = []

    claim_ids: set[str] = set()
    destinations: set[str] = set()
    table_destinations: set[str] = set()
    figure_destinations: set[str] = set()
    for index, raw_claim in enumerate(claims):
        if isinstance(raw_claim, dict):
            claim_id = raw_claim.get("id")
            if isinstance(claim_id, str):
                if claim_id in claim_ids:
                    errors.append(f"duplicate claim id: {claim_id}")
                claim_ids.add(claim_id)
            destination = raw_claim.get("paperDestination")
            if isinstance(destination, str):
                if destination in destinations:
                    errors.append(f"duplicate paperDestination: {destination}")
                destinations.add(destination)
                if raw_claim.get("kind") == "table":
                    table_destinations.add(destination)
                elif raw_claim.get("kind") == "figure":
                    figure_destinations.add(destination)
        _validate_claim(
            raw_claim,
            index=index,
            repo_root=repo_root,
            paper_dir=paper_dir,
            errors=errors,
        )

    expected_table_set = set(expected_tables)
    if len(expected_tables) != len(expected_table_set):
        errors.append("paperInventory.tables contains duplicates")
    for table in sorted(expected_table_set - table_destinations):
        errors.append(f"paper inventory table has no claim: {table}")
    for table in sorted(table_destinations - expected_table_set):
        errors.append(f"table claim missing from paper inventory: {table}")

    expected_figure_set = set(expected_figures)
    if len(expected_figures) != len(expected_figure_set):
        errors.append("paperInventory.figures contains duplicates")
    for figure in sorted(expected_figure_set - figure_destinations):
        errors.append(f"paper inventory figure has no claim: {figure}")
    for figure in sorted(figure_destinations - expected_figure_set):
        errors.append(f"figure claim missing from paper inventory: {figure}")
    for figure in sorted(expected_figure_set):
        figure_path = paper_dir / figure
        if not figure_path.is_file():
            errors.append(f"missing paper figure: {figure}")

    paper_figures_dir = paper_dir / "figures"
    actual_figures = (
        {
            path.relative_to(paper_dir).as_posix()
            for pattern in ("*.pdf", "*.png", "*.svg")
            for path in paper_figures_dir.glob(pattern)
        }
        if paper_figures_dir.is_dir()
        else set()
    )
    for figure in sorted(actual_figures - expected_figure_set):
        errors.append(f"unexpected paper figure: {figure}")

    paper_tables_dir = paper_dir / "tables"
    actual_tables = (
        {
            path.relative_to(paper_dir).as_posix()
            for path in paper_tables_dir.glob("*.tex")
        }
        if paper_tables_dir.is_dir()
        else set()
    )
    for table in sorted(expected_table_set - actual_tables):
        errors.append(f"missing paper table: {table}")
    for table in sorted(actual_tables - expected_table_set):
        errors.append(f"unexpected paper table: {table}")

    return errors


def main() -> int:
    args = _arguments()
    if not str(args.paper_dir):
        print("paper directory must be provided", file=sys.stderr)
        return 2
    try:
        manifest = json.loads(args.manifest.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        print(f"could not load manifest: {exc}", file=sys.stderr)
        return 2

    errors = validate_manifest(
        manifest,
        repo_root=args.repo_root.resolve(),
        paper_dir=args.paper_dir.resolve(),
    )
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"validated {len(manifest['claims'])} claims")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
