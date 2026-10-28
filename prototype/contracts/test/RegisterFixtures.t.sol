// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {RegisterFixtures} from "../script/RegisterFixtures.s.sol";
import {Eip712Recourse} from "../src/Eip712Recourse.sol";
import {RecourseTypes} from "../src/Types.sol";

contract RegisterFixturesHarness is RegisterFixtures {
    function decode(string memory json, string memory name, address operator)
        external
        pure
        returns (RecourseTypes.RecourseContract memory)
    {
        return _decode(json, name, operator);
    }
}

contract RegisterFixturesTest is Test {
    using stdJson for string;

    address internal constant OPERATOR = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    RegisterFixturesHarness internal registrar;

    function setUp() public {
        registrar = new RegisterFixturesHarness();
    }

    function test_catalogueUsesCanonicalRuntimeCommitmentsAndIds() public view {
        _assertFixture("k-postgres-update");
        _assertFixture("k-postgres-ddl");
        _assertFixture("k-git-pushforce");
        _assertFixture("k-cloud-ssm");
        _assertFixture("k-cloud-rds-snapshot");
    }

    function _assertFixture(string memory name) internal view {
        string memory json = vm.readFile(string.concat("../fixtures/k-contracts/", name, ".json"));
        RecourseTypes.RecourseContract memory k = registrar.decode(json, name, OPERATOR);
        assertEq(Eip712Recourse.recourseContractStructHash(k), json.readBytes32(".contractId"), name);
    }
}
