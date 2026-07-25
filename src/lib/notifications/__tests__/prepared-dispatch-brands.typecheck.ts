import {
  issueMaterializedGmailPreparation,
} from "../prepared-dispatch";
import type {
  AuthoritativeOutgoingEmail,
  CompatibilityMailDispatchAuthority,
  CompatibilitySourceAuthoritySha256,
  MailDispatchAuthority,
  MailPreparationContext,
  SourceAuthoritySha256,
} from "../prepared-dispatch";

declare const canonicalDigest: SourceAuthoritySha256;
declare const compatibilityDigest: CompatibilitySourceAuthoritySha256;
declare const canonicalAuthority: MailDispatchAuthority;
declare const compatibilityAuthority: CompatibilityMailDispatchAuthority;

// @ts-expect-error Compatibility authority is not canonical persisted-source authority.
const canonicalFromCompatibility: SourceAuthoritySha256 = compatibilityDigest;
// @ts-expect-error Canonical persisted-source authority is not compatibility authority.
const compatibilityFromCanonical: CompatibilitySourceAuthoritySha256 = canonicalDigest;
// @ts-expect-error Compatibility authority objects cannot masquerade as canonical authority.
const canonicalAuthorityFromCompatibility: MailDispatchAuthority = compatibilityAuthority;
// @ts-expect-error Canonical authority objects cannot masquerade as compatibility authority.
const compatibilityAuthorityFromCanonical: CompatibilityMailDispatchAuthority = canonicalAuthority;

void canonicalFromCompatibility;
void compatibilityFromCanonical;
void canonicalAuthorityFromCompatibility;
void compatibilityAuthorityFromCanonical;

const publicGmailContext: MailPreparationContext = {
  adapter: "gmail",
  from: "mail@example.test",
  messageId: "opaque-message-id",
  authority: canonicalAuthority,
  // @ts-expect-error Raw evidence tokens are not accepted by the public context.
  dispatchEvidenceToken: "A".repeat(43),
};

void publicGmailContext;
declare const outgoing: AuthoritativeOutgoingEmail;
declare const trustedGmailContext:
  MailPreparationContext & Readonly<{ adapter: "gmail" }>;

issueMaterializedGmailPreparation(
  outgoing,
  trustedGmailContext,
  // @ts-expect-error Raw evidence tokens cannot be injected into materialization.
  "A".repeat(43),
);
