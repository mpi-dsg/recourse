import { describe, expect, it } from "bun:test";
import { hashEvidence } from "../../../evidence-store/src/index.ts";
import { signEffectReceipt, type EffectReceipt, type Hex20, type Hex32, type RecourseContract } from "../../../receipts/src/index.ts";
import { adapterAccount as adapter, compensatorAccount as compensator } from "../../../receipts/test/helpers.ts";
import { MemoryGitCompensator } from "../src/index.ts";

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};
const contract = {
  schemaVersion: 1,
  contractId: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32,
  operator: "0x000000000000000000000000000000000000bEEF" as Hex20,
  actionTemplate: { tool: "git", action: "force-push" },
  resourceScope: { type: "git-ref", descriptor: { ref: "refs/heads/main" } },
  effectClass: "compensable",
  recoveryOperator: { compensatorId: "git", freshnessSeconds: 60, retentionSeconds: 3600, authPolicyHash: hashEvidence("auth").hash },
  coveredLossClass: { codes: ["history_bytes_lost"], excludeList: [] },
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
      resourceId: hashEvidence("refs/heads/main").hash,
      preStateDigest: hashEvidence("pre").hash,
      postStateDigest: hashEvidence("post").hash,
      timestamp: 1746979200,
      adapterAddress: adapter.address as Hex20,
    },
  });
}

describe("MemoryGitCompensator", () => {
  it("restores backup ref and reports restored history", async () => {
    const sdk = new MemoryGitCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1746979210,
      refs: { "refs/heads/main": "bbbbbbbb" },
      backup: { ref: "refs/heads/main", oid: "aaaaaaaa", bytesRestored: 300 },
    });

    const receipt = await sdk.recover(await effect());

    expect(sdk.refs["refs/heads/main"]).toBe("aaaaaaaa");
    expect(receipt.outcome).toBe("success");
    expect(receipt.residualMeasurements.history_bytes_lost?.value).toBe("0");
  });

  it("does not restore refs outside the contract scope", async () => {
    const sdk = new MemoryGitCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1746979210,
      refs: { "refs/heads/main": "bbbbbbbb", "refs/heads/release": "cccccccc" },
      backup: { ref: "refs/heads/release", oid: "aaaaaaaa", bytesRestored: 300 },
    });

    const receipt = await sdk.recover(await effect());

    expect(sdk.refs["refs/heads/release"]).toBe("cccccccc");
    expect(receipt.outcome).toBe("failure");
    expect(receipt.residualMeasurements.out_of_scope_recovery?.value).toBe("1");
  });
});
