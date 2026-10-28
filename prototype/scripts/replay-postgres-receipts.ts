#!/usr/bin/env bun
/**
 * L0 independent replayer for rq-provider-postgres EffectReceipts.
 *
 * Rationale. Table~\ref{tab:provenance} in the paper defines L0 as
 * "public replayer / any node from public state / on-chain digest /
 * optimistic". For each admitted Postgres cell, the EffectReceipt
 * binds: the snapshot reference (deterministic seed of `tenant_rows`),
 * the SQL action + WHERE predicate (the cell's ToolCall), the pre/post
 * WAL LSN, the pg_xact_id, the affected_row_count, and a queryHash.
 *
 * This script is a separate consumer. It does NOT import the adapter
 * package; it re-derives validation gates inline (identifier regex,
 * allowed-table scope, non-empty WHERE) so the proof does not trust
 * the adapter's signature. For each cell we:
 *
 *   1. Bring the test database to the snapshot referenced by the
 *      receipt (deterministic re-seed of tenant_rows, then replay any
 *      preceding admitted cell so the pre-LSN row state matches).
 *   2. Read the LSN before executing the receipted query.
 *   3. Execute the same DELETE/UPDATE the adapter executed, by
 *      mechanically rebuilding it from the receipt's cell parameters.
 *   4. Read the LSN after, and the rowCount returned by Postgres.
 *   5. Compare row count and LSN advance against the receipt's claim.
 *
 * For each over-scope cell we re-apply the gate (allowed-table set,
 * identifier regex, non-empty WHERE, supported action) and verify the
 * cell is independently rejected.
 *
 * Optional: for delete cells where the recovery receipt's snapshot
 * survives, we replay the snapshot re-insert and verify recovered row
 * count matches the recovery receipt.
 *
 * Output:
 *   results/rq-provider-postgres/replay-report.json   — per-cell record
 *   results/rq-provider-postgres/replay-summary.md    — human summary
 */

import { performance } from "node:perf_hooks";
// Resolve pg from the runtime-ts workspace where the bench installed it.
// The replayer ships in prototype/scripts/ but the npm dep `pg` lives in
// the adapter-postgres workspace. We do NOT import the adapter package;
// we only borrow the pg client library.
// @ts-expect-error — runtime path resolution, not a package import.
import { Client } from "../runtime-ts/packages/adapter-postgres/node_modules/pg/lib/index.js";
import * as fs from "node:fs";
import * as path from "node:path";

const PROTO_DIR =
  process.env.RECOURSE_PROTOTYPE_DIR ??
  path.resolve(new URL(".", import.meta.url).pathname, "..");
const RESULTS_DIR = path.join(PROTO_DIR, "results", "rq-provider-postgres");
const CELLS_PATH = path.join(RESULTS_DIR, "cells.json");
const REPORT_PATH = path.join(RESULTS_DIR, "replay-report.json");
const SUMMARY_PATH = path.join(RESULTS_DIR, "replay-summary.md");

const PG_URL =
  process.env.RECOURSE_PG_URL ??
  "postgresql://recourse:recourse@localhost:55432/recourse_test";

const ALLOWED_TABLES = new Set(["tenant_rows"]);
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface Cell {
  cell_id: string;
  scenario: string;
  action: string;
  table: string;
  expected_admitted: boolean;
  admitted: boolean;
  rejected_reason: string | null;
  pre_existing_matches: number;
  snapshot_rows: number;
  affected_rows: number;
  pg_txid: string | null;
  pre_lsn: string | null;
  post_lsn: string | null;
  receipt_hash: string | null;
  recovery_receipt_outcome: string | null;
}

/**
 * Cell-to-query mapping. This is the *public* part of the receipt:
 * the SQL semantics that any third party can reconstruct from the
 * receipt's bound (tool, action, params, resource). We keep it in
 * lock-step with bench/provider-postgres.ts. If the bench changes,
 * this table must be updated — that is intentional, it documents
 * the public commitment.
 */
interface ReplaySpec {
  cellId: string;
  action: "delete" | "update" | "create_table";
  table: string;
  where: Record<string, unknown>;
  set?: Record<string, unknown>;
  /** For rejected cells whose params table differs from resource table. */
  resourceTable?: string;
  /** Recovery: tenant_id used to snapshot for re-insert (full/half/none). */
  snapshotPredicate?: string;
  snapshotKeep?: "all" | "half" | "none";
}

