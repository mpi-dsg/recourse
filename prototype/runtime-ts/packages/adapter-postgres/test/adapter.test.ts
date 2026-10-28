import { describe, expect, it } from "bun:test";
import { AdapterScopeError, type ToolCall } from "../../adapter-sdk/src/index.ts";
import { verifyEffectReceipt, type Hex20, type Hex32 } from "../../receipts/src/index.ts";
import { adapterAccount as signer } from "../../receipts/test/helpers.ts";
import { MemoryPostgresAdapter, postgresStateDigest } from "../src/index.ts";

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};
const contractId = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32;
const jobId = "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex32;
const txHash = "0x9999000000000000000000000000000000000000000000000000000000000001" as Hex32;

function adapter(): MemoryPostgresAdapter {
  return new MemoryPostgresAdapter({
    domain,
    signer,
    adapterAddress: signer.address as Hex20,
    now: () => 1746979200,
    recordToChain: async () => txHash,
    allowedTables: ["tenant_rows"],
    tables: {
      tenant_rows: {
        tableOid: "pg_class:42",
        lsn: 100,
        rows: [
          { id: 1, tenantId: "tenant-a", value: "delete-me" },
          { id: 2, tenantId: "tenant-a", value: "delete-me-too" },
          { id: 3, tenantId: "tenant-b", value: "keep" },
        ],
      },
    },
  });
}

describe("MemoryPostgresAdapter", () => {
  it("delete-with-too-broad-where emits effect receipt with affected_rows in postStateDigest", async () => {
    const call: ToolCall = {
      contractId,
      jobId,
      tool: "postgres",
      action: "delete",
      params: { table: "tenant_rows", where: { tenantId: "tenant-a" } },
      resource: { table: "tenant_rows" },
    };

    const result = await adapter().run(call);

    expect(result.providerOutcome.affectedRows).toBe(2);
    expect(result.receipt.postStateDigest).toBe(
      postgresStateDigest({ tableOid: "pg_class:42", lsn: 101, affectedRows: 2 }),
    );
    await expect(verifyEffectReceipt({ domain, receipt: result.receipt })).resolves.toBe(true);
  });

  it("update-on-non-eligible-table refuses", async () => {
    const call: ToolCall = {
      contractId,
      jobId,
      tool: "postgres",
      action: "update",
      params: { table: "audit_logs", where: { tenantId: "tenant-a" }, set: { value: "x" } },
      resource: { table: "audit_logs" },
    };

    await expect(adapter().run(call)).rejects.toThrow(AdapterScopeError);
  });

  it("rejects mismatched params table and resource scope", async () => {
    const call: ToolCall = {
      contractId,
      jobId,
      tool: "postgres",
      action: "delete",
      params: { table: "tenant_rows", where: { tenantId: "tenant-a" } },
      resource: { table: "audit_logs" },
    };

    await expect(adapter().run(call)).rejects.toThrow(AdapterScopeError);
  });

  it("rejects empty mutation predicates", async () => {
    const deleteCall: ToolCall = {
      contractId,
      jobId,
      tool: "postgres",
      action: "delete",
      params: { table: "tenant_rows", where: {} },
      resource: { table: "tenant_rows" },
    };
    const updateCall: ToolCall = {
      ...deleteCall,
      action: "update",
      params: { table: "tenant_rows", where: { tenantId: "tenant-a" }, set: {} },
    };

    await expect(adapter().run(deleteCall)).rejects.toThrow(AdapterScopeError);
    await expect(adapter().run(updateCall)).rejects.toThrow(AdapterScopeError);
  });
});
