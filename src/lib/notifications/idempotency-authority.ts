import { createHash } from "node:crypto";

import {
  SYSTEM_EMAIL_PRODUCERS,
  type EmailTemplate,
  type SystemEmailProducer,
} from "./template-authority-policy";

export const MAIL_IDEMPOTENCY_AUTHORITY_VERSION = "event-v1-native" as const;

const AUTHORITY_DOMAIN = "mail-event-v1";
const AUTHORITY_SEPARATOR = "\u001f";
const FORBIDDEN_AUTHORITY_INPUT = /[\u0000-\u001f\u007f]/u;
const CANONICAL_LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SYSTEM_EMAIL_PRODUCER_SET = new Set<string>(SYSTEM_EMAIL_PRODUCERS);

function canonicalSystemUuid(value: string, label: "source" | "audience") {
  if (!CANONICAL_LOWERCASE_UUID.test(value)) {
    throw new Error(
      `System ${label} ID must be a canonical lowercase UUID.`,
    );
  }
  return value;
}

function registeredSystemProducer(value: SystemEmailProducer) {
  if (!SYSTEM_EMAIL_PRODUCER_SET.has(value)) {
    throw new Error("System producer is not registered.");
  }
  return value;
}

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

function authorityKey(parts: readonly string[]) {
  return createHash("sha256")
    .update(parts.join(AUTHORITY_SEPARATOR))
    .digest("hex");
}

export function accountMailEventIdempotencyKey(input: Readonly<{
  eventId: string;
  template: EmailTemplate;
  userId: string;
}>) {
  return authorityKey([
    AUTHORITY_DOMAIN,
    authorityPart(input.template, "template"),
    `a:${authorityPart(input.userId, "account scope")}`,
    authorityPart(input.eventId, "event identity"),
  ]);
}

export function systemMailEventIdempotencyKey(input: Readonly<{
  audienceId: string;
  eventId: string;
  producer: SystemEmailProducer;
  sourceId: string;
  template: EmailTemplate;
}>) {
  const authorityScope = [
    "s",
    registeredSystemProducer(input.producer),
    canonicalSystemUuid(input.sourceId, "source"),
    canonicalSystemUuid(input.audienceId, "audience"),
  ].join(":");
  return authorityKey([
    AUTHORITY_DOMAIN,
    authorityPart(input.template, "template"),
    authorityScope,
    authorityPart(input.eventId, "event identity"),
  ]);
}

export function verificationEmailSourceEventId(token: string) {
  return authorityKey([
    "verify-email-source-v1",
    authorityPart(token, "verification token"),
  ]);
}
