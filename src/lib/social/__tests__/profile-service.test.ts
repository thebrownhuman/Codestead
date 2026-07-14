import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  pool: { connect: mocks.connect, query: mocks.poolQuery },
}));

import { ENROLLMENT_DISCLOSURE_VERSION } from "@/lib/privacy/consent";
import { hashSocialEvidence } from "../hash";
import {
  hasLeaderboardConsent,
  isCurrentSocialConsentAccepted,
  listVisibleProfileOwners,
  loadOwnCohortSettings,
  loadVisibleCohortProfile,
  updateCohortProfile,
  withdrawCohortProfileForConsent,
  type CohortProfileUpdate,
} from "../profile-service";

const REQUEST_ID = "10000000-0000-4000-8000-000000000001";
const ACHIEVEMENT_ID = "20000000-0000-4000-8000-000000000002";
const PROJECT_ID = "30000000-0000-4000-8000-000000000003";
const PUBLIC_ID = "40000000-0000-4000-8000-000000000004";
const USER_ID = "learner-user";
const NOW = new Date("2026-07-12T12:00:00.000Z");

type QueryRows = { rows: unknown[] };
type QueryHandler = (statement: string, parameters?: readonly unknown[]) => Promise<QueryRows>;

function mockClient(handler: QueryHandler) {
  const query = vi.fn(handler);
  const release = vi.fn();
  mocks.connect.mockResolvedValue({ query, release });
  return { query, release };
}

function profile(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    user_id: USER_ID,
    alias: "learner-safe",
    bio: "A short bio",
    is_published: false,
    published_consent_record_id: null,
    show_bio: false,
    show_streak: false,
    show_mastery_summary: false,
    selected_achievement_ids: [],
    selected_project_ids: [],
    row_version: "1",
    published_at: null,
    withdrawn_at: null,
    ...overrides,
  };
}

function validUpdate(overrides: Partial<CohortProfileUpdate> = {}): CohortProfileUpdate {
  return {
    actorUserId: USER_ID,
    requestId: REQUEST_ID,
    expectedVersion: 0,
    alias: "learner-safe",
    bio: null,
    showBio: false,
    showStreak: false,
    showMasterySummary: false,
    publish: false,
    selectedAchievementIds: [],
    selectedProjectIds: [],
    now: NOW,
    ...overrides,
  };
}

function successfulUpdateClient(options: {
  existing?: ReturnType<typeof profile> | null;
  consent?: { id: string; decision: string; policy_version: string } | null;
  achievementIds?: readonly string[];
  projectIds?: readonly string[];
} = {}) {
  const existing = options.existing ?? null;
  return mockClient(async (statement) => {
    if (statement.includes('select status, role from "user"')) {
      return { rows: [{ status: "active", role: "learner" }] };
    }
    if (statement.includes("select snapshot, resulting_version")) return { rows: [] };
    if (statement.includes("from cohort_profile where user_id") && statement.includes("for update")) {
      return { rows: existing ? [existing] : [] };
    }
    if (statement.includes("from consent_record")) {
      return { rows: options.consent ? [options.consent] : [] };
    }
    if (statement.includes("select id from user_achievement")) {
      return { rows: (options.achievementIds ?? []).map((id) => ({ id })) };
    }
    if (statement.includes("select id from project")) {
      return { rows: (options.projectIds ?? []).map((id) => ({ id })) };
    }
    return { rows: [] };
  });
}

function statements(query: ReturnType<typeof vi.fn>): string[] {
  return query.mock.calls.map((call) => String(call[0]));
}

describe("social evidence hashing", () => {
  it("is canonical across object insertion order and changes for arrays, primitives, and null", () => {
    const left = { z: [3, { b: true, a: null }], a: "value" };
    const right = { a: "value", z: [3, { a: null, b: true }] };
    expect(hashSocialEvidence(left)).toBe(hashSocialEvidence(right));
    expect(hashSocialEvidence(left)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSocialEvidence([1, 2])).not.toBe(hashSocialEvidence([2, 1]));
    expect(hashSocialEvidence(null)).not.toBe(hashSocialEvidence(false));
    expect(hashSocialEvidence("1")).not.toBe(hashSocialEvidence(1));
  });
});

