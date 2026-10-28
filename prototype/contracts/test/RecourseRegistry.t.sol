// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Eip712Recourse} from "../src/Eip712Recourse.sol";
import {RecourseRegistry} from "../src/RecourseRegistry.sol";
import {RecourseTypes} from "../src/Types.sol";

contract RecourseRegistryTest is Test {
    bytes4 internal constant INVALID_DEADLINE_ORDER_SELECTOR = bytes4(keccak256("InvalidDeadlineOrder(uint64,uint64)"));
    bytes4 internal constant MINIMUM_BOND_BELOW_MAX_PAYOUT_SELECTOR =
        bytes4(keccak256("MinimumBondBelowMaxPayout(uint256,uint256)"));

    RecourseRegistry internal registry;
    address internal constant OPERATOR = address(0xAA00000000000000000000000000000000000001);
    address internal constant ARBITRATOR = address(0x000000000000000000000000000000000000d100);
    address internal constant USDC = address(0x00000000000000000000000000000000000aAaAA);

    function setUp() public {
        registry = new RecourseRegistry();
    }

    function _validContract() internal pure returns (RecourseTypes.RecourseContract memory) {
        return RecourseTypes.RecourseContract({
            schemaVersion: 1,
            operator: OPERATOR,
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
            bond: RecourseTypes.Bond({asset: USDC, minAmount: 5_000_000_000, maxAggregateExposure: 10_000_000_000}),
            evidenceSchema: RecourseTypes.EvidenceSchema({
                schemaId: bytes32(uint256(6)),
                requiredProvenance: RecourseTypes.Provenance.L1,
                accessPolicyHash: bytes32(uint256(7))
            }),
            deadlines: RecourseTypes.Deadlines({recoverySeconds: 1800, submissionSeconds: 86400, livenessSeconds: 21600}),
            disputeRoute: RecourseTypes.DisputeRoute({arbitrator: ARBITRATOR, evidenceGroupId: 1001})
        });
    }

    function test_registerStoresAndEmits() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        bytes32 expectedId = Eip712Recourse.recourseContractStructHash(k);

        vm.prank(OPERATOR);
        vm.expectEmit(true, true, false, false, address(registry));
        emit RecourseRegistry.ContractRegistered(expectedId, OPERATOR);
        bytes32 id = registry.register(k);

        assertEq(id, expectedId);
        assertTrue(registry.isAdmissible(id));
        RecourseTypes.RecourseContract memory stored = registry.get(id);
        assertEq(stored.bond.minAmount, k.bond.minAmount);
    }

    function test_registerUsesTypedHashForContractId() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        bytes32 typedId = Eip712Recourse.recourseContractStructHash(k);
        bytes32 rawAbiId = keccak256(abi.encode(k));

        vm.prank(OPERATOR);
        bytes32 id = registry.register(k);

        assertEq(id, typedId);
        assertTrue(id != rawAbiId);
    }

    function test_registerRevertsOnNonCompensable() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        k.effectClass = RecourseTypes.EffectClass.Reversible;
        vm.prank(OPERATOR);
        vm.expectRevert(RecourseRegistry.NotCompensable.selector);
        registry.register(k);
    }

    function test_registerRevertsOnUnsupportedSchemaVersion() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        k.schemaVersion = 2;
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(RecourseRegistry.UnsupportedSchemaVersion.selector, 1, 2));
        registry.register(k);
    }

    function test_registerRevertsOnZeroBond() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        k.bond.minAmount = 0;
        vm.prank(OPERATOR);
        vm.expectRevert(RecourseRegistry.ZeroBond.selector);
        registry.register(k);
    }

    function test_registerRevertsOnInvalidPayoutAndBondAsset() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        k.payoutRule.maxPayout = 0;
        vm.prank(OPERATOR);
        vm.expectRevert(RecourseRegistry.ZeroPayout.selector);
        registry.register(k);

        k = _validContract();
        k.bond.minAmount = k.payoutRule.maxPayout - 1;
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(MINIMUM_BOND_BELOW_MAX_PAYOUT_SELECTOR, k.bond.minAmount, k.payoutRule.maxPayout)
        );
        registry.register(k);

        k = _validContract();
        k.bond.asset = address(0);
        vm.prank(OPERATOR);
        vm.expectRevert(RecourseRegistry.ZeroBondAsset.selector);
        registry.register(k);

        k = _validContract();
        k.bond.maxAggregateExposure = k.payoutRule.maxPayout - 1;
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                RecourseRegistry.AggregateExposureBelowMaxPayout.selector,
                k.bond.maxAggregateExposure,
                k.payoutRule.maxPayout
            )
        );
        registry.register(k);
    }

    function test_registerRevertsOnZeroDeadlines() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        k.deadlines.recoverySeconds = 0;
        vm.prank(OPERATOR);
        vm.expectRevert(RecourseRegistry.ZeroDeadlines.selector);
        registry.register(k);

        k = _validContract();
        k.deadlines.submissionSeconds = 0;
        vm.prank(OPERATOR);
        vm.expectRevert(RecourseRegistry.ZeroDeadlines.selector);
        registry.register(k);

        k = _validContract();
        k.deadlines.livenessSeconds = 0;
        vm.prank(OPERATOR);
        vm.expectRevert(RecourseRegistry.ZeroDeadlines.selector);
        registry.register(k);
    }

    function test_registerRequiresRecoveryBeforeSubmissionDeadline() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        k.deadlines.recoverySeconds = k.deadlines.submissionSeconds;
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                INVALID_DEADLINE_ORDER_SELECTOR, k.deadlines.recoverySeconds, k.deadlines.submissionSeconds
            )
        );
        registry.register(k);

        k = _validContract();
        k.deadlines.recoverySeconds = k.deadlines.submissionSeconds + 1;
        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                INVALID_DEADLINE_ORDER_SELECTOR, k.deadlines.recoverySeconds, k.deadlines.submissionSeconds
            )
        );
        registry.register(k);
    }

    function test_registerRevertsOnZeroArbitrator() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        k.disputeRoute.arbitrator = address(0);
        vm.prank(OPERATOR);
        vm.expectRevert(RecourseRegistry.ZeroArbitrator.selector);
        registry.register(k);
    }

    function test_registerRevertsOnDuplicate() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        vm.prank(OPERATOR);
        bytes32 id = registry.register(k);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(RecourseRegistry.AlreadyRegistered.selector, id));
        registry.register(k);
    }

    function test_registerRevertsForNonOperator() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        address bystander = address(0xBEEF);
        vm.prank(bystander);
        vm.expectRevert(abi.encodeWithSelector(RecourseRegistry.NotOperator.selector, bystander, OPERATOR));
        registry.register(k);
    }

    function test_getRevertsOnUnknown() public {
        bytes32 fake = keccak256("fake");
        vm.expectRevert(abi.encodeWithSelector(RecourseRegistry.UnknownContract.selector, fake));
        registry.get(fake);
    }

    function test_revokeBlocksFutureAdmission() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        vm.prank(OPERATOR);
        bytes32 id = registry.register(k);
        assertTrue(registry.isAdmissible(id));

        vm.prank(OPERATOR);
        registry.revoke(id);

        assertTrue(!registry.isAdmissible(id));
        // get() still works after revoke — existing claims must be resolvable.
        RecourseTypes.RecourseContract memory stored = registry.get(id);
        assertEq(stored.operator, OPERATOR);
    }

    function test_revokeRevertsForNonOperator() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        vm.prank(OPERATOR);
        bytes32 id = registry.register(k);
        address bystander = address(0xBEEF);
        vm.prank(bystander);
        vm.expectRevert(abi.encodeWithSelector(RecourseRegistry.NotOperator.selector, bystander, OPERATOR));
        registry.revoke(id);
    }

    function test_revokeRevertsTwice() public {
        RecourseTypes.RecourseContract memory k = _validContract();
        vm.prank(OPERATOR);
        bytes32 id = registry.register(k);
        vm.prank(OPERATOR);
        registry.revoke(id);
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(RecourseRegistry.AlreadyRevoked.selector, id));
        registry.revoke(id);
    }

    function testFuzz_distinctContractsGetDistinctIds(uint256 saltA, uint256 saltB) public {
        vm.assume(saltA != saltB);
        RecourseTypes.RecourseContract memory kA = _validContract();
        RecourseTypes.RecourseContract memory kB = _validContract();
        kA.recoveryOperator.authPolicyHash = bytes32(saltA);
        kB.recoveryOperator.authPolicyHash = bytes32(saltB);
        vm.prank(OPERATOR);
        bytes32 idA = registry.register(kA);
        vm.prank(OPERATOR);
        bytes32 idB = registry.register(kB);
        assertTrue(idA != idB);
        assertTrue(registry.isAdmissible(idA));
        assertTrue(registry.isAdmissible(idB));
    }
}
