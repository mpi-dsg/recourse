import { AdapterScopeError, RecourseAdapter, type PostExecution, type PreExecution, type RecourseAdapterConfig, type ToolCall } from "../../adapter-sdk/src/index.ts";
import { hashEvidence } from "../../evidence-store/src/index.ts";
import type { Hex32 } from "../../receipts/src/index.ts";

export * from "./cloud-client.ts";
export * from "./cloud.ts";
export * from "./localstack-ssm-client.ts";

interface CloudResource {
  kind: string;
  config: Record<string, unknown>;
}

interface CloudCallResource {
  resourceId: string;
}

interface CloudParams {
  resourceId: string;
  config: Record<string, unknown>;
}

export interface MemoryCloudAdapterConfig extends RecourseAdapterConfig {
  resources: Record<string, CloudResource>;
}

export interface CloudProviderOutcome {
  resourceId: string;
  kind: string;
  previous: Record<string, unknown>;
  next: Record<string, unknown>;
}

export function cloudResourceDigest(input: { resourceId: string; kind: string; config: Record<string, unknown> }): Hex32 {
  return hashEvidence(input).hash;
}

export class MemoryCloudAdapter extends RecourseAdapter<CloudProviderOutcome> {
  constructor(private readonly cfg: MemoryCloudAdapterConfig) {
    super(cfg);
  }

  protected async readPreState(call: ToolCall): Promise<Hex32> {
    const params = this.params(call);
    const resource = this.resource(params.resourceId);
    return cloudResourceDigest({ resourceId: params.resourceId, kind: resource.kind, config: resource.config });
  }

  protected async execute(call: ToolCall): Promise<CloudProviderOutcome> {
    if (call.action !== "set-capacity") throw new AdapterScopeError(`unsupported cloud action: ${call.action}`);
    const params = this.params(call);
    const resource = this.resource(params.resourceId);
    const previous = { ...resource.config };
    resource.config = { ...params.config };
    return { resourceId: params.resourceId, kind: resource.kind, previous, next: { ...resource.config } };
  }

  protected async readPostState(_call: ToolCall, outcome: CloudProviderOutcome, _pre: PreExecution): Promise<PostExecution> {
    return {
      postStateDigest: cloudResourceDigest({ resourceId: outcome.resourceId, kind: outcome.kind, config: outcome.next }),
      providerReceiptHash: hashEvidence({ workload: "cloud", resourceId: outcome.resourceId, next: outcome.next }).hash,
    };
  }

  private params(call: ToolCall): CloudParams {
    const params = call.params as CloudParams;
    const resource = call.resource as CloudCallResource;
    if (params.resourceId !== resource.resourceId) {
      throw new AdapterScopeError(`cloud params resourceId does not match resource id: ${params.resourceId}`);
    }
    return params;
  }

  private resource(resourceId: string): CloudResource {
    const resource = this.cfg.resources[resourceId];
    if (!resource) throw new AdapterScopeError(`unknown cloud resource: ${resourceId}`);
    return resource;
  }
}
