// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RecourseRegistry} from "../src/RecourseRegistry.sol";
import {BondVault} from "../src/BondVault.sol";
import {ClaimRegistry, ClaimState} from "../src/ClaimRegistry.sol";
import {OptimisticPath} from "../src/OptimisticPath.sol";
import {ArbitrablePath} from "../src/ArbitrablePath.sol";
import {Eip712Recourse} from "../src/Eip712Recourse.sol";
import {RecourseTypes} from "../src/Types.sol";
import {MockArbitrator} from "./mocks/MockArbitrator.sol";
import {MockOptimisticOracleV3} from "./mocks/MockOptimisticOracleV3.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {RecourseTestFixtures} from "./mocks/RecourseTestFixtures.sol";

contract E2ETest is Test, RecourseTestFixtures {
    RecourseRegistry internal registry;
    MockUSDC internal usdc;
    BondVault internal vault;
    ClaimRegistry internal claims;
    MockOptimisticOracleV3 internal oracle;
    MockArbitrator internal arbitrator;
    OptimisticPath internal optimistic;
    ArbitrablePath internal arbitrable;
    bytes32 internal contractId;

    function setUp() public {
        registry = new RecourseRegistry();
        usdc = new MockUSDC();
        vault = new BondVault(usdc, registry);
        claims = new ClaimRegistry(registry, vault);
        vault.setClaimRegistry(address(claims));
        oracle = new MockOptimisticOracleV3();
        arbitrator = new MockArbitrator(0.01 ether);
        optimistic = new OptimisticPath(address(oracle), address(claims), usdc);
        claims.setOptimisticPath(address(optimistic));
        arbitrable = new ArbitrablePath(address(arbitrator), address(claims), bytes("recourse-arbitration-v1"));

        RecourseTypes.RecourseContract memory k =
            _recourseContract(OPERATOR, address(usdc), address(arbitrable), 1_000 * USDC_ONE, 1_000 * USDC_ONE);
        bytes32 expectedContractId = Eip712Recourse.recourseContractStructHash(k);
        vm.prank(OPERATOR);
        vm.expectEmit(true, true, false, false, address(registry));
        emit RecourseRegistry.ContractRegistered(expectedContractId, OPERATOR);
        contractId = registry.register(k);

        usdc.mint(OPERATOR, 1_000 * USDC_ONE);
        usdc.mint(address(this), 10 * USDC_ONE);
        usdc.approve(address(optimistic), type(uint256).max);

        vm.startPrank(OPERATOR);
        usdc.approve(address(vault), 1_000 * USDC_ONE);
        vault.postBond(contractId, 1_000 * USDC_ONE);
        vm.stopPrank();
    }

    function testFullOptimisticPathPaysClaimant() public {
        bytes32 jobId = keccak256("postgres-delete-job-001");
        uint256 payout = 640 * USDC_ONE;
        bytes32 evidenceHash = keccak256("QmRecoursePostgresClaim");
        ClaimRegistry.EffectReceiptCommit memory effect = _effectCommit(jobId, RecourseTypes.Provenance.L1);
        effect.evidenceHash = evidenceHash;
        vm.prank(OPERATOR);
        claims.commitReceipts(
            contractId,
            jobId,
            effect,
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1)
        );

        bytes32 claimId =
            _submitClaim(claims, contractId, jobId, payout, evidenceHash, RecourseTypes.RouteHint.Optimistic);

        bytes32 assertionId = optimistic.assertResidualLoss(
            claimId, contractId, abi.encode(jobId, payout, keccak256("QmRecoursePostgresClaim")), USDC_ONE
        );

        vm.expectEmit(true, true, true, true, address(claims));
        emit ClaimRegistry.ClaimFinalized(claimId, ClaimState.Paid, CLAIMANT, payout);
        vm.warp(block.timestamp + 21601);
        oracle.settle(assertionId);

        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.Paid));
        assertEq(usdc.balanceOf(CLAIMANT), payout);
        assertEq(vault.lockedByContract(contractId), 360 * USDC_ONE);
    }

    function testDisputedOptimisticClaimEscalatesAndPaysByArbitration() public {
        bytes32 jobId = keccak256("postgres-delete-job-disputed");
        uint256 payout = 120 * USDC_ONE;
        bytes32 evidenceHash = keccak256("QmRecourseDisputedClaim");
        ClaimRegistry.EffectReceiptCommit memory effect = _effectCommit(jobId, RecourseTypes.Provenance.L1);
        effect.evidenceHash = evidenceHash;
        vm.prank(OPERATOR);
        claims.commitReceipts(
            contractId,
            jobId,
            effect,
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1)
        );
        bytes32 claimId =
            _submitClaim(claims, contractId, jobId, payout, evidenceHash, RecourseTypes.RouteHint.Optimistic);

        bytes32 assertionId = optimistic.assertResidualLoss(
            claimId, contractId, abi.encode(jobId, payout, keccak256("QmRecourseDisputedClaim")), USDC_ONE
        );
        oracle.dispute(assertionId);
        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.InArbitration));

        uint256 disputeId = arbitrable.escalate{value: 0.01 ether}(claimId);
        arbitrator.giveRuling(disputeId, 1);

        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.Paid));
        assertEq(usdc.balanceOf(CLAIMANT), payout);
    }
}
