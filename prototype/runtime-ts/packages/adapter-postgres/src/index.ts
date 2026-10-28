import { AdapterScopeError, RecourseAdapter, type PostExecution, type PreExecution, type RecourseAdapterConfig, type ToolCall } from "../../adapter-sdk/src/index.ts";
import { hashEvidence } from "../../evidence-store/src/index.ts";
import type { Hex32 } from "../../receipts/src/index.ts";

export * from "./pg.ts";

type Row = Record<string, unknown>;

interface TableState {
  tableOid: string;
  lsn: number;
  rows: Row[];
}

interface PostgresCallParams {
  table: string;
  where: Record<string, unknown>;
  set?: Record<string, unknown>;
}

interface PostgresCallResource {
  table: string;
}

export interface MemoryPostgresAdapterConfig extends RecourseAdapterConfig {
  allowedTables: string[];
  tables: Record<string, TableState>;
}

export interface PostgresProviderOutcome {
  affectedRows: number;
  table: string;
  lsn: number;
}

export function postgresStateDigest(input: { tableOid: string; lsn: number; affectedRows: number }): Hex32 {
  return hashEvidence(input).hash;
}

export class MemoryPostgresAdapter extends RecourseAdapter<PostgresProviderOutcome> {
  private readonly allowedTables: Set<string>;
  private readonly tables: Record<string, TableState>;

  constructor(private readonly cfg: MemoryPostgresAdapterConfig) {
    super(cfg);
    this.allowedTables = new Set(cfg.allowedTables);
    this.tables = cfg.tables;
  }

  protected async readPreState(call: ToolCall): Promise<Hex32> {
    const params = this.params(call);
    const table = this.table(params.table);
    return postgresStateDigest({ tableOid: table.tableOid, lsn: table.lsn, affectedRows: this.matchingRows(table, params.where).length });
  }

  protected async execute(call: ToolCall): Promise<PostgresProviderOutcome> {
    const params = this.params(call);
    if (Object.keys(params.where).length === 0) {
      throw new AdapterScopeError("postgres mutation requires a non-empty where predicate");
    }
    const table = this.table(params.table);
    const matches = this.matchingRows(table, params.where);

    if (call.action === "delete") {
      table.rows = table.rows.filter((row) => !matches.includes(row));
    } else if (call.action === "update") {
      if (!params.set || Object.keys(params.set).length === 0) {
        throw new AdapterScopeError("postgres update requires a non-empty set clause");
      }
      for (const row of matches) Object.assign(row, params.set ?? {});
    } else {
      throw new AdapterScopeError(`unsupported postgres action: ${call.action}`);
    }

    table.lsn += 1;
    return { affectedRows: matches.length, table: params.table, lsn: table.lsn };
  }

  protected async readPostState(call: ToolCall, outcome: PostgresProviderOutcome, _pre: PreExecution): Promise<PostExecution> {
    const table = this.table(this.params(call).table);
    return {
      postStateDigest: postgresStateDigest({ tableOid: table.tableOid, lsn: outcome.lsn, affectedRows: outcome.affectedRows }),
      providerReceiptHash: hashEvidence({ workload: "postgres", table: outcome.table, affectedRows: outcome.affectedRows }).hash,
    };
  }

  private params(call: ToolCall): PostgresCallParams {
    const params = call.params as PostgresCallParams;
    const resource = call.resource as PostgresCallResource;
    if (params.table !== resource.table) {
      throw new AdapterScopeError(`postgres params table does not match resource table: ${params.table}`);
    }
    return params;
  }

  private table(name: string): TableState {
    if (!this.allowedTables.has(name)) throw new AdapterScopeError(`table is outside registered scope: ${name}`);
    const table = this.tables[name];
    if (!table) throw new AdapterScopeError(`unknown table: ${name}`);
    return table;
  }

  private matchingRows(table: TableState, where: Record<string, unknown>): Row[] {
    return table.rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
  }
}
