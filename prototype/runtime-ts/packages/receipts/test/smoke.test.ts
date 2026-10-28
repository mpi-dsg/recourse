import { describe, it, expect } from "bun:test";
import { RECEIPTS_PACKAGE, SCHEMA_VERSION } from "../src/index.ts";

describe("receipts smoke", () => {
  it("exports the package name", () => {
    expect(RECEIPTS_PACKAGE).toBe("@recourse/receipts");
  });

  it("pins schema version 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });
});
