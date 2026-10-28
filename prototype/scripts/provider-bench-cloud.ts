/**
 * Provider-backed Cloud (LocalStack SSM) bench for rq-provider-cloud.
 *
 * Drives the real `@recourse/adapter-cloud` (CloudAdapter + LocalStackSsmCloudClient)
 * and `@recourse/compensator-cloud` (CloudCompensator) against a live LocalStack
 * instance. Captures per-cell wall-clock (EIP-712 sign + SSM call), gross /
 * recovered / residual harm in parameter-changes-not-restored, and bond
 * utilization. Emits a JSON results file consumed by
 * scripts/provider-bench-cloud-to-parquet.py.
 *
 * Cells: 20 total.
 *   - 12 admitted:
 *       - 8 set-parameter overwrites (4 then restored to previous value, 4 left).
 *       - 4 delete-parameter (restored from version-history backup).
 *   - 8 over-scope, adapter-rejected:
 *       - cross-account / wrong-region resource identifiers,
 *       - wrong path prefix,
 *       - ARN-mismatch (resourceId mismatch between params & resource),
 *       - empty (untyped) value for set-parameter,
 *       - unsupported action (rotate-parameter),
 *       - invalid parameter name (slashes too deep / illegal chars).
 *
 * Run with:
 *   RECOURSE_LOCALSTACK_URL=http://localhost:4566 \
 *     bun run scripts/provider-bench-cloud.ts <output.json>
 */

import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";

import {
  AdapterScopeError,
  type ToolCall,
} from "../runtime-ts/packages/adapter-sdk/src/index.ts";
import {
  CloudAdapter,
  CloudClientError,
  LocalStackSsmCloudClient,
} from "../runtime-ts/packages/adapter-cloud/src/index.ts";
import { CloudCompensator } from "../runtime-ts/packages/compensators/cloud/src/index.ts";
import { hashEvidence } from "../runtime-ts/packages/evidence-store/src/index.ts";
import {
  hashEffectReceipt,
  hashRecourseContract,
  type Hex20,
  type Hex32,
  type RecourseContract,
} from "../runtime-ts/packages/receipts/src/index.ts";
import {
  adapterAccount,
  compensatorAccount,
} from "../runtime-ts/packages/receipts/test/helpers.ts";

const ENDPOINT = process.env.RECOURSE_LOCALSTACK_URL ?? "http://localhost:4566";
const BOND_MAX = 1000;
const PAYOUT_PER_CHANGE = 10;

const DOMAIN = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};

const EMPTY_CONTRACT_ID =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex32;

const ALLOWED_PREFIX = "/recourse/test/";
function paramName(i: number): string {
  return `${ALLOWED_PREFIX}p${i}`;
}

function makeContract(
  resourceId: string,
  action: CellSpec["action"],
): RecourseContract {
  const draft: RecourseContract = {
    schemaVersion: 1,
    contractId: EMPTY_CONTRACT_ID,
    operator: "0x000000000000000000000000000000000000bEEF" as Hex20,
    actionTemplate: { tool: "cloud", action },
    resourceScope: {
      type: "cloud-resource",
      descriptor: { service: "ssm", resourceId },
    },
    effectClass: "compensable",
    recoveryOperator: {
      compensatorId: "cloud",
      freshnessSeconds: 60,
      retentionSeconds: 3600,
      authPolicyHash: hashEvidence("cloud-auth").hash,
    },
    coveredLossClass: { codes: ["excess_spend_usd"], excludeList: [] },
    payoutRule: {
      type: "excessSpendSchedule",
      params: { coverageRatio: "1", deductibleUsd: "0" },
      maxPayout: String(BOND_MAX),
    },
    bond: {
      asset: "0x0000000000000000000000000000000000000001",
      minAmount: String(BOND_MAX),
      maxAggregateExposure: String(BOND_MAX),
    },
    evidenceSchema: {
      schemaId: hashEvidence("cloud-schema").hash,
      requiredProvenance: "L1",
      accessPolicyHash: hashEvidence("cloud-access").hash,
    },
    deadlines: { recoverySeconds: 60, submissionSeconds: 300, livenessSeconds: 600 },
    disputeRoute: {
      arbitrator: "0x0000000000000000000000000000000000000002",
      evidenceGroupId: "1",
    },
  };
  return { ...draft, contractId: hashRecourseContract(draft) };
}

