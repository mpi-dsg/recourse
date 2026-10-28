/**
 * EIP-712 typed-data definitions for Recourse receipts.
 *
 * The Solidity mirror lives in `prototype/contracts/src/Eip712Recourse.sol`.
 * Both must produce the same digest for the same struct + domain or the
 * parity test in `Eip712Recourse.t.sol` and `eip712-parity.test.ts` fails.
 *
 * When you add a field to a receipt, you MUST:
 *   1. Update the JSON schema in `prototype/schemas/*.v1.json`.
 *   2. Update `Types.sol` and `types.gen.ts`.
 *   3. Update both the TS typed-data definition AND the Solidity typehash.
 *   4. Re-pin the expected digest in `prototype/schemas/eip712_fixture.json`.
 *   5. Re-run the parity tests.
 */
import { encodeAbiParameters, hashTypedData, keccak256, type TypedDataDomain } from "viem";
import type {
  Claim,
  EffectClass,
  EffectReceipt,
  Hex20,
  Hex32,
  Provenance,
  RecoveryOutcome,
  RecoveryReceipt,
  RecourseContract,
  RouteHint,
} from "./types.gen.ts";

export const RECOURSE_DOMAIN_NAME = "Recourse" as const;
export const RECOURSE_DOMAIN_VERSION = "1" as const;

export interface RecourseDomainArgs {
  chainId: number;
  verifyingContract: Hex20;
}

export function recourseDomain(args: RecourseDomainArgs): TypedDataDomain {
  return {
    name: RECOURSE_DOMAIN_NAME,
    version: RECOURSE_DOMAIN_VERSION,
    chainId: args.chainId,
    verifyingContract: args.verifyingContract,
  };
}

export const EFFECT_RECEIPT_TYPES = {
  EffectReceipt: [
    { name: "schemaVersion", type: "uint8" },
    { name: "contractId", type: "bytes32" },
    { name: "jobId", type: "bytes32" },
    { name: "intentHash", type: "bytes32" },
    { name: "paramsHash", type: "bytes32" },
    { name: "resourceId", type: "bytes32" },
    { name: "preStateDigest", type: "bytes32" },
    { name: "postStateDigest", type: "bytes32" },
    { name: "providerReceiptHash", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
    { name: "adapterAddress", type: "address" },
  ],
} as const;

export const RECOVERY_RECEIPT_TYPES = {
  RecoveryReceipt: [
    { name: "schemaVersion", type: "uint8" },
    { name: "contractId", type: "bytes32" },
    { name: "effectReceiptHash", type: "bytes32" },
    { name: "compensatorAddress", type: "address" },
    { name: "restoreArtifactHash", type: "bytes32" },
    { name: "outcome", type: "uint8" },
    { name: "residualMeasurementsHash", type: "bytes32" },
    { name: "recoveryStartTs", type: "uint64" },
    { name: "recoveryEndTs", type: "uint64" },
  ],
} as const;

export const CLAIM_TYPES = {
  Claim: [
    { name: "schemaVersion", type: "uint8" },
    { name: "contractId", type: "bytes32" },
    { name: "jobId", type: "bytes32" },
    { name: "claimant", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "evidenceCidHash", type: "bytes32" },
    { name: "effectReceiptHash", type: "bytes32" },
    { name: "recoveryReceiptHash", type: "bytes32" },
    { name: "routeHint", type: "uint8" },
  ],
} as const;

export const RECOVERY_OUTCOME_CODES: Record<RecoveryOutcome, number> = {
  success: 0,
  partial: 1,
  failure: 2,
  inconclusive: 3,
};

export const ROUTE_HINT_CODES: Record<RouteHint, number> = {
  optimistic: 0,
  arbitrated: 1,
};

export const EFFECT_CLASS_CODES: Record<EffectClass, number> = {
  reversible: 0,
  compensable: 1,
  excluded: 2,
};

export const PROVENANCE_CODES: Record<Provenance, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
};

