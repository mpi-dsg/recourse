import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "viem";
import {
  canonicalJson,
  effectReceiptTypedData,
  hashClaim,
  hashEffectReceipt,
  hashRecoveryReceipt,
  signClaim,
  signEffectReceipt,
  signRecoveryReceipt,
  UnsupportedSchemaVersionError,
  UnsafeIntegerError,
  verifyClaim,
  verifyEffectReceipt,
  verifyRecoveryReceipt,
  type Claim,
  type EffectReceipt,
  type Hex20,
  type Hex32,
  type RecoveryReceipt,
  type RecourseContract,
} from "../src/index.ts";
import { adapterAccount as adapter, claimantAccount as claimant, compensatorAccount as compensator } from "./helpers.ts";

const ZERO32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex32;
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../../../../schemas/eip712_fixture.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  domain: { chainId: number; verifyingContract: Hex20 };
  receipt: Omit<EffectReceipt, "signature">;
  expectedDigest: Hex32;
  recoveryReceipt: Omit<RecoveryReceipt, "signature">;
  expectedRecoveryDigest: Hex32;
  claim: Omit<Claim, "signature">;
  expectedClaimDigest: Hex32;
  contract: RecourseContract;
  expectedContractId: Hex32;
};

const domain = {
  chainId: fixture.domain.chainId,
  verifyingContract: fixture.domain.verifyingContract,
};

function unsignedEffect(): Omit<EffectReceipt, "signature"> {
  return {
    ...fixture.receipt,
    adapterAddress: adapter.address as Hex20,
  };
}

function unsignedRecovery(effectReceiptHash: Hex32): Omit<RecoveryReceipt, "signature"> {
  return {
    schemaVersion: 1,
    contractId: fixture.receipt.contractId,
    effectReceiptHash,
    compensatorAddress: compensator.address as Hex20,
    restoreArtifactHash: "0x1212000000000000000000000000000000000000000000000000000000000001",
    outcome: "success",
    residualMeasurements: {
      rows_deleted: {
        value: "0",
        evidenceSource: "snapshot-diff",
        artifactHash: "0x3434000000000000000000000000000000000000000000000000000000000001",
      },
    },
    recoveryStartTs: 1746979210,
    recoveryEndTs: 1746979240,
  };
}

function unsignedClaim(effectReceiptHash: Hex32, recoveryReceiptHash: Hex32): Omit<Claim, "signature"> {
  return {
    schemaVersion: 1,
    contractId: fixture.receipt.contractId,
    jobId: fixture.receipt.jobId,
    claimant: claimant.address as Hex20,
    amount: "640000000",
    evidenceCid: "QmRecoursePostgresClaim00000000000000000000001",
    effectReceiptHash,
    recoveryReceiptHash,
    routeHint: "optimistic",
  };
}

