#!/usr/bin/env python3
"""Extract deterministic gas and receipt data from a Foundry broadcast."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def _quantity(value: Any, field: str) -> int:
    if isinstance(value, int) and value >= 0:
        return value
    if isinstance(value, str):
        base = 16 if value.startswith(("0x", "0X")) else 10
        try:
            parsed = int(value, base)
        except ValueError as exc:
            raise ValueError(f"{field} is not a valid quantity: {value!r}") from exc
        if parsed >= 0:
            return parsed
    raise ValueError(f"{field} is not a non-negative quantity: {value!r}")


def extract_deployment_receipts(path: Path) -> dict[str, Any]:
    raw = path.read_bytes()
    broadcast = json.loads(raw)
    transactions = broadcast.get("transactions")
    receipts = broadcast.get("receipts")
    if not isinstance(transactions, list) or not isinstance(receipts, list):
        raise ValueError("broadcast must contain transaction and receipt arrays")

    receipts_by_hash: dict[str, dict[str, Any]] = {}
    for receipt in receipts:
        tx_hash = str(receipt.get("transactionHash", "")).lower()
        if not tx_hash:
            raise ValueError("receipt is missing transactionHash")
        if tx_hash in receipts_by_hash:
            raise ValueError(f"duplicate receipt for transaction {tx_hash}")
        receipts_by_hash[tx_hash] = receipt

    extracted_transactions: list[dict[str, Any]] = []
    consumed: set[str] = set()
    for index, transaction in enumerate(transactions):
        tx_hash = str(transaction.get("hash", "")).lower()
        if not tx_hash:
            raise ValueError(f"transaction {index} is missing hash")
        receipt = receipts_by_hash.get(tx_hash)
        if receipt is None:
            raise ValueError(f"missing receipt for transaction {tx_hash}")
        consumed.add(tx_hash)

        item: dict[str, Any] = {
            "index": index,
            "transactionHash": tx_hash,
            "transactionType": transaction.get("transactionType"),
            "contractName": transaction.get("contractName"),
            "contractAddress": transaction.get("contractAddress"),
            "blockNumber": _quantity(receipt.get("blockNumber"), "blockNumber"),
            "status": _quantity(receipt.get("status", 1), "status"),
            "gasUsed": _quantity(receipt.get("gasUsed"), "gasUsed"),
            "l1GasUsed": _quantity(receipt.get("l1GasUsed", 0), "l1GasUsed"),
            "effectiveGasPrice": _quantity(
                receipt.get("effectiveGasPrice", 0), "effectiveGasPrice"
            ),
        }
        extracted_transactions.append(item)

    unconsumed = sorted(set(receipts_by_hash) - consumed)
    if unconsumed:
        raise ValueError(f"receipts without matching transactions: {unconsumed}")

    blocks = [item["blockNumber"] for item in extracted_transactions]
    return {
        "schemaVersion": 1,
        "kind": "foundry-deployment-receipts",
        "chainId": _quantity(broadcast.get("chain"), "chain"),
        "declaredCommit": broadcast.get("commit"),
        "broadcastTimestamp": broadcast.get("timestamp"),
        "broadcastArtifactSha256": hashlib.sha256(raw).hexdigest(),
        "summary": {
            "transactionCount": len(extracted_transactions),
            "receiptCount": len(receipts),
            "firstBlockNumber": min(blocks) if blocks else None,
            "lastBlockNumber": max(blocks) if blocks else None,
            "totalExecutionGas": sum(item["gasUsed"] for item in extracted_transactions),
            "totalL1Gas": sum(item["l1GasUsed"] for item in extracted_transactions),
        },
        "transactions": extracted_transactions,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("broadcast", type=Path, help="Foundry run-latest.json")
    parser.add_argument("--output", type=Path, help="also write the normalized JSON")
    args = parser.parse_args()

    try:
        result = extract_deployment_receipts(args.broadcast)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, sort_keys=True))
        return 1

    rendered = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
