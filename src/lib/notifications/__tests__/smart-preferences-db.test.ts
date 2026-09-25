import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  pool: { query: mocks.poolQuery, connect: mocks.connect },
}));

import {
  loadSmartReminderPreferences,
  updateSmartReminderPreferences,
} from "../smart-preferences";

const userId = "10000000-0000-4000-8000-000000000001";

function validInput(overrides: Partial<Parameters<typeof updateSmartReminderPreferences>[0]> = {}) {
  return {
    userId,
    expectedVersion: 0,
    dailyStudyEnabled: true,
    revisionEnabled: false,
    goalEnabled: false,
    challengeEnabled: false,
    weeklySummaryEnabled: false,
    learningEmailEnabled: false,
    timezone: "Asia/Kolkata",
    dailyStudyMinute: 480,
    revisionMinute: 540,
    quietHoursEnabled: true,
    quietStartMinute: 1_320,
    quietEndMinute: 480,
    now: new Date("2026-07-12T00:00:00.000Z"),
    ...overrides,
  };
}

function fakeClient(overrides: Partial<{
  currentRow: Record<string, unknown> | undefined;
  updateRowCount: number;
}> = {}) {
  const { currentRow, updateRowCount = 1 } = overrides;
  const queries: unknown[][] = [];
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      queries.push([text, values]);
      if (text.includes("select")) return { rows: currentRow ? [currentRow] : [] };
      if (text.includes("update notification_preference")) return { rowCount: updateRowCount };
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  return { client, queries };
}

describe("loadSmartReminderPreferences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies defaults for an active user with no preference row yet", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{
      daily_study_enabled: null, revision_enabled: null, goal_enabled: null, challenge_enabled: null,
      weekly_summary_enabled: null, learning_email_enabled: null, timezone: null,
      daily_study_minute: null, revision_minute: null, quiet_hours_enabled: null,
      quiet_start_minute: null, quiet_end_minute: null, row_version: null, user_timezone: "America/New_York",
    }] });

    const preferences = await loadSmartReminderPreferences(userId);

    expect(preferences).toMatchObject({
      dailyStudyEnabled: false,
      timezone: "America/New_York",
      dailyStudyMinute: 1_080,
      rowVersion: 0,
    });
  });

  it("throws USER_NOT_FOUND when the learner is missing or inactive", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [] });

    await expect(loadSmartReminderPreferences(userId)).rejects.toMatchObject({ code: "USER_NOT_FOUND", status: 404 });
  });
});

describe("updateSmartReminderPreferences", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an out-of-range minute before opening a transaction", async () => {
    await expect(updateSmartReminderPreferences(validInput({ dailyStudyMinute: 1_440 })))
      .rejects.toMatchObject({ code: "INVALID_MINUTE" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects an invalid time zone before opening a transaction", async () => {
    await expect(updateSmartReminderPreferences(validInput({ timezone: "Not/AZone" })))
      .rejects.toMatchObject({ code: "INVALID_TIMEZONE" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects a negative expected version before opening a transaction", async () => {
    await expect(updateSmartReminderPreferences(validInput({ expectedVersion: -1 })))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("inserts a first preference row when none exists yet, and commits", async () => {
    const { client, queries } = fakeClient({ currentRow: { row_version: null } });
    mocks.connect.mockResolvedValue(client);

    const result = await updateSmartReminderPreferences(validInput({ expectedVersion: 0 }));

    expect(result).toMatchObject({ rowVersion: 1, timezone: "Asia/Kolkata" });
    expect(queries.some(([text]) => String(text).includes("insert into notification_preference"))).toBe(true);
    expect(client.query).toHaveBeenCalledWith("commit");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("updates an existing row by expected version and commits", async () => {
    const { client, queries } = fakeClient({ currentRow: { row_version: 3 } });
    mocks.connect.mockResolvedValue(client);

    const result = await updateSmartReminderPreferences(validInput({ expectedVersion: 3 }));

    expect(result.rowVersion).toBe(4);
    expect(queries.some(([text]) => String(text).includes("update notification_preference"))).toBe(true);
    expect(client.query).toHaveBeenCalledWith("commit");
  });

  it("rolls back and reports USER_NOT_FOUND when the locked row disappears", async () => {
    const { client } = fakeClient({ currentRow: undefined });
    mocks.connect.mockResolvedValue(client);

    await expect(updateSmartReminderPreferences(validInput())).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    expect(client.query).toHaveBeenCalledWith("rollback");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back on a stale expected version", async () => {
    const { client } = fakeClient({ currentRow: { row_version: 5 } });
    mocks.connect.mockResolvedValue(client);

    await expect(updateSmartReminderPreferences(validInput({ expectedVersion: 2 })))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(client.query).toHaveBeenCalledWith("rollback");
  });

  it("rolls back when a concurrent writer already advanced the row version", async () => {
    const { client } = fakeClient({ currentRow: { row_version: 3 }, updateRowCount: 0 });
    mocks.connect.mockResolvedValue(client);

    await expect(updateSmartReminderPreferences(validInput({ expectedVersion: 3 })))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(client.query).toHaveBeenCalledWith("rollback");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
