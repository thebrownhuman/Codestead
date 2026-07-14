import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  consentIdempotencyKey,
  consentInsert,
  consentPurposeForProvider,
  DATA_CATEGORIES,
  ENROLLMENT_DISCLOSURES,
  ENROLLMENT_DISCLOSURE_VERSION,
  isConsentPurpose,
  isCurrentConsentAccepted,
  isWithdrawablePurpose,
  OPTIONAL_CONSENT_PURPOSES,
  REQUIRED_DISCLOSURE_PURPOSES,
  type CurrentConsent,
} from "../consent";

describe("versioned privacy consent policy", () => {
  it("covers every required disclosure with learner-facing copy and data categories", () => {
    expect(ENROLLMENT_DISCLOSURE_VERSION).toMatch(/^enrollment-disclosure-.+\.v\d+$/);
    expect(ENROLLMENT_DISCLOSURES.map((item) => item.purpose)).toEqual(
      REQUIRED_DISCLOSURE_PURPOSES,
    );
    for (const disclosure of ENROLLMENT_DISCLOSURES) {
      expect(disclosure.title.length).toBeGreaterThan(3);
      expect(disclosure.summary.length).toBeGreaterThan(40);
      expect(DATA_CATEGORIES[disclosure.purpose].length).toBeGreaterThan(0);
      expect(isWithdrawablePurpose(disclosure.purpose)).toBe(false);
    }
  });

  it("maps only approved providers to independently withdrawable purposes", () => {
    for (const provider of [
      "nvidia_nim",
      "openrouter",
      "google",
      "openai",
      "anthropic",
      "deepseek",
      "custom_openai_compatible",
    ]) {
      const purpose = consentPurposeForProvider(provider);
      expect(purpose).toBe(`provider:${provider}`);
      expect(isConsentPurpose(purpose!)).toBe(true);
      expect(isWithdrawablePurpose(purpose!)).toBe(true);
    }
    expect(consentPurposeForProvider("unknown-provider")).toBeNull();
    expect(OPTIONAL_CONSENT_PURPOSES).toContain("admin_fallback_ai");
  });

  it("requires both acceptance and the current policy version", () => {
    const accepted: CurrentConsent = {
      id: "11111111-1111-4111-8111-111111111111",
      purpose: "provider:nvidia_nim",
      policyVersion: ENROLLMENT_DISCLOSURE_VERSION,
      decision: "accepted",
      dataCategories: [],
      occurredAt: new Date(),
    };
    expect(isCurrentConsentAccepted(new Map([[accepted.purpose, accepted]]), "provider:nvidia_nim")).toBe(true);
    expect(isCurrentConsentAccepted(new Map([[accepted.purpose, { ...accepted, decision: "withdrawn" }]]), "provider:nvidia_nim")).toBe(false);
    expect(isCurrentConsentAccepted(new Map([[accepted.purpose, { ...accepted, policyVersion: "old.v1" }]]), "provider:nvidia_nim")).toBe(false);
    expect(isCurrentConsentAccepted(new Map(), "provider:nvidia_nim")).toBe(false);
  });

  it("builds deterministic, opaque idempotency keys without embedding identity", () => {
    const input = {
      userId: "learner-private-identity",
      purpose: "admin_fallback_ai" as const,
      decision: "accepted" as const,
      source: "settings" as const,
      requestId: "11111111-1111-4111-8111-111111111111",
    };
    const first = consentIdempotencyKey(input);
    expect(first).toBe(consentIdempotencyKey(input));
    expect(first).toMatch(/^consent:[a-f0-9]{64}$/);
    expect(first).not.toContain(input.userId);
    expect(consentIdempotencyKey({ ...input, decision: "withdrawn" })).not.toBe(first);
  });

  it("creates allowlisted category snapshots for an append-only decision", () => {
    const occurredAt = new Date("2026-07-12T00:00:00.000Z");
    const row = consentInsert({
      userId: "learner-1",
      purpose: "cohort_profile",
      decision: "withdrawn",
      source: "settings",
      requestId: "22222222-2222-4222-8222-222222222222",
      occurredAt,
    });
    expect(row).toMatchObject({
      userId: "learner-1",
      purpose: "cohort_profile",
      decision: "withdrawn",
      source: "settings",
      policyVersion: ENROLLMENT_DISCLOSURE_VERSION,
      occurredAt,
    });
    expect(row.dataCategories).toEqual([...DATA_CATEGORIES.cohort_profile]);
  });

  it("gates every future external-AI and server-execution boundary", () => {
    const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
    const tutor = read("src/app/api/ai/tutor/route.ts");
    expect(tutor).toContain('isCurrentConsentAccepted(currentConsents, "external_ai_routing")');
    expect(tutor).toContain("consentPurposeForProvider(credential.provider)");
    expect(tutor).toContain('isCurrentConsentAccepted(currentConsents, "admin_fallback_ai")');
    expect(tutor).toContain("consentPurposeForProvider(row.provider)");

    for (const file of [
      "src/app/api/code/run/route.ts",
      "src/app/api/exams/[sessionId]/run/route.ts",
    ]) {
      expect(read(file)).toContain('hasCurrentConsent(authz.session.user.id, "server_code_execution")');
    }
    const credentialRoute = read("src/app/api/credentials/route.ts");
    expect(credentialRoute).toContain("consentPurposeForProvider(body.data.provider)");
    expect(credentialRoute).toContain("PROVIDER_CONSENT_REQUIRED");
  });
});
