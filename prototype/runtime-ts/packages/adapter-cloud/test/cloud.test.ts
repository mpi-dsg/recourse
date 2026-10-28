import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type ToolCall } from "../../adapter-sdk/src/index.ts";
import { verifyEffectReceipt, type Hex20, type Hex32 } from "../../receipts/src/index.ts";
import { adapterAccount as signer } from "../../receipts/test/helpers.ts";
import { CloudAdapter, LocalStackSsmCloudClient } from "../src/index.ts";

const endpoint = process.env.RECOURSE_LOCALSTACK_URL;
const skip = !endpoint;

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};
const contractId =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32;
const jobId = "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex32;
const txHash = "0x9999000000000000000000000000000000000000000000000000000000000001" as Hex32;

let client: LocalStackSsmCloudClient | undefined;

beforeAll(() => {
  if (skip) return;
  client = new LocalStackSsmCloudClient({ endpoint: endpoint! });
});

beforeEach(
  async () => {
    if (skip) return;
    await client!.deleteParameter("/recourse/test/app-config");
    await client!.putParameter("/recourse/test/app-config", "{\"replicas\":2}");
  },
  20_000,
);

afterAll(async () => {
  if (skip || !client) return;
  await client.deleteParameter("/recourse/test/app-config");
});

function adapter(): CloudAdapter {
  return new CloudAdapter({
    domain,
    signer,
    adapterAddress: signer.address as Hex20,
    now: () => 1_746_979_200,
    recordToChain: async () => txHash,
    client: client!,
    allowedResources: ["/recourse/test/app-config"],
  });
}

describe.skipIf(skip)("CloudAdapter (LocalStack SSM)", () => {
  it("set-parameter updates the live parameter and signs a verifiable receipt", async () => {
    const call: ToolCall = {
      contractId,
      jobId,
      tool: "cloud",
      action: "set-parameter",
      params: {
        resourceId: "/recourse/test/app-config",
        config: { value: "{\"replicas\":99}" },
      },
      resource: { resourceId: "/recourse/test/app-config" },
    };
    const result = await adapter().run(call);

    expect(result.providerOutcome.previous).toBe("{\"replicas\":2}");
    expect(result.providerOutcome.next).toBe("{\"replicas\":99}");
    await expect(verifyEffectReceipt({ domain, receipt: result.receipt })).resolves.toBe(true);

    const after = await client!.getParameter("/recourse/test/app-config");
    expect(after?.value).toBe("{\"replicas\":99}");
  });

  it("delete-parameter removes the live parameter", async () => {
    const call: ToolCall = {
      contractId,
      jobId,
      tool: "cloud",
      action: "delete-parameter",
      params: {
        resourceId: "/recourse/test/app-config",
        config: { value: "" },
      },
      resource: { resourceId: "/recourse/test/app-config" },
    };
    const result = await adapter().run(call);
    expect(result.providerOutcome.next).toBeNull();
    expect(await client!.getParameter("/recourse/test/app-config")).toBeNull();
  });
});
