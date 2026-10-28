#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "jsonschema>=4.21",
# ]
# ///
"""Validate the κ-contract catalogue against ``schemas/recourse_contract.v1.json``.

The catalogue lives at ``prototype/fixtures/k-contracts/`` and must conform to
the RecourseContract v1 schema. The script fails loudly on the first invalid
fixture so registration never proceeds against a broken κ.

Canonical EIP-712 ids are checked by the runtime
``contract-id-catalog.test.ts`` and the Foundry ``RegisterFixtures.t.sol``
parity test. This script checks structural validity and cross-field invariants
the schema cannot express.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import jsonschema
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "schemas" / "recourse_contract.v1.json"
FIXTURES = ROOT / "fixtures" / "k-contracts"

EXPECTED_FIXTURES = (
    "k-postgres-update.json",
    "k-postgres-ddl.json",
    "k-git-pushforce.json",
    "k-cloud-ssm.json",
    "k-cloud-rds-snapshot.json",
)


def _cross_field_invariants(name: str, k: dict) -> list[str]:
    issues: list[str] = []
    max_payout = int(k["payoutRule"]["maxPayout"])
    min_bond = int(k["bond"]["minAmount"])
    max_agg = int(k["bond"]["maxAggregateExposure"])
    if max_agg < max_payout:
        issues.append(
            f"{name}: bond.maxAggregateExposure ({max_agg}) < payoutRule.maxPayout ({max_payout})"
        )
    if min_bond < max_payout:
        issues.append(
            f"{name}: bond.minAmount ({min_bond}) < payoutRule.maxPayout ({max_payout}); "
            "recourse capital must at least cover the per-claim cap"
        )
    covered = set(k["coveredLossClass"]["codes"])
    excluded = set(k["coveredLossClass"]["excludeList"])
    overlap = covered & excluded
    if overlap:
        issues.append(f"{name}: coveredLossClass codes overlap excludeList: {sorted(overlap)}")
    if k["effectClass"] != "compensable":
        issues.append(f"{name}: effectClass must be 'compensable' to be admissible")
    recovery_seconds = k["deadlines"]["recoverySeconds"]
    submission_seconds = k["deadlines"]["submissionSeconds"]
    if recovery_seconds >= submission_seconds:
        issues.append(
            f"{name}: deadlines.recoverySeconds ({recovery_seconds}) must be less than "
            f"deadlines.submissionSeconds ({submission_seconds})"
        )
    return issues


def main() -> int:
    schema = json.loads(SCHEMA.read_text())
    validator = Draft202012Validator(schema)

    issues: list[str] = []
    seen_ids: dict[str, str] = {}
    for fname in EXPECTED_FIXTURES:
        path = FIXTURES / fname
        if not path.exists():
            issues.append(f"{fname}: missing fixture file at {path}")
            continue
        try:
            k = json.loads(path.read_text())
        except json.JSONDecodeError as exc:
            issues.append(f"{fname}: invalid JSON ({exc})")
            continue
        errs = sorted(validator.iter_errors(k), key=lambda e: list(e.path))
        for err in errs:
            loc = "/".join(str(p) for p in err.path) or "<root>"
            issues.append(f"{fname}:{loc} schema violation: {err.message}")
        issues.extend(_cross_field_invariants(fname, k))
        cid = k.get("contractId")
        if cid in seen_ids and cid is not None:
            issues.append(
                f"{fname}: duplicate contractId {cid} (also used by {seen_ids[cid]})"
            )
        elif cid is not None:
            seen_ids[cid] = fname

    if issues:
        for i in issues:
            print(f"FAIL {i}", file=sys.stderr)
        print(f"\n{len(issues)} validation issue(s) across {len(EXPECTED_FIXTURES)} fixtures.", file=sys.stderr)
        return 1

    print(f"OK: {len(EXPECTED_FIXTURES)} κ-contract fixtures valid against RecourseContract v1")
    for fname in EXPECTED_FIXTURES:
        k = json.loads((FIXTURES / fname).read_text())
        print(
            f"  - {fname}: tool={k['actionTemplate']['tool']:<8} "
            f"action={k['actionTemplate']['action']:<22} "
            f"maxPayout={k['payoutRule']['maxPayout']} "
            f"bond.min={k['bond']['minAmount']}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
