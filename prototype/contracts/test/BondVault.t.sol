// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {RecourseRegistry} from "../src/RecourseRegistry.sol";
import {BondVault} from "../src/BondVault.sol";
import {RecourseTypes} from "../src/Types.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {RecourseTestFixtures} from "./mocks/RecourseTestFixtures.sol";

contract BondVaultTest is Test, RecourseTestFixtures {
    bytes4 internal constant COLLATERAL_BELOW_MINIMUM_SELECTOR =
        bytes4(keccak256("CollateralBelowMinimum(bytes32,uint256,uint256)"));

    RecourseRegistry internal registry;
    BondVault internal vault;
    MockUSDC internal usdc;
    bytes32 internal contractId;
    address internal claimRegistry = address(0xC1A1);

    function setUp() public {
        registry = new RecourseRegistry();
        usdc = new MockUSDC();
        vault = new BondVault(usdc, registry);
        vault.setClaimRegistry(claimRegistry);

        RecourseTypes.RecourseContract memory k =
            _recourseContract(OPERATOR, address(usdc), ARBITRATOR, 100 * USDC_ONE, 100 * USDC_ONE);
        k.bond.maxAggregateExposure = 1_000 * USDC_ONE;
        vm.prank(OPERATOR);
        contractId = registry.register(k);
    }

    function _post(uint256 amount) internal {
        usdc.mint(OPERATOR, amount);
        vm.startPrank(OPERATOR);
        usdc.approve(address(vault), amount);
        vault.postBond(contractId, amount);
        vm.stopPrank();
    }

    function testConstructorAndClaimRegistrySetGuards() public {
        vm.expectRevert(BondVault.ZeroAddress.selector);
        new BondVault(MockUSDC(address(0)), registry);

        vm.expectRevert(BondVault.ZeroAddress.selector);
        new BondVault(usdc, RecourseRegistry(address(0)));

        BondVault fresh = new BondVault(usdc, registry);
        vm.prank(CLAIMANT);
        vm.expectRevert(abi.encodeWithSelector(BondVault.NotOwner.selector, CLAIMANT, address(this)));
        fresh.setClaimRegistry(claimRegistry);

        vm.expectRevert(BondVault.ZeroAddress.selector);
        fresh.setClaimRegistry(address(0));

        fresh.setClaimRegistry(claimRegistry);
        vm.expectRevert(abi.encodeWithSelector(BondVault.ClaimRegistryAlreadySet.selector, claimRegistry));
        fresh.setClaimRegistry(address(0xBEEF));
    }

    function testPostBondPullsTokens() public {
        uint256 amount = 750 * USDC_ONE;
        usdc.mint(OPERATOR, amount);

        vm.startPrank(OPERATOR);
        usdc.approve(address(vault), amount);
        vm.expectEmit(true, true, false, true, address(vault));
        emit BondVault.BondPosted(contractId, OPERATOR, amount);
        vault.postBond(contractId, amount);
        vm.stopPrank();

        assertEq(vault.lockedByContract(contractId), amount);
        assertEq(usdc.balanceOf(address(vault)), amount);
        assertEq(usdc.balanceOf(OPERATOR), 0);
    }

    function testPostBondRejectsZeroAmountAndWrongAsset() public {
        vm.expectRevert(BondVault.ZeroAmount.selector);
        vault.postBond(contractId, 0);

        usdc.mint(CLAIMANT, 1);
        vm.startPrank(CLAIMANT);
        usdc.approve(address(vault), 1);
        vm.expectRevert(abi.encodeWithSelector(BondVault.NotOperator.selector, CLAIMANT, OPERATOR));
        vault.postBond(contractId, 1);
        vm.stopPrank();

        MockUSDC other = new MockUSDC();
        RecourseTypes.RecourseContract memory k =
            _recourseContract(OPERATOR, address(other), ARBITRATOR, 100 * USDC_ONE, 100 * USDC_ONE);
        vm.prank(OPERATOR);
        bytes32 wrongAssetId = registry.register(k);

        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(BondVault.InvalidAsset.selector, wrongAssetId, address(other), address(usdc))
        );
        vault.postBond(wrongAssetId, 1);

        vm.prank(OPERATOR);
        registry.revoke(contractId);
        usdc.mint(OPERATOR, 1);
        vm.startPrank(OPERATOR);
        usdc.approve(address(vault), 1);
        vm.expectRevert(abi.encodeWithSelector(BondVault.ContractNotAdmissible.selector, contractId));
        vault.postBond(contractId, 1);
        vm.stopPrank();
    }

    function testReserveExceedsLockedReverts() public {
        _post(100 * USDC_ONE);
        bytes32 claimId = keccak256("claim");

        vm.prank(claimRegistry);
        vm.expectRevert(
            abi.encodeWithSelector(BondVault.InsufficientLocked.selector, contractId, 101 * USDC_ONE, 100 * USDC_ONE)
        );
        vault.reserveExposure(contractId, claimId, 101 * USDC_ONE);
    }

    function testReserveRejectsCollateralBelowRegisteredMinimum() public {
        bytes32 underfundedId;
        RecourseTypes.RecourseContract memory k =
            _recourseContract(OPERATOR, address(usdc), ARBITRATOR, 100 * USDC_ONE, 100 * USDC_ONE);
        vm.prank(OPERATOR);
        underfundedId = registry.register(k);

        usdc.mint(OPERATOR, 50 * USDC_ONE);
        vm.startPrank(OPERATOR);
        usdc.approve(address(vault), 50 * USDC_ONE);
        vault.postBond(underfundedId, 50 * USDC_ONE);
        vm.stopPrank();

        vm.prank(claimRegistry);
        vm.expectRevert(
            abi.encodeWithSelector(COLLATERAL_BELOW_MINIMUM_SELECTOR, underfundedId, 100 * USDC_ONE, 50 * USDC_ONE)
        );
        vault.reserveExposure(underfundedId, keccak256("underfunded-minimum"), 10 * USDC_ONE);
    }

    function testActionAdmissionRequiresOpenExposurePlusMaxPayoutCapacity() public {
        _post(150 * USDC_ONE);

        (bool availableOk, bytes memory availableResult) =
            address(vault).staticcall(abi.encodeWithSignature("canAdmitAction(bytes32)", contractId));
        assertTrue(availableOk, "canAdmitAction view is missing");
        assertTrue(abi.decode(availableResult, (bool)), "fresh capacity should admit one max-payout action");

        vm.prank(claimRegistry);
        vault.reserveExposure(contractId, keccak256("existing-claim"), 60 * USDC_ONE);

        (bool exhaustedOk, bytes memory exhaustedResult) =
            address(vault).staticcall(abi.encodeWithSignature("canAdmitAction(bytes32)", contractId));
        assertTrue(exhaustedOk, "canAdmitAction view reverted");
        assertFalse(abi.decode(exhaustedResult, (bool)), "open exposure plus Pmax exceeds locked collateral");
    }

    function testReserveExposureOnlyClaimRegistryAndNoDuplicateReservations() public {
        _post(100 * USDC_ONE);
        bytes32 claimId = keccak256("claim");

        vm.expectRevert(abi.encodeWithSelector(BondVault.NotClaimRegistry.selector, address(this), claimRegistry));
        vault.reserveExposure(contractId, claimId, 10 * USDC_ONE);

        vm.startPrank(claimRegistry);
        vault.reserveExposure(contractId, claimId, 10 * USDC_ONE);
        vm.expectRevert(abi.encodeWithSelector(BondVault.ClaimAlreadyReserved.selector, claimId));
        vault.reserveExposure(contractId, claimId, 1);
        vm.stopPrank();
    }

    function testReserveExceedsAggregateCapRevertsEvenWhenLocked() public {
        bytes32 cappedId;
        RecourseTypes.RecourseContract memory k =
            _recourseContract(OPERATOR, address(usdc), ARBITRATOR, 100 * USDC_ONE, 100 * USDC_ONE);
        vm.prank(OPERATOR);
        cappedId = registry.register(k);

        usdc.mint(OPERATOR, 200 * USDC_ONE);
        vm.startPrank(OPERATOR);
        usdc.approve(address(vault), 200 * USDC_ONE);
        vault.postBond(cappedId, 200 * USDC_ONE);
        vm.stopPrank();

        vm.prank(claimRegistry);
        vm.expectRevert(
            abi.encodeWithSelector(
                BondVault.ExposureExceedsAggregateCap.selector, cappedId, 101 * USDC_ONE, 100 * USDC_ONE
            )
        );
        vault.reserveExposure(cappedId, keccak256("over-cap-claim"), 101 * USDC_ONE);
    }

    function testWithdrawWhileExposureLockedReverts() public {
        _post(120 * USDC_ONE);
        bytes32 claimId = keccak256("claim");

        vm.prank(claimRegistry);
        vault.reserveExposure(contractId, claimId, 80 * USDC_ONE);

        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(BondVault.InsufficientIdle.selector, contractId, 21 * USDC_ONE, 20 * USDC_ONE)
        );
        vault.withdrawIdle(contractId, 21 * USDC_ONE);

        vm.prank(OPERATOR);
        vault.withdrawIdle(contractId, 20 * USDC_ONE);
        assertEq(vault.lockedByContract(contractId), 100 * USDC_ONE);
    }

    function testWithdrawPreservesRegisteredMinimumCollateral() public {
        _post(150 * USDC_ONE);

        vm.prank(OPERATOR);
        vm.expectRevert(
            abi.encodeWithSelector(BondVault.InsufficientIdle.selector, contractId, 51 * USDC_ONE, 50 * USDC_ONE)
        );
        vault.withdrawIdle(contractId, 51 * USDC_ONE);

        vm.prank(OPERATOR);
        vault.withdrawIdle(contractId, 50 * USDC_ONE);
        assertEq(vault.lockedByContract(contractId), 100 * USDC_ONE);
    }

    function testRevokedContractCanWithdrawMinimumWhenNoExposureRemains() public {
        _post(100 * USDC_ONE);
        vm.prank(OPERATOR);
        registry.revoke(contractId);

        vm.prank(OPERATOR);
        vault.withdrawIdle(contractId, 100 * USDC_ONE);

        assertEq(vault.lockedByContract(contractId), 0);
    }

    function testWithdrawRejectsZeroAndNonOperator() public {
        _post(110 * USDC_ONE);

        vm.prank(OPERATOR);
        vm.expectRevert(BondVault.ZeroAmount.selector);
        vault.withdrawIdle(contractId, 0);

        vm.prank(CLAIMANT);
        vm.expectRevert(abi.encodeWithSelector(BondVault.NotOperator.selector, CLAIMANT, OPERATOR));
        vault.withdrawIdle(contractId, 1);

        vm.prank(OPERATOR);
        vm.expectEmit(true, true, false, true, address(vault));
        emit BondVault.IdleWithdrawn(contractId, OPERATOR, 10 * USDC_ONE);
        vault.withdrawIdle(contractId, 10 * USDC_ONE);
    }

    function testReleaseExposureOnlyClaimRegistryAndUnknownReservation() public {
        _post(100 * USDC_ONE);
        bytes32 claimId = keccak256("claim");

        vm.expectRevert(abi.encodeWithSelector(BondVault.NotClaimRegistry.selector, address(this), claimRegistry));
        vault.releaseExposure(contractId, claimId);

        vm.prank(claimRegistry);
        vm.expectRevert(abi.encodeWithSelector(BondVault.UnknownReservation.selector, claimId));
        vault.releaseExposure(contractId, claimId);

        vm.startPrank(claimRegistry);
        vault.reserveExposure(contractId, claimId, 30 * USDC_ONE);
        vm.expectEmit(true, true, false, true, address(vault));
        emit BondVault.ExposureReleased(contractId, claimId, 30 * USDC_ONE);
        vault.releaseExposure(contractId, claimId);
        vm.stopPrank();

        assertEq(vault.openExposureByContract(contractId), 0);
        assertEq(vault.reservedByClaim(claimId), 0);
    }

    function testPayoutOnlyByClaimRegistry() public {
        _post(100 * USDC_ONE);
        bytes32 claimId = keccak256("claim");

        vm.prank(claimRegistry);
        vault.reserveExposure(contractId, claimId, 60 * USDC_ONE);

        vm.expectRevert(abi.encodeWithSelector(BondVault.NotClaimRegistry.selector, address(this), claimRegistry));
        vault.payout(contractId, claimId, CLAIMANT, 60 * USDC_ONE);
    }

    function testPayoutRejectsZeroRecipientUnknownReservationAndOverpay() public {
        _post(100 * USDC_ONE);
        bytes32 claimId = keccak256("claim");

        vm.startPrank(claimRegistry);
        vault.reserveExposure(contractId, claimId, 40 * USDC_ONE);

        vm.expectRevert(BondVault.ZeroAddress.selector);
        vault.payout(contractId, claimId, address(0), 1);

        vm.expectRevert(abi.encodeWithSelector(BondVault.UnknownReservation.selector, claimId));
        vault.payout(keccak256("wrong-contract"), claimId, CLAIMANT, 1);

        vm.expectRevert(
            abi.encodeWithSelector(BondVault.PayoutExceedsReservation.selector, claimId, 41 * USDC_ONE, 40 * USDC_ONE)
        );
        vault.payout(contractId, claimId, CLAIMANT, 41 * USDC_ONE);
        vm.stopPrank();
    }

    function testPayoutDecreasesLocked() public {
        _post(100 * USDC_ONE);
        bytes32 claimId = keccak256("claim");

        vm.startPrank(claimRegistry);
        vault.reserveExposure(contractId, claimId, 60 * USDC_ONE);
        vm.expectEmit(true, true, true, true, address(vault));
        emit BondVault.PaidOut(contractId, claimId, CLAIMANT, 60 * USDC_ONE);
        vault.payout(contractId, claimId, CLAIMANT, 60 * USDC_ONE);
        vm.stopPrank();

        assertEq(vault.lockedByContract(contractId), 40 * USDC_ONE);
        assertEq(vault.openExposureByContract(contractId), 0);
        assertEq(vault.reservedByClaim(claimId), 0);
        assertEq(usdc.balanceOf(CLAIMANT), 60 * USDC_ONE);
    }

    function testFuzzReserveExposureTracksOpen(uint96 lockedRaw, uint96 amountRaw) public {
        uint256 locked = bound(uint256(lockedRaw), 100 * USDC_ONE, 1_000 * USDC_ONE);
        uint256 amount = bound(uint256(amountRaw), 0, locked);
        _post(locked);

        bytes32 claimId = keccak256(abi.encode("claim", amount));
        vm.prank(claimRegistry);
        vault.reserveExposure(contractId, claimId, amount);

        assertEq(vault.openExposureByContract(contractId), amount);
        assertEq(vault.reservedByClaim(claimId), amount);
        assertLe(vault.openExposureByContract(contractId), vault.lockedByContract(contractId));
    }
}
