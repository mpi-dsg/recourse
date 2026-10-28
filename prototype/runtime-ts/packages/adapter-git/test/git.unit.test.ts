import { describe, expect, it } from "bun:test";
import { AdapterScopeError, type ToolCall } from "../../adapter-sdk/src/index.ts";
import { verifyEffectReceipt, type Hex20, type Hex32 } from "../../receipts/src/index.ts";
import { adapterAccount as signer } from "../../receipts/test/helpers.ts";
import { GitAdapter, realGitRefDigest, type GitClient } from "../src/index.ts";

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};
const contractId =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32;
const jobId = "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex32;
const txHash = "0x9999000000000000000000000000000000000000000000000000000000000001" as Hex32;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

class MockGitClient implements GitClient {
  public readonly refs: Record<string, string>;
  public readonly sizes: Record<string, number>;
  public readonly calls: Array<[string, ...unknown[]]> = [];

  constructor(
    refs: Record<string, string> = {},
    sizes: Record<string, number> = {},
  ) {
    this.refs = { ...refs };
    this.sizes = { ...sizes };
  }

  async revParse(ref: string): Promise<string | null> {
    this.calls.push(["revParse", ref]);
    return this.refs[ref] ?? null;
  }

  async updateRef(ref: string, sha: string, expected?: string): Promise<void> {
    this.calls.push(["updateRef", ref, sha, expected]);
    this.refs[ref] = sha;
  }

  async deleteRef(ref: string): Promise<void> {
    this.calls.push(["deleteRef", ref]);
    delete this.refs[ref];
  }

  async commitObjectSize(sha: string): Promise<number> {
    this.calls.push(["commitObjectSize", sha]);
    return this.sizes[sha] ?? 0;
  }
}

function adapter(client: MockGitClient): GitAdapter {
  return new GitAdapter({
    domain,
    signer,
    adapterAddress: signer.address as Hex20,
    now: () => 1_746_979_200,
    recordToChain: async () => txHash,
    client,
    repo: "demo",
    allowedRefs: ["refs/heads/main"],
  });
}

function forcePush(to: string): ToolCall {
  return {
    contractId,
    jobId,
    tool: "git",
    action: "force-push",
    params: { ref: "refs/heads/main", to },
    resource: { repo: "demo", ref: "refs/heads/main" },
  };
}

function deleteRef(): ToolCall {
  return {
    contractId,
    jobId,
    tool: "git",
    action: "delete-ref",
    params: { ref: "refs/heads/main" },
    resource: { repo: "demo", ref: "refs/heads/main" },
  };
}

describe("GitAdapter (mock client)", () => {
  it("force-push updates the ref and emits a verifiable receipt", async () => {
    const client = new MockGitClient({ "refs/heads/main": SHA_A }, { [SHA_A]: 1200, [SHA_B]: 900 });
    const result = await adapter(client).run(forcePush(SHA_B));

    expect(client.refs["refs/heads/main"]).toBe(SHA_B);
    expect(result.providerOutcome.previous).toBe(SHA_A);
    expect(result.providerOutcome.next).toBe(SHA_B);
    expect(result.providerOutcome.bytesOfHistoryChanged).toBe(300);
    expect(result.post.postStateDigest).toBe(
      realGitRefDigest({ repo: "demo", ref: "refs/heads/main", oid: SHA_B }),
    );
    await expect(verifyEffectReceipt({ domain, receipt: result.receipt })).resolves.toBe(true);
  });

  it("delete-ref removes the ref and records the lost commit size", async () => {
    const client = new MockGitClient({ "refs/heads/main": SHA_A }, { [SHA_A]: 1200 });
    const result = await adapter(client).run(deleteRef());

    expect(client.refs["refs/heads/main"]).toBeUndefined();
    expect(result.providerOutcome.next).toBeNull();
    expect(result.providerOutcome.bytesOfHistoryChanged).toBe(1200);
    expect(result.post.postStateDigest).toBe(
      realGitRefDigest({ repo: "demo", ref: "refs/heads/main", oid: null }),
    );
  });

  it("rejects refs outside allowedRefs", async () => {
    const client = new MockGitClient();
    const call: ToolCall = {
      ...forcePush(SHA_B),
      params: { ref: "refs/heads/release", to: SHA_B },
      resource: { repo: "demo", ref: "refs/heads/release" },
    };
    await expect(adapter(client).run(call)).rejects.toThrow(AdapterScopeError);
  });

  it("rejects resource pointing at the wrong repo", async () => {
    const client = new MockGitClient({ "refs/heads/main": SHA_A });
    const call: ToolCall = {
      ...forcePush(SHA_B),
      resource: { repo: "wrong-repo", ref: "refs/heads/main" },
    };
    await expect(adapter(client).run(call)).rejects.toThrow(AdapterScopeError);
  });

  it("rejects mismatched params and resource refs", async () => {
    const client = new MockGitClient({ "refs/heads/main": SHA_A });
    const call: ToolCall = {
      ...forcePush(SHA_B),
      params: { ref: "refs/heads/release", to: SHA_B },
    };
    await expect(adapter(client).run(call)).rejects.toThrow(AdapterScopeError);
  });

  it("rejects force-push to an invalid sha", async () => {
    const client = new MockGitClient({ "refs/heads/main": SHA_A });
    await expect(adapter(client).run(forcePush("not-a-sha"))).rejects.toThrow();
  });

  it("rejects unsupported actions", async () => {
    const client = new MockGitClient({ "refs/heads/main": SHA_A });
    const call: ToolCall = {
      ...forcePush(SHA_B),
      action: "rebase",
    };
    await expect(adapter(client).run(call)).rejects.toThrow(AdapterScopeError);
  });

  it("rejects delete on a non-existent ref", async () => {
    const client = new MockGitClient();
    await expect(adapter(client).run(deleteRef())).rejects.toThrow(AdapterScopeError);
  });
});
