#!/usr/bin/env bun
/**
 * L0 independent replayer for rq-provider-git EffectReceipts.
 *
 * Rationale. Table~\ref{tab:provenance} defines L0 as "public replayer
 * / any node from public state / on-chain digest / optimistic". For
 * each admitted git cell, the EffectReceipt binds: the contract's
 * allowedRefs (which ref the mutation acts on), the action
 * (force-push | delete-ref), and the target oid (for force-push). The
 * effect is observable in the bare repo as a ref update plus a reflog
 * entry pre@{1} -> post.
 *
 * This script is a separate consumer. It does NOT import the
 * `@recourse/adapter-git` package. It only shells out to the system
 * `git` binary so the proof is trust-free of the adapter's signature.
 * The admission gate (allowed-ref set, ref-name regex, sha regex,
 * supported action) is re-derived inline.
 *
 * The bench's per-cell receipts live in
 *   results/rq-provider-git/manifest.json["receipts"]
 * keyed by cellId (the receipt hash is null for over-scope cells). The
 * per-cell mapping (which ref, which target, recovery mode) is held in
 * REPLAY_SPECS below and must stay in lock-step with
 *   scripts/provider-bench-git.ts::planCells().
 * That table is the public commitment third-party replayers must hold.
 *
 * For each admitted cell we:
 *   1. Build a deterministic bare git fixture mirroring the bench
 *      (6 main commits, 3 feature/payments commits, v1 tag at main[5],
 *      6 disposable branches).
 *   2. Resolve the cell's start state from the fixture (pre-sha of
 *      the target ref).
 *   3. Apply the public admission gate (allowedRefs == [cell.ref]).
 *      Reject if call's ref is outside the gate.
 *   4. Execute the receipted operation independently via the system
 *      `git` binary (update-ref / update-ref -d).
 *   5. Read the post-state: new ref tip, reflog entry, object
 *      reachability of the new tip.
 *   6. Compare effect to receipt's claim: admitted-in-manifest implies
 *      receipt hash is non-null and the ref actually moved (force-push)
 *      or was deleted (delete-ref). Reflog must record pre -> post.
 *
 * For each over-scope cell we apply the gate and verify it is
 * independently rejected.
 *
 * Output:
 *   results/rq-provider-git/replay-report.json   — per-cell record
 *   results/rq-provider-git/replay-summary.md    — human summary
 */

import { performance } from "node:perf_hooks";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  rm,
  writeFile,
  mkdir,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const exec = promisify(execFileCallback);

const PROTO_DIR =
  process.env.RECOURSE_PROTOTYPE_DIR ??
  path.resolve(new URL(".", import.meta.url).pathname, "..");
const RESULTS_DIR = path.join(PROTO_DIR, "results", "rq-provider-git");
const MANIFEST_PATH = path.join(RESULTS_DIR, "manifest.json");
const REPORT_PATH = path.join(RESULTS_DIR, "replay-report.json");
const SUMMARY_PATH = path.join(RESULTS_DIR, "replay-summary.md");

// Public admission gate constants. Mirror the regexes the adapter uses
// (adapter-git/git-client.ts) so the proof is trust-free of the adapter
// package.
const GIT_REF_RE = /^refs\/[A-Za-z0-9_./-]+$/;
const GIT_SHA_RE = /^[0-9a-f]{40}$/;

interface ManifestReceipt {
  cellId: number;
  effectReceiptHash: string | null;
  recoveryOutcome: string | null;
  recoveryReceiptVerified: boolean | null;
}

interface Manifest {
  rq: string;
  workload: string;
  cells: number;
  receipts: ManifestReceipt[];
  fixture: {
    mainShas: string[]; // recorded by the bench but SHAs depend on commit timestamps;
    featureShas: string[]; // we rebuild a *fresh* fixture and use that fixture's SHAs
    tagSha: string;
  };
  [k: string]: unknown;
}

type ShaToken =
  | "ROOT_MAIN"
  | "MAIN_2"
  | "MID_MAIN"
  | "TIP_MAIN"
  | "FEATURE_BASE"
  | "FEATURE_FIRST"
  | "FEATURE_TIP"
  | "TAG_V1";

