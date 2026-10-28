// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BondVault} from "../src/BondVault.sol";
import {ClaimRegistry} from "../src/ClaimRegistry.sol";
import {RecourseRegistry} from "../src/RecourseRegistry.sol";
import {RecourseTypes} from "../src/Types.sol";
import {Eip712Recourse} from "../src/Eip712Recourse.sol";

/// @notice End-to-end live-claim exerciser against the Base Sepolia
///         deployment pinned in `prototype/deployments/base-sepolia/addresses.json`.
///
/// @dev    What this script does, in one broadcast:
///         1. Registers one κ matching the `k-postgres-update` fixture
///            against the deployed RecourseRegistry (the on-chain projection
///            uses keccak-seeded hashes so we do not need a canonical JSON
///            serializer on chain).
///         2. Approves Circle test USDC to BondVault and posts a bond equal
///            to `10x` the per-claim payout cap (per main.tex:225 sizing
///            heuristic), giving us full single-claim headroom.
///         3. Commits a synthetic effect+recovery receipt pair into
///            ClaimRegistry for a fresh `jobId`.
///         4. Signs and submits a Claim for a small USDC payout (default
///            $1.00 = 1_000_000 base units) and prints every tx hash.
///
///         Settlement (optimistic liveness window or arbitration) happens
///         async after this script returns; the paper's reviewer-gap claim
///         is satisfied by the on-chain submission transaction.
///
/// Required env:
///   PRIVATE_KEY   funded EOA (must hold ≥ bond + gas; this address becomes
///                 both κ.operator and the claimant for simplicity).
///
/// Optional env:
///   CLAIM_AMOUNT_BASE6  USDC amount in 6-decimal base units (default 1_000_000 = $1).
///   BOND_AMOUNT_BASE6   USDC bond amount   (default 10_000_000 = $10 = 10× cap).
///   PAYOUT_MAX_BASE6    κ.payoutRule.maxPayout (default 1_000_000 = $1).
///
/// Invocation:
///   PRIVATE_KEY=0x... forge script contracts/script/LiveClaim.s.sol \
///       --rpc-url https://sepolia.base.org \
///       --broadcast \
///       --slow \
///       -vv
contract LiveClaim is Script {
    // --- Pinned Base Sepolia addresses (addresses.json) ---
    RecourseRegistry constant REGISTRY = RecourseRegistry(0x28233Bb34702EB846a6A77dEF340Df05824116f0);
    BondVault constant VAULT = BondVault(0xA27f1588682bC191148233e19fe360b3B161771c);
    ClaimRegistry constant CLAIMS = ClaimRegistry(0x87f25b7A792623Fc67B2123d123fE6D83691b9E6);
    IERC20 constant USDC = IERC20(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
    address constant ARBITRATOR = 0x9eD6ED4D525272096C4062f1c8A8c1076ef25Af4; // MockArbitrator

    // EIP-712 commitment defaults — deterministic keccak-seeded projections
    // for the postgres-update fixture; off-chain evidence store keeps originals.
    bytes32 constant DESCRIPTOR_HASH = keccak256("k-postgres-update:resourceScope.descriptor");
    bytes32 constant CODES_HASH = keccak256("k-postgres-update:coveredLossClass.codes");
    bytes32 constant EXCLUDE_HASH = keccak256("k-postgres-update:coveredLossClass.excludeList");
    bytes32 constant PARAMS_HASH = keccak256("k-postgres-update:payoutRule.params");
    bytes32 constant AUTH_POLICY_HASH = 0xaaaa000000000000000000000000000000000000000000000000000000000101;
    bytes32 constant SCHEMA_ID = 0xbbbb000000000000000000000000000000000000000000000000000000000101;
    bytes32 constant ACCESS_POLICY_HASH = 0xcccc000000000000000000000000000000000000000000000000000000000101;

    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address me = vm.addr(pk);
        uint256 payoutMax = vm.envOr("PAYOUT_MAX_BASE6", uint256(1_000_000));
        uint256 bondAmount = vm.envOr("BOND_AMOUNT_BASE6", uint256(10_000_000));
        uint256 claimAmount = vm.envOr("CLAIM_AMOUNT_BASE6", uint256(1_000_000));

        console2.log("operator/claimant:", me);
        console2.log("payoutMax (USDC base6):", payoutMax);
        console2.log("bondAmount (USDC base6):", bondAmount);
        console2.log("claimAmount (USDC base6):", claimAmount);

        RecourseTypes.RecourseContract memory k = _buildKappa(me, payoutMax, bondAmount);
        bytes32 expectedId = Eip712Recourse.recourseContractStructHash(k);
        console2.log("kappa.contractId (expected):");
        console2.logBytes32(expectedId);

        vm.startBroadcast(pk);

        bytes32 contractId = REGISTRY.register(k);
        require(contractId == expectedId, "kappa contractId mismatch");

        USDC.approve(address(VAULT), bondAmount);
        VAULT.postBond(contractId, bondAmount);

        bytes32 jobId = keccak256(abi.encodePacked("live-claim-job", block.timestamp, me));
        (bytes32 effectHash, bytes32 recoveryHash, bytes32 evidenceCidHash) = _commitReceipts(contractId, jobId);

        bytes32 claimId =
            _submitClaim(pk, me, contractId, jobId, claimAmount, effectHash, recoveryHash, evidenceCidHash);

        vm.stopBroadcast();

        console2.log("=== LIVE CLAIM SUBMITTED ===");
        console2.log("contractId:");
        console2.logBytes32(contractId);
        console2.log("jobId:");
        console2.logBytes32(jobId);
        console2.log("claimId:");
        console2.logBytes32(claimId);
        console2.log("Liveness window (s):", k.deadlines.livenessSeconds);
        console2.log("Settle async via OptimisticPath / ArbitrablePath.");
    }

    function _buildKappa(address me, uint256 payoutMax, uint256 bondAmount)
        internal
        pure
        returns (RecourseTypes.RecourseContract memory k)
    {
        k.schemaVersion = RecourseTypes.SCHEMA_VERSION;
        k.operator = me;
        k.actionTemplate = RecourseTypes.ActionTemplate({tool: "postgres", action: "schemaScopedDml"});
        k.resourceScope = RecourseTypes.ResourceScope({scopeType: "postgres-table", descriptorHash: DESCRIPTOR_HASH});
        k.effectClass = RecourseTypes.EffectClass.Compensable;
        k.recoveryOperator = RecourseTypes.RecoveryOperator({
            compensatorId: keccak256(bytes("postgres.snapshot.restore.v1")),
            freshnessSeconds: 3600,
            retentionSeconds: 1209600,
            authPolicyHash: AUTH_POLICY_HASH
        });
        k.coveredLossClass = RecourseTypes.CoveredLossClass({codesHash: CODES_HASH, excludeListHash: EXCLUDE_HASH});
        k.payoutRule = RecourseTypes.PayoutRule({
            ruleType: keccak256(bytes("rowCountSchedule")),
            paramsHash: PARAMS_HASH,
            maxPayout: payoutMax
        });
        k.bond = RecourseTypes.Bond({asset: address(USDC), minAmount: bondAmount, maxAggregateExposure: bondAmount});
        k.evidenceSchema = RecourseTypes.EvidenceSchema({
            schemaId: SCHEMA_ID,
            requiredProvenance: RecourseTypes.Provenance.L1,
            accessPolicyHash: ACCESS_POLICY_HASH
        });
        k.deadlines = RecourseTypes.Deadlines({recoverySeconds: 1800, submissionSeconds: 86400, livenessSeconds: 21600});
        k.disputeRoute = RecourseTypes.DisputeRoute({arbitrator: ARBITRATOR, evidenceGroupId: 1101});
    }

    function _commitReceipts(bytes32 contractId, bytes32 jobId)
        internal
        returns (bytes32 effectHash, bytes32 recoveryHash, bytes32 evidenceCidHash)
    {
        effectHash = keccak256(abi.encodePacked(contractId, jobId, "effect"));
        recoveryHash = keccak256(abi.encodePacked(contractId, jobId, "recovery"));
        evidenceCidHash = keccak256(abi.encodePacked(contractId, jobId, "evidence-cid"));
        uint64 nowTs = uint64(block.timestamp);

        ClaimRegistry.EffectReceiptCommit memory ec = ClaimRegistry.EffectReceiptCommit({
            schemaVersion: uint16(RecourseTypes.SCHEMA_VERSION),
            receiptHash: effectHash,
            provenance: RecourseTypes.Provenance.L1,
            timestamp: nowTs,
            evidenceHash: evidenceCidHash
        });
        ClaimRegistry.RecoveryReceiptCommit memory rc = ClaimRegistry.RecoveryReceiptCommit({
            schemaVersion: uint16(RecourseTypes.SCHEMA_VERSION),
            receiptHash: recoveryHash,
            outcome: RecourseTypes.RecoveryOutcome.Partial,
            provenance: RecourseTypes.Provenance.L1,
            recoveryEndTs: nowTs
        });
        CLAIMS.commitReceipts(contractId, jobId, ec, rc);
    }

    function _submitClaim(
        uint256 pk,
        address me,
        bytes32 contractId,
        bytes32 jobId,
        uint256 amount,
        bytes32 effectHash,
        bytes32 recoveryHash,
        bytes32 evidenceCidHash
    ) internal returns (bytes32 claimId) {
        RecourseTypes.Claim memory c = RecourseTypes.Claim({
            schemaVersion: RecourseTypes.SCHEMA_VERSION,
            contractId: contractId,
            jobId: jobId,
            claimant: me,
            amount: amount,
            evidenceCidHash: evidenceCidHash,
            effectReceiptHash: effectHash,
            recoveryReceiptHash: recoveryHash,
            routeHint: RecourseTypes.RouteHint.Optimistic
        });
        bytes32 digest = Eip712Recourse.claimDigest(block.chainid, address(CLAIMS), c);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        claimId = CLAIMS.submitClaim(c, abi.encodePacked(r, s, v));
    }
}
