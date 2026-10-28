import type { Client } from "pg";
import {
  AdapterScopeError,
  RecourseAdapter,
  type PostExecution,
  type RecourseAdapterConfig,
  type ToolCall,
} from "../../adapter-sdk/src/index.ts";
import { hashEvidence } from "../../evidence-store/src/index.ts";
import type { Hex32 } from "../../receipts/src/index.ts";

export interface PgPostgresAdapterConfig extends RecourseAdapterConfig {
  client: Client;
  allowedTables: string[];
}

export interface PgPostgresProviderOutcome {
  affectedRows: number;
  table: string;
  preLsn: string;
  postLsn: string;
  txid: string;
  queryHash: Hex32;
}

interface PgPostgresCallParams {
  table: string;
  where: Record<string, unknown>;
  set?: Record<string, unknown>;
}

interface PgPostgresCallResource {
  table: string;
}

interface PreContext {
  tableOid: string;
  preLsn: string;
  matchingCount: number;
}

export function pgPostgresStateDigest(input: {
  tableOid: string;
  lsn: string;
  affectedRows: number;
}): Hex32 {
  return hashEvidence(input).hash;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class PgPostgresAdapter extends RecourseAdapter<PgPostgresProviderOutcome> {
  private readonly client: Client;
  private readonly allowedTables: Set<string>;
  private preContext: PreContext | null = null;

  constructor(cfg: PgPostgresAdapterConfig) {
    super(cfg);
    this.client = cfg.client;
    this.allowedTables = new Set(cfg.allowedTables);
  }

  protected async readPreState(call: ToolCall): Promise<Hex32> {
    const params = this.params(call);
    this.assertTableAllowed(params.table);
    const tableOid = await this.tableOid(params.table);
    const preLsn = await this.currentLsn();
    const matchingCount = await this.countMatching(params.table, params.where);
    this.preContext = { tableOid, preLsn, matchingCount };
    return pgPostgresStateDigest({ tableOid, lsn: preLsn, affectedRows: matchingCount });
  }

  protected async execute(call: ToolCall): Promise<PgPostgresProviderOutcome> {
    const params = this.params(call);
    if (Object.keys(params.where).length === 0) {
      throw new AdapterScopeError("postgres mutation requires a non-empty where predicate");
    }
    const ctx = this.preContext;
    if (!ctx) throw new AdapterScopeError("preExecute did not run before execute");

    let result: { rowCount: number | null };
    let queryText: string;
    if (call.action === "delete") {
      const { sql, values } = buildDelete(params.table, params.where);
      queryText = sql;
      result = await this.client.query(sql, values);
    } else if (call.action === "update") {
      if (!params.set || Object.keys(params.set).length === 0) {
        throw new AdapterScopeError("postgres update requires a non-empty set clause");
      }
      const { sql, values } = buildUpdate(params.table, params.where, params.set);
      queryText = sql;
      result = await this.client.query(sql, values);
    } else {
      throw new AdapterScopeError(`unsupported postgres action: ${call.action}`);
    }

    const postLsn = await this.currentLsn();
    const txid = await this.txidCurrent();
    const queryHash = hashEvidence({ sql: queryText }).hash;

    return {
      affectedRows: result.rowCount ?? 0,
      table: params.table,
      preLsn: ctx.preLsn,
      postLsn,
      txid,
      queryHash,
    };
  }

  protected async readPostState(
    _call: ToolCall,
    outcome: PgPostgresProviderOutcome,
  ): Promise<PostExecution> {
    const ctx = this.preContext;
    if (!ctx) throw new AdapterScopeError("preExecute did not run before postExecute");

    const postStateDigest = pgPostgresStateDigest({
      tableOid: ctx.tableOid,
      lsn: outcome.postLsn,
      affectedRows: outcome.affectedRows,
    });
    const providerReceiptHash = hashEvidence({
      workload: "postgres",
      table: outcome.table,
      tableOid: ctx.tableOid,
      preLsn: outcome.preLsn,
      postLsn: outcome.postLsn,
      affectedRows: outcome.affectedRows,
      txid: outcome.txid,
      queryHash: outcome.queryHash,
    }).hash;

    this.preContext = null;

    return { postStateDigest, providerReceiptHash };
  }

  private params(call: ToolCall): PgPostgresCallParams {
    const params = call.params as PgPostgresCallParams;
    const resource = call.resource as PgPostgresCallResource;
    if (params.table !== resource.table) {
      throw new AdapterScopeError(
        `postgres params table does not match resource table: ${params.table}`,
      );
    }
    return params;
  }

  private assertTableAllowed(table: string): void {
    if (!IDENT_RE.test(table)) {
      throw new AdapterScopeError(`invalid table identifier: ${table}`);
    }
    if (!this.allowedTables.has(table)) {
      throw new AdapterScopeError(`table is outside registered scope: ${table}`);
    }
  }

  private async tableOid(table: string): Promise<string> {
    const result = await this.client.query<{ oid: number }>(
      "SELECT oid FROM pg_class WHERE relname = $1 AND relkind = 'r'",
      [table],
    );
    if (result.rows.length === 0) {
      throw new AdapterScopeError(`unknown table: ${table}`);
    }
    return `pg_class:${result.rows[0]!.oid}`;
  }

  private async currentLsn(): Promise<string> {
    const result = await this.client.query<{ lsn: string }>("SELECT pg_current_wal_lsn() AS lsn");
    return String(result.rows[0]!.lsn);
  }

  private async txidCurrent(): Promise<string> {
    const result = await this.client.query<{ txid: string }>(
      "SELECT pg_current_xact_id()::text AS txid",
    );
    return String(result.rows[0]!.txid);
  }

  private async countMatching(table: string, where: Record<string, unknown>): Promise<number> {
    const { sql, values } = buildCount(table, where);
    const result = await this.client.query<{ count: string }>(sql, values);
    return Number(result.rows[0]!.count);
  }
}

function assertIdent(name: string, kind: string): void {
  if (!IDENT_RE.test(name)) {
    throw new AdapterScopeError(`invalid ${kind} identifier: ${name}`);
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

function buildCount(
  table: string,
  where: Record<string, unknown>,
): { sql: string; values: unknown[] } {
  assertIdent(table, "table");
  if (Object.keys(where).length === 0) {
    return { sql: `SELECT COUNT(*)::text AS count FROM "${table}"`, values: [] };
  }
  const { clause, values } = buildWhereClause(where, 0);
  return { sql: `SELECT COUNT(*)::text AS count FROM "${table}" WHERE ${clause}`, values };
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
  const { clause, values: whereValues } = buildWhereClause(where, setEntries.length);
  return {
    sql: `UPDATE "${table}" SET ${setFragments.join(", ")} WHERE ${clause}`,
    values: [...setValues, ...whereValues],
  };
}
