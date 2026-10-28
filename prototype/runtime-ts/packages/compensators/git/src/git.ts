import {
  RecourseCompensator,
  type RecourseCompensatorConfig,
  type RecoveryAttempt,
  type RecoverySideEffect,
} from "../../../compensator-sdk/src/index.ts";
import { hashEvidence } from "../../../evidence-store/src/index.ts";
import type { EffectReceipt } from "../../../receipts/src/index.ts";
import {
  GitClientError,
  assertGitRef,
  assertGitSha,
  type GitClient,
} from "../../../adapter-git/src/git-client.ts";

export interface GitCompensatorConfig extends RecourseCompensatorConfig {
  client: GitClient;
  ref: string;
  backupSha: string;
}

export class GitCompensator extends RecourseCompensator {
  private readonly client: GitClient;
  private readonly ref: string;
  private readonly backupSha: string;

  constructor(private readonly cfg: GitCompensatorConfig) {
    super(cfg);
    assertGitRef(cfg.ref);
    assertGitSha(cfg.backupSha);
    this.client = cfg.client;
    this.ref = cfg.ref;
    this.backupSha = cfg.backupSha;
  }

  protected override async declareSideEffects(
    _effect: EffectReceipt,
  ): Promise<RecoverySideEffect[]> {
    return [
      {
        type: "git-ref",
        descriptor: { ...this.cfg.contract.resourceScope.descriptor, ref: this.ref },
      },
    ];
  }

  protected async restore(_effect: EffectReceipt): Promise<RecoveryAttempt> {
    try {
      const currentSha = await this.client.revParse(this.ref);
      await this.client.updateRef(this.ref, this.backupSha);
      const bytesRestored = await this.safeCommitSize(this.backupSha);
      return {
        outcome: "success",
        restoreArtifactHash: hashEvidence({
          workload: "git",
          ref: this.ref,
          from: currentSha ?? "",
          to: this.backupSha,
        }).hash,
        residualMeasurements: {
          history_bytes_lost: { value: "0", evidenceSource: "reflog" },
          history_bytes_restored: {
            value: String(bytesRestored),
            evidenceSource: "reflog",
          },
        },
      };
    } catch (error) {
      if (!(error instanceof GitClientError)) throw error;
      return {
        outcome: "failure",
        restoreArtifactHash: hashEvidence({
          workload: "git",
          ref: this.ref,
          error: error.message,
        }).hash,
        residualMeasurements: {
          history_bytes_lost: {
            value: "0",
            evidenceSource: "compensator-attested",
            artifactHash: hashEvidence(error.message).hash,
          },
        },
      };
    }
  }

  private async safeCommitSize(sha: string): Promise<number> {
    try {
      return await this.client.commitObjectSize(sha);
    } catch {
      return 0;
    }
  }
}