const ACTION_TEMPLATE_TYPEHASH = hashUtf8("ActionTemplate(string tool,string action)");
const RESOURCE_SCOPE_TYPEHASH = hashUtf8("ResourceScope(string scopeType,bytes32 descriptorHash)");
const RECOVERY_OPERATOR_TYPEHASH = hashUtf8(
  "RecoveryOperator(bytes32 compensatorId,uint64 freshnessSeconds,uint64 retentionSeconds,bytes32 authPolicyHash)",
);
const COVERED_LOSS_CLASS_TYPEHASH = hashUtf8("CoveredLossClass(bytes32 codesHash,bytes32 excludeListHash)");
const PAYOUT_RULE_TYPEHASH = hashUtf8("PayoutRule(bytes32 ruleType,bytes32 paramsHash,uint256 maxPayout)");
const BOND_TYPEHASH = hashUtf8("Bond(address asset,uint256 minAmount,uint256 maxAggregateExposure)");
const EVIDENCE_SCHEMA_TYPEHASH = hashUtf8(
  "EvidenceSchema(bytes32 schemaId,uint8 requiredProvenance,bytes32 accessPolicyHash)",
);
const DEADLINES_TYPEHASH = hashUtf8(
  "Deadlines(uint64 recoverySeconds,uint64 submissionSeconds,uint64 livenessSeconds)",
);
const DISPUTE_ROUTE_TYPEHASH = hashUtf8("DisputeRoute(address arbitrator,uint256 evidenceGroupId)");
const RECOURSE_CONTRACT_TYPEHASH = hashUtf8(
  "RecourseContract(uint8 schemaVersion,address operator,ActionTemplate actionTemplate,ResourceScope resourceScope,uint8 effectClass,RecoveryOperator recoveryOperator,CoveredLossClass coveredLossClass,PayoutRule payoutRule,Bond bond,EvidenceSchema evidenceSchema,Deadlines deadlines,DisputeRoute disputeRoute)ActionTemplate(string tool,string action)Bond(address asset,uint256 minAmount,uint256 maxAggregateExposure)CoveredLossClass(bytes32 codesHash,bytes32 excludeListHash)Deadlines(uint64 recoverySeconds,uint64 submissionSeconds,uint64 livenessSeconds)DisputeRoute(address arbitrator,uint256 evidenceGroupId)EvidenceSchema(bytes32 schemaId,uint8 requiredProvenance,bytes32 accessPolicyHash)PayoutRule(bytes32 ruleType,bytes32 paramsHash,uint256 maxPayout)RecoveryOperator(bytes32 compensatorId,uint64 freshnessSeconds,uint64 retentionSeconds,bytes32 authPolicyHash)ResourceScope(string scopeType,bytes32 descriptorHash)",
);

export interface HashEffectReceiptArgs {
  domain: RecourseDomainArgs;
  receipt: Omit<EffectReceipt, "signature">;
}

export interface HashRecoveryReceiptArgs {
  domain: RecourseDomainArgs;
  receipt: Omit<RecoveryReceipt, "signature">;
}

export interface HashClaimArgs {
  domain: RecourseDomainArgs;
  claim: Omit<Claim, "signature">;
}

export class NonCanonicalPayloadError extends Error {
  constructor(path: string, reason: string) {
    super(`non-canonical payload at ${path}: ${reason}`);
    this.name = "NonCanonicalPayloadError";
  }
}

export class UnsafeIntegerError extends Error {
  constructor(path: string, value: number) {
    super(`unsafe integer at ${path}: ${value}`);
    this.name = "UnsafeIntegerError";
  }
}

export function canonicalJson(value: unknown): string {
  assertJsonValue(value, "$");
  return JSON.stringify(sortCanonical(value));
}

export function hashCanonicalPayload(value: unknown): Hex32 {
  return keccak256(new TextEncoder().encode(canonicalJson(value))) as Hex32;
}

export function hashEvidenceCid(evidenceCid: string): Hex32 {
  return hashCanonicalPayload(evidenceCid);
}

export function hashResidualMeasurements(
  residualMeasurements: RecoveryReceipt["residualMeasurements"],
): Hex32 {
  return hashCanonicalPayload(residualMeasurements);
}

