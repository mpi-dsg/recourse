// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {RecourseTypes} from "./Types.sol";
import {Eip712Recourse} from "./Eip712Recourse.sol";

/// @title On-chain registry for κ contracts.
/// @notice Ex ante admission gate per main.tex:121. The runtime classifier
///         (off-chain) calls `register` once per (action template, resource
///         scope) and stores the returned `contractId`. Receipts and claims
///         later reference the κ by its `contractId`.
///
///         This contract is intentionally minimal: it stores the κ, refuses
///         duplicates and obvious admission failures, and exposes lookup.
///         Workload-specific eligibility predicates (scope closure, payout
///         totality, evidence-schema match) live in the Python classifier
///         because they are easier to test and update than Solidity.
contract RecourseRegistry {
    using RecourseTypes for *;

    /// @notice Emitted on a successful register call.
    event ContractRegistered(bytes32 indexed contractId, address indexed operator);

    /// @notice Emitted when an operator revokes a contract from future
    ///         admissions. Existing claims under the contract are unaffected.
    event ContractRevoked(bytes32 indexed contractId, address indexed operator);

    error AlreadyRegistered(bytes32 contractId);
    error NotCompensable();
    error ZeroBond();
    error ZeroBondAsset();
    error ZeroPayout();
    error ZeroDeadlines();
    error ZeroArbitrator();
    error UnknownContract(bytes32 contractId);
    error NotOperator(address caller, address operator);
    error AlreadyRevoked(bytes32 contractId);
    error UnsupportedSchemaVersion(uint8 expected, uint8 actual);
    error MinimumBondBelowMaxPayout(uint256 minAmount, uint256 maxPayout);
    error AggregateExposureBelowMaxPayout(uint256 maxAggregateExposure, uint256 maxPayout);
    error InvalidDeadlineOrder(uint64 recoverySeconds, uint64 submissionSeconds);

    struct StoredContract {
        RecourseTypes.RecourseContract k;
        bool exists;
        bool revoked;
    }

    mapping(bytes32 => StoredContract) private _contracts;

    /// @notice Register κ. The caller must equal `k.operator` and the κ must
    ///         clear the cheap admission checks. The chain-side `contractId`
    ///         is the EIP-712 struct hash of κ. Off-chain code should compute
    ///         the same id from the canonical JSON projection; the parity
    ///         tests confirm receipt digest parity at schema-pin time.
    function register(RecourseTypes.RecourseContract calldata k) external returns (bytes32 contractId) {
        if (k.schemaVersion != RecourseTypes.SCHEMA_VERSION) {
            revert UnsupportedSchemaVersion(RecourseTypes.SCHEMA_VERSION, k.schemaVersion);
        }
        if (msg.sender != k.operator) revert NotOperator(msg.sender, k.operator);
        if (k.effectClass != RecourseTypes.EffectClass.Compensable) revert NotCompensable();
        if (k.payoutRule.maxPayout == 0) revert ZeroPayout();
        if (k.bond.asset == address(0)) revert ZeroBondAsset();
        if (k.bond.minAmount == 0) revert ZeroBond();
        if (k.bond.minAmount < k.payoutRule.maxPayout) {
            revert MinimumBondBelowMaxPayout(k.bond.minAmount, k.payoutRule.maxPayout);
        }
        if (k.bond.maxAggregateExposure < k.payoutRule.maxPayout) {
            revert AggregateExposureBelowMaxPayout(k.bond.maxAggregateExposure, k.payoutRule.maxPayout);
        }
        if (k.deadlines.recoverySeconds == 0 || k.deadlines.submissionSeconds == 0 || k.deadlines.livenessSeconds == 0)
        {
            revert ZeroDeadlines();
        }
        if (k.deadlines.recoverySeconds >= k.deadlines.submissionSeconds) {
            revert InvalidDeadlineOrder(k.deadlines.recoverySeconds, k.deadlines.submissionSeconds);
        }
        if (k.disputeRoute.arbitrator == address(0)) revert ZeroArbitrator();

        contractId = Eip712Recourse.recourseContractStructHash(k);
        if (_contracts[contractId].exists) revert AlreadyRegistered(contractId);
        _contracts[contractId] = StoredContract({k: k, exists: true, revoked: false});
        emit ContractRegistered(contractId, k.operator);
    }

    /// @notice Look up a previously registered κ. Reverts if absent.
    function get(bytes32 contractId) external view returns (RecourseTypes.RecourseContract memory) {
        StoredContract storage sc = _contracts[contractId];
        if (!sc.exists) revert UnknownContract(contractId);
        return sc.k;
    }

    /// @notice True if the κ exists and has not been revoked.
    function isAdmissible(bytes32 contractId) external view returns (bool) {
        StoredContract storage sc = _contracts[contractId];
        return sc.exists && !sc.revoked;
    }

    /// @notice Operator revokes future admissions under this κ. Existing
    ///         claims continue to resolve normally; this only blocks new
    ///         action instances from being admitted.
    function revoke(bytes32 contractId) external {
        StoredContract storage sc = _contracts[contractId];
        if (!sc.exists) revert UnknownContract(contractId);
        if (sc.revoked) revert AlreadyRevoked(contractId);
        if (msg.sender != sc.k.operator) revert NotOperator(msg.sender, sc.k.operator);
        sc.revoked = true;
        emit ContractRevoked(contractId, sc.k.operator);
    }
}
