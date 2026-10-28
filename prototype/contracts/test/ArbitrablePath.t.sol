// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RecourseRegistry} from "../src/RecourseRegistry.sol";
import {BondVault} from "../src/BondVault.sol";
import {ClaimRegistry, ClaimRoute, ClaimState} from "../src/ClaimRegistry.sol";
import {ArbitrablePath} from "../src/ArbitrablePath.sol";
import {RecourseTypes} from "../src/Types.sol";
import {MockArbitrator} from "./mocks/MockArbitrator.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {RecourseTestFixtures} from "./mocks/RecourseTestFixtures.sol";

contract ArbitrablePathTest is Test, RecourseTestFixtures {
    bytes4 internal constant NOT_ARBITRATED_SELECTOR = bytes4(keccak256("NotArbitrated(bytes32)"));

    RecourseRegistry internal registry;
    BondVault internal vault;
    ClaimRegistry internal claims;
    ArbitrablePath internal arbitrable;
    MockArbitrator internal arbitrator;
    MockUSDC internal usdc;
    bytes32 internal contractId;

    receive() external payable {}

    function setUp() public {
        registry = new RecourseRegistry();
        usdc = new MockUSDC();
        vault = new BondVault(usdc, registry);
        claims = new ClaimRegistry(registry, vault);
        vault.setClaimRegistry(address(claims));
        arbitrator = new MockArbitrator(0.01 ether);
        arbitrable = new ArbitrablePath(address(arbitrator), address(claims), bytes("recourse-arbitration-v1"));

        RecourseTypes.RecourseContract memory k =
            _recourseContract(OPERATOR, address(usdc), address(arbitrable), 1_000 * USDC_ONE, 1_000 * USDC_ONE);
        vm.prank(OPERATOR);
        contractId = registry.register(k);
        usdc.mint(OPERATOR, 1_000 * USDC_ONE);
        vm.startPrank(OPERATOR);
        usdc.approve(address(vault), 1_000 * USDC_ONE);
        vault.postBond(contractId, 1_000 * USDC_ONE);
        vm.stopPrank();
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
        assertEq(uint8(claims.routeOf(claimId)), uint8(ClaimRoute.Optimistic));
    }

    function testConstructorRejectsZeroAddresses() public {
        vm.expectRevert(ArbitrablePath.ZeroAddress.selector);
        new ArbitrablePath(address(0), address(claims), "");

        vm.expectRevert(ArbitrablePath.ZeroAddress.selector);
        new ArbitrablePath(address(arbitrator), address(0), "");
    }

    function testEscalateCreatesDisputeAndStoresMapping() public {
        bytes32 claimId = _submitArbitrated(keccak256("escalate"), 100 * USDC_ONE);

        uint256 disputeId = arbitrable.escalate{value: 0.01 ether}(claimId);

        assertEq(disputeId, 1);
        assertEq(arbitrable.claimByDispute(disputeId), claimId);
        assertEq(arbitrable.disputeByClaim(claimId), disputeId);
    }

    function testEscalateRefundsOverpaymentAndRejectsDuplicate() public {
        bytes32 claimId = _submitArbitrated(keccak256("escalate-refund"), 100 * USDC_ONE);
        vm.deal(address(this), 1 ether);
        uint256 balanceBefore = address(this).balance;

        uint256 disputeId = arbitrable.escalate{value: 0.02 ether}(claimId);

        assertEq(address(this).balance, balanceBefore - 0.01 ether);
        vm.expectRevert(abi.encodeWithSelector(ArbitrablePath.AlreadyEscalated.selector, claimId, disputeId));
        arbitrable.escalate{value: 0.01 ether}(claimId);
    }

    function testEscalateRejectsDuplicateWhenDisputeIdIsZero() public {
        bytes32 claimId = _submitArbitrated(keccak256("zero-dispute-id"), 100 * USDC_ONE);
        arbitrator.setNextDisputeId(0);

        uint256 disputeId = arbitrable.escalate{value: 0.01 ether}(claimId);

        assertEq(disputeId, 0);
        assertEq(arbitrable.claimByDispute(disputeId), claimId);
        assertEq(arbitrable.disputeByClaim(claimId), disputeId);
        assertTrue(arbitrable.claimEscalated(claimId));
        vm.expectRevert(abi.encodeWithSelector(ArbitrablePath.AlreadyEscalated.selector, claimId, disputeId));
        arbitrable.escalate{value: 0.01 ether}(claimId);

        arbitrator.giveRuling(disputeId, 1);
        assertFalse(arbitrable.claimEscalated(claimId));
    }

    function testEscalateRejectsUnknownAndNonArbitratedClaims() public {
        bytes32 unknownClaimId = keccak256("unknown-claim");
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.UnknownClaim.selector, unknownClaimId));
        arbitrable.escalate{value: 0.01 ether}(unknownClaimId);

        bytes32 optimisticClaimId = _submitOptimistic(keccak256("optimistic-claim"), 100 * USDC_ONE);
        vm.expectRevert(abi.encodeWithSelector(NOT_ARBITRATED_SELECTOR, optimisticClaimId));
        arbitrable.escalate{value: 0.01 ether}(optimisticClaimId);

        assertEq(arbitrator.nextDisputeId(), 1);
    }

    function testEscalateRevertsWhenFeeIsUnderfunded() public {
        bytes32 claimId = _submitArbitrated(keccak256("underfunded-escalate"), 100 * USDC_ONE);

        vm.expectRevert(abi.encodeWithSelector(ArbitrablePath.InsufficientArbitrationFee.selector, 0.01 ether, 0));
        arbitrable.escalate(claimId);
    }

    function testRuleRejectsNonArbitratorAndUnknownRuling() public {
        bytes32 claimId = _submitArbitrated(keccak256("rule-guards"), 100 * USDC_ONE);
        uint256 disputeId = arbitrable.escalate{value: 0.01 ether}(claimId);

        vm.expectRevert(
            abi.encodeWithSelector(ArbitrablePath.NotArbitrator.selector, address(this), address(arbitrator))
        );
        arbitrable.rule(disputeId, 1);

        vm.expectRevert(abi.encodeWithSelector(ArbitrablePath.UnknownRuling.selector, 4));
        arbitrator.giveRuling(disputeId, 4);
    }

    function testRulingZeroAppliesDefaultPayout() public {
        bytes32 claimId = _submitArbitrated(keccak256("rule-zero-default"), 100 * USDC_ONE);
        uint256 disputeId = arbitrable.escalate{value: 0.01 ether}(claimId);

        arbitrator.giveRuling(disputeId, 0);

        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.DefaultPayout));
        assertEq(usdc.balanceOf(CLAIMANT), 100 * USDC_ONE);
    }

    function testRulingFinalizesClaim() public {
        bytes32 claimId = _submitArbitrated(keccak256("rule"), 100 * USDC_ONE);
        uint256 disputeId = arbitrable.escalate{value: 0.01 ether}(claimId);

        arbitrator.giveRuling(disputeId, 1);

        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.Paid));
        assertEq(usdc.balanceOf(CLAIMANT), 100 * USDC_ONE);
        assertEq(arbitrable.claimByDispute(disputeId), bytes32(0));
        assertEq(arbitrable.disputeByClaim(claimId), 0);

        vm.expectRevert(abi.encodeWithSelector(ArbitrablePath.UnknownDispute.selector, disputeId));
        arbitrator.giveRuling(disputeId, 1);
    }

    function testEvidenceEventEmitted() public {
        string memory evidence = "ipfs://recourse/evidence.json";
        uint256 evidenceGroupId = 1001;

        vm.expectEmit(true, true, true, true, address(arbitrable));
        emit ArbitrablePath.Evidence(address(arbitrator), evidenceGroupId, CLAIMANT, evidence);
        vm.prank(CLAIMANT);
        arbitrable.submitEvidence(evidenceGroupId, evidence);
    }
}
