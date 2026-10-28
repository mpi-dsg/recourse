import { getAddress, recoverTypedDataAddress } from "viem";
import {
  claimTypedData,
  effectReceiptTypedData,
  recoveryReceiptTypedData,
  type RecourseDomainArgs,
} from "./eip712.ts";
import { SCHEMA_VERSION_TYPES, type Claim, type EffectReceipt, type Hex20, type RecoveryReceipt } from "./types.gen.ts";

export interface VerifyEffectReceiptArgs {
  domain: RecourseDomainArgs;
  receipt: EffectReceipt;
}

export interface VerifyRecoveryReceiptArgs {
  domain: RecourseDomainArgs;
  receipt: RecoveryReceipt;
}

export interface VerifyClaimArgs {
  domain: RecourseDomainArgs;
  claim: Claim;
}

export async function recoverEffectReceiptSigner(args: VerifyEffectReceiptArgs): Promise<Hex20> {
  const { signature: _signature, ...receipt } = args.receipt;
  const recovered = await recoverTypedDataAddress({
    ...effectReceiptTypedData({ domain: args.domain, receipt }),
    signature: args.receipt.signature,
  });
  return getAddress(recovered) as Hex20;
}

export async function recoverRecoveryReceiptSigner(args: VerifyRecoveryReceiptArgs): Promise<Hex20> {
  const { signature: _signature, ...receipt } = args.receipt;
  const recovered = await recoverTypedDataAddress({
    ...recoveryReceiptTypedData({ domain: args.domain, receipt }),
    signature: args.receipt.signature,
  });
  return getAddress(recovered) as Hex20;
}

export async function recoverClaimSigner(args: VerifyClaimArgs): Promise<Hex20> {
  const { signature: _signature, ...claim } = args.claim;
  const recovered = await recoverTypedDataAddress({
    ...claimTypedData({ domain: args.domain, claim }),
    signature: args.claim.signature,
  });
  return getAddress(recovered) as Hex20;
}

export async function verifyEffectReceipt(args: VerifyEffectReceiptArgs): Promise<boolean> {
  if (!schemaVersionSupported(args.receipt.schemaVersion)) return false;
  return verifyRoleAddress(() => recoverEffectReceiptSigner(args), args.receipt.adapterAddress);
}

export async function verifyRecoveryReceipt(args: VerifyRecoveryReceiptArgs): Promise<boolean> {
  if (!schemaVersionSupported(args.receipt.schemaVersion)) return false;
  return verifyRoleAddress(() => recoverRecoveryReceiptSigner(args), args.receipt.compensatorAddress);
}

export async function verifyClaim(args: VerifyClaimArgs): Promise<boolean> {
  if (!schemaVersionSupported(args.claim.schemaVersion)) return false;
  return verifyRoleAddress(() => recoverClaimSigner(args), args.claim.claimant);
}

function schemaVersionSupported(actual: number): boolean {
  return actual === SCHEMA_VERSION_TYPES;
}

async function verifyRoleAddress(recover: () => Promise<Hex20>, expected: Hex20): Promise<boolean> {
  try {
    return getAddress(await recover()) === getAddress(expected);
  } catch {
    return false;
  }
}
