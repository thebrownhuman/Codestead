# Mail Delivery Live Race Matrix — Authoritative Errata

This addendum is part of
`docs/superpowers/plans/2026-07-26-mail-delivery-live-race-matrix.md` and
supersedes the two points below. It exists because the Windows patch helper
could create the plan but could not reopen any newly created file during the
same session.

## 1. Exact provider recorder tuple

The provider recorder must not use the illustrative
`resolved-from-issued-test-envelope` strings. Use an explicit expected tuple
constructed from the module-issued committed receipt and claim fence:

```ts
export type ExpectedProviderCall = Readonly<{
  operationId: string;
  messageId: string;
  requestSha256: string;
}>;

export class RecordingGmailTransport {
  readonly entered = deferred();
  readonly release = deferred();
  readonly calls: RecordedProviderCall[] = [];

  constructor(
    private readonly expected: ExpectedProviderCall,
    private readonly outcome:
      | { kind: "accepted"; providerMessageId: string }
      | { kind: "definitely-rejected"; code: string }
      | { kind: "ambiguous"; code: string },
  ) {}

  fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    if (target === "https://oauth2.googleapis.com/token") {
      return new Response('{"access_token":"fixture-access"}', { status: 200 });
    }
    if (target !== "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
      throw new Error("Unexpected provider endpoint.");
    }
    const bytes = Buffer.from(String(init?.body ?? ""), "utf8");
    const requestSha256 = createHash("sha256").update(bytes).digest("hex");
    if (requestSha256 !== this.expected.requestSha256) {
      throw new Error("Provider request bytes do not match the committed dispatch.");
    }
    this.calls.push(Object.freeze({
      operationId: this.expected.operationId,
      messageId: this.expected.messageId,
      requestSha256,
      requestLength: bytes.length,
    }));
    this.entered.resolve();
    await this.release.promise;
    if (this.outcome.kind === "accepted") {
      return new Response(
        JSON.stringify({ id: this.outcome.providerMessageId }),
        { status: 200 },
      );
    }
    if (this.outcome.kind === "definitely-rejected") {
      return new Response(
        JSON.stringify({ error: { code: 400, status: this.outcome.code } }),
        { status: 400 },
      );
    }
    throw new TypeError(this.outcome.code);
  };
}
```

Export and consume one exact executable inventory:

```ts
export const MAIL_DELIVERY_RACE_CASE_IDS = Object.freeze([
  "CLAIM-01", "CLAIM-02", "CLAIM-03", "CLAIM-04", "CLAIM-05", "CLAIM-06",
  "TX1-01", "TX1-02", "TX1-03",
  "TX2-01", "TX2-02", "TX2-03", "TX2-04", "TX2-05", "TX2-06", "TX2-07",
  "SWEEP-01", "SWEEP-02", "SWEEP-03", "SWEEP-04",
  "DEL-01", "DEL-02", "DEL-03", "DEL-04", "DEL-05", "DEL-06", "DEL-07", "DEL-08",
  "RET-01", "RET-02", "CAP-01",
] as const);
```

The registration test must consume this array and prove every ID occurs
exactly once in the executable suite and evidence schema.

## 2. Git identity width

The current repository uses 40-hex Git object IDs. The evidence schema must
require exactly 40 lowercase hexadecimal characters for `commit` and `tree`,
not 64. OCI image digests and SHA-256 evidence fields remain 64 hex.

The final Task 6 command is:

```powershell
npm.cmd run test:mail-retention-redaction-0068:registration
```

Task 8 must register that exact command before Task 9 execution.
