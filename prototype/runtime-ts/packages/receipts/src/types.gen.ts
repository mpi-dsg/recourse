/**
 * Recourse canonical types — TypeScript projection.
 *
 * Mirror of `prototype/schemas/*.v1.json`. The Solidity projection lives in
 * `prototype/contracts/src/Types.sol`; both must move together when the
 * schema changes. The parity verifier in `prototype/schemas/verify_parity.py`
 * checks that every field listed in the JSON schemas appears here and in
 * Types.sol.
 *
 * Do not hand-edit without bumping SCHEMA_VERSIONS.md.
 */

export const SCHEMA_VERSION_TYPES = 1 as const;

export type Hex32 = `0x${string}`; // 32-byte hex (66 chars)
export type Hex20 = `0x${string}`; // 20-byte hex (42 chars)
export type HexSig = `0x${string}`; // 65-byte hex (132 chars)
export type DecimalString = string; // base-10 uint256 as decimal string

export type EffectClass = "reversible" | "compensable" | "excluded";

export type Provenance = "L0" | "L1" | "L2";

export type RecoveryOutcome = "success" | "partial" | "failure" | "inconclusive";

export type RouteHint = "optimistic" | "arbitrated";

export type LossCode =
  | "rows_deleted"
  | "rows_modified"
  | "downtime_seconds"
  | "manual_recovery_effort"
  | "excess_spend_usd"
  | "history_bytes_lost";

export type ExcludedHarmCode =
  | "data_exfiltration"
  | "public_disclosure"
  | "irreversible_transfer"
  | "physical_action"
  | "reputation_damage"
  | "uncapped_downstream";

export type EvidenceSourceCode =
  | "provider-receipt"
  | "snapshot-diff"
  | "cost-explorer"
  | "reflog"
  | "compensator-attested";

export interface ActionTemplate {
  tool: "postgres" | "git" | "cloud";
  action: string;
}

export interface ResourceScope {
  type: "postgres-table" | "git-ref" | "cloud-resource";
  descriptor: Record<string, unknown>;
}

export interface RecoveryOperatorSpec {
  compensatorId: string;
  freshnessSeconds: number;
  retentionSeconds: number;
  authPolicyHash: Hex32;
}

export interface CoveredLossClass {
  codes: LossCode[];
  excludeList: ExcludedHarmCode[];
}

export interface PayoutRule {
  type: "rowCountSchedule" | "downtimeSchedule" | "excessSpendSchedule" | "composite";
  params: Record<string, unknown>;
  maxPayout: DecimalString;
}

export interface BondSpec {
  asset: Hex20;
  minAmount: DecimalString;
  maxAggregateExposure: DecimalString;
}

export interface EvidenceSchemaSpec {
  schemaId: Hex32;
  requiredProvenance: Provenance;
  accessPolicyHash: Hex32;
}

export interface Deadlines {
  recoverySeconds: number;
  submissionSeconds: number;
  livenessSeconds: number;
}

export interface DisputeRoute {
  arbitrator: Hex20;
  evidenceGroupId: DecimalString;
}

export interface RecourseContract {
  schemaVersion: 1;
  contractId: Hex32;
  operator: Hex20;
  actionTemplate: ActionTemplate;
  resourceScope: ResourceScope;
  effectClass: "compensable";
  recoveryOperator: RecoveryOperatorSpec;
  coveredLossClass: CoveredLossClass;
  payoutRule: PayoutRule;
  bond: BondSpec;
  evidenceSchema: EvidenceSchemaSpec;
  deadlines: Deadlines;
  disputeRoute: DisputeRoute;
}

export interface EffectReceipt {
  schemaVersion: 1;
  contractId: Hex32;
  jobId: Hex32;
  intentHash: Hex32;
  paramsHash: Hex32;
  resourceId: Hex32;
  preStateDigest: Hex32;
  postStateDigest: Hex32;
  providerReceiptHash?: Hex32;
  timestamp: number;
  adapterAddress: Hex20;
  signature: HexSig;
}

export interface ResidualMeasurement {
  value: DecimalString;
  evidenceSource: EvidenceSourceCode;
  artifactHash?: Hex32;
}

export interface RecoveryReceipt {
  schemaVersion: 1;
  contractId: Hex32;
  effectReceiptHash: Hex32;
  compensatorAddress: Hex20;
  restoreArtifactHash: Hex32;
  outcome: RecoveryOutcome;
  residualMeasurements: Record<string, ResidualMeasurement>;
  recoveryStartTs: number;
  recoveryEndTs: number;
  signature: HexSig;
}

export interface Claim {
  schemaVersion: 1;
  contractId: Hex32;
  jobId: Hex32;
  claimant: Hex20;
  amount: DecimalString;
  evidenceCid: string;
  effectReceiptHash: Hex32;
  recoveryReceiptHash: Hex32;
  routeHint: RouteHint;
  signature: HexSig;
}
