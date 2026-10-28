import { describe, expect, it } from "bun:test";
import { hashEvidence } from "../../../evidence-store/src/index.ts";
import {
  signEffectReceipt,
  verifyRecoveryReceipt,
  type EffectReceipt,
  type Hex20,
  type Hex32,
  type RecourseContract,
} from "../../../receipts/src/index.ts";
import {
  adapterAccount as adapter,
  compensatorAccount as compensator,
} from "../../../receipts/test/helpers.ts";
import {
  CloudClientError,
  type CloudClient,
  type CloudParameter,
} from "../../../adapter-cloud/src/index.ts";
import { CloudCompensator } from "../src/index.ts";

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};

const contract: RecourseContract = {
  schemaVersion: 1,
  contractId: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32,
  operator: "0x000000000000000000000000000000000000bEEF" as Hex20,
  actionTemplate: { tool: "cloud", action: "set-parameter" },
  resourceScope: {
    type: "cloud-resource",
    descriptor: { service: "ssm", resourceId: "/recourse/test/app-config" },
  },
  effectClass: "compensable",
  recoveryOperator: {
    compensatorId: "cloud",
    freshnessSeconds: 60,
    retentionSeconds: 3600,
    authPolicyHash: hashEvidence("auth").hash,
  },
  coveredLossClass: { codes: ["excess_spend_usd"], excludeList: [] },
  payoutRule: { type: "excessSpendSchedule", params: {}, maxPayout: "1000" },
  bond: {
    asset: "0x0000000000000000000000000000000000000001",
    minAmount: "1000",
    maxAggregateExposure: "1000",
  },
  evidenceSchema: {
    schemaId: hashEvidence("schema").hash,
    requiredProvenance: "L1",
    accessPolicyHash: hashEvidence("access").hash,
  },
  deadlines: { recoverySeconds: 60, submissionSeconds: 300, livenessSeconds: 600 },
  disputeRoute: { arbitrator: "0x0000000000000000000000000000000000000002", evidenceGroupId: "1" },
};

async function effect(timestamp = 1_746_979_200): Promise<EffectReceipt> {
  return signEffectReceipt({
    domain,
    signer: adapter,
    receipt: {
      schemaVersion: 1,
      contractId: contract.contractId,
      jobId: "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex32,
      intentHash: hashEvidence("intent").hash,
      paramsHash: hashEvidence("params").hash,
      resourceId: hashEvidence("/recourse/test/app-config").hash,
      preStateDigest: hashEvidence("pre").hash,
      postStateDigest: hashEvidence("post").hash,
      timestamp,
      adapterAddress: adapter.address as Hex20,
    },
  });
}

class MockCloudClient implements CloudClient {
  public store: Record<string, CloudParameter | undefined>;
  public failPut = false;
  constructor(seed: Record<string, CloudParameter | undefined> = {}) {
    this.store = { ...seed };
  }
  async getParameter(name: string): Promise<CloudParameter | null> {
    return this.store[name] ?? null;
  }
  async putParameter(name: string, value: string): Promise<CloudParameter> {
    if (this.failPut) throw new CloudClientError("put failed");
    const next = { name, value };
    this.store[name] = next;
    return next;
  }
  async deleteParameter(name: string): Promise<void> {
    delete this.store[name];
  }
}

describe("CloudCompensator (mock client)", () => {
  it("restores the parameter to the backup value and reports zero excess spend", async () => {
    const client = new MockCloudClient({
      "/recourse/test/app-config": {
        name: "/recourse/test/app-config",
        value: "{\"replicas\":99}",
      },
    });
    const sdk = new CloudCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1_746_979_210,
      client,
      resourceId: "/recourse/test/app-config",
      restoreValue: "{\"replicas\":2}",
    });

    const receipt = await sdk.recover(await effect());
    expect(receipt.outcome).toBe("success");
    expect(receipt.residualMeasurements?.excess_spend_usd?.value).toBe("0");
    expect(client.store["/recourse/test/app-config"]?.value).toBe("{\"replicas\":2}");
    await expect(verifyRecoveryReceipt({ domain, receipt })).resolves.toBe(true);
  });

  it("reports partial when there is residual excess spend", async () => {
    const client = new MockCloudClient({
      "/recourse/test/app-config": {
        name: "/recourse/test/app-config",
        value: "{\"replicas\":99}",
      },
    });
    const sdk = new CloudCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1_746_979_210,
      client,
      resourceId: "/recourse/test/app-config",
      restoreValue: "{\"replicas\":2}",
      excessSpendUsd: "42",
    });
    const receipt = await sdk.recover(await effect());
    expect(receipt.outcome).toBe("partial");
    expect(receipt.residualMeasurements?.excess_spend_usd?.value).toBe("42");
  });

  it("emits a failure receipt when putParameter fails", async () => {
    const client = new MockCloudClient({
      "/recourse/test/app-config": {
        name: "/recourse/test/app-config",
        value: "{\"replicas\":99}",
      },
    });
    client.failPut = true;
    const sdk = new CloudCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1_746_979_210,
      client,
      resourceId: "/recourse/test/app-config",
      restoreValue: "{\"replicas\":2}",
    });
    const receipt = await sdk.recover(await effect());
    expect(receipt.outcome).toBe("failure");
    expect(client.store["/recourse/test/app-config"]?.value).toBe("{\"replicas\":99}");
  });

  it("rejects an invalid parameter name at construction", () => {
    const client = new MockCloudClient();
    expect(
      () =>
        new CloudCompensator({
          contract,
          domain,
          signer: compensator,
          compensatorAddress: compensator.address as Hex20,
          client,
          resourceId: "",
          restoreValue: "",
        }),
    ).toThrow(CloudClientError);
  });
});
