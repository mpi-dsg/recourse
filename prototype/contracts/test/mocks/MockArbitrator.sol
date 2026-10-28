// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ArbitrablePath} from "../../src/ArbitrablePath.sol";

contract MockArbitrator {
    event DisputeCreated(uint256 indexed disputeId, address indexed arbitrable, uint256 choices);

    uint256 public immutable COST;
    uint256 public nextDisputeId = 1;

    mapping(uint256 => address) public arbitrableByDispute;

    constructor(uint256 cost_) {
        COST = cost_;
    }

    function setNextDisputeId(uint256 disputeId) external {
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

    function giveRuling(uint256 disputeId, uint256 ruling) external {
        ArbitrablePath(arbitrableByDispute[disputeId]).rule(disputeId, ruling);
    }
}
