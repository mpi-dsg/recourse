"""Regression tests for deployment receipt and bytecode verification tools."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from deployment_receipts import extract_deployment_receipts
from verify_base_sepolia import compare_runtime_bytecode


class DeploymentReceiptExtractionTest(unittest.TestCase):
    def test_extracts_per_transaction_and_total_gas(self) -> None:
        broadcast = {
            "chain": 84532,
            "commit": "abc123",
            "timestamp": 1234,
            "transactions": [
                {
                    "hash": "0x01",
                    "transactionType": "CREATE",
                    "contractName": "A",
                    "contractAddress": "0x0000000000000000000000000000000000000001",
                },
                {
                    "hash": "0x02",
                    "transactionType": "CALL",
                    "contractName": "A",
                    "contractAddress": "0x0000000000000000000000000000000000000001",
                },
            ],
            "receipts": [
                {
                    "transactionHash": "0x02",
                    "blockNumber": "0x11",
                    "status": "0x1",
                    "gasUsed": "0x20",
                    "l1GasUsed": "0x3",
                    "effectiveGasPrice": "0x4",
                },
                {
                    "transactionHash": "0x01",
                    "blockNumber": "0x10",
                    "status": "0x1",
                    "gasUsed": "0x10",
                    "l1GasUsed": "0x2",
                    "effectiveGasPrice": "0x4",
                },
            ],
        }

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run.json"
            path.write_text(json.dumps(broadcast))
            extracted = extract_deployment_receipts(path)

        self.assertEqual(extracted["summary"]["transactionCount"], 2)
        self.assertEqual(extracted["summary"]["totalExecutionGas"], 48)
        self.assertEqual(extracted["summary"]["totalL1Gas"], 5)
        self.assertEqual(extracted["summary"]["lastBlockNumber"], 17)
        self.assertEqual(extracted["transactions"][0]["gasUsed"], 16)
        self.assertEqual(extracted["transactions"][1]["gasUsed"], 32)

    def test_rejects_transaction_without_receipt(self) -> None:
        broadcast = {
            "chain": 84532,
            "transactions": [{"hash": "0x01", "transactionType": "CALL"}],
            "receipts": [],
        }

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run.json"
            path.write_text(json.dumps(broadcast))
            with self.assertRaisesRegex(ValueError, "missing receipt"):
                extract_deployment_receipts(path)


class RuntimeBytecodeComparisonTest(unittest.TestCase):
    def test_ignores_linked_immutable_values_but_not_source_changes(self) -> None:
        artifact = {
            "deployedBytecode": {
                "object": "0x600100006002",
                "immutableReferences": {"7": [{"start": 2, "length": 2}]},
            }
        }

        immutable_only = compare_runtime_bytecode(
            "Example", "0x6001ffff6002", artifact
        )
        source_change = compare_runtime_bytecode(
            "Example", "0x6001ffff6003", artifact
        )

        self.assertTrue(immutable_only["matchesCurrentArtifact"])
        self.assertFalse(source_change["matchesCurrentArtifact"])
        self.assertEqual(immutable_only["immutableByteCount"], 2)


if __name__ == "__main__":
    unittest.main()
