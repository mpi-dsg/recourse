/**
 * provider-compatible local Postgres bench for rq-provider-postgres.
 *
 * Runs ~20 admitted-action cells against a real Postgres reachable at
 * RECOURSE_PG_URL. Uses the existing EIP-712 signing path through
 * RecourseAdapter.run() and RecourseCompensator.recover(). Emits one JSON
 * record per cell to RECOURSE_BENCH_OUT (default: stdout).
 *
 * Cells cover:
 *   - in-scope UPDATE (recoverable / not deleting)
 *   - in-scope DELETE with full snapshot (success recovery)
 *   - in-scope DELETE with partial snapshot (partial recovery, residual loss)
 *   - in-scope DELETE with no snapshot (failure recovery, all rows lost)
 *   - out-of-scope: wrong table, mismatched resource, empty where,
 *                   sql-injection identifier, CREATE TABLE (unsupported action)
 *
 * Cells classified as "rejected" never reach the provider — they bounce at
 * the adapter's scope/predicate gate.
 */

import { performance } from "node:perf_hooks";
import { Client } from "pg";
import { type ToolCall, AdapterScopeError } from "../../adapter-sdk/src/index.ts";
import { hashEvidence } from "../../evidence-store/src/index.ts";
import {
  hashEffectReceipt,
  hashRecourseContract,
  type Hex20,
  type Hex32,
  type RecourseContract,
} from "../../receipts/src/index.ts";
import { adapterAccount, compensatorAccount } from "../../receipts/test/helpers.ts";
import { PgPostgresAdapter } from "../src/pg.ts";
import { PgPostgresCompensator } from "../../compensators/postgres/src/pg.ts";

type Row = { id: number; tenant_id: string; value: string };

const PG_URL = process.env.RECOURSE_PG_URL ?? "postgresql://recourse:recourse@localhost:55432/recourse_test";
const OUT_PATH = process.env.RECOURSE_BENCH_OUT;
const BOND_MAX = 1000;
const PAYOUT_PER_ROW = 10;

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};

const EMPTY_CONTRACT_ID = `0x${"0".repeat(64)}` as Hex32;
// Cell plans are action-agnostic. runCell replaces this placeholder with the
// canonical ID of the action-specific κ before executing.
const contractId = EMPTY_CONTRACT_ID;

