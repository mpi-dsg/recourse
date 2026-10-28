import {
  RecourseCompensator,
  type RecourseCompensatorConfig,
  type RecoveryAttempt,
  type RecoverySideEffect,
} from "../../../compensator-sdk/src/index.ts";
import { hashEvidence } from "../../../evidence-store/src/index.ts";
import type { EffectReceipt } from "../../../receipts/src/index.ts";

export * from "./cloud.ts";

export interface MemoryCloudCompensatorConfig extends RecourseCompensatorConfig {
  resources: Record<string, Record<string, unknown>>;
  restore: { resourceId: string; config: Record<string, unknown>; excessSpendUsd: string };
}

export class MemoryCloudCompensator extends RecourseCompensator {
  public readonly resources: Record<string, Record<string, unknown>>;

  constructor(private readonly cfg: MemoryCloudCompensatorConfig) {
    super(cfg);
    this.resources = cfg.resources;
  }

  protected override async declareSideEffects(_effect: EffectReceipt): Promise<RecoverySideEffect[]> {
    return [
      {
        type: "cloud-resource",
        descriptor: { ...this.cfg.contract.resourceScope.descriptor, resourceId: this.cfg.restore.resourceId },
      },
    ];
  }

  protected async restore(_effect: EffectReceipt): Promise<RecoveryAttempt> {
    this.resources[this.cfg.restore.resourceId] = { ...this.cfg.restore.config };
    return {
      outcome: this.cfg.restore.excessSpendUsd === "0" ? "success" : "partial",
      restoreArtifactHash: hashEvidence({ workload: "cloud", restore: this.cfg.restore }).hash,
      residualMeasurements: {
        excess_spend_usd: {
          value: this.cfg.restore.excessSpendUsd,
          evidenceSource: "cost-explorer",
        },
      },
    };
  }
}
