import {
  RecourseCompensator,
  type RecourseCompensatorConfig,
  type RecoveryAttempt,
  type RecoverySideEffect,
} from "../../../compensator-sdk/src/index.ts";
import { hashEvidence } from "../../../evidence-store/src/index.ts";
import type { EffectReceipt } from "../../../receipts/src/index.ts";

export * from "./pg.ts";

type Row = Record<string, unknown>;

export interface MemoryPostgresCompensatorConfig extends RecourseCompensatorConfig {
  table: { rows: Row[] };
  tableName?: string;
  restoreRows: Row[];
  expectedRecoveredRows: number;
}

export class MemoryPostgresCompensator extends RecourseCompensator {
  public readonly rows: Row[];

  constructor(private readonly cfg: MemoryPostgresCompensatorConfig) {
    super(cfg);
    this.rows = cfg.table.rows;
  }

  protected override async declareSideEffects(_effect: EffectReceipt): Promise<RecoverySideEffect[]> {
    return [
      {
        type: "postgres-table",
        descriptor: {
          ...this.cfg.contract.resourceScope.descriptor,
          ...(this.cfg.tableName === undefined ? {} : { table: this.cfg.tableName }),
        },
      },
    ];
  }

  protected async restore(_effect: EffectReceipt): Promise<RecoveryAttempt> {
    this.rows.push(...this.cfg.restoreRows.map((row) => ({ ...row })));
    const missing = Math.max(0, this.cfg.expectedRecoveredRows - this.cfg.restoreRows.length);
    return {
      outcome: missing === 0 ? "success" : "partial",
      restoreArtifactHash: hashEvidence({ workload: "postgres", restoredRows: this.cfg.restoreRows }).hash,
      residualMeasurements: {
        rows_deleted: { value: String(missing), evidenceSource: "snapshot-diff" },
      },
    };
  }
}