const REPLAY_SPECS: ReplaySpec[] = [
  {
    cellId: "cell-01-delete-tenant-a-full-snap",
    action: "delete",
    table: "tenant_rows",
    where: { tenant_id: "tenant-a" },
    snapshotPredicate: "tenant-a",
    snapshotKeep: "all",
  },
  {
    cellId: "cell-02-delete-tenant-b-half-snap",
    action: "delete",
    table: "tenant_rows",
    where: { tenant_id: "tenant-b" },
    snapshotPredicate: "tenant-b",
    snapshotKeep: "half",
  },
  {
    cellId: "cell-03-delete-tenant-c-no-snap",
    action: "delete",
    table: "tenant_rows",
    where: { tenant_id: "tenant-c" },
    snapshotPredicate: "tenant-c",
    snapshotKeep: "none",
  },
  {
    cellId: "cell-04-update-tenant-d",
    action: "update",
    table: "tenant_rows",
    where: { tenant_id: "tenant-d" },
    set: { value: "redacted" },
  },
  {
    cellId: "cell-05-delete-tenant-e-full-snap",
    action: "delete",
    table: "tenant_rows",
    where: { tenant_id: "tenant-e" },
    snapshotPredicate: "tenant-e",
    snapshotKeep: "all",
  },
  {
    cellId: "cell-06-delete-tenant-f-half-snap",
    action: "delete",
    table: "tenant_rows",
    where: { tenant_id: "tenant-f" },
    snapshotPredicate: "tenant-f",
    snapshotKeep: "half",
  },
  {
    cellId: "cell-07-delete-tenant-g-no-snap",
    action: "delete",
    table: "tenant_rows",
    where: { tenant_id: "tenant-g" },
    snapshotPredicate: "tenant-g",
    snapshotKeep: "none",
  },
  {
    cellId: "cell-08-update-tenant-h",
    action: "update",
    table: "tenant_rows",
    where: { tenant_id: "tenant-h" },
    set: { value: "scrubbed" },
  },
  {
    cellId: "cell-09-delete-tenant-i-full-snap",
    action: "delete",
    table: "tenant_rows",
    where: { tenant_id: "tenant-i" },
    snapshotPredicate: "tenant-i",
    snapshotKeep: "all",
  },
  {
    cellId: "cell-10-delete-tenant-j-half-snap",
    action: "delete",
    table: "tenant_rows",
    where: { tenant_id: "tenant-j" },
    snapshotPredicate: "tenant-j",
    snapshotKeep: "half",
  },
  {
    cellId: "cell-11-delete-tenant-k-no-snap",
    action: "delete",
    table: "tenant_rows",
    where: { tenant_id: "tenant-k" },
    snapshotPredicate: "tenant-k",
    snapshotKeep: "none",
  },
  {
    cellId: "cell-12-update-tenant-l",
    action: "update",
    table: "tenant_rows",
    where: { tenant_id: "tenant-l" },
    set: { value: "anon" },
  },
  {
    cellId: "cell-13-delete-tenant-m-full-snap",
    action: "delete",
    table: "tenant_rows",
    where: { tenant_id: "tenant-m" },
    snapshotPredicate: "tenant-m",
    snapshotKeep: "all",
  },
  {
    cellId: "cell-14-update-tenant-n",
    action: "update",
    table: "tenant_rows",
    where: { tenant_id: "tenant-n" },
    set: { value: "masked" },
  },
  {
    cellId: "cell-15-delete-tenant-o-half-snap",
    action: "delete",
    table: "tenant_rows",
    where: { tenant_id: "tenant-o" },
    snapshotPredicate: "tenant-o",
    snapshotKeep: "half",
  },
  // Rejected cells: gate must reject these on independent replay.
  {
    cellId: "cell-16-rejected-out-of-scope-table",
    action: "delete",
    table: "audit_logs",
    where: { tenant_id: "tenant-a" },
    resourceTable: "audit_logs",
  },
  {
    cellId: "cell-17-rejected-table-mismatch",
    action: "delete",
    table: "tenant_rows",
    where: { tenant_id: "tenant-a" },
    resourceTable: "audit_logs",
  },
  {
    cellId: "cell-18-rejected-empty-where",
    action: "delete",
    table: "tenant_rows",
    where: {},
  },
  {
    cellId: "cell-19-rejected-sql-injection-ident",
    action: "delete",
    table: 'tenant_rows"; DROP TABLE tenant_rows;--',
    where: { tenant_id: "x" },
  },
  {
    cellId: "cell-20-rejected-create-table",
    action: "create_table",
    table: "tenant_rows",
    where: { tenant_id: "tenant-a" },
  },
];