interface CellSpec {
  cellId: string;
  scenario: string;
  action: "set-parameter" | "delete-parameter" | "rotate-parameter";
  resourceId: string;
  callResourceId: string;
  // Optional: separate params.resourceId from resource.resourceId to exercise
  // the adapter's mismatch check; defaults to callResourceId when undefined.
  paramsResourceId?: string;
  setValue: string;
  // If true, run the compensator after admission to restore the prior value.
  restore: boolean;
  expectAdmitted: boolean;
  rejectionKind?: string;
}

function makeCells(): CellSpec[] {
  let n = 0;
  const id = (s: string) => `cell-${String(++n).padStart(2, "0")}-${s}`;
  const cells: CellSpec[] = [];

  // 1-4: set-parameter overwrites followed by full restore (recoverable).
  for (let i = 0; i < 4; i++) {
    cells.push({
      cellId: id(`set-restore-p${i}`),
      scenario: "set-recoverable",
      action: "set-parameter",
      resourceId: paramName(i),
      callResourceId: paramName(i),
      setValue: `mutated-${i}`,
      restore: true,
      expectAdmitted: true,
    });
  }

  // 5-8: set-parameter overwrites that are NOT restored (residual harm = 1 each).
  for (let i = 4; i < 8; i++) {
    cells.push({
      cellId: id(`set-noundo-p${i}`),
      scenario: "set-unrecovered",
      action: "set-parameter",
      resourceId: paramName(i),
      callResourceId: paramName(i),
      setValue: `mutated-${i}`,
      restore: false,
      expectAdmitted: true,
    });
  }

  // 9-12: delete-parameter on p8..p9 (restored from version-history backup),
  // with two delete cells that fail-to-restore (compensator partial). Total 4.
  for (let i = 8; i < 10; i++) {
    cells.push({
      cellId: id(`delete-restore-p${i}`),
      scenario: "delete-recoverable",
      action: "delete-parameter",
      resourceId: paramName(i),
      callResourceId: paramName(i),
      setValue: "",
      restore: true,
      expectAdmitted: true,
    });
  }
  for (let i = 8; i < 10; i++) {
    cells.push({
      cellId: id(`delete-norestore-p${i}-bis`),
      scenario: "delete-unrecovered",
      action: "delete-parameter",
      resourceId: paramName(i),
      callResourceId: paramName(i),
      setValue: "",
      restore: false,
      expectAdmitted: true,
    });
  }

  // 13-20: 8 over-scope, adapter-rejected.
  //   13 cross-account ARN (different account id in ARN)
  cells.push({
    cellId: id("rejected-cross-account-arn"),
    scenario: "rejected-cross-account",
    action: "set-parameter",
    resourceId: paramName(0),
    callResourceId: "arn:aws:ssm:us-east-1:999999999999:parameter/recourse/test/p0",
    setValue: "x",
    restore: false,
    expectAdmitted: false,
    rejectionKind: "cross-account",
  });
  //   14 wrong path prefix (/foreign/...)
  cells.push({
    cellId: id("rejected-wrong-prefix"),
    scenario: "rejected-wrong-prefix",
    action: "set-parameter",
    resourceId: "/foreign/zone/p1",
    callResourceId: "/foreign/zone/p1",
    setValue: "x",
    restore: false,
    expectAdmitted: false,
    rejectionKind: "wrong-prefix",
  });
  //   15 ARN-mismatch: params.resourceId != resource.resourceId
  cells.push({
    cellId: id("rejected-arn-mismatch"),
    scenario: "rejected-resource-mismatch",
    action: "set-parameter",
    resourceId: paramName(2),
    callResourceId: paramName(2),
    paramsResourceId: paramName(3), // mismatch trips adapter parseParams check
    setValue: "x",
    restore: false,
    expectAdmitted: false,
    rejectionKind: "resource-mismatch",
  });
  //   16 untyped/empty value for set-parameter
  cells.push({
    cellId: id("rejected-empty-value"),
    scenario: "rejected-untyped-value",
    action: "set-parameter",
    resourceId: paramName(4),
    callResourceId: paramName(4),
    setValue: "", // we'll signal this as missing string by passing config={}
    restore: false,
    expectAdmitted: false,
    rejectionKind: "untyped-value",
  });
  //   17 unsupported action (rotate-parameter)
  cells.push({
    cellId: id("rejected-rotate-action"),
    scenario: "rejected-action",
    action: "rotate-parameter",
    resourceId: paramName(5),
    callResourceId: paramName(5),
    setValue: "x",
    restore: false,
    expectAdmitted: false,
    rejectionKind: "unsupported-action",
  });
  //   18 invalid parameter name (illegal chars)
  cells.push({
    cellId: id("rejected-invalid-name"),
    scenario: "rejected-invalid-name",
    action: "set-parameter",
    resourceId: "/recourse/test/p?evil$",
    callResourceId: "/recourse/test/p?evil$",
    setValue: "x",
    restore: false,
    expectAdmitted: false,
    rejectionKind: "invalid-name",
  });
  //   19 wrong-region prefix (ssm path style with region suffix)
  cells.push({
    cellId: id("rejected-wrong-region"),
    scenario: "rejected-wrong-region",
    action: "set-parameter",
    resourceId: "/recourse-prod/test/p7",
    callResourceId: "/recourse-prod/test/p7",
    setValue: "x",
    restore: false,
    expectAdmitted: false,
    rejectionKind: "wrong-region",
  });
  //   20 cross-account: ARN form for completely different account/region
  cells.push({
    cellId: id("rejected-foreign-arn"),
    scenario: "rejected-cross-account",
    action: "set-parameter",
    resourceId: "arn:aws:ssm:eu-west-1:000000000000:parameter/unrelated/p8",
    callResourceId: "arn:aws:ssm:eu-west-1:000000000000:parameter/unrelated/p8",
    setValue: "x",
    restore: false,
    expectAdmitted: false,
    rejectionKind: "cross-account-foreign",
  });

  return cells;
}

