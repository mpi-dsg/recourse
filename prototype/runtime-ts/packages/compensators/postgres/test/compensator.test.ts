import { describe, expect, it } from "bun:test";
import { hashEvidence } from "../../../evidence-store/src/index.ts";
import { signEffectReceipt, verifyRecoveryReceipt, type EffectReceipt, type Hex20, type Hex32, type RecourseContract } from "../../../receipts/src/index.ts";
import { adapterAccount as adapter, compensatorAccount as compensator } from "../../../receipts/test/helpers.ts";
import { MemoryPostgresCompensator } from "../src/index.ts";

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};
const contract = {
  schemaVersion: 1,
  contractId: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32,
  operator: "0x000000000000000000000000000000000000bEEF" as Hex20,
  actionTemplate: { tool: "postgres", action: "delete" },
  resourceScope: { type: "postgres-table", descriptor: { table: "tenant_rows" } },
  effectClass: "compensable",
  recoveryOperator: { compensatorId: "postgres", freshnessSeconds: 60, retentionSeconds: 3600, authPolicyHash: hashEvidence("auth").hash },
  coveredLossClass: { codes: ["rows_deleted"], excludeList: [] },
  payoutRule: { type: "rowCountSchedule", params: {}, maxPayout: "1000" },
  bond: { asset: "0x0000000000000000000000000000000000000001", minAmount: "1000", maxAggregateExposure: "1000" },
  evidenceSchema: { schemaId: hashEvidence("schema").hash, requiredProvenance: "L1", accessPolicyHash: hashEvidence("access").hash },
  deadlines: { recoverySeconds: 60, submissionSeconds: 300, livenessSeconds: 600 },
  disputeRoute: { arbitrator: "0x0000000000000000000000000000000000000002", evidenceGroupId: "1" },
} satisfies RecourseContract;

async function effect(): Promise<EffectReceipt> {
  return signEffectReceipt({
    domain,
    signer: adapter,
    receipt: {
      schemaVersion: 1,
      contractId: contract.contractId,
      jobId: "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex32,
      intentHash: hashEvidence("intent").hash,
      paramsHash: hashEvidence("params").hash,
      resourceId: hashEvidence("tenant_rows").hash,
      preStateDigest: hashEvidence("pre").hash,
      postStateDigest: hashEvidence("post").hash,
      timestamp: 1746979200,
      adapterAddress: adapter.address as Hex20,
    },
  });
}

describe("MemoryPostgresCompensator", () => {
  it("restores deleted rows and emits success receipt", async () => {
    const sdk = new MemoryPostgresCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1746979210,
      table: { rows: [{ id: 3, tenantId: "tenant-b" }] },
      restoreRows: [
        { id: 1, tenantId: "tenant-a" },
        { id: 2, tenantId: "tenant-a" },
      ],
      expectedRecoveredRows: 2,
    });

    const receipt = await sdk.recover(await effect());

    expect(sdk.rows).toHaveLength(3);
    expect(receipt.outcome).toBe("success");
    expect(receipt.residualMeasurements.rows_deleted?.value).toBe("0");
    await expect(verifyRecoveryReceipt({ domain, receipt })).resolves.toBe(true);
  });

  it("does not restore rows outside the contract table scope", async () => {
    const sdk = new MemoryPostgresCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1746979210,
      table: { rows: [{ id: 3, tenantId: "tenant-b" }] },
      tableName: "audit_logs",
      restoreRows: [{ id: 1, tenantId: "tenant-a" }],
      expectedRecoveredRows: 1,
    });

    const receipt = await sdk.recover(await effect());

    expect(sdk.rows).toHaveLength(1);
    expect(receipt.outcome).toBe("failure");
    expect(receipt.residualMeasurements.out_of_scope_recovery?.value).toBe("1");
  });
});
