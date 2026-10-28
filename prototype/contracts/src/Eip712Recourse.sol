// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RecourseTypes} from "./Types.sol";

/// @title EIP-712 typehashes and digest computation for Recourse receipts.
/// @notice Mirror of `prototype/runtime-ts/packages/receipts/src/eip712.ts`.
///         Both sides MUST produce the same digest for the same struct +
///         domain. The parity invariant is asserted by `Eip712Recourse.t.sol`
///         and `eip712-parity.test.ts`.
library Eip712Recourse {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 internal constant EFFECT_RECEIPT_TYPEHASH = keccak256(
        "EffectReceipt(uint8 schemaVersion,bytes32 contractId,bytes32 jobId,bytes32 intentHash,bytes32 paramsHash,bytes32 resourceId,bytes32 preStateDigest,bytes32 postStateDigest,bytes32 providerReceiptHash,uint64 timestamp,address adapterAddress)"
    );
    bytes32 internal constant RECOVERY_RECEIPT_TYPEHASH = keccak256(
        "RecoveryReceipt(uint8 schemaVersion,bytes32 contractId,bytes32 effectReceiptHash,address compensatorAddress,bytes32 restoreArtifactHash,uint8 outcome,bytes32 residualMeasurementsHash,uint64 recoveryStartTs,uint64 recoveryEndTs)"
    );
    bytes32 internal constant CLAIM_TYPEHASH = keccak256(
        "Claim(uint8 schemaVersion,bytes32 contractId,bytes32 jobId,address claimant,uint256 amount,bytes32 evidenceCidHash,bytes32 effectReceiptHash,bytes32 recoveryReceiptHash,uint8 routeHint)"
    );

    bytes32 internal constant ACTION_TEMPLATE_TYPEHASH = keccak256("ActionTemplate(string tool,string action)");
    bytes32 internal constant RESOURCE_SCOPE_TYPEHASH =
        keccak256("ResourceScope(string scopeType,bytes32 descriptorHash)");
    bytes32 internal constant RECOVERY_OPERATOR_TYPEHASH = keccak256(
        "RecoveryOperator(bytes32 compensatorId,uint64 freshnessSeconds,uint64 retentionSeconds,bytes32 authPolicyHash)"
    );
    bytes32 internal constant COVERED_LOSS_CLASS_TYPEHASH =
        keccak256("CoveredLossClass(bytes32 codesHash,bytes32 excludeListHash)");
    bytes32 internal constant PAYOUT_RULE_TYPEHASH =
        keccak256("PayoutRule(bytes32 ruleType,bytes32 paramsHash,uint256 maxPayout)");
    bytes32 internal constant BOND_TYPEHASH =
        keccak256("Bond(address asset,uint256 minAmount,uint256 maxAggregateExposure)");
    bytes32 internal constant EVIDENCE_SCHEMA_TYPEHASH =
        keccak256("EvidenceSchema(bytes32 schemaId,uint8 requiredProvenance,bytes32 accessPolicyHash)");
    bytes32 internal constant DEADLINES_TYPEHASH =
        keccak256("Deadlines(uint64 recoverySeconds,uint64 submissionSeconds,uint64 livenessSeconds)");
    bytes32 internal constant DISPUTE_ROUTE_TYPEHASH =
        keccak256("DisputeRoute(address arbitrator,uint256 evidenceGroupId)");
    bytes32 internal constant RECOURSE_CONTRACT_TYPEHASH = keccak256(
        "RecourseContract(uint8 schemaVersion,address operator,ActionTemplate actionTemplate,ResourceScope resourceScope,uint8 effectClass,RecoveryOperator recoveryOperator,CoveredLossClass coveredLossClass,PayoutRule payoutRule,Bond bond,EvidenceSchema evidenceSchema,Deadlines deadlines,DisputeRoute disputeRoute)ActionTemplate(string tool,string action)Bond(address asset,uint256 minAmount,uint256 maxAggregateExposure)CoveredLossClass(bytes32 codesHash,bytes32 excludeListHash)Deadlines(uint64 recoverySeconds,uint64 submissionSeconds,uint64 livenessSeconds)DisputeRoute(address arbitrator,uint256 evidenceGroupId)EvidenceSchema(bytes32 schemaId,uint8 requiredProvenance,bytes32 accessPolicyHash)PayoutRule(bytes32 ruleType,bytes32 paramsHash,uint256 maxPayout)RecoveryOperator(bytes32 compensatorId,uint64 freshnessSeconds,uint64 retentionSeconds,bytes32 authPolicyHash)ResourceScope(string scopeType,bytes32 descriptorHash)"
    );

    bytes32 internal constant RECOURSE_NAME_HASH = keccak256("Recourse");
    bytes32 internal constant RECOURSE_VERSION_HASH = keccak256("1");

    function domainSeparator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, RECOURSE_NAME_HASH, RECOURSE_VERSION_HASH, chainId, verifyingContract)
        );
    }

    function effectReceiptStructHash(RecourseTypes.EffectReceipt memory r) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                EFFECT_RECEIPT_TYPEHASH,
                r.schemaVersion,
                r.contractId,
                r.jobId,
                r.intentHash,
                r.paramsHash,
                r.resourceId,
                r.preStateDigest,
                r.postStateDigest,
                r.providerReceiptHash,
                r.timestamp,
                r.adapterAddress
            )
        );
    }

    function recoveryReceiptStructHash(RecourseTypes.RecoveryReceipt memory r) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                RECOVERY_RECEIPT_TYPEHASH,
                r.schemaVersion,
                r.contractId,
                r.effectReceiptHash,
                r.compensatorAddress,
                r.restoreArtifactHash,
                uint8(r.outcome),
                r.residualMeasurementsHash,
                r.recoveryStartTs,
                r.recoveryEndTs
            )
        );
    }

    function claimStructHash(RecourseTypes.Claim memory c) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CLAIM_TYPEHASH,
                c.schemaVersion,
                c.contractId,
                c.jobId,
                c.claimant,
                c.amount,
                c.evidenceCidHash,
                c.effectReceiptHash,
                c.recoveryReceiptHash,
                uint8(c.routeHint)
            )
        );
    }

    function actionTemplateStructHash(RecourseTypes.ActionTemplate memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(ACTION_TEMPLATE_TYPEHASH, keccak256(bytes(a.tool)), keccak256(bytes(a.action))));
    }

    function resourceScopeStructHash(RecourseTypes.ResourceScope memory scope) internal pure returns (bytes32) {
        return keccak256(abi.encode(RESOURCE_SCOPE_TYPEHASH, keccak256(bytes(scope.scopeType)), scope.descriptorHash));
    }

    function recoveryOperatorStructHash(RecourseTypes.RecoveryOperator memory r) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                RECOVERY_OPERATOR_TYPEHASH, r.compensatorId, r.freshnessSeconds, r.retentionSeconds, r.authPolicyHash
            )
        );
    }

    function coveredLossClassStructHash(RecourseTypes.CoveredLossClass memory l) internal pure returns (bytes32) {
        return keccak256(abi.encode(COVERED_LOSS_CLASS_TYPEHASH, l.codesHash, l.excludeListHash));
    }

    function payoutRuleStructHash(RecourseTypes.PayoutRule memory p) internal pure returns (bytes32) {
        return keccak256(abi.encode(PAYOUT_RULE_TYPEHASH, p.ruleType, p.paramsHash, p.maxPayout));
    }

    function bondStructHash(RecourseTypes.Bond memory b) internal pure returns (bytes32) {
        return keccak256(abi.encode(BOND_TYPEHASH, b.asset, b.minAmount, b.maxAggregateExposure));
    }

    function evidenceSchemaStructHash(RecourseTypes.EvidenceSchema memory s) internal pure returns (bytes32) {
        return
            keccak256(abi.encode(EVIDENCE_SCHEMA_TYPEHASH, s.schemaId, uint8(s.requiredProvenance), s.accessPolicyHash));
    }

    function deadlinesStructHash(RecourseTypes.Deadlines memory d) internal pure returns (bytes32) {
        return keccak256(abi.encode(DEADLINES_TYPEHASH, d.recoverySeconds, d.submissionSeconds, d.livenessSeconds));
    }

    function disputeRouteStructHash(RecourseTypes.DisputeRoute memory route) internal pure returns (bytes32) {
        return keccak256(abi.encode(DISPUTE_ROUTE_TYPEHASH, route.arbitrator, route.evidenceGroupId));
    }

    function recourseContractStructHash(RecourseTypes.RecourseContract memory k) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                RECOURSE_CONTRACT_TYPEHASH,
                k.schemaVersion,
                k.operator,
                actionTemplateStructHash(k.actionTemplate),
                resourceScopeStructHash(k.resourceScope),
                uint8(k.effectClass),
                recoveryOperatorStructHash(k.recoveryOperator),
                coveredLossClassStructHash(k.coveredLossClass),
                payoutRuleStructHash(k.payoutRule),
                bondStructHash(k.bond),
                evidenceSchemaStructHash(k.evidenceSchema),
                deadlinesStructHash(k.deadlines),
                disputeRouteStructHash(k.disputeRoute)
            )
        );
    }

    function effectReceiptDigest(uint256 chainId, address verifyingContract, RecourseTypes.EffectReceipt memory r)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(hex"1901", domainSeparator(chainId, verifyingContract), effectReceiptStructHash(r))
        );
    }

    function recoveryReceiptDigest(uint256 chainId, address verifyingContract, RecourseTypes.RecoveryReceipt memory r)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(hex"1901", domainSeparator(chainId, verifyingContract), recoveryReceiptStructHash(r))
        );
    }

    function claimDigest(uint256 chainId, address verifyingContract, RecourseTypes.Claim memory c)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(chainId, verifyingContract), claimStructHash(c)));
    }
}
