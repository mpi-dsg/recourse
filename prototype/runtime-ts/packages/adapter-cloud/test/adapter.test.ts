import { describe, expect, it } from "bun:test";
import { AdapterScopeError, type ToolCall } from "../../adapter-sdk/src/index.ts";
import { verifyEffectReceipt, type Hex20, type Hex32 } from "../../receipts/src/index.ts";
import { adapterAccount as signer } from "../../receipts/test/helpers.ts";
import { cloudResourceDigest, MemoryCloudAdapter } from "../src/index.ts";

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};
const txHash = "0x9999000000000000000000000000000000000000000000000000000000000001" as Hex32;

describe("MemoryCloudAdapter", () => {
  it("configuration change emits deterministic resource digest and receipt", async () => {
    const adapter = new MemoryCloudAdapter({
      domain,
      signer,
      adapterAddress: signer.address as Hex20,
      now: () => 1746979200,
      recordToChain: async () => txHash,
      resources: {
        "asg:web": { kind: "autoscaling-group", config: { min: 2, max: 4 } },
      },
    });
    const call: ToolCall = {
      contractId: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32,
      jobId: "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex32,
      tool: "cloud",
      action: "set-capacity",
      params: { resourceId: "asg:web", config: { min: 0, max: 12 } },
      resource: { resourceId: "asg:web" },
    };

    const result = await adapter.run(call);

    expect(result.providerOutcome.previous).toEqual({ min: 2, max: 4 });
    expect(result.receipt.postStateDigest).toBe(
      cloudResourceDigest({ resourceId: "asg:web", kind: "autoscaling-group", config: { min: 0, max: 12 } }),
    );
    await expect(verifyEffectReceipt({ domain, receipt: result.receipt })).resolves.toBe(true);
  });

  it("rejects mismatched resource params and receipt scope", async () => {
    const adapter = new MemoryCloudAdapter({
      domain,
      signer,
      adapterAddress: signer.address as Hex20,
      recordToChain: async () => txHash,
      resources: {
        "asg:web": { kind: "autoscaling-group", config: { min: 2, max: 4 } },
        "asg:admin": { kind: "autoscaling-group", config: { min: 1, max: 2 } },
      },
    });
    const call: ToolCall = {
      contractId: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32,
      jobId: "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex32,
      tool: "cloud",
      action: "set-capacity",
      params: { resourceId: "asg:admin", config: { min: 0, max: 12 } },
      resource: { resourceId: "asg:web" },
    };

    await expect(adapter.run(call)).rejects.toThrow(AdapterScopeError);
  });
});
