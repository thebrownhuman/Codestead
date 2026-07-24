import { describe, expect, it } from "vitest";

import { assertGmailReconciliationOAuthScopes } from "../gmail-oauth-scopes";

const SEND = "https://www.googleapis.com/auth/gmail.send";
const METADATA = "https://www.googleapis.com/auth/gmail.metadata";

describe("Gmail reconciliation OAuth scope contract", () => {
  it.each([
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://mail.google.com/",
    `${SEND} https://www.googleapis.com/auth/gmail.readonly`,
    `${SEND},https://www.googleapis.com/auth/gmail.readonly`,
  ])("accepts a search-compatible scope declaration", (scopes) => {
    expect(() => assertGmailReconciliationOAuthScopes(scopes)).not.toThrow();
  });

  it.each([
    undefined,
    "",
    SEND,
    METADATA,
    `${SEND} ${METADATA}`,
    "not-a-scope-secret-marker",
  ])("rejects a missing or incompatible declaration without echoing it", (scopes) => {
    let error: unknown;
    try {
      assertGmailReconciliationOAuthScopes(scopes);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("GMAIL_OAUTH_SCOPES");
    if (scopes) expect((error as Error).message).not.toContain(scopes);
  });
});
