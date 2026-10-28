// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {BondVault} from "./BondVault.sol";
import {Eip712Recourse} from "./Eip712Recourse.sol";
import {RecourseRegistry} from "./RecourseRegistry.sol";
import {RecourseTypes} from "./Types.sol";

enum ClaimRoute {
    Unknown,
    Optimistic,
    Arbitrated
}

enum ClaimState {
    None,
    Submitted,
    InArbitration,
    Paid,
    Rejected,
    DefaultPayout
}

enum ArbitrationOutcome {
    Reject,
    PayClaim,
    DefaultPayout
}

/// @title Claim lifecycle registry for residual-loss claims.
/// @notice Stores receipt commitments and routes claims to the optimistic
///         challenge path or arbitration according to the settleability
///         predicates that can be checked on chain.
contract ClaimRegistry {
    event ReceiptsCommitted(
        bytes32 indexed contractId, bytes32 indexed jobId, bytes32 effectReceiptHash, bytes32 recoveryReceiptHash
    );
    event ClaimSubmitted(
        bytes32 indexed claimId,
        bytes32 indexed contractId,
        bytes32 indexed jobId,
        address claimant,
        uint256 amount,
        ClaimRoute route,
        uint256 livenessDeadline
    );
    event ClaimDisputed(bytes32 indexed claimId, address indexed challenger);
    event ClaimFinalized(bytes32 indexed claimId, ClaimState indexed state, address indexed claimant, uint256 amount);
    event OptimisticPathSet(address indexed optimisticPath);

    error ZeroAddress();
    error ZeroAmount();
    error ZeroReceiptHash();
    error ZeroEvidenceHash();
    error ZeroEvidenceCid();
    error NotOwner(address caller, address owner);
    error NotReceiptCommitter(address caller, address operator);
    error ContractNotAdmissible(bytes32 contractId);
    error ReceiptAlreadyCommitted(bytes32 contractId, bytes32 jobId);
    error EffectTimestampInFuture(bytes32 contractId, bytes32 jobId, uint64 timestamp);
    error InvalidRecoveryReceipt(bytes32 contractId, bytes32 jobId);
    error SchemaVersionMismatch(uint16 expected, uint16 actual);
    error UnknownReceiptCommit(bytes32 contractId, bytes32 jobId);
    error ClaimAlreadySubmitted(bytes32 contractId, bytes32 jobId, bytes32 claimId);
    error SubmissionDeadlineExpired(bytes32 contractId, bytes32 jobId, uint256 deadline);
    error RecoveryDeadlinePending(bytes32 contractId, bytes32 jobId, uint256 readyAt);
    error RecoveryDeadlineExpired(bytes32 contractId, bytes32 jobId, uint256 deadline, uint64 recoveredAt);
    error AmountExceedsMaxPayout(bytes32 contractId, uint256 amount, uint256 maxPayout);
    error UnknownClaim(bytes32 claimId);
    error LivenessActive(bytes32 claimId);
    error LivenessExpired(bytes32 claimId);
    error NotOptimistic(bytes32 claimId);
    error NotArbitrated(bytes32 claimId);
    error InvalidClaimState(bytes32 claimId, ClaimState state);
    error ClaimContractMismatch(bytes32 claimId, bytes32 expected, bytes32 actual);
    error ClaimReceiptMismatch(bytes32 contractId, bytes32 jobId);
    error ClaimEvidenceMismatch(bytes32 contractId, bytes32 jobId, bytes32 expected, bytes32 actual);
    error InvalidClaimSignature(address expected, address actual);
    error NotArbitrator(address caller, address expected);
    error OptimisticPathAlreadySet(address current);
    error NotOptimisticPath(address caller, address expected);

    struct EffectReceiptCommit {
        uint16 schemaVersion;
        bytes32 receiptHash;
        RecourseTypes.Provenance provenance;
        uint64 timestamp;
        bytes32 evidenceHash;
    }

    struct RecoveryReceiptCommit {
        uint16 schemaVersion;
        bytes32 receiptHash;
        RecourseTypes.RecoveryOutcome outcome;
        RecourseTypes.Provenance provenance;
        uint64 recoveryEndTs;
    }

    struct ReceiptRecord {
        bytes32 effectReceiptHash;
        RecourseTypes.Provenance effectProvenance;
        uint64 effectTimestamp;
        bytes32 effectEvidenceHash;
        bytes32 recoveryReceiptHash;
        RecourseTypes.RecoveryOutcome recoveryOutcome;
        RecourseTypes.Provenance recoveryProvenance;
        uint64 recoveryEndTs;
        uint64 recordedAt;
        bool exists;
    }

    struct ClaimRecord {
        bytes32 contractId;
        bytes32 jobId;
        address claimant;
        uint256 amount;
        bytes32 evidenceCid;
        ClaimRoute route;
        ClaimState state;
        uint256 livenessDeadline;
        address arbitrator;
    }

    struct SubmitClaimContext {
        bytes32 key;
        bytes32 contractId;
        bytes32 jobId;
        address claimant;
        uint256 amount;
        bytes32 evidenceCid;
        ClaimRoute route;
        address arbitrator;
        uint64 livenessSeconds;
    }

    RecourseRegistry public immutable REGISTRY;
    BondVault public immutable VAULT;
    address public immutable OWNER;
    address public optimisticPath;

    uint256 private _nextClaimNonce = 1;

    mapping(bytes32 => ReceiptRecord) private _receiptRecords;
    mapping(bytes32 => bytes32) private _claimByReceiptKey;
    mapping(bytes32 => ClaimRecord) private _claims;

    constructor(RecourseRegistry registry_, BondVault vault_) {
        if (address(registry_) == address(0) || address(vault_) == address(0)) revert ZeroAddress();
        REGISTRY = registry_;
        VAULT = vault_;
        OWNER = msg.sender;
    }

    function setOptimisticPath(address optimisticPath_) external {
        if (msg.sender != OWNER) revert NotOwner(msg.sender, OWNER);
        if (optimisticPath_ == address(0)) revert ZeroAddress();
        if (optimisticPath != address(0)) revert OptimisticPathAlreadySet(optimisticPath);
        optimisticPath = optimisticPath_;
        emit OptimisticPathSet(optimisticPath_);
    }

    function commitReceipts(
        bytes32 contractId,
        bytes32 jobId,
        EffectReceiptCommit calldata ec,
        RecoveryReceiptCommit calldata rc
    ) external {
        RecourseTypes.RecourseContract memory k = REGISTRY.get(contractId);
        if (!REGISTRY.isAdmissible(contractId)) revert ContractNotAdmissible(contractId);
        if (msg.sender != k.operator) revert NotReceiptCommitter(msg.sender, k.operator);
        if (ec.schemaVersion != k.schemaVersion) revert SchemaVersionMismatch(k.schemaVersion, ec.schemaVersion);
        if (rc.receiptHash != bytes32(0) && rc.schemaVersion != k.schemaVersion) {
            revert SchemaVersionMismatch(k.schemaVersion, rc.schemaVersion);
        }
        if (ec.receiptHash == bytes32(0)) revert ZeroReceiptHash();
        if (ec.evidenceHash == bytes32(0)) revert ZeroEvidenceHash();
        if (uint256(ec.timestamp) > block.timestamp) {
            revert EffectTimestampInFuture(contractId, jobId, ec.timestamp);
        }
        if (
            rc.receiptHash != bytes32(0)
                && (rc.recoveryEndTs == 0 || rc.recoveryEndTs < ec.timestamp || uint256(rc.recoveryEndTs) > block.timestamp)
        ) {
            revert InvalidRecoveryReceipt(contractId, jobId);
        }
        uint256 recoveryDeadline = uint256(ec.timestamp) + k.deadlines.recoverySeconds;
        if (rc.receiptHash != bytes32(0) && uint256(rc.recoveryEndTs) > recoveryDeadline) {
            revert RecoveryDeadlineExpired(contractId, jobId, recoveryDeadline, rc.recoveryEndTs);
        }

        bytes32 key = receiptKey(contractId, jobId);
        ReceiptRecord storage record = _receiptRecords[key];
        if (record.exists) revert ReceiptAlreadyCommitted(contractId, jobId);
        record.recordedAt = uint64(block.timestamp);
        record.exists = true;

        record.effectReceiptHash = ec.receiptHash;
        record.effectProvenance = ec.provenance;
        record.effectTimestamp = ec.timestamp;
        record.effectEvidenceHash = ec.evidenceHash;
        record.recoveryReceiptHash = rc.receiptHash;
        record.recoveryOutcome = rc.outcome;
        record.recoveryProvenance = rc.provenance;
        record.recoveryEndTs = rc.recoveryEndTs;

        emit ReceiptsCommitted(contractId, jobId, ec.receiptHash, rc.receiptHash);
    }

    function submitClaim(RecourseTypes.Claim calldata c, bytes calldata signature) external returns (bytes32 claimId) {
        if (c.amount == 0) revert ZeroAmount();
        if (c.evidenceCidHash == bytes32(0)) revert ZeroEvidenceCid();
        address signer = ECDSA.recover(Eip712Recourse.claimDigest(block.chainid, address(this), c), signature);
        if (signer != c.claimant) revert InvalidClaimSignature(c.claimant, signer);

        bytes32 contractId = c.contractId;
        bytes32 jobId = c.jobId;
        RecourseTypes.RecourseContract memory k = REGISTRY.get(contractId);
        if (c.schemaVersion != k.schemaVersion) revert SchemaVersionMismatch(k.schemaVersion, c.schemaVersion);
        if (c.amount > k.payoutRule.maxPayout) {
            revert AmountExceedsMaxPayout(contractId, c.amount, k.payoutRule.maxPayout);
        }

        bytes32 key = receiptKey(contractId, jobId);
        ReceiptRecord storage record = _receiptRecords[key];
        if (!record.exists) revert UnknownReceiptCommit(contractId, jobId);
        if (record.effectReceiptHash != c.effectReceiptHash || record.recoveryReceiptHash != c.recoveryReceiptHash) {
            revert ClaimReceiptMismatch(contractId, jobId);
        }
        bytes32 existingClaimId = _claimByReceiptKey[key];
        if (existingClaimId != bytes32(0)) revert ClaimAlreadySubmitted(contractId, jobId, existingClaimId);
        if (record.effectEvidenceHash != c.evidenceCidHash) {
            revert ClaimEvidenceMismatch(contractId, jobId, record.effectEvidenceHash, c.evidenceCidHash);
        }
        uint256 submissionDeadline = uint256(record.effectTimestamp) + k.deadlines.submissionSeconds;
        if (block.timestamp > submissionDeadline) {
            revert SubmissionDeadlineExpired(contractId, jobId, submissionDeadline);
        }

        ClaimRoute route = _route(k, record, c.routeHint, contractId, jobId);
        claimId = _storeClaim(
            SubmitClaimContext({
                key: key,
                contractId: contractId,
                jobId: jobId,
                claimant: c.claimant,
                amount: c.amount,
                evidenceCid: c.evidenceCidHash,
                route: route,
                arbitrator: k.disputeRoute.arbitrator,
                livenessSeconds: k.deadlines.livenessSeconds
            })
        );
    }

    function _storeClaim(SubmitClaimContext memory ctx) internal returns (bytes32 claimId) {
        claimId = keccak256(
            abi.encode(ctx.contractId, ctx.jobId, ctx.claimant, ctx.amount, ctx.evidenceCid, _nextClaimNonce++)
        );
        ClaimState state = ctx.route == ClaimRoute.Optimistic ? ClaimState.Submitted : ClaimState.InArbitration;
        uint256 livenessDeadline = block.timestamp + ctx.livenessSeconds;

        VAULT.reserveExposure(ctx.contractId, claimId, ctx.amount);
        _claimByReceiptKey[ctx.key] = claimId;
        _claims[claimId] = ClaimRecord({
            contractId: ctx.contractId,
            jobId: ctx.jobId,
            claimant: ctx.claimant,
            amount: ctx.amount,
            evidenceCid: ctx.evidenceCid,
            route: ctx.route,
            state: state,
            livenessDeadline: livenessDeadline,
            arbitrator: ctx.arbitrator
        });

        emit ClaimSubmitted(claimId, ctx.contractId, ctx.jobId, ctx.claimant, ctx.amount, ctx.route, livenessDeadline);
    }

    function dispute(bytes32 claimId) external onlyOptimisticPath {
        ClaimRecord storage claim = _existingClaim(claimId);
        if (claim.route != ClaimRoute.Optimistic) revert NotOptimistic(claimId);
        if (claim.state != ClaimState.Submitted) revert InvalidClaimState(claimId, claim.state);
        if (block.timestamp > claim.livenessDeadline) revert LivenessExpired(claimId);

        claim.state = ClaimState.InArbitration;
        claim.route = ClaimRoute.Arbitrated;
        emit ClaimDisputed(claimId, msg.sender);
    }

    function finalizeOptimistic(bytes32 claimId) external onlyOptimisticPath {
        ClaimRecord storage claim = _existingClaim(claimId);
        if (claim.route != ClaimRoute.Optimistic) revert NotOptimistic(claimId);
        if (claim.state != ClaimState.Submitted) revert InvalidClaimState(claimId, claim.state);
        if (block.timestamp <= claim.livenessDeadline) revert LivenessActive(claimId);

        claim.state = ClaimState.Paid;
        VAULT.payout(claim.contractId, claimId, claim.claimant, claim.amount);
        emit ClaimFinalized(claimId, ClaimState.Paid, claim.claimant, claim.amount);
    }

    function applyArbitration(bytes32 claimId, ArbitrationOutcome outcome) external {
        ClaimRecord storage claim = _existingClaim(claimId);
        if (msg.sender != claim.arbitrator) revert NotArbitrator(msg.sender, claim.arbitrator);
        if (claim.state != ClaimState.InArbitration) revert InvalidClaimState(claimId, claim.state);

        if (outcome == ArbitrationOutcome.Reject) {
            claim.state = ClaimState.Rejected;
            VAULT.releaseExposure(claim.contractId, claimId);
            emit ClaimFinalized(claimId, ClaimState.Rejected, claim.claimant, 0);
            return;
        }

        if (outcome == ArbitrationOutcome.DefaultPayout) {
            claim.state = ClaimState.DefaultPayout;
            VAULT.payout(claim.contractId, claimId, claim.claimant, claim.amount);
            emit ClaimFinalized(claimId, ClaimState.DefaultPayout, claim.claimant, claim.amount);
            return;
        }

        claim.state = ClaimState.Paid;
        VAULT.payout(claim.contractId, claimId, claim.claimant, claim.amount);
        emit ClaimFinalized(claimId, ClaimState.Paid, claim.claimant, claim.amount);
    }

    function assertCanEscalate(bytes32 claimId, address arbitrablePath) external view {
        if (arbitrablePath == address(0)) revert ZeroAddress();
        ClaimRecord storage claim = _existingClaim(claimId);
        if (claim.route != ClaimRoute.Arbitrated) revert NotArbitrated(claimId);
        if (claim.state != ClaimState.InArbitration) revert InvalidClaimState(claimId, claim.state);
        if (claim.arbitrator != arbitrablePath) revert NotArbitrator(arbitrablePath, claim.arbitrator);
    }

    function assertCanAssertOptimistic(bytes32 claimId, bytes32 contractId, uint64 assertionLivenessSeconds)
        external
        view
    {
        ClaimRecord storage claim = _existingClaim(claimId);
        if (claim.route != ClaimRoute.Optimistic) revert NotOptimistic(claimId);
        if (claim.state != ClaimState.Submitted) revert InvalidClaimState(claimId, claim.state);
        if (claim.contractId != contractId) revert ClaimContractMismatch(claimId, claim.contractId, contractId);
        if (block.timestamp + assertionLivenessSeconds > claim.livenessDeadline) revert LivenessExpired(claimId);
    }

    function receiptKey(bytes32 contractId, bytes32 jobId) public pure returns (bytes32) {
        return keccak256(abi.encode(contractId, jobId));
    }

    function routeOf(bytes32 claimId) external view returns (ClaimRoute) {
        return _claims[claimId].route;
    }

    function stateOf(bytes32 claimId) external view returns (ClaimState) {
        return _claims[claimId].state;
    }

    function livenessDeadlineOf(bytes32 claimId) external view returns (uint256) {
        return _claims[claimId].livenessDeadline;
    }

    function getClaim(bytes32 claimId) external view returns (ClaimRecord memory) {
        return _claims[claimId];
    }

    function getReceiptRecord(bytes32 contractId, bytes32 jobId) external view returns (ReceiptRecord memory) {
        return _receiptRecords[receiptKey(contractId, jobId)];
    }

    function _route(
        RecourseTypes.RecourseContract memory k,
        ReceiptRecord storage record,
        RecourseTypes.RouteHint hint,
        bytes32 contractId,
        bytes32 jobId
    ) internal view returns (ClaimRoute) {
        if (record.recoveryReceiptHash == bytes32(0)) {
            uint256 readyAt = uint256(record.effectTimestamp) + k.deadlines.recoverySeconds;
            if (block.timestamp <= readyAt) revert RecoveryDeadlinePending(contractId, jobId, readyAt);
            return ClaimRoute.Arbitrated;
        }

        if (_weakerThanRequired(record.effectProvenance, k.evidenceSchema.requiredProvenance)) {
            return ClaimRoute.Arbitrated;
        }
        if (_weakerThanRequired(record.recoveryProvenance, k.evidenceSchema.requiredProvenance)) {
            return ClaimRoute.Arbitrated;
        }
        if (
            record.recoveryOutcome == RecourseTypes.RecoveryOutcome.Failure
                || record.recoveryOutcome == RecourseTypes.RecoveryOutcome.Inconclusive
        ) {
            return ClaimRoute.Arbitrated;
        }
        if (hint == RecourseTypes.RouteHint.Arbitrated) return ClaimRoute.Arbitrated;

        return ClaimRoute.Optimistic;
    }

    function _weakerThanRequired(RecourseTypes.Provenance actual, RecourseTypes.Provenance required)
        internal
        pure
        returns (bool)
    {
        return uint8(actual) > uint8(required);
    }

    function _existingClaim(bytes32 claimId) internal view returns (ClaimRecord storage claim) {
        claim = _claims[claimId];
        if (claim.state == ClaimState.None) revert UnknownClaim(claimId);
    }

    modifier onlyOptimisticPath() {
        if (msg.sender != optimisticPath) revert NotOptimisticPath(msg.sender, optimisticPath);
        _;
    }
}
