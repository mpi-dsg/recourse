import { hashEvidence } from "../../evidence-store/src/index.ts";
import {
  hashEffectReceipt,
  signRecoveryReceipt,
  verifyEffectReceipt,
  type EffectReceipt,
  type Hex20,
  type Hex32,
  type RecourseDomainArgs,
  type RecourseTypedDataSigner,
  type RecourseContract,
  type RecoveryReceipt,
} from "../../receipts/src/index.ts";
import { OutOfScopeRecoveryError, type RecoveryAttempt } from "./outcomes.ts";

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex32;

export interface RecoverySideEffect {
  type: RecourseContract["resourceScope"]["type"];
  descriptor: Record<string, unknown>;
}

export interface RecourseCompensatorConfig {
  contract: RecourseContract;
  domain: RecourseDomainArgs;
  signer: RecourseTypedDataSigner;
  compensatorAddress: Hex20;
  authorizedAdapters?: readonly Hex20[];
  now?: () => number;
}

export class InvalidEffectReceiptError extends Error {
  constructor(reason: string) {
    super(`invalid effect receipt: ${reason}`);
    this.name = "InvalidEffectReceiptError";
  }
}

export abstract class RecourseCompensator {
  constructor(private readonly config: RecourseCompensatorConfig) {}

  async recover(effect: EffectReceipt): Promise<RecoveryReceipt> {
    const start = this.now();
    await this.assertEffectReceiptAccepted(effect);
    if (start > effect.timestamp + this.config.contract.deadlines.recoverySeconds) {
      return this.emitReceipt(effect, {
        outcome: "inconclusive",
        restoreArtifactHash: ZERO32,
        residualMeasurements: {
          recovery_deadline_missed: {
            value: "1",
            evidenceSource: "compensator-attested",
            artifactHash: hashEvidence("recovery deadline missed").hash,
          },
        },
        recoveryStartTs: start,
        recoveryEndTs: start,
      });
    }

    try {
      this.assertScopeClosed(await this.declareSideEffects(effect));
      const attempt = await this.restore(effect);
      return this.emitReceipt(effect, {
        ...attempt,
        recoveryStartTs: start,
        recoveryEndTs: this.now(),
      });
    } catch (error) {
      if (error instanceof OutOfScopeRecoveryError) {
        const end = this.now();
        return this.emitReceipt(effect, {
          outcome: "failure",
          restoreArtifactHash: hashEvidence(error.message).hash,
          residualMeasurements: {
            out_of_scope_recovery: {
              value: "1",
              evidenceSource: "compensator-attested",
              artifactHash: hashEvidence(error.message).hash,
            },
          },
          recoveryStartTs: start,
          recoveryEndTs: end,
        });
      }
      throw error;
    }
  }

  protected async declareSideEffects(_effect: EffectReceipt): Promise<RecoverySideEffect[]> {
    return [
      {
        type: this.config.contract.resourceScope.type,
        descriptor: this.config.contract.resourceScope.descriptor,
      },
    ];
  }

  protected abstract restore(effect: EffectReceipt): Promise<RecoveryAttempt>;

  private assertScopeClosed(sideEffects: RecoverySideEffect[]): void {
    for (const sideEffect of sideEffects) {
      if (sideEffect.type !== this.config.contract.resourceScope.type) {
        throw new OutOfScopeRecoveryError(
          `recovery side effect ${sideEffect.type} exceeds ${this.config.contract.resourceScope.type}`,
        );
      }
      if (hashEvidence(sideEffect.descriptor).hash !== hashEvidence(this.config.contract.resourceScope.descriptor).hash) {
        throw new OutOfScopeRecoveryError("recovery side effect descriptor exceeds registered scope");
      }
    }
  }

  private async assertEffectReceiptAccepted(effect: EffectReceipt): Promise<void> {
    if (effect.schemaVersion !== 1) {
      throw new InvalidEffectReceiptError(`unsupported schema version ${effect.schemaVersion}`);
    }
    if (effect.contractId !== this.config.contract.contractId) {
      throw new InvalidEffectReceiptError("contract id does not match configured kappa");
    }
    if (!(await verifyEffectReceipt({ domain: this.config.domain, receipt: effect }))) {
      throw new InvalidEffectReceiptError("signature does not verify for adapter address");
    }
    const allowed = this.config.authorizedAdapters;
    if (allowed && !allowed.includes(effect.adapterAddress)) {
      throw new InvalidEffectReceiptError("adapter address is not authorized for this compensator");
    }
  }

  private async emitReceipt(
    effect: EffectReceipt,
    attempt: RecoveryAttempt & { recoveryStartTs: number; recoveryEndTs: number },
  ): Promise<RecoveryReceipt> {
    const { signature: _signature, ...unsignedEffect } = effect;
    return signRecoveryReceipt({
      domain: this.config.domain,
      signer: this.config.signer,
      receipt: {
        schemaVersion: 1,
        contractId: effect.contractId,
        effectReceiptHash: hashEffectReceipt({ domain: this.config.domain, receipt: unsignedEffect }),
        compensatorAddress: this.config.compensatorAddress,
        restoreArtifactHash: attempt.restoreArtifactHash as Hex32,
        outcome: attempt.outcome,
        residualMeasurements: attempt.residualMeasurements,
        recoveryStartTs: attempt.recoveryStartTs,
        recoveryEndTs: attempt.recoveryEndTs,
      },
    });
  }

  private now(): number {
    return this.config.now?.() ?? Math.floor(Date.now() / 1000);
  }
}
