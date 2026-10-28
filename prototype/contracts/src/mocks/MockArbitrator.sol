// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArbitrablePath} from "../ArbitrablePath.sol";

/// @notice ERC-792-shaped fallback arbitrator for Base Sepolia broadcasts when
///         no live Kleros L2 instance exists on the target chain.
contract MockArbitrator {
    event DisputeCreated(uint256 indexed disputeId, address indexed arbitrable, uint256 choices);

    error NotOwner(address caller, address owner);

    uint256 public immutable COST;
    address public immutable OWNER;
    uint256 public nextDisputeId = 1;

    mapping(uint256 => address) public arbitrableByDispute;

    constructor(uint256 cost_) {
        COST = cost_;
        OWNER = msg.sender;
    }

    function setNextDisputeId(uint256 disputeId) external onlyOwner {
        nextDisputeId = disputeId;
    }

    function arbitrationCost(bytes calldata) external view returns (uint256) {
        return COST;
    }

    function createDispute(uint256 choices, bytes calldata) external payable returns (uint256 disputeId) {
        require(msg.value >= COST, "INSUFFICIENT_ARBITRATION_FEE");
        disputeId = nextDisputeId++;
        arbitrableByDispute[disputeId] = msg.sender;
        emit DisputeCreated(disputeId, msg.sender, choices);
    }

    function giveRuling(uint256 disputeId, uint256 ruling) external onlyOwner {
        ArbitrablePath(arbitrableByDispute[disputeId]).rule(disputeId, ruling);
    }

    modifier onlyOwner() {
        if (msg.sender != OWNER) revert NotOwner(msg.sender, OWNER);
        _;
    }
}
