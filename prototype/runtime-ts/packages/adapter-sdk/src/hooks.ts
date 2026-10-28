import type { Hex32 } from "../../receipts/src/types.gen.ts";

export type AdapterExecutionStage =
  | "preExecute"
  | "execute"
  | "postExecute"
  | "emitEffectReceipt"
  | "recordToChain";

export interface ToolCall<TParams = unknown, TResource = unknown> {
  contractId: Hex32;
  jobId: Hex32;
  tool: string;
  action: string;
  params: TParams;
  resource: TResource;
}

export interface PreExecution {
  intentHash: Hex32;
  paramsHash: Hex32;
  resourceId: Hex32;
  preStateDigest: Hex32;
}

export interface PostExecution {
  postStateDigest: Hex32;
  providerReceiptHash?: Hex32;
}
