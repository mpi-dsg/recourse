import { createHash } from "node:crypto";
import type { Hex32 } from "../../receipts/src/types.gen.ts";

export type EvidencePayload = string | Uint8Array | Record<string, unknown> | unknown[];

export interface EvidenceHash {
  hash: Hex32;
  bytes: Uint8Array;
}

export class NonCanonicalEvidenceError extends Error {
  constructor(path: string, reason: string) {
    super(`non-canonical evidence payload at ${path}: ${reason}`);
    this.name = "NonCanonicalEvidenceError";
  }
}

export function canonicalEvidenceBytes(payload: EvidencePayload): Uint8Array {
  if (payload instanceof Uint8Array) {
    return payload;
  }
  if (typeof payload === "string") {
    return new TextEncoder().encode(payload);
  }
  assertJsonValue(payload, "$");
  return new TextEncoder().encode(JSON.stringify(sortCanonical(payload)));
}

export function hashEvidence(payload: EvidencePayload): EvidenceHash {
  const bytes = canonicalEvidenceBytes(payload);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return { hash: `0x${digest}` as Hex32, bytes };
}

function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortCanonical);
  }
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    const input = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      sorted[key] = sortCanonical(input[key]);
    }
    return sorted;
  }
  return value;
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null) return;

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new NonCanonicalEvidenceError(path, "number must be finite");
      }
      return;
    case "object":
      if (Array.isArray(value)) {
        value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
        return;
      }
      if (value instanceof Uint8Array) {
        throw new NonCanonicalEvidenceError(path, "binary data is only supported as the top-level payload");
      }
      if (!isPlainObject(value)) {
        throw new NonCanonicalEvidenceError(path, "object must be a plain JSON object");
      }
      for (const [key, item] of Object.entries(value)) {
        assertJsonValue(item, `${path}.${key}`);
      }
      return;
    default:
      throw new NonCanonicalEvidenceError(path, `${typeof value} is not valid JSON`);
  }
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
