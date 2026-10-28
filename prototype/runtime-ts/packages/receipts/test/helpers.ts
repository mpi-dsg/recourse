import { privateKeyToAccount } from "viem/accounts";

export const adapterAccount = privateKeyToAccount(
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
);

export const compensatorAccount = privateKeyToAccount(
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
);

export const claimantAccount = privateKeyToAccount(
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
);
