import type { Hex32 } from "../../receipts/src/types.gen.ts";
import { getEvidenceFile, getEvidenceJson } from "./get.ts";
import { type EvidencePayload } from "./hash.ts";
import { evidencePath, putEvidenceFile } from "./put.ts";

export class FileEvidenceStore {
  constructor(private readonly rootDir: string) {}

  async put(payload: EvidencePayload) {
    return putEvidenceFile(this.rootDir, payload);
  }

  async get(hash: Hex32): Promise<Uint8Array> {
    return getEvidenceFile(this.rootDir, hash);
  }

  async getJson<T>(hash: Hex32): Promise<T> {
    return getEvidenceJson<T>(this.rootDir, hash);
  }

  pathForHash(hash: Hex32): string {
    return evidencePath(this.rootDir, hash);
  }
}

export * from "./get.ts";
export * from "./hash.ts";
export * from "./put.ts";
