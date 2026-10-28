// Provider-backed git workload benchmark for the recourse paper.
//
// Drives the real `@recourse/adapter-git` against a local bare git repo, with
// real EIP-712 receipts and a real `@recourse/compensator-git` performing
// reflog-style restores. Captures per-cell latency, gross/recovered/residual
// harm in bytes-of-objects, and bond utilization. Emits a JSON results file
// that scripts/provider-bench-git-to-parquet.py converts to parquet.
//
// Only depends on the workspace packages and viem (already pulled in by
// `@recourse/receipts`). Run with:
//   bun run scripts/provider-bench-git.ts <output.json> [<bare-repo-path>]

import {
  execFile as execFileCallback,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  AdapterScopeError,
  type ToolCall,
} from "../runtime-ts/packages/adapter-sdk/src/index.ts";
import {
  GitAdapter,
  LocalBareGitClient,
} from "../runtime-ts/packages/adapter-git/src/index.ts";
import { GitCompensator } from "../runtime-ts/packages/compensators/git/src/index.ts";
import { hashEvidence } from "../runtime-ts/packages/evidence-store/src/index.ts";
import {
  hashEffectReceipt,
  hashRecourseContract,
  signEffectReceipt,
  verifyRecoveryReceipt,
  type EffectReceipt,
  type Hex20,
  type Hex32,
  type RecourseContract,
} from "../runtime-ts/packages/receipts/src/index.ts";
import {
  adapterAccount,
  compensatorAccount,
} from "../runtime-ts/packages/receipts/test/helpers.ts";

const exec = promisify(execFileCallback);
const PROTOTYPE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const DOMAIN = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};

const BOND_MAX_BYTES = 100_000; // bond covers up to 100kB of object history.

interface BareRepoFixture {
  workspace: string;
  bareRepo: string;
  mainShas: string[]; // index 0 = root, last = tip
  featureShas: string[]; // 3 commits on feature/payments
  tagSha: string;
  // Disposable branches each hold a unique commit with no other reachability
  // so gc-unrecoverable cells can actually lose the backup history when the
  // ref is mutated, reflog expired, and `git gc --prune=now` is run.
  disposableShas: string[];
}

async function git(
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string }> {
  const opts: ExecFileOptionsWithStringEncoding = {
    encoding: "utf8",
    ...(cwd ? { cwd } : {}),
    ...(env ? { env: { ...process.env, ...env } } : {}),
  };
  const { stdout, stderr } = await exec("git", args, opts);
  return { stdout: stdout.trim(), stderr };
}

