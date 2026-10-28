#!/usr/bin/env bun
/**
 * L0 independent replayer for rq-provider-cloud EffectReceipts.
 *
 * Rationale. Table~\ref{tab:provenance} defines L0 as "public replayer /
 * any node from public state / on-chain digest / optimistic". For each
 * admitted cloud cell, the EffectReceipt binds: the SSM parameter
 * resourceId, the action (set-parameter | delete-parameter), the new
 * value (for set), the pre/post value, and the SSM parameter version
 * after the call (`ssm_version_after` in cells.json).
 *
 * This script is a separate consumer. It does NOT import the
 * `@recourse/adapter-cloud` package's CloudAdapter. It only borrows the
 * AWS SDK SSM client (via the workspace node_modules) to talk to the
 * same LocalStack endpoint. The admission gate is re-derived inline
 * (allowed-prefix set, parameter-name regex, supported actions, typed
 * value for set, params/resource match) so the proof is trust-free of
 * the adapter's signature.
 *
 * For each cell we:
 *   1. Make sure the parameter is at its seed value: putParameter with
 *      seedValues[resourceId]. (For rejected cells we still seed any
 *      adjacent valid name they touch so the test environment stays
 *      deterministic across the run.)
 *   2. Read the current SSM Version of the parameter to anchor the
 *      pre-state.
 *   3. Independently execute the receipted action (Put or Delete).
 *   4. Read the post-state (value + version) from SSM.
 *   5. Compare against the receipt's claim (post_value, post_version,
 *      ssm_version_after).
 *
 * For over-scope cells we apply the public gate to the cell's
 * (action, resourceId, paramsResourceId, callResourceId, configValue)
 * tuple and verify the cell is independently rejected with the same
 * (or equivalent-class) reason.
 *
 * Output:
 *   results/rq-provider-cloud/replay-report.json   — per-cell record
 *   results/rq-provider-cloud/replay-summary.md    — human summary
 */

import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as path from "node:path";

// Borrow @aws-sdk/client-ssm from the adapter-cloud workspace node_modules.
// We do NOT import any adapter/compensator code from @recourse/*; this is
// solely the AWS SSM client library, used to talk to LocalStack.
import {
  DeleteParameterCommand,
  GetParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
} from "../runtime-ts/packages/adapter-cloud/node_modules/@aws-sdk/client-ssm";

const PROTO_DIR =
  process.env.RECOURSE_PROTOTYPE_DIR ??
  path.resolve(new URL(".", import.meta.url).pathname, "..");
const RESULTS_DIR = path.join(PROTO_DIR, "results", "rq-provider-cloud");
const CELLS_PATH = path.join(RESULTS_DIR, "cells.json");
const REPORT_PATH = path.join(RESULTS_DIR, "replay-report.json");
const SUMMARY_PATH = path.join(RESULTS_DIR, "replay-summary.md");

const ENDPOINT = process.env.RECOURSE_LOCALSTACK_URL ?? "http://localhost:4566";
const REGION = process.env.RECOURSE_LOCALSTACK_REGION ?? "us-east-1";

// Public admission scope. Mirrors what the bench seeded under
// /recourse/test/p0..p9 in provider-bench-cloud.ts. Any other name is
// outside scope.
const ALLOWED_PREFIX = "/recourse/test/";
const ALLOWED_RESOURCES = new Set<string>();
for (let i = 0; i < 10; i++) ALLOWED_RESOURCES.add(`${ALLOWED_PREFIX}p${i}`);

// SSM-style parameter name regex (mirrors adapter-cloud/cloud-client.ts).
const PARAMETER_NAME_RE = /^\/?[A-Za-z0-9_.\-/]+$/;

interface CellsDoc {
  schemaVersion: number;
  provider: string;
  workload: string;
  endpoint: string;
  seedValues: Record<string, string>;
  cells: CloudCell[];
}

interface CloudCell {
  cell_id: string;
  scenario: string;
  action: string;
  resource_id: string;
  call_resource_id: string;
  expected_admitted: boolean;
  admitted: boolean;
  rejected_reason: string | null;
  rejection_kind: string | null;
  pre_value: string | null;
  post_value: string | null;
  pre_version: number | null;
  post_version: number | null;
  receipt_hash: string | null;
  ssm_version_after: number | null;
  // Several auxiliary fields are present but unused by the replayer.
  [key: string]: unknown;
}

