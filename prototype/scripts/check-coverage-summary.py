#!/usr/bin/env python3
"""Check coverage summaries emitted by local toolchains.

The repository intentionally keeps tool-specific coverage commands in the
Makefile. This helper gives those commands a shared fail-under policy without
depending on generated coverage files.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def _as_float(raw: str) -> float:
    try:
        return float(raw)
    except ValueError as exc:
        raise SystemExit(f"invalid coverage value: {raw}") from exc


def parse_foundry(text: str) -> dict[str, float]:
    for line in text.splitlines():
        if "Total" not in line:
            continue
        values = [_as_float(value) for value in re.findall(r"([0-9]+(?:\.[0-9]+)?)%", line)]
        if len(values) >= 4:
            return {
                "lines": values[0],
                "statements": values[1],
                "branches": values[2],
                "functions": values[3],
            }
    raise SystemExit("could not find Foundry Total coverage row")


def parse_bun(text: str) -> dict[str, float]:
    for line in text.splitlines():
        if "All files" not in line:
            continue
        columns = [part.strip() for part in line.split("|")]
        values = [_as_float(column) for column in columns if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", column)]
        if len(values) >= 2:
            return {"functions": values[0], "lines": values[1]}
    raise SystemExit("could not find Bun All files coverage row")


def check_metric(metrics: dict[str, float], metric: str, minimum: float | None) -> list[str]:
    if minimum is None:
        return []
    actual = metrics.get(metric)
    if actual is None:
        return [f"{metric}: metric unavailable, required {minimum:.2f}%"]
    if actual + 1e-9 < minimum:
        return [f"{metric}: {actual:.2f}% below required {minimum:.2f}%"]
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tool", choices=("foundry", "bun"))
    parser.add_argument("summary", type=Path)
    parser.add_argument("--line-min", type=float)
    parser.add_argument("--statement-min", type=float)
    parser.add_argument("--function-min", type=float)
    parser.add_argument("--branch-min", type=float)
    args = parser.parse_args()

    text = args.summary.read_text(encoding="utf-8")
    metrics = parse_foundry(text) if args.tool == "foundry" else parse_bun(text)

    failures: list[str] = []
    failures.extend(check_metric(metrics, "lines", args.line_min))
    failures.extend(check_metric(metrics, "statements", args.statement_min))
    failures.extend(check_metric(metrics, "functions", args.function_min))
    failures.extend(check_metric(metrics, "branches", args.branch_min))

    rendered = ", ".join(f"{name}={value:.2f}%" for name, value in sorted(metrics.items()))
    print(f"{args.tool} coverage: {rendered}")
    if failures:
        for failure in failures:
            print(f"coverage threshold failed: {failure}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
