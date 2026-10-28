// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {RecourseRegistry} from "./RecourseRegistry.sol";
import {RecourseTypes} from "./Types.sol";

/// @title Neutral collateral custody for Recourse contracts.
/// @notice Holds ERC-20 collateral per κ and lets only the ClaimRegistry
///         reserve, release, or pay open claim exposure.
contract BondVault {
    using SafeERC20 for IERC20;

    event BondPosted(bytes32 indexed contractId, address indexed from, uint256 amount);
    event IdleWithdrawn(bytes32 indexed contractId, address indexed operator, uint256 amount);
    event ExposureReserved(bytes32 indexed contractId, bytes32 indexed claimId, uint256 amount);
    event ExposureReleased(bytes32 indexed contractId, bytes32 indexed claimId, uint256 amount);
    event PaidOut(bytes32 indexed contractId, bytes32 indexed claimId, address indexed to, uint256 amount);
    event ClaimRegistrySet(address indexed claimRegistry);

    error ZeroAddress();
    error ZeroAmount();
    error NotOwner(address caller, address owner);
    error ClaimRegistryAlreadySet(address current);
    error NotClaimRegistry(address caller, address expected);
    error NotOperator(address caller, address operator);
    error ContractNotAdmissible(bytes32 contractId);
    error InvalidAsset(bytes32 contractId, address expected, address actual);
    error CollateralBelowMinimum(bytes32 contractId, uint256 required, uint256 locked);
    error InsufficientLocked(bytes32 contractId, uint256 required, uint256 locked);
    error ExposureExceedsAggregateCap(bytes32 contractId, uint256 required, uint256 cap);
    error InsufficientIdle(bytes32 contractId, uint256 requested, uint256 idle);
    error ClaimAlreadyReserved(bytes32 claimId);
    error UnknownReservation(bytes32 claimId);
    error PayoutExceedsReservation(bytes32 claimId, uint256 requested, uint256 reserved);

    IERC20 public immutable ASSET;
    RecourseRegistry public immutable REGISTRY;
    address public immutable OWNER;
    address public claimRegistry;

    mapping(bytes32 => uint256) public lockedByContract;
    mapping(bytes32 => uint256) public openExposureByContract;
    mapping(bytes32 => uint256) public reservedByClaim;

    mapping(bytes32 => bytes32) private _contractByClaim;

    constructor(IERC20 asset_, RecourseRegistry registry_) {
        if (address(asset_) == address(0) || address(registry_) == address(0)) revert ZeroAddress();
        ASSET = asset_;
        REGISTRY = registry_;
        OWNER = msg.sender;
    }

    function setClaimRegistry(address claimRegistry_) external {
        if (msg.sender != OWNER) revert NotOwner(msg.sender, OWNER);
        if (claimRegistry_ == address(0)) revert ZeroAddress();
        if (claimRegistry != address(0)) revert ClaimRegistryAlreadySet(claimRegistry);
        claimRegistry = claimRegistry_;
        emit ClaimRegistrySet(claimRegistry_);
    }

    function postBond(bytes32 contractId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        RecourseTypes.RecourseContract memory k = REGISTRY.get(contractId);
        if (!REGISTRY.isAdmissible(contractId)) revert ContractNotAdmissible(contractId);
        if (msg.sender != k.operator) revert NotOperator(msg.sender, k.operator);
        if (k.bond.asset != address(ASSET)) revert InvalidAsset(contractId, k.bond.asset, address(ASSET));

        lockedByContract[contractId] += amount;
        ASSET.safeTransferFrom(msg.sender, address(this), amount);
        emit BondPosted(contractId, msg.sender, amount);
    }

    function withdrawIdle(bytes32 contractId, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        RecourseTypes.RecourseContract memory k = REGISTRY.get(contractId);
        if (msg.sender != k.operator) revert NotOperator(msg.sender, k.operator);

        uint256 locked = lockedByContract[contractId];
        uint256 open = openExposureByContract[contractId];
        uint256 minimum = REGISTRY.isAdmissible(contractId) ? k.bond.minAmount : 0;
        uint256 collateralFloor = open > minimum ? open : minimum;
        uint256 idle = locked > collateralFloor ? locked - collateralFloor : 0;
        if (amount > idle) revert InsufficientIdle(contractId, amount, idle);

        lockedByContract[contractId] -= amount;
        ASSET.safeTransfer(k.operator, amount);
        emit IdleWithdrawn(contractId, k.operator, amount);
    }

    function reserveExposure(bytes32 contractId, bytes32 claimId, uint256 amount) external onlyClaimRegistry {
        if (reservedByClaim[claimId] != 0) revert ClaimAlreadyReserved(claimId);
        RecourseTypes.RecourseContract memory k = REGISTRY.get(contractId);
        uint256 newOpen = openExposureByContract[contractId] + amount;
        if (newOpen > k.bond.maxAggregateExposure) {
            revert ExposureExceedsAggregateCap(contractId, newOpen, k.bond.maxAggregateExposure);
        }
        uint256 locked = lockedByContract[contractId];
        if (locked < k.bond.minAmount) {
            revert CollateralBelowMinimum(contractId, k.bond.minAmount, locked);
        }
        if (newOpen > locked) revert InsufficientLocked(contractId, newOpen, locked);

        openExposureByContract[contractId] = newOpen;
        reservedByClaim[claimId] = amount;
        _contractByClaim[claimId] = contractId;
        emit ExposureReserved(contractId, claimId, amount);
    }

    /// @notice Whether the current collateral can admit one additional action
    ///         at the registered worst-case payout `Pmax`.
    /// @dev Runtime admission should require this predicate immediately before
    ///      executing an action. Claim reservations still account for the
    ///      realized amount once a claim is submitted.
    function canAdmitAction(bytes32 contractId) external view returns (bool) {
        RecourseTypes.RecourseContract memory k = REGISTRY.get(contractId);
        if (!REGISTRY.isAdmissible(contractId) || k.bond.asset != address(ASSET)) return false;

        uint256 locked = lockedByContract[contractId];
        if (locked < k.bond.minAmount) return false;

        uint256 open = openExposureByContract[contractId];
        uint256 maxPayout = k.payoutRule.maxPayout;
        if (maxPayout > type(uint256).max - open) return false;
        uint256 required = open + maxPayout;
        return required <= locked && required <= k.bond.maxAggregateExposure;
    }

    function releaseExposure(bytes32 contractId, bytes32 claimId) external onlyClaimRegistry {
        _release(contractId, claimId);
    }

    function payout(bytes32 contractId, bytes32 claimId, address to, uint256 amount) external onlyClaimRegistry {
        if (to == address(0)) revert ZeroAddress();
        uint256 reserved = reservedByClaim[claimId];
        if (_contractByClaim[claimId] != contractId) revert UnknownReservation(claimId);
        if (amount > reserved) revert PayoutExceedsReservation(claimId, amount, reserved);

        _clearReservation(contractId, claimId, reserved);
        lockedByContract[contractId] -= amount;
        ASSET.safeTransfer(to, amount);
        emit PaidOut(contractId, claimId, to, amount);
    }

    function _release(bytes32 contractId, bytes32 claimId) internal {
        uint256 reserved = reservedByClaim[claimId];
        if (_contractByClaim[claimId] != contractId) revert UnknownReservation(claimId);
        _clearReservation(contractId, claimId, reserved);
        emit ExposureReleased(contractId, claimId, reserved);
    }

    function _clearReservation(bytes32 contractId, bytes32 claimId, uint256 reserved) internal {
        openExposureByContract[contractId] -= reserved;
        delete reservedByClaim[claimId];
        delete _contractByClaim[claimId];
    }

    modifier onlyClaimRegistry() {
        if (msg.sender != claimRegistry) revert NotClaimRegistry(msg.sender, claimRegistry);
        _;
    }
}