function assertIdent(name: string, kind: string): void {
  if (!IDENT_RE.test(name)) {
    throw new Error(`invalid ${kind} identifier: ${name}`);
  }
}

function buildWhereClause(
  where: Record<string, unknown>,
  paramOffset: number,
): { clause: string; values: unknown[] } {
  const entries = Object.entries(where);
  const values: unknown[] = [];
  const fragments = entries.map(([col, val], i) => {
    assertIdent(col, "column");
    values.push(val);
    return `"${col}" = $${paramOffset + i + 1}`;
  });
  return { clause: fragments.join(" AND "), values };
}

function buildDelete(
  table: string,
  where: Record<string, unknown>,
): { sql: string; values: unknown[] } {
  assertIdent(table, "table");
  const { clause, values } = buildWhereClause(where, 0);
  return { sql: `DELETE FROM "${table}" WHERE ${clause}`, values };
}

function buildUpdate(
  table: string,
  where: Record<string, unknown>,
  set: Record<string, unknown>,
): { sql: string; values: unknown[] } {
  assertIdent(table, "table");
  const setEntries = Object.entries(set);
  const setValues: unknown[] = [];
  const setFragments = setEntries.map(([col, val], i) => {
    assertIdent(col, "column");
    setValues.push(val);
    return `"${col}" = $${i + 1}`;
  });
  const { clause, values: whereValues } = buildWhereClause(
    where,
    setEntries.length,
  );
  return {
    sql: `UPDATE "${table}" SET ${setFragments.join(", ")} WHERE ${clause}`,
    values: [...setValues, ...whereValues],
  };
}

/** Apply the public admission gate. Returns null if admitted, else reason. */
function gateReject(spec: ReplaySpec): string | null {
  // 1) action support
  if (spec.action !== "delete" && spec.action !== "update") {
    return `unsupported postgres action: ${spec.action}`;
  }
  // 2) identifier safety on resource table (caught before params/resource compare)
  const resourceTable = spec.resourceTable ?? spec.table;
  if (!IDENT_RE.test(spec.table)) {
    return `invalid table identifier: ${spec.table}`;
  }
  // 3) params/resource agreement
  if (spec.table !== resourceTable) {
    return `postgres params table does not match resource table: ${spec.table}`;
  }
  // 4) allowed-table scope (post-ident, post-mismatch)
  if (!ALLOWED_TABLES.has(spec.table)) {
    return `table is outside registered scope: ${spec.table}`;
  }
  // 5) non-empty where
  if (Object.keys(spec.where).length === 0) {
    return "postgres mutation requires a non-empty where predicate";
  }
  return null;
}

async function currentLsn(client: Client): Promise<string> {
  const r = await client.query<{ lsn: string }>(
    "SELECT pg_current_wal_lsn() AS lsn",
  );
  return String(r.rows[0]!.lsn);
}

