// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RecourseRegistry} from "../src/RecourseRegistry.sol";
import {BondVault} from "../src/BondVault.sol";
import {ClaimRegistry, ClaimRoute} from "../src/ClaimRegistry.sol";
import {RecourseTypes} from "../src/Types.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {RecourseTestFixtures} from "./mocks/RecourseTestFixtures.sol";

/// @title Stateless fuzz tests for the Recourse contracts.
/// @notice These complement the stateful invariants by spraying random
///         inputs at individual entry points. The properties target the
///         two surfaces with the most boundary conditions:
///
///           * `submitClaim` accepts any signed Claim that satisfies the
///             registry's documented preconditions (positive amount,
///             valid receipts, within deadlines, ≤ maxPayout).
///           * `register` is idempotent for the same κ struct: repeated
///             registration must revert with `AlreadyRegistered` rather
///             than silently overwriting state or double-counting bonds.
contract RecourseFuzzTest is Test, RecourseTestFixtures {
    RecourseRegistry internal registry;
    BondVault internal vault;
    ClaimRegistry internal claims;
    MockUSDC internal usdc;
    bytes32 internal contractId;
    uint256 internal constant MAX_PAYOUT = 1_000 * USDC_ONE;
    uint256 internal constant DEPOSIT = 1_000 * USDC_ONE;

    function setUp() public {
        registry = new RecourseRegistry();
        usdc = new MockUSDC();
        vault = new BondVault(usdc, registry);
        claims = new ClaimRegistry(registry, vault);
        vault.setClaimRegistry(address(claims));
        claims.setOptimisticPath(address(this));

        RecourseTypes.RecourseContract memory k =
            _recourseContract(OPERATOR, address(usdc), ARBITRATOR, MAX_PAYOUT, DEPOSIT);
        k.bond.maxAggregateExposure = DEPOSIT;
        k.bond.minAmount = DEPOSIT;

        vm.prank(OPERATOR);
        contractId = registry.register(k);

        usdc.mint(OPERATOR, DEPOSIT);
        vm.startPrank(OPERATOR);
        usdc.approve(address(vault), DEPOSIT);
        vault.postBond(contractId, DEPOSIT);
        vm.stopPrank();
    }

    /// @notice For valid signed inputs, `submitClaim` must not revert.
    /// @dev `amountSeed` is bounded into a valid range; `jobSeed`
    ///      randomises the receipt key so each call is independent.
    function testFuzz_submitClaim_neverReverts(uint256 amountSeed, uint64 jobSeed) public {
        bytes32 jobId = keccak256(abi.encode("fuzz-job", jobSeed));
        uint256 amount = bound(amountSeed, 1, MAX_PAYOUT);

        vm.prank(OPERATOR);
        claims.commitReceipts(
            contractId,
            jobId,
            _effectCommit(jobId, RecourseTypes.Provenance.L1),
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1)
        );

        (RecourseTypes.Claim memory c, bytes memory sig) = _signedClaim(
            claims,
            contractId,
            jobId,
            amount,
            keccak256(abi.encode("evidence", jobId)),
            RecourseTypes.RouteHint.Optimistic
        );

        bytes32 claimId = claims.submitClaim(c, sig);
        assertTrue(claimId != bytes32(0), "claim id zero");
        assertEq(claims.getClaim(claimId).amount, amount);
        assertEq(uint8(claims.routeOf(claimId)), uint8(ClaimRoute.Optimistic));
    }

    /// @notice Amounts above maxPayout must revert with the documented error.
    function testFuzz_submitClaim_revertsAboveCap(uint256 over, uint64 jobSeed) public {
        bytes32 jobId = keccak256(abi.encode("cap-job", jobSeed));
        uint256 amount = MAX_PAYOUT + (over % (type(uint128).max - MAX_PAYOUT)) + 1;

        vm.prank(OPERATOR);
        claims.commitReceipts(
            contractId,
            jobId,
            _effectCommit(jobId, RecourseTypes.Provenance.L1),
            _recoveryCommit(jobId, RecourseTypes.RecoveryOutcome.Success, RecourseTypes.Provenance.L1)
        );
        (RecourseTypes.Claim memory c, bytes memory sig) = _signedClaim(
            claims,
            contractId,
            jobId,
            amount,
            keccak256(abi.encode("evidence", jobId)),
            RecourseTypes.RouteHint.Optimistic
        );
        vm.expectRevert(
            abi.encodeWithSelector(ClaimRegistry.AmountExceedsMaxPayout.selector, contractId, amount, MAX_PAYOUT)
        );
        claims.submitClaim(c, sig);
    }

    /// @notice Registering the same κ twice must revert with
    ///         `AlreadyRegistered` and leave the original record intact.
    function testFuzz_register_idempotent(uint64 maxPayoutSeed, uint64 livenessSeed) public {
        // Build a fresh κ in a parameter range that always satisfies the
        // registry's admission checks.
        uint256 maxPayout = bound(uint256(maxPayoutSeed), 1, type(uint128).max);
        uint64 liveness = uint64(bound(uint256(livenessSeed), 1, type(uint32).max));

        RecourseTypes.RecourseContract memory k =
            _recourseContract(OPERATOR, address(usdc), ARBITRATOR, maxPayout, maxPayout);
        k.bond.maxAggregateExposure = maxPayout;
        k.bond.minAmount = maxPayout;
        k.deadlines.livenessSeconds = liveness;

        // First registration succeeds.
        vm.prank(OPERATOR);
        bytes32 id = registry.register(k);
        assertTrue(registry.isAdmissible(id), "first register did not admit");
        RecourseTypes.RecourseContract memory stored = registry.get(id);
        assertEq(stored.operator, OPERATOR, "operator changed on first register");
        assertEq(stored.payoutRule.maxPayout, maxPayout, "maxPayout drifted");

        // Second registration with the same struct reverts.
        vm.prank(OPERATOR);
        vm.expectRevert(abi.encodeWithSelector(RecourseRegistry.AlreadyRegistered.selector, id));
        registry.register(k);

        // State is unchanged: still admissible and identical.
        assertTrue(registry.isAdmissible(id), "admissibility lost on duplicate register");
        RecourseTypes.RecourseContract memory after_ = registry.get(id);
        assertEq(after_.payoutRule.maxPayout, maxPayout, "maxPayout drifted after dup");
        assertEq(after_.deadlines.livenessSeconds, liveness, "liveness drifted after dup");
    }
}