export function effectReceiptTypedData(args: HashEffectReceiptArgs) {
  const providerReceiptHash: Hex32 =
    args.receipt.providerReceiptHash ??
    ("0x0000000000000000000000000000000000000000000000000000000000000000" as Hex32);

  return {
    domain: recourseDomain(args.domain),
    types: EFFECT_RECEIPT_TYPES,
    primaryType: "EffectReceipt",
    message: {
      schemaVersion: args.receipt.schemaVersion,
      contractId: args.receipt.contractId,
      jobId: args.receipt.jobId,
      intentHash: args.receipt.intentHash,
      paramsHash: args.receipt.paramsHash,
      resourceId: args.receipt.resourceId,
      preStateDigest: args.receipt.preStateDigest,
      postStateDigest: args.receipt.postStateDigest,
      providerReceiptHash,
      timestamp: uint64(args.receipt.timestamp, "$.timestamp"),
      adapterAddress: args.receipt.adapterAddress,
    },
  } as const;
}

export function recoveryReceiptTypedData(args: HashRecoveryReceiptArgs) {
  return {
    domain: recourseDomain(args.domain),
    types: RECOVERY_RECEIPT_TYPES,
    primaryType: "RecoveryReceipt",
    message: {
      schemaVersion: args.receipt.schemaVersion,
      contractId: args.receipt.contractId,
      effectReceiptHash: args.receipt.effectReceiptHash,
      compensatorAddress: args.receipt.compensatorAddress,
      restoreArtifactHash: args.receipt.restoreArtifactHash,
      outcome: RECOVERY_OUTCOME_CODES[args.receipt.outcome],
      residualMeasurementsHash: hashResidualMeasurements(args.receipt.residualMeasurements),
      recoveryStartTs: uint64(args.receipt.recoveryStartTs, "$.recoveryStartTs"),
      recoveryEndTs: uint64(args.receipt.recoveryEndTs, "$.recoveryEndTs"),
    },
  } as const;
}

export function claimTypedData(args: HashClaimArgs) {
  return {
    domain: recourseDomain(args.domain),
    types: CLAIM_TYPES,
    primaryType: "Claim",
    message: {
      schemaVersion: args.claim.schemaVersion,
      contractId: args.claim.contractId,
      jobId: args.claim.jobId,
      claimant: args.claim.claimant,
      amount: BigInt(args.claim.amount),
      evidenceCidHash: hashEvidenceCid(args.claim.evidenceCid),
      effectReceiptHash: args.claim.effectReceiptHash,
      recoveryReceiptHash: args.claim.recoveryReceiptHash,
      routeHint: ROUTE_HINT_CODES[args.claim.routeHint],
    },
  } as const;
}

/**
 * Returns the EIP-712 final digest for an EffectReceipt.
 * Missing `providerReceiptHash` is normalized to bytes32(0).
 */
export function hashEffectReceipt(args: HashEffectReceiptArgs): Hex32 {
  return hashTypedData(effectReceiptTypedData(args)) as Hex32;
}

export function hashRecoveryReceipt(args: HashRecoveryReceiptArgs): Hex32 {
  return hashTypedData(recoveryReceiptTypedData(args)) as Hex32;
}

export function hashClaim(args: HashClaimArgs): Hex32 {
  return hashTypedData(claimTypedData(args)) as Hex32;
}

/**
 * Returns the registry `contractId`: the Solidity RecourseContract struct hash.
 *
 * The JSON schema includes `contractId` so stored examples can refer to their
 * on-chain id, but the on-chain struct deliberately excludes that field. This
 * function hashes the rest of canonical κ exactly as `RecourseRegistry.register`
 * does after projecting workload-specific JSON objects to bytes32 commits.
 */
export function hashRecourseContract(contract: RecourseContract): Hex32 {
  return hashAbi(
    [
      { type: "bytes32" },
      { type: "uint8" },
      { type: "address" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint8" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
    ],
    [
      RECOURSE_CONTRACT_TYPEHASH,
      contract.schemaVersion,
      addressBytes(contract.operator),
      actionTemplateStructHash(contract),
      resourceScopeStructHash(contract),
      EFFECT_CLASS_CODES[contract.effectClass],
      recoveryOperatorStructHash(contract),
      coveredLossClassStructHash(contract),
      payoutRuleStructHash(contract),
      bondStructHash(contract),
      evidenceSchemaStructHash(contract),
      deadlinesStructHash(contract),
      disputeRouteStructHash(contract),
    ],
  );
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      sorted[key] = sortCanonical(input[key]);
    }
    return sorted;
  }
  return value;
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null) return;

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new NonCanonicalPayloadError(path, "number must be finite");
      }
      return;
    case "object":
      if (Array.isArray(value)) {
        value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
        return;
      }
      if (!isPlainObject(value)) {
        throw new NonCanonicalPayloadError(path, "object must be a plain JSON object");
      }
      for (const [key, item] of Object.entries(value)) {
        assertJsonValue(item, `${path}.${key}`);
      }
      return;
    default:
      throw new NonCanonicalPayloadError(path, `${typeof value} is not valid JSON`);
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hashUtf8(value: string): Hex32 {
  return keccak256(new TextEncoder().encode(value)) as Hex32;
}