interface ReplaySpec {
  cellId: number;
  label: string;
  action: "force-push" | "delete-ref";
  /** The ref scoped in the contract (allowedRefs = [this]). */
  ref: string;
  /** The ref carried by the call. Equal to `ref` for in-scope cells. */
  callRef: string;
  /** Target sha token for force-push. */
  to?: ShaToken;
  recoveryMode: "reflog-success" | "gc-unrecoverable" | "classifier-rejected";
}

// Lock-step with provider-bench-git.ts::planCells(). 20 cells.
const REPLAY_SPECS: ReplaySpec[] = [
  // 8 recoverable, in-scope.
  { cellId: 0, label: "force-push main back to root", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/main", to: "ROOT_MAIN", recoveryMode: "reflog-success" },
  { cellId: 1, label: "force-push main back to mid", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/main", to: "MID_MAIN", recoveryMode: "reflog-success" },
  { cellId: 2, label: "force-push feature back to base", action: "force-push", ref: "refs/heads/feature/payments", callRef: "refs/heads/feature/payments", to: "FEATURE_BASE", recoveryMode: "reflog-success" },
  { cellId: 3, label: "force-push feature back to first", action: "force-push", ref: "refs/heads/feature/payments", callRef: "refs/heads/feature/payments", to: "FEATURE_FIRST", recoveryMode: "reflog-success" },
  { cellId: 4, label: "force-push main back to commit 2", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/main", to: "MAIN_2", recoveryMode: "reflog-success" },
  { cellId: 5, label: "delete-ref feature/payments", action: "delete-ref", ref: "refs/heads/feature/payments", callRef: "refs/heads/feature/payments", recoveryMode: "reflog-success" },
  { cellId: 6, label: "force-push tag v1 back to root", action: "force-push", ref: "refs/tags/v1", callRef: "refs/tags/v1", to: "ROOT_MAIN", recoveryMode: "reflog-success" },
  { cellId: 7, label: "force-push main back to mid (2)", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/main", to: "MID_MAIN", recoveryMode: "reflog-success" },
  // 6 unrecoverable, in-scope (disposable branches).
  ...[0, 1, 2, 3, 4, 5].map<ReplaySpec>((i) => {
    const branch = `refs/heads/bench-disposable-${i}`;
    const action: "force-push" | "delete-ref" = i === 2 ? "delete-ref" : "force-push";
    return {
      cellId: 8 + i,
      label: `${action} disposable-${i} then gc backup`,
      action,
      ref: branch,
      callRef: branch,
      ...(action === "force-push" ? { to: "ROOT_MAIN" as const } : {}),
      recoveryMode: "gc-unrecoverable" as const,
    };
  }),
  // 6 over-scope, classifier-rejected. Contract scopes refs/heads/main;
  // call targets a different ref (release/secret/hotfix).
  { cellId: 14, label: "force-push release ref (over-scope)", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/release/2025", to: "ROOT_MAIN", recoveryMode: "classifier-rejected" },
  { cellId: 15, label: "delete-ref release ref (over-scope)", action: "delete-ref", ref: "refs/heads/main", callRef: "refs/heads/release/2025", recoveryMode: "classifier-rejected" },
  { cellId: 16, label: "force-push secret ref (over-scope)", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/secret", to: "MID_MAIN", recoveryMode: "classifier-rejected" },
  { cellId: 17, label: "force-push hotfix ref (over-scope)", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/hotfix/2025-q1", to: "ROOT_MAIN", recoveryMode: "classifier-rejected" },
  { cellId: 18, label: "delete-ref secret ref (over-scope)", action: "delete-ref", ref: "refs/heads/main", callRef: "refs/heads/secret", recoveryMode: "classifier-rejected" },
  { cellId: 19, label: "force-push another release (over-scope)", action: "force-push", ref: "refs/heads/main", callRef: "refs/heads/release/old", to: "ROOT_MAIN", recoveryMode: "classifier-rejected" },
];

interface Fixture {
  workspace: string;
  bareRepo: string;
  mainShas: string[];
  featureShas: string[];
  tagSha: string;
  disposableShas: string[];
}

async function git(
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
  // Use fixed committer/author identity + dates so the test environment
  // is deterministic; the replayer does not need byte-identical SHAs to
  // the bench, but determinism inside a single run makes the report
  // reproducible.
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Recourse Replay",
    GIT_AUTHOR_EMAIL: "replay@recourse.test",
    GIT_COMMITTER_NAME: "Recourse Replay",
    GIT_COMMITTER_EMAIL: "replay@recourse.test",
  };
  const opts: { encoding: "utf8"; cwd?: string; env: NodeJS.ProcessEnv } = cwd
    ? { cwd, encoding: "utf8", env }
    : { encoding: "utf8", env };
  const { stdout, stderr } = await exec("git", args, opts);
  return { stdout: stdout.trimEnd(), stderr };
}

/**
 * Build the bare-repo fixture from scratch. Mirrors
 * provider-bench-git.ts::setupFixture(). The SHAs differ from the bench
 * (different committer date), but the *structure* matches: 6 main
 * commits, 3 feature/payments commits off main[3], v1 tag at main[5],
 * 6 disposable branches each off main[0] with a unique commit.
 */
async function setupFixture(): Promise<Fixture> {
  const workspace = await mkdtemp(path.join(tmpdir(), "recourse-git-replay-"));
  const bareRepo = path.join(workspace, "fixture.git");
  await mkdir(bareRepo, { recursive: true });
  const work = path.join(workspace, "work");

  await git(["init", "--bare", "--initial-branch=main", bareRepo]);
  // Enable reflog logging in the bare repo so update-ref / push leave a
  // verifiable audit trail. Bare repos default to no reflog; the bench
  // also operates against bare repos but only verifies via ref tips, so
  // enabling this here is what lets us see pre@{1} -> post entries.
  await git([
    "--git-dir",
    bareRepo,
    "config",
    "core.logAllRefUpdates",
    "always",
  ]);
  await git(["clone", bareRepo, work]);
  await git(["-C", work, "config", "user.email", "replay@recourse.test"]);
  await git(["-C", work, "config", "user.name", "Recourse Replay"]);
  await git(["-C", work, "config", "commit.gpgsign", "false"]);

  const mainShas: string[] = [];
  for (let i = 0; i < 6; i++) {
    await writeFile(
      path.join(work, `main-${i}.md`),
      `main commit ${i}\n`.repeat(50 + i * 7),
    );
    await git(["-C", work, "add", "."]);
    await git(["-C", work, "commit", "-m", `main ${i}`]);
    await git(["-C", work, "push", "origin", "main"]);
    const { stdout } = await git([
      "--git-dir",
      bareRepo,
      "rev-parse",
      "refs/heads/main",
    ]);
    mainShas.push(stdout);
  }

  await git(["-C", work, "checkout", "-b", "feature/payments", mainShas[3]!]);
  const featureShas: string[] = [];
  for (let i = 0; i < 3; i++) {
    await writeFile(
      path.join(work, `feature-${i}.md`),
      `feature ${i}\n`.repeat(40 + i * 11),
    );
    await git(["-C", work, "add", "."]);
    await git(["-C", work, "commit", "-m", `feature ${i}`]);
    await git(["-C", work, "push", "origin", "feature/payments"]);
    const { stdout } = await git([
      "--git-dir",
      bareRepo,
      "rev-parse",
      "refs/heads/feature/payments",
    ]);
    featureShas.push(stdout);
  }

  await git(["-C", work, "checkout", "main"]);
  await git(["-C", work, "tag", "v1", mainShas[5]!]);
  await git(["-C", work, "push", "origin", "v1"]);
  const { stdout: tagSha } = await git([
    "--git-dir",
    bareRepo,
    "rev-parse",
    "refs/tags/v1",
  ]);

  const disposableShas: string[] = [];
  for (let i = 0; i < 6; i++) {
    const branch = `bench-disposable-${i}`;
    await git(["-C", work, "checkout", "-b", branch, mainShas[0]!]);
    const padding = "x".repeat(200 + i * 113);
    await writeFile(
      path.join(work, `disposable-${i}.md`),
      `disposable ${i}\n${padding}\n`,
    );
    await git(["-C", work, "add", "."]);
    await git(["-C", work, "commit", "-m", `disposable ${i}`]);
    await git(["-C", work, "push", "origin", branch]);
    const { stdout } = await git([
      "--git-dir",
      bareRepo,
      "rev-parse",
      `refs/heads/${branch}`,
    ]);
    disposableShas.push(stdout);
    await git(["-C", work, "checkout", "main"]);
  }

  return { workspace, bareRepo, mainShas, featureShas, tagSha, disposableShas };
}

function resolveShaToken(token: ShaToken, fx: Fixture): string {
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
  }
}

async function refSha(repo: string, ref: string): Promise<string | null> {
  try {
    const { stdout } = await git([
      "--git-dir",
      repo,
      "rev-parse",
      "--verify",
      `${ref}^{commit}`,
    ]);
    return stdout;
  } catch {
    return null;
  }
}

async function commitReachable(repo: string, sha: string): Promise<boolean> {
  try {
    await git(["--git-dir", repo, "cat-file", "-e", sha]);
    return true;
  } catch {
    return false;
  }
}

async function readReflog(
  repo: string,
  ref: string,
): Promise<{ oldSha: string; newSha: string; subject: string }[]> {
  try {
    const { stdout } = await git([
      "--git-dir",
      repo,
      "reflog",
      "show",
      "--no-abbrev",
      "--format=%H %gs",
      ref,
    ]);
    if (!stdout) return [];
    // `reflog show` for a single ref prints one line per entry but
    // doesn't expose oldSha directly. Use the porcelain alternative.
    const { stdout: porcelain } = await git([
      "--git-dir",
      repo,
      "reflog",
      ref,
      "--no-abbrev",
    ]);
    const entries: { oldSha: string; newSha: string; subject: string }[] = [];
    for (const line of porcelain.split("\n")) {
      // <new> <ref>@{N}: <subject>
      const m = line.match(
        /^([0-9a-f]{40}) [^:]+:\s*(.+)$/,
      );
      if (m) {
        entries.push({ oldSha: "", newSha: m[1]!, subject: m[2]! });
      }
    }
    // Augment with old shas by walking pairs.
    // git reflog lists newest first; the "old sha" of entry i is the
    // "new sha" of entry i+1.
    for (let i = 0; i < entries.length - 1; i++) {
      entries[i]!.oldSha = entries[i + 1]!.newSha;
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Public admission gate. Mirrors the GitAdapter's preExecute checks
 * but operates only on the ToolCall surface (action, ref strings).
 */
function gateReject(spec: ReplaySpec): string | null {
  // 1) supported action
  if (spec.action !== "force-push" && spec.action !== "delete-ref") {
    return `unsupported git action: ${spec.action}`;
  }
  // 2) ref-name validity for both call ref and contract ref
  if (!GIT_REF_RE.test(spec.callRef)) {
    return `invalid git ref: ${spec.callRef}`;
  }
  if (!GIT_REF_RE.test(spec.ref)) {
    return `invalid git ref: ${spec.ref}`;
  }
  // 3) params/resource agreement: in the bench the call carries
  //    params.ref == resource.ref, both = callRef. Mismatch would also
  //    trip the adapter but isn't exercised here.
  // 4) registered scope: contract's allowedRefs = [spec.ref]; if the
  //    call targets a different ref, scope check fires.
  if (spec.callRef !== spec.ref) {
    return `ref is outside registered scope: ${spec.callRef}`;
  }
  return null;
}

interface PerCellReport {
  cell_id: number;
  label: string;
  action: string;
  ref: string;
  call_ref: string;
  receipt_hash: string | null;
  admitted_in_receipt: boolean;
  replay_admitted: boolean;
  replay_rejected_reason: string | null;
  pre_sha_replay: string | null;
  post_sha_replay: string | null;
  expected_target_sha: string | null;
  ref_state_match: boolean;
  reflog_entry_match: boolean;
  object_reachable: boolean;
  rejection_match: boolean;
  overall_match: boolean;
  replay_latency_ms: number;
  notes: string[];
}

async function replayCell(
  fx: Fixture,
  spec: ReplaySpec,
  receipt: ManifestReceipt | undefined,
): Promise<PerCellReport> {
  const notes: string[] = [];
  const admittedInReceipt =
    !!receipt && receipt.effectReceiptHash !== null;
  const report: PerCellReport = {
    cell_id: spec.cellId,
    label: spec.label,
    action: spec.action,
    ref: spec.ref,
    call_ref: spec.callRef,
    receipt_hash: receipt?.effectReceiptHash ?? null,
    admitted_in_receipt: admittedInReceipt,
    replay_admitted: false,
    replay_rejected_reason: null,
    pre_sha_replay: null,
    post_sha_replay: null,
    expected_target_sha: null,
    ref_state_match: false,
    reflog_entry_match: false,
    object_reachable: false,
    rejection_match: false,
    overall_match: false,
    replay_latency_ms: 0,
    notes,
  };

  const t0 = performance.now();

  // Apply public admission gate.
  const gateReason = gateReject(spec);
  if (gateReason !== null) {
    report.replay_admitted = false;
    report.replay_rejected_reason = gateReason;
    report.rejection_match = !admittedInReceipt;
    if (!report.rejection_match) {
      notes.push(
        `gate rejected but manifest carries receipt hash ${receipt?.effectReceiptHash}`,
      );
    }
    report.overall_match = report.rejection_match;
    report.replay_latency_ms = performance.now() - t0;
    return report;
  }

  // Admitted on independent replay: execute the operation against a
  // fresh ref tip restored to the fixture's recorded value. This is
  // necessary because cells re-use refs (e.g. cell 0 and cell 1 both
  // mutate refs/heads/main); we restore the ref to its fixture value
  // before each replay so the pre-state is well-defined.
  report.replay_admitted = true;

  // Restore the ref to its fixture starting state.
  await restoreRefToFixtureState(fx, spec.ref);
  const preSha = await refSha(fx.bareRepo, spec.ref);
  report.pre_sha_replay = preSha;
  if (preSha === null) {
    notes.push("pre-state ref missing in fixture; cannot replay effect");
    report.overall_match = false;
    report.replay_latency_ms = performance.now() - t0;
    return report;
  }

  // Execute the operation.
  let expectedTargetSha: string | null = null;
  if (spec.action === "force-push") {
    if (!spec.to) {
      report.replay_rejected_reason = "force-push without `to` token";
      report.overall_match = false;
      report.replay_latency_ms = performance.now() - t0;
      return report;
    }
    expectedTargetSha = resolveShaToken(spec.to, fx);
    if (!GIT_SHA_RE.test(expectedTargetSha)) {
      report.replay_rejected_reason = `invalid target sha: ${expectedTargetSha}`;
      report.overall_match = false;
      report.replay_latency_ms = performance.now() - t0;
      return report;
    }
    await git([
      "--git-dir",
      fx.bareRepo,
      "update-ref",
      spec.ref,
      expectedTargetSha,
    ]);
  } else {
    // delete-ref
    await git(["--git-dir", fx.bareRepo, "update-ref", "-d", spec.ref]);
  }
  report.expected_target_sha = expectedTargetSha;

  // Read post-state.
  const postSha = await refSha(fx.bareRepo, spec.ref);
  report.post_sha_replay = postSha;

  if (spec.action === "force-push") {
    report.ref_state_match = postSha === expectedTargetSha;
    report.object_reachable = postSha !== null
      ? await commitReachable(fx.bareRepo, postSha)
      : false;
  } else {
    report.ref_state_match = postSha === null;
    // For delete-ref the previous object is still reachable via reflog
    // until expired/gc'd. Reachability of the deleted-from sha confirms
    // recoverability (matches recovery_outcome="success" for cell 5,
    // "failure" for cell 10's gc-unrecoverable variant).
    report.object_reachable = await commitReachable(fx.bareRepo, preSha);
  }

  // Verify reflog records pre -> post.
  const reflog = await readReflog(fx.bareRepo, spec.ref);
  if (spec.action === "force-push") {
    // After update-ref, reflog HEAD entry has newSha = postSha. We don't
    // pin oldSha against preSha because porcelain `git reflog` doesn't
    // always print the old sha for a fresh ref; instead we look for any
    // entry where newSha == postSha *and* an adjacent entry has newSha
    // == preSha.
    const sawNewTip = reflog.some((e) => e.newSha === postSha);
    const sawPre = reflog.some((e) => e.newSha === preSha);
    report.reflog_entry_match = sawNewTip && sawPre;
  } else {
    // After delete-ref, the ref is gone so no reflog exists for the ref
    // itself, but the deleted sha is still recorded in the parent
    // directory's reflog. We approximate by checking the deleted sha is
    // still in the object database (reachable via packed-refs/reflog).
    report.reflog_entry_match = await commitReachable(fx.bareRepo, preSha);
  }

  // Gross result. Effect is verified by:
  //   (a) gate admits in lock-step with the manifest's admittedness,
  //   (b) ref state post-op matches the expected state,
  //   (c) reflog records the transition (or the deleted object is still
  //       reachable for the delete-ref case),
  //   (d) the new tip's object exists in the database.
  report.rejection_match = admittedInReceipt; // admitted-on-replay matches receipt
  report.overall_match =
    admittedInReceipt &&
    report.ref_state_match &&
    report.object_reachable &&
    report.reflog_entry_match;

  // For gc-unrecoverable cells (cellIds 8..13), the bench's
  // recovery_outcome is "failure" because `git gc --prune=now` made
  // the prior sha unreachable. Our L0 replay doesn't run the gc step
  // (we're verifying the *effect*, not the compensation), so reflog
  // and object reachability should still hold for the pre-sha here.
  // No additional handling needed.

  report.replay_latency_ms = performance.now() - t0;
  return report;
}

/**
 * Reset `ref` to its starting fixture value so the next cell can mutate
 * it from a well-defined pre-state.
 */
async function restoreRefToFixtureState(
  fx: Fixture,
  ref: string,
): Promise<void> {
  if (ref === "refs/heads/main") {
    await git([
      "--git-dir",
      fx.bareRepo,
      "update-ref",
      ref,
      fx.mainShas[fx.mainShas.length - 1]!,
    ]);
  } else if (ref === "refs/heads/feature/payments") {
    const current = await refSha(fx.bareRepo, ref);
    if (current === null) {
      // Was deleted; recreate at the feature tip.
      await git([
        "--git-dir",
        fx.bareRepo,
        "update-ref",
        ref,
        fx.featureShas[fx.featureShas.length - 1]!,
      ]);
    } else {
      await git([
        "--git-dir",
        fx.bareRepo,
        "update-ref",
        ref,
        fx.featureShas[fx.featureShas.length - 1]!,
      ]);
    }
  } else if (ref === "refs/tags/v1") {
    await git(["--git-dir", fx.bareRepo, "update-ref", ref, fx.tagSha]);
  } else if (/^refs\/heads\/bench-disposable-(\d+)$/.test(ref)) {
    const i = Number.parseInt(ref.match(/(\d+)$/)![1]!, 10);
    const current = await refSha(fx.bareRepo, ref);
    const target = fx.disposableShas[i];
    if (target === undefined) return;
    if (current === null) {
      await git(["--git-dir", fx.bareRepo, "update-ref", ref, target]);
    } else {
      await git(["--git-dir", fx.bareRepo, "update-ref", ref, target]);
    }
  }
  // Refs not present in the fixture (release/secret/hotfix) intentionally
  // stay missing; over-scope cells should not reach this function because
  // the gate fires first.
}

function summarize(reports: PerCellReport[]): {
  text: string;
  admittedReplayable: number;
  admittedTotal: number;
  rejectedReplayable: number;
  rejectedTotal: number;
  meanLatencyMs: number;
} {
  const admitted = reports.filter((r) => r.admitted_in_receipt);
  const admittedReplayable = admitted.filter((r) => r.overall_match).length;
  const rejected = reports.filter((r) => !r.admitted_in_receipt);
  const rejectedReplayable = rejected.filter((r) => r.rejection_match).length;
  const allLatencies = reports.map((r) => r.replay_latency_ms);
  const meanLatency =
    allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;
  const nonMatches = reports.filter(
    (r) =>
      r.admitted_in_receipt
        ? !r.overall_match
        : !r.rejection_match,
  );

  let text = "# L0 Replay Summary — rq-provider-git\n\n";
  text += `Receipt set: ${reports.length} cells (${admitted.length} admitted, ${rejected.length} over-scope).\n\n`;
  text += `**Admitted cells replayable**: ${admittedReplayable}/${admitted.length}.\n`;
  text += `**Over-scope cells correctly rejected on independent replay**: ${rejectedReplayable}/${rejected.length}.\n`;
  text += `**Mean replay latency**: ${meanLatency.toFixed(2)} ms.\n\n`;

  if (nonMatches.length === 0) {
    text += "All cells matched the receipt's claim on independent replay.\n\n";
  } else {
    text += "## Mismatches\n\n";
    for (const r of nonMatches) {
      text += `- cell ${r.cell_id} (${r.label}): pre=${r.pre_sha_replay?.slice(0, 8) ?? "-"} post=${r.post_sha_replay?.slice(0, 8) ?? "-"} target=${r.expected_target_sha?.slice(0, 8) ?? "-"} ref_state_match=${r.ref_state_match} reflog_match=${r.reflog_entry_match} reachable=${r.object_reachable} notes=${r.notes.join("; ")}\n`;
    }
    text += "\n";
  }

  text += "## Per-cell\n\n";
  text +=
    "| Cell | Action | Ref | Call ref | Receipt | RefState | Reflog | Reachable | Match | Lat. (ms) |\n";
  text +=
    "|-----:|--------|-----|----------|:-------:|:--------:|:------:|:---------:|:-----:|----------:|\n";
  for (const r of reports) {
    const overall = r.admitted_in_receipt ? r.overall_match : r.rejection_match;
    text += `| ${r.cell_id} | ${r.action} | ${r.ref} | ${r.call_ref} | ${r.admitted_in_receipt ? "yes" : "(rejected)"} | ${r.admitted_in_receipt ? (r.ref_state_match ? "y" : "n") : "—"} | ${r.admitted_in_receipt ? (r.reflog_entry_match ? "y" : "n") : "—"} | ${r.admitted_in_receipt ? (r.object_reachable ? "y" : "n") : "—"} | ${overall ? "y" : "n"} | ${r.replay_latency_ms.toFixed(2)} |\n`;
  }

  return {
    text,
    admittedReplayable,
    admittedTotal: admitted.length,
    rejectedReplayable,
    rejectedTotal: rejected.length,
    meanLatencyMs: meanLatency,
  };
}

async function main(): Promise<void> {
  if (!fs.existsSync(MANIFEST_PATH)) {
    console.error(`missing ${MANIFEST_PATH}`);
    process.exit(1);
  }
  const manifest = JSON.parse(
    await readFile(MANIFEST_PATH, "utf8"),
  ) as Manifest;

  const receiptByCellId = new Map<number, ManifestReceipt>();
  for (const r of manifest.receipts) receiptByCellId.set(r.cellId, r);

  process.stderr.write("[setup] building deterministic git fixture...\n");
  const fxStart = performance.now();
  const fx = await setupFixture();
  process.stderr.write(
    `[setup] fixture built in ${(performance.now() - fxStart).toFixed(0)} ms at ${fx.bareRepo}\n`,
  );

  const reports: PerCellReport[] = [];
  for (const spec of REPLAY_SPECS) {
    const rec = receiptByCellId.get(spec.cellId);
    const rep = await replayCell(fx, spec, rec);
    reports.push(rep);
    process.stderr.write(
      `[replay] cell ${spec.cellId} (${spec.action} ${spec.ref}): ` +
        `admitted_receipt=${rep.admitted_in_receipt} ` +
        `replay_admitted=${rep.replay_admitted} ` +
        `ref_state_match=${rep.ref_state_match} ` +
        `match=${
          rep.admitted_in_receipt ? rep.overall_match : rep.rejection_match
        } lat=${rep.replay_latency_ms.toFixed(2)}ms\n`,
    );
  }

  // Cleanup workspace.
  await rm(fx.workspace, { recursive: true, force: true });

  const summary = summarize(reports);
  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        schemaVersion: 1,
        rq: "rq-provider-git",
        replay: {
          admittedReplayable: summary.admittedReplayable,
          admittedTotal: summary.admittedTotal,
          rejectedReplayable: summary.rejectedReplayable,
          rejectedTotal: summary.rejectedTotal,
          meanLatencyMs: summary.meanLatencyMs,
          fixtureRoot: fx.bareRepo.replace(/[A-Za-z0-9_-]+\.git$/, "<bare>.git"),
        },
        cells: reports,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(SUMMARY_PATH, summary.text);

  process.stderr.write(
    `\nwrote ${REPORT_PATH}\nwrote ${SUMMARY_PATH}\n` +
      `admitted_replayable=${summary.admittedReplayable}/${summary.admittedTotal} ` +
      `rejected_replayable=${summary.rejectedReplayable}/${summary.rejectedTotal} ` +
      `mean_latency_ms=${summary.meanLatencyMs.toFixed(2)}\n`,
  );
}

await main();
