# Recourse schema versions

The on-chain tier, the TypeScript runtime, and the Python classifier all hash and validate
against the schemas listed below. Every change here is breaking and forces matching changes
in `prototype/contracts/src/Types.sol`, `prototype/runtime-ts/packages/receipts/src/types.gen.ts`,
and the Python schema/predicate tests under `prototype/classifier/tests/`.

| Object | File | Version | Pinned |
|--------|------|---------|--------|
| `RecourseContract` (κ) | `schemas/recourse_contract.v1.json` | 1 | 2026-05-10 |
| `EffectReceipt` | `schemas/effect_receipt.v1.json` | 1 | 2026-05-10 |
| `RecoveryReceipt` | `schemas/recovery_receipt.v1.json` | 1 | 2026-05-10 |
| `Claim` | `schemas/claim.v1.json` | 1 | 2026-05-10 |

## EIP-712 domain

```
{
  name:             "Recourse",
  version:          "1",
  chainId:          <chain id>,
  verifyingContract:<ClaimRegistry address>
}
```

The `version` field of the EIP-712 domain tracks the **schema** version, not a contract
upgrade. Contract upgrades that preserve schema must keep `version = "1"` so prior receipts
remain verifiable.

## Cross-language parity

A parity test checks this: a known fixture in TypeScript
computes `_hashTypedDataV4(EffectReceipt)`; the Foundry test computes the same digest from
the same struct; they must equal byte-for-byte. **Every schema change must reset that
parity test before any other receipt code is touched.**

## Versioning policy

- A schema version is bumped only when a breaking field change lands. Adding optional fields
  is breaking under EIP-712 because the typehash changes; therefore field additions also bump
  the version.
- Each receipt and contract carries its own `schemaVersion`. The `ClaimRegistry` rejects
  receipts whose `schemaVersion` does not match the registered contract's `schemaVersion`.
- Old receipts remain verifiable forever; old contracts remain admissible until revoked.
  The chain never rewrites prior receipts on upgrade.
