import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashClaim, hashEffectReceipt, hashRecoveryReceipt, hashRecourseContract } from "../src/eip712.ts";
import type { Claim, EffectReceipt, RecoveryReceipt, RecourseContract } from "../src/types.gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../../../../schemas/eip712_fixture.json");

interface Fixture {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  receipt: Omit<EffectReceipt, "signature">;
  expectedDigest: `0x${string}`;
  recoveryReceipt: Omit<RecoveryReceipt, "signature">;
  expectedRecoveryDigest: `0x${string}`;
  claim: Omit<Claim, "signature">;
  expectedClaimDigest: `0x${string}`;
  contract: RecourseContract;
  expectedContractId: `0x${string}`;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

describe("Recourse EIP-712 parity", () => {
  it("viem produces the locked-in digest from the fixture", () => {
    const d = hashEffectReceipt({
      domain: {
        chainId: fixture.domain.chainId,
        verifyingContract: fixture.domain.verifyingContract,
      },
      receipt: fixture.receipt,
    });
    expect(d).toBe(fixture.expectedDigest);
  });

  it("viem produces the locked-in recovery digest from the fixture", () => {
    const d = hashRecoveryReceipt({
      domain: {
        chainId: fixture.domain.chainId,
        verifyingContract: fixture.domain.verifyingContract,
      },
      receipt: fixture.recoveryReceipt,
    });
    expect(d).toBe(fixture.expectedRecoveryDigest);
  });

  it("viem produces the locked-in claim digest from the fixture", () => {
    const d = hashClaim({
      domain: {
        chainId: fixture.domain.chainId,
        verifyingContract: fixture.domain.verifyingContract,
      },
      claim: fixture.claim,
    });
    expect(d).toBe(fixture.expectedClaimDigest);
  });

  it("derives the locked-in registry contract id from canonical κ", () => {
    expect(hashRecourseContract(fixture.contract)).toBe(fixture.expectedContractId);
  });

  it("expected digest is not the placeholder", () => {
    expect(fixture.expectedDigest).not.toBe("PENDING");
    expect(fixture.expectedDigest.length).toBe(66);
    expect(fixture.expectedRecoveryDigest).not.toBe("PENDING");
    expect(fixture.expectedRecoveryDigest.length).toBe(66);
    expect(fixture.expectedClaimDigest).not.toBe("PENDING");
    expect(fixture.expectedClaimDigest.length).toBe(66);
    expect(fixture.expectedContractId).not.toBe("PENDING");
    expect(fixture.expectedContractId.length).toBe(66);
  });

  it("mutating the receipt changes the digest", () => {
    const tampered: Omit<EffectReceipt, "signature"> = {
      ...fixture.receipt,
      timestamp: fixture.receipt.timestamp + 1,
    };
    const d = hashEffectReceipt({
      domain: {
        chainId: fixture.domain.chainId,
        verifyingContract: fixture.domain.verifyingContract,
      },
      receipt: tampered,
    });
    expect(d).not.toBe(fixture.expectedDigest);
  });

  it("mutating the chainId changes the digest", () => {
    const d = hashEffectReceipt({
      domain: {
        chainId: fixture.domain.chainId + 1,
        verifyingContract: fixture.domain.verifyingContract,
      },
      receipt: fixture.receipt,
    });
    expect(d).not.toBe(fixture.expectedDigest);
  });

  it("mutating κ changes the registry contract id", () => {
    expect(
      hashRecourseContract({
        ...fixture.contract,
        deadlines: {
          ...fixture.contract.deadlines,
          livenessSeconds: fixture.contract.deadlines.livenessSeconds + 1,
        },
      }),
    ).not.toBe(fixture.expectedContractId);
  });
});
