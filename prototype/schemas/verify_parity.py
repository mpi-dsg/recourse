"""Verify that the canonical JSON schemas, the TypeScript type projection, and the Solidity
struct projection name the same fields.

This is a name-level parity check, not a semantic one. The chain stores hashes of nested
off-chain payloads (descriptor, params, residualMeasurements) rather than parsed nested
structures, so the Solidity projection collapses those into `*Hash` fields. The verifier
applies a deterministic JSON→Solidity field-name mapping:

  "<key>" with a primitive value           → "<key>"
  "<key>" with object/array value          → "<key>" (passthrough) OR "<key>Hash" (collapsed)
  "type" (special: Solidity reserved word) → "scopeType" / "ruleType"

The mapping is defined by JSON_TO_SOL_HASHED and JSON_TO_SOL_RENAMES below. When you add
a new JSON-schema field, you must also extend the type files and (if it is a nested
object) extend the mapping.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "schemas"
TS_TYPES = ROOT / "runtime-ts" / "packages" / "receipts" / "src" / "types.gen.ts"
SOL_TYPES = ROOT / "contracts" / "src" / "Types.sol"

# JSON-schema fields that the Solidity projection collapses into a single hash field.
JSON_TO_SOL_HASHED = {
    # (schemaName, jsonField) -> solidityField
    ("RecourseContract", "resourceScope.descriptor"): "descriptorHash",
    ("RecourseContract", "coveredLossClass.codes"): "codesHash",
    ("RecourseContract", "coveredLossClass.excludeList"): "excludeListHash",
    ("RecourseContract", "payoutRule.params"): "paramsHash",
    ("RecoveryReceipt", "residualMeasurements"): "residualMeasurementsHash",
    ("Claim", "evidenceCid"): "evidenceCidHash",
}

# JSON-schema fields renamed in Solidity because of reserved words or clarity.
JSON_TO_SOL_RENAMES = {
    ("ResourceScope", "type"): "scopeType",
    ("PayoutRule", "type"): "ruleType",
}

# Fields present off-chain only — the chain does not store these.
OFFCHAIN_ONLY = {
    ("EffectReceipt", "signature"),
    ("RecoveryReceipt", "signature"),
    ("Claim", "signature"),
    ("RecourseContract", "contractId"),  # the contractId IS the storage key on chain
}


def _camel_to_solidity(field: str, schema_name: str) -> str:
    renamed = JSON_TO_SOL_RENAMES.get((schema_name, field))
    return renamed if renamed else field


def _flatten_required(schema: dict, schema_name: str) -> set[str]:
    """Return the set of JSON-schema field paths we expect to find type-side.

    Nested object fields are kept as 'parent.child' when the chain stores them
    flat; collapsed-to-hash fields keep their nested key form so we can map them
    via JSON_TO_SOL_HASHED.
    """
    fields: set[str] = set()
    for name, prop in schema.get("properties", {}).items():
        fields.add(name)
        if prop.get("type") == "object" and "properties" in prop:
            for sub in prop["properties"]:
                fields.add(f"{name}.{sub}")
    return fields


def _solidity_struct_fields(sol_src: str, struct_name: str) -> set[str]:
    pattern = rf"struct\s+{struct_name}\s*\{{(.*?)\}}"
    m = re.search(pattern, sol_src, re.DOTALL)
    if not m:
        return set()
    body = m.group(1)
    # Each declaration looks like: "<type> <name>;  // comment"
    fields = set()
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("//"):
            continue
        line = line.split("//", 1)[0].strip().rstrip(";")
        if not line:
            continue
        parts = line.split()
        if len(parts) >= 2:
            fields.add(parts[-1])
    return fields


def _typescript_interface_fields(ts_src: str, iface_name: str) -> set[str]:
    pattern = rf"interface\s+{iface_name}\s*\{{(.*?)\n\}}"
    m = re.search(pattern, ts_src, re.DOTALL)
    if not m:
        return set()
    body = m.group(1)
    fields = set()
    for line in body.splitlines():
        line = line.strip()
        if not line or line.startswith("//") or line.startswith("/*"):
            continue
        match = re.match(r"([A-Za-z_][A-Za-z0-9_]*)\??\s*:", line)
        if match:
            fields.add(match.group(1))
    return fields


def _check_schema(schema_file: str, schema_name: str, ts_iface: str, sol_struct: str) -> list[str]:
    issues: list[str] = []
    schema = json.loads((SCHEMAS / schema_file).read_text())
    ts_src = TS_TYPES.read_text()
    sol_src = SOL_TYPES.read_text()

    json_fields = _flatten_required(schema, schema_name)
    ts_fields = _typescript_interface_fields(ts_src, ts_iface)
    sol_fields = _solidity_struct_fields(sol_src, sol_struct)

    for jf in json_fields:
        offchain = (schema_name, jf) in OFFCHAIN_ONLY
        # TypeScript side: nested keys mostly live inside their parent type alias, so
        # only top-level keys are expected on the parent interface.
        if "." not in jf and not offchain and jf not in ts_fields:
            issues.append(f"{schema_name}: TS interface {ts_iface} missing field '{jf}'")

        # Solidity side
        if offchain:
            continue
        hashed = JSON_TO_SOL_HASHED.get((schema_name, jf))
        if hashed:
            if hashed not in sol_fields and not _find_in_any_struct(sol_src, hashed):
                issues.append(
                    f"{schema_name}: Solidity struct missing hashed field '{hashed}' (from JSON '{jf}')"
                )
            continue
        if "." in jf:
            parent, sub = jf.split(".", 1)
            sub_sol = _camel_to_solidity(sub, parent[0].upper() + parent[1:])
            # nested struct name is the capitalized parent (RecoveryOperator, Deadlines, ...)
            possible_struct_names = {
                "recoveryOperator": "RecoveryOperator",
                "coveredLossClass": "CoveredLossClass",
                "payoutRule": "PayoutRule",
                "bond": "Bond",
                "evidenceSchema": "EvidenceSchema",
                "deadlines": "Deadlines",
                "disputeRoute": "DisputeRoute",
                "actionTemplate": "ActionTemplate",
                "resourceScope": "ResourceScope",
            }
            target_struct = possible_struct_names.get(parent)
            if target_struct is None:
                continue
            nested_fields = _solidity_struct_fields(sol_src, target_struct)
            if sub_sol not in nested_fields:
                issues.append(
                    f"{schema_name}: Solidity nested struct {target_struct} missing field '{sub_sol}' (from JSON '{jf}')"
                )
        else:
            target = _camel_to_solidity(jf, schema_name)
            if target not in sol_fields:
                issues.append(f"{schema_name}: Solidity struct {sol_struct} missing field '{target}' (from JSON '{jf}')")
    return issues


def _find_in_any_struct(sol_src: str, field: str) -> bool:
    return bool(re.search(rf"\b{field}\b\s*;", sol_src))


def main() -> int:
    issues = []
    issues += _check_schema("recourse_contract.v1.json", "RecourseContract", "RecourseContract", "RecourseContract")
    issues += _check_schema("effect_receipt.v1.json", "EffectReceipt", "EffectReceipt", "EffectReceipt")
    issues += _check_schema("recovery_receipt.v1.json", "RecoveryReceipt", "RecoveryReceipt", "RecoveryReceipt")
    issues += _check_schema("claim.v1.json", "Claim", "Claim", "Claim")
    if issues:
        for i in issues:
            print(i)
        return 1
    print("schemas in parity (json + ts + solidity)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
