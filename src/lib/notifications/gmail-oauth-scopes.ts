const GMAIL_READONLY_SCOPE =
  "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_MODIFY_SCOPE =
  "https://www.googleapis.com/auth/gmail.modify";
const GMAIL_FULL_MAIL_SCOPE = "https://mail.google.com/";

const RECONCILIATION_SCOPES = new Set([
  GMAIL_READONLY_SCOPE,
  GMAIL_MODIFY_SCOPE,
  GMAIL_FULL_MAIL_SCOPE,
]);

export function assertGmailReconciliationOAuthScopes(
  configuredScopes: string | undefined,
) {
  const scopes = (configuredScopes ?? "")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!scopes.some((scope) => RECONCILIATION_SCOPES.has(scope))) {
    throw new Error(
      "GMAIL_OAUTH_SCOPES must declare gmail.readonly, gmail.modify, or mail.google.com for Gmail reconciliation; gmail.send and gmail.metadata alone are insufficient.",
    );
  }
}