/**
 * Replay spec. The cells.json receipts do not carry the original
 * params.resourceId vs resource.resourceId split (only `resource_id` and
 * `call_resource_id`), or the set-value, because the bench script keeps
 * that as a private detail of how the call was framed. We re-derive the
 * (small, public) mapping here in lock-step with provider-bench-cloud.ts.
 *
 * If the bench changes, this table changes — that is intentional, it
 * documents the public commitment that a third-party replayer must hold.
 */
interface ReplaySpec {
  cellId: string;
  action: "set-parameter" | "delete-parameter" | "rotate-parameter";
  // Resource id as carried in the ToolCall's resource block.
  callResourceId: string;
  // Resource id as carried in the ToolCall's params block.
  // For mismatch cells this differs from callResourceId.
  paramsResourceId: string;
  // The value the receipted PutParameter writes; empty string means
  // omit `value` (untyped) to trip the typed-value gate.
  setValue: string | null; // null -> no `value` field in params.config
  // Expected gate verdict.
  expectedAdmitted: boolean;
}

const REPLAY_SPECS: ReplaySpec[] = [
  // Admitted: set-parameter overwrites (4 restored, 4 not restored).
  {
    cellId: "cell-01-set-restore-p0",
    action: "set-parameter",
    callResourceId: "/recourse/test/p0",
    paramsResourceId: "/recourse/test/p0",
    setValue: "mutated-0",
    expectedAdmitted: true,
  },
  {
    cellId: "cell-02-set-restore-p1",
    action: "set-parameter",
    callResourceId: "/recourse/test/p1",
    paramsResourceId: "/recourse/test/p1",
    setValue: "mutated-1",
    expectedAdmitted: true,
  },
  {
    cellId: "cell-03-set-restore-p2",
    action: "set-parameter",
    callResourceId: "/recourse/test/p2",
    paramsResourceId: "/recourse/test/p2",
    setValue: "mutated-2",
    expectedAdmitted: true,
  },
  {
    cellId: "cell-04-set-restore-p3",
    action: "set-parameter",
    callResourceId: "/recourse/test/p3",
    paramsResourceId: "/recourse/test/p3",
    setValue: "mutated-3",
    expectedAdmitted: true,
  },
  {
    cellId: "cell-05-set-noundo-p4",
    action: "set-parameter",
    callResourceId: "/recourse/test/p4",
    paramsResourceId: "/recourse/test/p4",
    setValue: "mutated-4",
    expectedAdmitted: true,
  },
  {
    cellId: "cell-06-set-noundo-p5",
    action: "set-parameter",
    callResourceId: "/recourse/test/p5",
    paramsResourceId: "/recourse/test/p5",
    setValue: "mutated-5",
    expectedAdmitted: true,
  },
  {
    cellId: "cell-07-set-noundo-p6",
    action: "set-parameter",
    callResourceId: "/recourse/test/p6",
    paramsResourceId: "/recourse/test/p6",
    setValue: "mutated-6",
    expectedAdmitted: true,
  },
  {
    cellId: "cell-08-set-noundo-p7",
    action: "set-parameter",
    callResourceId: "/recourse/test/p7",
    paramsResourceId: "/recourse/test/p7",
    setValue: "mutated-7",
    expectedAdmitted: true,
  },
  // Admitted: delete-parameter on p8..p9, then re-seed and delete again.
  {
    cellId: "cell-09-delete-restore-p8",
    action: "delete-parameter",
    callResourceId: "/recourse/test/p8",
    paramsResourceId: "/recourse/test/p8",
    setValue: "",
    expectedAdmitted: true,
  },
  {
    cellId: "cell-10-delete-restore-p9",
    action: "delete-parameter",
    callResourceId: "/recourse/test/p9",
    paramsResourceId: "/recourse/test/p9",
    setValue: "",
    expectedAdmitted: true,
  },
  {
    cellId: "cell-11-delete-norestore-p8-bis",
    action: "delete-parameter",
    callResourceId: "/recourse/test/p8",
    paramsResourceId: "/recourse/test/p8",
    setValue: "",
    expectedAdmitted: true,
  },
  {
    cellId: "cell-12-delete-norestore-p9-bis",
    action: "delete-parameter",
    callResourceId: "/recourse/test/p9",
    paramsResourceId: "/recourse/test/p9",
    setValue: "",
    expectedAdmitted: true,
  },
  // Rejected: over-scope / malformed.
  {
    cellId: "cell-13-rejected-cross-account-arn",
    action: "set-parameter",
    callResourceId: "arn:aws:ssm:us-east-1:999999999999:parameter/recourse/test/p0",
    paramsResourceId:
      "arn:aws:ssm:us-east-1:999999999999:parameter/recourse/test/p0",
    setValue: "x",
    expectedAdmitted: false,
  },
  {
    cellId: "cell-14-rejected-wrong-prefix",
    action: "set-parameter",
    callResourceId: "/foreign/zone/p1",
    paramsResourceId: "/foreign/zone/p1",
    setValue: "x",
    expectedAdmitted: false,
  },
  {
    cellId: "cell-15-rejected-arn-mismatch",
    action: "set-parameter",
    callResourceId: "/recourse/test/p2",
    paramsResourceId: "/recourse/test/p3", // mismatch
    setValue: "x",
    expectedAdmitted: false,
  },
  {
    cellId: "cell-16-rejected-empty-value",
    action: "set-parameter",
    callResourceId: "/recourse/test/p4",
    paramsResourceId: "/recourse/test/p4",
    setValue: null, // missing `value` field
    expectedAdmitted: false,
  },
  {
    cellId: "cell-17-rejected-rotate-action",
    action: "rotate-parameter",
    callResourceId: "/recourse/test/p5",
    paramsResourceId: "/recourse/test/p5",
    setValue: "x",
    expectedAdmitted: false,
  },
  {
    cellId: "cell-18-rejected-invalid-name",
    action: "set-parameter",
    callResourceId: "/recourse/test/p?evil$",
    paramsResourceId: "/recourse/test/p?evil$",
    setValue: "x",
    expectedAdmitted: false,
  },
  {
    cellId: "cell-19-rejected-wrong-region",
    action: "set-parameter",
    callResourceId: "/recourse-prod/test/p7",
    paramsResourceId: "/recourse-prod/test/p7",
    setValue: "x",
    expectedAdmitted: false,
  },
  {
    cellId: "cell-20-rejected-foreign-arn",
    action: "set-parameter",
    callResourceId: "arn:aws:ssm:eu-west-1:000000000000:parameter/unrelated/p8",
    paramsResourceId:
      "arn:aws:ssm:eu-west-1:000000000000:parameter/unrelated/p8",
    setValue: "x",
    expectedAdmitted: false,
  },
];