function actionTemplateStructHash(contract: RecourseContract): Hex32 {
  return hashAbi(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [ACTION_TEMPLATE_TYPEHASH, hashUtf8(contract.actionTemplate.tool), hashUtf8(contract.actionTemplate.action)],
  );
}

function resourceScopeStructHash(contract: RecourseContract): Hex32 {
  return hashAbi(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [
      RESOURCE_SCOPE_TYPEHASH,
      hashUtf8(contract.resourceScope.type),
      hashCanonicalPayload(contract.resourceScope.descriptor),
    ],
  );
}

function recoveryOperatorStructHash(contract: RecourseContract): Hex32 {
  const recovery = contract.recoveryOperator;
  return hashAbi(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" }, { type: "bytes32" }],
    [
      RECOVERY_OPERATOR_TYPEHASH,
      hashUtf8(recovery.compensatorId),
      uint64(recovery.freshnessSeconds, "$.recoveryOperator.freshnessSeconds"),
      uint64(recovery.retentionSeconds, "$.recoveryOperator.retentionSeconds"),
      recovery.authPolicyHash,
    ],
  );
}

function coveredLossClassStructHash(contract: RecourseContract): Hex32 {
  return hashAbi(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
    [
      COVERED_LOSS_CLASS_TYPEHASH,
      hashCanonicalPayload(contract.coveredLossClass.codes),
      hashCanonicalPayload(contract.coveredLossClass.excludeList),
    ],
  );
}

function payoutRuleStructHash(contract: RecourseContract): Hex32 {
  return hashAbi(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
    [
      PAYOUT_RULE_TYPEHASH,
      hashUtf8(contract.payoutRule.type),
      hashCanonicalPayload(contract.payoutRule.params),
      BigInt(contract.payoutRule.maxPayout),
    ],
  );
}

function bondStructHash(contract: RecourseContract): Hex32 {
  return hashAbi(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
    [
      BOND_TYPEHASH,
      addressBytes(contract.bond.asset),
      BigInt(contract.bond.minAmount),
      BigInt(contract.bond.maxAggregateExposure),
    ],
  );
}

function evidenceSchemaStructHash(contract: RecourseContract): Hex32 {
  const evidence = contract.evidenceSchema;
  return hashAbi(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }],
    [
      EVIDENCE_SCHEMA_TYPEHASH,
      evidence.schemaId,
      PROVENANCE_CODES[evidence.requiredProvenance],
      evidence.accessPolicyHash,
    ],
  );
}

function deadlinesStructHash(contract: RecourseContract): Hex32 {
  const deadlines = contract.deadlines;
  return hashAbi(
    [{ type: "bytes32" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }],
    [
      DEADLINES_TYPEHASH,
      uint64(deadlines.recoverySeconds, "$.deadlines.recoverySeconds"),
      uint64(deadlines.submissionSeconds, "$.deadlines.submissionSeconds"),
      uint64(deadlines.livenessSeconds, "$.deadlines.livenessSeconds"),
    ],
  );
}

function disputeRouteStructHash(contract: RecourseContract): Hex32 {
  return hashAbi(
    [{ type: "bytes32" }, { type: "address" }, { type: "uint256" }],
    [DISPUTE_ROUTE_TYPEHASH, addressBytes(contract.disputeRoute.arbitrator), BigInt(contract.disputeRoute.evidenceGroupId)],
  );
}

function hashAbi(parameters: readonly { type: string }[], values: readonly unknown[]): Hex32 {
  return keccak256(encodeAbiParameters(parameters as never, values as never)) as Hex32;
}

function addressBytes(value: Hex20): Hex20 {
  return value.toLowerCase() as Hex20;
}

function uint64(value: number, path: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UnsafeIntegerError(path, value);
  }
  return BigInt(value);
}
