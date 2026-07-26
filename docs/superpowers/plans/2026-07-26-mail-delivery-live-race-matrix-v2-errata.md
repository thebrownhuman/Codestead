# Mail Delivery Live Race Matrix V2 — Authoritative Errata

This addendum is part of
`docs/superpowers/plans/2026-07-26-mail-delivery-live-race-matrix-v2.md`.
Together, V2 and this addendum supersede both the original plan and its
original errata.

## Exact provider-attempt identity

The provider recorder tuple in V2 must include the exact module-issued
message identity as well as the operation and request digest:

```ts
export type ProviderAttemptEvidence = Readonly<{
  operationId: string;
  messageId: string;
  requestSha256: string;
  requestLength: number;
  startedAtCode: "provider_started";
  settledAs: "accepted" | "rejected" | "ambiguous" | "unsettled";
}>;
```

Construct the expected `(operationId, messageId, requestSha256)` tuple from
the committed TX1 receipt and claim fence. The recorder compares all three
before counting a provider attempt. It normalizes the actual `BodyInit` bytes
exactly as specified by V2; it must never call `String(body)`.

## Exact Task 6 dependency command

In Task 5, Step 7 of V2, replace:

```powershell
npm.cmd run test:mail-retention-redaction-0068
```

with the final registered command:

```powershell
npm.cmd run test:mail-retention-redaction-0068:registration
```

Task 8 must register that exact command before Task 9 execution.
