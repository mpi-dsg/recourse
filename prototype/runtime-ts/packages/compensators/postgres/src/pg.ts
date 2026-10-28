import type { Client, QueryResult, QueryResultRow } from "pg";
import {
  RecourseCompensator,
  type RecourseCompensatorConfig,
  type RecoveryAttempt,
  type RecoverySideEffect,
} from "../../../compensator-sdk/src/index.ts";
import { hashEvidence } from "../../../evidence-store/src/index.ts";
import type { EffectReceipt } from "../../../receipts/src/index.ts";

type Row = Record<string, unknown>;

export interface PgPostgresCompensatorConfig extends RecourseCompensatorConfig {
  client: Client;
  tableName: string;
  primaryKey?: string;
  snapshotRows: Row[];
  expectedRecoveredRows: number;
}

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdent(name: string, kind: string): void {
  if (!IDENT_RE.test(name)) {
    throw new PgCompensatorError(`invalid ${kind} identifier: ${name}`);
  }
}

export class PgCompensatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PgCompensatorError";
  }
}

export class PgPostgresCompensator extends RecourseCompensator {
  private readonly client: Client;
  private readonly tableName: string;
  private readonly primaryKey: string;
  private readonly snapshotRows: Row[];
  private readonly expectedRecoveredRows: number;

  constructor(private readonly cfg: PgPostgresCompensatorConfig) {
    super(cfg);
    assertIdent(cfg.tableName, "table");
    assertIdent(cfg.primaryKey ?? "id", "primaryKey");
    this.client = cfg.client;
    this.tableName = cfg.tableName;
    this.primaryKey = cfg.primaryKey ?? "id";
    this.snapshotRows = cfg.snapshotRows;
    this.expectedRecoveredRows = cfg.expectedRecoveredRows;
  }

  protected override async declareSideEffects(
    _effect: EffectReceipt,
  ): Promise<RecoverySideEffect[]> {
    return [
      {
        type: "postgres-table",
        descriptor: {
          ...this.cfg.contract.resourceScope.descriptor,
          table: this.tableName,
        },
      },
    ];
  }

  protected async restore(effect: EffectReceipt): Promise<RecoveryAttempt> {
    const pks = this.snapshotRows.map((r) => r[this.primaryKey]);
    for (const v of pks) {
      if (v === undefined || v === null) {
        throw new PgCompensatorError(
          `snapshot row missing primary key column ${this.primaryKey}`,
        );
      }
    }

    let inserted = 0;
    if (this.snapshotRows.length > 0) {
      const placeholders = pks.map((_, i) => `$${i + 1}`).join(", ");
      const existing = await this.client.query<{ pk: unknown }>(
        `SELECT "${this.primaryKey}" AS pk FROM "${this.tableName}" WHERE "${this.primaryKey}" IN (${placeholders})`,
        pks,
      );
      const existingPks = new Set(existing.rows.map((r) => String(r.pk)));
      const missing = this.snapshotRows.filter(
        (r) => !existingPks.has(String(r[this.primaryKey])),
      );

      for (const row of missing) {
        const cols = Object.keys(row);
        for (const c of cols) assertIdent(c, "column");
        const colList = cols.map((c) => `"${c}"`).join(", ");
        const ph = cols.map((_, i) => `$${i + 1}`).join(", ");
        const values = cols.map((c) => row[c]);
        const result: QueryResult<QueryResultRow> = await this.client.query(
          `INSERT INTO "${this.tableName}" (${colList}) VALUES (${ph})`,
          values,
        );
        inserted += result.rowCount ?? 0;
      }
    }

    const outcome =
      inserted >= this.expectedRecoveredRows
        ? "success"
        : inserted > 0
          ? "partial"
          : "failure";

    const now = this.cfg.now?.() ?? Math.floor(Date.now() / 1000);
    const downtime = Math.max(0, now - effect.timestamp);
    const stillMissing = Math.max(0, this.expectedRecoveredRows - inserted);

    return {
      outcome,
      restoreArtifactHash: hashEvidence({
        workload: "postgres",
        table: this.tableName,
        inserted,
        snapshotRowCount: this.snapshotRows.length,
      }).hash,
      residualMeasurements: {
        rows_deleted: {
          value: String(stillMissing),
          evidenceSource: "snapshot-diff",
        },
        recovered_row_count: {
          value: String(inserted),
          evidenceSource: "snapshot-diff",
        },
        downtime_seconds: {
          value: String(downtime),
          evidenceSource: "compensator-attested",
        },
      },
    };
  }
}