function deterministicCommitEnv(offsetMinutes: number): Record<string, string> {
  const date = new Date(Date.UTC(2024, 0, 1, 0, offsetMinutes, 0)).toISOString();
  return { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
}

async function setupFixture(repoPath: string): Promise<BareRepoFixture> {
  const workspace = await mkdtemp(join(tmpdir(), "recourse-git-bench-work-"));
  const bareRepo = repoPath;
  await mkdir(bareRepo, { recursive: true });
  const work = join(workspace, "work");

  await git(["init", "--bare", "--initial-branch=main", bareRepo]);
  await git(["clone", bareRepo, work]);
  await git(["-C", work, "config", "user.email", "bench@recourse.test"]);
  await git(["-C", work, "config", "user.name", "Recourse Bench"]);
  await git(["-C", work, "config", "commit.gpgsign", "false"]);

  const mainShas: string[] = [];
  for (let i = 0; i < 6; i++) {
    await writeFile(join(work, `main-${i}.md`), `main commit ${i}\n`.repeat(50 + i * 7));
    await git(["-C", work, "add", "."]);
    await git(
      ["-C", work, "commit", "-m", `main ${i}`],
      undefined,
      deterministicCommitEnv(i),
    );
    await git(["-C", work, "push", "origin", "main"]);
    const { stdout } = await git(["--git-dir", bareRepo, "rev-parse", "refs/heads/main"]);
    mainShas.push(stdout);
  }

  // Create a feature branch off mainShas[3].
  await git(["-C", work, "checkout", "-b", "feature/payments", mainShas[3]!]);
  const featureShas: string[] = [];
  for (let i = 0; i < 3; i++) {
    await writeFile(join(work, `feature-${i}.md`), `feature ${i}\n`.repeat(40 + i * 11));
    await git(["-C", work, "add", "."]);
    await git(
      ["-C", work, "commit", "-m", `feature ${i}`],
      undefined,
      deterministicCommitEnv(20 + i),
    );
    await git(["-C", work, "push", "origin", "feature/payments"]);
    const { stdout } = await git([
      "--git-dir",
      bareRepo,
      "rev-parse",
      "refs/heads/feature/payments",
    ]);
    featureShas.push(stdout);
  }

  // Tag v1 at mainShas[5].
  await git(["-C", work, "checkout", "main"]);
  await git(["-C", work, "tag", "v1", mainShas[5]!]);
  await git(["-C", work, "push", "origin", "v1"]);
  const { stdout: tagSha } = await git([
    "--git-dir",
    bareRepo,
    "rev-parse",
    "refs/tags/v1",
  ]);

  // Disposable branches: each carries a unique commit so that mutating the
  // branch and pruning the reflog leaves the previous commit truly unreachable.
  const disposableShas: string[] = [];
  for (let i = 0; i < 6; i++) {
    const branch = `bench-disposable-${i}`;
    await git(["-C", work, "checkout", "-b", branch, mainShas[0]!]);
    const padding = "x".repeat(200 + i * 113);
    await writeFile(
      join(work, `disposable-${i}.md`),
      `disposable ${i}\n${padding}\n`,
    );
    await git(["-C", work, "add", "."]);
    await git(
      ["-C", work, "commit", "-m", `disposable ${i}`],
      undefined,
      deterministicCommitEnv(40 + i),
    );
    await git(["-C", work, "push", "origin", branch]);
    const { stdout } = await git([
      "--git-dir",
      bareRepo,
      "rev-parse",
      `refs/heads/${branch}`,
    ]);
    disposableShas.push(stdout);
    // Reset working copy so the next disposable branch is also rooted at root.
    await git(["-C", work, "checkout", "main"]);
  }

  return { workspace, bareRepo, mainShas, featureShas, tagSha, disposableShas };
}

const EMPTY_CONTRACT_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex32;

function makeContract(
  ref: string,
  action: "force-push" | "delete-ref",
): RecourseContract {
  const draft: RecourseContract = {
    schemaVersion: 1,
    contractId: EMPTY_CONTRACT_ID,
    operator: "0x000000000000000000000000000000000000bEEF" as Hex20,
    actionTemplate: { tool: "git", action },
    resourceScope: { type: "git-ref", descriptor: { repo: "bench-repo", ref } },
    effectClass: "compensable",
    recoveryOperator: {
      compensatorId: "git",
      freshnessSeconds: 60,
      retentionSeconds: 3600,
      authPolicyHash: hashEvidence("bench-auth").hash,
    },
    coveredLossClass: { codes: ["history_bytes_lost"], excludeList: [] },
    payoutRule: {
      type: "rowCountSchedule",
      params: { perRowUsd: "1" },
      maxPayout: String(BOND_MAX_BYTES),
    },
    bond: {
      asset: "0x0000000000000000000000000000000000000001",
      minAmount: String(BOND_MAX_BYTES),
      maxAggregateExposure: String(BOND_MAX_BYTES),
    },
    evidenceSchema: {
      schemaId: hashEvidence("bench-schema").hash,
      requiredProvenance: "L1",
      accessPolicyHash: hashEvidence("bench-access").hash,
    },
    deadlines: { recoverySeconds: 120, submissionSeconds: 600, livenessSeconds: 600 },
    disputeRoute: {
      arbitrator: "0x0000000000000000000000000000000000000002",
      evidenceGroupId: "1",
    },
  };
  return { ...draft, contractId: hashRecourseContract(draft) };
}

function pad32(seed: number): Hex32 {
  const hex = seed.toString(16).padStart(64, "0");
  return ("0x" + hex) as Hex32;
}

interface CellSpec {
  cellId: number;
  label: string;
  action: "force-push" | "delete-ref";
  ref: string; // ref being acted on (declared in contract)
  callRef: string; // ref the call carries (may exceed scope)
  to?: string; // sha (or "ROOT_MAIN" / "TIP_MAIN" / "PREV_TIP" - resolved later)
  preMutation?: "delete-feature-tip" | "advance-main"; // optional setup to create something to undo
  recoveryMode: "reflog-success" | "gc-unrecoverable" | "adapter-rejected";
}

function planCells(): CellSpec[] {
  // 20 cells total: 8 recoverable, 6 unrecoverable (gc'd), 6 over-scope/adapter-rejected.
  // Distributed across main, feature/payments, and v1 tag.
  const cells: CellSpec[] = [];
  let id = 0;

  // 8 recoverable force-push/delete-ref on in-scope refs.
  const recoverableSpecs: Array<Omit<CellSpec, "cellId" | "recoveryMode">> = [
    { label: "force-push main back to root", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/main", to: "ROOT_MAIN" },
    { label: "force-push main back to mid", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/main", to: "MID_MAIN" },
    { label: "force-push feature back to base", action: "force-push", ref: "refs/heads/feature/payments", callRef: "refs/heads/feature/payments", to: "FEATURE_BASE" },
    { label: "force-push feature back to first", action: "force-push", ref: "refs/heads/feature/payments", callRef: "refs/heads/feature/payments", to: "FEATURE_FIRST" },
    { label: "force-push main back to commit 2", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/main", to: "MAIN_2" },
    { label: "delete-ref feature/payments", action: "delete-ref", ref: "refs/heads/feature/payments", callRef: "refs/heads/feature/payments" },
    { label: "force-push tag v1 back to root", action: "force-push", ref: "refs/tags/v1", callRef: "refs/tags/v1", to: "ROOT_MAIN" },
    { label: "force-push main back to mid (2)", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/main", to: "MID_MAIN" },
  ];
  for (const s of recoverableSpecs) {
    cells.push({ cellId: id++, ...s, recoveryMode: "reflog-success" });
  }

  // 6 unrecoverable: force-push a disposable branch (whose backup commit has
  // no other reachability) and then run `git gc --prune=now` so the previous
  // tip is actually unreachable on disk. The compensator's restore call will
  // then fail (`git update-ref` on a missing sha).
  for (let i = 0; i < 6; i++) {
    const branch = `refs/heads/bench-disposable-${i}`;
    const action = i === 2 ? "delete-ref" : "force-push";
    cells.push({
      cellId: id++,
      label: `${action} disposable-${i} then gc backup`,
      action,
      ref: branch,
      callRef: branch,
      ...(action === "force-push" ? { to: "ROOT_MAIN" } : {}),
      recoveryMode: "gc-unrecoverable",
    });
  }

  // 6 adapter-rejected over-scope.
  // Contract scopes refs/heads/main; call targets refs/heads/release/* or
  // refs/heads/secret. The adapter's allowedRefs guard short-circuits these.
  const rejectedSpecs: Array<Omit<CellSpec, "cellId" | "recoveryMode">> = [
    { label: "force-push release ref (over-scope)", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/release/2025", to: "ROOT_MAIN" },
    { label: "delete-ref release ref (over-scope)", action: "delete-ref", ref: "refs/heads/main", callRef: "refs/heads/release/2025" },
    { label: "force-push secret ref (over-scope)", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/secret", to: "MID_MAIN" },
    { label: "force-push hotfix ref (over-scope)", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/hotfix/2025-q1", to: "ROOT_MAIN" },
    { label: "delete-ref secret ref (over-scope)", action: "delete-ref", ref: "refs/heads/main", callRef: "refs/heads/secret" },
    { label: "force-push another release (over-scope)", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/release/old", to: "ROOT_MAIN" },
  ];
  for (const s of rejectedSpecs) {
    cells.push({ cellId: id++, ...s, recoveryMode: "adapter-rejected" });
  }

  return cells;
}

function resolveSha(token: string, fx: BareRepoFixture): string {
  switch (token) {
    case "ROOT_MAIN":
      return fx.mainShas[0]!;
    case "MAIN_2":
      return fx.mainShas[2]!;
    case "MID_MAIN":
      return fx.mainShas[3]!;
    case "TIP_MAIN":
      return fx.mainShas[5]!;
    case "FEATURE_BASE":
      return fx.mainShas[3]!;
    case "FEATURE_FIRST":
      return fx.featureShas[0]!;
    case "FEATURE_TIP":
      return fx.featureShas[2]!;
    case "TAG_V1":
      return fx.tagSha;
    default:
      throw new Error(`unknown sha token: ${token}`);
  }
}

async function refExists(repo: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await git(["--git-dir", repo, "rev-parse", "--verify", `${ref}^{commit}`]);
    return stdout;
  } catch {
    return null;
  }
}

interface CellResult {
  cellId: number;
  label: string;
  action: string;
  ref: string;
  callRef: string;
  recoveryMode: string;
  outcome: "applied-recovered" | "applied-unrecovered" | "adapter-rejected" | "compensator-failed";
  routingCorrect: boolean;
  classifierLabel: "in-scope" | "over-scope";
  grossHarmBytes: number;
  bytesOfHistoryDelta: number;
  recoveredBytes: number;
  residualBytes: number;
  adapterLatencyMs: number;
  signingLatencyMs: number;
  totalLatencyMs: number;
  bondUtilization: number;
  effectReceiptHash: string | null;
  recoveryOutcome: string | null;
  recoveryReceiptVerified: boolean | null;
}

async function objectCount(repo: string): Promise<number> {
  const { stdout } = await git(["--git-dir", repo, "count-objects", "-v"]);
  // sum loose + packed counts
  let total = 0;
  for (const line of stdout.split("\n")) {
    const [key, val] = line.split(":").map((s) => s.trim());
    if (key === "count" || key === "in-pack") total += Number.parseInt(val ?? "0", 10);
  }
  return total;
}

async function runCell(
  fx: BareRepoFixture,
  spec: CellSpec,
  bondMaxBytes: number,
): Promise<CellResult> {
  const client = new LocalBareGitClient(fx.bareRepo);
  const jobId = pad32(0xb000 + spec.cellId);
  const callTo = spec.to ? resolveSha(spec.to, fx) : undefined;

  // Snapshot ref state for recovery backup.
  const preSha = await refExists(fx.bareRepo, spec.ref);
  // gross_harm in bytes-of-objects: the commit object size that would become
  // unreachable if the mutation were not compensated. Captured pre-mutation
  // so it stays well-defined even when gc later destroys the object.
  let preSize = 0;
  if (preSha) {
    try {
      preSize = await client.commitObjectSize(preSha);
    } catch {
      preSize = 0;
    }
  }
  const contract = makeContract(spec.ref, spec.action);
  const contractId = contract.contractId;
  const classifierLabel = spec.callRef === spec.ref ? "in-scope" : "over-scope";
  const expectedRejection = classifierLabel === "over-scope";
  let routingCorrect = true;

  const adapter = new GitAdapter({
    domain: DOMAIN,
    signer: adapterAccount,
    adapterAddress: adapterAccount.address as Hex20,
    now: () => 1_746_979_200 + spec.cellId,
    recordToChain: async (r) => hashEffectReceipt({ domain: DOMAIN, receipt: r }),
    client,
    repo: "bench-repo",
    allowedRefs: [spec.ref],
  });

  // Build the tool call. For over-scope cells, the resource carries the
  // out-of-scope callRef but params still names callRef so the adapter's scope
  // check fires (rather than the params-vs-resource sanity check).
  const call: ToolCall = {
    contractId,
    jobId,
    tool: "git",
    action: spec.action,
    params: spec.action === "force-push" ? { ref: spec.callRef, to: callTo! } : { ref: spec.callRef },
    resource: { repo: "bench-repo", ref: spec.callRef },
  };

  const t0 = performance.now();
  let signingMs = 0;
  let adapterMs = 0;
  let effect: EffectReceipt | null = null;
  let outcome: CellResult["outcome"];
  let grossHarmBytes = 0;
  let bytesOfHistoryDelta = 0;
  let recoveredBytes = 0;
  let residualBytes = 0;
  let recoveryOutcome: string | null = null;
  let recoveryReceiptVerified: boolean | null = null;
  let effectReceiptHash: string | null = null;

  try {
    const tAdapterStart = performance.now();
    const result = await adapter.run(call);
    adapterMs = performance.now() - tAdapterStart;
    effect = result.receipt;
    // Signing cost = postExecute -> emit signed receipt is bundled inside run().
    // We approximate by timing only the receipt re-sign for a verifiable
    // measurement: one signEffectReceipt call against the same payload.
    const { signature: _sig, ...unsigned } = result.receipt;
    const tSig = performance.now();
    await signEffectReceipt({ domain: DOMAIN, signer: adapterAccount, receipt: unsigned });
    signingMs = performance.now() - tSig;
    effectReceiptHash = hashEffectReceipt({ domain: DOMAIN, receipt: unsigned });
    // Gross harm = previous commit object size (bytes that would be lost
    // if not compensated). The adapter's `bytesOfHistoryChanged` reports the
    // signed delta which is useful for telemetry but not for harm accounting.
    grossHarmBytes = preSize;
    bytesOfHistoryDelta = result.providerOutcome.bytesOfHistoryChanged;

    if (expectedRejection) {
      // The mutation was applied but the contract expected this to be rejected
      // upstream: routing was incorrect.
      routingCorrect = false;
    }

    // Attempt recovery.
    if (spec.recoveryMode === "gc-unrecoverable") {
      // Make the backup sha unreachable: drop any extra refs that keep it
      // alive, then `git gc --prune=now` to garbage-collect the lost objects.
      if (preSha) {
        // The compensator will try to restore to preSha. Force gc so preSha is
        // unreachable from any current ref.
        try {
          await git(["--git-dir", fx.bareRepo, "reflog", "expire", "--expire=now", "--all"]);
          await git(["--git-dir", fx.bareRepo, "gc", "--prune=now", "--quiet"]);
        } catch {
          // ignore - some git versions emit warnings; reachability is what matters
        }
      }
    }

    if (preSha) {
      const compensator = new GitCompensator({
        contract,
        domain: DOMAIN,
        signer: compensatorAccount,
        compensatorAddress: compensatorAccount.address as Hex20,
        now: () => 1_746_979_205 + spec.cellId,
        client,
        ref: spec.ref,
        backupSha: preSha,
      });
      const recoveryReceipt = await compensator.recover(result.receipt);
      recoveryOutcome = recoveryReceipt.outcome;
      recoveryReceiptVerified = await verifyRecoveryReceipt({
        domain: DOMAIN,
        receipt: recoveryReceipt,
      });
      if (recoveryReceipt.outcome === "success") {
        recoveredBytes = Number(
          recoveryReceipt.residualMeasurements?.history_bytes_restored?.value ?? "0",
        );
        outcome = "applied-recovered";
      } else {
        outcome = "compensator-failed";
      }
    } else {
      // No preSha to restore to; mark as unrecovered.
      outcome = "applied-unrecovered";
    }
  } catch (err) {
    adapterMs = performance.now() - t0;
    if (err instanceof AdapterScopeError) {
      outcome = "adapter-rejected";
      if (!expectedRejection) routingCorrect = false;
      // Time a signing op on a synthetic receipt to record signing latency
      // even on rejection (we still pay it on every successful adapter call,
      // so reporting it keeps the number honest for the recovered path).
      const tSig = performance.now();
      await signEffectReceipt({
        domain: DOMAIN,
        signer: adapterAccount,
        receipt: {
          schemaVersion: 1,
          contractId,
          jobId,
          intentHash: hashEvidence({ action: spec.action }).hash,
          paramsHash: hashEvidence(call.params as Record<string, unknown>).hash,
          resourceId: hashEvidence(call.resource as Record<string, unknown>).hash,
          preStateDigest: hashEvidence("rejected-pre").hash,
          postStateDigest: hashEvidence("rejected-post").hash,
          timestamp: Math.floor(Date.now() / 1000),
          adapterAddress: adapterAccount.address as Hex20,
        },
      });
      signingMs = performance.now() - tSig;
    } else {
      throw err;
    }
  }
  const totalMs = performance.now() - t0;

  // Restore the ref state for the next cell (idempotent). Skip gc-unrecoverable
  // disposable branches: their backup commits are intentionally destroyed and
  // cannot be resurrected.
  if (preSha && spec.recoveryMode !== "gc-unrecoverable") {
    try {
      await git(["--git-dir", fx.bareRepo, "update-ref", spec.ref, preSha]);
    } catch {
      /* ignore - the next cell's preSha read will reflect the actual state */
    }
  }

  // Cap recovered at gross when both apply: you cannot restore more bytes than
  // were placed at risk by this single mutation.
  const cappedRecovered = Math.min(recoveredBytes, grossHarmBytes);
  residualBytes = Math.max(0, grossHarmBytes - cappedRecovered);
  const bondUtilization = Math.min(1, residualBytes / bondMaxBytes);
  void effect; // receipt is hashed above, not needed downstream

  return {
    cellId: spec.cellId,
    label: spec.label,
    action: spec.action,
    ref: spec.ref,
    callRef: spec.callRef,
    recoveryMode: spec.recoveryMode,
    outcome,
    routingCorrect,
    classifierLabel,
    grossHarmBytes,
    bytesOfHistoryDelta,
    recoveredBytes: cappedRecovered,
    residualBytes,
    adapterLatencyMs: adapterMs,
    signingLatencyMs: signingMs,
    totalLatencyMs: totalMs,
    bondUtilization,
    effectReceiptHash,
    recoveryOutcome,
    recoveryReceiptVerified,
  };
}

async function main() {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error("usage: bun run scripts/provider-bench-git.ts <output.json> [<bare-repo>]");
    process.exit(2);
  }
  const repoArg = process.argv[3];
  const bareRepo =
    repoArg ?? join(tmpdir(), `recourse-git-fixture-${Math.floor(Math.random() * 1e9)}.git`);

  const start = Date.now();
  const fx = await setupFixture(bareRepo);
  const setupMs = Date.now() - start;
  const objectsBefore = await objectCount(fx.bareRepo);

  const cells = planCells();
  const results: CellResult[] = [];
  for (const cell of cells) {
    const r = await runCell(fx, cell, BOND_MAX_BYTES);
    results.push(r);
  }
  const objectsAfter = await objectCount(fx.bareRepo);

  const gitVersion = (await git(["--version"])).stdout;
  const harnessCommit = (await git(["rev-parse", "HEAD"], PROTOTYPE_ROOT)).stdout;

  const out = {
    schemaVersion: 1,
    workload: "git",
    providerBacked: false,
    providerCompatibleSandbox: true,
    bondMaxBytes: BOND_MAX_BYTES,
    fixture: {
      bareRepo: fx.bareRepo,
      mainShas: fx.mainShas,
      featureShas: fx.featureShas,
      tagSha: fx.tagSha,
      setupMs,
      objectsBefore,
      objectsAfter,
    },
    env: {
      gitVersion,
      harnessCommit,
      bunVersion: process.versions.bun ?? "unknown",
      platform: process.platform,
      arch: process.arch,
    },
    cells: results,
  };

  await writeFile(outPath, JSON.stringify(out, null, 2));
  await rm(fx.workspace, { recursive: true, force: true });

  // Tidy up the bare repo unless caller asked to keep it.
  if (!repoArg) await rm(fx.bareRepo, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
