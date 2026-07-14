import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
  rateLimit: vi.fn(async (_input: unknown, callback: () => Promise<Response>) => callback()),
  session: { user: { id: "learner-1" } },
}));

vi.mock("@/lib/http/authz", () => ({
  requireAuth: vi.fn(async () => ({ session: mocks.session, response: NextResponse.json({ error: "AUTH" }, { status: 401 }) })),
}));
vi.mock("@/lib/notifications/smart-preferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/smart-preferences")>()),
  loadSmartReminderPreferences: mocks.load,
  updateSmartReminderPreferences: mocks.update,
}));
vi.mock("@/lib/security/audit-writer", () => ({ writeAuditEvent: mocks.audit }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.rateLimit }));

import { GET, PATCH } from "../route";
import { SmartReminderPreferenceError } from "@/lib/notifications/smart-preferences";

const preferences = {
  dailyStudyEnabled: true,
  revisionEnabled: true,
  goalEnabled: true,
  challengeEnabled: true,
  weeklySummaryEnabled: true,
  learningEmailEnabled: true,
  timezone: "Asia/Kolkata",
  dailyStudyMinute: 1_080,
  revisionMinute: 1_140,
  quietHoursEnabled: true,
  quietStartMinute: 1_320,
  quietEndMinute: 480,
  rowVersion: 2,
};

function request(body: unknown) {
  return new NextRequest("https://learn.example.test/api/notifications/preferences", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("notification preference route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.load.mockResolvedValue(preferences);
    mocks.update.mockResolvedValue({ ...preferences, rowVersion: 3 });
    mocks.audit.mockResolvedValue(undefined);
  });

  it("loads only the authenticated learner's preferences", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(mocks.load).toHaveBeenCalledWith("learner-1");
    expect(await response.json()).toEqual({ preferences });
  });

  it("rejects partial or unexpected preference payloads", async () => {
    const response = await PATCH(request({ expectedVersion: 2, dailyStudyEnabled: true, unknown: true }));
    expect(response.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rate-limits, persists optimistic concurrency, and records content-free audit metadata", async () => {
    const response = await PATCH(request({ ...preferences, rowVersion: undefined, expectedVersion: 2 }));
    expect(response.status).toBe(200);
    expect(mocks.rateLimit).toHaveBeenCalledWith(expect.objectContaining({ policy: "notification_preferences_user" }), expect.any(Function));
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ userId: "learner-1", expectedVersion: 2, timezone: "Asia/Kolkata" }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "notification_preferences.updated",
      metadata: expect.not.objectContaining({ email: expect.anything(), body: expect.anything() }),
    }));
  });

  it("does not misreport a committed preference update when optional audit telemetry fails", async () => {
    mocks.audit.mockRejectedValueOnce(new Error("audit unavailable"));
    const response = await PATCH(request({ ...preferences, rowVersion: undefined, expectedVersion: 2 }));
    expect(response.status).toBe(200);
    expect((await response.json()).warning).toMatch(/saved/i);
  });

  it("maps optimistic concurrency conflicts without exposing details", async () => {
    mocks.update.mockRejectedValueOnce(new SmartReminderPreferenceError("VERSION_CONFLICT", 409));
    const response = await PATCH(request({ ...preferences, rowVersion: undefined, expectedVersion: 2 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "VERSION_CONFLICT" });
  });
});
