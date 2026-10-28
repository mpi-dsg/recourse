import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Client } from "pg";
import { hashEvidence } from "../../../evidence-store/src/index.ts";
import {
  signEffectReceipt,
  verifyRecoveryReceipt,
  type EffectReceipt,
  type Hex20,
  type Hex32,
  type RecourseContract,
} from "../../../receipts/src/index.ts";
import {
  adapterAccount as adapter,
  compensatorAccount as compensator,
} from "../../../receipts/test/helpers.ts";
import { PgPostgresCompensator } from "../src/pg.ts";

const url = process.env.RECOURSE_PG_URL;
const skip = !url;

const domain = {
  chainId: 84532,
  verifyingContract: "0x0000000000000000000000000000000000000000" as Hex20,
};

const contract: RecourseContract = {
  schemaVersion: 1,
  contractId: "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex32,
  operator: "0x000000000000000000000000000000000000bEEF" as Hex20,
  actionTemplate: { tool: "postgres", action: "delete" },
  resourceScope: { type: "postgres-table", descriptor: { table: "tenant_rows" } },
  effectClass: "compensable",
  recoveryOperator: {
    compensatorId: "postgres",
    freshnessSeconds: 60,
    retentionSeconds: 3600,
    authPolicyHash: hashEvidence("auth").hash,
  },
  coveredLossClass: { codes: ["rows_deleted"], excludeList: [] },
  payoutRule: { type: "rowCountSchedule", params: {}, maxPayout: "1000" },
  bond: {
    asset: "0x0000000000000000000000000000000000000001",
    minAmount: "1000",
    maxAggregateExposure: "1000",
  },
  evidenceSchema: {
    schemaId: hashEvidence("schema").hash,
    requiredProvenance: "L1",
    accessPolicyHash: hashEvidence("access").hash,
  },
  deadlines: { recoverySeconds: 60, submissionSeconds: 300, livenessSeconds: 600 },
  disputeRoute: { arbitrator: "0x0000000000000000000000000000000000000002", evidenceGroupId: "1" },
};

async function effect(timestamp = 1_746_979_200): Promise<EffectReceipt> {
  return signEffectReceipt({
    domain,
    signer: adapter,
    receipt: {
      schemaVersion: 1,
      contractId: contract.contractId,
      jobId: "0xdead000000000000000000000000000000000000000000000000000000000001" as Hex32,
      intentHash: hashEvidence("intent").hash,
      paramsHash: hashEvidence("params").hash,
      resourceId: hashEvidence("tenant_rows").hash,
      preStateDigest: hashEvidence("pre").hash,
      postStateDigest: hashEvidence("post").hash,
      timestamp,
      adapterAddress: adapter.address as Hex20,
    },
  });
}

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
       (1, 'tenant-a', 'a'),
       (2, 'tenant-a', 'b'),
       (3, 'tenant-b', 'c')`,
  );
});

describe.skipIf(skip)("PgPostgresCompensator (real Postgres)", () => {
  it("restores deleted rows and reports success matching the pre-state", async () => {
    // Simulate the failure: an over-broad delete that removed two tenant-a rows.
    const deleted = await client!.query<{
      id: number;
      tenant_id: string;
      value: string;
    }>(
      "DELETE FROM tenant_rows WHERE tenant_id = $1 RETURNING id, tenant_id, value",
      ["tenant-a"],
    );
    expect(deleted.rowCount).toBe(2);

    const sdk = new PgPostgresCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1_746_979_215,
      client: client!,
      tableName: "tenant_rows",
      snapshotRows: deleted.rows,
      expectedRecoveredRows: deleted.rowCount ?? 0,
    });

    const receipt = await sdk.recover(await effect());

    expect(receipt.outcome).toBe("success");
    expect(receipt.residualMeasurements?.recovered_row_count?.value).toBe("2");
    expect(receipt.residualMeasurements?.rows_deleted?.value).toBe("0");
    await expect(verifyRecoveryReceipt({ domain, receipt })).resolves.toBe(true);

    const restored = await client!.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM tenant_rows WHERE tenant_id = 'tenant-a'",
    );
    expect(restored.rows[0]!.count).toBe("2");

    // pre-state row-set equality: every snapshot row is present with the same value
    for (const row of deleted.rows) {
      const r = await client!.query<{ value: string }>(
        "SELECT value FROM tenant_rows WHERE id = $1",
        [row.id],
      );
      expect(r.rows[0]!.value).toBe(row.value);
    }
  });

  it("reports partial when only some rows can be restored", async () => {
    // One row is already present; snapshot claims two should be restored.
    await client!.query("DELETE FROM tenant_rows WHERE id = $1", [1]);

    const sdk = new PgPostgresCompensator({
      contract,
      domain,
      signer: compensator,
      compensatorAddress: compensator.address as Hex20,
      now: () => 1_746_979_215,
      client: client!,
      tableName: "tenant_rows",
      // Both id=1 (missing) and id=2 (already present) appear in the snapshot.
      snapshotRows: [
        { id: 1, tenant_id: "tenant-a", value: "a" },
        { id: 2, tenant_id: "tenant-a", value: "b" },
      ],
      expectedRecoveredRows: 2,
    });

    const receipt = await sdk.recover(await effect());

    expect(receipt.outcome).toBe("partial");
    expect(receipt.residualMeasurements?.recovered_row_count?.value).toBe("1");
    expect(receipt.residualMeasurements?.rows_deleted?.value).toBe("1");
  });
});