interface CellRecord {
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
  gross_harm_changes: number;
  recovered_changes: number;
  residual_harm_changes: number;
  recovery_outcome: string | null;
  sign_provider_latency_ms: number;
  recovery_latency_ms: number;
  bond_locked: number;
  bond_max: number;
  bond_utilization: number;
  bond_shortfall: number;
  receipt_hash: string | null;
  ssm_version_after: number | null;
}

async function seedParameters(
  client: LocalStackSsmCloudClient,
  count: number,
): Promise<Record<string, string>> {
  const seeded: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const name = paramName(i);
    const value = `seed-value-${i}`;
    // best-effort cleanup so version history doesn't unbound across runs
    await client.deleteParameter(name);
    await client.putParameter(name, value);
    seeded[name] = value;
  }
  return seeded;
}

async function runCell(
  client: LocalStackSsmCloudClient,
  spec: CellSpec,
  baseTs: number,
  seedValues: Record<string, string>,
): Promise<CellRecord> {
  // Build params.config according to scenario.
  // For "rejected-untyped-value" we omit `value` to trip the typed-value check.
  let paramsConfig: Record<string, unknown>;
  if (spec.rejectionKind === "untyped-value") {
    paramsConfig = {}; // no `value` -> AdapterScopeError per cloud.ts
  } else {
    paramsConfig = { value: spec.setValue };
  }

  const paramsRid = spec.paramsResourceId ?? spec.callResourceId;
  const contract = makeContract(spec.resourceId, spec.action);
  const call: ToolCall = {
    contractId: contract.contractId,
    jobId: ("0xdead" +
      spec.cellId.replace(/[^0-9a-f]/gi, "0").padEnd(60, "0").slice(0, 60)) as Hex32,
    tool: "cloud",
    action: spec.action,
    params: { resourceId: paramsRid, config: paramsConfig },
    resource: { resourceId: spec.callResourceId },
  };

  // Adapter scope: only the canonical seeded names are admitted.
  const allowed: string[] = [];
  for (let i = 0; i < 10; i++) allowed.push(paramName(i));

  const adapter = new CloudAdapter({
    domain: DOMAIN,
    signer: adapterAccount,
    adapterAddress: adapterAccount.address as Hex20,
    now: () => baseTs,
    recordToChain: async (r) => hashEffectReceipt({ domain: DOMAIN, receipt: r }),
    client,
    allowedResources: allowed,
  });

  let admitted = false;
  let rejectedReason: string | null = null;
  let preValue: string | null = null;
  let postValue: string | null = null;
  let preVersion: number | null = null;
  let postVersion: number | null = null;
  let receiptHash: string | null = null;
  let outcome: string | null = null;
  let recoveredChanges = 0;
  let recoveryLatencyMs = 0;
  let ssmVersionAfter: number | null = null;
  let runResult: Awaited<ReturnType<CloudAdapter["run"]>> | undefined;

  const startSign = performance.now();
  try {
    runResult = await adapter.run(call);
    admitted = true;
    preValue = runResult.providerOutcome.previous;
    postValue = runResult.providerOutcome.next;
    postVersion = runResult.providerOutcome.version;
    const { signature: _signature, ...unsignedReceipt } = runResult.receipt;
    receiptHash = hashEffectReceipt({
      domain: DOMAIN,
      receipt: unsignedReceipt,
    });
  } catch (e) {
    if (e instanceof AdapterScopeError) {
      rejectedReason = e.message;
    } else if (e instanceof CloudClientError) {
      rejectedReason = e.message;
    } else if (e instanceof Error) {
      rejectedReason = e.message;
    } else {
      rejectedReason = String(e);
    }
  }
  const endSign = performance.now();
  const signProviderLatencyMs = endSign - startSign;

  // Compute gross harm: 1 parameter-change for any admitted set/delete.
  const grossHarm = admitted ? 1 : 0;

  // Recovery: restore the parameter to its seed value, if requested.
  if (admitted && spec.restore) {
    const seed = seedValues[spec.resourceId] ?? null;
    if (seed !== null) {
      const compensator = new CloudCompensator({
        contract,
        domain: DOMAIN,
        signer: compensatorAccount,
        compensatorAddress: compensatorAccount.address as Hex20,
        now: () => baseTs + 5,
        client,
        resourceId: spec.resourceId,
        restoreValue: seed,
      });
      const startRec = performance.now();
      const rec = await compensator.recover(runResult!.receipt);
      const endRec = performance.now();
      recoveryLatencyMs = endRec - startRec;
      outcome = rec.outcome;
      if (rec.outcome === "success" || rec.outcome === "partial") {
        recoveredChanges = 1;
      }
      const after = await client.getParameter(spec.resourceId);
      ssmVersionAfter = after?.version ?? null;
    } else {
      outcome = "failure";
    }
  } else if (admitted && !spec.restore) {
    // mutation stands; record post-mutation parameter version for evidence.
    if (spec.action === "delete-parameter") {
      // re-create with the mutated value so subsequent cells targeting same key
      // still find something; but mark recovered = 0 for residual accounting.
      // (We re-seed AFTER recording the residual harm.)
      const seed = seedValues[spec.resourceId] ?? "seed-restore";
      await client.putParameter(spec.resourceId, seed);
    }
    outcome = "n/a";
    const after = await client.getParameter(spec.resourceId);
    ssmVersionAfter = after?.version ?? null;
  }

  // Capture pre-version for evidence (read AFTER admission so it's authoritative
  // when the call modified state; for rejected cells this is current state).
  const cur = await client.getParameter(spec.resourceId).catch(() => null);
  if (cur && preVersion === null && runResult) {
    // pre-version is post-1 if PutParameter incremented Version.
    preVersion = postVersion !== null ? Math.max(1, postVersion - 1) : null;
  }
  if (cur) ssmVersionAfter = cur.version ?? ssmVersionAfter;

  const residualHarm = Math.max(0, grossHarm - recoveredChanges);
  const bondNeeded = residualHarm * PAYOUT_PER_CHANGE;
  const bondShortfall = Math.max(0, bondNeeded - BOND_MAX);
  const bondLocked = Math.min(bondNeeded, BOND_MAX);

  return {
    cell_id: spec.cellId,
    scenario: spec.scenario,
    action: spec.action,
    resource_id: spec.resourceId,
    call_resource_id: spec.callResourceId,
    expected_admitted: spec.expectAdmitted,
    admitted,
    rejected_reason: rejectedReason,
    rejection_kind: spec.rejectionKind ?? null,
    pre_value: preValue,
    post_value: postValue,
    pre_version: preVersion,
    post_version: postVersion,
    gross_harm_changes: grossHarm,
    recovered_changes: recoveredChanges,
    residual_harm_changes: residualHarm,
    recovery_outcome: outcome,
    sign_provider_latency_ms: signProviderLatencyMs,
    recovery_latency_ms: recoveryLatencyMs,
    bond_locked: bondLocked,
    bond_max: BOND_MAX,
    bond_utilization: bondLocked / BOND_MAX,
    bond_shortfall: bondShortfall,
    receipt_hash: receiptHash,
    ssm_version_after: ssmVersionAfter,
  };
}

