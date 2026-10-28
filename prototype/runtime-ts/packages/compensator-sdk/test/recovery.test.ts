import { describe, expect, it } from "bun:test";
import { hashEvidence } from "../../evidence-store/src/index.ts";
import { signEffectReceipt, verifyRecoveryReceipt, type EffectReceipt, type Hex20, type Hex32 } from "../../receipts/src/index.ts";
import { adapterAccount as adapter, compensatorAccount as compensator } from "../../receipts/test/helpers.ts";
import {
  InvalidEffectReceiptError,
  OutOfScopeRecoveryError,
  RecourseCompensator,
  type RecoveryAttempt,
} from "../src/index.ts";
import type { RecourseContract } from "../../receipts/src/types.gen.ts";

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};

const contract: RecourseContract = {
  schemaVersion: 1,
  contractId: "0x1111111111111111111111111111111111111111111111111111111111111111",
  operator: "0x000000000000000000000000000000000000bEEF",
  actionTemplate: { tool: "postgres", action: "delete" },
  resourceScope: { type: "postgres-table", descriptor: { table: "tenant_rows" } },
  effectClass: "compensable",
  recoveryOperator: {
    compensatorId: "postgres-pitr",
    freshnessSeconds: 300,
    retentionSeconds: 3600,
    authPolicyHash: hashEvidence("auth").hash,
  },
  coveredLossClass: { codes: ["rows_deleted"], excludeList: [] },
  payoutRule: { type: "rowCountSchedule", params: {}, maxPayout: "1000000" },
  bond: {
    asset: "0x0000000000000000000000000000000000000001",
    minAmount: "1000000",
    maxAggregateExposure: "1000000",
  },
  evidenceSchema: {
    schemaId: hashEvidence("schema").hash,
    requiredProvenance: "L1",
    accessPolicyHash: hashEvidence("access").hash,
  },
  deadlines: { recoverySeconds: 60, submissionSeconds: 300, livenessSeconds: 600 },
  disputeRoute: { arbitrator: "0x0000000000000000000000000000000000000002", evidenceGroupId: "1" },
};

async function effectReceipt(timestamp = 1746979200): Promise<EffectReceipt> {
  return signEffectReceipt({
    domain,
    signer: adapter,
    receipt: {
      schemaVersion: 1,
      contractId: contract.contractId,
      jobId: "0xdead000000000000000000000000000000000000000000000000000000000001",
      intentHash: hashEvidence("intent").hash,
      paramsHash: hashEvidence("params").hash,
      resourceId: hashEvidence("tenant_rows").hash,
      preStateDigest: hashEvidence("pre").hash,
      postStateDigest: hashEvidence("post").hash,
      timestamp,
      adapterAddress: adapter.address as Hex20,
    },
  });
}

class SuccessfulCompensator extends RecourseCompensator {
  protected async restore(_effect: EffectReceipt): Promise<RecoveryAttempt> {
    return {
      outcome: "success",
      restoreArtifactHash: hashEvidence("restore-ok").hash,
      residualMeasurements: {
        rows_deleted: { value: "0", evidenceSource: "snapshot-diff" },
      },
    };
  }
}

class OutOfScopeCompensator extends RecourseCompensator {
  protected async restore(_effect: EffectReceipt): Promise<RecoveryAttempt> {
    throw new OutOfScopeRecoveryError("restore touches audit_logs");
  }
}

class DescriptorOutOfScopeCompensator extends RecourseCompensator {
  protected override async declareSideEffects(_effect: EffectReceipt) {
    return [{ type: "postgres-table" as const, descriptor: { table: "audit_logs" } }];
  }

  protected async restore(_effect: EffectReceipt): Promise<RecoveryAttempt> {
    return {
      outcome: "success",
      restoreArtifactHash: hashEvidence("restore-ok").hash,
      residualMeasurements: {},
    };
  }
}

describe("RecourseCompensator recovery", () => {
  it("compensator that returns success emits success receipt", async () => {
    const sdk = new SuccessfulCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1746979210,
    });

    const receipt = await sdk.recover(await effectReceipt());

    expect(receipt.outcome).toBe("success");
    await expect(verifyRecoveryReceipt({ domain, receipt })).resolves.toBe(true);
  });

  it("compensator throwing OutOfScopeRecoveryError emits a failure receipt with reason", async () => {
    const sdk = new OutOfScopeCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1746979210,
    });

    const receipt = await sdk.recover(await effectReceipt());

    expect(receipt.outcome).toBe("failure");
    expect(receipt.residualMeasurements["out_of_scope_recovery"]?.value).toBe("1");
    await expect(verifyRecoveryReceipt({ domain, receipt })).resolves.toBe(true);
  });

  it("late compensator emits inconclusive-recovery receipt", async () => {
    const sdk = new SuccessfulCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1746979300,
    });

    const receipt = await sdk.recover(await effectReceipt(1746979200));

    expect(receipt.outcome).toBe("inconclusive");
    expect(receipt.residualMeasurements["recovery_deadline_missed"]?.value).toBe("1");
  });

  it("rejects unsigned scope swaps before recovery", async () => {
    const sdk = new SuccessfulCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      authorizedAdapters: [adapter.address as Hex20],
      now: () => 1746979210,
    });

    const receipt = await effectReceipt();
    await expect(
      sdk.recover({
        ...receipt,
        contractId: "0x2222222222222222222222222222222222222222222222222222222222222222" as Hex32,
      }),
    ).rejects.toThrow(InvalidEffectReceiptError);
    await expect(
      sdk.recover({
        ...receipt,
        adapterAddress: "0x000000000000000000000000000000000000dEaD" as Hex20,
      }),
    ).rejects.toThrow(InvalidEffectReceiptError);
  });

  it("rejects otherwise valid receipts from unconfigured adapters", async () => {
    const sdk = new SuccessfulCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      authorizedAdapters: ["0x000000000000000000000000000000000000dEaD" as Hex20],
      now: () => 1746979210,
    });

    await expect(sdk.recover(await effectReceipt())).rejects.toThrow(InvalidEffectReceiptError);
  });

  it("marks descriptor-expanding recovery as out of scope", async () => {
    const sdk = new DescriptorOutOfScopeCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1746979210,
    });

    const receipt = await sdk.recover(await effectReceipt());

    expect(receipt.outcome).toBe("failure");
    expect(receipt.residualMeasurements["out_of_scope_recovery"]?.value).toBe("1");
  });
});
