// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SmokeTest is Test {
    function test_forgeStdAvailable() public pure {
        assertEq(uint256(1), uint256(1));
    }

    function test_openzeppelinImportCompiles() public pure {
        bytes4 sel = IERC20.transfer.selector;
        assertTrue(sel != bytes4(0));
    }
}
