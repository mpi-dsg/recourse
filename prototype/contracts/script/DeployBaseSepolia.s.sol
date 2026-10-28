// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ArbitrablePath} from "../src/ArbitrablePath.sol";
import {BondVault} from "../src/BondVault.sol";
import {ClaimRegistry} from "../src/ClaimRegistry.sol";
import {OptimisticPath} from "../src/OptimisticPath.sol";
import {RecourseRegistry} from "../src/RecourseRegistry.sol";
import {MockArbitrator} from "../src/mocks/MockArbitrator.sol";

/// @notice Base Sepolia deployment script for the Recourse contract core.
///
/// @dev Required environment variables:
///      RECOURSE_BOND_ASSET   ERC-20 collateral. Defaults to Circle test
///                            USDC on Base Sepolia
///                            (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
///                            when unset.
///      UMA_OO_BASE_SEPOLIA   UMA Optimistic Oracle V3 on Base Sepolia.
///                            Default: 0x0F7fC5E6482f096380db6158f978167b57388deE
///                            (the live UMA OOv3 deployment).
///      ERC792_ARBITRATOR_BASE_SEPOLIA  ERC-792 arbitrator backend. If
///                            unset, a fresh MockArbitrator is deployed
///                            in the same transaction batch — Kleros L2
///                            is not deployed on Base Sepolia as of
///                            May 2026 and the paper's portability claim
///                            is justified by interface conformance only.
///      RECOURSE_MOCK_ARBITRATOR_COST  optional, in wei. Defaults to
///                            0.001 ether.
contract DeployBaseSepolia is Script {
    address private constant DEFAULT_BOND_ASSET = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address private constant DEFAULT_UMA_OOV3 = 0x0F7fC5E6482f096380db6158f978167b57388deE;
    uint256 private constant DEFAULT_MOCK_ARBITRATION_COST = 0.001 ether;

    function run()
        external
        returns (
            RecourseRegistry registry,
            BondVault vault,
            ClaimRegistry claimRegistry,
            OptimisticPath optimisticPath,
            ArbitrablePath arbitrablePath,
            address arbitrator
        )
    {
        IERC20 bondAsset = IERC20(_envAddressOr("RECOURSE_BOND_ASSET", DEFAULT_BOND_ASSET));
        address optimisticOracle = _envAddressOr("UMA_OO_BASE_SEPOLIA", DEFAULT_UMA_OOV3);
        address arbitratorEnv = _envAddressOr("ERC792_ARBITRATOR_BASE_SEPOLIA", address(0));

        vm.startBroadcast();

        if (arbitratorEnv == address(0)) {
            uint256 cost = vm.envOr("RECOURSE_MOCK_ARBITRATOR_COST", DEFAULT_MOCK_ARBITRATION_COST);
            MockArbitrator mock = new MockArbitrator(cost);
            arbitrator = address(mock);
        } else {
            arbitrator = arbitratorEnv;
        }

        registry = new RecourseRegistry();
        vault = new BondVault(bondAsset, registry);
        claimRegistry = new ClaimRegistry(registry, vault);
        vault.setClaimRegistry(address(claimRegistry));

        optimisticPath = new OptimisticPath(optimisticOracle, address(claimRegistry), bondAsset);
        claimRegistry.setOptimisticPath(address(optimisticPath));

        arbitrablePath = new ArbitrablePath(arbitrator, address(claimRegistry), bytes("recourse-arbitration-v1"));

        vm.stopBroadcast();

        console2.log("BondAsset       ", address(bondAsset));
        console2.log("OptimisticOracle", optimisticOracle);
        console2.log("Arbitrator      ", arbitrator);
        console2.log("RecourseRegistry", address(registry));
        console2.log("BondVault       ", address(vault));
        console2.log("ClaimRegistry   ", address(claimRegistry));
        console2.log("OptimisticPath  ", address(optimisticPath));
        console2.log("ArbitrablePath  ", address(arbitrablePath));
    }

    function _envAddressOr(string memory name, address fallback_) private view returns (address value) {
        try vm.envAddress(name) returns (address envValue) {
            value = envValue;
        } catch {
            value = fallback_;
        }
    }
}
