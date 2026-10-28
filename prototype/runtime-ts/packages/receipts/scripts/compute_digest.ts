/**
 * One-shot script: compute the canonical EIP-712 digests for the fixture in
 * `prototype/schemas/eip712_fixture.json` and print them. Used by the parity
 * tests to lock in expected digests after any schema change.
 *
 * Usage: bun run packages/receipts/scripts/compute_digest.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hashClaim, hashEffectReceipt, hashRecoveryReceipt, hashRecourseContract } from "../src/eip712.ts";
import type { Claim, EffectReceipt, RecoveryReceipt, RecourseContract } from "../src/types.gen.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../../../../schemas/eip712_fixture.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
  domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` };
  receipt: Omit<EffectReceipt, "signature">;
  recoveryReceipt: Omit<RecoveryReceipt, "signature">;
  claim: Omit<Claim, "signature">;
  contract: RecourseContract;
};

const domain = { chainId: fixture.domain.chainId, verifyingContract: fixture.domain.verifyingContract };
const digest = hashEffectReceipt({
  domain,
  receipt: fixture.receipt,
});

process.stdout.write(
  JSON.stringify(
    {
      expectedDigest: digest,
      expectedRecoveryDigest: hashRecoveryReceipt({ domain, receipt: fixture.recoveryReceipt }),
      expectedClaimDigest: hashClaim({ domain, claim: fixture.claim }),
      expectedContractId: hashRecourseContract(fixture.contract),
    },
    null,
    2,
  ) + "\n",
);
