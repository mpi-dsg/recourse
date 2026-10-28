import {
  AdapterScopeError,
  RecourseAdapter,
  type PostExecution,
  type RecourseAdapterConfig,
  type ToolCall,
} from "../../adapter-sdk/src/index.ts";
import { hashEvidence } from "../../evidence-store/src/index.ts";
import type { Hex32 } from "../../receipts/src/index.ts";
import {
  GitClientError,
  assertGitRef,
  assertGitSha,
  type GitClient,
} from "./git-client.ts";

export interface GitAdapterConfig extends RecourseAdapterConfig {
  client: GitClient;
  repo: string;
  allowedRefs: string[];
}

interface GitParams {
  ref: string;
  to?: string;
}

interface GitResource {
  repo: string;
  ref: string;
}

interface PreContext {
  previousSha: string | null;
  previousSize: number;
}

export interface RealGitProviderOutcome {
  ref: string;
  previous: string | null;
  next: string | null;
  bytesOfHistoryChanged: number;
  action: "force-push" | "delete-ref";
}

export function realGitRefDigest(input: {
  repo: string;
  ref: string;
  oid: string | null;
}): Hex32 {
  return hashEvidence({ repo: input.repo, ref: input.ref, oid: input.oid ?? "" }).hash;
}

export class GitAdapter extends RecourseAdapter<RealGitProviderOutcome> {
  private readonly client: GitClient;
  private readonly repo: string;
  private readonly allowedRefs: Set<string>;
  private preContext: PreContext | null = null;

  constructor(cfg: GitAdapterConfig) {
    super(cfg);
    for (const ref of cfg.allowedRefs) assertGitRef(ref);
    this.client = cfg.client;
    this.repo = cfg.repo;
    this.allowedRefs = new Set(cfg.allowedRefs);
  }

  protected async readPreState(call: ToolCall): Promise<Hex32> {
    const { params, resource } = this.parse(call);
    this.assertRefAllowed(resource.ref);
    if (params.ref !== resource.ref) {
      throw new AdapterScopeError(`git params ref does not match resource ref: ${params.ref}`);
    }
    const previousSha = await this.client.revParse(resource.ref);
    let previousSize = 0;
    if (previousSha) {
      try {
        previousSize = await this.client.commitObjectSize(previousSha);
      } catch (error) {
        if (!(error instanceof GitClientError)) throw error;
      }
    }
    this.preContext = { previousSha, previousSize };
    return realGitRefDigest({ repo: this.repo, ref: resource.ref, oid: previousSha });
  }

  protected async execute(call: ToolCall): Promise<RealGitProviderOutcome> {
    const { params, resource } = this.parse(call);
    const ctx = this.preContext;
    if (!ctx) throw new AdapterScopeError("preExecute did not run before execute");
    if (call.action === "force-push") {
      if (!params.to) throw new AdapterScopeError("force-push requires params.to");
      assertGitSha(params.to);
      await this.client.updateRef(resource.ref, params.to);
      const nextSize = await this.client.commitObjectSize(params.to);
      return {
        ref: resource.ref,
        previous: ctx.previousSha,
        next: params.to,
        bytesOfHistoryChanged: Math.abs(nextSize - ctx.previousSize),
        action: "force-push",
      };
    }
    if (call.action === "delete-ref") {
      if (!ctx.previousSha) {
        throw new AdapterScopeError(`cannot delete non-existent ref: ${resource.ref}`);
      }
      await this.client.deleteRef(resource.ref);
      return {
        ref: resource.ref,
        previous: ctx.previousSha,
        next: null,
        bytesOfHistoryChanged: ctx.previousSize,
        action: "delete-ref",
      };
    }
    throw new AdapterScopeError(`unsupported git action: ${call.action}`);
  }

  protected async readPostState(
    _call: ToolCall,
    outcome: RealGitProviderOutcome,
  ): Promise<PostExecution> {
    const ctx = this.preContext;
    if (!ctx) throw new AdapterScopeError("preExecute did not run before postExecute");
    const postStateDigest = realGitRefDigest({
      repo: this.repo,
      ref: outcome.ref,
      oid: outcome.next,
    });
    const providerReceiptHash = hashEvidence({
      workload: "git",
      repo: this.repo,
      ref: outcome.ref,
      action: outcome.action,
      previous: outcome.previous ?? "",
      next: outcome.next ?? "",
      bytesOfHistoryChanged: outcome.bytesOfHistoryChanged,
    }).hash;
    this.preContext = null;
    return { postStateDigest, providerReceiptHash };
  }

  private parse(call: ToolCall): { params: GitParams; resource: GitResource } {
    const params = call.params as GitParams;
    const resource = call.resource as GitResource;
    if (resource.repo !== this.repo) {
      throw new AdapterScopeError(`git resource repo mismatch: ${resource.repo}`);
    }
    return { params, resource };
  }

  private assertRefAllowed(ref: string): void {
    if (!this.allowedRefs.has(ref)) {
      throw new AdapterScopeError(`ref is outside registered scope: ${ref}`);
    }
  }
}
