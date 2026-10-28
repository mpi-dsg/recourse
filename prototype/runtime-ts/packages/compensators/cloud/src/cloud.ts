import {
  RecourseCompensator,
  type RecourseCompensatorConfig,
  type RecoveryAttempt,
  type RecoverySideEffect,
} from "../../../compensator-sdk/src/index.ts";
import { hashEvidence } from "../../../evidence-store/src/index.ts";
import type { EffectReceipt } from "../../../receipts/src/index.ts";
import {
  CloudClientError,
  assertCloudParameterName,
  type CloudClient,
} from "../../../adapter-cloud/src/cloud-client.ts";

export interface CloudCompensatorConfig extends RecourseCompensatorConfig {
  client: CloudClient;
  resourceId: string;
  restoreValue: string;
  excessSpendUsd?: string;
}

export class CloudCompensator extends RecourseCompensator {
  private readonly client: CloudClient;
  private readonly resourceId: string;
  private readonly restoreValue: string;
  private readonly excessSpendUsd: string;

  constructor(private readonly cfg: CloudCompensatorConfig) {
    super(cfg);
    assertCloudParameterName(cfg.resourceId);
    this.client = cfg.client;
    this.resourceId = cfg.resourceId;
    this.restoreValue = cfg.restoreValue;
    this.excessSpendUsd = cfg.excessSpendUsd ?? "0";
  }

  protected override async declareSideEffects(
    _effect: EffectReceipt,
  ): Promise<RecoverySideEffect[]> {
    return [
      {
        type: "cloud-resource",
        descriptor: { ...this.cfg.contract.resourceScope.descriptor, resourceId: this.resourceId },
      },
    ];
  }

  protected async restore(_effect: EffectReceipt): Promise<RecoveryAttempt> {
    try {
      const before = await this.client.getParameter(this.resourceId);
      await this.client.putParameter(this.resourceId, this.restoreValue);
      return {
        outcome: this.excessSpendUsd === "0" ? "success" : "partial",
        restoreArtifactHash: hashEvidence({
          workload: "cloud",
          resourceId: this.resourceId,
          from: before?.value ?? "",
          to: this.restoreValue,
          excessSpendUsd: this.excessSpendUsd,
        }).hash,
        residualMeasurements: {
          excess_spend_usd: {
            value: this.excessSpendUsd,
            evidenceSource: "cost-explorer",
          },
        },
      };
    } catch (error) {
      if (!(error instanceof CloudClientError)) throw error;
      return {
        outcome: "failure",
        restoreArtifactHash: hashEvidence({
          workload: "cloud",
          resourceId: this.resourceId,
          error: error.message,
        }).hash,
        residualMeasurements: {
          excess_spend_usd: {
            value: this.excessSpendUsd,
            evidenceSource: "compensator-attested",
            artifactHash: hashEvidence(error.message).hash,
          },
        },
      };
    }
  }
}
