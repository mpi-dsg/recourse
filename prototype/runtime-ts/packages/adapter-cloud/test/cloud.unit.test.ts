import { describe, expect, it } from "bun:test";
import { AdapterScopeError, type ToolCall } from "../../adapter-sdk/src/index.ts";
import { verifyEffectReceipt, type Hex20, type Hex32 } from "../../receipts/src/index.ts";
import { adapterAccount as signer } from "../../receipts/test/helpers.ts";
import {
  CloudAdapter,
  realCloudResourceDigest,
  type CloudClient,
  type CloudParameter,
} from "../src/index.ts";

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};
const contractId =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32;
const jobId = "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex32;
const txHash = "0x9999000000000000000000000000000000000000000000000000000000000001" as Hex32;

class MockCloudClient implements CloudClient {
  public store: Record<string, CloudParameter | undefined>;
  public readonly calls: Array<[string, ...unknown[]]> = [];

  constructor(seed: Record<string, CloudParameter | undefined> = {}) {
    this.store = { ...seed };
  }

  async getParameter(name: string): Promise<CloudParameter | null> {
    this.calls.push(["getParameter", name]);
    return this.store[name] ?? null;
  }
  async putParameter(name: string, value: string): Promise<CloudParameter> {
    this.calls.push(["putParameter", name, value]);
    const prev = this.store[name];
    const version = (prev?.version ?? 0) + 1;
    const next = { name, value, version };
    this.store[name] = next;
    return next;
  }
  async deleteParameter(name: string): Promise<void> {
    this.calls.push(["deleteParameter", name]);
    delete this.store[name];
  }
}

function adapter(client: CloudClient): CloudAdapter {
  return new CloudAdapter({
    domain,
    signer,
    adapterAddress: signer.address as Hex20,
    now: () => 1_746_979_200,
    recordToChain: async () => txHash,
    client,
    allowedResources: ["/recourse/test/app-config"],
  });
}

function setCall(value: string): ToolCall {
  return {
    contractId,
    jobId,
    tool: "cloud",
    action: "set-parameter",
    params: { resourceId: "/recourse/test/app-config", config: { value } },
    resource: { resourceId: "/recourse/test/app-config" },
  };
}

function deleteCall(): ToolCall {
  return {
    contractId,
    jobId,
    tool: "cloud",
    action: "delete-parameter",
    params: { resourceId: "/recourse/test/app-config", config: { value: "" } },
    resource: { resourceId: "/recourse/test/app-config" },
  };
}

describe("CloudAdapter (mock client)", () => {
  it("set-parameter updates the value and signs a verifiable receipt", async () => {
    const client = new MockCloudClient({
      "/recourse/test/app-config": {
        name: "/recourse/test/app-config",
        value: "{\"replicas\":2}",
        version: 1,
      },
    });
    const result = await adapter(client).run(setCall("{\"replicas\":99}"));

    expect(result.providerOutcome.previous).toBe("{\"replicas\":2}");
    expect(result.providerOutcome.next).toBe("{\"replicas\":99}");
    expect(result.providerOutcome.version).toBe(2);
    expect(result.post.postStateDigest).toBe(
      realCloudResourceDigest({
        resourceId: "/recourse/test/app-config",
        value: "{\"replicas\":99}",
      }),
    );
    await expect(verifyEffectReceipt({ domain, receipt: result.receipt })).resolves.toBe(true);
    expect(client.store["/recourse/test/app-config"]?.value).toBe("{\"replicas\":99}");
  });

  it("set-parameter writes a fresh parameter when one did not exist", async () => {
    const client = new MockCloudClient();
    const result = await adapter(client).run(setCall("hello"));
    expect(result.providerOutcome.previous).toBeNull();
    expect(result.providerOutcome.next).toBe("hello");
  });

  it("delete-parameter removes the value", async () => {
    const client = new MockCloudClient({
      "/recourse/test/app-config": { name: "/recourse/test/app-config", value: "v" },
    });
    const result = await adapter(client).run(deleteCall());
    expect(result.providerOutcome.next).toBeNull();
    expect(client.store["/recourse/test/app-config"]).toBeUndefined();
  });

  it("rejects delete on a missing parameter", async () => {
    const client = new MockCloudClient();
    await expect(adapter(client).run(deleteCall())).rejects.toThrow(AdapterScopeError);
  });

  it("rejects resource outside allowedResources", async () => {
    const client = new MockCloudClient();
    const call: ToolCall = {
      ...setCall("x"),
      params: { resourceId: "/recourse/other", config: { value: "x" } },
      resource: { resourceId: "/recourse/other" },
    };
    await expect(adapter(client).run(call)).rejects.toThrow(AdapterScopeError);
  });

  it("rejects mismatched params and resource ids", async () => {
    const client = new MockCloudClient();
    const call: ToolCall = {
      ...setCall("x"),
      resource: { resourceId: "/recourse/wrong" },
    };
    await expect(adapter(client).run(call)).rejects.toThrow(AdapterScopeError);
  });

  it("rejects set-parameter without a string config.value", async () => {
    const client = new MockCloudClient();
    const call: ToolCall = {
      ...setCall("x"),
      params: { resourceId: "/recourse/test/app-config", config: {} as { value: string } },
    };
    await expect(adapter(client).run(call)).rejects.toThrow(AdapterScopeError);
  });

  it("rejects unsupported actions", async () => {
    const client = new MockCloudClient({
      "/recourse/test/app-config": { name: "/recourse/test/app-config", value: "v" },
    });
    const call: ToolCall = { ...setCall("x"), action: "rotate-key" };
    await expect(adapter(client).run(call)).rejects.toThrow(AdapterScopeError);
  });
});
