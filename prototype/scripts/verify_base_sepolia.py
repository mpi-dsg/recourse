#!/usr/bin/env python3
"""Read-only verification of pinned Base Sepolia deployment bytecode."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_RPC_URL = "https://sepolia.base.org"
DEFAULT_IDENTIFIER_SELECTOR = "0xd509b017"
FINDER_SELECTOR = "0xb9a3c84c"
GET_IMPLEMENTATION_ADDRESS_SELECTOR = "0xaafd5e40"
IS_IDENTIFIER_SUPPORTED_SELECTOR = "0x90978d1b"
IDENTIFIER_WHITELIST_INTERFACE = (
    "4964656e74696669657257686974656c69737400000000000000000000000000"
)
LEGACY_IDENTIFIER = (
    "9ad80cd341a6ebd82d6a56057ac0e34f41d58e5345d90d8f4b0ef30665dbc282"
)


class JsonRpc:
    def __init__(self, url: str) -> None:
        self._url = url
        self._next_id = 1

    def call(self, method: str, params: list[Any]) -> Any:
        request_id = self._next_id
        self._next_id += 1
        payload = json.dumps(
            {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        ).encode()
        request = urllib.request.Request(
            self._url,
            data=payload,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "recourse-deployment-verifier/1",
            },
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read())
        if "error" in result:
            raise RuntimeError(f"{method}: {result['error']}")
        if result.get("id") != request_id or "result" not in result:
            raise RuntimeError(f"{method}: malformed JSON-RPC response")
        return result["result"]


def _hex_bytes(value: str, field: str) -> bytes:
    if not isinstance(value, str) or not value.startswith("0x"):
        raise ValueError(f"{field} must be 0x-prefixed hex")
    try:
        return bytes.fromhex(value[2:])
    except ValueError as exc:
        raise ValueError(f"{field} contains invalid hex") from exc


def _decode_address(value: str, field: str) -> str:
    encoded = _hex_bytes(value, field)
    if len(encoded) != 32:
        raise ValueError(f"{field} must be one ABI word")
    return f"0x{encoded[-20:].hex()}"


def _decode_bool(value: str, field: str) -> bool:
    encoded = _hex_bytes(value, field)
    if len(encoded) != 32 or int.from_bytes(encoded, "big") not in (0, 1):
        raise ValueError(f"{field} must be an ABI-encoded bool")
    return bool(int.from_bytes(encoded, "big"))


def _immutable_ranges(artifact: dict[str, Any]) -> list[tuple[int, int]]:
    references = artifact.get("deployedBytecode", {}).get(
        "immutableReferences", {}
    )
    ranges: list[tuple[int, int]] = []
    for entries in references.values():
        for entry in entries:
            ranges.append((int(entry["start"]), int(entry["length"])))
    return ranges


def _zero_ranges(code: bytes, ranges: list[tuple[int, int]]) -> bytes:
    normalized = bytearray(code)
    for start, length in ranges:
        end = start + length
        if start < 0 or length < 0 or end > len(normalized):
            raise ValueError(
                f"immutable range [{start}, {end}) exceeds bytecode length {len(code)}"
            )
        normalized[start:end] = b"\x00" * length
    return bytes(normalized)


def compare_runtime_bytecode(
    contract_name: str, onchain_hex: str, artifact: dict[str, Any]
) -> dict[str, Any]:
    onchain = _hex_bytes(onchain_hex, f"{contract_name} on-chain code")
    compiled = _hex_bytes(
        artifact.get("deployedBytecode", {}).get("object", ""),
        f"{contract_name} deployedBytecode.object",
    )
    ranges = _immutable_ranges(artifact)
    normalized_onchain = _zero_ranges(onchain, ranges)
    normalized_compiled = _zero_ranges(compiled, ranges)
    return {
        "contractName": contract_name,
        "onchainCodeSize": len(onchain),
        "currentArtifactCodeSize": len(compiled),
        "immutableByteCount": sum(length for _, length in ranges),
        "onchainCodeSha256": hashlib.sha256(onchain).hexdigest(),
        "currentArtifactSha256": hashlib.sha256(compiled).hexdigest(),
        "normalizedOnchainSha256": hashlib.sha256(normalized_onchain).hexdigest(),
        "normalizedCurrentArtifactSha256": hashlib.sha256(
            normalized_compiled
        ).hexdigest(),
        "matchesCurrentArtifact": normalized_onchain == normalized_compiled,
    }


def _artifact_for(artifacts_dir: Path, contract_name: str) -> dict[str, Any]:
    candidates = sorted(
        artifacts_dir.glob(f"**/{contract_name}.sol/{contract_name}.json")
    )
    matches: list[tuple[Path, dict[str, Any]]] = []
    for path in candidates:
        artifact = json.loads(path.read_text())
        targets = artifact.get("metadata", {}).get("settings", {}).get(
            "compilationTarget", {}
        )
        if any(source.startswith("src/") for source in targets):
            matches.append((path, artifact))
    if len(matches) != 1:
        raise ValueError(
            f"expected one src artifact for {contract_name}, "
            f"found {[str(path) for path, _ in matches]}"
        )
    return matches[0][1]


def _local_commit(repo_root: Path) -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def verify(
    addresses_path: Path, artifacts_dir: Path, rpc_url: str
) -> dict[str, Any]:
    addresses = json.loads(addresses_path.read_text())
    rpc = JsonRpc(rpc_url)
    block_number = addresses.get("blockNumber")
    block_tag = hex(int(block_number)) if block_number is not None else "latest"

    comparisons: list[dict[str, Any]] = []
    deployed_code: dict[str, str] = {}
    for name, address in sorted(addresses["contracts"].items()):
        code = rpc.call("eth_getCode", [address, block_tag])
        deployed_code[name] = code
        comparisons.append(
            compare_runtime_bytecode(name, code, _artifact_for(artifacts_dir, name))
        )

    external_backends: dict[str, Any] = {}
    for name, address in sorted(addresses.get("externalBackends", {}).items()):
        code = rpc.call("eth_getCode", [address, block_tag])
        external_backends[name] = {
            "address": address,
            "hasCode": code != "0x",
            "codeSize": len(_hex_bytes(code, f"{name} code")),
            "codeSha256": hashlib.sha256(
                _hex_bytes(code, f"{name} code")
            ).hexdigest(),
        }

    oracle_address = addresses.get("externalBackends", {}).get(
        "OptimisticOracleV3_UMA"
    )
    oracle_default_identifier = None
    oracle_default_identifier_supported = None
    identifier_whitelist = None
    if oracle_address:
        oracle_default_identifier = rpc.call(
            "eth_call",
            [{"to": oracle_address, "data": DEFAULT_IDENTIFIER_SELECTOR}, block_tag],
        )
        finder_result = rpc.call(
            "eth_call", [{"to": oracle_address, "data": FINDER_SELECTOR}, block_tag]
        )
        finder = _decode_address(finder_result, "UMA finder")
        whitelist_result = rpc.call(
            "eth_call",
            [
                {
                    "to": finder,
                    "data": (
                        GET_IMPLEMENTATION_ADDRESS_SELECTOR
                        + IDENTIFIER_WHITELIST_INTERFACE
                    ),
                },
                block_tag,
            ],
        )
        identifier_whitelist = _decode_address(
            whitelist_result, "UMA identifier whitelist"
        )
        supported_result = rpc.call(
            "eth_call",
            [
                {
                    "to": identifier_whitelist,
                    "data": (
                        IS_IDENTIFIER_SUPPORTED_SELECTOR
                        + oracle_default_identifier.removeprefix("0x")
                    ),
                },
                block_tag,
            ],
        )
        oracle_default_identifier_supported = _decode_bool(
            supported_result, "UMA identifier support"
        )

    optimistic_code = deployed_code.get("OptimisticPath", "").lower()
    contains_legacy_identifier = LEGACY_IDENTIFIER in optimistic_code
    all_match = all(item["matchesCurrentArtifact"] for item in comparisons)
    classification = (
        "current-source-match"
        if all_match and not contains_legacy_identifier
        else "obsolete-source-mismatch"
    )

    repo_root = addresses_path.resolve().parents[3]
    return {
        "schemaVersion": 1,
        "kind": "base-sepolia-read-only-verification",
        "ok": True,
        "network": addresses.get("network"),
        "chainId": addresses.get("chainId"),
        "verificationBlock": block_number,
        "rpcEndpointLabel": addresses.get("rpcEndpointLabel"),
        "declaredDeploymentCommit": addresses.get("commit"),
        "localSourceCommit": _local_commit(repo_root),
        "classification": classification,
        "matchesCurrentSource": classification == "current-source-match",
        "contracts": comparisons,
        "externalBackends": external_backends,
        "compatibility": {
            "umaDefaultIdentifier": oracle_default_identifier,
            "umaDefaultIdentifierSupported": oracle_default_identifier_supported,
            "umaIdentifierWhitelist": identifier_whitelist,
            "legacyResidualLossIdentifier": f"0x{LEGACY_IDENTIFIER}",
            "optimisticPathContainsLegacyIdentifier": contains_legacy_identifier,
        },
    }


def main() -> int:
    prototype = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--addresses",
        type=Path,
        default=prototype / "deployments/base-sepolia/addresses.json",
    )
    parser.add_argument(
        "--artifacts", type=Path, default=prototype / "contracts/out"
    )
    parser.add_argument(
        "--rpc-url",
        default=os.environ.get("BASE_SEPOLIA_RPC_URL", DEFAULT_RPC_URL),
    )
    args = parser.parse_args()

    try:
        result = verify(args.addresses, args.artifacts, args.rpc_url)
    except (OSError, ValueError, KeyError, json.JSONDecodeError, RuntimeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True))
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["classification"] == "current-source-match" else 2


if __name__ == "__main__":
    raise SystemExit(main())
