// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RecourseTypes} from "../src/Types.sol";

contract TypesTest is Test {
    function test_schemaVersionPinned() public pure {
        assertEq(uint256(RecourseTypes.SCHEMA_VERSION), uint256(1));
    }

    function test_constructRecourseContractInMemory() public pure {
        RecourseTypes.RecourseContract memory k = RecourseTypes.RecourseContract({
            schemaVersion: RecourseTypes.SCHEMA_VERSION,
            operator: address(0xAA00000000000000000000000000000000000001),
            actionTemplate: RecourseTypes.ActionTemplate({tool: "postgres", action: "bulkDelete"}),
            resourceScope: RecourseTypes.ResourceScope({scopeType: "postgres-table", descriptorHash: bytes32(uint256(1))}),
            effectClass: RecourseTypes.EffectClass.Compensable,
            recoveryOperator: RecourseTypes.RecoveryOperator({
                compensatorId: keccak256("postgres.snapshot.restore.v1"),
                freshnessSeconds: 3600,
                retentionSeconds: 1209600,
                authPolicyHash: bytes32(uint256(2))
            }),
            coveredLossClass: RecourseTypes.CoveredLossClass({
                codesHash: bytes32(uint256(3)),
                excludeListHash: bytes32(uint256(4))
            }),
            payoutRule: RecourseTypes.PayoutRule({
                ruleType: keccak256("composite"),
                paramsHash: bytes32(uint256(5)),
                maxPayout: 1_000_000_000
            }),
            bond: RecourseTypes.Bond({
                asset: address(0x00000000000000000000000000000000000aAaAA),
                minAmount: 5_000_000_000,
                maxAggregateExposure: 10_000_000_000
            }),
            evidenceSchema: RecourseTypes.EvidenceSchema({
                schemaId: bytes32(uint256(6)),
                requiredProvenance: RecourseTypes.Provenance.L1,
                accessPolicyHash: bytes32(uint256(7))
            }),
            deadlines: RecourseTypes.Deadlines({recoverySeconds: 1800, submissionSeconds: 86400, livenessSeconds: 21600}),
            disputeRoute: RecourseTypes.DisputeRoute({
                arbitrator: address(0x000000000000000000000000000000000000d100),
                evidenceGroupId: 1001
            })
        });
        assertEq(uint256(k.schemaVersion), 1);
        assertEq(k.bond.minAmount, 5_000_000_000);
        assertEq(uint256(k.effectClass), uint256(RecourseTypes.EffectClass.Compensable));
    }

    function test_constructEffectReceiptInMemory() public pure {
        RecourseTypes.EffectReceipt memory e = RecourseTypes.EffectReceipt({
            schemaVersion: 1,
            contractId: bytes32(uint256(0x11)),
            jobId: bytes32(uint256(0xde)),
            intentHash: bytes32(uint256(0x99)),
            paramsHash: bytes32(uint256(0x88)),
            resourceId: bytes32(uint256(0x77)),
            preStateDigest: bytes32(uint256(0x66)),
            postStateDigest: bytes32(uint256(0x55)),
            providerReceiptHash: bytes32(uint256(0x44)),
            timestamp: 1_746_979_200,
            adapterAddress: address(0x000000000000000000000000000000000000bEEF)
        });
        assertEq(e.timestamp, 1_746_979_200);
    }

    function test_recoveryOutcomeEnumValues() public pure {
        assertEq(uint8(RecourseTypes.RecoveryOutcome.Success), 0);
        assertEq(uint8(RecourseTypes.RecoveryOutcome.Partial), 1);
        assertEq(uint8(RecourseTypes.RecoveryOutcome.Failure), 2);
        assertEq(uint8(RecourseTypes.RecoveryOutcome.Inconclusive), 3);
    }
}
