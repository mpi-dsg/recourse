import type { RecoveryOutcome, ResidualMeasurement } from "../../receipts/src/types.gen.ts";

export interface RecoveryAttempt {
  outcome: RecoveryOutcome;
  restoreArtifactHash: `0x${string}`;
  residualMeasurements: Record<string, ResidualMeasurement>;
}

export class OutOfScopeRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutOfScopeRecoveryError";
  }
}
