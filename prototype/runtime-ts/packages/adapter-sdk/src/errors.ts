export class AdapterScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterScopeError";
  }
}

export class AdapterExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AdapterExecutionError";
  }
}

export class MissingRecordToChainError extends Error {
  constructor() {
    super("recordToChain callback is required before executing a compensable side effect");
    this.name = "MissingRecordToChainError";
  }
}

export class AdapterConcurrentRunError extends Error {
  constructor() {
    super("adapter instances do not support concurrent run() calls");
    this.name = "AdapterConcurrentRunError";
  }
}

export class InvalidChainTransactionHashError extends Error {
  constructor(txHash: unknown) {
    super(`recordToChain returned an invalid transaction hash: ${String(txHash)}`);
    this.name = "InvalidChainTransactionHashError";
  }
}
