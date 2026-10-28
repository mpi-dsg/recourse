// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArbitrationOutcome} from "./ClaimRegistry.sol";

interface IArbitrator {
    function arbitrationCost(bytes calldata extraData) external view returns (uint256);
    function createDispute(uint256 choices, bytes calldata extraData) external payable returns (uint256 disputeId);
}

interface IClaimRegistryForArbitrable {
    function assertCanEscalate(bytes32 claimId, address arbitrablePath) external view;
    function applyArbitration(bytes32 claimId, ArbitrationOutcome outcome) external;
}

/// @title ERC-792/1497-style arbitration wrapper for non-objective claims.
/// @notice The backend arbitrator calls `rule`; this contract maps the ruling
///         to the ClaimRegistry's arbitration outcome.
contract ArbitrablePath {
    event Evidence(address indexed arbitrator, uint256 indexed evidenceGroupId, address indexed party, string evidence);
    event DisputeEscalated(bytes32 indexed claimId, uint256 indexed disputeId, uint256 arbitrationCost);

    error ZeroAddress();
    error NotArbitrator(address caller, address arbitrator);
    error UnknownDispute(uint256 disputeId);
    error AlreadyEscalated(bytes32 claimId, uint256 disputeId);
    error DisputeAlreadyMapped(uint256 disputeId, bytes32 claimId);
    error InsufficientArbitrationFee(uint256 required, uint256 provided);
    error ArbitrationFeeRefundFailed(address recipient, uint256 amount);
    error UnknownRuling(uint256 ruling);

    uint256 public constant NUM_CHOICES = 3;

    IArbitrator public immutable ARBITRATOR;
    IClaimRegistryForArbitrable public immutable CLAIM_REGISTRY;
    bytes private _extraData;

    mapping(uint256 => bytes32) public claimByDispute;
    mapping(bytes32 => uint256) public disputeByClaim;
    mapping(bytes32 => bool) public claimEscalated;

    constructor(address arbitrator_, address claimRegistry_, bytes memory extraData_) {
        if (arbitrator_ == address(0) || claimRegistry_ == address(0)) revert ZeroAddress();
        ARBITRATOR = IArbitrator(arbitrator_);
        CLAIM_REGISTRY = IClaimRegistryForArbitrable(claimRegistry_);
        _extraData = extraData_;
    }

    function escalate(bytes32 claimId) external payable returns (uint256 disputeId) {
        if (claimEscalated[claimId]) revert AlreadyEscalated(claimId, disputeByClaim[claimId]);
        CLAIM_REGISTRY.assertCanEscalate(claimId, address(this));

        bytes memory data = _extraData;
        uint256 cost = ARBITRATOR.arbitrationCost(data);
        if (msg.value < cost) revert InsufficientArbitrationFee(cost, msg.value);
        disputeId = ARBITRATOR.createDispute{value: cost}(NUM_CHOICES, data);
        bytes32 existingClaim = claimByDispute[disputeId];
        if (existingClaim != bytes32(0)) revert DisputeAlreadyMapped(disputeId, existingClaim);
        claimByDispute[disputeId] = claimId;
        disputeByClaim[claimId] = disputeId;
        claimEscalated[claimId] = true;

        if (msg.value > cost) {
            uint256 refund = msg.value - cost;
            (bool sent,) = payable(msg.sender).call{value: refund}("");
            if (!sent) revert ArbitrationFeeRefundFailed(msg.sender, refund);
        }
        emit DisputeEscalated(claimId, disputeId, cost);
    }

    function rule(uint256 disputeId, uint256 ruling) external {
        if (msg.sender != address(ARBITRATOR)) revert NotArbitrator(msg.sender, address(ARBITRATOR));
        bytes32 claimId = claimByDispute[disputeId];
        if (claimId == bytes32(0)) revert UnknownDispute(disputeId);
        ArbitrationOutcome outcome = _outcomeForRuling(ruling);
        delete claimByDispute[disputeId];
        delete disputeByClaim[claimId];
        delete claimEscalated[claimId];
        CLAIM_REGISTRY.applyArbitration(claimId, outcome);
    }

    function submitEvidence(uint256 evidenceGroupId, string calldata evidence) external {
        emit Evidence(address(ARBITRATOR), evidenceGroupId, msg.sender, evidence);
    }

    function extraData() external view returns (bytes memory) {
        return _extraData;
    }

    function _outcomeForRuling(uint256 ruling) internal pure returns (ArbitrationOutcome) {
        if (ruling == 0) return ArbitrationOutcome.DefaultPayout;
        if (ruling == 1) return ArbitrationOutcome.PayClaim;
        if (ruling == 2) return ArbitrationOutcome.Reject;
        if (ruling == 3) return ArbitrationOutcome.DefaultPayout;
        revert UnknownRuling(ruling);
    }
}
