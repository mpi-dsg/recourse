// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {RecourseRegistry} from "../src/RecourseRegistry.sol";
import {BondVault} from "../src/BondVault.sol";
import {ClaimRegistry, ArbitrationOutcome, ClaimState} from "../src/ClaimRegistry.sol";
import {RecourseTypes} from "../src/Types.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {RecourseTestFixtures} from "./mocks/RecourseTestFixtures.sol";

library ClaimStateTransition {
    function isMonotone(ClaimState beforeState, ClaimState afterState) internal pure returns (bool) {
        if (_terminal(beforeState)) return afterState == beforeState;
        return _rank(afterState) >= _rank(beforeState);
    }

    function _terminal(ClaimState state) private pure returns (bool) {
        return state == ClaimState.Paid || state == ClaimState.Rejected || state == ClaimState.DefaultPayout;
    }

    function _rank(ClaimState state) private pure returns (uint8) {
        if (state == ClaimState.None) return 0;
        if (state == ClaimState.Submitted) return 1;
        if (state == ClaimState.InArbitration) return 2;
        return 3;
    }
}

/// @title Stateful invariants for the Recourse contract suite.
/// @notice Three invariants from the paper's Threats section:
///         1. BondVault locked exposure is always covered by deposits and
///            never negative.
///         2. Claim state transitions only move forward through the
///            lifecycle (Submitted/InArbitration → Paid/Rejected/Default),
///            never resurrect from a terminal state.
///         3. Per-claim payout never exceeds the κ's `payoutRule.maxPayout`.
contract RecourseInvariantHandler is RecourseTestFixtures {
    RecourseRegistry public registry;
    BondVault public vault;
    ClaimRegistry public claims;
    MockUSDC public usdc;

    bytes32 public contractId;
    uint256 public maxPayout;
    uint256 public deposited;

    // Track claim ids encountered so invariants can sweep them.
    bytes32[] public claimIds;
    mapping(bytes32 => bool) public seen;
    mapping(bytes32 => ClaimState) public lastState;
    bool public monotonicityViolated;

    // Bookkeeping for invariant_bondCovers.
    uint256 public totalDeposited;

    constructor(
        RecourseRegistry registry_,
        BondVault vault_,
        ClaimRegistry claims_,
        MockUSDC usdc_,
        bytes32 contractId_,
        uint256 maxPayout_,
        uint256 deposited_
    ) {
        registry = registry_;
        vault = vault_;
        claims = claims_;
        usdc = usdc_;
        contractId = contractId_;
        maxPayout = maxPayout_;
        deposited = deposited_;
        totalDeposited = deposited_;
    }

    function _recordNewClaim(bytes32 claimId) internal {
        if (!seen[claimId]) {
            seen[claimId] = true;
            claimIds.push(claimId);
        }
        lastState[claimId] = claims.stateOf(claimId);
    }

    function _recordTransition(bytes32 claimId, ClaimState beforeState) internal {
        ClaimState afterState = claims.stateOf(claimId);
        if (!ClaimStateTransition.isMonotone(beforeState, afterState)) {
            monotonicityViolated = true;
        }
        lastState[claimId] = afterState;
    }

    function claimsCount() external view returns (uint256) {
        return claimIds.length;
    }

    function getClaimId(uint256 i) external view returns (bytes32) {
        return claimIds[i];
    }

    /// @dev Fuzz-callable: commit receipts and submit an optimistic claim.
    function commitAndSubmitOptimistic(uint64 seed, uint256 amountSeed) external {
        bytes32 jobId = keccak256(abi.encode("inv-opt", seed));
        if (claims.getReceiptRecord(contractId, jobId).effectReceiptHash != bytes32(0)) {
            return;
        }
        vm.prank(OPERATOR);
        try claims.commitReceipts(
            contractId,
            jobId,
            _effectCommit(jobId, RecourseTypes.Provenance.L1),
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1)
        ) {} catch {
            return;
        }

        uint256 amount = bound(amountSeed, 1, maxPayout);
        try this.submitOptimistic(jobId, amount) returns (bytes32 claimId) {
            _recordNewClaim(claimId);
        } catch {}
    }

    function commitAndSubmitArbitrated(uint64 seed, uint256 amountSeed) external {
        bytes32 jobId = keccak256(abi.encode("inv-arb", seed));
        if (claims.getReceiptRecord(contractId, jobId).effectReceiptHash != bytes32(0)) {
            return;
        }
        vm.prank(OPERATOR);
        try claims.commitReceipts(
            contractId,
            jobId,
            _effectCommit(jobId, RecourseTypes.Provenance.L2),
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Failure, RecourseTypes.Provenance.L2)
        ) {} catch {
            return;
        }
        uint256 amount = bound(amountSeed, 1, maxPayout);
        try this.submitArbitrated(jobId, amount) returns (bytes32 claimId) {
            _recordNewClaim(claimId);
        } catch {}
    }

    /// @dev External so try/catch works; submits a claim under either route.
    function submitOptimistic(bytes32 jobId, uint256 amount) external returns (bytes32 claimId) {
        require(msg.sender == address(this), "self-only");
        return _submitClaim(
            claims,
            contractId,
            jobId,
            amount,
            keccak256(abi.encode("evidence", jobId)),
            RecourseTypes.RouteHint.Optimistic
        );
    }

    function submitArbitrated(bytes32 jobId, uint256 amount) external returns (bytes32 claimId) {
        require(msg.sender == address(this), "self-only");
        return _submitClaim(
            claims,
            contractId,
            jobId,
            amount,
            keccak256(abi.encode("evidence", jobId)),
            RecourseTypes.RouteHint.Arbitrated
        );
    }

    function finalizeOptimistic(uint256 idx) external {
        if (claimIds.length == 0) return;
        bytes32 claimId = claimIds[idx % claimIds.length];
        ClaimRegistry.ClaimRecord memory rec = claims.getClaim(claimId);
        if (rec.state != ClaimState.Submitted) return;
        if (block.timestamp <= rec.livenessDeadline) {
            vm.warp(rec.livenessDeadline + 1);
        }
        ClaimState beforeState = rec.state;
        vm.prank(address(this));
        try claims.finalizeOptimistic(claimId) {
            _recordTransition(claimId, beforeState);
        } catch {}
    }

    function disputeClaim(uint256 idx) external {
        if (claimIds.length == 0) return;
        bytes32 claimId = claimIds[idx % claimIds.length];
        ClaimRegistry.ClaimRecord memory rec = claims.getClaim(claimId);
        if (rec.state != ClaimState.Submitted) return;
        ClaimState beforeState = rec.state;
        vm.prank(address(this));
        try claims.dispute(claimId) {
            _recordTransition(claimId, beforeState);
        } catch {}
    }

    function arbitrate(uint256 idx, uint8 outcomeSeed) external {
        if (claimIds.length == 0) return;
        bytes32 claimId = claimIds[idx % claimIds.length];
        ClaimRegistry.ClaimRecord memory rec = claims.getClaim(claimId);
        if (rec.state != ClaimState.InArbitration) return;
        ArbitrationOutcome outcome = ArbitrationOutcome(outcomeSeed % 3);
        ClaimState beforeState = rec.state;
        vm.prank(rec.arbitrator);
        try claims.applyArbitration(claimId, outcome) {
            _recordTransition(claimId, beforeState);
        } catch {}
    }

    function topUpBond(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, 10 * USDC_ONE);
        usdc.mint(OPERATOR, amount);
        vm.startPrank(OPERATOR);
        usdc.approve(address(vault), amount);
        try vault.postBond(contractId, amount) {
            totalDeposited += amount;
        } catch {}
        vm.stopPrank();
    }
}

