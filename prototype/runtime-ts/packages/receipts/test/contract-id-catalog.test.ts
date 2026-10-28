import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashEffectReceipt,
  hashRecoveryReceipt,
  hashRecourseContract,
} from "../src/eip712.ts";
import type {
  Claim,
  EffectReceipt,
  Hex20,
  RecoveryReceipt,
  RecourseContract,
} from "../src/types.gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const prototypeDir = resolve(here, "../../../..");
const contractFiles = [
  "schemas/eip712_fixture.json",
  "schemas/examples/postgres.contract.json",
  "schemas/examples/git.contract.json",
  "schemas/examples/cloud.contract.json",
  "fixtures/k-contracts/k-cloud-rds-snapshot.json",
  "fixtures/k-contracts/k-cloud-ssm.json",
  "fixtures/k-contracts/k-git-pushforce.json",
  "fixtures/k-contracts/k-postgres-ddl.json",
  "fixtures/k-contracts/k-postgres-update.json",
];

describe("canonical contract-id catalog", () => {
  for (const relativePath of contractFiles) {
    it(`${relativePath} declares its shipped registry hash`, () => {
      const document = JSON.parse(
        readFileSync(resolve(prototypeDir, relativePath), "utf8"),
      ) as RecourseContract | { contract: RecourseContract };
      const contract = "contract" in document ? document.contract : document;

      expect(contract.contractId).toBe(hashRecourseContract(contract));
    });
  }

  it("the parity receipts and claim reference the canonical fixture contract", () => {
    const fixture = JSON.parse(
      readFileSync(resolve(prototypeDir, "schemas/eip712_fixture.json"), "utf8"),
    ) as {
      receipt: Omit<EffectReceipt, "signature">;
      recoveryReceipt: Omit<RecoveryReceipt, "signature">;
      claim: Omit<Claim, "signature">;
      contract: RecourseContract;
    };

    expect(fixture.receipt.contractId).toBe(fixture.contract.contractId);
    expect(fixture.recoveryReceipt.contractId).toBe(fixture.contract.contractId);
    expect(fixture.claim.contractId).toBe(fixture.contract.contractId);
  });

  it("the postgres example receipt chain contains canonical digest bindings", () => {
    const domain = {
      chainId: 84532,
      verifyingContract:
        "0x0000000000000000000000000000000000000000" as Hex20,
    };
    const effect = JSON.parse(
      readFileSync(
        resolve(prototypeDir, "schemas/examples/postgres.effect_receipt.json"),
        "utf8",
      ),
    ) as EffectReceipt;
    const recovery = JSON.parse(
      readFileSync(
        resolve(prototypeDir, "schemas/examples/postgres.recovery_receipt.json"),
        "utf8",
      ),
    ) as RecoveryReceipt;
    const claim = JSON.parse(
      readFileSync(
        resolve(prototypeDir, "schemas/examples/postgres.claim.json"),
        "utf8",
      ),
    ) as Claim;
    const { signature: _effectSignature, ...unsignedEffect } = effect;
    const { signature: _recoverySignature, ...unsignedRecovery } = recovery;
    const effectHash = hashEffectReceipt({ domain, receipt: unsignedEffect });
    const recoveryHash = hashRecoveryReceipt({
      domain,
      receipt: unsignedRecovery,
    });

    expect(recovery.effectReceiptHash).toBe(effectHash);
    expect(claim.effectReceiptHash).toBe(effectHash);
    expect(claim.recoveryReceiptHash).toBe(recoveryHash);
  });
});
