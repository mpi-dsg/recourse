import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ToolCall } from "../../adapter-sdk/src/index.ts";
import { verifyEffectReceipt, type Hex20, type Hex32 } from "../../receipts/src/index.ts";
import { adapterAccount as signer } from "../../receipts/test/helpers.ts";
import { GitAdapter, LocalBareGitClient } from "../src/index.ts";

const exec = promisify(execFileCallback);

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};
const contractId =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32;
const jobId = "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex32;
const txHash = "0x9999000000000000000000000000000000000000000000000000000000000001" as Hex32;

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
  workspace = await mkdtemp(join(tmpdir(), "recourse-git-"));
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

function adapter(): GitAdapter {
  return new GitAdapter({
    domain,
    signer,
    adapterAddress: signer.address as Hex20,
    now: () => 1_746_979_200,
    recordToChain: async () => txHash,
    client: new LocalBareGitClient(bareRepo!),
    repo: "demo",
    allowedRefs: ["refs/heads/main"],
  });
}

describe("GitAdapter against a local bare repo", () => {
  it("force-pushes the branch back to an older commit and signs the receipt", async () => {
    // Sanity: current state is secondSha.
    expect(await rev(bareRepo!, "refs/heads/main")).toBe(secondSha!);

    const call: ToolCall = {
      contractId,
      jobId,
      tool: "git",
      action: "force-push",
      params: { ref: "refs/heads/main", to: firstSha! },
      resource: { repo: "demo", ref: "refs/heads/main" },
    };
    const result = await adapter().run(call);

    expect(result.providerOutcome.previous).toBe(secondSha!);
    expect(result.providerOutcome.next).toBe(firstSha!);
    expect(result.providerOutcome.bytesOfHistoryChanged).toBeGreaterThanOrEqual(0);
    await expect(verifyEffectReceipt({ domain, receipt: result.receipt })).resolves.toBe(true);

    expect(await rev(bareRepo!, "refs/heads/main")).toBe(firstSha!);

    // Restore for the next test case.
    await exec("git", ["--git-dir", bareRepo!, "update-ref", "refs/heads/main", secondSha!]);
  });

  it("deletes the ref when commanded", async () => {
    const call: ToolCall = {
      contractId,
      jobId,
      tool: "git",
      action: "delete-ref",
      params: { ref: "refs/heads/main" },
      resource: { repo: "demo", ref: "refs/heads/main" },
    };
    const result = await adapter().run(call);

    expect(result.providerOutcome.next).toBeNull();
    expect(result.providerOutcome.previous).toBe(secondSha!);

    const after = await new LocalBareGitClient(bareRepo!).revParse("refs/heads/main");
    expect(after).toBeNull();

    // Restore for downstream tests.
    await exec("git", ["--git-dir", bareRepo!, "update-ref", "refs/heads/main", secondSha!]);
  });
});
