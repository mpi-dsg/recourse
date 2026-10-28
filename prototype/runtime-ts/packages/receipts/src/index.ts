export const SCHEMA_VERSION = 1 as const;

export const RECEIPTS_PACKAGE = "@recourse/receipts" as const;

export * from "./types.gen.ts";
export * from "./eip712.ts";
export * from "./sign.ts";
export * from "./verify.ts";
