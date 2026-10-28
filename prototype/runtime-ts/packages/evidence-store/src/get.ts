import { readFile } from "node:fs/promises";
import type { Hex32 } from "../../receipts/src/types.gen.ts";
import { hashEvidence } from "./hash.ts";
import { evidencePath } from "./put.ts";

export class EvidenceHashMismatchError extends Error {
  constructor(expected: Hex32, actual: Hex32) {
    super(`evidence hash mismatch: expected ${expected}, got ${actual}`);
    this.name = "EvidenceHashMismatchError";
  }
}

export async function getEvidenceFile(rootDir: string, hash: Hex32): Promise<Uint8Array> {
  const bytes = await readFile(evidencePath(rootDir, hash));
  const actual = hashEvidence(bytes).hash;
  if (actual !== hash) {
    throw new EvidenceHashMismatchError(hash, actual);
  }
  return bytes;
}

export async function getEvidenceJson<T>(rootDir: string, hash: Hex32): Promise<T> {
  const bytes = await getEvidenceFile(rootDir, hash);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
