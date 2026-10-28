"""Validate each in-repo example contract against the canonical κ JSON schema.

The schemas live in prototype/schemas; they are the single source of truth across the
Solidity, TypeScript, and Python tiers. Any drift here is a schema-versioning bug.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

SCHEMAS_DIR = Path(__file__).resolve().parents[2] / "schemas"
EXAMPLES_DIR = SCHEMAS_DIR / "examples"


def _load(path: Path) -> dict:
    return json.loads(path.read_text())


@pytest.fixture(scope="module")
def contract_validator() -> Draft202012Validator:
    schema = _load(SCHEMAS_DIR / "recourse_contract.v1.json")
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


@pytest.fixture(scope="module")
def effect_validator() -> Draft202012Validator:
    schema = _load(SCHEMAS_DIR / "effect_receipt.v1.json")
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


@pytest.fixture(scope="module")
def recovery_validator() -> Draft202012Validator:
    schema = _load(SCHEMAS_DIR / "recovery_receipt.v1.json")
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


@pytest.fixture(scope="module")
def claim_validator() -> Draft202012Validator:
    schema = _load(SCHEMAS_DIR / "claim.v1.json")
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


@pytest.mark.parametrize(
    "example_name",
    ["postgres.contract.json", "git.contract.json", "cloud.contract.json"],
)
def test_example_contracts_validate(
    contract_validator: Draft202012Validator, example_name: str
) -> None:
    instance = _load(EXAMPLES_DIR / example_name)
    errors = sorted(contract_validator.iter_errors(instance), key=lambda e: e.path)
    assert not errors, "\n".join(f"{list(e.path)}: {e.message}" for e in errors)


def test_compensable_only(contract_validator: Draft202012Validator) -> None:
    """effectClass=='compensable' is enforced — reversible or excluded must reject."""
    instance = _load(EXAMPLES_DIR / "postgres.contract.json")
    instance["effectClass"] = "reversible"
    errors = list(contract_validator.iter_errors(instance))
    assert errors, "schema must reject non-compensable effect class"


def test_amount_strings_must_be_decimal(
    contract_validator: Draft202012Validator,
) -> None:
    """uint256 amounts are decimal strings; hex or signed values must reject."""
    instance = _load(EXAMPLES_DIR / "postgres.contract.json")
    instance["bond"]["minAmount"] = "0x1234"
    errors = list(contract_validator.iter_errors(instance))
    assert errors, "schema must reject non-decimal amount strings"


def test_unknown_loss_code_rejected(
    contract_validator: Draft202012Validator,
) -> None:
    instance = _load(EXAMPLES_DIR / "postgres.contract.json")
    instance["coveredLossClass"]["codes"].append("not_a_real_code")
    errors = list(contract_validator.iter_errors(instance))
    assert errors, "schema must reject unknown coveredLossClass codes"


def test_effect_receipt_example_validates(
    effect_validator: Draft202012Validator,
) -> None:
    instance = _load(EXAMPLES_DIR / "postgres.effect_receipt.json")
    errors = sorted(effect_validator.iter_errors(instance), key=lambda e: e.path)
    assert not errors, "\n".join(f"{list(e.path)}: {e.message}" for e in errors)


def test_recovery_receipt_example_validates(
    recovery_validator: Draft202012Validator,
) -> None:
    instance = _load(EXAMPLES_DIR / "postgres.recovery_receipt.json")
    errors = sorted(recovery_validator.iter_errors(instance), key=lambda e: e.path)
    assert not errors, "\n".join(f"{list(e.path)}: {e.message}" for e in errors)


def test_claim_example_validates(claim_validator: Draft202012Validator) -> None:
    instance = _load(EXAMPLES_DIR / "postgres.claim.json")
    errors = sorted(claim_validator.iter_errors(instance), key=lambda e: e.path)
    assert not errors, "\n".join(f"{list(e.path)}: {e.message}" for e in errors)


def test_recovery_receipt_outcome_must_be_enum(
    recovery_validator: Draft202012Validator,
) -> None:
    instance = _load(EXAMPLES_DIR / "postgres.recovery_receipt.json")
    instance["outcome"] = "great-success"
    errors = list(recovery_validator.iter_errors(instance))
    assert errors, "schema must reject unknown outcome values"


def test_signature_length_enforced(
    effect_validator: Draft202012Validator,
) -> None:
    instance = _load(EXAMPLES_DIR / "postgres.effect_receipt.json")
    instance["signature"] = "0x1234"  # too short for 65-byte sig
    errors = list(effect_validator.iter_errors(instance))
    assert errors, "schema must reject signatures that are not 65 bytes"
