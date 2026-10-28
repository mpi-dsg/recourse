import { describe, expect, it } from "bun:test";
import { hashEvidence } from "../../evidence-store/src/index.ts";
import { adapterAccount as signer } from "../../receipts/test/helpers.ts";
import {
  RecourseAdapter,
  type AdapterExecutionStage,
  AdapterConcurrentRunError,
  InvalidChainTransactionHashError,
  type PostExecution,
  MissingRecordToChainError,
  type ToolCall,
} from "../src/index.ts";
import type { Hex20, Hex32 } from "../../receipts/src/index.ts";

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};

const call: ToolCall = {
  contractId: "0x1111111111111111111111111111111111111111111111111111111111111111",
  jobId: "0xdead000000000000000000000000000000000000000000000000000000000001",
  tool: "postgres",
  action: "delete",
  params: { table: "tenant_rows", where: { tenantId: "tenant-a" } },
  resource: { table: "tenant_rows" },
};

class RecordingAdapter extends RecourseAdapter<{ providerReceipt: string }> {
  protected async readPreState(_call: ToolCall): Promise<Hex32> {
    return hashEvidence({ stage: "pre" }).hash;
  }

  protected async execute(_call: ToolCall): Promise<{ providerReceipt: string }> {
    return { providerReceipt: "provider-ok" };
  }

  protected async readPostState(
    _call: ToolCall,
    outcome: { providerReceipt: string },
  ): Promise<PostExecution> {
    return {
      postStateDigest: hashEvidence({ stage: "post" }).hash,
      providerReceiptHash: hashEvidence(outcome).hash,
    };
  }
}

class SideEffectTrackingAdapter extends RecordingAdapter {
  executeCalls = 0;

  protected override async execute(call: ToolCall): Promise<{ providerReceipt: string }> {
    this.executeCalls += 1;
    return super.execute(call);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class BlockingPreStateAdapter extends RecordingAdapter {
  constructor(
    config: ConstructorParameters<typeof RecordingAdapter>[0],
    private readonly gate: Promise<void>,
  ) {
    super(config);
  }

  protected override async readPreState(call: ToolCall): Promise<Hex32> {
    await this.gate;
    return super.readPreState(call);
  }
}

describe("RecourseAdapter lifecycle", () => {
  it("runs hooks in order and emits after postExecute", async () => {
    const stages: AdapterExecutionStage[] = [];
    const adapter = new RecordingAdapter({
      domain,
      signer,
      adapterAddress: signer.address as Hex20,
      now: () => 1746979200,
      recordToChain: async () =>
        "0x9999000000000000000000000000000000000000000000000000000000000001" as Hex32,
      onStage: (stage) => stages.push(stage),
    });

    const result = await adapter.run(call);

    expect(stages).toEqual([
      "preExecute",
      "execute",
      "postExecute",
      "emitEffectReceipt",
      "recordToChain",
    ]);
    expect(result.receipt.postStateDigest).toBe(hashEvidence({ stage: "post" }).hash);
    expect(result.txHash).toBe(
      "0x9999000000000000000000000000000000000000000000000000000000000001",
    );
  });

  it("fails before returning a fake chain commit when recordToChain is missing", async () => {
    const adapter = new SideEffectTrackingAdapter({
      domain,
      signer,
      adapterAddress: signer.address as Hex20,
      now: () => 1746979200,
    } as unknown as ConstructorParameters<typeof RecordingAdapter>[0]);

    await expect(adapter.run(call)).rejects.toThrow(MissingRecordToChainError);
    expect(adapter.executeCalls).toBe(0);
  });

  it.each([
    "0x0000000000000000000000000000000000000000000000000000000000000000",
    "0x1234",
    "not-a-transaction-hash",
  ])("rejects an invalid recordToChain transaction hash: %s", async (txHash) => {
    const adapter = new RecordingAdapter({
      domain,
      signer,
      adapterAddress: signer.address as Hex20,
      now: () => 1746979200,
      recordToChain: async () => txHash as Hex32,
    });

    await expect(adapter.run(call)).rejects.toThrow(InvalidChainTransactionHashError);
  });

  it("rejects concurrent runs on the same adapter instance", async () => {
    const gate = deferred();
    const adapter = new BlockingPreStateAdapter(
      {
        domain,
        signer,
        adapterAddress: signer.address as Hex20,
        now: () => 1746979200,
        recordToChain: async () =>
          "0x9999000000000000000000000000000000000000000000000000000000000001" as Hex32,
      },
      gate.promise,
    );

    const firstRun = adapter.run(call);
    await expect(adapter.run(call)).rejects.toThrow(AdapterConcurrentRunError);

    gate.resolve();
    await expect(firstRun).resolves.toHaveProperty("txHash");
    await expect(adapter.run(call)).resolves.toHaveProperty("txHash");
  });
});
