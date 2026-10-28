// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {RecourseRegistry} from "../src/RecourseRegistry.sol";
import {RecourseTypes} from "../src/Types.sol";
import {Eip712Recourse} from "../src/Eip712Recourse.sol";
import {MockUSDC} from "../test/mocks/MockUSDC.sol";
import {MockArbitrator} from "../test/mocks/MockArbitrator.sol";

/// @notice Anvil-side registration of the curated κ-contract catalogue.
///
/// @dev    The script:
///         1. Deploys ``RecourseRegistry``, ``MockUSDC``, ``MockArbitrator``
///            in a deterministic order so the addresses match the ones the
///            JSON fixtures pin (Anvil canonical CREATE addresses for
///            ``0xf39F...266``, nonces 0/1/5).
///         2. Loads each JSON fixture under
///            ``prototype/fixtures/k-contracts/`` via ``vm.readFile`` /
///            ``stdJson``.
///         3. Reconstructs the on-chain ``RecourseTypes.RecourseContract``
///            projection. Nested off-chain payloads (descriptor, codes,
///            excludeList, payout params) use the exact canonical-JSON
///            commitments produced by the Recourse receipts runtime package.
///         4. Calls ``register`` and captures the per-κ gas cost.
///         5. Writes ``results/k-contracts/registration.json``, the
///            ``\tablekcatalogue`` LaTeX row block, and a short paragraph
///            snippet via ``vm.writeFile``.
///
///         Run with:
///           PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
///             forge script script/RegisterFixtures.s.sol \
///             --rpc-url http://127.0.0.1:8545 --broadcast --slow
///
///         The orchestrating shell in ``prototype/scripts/`` starts and
///         tears down the Anvil instance around this script.
contract RegisterFixtures is Script {
    using stdJson for string;

    uint256 private constant NUM_KAPPAS = 5;

    struct KappaSummary {
        string name;
        bytes32 contractId;
        string scopeType;
        uint256 maxPayout;
        uint256 minBond;
        string compensatorId;
        uint256 gasUsed;
    }

    struct CanonicalCommits {
        bytes32 descriptorHash;
        bytes32 codesHash;
        bytes32 excludeListHash;
        bytes32 paramsHash;
    }

    string[NUM_KAPPAS] private fixtureNames =
        ["k-postgres-update", "k-postgres-ddl", "k-git-pushforce", "k-cloud-ssm", "k-cloud-rds-snapshot"];

    function run() external {
        uint256 pk =
            vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));
        string memory outputDir = vm.envOr("RECOURSE_K_RESULTS_DIR", string("../results/k-contracts"));
        address operator = vm.addr(pk);

        vm.startBroadcast(pk);

        // nonce 0 of the operator → registry
        RecourseRegistry registry = new RecourseRegistry();
        // nonce 1 of the operator → MockUSDC (bond asset committed in fixtures)
        MockUSDC usdc = new MockUSDC();
        // pad nonces 2..4 with throwaway deploys so the arbitrator lands at
        // nonce 5, matching the address pinned in the JSON fixtures
        // (0x5FC8d32690cc91D4c39d9d3abcBD16989F875707).
        new MockUSDC();
        new MockUSDC();
        new MockUSDC();
        MockArbitrator arbitrator = new MockArbitrator(0.01 ether);

        require(
            address(registry) == 0x5FbDB2315678afecb367f032d93F642f64180aa3,
            "registry CREATE addr mismatch; check operator nonce"
        );
        require(
            address(usdc) == 0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512,
            "MockUSDC CREATE addr mismatch; check operator nonce"
        );
        require(
            address(arbitrator) == 0x5FC8d32690cc91D4c39d9d3abcBD16989F875707,
            "MockArbitrator CREATE addr mismatch; check operator nonce"
        );

        KappaSummary[NUM_KAPPAS] memory summaries;
        for (uint256 i = 0; i < NUM_KAPPAS; i++) {
            summaries[i] = _registerOne(registry, fixtureNames[i], operator);
        }

        vm.stopBroadcast();

        _writeRegistrationJson(outputDir, address(registry), summaries);
        _writeCatalogueTex(outputDir, summaries);
        _writeSnippetTex(outputDir, summaries);
    }

    function _registerOne(RecourseRegistry registry, string memory name, address operator)
        internal
        returns (KappaSummary memory s)
    {
        string memory path = string.concat("../fixtures/k-contracts/", name, ".json");
        string memory json = vm.readFile(path);

        RecourseTypes.RecourseContract memory k = _decode(json, name, operator);

        bytes32 expectedId = Eip712Recourse.recourseContractStructHash(k);
        require(expectedId == json.readBytes32(".contractId"), "fixture contractId is not canonical");

        uint256 gasBefore = gasleft();
        bytes32 contractId = registry.register(k);
        uint256 gasAfter = gasleft();
        require(contractId == expectedId, "register returned unexpected contractId");

        s = KappaSummary({
            name: name,
            contractId: contractId,
            scopeType: k.resourceScope.scopeType,
            maxPayout: k.payoutRule.maxPayout,
            minBond: k.bond.minAmount,
            compensatorId: json.readString(".recoveryOperator.compensatorId"),
            gasUsed: gasBefore - gasAfter
        });

        console2.log("registered", name);
        console2.logBytes32(contractId);
        console2.log("  gas:", s.gasUsed);
    }

    function _decode(string memory json, string memory name, address operator)
        internal
        pure
        returns (RecourseTypes.RecourseContract memory k)
    {
        CanonicalCommits memory commits = _canonicalCommits(name);

        uint256 schemaVersion = json.readUint(".schemaVersion");
        require(schemaVersion == RecourseTypes.SCHEMA_VERSION, "fixture schemaVersion mismatch");

        address fixtureOperator = json.readAddress(".operator");
        require(fixtureOperator == operator, "fixture operator must match broadcast key");

        k.schemaVersion = uint8(schemaVersion);
        k.operator = fixtureOperator;
        k.actionTemplate = RecourseTypes.ActionTemplate({
            tool: json.readString(".actionTemplate.tool"),
            action: json.readString(".actionTemplate.action")
        });
        k.resourceScope = RecourseTypes.ResourceScope({
            scopeType: json.readString(".resourceScope.type"),
            descriptorHash: commits.descriptorHash
        });
        k.effectClass = RecourseTypes.EffectClass.Compensable;
        k.recoveryOperator = RecourseTypes.RecoveryOperator({
            compensatorId: keccak256(bytes(json.readString(".recoveryOperator.compensatorId"))),
            freshnessSeconds: uint64(json.readUint(".recoveryOperator.freshnessSeconds")),
            retentionSeconds: uint64(json.readUint(".recoveryOperator.retentionSeconds")),
            authPolicyHash: json.readBytes32(".recoveryOperator.authPolicyHash")
        });
        k.coveredLossClass =
            RecourseTypes.CoveredLossClass({codesHash: commits.codesHash, excludeListHash: commits.excludeListHash});
        k.payoutRule = RecourseTypes.PayoutRule({
            ruleType: keccak256(bytes(json.readString(".payoutRule.type"))),
            paramsHash: commits.paramsHash,
            maxPayout: _readDecimalString(json, ".payoutRule.maxPayout")
        });
        k.bond = RecourseTypes.Bond({
            asset: json.readAddress(".bond.asset"),
            minAmount: _readDecimalString(json, ".bond.minAmount"),
            maxAggregateExposure: _readDecimalString(json, ".bond.maxAggregateExposure")
        });
        k.evidenceSchema = RecourseTypes.EvidenceSchema({
            schemaId: json.readBytes32(".evidenceSchema.schemaId"),
            requiredProvenance: _provenance(json.readString(".evidenceSchema.requiredProvenance")),
            accessPolicyHash: json.readBytes32(".evidenceSchema.accessPolicyHash")
        });
        k.deadlines = RecourseTypes.Deadlines({
            recoverySeconds: uint64(json.readUint(".deadlines.recoverySeconds")),
            submissionSeconds: uint64(json.readUint(".deadlines.submissionSeconds")),
            livenessSeconds: uint64(json.readUint(".deadlines.livenessSeconds"))
        });
        k.disputeRoute = RecourseTypes.DisputeRoute({
            arbitrator: json.readAddress(".disputeRoute.arbitrator"),
            evidenceGroupId: _readDecimalString(json, ".disputeRoute.evidenceGroupId")
        });
    }

    /// @dev Generated with the runtime `hashCanonicalPayload` helper.
    ///      Foundry and runtime parity tests fail if fixture payloads drift.
    function _canonicalCommits(string memory name) internal pure returns (CanonicalCommits memory commits) {
        bytes32 nameHash = keccak256(bytes(name));
        if (nameHash == keccak256("k-postgres-update")) {
            return CanonicalCommits({
                descriptorHash: 0x34ac66c165c8557a1517c38cd12ca7a514da2d5e15dccdc20eed8cc6ade34f48,
                codesHash: 0x496f8ace3377a1c14e95c8d406f177f9307fe7806051e8b220d4bec61e43f4e2,
                excludeListHash: 0x96979200aa50bbbec743519b624ca8563589f1765c9b3b782ded6b2bba9e2c3d,
                paramsHash: 0x491d2b21c1d08a380e043e2c03322d855bf2507d2a035cfbd90ef86e58449cfd
            });
        }
        if (nameHash == keccak256("k-postgres-ddl")) {
            return CanonicalCommits({
                descriptorHash: 0xa9c8e961fced43d366355c65461f1fd06e42a739b0eca9aab03e5eba1397264d,
                codesHash: 0xc62cd4f4ae372c06df96f57e9f3d8d6b7c104f1ffe4315ff7ad1c4bdb89bf524,
                excludeListHash: 0x96979200aa50bbbec743519b624ca8563589f1765c9b3b782ded6b2bba9e2c3d,
                paramsHash: 0x00d9d9f9175fe6f0b7a91349350651191fbb2e1b053b5cea39e88d187e6b2bc1
            });
        }
        if (nameHash == keccak256("k-git-pushforce")) {
            return CanonicalCommits({
                descriptorHash: 0x0fefd757db89b5a584a8f8c5262388218670d5bca1828a5dcefee5e84e839413,
                codesHash: 0x7b4e0e6c74ee8c458be05fa81c4ac6c6fe70134ef356ddd6e7dbfe8c6ae3cec6,
                excludeListHash: 0x96979200aa50bbbec743519b624ca8563589f1765c9b3b782ded6b2bba9e2c3d,
                paramsHash: 0x7499493807ead9fd5489382d35f1e708691a4a2aa5cf7639d80d9bb2ea3a5efc
            });
        }
        if (nameHash == keccak256("k-cloud-ssm")) {
            return CanonicalCommits({
                descriptorHash: 0xf072608cafc8849c026097a1bbb0bc2901ee57ccbbcf847f126fc7ad0da4b266,
                codesHash: 0x1e0a47e148c3c6fca072b2aaf88ef0bc893eb96e7772ae3ef198e84197eef413,
                excludeListHash: 0xc81257a0938ecbb71e36a1f5226921c7d7fd2f9e87dbb5951808847bbb3be077,
                paramsHash: 0xd45187f03328074bbdcd2e1196f349a4845b0992806d8a05ecded8796b65bf06
            });
        }
        if (nameHash == keccak256("k-cloud-rds-snapshot")) {
            return CanonicalCommits({
                descriptorHash: 0xc5ffe2202f0f1cfe57d1319ea99103cf1a56dad228cef091a264d078e20db2b9,
                codesHash: 0x1e0a47e148c3c6fca072b2aaf88ef0bc893eb96e7772ae3ef198e84197eef413,
                excludeListHash: 0xc81257a0938ecbb71e36a1f5226921c7d7fd2f9e87dbb5951808847bbb3be077,
                paramsHash: 0x0f219a529a9bf5486655fbc8ea0319380c38af000f8272ea45392e8b1e700336
            });
        }
        revert("unknown fixture name");
    }

    function _provenance(string memory s) internal pure returns (RecourseTypes.Provenance) {
        bytes32 h = keccak256(bytes(s));
        if (h == keccak256("L0")) return RecourseTypes.Provenance.L0;
        if (h == keccak256("L1")) return RecourseTypes.Provenance.L1;
        if (h == keccak256("L2")) return RecourseTypes.Provenance.L2;
        revert("unknown provenance");
    }

    /// @dev The schema stores uint256-shaped quantities as decimal strings so
    ///      JSON parsers do not lose precision. Solidity-side we parse back.
    function _readDecimalString(string memory json, string memory key) internal pure returns (uint256) {
        bytes memory raw = bytes(json.readString(key));
        require(raw.length > 0, "empty decimal string");
        uint256 acc;
        for (uint256 i = 0; i < raw.length; i++) {
            uint8 c = uint8(raw[i]);
            require(c >= 0x30 && c <= 0x39, "non-digit in decimal string");
            acc = acc * 10 + (c - 0x30);
        }
        return acc;
    }

    function _writeRegistrationJson(
        string memory outputDir,
        address registryAddr,
        KappaSummary[NUM_KAPPAS] memory summaries
    ) internal {
        // build kContracts array
        string memory list = "[";
        for (uint256 i = 0; i < NUM_KAPPAS; i++) {
            list = string.concat(
                list,
                "{",
                "\"name\":\"",
                summaries[i].name,
                "\",",
                "\"hash\":\"",
                vm.toString(summaries[i].contractId),
                "\",",
                "\"scope\":\"",
                summaries[i].scopeType,
                "\",",
                "\"maxPayout\":\"",
                vm.toString(summaries[i].maxPayout),
                "\",",
                "\"bond\":\"",
                vm.toString(summaries[i].minBond),
                "\",",
                "\"compensatorId\":\"",
                summaries[i].compensatorId,
                "\",",
                "\"gas\":",
                vm.toString(summaries[i].gasUsed),
                "}",
                i + 1 == NUM_KAPPAS ? "" : ","
            );
        }
        list = string.concat(list, "]");

        string memory out = string.concat(
            "{\n",
            "  \"kContracts\": ",
            list,
            ",\n",
            "  \"registryAddress\": \"",
            vm.toString(registryAddr),
            "\",\n",
            "  \"rpcEndpoint\": \"anvil-in-process\",\n",
            "  \"chainId\": 31337\n",
            "}\n"
        );
        vm.writeFile(string.concat(outputDir, "/registration.json"), out);
    }

    function _writeCatalogueTex(string memory outputDir, KappaSummary[NUM_KAPPAS] memory summaries) internal {
        string memory body = "% Auto-generated by RegisterFixtures.s.sol. Do not edit by hand.\n"
            "\\providecommand{\\tablekcatalogue}{%\n";
        for (uint256 i = 0; i < NUM_KAPPAS; i++) {
            body = string.concat(
                body,
                "  ",
                _escape(summaries[i].name),
                " & ",
                _escape(summaries[i].scopeType),
                " & ",
                _formatUsdc(summaries[i].maxPayout),
                " & ",
                _formatUsdc(summaries[i].minBond),
                " & ",
                _escape(summaries[i].compensatorId),
                " & ",
                vm.toString(summaries[i].gasUsed),
                " \\\\\n"
            );
        }
        body = string.concat(body, "}\n");
        vm.writeFile(string.concat(outputDir, "/table_k_catalogue.tex"), body);
    }

    function _writeSnippetTex(string memory outputDir, KappaSummary[NUM_KAPPAS] memory summaries) internal {
        uint256 totalGas;
        uint256 maxGas;
        uint256 minGas = type(uint256).max;
        for (uint256 i = 0; i < NUM_KAPPAS; i++) {
            uint256 g = summaries[i].gasUsed;
            totalGas += g;
            if (g > maxGas) maxGas = g;
            if (g < minGas) minGas = g;
        }
        uint256 avgGas = totalGas / NUM_KAPPAS;

        string memory snippet = string.concat(
            "% Auto-generated by RegisterFixtures.s.sol. \\input from main.tex.\n",
            "We instantiate a five-entry catalogue $\\{\\kappa_i\\}_{i=1}^{5}$ that exercises every adapter ",
            "in our prototype: two Postgres templates (schema-scoped \\textsc{update}/\\textsc{delete} and ",
            "\\textsc{create}/\\textsc{drop}~\\textsc{table}), a Git \\textsc{force-push} guard for ",
            "non-protected refs, and two cloud templates covering SSM parameter writes and RDS snapshot ",
            "lifecycle. Each $\\kappa$ pairs a workload-specific compensator (snapshot restore, migration ",
            "replay, reflog replay, prior-version restore, point-in-time restore) with a payout schedule ",
            "calibrated to the loss codes that template can produce; bonds are sized at $10\\times$ the per-",
            "claim cap so $E_{\\text{open}}+P_{\\max}$ stays inside $\\maxAggregateExposure$ (cf.~main.tex:225). ",
            "All five register against a deployed \\textsc{RecourseRegistry} on an Anvil instance (",
            "chain id $31337$) with mean cost ",
            vm.toString(avgGas),
            "\\,gas (range ",
            vm.toString(minGas),
            "--",
            vm.toString(maxGas),
            "), demonstrating that the on-chain admission path is workload-agnostic.\n"
        );
        vm.writeFile(string.concat(outputDir, "/snippet.tex"), snippet);
    }

    function _formatUsdc(uint256 base6) internal pure returns (string memory) {
        // Format an integer in USDC base units (1e6) as $X.YY in human readable form.
        uint256 whole = base6 / 1_000_000;
        uint256 cents = (base6 % 1_000_000) / 10_000; // two decimal digits
        string memory centsStr;
        if (cents < 10) {
            centsStr = string.concat("0", vm.toString(cents));
        } else {
            centsStr = vm.toString(cents);
        }
        return string.concat("\\$", vm.toString(whole), ".", centsStr);
    }

    /// @dev Escape underscores so the row strings render cleanly inside LaTeX
    ///      tabular cells.
    function _escape(string memory s) internal pure returns (string memory out) {
        bytes memory b = bytes(s);
        bytes memory acc = new bytes(b.length * 2);
        uint256 j;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == bytes1("_") || c == bytes1("&") || c == bytes1("#") || c == bytes1("%")) {
                acc[j++] = bytes1("\\");
            }
            acc[j++] = c;
        }
        bytes memory trimmed = new bytes(j);
        for (uint256 k = 0; k < j; k++) {
            trimmed[k] = acc[k];
        }
        out = string(trimmed);
    }
}
