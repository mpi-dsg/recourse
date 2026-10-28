import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Hex32 } from "../../receipts/src/types.gen.ts";
import { type EvidencePayload, hashEvidence } from "./hash.ts";

export interface EvidenceRef {
  hash: Hex32;
  uri: string;
  size: number;
}

export class InvalidEvidenceHashError extends Error {
  constructor(hash: string) {
    super(`invalid evidence hash: ${hash}`);
    this.name = "InvalidEvidenceHashError";
  }
}

export class ExistingEvidenceMismatchError extends Error {
  constructor(hash: Hex32) {
    super(`existing evidence content does not match hash: ${hash}`);
    this.name = "ExistingEvidenceMismatchError";
  }
}

export async function putEvidenceFile(rootDir: string, payload: EvidencePayload): Promise<EvidenceRef> {
  const { hash, bytes } = hashEvidence(payload);
  const path = evidencePath(rootDir, hash);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
    const existing = await readFile(path);
    if (hashEvidence(existing).hash !== hash) {
      throw new ExistingEvidenceMismatchError(hash);
    }
  }
  return { hash, uri: `file://${path}`, size: bytes.byteLength };
}

export function evidencePath(rootDir: string, hash: Hex32): string {
  assertEvidenceHash(hash);
  const digest = hash.slice(2);
  return join(rootDir, digest.slice(0, 2), digest);
}

export function assertEvidenceHash(hash: Hex32): void {
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    throw new InvalidEvidenceHashError(hash);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
