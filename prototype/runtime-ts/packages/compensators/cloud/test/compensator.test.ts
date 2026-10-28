import { describe, expect, it } from "bun:test";
import { hashEvidence } from "../../../evidence-store/src/index.ts";
import { signEffectReceipt, type EffectReceipt, type Hex20, type Hex32, type RecourseContract } from "../../../receipts/src/index.ts";
import { adapterAccount as adapter, compensatorAccount as compensator } from "../../../receipts/test/helpers.ts";
import { MemoryCloudCompensator } from "../src/index.ts";

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};
const contract = {
  schemaVersion: 1,
  contractId: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32,
  operator: "0x000000000000000000000000000000000000bEEF" as Hex20,
  actionTemplate: { tool: "cloud", action: "set-capacity" },
  resourceScope: { type: "cloud-resource", descriptor: { resourceId: "asg:web" } },
  effectClass: "compensable",
  recoveryOperator: { compensatorId: "cloud", freshnessSeconds: 60, retentionSeconds: 3600, authPolicyHash: hashEvidence("auth").hash },
  coveredLossClass: { codes: ["excess_spend_usd"], excludeList: [] },
  payoutRule: { type: "excessSpendSchedule", params: {}, maxPayout: "1000" },
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
      resourceId: hashEvidence("asg:web").hash,
      preStateDigest: hashEvidence("pre").hash,
      postStateDigest: hashEvidence("post").hash,
      timestamp: 1746979200,
      adapterAddress: adapter.address as Hex20,
    },
  });
}

describe("MemoryCloudCompensator", () => {
  it("restores cloud config and reports bounded excess spend", async () => {
    const sdk = new MemoryCloudCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1746979210,
      resources: { "asg:web": { min: 0, max: 12 } },
      restore: { resourceId: "asg:web", config: { min: 2, max: 4 }, excessSpendUsd: "12" },
    });

    const receipt = await sdk.recover(await effect());

    expect(sdk.resources["asg:web"]).toEqual({ min: 2, max: 4 });
    expect(receipt.outcome).toBe("partial");
    expect(receipt.residualMeasurements.excess_spend_usd?.value).toBe("12");
  });

  it("does not restore cloud resources outside the contract scope", async () => {
    const sdk = new MemoryCloudCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1746979210,
      resources: {
        "asg:web": { min: 0, max: 12 },
        "asg:admin": { min: 6, max: 20 },
      },
      restore: { resourceId: "asg:admin", config: { min: 2, max: 4 }, excessSpendUsd: "0" },
    });

    const receipt = await sdk.recover(await effect());

    expect(sdk.resources["asg:admin"]).toEqual({ min: 6, max: 20 });
    expect(receipt.outcome).toBe("failure");
    expect(receipt.residualMeasurements.out_of_scope_recovery?.value).toBe("1");
  });
});