function makeContract(action: "delete" | "update"): RecourseContract {
  const draft: RecourseContract = {
    schemaVersion: 1,
    contractId: EMPTY_CONTRACT_ID,
    operator: "0x000000000000000000000000000000000000bEEF" as Hex20,
    actionTemplate: { tool: "postgres", action },
    resourceScope: { type: "postgres-table", descriptor: { table: "tenant_rows" } },
    effectClass: "compensable",
    recoveryOperator: {
      compensatorId: "postgres",
      freshnessSeconds: 60,
      retentionSeconds: 3600,
      authPolicyHash: hashEvidence("auth").hash,
    },
    coveredLossClass: {
      codes: [action === "delete" ? "rows_deleted" : "rows_modified"],
      excludeList: [],
    },
    payoutRule: {
      type: "rowCountSchedule",
      params: { perRowUsd: String(PAYOUT_PER_ROW) },
      maxPayout: String(BOND_MAX),
    },
    bond: {
      asset: "0x0000000000000000000000000000000000000001",
      minAmount: String(BOND_MAX),
      maxAggregateExposure: String(BOND_MAX),
    },
    evidenceSchema: {
      schemaId: hashEvidence("schema").hash,
      requiredProvenance: "L1",
      accessPolicyHash: hashEvidence("access").hash,
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
  call: ToolCall;
  // If non-null: we'll snapshot rows matching this WHERE before delete and
  // pass that snapshot (possibly truncated) to the compensator.
  snapshotPredicate?: { tenant_id: string };
  snapshotKeep?: "all" | "half" | "none";
  expectAdmitted: boolean;
}

function makeCells(): CellSpec[] {
  let n = 0;
  const id = (s: string) => `cell-${String(++n).padStart(2, "0")}-${s}`;
  const job = (i: number): Hex32 =>
    (`0xdead${i.toString(16).padStart(60, "0")}`) as Hex32;

  const cells: CellSpec[] = [
    // 1. Recoverable DELETE: full snapshot, ~3 rows tenant-a
    {
      cellId: id("delete-tenant-a-full-snap"),
      scenario: "delete-recoverable-full",
      call: {
        contractId,
        jobId: job(1),
        tool: "postgres",
        action: "delete",
        params: { table: "tenant_rows", where: { tenant_id: "tenant-a" } },
        resource: { table: "tenant_rows" },
      },
      snapshotPredicate: { tenant_id: "tenant-a" },
      snapshotKeep: "all",
      expectAdmitted: true,
    },
    // 2. Partial recovery: only half of snapshot survives
    {
      cellId: id("delete-tenant-b-half-snap"),
      scenario: "delete-partial",
      call: {
        contractId,
        jobId: job(2),
        tool: "postgres",
        action: "delete",
        params: { table: "tenant_rows", where: { tenant_id: "tenant-b" } },
        resource: { table: "tenant_rows" },
      },
      snapshotPredicate: { tenant_id: "tenant-b" },
      snapshotKeep: "half",
      expectAdmitted: true,
    },
    // 3. Unrecoverable: snapshot empty -> all rows lost (residual harm)
    {
      cellId: id("delete-tenant-c-no-snap"),
      scenario: "delete-unrecoverable",
      call: {
        contractId,
        jobId: job(3),
        tool: "postgres",
        action: "delete",
        params: { table: "tenant_rows", where: { tenant_id: "tenant-c" } },
        resource: { table: "tenant_rows" },
      },
      snapshotPredicate: { tenant_id: "tenant-c" },
      snapshotKeep: "none",
      expectAdmitted: true,
    },
    // 4. UPDATE in-scope (no rows lost; update is reversible-ish, recovery still attempted)
    {
      cellId: id("update-tenant-d"),
      scenario: "update-inscope",
      call: {
        contractId,
        jobId: job(4),
        tool: "postgres",
        action: "update",
        params: {
          table: "tenant_rows",
          where: { tenant_id: "tenant-d" },
          set: { value: "redacted" },
        },
        resource: { table: "tenant_rows" },
      },
      expectAdmitted: true,
    },
    // 5. Recoverable DELETE: tenant-e full snapshot (small set)
    {
      cellId: id("delete-tenant-e-full-snap"),
      scenario: "delete-recoverable-full",
      call: {
        contractId,
        jobId: job(5),
        tool: "postgres",
        action: "delete",
        params: { table: "tenant_rows", where: { tenant_id: "tenant-e" } },
        resource: { table: "tenant_rows" },
      },
      snapshotPredicate: { tenant_id: "tenant-e" },
      snapshotKeep: "all",
      expectAdmitted: true,
    },
    // 6. Partial recovery: tenant-f half snap
    {
      cellId: id("delete-tenant-f-half-snap"),
      scenario: "delete-partial",
      call: {
        contractId,
        jobId: job(6),
        tool: "postgres",
        action: "delete",
        params: { table: "tenant_rows", where: { tenant_id: "tenant-f" } },
        resource: { table: "tenant_rows" },
      },
      snapshotPredicate: { tenant_id: "tenant-f" },
      snapshotKeep: "half",
      expectAdmitted: true,
    },
    // 7. Unrecoverable tenant-g
    {
      cellId: id("delete-tenant-g-no-snap"),
      scenario: "delete-unrecoverable",
      call: {
        contractId,
        jobId: job(7),
        tool: "postgres",
        action: "delete",
        params: { table: "tenant_rows", where: { tenant_id: "tenant-g" } },
        resource: { table: "tenant_rows" },
      },
      snapshotPredicate: { tenant_id: "tenant-g" },
      snapshotKeep: "none",
      expectAdmitted: true,
    },
    // 8. UPDATE tenant-h
    {
      cellId: id("update-tenant-h"),
      scenario: "update-inscope",
      call: {
        contractId,
        jobId: job(8),
        tool: "postgres",
        action: "update",
        params: {
          table: "tenant_rows",
          where: { tenant_id: "tenant-h" },
          set: { value: "scrubbed" },
        },
        resource: { table: "tenant_rows" },
      },
      expectAdmitted: true,
    },
    // 9. Recoverable DELETE tenant-i full
    {
      cellId: id("delete-tenant-i-full-snap"),
      scenario: "delete-recoverable-full",
      call: {
        contractId,
        jobId: job(9),
        tool: "postgres",
        action: "delete",
        params: { table: "tenant_rows", where: { tenant_id: "tenant-i" } },
        resource: { table: "tenant_rows" },
      },
      snapshotPredicate: { tenant_id: "tenant-i" },
      snapshotKeep: "all",
      expectAdmitted: true,
    },
    // 10. Partial tenant-j
    {
      cellId: id("delete-tenant-j-half-snap"),
      scenario: "delete-partial",
      call: {
        contractId,
        jobId: job(10),
        tool: "postgres",
        action: "delete",
        params: { table: "tenant_rows", where: { tenant_id: "tenant-j" } },
        resource: { table: "tenant_rows" },
      },
      snapshotPredicate: { tenant_id: "tenant-j" },
      snapshotKeep: "half",
      expectAdmitted: true,
    },
    // 11. Unrecoverable tenant-k
    {
      cellId: id("delete-tenant-k-no-snap"),
      scenario: "delete-unrecoverable",
      call: {
        contractId,
        jobId: job(11),
        tool: "postgres",
        action: "delete",
        params: { table: "tenant_rows", where: { tenant_id: "tenant-k" } },
        resource: { table: "tenant_rows" },
      },
      snapshotPredicate: { tenant_id: "tenant-k" },
      snapshotKeep: "none",
      expectAdmitted: true,
    },
    // 12. UPDATE tenant-l
    {
      cellId: id("update-tenant-l"),
      scenario: "update-inscope",
      call: {
        contractId,
        jobId: job(12),
        tool: "postgres",
        action: "update",
        params: {
          table: "tenant_rows",
          where: { tenant_id: "tenant-l" },
          set: { value: "anon" },
        },
        resource: { table: "tenant_rows" },
      },
      expectAdmitted: true,
    },
    // 13. Recoverable DELETE tenant-m full
    {
      cellId: id("delete-tenant-m-full-snap"),
      scenario: "delete-recoverable-full",
      call: {
        contractId,
        jobId: job(13),
        tool: "postgres",
        action: "delete",
        params: { table: "tenant_rows", where: { tenant_id: "tenant-m" } },
        resource: { table: "tenant_rows" },
      },
      snapshotPredicate: { tenant_id: "tenant-m" },
      snapshotKeep: "all",
      expectAdmitted: true,
    },
    // 14. UPDATE tenant-n
    {
      cellId: id("update-tenant-n"),
      scenario: "update-inscope",
      call: {
        contractId,
        jobId: job(14),
        tool: "postgres",
        action: "update",
        params: {
          table: "tenant_rows",
          where: { tenant_id: "tenant-n" },
          set: { value: "masked" },
        },
        resource: { table: "tenant_rows" },
      },
      expectAdmitted: true,
    },
    // 15. Partial tenant-o
    {
      cellId: id("delete-tenant-o-half-snap"),
      scenario: "delete-partial",
      call: {
        contractId,
        jobId: job(15),
        tool: "postgres",
        action: "delete",
        params: { table: "tenant_rows", where: { tenant_id: "tenant-o" } },
        resource: { table: "tenant_rows" },
      },
      snapshotPredicate: { tenant_id: "tenant-o" },
      snapshotKeep: "half",
      expectAdmitted: true,
    },
    // 16. REJECTED: out-of-scope table audit_logs (allowed list excludes it)
    {
      cellId: id("rejected-out-of-scope-table"),
      scenario: "rejected-scope",
      call: {
        contractId,
        jobId: job(16),
        tool: "postgres",
        action: "delete",
        params: { table: "audit_logs", where: { tenant_id: "tenant-a" } },
        resource: { table: "audit_logs" },
      },
      expectAdmitted: false,
    },
    // 17. REJECTED: params/resource table mismatch
    {
      cellId: id("rejected-table-mismatch"),
      scenario: "rejected-scope",
      call: {
        contractId,
        jobId: job(17),
        tool: "postgres",
        action: "delete",
        params: { table: "tenant_rows", where: { tenant_id: "tenant-a" } },
        resource: { table: "audit_logs" },
      },
      expectAdmitted: false,
    },
    // 18. REJECTED: empty WHERE predicate (over-broad)
    {
      cellId: id("rejected-empty-where"),
      scenario: "rejected-predicate",
      call: {
        contractId,
        jobId: job(18),
        tool: "postgres",
        action: "delete",
        params: { table: "tenant_rows", where: {} },
        resource: { table: "tenant_rows" },
      },
      expectAdmitted: false,
    },
    // 19. REJECTED: SQL-injection-shaped table identifier
    {
      cellId: id("rejected-sql-injection-ident"),
      scenario: "rejected-scope",
      call: {
        contractId,
        jobId: job(19),
        tool: "postgres",
        action: "delete",
        params: {
          table: 'tenant_rows"; DROP TABLE tenant_rows;--',
          where: { tenant_id: "x" },
        },
        resource: { table: 'tenant_rows"; DROP TABLE tenant_rows;--' },
      },
      expectAdmitted: false,
    },
    // 20. REJECTED: unsupported action 'create_table'
    {
      cellId: id("rejected-create-table"),
      scenario: "rejected-action",
      call: {
        contractId,
        jobId: job(20),
        tool: "postgres",
        action: "create_table",
        params: { table: "tenant_rows", where: { tenant_id: "tenant-a" } },
        resource: { table: "tenant_rows" },
      },
      expectAdmitted: false,
    },
  ];
  return cells;
}

async function reseedTable(client: Client): Promise<void> {
  await client.query("DROP TABLE IF EXISTS tenant_rows");
  await client.query(`
    CREATE TABLE tenant_rows (
      id INT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      value TEXT NOT NULL
    )
  `);
  // 15 tenants, each with 3 rows -> 45 rows total
  const values: string[] = [];
  let pk = 1;
  const tenants = "abcdefghijklmno".split("");
  for (const t of tenants) {
    for (let r = 0; r < 3; r++) {
      values.push(`(${pk}, 'tenant-${t}', 'value-${t}-${r}')`);
      pk++;
    }
  }
  await client.query(
    `INSERT INTO tenant_rows (id, tenant_id, value) VALUES ${values.join(", ")}`,
  );
}

async function runCell(
  client: Client,
  spec: CellSpec,
  now: number,
): Promise<Record<string, unknown>> {
  const txHash = hashEvidence(`local-chain-stub:${spec.cellId}`).hash;
  const actionContract = makeContract(spec.call.action === "update" ? "update" : "delete");
  const call = { ...spec.call, contractId: actionContract.contractId };

  const adapter = new PgPostgresAdapter({
    domain,
    signer: adapterAccount,
    adapterAddress: adapterAccount.address as Hex20,
    now: () => now,
    recordToChain: async () => txHash,
    client,
    allowedTables: ["tenant_rows"],
  });

  // Capture pre-delete snapshot if this is a delete with a snapshot policy.
  let snapshotRows: Row[] = [];
  let preExistingMatches = 0;
  if (
    spec.expectAdmitted &&
    spec.call.action === "delete" &&
    spec.snapshotPredicate
  ) {
    const r = await client.query<Row>(
      "SELECT id, tenant_id, value FROM tenant_rows WHERE tenant_id = $1 ORDER BY id",
      [spec.snapshotPredicate.tenant_id],
    );
    preExistingMatches = r.rowCount ?? 0;
    if (spec.snapshotKeep === "all") {
      snapshotRows = r.rows;
    } else if (spec.snapshotKeep === "half") {
      snapshotRows = r.rows.slice(0, Math.floor(r.rows.length / 2));
    } else {
      snapshotRows = [];
    }
  }

  const startSign = performance.now();
  let admitted = false;
  let rejectedReason: string | null = null;
  let affectedRows = 0;
  let receiptHash: Hex32 | null = null;
  let recoveryOutcome: string | null = null;
  let recoveredRows = 0;
  let recoveryReceiptOutcome: string | null = null;
  let txid: string | null = null;
  let preLsn: string | null = null;
  let postLsn: string | null = null;

  let result;
  try {
    result = await adapter.run(call);
    admitted = true;
    affectedRows = result.providerOutcome.affectedRows;
    txid = result.providerOutcome.txid;
    preLsn = result.providerOutcome.preLsn;
    postLsn = result.providerOutcome.postLsn;
    const { signature: _signature, ...unsignedReceipt } = result.receipt;
    receiptHash = hashEffectReceipt({
      domain,
      receipt: unsignedReceipt,
    });
  } catch (e) {
    if (e instanceof AdapterScopeError) {
      rejectedReason = e.message;
    } else if (e instanceof Error) {
      rejectedReason = e.message;
    } else {
      rejectedReason = String(e);
    }
  }
  const endSign = performance.now();
  const signProviderLatencyMs = endSign - startSign;

  let recoveryLatencyMs = 0;
  if (admitted && result && spec.call.action === "delete" && spec.snapshotPredicate) {
    const compensator = new PgPostgresCompensator({
      contract: actionContract,
      domain,
      signer: compensatorAccount,
      compensatorAddress: compensatorAccount.address as Hex20,
      now: () => now + 5,
      client,
      tableName: "tenant_rows",
      primaryKey: "id",
      snapshotRows: snapshotRows as unknown as Record<string, unknown>[],
      expectedRecoveredRows: affectedRows,
    });
    const startRec = performance.now();
    const rec = await compensator.recover(result.receipt);
    const endRec = performance.now();
    recoveryLatencyMs = endRec - startRec;
    recoveryOutcome = rec.outcome;
    recoveryReceiptOutcome = rec.outcome;
    const recoveredStr = rec.residualMeasurements?.recovered_row_count?.value;
    recoveredRows = recoveredStr ? Number(recoveredStr) : 0;
  } else if (admitted && result && spec.call.action === "update") {
    // updates: no row loss, no recovery side effect to restore. Treat as
    // success with recoveredRows == 0 and gross_harm = 0.
    recoveryOutcome = "n/a";
  }

  // Harm accounting in rows:
  // - For DELETE: gross_harm = affected_rows; recovered = restored rows;
  //   residual = gross - recovered.
  // - For UPDATE: gross_harm = 0 (no rows lost). Note: updates do mutate
  //   rows but our covered loss class is rows_deleted; updates are listed
  //   for completeness of admitted-action mix.
  // - For REJECTED: nothing executed; harm = 0.
  const grossHarm = admitted && spec.call.action === "delete" ? affectedRows : 0;
  const residualHarm = Math.max(0, grossHarm - recoveredRows);

  const bondNeeded = residualHarm * PAYOUT_PER_ROW;
  const bondShortfall = Math.max(0, bondNeeded - BOND_MAX);
  const bondLocked = Math.min(bondNeeded, BOND_MAX);

  return {
    cell_id: spec.cellId,
    scenario: spec.scenario,
    action: spec.call.action,
    table: (spec.call.resource as { table: string }).table,
    expected_admitted: spec.expectAdmitted,
    admitted,
    rejected_reason: rejectedReason,
    pre_existing_matches: preExistingMatches,
    snapshot_rows: snapshotRows.length,
    affected_rows: affectedRows,
    gross_harm_rows: grossHarm,
    recovered_rows: recoveredRows,
    residual_harm_rows: residualHarm,
    recovery_outcome: recoveryOutcome,
    sign_provider_latency_ms: signProviderLatencyMs,
    recovery_latency_ms: recoveryLatencyMs,
    bond_locked: bondLocked,
    bond_max: BOND_MAX,
    bond_utilization: bondLocked / BOND_MAX,
    bond_shortfall: bondShortfall,
    pg_txid: txid,
    pre_lsn: preLsn,
    post_lsn: postLsn,
    receipt_hash: receiptHash,
    recovery_receipt_outcome: recoveryReceiptOutcome,
  };
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: PG_URL });
  await client.connect();

  // Warm-up: verify connectivity
  await client.query("SELECT 1");

  await reseedTable(client);

  const cells = makeCells();
  const baseTs = 1_746_979_200;
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const rec = await runCell(client, c, baseTs + i * 10);
    records.push(rec);
    process.stderr.write(
      `[cell ${i + 1}/${cells.length}] ${c.cellId} -> admitted=${rec.admitted} ` +
        `gross=${rec.gross_harm_rows} recovered=${rec.recovered_rows} ` +
        `residual=${rec.residual_harm_rows} ` +
        `latency=${(rec.sign_provider_latency_ms as number).toFixed(2)}ms\n`,
    );
  }

  await client.end();

  const out = JSON.stringify(
    {
      schemaVersion: 1,
      provider: "postgres",
      pgUrl: PG_URL.replace(/:[^:@]+@/, ":***@"),
      cells: records,
    },
    null,
    2,
  );

  if (OUT_PATH) {
    await Bun.write(OUT_PATH, out);
    process.stderr.write(`wrote ${OUT_PATH}\n`);
  } else {
    process.stdout.write(out);
  }
}

await main();
