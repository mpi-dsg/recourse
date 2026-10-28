#!/usr/bin/env python3
"""Compare a fresh reproduction with the source-controlled paper evidence."""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import pyarrow.parquet as pq

SYNTHETIC_TABLES = {
    "rq1": "table_rq1_baselines.tex",
    "rq2": "table_rq2_predicates.tex",
    "rq2-reasons": "table_rq2_reasons.tex",
    "rq3": "table_rq3_capital.tex",
    "rq4": "table_rq4_ablation.tex",
    "rq5": "table_rq5_routing.tex",
    "rq5-adv": "table_rq5_adv.tex",
    "rq8": "table_rq8_bondsens.tex",
    "rq9": "table_rq9_frontier.tex",
    "rq10": "table_rq10_correlated.tex",
}
CI_TABLES = {
    "rq1-ci": "table_rq1_baselines_ci.tex",
    "rq4-ci": "table_rq4_ablation_ci.tex",
    "rq5-adv-ci": "table_rq5_adv_ci.tex",
    "rq8-ci": "table_rq8_bondsens_ci.tex",
    "rq10-ci": "table_rq10_correlated_ci.tex",
}
PROVIDER_STABLE_COLUMNS = (
    "baseline",
    "workload",
    "seed",
    "fault_class",
    "actions",
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
    "bond_peak_locked",
    "bond_peak_concurrent_locked",
    "under_bond_shortfall",
    "concurrent_shortfall",
    "payout_without_operator_consent",
    "third_party_can_challenge",
    "external_history_reconstructable",
    "provider_backed",
    "provider_compatible_sandbox",
)


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results", type=Path, required=True)
    parser.add_argument("--frozen", type=Path, required=True)
    return parser.parse_args()


def _same_bytes(
    fresh: Path,
    frozen: Path,
    *,
    label: str,
    errors: list[str],
) -> None:
    if not fresh.is_file():
        errors.append(f"{label}: missing fresh artifact {fresh}")
    elif not frozen.is_file():
        errors.append(f"{label}: missing frozen artifact {frozen}")
    elif fresh.read_bytes() != frozen.read_bytes():
        errors.append(f"{label}: fresh artifact differs from frozen evidence")


def _provider_row(path: Path) -> dict[str, object]:
    table = pq.read_table(path)
    if table.num_rows != 1:
        raise ValueError(f"expected one provider summary row in {path}")
    return {
        name: table.column(name)[0].as_py()
        for name in PROVIDER_STABLE_COLUMNS
    }


def _png_dimensions(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        raise ValueError(f"not a PNG with an IHDR header: {path}")
    return struct.unpack(">II", data[16:24])


def main() -> int:
    args = _args()
    results = args.results.resolve()
    frozen = args.frozen.resolve() / "results"
    errors: list[str] = []

    for rq, filename in {**SYNTHETIC_TABLES, **CI_TABLES}.items():
        _same_bytes(
            results / rq / filename,
            frozen / rq / filename,
            label=f"{rq} table",
            errors=errors,
        )

    _same_bytes(
        results / "multi-seed" / "report.md",
        frozen / "multi-seed" / "report.md",
        label="multi-seed report",
        errors=errors,
    )

    for provider in ("postgres", "git", "cloud"):
        directory = f"rq-provider-{provider}"
        _same_bytes(
            results / directory / f"table_provider_{provider}.tex",
            frozen / directory / f"table_provider_{provider}.tex",
            label=f"{directory} deterministic table",
            errors=errors,
        )
        try:
            fresh_row = _provider_row(results / directory / "metrics.parquet")
            frozen_row = _provider_row(frozen / directory / "metrics.parquet")
        except (FileNotFoundError, KeyError, ValueError) as exc:
            errors.append(f"{directory}: {exc}")
        else:
            if fresh_row != frozen_row:
                errors.append(
                    f"{directory}: stable functional metrics differ from frozen evidence"
                )

    for group, filenames in {
        "k-contracts": ("registration.json", "table_k_catalogue.tex"),
        "anvil-e2e": ("metrics.json", "table_anvile2e_gas.tex"),
        "fuzzing": ("metrics.json", "table_fuzz.tex"),
    }.items():
        for filename in filenames:
            _same_bytes(
                results / group / filename,
                frozen / group / filename,
                label=f"{group}/{filename}",
                errors=errors,
            )

    fresh_architecture = results / "figure_architecture.png"
    frozen_architecture = args.frozen.resolve() / "figures" / "figure_architecture.png"
    try:
        dimensions = _png_dimensions(fresh_architecture)
        frozen_dimensions = _png_dimensions(frozen_architecture)
    except (OSError, ValueError) as exc:
        errors.append(f"architecture figure: {exc}")
    else:
        if dimensions != frozen_dimensions:
            errors.append(
                "architecture figure dimensions differ: "
                f"fresh={dimensions}, frozen={frozen_dimensions}"
            )

    for rq in CI_TABLES:
        manifest_path = results / rq / "multi_seed_manifest.json"
        try:
            manifest = json.loads(manifest_path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"{rq}: invalid multi-seed manifest: {exc}")
            continue
        if manifest.get("baseSeeds") != list(range(42, 52)):
            errors.append(f"{rq}: expected independent base seeds 42..51")
        if manifest.get("samplesPerCell") != 10:
            errors.append(f"{rq}: expected ten independent samples per cell")

    if errors:
        print("reproduction validation failed:")
        for error in errors:
            print(f"  - {error}")
        return 1
    print("reproduced results match all frozen deterministic and stable metrics")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
