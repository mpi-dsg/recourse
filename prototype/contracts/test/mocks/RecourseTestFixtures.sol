// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RecourseTypes} from "../../src/Types.sol";
import {ClaimRegistry} from "../../src/ClaimRegistry.sol";
import {Eip712Recourse} from "../../src/Eip712Recourse.sol";
import {Test} from "forge-std/Test.sol";

abstract contract RecourseTestFixtures is Test {
    uint256 internal constant USDC_ONE = 1_000_000;
    uint256 internal constant CLAIMANT_KEY = 0xC1A17;
    address internal constant OPERATOR = address(0xAA00000000000000000000000000000000000001);
    address internal constant CLAIMANT = address(0xEAdb4171B50F251FC3EeBD7b4648455bD3D48263);
    address internal constant CHALLENGER = address(0xdD00000000000000000000000000000000000001);
    address internal constant ARBITRATOR = address(0x000000000000000000000000000000000000d100);
    address internal constant ADAPTER = address(0xAD00000000000000000000000000000000000001);
    address internal constant COMPENSATOR = address(0xC000000000000000000000000000000000000001);

    function _recourseContract(address operator, address asset, address arbitrator, uint256 maxPayout, uint256 minBond)
        internal
        pure
        returns (RecourseTypes.RecourseContract memory)
    {
        return RecourseTypes.RecourseContract({
            schemaVersion: 1,
            operator: operator,
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
                maxPayout: maxPayout
            }),
            bond: RecourseTypes.Bond({asset: asset, minAmount: minBond, maxAggregateExposure: maxPayout}),
            evidenceSchema: RecourseTypes.EvidenceSchema({
                schemaId: bytes32(uint256(6)),
                requiredProvenance: RecourseTypes.Provenance.L1,
                accessPolicyHash: bytes32(uint256(7))
            }),
            deadlines: RecourseTypes.Deadlines({recoverySeconds: 1800, submissionSeconds: 86400, livenessSeconds: 21600}),
            disputeRoute: RecourseTypes.DisputeRoute({arbitrator: arbitrator, evidenceGroupId: 1001})
        });
    }

    function _effectCommit(bytes32 seed, RecourseTypes.Provenance provenance)
        internal
        view
        returns (ClaimRegistry.EffectReceiptCommit memory)
    {
        return ClaimRegistry.EffectReceiptCommit({
            schemaVersion: 1,
            receiptHash: keccak256(abi.encode("effect", seed)),
            provenance: provenance,
            timestamp: uint64(block.timestamp),
            evidenceHash: keccak256(abi.encode("evidence", seed))
        });
    }

    function _recoveryCommit(bytes32 seed, RecourseTypes.RecoveryOutcome outcome, RecourseTypes.Provenance provenance)
        internal
        view
        returns (ClaimRegistry.RecoveryReceiptCommit memory)
    {
        return ClaimRegistry.RecoveryReceiptCommit({
            schemaVersion: 1,
            receiptHash: keccak256(abi.encode("recovery", seed)),
            outcome: outcome,
            provenance: provenance,
            recoveryEndTs: uint64(block.timestamp)
        });
    }

    function _missingRecoveryCommit() internal pure returns (ClaimRegistry.RecoveryReceiptCommit memory) {
        return ClaimRegistry.RecoveryReceiptCommit({
            schemaVersion: 1,
            receiptHash: bytes32(0),
            outcome: RecourseTypes.RecoveryOutcome.Inconclusive,
            provenance: RecourseTypes.Provenance.L2,
            recoveryEndTs: 0
        });
    }

    function _signedClaim(
        ClaimRegistry claimRegistry,
        bytes32 contractId,
        bytes32 jobId,
        uint256 amount,
        bytes32 evidenceCid,
        RecourseTypes.RouteHint hint
    ) internal view returns (RecourseTypes.Claim memory claim, bytes memory signature) {
        ClaimRegistry.ReceiptRecord memory record = claimRegistry.getReceiptRecord(contractId, jobId);
        claim = RecourseTypes.Claim({
            schemaVersion: 1,
            contractId: contractId,
            jobId: jobId,
            claimant: CLAIMANT,
            amount: amount,
            evidenceCidHash: evidenceCid,
            effectReceiptHash: record.effectReceiptHash,
            recoveryReceiptHash: record.recoveryReceiptHash,
            routeHint: hint
        });
        bytes32 digest = Eip712Recourse.claimDigest(block.chainid, address(claimRegistry), claim);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CLAIMANT_KEY, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _submitClaim(
        ClaimRegistry claimRegistry,
        bytes32 contractId,
        bytes32 jobId,
        uint256 amount,
        bytes32 evidenceCid,
        RecourseTypes.RouteHint hint
    ) internal returns (bytes32 claimId) {
        (RecourseTypes.Claim memory claim, bytes memory signature) =
            _signedClaim(claimRegistry, contractId, jobId, amount, evidenceCid, hint);
        return claimRegistry.submitClaim(claim, signature);
    }
}
