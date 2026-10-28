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
  CloudClientError,
  assertCloudParameterName,
  type CloudClient,
} from "./cloud-client.ts";

export interface CloudAdapterConfig extends RecourseAdapterConfig {
  client: CloudClient;
  allowedResources: string[];
}

interface CloudParams {
  resourceId: string;
  config: { value: string };
}

interface CloudCallResource {
  resourceId: string;
}

interface PreContext {
  previousValue: string | null;
  previousVersion: number | null;
}

export interface RealCloudProviderOutcome {
  resourceId: string;
  previous: string | null;
  next: string | null;
  version: number | null;
  action: "set-parameter" | "delete-parameter";
}

export function realCloudResourceDigest(input: {
  resourceId: string;
  value: string | null;
}): Hex32 {
  return hashEvidence({ resourceId: input.resourceId, value: input.value ?? "" }).hash;
}

export class CloudAdapter extends RecourseAdapter<RealCloudProviderOutcome> {
  private readonly client: CloudClient;
  private readonly allowedResources: Set<string>;
  private preContext: PreContext | null = null;

  constructor(cfg: CloudAdapterConfig) {
    super(cfg);
    for (const id of cfg.allowedResources) assertCloudParameterName(id);
    this.client = cfg.client;
    this.allowedResources = new Set(cfg.allowedResources);
  }

  protected async readPreState(call: ToolCall): Promise<Hex32> {
    const params = this.parseParams(call);
    this.assertResourceAllowed(params.resourceId);
    const previous = await this.client.getParameter(params.resourceId);
    this.preContext = {
      previousValue: previous?.value ?? null,
      previousVersion: previous?.version ?? null,
    };
    return realCloudResourceDigest({
      resourceId: params.resourceId,
      value: previous?.value ?? null,
    });
  }

  protected async execute(call: ToolCall): Promise<RealCloudProviderOutcome> {
    const params = this.parseParams(call);
    const ctx = this.preContext;
    if (!ctx) throw new AdapterScopeError("preExecute did not run before execute");

    if (call.action === "set-parameter") {
      if (typeof params.config?.value !== "string") {
        throw new AdapterScopeError("set-parameter requires params.config.value");
      }
      const result = await this.client.putParameter(params.resourceId, params.config.value);
      return {
        resourceId: params.resourceId,
        previous: ctx.previousValue,
        next: result.value,
        version: result.version ?? null,
        action: "set-parameter",
      };
    }
    if (call.action === "delete-parameter") {
      if (ctx.previousValue === null) {
        throw new AdapterScopeError(`cannot delete missing parameter: ${params.resourceId}`);
      }
      await this.client.deleteParameter(params.resourceId);
      return {
        resourceId: params.resourceId,
        previous: ctx.previousValue,
        next: null,
        version: null,
        action: "delete-parameter",
      };
    }
    throw new AdapterScopeError(`unsupported cloud action: ${call.action}`);
  }

  protected async readPostState(
    _call: ToolCall,
    outcome: RealCloudProviderOutcome,
  ): Promise<PostExecution> {
    const ctx = this.preContext;
    if (!ctx) throw new AdapterScopeError("preExecute did not run before postExecute");
    const postStateDigest = realCloudResourceDigest({
      resourceId: outcome.resourceId,
      value: outcome.next,
    });
    const providerReceiptHash = hashEvidence({
      workload: "cloud",
      resourceId: outcome.resourceId,
      action: outcome.action,
      previous: outcome.previous ?? "",
      next: outcome.next ?? "",
      version: outcome.version ?? 0,
    }).hash;
    this.preContext = null;
    return { postStateDigest, providerReceiptHash };
  }

  private parseParams(call: ToolCall): CloudParams {
    const params = call.params as CloudParams;
    const resource = call.resource as CloudCallResource;
    if (params.resourceId !== resource.resourceId) {
      throw new AdapterScopeError(
        `cloud params resourceId does not match resource id: ${params.resourceId}`,
      );
    }
    return params;
  }

  private assertResourceAllowed(resourceId: string): void {
    if (!this.allowedResources.has(resourceId)) {
      throw new AdapterScopeError(`resource is outside registered scope: ${resourceId}`);
    }
  }
}

export { CloudClientError };
