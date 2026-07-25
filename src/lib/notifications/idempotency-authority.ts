import { createHash } from "node:crypto";

import type { EmailTemplate } from "./template-authority-policy";

export const MAIL_IDEMPOTENCY_AUTHORITY_VERSION = "event-v1" as const;

const AUTHORITY_DOMAIN = "mail-event-v1";
const AUTHORITY_SEPARATOR = "\u001f";
const FORBIDDEN_AUTHORITY_INPUT = /[\u0000-\u001f\u007f]/u;

function authorityPart(value: string, label: string) {
  if (
    value.length === 0
    || value.trim() !== value
    || FORBIDDEN_AUTHORITY_INPUT.test(value)
  ) {
    throw new Error(`Mail ${label} must be nonblank canonical text.`);
  }
  return value;
}

export function accountMailEventIdempotencyKey(input: Readonly<{
  eventId: string;
  template: EmailTemplate;
  userId: string;
}>) {
  const authorityScope = `a:${authorityPart(input.userId, "account scope")}`;
  return createHash("sha256")
    .update([
      AUTHORITY_DOMAIN,
      authorityPart(input.template, "template"),
      authorityScope,
      authorityPart(input.eventId, "event identity"),
    ].join(AUTHORITY_SEPARATOR))
    .digest("hex");
}

export function systemMailEventIdempotencyKey(input: Readonly<{
  eventId: string;
  producer: string;
  audienceId: string;
  sourceId: string;
  template: EmailTemplate;
}>) {
  const authorityScope = [
    "s",
    authorityPart(input.producer, "system producer"),
    authorityPart(input.sourceId, "system source"),
    authorityPart(input.audienceId, "system audience"),
  ].join(":");
  return createHash("sha256")
    .update([
      AUTHORITY_DOMAIN,
      authorityPart(input.template, "template"),
      authorityScope,
      authorityPart(input.eventId, "event identity"),
    ].join(AUTHORITY_SEPARATOR))
    .digest("hex");
}

export function verificationEmailSourceEventId(token: string) {
  return createHash("sha256")
    .update([
      "verify-email-source-v1",
      authorityPart(token, "verification token"),
    ].join(AUTHORITY_SEPARATOR))
    .digest("hex");
}