describe("receipt signing and verification", () => {
  it("rejects non-json canonical payload values", () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow();
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow();
    expect(() => canonicalJson({ bad: Number.POSITIVE_INFINITY })).toThrow();
  });

  it("rejects unsafe uint64 timestamp numbers before signing", () => {
    expect(() =>
      effectReceiptTypedData({
        domain,
        receipt: { ...unsignedEffect(), timestamp: Number.MAX_SAFE_INTEGER + 1 },
      }),
    ).toThrow(UnsafeIntegerError);
  });

  it("signs and recovers adapter address", async () => {
    const signed = await signEffectReceipt({ domain, receipt: unsignedEffect(), signer: adapter });

    expect(signed.signature.length).toBe(132);
    await expect(verifyEffectReceipt({ domain, receipt: signed })).resolves.toBe(true);
    expect(getAddress(signed.adapterAddress)).toBe(getAddress(adapter.address));
  });

  it("tamper with one field invalidates signature", async () => {
    const signed = await signEffectReceipt({ domain, receipt: unsignedEffect(), signer: adapter });
    const tampered: EffectReceipt = { ...signed, timestamp: signed.timestamp + 1 };

    await expect(verifyEffectReceipt({ domain, receipt: tampered })).resolves.toBe(false);
  });

  it("digest matches the Foundry digest", () => {
    const digest = hashEffectReceipt({ domain, receipt: fixture.receipt });

    expect(digest).toBe(fixture.expectedDigest);
    expect(digest).not.toBe(ZERO32);
  });

  it("rejects unsupported schema versions before signing", async () => {
    await expect(
      signEffectReceipt({
        domain,
        receipt: { ...unsignedEffect(), schemaVersion: 2 } as unknown as Omit<EffectReceipt, "signature">,
        signer: adapter,
      }),
    ).rejects.toThrow(UnsupportedSchemaVersionError);

    const effectHash = hashEffectReceipt({ domain, receipt: unsignedEffect() });
    await expect(
      signRecoveryReceipt({
        domain,
        receipt: {
          ...unsignedRecovery(effectHash),
          schemaVersion: 2,
        } as unknown as Omit<RecoveryReceipt, "signature">,
        signer: compensator,
      }),
    ).rejects.toThrow(UnsupportedSchemaVersionError);

    const recoveryHash = hashRecoveryReceipt({ domain, receipt: unsignedRecovery(effectHash) });
    await expect(
      signClaim({
        domain,
        claim: {
          ...unsignedClaim(effectHash, recoveryHash),
          schemaVersion: 2,
        } as unknown as Omit<Claim, "signature">,
        signer: claimant,
      }),
    ).rejects.toThrow(UnsupportedSchemaVersionError);
  });

  it("does not verify receipts from unsupported schema versions", async () => {
    const signedEffect = await signEffectReceipt({ domain, receipt: unsignedEffect(), signer: adapter });
    const unsupportedEffect = { ...signedEffect, schemaVersion: 2 } as unknown as EffectReceipt;
    await expect(verifyEffectReceipt({ domain, receipt: unsupportedEffect })).resolves.toBe(false);

    const effectHash = hashEffectReceipt({ domain, receipt: unsignedEffect() });
    const signedRecovery = await signRecoveryReceipt({
      domain,
      receipt: unsignedRecovery(effectHash),
      signer: compensator,
    });
    const unsupportedRecovery = { ...signedRecovery, schemaVersion: 2 } as unknown as RecoveryReceipt;
    await expect(verifyRecoveryReceipt({ domain, receipt: unsupportedRecovery })).resolves.toBe(false);

    const recoveryHash = hashRecoveryReceipt({ domain, receipt: unsignedRecovery(effectHash) });
    const signedClaim = await signClaim({
      domain,
      claim: unsignedClaim(effectHash, recoveryHash),
      signer: claimant,
    });
    const unsupportedClaim = { ...signedClaim, schemaVersion: 2 } as unknown as Claim;
    await expect(verifyClaim({ domain, claim: unsupportedClaim })).resolves.toBe(false);
  });

  it("signs and verifies recovery receipts over residual measurement hashes", async () => {
    const effectHash = hashEffectReceipt({ domain, receipt: unsignedEffect() });
    const signed = await signRecoveryReceipt({
      domain,
      receipt: unsignedRecovery(effectHash),
      signer: compensator,
    });

    await expect(verifyRecoveryReceipt({ domain, receipt: signed })).resolves.toBe(true);

    const tampered: RecoveryReceipt = {
      ...signed,
      residualMeasurements: {
        rows_deleted: { value: "1", evidenceSource: "snapshot-diff" },
      },
    };
    await expect(verifyRecoveryReceipt({ domain, receipt: tampered })).resolves.toBe(false);
  });

  it("signs and verifies claims over evidence CIDs", async () => {
    const effectHash = hashEffectReceipt({ domain, receipt: unsignedEffect() });
    const recoveryHash = hashRecoveryReceipt({ domain, receipt: unsignedRecovery(effectHash) });
    const signed = await signClaim({
      domain,
      claim: unsignedClaim(effectHash, recoveryHash),
      signer: claimant,
    });

    await expect(verifyClaim({ domain, claim: signed })).resolves.toBe(true);
    expect(hashClaim({ domain, claim: unsignedClaim(effectHash, recoveryHash) }).length).toBe(66);

    const tampered: Claim = { ...signed, evidenceCid: "QmDifferentEvidence" };
    await expect(verifyClaim({ domain, claim: tampered })).resolves.toBe(false);
  });
});