/**
 * Public admission gate. Returns null when admitted, else a (stable)
 * reason string. The reason text mirrors the adapter-cloud's
 * AdapterScopeError messages so the postgres-style "rejection match by
 * class prefix" check works.
 */
function gateReject(spec: ReplaySpec): string | null {
  // 1) supported action
  if (spec.action !== "set-parameter" && spec.action !== "delete-parameter") {
    return `unsupported cloud action: ${spec.action}`;
  }
  // 2) parameter-name validity (callResourceId carries the SSM name when
  //    it's not an ARN; ARNs and invalid characters both fail here).
  if (
    !PARAMETER_NAME_RE.test(spec.callResourceId) ||
    spec.callResourceId.length > 256
  ) {
    return `resource is outside registered scope: ${spec.callResourceId}`;
  }
  // 3) params/resource agreement (rejects ARN/path mismatch even before
  //    checking the allowlist).
  if (spec.paramsResourceId !== spec.callResourceId) {
    return `cloud params resourceId does not match resource id: ${spec.paramsResourceId}`;
  }
  // 4) typed value for set-parameter
  if (spec.action === "set-parameter" && spec.setValue === null) {
    return "set-parameter requires params.config.value";
  }
  // 5) registered scope
  if (!ALLOWED_RESOURCES.has(spec.callResourceId)) {
    return `resource is outside registered scope: ${spec.callResourceId}`;
  }
  return null;
}

