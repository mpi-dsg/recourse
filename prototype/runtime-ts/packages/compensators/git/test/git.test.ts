import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
import { LocalBareGitClient } from "../../../adapter-git/src/index.ts";
import { GitCompensator } from "../src/index.ts";

const exec = promisify(execFileCallback);

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};

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

let workspace: string | undefined;
let bareRepo: string | undefined;
let firstSha: string | undefined;
let secondSha: string | undefined;

async function rev(repo: string, ref: string): Promise<string> {
  const { stdout } = await exec("git", ["--git-dir", repo, "rev-parse", ref], {
    encoding: "utf8",
  });
  return stdout.trim();
}

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "recourse-git-comp-"));
  bareRepo = join(workspace, "demo.git");
  const work = join(workspace, "work");
  await exec("git", ["init", "--bare", "--initial-branch=main", bareRepo]);
  await exec("git", ["clone", bareRepo, work]);
  await exec("git", ["-C", work, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", work, "config", "user.name", "Test User"]);
  await exec("git", ["-C", work, "config", "commit.gpgsign", "false"]);

  await writeFile(join(work, "README.md"), "first\n");
  await exec("git", ["-C", work, "add", "."]);
  await exec("git", ["-C", work, "commit", "-m", "first"]);
  await exec("git", ["-C", work, "push", "origin", "main"]);
  firstSha = await rev(bareRepo, "refs/heads/main");

  await writeFile(join(work, "two.md"), "second\n");
  await exec("git", ["-C", work, "add", "."]);
  await exec("git", ["-C", work, "commit", "-m", "second"]);
  await exec("git", ["-C", work, "push", "origin", "main"]);
  secondSha = await rev(bareRepo, "refs/heads/main");
}, 30_000);

afterAll(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
});

beforeEach(async () => {
  // Simulate the failure: ref currently points at firstSha (rolled back).
  await exec("git", ["--git-dir", bareRepo!, "update-ref", "refs/heads/main", firstSha!]);
});

describe("GitCompensator against a local bare repo", () => {
  it("restores the ref to the backup sha", async () => {
    const sdk = new GitCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1_746_979_210,
      client: new LocalBareGitClient(bareRepo!),
      ref: "refs/heads/main",
      backupSha: secondSha!,
    });

    const receipt = await sdk.recover(await effect());
    expect(receipt.outcome).toBe("success");
    expect(Number(receipt.residualMeasurements?.history_bytes_restored?.value ?? "0")).toBeGreaterThan(0);
    await expect(verifyRecoveryReceipt({ domain, receipt })).resolves.toBe(true);
    expect(await rev(bareRepo!, "refs/heads/main")).toBe(secondSha!);
  });

  it("emits a failure receipt when the backup sha is unknown to the repo", async () => {
    const bogus = "f".repeat(40);
    const sdk = new GitCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1_746_979_210,
      client: new LocalBareGitClient(bareRepo!),
      ref: "refs/heads/main",
      backupSha: bogus,
    });

    const receipt = await sdk.recover(await effect());
    expect(receipt.outcome).toBe("failure");
    expect(await rev(bareRepo!, "refs/heads/main")).toBe(firstSha!);
  });
});
