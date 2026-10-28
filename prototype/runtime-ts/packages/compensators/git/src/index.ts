import {
  RecourseCompensator,
  type RecourseCompensatorConfig,
  type RecoveryAttempt,
  type RecoverySideEffect,
} from "../../../compensator-sdk/src/index.ts";
import { hashEvidence } from "../../../evidence-store/src/index.ts";
import type { EffectReceipt } from "../../../receipts/src/index.ts";

export * from "./git.ts";

export interface MemoryGitCompensatorConfig extends RecourseCompensatorConfig {
  refs: Record<string, string>;
  backup: { ref: string; oid: string; bytesRestored: number };
}

export class MemoryGitCompensator extends RecourseCompensator {
  public readonly refs: Record<string, string>;

  constructor(private readonly cfg: MemoryGitCompensatorConfig) {
    super(cfg);
    this.refs = cfg.refs;
  }

  protected override async declareSideEffects(_effect: EffectReceipt): Promise<RecoverySideEffect[]> {
    return [
      {
        type: "git-ref",
        descriptor: { ...this.cfg.contract.resourceScope.descriptor, ref: this.cfg.backup.ref },
      },
    ];
  }

  protected async restore(_effect: EffectReceipt): Promise<RecoveryAttempt> {
    this.refs[this.cfg.backup.ref] = this.cfg.backup.oid;
    return {
      outcome: "success",
      restoreArtifactHash: hashEvidence({ workload: "git", backup: this.cfg.backup }).hash,
      residualMeasurements: {
        history_bytes_lost: { value: "0", evidenceSource: "reflog" },
      },
    };
  }
}
