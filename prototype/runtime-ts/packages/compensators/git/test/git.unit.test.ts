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
import { GitClientError, type GitClient } from "../../../adapter-git/src/index.ts";
import { GitCompensator } from "../src/index.ts";

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const contract: RecourseContract = {
  schemaVersion: 1,
  contractId: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32,
  operator: "0x000000000000000000000000000000000000bEEF" as Hex20,
  actionTemplate: { tool: "git", action: "force-push" },
  resourceScope: { type: "git-ref", descriptor: { repo: "demo", ref: "refs/heads/main" } },
  effectClass: "compensable",
  recoveryOperator: {
    compensatorId: "git",
    freshnessSeconds: 60,
    retentionSeconds: 3600,
    authPolicyHash: hashEvidence("auth").hash,
  },
  coveredLossClass: { codes: ["history_bytes_lost"], excludeList: [] },
  payoutRule: { type: "rowCountSchedule", params: {}, maxPayout: "1000" },
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
      resourceId: hashEvidence("refs/heads/main").hash,
      preStateDigest: hashEvidence("pre").hash,
      postStateDigest: hashEvidence("post").hash,
      timestamp,
      adapterAddress: adapter.address as Hex20,
    },
  });
}

class MockGitClient implements GitClient {
  public refs: Record<string, string>;
  public sizes: Record<string, number>;
  public failUpdate = false;

  constructor(refs: Record<string, string>, sizes: Record<string, number>) {
    this.refs = { ...refs };
    this.sizes = { ...sizes };
  }
  async revParse(ref: string): Promise<string | null> {
    return this.refs[ref] ?? null;
  }
  async updateRef(ref: string, sha: string): Promise<void> {
    if (this.failUpdate) throw new GitClientError("update-ref failed");
    this.refs[ref] = sha;
  }
  async deleteRef(ref: string): Promise<void> {
    delete this.refs[ref];
  }
  async commitObjectSize(sha: string): Promise<number> {
    return this.sizes[sha] ?? 0;
  }
}

describe("GitCompensator (mock client)", () => {
  it("restores the ref to the backup sha and reports bytes restored", async () => {
    const client = new MockGitClient({ "refs/heads/main": SHA_B }, { [SHA_A]: 1200 });
    const sdk = new GitCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1_746_979_210,
      client,
      ref: "refs/heads/main",
      backupSha: SHA_A,
    });
    const receipt = await sdk.recover(await effect());
    expect(receipt.outcome).toBe("success");
    expect(client.refs["refs/heads/main"]).toBe(SHA_A);
    expect(receipt.residualMeasurements?.history_bytes_restored?.value).toBe("1200");
    expect(receipt.residualMeasurements?.history_bytes_lost?.value).toBe("0");
    await expect(verifyRecoveryReceipt({ domain, receipt })).resolves.toBe(true);
  });

  it("emits a failure receipt when update-ref fails", async () => {
    const client = new MockGitClient({ "refs/heads/main": SHA_B }, {});
    client.failUpdate = true;
    const sdk = new GitCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1_746_979_210,
      client,
      ref: "refs/heads/main",
      backupSha: SHA_A,
    });
    const receipt = await sdk.recover(await effect());
    expect(receipt.outcome).toBe("failure");
    expect(client.refs["refs/heads/main"]).toBe(SHA_B);
  });

  it("rejects invalid backup shas at construction", () => {
    const client = new MockGitClient({}, {});
    expect(
      () =>
        new GitCompensator({
          contract,
          domain,
          signer: compensator,
          compensatorAddress: compensator.address as Hex20,
          client,
          ref: "refs/heads/main",
          backupSha: "not-a-sha",
        }),
    ).toThrow(GitClientError);
  });

  it("rejects invalid ref names at construction", () => {
    const client = new MockGitClient({}, {});
    expect(
      () =>
        new GitCompensator({
          contract,
          domain,
          signer: compensator,
          compensatorAddress: compensator.address as Hex20,
          client,
          ref: "not-a-ref",
          backupSha: SHA_A,
        }),
    ).toThrow(GitClientError);
  });
});
