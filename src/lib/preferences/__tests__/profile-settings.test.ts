import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
const mocks = vi.hoisted(() => {
  const limit = vi.fn(); const where = vi.fn<(condition: SQL) => { limit: typeof limit }>(() => ({ limit })); const from = vi.fn(() => ({ where })); const select = vi.fn(() => ({ from }));
  const upsert = vi.fn(); const values = vi.fn(() => ({ onConflictDoUpdate: upsert })); const insert = vi.fn(() => ({ values }));
  const tx = { select, insert, execute: vi.fn() };
  const clientQuery = vi.fn(async (_statement: string) => ({ rows: [] }));
  const client = { query: clientQuery, release: vi.fn() };
  return { limit, where, select, insert, values, upsert, tx, transaction: vi.fn((action: (transaction: typeof tx) => unknown) => action(tx)), connect: vi.fn(async () => client), client, clientQuery, cohort: vi.fn(), publish: vi.fn(), lock: vi.fn() };
});
vi.mock("@/lib/db/client", () => ({ db: { ...mocks.tx, transaction: mocks.transaction }, pool: { connect: mocks.connect } }));
vi.mock("drizzle-orm/node-postgres", () => ({ drizzle: () => mocks.tx }));
vi.mock("@/lib/security/user-authority-lock", () => ({ lockUserAuthority: mocks.lock }));
vi.mock("@/lib/social/profile-service", () => ({ loadOwnCohortSettings: mocks.cohort, updateCohortProfile: mocks.publish, updateCohortProfileInTransaction: mocks.publish, SocialProfileError: class SocialProfileError extends Error {} }));
import { loadLearningProfile, saveLearningProfile } from "../profile-settings";
import { SocialProfileError } from "@/lib/social/profile-service";
const statements = () => mocks.clientQuery.mock.calls.map(([statement]) => statement);
const input = { name: "Actual Name", bio: "Private learning bio", analogyFrequency: "frequent" as const, cohortVisibility: "selected" as const, profileVersion: 1, cohortVersion: 2, requestId: "b1000000-0000-4000-8000-000000000001" };
const cohort = { live: false, consent: { cohortProfile: true }, profile: { rowVersion: 2, alias: "my-alias", bio: "Explicit public bio", showBio: false, showStreak: false, showMasterySummary: false }, badges: [{ id: "badge-own", selected: true }, { id: "badge-other", selected: false }], projects: [{ id: "project-own", selected: true }] };
beforeEach(() => { vi.clearAllMocks(); mocks.cohort.mockResolvedValue(cohort); mocks.limit.mockReset(); mocks.upsert.mockResolvedValue(undefined); mocks.publish.mockResolvedValue({}); });
describe("existing profile persistence and cohort privacy", () => {
  it("loads owned preferences rather than demo defaults", async () => {
    mocks.limit.mockResolvedValue([{ bio: "Stored bio", analogyFrequency: "neutral", rowVersion: 3 }]);
    expect(await loadLearningProfile("owner", "Signed In", "learner")).toMatchObject({ name: "Signed In", bio: "Stored bio", analogyFrequency: "neutral", profileVersion: 3, cohortAlias: "my-alias", cohortVisibility: "hidden" });
    expect(new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]).params).toEqual(["owner"]);
  });
  it("saves owned preferences without replacing onboarding fields or publishing the private name/bio", async () => {
    mocks.limit.mockResolvedValueOnce([{ status: "active" }]).mockResolvedValueOnce([{ rowVersion: 1 }]);
    await saveLearningProfile("owner", "learner", input);
    expect(mocks.lock).toHaveBeenCalledWith(mocks.tx, "owner");
    expect(mocks.values).toHaveBeenCalledWith({ userId: "owner", bio: input.bio, analogyFrequency: "frequent" });
    expect(mocks.publish).toHaveBeenCalledWith(mocks.client, expect.objectContaining({ actorUserId: "owner", alias: "my-alias", bio: "Explicit public bio", publish: true, showBio: false, selectedAchievementIds: ["badge-own"], selectedProjectIds: ["project-own"] }));
    expect(JSON.stringify(mocks.publish.mock.calls)).not.toContain(input.bio);
    expect(JSON.stringify(mocks.publish.mock.calls)).not.toContain(input.name);
  });
  it("writes preferences and cohort visibility in one transaction on one client", async () => {
    mocks.limit.mockResolvedValueOnce([{ status: "active" }]).mockResolvedValueOnce([{ rowVersion: 1 }]);
    await saveLearningProfile("owner", "learner", input);
    expect(mocks.publish).toHaveBeenCalledWith(mocks.client, expect.objectContaining({ actorUserId: "owner" }));
    expect(statements()).toEqual(["begin", "commit"]);
    expect(mocks.client.release).toHaveBeenCalledOnce();
  });
  it("rolls the preferences back when the cohort update fails", async () => {
    mocks.limit.mockResolvedValueOnce([{ status: "active" }]).mockResolvedValueOnce([{ rowVersion: 1 }]);
    mocks.publish.mockRejectedValueOnce(new SocialProfileError("VERSION_CONFLICT"));
    await expect(saveLearningProfile("owner", "learner", input)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("nothing was saved") });
    expect(mocks.upsert).toHaveBeenCalledOnce();
    expect(statements()).toEqual(["begin", "rollback"]);
    expect(mocks.client.release).toHaveBeenCalledOnce();
  });
  it("rolls back and releases the client on an unexpected cohort failure", async () => {
    mocks.limit.mockResolvedValueOnce([{ status: "active" }]).mockResolvedValueOnce([{ rowVersion: 1 }]);
    mocks.publish.mockRejectedValueOnce(new Error("connection reset"));
    await expect(saveLearningProfile("owner", "learner", input)).rejects.toThrow("connection reset");
    expect(statements()).toEqual(["begin", "rollback"]);
    expect(mocks.client.release).toHaveBeenCalledOnce();
  });
  it("requires current sharing consent before any writes", async () => {
    mocks.cohort.mockResolvedValue({ ...cohort, consent: { cohortProfile: false } });
    await expect(saveLearningProfile("owner", "learner", input)).rejects.toMatchObject({ status: 400 }); expect(mocks.transaction).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("rejects stale preferences without overwriting them", async () => {
    mocks.limit.mockResolvedValueOnce([{ status: "active" }]).mockResolvedValueOnce([{ rowVersion: 9 }]);
    await expect(saveLearningProfile("owner", "learner", input)).rejects.toMatchObject({ status: 409 }); expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("rechecks active authority inside the transaction", async () => {
    mocks.limit.mockResolvedValueOnce([{ status: "deleted" }]);
    await expect(saveLearningProfile("owner", "learner", input)).rejects.toMatchObject({ status: 403 }); expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("alias-only clears every optional public field and selected item", async () => {
    mocks.limit.mockResolvedValueOnce([{ status: "active" }]).mockResolvedValueOnce([{ rowVersion: 1 }]);
    await saveLearningProfile("owner", "learner", { ...input, cohortVisibility: "alias" });
    expect(mocks.publish).toHaveBeenCalledWith(mocks.client, expect.objectContaining({ publish: true, showBio: false, showStreak: false, showMasterySummary: false, selectedAchievementIds: [], selectedProjectIds: [] }));
  });
  it("withdraws a live profile through the existing cohort service", async () => {
    mocks.cohort.mockResolvedValue({ ...cohort, live: true }); mocks.limit.mockResolvedValueOnce([{ status: "active" }]).mockResolvedValueOnce([{ rowVersion: 1 }]);
    await saveLearningProfile("owner", "learner", { ...input, cohortVisibility: "hidden" }); expect(mocks.publish).toHaveBeenCalledWith(mocks.client, expect.objectContaining({ publish: false }));
  });
});
