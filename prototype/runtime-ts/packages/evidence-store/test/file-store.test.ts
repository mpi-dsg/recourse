import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  EvidenceHashMismatchError,
  ExistingEvidenceMismatchError,
  FileEvidenceStore,
  InvalidEvidenceHashError,
  NonCanonicalEvidenceError,
  canonicalEvidenceBytes,
  hashEvidence,
} from "../src/index.ts";
import type { Hex32 } from "../../receipts/src/types.gen.ts";

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "recourse-evidence-"));
  tempDirs.push(dir);
  return dir;
}

describe("file-backed evidence store", () => {
  it("hashes canonical JSON independent of object key order", () => {
    const left = hashEvidence({ b: 2, a: 1 });
    const right = hashEvidence({ a: 1, b: 2 });

    expect(left.hash).toBe(right.hash);
    expect(new TextDecoder().decode(canonicalEvidenceBytes({ b: 2, a: 1 }))).toBe('{"a":1,"b":2}');
  });

  it("rejects non-json evidence payload values", () => {
    expect(() => hashEvidence({ missing: undefined })).toThrow(NonCanonicalEvidenceError);
    expect(() => hashEvidence({ bad: Number.NaN })).toThrow(NonCanonicalEvidenceError);
    expect(() => hashEvidence({ bad: Number.POSITIVE_INFINITY })).toThrow(NonCanonicalEvidenceError);
  });

  it("rejects malformed hashes before building file paths", async () => {
    const store = new FileEvidenceStore(await tempRoot());
    const malformed = "0x../../outside" as Hex32;

    expect(() => store.pathForHash(malformed)).toThrow(InvalidEvidenceHashError);
    await expect(store.get(malformed)).rejects.toThrow(InvalidEvidenceHashError);
  });

  it("stores and retrieves payloads by content hash", async () => {
    const store = new FileEvidenceStore(await tempRoot());
    const payload = { action: "delete", affectedRows: 2, table: "tenant_rows" };

    const ref = await store.put(payload);
    const loaded = await store.getJson<typeof payload>(ref.hash);

    expect(loaded).toEqual(payload);
    expect(ref.uri).toBe(`file://${store.pathForHash(ref.hash)}`);
  });

  it("detects file tampering on read", async () => {
    const store = new FileEvidenceStore(await tempRoot());
    const ref = await store.put({ ok: true });

    await writeFile(store.pathForHash(ref.hash), "tampered");

    await expect(store.get(ref.hash)).rejects.toThrow(EvidenceHashMismatchError);
    await expect(store.put({ ok: true })).rejects.toThrow(ExistingEvidenceMismatchError);
  });
});
