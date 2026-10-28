import { hashEvidence, type EvidencePayload } from "../../evidence-store/src/index.ts";
import {
  signEffectReceipt,
  type EffectReceipt,
  type Hex20,
  type Hex32,
  type RecourseDomainArgs,
  type RecourseTypedDataSigner,
} from "../../receipts/src/index.ts";
import {
  AdapterConcurrentRunError,
  InvalidChainTransactionHashError,
  MissingRecordToChainError,
} from "./errors.ts";
import type { AdapterExecutionStage, PostExecution, PreExecution, ToolCall } from "./hooks.ts";

const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ZERO_TRANSACTION_HASH = `0x${"0".repeat(64)}`;

export interface RecourseAdapterConfig {
  domain: RecourseDomainArgs;
  signer: RecourseTypedDataSigner;
  adapterAddress: Hex20;
  now?: () => number;
  recordToChain: (receipt: EffectReceipt) => Promise<Hex32>;
  onStage?: (stage: AdapterExecutionStage) => void;
}

export interface AdapterRunResult<TOutcome> {
  pre: PreExecution;
  providerOutcome: TOutcome;
  post: PostExecution;
  receipt: EffectReceipt;
  txHash: Hex32;
}

export abstract class RecourseAdapter<TOutcome, TCall extends ToolCall = ToolCall> {
  private inFlight = false;

  constructor(private readonly config: RecourseAdapterConfig) {}

  async run(call: TCall): Promise<AdapterRunResult<TOutcome>> {
    this.assertRecordToChainConfigured();
    if (this.inFlight) throw new AdapterConcurrentRunError();
    this.inFlight = true;
    try {
      this.stage("preExecute");
      const pre = await this.preExecute(call);

      this.stage("execute");
      const providerOutcome = await this.execute(call, pre);

      this.stage("postExecute");
      const post = await this.postExecute(call, providerOutcome, pre);

      this.stage("emitEffectReceipt");
      const receipt = await this.emitEffectReceipt(call, pre, post);

      this.stage("recordToChain");
      const txHash = await this.recordToChain(receipt);

      return { pre, providerOutcome, post, receipt, txHash };
    } finally {
      this.inFlight = false;
    }
  }

  async preExecute(call: TCall): Promise<PreExecution> {
    return {
      intentHash: hashEvidence({ action: call.action, tool: call.tool }).hash,
      paramsHash: hashEvidence(call.params as EvidencePayload).hash,
      resourceId: hashEvidence(call.resource as EvidencePayload).hash,
      preStateDigest: await this.readPreState(call),
    };
  }

  protected async postExecute(call: TCall, outcome: TOutcome, pre: PreExecution): Promise<PostExecution> {
    return this.readPostState(call, outcome, pre);
  }

  protected async emitEffectReceipt(
    call: TCall,
    pre: PreExecution,
    post: PostExecution,
  ): Promise<EffectReceipt> {
    const unsignedReceipt: Omit<EffectReceipt, "signature"> = {
      schemaVersion: 1,
      contractId: call.contractId,
      jobId: call.jobId,
      intentHash: pre.intentHash,
      paramsHash: pre.paramsHash,
      resourceId: pre.resourceId,
      preStateDigest: pre.preStateDigest,
      postStateDigest: post.postStateDigest,
      timestamp: this.config.now?.() ?? Math.floor(Date.now() / 1000),
      adapterAddress: this.config.adapterAddress,
      ...(post.providerReceiptHash === undefined
        ? {}
        : { providerReceiptHash: post.providerReceiptHash }),
    };
    return signEffectReceipt({
      domain: this.config.domain,
      signer: this.config.signer,
      receipt: unsignedReceipt,
    });
  }

  protected async recordToChain(receipt: EffectReceipt): Promise<Hex32> {
    const txHash = await this.config.recordToChain(receipt);
    if (
      !TRANSACTION_HASH_PATTERN.test(txHash) ||
      txHash.toLowerCase() === ZERO_TRANSACTION_HASH
    ) {
      throw new InvalidChainTransactionHashError(txHash);
    }
    return txHash;
  }

  protected abstract execute(call: TCall, pre: PreExecution): Promise<TOutcome>;

  protected abstract readPreState(call: TCall): Promise<Hex32>;

  protected abstract readPostState(call: TCall, outcome: TOutcome, pre: PreExecution): Promise<PostExecution>;

  private stage(stage: AdapterExecutionStage): void {
    this.config.onStage?.(stage);
  }

  private assertRecordToChainConfigured(): void {
    if (typeof this.config.recordToChain !== "function") {
      throw new MissingRecordToChainError();
    }
  }
}
