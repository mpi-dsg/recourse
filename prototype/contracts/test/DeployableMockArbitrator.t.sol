// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockArbitrator} from "../src/mocks/MockArbitrator.sol";

contract DeployableMockArbitratorTest is Test {
    function testOwnerCanSetNextDisputeId() public {
        MockArbitrator arbitrator = new MockArbitrator(1 ether);

        arbitrator.setNextDisputeId(42);

        assertEq(arbitrator.nextDisputeId(), 42);
    }

    function testNonOwnerCannotAdministerOrRule() public {
        MockArbitrator arbitrator = new MockArbitrator(1 ether);
        address caller = address(0xBEEF);

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(MockArbitrator.NotOwner.selector, caller, address(this)));
        arbitrator.setNextDisputeId(42);

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(MockArbitrator.NotOwner.selector, caller, address(this)));
        arbitrator.giveRuling(1, 1);
    }
}
