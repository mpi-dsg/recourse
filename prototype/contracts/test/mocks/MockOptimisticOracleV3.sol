// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {OptimisticPath} from "../../src/OptimisticPath.sol";

contract MockOptimisticOracleV3 {
    using SafeERC20 for IERC20;

    bytes32 public constant DEFAULT_IDENTIFIER = bytes32("ASSERT_TRUTH");

    event TruthAsserted(bytes32 indexed assertionId, address indexed callbackRecipient, bytes claim, uint256 bond);

    struct Assertion {
        address callbackRecipient;
        bytes claim;
        uint256 bond;
        uint64 liveness;
    }

    mapping(bytes32 => Assertion) public assertions;
    bytes32 public lastIdentifier;
    bool public settleTruthfully = true;

    function defaultIdentifier() external pure returns (bytes32) {
        return DEFAULT_IDENTIFIER;
    }

    function assertTruth(
        bytes calldata claim,
        address,
        address callbackRecipient,
        address,
        uint64 liveness,
        IERC20 currency,
        uint256 bond,
        bytes32 identifier,
        bytes32
    ) external returns (bytes32 assertionId) {
        currency.safeTransferFrom(msg.sender, address(this), bond);
        lastIdentifier = identifier;
        assertionId = keccak256(abi.encode(msg.sender, callbackRecipient, claim, bond, block.number));
        assertions[assertionId] =
            Assertion({callbackRecipient: callbackRecipient, claim: claim, bond: bond, liveness: liveness});
        emit TruthAsserted(assertionId, callbackRecipient, claim, bond);
    }

    function setSettleTruthfully(bool truthful) external {
        settleTruthfully = truthful;
    }

    function settleAssertion(bytes32 assertionId) public {
        OptimisticPath(assertions[assertionId].callbackRecipient).assertionResolvedCallback(
            assertionId, settleTruthfully
        );
    }

    function settle(bytes32 assertionId) external {
        settleAssertion(assertionId);
    }

    function dispute(bytes32 assertionId) external {
        OptimisticPath(assertions[assertionId].callbackRecipient).assertionDisputedCallback(assertionId);
    }
}
