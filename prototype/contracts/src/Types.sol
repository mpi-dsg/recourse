// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Recourse on-chain type projection
/// @notice On-chain representation of the canonical schemas in
///         `prototype/schemas/*.v1.json`. Nested off-chain payloads
///         (resource descriptor, payout params, residual measurements,
///         large evidence bundles) appear here as their content hashes;
///         the runtime keeps the originals in the evidence store.
///
///         **Do not edit by hand without bumping `SCHEMA_VERSIONS.md` and
///         the EIP-712 parity test in `Eip712Recourse.t.sol`.**
library RecourseTypes {
    /// @notice Schema version pinned in `prototype/SCHEMA_VERSIONS.md`.
    uint8 internal constant SCHEMA_VERSION = 1;

    /// @notice Effect class. Only `Compensable` is admitted by the registry.
    enum EffectClass {
        Reversible,
        Compensable,
        Excluded
    }

    /// @notice Provenance levels per main.tex:246.
    enum Provenance {
        L0, // independently replayable / publicly verifiable
        L1, // provider-attested under a registered provider key
        L2 // adapter- or compensator-attested

    }

    /// @notice Recovery outcome per main.tex:252.
    enum RecoveryOutcome {
        Success,
        Partial,
        Failure,
        Inconclusive
    }

    /// @notice Claim route hint per main.tex:267. The router can override.
    enum RouteHint {
        Optimistic,
        Arbitrated
    }

    /// @notice On-chain projection of κ.actionTemplate.
    /// @dev    Tool and action names are arbitrary; the registry treats them
    ///         as opaque labels. Workload-specific admission checks happen in
    ///         the classifier before registration.
    struct ActionTemplate {
        string tool;
        string action;
    }

    /// @notice On-chain projection of κ.resourceScope. The descriptor
    ///         (workload-specific) is committed as a hash; the canonical
    ///         JSON lives in the evidence store.
    struct ResourceScope {
        string scopeType; // "postgres-table" | "git-ref" | "cloud-resource"
        bytes32 descriptorHash;
    }

    /// @notice On-chain projection of κ.recoveryOperator.
    struct RecoveryOperator {
        bytes32 compensatorId; // keccak256(compensatorId string)
        uint64 freshnessSeconds;
        uint64 retentionSeconds;
        bytes32 authPolicyHash;
    }

    /// @notice On-chain projection of κ.coveredLossClass. Codes and
    ///         excludeList are committed as a single keccak256 over the
    ///         canonical-sorted JSON; predicate checks happen off-chain.
    struct CoveredLossClass {
        bytes32 codesHash;
        bytes32 excludeListHash;
    }

    /// @notice On-chain projection of κ.payoutRule.
    ///         `paramsHash` covers the family-specific parameters; the
    ///         registry checks only the chain-relevant payout bounds.
    struct PayoutRule {
        bytes32 ruleType; // keccak256(rule type name)
        bytes32 paramsHash;
        uint256 maxPayout;
    }

    /// @notice On-chain projection of κ.bond.
    struct Bond {
        address asset;
        uint256 minAmount;
        uint256 maxAggregateExposure;
    }

    /// @notice On-chain projection of κ.evidenceSchema.
    struct EvidenceSchema {
        bytes32 schemaId;
        Provenance requiredProvenance;
        bytes32 accessPolicyHash;
    }

    /// @notice On-chain projection of κ.deadlines (Δ).
    struct Deadlines {
        uint64 recoverySeconds; // Δ_ρ
        uint64 submissionSeconds; // Δ_s
        uint64 livenessSeconds; // Δ_l
    }

    /// @notice On-chain projection of κ.disputeRoute.
    struct DisputeRoute {
        address arbitrator;
        uint256 evidenceGroupId;
    }

    /// @notice The κ object as stored on chain (main.tex:115).
    struct RecourseContract {
        uint8 schemaVersion;
        address operator;
        ActionTemplate actionTemplate;
        ResourceScope resourceScope;
        EffectClass effectClass;
        RecoveryOperator recoveryOperator;
        CoveredLossClass coveredLossClass;
        PayoutRule payoutRule;
        Bond bond;
        EvidenceSchema evidenceSchema;
        Deadlines deadlines;
        DisputeRoute disputeRoute;
    }

    /// @notice Effect receipt (main.tex:232–246). Realizes the observable
    ///         evidence object o.
    struct EffectReceipt {
        uint8 schemaVersion;
        bytes32 contractId;
        bytes32 jobId;
        bytes32 intentHash;
        bytes32 paramsHash;
        bytes32 resourceId;
        bytes32 preStateDigest;
        bytes32 postStateDigest;
        bytes32 providerReceiptHash; // zero if absent
        uint64 timestamp;
        address adapterAddress;
    }

    /// @notice Per-loss-code residual measurement commit, as stored on
    ///         chain. Off-chain shape lives in
    ///         `schemas/recovery_receipt.v1.json`.
    struct ResidualMeasurementCommit {
        bytes32 lossCode; // keccak256(coveredLossClass code)
        bytes32 valueHash; // keccak256(canonical decimal-string value)
        bytes32 evidenceSource; // keccak256(evidence source enum)
        bytes32 artifactHash; // zero if absent
    }

    /// @notice Recovery receipt (main.tex:251–257). Realizes r.
    struct RecoveryReceipt {
        uint8 schemaVersion;
        bytes32 contractId;
        bytes32 effectReceiptHash;
        address compensatorAddress;
        bytes32 restoreArtifactHash;
        RecoveryOutcome outcome;
        bytes32 residualMeasurementsHash; // keccak256 over sorted commits
        uint64 recoveryStartTs;
        uint64 recoveryEndTs;
    }

    /// @notice Claim submitted to the registry.
    struct Claim {
        uint8 schemaVersion;
        bytes32 contractId;
        bytes32 jobId;
        address claimant;
        uint256 amount;
        bytes32 evidenceCidHash;
        bytes32 effectReceiptHash;
        bytes32 recoveryReceiptHash;
        RouteHint routeHint;
    }
}
