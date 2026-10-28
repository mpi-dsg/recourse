// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RecourseRegistry} from "../src/RecourseRegistry.sol";
import {BondVault} from "../src/BondVault.sol";
import {ClaimRegistry, ArbitrationOutcome, ClaimRoute, ClaimState} from "../src/ClaimRegistry.sol";
import {Eip712Recourse} from "../src/Eip712Recourse.sol";
import {RecourseTypes} from "../src/Types.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {RecourseTestFixtures} from "./mocks/RecourseTestFixtures.sol";

contract ClaimRegistryTest is Test, RecourseTestFixtures {
    bytes4 internal constant EFFECT_TIMESTAMP_IN_FUTURE_SELECTOR =
        bytes4(keccak256("EffectTimestampInFuture(bytes32,bytes32,uint64)"));
    bytes4 internal constant INVALID_RECOVERY_RECEIPT_SELECTOR =
        bytes4(keccak256("InvalidRecoveryReceipt(bytes32,bytes32)"));
    bytes4 internal constant ZERO_EVIDENCE_CID_SELECTOR = bytes4(keccak256("ZeroEvidenceCid()"));
    bytes4 internal constant ZERO_EVIDENCE_HASH_SELECTOR = bytes4(keccak256("ZeroEvidenceHash()"));
    bytes4 internal constant RECOVERY_DEADLINE_EXPIRED_SELECTOR =
        bytes4(keccak256("RecoveryDeadlineExpired(bytes32,bytes32,uint256,uint64)"));
    bytes4 internal constant CLAIM_EVIDENCE_MISMATCH_SELECTOR =
        bytes4(keccak256("ClaimEvidenceMismatch(bytes32,bytes32,bytes32,bytes32)"));

    RecourseRegistry internal registry;
    BondVault internal vault;
    ClaimRegistry internal claims;
    MockUSDC internal usdc;
    bytes32 internal contractId;

    function setUp() public {
        registry = new RecourseRegistry();
        usdc = new MockUSDC();
        vault = new BondVault(usdc, registry);
        claims = new ClaimRegistry(registry, vault);
        vault.setClaimRegistry(address(claims));
        claims.setOptimisticPath(address(this));
        contractId = _registerAndPost(1_000 * USDC_ONE, 1_000 * USDC_ONE, ARBITRATOR);
    }

    function _registerAndPost(uint256 maxPayout, uint256 posted, address arbitrator) internal returns (bytes32 id) {
        RecourseTypes.RecourseContract memory k =
            _recourseContract(OPERATOR, address(usdc), arbitrator, maxPayout, maxPayout);
        vm.prank(OPERATOR);
        id = registry.register(k);
        usdc.mint(OPERATOR, posted);
        vm.startPrank(OPERATOR);
        usdc.approve(address(vault), posted);
        vault.postBond(id, posted);
        vm.stopPrank();
    }

    function _commitStrong(bytes32 id, bytes32 jobId) internal {
        vm.prank(OPERATOR);
        claims.commitReceipts(
            id,
            jobId,
            _effectCommit(jobId, RecourseTypes.Provenance.L1),
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1)
        );
    }

    function _submit(bytes32 id, bytes32 jobId, uint256 amount) internal returns (bytes32 claimId) {
        claimId = _submitClaim(
            claims, id, jobId, amount, keccak256(abi.encode("evidence", jobId)), RecourseTypes.RouteHint.Optimistic
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
        claimId = _submit(contractId, jobId, amount);
    }

    function testConstructorAndOptimisticPathSetGuards() public {
        vm.expectRevert(ClaimRegistry.ZeroAddress.selector);
        new ClaimRegistry(RecourseRegistry(address(0)), vault);

        vm.expectRevert(ClaimRegistry.ZeroAddress.selector);
        new ClaimRegistry(registry, BondVault(address(0)));

        ClaimRegistry fresh = new ClaimRegistry(registry, vault);
        vm.prank(CLAIMANT);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.NotOwner.selector, CLAIMANT, address(this)));
        fresh.setOptimisticPath(address(0xBEEF));

        vm.expectRevert(ClaimRegistry.ZeroAddress.selector);
        fresh.setOptimisticPath(address(0));

        fresh.setOptimisticPath(address(0xBEEF));
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.OptimisticPathAlreadySet.selector, address(0xBEEF)));
        fresh.setOptimisticPath(address(0xCAFE));
    }

    function testSubmitWithoutRecoveryAfterDeadlineRoutesArbitration() public {
        bytes32 jobId = keccak256("job-no-recovery");
        vm.prank(OPERATOR);
        claims.commitReceipts(
            contractId, jobId, _effectCommit(jobId, RecourseTypes.Provenance.L1), _missingRecoveryCommit()
        );

        vm.warp(block.timestamp + 1801);
        bytes32 claimId = _submit(contractId, jobId, 100 * USDC_ONE);

        assertEq(uint8(claims.routeOf(claimId)), uint8(ClaimRoute.Arbitrated));
        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.InArbitration));
    }

    function testSubmitWithStrongEvidenceRoutesOptimistic() public {
        bytes32 jobId = keccak256("job-strong");
        _commitStrong(contractId, jobId);

        bytes32 claimId = _submit(contractId, jobId, 100 * USDC_ONE);

        assertEq(uint8(claims.routeOf(claimId)), uint8(ClaimRoute.Optimistic));
        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.Submitted));
        assertEq(claims.livenessDeadlineOf(claimId), block.timestamp + 21600);
    }

    function testSubmitWithArbitratedRouteHintOverridesStrongEvidence() public {
        bytes32 jobId = keccak256("job-route-hint-arbitrated");
        _commitStrong(contractId, jobId);

        bytes32 claimId = _submitClaim(
            claims,
            contractId,
            jobId,
            100 * USDC_ONE,
            keccak256(abi.encode("evidence", jobId)),
            RecourseTypes.RouteHint.Arbitrated
        );

        assertEq(uint8(claims.routeOf(claimId)), uint8(ClaimRoute.Arbitrated));
        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.InArbitration));
    }

    function testCommitReceiptsOnlyOperator() public {
        bytes32 jobId = keccak256("job-unauthorized-commit");

        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.NotReceiptCommitter.selector, address(this), OPERATOR));
        claims.commitReceipts(
            contractId,
            jobId,
            _effectCommit(jobId, RecourseTypes.Provenance.L1),
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1)
        );
    }

    function testCommitReceiptsRejectsRevokedContract() public {
        bytes32 jobId = keccak256("job-revoked-contract");
        vm.prank(OPERATOR);
        registry.revoke(contractId);

        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.ContractNotAdmissible.selector, contractId));
        claims.commitReceipts(
            contractId,
            jobId,
            _effectCommit(jobId, RecourseTypes.Provenance.L1),
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1)
        );
    }

    function testCommitReceiptsRejectsSchemaMismatchAndOverwrite() public {
        bytes32 jobId = keccak256("job-schema-mismatch");
        ClaimRegistry.EffectReceiptCommit memory effect = _effectCommit(jobId, RecourseTypes.Provenance.L1);
        ClaimRegistry.RecoveryReceiptCommit memory recovery =
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1);
        effect.schemaVersion = 2;

        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.SchemaVersionMismatch.selector, 1, 2));
        claims.commitReceipts(contractId, jobId, effect, recovery);

        effect.schemaVersion = 1;
        vm.prank(OPERATOR);
        claims.commitReceipts(contractId, jobId, effect, recovery);

        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.ReceiptAlreadyCommitted.selector, contractId, jobId));
        claims.commitReceipts(contractId, jobId, effect, recovery);
    }

    function testCommitReceiptsRejectsMalformedReceiptMetadata() public {
        bytes32 futureJob = keccak256("job-future-effect");
        ClaimRegistry.EffectReceiptCommit memory futureEffect = _effectCommit(futureJob, RecourseTypes.Provenance.L1);
        futureEffect.timestamp = uint64(block.timestamp + 1);

        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(EFFECT_TIMESTAMP_IN_FUTURE_SELECTOR, contractId, futureJob, futureEffect.timestamp)
        );
        claims.commitReceipts(
            contractId,
            futureJob,
            futureEffect,
            _recoveryCommit(futureJob, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1)
        );

        bytes32 zeroEvidenceJob = keccak256("job-zero-effect-evidence");
        ClaimRegistry.EffectReceiptCommit memory zeroEvidenceEffect =
            _effectCommit(zeroEvidenceJob, RecourseTypes.Provenance.L1);
        zeroEvidenceEffect.evidenceHash = bytes32(0);

        vm.prank(OPERATOR);
        vm.expectRevert(ZERO_EVIDENCE_HASH_SELECTOR);
        claims.commitReceipts(
            contractId,
            zeroEvidenceJob,
            zeroEvidenceEffect,
            _recoveryCommit(zeroEvidenceJob, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1)
        );

        bytes32 staleRecoveryJob = keccak256("job-stale-recovery");
        ClaimRegistry.RecoveryReceiptCommit memory staleRecovery =
            _recoveryCommit(staleRecoveryJob, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1);
        staleRecovery.recoveryEndTs = uint64(block.timestamp - 1);

        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(INVALID_RECOVERY_RECEIPT_SELECTOR, contractId, staleRecoveryJob));
        claims.commitReceipts(
            contractId, staleRecoveryJob, _effectCommit(staleRecoveryJob, RecourseTypes.Provenance.L1), staleRecovery
        );

        bytes32 futureRecoveryJob = keccak256("job-future-recovery");
        ClaimRegistry.RecoveryReceiptCommit memory futureRecovery =
            _recoveryCommit(futureRecoveryJob, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1);
        futureRecovery.recoveryEndTs = uint64(block.timestamp + 1);

        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(INVALID_RECOVERY_RECEIPT_SELECTOR, contractId, futureRecoveryJob));
        claims.commitReceipts(
            contractId, futureRecoveryJob, _effectCommit(futureRecoveryJob, RecourseTypes.Provenance.L1), futureRecovery
        );
    }

    function testCommitReceiptsRejectsRecoveryAfterContractDeadline() public {
        bytes32 jobId = keccak256("job-late-recovery");
        ClaimRegistry.EffectReceiptCommit memory effect = _effectCommit(jobId, RecourseTypes.Provenance.L1);
        uint256 deadline = uint256(effect.timestamp) + 1800;
        vm.warp(deadline + 1);
        ClaimRegistry.RecoveryReceiptCommit memory recovery =
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1);

        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(
                RECOVERY_DEADLINE_EXPIRED_SELECTOR, contractId, jobId, deadline, recovery.recoveryEndTs
            )
        );
        claims.commitReceipts(contractId, jobId, effect, recovery);
    }

    function testSubmitRejectsZeroAmount() public {
        bytes32 jobId = keccak256("job-zero-amount");
        _commitStrong(contractId, jobId);

        (RecourseTypes.Claim memory claim, bytes memory signature) = _signedClaim(
            claims, contractId, jobId, 0, keccak256(abi.encode("evidence", jobId)), RecourseTypes.RouteHint.Optimistic
        );
        vm.expectRevert(ClaimRegistry.ZeroAmount.selector);
        claims.submitClaim(claim, signature);
    }

    function testSubmitRejectsZeroEvidenceCid() public {
        bytes32 jobId = keccak256("job-zero-evidence-cid");
        _commitStrong(contractId, jobId);

        (RecourseTypes.Claim memory claim, bytes memory signature) =
            _signedClaim(claims, contractId, jobId, 100 * USDC_ONE, bytes32(0), RecourseTypes.RouteHint.Optimistic);
        vm.expectRevert(ZERO_EVIDENCE_CID_SELECTOR);
        claims.submitClaim(claim, signature);
    }

    function testSubmitRejectsInvalidSignatureAndReceiptMismatch() public {
        bytes32 jobId = keccak256("job-invalid-claim-signature");
        _commitStrong(contractId, jobId);

        (RecourseTypes.Claim memory claim, bytes memory signature) = _signedClaim(
            claims,
            contractId,
            jobId,
            100 * USDC_ONE,
            keccak256(abi.encode("evidence", jobId)),
            RecourseTypes.RouteHint.Optimistic
        );

        RecourseTypes.Claim memory forgedClaimant = claim;
        forgedClaimant.claimant = CHALLENGER;
        vm.expectRevert();
        claims.submitClaim(forgedClaimant, signature);

        (RecourseTypes.Claim memory mismatchedReceipt,) = _signedClaim(
            claims,
            contractId,
            jobId,
            100 * USDC_ONE,
            keccak256(abi.encode("evidence", jobId)),
            RecourseTypes.RouteHint.Optimistic
        );
        mismatchedReceipt.effectReceiptHash = keccak256("wrong-effect-receipt");
        bytes32 digest = Eip712Recourse.claimDigest(block.chainid, address(claims), mismatchedReceipt);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(CLAIMANT_KEY, digest);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.ClaimReceiptMismatch.selector, contractId, jobId));
        claims.submitClaim(mismatchedReceipt, abi.encodePacked(r, s, v));
    }

    function testSubmitRejectsEvidenceOutsideCommittedEffectBundle() public {
        bytes32 jobId = keccak256("job-mismatched-evidence");
        _commitStrong(contractId, jobId);
        ClaimRegistry.ReceiptRecord memory record = claims.getReceiptRecord(contractId, jobId);
        bytes32 uncommittedEvidence = keccak256("different-evidence-bundle");
        (RecourseTypes.Claim memory claim, bytes memory signature) = _signedClaim(
            claims, contractId, jobId, 100 * USDC_ONE, uncommittedEvidence, RecourseTypes.RouteHint.Optimistic
        );

        vm.expectRevert(
            abi.encodeWithSelector(
                CLAIM_EVIDENCE_MISMATCH_SELECTOR, contractId, jobId, record.effectEvidenceHash, uncommittedEvidence
            )
        );
        claims.submitClaim(claim, signature);
    }

    function testSubmitRejectsDuplicateReceiptClaim() public {
        bytes32 jobId = keccak256("job-duplicate-claim");
        _commitStrong(contractId, jobId);

        bytes32 firstClaimId = _submit(contractId, jobId, 100 * USDC_ONE);

        (RecourseTypes.Claim memory claim, bytes memory signature) = _signedClaim(
            claims,
            contractId,
            jobId,
            100 * USDC_ONE,
            keccak256(abi.encode("second", jobId)),
            RecourseTypes.RouteHint.Optimistic
        );
        vm.expectRevert(
            abi.encodeWithSelector(ClaimRegistry.ClaimAlreadySubmitted.selector, contractId, jobId, firstClaimId)
        );
        claims.submitClaim(claim, signature);
    }

    function testSubmitRejectsExpiredSubmissionWindow() public {
        bytes32 jobId = keccak256("job-expired-submission");
        _commitStrong(contractId, jobId);

        uint256 deadline = block.timestamp + 86400;
        vm.warp(deadline + 1);

        (RecourseTypes.Claim memory claim, bytes memory signature) = _signedClaim(
            claims,
            contractId,
            jobId,
            100 * USDC_ONE,
            keccak256(abi.encode("evidence", jobId)),
            RecourseTypes.RouteHint.Optimistic
        );
        vm.expectRevert(
            abi.encodeWithSelector(ClaimRegistry.SubmissionDeadlineExpired.selector, contractId, jobId, deadline)
        );
        claims.submitClaim(claim, signature);
    }

    function testSubmitWithLevel3EvidenceRoutesArbitration() public {
        bytes32 jobId = keccak256("job-weak");
        vm.prank(OPERATOR);
        claims.commitReceipts(
            contractId,
            jobId,
            _effectCommit(jobId, RecourseTypes.Provenance.L2),
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L2)
        );

        bytes32 claimId = _submit(contractId, jobId, 100 * USDC_ONE);

        assertEq(uint8(claims.routeOf(claimId)), uint8(ClaimRoute.Arbitrated));
        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.InArbitration));
    }

    function testMissingRecoveryDeadlineErrorIncludesReceiptIds() public {
        bytes32 jobId = keccak256("job-recovery-pending-ids");
        vm.prank(OPERATOR);
        claims.commitReceipts(
            contractId, jobId, _effectCommit(jobId, RecourseTypes.Provenance.L1), _missingRecoveryCommit()
        );

        uint256 readyAt = block.timestamp + 1800;
        (RecourseTypes.Claim memory claim, bytes memory signature) = _signedClaim(
            claims,
            contractId,
            jobId,
            100 * USDC_ONE,
            keccak256(abi.encode("evidence", jobId)),
            RecourseTypes.RouteHint.Optimistic
        );
        vm.expectRevert(
            abi.encodeWithSelector(ClaimRegistry.RecoveryDeadlinePending.selector, contractId, jobId, readyAt)
        );
        claims.submitClaim(claim, signature);
    }

    function testMissingRecoveryDeadlineUsesEffectTimestampNotCommitTime() public {
        bytes32 jobId = keccak256("job-delayed-commit-no-recovery");
        ClaimRegistry.EffectReceiptCommit memory effect = _effectCommit(jobId, RecourseTypes.Provenance.L1);
        uint256 readyAt = uint256(effect.timestamp) + 1800;
        vm.warp(block.timestamp + 1200);
        vm.prank(OPERATOR);
        claims.commitReceipts(contractId, jobId, effect, _missingRecoveryCommit());

        vm.warp(readyAt + 1);
        bytes32 claimId = _submit(contractId, jobId, 100 * USDC_ONE);

        assertEq(uint8(claims.routeOf(claimId)), uint8(ClaimRoute.Arbitrated));
    }

    function testFinalizeBeforeLivenessReverts() public {
        bytes32 jobId = keccak256("job-finalize-early");
        _commitStrong(contractId, jobId);
        bytes32 claimId = _submit(contractId, jobId, 100 * USDC_ONE);

        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.LivenessActive.selector, claimId));
        claims.finalizeOptimistic(claimId);
    }

    function testOptimisticStateChangesOnlyByOptimisticPath() public {
        bytes32 jobId = keccak256("job-optimistic-path-only");
        _commitStrong(contractId, jobId);
        bytes32 claimId = _submit(contractId, jobId, 100 * USDC_ONE);

        vm.prank(CHALLENGER);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.NotOptimisticPath.selector, CHALLENGER, address(this)));
        claims.dispute(claimId);

        vm.warp(block.timestamp + 21601);
        vm.prank(CHALLENGER);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.NotOptimisticPath.selector, CHALLENGER, address(this)));
        claims.finalizeOptimistic(claimId);
    }

    function testDisputeAfterLivenessReverts() public {
        bytes32 jobId = keccak256("job-dispute-late");
        _commitStrong(contractId, jobId);
        bytes32 claimId = _submit(contractId, jobId, 100 * USDC_ONE);

        vm.warp(block.timestamp + 21601);
        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.LivenessExpired.selector, claimId));
        claims.dispute(claimId);
    }

    function testOptimisticFinalizersRejectArbitratedClaims() public {
        bytes32 claimId = _submitArbitrated(keccak256("job-not-optimistic"), 100 * USDC_ONE);

        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.NotOptimistic.selector, claimId));
        claims.dispute(claimId);

        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.NotOptimistic.selector, claimId));
        claims.finalizeOptimistic(claimId);
    }

    function testPayoutCappedAtBondAndAtMaxPayout() public {
        bytes32 jobTooLarge = keccak256("job-too-large");
        _commitStrong(contractId, jobTooLarge);
        (RecourseTypes.Claim memory tooLargeClaim, bytes memory tooLargeSignature) = _signedClaim(
            claims,
            contractId,
            jobTooLarge,
            1_001 * USDC_ONE,
            keccak256("evidence-too-large"),
            RecourseTypes.RouteHint.Optimistic
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                ClaimRegistry.AmountExceedsMaxPayout.selector, contractId, 1_001 * USDC_ONE, 1_000 * USDC_ONE
            )
        );
        claims.submitClaim(tooLargeClaim, tooLargeSignature);

        bytes32 underfundedId =
            _registerAndPost(1_000 * USDC_ONE, 500 * USDC_ONE, address(0x000000000000000000000000000000000000d101));
        bytes32 jobUnderfunded = keccak256("job-underfunded");
        _commitStrong(underfundedId, jobUnderfunded);
        (RecourseTypes.Claim memory underfundedClaim, bytes memory underfundedSignature) = _signedClaim(
            claims,
            underfundedId,
            jobUnderfunded,
            600 * USDC_ONE,
            keccak256(abi.encode("evidence", jobUnderfunded)),
            RecourseTypes.RouteHint.Optimistic
        );
        vm.expectRevert(
            abi.encodeWithSelector(
                BondVault.CollateralBelowMinimum.selector, underfundedId, 1_000 * USDC_ONE, 500 * USDC_ONE
            )
        );
        claims.submitClaim(underfundedClaim, underfundedSignature);
    }

    function testApplyArbitrationOnlyByArbitrator() public {
        bytes32 claimId = _submitArbitrated(keccak256("job-arb"), 100 * USDC_ONE);

        vm.expectRevert(abi.encodeWithSelector(ClaimRegistry.NotArbitrator.selector, address(this), ARBITRATOR));
        claims.applyArbitration(claimId, ArbitrationOutcome.PayClaim);

        vm.prank(ARBITRATOR);
        claims.applyArbitration(claimId, ArbitrationOutcome.PayClaim);

        assertEq(uint8(claims.stateOf(claimId)), uint8(ClaimState.Paid));
        assertEq(usdc.balanceOf(CLAIMANT), 100 * USDC_ONE);
    }

    function testApplyArbitrationRejectAndDefaultPayoutOutcomes() public {
        bytes32 rejectedClaimId = _submitArbitrated(keccak256("job-arb-reject"), 100 * USDC_ONE);

        vm.prank(ARBITRATOR);
        claims.applyArbitration(rejectedClaimId, ArbitrationOutcome.Reject);

        assertEq(uint8(claims.stateOf(rejectedClaimId)), uint8(ClaimState.Rejected));
        assertEq(vault.openExposureByContract(contractId), 0);
        assertEq(vault.reservedByClaim(rejectedClaimId), 0);
        assertEq(usdc.balanceOf(CLAIMANT), 0);

        vm.prank(ARBITRATOR);
        vm.expectRevert(
            abi.encodeWithSelector(ClaimRegistry.InvalidClaimState.selector, rejectedClaimId, ClaimState.Rejected)
        );
        claims.applyArbitration(rejectedClaimId, ArbitrationOutcome.PayClaim);

        bytes32 defaultClaimId = _submitArbitrated(keccak256("job-arb-default"), 100 * USDC_ONE);
        vm.prank(ARBITRATOR);
        claims.applyArbitration(defaultClaimId, ArbitrationOutcome.DefaultPayout);

        assertEq(uint8(claims.stateOf(defaultClaimId)), uint8(ClaimState.DefaultPayout));
        assertEq(usdc.balanceOf(CLAIMANT), 100 * USDC_ONE);
    }
}
