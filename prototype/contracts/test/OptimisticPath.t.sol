// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RecourseRegistry} from "../src/RecourseRegistry.sol";
import {BondVault} from "../src/BondVault.sol";
import {ClaimRegistry, ClaimState} from "../src/ClaimRegistry.sol";
import {OptimisticPath} from "../src/OptimisticPath.sol";
import {RecourseTypes} from "../src/Types.sol";
import {MockOptimisticOracleV3} from "./mocks/MockOptimisticOracleV3.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {RecourseTestFixtures} from "./mocks/RecourseTestFixtures.sol";

contract OptimisticPathTest is Test, RecourseTestFixtures {
    bytes4 internal constant CLAIM_CONTRACT_MISMATCH_SELECTOR =
        bytes4(keccak256("ClaimContractMismatch(bytes32,bytes32,bytes32)"));
    bytes4 internal constant ZERO_AMOUNT_SELECTOR = bytes4(keccak256("ZeroAmount()"));

    RecourseRegistry internal registry;
    BondVault internal vault;
    ClaimRegistry internal claims;
    OptimisticPath internal optimistic;
    MockOptimisticOracleV3 internal oracle;
    MockUSDC internal usdc;
    bytes32 internal contractId;

    function setUp() public {
        registry = new RecourseRegistry();
        usdc = new MockUSDC();
        vault = new BondVault(usdc, registry);
        claims = new ClaimRegistry(registry, vault);
        vault.setClaimRegistry(address(claims));
        oracle = new MockOptimisticOracleV3();
        optimistic = new OptimisticPath(address(oracle), address(claims), usdc);
        claims.setOptimisticPath(address(optimistic));

        RecourseTypes.RecourseContract memory k =
            _recourseContract(OPERATOR, address(usdc), ARBITRATOR, 1_000 * USDC_ONE, 1_000 * USDC_ONE);
        vm.prank(OPERATOR);
        contractId = registry.register(k);
        usdc.mint(OPERATOR, 1_000 * USDC_ONE);
        vm.startPrank(OPERATOR);
        usdc.approve(address(vault), 1_000 * USDC_ONE);
        vault.postBond(contractId, 1_000 * USDC_ONE);
        vm.stopPrank();

        usdc.mint(address(this), 100 * USDC_ONE);
        usdc.approve(address(optimistic), type(uint256).max);
    }

    function _submitOptimistic(bytes32 jobId, uint256 amount) internal returns (bytes32 claimId) {
        vm.prank(OPERATOR);
        claims.commitReceipts(
            contractId,
            jobId,
            _effectCommit(jobId, RecourseTypes.Provenance.L1),
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1)
        );
        claimId = _submitClaim(
            claims,
            contractId,
            jobId,
            amount,
            keccak256(abi.encode("evidence", jobId)),
            RecourseTypes.RouteHint.Optimistic
        );
    }

    function _submitArbitrated(bytes32 jobId, uint256 amount) internal returns (bytes32 claimId) {
        vm.prank(OPERATOR);
        claims.commitReceipts(
            contractId,
            jobId,
            _effectCommit(jobId, RecourseTypes.Provenance.L2),
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Failure, RecourseTypes.Provenance.L2)
        );
        claimId = _submitClaim(
            claims,
            contractId,
            jobId,
            amount,
            keccak256(abi.encode("evidence", jobId)),
            RecourseTypes.RouteHint.Optimistic
        );
    }

    function testConstructorRejectsZeroAddresses() public {
        vm.expectRevert(OptimisticPath.ZeroAddress.selector);
        new OptimisticPath(address(0), address(claims), usdc);

        vm.expectRevert(OptimisticPath.ZeroAddress.selector);
        new OptimisticPath(address(oracle), address(0), usdc);

        vm.expectRevert(OptimisticPath.ZeroAddress.selector);
        new OptimisticPath(address(oracle), address(claims), MockUSDC(address(0)));
    }

    function testAssertRejectsUnknownArbitratedExpiredAndUnbondedClaims() public {
        bytes32 unknownClaimId = keccak256("unknown-claim");
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.UnknownClaim.selector, unknownClaimId));
        optimistic.assertResidualLoss(unknownClaimId, contractId, "", USDC_ONE);

        bytes32 arbitratedClaimId = _submitArbitrated(keccak256("arbitrated-assertion"), 100 * USDC_ONE);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.NotOptimistic.selector, arbitratedClaimId));
        optimistic.assertResidualLoss(arbitratedClaimId, contractId, "", USDC_ONE);

        bytes32 mismatchedClaimId = _submitOptimistic(keccak256("mismatched-contract"), 100 * USDC_ONE);
        bytes32 wrongContractId = keccak256("wrong-contract");
        vm.expectRevert(
            abi.encodeWithSelector(CLAIM_CONTRACT_MISMATCH_SELECTOR, mismatchedClaimId, contractId, wrongContractId)
        );
        optimistic.assertResidualLoss(mismatchedClaimId, wrongContractId, "", USDC_ONE);

        bytes32 expiredClaimId = _submitOptimistic(keccak256("expired-assertion"), 100 * USDC_ONE);
        vm.warp(block.timestamp + 21601);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.LivenessExpired.selector, expiredClaimId));
        optimistic.assertResidualLoss(expiredClaimId, contractId, "", USDC_ONE);

        bytes32 unbondedClaimId = _submitOptimistic(keccak256("unbonded-assertion"), 100 * USDC_ONE);
        vm.expectRevert(ZERO_AMOUNT_SELECTOR);
        optimistic.assertResidualLoss(unbondedClaimId, contractId, "", 0);
    }

    function testOracleCallbacksRejectUnauthorizedAndUnknownAssertions() public {
        bytes32 assertionId = keccak256("unknown-assertion");

        vm.expectRevert(abi.encodeWithSelector(OptimisticPath.NotOracle.selector, address(this), address(oracle)));
        optimistic.assertionResolvedCallback(assertionId, true);

        vm.prank(address(oracle));
        vm.expectRevert(abi.encodeWithSelector(OptimisticPath.UnknownAssertion.selector, assertionId));
        optimistic.assertionResolvedCallback(assertionId, true);

        vm.prank(address(oracle));
        vm.expectRevert(abi.encodeWithSelector(OptimisticPath.UnknownAssertion.selector, assertionId));
        optimistic.assertionDisputedCallback(assertionId);
    }

    function testPriceSettledFinalizesClaim() public {
        bytes32 jobId = keccak256("optimistic-settle");
        bytes32 claimId = _submitOptimistic(jobId, 100 * USDC_ONE);

        bytes32 assertionId =
            optimistic.assertResidualLoss(claimId, contractId, abi.encode(jobId, uint256(100 * USDC_ONE)), USDC_ONE);

        assertEq(usdc.balanceOf(address(oracle)), USDC_ONE);
        assertEq(usdc.allowance(address(optimistic), address(oracle)), 0);
        vm.warp(block.timestamp + 21601);
        oracle.settle(assertionId);

        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.Paid));
        assertEq(usdc.balanceOf(CLAIMANT), 100 * USDC_ONE);
        assertEq(optimistic.claimByAssertion(assertionId), bytes32(0));
    }

    function testAssertUsesOracleSupportedDefaultIdentifier() public {
        bytes32 jobId = keccak256("optimistic-default-identifier");
        bytes32 claimId = _submitOptimistic(jobId, 100 * USDC_ONE);

        optimistic.assertResidualLoss(claimId, contractId, abi.encode(jobId), USDC_ONE);

        assertEq(oracle.lastIdentifier(), oracle.DEFAULT_IDENTIFIER());
    }

    function testAssertUsesRemainingLivenessForShortContractWindow() public {
        RecourseTypes.RecourseContract memory k =
            _recourseContract(OPERATOR, address(usdc), ARBITRATOR, 1_000 * USDC_ONE, 1_000 * USDC_ONE);
        k.deadlines.livenessSeconds = 60;
        vm.prank(OPERATOR);
        bytes32 shortContractId = registry.register(k);
        usdc.mint(OPERATOR, 1_000 * USDC_ONE);
        vm.startPrank(OPERATOR);
        usdc.approve(address(vault), 1_000 * USDC_ONE);
        vault.postBond(shortContractId, 1_000 * USDC_ONE);

        bytes32 jobId = keccak256("short-liveness");
        claims.commitReceipts(
            shortContractId,
            jobId,
            _effectCommit(jobId, RecourseTypes.Provenance.L1),
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1)
        );
        vm.stopPrank();
        bytes32 claimId = _submitClaim(
            claims,
            shortContractId,
            jobId,
            100 * USDC_ONE,
            keccak256(abi.encode("evidence", jobId)),
            RecourseTypes.RouteHint.Optimistic
        );

        bytes32 assertionId = optimistic.assertResidualLoss(claimId, shortContractId, "", USDC_ONE);
        (,,, uint64 liveness) = oracle.assertions(assertionId);

        assertEq(liveness, 60);
    }

    function testRejectsDuplicateAssertionsForClaim() public {
        bytes32 jobId = keccak256("duplicate-assertion");
        bytes32 claimId = _submitOptimistic(jobId, 100 * USDC_ONE);
        bytes32 assertionId = optimistic.assertResidualLoss(claimId, contractId, abi.encode(jobId), USDC_ONE);

        vm.expectRevert(abi.encodeWithSelector(OptimisticPath.ClaimAlreadyAsserted.selector, claimId, assertionId));
        optimistic.assertResidualLoss(claimId, contractId, abi.encode(jobId, "second"), USDC_ONE);
    }

    function testFinalizeExpiredClaimRequiresOracleAssertion() public {
        bytes32 jobId = keccak256("no-assertion-finalize");
        bytes32 claimId = _submitOptimistic(jobId, 100 * USDC_ONE);

        vm.warp(block.timestamp + 21601);
        vm.expectRevert(abi.encodeWithSelector(OptimisticPath.ClaimNotAsserted.selector, claimId));
        optimistic.finalizeExpiredClaim(claimId);
    }

    function testFinalizeExpiredAssertedClaimAfterLiveness() public {
        bytes32 jobId = keccak256("asserted-finalize");
        bytes32 claimId = _submitOptimistic(jobId, 100 * USDC_ONE);

        bytes32 assertionId = optimistic.assertResidualLoss(claimId, contractId, abi.encode(jobId), USDC_ONE);
        assertEq(optimistic.assertionByClaim(claimId), assertionId);

        vm.warp(block.timestamp + 21601);
        optimistic.finalizeExpiredClaim(claimId);

        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.Paid));
        assertEq(usdc.balanceOf(CLAIMANT), 100 * USDC_ONE);
        assertEq(optimistic.assertionByClaim(claimId), bytes32(0));
    }

    function testFinalizeExpiredClaimCannotBypassOracleFalseResolution() public {
        bytes32 jobId = keccak256("asserted-finalize-false");
        bytes32 claimId = _submitOptimistic(jobId, 100 * USDC_ONE);

        optimistic.assertResidualLoss(claimId, contractId, abi.encode(jobId), USDC_ONE);
        oracle.setSettleTruthfully(false);
        vm.warp(block.timestamp + 21601);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.LivenessExpired.selector, claimId));
        optimistic.finalizeExpiredClaim(claimId);

        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.Submitted));
        assertEq(usdc.balanceOf(CLAIMANT), 0);
    }

    function testFalseResolutionRoutesToArbitration() public {
        bytes32 jobId = keccak256("optimistic-false-resolution");
        bytes32 claimId = _submitOptimistic(jobId, 100 * USDC_ONE);

        bytes32 assertionId =
            optimistic.assertResidualLoss(claimId, contractId, abi.encode(jobId, uint256(100 * USDC_ONE)), USDC_ONE);
        vm.prank(address(oracle));
        optimistic.assertionResolvedCallback(assertionId, false);

        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.InArbitration));
        assertEq(optimistic.claimByAssertion(assertionId), bytes32(0));
    }

    function testPriceDisputedRoutesToArbitration() public {
        bytes32 jobId = keccak256("optimistic-dispute");
        bytes32 claimId = _submitOptimistic(jobId, 100 * USDC_ONE);

        bytes32 assertionId =
            optimistic.assertResidualLoss(claimId, contractId, abi.encode(jobId, uint256(100 * USDC_ONE)), USDC_ONE);
        oracle.dispute(assertionId);

        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.InArbitration));
        assertEq(optimistic.claimByAssertion(assertionId), claimId);
        assertTrue(optimistic.assertionDisputed(assertionId));

        oracle.settle(assertionId);

        assertEq(optimistic.claimByAssertion(assertionId), bytes32(0));
        assertFalse(optimistic.assertionDisputed(assertionId));
        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.InArbitration));
    }
}
