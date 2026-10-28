// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IOptimisticOracleV3 {
    function defaultIdentifier() external view returns (bytes32);
    function settleAssertion(bytes32 assertionId) external;

    function assertTruth(
        bytes calldata claim,
        address asserter,
        address callbackRecipient,
        address escalationManager,
        uint64 liveness,
        IERC20 currency,
        uint256 bond,
        bytes32 identifier,
        bytes32 domainId
    ) external returns (bytes32 assertionId);
}

interface IClaimRegistryForOptimistic {
    function assertCanAssertOptimistic(bytes32 claimId, bytes32 contractId, uint64 assertionLivenessSeconds)
        external
        view;
    function livenessDeadlineOf(bytes32 claimId) external view returns (uint256);
    function finalizeOptimistic(bytes32 claimId) external;
    function dispute(bytes32 claimId) external;
}

/// @title UMA Optimistic Oracle V3 wrapper.
/// @notice Keeps the oracle dependency behind a narrow interface so tests can
///         use a deterministic mock with the same assert/callback shape.
contract OptimisticPath {
    using SafeERC20 for IERC20;

    event ResidualLossAsserted(
        bytes32 indexed assertionId,
        bytes32 indexed claimId,
        bytes32 indexed contractId,
        uint256 bond,
        bytes ancillaryData
    );

    error ZeroAddress();
    error ZeroAmount();
    error NotOracle(address caller, address oracle);
    error UnknownAssertion(bytes32 assertionId);
    error ClaimNotAsserted(bytes32 claimId);
    error ClaimAlreadyAsserted(bytes32 claimId, bytes32 assertionId);

    uint64 internal constant DEFAULT_LIVENESS_SECONDS = 7200;

    IOptimisticOracleV3 public immutable OPTIMISTIC_ORACLE;
    IClaimRegistryForOptimistic public immutable CLAIM_REGISTRY;
    IERC20 public immutable BOND_CURRENCY;
    bytes32 public immutable ASSERTION_IDENTIFIER;

    mapping(bytes32 => bytes32) public claimByAssertion;
    mapping(bytes32 => bytes32) public assertionByClaim;
    mapping(bytes32 => bool) public assertionDisputed;

    constructor(address optimisticOracle_, address claimRegistry_, IERC20 bondCurrency_) {
        if (optimisticOracle_ == address(0) || claimRegistry_ == address(0) || address(bondCurrency_) == address(0)) {
            revert ZeroAddress();
        }
        OPTIMISTIC_ORACLE = IOptimisticOracleV3(optimisticOracle_);
        CLAIM_REGISTRY = IClaimRegistryForOptimistic(claimRegistry_);
        BOND_CURRENCY = bondCurrency_;
        ASSERTION_IDENTIFIER = IOptimisticOracleV3(optimisticOracle_).defaultIdentifier();
    }

    function assertResidualLoss(bytes32 claimId, bytes32 contractId, bytes calldata ancillaryData, uint256 bond)
        external
        returns (bytes32 assertionId)
    {
        if (bond == 0) revert ZeroAmount();
        bytes32 existingAssertionId = assertionByClaim[claimId];
        if (existingAssertionId != bytes32(0)) {
            revert ClaimAlreadyAsserted(claimId, existingAssertionId);
        }
        uint64 liveness = _assertionLiveness(claimId, contractId);
        bytes memory assertion = abi.encode(contractId, claimId, ancillaryData);
        BOND_CURRENCY.safeTransferFrom(msg.sender, address(this), bond);
        BOND_CURRENCY.forceApprove(address(OPTIMISTIC_ORACLE), bond);
        assertionId = OPTIMISTIC_ORACLE.assertTruth(
            assertion,
            msg.sender,
            address(this),
            address(0),
            liveness,
            BOND_CURRENCY,
            bond,
            ASSERTION_IDENTIFIER,
            bytes32(0)
        );
        if (BOND_CURRENCY.allowance(address(this), address(OPTIMISTIC_ORACLE)) != 0) {
            BOND_CURRENCY.forceApprove(address(OPTIMISTIC_ORACLE), 0);
        }
        claimByAssertion[assertionId] = claimId;
        assertionByClaim[claimId] = assertionId;
        emit ResidualLossAsserted(assertionId, claimId, contractId, bond, ancillaryData);
    }

    function finalizeExpiredClaim(bytes32 claimId) external {
        bytes32 assertionId = assertionByClaim[claimId];
        if (assertionId == bytes32(0)) revert ClaimNotAsserted(claimId);
        OPTIMISTIC_ORACLE.settleAssertion(assertionId);
    }

    function assertionResolvedCallback(bytes32 assertionId, bool assertedTruthfully) external onlyOracle {
        bytes32 claimId = claimByAssertion[assertionId];
        if (claimId == bytes32(0)) revert UnknownAssertion(assertionId);
        delete claimByAssertion[assertionId];
        delete assertionByClaim[claimId];
        bool disputed = assertionDisputed[assertionId];
        delete assertionDisputed[assertionId];
        if (disputed) return;
        if (assertedTruthfully) {
            CLAIM_REGISTRY.finalizeOptimistic(claimId);
        } else {
            CLAIM_REGISTRY.dispute(claimId);
        }
    }

    function assertionDisputedCallback(bytes32 assertionId) external onlyOracle {
        bytes32 claimId = claimByAssertion[assertionId];
        if (claimId == bytes32(0)) revert UnknownAssertion(assertionId);
        assertionDisputed[assertionId] = true;
        CLAIM_REGISTRY.dispute(claimId);
    }

    function _assertionLiveness(bytes32 claimId, bytes32 contractId) internal view returns (uint64) {
        uint256 deadline = CLAIM_REGISTRY.livenessDeadlineOf(claimId);
        uint64 liveness = DEFAULT_LIVENESS_SECONDS;
        if (deadline <= block.timestamp) {
            CLAIM_REGISTRY.assertCanAssertOptimistic(claimId, contractId, 1);
            return 1;
        }

        uint256 remaining = deadline - block.timestamp;
        if (remaining < DEFAULT_LIVENESS_SECONDS) {
            liveness = uint64(remaining);
        }
        CLAIM_REGISTRY.assertCanAssertOptimistic(claimId, contractId, liveness);
        return liveness;
    }

    modifier onlyOracle() {
        if (msg.sender != address(OPTIMISTIC_ORACLE)) revert NotOracle(msg.sender, address(OPTIMISTIC_ORACLE));
        _;
    }
}
