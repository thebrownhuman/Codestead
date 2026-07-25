import { createHash } from "node:crypto";

import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";
import { describe, expect, it, vi } from "vitest";

const APPLICATION_URL = "https://learn.example.test";
const NOW = new Date("2026-07-25T09:30:00.000Z");
const OUTBOX_ID = "10000000-0000-4000-8000-000000000001";
const LOST_PROOF_ID = "20000000-0000-4000-8000-000000000002";
const REVOCATION_ID = "30000000-0000-4000-8000-000000000003";
const EPISODE_ID = "40000000-0000-4000-8000-000000000004";
const DISPATCH_ID = "50000000-0000-4000-8000-000000000005";
const RESET_TOKEN = "AbCdEfGhIjKlMnOpQrStUvWx";
const RESET_URL = `${APPLICATION_URL}/api/auth/reset-password/${RESET_TOKEN}?callbackURL=${encodeURIComponent(`${APPLICATION_URL}/reset-password`)}`;
const LOST_RAW_PROOF = "A".repeat(43);
const LOST_PROOF_HASH = createHash("sha256").update(LOST_RAW_PROOF).digest("hex");

async function subject() {
  return import("../revocable-source-authority");
}

function normalized(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

const exactCases = [
  ["reset-password", "1", {
    name: "Learner", resetVerificationId: "verification_source_01", url: RESET_URL,
  }],
  ["lost-device-proof", "1", {
    name: "Learner", recoveryRequestId: LOST_PROOF_ID,
  }],
  ["session-revocation-requested", "1", {
    device: "an approved browser profile", name: "Administrator", revocationRequestId: REVOCATION_ID,
    url: `${APPLICATION_URL}/admin/learners/learner-1`,
  }],
  ["inactivity-reminder", "2", {
    inactivityEpisodeId: EPISODE_ID, inactivityPolicyVersion: "inactivity-2026-07.v2",
    name: "Learner", url: `${APPLICATION_URL}/learn`,
  }],
  ["inactivity-admin-notice", "2", {
    inactivityEpisodeId: EPISODE_ID, inactivityPolicyVersion: "inactivity-2026-07.v2",
    name: "administrator", url: `${APPLICATION_URL}/admin`,
  }],
  ["revision-reminder", "1", {
    name: "Learner", smartReminderDispatchId: DISPATCH_ID, smartReminderKind: "revision",
    smartReminderPeriodKey: "2026-07-25", smartReminderPolicyVersion: "smart-reminders-2026-07.v1",
    url: `${APPLICATION_URL}/review`,
  }],
  ["weekly-summary", "1", {
    name: "Learner", smartReminderDispatchId: DISPATCH_ID, smartReminderKind: "weekly_summary",
    smartReminderPeriodKey: "2026-W30", smartReminderPolicyVersion: "smart-reminders-2026-07.v1",
    summary: "Your private, evidence-backed weekly summary is ready inside Codestead.",
    url: `${APPLICATION_URL}/learn`,
  }],
] as const;

describe("revocable mail source variable contracts", () => {
  it.each(exactCases)("accepts only the exact persisted %s v%s schema", async (template, templateVersion, variables) => {
    const authority = await subject();
    const parsed = authority.parseRevocableSourceVariables({
      applicationUrl: APPLICATION_URL,
      template,
      templateVersion,
      variables,
    });
    expect(parsed).not.toBeNull();
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(JSON.stringify(parsed)).not.toContain(RESET_TOKEN);
  });

  it.each([
    ["unknown", { template: "new-device", templateVersion: "1", variables: {} }],
    ["extra", { template: "lost-device-proof", templateVersion: "1", variables: {
      name: "Learner", recoveryRequestId: LOST_PROOF_ID, bearer: "secret",
    } }],
    ["missing", { template: "session-revocation-requested", templateVersion: "1", variables: {
      name: "Admin", device: "Laptop", url: `${APPLICATION_URL}/admin/learners/learner-1`,
    } }],
    ["wrong version", { template: "inactivity-reminder", templateVersion: "1", variables: {
      inactivityEpisodeId: EPISODE_ID, inactivityPolicyVersion: "inactivity-2026-07.v2",
      name: "Learner", url: `${APPLICATION_URL}/learn`,
    } }],
    ["cross origin", { template: "session-revocation-requested", templateVersion: "1", variables: {
      ...exactCases[2][2],
      url: "https://attacker.example/admin/learners/learner-1",
    } }],
    ["reset endpoint drift", { template: "reset-password", templateVersion: "1", variables: {
      ...exactCases[0][2],
      url: RESET_URL.replace("/api/auth/", "/not-auth/"),
    } }],
    ["kind mismatch", { template: "revision-reminder", templateVersion: "1", variables: {
      name: "Learner", smartReminderDispatchId: DISPATCH_ID, smartReminderKind: "goal",
      smartReminderPeriodKey: "2026-07-25", smartReminderPolicyVersion: "smart-reminders-2026-07.v1",
      url: `${APPLICATION_URL}/review`,
    } }],
    ["mutable session device copy", { template: "session-revocation-requested", templateVersion: "1", variables: {
      ...exactCases[2][2], device: "Chrome on laptop",
    } }],
    ["impossible daily period", { template: "revision-reminder", templateVersion: "1", variables: {
      ...exactCases[5][2], smartReminderPeriodKey: "2026-02-30",
    } }],
    ["impossible calendar month", { template: "revision-reminder", templateVersion: "1", variables: {
      ...exactCases[5][2], smartReminderPeriodKey: "2026-13-01",
    } }],
    ["impossible ISO week", { template: "weekly-summary", templateVersion: "1", variables: {
      ...exactCases[6][2], smartReminderPeriodKey: "2026-W54",
    } }],
    ["non-leap February", { template: "revision-reminder", templateVersion: "1", variables: {
      ...exactCases[5][2], smartReminderPeriodKey: "2025-02-29",
    } }],
    ["year without ISO week 53", { template: "weekly-summary", templateVersion: "1", variables: {
      ...exactCases[6][2], smartReminderPeriodKey: "2025-W53",
    } }],
  ])("fails closed for %s evidence", async (_label, input) => {
    const authority = await subject();
    expect(authority.parseRevocableSourceVariables({ applicationUrl: APPLICATION_URL, ...input })).toBeNull();
  });

  it.each([
    ["leap day", { template: "revision-reminder", templateVersion: "1", variables: {
      ...exactCases[5][2], smartReminderPeriodKey: "2024-02-29",
    } }],
    ["valid ISO week 53", { template: "weekly-summary", templateVersion: "1", variables: {
      ...exactCases[6][2], smartReminderPeriodKey: "2026-W53",
    } }],
  ])("accepts the real %s period boundary", async (_label, input) => {
    const authority = await subject();
    expect(authority.parseRevocableSourceVariables({ applicationUrl: APPLICATION_URL, ...input })).not.toBeNull();
  });

  it("fails closed without coercing untrusted template values", async () => {
    const authority = await subject();
    const poisonedTemplate = {
      toString() {
        throw new Error("sensitive coercion canary");
      },
    };
    expect(authority.parseRevocableSourceVariables({
      applicationUrl: APPLICATION_URL, template: poisonedTemplate, templateVersion: "1", variables: {},
    })).toBeNull();
    const poisonedVariables = new Proxy({}, {
      ownKeys() {
        throw new Error("sensitive variables canary");
      },
    });
    expect(authority.parseRevocableSourceVariables({
      applicationUrl: APPLICATION_URL, template: "lost-device-proof", templateVersion: "1", variables: poisonedVariables,
    })).toBeNull();
  });

  it("constructs frozen exact variables without duplicating bearer values", async () => {
    const authority = await subject();
    const reset = authority.createResetPasswordSourceVariables({
      applicationUrl: APPLICATION_URL, name: "Learner", token: RESET_TOKEN,
      url: RESET_URL, verificationId: "verification_source_01",
    });
    const lost = authority.createLostDeviceProofSourceVariables({ name: "Learner", recoveryRequestId: LOST_PROOF_ID });
    expect(reset).toEqual({ name: "Learner", resetVerificationId: "verification_source_01", url: RESET_URL });
    expect(lost).toEqual({ name: "Learner", recoveryRequestId: LOST_PROOF_ID });
    expect(Object.isFrozen(reset)).toBe(true);
    expect(Object.keys(reset ?? {})).not.toContain("token");
    expect(JSON.stringify(lost)).not.toMatch(/proof=/i);
  });

  it("turns invalid producer evidence into a bounded non-sensitive error", async () => {
    const authority = await subject();
    const error = (() => {
      try { return authority.requireRevocableSourceVariables(null); }
      catch (failure) { return failure; }
    })();
    expect(error).toMatchObject({ code: "MAIL_SOURCE_EVIDENCE_INVALID" });
    expect(JSON.stringify(error)).not.toContain(RESET_TOKEN);
    expect(String(error)).not.toContain("learner@example.test");
  });
});

describe("revocable mail source authority SQL", () => {
  it.each([
    [exactCases[0], ["public.verification source_verification", "source_verification.identifier = $3", "source_verification.value = mail.user_id", "source_verification.expires_at > $4", "mail.variables ->> 'name' = recipient_user.name", "for share of recipient_user, source_verification"]],
    [exactCases[1], ["public.lost_device_proof source_proof", "source_proof.proof_hash = $3", "source_session.revoked_at is null", "source_session.expires_at > $4", "mail.variables ->> 'name' = recipient_user.name", "for share of recipient_user, source_proof, source_session"]],
    [exactCases[2], ["public.session_revocation_request source_request", "source_request.status = 'pending'", "recipient_user.role = 'admin'", "recipient_user.banned = false", "mail.variables ->> 'device' = $4", "for share of recipient_user, source_request"]],
    [exactCases[3], ["public.inactivity_episode source_episode", "source_episode.closed_at is null", "latest_consent.decision = 'accepted'", "inactivity_paused_until", "learner_first_queued_at between source_episode.eligible_at and $3", "learner_second_queued_at between source_episode.second_eligible_at and $3", "learner_second_queued_at >= source_episode.learner_first_queued_at + interval '48 hours'", "for share of recipient_user, learner_user, source_episode"]],
    [exactCases[5], ["public.smart_reminder_dispatch source_dispatch", "pg_catalog.pg_timezone_names source_timezone", "source_dispatch.timezone = recipient_preference.timezone", "source_dispatch.local_period_key = $4", "source_dispatch.scheduled_for <= $8", "source_dispatch.dispatched_at >= source_dispatch.scheduled_for", "recipient_preference.learning_email_enabled = true", "recipient_preference.revision_enabled = true", "for share of recipient_user, recipient_preference, source_dispatch"]],
  ])("builds a parameterized authority query plan for %s", async ([template, templateVersion, variables], fragments) => {
    const authority = await subject();
    const authorityEvidence = template === "lost-device-proof"
      ? authority.createLostDeviceAuthorityEvidence({
          sourceId: LOST_PROOF_ID, rawProof: LOST_RAW_PROOF, storedProofHash: LOST_PROOF_HASH,
        }) ?? undefined
      : undefined;
    const query = authority.buildRevocableSourceAuthorityQuery({
      applicationUrl: APPLICATION_URL,
      authorityEvidence,
      now: NOW,
      outboxId: OUTBOX_ID,
      template,
      templateVersion,
      variables,
    });
    expect(query).not.toBeNull();
    const text = normalized(query!.text);
    for (const fragment of fragments) expect(text).toContain(fragment);
    expect(text).not.toContain(RESET_TOKEN.toLowerCase());
    expect(query!.values[0]).toBe(OUTBOX_ID);
    expect(Object.isFrozen(query)).toBe(true);
    expect(Object.isFrozen(query!.values)).toBe(true);
  });

  it("accepts only opaque evidence computed from the exact rendered lost-device proof", async () => {
    const authority = await subject();
    const evidence = authority.createLostDeviceAuthorityEvidence({
      sourceId: LOST_PROOF_ID, rawProof: LOST_RAW_PROOF, storedProofHash: LOST_PROOF_HASH,
    });
    expect(evidence).toMatchObject({ kind: "lost-device-proof", sourceId: LOST_PROOF_ID, proofHash: LOST_PROOF_HASH });
    expect(Object.isFrozen(evidence)).toBe(true);
    const oneByteMutation = `B${LOST_RAW_PROOF.slice(1)}`;
    expect(authority.createLostDeviceAuthorityEvidence({
      sourceId: LOST_PROOF_ID, rawProof: oneByteMutation, storedProofHash: LOST_PROOF_HASH,
    })).toBeNull();
    const forged = Object.freeze({
      kind: "lost-device-proof", sourceId: LOST_PROOF_ID, proofHash: LOST_PROOF_HASH,
    });
    const input = {
      applicationUrl: APPLICATION_URL, now: NOW, outboxId: OUTBOX_ID,
      template: "lost-device-proof", templateVersion: "1", variables: exactCases[1][2],
    } as const;
    expect(authority.buildRevocableSourceAuthorityQuery({
      ...input, authorityEvidence: evidence!,
    })).not.toBeNull();
    expect(authority.buildRevocableSourceAuthorityQuery({
      ...input, authorityEvidence: forged as never,
    })).toBeNull();
  });

  it("binds reset authority to both stable row id and exact live bearer identifier", async () => {
    const authority = await subject();
    const query = authority.buildRevocableSourceAuthorityQuery({
      applicationUrl: APPLICATION_URL, now: NOW, outboxId: OUTBOX_ID,
      template: "reset-password", templateVersion: "1", variables: exactCases[0][2],
    });
    expect(query?.values).toEqual([OUTBOX_ID, "verification_source_01", `reset-password:${RESET_TOKEN}`, NOW]);
  });

  it("binds inactivity to the canonical consent and coherent non-future stage markers", async () => {
    const authority = await subject();
    const query = authority.buildRevocableSourceAuthorityQuery({
      applicationUrl: APPLICATION_URL, now: NOW, outboxId: OUTBOX_ID,
      template: "inactivity-reminder", templateVersion: "2", variables: exactCases[3][2],
    });
    const text = normalized(query!.text);
    expect(text).toContain("mail.template = $7");
    expect(text).toContain("learner_first_queued_at between source_episode.eligible_at and $3");
    expect(text).toContain("learner_second_queued_at between source_episode.second_eligible_at and $3");
    expect(text).toContain("learner_second_queued_at >= source_episode.learner_first_queued_at + interval '48 hours'");
    expect(query!.values.at(-1)).toBe("inactivity-reminder");
    expect(query!.values[3]).toBe(ENROLLMENT_DISCLOSURE_VERSION);
    const admin = authority.buildRevocableSourceAuthorityQuery({
      applicationUrl: APPLICATION_URL, now: NOW, outboxId: OUTBOX_ID,
      template: "inactivity-admin-notice", templateVersion: "2", variables: exactCases[4][2],
    });
    const adminText = normalized(admin!.text);
    expect(adminText).toContain("admin_notice_queued_at <= $3");
    expect(adminText).toContain("learner_first_queued_at <= source_episode.admin_notice_queued_at");
  });

  it("binds smart-reminder periods to dispatch time and the still-current timezone", async () => {
    const authority = await subject();
    const daily = authority.buildRevocableSourceAuthorityQuery({
      applicationUrl: APPLICATION_URL, now: NOW, outboxId: OUTBOX_ID,
      template: "revision-reminder", templateVersion: "1", variables: exactCases[5][2],
    });
    expect(daily!.values[6]).toBe("YYYY-MM-DD");
    expect(daily!.values[7]).toBe(NOW);
    const weekly = authority.buildRevocableSourceAuthorityQuery({
      applicationUrl: APPLICATION_URL, now: NOW, outboxId: OUTBOX_ID,
      template: "weekly-summary", templateVersion: "1", variables: exactCases[6][2],
    });
    expect(weekly!.values[6]).toBe('IYYY-"W"IW');
  });

  it("fails closed before querying for malformed evidence or a missing proof verifier", async () => {
    const authority = await subject();
    expect(authority.buildRevocableSourceAuthorityQuery({
      applicationUrl: APPLICATION_URL, now: NOW, outboxId: OUTBOX_ID,
      template: "lost-device-proof", templateVersion: "1", variables: exactCases[1][2],
    })).toBeNull();
    expect(authority.buildRevocableSourceAuthorityQuery({
      applicationUrl: APPLICATION_URL, now: new Date(Number.NaN), outboxId: OUTBOX_ID,
      template: "reset-password", templateVersion: "1", variables: exactCases[0][2],
    })).toBeNull();
  });

  it("exports the canonical central lock order", async () => {
    const authority = await subject();
    expect(authority.REVOCABLE_SOURCE_LOCK_ORDER).toEqual([
      "email_outbox", "user:ascending-id", "verification", "lost_device_proof", "session",
      "session_revocation_request", "inactivity_episode", "consent_record",
      "notification_preference", "smart_reminder_dispatch",
    ]);
    expect(Object.isFrozen(authority.REVOCABLE_SOURCE_LOCK_ORDER)).toBe(true);
  });
});

describe("reset-password source resolution", () => {
  it("selects exactly one unexpired verification row by bearer and owner", async () => {
    const authority = await subject();
    const query = vi.fn(async (_text: string, _values: unknown[]) => {
      void _text;
      void _values;
      return { rows: [{ id: "verification_source_01" }] };
    });
    await expect(authority.loadResetPasswordVerificationSource({ query }, {
      token: RESET_TOKEN, userId: "learner-1",
    })).resolves.toBe("verification_source_01");
    const [text, values] = query.mock.calls[0]!;
    expect(normalized(text)).toContain("from public.verification");
    expect(normalized(text)).toContain("expires_at > statement_timestamp()");
    expect(normalized(text)).toContain("limit 2");
    expect(values).toEqual([`reset-password:${RESET_TOKEN}`, "learner-1"]);
  });

  it.each([
    ["none", []], ["duplicates", [{ id: "verification_source_01" }, { id: "verification_source_02" }]],
    ["bad id", [{ id: "contains spaces" }]],
  ])("fails closed for %s", async (_label, rows) => {
    const authority = await subject();
    await expect(authority.loadResetPasswordVerificationSource({ query: async () => ({ rows }) }, {
      token: RESET_TOKEN, userId: "learner-1",
    })).resolves.toBeNull();
  });

  it("replaces database failures with a bounded non-sensitive error", async () => {
    const authority = await subject();
    const canary = `recipient=learner@example.test token=${RESET_TOKEN}`;
    const error = await authority.loadResetPasswordVerificationSource({
      query: async () => { throw new Error(canary); },
    }, { token: RESET_TOKEN, userId: "learner-1" }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(authority.RevocableSourceAuthorityError);
    expect(error).toMatchObject({ code: "RESET_PASSWORD_SOURCE_UNAVAILABLE" });
    expect(String(error)).not.toContain(canary);
    expect(JSON.stringify(error)).not.toContain(RESET_TOKEN);
  });
});
