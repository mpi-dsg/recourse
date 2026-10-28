import { getAddress } from "viem";
import {
  claimTypedData,
  effectReceiptTypedData,
  recoveryReceiptTypedData,
  type RecourseDomainArgs,
} from "./eip712.ts";
import { SCHEMA_VERSION_TYPES, type Claim, type EffectReceipt, type Hex20, type HexSig, type RecoveryReceipt } from "./types.gen.ts";

export interface RecourseTypedDataSigner {
  address: Hex20;
  signTypedData(typedData: unknown): Promise<HexSig>;
}

export interface SignEffectReceiptArgs {
  domain: RecourseDomainArgs;
  receipt: Omit<EffectReceipt, "signature">;
  signer: RecourseTypedDataSigner;
}

export interface SignRecoveryReceiptArgs {
  domain: RecourseDomainArgs;
  receipt: Omit<RecoveryReceipt, "signature">;
  signer: RecourseTypedDataSigner;
}

export interface SignClaimArgs {
  domain: RecourseDomainArgs;
  claim: Omit<Claim, "signature">;
  signer: RecourseTypedDataSigner;
}

export class SignerAddressMismatchError extends Error {
  constructor(role: string, expected: Hex20, actual: Hex20) {
    super(`${role} address ${expected} does not match signer ${actual}`);
    this.name = "SignerAddressMismatchError";
  }
}

export class UnsupportedSchemaVersionError extends Error {
  constructor(actual: number) {
    super(`unsupported schemaVersion ${actual}; expected ${SCHEMA_VERSION_TYPES}`);
    this.name = "UnsupportedSchemaVersionError";
  }
}

export async function signEffectReceipt(args: SignEffectReceiptArgs): Promise<EffectReceipt> {
  assertSchemaVersion(args.receipt.schemaVersion);
  assertSignerAddress("adapter", args.receipt.adapterAddress, args.signer.address);
  const signature = await args.signer.signTypedData(effectReceiptTypedData(args));
  return { ...args.receipt, signature };
}

export async function signRecoveryReceipt(args: SignRecoveryReceiptArgs): Promise<RecoveryReceipt> {
  assertSchemaVersion(args.receipt.schemaVersion);
  assertSignerAddress("compensator", args.receipt.compensatorAddress, args.signer.address);
  const signature = await args.signer.signTypedData(recoveryReceiptTypedData(args));
  return { ...args.receipt, signature };
}

export async function signClaim(args: SignClaimArgs): Promise<Claim> {
  assertSchemaVersion(args.claim.schemaVersion);
  assertSignerAddress("claimant", args.claim.claimant, args.signer.address);
  const signature = await args.signer.signTypedData(claimTypedData(args));
  return { ...args.claim, signature };
}

function assertSchemaVersion(actual: number): void {
  if (actual !== SCHEMA_VERSION_TYPES) throw new UnsupportedSchemaVersionError(actual);
}

function assertSignerAddress(role: string, expected: Hex20, actual: Hex20): void {
  if (getAddress(expected) !== getAddress(actual)) {
    throw new SignerAddressMismatchError(role, expected, actual);
  }
}