interface PerCellReport {
  cell_id: string;
  receipt_hash: string | null;
  admitted_in_receipt: boolean;
  replay_admitted: boolean;
  expected_rejected_reason: string | null;
  replay_rejected_reason: string | null;
  pre_value_replay: string | null;
  post_value_replay: string | null;
  expected_post_value: string | null;
  pre_version_replay: number | null;
  post_version_replay: number | null;
  expected_ssm_version_after: number | null;
  value_match: boolean;
  version_advanced: boolean;
  version_match_receipt: boolean | null;
  rejection_match: boolean;
  overall_match: boolean;
  replay_latency_ms: number;
  notes: string[];
}

interface SsmClientLike {
  send: (cmd: unknown) => Promise<unknown>;
}

async function getParameter(
  client: SsmClientLike,
  name: string,
): Promise<{ value: string; version: number } | null> {
  try {
    const out = (await client.send(
      new GetParameterCommand({ Name: name }),
    )) as { Parameter?: { Value?: string; Version?: number } };
    const p = out.Parameter;
    if (!p || p.Value === undefined) return null;
    return { value: p.Value, version: p.Version ?? 1 };
  } catch (err) {
    if (err instanceof ParameterNotFound) return null;
    // Some errors are surfaced as `name === "ParameterNotFound"` on the wire.
    if ((err as { name?: string }).name === "ParameterNotFound") return null;
    throw err;
  }
}

async function putParameter(
  client: SsmClientLike,
  name: string,
  value: string,
): Promise<number | null> {
  const out = (await client.send(
    new PutParameterCommand({
      Name: name,
      Value: value,
      Type: "String",
      Overwrite: true,
    }),
  )) as { Version?: number };
  return out.Version ?? null;
}

async function deleteParameter(
  client: SsmClientLike,
  name: string,
): Promise<void> {
  try {
    await client.send(new DeleteParameterCommand({ Name: name }));
  } catch (err) {
    if (err instanceof ParameterNotFound) return;
    if ((err as { name?: string }).name === "ParameterNotFound") return;
    throw err;
  }
}

async function ensureSeed(
  client: SsmClientLike,
  name: string,
  seed: string,
): Promise<void> {
  // Delete and re-put so the version sequence is well-defined: every
  // cell starts at Version=1 for its seed. SSM increments the version
  // monotonically; deleting and re-creating resets to 1.
  await deleteParameter(client, name);
  await putParameter(client, name, seed);
}

