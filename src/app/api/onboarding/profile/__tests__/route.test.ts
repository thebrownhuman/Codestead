import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ENROLLMENT_DISCLOSURE_VERSION,
  REQUIRED_DISCLOSURE_PURPOSES,
} from "@/lib/privacy/consent";

const mocks = vi.hoisted(() => {
  const updateWhere = vi.fn();
  const set = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set }));
  const onConflictDoUpdate = vi.fn();
  const onConflictDoNothing = vi.fn();
  const values = vi.fn(() => ({ onConflictDoUpdate, onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));
  const execute = vi.fn();
  const accountRows = [] as Array<{ status: string }>;
  const limit = vi.fn(async () => accountRows);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback({
    update,
    insert,
    execute,
    select,
  }));
  return {
    updateWhere,
    set,
    update,
    onConflictDoUpdate,
    onConflictDoNothing,
    values,
    insert,
    execute,
    accountRows,
    transaction,
    requireAuth: vi.fn(),
  };
});

vi.mock("@/lib/db/client", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));

import { POST } from "../route";

const validBody = {
  requestId: "11111111-1111-4111-8111-111111111111",
  disclosureVersion: ENROLLMENT_DISCLOSURE_VERSION,
  acknowledgements: {
    adult18Plus: true,
    mentorVisibility: true,
    externalAiRouting: true,
    serverCodeExecution: true,
    retentionPolicy: true,
    inactivityMentorNotice: true,
    nvidiaNimProvider: true,
  },
  optionalConsents: {
    cohortProfile: false,
    leaderboard: false,
    adminFallbackAi: false,
  },
  name: "Aarav Learner",
  level: "beginner",
  preferredSessionMinutes: 30,
  weeklyGoalMinutes: 180,
  goal: "Learn Python independently",
  hobbies: [
    { label: "cooking", category: "cooking", confirmed: true },
    { label: "cars", category: "cars", confirmed: true },
  ],
  analogyFrequency: "helpful",
  selectedTracks: ["programming-foundations", "python"],
  timezone: "Asia/Kolkata",
};

function request(body: unknown) {
  return new NextRequest("https://learn.test/api/onboarding/profile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("versioned onboarding profile and disclosure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" }, session: { id: "session-1" } },
      response: null,
    });
    mocks.updateWhere.mockResolvedValue(undefined);
    mocks.onConflictDoUpdate.mockResolvedValue(undefined);
    mocks.onConflictDoNothing.mockResolvedValue(undefined);
    mocks.accountRows.splice(0, mocks.accountRows.length, { status: "pending" });
  });

  it("rejects any missing acknowledgement or stale disclosure before persistence", async () => {
    const missing = await POST(request({
      ...validBody,
      acknowledgements: { ...validBody.acknowledgements, retentionPolicy: false },
    }));
    expect(missing.status).toBe(400);
    const stale = await POST(request({ ...validBody, disclosureVersion: "old.v1" }));
    expect(stale.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("requires a DSA language and enforces the cohort/leaderboard dependency", async () => {
    const missingLanguage = await POST(request({
      ...validBody,
      selectedTracks: ["dsa"],
    }));
    expect(missingLanguage.status).toBe(400);
    const leaderboardWithoutProfile = await POST(request({
      ...validBody,
      optionalConsents: { ...validBody.optionalConsents, leaderboard: true },
    }));
    expect(leaderboardWithoutProfile.status).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("persists availability, adult confirmation, interests, and an append-only policy snapshot", async () => {
    const response = await POST(request(validBody));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      disclosureVersion: ENROLLMENT_DISCLOSURE_VERSION,
      interests: [
        { label: "cooking", category: "cooking", confirmed: true },
        { label: "cars", category: "cars", confirmed: true },
      ],
    });
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({
      name: "Aarav Learner",
      timezone: "Asia/Kolkata",
      adultConfirmedAt: expect.anything(),
    }));
    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      userId: "learner-1",
      preferredSessionMinutes: 30,
      weeklyGoalMinutes: 180,
      onboardingStep: "mfa",
    }));
    const consentRows = (mocks.values.mock.calls as unknown as Array<[unknown]>).find(
      ([value]) => Array.isArray(value),
    )?.[0] as Array<{ purpose: string; decision: string; policyVersion: string }>;
    expect(consentRows).toHaveLength(REQUIRED_DISCLOSURE_PURPOSES.length + 4);
    expect(consentRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ purpose: "adult_18_plus", decision: "accepted" }),
      expect.objectContaining({ purpose: "provider:nvidia_nim", decision: "accepted" }),
      expect.objectContaining({ purpose: "cohort_profile", decision: "withdrawn" }),
      expect.objectContaining({ purpose: "leaderboard", decision: "withdrawn" }),
      expect.objectContaining({ purpose: "admin_fallback_ai", decision: "withdrawn" }),
    ]));
    expect(new Set(consentRows.map((row) => row.policyVersion))).toEqual(
      new Set([ENROLLMENT_DISCLOSURE_VERSION]),
    );
    expect(mocks.onConflictDoNothing).toHaveBeenCalled();
  });

  it("does not append onboarding consent after account deletion begins", async () => {
    mocks.accountRows.splice(0, mocks.accountRows.length, { status: "deletion_pending" });
    const response = await POST(request(validBody));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ACCOUNT_UNAVAILABLE" });
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