async function main(): Promise<void> {
  const outPath = process.argv[2];
  if (!outPath) {
    console.error("usage: bun run scripts/provider-bench-cloud.ts <output.json>");
    process.exit(2);
  }

  const client = new LocalStackSsmCloudClient({ endpoint: ENDPOINT });

  // Connectivity probe.
  await client.getParameter("/recourse/test/__probe__");

  const seedValues = await seedParameters(client, 10);

  const cells = makeCells();
  const baseTs = 1_746_979_200;
  const records: CellRecord[] = [];

  const wallStart = performance.now();
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const rec = await runCell(client, c, baseTs + i * 10, seedValues);
    records.push(rec);
    process.stderr.write(
      `[cell ${i + 1}/${cells.length}] ${c.cellId} -> admitted=${rec.admitted} ` +
        `gross=${rec.gross_harm_changes} recovered=${rec.recovered_changes} ` +
        `residual=${rec.residual_harm_changes} ` +
        `latency=${rec.sign_provider_latency_ms.toFixed(2)}ms\n`,
    );
  }
  const wallEnd = performance.now();

  // Cleanup seeded parameters.
  for (let i = 0; i < 10; i++) {
    try {
      await client.deleteParameter(paramName(i));
    } catch {
      /* ignore */
    }
  }

  const out = {
    schemaVersion: 1,
    provider: "cloud",
    workload: "cloud",
    providerBacked: false,
    providerCompatibleSandbox: true,
    endpoint: ENDPOINT,
    bondMax: BOND_MAX,
    payoutPerChange: PAYOUT_PER_CHANGE,
    seedValues,
    totalWallClockMs: wallEnd - wallStart,
    env: {
      bunVersion: process.versions.bun ?? "unknown",
      platform: process.platform,
      arch: process.arch,
    },
    cells: records,
  };

  await writeFile(outPath, JSON.stringify(out, null, 2));
  process.stderr.write(`wrote ${outPath}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
