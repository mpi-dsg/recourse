import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "pg";
import { AdapterScopeError, type ToolCall } from "../../adapter-sdk/src/index.ts";
import { verifyEffectReceipt, type Hex20, type Hex32 } from "../../receipts/src/index.ts";
import { adapterAccount as signer } from "../../receipts/test/helpers.ts";
import { PgPostgresAdapter, pgPostgresStateDigest } from "../src/pg.ts";

// Integration test against a real Postgres reachable at RECOURSE_PG_URL.
// `make test-integration` (or `scripts/integration-up.sh`) brings up the
// docker-compose stack that publishes this URL.
const url = process.env.RECOURSE_PG_URL;
const skip = !url;

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};
const contractId =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32;
const jobId = "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex32;
const txHash = "0x9999000000000000000000000000000000000000000000000000000000000001" as Hex32;

let client: Client | undefined;

beforeAll(async () => {
  if (skip) return;
  client = new Client({ connectionString: url });
  await client.connect();
  await client.query("DROP TABLE IF EXISTS tenant_rows");
  await client.query(`
    CREATE TABLE tenant_rows (
      id INT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      value TEXT NOT NULL
    )
  `);
}, 30_000);

afterAll(async () => {
  if (client) {
    await client.query("DROP TABLE IF EXISTS tenant_rows");
    await client.end();
  }
});

beforeEach(async () => {
  if (skip) return;
  await client!.query("TRUNCATE tenant_rows");
  await client!.query(
    `INSERT INTO tenant_rows (id, tenant_id, value) VALUES
       (1, 'tenant-a', 'delete-me'),
       (2, 'tenant-a', 'delete-me-too'),
       (3, 'tenant-b', 'keep')`,
  );
});

function adapter(): PgPostgresAdapter {
  return new PgPostgresAdapter({
    domain,
    signer,
    adapterAddress: signer.address as Hex20,
    now: () => 1_746_979_200,
    recordToChain: async () => txHash,
    client: client!,
    allowedTables: ["tenant_rows"],
  });
}

async function lookupTableOid(table: string): Promise<string> {
  const r = await client!.query<{ oid: number }>(
    "SELECT oid FROM pg_class WHERE relname = $1 AND relkind = 'r'",
    [table],
  );
  return `pg_class:${r.rows[0]!.oid}`;
}

describe.skipIf(skip)("PgPostgresAdapter (real Postgres)", () => {
  it("delete-with-too-broad-where emits effect receipt with affected_rows in postStateDigest", async () => {
    const call: ToolCall = {
      contractId,
      jobId,
      tool: "postgres",
      action: "delete",
      params: { table: "tenant_rows", where: { tenant_id: "tenant-a" } },
      resource: { table: "tenant_rows" },
    };

    const result = await adapter().run(call);

    expect(result.providerOutcome.affectedRows).toBe(2);
    const tableOid = await lookupTableOid("tenant_rows");
    expect(result.post.postStateDigest).toBe(
      pgPostgresStateDigest({
        tableOid,
        lsn: result.providerOutcome.postLsn,
        affectedRows: 2,
      }),
    );

    await expect(verifyEffectReceipt({ domain, receipt: result.receipt })).resolves.toBe(true);

    const post = await client!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM tenant_rows",
    );
    expect(post.rows[0]!.count).toBe("1");
  });

  it("update mutates rows and emits a recoverable receipt", async () => {
    const call: ToolCall = {
      contractId,
      jobId,
      tool: "postgres",
      action: "update",
      params: {
        table: "tenant_rows",
        where: { tenant_id: "tenant-a" },
        set: { value: "redacted" },
      },
      resource: { table: "tenant_rows" },
    };

    const result = await adapter().run(call);

    expect(result.providerOutcome.affectedRows).toBe(2);
    await expect(verifyEffectReceipt({ domain, receipt: result.receipt })).resolves.toBe(true);

    const post = await client!.query<{ value: string }>(
      "SELECT value FROM tenant_rows WHERE tenant_id = 'tenant-a'",
    );
    expect(post.rows.every((row) => row.value === "redacted")).toBe(true);
  });

  it("update-on-non-eligible-table refuses", async () => {
    const call: ToolCall = {
      contractId,
      jobId,
      tool: "postgres",
      action: "update",
      params: { table: "audit_logs", where: { tenant_id: "tenant-a" }, set: { value: "x" } },
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
      params: { table: "tenant_rows", where: { tenant_id: "tenant-a" } },
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
      params: { table: "tenant_rows", where: { tenant_id: "tenant-a" }, set: {} },
    };
    await expect(adapter().run(deleteCall)).rejects.toThrow(AdapterScopeError);
    await expect(adapter().run(updateCall)).rejects.toThrow(AdapterScopeError);
  });

  it("rejects sql-injection-shaped identifiers", async () => {
    const call: ToolCall = {
      contractId,
      jobId,
      tool: "postgres",
      action: "delete",
      params: { table: 'tenant_rows"; DROP TABLE tenant_rows;--', where: { tenant_id: "x" } },
      resource: { table: 'tenant_rows"; DROP TABLE tenant_rows;--' },
    };
    await expect(adapter().run(call)).rejects.toThrow(AdapterScopeError);
  });
});
