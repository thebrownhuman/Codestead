import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), connect: vi.fn(), clientQuery: vi.fn(), release: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query, connect: mocks.connect } }));
import { loadLearnerModelSettings, ModelChoiceError, saveLearnerModelChoice } from "../learner-model-choice-store";

const key = "10000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  mocks.clientQuery.mockResolvedValue({ rowCount: 1, rows: [] });
});

it("reads the saved choice only from the session-owned profile", async () => {
  mocks.query.mockImplementation((sql: string, values?: unknown[]) => {
    if (sql.includes("FROM provider_policy")) return Promise.resolve({ rows: [
      { id: key, provider: "openai", model: "test-model", operation: "tutor", enabled: true, priority: 1 },
    ] });
    expect(sql).toContain("WHERE user_id=$1");
    expect(values).toEqual(["owner"]);
    return Promise.resolve({ rows: [{ preferred_ai_model_policy_id: key }] });
  });
  expect(await loadLearnerModelSettings("owner")).toMatchObject({ selectedKey: key, unavailable: false });
});

it("uses the default when the session owner has no profile", async () => {
  mocks.query.mockResolvedValue({ rows: [] });
  expect(await loadLearnerModelSettings("owner")).toMatchObject({ selectedKey: null, unavailable: false });
});

it.each([key, null])("commits a validated choice for the owner: %s", async (choice) => {
  await saveLearnerModelChoice("owner", choice);
  const save = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO learner_profile"));
  expect(save?.[1]).toEqual(["owner", choice]);
  expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  const lock = mocks.clientQuery.mock.calls.find(([sql]) => String(sql).includes("FOR SHARE"));
  if (choice === null) expect(lock).toBeUndefined();
  else {
    expect(lock?.[0]).toContain("operation='tutor' AND enabled=true");
    expect(lock?.[1]).toEqual([key]);
  }
  expect(mocks.release).toHaveBeenCalledOnce();
});

it.each([0, null])("rolls back an unavailable policy without changing the profile: %s", async (rowCount) => {
  mocks.clientQuery.mockImplementation((sql: string) => Promise.resolve({ rowCount: sql.includes("FOR SHARE") ? rowCount : 1 }));
  await expect(saveLearnerModelChoice("owner", key)).rejects.toBeInstanceOf(ModelChoiceError);
  expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO learner_profile"))).toBe(false);
  expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  expect(mocks.release).toHaveBeenCalledOnce();
});

it("rolls back a write failure and releases the transaction connection", async () => {
  const failure = new Error("synthetic profile write failure");
  mocks.clientQuery.mockImplementation((sql: string) => sql.includes("INSERT INTO learner_profile")
    ? Promise.reject(failure) : Promise.resolve({ rowCount: 1 }));
  await expect(saveLearnerModelChoice("owner", key)).rejects.toBe(failure);
  expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  expect(mocks.release).toHaveBeenCalledOnce();
});

it("releases the connection even if rollback fails", async () => {
  const failure = new Error("synthetic rollback failure");
  mocks.clientQuery.mockImplementation((sql: string) => sql === "ROLLBACK"
    ? Promise.reject(failure) : Promise.resolve({ rowCount: 0 }));
  await expect(saveLearnerModelChoice("owner", key)).rejects.toBe(failure);
  expect(mocks.release).toHaveBeenCalledOnce();
});
