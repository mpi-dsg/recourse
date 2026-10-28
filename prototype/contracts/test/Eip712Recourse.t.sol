// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RecourseTypes} from "../src/Types.sol";
import {Eip712Recourse} from "../src/Eip712Recourse.sol";

/// @notice Pin the EIP-712 EffectReceipt digest against the value computed
///         by viem in `prototype/schemas/eip712_fixture.json`. If this test
///         fails, EITHER the TS and Solidity sides drifted (bug) OR a schema
///         field was changed without updating the fixture (regenerate via
///         `bun run packages/receipts/scripts/compute_digest.ts`).
contract Eip712RecourseTest is Test {
    // Locked from prototype/schemas/eip712_fixture.json (schema v1).
    bytes32 internal constant EXPECTED_DIGEST = 0x0f90fc644035ef80af7fb13123adc1bfd6cb670af4ff51b8a4d014ef65c5bebf;
    bytes32 internal constant EXPECTED_RECOVERY_DIGEST =
        0x26ec16eb6b2317c3342a264152177cdbcd5f45d37015dff1a45441f7797eebb2;
    bytes32 internal constant EXPECTED_CLAIM_DIGEST = 0x26aa9429f63732985b41ebfb59b1d20b9fe53c145868d07e3f2131fb2babd2f9;
    bytes32 internal constant EXPECTED_CONTRACT_ID = 0x49b4d1e81ceec50d64f53dea0ad2bd3f60af46e3f324265e666a1b4ea9d35c74;

    uint256 internal constant FIXTURE_CHAIN_ID = 84532;
    address internal constant FIXTURE_VERIFIER = address(0);

    function _fixtureReceipt() internal pure returns (RecourseTypes.EffectReceipt memory) {
        return RecourseTypes.EffectReceipt({
            schemaVersion: 1,
            contractId: 0x1111111111111111111111111111111111111111111111111111111111111111,
            jobId: 0xdead000000000000000000000000000000000000000000000000000000000001,
            intentHash: 0x9999000000000000000000000000000000000000000000000000000000000001,
            paramsHash: 0x8888000000000000000000000000000000000000000000000000000000000001,
            resourceId: 0x7777000000000000000000000000000000000000000000000000000000000001,
            preStateDigest: 0x6666000000000000000000000000000000000000000000000000000000000001,
            postStateDigest: 0x5555000000000000000000000000000000000000000000000000000000000001,
            providerReceiptHash: 0x4444000000000000000000000000000000000000000000000000000000000001,
            timestamp: 1_746_979_200,
            adapterAddress: address(0x000000000000000000000000000000000000bEEF)
        });
    }

    function _fixtureRecoveryReceipt() internal pure returns (RecourseTypes.RecoveryReceipt memory) {
        return RecourseTypes.RecoveryReceipt({
            schemaVersion: 1,
            contractId: 0x1111111111111111111111111111111111111111111111111111111111111111,
            effectReceiptHash: EXPECTED_DIGEST,
            compensatorAddress: address(0x000000000000000000000000000000000000c0DE),
            restoreArtifactHash: 0x1212000000000000000000000000000000000000000000000000000000000001,
            outcome: RecourseTypes.RecoveryOutcome.Success,
            residualMeasurementsHash: 0x3594c4ea07fe427094f498b36a4584484e1398ff67b9dc2fd4dc607c25412ca2,
            recoveryStartTs: 1_746_979_210,
            recoveryEndTs: 1_746_979_240
        });
    }

    function _fixtureClaim() internal pure returns (RecourseTypes.Claim memory) {
        return RecourseTypes.Claim({
            schemaVersion: 1,
            contractId: 0x1111111111111111111111111111111111111111111111111111111111111111,
            jobId: 0xdead000000000000000000000000000000000000000000000000000000000001,
            claimant: address(0x000000000000000000000000000000000000cafE),
            amount: 640_000_000,
            evidenceCidHash: 0xec017bf3bbba58c70db1164a3cd6eec5076e4f6c4f098f6deb8638b56dcac1c0,
            effectReceiptHash: EXPECTED_DIGEST,
            recoveryReceiptHash: EXPECTED_RECOVERY_DIGEST,
            routeHint: RecourseTypes.RouteHint.Optimistic
        });
    }

    function _fixtureContract() internal pure returns (RecourseTypes.RecourseContract memory) {
        return RecourseTypes.RecourseContract({
            schemaVersion: 1,
            operator: address(0xAA00000000000000000000000000000000000001),
            actionTemplate: RecourseTypes.ActionTemplate({tool: "postgres", action: "bulkDelete"}),
            resourceScope: RecourseTypes.ResourceScope({
                scopeType: "postgres-table",
                descriptorHash: 0xf3ce91fbe90fcd3a8b90ebfeb3e709a8f73957fb7ffa7439b952c7715e984180
            }),
            effectClass: RecourseTypes.EffectClass.Compensable,
            recoveryOperator: RecourseTypes.RecoveryOperator({
                compensatorId: keccak256("postgres.snapshot.restore.v1"),
                freshnessSeconds: 3600,
                retentionSeconds: 1_209_600,
                authPolicyHash: 0xaaaa000000000000000000000000000000000000000000000000000000000001
            }),
            coveredLossClass: RecourseTypes.CoveredLossClass({
                codesHash: 0xe495202ed94d42467e46508af7109557caa736f2d555cde8538254015ff46033,
                excludeListHash: 0x0687af526fbebb9140a76dce7422ecc7d21c347158496caacb153035e2efbe89
            }),
            payoutRule: RecourseTypes.PayoutRule({
                ruleType: keccak256("composite"),
                paramsHash: 0xb00c3f449f2d8621ce6e29a1fc1fe3adeffadf6368df568fc0ff75e8f1791a3d,
                maxPayout: 1_000_000_000
            }),
            bond: RecourseTypes.Bond({
                asset: address(0x0000000000000000000000000000000000AAAAAa),
                minAmount: 5_000_000_000,
                maxAggregateExposure: 10_000_000_000
            }),
            evidenceSchema: RecourseTypes.EvidenceSchema({
                schemaId: 0xbbbb000000000000000000000000000000000000000000000000000000000001,
                requiredProvenance: RecourseTypes.Provenance.L1,
                accessPolicyHash: 0xcccc000000000000000000000000000000000000000000000000000000000001
            }),
            deadlines: RecourseTypes.Deadlines({recoverySeconds: 1800, submissionSeconds: 86_400, livenessSeconds: 21_600}),
            disputeRoute: RecourseTypes.DisputeRoute({
                arbitrator: address(0x000000000000000000000000000000000000d100),
                evidenceGroupId: 1001
            })
        });
    }

    function test_effectReceiptDigestMatchesViem() public pure {
        bytes32 d = Eip712Recourse.effectReceiptDigest(FIXTURE_CHAIN_ID, FIXTURE_VERIFIER, _fixtureReceipt());
        assertEq(d, EXPECTED_DIGEST, "Solidity digest must equal viem digest from eip712_fixture.json");
    }

    function test_changeInScalarMutatesDigest() public pure {
        RecourseTypes.EffectReceipt memory r = _fixtureReceipt();
        r.timestamp = r.timestamp + 1;
        bytes32 d = Eip712Recourse.effectReceiptDigest(FIXTURE_CHAIN_ID, FIXTURE_VERIFIER, r);
        assertTrue(d != EXPECTED_DIGEST, "perturbed receipt must produce a different digest");
    }

    function test_changeInChainIdMutatesDigest() public pure {
        bytes32 d = Eip712Recourse.effectReceiptDigest(FIXTURE_CHAIN_ID + 1, FIXTURE_VERIFIER, _fixtureReceipt());
        assertTrue(d != EXPECTED_DIGEST, "domain chainId is part of the digest");
    }

    function test_recoveryReceiptDigestMatchesViem() public pure {
        bytes32 d = Eip712Recourse.recoveryReceiptDigest(FIXTURE_CHAIN_ID, FIXTURE_VERIFIER, _fixtureRecoveryReceipt());
        assertEq(d, EXPECTED_RECOVERY_DIGEST, "Solidity recovery digest must equal viem digest");
    }

    function test_claimDigestMatchesViem() public pure {
        bytes32 d = Eip712Recourse.claimDigest(FIXTURE_CHAIN_ID, FIXTURE_VERIFIER, _fixtureClaim());
        assertEq(d, EXPECTED_CLAIM_DIGEST, "Solidity claim digest must equal viem digest");
    }

    function test_recourseContractStructHashMatchesViem() public pure {
        bytes32 d = Eip712Recourse.recourseContractStructHash(_fixtureContract());
        assertEq(d, EXPECTED_CONTRACT_ID, "Solidity contract id must equal viem struct hash");
    }
}
