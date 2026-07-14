import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  DraftIdempotencyMismatchError,
  DraftQuotaExceededError,
  DraftScopeUnavailableError,
  DraftVersionConflictError,
  PostgresLearnerDraftRepository,
  type DraftDatabase,
} from "../repository";
import type { SaveLearnerDraftInput } from "../types";

const NOW = new Date("2026-07-12T10:02:00.000Z");
const input: SaveLearnerDraftInput = {
  userId: "learner-1",
  kind: "code",
  courseId: "python",
  skillId: "python.variables",
  language: "python",
  content: "answer = 42\n",
  expectedRowVersion: 0,
  requestId: "10000000-0000-4000-8000-000000000001",
};
const row = {
  id: "20000000-0000-4000-8000-000000000001",
  user_id: "learner-1",
  kind: "code",
  course_id: "python",
  skill_id: "python.variables",
  language: "python",
  content: "answer = 42\n",
  row_version: "1",
  created_at: "2026-07-12T10:00:00.000Z",
  updated_at: "2026-07-12T10:01:00.000Z",
};

type Step = { rows: Record<string, unknown>[] } | Error;

function database(steps: Step[]) {
  const query = vi.fn(async (...args: [statement: string, values?: readonly unknown[]]) => {
    void args;
    const step = steps.shift();
    if (!step) throw new Error("Unexpected query");
    if (step instanceof Error) throw step;
    return step;
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { value: { connect } as unknown as DraftDatabase, query, release, steps };
}

function hash(value: SaveLearnerDraftInput) {
  return createHash("sha256")
    .update("learncoding-draft-mutation-v1\0")
    .update(JSON.stringify({
      userId: value.userId,
      kind: value.kind,
      courseId: value.courseId,
      skillId: value.skillId,
      language: value.language,
      content: value.content,
      expectedRowVersion: value.expectedRowVersion,
    }))
    .digest("hex");
}

describe("PostgresLearnerDraftRepository", () => {
  it("loads by the complete authenticated owner scope and maps PostgreSQL values", async () => {
    const fake = database([{ rows: [{ allowed: true }] }, { rows: [row] }]);
    const repository = new PostgresLearnerDraftRepository(fake.value);
    await expect(repository.load("learner-1", input)).resolves.toEqual({
      id: row.id,
      kind: "code",
      courseId: "python",
      skillId: "python.variables",
      language: "python",
      content: "answer = 42\n",
      rowVersion: 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    expect(fake.query).toHaveBeenCalledWith(expect.stringContaining("where user_id = $1"), [
      "learner-1", "code", "python", "python.variables", "python",
    ]);
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("returns null on a cache-independent server miss and always releases", async () => {
    const fake = database([{ rows: [{ allowed: true }] }, { rows: [] }]);
    const repository = new PostgresLearnerDraftRepository(fake.value);
    await expect(repository.load("learner-1", input)).resolves.toBeNull();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("allows only the exact authenticated platform playground scratchpad without curriculum enrollment", async () => {
    const playground = {
      ...input,
      courseId: "python",
      skillId: "free-playground",
      language: "python",
    };
    const fake = database([{ rows: [] }]);
    const repository = new PostgresLearnerDraftRepository(fake.value);

    await expect(repository.load("learner-1", playground)).resolves.toBeNull();
    expect(fake.query).toHaveBeenCalledOnce();
    expect(String(fake.query.mock.calls[0]?.[0])).toContain("from learner_draft");
    expect(fake.query.mock.calls[0]?.[1]).toEqual([
      "learner-1", "code", "python", "free-playground", "python",
    ]);
  });

  it("does not let neighboring synthetic playground scopes bypass curriculum authorization", async () => {
    for (const playground of [
      { ...input, courseId: "python", skillId: "free-playground-copy", language: "python" },
      { ...input, courseId: "python", skillId: "free-playground", language: "cpp" },
    ]) {
      const fake = database([{ rows: [] }]);
      const repository = new PostgresLearnerDraftRepository(fake.value);
      await expect(repository.load("learner-1", playground)).rejects.toBeInstanceOf(DraftScopeUnavailableError);
      expect(String(fake.query.mock.calls[0]?.[0])).toContain("from enrollment");
    }
  });

  it("rejects arbitrary or unpublished curriculum scopes before reading draft text", async () => {
    const fake = database([{ rows: [] }]);
    const repository = new PostgresLearnerDraftRepository(fake.value);
    await expect(repository.load("learner-1", input)).rejects.toBeInstanceOf(DraftScopeUnavailableError);
    expect(fake.query).toHaveBeenCalledOnce();
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("normalizes the enrolled or profile DSA language before authorizing a runner draft", async () => {
    const fake = database([{ rows: [{ allowed: true }] }, { rows: [] }]);
    const repository = new PostgresLearnerDraftRepository(fake.value);

    await expect(repository.load("learner-1", {
      kind: "code",
      courseId: "dsa",
      skillId: "dsa.arrays",
      language: "cpp",
    })).resolves.toBeNull();

    const authorizationSql = String(fake.query.mock.calls[0]?.[0]);
    expect(authorizationSql).toContain("left join learner_profile");
    expect(authorizationSql).toContain("coalesce(nullif(trim(e.implementation_language), ''), lp.dsa_language");
    expect(authorizationSql).toContain("when 'c++' then 'cpp'");
    expect(fake.query.mock.calls[0]?.[1]).toEqual([
      "learner-1", "dsa", "dsa.arrays", "code", "cpp",
    ]);
  });

  it("creates version one and a durable receipt in one transaction", async () => {
    const fake = database([
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [{ allowed: true }] }, { rows: [] }, { rows: [] },
      { rows: [{ record_count: 0, total_bytes: 0 }] }, { rows: [row] },
      { rows: [] }, { rows: [] },
    ]);
    const repository = new PostgresLearnerDraftRepository(fake.value, () => NOW);
    await expect(repository.save(input)).resolves.toMatchObject({
      replayed: false,
      committedRowVersion: 1,
      draft: { content: input.content, rowVersion: 1 },
    });
    expect(fake.query.mock.calls.map(([statement]) => String(statement).trim().split(/\s+/)[0])).toEqual([
      "begin", "select", "select", "select", "select", "select", "select", "select", "insert", "insert", "commit",
    ]);
    const receipt = fake.query.mock.calls[9];
    expect(receipt?.[1]).toEqual([
      input.requestId, row.id, hash(input), 0, 1, NOW,
    ]);
    expect(fake.steps).toHaveLength(0);
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("updates only the expected owner/version and increments once", async () => {
    const updateInput = { ...input, expectedRowVersion: 1, requestId: "10000000-0000-4000-8000-000000000002" };
    const current = { ...row, row_version: 1 };
    const changed = { ...row, row_version: 2, updated_at: NOW };
    const fake = database([
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [{ allowed: true }] }, { rows: [] }, { rows: [current] },
      { rows: [{ record_count: 1, total_bytes: 12 }] }, { rows: [changed] },
      { rows: [] }, { rows: [] },
    ]);
    const repository = new PostgresLearnerDraftRepository(fake.value, () => NOW);
    await expect(repository.save(updateInput)).resolves.toMatchObject({ committedRowVersion: 2 });
    expect(fake.query.mock.calls[8]?.[0]).toContain("where id = $4 and user_id = $5 and row_version = $6");
    expect(fake.query.mock.calls[8]?.[1]).toEqual([
      "python", "answer = 42\n", NOW, row.id, "learner-1", 1,
    ]);
  });

  it("replays an old receipt while returning the current newer draft", async () => {
    const current = {
      ...row,
      content: "newer = true\n",
      row_version: "4",
      input_hash: hash(input),
      resulting_row_version: "1",
    };
    const fake = database([{ rows: [] }, { rows: [] }, { rows: [current] }, { rows: [] }]);
    const repository = new PostgresLearnerDraftRepository(fake.value);
    await expect(repository.save(input)).resolves.toMatchObject({
      replayed: true,
      committedRowVersion: 1,
      draft: { content: "newer = true\n", rowVersion: 4 },
    });
    expect(fake.query.mock.calls.map(([statement]) => String(statement).trim())).toEqual([
      "begin",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("learner_draft_mutation"),
      "commit",
    ]);
  });

  it("rejects a receipt owned by another scope or containing another payload hash", async () => {
    for (const replay of [
      { ...row, user_id: "learner-2", input_hash: hash(input), resulting_row_version: 1 },
      { ...row, input_hash: "f".repeat(64), resulting_row_version: 1 },
    ]) {
      const fake = database([{ rows: [] }, { rows: [] }, { rows: [replay] }, { rows: [] }]);
      const repository = new PostgresLearnerDraftRepository(fake.value);
      await expect(repository.save(input)).rejects.toBeInstanceOf(DraftIdempotencyMismatchError);
      expect(fake.query.mock.calls.at(-1)?.[0]).toBe("rollback");
      expect(fake.release).toHaveBeenCalledOnce();
    }
  });

  it("returns the current record on a stale optimistic version and never writes", async () => {
    const current = { ...row, row_version: "3", content: "server = 3\n" };
    const fake = database([
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [{ allowed: true }] }, { rows: [] }, { rows: [current] }, { rows: [] },
    ]);
    const repository = new PostgresLearnerDraftRepository(fake.value);
    let error: unknown;
    try { await repository.save(input); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(DraftVersionConflictError);
    expect((error as DraftVersionConflictError).current).toMatchObject({ rowVersion: 3, content: "server = 3\n" });
    expect(fake.query.mock.calls.some(([statement]) => /^\s*(insert|update) learner_draft/i.test(String(statement)))).toBe(false);
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("serializes and rejects aggregate record quota overflow before inserting", async () => {
    const fake = database([
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [{ allowed: true }] }, { rows: [] }, { rows: [] },
      { rows: [{ record_count: 512, total_bytes: 1_024 }] }, { rows: [] },
    ]);
    const repository = new PostgresLearnerDraftRepository(fake.value);
    await expect(repository.save(input)).rejects.toMatchObject(
      new DraftQuotaExceededError("records"),
    );
    expect(fake.query.mock.calls.some(([, values]) => values?.includes("draft-account-quota:learner-1"))).toBe(true);
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("maps a database-trigger quota race to the stable application error", async () => {
    const trigger = Object.assign(new Error("learner draft byte quota exceeded"), { code: "23514" });
    const fake = database([
      { rows: [] }, { rows: [] }, { rows: [] }, { rows: [] },
      { rows: [{ allowed: true }] }, { rows: [] }, { rows: [] },
      { rows: [{ record_count: 1, total_bytes: 1 }] }, trigger, { rows: [] },
    ]);
    const repository = new PostgresLearnerDraftRepository(fake.value);
    await expect(repository.save(input)).rejects.toMatchObject(
      new DraftQuotaExceededError("bytes"),
    );
    expect(fake.query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("rolls back infrastructure failures and rejects invalid database rows", async () => {
    const failed = database([{ rows: [] }, { rows: [] }, new Error("database unavailable"), { rows: [] }]);
    await expect(new PostgresLearnerDraftRepository(failed.value).save(input)).rejects.toThrow("database unavailable");
    expect(failed.query.mock.calls.at(-1)?.[0]).toBe("rollback");
    expect(failed.release).toHaveBeenCalledOnce();

    const invalid = database([{ rows: [{ allowed: true }] }, { rows: [{ ...row, row_version: "0" }] }]);
    await expect(new PostgresLearnerDraftRepository(invalid.value).load("learner-1", input)).rejects.toThrow(/row version/i);
    expect(invalid.release).toHaveBeenCalledOnce();
  });
});