describe("social consent lookup", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [{ id: "consent", decision: "accepted", policy_version: ENROLLMENT_DISCLOSURE_VERSION }, true],
    [{ id: "consent", decision: "declined", policy_version: ENROLLMENT_DISCLOSURE_VERSION }, false],
    [{ id: "consent", decision: "accepted", policy_version: "obsolete" }, false],
    [null, false],
  ])("accepts only the latest accepted current-version consent %#", async (row, accepted) => {
    const query = vi.fn().mockResolvedValue({ rows: row ? [row] : [] });
    const result = await isCurrentSocialConsentAccepted(
      { query } as never,
      USER_ID,
      "cohort_profile",
    );
    expect(Boolean(result)).toBe(accepted);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("from consent_record"), [USER_ID, "cohort_profile"]);
  });

  it("loads leaderboard consent through a released pooled client", async () => {
    const { release } = mockClient(async () => ({
      rows: [{ id: "consent", decision: "accepted", policy_version: ENROLLMENT_DISCLOSURE_VERSION }],
    }));
    await expect(hasLeaderboardConsent(USER_ID)).resolves.toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("cohort profile update validation and transactions", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [{ requestId: "bad" }, "INVALID_REQUEST"],
    [{ expectedVersion: 0.5 }, "INVALID_REQUEST"],
    [{ expectedVersion: -1 }, "INVALID_REQUEST"],
    [{ alias: "x" }, "INVALID_REQUEST"],
    [{ bio: "x".repeat(281) }, "INVALID_REQUEST"],
    [{ selectedAchievementIds: Array.from({ length: 101 }, () => ACHIEVEMENT_ID) }, "INVALID_REQUEST"],
    [{ selectedProjectIds: Array.from({ length: 101 }, () => PROJECT_ID) }, "INVALID_REQUEST"],
    [{ now: new Date(Number.NaN) }, "INVALID_REQUEST"],
    [{ selectedAchievementIds: ["bad"] }, "INVALID_SELECTION"],
    [{ selectedProjectIds: ["bad"] }, "INVALID_SELECTION"],
  ])("rejects invalid input before opening a connection %#", async (override, code) => {
    await expect(updateCohortProfile(validUpdate(override))).rejects.toEqual(
      expect.objectContaining({ code }),
    );
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    [[], "NOT_FOUND"],
    [[{ status: "disabled", role: "learner" }], "NOT_FOUND"],
    [[{ status: "active", role: "admin" }], "NOT_FOUND"],
  ])("rejects a missing, inactive, or non-learner actor %#", async (actorRows, code) => {
    const { query, release } = mockClient(async (statement) => {
      if (statement.includes('select status, role from "user"')) return { rows: actorRows };
      return { rows: [] };
    });
    await expect(updateCohortProfile(validUpdate())).rejects.toEqual(expect.objectContaining({ code }));
    expect(query).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  });

  it("replays an identical idempotent request and commits without rewriting the profile", async () => {
    const input = validUpdate({ alias: "  learner-safe  ", bio: "   " });
    const expectedHash = hashSocialEvidence({
      requestId: REQUEST_ID,
      alias: "learner-safe",
      bio: null,
      showBio: false,
      showStreak: false,
      showMasterySummary: false,
      publish: false,
      selectedAchievementIds: [],
      selectedProjectIds: [],
    });
    const { query, release } = mockClient(async (statement) => {
      if (statement.includes('select status, role from "user"')) return { rows: [{ status: "active", role: "learner" }] };
      if (statement.includes("select snapshot, resulting_version")) {
        return { rows: [{ snapshot: { requestHash: expectedHash }, resulting_version: "7" }] };
      }
      return { rows: [] };
    });
    await expect(updateCohortProfile(input)).resolves.toEqual({ rowVersion: 7, replayed: true });
    expect(query).toHaveBeenCalledWith("commit");
    expect(statements(query).some((statement) => statement.includes("insert into cohort_profile"))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects reuse of an idempotency key with different content", async () => {
    const { query } = mockClient(async (statement) => {
      if (statement.includes('select status, role from "user"')) return { rows: [{ status: "active", role: "learner" }] };
      if (statement.includes("select snapshot, resulting_version")) {
        return { rows: [{ snapshot: { requestHash: "different" }, resulting_version: 2 }] };
      }
      return { rows: [] };
    });
    await expect(updateCohortProfile(validUpdate())).rejects.toEqual(
      expect.objectContaining({ code: "IDEMPOTENCY_MISMATCH" }),
    );
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it.each([
    [null, 1],
    [profile({ row_version: "2" }), 1],
  ])("enforces optimistic profile versions %#", async (existing, expectedVersion) => {
    const { query } = successfulUpdateClient({ existing });
    await expect(updateCohortProfile(validUpdate({ expectedVersion }))).rejects.toEqual(
      expect.objectContaining({ code: "VERSION_CONFLICT" }),
    );
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it.each([
    [null],
    [{ id: "consent", decision: "declined", policy_version: ENROLLMENT_DISCLOSURE_VERSION }],
    [{ id: "consent", decision: "accepted", policy_version: "old" }],
  ])("requires current affirmative cohort consent before publication %#", async (consent) => {
    const { query } = successfulUpdateClient({ consent });
    await expect(updateCohortProfile(validUpdate({ publish: true }))).rejects.toEqual(
      expect.objectContaining({ code: "CONSENT_REQUIRED" }),
    );
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it.each([
    [{ selectedAchievementIds: [ACHIEVEMENT_ID] }, [], undefined],
    [{ selectedProjectIds: [PROJECT_ID] }, undefined, []],
  ])("rejects selected evidence that the learner does not own %#", async (override, achievementIds, projectIds) => {
    const { query } = successfulUpdateClient({ achievementIds, projectIds });
    await expect(updateCohortProfile(validUpdate(override))).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_SELECTION" }),
    );
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it("creates a private draft with normalized fields and no visibility notification", async () => {
    const { query, release } = successfulUpdateClient();
    await expect(updateCohortProfile(validUpdate({
      alias: "  learner-safe  ",
      bio: "  private bio  ",
    }))).resolves.toEqual({ rowVersion: 1, replayed: false, event: "created" });
    const eventCall = query.mock.calls.find((call) => String(call[0]).includes("insert into cohort_profile_event"));
    expect(eventCall?.[1]?.[2]).toBe("created");
    expect(String(eventCall?.[1]?.[3])).toContain('"alias":"learner-safe"');
    expect(String(eventCall?.[1]?.[3])).toContain('"bio":"private bio"');
    expect(statements(query).some((statement) => statement.includes("insert into notification"))).toBe(false);
    expect(query).toHaveBeenCalledWith("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("publishes a new profile with sorted unique owned selections and current consent", async () => {
    const consent = { id: "consent-current", decision: "accepted", policy_version: ENROLLMENT_DISCLOSURE_VERSION };
    const secondAchievement = "20000000-0000-4000-8000-000000000001";
    const { query } = successfulUpdateClient({
      consent,
      achievementIds: [secondAchievement, ACHIEVEMENT_ID],
      projectIds: [PROJECT_ID],
    });
    const result = await updateCohortProfile(validUpdate({
      publish: true,
      showBio: true,
      showStreak: true,
      showMasterySummary: true,
      selectedAchievementIds: [ACHIEVEMENT_ID, secondAchievement, ACHIEVEMENT_ID],
      selectedProjectIds: [PROJECT_ID],
    }));
    expect(result).toEqual({ rowVersion: 1, replayed: false, event: "published" });
    const achievementLookup = query.mock.calls.find((call) => String(call[0]).includes("select id from user_achievement"));
    expect(achievementLookup?.[1]?.[1]).toEqual([secondAchievement, ACHIEVEMENT_ID]);
    expect(statements(query).some((statement) => statement.includes("insert into notification"))).toBe(true);
    const notification = query.mock.calls.find((call) => String(call[0]).includes("insert into notification"));
    expect(notification?.[1]?.[1]).toBe("Cohort profile published");
  });

  it.each([
    [profile({ is_published: true }), false, "withdrawn", "Cohort profile withdrawn"],
    [profile({ is_published: false }), true, "published", "Cohort profile published"],
    [profile({ is_published: true }), true, "updated", "Cohort profile updated"],
    [profile({ is_published: false }), false, "updated", null],
  ])("derives transition event and notification for existing profiles %#", async (existing, publish, event, title) => {
    const consent = publish
      ? { id: "consent-current", decision: "accepted", policy_version: ENROLLMENT_DISCLOSURE_VERSION }
      : null;
    const { query } = successfulUpdateClient({ existing, consent });
    await expect(updateCohortProfile(validUpdate({ expectedVersion: 1, publish }))).resolves.toMatchObject({ event });
    const notification = query.mock.calls.find((call) => String(call[0]).includes("insert into notification"));
    if (title) expect(notification?.[1]?.[1]).toBe(title);
    else expect(notification).toBeUndefined();
    const eventCall = query.mock.calls.find((call) => String(call[0]).includes("insert into cohort_profile_event"));
    expect(eventCall?.[1]?.[2]).toBe(event);
  });

  it("maps only the profile alias unique constraint to ALIAS_TAKEN", async () => {
    const { query, release } = mockClient(async (statement) => {
      if (statement.includes('select status, role from "user"')) return { rows: [{ status: "active", role: "learner" }] };
      if (statement.includes("select snapshot, resulting_version") || statement.includes("from cohort_profile")) return { rows: [] };
      if (statement.includes("insert into cohort_profile")) {
        throw { code: "23505", constraint: "cohort_profile_alias_unique" };
      }
      return { rows: [] };
    });
    await expect(updateCohortProfile(validUpdate())).rejects.toEqual(
      expect.objectContaining({ code: "ALIAS_TAKEN" }),
    );
    expect(query).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves unexpected database errors even when rollback also fails", async () => {
    const failure = new Error("database unavailable");
    const { release } = mockClient(async (statement) => {
      if (statement === "begin") return { rows: [] };
      if (statement === "rollback") throw new Error("rollback unavailable");
      throw failure;
    });
    await expect(updateCohortProfile(validUpdate())).rejects.toBe(failure);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("consent-triggered profile withdrawal", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an invalid consent request id before connecting", async () => {
    await expect(withdrawCohortProfileForConsent({ userId: USER_ID, consentRequestId: "bad" })).rejects.toEqual(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each([
    [null, null, { withdrawn: false, replayed: false }, false],
    [profile({ is_published: true, row_version: "4" }), { id: "prior" }, { withdrawn: true, replayed: true }, false],
    [profile({ is_published: true, row_version: "4" }), null, { withdrawn: true, replayed: false }, true],
  ])("hides projections and writes one idempotent withdrawal event %#", async (existing, prior, expected, writesEvent) => {
    const { query, release } = mockClient(async (statement) => {
      if (statement.includes("select * from cohort_profile")) return { rows: existing ? [existing] : [] };
      if (statement.includes("select id from cohort_profile_event")) return { rows: prior ? [prior] : [] };
      return { rows: [] };
    });
    await expect(withdrawCohortProfileForConsent({
      userId: USER_ID,
      consentRequestId: REQUEST_ID,
      now: NOW,
    })).resolves.toEqual(expected);
    expect(statements(query).some((statement) => statement.includes("update user_achievement set visibility = 'private'"))).toBe(true);
    expect(statements(query).some((statement) => statement.includes("update project set visibility = 'private'"))).toBe(true);
    expect(statements(query).some((statement) => statement.includes("insert into cohort_profile_event"))).toBe(writesEvent);
    expect(statements(query).some((statement) => statement.includes("insert into notification"))).toBe(writesEvent);
    expect(query).toHaveBeenCalledWith("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back and releases on withdrawal failure", async () => {
    const failure = new Error("write failed");
    const { query, release } = mockClient(async (statement) => {
      if (statement === "begin") return { rows: [] };
      if (statement === "rollback") return { rows: [] };
      throw failure;
    });
    await expect(withdrawCohortProfileForConsent({
      userId: USER_ID,
      consentRequestId: REQUEST_ID,
    })).rejects.toBe(failure);
    expect(query).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("own and visible cohort profile projections", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a missing active owner and releases the client", async () => {
    const { release } = mockClient(async () => ({ rows: [] }));
    await expect(loadOwnCohortSettings(USER_ID, NOW)).rejects.toEqual(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns privacy-safe defaults, suggested alias, selections, and a yesterday-based streak", async () => {
    let consentQuery = 0;
    const { release } = mockClient(async (statement) => {
      if (statement.includes('select public_id from "user"')) return { rows: [{ public_id: PUBLIC_ID }] };
      if (statement.includes("select * from cohort_profile")) return { rows: [] };
      if (statement.includes("from consent_record")) {
        consentQuery += 1;
        return { rows: consentQuery === 1
          ? [{ id: "old", decision: "accepted", policy_version: "obsolete" }]
          : [{ id: "leader", decision: "declined", policy_version: ENROLLMENT_DISCLOSURE_VERSION }] };
      }
      if (statement.includes("join achievement")) return { rows: [{ id: ACHIEVEMENT_ID, title: "Badge", description: "D", icon: "star", visibility: "private" }] };
      if (statement.includes("select id,title,summary,status,visibility from project")) return { rows: [{ id: PROJECT_ID, title: "P", summary: "S", status: "idea", visibility: "private" }] };
      if (statement.includes("from concept_mastery")) return { rows: [] };
      if (statement.includes("from learning_session_event")) return { rows: [{ day_key: "2026-07-11" }, { day_key: "2026-07-10" }] };
      throw new Error("Unexpected query: " + statement);
    });
    const settings = await loadOwnCohortSettings(USER_ID, NOW);
    expect(settings).toMatchObject({
      consent: { cohortProfile: false, leaderboard: false },
      live: false,
      profile: {
        alias: "learner-40000000",
        bio: "",
        isPublished: false,
        showBio: false,
        showStreak: false,
        showMasterySummary: false,
        rowVersion: 0,
      },
      availableAggregates: { streak: 2, masteredConcepts: 0 },
      livePreview: null,
    });
    expect(settings.badges[0]).toMatchObject({ id: ACHIEVEMENT_ID, selected: false });
    expect(settings.projects[0]).toMatchObject({ id: PROJECT_ID, selected: false });
    expect(settings.exclusionNotice).toContain("Email");
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns a live preview only when current consent id matches the publication", async () => {
    const liveProfile = profile({
      public_id: PUBLIC_ID,
      is_published: true,
      published_consent_record_id: "cohort-consent",
      show_bio: true,
      show_streak: true,
      show_mastery_summary: true,
      selected_achievement_ids: [ACHIEVEMENT_ID],
      selected_project_ids: [PROJECT_ID],
      row_version: 3,
    });
    const { release } = mockClient(async (statement, parameters) => {
      if (statement.includes('select public_id from "user"')) return { rows: [{ public_id: PUBLIC_ID }] };
      if (statement.startsWith("select * from cohort_profile")) return { rows: [liveProfile] };
      if (statement.includes("from cohort_profile cp join")) return { rows: [liveProfile] };
      if (statement.includes("from consent_record")) {
        return { rows: [{
          id: parameters?.[1] === "cohort_profile" ? "cohort-consent" : "leader-consent",
          decision: "accepted",
          policy_version: ENROLLMENT_DISCLOSURE_VERSION,
        }] };
      }
      if (statement.includes("ua.visibility = 'cohort'")) return { rows: [{ id: ACHIEVEMENT_ID, title: "Badge", description: "D", icon: "star" }] };
      if (statement.includes("visibility = 'cohort'")) return { rows: [{ id: PROJECT_ID, title: "Project", summary: "S", status: "done" }] };
      if (statement.includes("join achievement")) return { rows: [{ id: ACHIEVEMENT_ID, title: "Badge", description: "D", icon: "star", visibility: "cohort" }] };
      if (statement.includes("select id,title,summary,status,visibility from project")) return { rows: [{ id: PROJECT_ID, title: "Project", summary: "S", status: "done", visibility: "cohort" }] };
      if (statement.includes("from concept_mastery")) return { rows: [{ mastered: "6" }] };
      if (statement.includes("from learning_session_event")) return { rows: [{ day_key: "2026-07-12" }, { day_key: "2026-07-11" }] };
      throw new Error("Unexpected query: " + statement);
    });
    const settings = await loadOwnCohortSettings(USER_ID, NOW);
    expect(settings.consent).toEqual({ cohortProfile: true, leaderboard: true });
    expect(settings.live).toBe(true);
    expect(settings.profile.rowVersion).toBe(3);
    expect(settings.badges[0]?.selected).toBe(true);
    expect(settings.projects[0]?.selected).toBe(true);
    expect(settings.livePreview).toMatchObject({
      publicId: PUBLIC_ID,
      alias: "learner-safe",
      bio: "A short bio",
      streak: 2,
      masteredConcepts: 6,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["bad", REQUEST_ID])("returns NOT_FOUND for invalid, unknown, or hidden public profiles %#", async (publicId) => {
    if (publicId === REQUEST_ID) mocks.poolQuery.mockResolvedValue({ rows: [] });
    await expect(loadVisibleCohortProfile(publicId, NOW)).rejects.toEqual(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    if (publicId === "bad") expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it("rejects an active target whose profile is not currently visible", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ id: USER_ID }] });
    const { release } = mockClient(async () => ({ rows: [] }));
    await expect(loadVisibleCohortProfile(PUBLIC_ID, NOW)).rejects.toEqual(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("loads a minimal visible projection without optional bio, streak, or mastery fields", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [{ id: USER_ID }] });
    const minimal = profile({ public_id: PUBLIC_ID, is_published: true, bio: "", show_bio: false });
    const { release } = mockClient(async (statement) => {
      if (statement.includes("from cohort_profile cp join")) return { rows: [minimal] };
      if (statement.includes("ua.visibility = 'cohort'")) return { rows: [] };
      if (statement.includes("visibility = 'cohort'")) return { rows: [] };
      throw new Error("Unexpected query: " + statement);
    });
    const result = await loadVisibleCohortProfile(PUBLIC_ID, NOW);
    expect(result).toEqual({ publicId: PUBLIC_ID, alias: "learner-safe", badges: [], projects: [] });
    expect(release).toHaveBeenCalledOnce();
  });

  it("lists only service-projected owner identifiers and aliases", async () => {
    mocks.poolQuery.mockResolvedValue({ rows: [
      { user_id: "u1", public_id: PUBLIC_ID, alias: "Alpha" },
      { user_id: "u2", public_id: REQUEST_ID, alias: "Beta" },
    ] });
    await expect(listVisibleProfileOwners()).resolves.toEqual([
      { userId: "u1", publicId: PUBLIC_ID, alias: "Alpha" },
      { userId: "u2", publicId: REQUEST_ID, alias: "Beta" },
    ]);
    expect(mocks.poolQuery).toHaveBeenCalledWith(expect.stringContaining("where cp.is_published"), [ENROLLMENT_DISCLOSURE_VERSION]);
  });
});
