import { AdapterScopeError, RecourseAdapter, type PostExecution, type PreExecution, type RecourseAdapterConfig, type ToolCall } from "../../adapter-sdk/src/index.ts";
import { hashEvidence } from "../../evidence-store/src/index.ts";
import type { Hex32 } from "../../receipts/src/index.ts";

export * from "./git-client.ts";
export * from "./git.ts";
export * from "./local-bare-client.ts";

interface GitResource {
  repo: string;
  ref: string;
}

interface GitParams {
  ref: string;
  to: string;
}

export interface MemoryGitAdapterConfig extends RecourseAdapterConfig {
  refs: Record<string, string>;
  commitSizes: Record<string, number>;
}

export interface GitProviderOutcome {
  ref: string;
  previous: string;
  next: string;
  bytesOfHistoryChanged: number;
}

export function gitRefDigest(input: { repo: string; ref: string; oid: string }): Hex32 {
  return hashEvidence(input).hash;
}

export class MemoryGitAdapter extends RecourseAdapter<GitProviderOutcome> {
  constructor(private readonly cfg: MemoryGitAdapterConfig) {
    super(cfg);
  }

  protected async readPreState(call: ToolCall): Promise<Hex32> {
    const resource = call.resource as GitResource;
    return gitRefDigest({ repo: resource.repo, ref: resource.ref, oid: this.oid(resource.ref) });
  }

  protected async execute(call: ToolCall): Promise<GitProviderOutcome> {
    if (call.action !== "force-push") throw new AdapterScopeError(`unsupported git action: ${call.action}`);
    const params = call.params as GitParams;
    const resource = call.resource as GitResource;
    if (params.ref !== resource.ref) {
      throw new AdapterScopeError(`git params ref does not match resource ref: ${params.ref}`);
    }
    const previous = this.oid(params.ref);
    this.cfg.refs[params.ref] = params.to;
    return {
      ref: params.ref,
      previous,
      next: params.to,
      bytesOfHistoryChanged: Math.abs((this.cfg.commitSizes[previous] ?? 0) - (this.cfg.commitSizes[params.to] ?? 0)),
    };
  }

  protected async readPostState(call: ToolCall, outcome: GitProviderOutcome, _pre: PreExecution): Promise<PostExecution> {
    const resource = call.resource as GitResource;
    return {
      postStateDigest: gitRefDigest({ repo: resource.repo, ref: outcome.ref, oid: outcome.next }),
      providerReceiptHash: hashEvidence({ workload: "git", ref: outcome.ref, previous: outcome.previous, next: outcome.next }).hash,
    };
  }

  private oid(ref: string): string {
    const oid = this.cfg.refs[ref];
    if (!oid) throw new AdapterScopeError(`unknown git ref: ${ref}`);
    return oid;
  }
}
