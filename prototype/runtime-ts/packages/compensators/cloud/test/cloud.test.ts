import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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
import { LocalStackSsmCloudClient } from "../../../adapter-cloud/src/index.ts";
import { CloudCompensator } from "../src/index.ts";

const endpoint = process.env.RECOURSE_LOCALSTACK_URL;
const skip = !endpoint;

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

let client: LocalStackSsmCloudClient | undefined;

beforeAll(() => {
  if (skip) return;
  client = new LocalStackSsmCloudClient({ endpoint: endpoint! });
});

beforeEach(
  async () => {
    if (skip) return;
    await client!.deleteParameter("/recourse/test/app-config");
    await client!.putParameter("/recourse/test/app-config", "{\"replicas\":99}");
  },
  20_000,
);

afterAll(async () => {
  if (skip || !client) return;
  await client.deleteParameter("/recourse/test/app-config");
});

describe.skipIf(skip)("CloudCompensator (LocalStack SSM)", () => {
  it("restores the parameter to the configured backup value", async () => {
    const sdk = new CloudCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1_746_979_210,
      client: client!,
      resourceId: "/recourse/test/app-config",
      restoreValue: "{\"replicas\":2}",
    });

    const receipt = await sdk.recover(await effect());
    expect(receipt.outcome).toBe("success");
    await expect(verifyRecoveryReceipt({ domain, receipt })).resolves.toBe(true);

    const after = await client!.getParameter("/recourse/test/app-config");
    expect(after?.value).toBe("{\"replicas\":2}");
  });
});
