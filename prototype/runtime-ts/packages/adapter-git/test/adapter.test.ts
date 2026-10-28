import { describe, expect, it } from "bun:test";
import { AdapterScopeError, type ToolCall } from "../../adapter-sdk/src/index.ts";
import { verifyEffectReceipt, type Hex20, type Hex32 } from "../../receipts/src/index.ts";
import { adapterAccount as signer } from "../../receipts/test/helpers.ts";
import { gitRefDigest, MemoryGitAdapter } from "../src/index.ts";

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};
const txHash = "0x9999000000000000000000000000000000000000000000000000000000000001" as Hex32;

describe("MemoryGitAdapter", () => {
  it("force-push emits deterministic ref digests and receipt", async () => {
    const adapter = new MemoryGitAdapter({
      domain,
      signer,
      adapterAddress: signer.address as Hex20,
      now: () => 1746979200,
      recordToChain: async () => txHash,
      refs: { "refs/heads/main": "aaaaaaaa" },
      commitSizes: { aaaaaaaa: 1200, bbbbbbbb: 900 },
    });
    const call: ToolCall = {
      contractId: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32,
      jobId: "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex32,
      tool: "git",
      action: "force-push",
      params: { ref: "refs/heads/main", to: "bbbbbbbb" },
      resource: { repo: "demo", ref: "refs/heads/main" },
    };

    const result = await adapter.run(call);

    expect(result.providerOutcome.bytesOfHistoryChanged).toBe(300);
    expect(result.receipt.postStateDigest).toBe(
      gitRefDigest({ repo: "demo", ref: "refs/heads/main", oid: "bbbbbbbb" }),
    );
    await expect(verifyEffectReceipt({ domain, receipt: result.receipt })).resolves.toBe(true);
  });

  it("rejects mismatched ref params and resource scope", async () => {
    const adapter = new MemoryGitAdapter({
      domain,
      signer,
      adapterAddress: signer.address as Hex20,
      recordToChain: async () => txHash,
      refs: { "refs/heads/main": "aaaaaaaa", "refs/heads/release": "cccccccc" },
      commitSizes: { aaaaaaaa: 1200, bbbbbbbb: 900, cccccccc: 900 },
    });
    const call: ToolCall = {
      contractId: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32,
      jobId: "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex32,
      tool: "git",
      action: "force-push",
      params: { ref: "refs/heads/release", to: "bbbbbbbb" },
      resource: { repo: "demo", ref: "refs/heads/main" },
    };

    await expect(adapter.run(call)).rejects.toThrow(AdapterScopeError);
  });
});