async function replayCell(
  client: SsmClientLike,
  cell: CloudCell,
  spec: ReplaySpec,
  seedValues: Record<string, string>,
): Promise<PerCellReport> {
  const notes: string[] = [];
  const report: PerCellReport = {
    cell_id: cell.cell_id,
    receipt_hash: cell.receipt_hash,
    admitted_in_receipt: cell.admitted,
    replay_admitted: false,
    expected_rejected_reason: cell.rejected_reason,
    replay_rejected_reason: null,
    pre_value_replay: null,
    post_value_replay: null,
    expected_post_value: cell.post_value,
    pre_version_replay: null,
    post_version_replay: null,
    expected_ssm_version_after: cell.ssm_version_after,
    value_match: false,
    version_advanced: false,
    version_match_receipt: null,
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
    report.rejection_match =
      !cell.admitted && gateReason === cell.rejected_reason;
    if (!report.rejection_match && !cell.admitted) {
      // Class-prefix fallback (mirrors postgres replayer): two reasons
      // are equivalent if they share the same colon-delimited class.
      const norm = (s: string | null) =>
        (s ?? "").toLowerCase().split(":")[0]!.trim();
      if (norm(gateReason) === norm(cell.rejected_reason)) {
        report.rejection_match = true;
        notes.push("rejection reason matched by class prefix");
      }
    }
    report.overall_match = report.rejection_match;
    report.replay_latency_ms = performance.now() - t0;
    return report;
  }

  // Admitted on independent replay. Seed -> read pre -> execute -> read post.
  report.replay_admitted = true;
  const seed = seedValues[spec.callResourceId];
  if (seed === undefined) {
    notes.push("no seed value recorded for this resource — using empty seed");
  }
  await ensureSeed(client, spec.callResourceId, seed ?? "seed-default");
  const pre = await getParameter(client, spec.callResourceId);
  report.pre_value_replay = pre?.value ?? null;
  report.pre_version_replay = pre?.version ?? null;

  if (spec.action === "set-parameter") {
    if (spec.setValue === null) {
      // Should have been caught by the gate, but fail closed.
      report.replay_rejected_reason = "set-parameter requires params.config.value";
      report.replay_admitted = false;
      report.rejection_match = !cell.admitted;
      report.overall_match = report.rejection_match;
      report.replay_latency_ms = performance.now() - t0;
      return report;
    }
    const newVersion = await putParameter(
      client,
      spec.callResourceId,
      spec.setValue,
    );
    const post = await getParameter(client, spec.callResourceId);
    report.post_value_replay = post?.value ?? null;
    report.post_version_replay = post?.version ?? newVersion;
    report.value_match = report.post_value_replay === spec.setValue;
    report.version_advanced =
      report.post_version_replay !== null &&
      (report.pre_version_replay === null ||
        report.post_version_replay > report.pre_version_replay);
  } else if (spec.action === "delete-parameter") {
    await deleteParameter(client, spec.callResourceId);
    const post = await getParameter(client, spec.callResourceId);
    report.post_value_replay = post?.value ?? null;
    report.post_version_replay = post?.version ?? null;
    // For deletes the receipt's post_value should be null; the parameter
    // is gone after the operation, and a re-seed would re-create it at
    // version 1. Receipt's `ssm_version_after` for delete cells is 1
    // (the bench reseeds for the "norestore" arm).
    report.value_match = report.post_value_replay === null;
    report.version_advanced = report.post_version_replay === null;
  } else {
    report.replay_rejected_reason = `unsupported cloud action: ${spec.action}`;
    report.replay_admitted = false;
    report.rejection_match = !cell.admitted;
    report.overall_match = report.rejection_match;
    report.replay_latency_ms = performance.now() - t0;
    return report;
  }

  // Receipt comparison.
  // Note: the bench's `ssm_version_after` is read AFTER any restoration
  // by the compensator, so a set-restore cell reports v=3 (seed v1 ->
  // mutated v2 -> restored v3). Our L0 replay does not restore (replay
  // is verifying the *effect*, not the compensation). So we compare
  // against pre-restoration intermediate version where applicable: for
  // set-parameter that is `post_version` (v2). For cells that the bench
  // did not restore (set-noundo and delete-norestore arms) the receipt's
  // ssm_version_after directly matches our post-version observation.
  if (spec.action === "set-parameter") {
    // The bench's `post_version` field captures the immediate-post version.
    if (cell.post_version !== null && report.post_version_replay !== null) {
      report.version_match_receipt =
        report.post_version_replay === cell.post_version;
    } else {
      // Fall back: any monotonic increase counts when the receipt did
      // not pin a specific post_version (some scenarios leave it null).
      report.version_match_receipt = report.version_advanced;
    }
  } else {
    // delete-parameter: the receipt's post_value/post_version are null.
    report.version_match_receipt =
      cell.post_value === null && cell.post_version === null;
  }

  // Sanity: the receipt's pre_value should match our pre-read seed value.
  if (cell.pre_value !== null && cell.pre_value !== report.pre_value_replay) {
    notes.push(
      `pre_value mismatch: receipt=${cell.pre_value} replay=${report.pre_value_replay}`,
    );
  }

  report.rejection_match = cell.admitted; // admitted-in-receipt matches admitted-on-replay
  report.overall_match =
    cell.admitted &&
    report.value_match &&
    report.version_advanced &&
    report.version_match_receipt === true;

  report.replay_latency_ms = performance.now() - t0;
  return report;
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
    (r) => !r.overall_match && !(r.rejection_match && !r.admitted_in_receipt),
  );

  let text = "# L0 Replay Summary — rq-provider-cloud\n\n";
  text += `Receipt set: ${reports.length} cells (${admitted.length} admitted, ${rejected.length} over-scope).\n\n`;
  text += `**Admitted cells replayable**: ${admittedReplayable}/${admitted.length}.\n`;
  text += `**Over-scope cells correctly rejected on independent replay**: ${rejectedReplayable}/${rejected.length}.\n`;
  text += `**Mean replay latency**: ${meanLatency.toFixed(2)} ms.\n\n`;

  if (nonMatches.length === 0) {
    text += "All cells matched the receipt's claim on independent replay.\n\n";
  } else {
    text += "## Mismatches\n\n";
    for (const r of nonMatches) {
      text += `- ${r.cell_id}: expected_post=${r.expected_post_value ?? "(null)"} replayed=${r.post_value_replay ?? "(null)"} ssm_v=${r.expected_ssm_version_after ?? "-"}/${r.post_version_replay ?? "-"} notes=${r.notes.join("; ")}\n`;
    }
    text += "\n";
  }

  text += "## Per-cell\n\n";
  text +=
    "| Cell | Action | Post (receipt → replay) | Ver (receipt → replay) | Match | Lat. (ms) |\n";
  text +=
    "|------|--------|-------------------------|-----------------------:|:-----:|----------:|\n";
  for (const r of reports) {
    const overallMatch = r.admitted_in_receipt
      ? r.overall_match
      : r.rejection_match;
    const postReceipt = r.expected_post_value ?? "(null)";
    const postReplay = r.admitted_in_receipt
      ? r.post_value_replay ?? "(null)"
      : `(rejected: ${r.replay_rejected_reason ?? "n/a"})`;
    const verReceipt = r.expected_ssm_version_after ?? "-";
    const verReplay = r.post_version_replay ?? "-";
    text += `| ${r.cell_id} | ${r.admitted_in_receipt ? "exec" : "gate"} | ${postReceipt} → ${postReplay} | ${verReceipt} → ${verReplay} | ${overallMatch ? "y" : "n"} | ${r.replay_latency_ms.toFixed(2)} |\n`;
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
  if (!fs.existsSync(CELLS_PATH)) {
    console.error(`missing ${CELLS_PATH}`);
    process.exit(1);
  }
  const cellsDoc = JSON.parse(fs.readFileSync(CELLS_PATH, "utf8")) as CellsDoc;
  const cells = cellsDoc.cells;
  const seedValues = cellsDoc.seedValues ?? {};

  const specByCell = new Map<string, ReplaySpec>();
  for (const s of REPLAY_SPECS) specByCell.set(s.cellId, s);

  const client = new SSMClient({
    endpoint: ENDPOINT,
    region: REGION,
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  }) as unknown as SsmClientLike;

  // Connectivity probe.
  await getParameter(client, "/recourse/test/__probe__");

  const reports: PerCellReport[] = [];
  for (const cell of cells) {
    const spec = specByCell.get(cell.cell_id);
    if (!spec) {
      reports.push({
        cell_id: cell.cell_id,
        receipt_hash: cell.receipt_hash,
        admitted_in_receipt: cell.admitted,
        replay_admitted: false,
        expected_rejected_reason: cell.rejected_reason,
        replay_rejected_reason: "no replay spec for cell",
        pre_value_replay: null,
        post_value_replay: null,
        expected_post_value: cell.post_value,
        pre_version_replay: null,
        post_version_replay: null,
        expected_ssm_version_after: cell.ssm_version_after,
        value_match: false,
        version_advanced: false,
        version_match_receipt: null,
        rejection_match: false,
        overall_match: false,
        replay_latency_ms: 0,
        notes: ["no public ReplaySpec for this cell"],
      });
      continue;
    }
    const rep = await replayCell(client, cell, spec, seedValues);
    reports.push(rep);
    process.stderr.write(
      `[replay] ${cell.cell_id}: admitted_receipt=${cell.admitted} ` +
        `replay_admitted=${rep.replay_admitted} ` +
        `value_match=${rep.value_match} ` +
        `version_match=${rep.version_match_receipt ?? "-"} ` +
        `match=${cell.admitted ? rep.overall_match : rep.rejection_match} ` +
        `lat=${rep.replay_latency_ms.toFixed(2)}ms\n`,
    );
  }

  // Best-effort cleanup of the seeded parameters so subsequent runs start fresh.
  for (const name of Object.keys(seedValues)) {
    try {
      await deleteParameter(client, name);
    } catch {
      /* ignore */
    }
  }

  const summary = summarize(reports);
  fs.writeFileSync(
    REPORT_PATH,
    JSON.stringify(
      {
        schemaVersion: 1,
        rq: "rq-provider-cloud",
        replay: {
          admittedReplayable: summary.admittedReplayable,
          admittedTotal: summary.admittedTotal,
          rejectedReplayable: summary.rejectedReplayable,
          rejectedTotal: summary.rejectedTotal,
          meanLatencyMs: summary.meanLatencyMs,
          endpoint: ENDPOINT,
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
