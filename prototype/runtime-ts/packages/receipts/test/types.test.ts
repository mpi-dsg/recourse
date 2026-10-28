import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Claim, EffectReceipt, RecourseContract, RecoveryReceipt } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const examplesDir = resolve(here, "../../../../schemas/examples");

function loadExample<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(examplesDir, name), "utf8")) as T;
}

describe("types.gen — example round-trip", () => {
  it("parses the postgres recourse contract example", () => {
    const k = loadExample<RecourseContract>("postgres.contract.json");
    expect(k.schemaVersion).toBe(1);
    expect(k.actionTemplate.tool).toBe("postgres");
    expect(k.effectClass).toBe("compensable");
    expect(k.deadlines.livenessSeconds).toBeGreaterThan(0);
  });

  it("parses the postgres effect receipt example", () => {
    const e = loadExample<EffectReceipt>("postgres.effect_receipt.json");
    expect(e.schemaVersion).toBe(1);
    expect(e.signature.length).toBe(132); // 0x + 130 hex
  });

  it("parses the postgres recovery receipt example", () => {
    const r = loadExample<RecoveryReceipt>("postgres.recovery_receipt.json");
    expect(r.outcome).toBe("success");
    expect(r.residualMeasurements["rows_deleted"]?.evidenceSource).toBe("snapshot-diff");
  });

  it("parses the postgres claim example", () => {
    const c = loadExample<Claim>("postgres.claim.json");
    expect(c.routeHint).toBe("optimistic");
  });
});
