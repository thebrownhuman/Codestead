import { createHash } from "node:crypto";

import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db/client";
import { consentRecord } from "@/lib/db/schema";

export const ENROLLMENT_DISCLOSURE_VERSION = "enrollment-disclosure-2026-07-12.v2";

export const REQUIRED_DISCLOSURE_PURPOSES = [
  "adult_18_plus",
  "mentor_visibility",
  "external_ai_routing",
  "server_code_execution",
  "retention_policy",
  "inactivity_mentor_notice",
] as const;

export const OPTIONAL_CONSENT_PURPOSES = [
  "cohort_profile",
  "leaderboard",
  "admin_fallback_ai",
  "provider:nvidia_nim",
  "provider:openrouter",
  "provider:google",
  "provider:openai",
  "provider:anthropic",
  "provider:deepseek",
  "provider:custom_openai_compatible",
] as const;

export type RequiredDisclosurePurpose = typeof REQUIRED_DISCLOSURE_PURPOSES[number];
export type OptionalConsentPurpose = typeof OPTIONAL_CONSENT_PURPOSES[number];
export type ConsentPurpose = RequiredDisclosurePurpose | OptionalConsentPurpose;
export type ConsentDecision = "accepted" | "withdrawn";

const providerPurpose = new Set<string>(
  OPTIONAL_CONSENT_PURPOSES.filter((purpose) => purpose.startsWith("provider:")),
);

export const ENROLLMENT_DISCLOSURES = [
  {
    purpose: "adult_18_plus",
    title: "Adult-only pilot",
    summary: "I confirm I am at least 18 years old. The app does not request a date of birth.",
  },
  {
    purpose: "mentor_visibility",
    title: "Administrator mentor visibility",
    summary: "The administrator can inspect learning progress, attempts, projects, tutor history, and operational records to mentor and support me. Deliberate sensitive reads are audited.",
  },
  {
    purpose: "external_ai_routing",
    title: "External AI providers",
    summary: "Tutor prompts may send a bounded lesson context, preferences, relevant messages, and code I choose to discuss to my selected provider. Email, keys, hidden tests, and other learners are excluded.",
  },
  {
    purpose: "server_code_execution",
    title: "Server code execution",
    summary: "Submitted code and standard input run in isolated, network-disabled containers on the learning server. Formal hidden tests remain private.",
  },
  {
    purpose: "retention_policy",
    title: "Retention and backups",
    summary: "Learning/mastery records remain until account deletion; raw chat, code, and AI-request metadata normally retain for 12 months, security/admin records for up to 24 months, and encrypted backups age out on the disclosed 7 daily / 4 weekly / 12 monthly schedule.",
  },
  {
    purpose: "inactivity_mentor_notice",
    title: "Inactivity notices",
    summary: "After 24 hours without meaningful learning, the app may send one generic reminder to me and one generic notice to the administrator, followed by one final generic learner reminder after 72 hours. It then stays silent until meaningful learning closes the episode. Messages do not include scores, mistakes, code, chat, provider details, keys, or raw study time.",
  },
] as const;

export const DATA_CATEGORIES: Readonly<Record<ConsentPurpose, readonly string[]>> = {
  adult_18_plus: ["adult-confirmation"],
  mentor_visibility: ["learning-progress", "assessment-evidence", "projects", "tutor-history", "operations"],
  external_ai_routing: ["lesson-context", "learning-preferences", "relevant-chat", "learner-selected-code"],
  server_code_execution: ["source-code", "standard-input", "test-results"],
  retention_policy: ["account", "learning-history", "raw-chat-and-code", "security-audit", "encrypted-backups"],
  inactivity_mentor_notice: ["last-meaningful-activity", "inactivity-episode"],
  cohort_profile: ["public-alias", "optional-bio", "selected-badges", "selected-projects", "streak", "mastery-count"],
  leaderboard: ["public-alias", "capped-points", "streak"],
  admin_fallback_ai: ["lesson-context", "learning-preferences", "relevant-chat", "learner-selected-code", "token-usage"],
  "provider:nvidia_nim": ["lesson-context", "learning-preferences", "relevant-chat", "learner-selected-code"],
  "provider:openrouter": ["lesson-context", "learning-preferences", "relevant-chat", "learner-selected-code"],
  "provider:google": ["lesson-context", "learning-preferences", "relevant-chat", "learner-selected-code"],
  "provider:openai": ["lesson-context", "learning-preferences", "relevant-chat", "learner-selected-code"],
  "provider:anthropic": ["lesson-context", "learning-preferences", "relevant-chat", "learner-selected-code"],
  "provider:deepseek": ["lesson-context", "learning-preferences", "relevant-chat", "learner-selected-code"],
  "provider:custom_openai_compatible": ["lesson-context", "learning-preferences", "relevant-chat", "learner-selected-code"],
};

