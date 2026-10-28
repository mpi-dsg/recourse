import { describe, expect, it } from "bun:test";
import type { Client, QueryResult, QueryResultRow } from "pg";
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
import {
  PgCompensatorError,
  PgPostgresCompensator,
  type PgPostgresCompensatorConfig,
} from "../src/pg.ts";

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

class MockClient {
  public readonly calls: Array<{ sql: string; values: unknown[] }> = [];
  private readonly script: Array<(sql: string, values: unknown[]) => QueryResult<QueryResultRow>>;

  constructor(script: Array<(sql: string, values: unknown[]) => QueryResult<QueryResultRow>>) {
    this.script = script;
  }

  query<T extends QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<T>> {
    if (this.script.length === 0) throw new Error(`unexpected query: ${text}`);
    const next = this.script.shift()!;
    this.calls.push({ sql: text, values: values ?? [] });
    return Promise.resolve(next(text, values ?? []) as QueryResult<T>);
  }
}

function row<T extends QueryResultRow>(rows: T[], rowCount?: number): QueryResult<QueryResultRow> {
  return { rows: rows as QueryResultRow[], rowCount: rowCount ?? rows.length, command: "", oid: 0, fields: [] };
}

function compensatorWith(cfg: {
  client: MockClient;
  snapshotRows: Record<string, unknown>[];
  expectedRecoveredRows: number;
  tableName?: string;
  primaryKey?: string;
}): PgPostgresCompensator {
  const baseCfg: PgPostgresCompensatorConfig = {
    contract,
    domain,
    signer: compensator,
    compensatorAddress: compensator.address as Hex20,
    now: () => 1_746_979_210,
    client: cfg.client as unknown as Client,
    tableName: cfg.tableName ?? "tenant_rows",
    primaryKey: cfg.primaryKey ?? "id",
    snapshotRows: cfg.snapshotRows,
    expectedRecoveredRows: cfg.expectedRecoveredRows,
  };
  return new PgPostgresCompensator(baseCfg);
}

describe("PgPostgresCompensator (mock client)", () => {
  it("inserts missing rows and emits a verifiable success receipt", async () => {
    const client = new MockClient([
      () => row([{ pk: 3 }]), // existing: only row id=3 still in DB
      () => row([], 1),       // INSERT row id=1 -> 1 inserted
      () => row([], 1),       // INSERT row id=2 -> 1 inserted
    ]);
    const sdk = compensatorWith({
      client,
      snapshotRows: [
        { id: 1, tenant_id: "tenant-a" },
        { id: 2, tenant_id: "tenant-a" },
        { id: 3, tenant_id: "tenant-b" },
      ],
      expectedRecoveredRows: 2,
    });

    const receipt = await sdk.recover(await effect());

    expect(receipt.outcome).toBe("success");
    expect(receipt.residualMeasurements?.recovered_row_count?.value).toBe("2");
    expect(receipt.residualMeasurements?.rows_deleted?.value).toBe("0");
    expect(receipt.residualMeasurements?.downtime_seconds?.value).toBe("10");
    await expect(verifyRecoveryReceipt({ domain, receipt })).resolves.toBe(true);
    expect(client.calls[1]!.sql).toBe(
      `INSERT INTO "tenant_rows" ("id", "tenant_id") VALUES ($1, $2)`,
    );
    expect(client.calls[1]!.values).toEqual([1, "tenant-a"]);
  });

  it("reports partial when fewer rows are inserted than expected", async () => {
    const client = new MockClient([
      () => row([{ pk: 1 }, { pk: 3 }]),
      () => row([], 1),
    ]);
    const sdk = compensatorWith({
      client,
      snapshotRows: [
        { id: 1, tenant_id: "tenant-a" },
        { id: 2, tenant_id: "tenant-a" },
        { id: 3, tenant_id: "tenant-b" },
      ],
      expectedRecoveredRows: 2,
    });

    const receipt = await sdk.recover(await effect());

    expect(receipt.outcome).toBe("partial");
    expect(receipt.residualMeasurements?.recovered_row_count?.value).toBe("1");
    expect(receipt.residualMeasurements?.rows_deleted?.value).toBe("1");
  });

  it("reports failure when no rows are inserted", async () => {
    const client = new MockClient([() => row([{ pk: 1 }, { pk: 2 }])]);
    const sdk = compensatorWith({
      client,
      snapshotRows: [
        { id: 1, tenant_id: "tenant-a" },
        { id: 2, tenant_id: "tenant-a" },
      ],
      expectedRecoveredRows: 2,
    });

    const receipt = await sdk.recover(await effect());

    expect(receipt.outcome).toBe("failure");
    expect(receipt.residualMeasurements?.recovered_row_count?.value).toBe("0");
    expect(receipt.residualMeasurements?.rows_deleted?.value).toBe("2");
  });

  it("returns success with zero work when there are no snapshot rows", async () => {
    const client = new MockClient([]);
    const sdk = compensatorWith({
      client,
      snapshotRows: [],
      expectedRecoveredRows: 0,
    });
    const receipt = await sdk.recover(await effect());
    expect(receipt.outcome).toBe("success");
    expect(client.calls).toHaveLength(0);
  });

  it("rejects invalid identifiers at construction", () => {
    const client = new MockClient([]);
    expect(() =>
      compensatorWith({
        client,
        tableName: 'tenant_rows"; DROP TABLE x;--',
        snapshotRows: [],
        expectedRecoveredRows: 0,
      }),
    ).toThrow(PgCompensatorError);
    expect(() =>
      compensatorWith({
        client,
        primaryKey: "bad col",
        snapshotRows: [],
        expectedRecoveredRows: 0,
      }),
    ).toThrow(PgCompensatorError);
  });

  it("throws when a snapshot row is missing the primary key column", async () => {
    const client = new MockClient([]);
    const sdk = compensatorWith({
      client,
      snapshotRows: [{ tenant_id: "tenant-a" }],
      expectedRecoveredRows: 1,
    });
    await expect(sdk.recover(await effect())).rejects.toThrow(PgCompensatorError);
  });

  it("rejects column identifiers that fail the validation regex", async () => {
    const client = new MockClient([() => row([])]);
    const sdk = compensatorWith({
      client,
      snapshotRows: [{ id: 1, "bad col": "x" }],
      expectedRecoveredRows: 1,
    });
    await expect(sdk.recover(await effect())).rejects.toThrow(PgCompensatorError);
  });
});