contract RecourseInvariantTest is StdInvariant, Test, RecourseTestFixtures {
    RecourseRegistry internal registry;
    BondVault internal vault;
    ClaimRegistry internal claims;
    MockUSDC internal usdc;
    RecourseInvariantHandler internal handler;
    bytes32 internal contractId;
    uint256 internal constant MAX_PAYOUT = 200 * USDC_ONE;
    uint256 internal constant INITIAL_DEPOSIT = 1_000 * USDC_ONE;

    function setUp() public {
        registry = new RecourseRegistry();
        usdc = new MockUSDC();
        vault = new BondVault(usdc, registry);
        claims = new ClaimRegistry(registry, vault);
        vault.setClaimRegistry(address(claims));

        RecourseTypes.RecourseContract memory k =
            _recourseContract(OPERATOR, address(usdc), ARBITRATOR, MAX_PAYOUT, INITIAL_DEPOSIT);
        // Bond.maxAggregateExposure must be >= maxPayout; bond.minAmount must be > 0.
        k.bond.maxAggregateExposure = INITIAL_DEPOSIT;
        k.bond.minAmount = INITIAL_DEPOSIT;

        vm.prank(OPERATOR);
        contractId = registry.register(k);

        usdc.mint(OPERATOR, INITIAL_DEPOSIT);
        vm.startPrank(OPERATOR);
        usdc.approve(address(vault), INITIAL_DEPOSIT);
        vault.postBond(contractId, INITIAL_DEPOSIT);
        vm.stopPrank();

        handler = new RecourseInvariantHandler(registry, vault, claims, usdc, contractId, MAX_PAYOUT, INITIAL_DEPOSIT);
        // The handler acts as the optimistic-path proxy so it can finalize/dispute.
        claims.setOptimisticPath(address(handler));

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = RecourseInvariantHandler.commitAndSubmitOptimistic.selector;
        selectors[1] = RecourseInvariantHandler.commitAndSubmitArbitrated.selector;
        selectors[2] = RecourseInvariantHandler.finalizeOptimistic.selector;
        selectors[3] = RecourseInvariantHandler.disputeClaim.selector;
        selectors[4] = RecourseInvariantHandler.arbitrate.selector;
        selectors[5] = RecourseInvariantHandler.topUpBond.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice BondVault locked balance never exceeds total deposits and
    ///         token balance is exactly the locked figure.
    function invariant_bondCovers() public view {
        uint256 locked = vault.lockedByContract(contractId);
        uint256 open = vault.openExposureByContract(contractId);
        // Open exposure cannot exceed locked collateral.
        assertLe(open, locked, "open exposure exceeds locked collateral");
        // Locked cannot exceed total ever deposited (since deposits only grow).
        assertLe(locked, handler.totalDeposited(), "locked exceeds total deposited");
        // Vault token balance equals the unpaid locked balance.
        assertEq(usdc.balanceOf(address(vault)), locked, "vault balance != locked");
    }

    /// @notice Claim state transitions never move backwards. Terminal
    ///         states (Paid, Rejected, DefaultPayout) are absorbing.
    function invariant_claimMonotone() public view {
        assertFalse(handler.monotonicityViolated(), "handler observed a regressive claim transition");
        uint256 n = handler.claimsCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 claimId = handler.getClaimId(i);
            ClaimState recorded = handler.lastState(claimId);
            ClaimState current = claims.stateOf(claimId);
            assertTrue(ClaimStateTransition.isMonotone(recorded, current), "claim state moved backwards");
        }
    }

    function test_regressiveModelFailsMonotonicityPredicate() public pure {
        assertFalse(ClaimStateTransition.isMonotone(ClaimState.Paid, ClaimState.Submitted));
        assertFalse(ClaimStateTransition.isMonotone(ClaimState.Rejected, ClaimState.DefaultPayout));
        assertTrue(ClaimStateTransition.isMonotone(ClaimState.Submitted, ClaimState.InArbitration));
        assertTrue(ClaimStateTransition.isMonotone(ClaimState.InArbitration, ClaimState.Paid));
    }

    /// @notice Per-claim reserved amount and payouts never exceed the
    ///         registered `maxPayout`.
    function invariant_payoutCap() public view {
        uint256 n = handler.claimsCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 claimId = handler.getClaimId(i);
            ClaimRegistry.ClaimRecord memory rec = claims.getClaim(claimId);
            assertLe(rec.amount, MAX_PAYOUT, "claim amount exceeds maxPayout");
            assertLe(vault.reservedByClaim(claimId), MAX_PAYOUT, "reservation exceeds maxPayout");
        }
    }
}