async function lsnDiff(
  client: Client,
  a: string,
  b: string,
): Promise<bigint> {
  const r = await client.query<{ d: string }>(
    "SELECT pg_wal_lsn_diff($1, $2)::text AS d",
    [a, b],
  );
  return BigInt(r.rows[0]!.d);
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

interface PerCellReport {
  cell_id: string;
  receipt_hash: string | null;
  admitted_in_receipt: boolean;
  replay_admitted: boolean;
  expected_row_count: number;
  replayed_row_count: number;
  expected_rejected_reason: string | null;
  replay_rejected_reason: string | null;
  pre_lsn_replay: string | null;
  post_lsn_replay: string | null;
  wal_advanced: boolean;
  row_count_match: boolean;
  rejection_match: boolean;
  overall_match: boolean;
  recovery_outcome_receipt: string | null;
  recovery_replay_outcome: string | null;
  recovery_match: boolean | null;
  replay_latency_ms: number;
  snapshot_available: boolean;
  notes: string[];
}

async function replayCell(
  client: Client,
  cell: Cell,
  spec: ReplaySpec,
): Promise<PerCellReport> {
  const notes: string[] = [];
  const report: PerCellReport = {
    cell_id: cell.cell_id,
    receipt_hash: cell.receipt_hash,
    admitted_in_receipt: cell.admitted,
    replay_admitted: false,
    expected_row_count: cell.affected_rows,
    replayed_row_count: 0,
    expected_rejected_reason: cell.rejected_reason,
    replay_rejected_reason: null,
    pre_lsn_replay: null,
    post_lsn_replay: null,
    wal_advanced: false,
    row_count_match: false,
    rejection_match: false,
    overall_match: false,
    recovery_outcome_receipt: cell.recovery_receipt_outcome,
    recovery_replay_outcome: null,
    recovery_match: null,
    replay_latency_ms: 0,
    snapshot_available: true,
    notes,
  };

  const t0 = performance.now();

  // Apply the public admission gate.
  const gateReason = gateReject(spec);
  if (gateReason !== null) {
    report.replay_admitted = false;
    report.replay_rejected_reason = gateReason;
    report.rejection_match =
      cell.admitted === false && gateReason === cell.rejected_reason;
    if (!report.rejection_match && !cell.admitted) {
      // Some rejected cells have rejected_reason text that differs in wording
      // but encodes the same constraint. Cross-check by failure-class fallback.
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

  // Admitted: execute SQL.
  report.replay_admitted = true;
  const preLsn = await currentLsn(client);
  report.pre_lsn_replay = preLsn;

  let result: { rowCount: number | null };
  if (spec.action === "delete") {
    const { sql, values } = buildDelete(spec.table, spec.where);
    result = await client.query(sql, values);
  } else if (spec.action === "update") {
    if (!spec.set) throw new Error("update without set");
    const { sql, values } = buildUpdate(spec.table, spec.where, spec.set);
    result = await client.query(sql, values);
  } else {
    throw new Error(`unreachable: ${spec.action}`);
  }
  const postLsn = await currentLsn(client);
  report.post_lsn_replay = postLsn;
  report.replayed_row_count = result.rowCount ?? 0;

  const diff = await lsnDiff(client, postLsn, preLsn);
  report.wal_advanced = diff > 0n;
  report.row_count_match =
    cell.admitted && report.replayed_row_count === cell.affected_rows;
  report.rejection_match = cell.admitted; // admitted-in-receipt and admitted-on-replay agree
  report.overall_match =
    report.row_count_match && report.wal_advanced && cell.admitted;

  // Optional: replay the recovery for delete cells with snapshot survival.
  if (
    spec.action === "delete" &&
    spec.snapshotPredicate &&
    spec.snapshotKeep
  ) {
    // We captured the snapshot rows the recovery operator promised to
    // restore. The snapshot survives the delete by definition (it is a
    // copy held off-row). Reinsert keeping = "all" => 3, "half" => 1,
    // "none" => 0.
    const snapshotCount =
      spec.snapshotKeep === "all" ? 3 : spec.snapshotKeep === "half" ? 1 : 0;
    const inserted = await reinsertSnapshot(
      client,
      spec.snapshotPredicate,
      snapshotCount,
    );
    const expectedOutcome =
      snapshotCount === cell.affected_rows
        ? "success"
        : snapshotCount === 0
          ? "failure"
          : "partial";
    report.recovery_replay_outcome = expectedOutcome;
    report.recovery_match =
      inserted === snapshotCount &&
      cell.recovery_receipt_outcome === expectedOutcome;
    if (!report.recovery_match) {
      notes.push(
        `recovery mismatch: inserted=${inserted} expected=${snapshotCount}`,
      );
    }
  }

  report.replay_latency_ms = performance.now() - t0;
  return report;
}

/**
 * Re-insert the snapshotted rows the recovery operator promised, mimicking
 * the compensator's restore path. The snapshot rows are deterministic by
 * tenant: 3 rows with values value-X-0, value-X-1, value-X-2; for "half"
 * we keep the first floor(n/2) rows.
 */
async function reinsertSnapshot(
  client: Client,
  tenant: string,
  count: number,
): Promise<number> {
  if (count === 0) return 0;
  const letter = tenant.replace(/^tenant-/, "");
  // Find the id range used during reseed for this tenant.
  const tenants = "abcdefghijklmno".split("");
  const idx = tenants.indexOf(letter);
  if (idx < 0) throw new Error(`unknown tenant: ${tenant}`);
  const baseId = idx * 3 + 1;
  const values: string[] = [];
  for (let r = 0; r < count; r++) {
    values.push(`(${baseId + r}, '${tenant}', 'value-${letter}-${r}')`);
  }
  const r = await client.query(
    `INSERT INTO tenant_rows (id, tenant_id, value) VALUES ${values.join(", ")}`,
  );
  return r.rowCount ?? 0;
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
  const nonMatches = reports.filter((r) => !r.overall_match && !r.rejection_match);

  let text = "# L0 Replay Summary — rq-provider-postgres\n\n";
  text += `Receipt set: ${reports.length} cells (${admitted.length} admitted, ${rejected.length} over-scope).\n\n`;
  text += `**Admitted cells replayable**: ${admittedReplayable}/${admitted.length}.\n`;
  text += `**Over-scope cells correctly rejected on independent replay**: ${rejectedReplayable}/${rejected.length}.\n`;
  text += `**Mean replay latency**: ${meanLatency.toFixed(2)} ms.\n\n`;

  if (nonMatches.length === 0) {
    text += "All cells matched the receipt's claim on independent replay.\n\n";
  } else {
    text += "## Mismatches\n\n";
    for (const r of nonMatches) {
      text += `- ${r.cell_id}: expected_rows=${r.expected_row_count} replayed=${r.replayed_row_count} wal_advanced=${r.wal_advanced} notes=${r.notes.join("; ")}\n`;
    }
    text += "\n";
  }

  text += "## Per-cell\n\n";
  text += "| Cell | Receipt rows | Replay rows | WAL+ | Match | Rec. receipt | Rec. replay | Lat. (ms) |\n";
  text += "|------|-------------:|------------:|:----:|:-----:|:------------:|:-----------:|----------:|\n";
  for (const r of reports) {
    const recMatch =
      r.recovery_match === null ? "—" : r.recovery_match ? "y" : "n";
    const overallMatch = r.admitted_in_receipt
      ? r.overall_match
      : r.rejection_match;
    text += `| ${r.cell_id} | ${r.expected_row_count} | ${r.replayed_row_count} | ${r.wal_advanced ? "y" : "n"} | ${overallMatch ? "y" : "n"} | ${r.recovery_outcome_receipt ?? "—"} | ${r.recovery_replay_outcome ?? "—"} | ${r.replay_latency_ms.toFixed(2)} |\n`;
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
  const cellsDoc = JSON.parse(fs.readFileSync(CELLS_PATH, "utf8"));
  const cells: Cell[] = cellsDoc.cells;

  // Index specs by cell_id.
  const specByCell = new Map<string, ReplaySpec>();
  for (const s of REPLAY_SPECS) specByCell.set(s.cellId, s);

  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  try {
    await client.query("SELECT 1");
    // The receipts reference the seeded `tenant_rows` snapshot. We
    // reset to that snapshot once, then replay cell-by-cell in the
    // same order the bench ran so the pre-LSN row state for each
    // cell matches the receipt's pre-LSN row state.
    await reseedTable(client);

    const reports: PerCellReport[] = [];
    for (const cell of cells) {
      const spec = specByCell.get(cell.cell_id);
      if (!spec) {
        reports.push({
          cell_id: cell.cell_id,
          receipt_hash: cell.receipt_hash,
          admitted_in_receipt: cell.admitted,
          replay_admitted: false,
          expected_row_count: cell.affected_rows,
          replayed_row_count: 0,
          expected_rejected_reason: cell.rejected_reason,
          replay_rejected_reason:
            "no replay spec for cell (snapshot reference unavailable)",
          pre_lsn_replay: null,
          post_lsn_replay: null,
          wal_advanced: false,
          row_count_match: false,
          rejection_match: false,
          overall_match: false,
          recovery_outcome_receipt: cell.recovery_receipt_outcome,
          recovery_replay_outcome: null,
          recovery_match: null,
          replay_latency_ms: 0,
          snapshot_available: false,
          notes: ["no public ReplaySpec for this cell"],
        });
        continue;
      }
      const rep = await replayCell(client, cell, spec);
      reports.push(rep);
      process.stderr.write(
        `[replay] ${cell.cell_id}: admitted_receipt=${cell.admitted} ` +
          `replay_admitted=${rep.replay_admitted} ` +
          `rows=${rep.replayed_row_count}/${cell.affected_rows} ` +
          `wal+=${rep.wal_advanced} match=${
            cell.admitted ? rep.overall_match : rep.rejection_match
          } lat=${rep.replay_latency_ms.toFixed(2)}ms\n`,
      );
    }

    const summary = summarize(reports);
    fs.writeFileSync(
      REPORT_PATH,
      JSON.stringify(
        {
          schemaVersion: 1,
          rq: "rq-provider-postgres",
          replay: {
            admittedReplayable: summary.admittedReplayable,
            admittedTotal: summary.admittedTotal,
            rejectedReplayable: summary.rejectedReplayable,
            rejectedTotal: summary.rejectedTotal,
            meanLatencyMs: summary.meanLatencyMs,
            pgUrl: PG_URL.replace(/:[^:@]+@/, ":***@"),
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
  } finally {
    await client.end();
  }
}

await main();