export function isConsentPurpose(value: string): value is ConsentPurpose {
  return (REQUIRED_DISCLOSURE_PURPOSES as readonly string[]).includes(value) ||
    (OPTIONAL_CONSENT_PURPOSES as readonly string[]).includes(value);
}

export function isWithdrawablePurpose(value: string): value is OptionalConsentPurpose {
  return (OPTIONAL_CONSENT_PURPOSES as readonly string[]).includes(value);
}

export function consentPurposeForProvider(provider: string): OptionalConsentPurpose | null {
  const purpose = `provider:${provider}`;
  return providerPurpose.has(purpose) ? purpose as OptionalConsentPurpose : null;
}

export function consentIdempotencyKey(input: {
  userId: string;
  purpose: ConsentPurpose;
  decision: ConsentDecision;
  source: "onboarding" | "settings" | "system_migration";
  requestId: string;
}) {
  const digest = createHash("sha256")
    .update([
      input.userId,
      input.purpose,
      input.decision,
      input.source,
      input.requestId,
      ENROLLMENT_DISCLOSURE_VERSION,
    ].join("\u0000"))
    .digest("hex");
  return `consent:${digest}`;
}

export type CurrentConsent = {
  id: string;
  purpose: string;
  policyVersion: string;
  decision: ConsentDecision;
  dataCategories: string[];
  occurredAt: Date;
};

type ConsentReadDatabase = Pick<typeof db, "selectDistinctOn">;
export async function getCurrentConsentsFrom(
  database: ConsentReadDatabase,
  userId: string,
): Promise<Map<string, CurrentConsent>> {
  const rows = await database
    .selectDistinctOn([consentRecord.purpose], {
      id: consentRecord.id,
      purpose: consentRecord.purpose,
      policyVersion: consentRecord.policyVersion,
      decision: consentRecord.decision,
      dataCategories: consentRecord.dataCategories,
      occurredAt: consentRecord.occurredAt,
    })
    .from(consentRecord)
    .where(eq(consentRecord.userId, userId))
    .orderBy(
      consentRecord.purpose,
      desc(consentRecord.occurredAt),
      desc(consentRecord.createdAt),
      desc(consentRecord.id),
    );
  const current = new Map<string, CurrentConsent>();
  for (const row of rows) {
    if (current.has(row.purpose)) continue;
    current.set(row.purpose, {
      ...row,
      decision: row.decision as ConsentDecision,
    });
  }
  return current;
}

export async function getCurrentConsents(userId: string): Promise<Map<string, CurrentConsent>> {
  return getCurrentConsentsFrom(db, userId);
}

export function isCurrentConsentAccepted(
  current: ReadonlyMap<string, CurrentConsent>,
  purpose: ConsentPurpose,
) {
  const record = current.get(purpose);
  return record?.decision === "accepted" &&
    record.policyVersion === ENROLLMENT_DISCLOSURE_VERSION;
}

export async function hasCurrentConsent(userId: string, purpose: ConsentPurpose) {
  return isCurrentConsentAccepted(await getCurrentConsents(userId), purpose);
}

export function consentInsert(input: {
  userId: string;
  purpose: ConsentPurpose;
  decision: ConsentDecision;
  source: "onboarding" | "settings" | "system_migration";
  requestId: string;
  occurredAt?: Date;
}) {
  return {
    userId: input.userId,
    purpose: input.purpose,
    policyVersion: ENROLLMENT_DISCLOSURE_VERSION,
    decision: input.decision,
    dataCategories: [...DATA_CATEGORIES[input.purpose]],
    source: input.source,
    idempotencyKey: consentIdempotencyKey(input),
    occurredAt: input.occurredAt ?? new Date(),
  };
}
