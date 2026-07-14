import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  pool: {
    connect: dbMocks.connect,
    query: dbMocks.query,
  },
}));

import {
  createProjectRevision,
  getProjectRevision,
  listProjectRevisions,
  MAX_PROJECT_REVISION_FILES,
  MAX_PROJECT_REVISION_PAGE,
  normalizeRevisionMutation,
  ProjectRevisionError,
  projectRevisionInputHash,
} from "../revision-service";

const projectId = "11000000-0000-4000-8000-000000000001";
const requestId = "11000000-0000-4000-8000-000000000002";
const fileA = "11000000-0000-4000-8000-000000000003";
const fileB = "11000000-0000-4000-8000-000000000004";
const userId = "learner-1";
const revisionId = "11000000-0000-4000-8000-000000000005";
const sessionId = "11000000-0000-4000-8000-000000000006";
const now = new Date("2026-07-12T10:11:12.000Z");

type QueryResult = { rows: unknown[]; rowCount?: number };
type QueryCall = { statement: string; values: unknown[] };

function normalizedSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim().toLowerCase();
}

function revisionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: revisionId,
    project_id: projectId,
    sequence: 1,
    change_summary: "Added a durable learner checkpoint.",
    reflection: "The transaction boundary is clearer now.",
    created_at: now,
    ...overrides,
  };
}

function linkedFile(overrides: Record<string, unknown> = {}) {
  return {
    revision_id: revisionId,
    object_id: fileA,
    original_name: "proof #1.ts",
    media_type: "text/typescript",
    size_bytes: "42",
    sha256: "a".repeat(64),
    available: true,
    ...overrides,
  };
}

type CreateScenario = {
  owned?: boolean;
  prior?: { id: string; input_hash: string } | null;
  latest?: number;
  omitLatestRow?: boolean;
  objects?: Array<{
    id: string;
    original_name: string;
    media_type: string;
    size_bytes: string | number;
    sha256: string;
  }>;
  createdId?: string | null;
  activeSession?: string | null;
  loadedRevision?: ReturnType<typeof revisionRow> | null;
  loadedFiles?: ReturnType<typeof linkedFile>[];
  failAt?: string;
  rollbackFails?: boolean;
};

function createHarness(scenario: CreateScenario = {}) {
  const calls: QueryCall[] = [];
  let released = false;
  const query = vi.fn(async (sqlInput: string, values: unknown[] = []): Promise<QueryResult> => {
    const statement = normalizedSql(sqlInput);
    calls.push({ statement, values });
    if (scenario.failAt && statement.includes(scenario.failAt)) {
      throw new Error(`database failed at ${scenario.failAt}`);
    }
    if (statement === "begin" || statement === "commit") return { rows: [] };
    if (statement === "rollback") {
      if (scenario.rollbackFails) throw new Error("rollback failed");
      return { rows: [] };
    }
    if (statement.startsWith("select id from project where")) {
      return { rows: scenario.owned === false ? [] : [{ id: projectId }] };
    }
    if (statement.startsWith("select id, input_hash from project_revision")) {
      return { rows: scenario.prior ? [scenario.prior] : [] };
    }
    if (statement.startsWith("select coalesce(max(sequence)")) {
      return { rows: scenario.omitLatestRow ? [] : [{ latest: scenario.latest ?? 0 }] };
    }
    if (statement.includes("from stored_object") && statement.includes("for share")) {
      return { rows: scenario.objects ?? [] };
    }
    if (statement.startsWith("insert into project_revision ")) {
      const createdId = scenario.createdId === undefined ? revisionId : scenario.createdId;
      return { rows: createdId ? [{ id: createdId }] : [] };
    }
    if (statement.startsWith("insert into project_revision_object")) return { rows: [] };
    if (statement.startsWith("update project set updated_at")) return { rows: [] };
    if (statement.startsWith("select id from learning_session")) {
      const activeSession = scenario.activeSession === undefined ? sessionId : scenario.activeSession;
      return { rows: activeSession ? [{ id: activeSession }] : [] };
    }
    if (
      statement.startsWith("insert into learning_session_event")
      || statement.startsWith("update learning_session")
      || statement.startsWith("update \"user\"")
      || statement.startsWith("update inactivity_episode")
    ) return { rows: [] };
    if (statement.startsWith("select revision.id, revision.project_id")) {
      const loaded = scenario.loadedRevision === undefined ? revisionRow() : scenario.loadedRevision;
      return { rows: loaded ? [loaded] : [] };
    }
    if (statement.includes("from project_revision_object link")) {
      return { rows: scenario.loadedFiles ?? [] };
    }
    throw new Error(`Unexpected revision query: ${statement}`);
  });
  const client = {
    query,
    release: vi.fn(() => { released = true; }),
  };
  dbMocks.connect.mockResolvedValue(client);
  return { query, calls, client, released: () => released };
}

function mockPoolQueries(handler: (statement: string, values: unknown[]) => QueryResult | Promise<QueryResult>) {
  dbMocks.query.mockImplementation(async (sqlInput: string, values: unknown[] = []) => (
    handler(normalizedSql(sqlInput), values)
  ));
}

beforeEach(() => {
  dbMocks.connect.mockReset();
  dbMocks.query.mockReset();
});

describe("project revision mutation contract", () => {
  it("normalizes whitespace and file ordering into one stable replay hash", () => {
    const left = normalizeRevisionMutation({
      projectId,
      clientRequestId: requestId,
      expectedLatestRevision: 2,
      changeSummary: "  Added deterministic boundary tests.  ",
      reflection: "  I learned to isolate failure behavior.  ",
      fileIds: [fileB, fileA],
    });
    const right = normalizeRevisionMutation({
      projectId,
      clientRequestId: requestId,
      expectedLatestRevision: 2,
      changeSummary: "Added deterministic boundary tests.",
      reflection: "I learned to isolate failure behavior.",
      fileIds: [fileA, fileB],
    });
    expect(left.fileIds).toEqual([fileA, fileB]);
    expect(left).toEqual(right);
    expect(projectRevisionInputHash(left)).toBe(projectRevisionInputHash(right));
    expect(projectRevisionInputHash(left)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds concurrency and content changes into the idempotency evidence", () => {
    const base = normalizeRevisionMutation({
      projectId,
      clientRequestId: requestId,
      expectedLatestRevision: 0,
      changeSummary: "Created the first learner checkpoint.",
      fileIds: [],
    });
    const advanced = normalizeRevisionMutation({
      ...base,
      expectedLatestRevision: 1,
    });
    expect(projectRevisionInputHash(base)).not.toBe(projectRevisionInputHash(advanced));
  });

  it.each([
    [{ projectId: "bad", clientRequestId: requestId, expectedLatestRevision: 0, changeSummary: "A valid long summary." }],
    [{ projectId, clientRequestId: "bad", expectedLatestRevision: 0, changeSummary: "A valid long summary." }],
    [{ projectId, clientRequestId: requestId, expectedLatestRevision: -1, changeSummary: "A valid long summary." }],
    [{ projectId, clientRequestId: requestId, expectedLatestRevision: 0, changeSummary: "short" }],
    [{ projectId, clientRequestId: requestId, expectedLatestRevision: 0, changeSummary: "A valid long summary.", fileIds: [fileA, fileA] }],
  ])("rejects malformed, stale-shape, or duplicate input before storage", (input) => {
    expect(() => normalizeRevisionMutation(input)).toThrow(ProjectRevisionError);
  });

  it.each([
    { expectedLatestRevision: 1.5 },
    { expectedLatestRevision: 2_147_483_648 },
    { changeSummary: `Valid summary\0with unsafe content` },
    { changeSummary: "x".repeat(1_001) },
    { reflection: `Unsafe\0reflection` },
    { reflection: "x".repeat(4_001) },
    { fileIds: ["not-a-uuid"] },
    { fileIds: Array.from({ length: MAX_PROJECT_REVISION_FILES + 1 }, () => fileA) },
  ])("rejects every bounded mutation field before opening storage: %#", (override) => {
    expect(() => normalizeRevisionMutation({
      projectId,
      clientRequestId: requestId,
      expectedLatestRevision: 0,
      changeSummary: "A sufficiently detailed checkpoint summary.",
      ...override,
    })).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
  });

  it("normalizes omitted and whitespace-only optional fields", () => {
    expect(normalizeRevisionMutation({
      projectId,
      clientRequestId: requestId,
      expectedLatestRevision: 0,
      changeSummary: "  A sufficiently detailed checkpoint summary.  ",
      reflection: "   ",
    })).toMatchObject({
      changeSummary: "A sufficiently detailed checkpoint summary.",
      reflection: null,
      fileIds: [],
    });
  });
});

describe("createProjectRevision transaction", () => {
  const baseInput = () => ({
    userId,
    projectId,
    clientRequestId: requestId,
    expectedLatestRevision: 0,
    changeSummary: "Added a durable learner checkpoint.",
    reflection: "The transaction boundary is clearer now.",
    now,
  });

  it("creates a file-backed revision and records meaningful activity in the active session", async () => {
    const harness = createHarness({
      objects: [{
        id: fileA,
        original_name: "proof #1.ts",
        media_type: "text/typescript",
        size_bytes: "42",
        sha256: "a".repeat(64),
      }],
      loadedFiles: [linkedFile()],
    });

    await expect(createProjectRevision({ ...baseInput(), fileIds: [fileA] })).resolves.toEqual({
      duplicate: false,
      revision: {
        id: revisionId,
        projectId,
        sequence: 1,
        changeSummary: "Added a durable learner checkpoint.",
        reflection: "The transaction boundary is clearer now.",
        createdAt: now.toISOString(),
        files: [{
          objectId: fileA,
          originalName: "proof #1.ts",
          mediaType: "text/typescript",
          sizeBytes: 42,
          sha256: "a".repeat(64),
          available: true,
          downloadUrl: `/api/files/${fileA}`,
        }],
      },
    });

    const link = harness.calls.find((call) => call.statement.startsWith("insert into project_revision_object"));
    expect(link?.values).toEqual([
      revisionId, 0, fileA, "proof #1.ts", "text/typescript", 42, "a".repeat(64), now,
    ]);
    const event = harness.calls.find((call) => call.statement.startsWith("insert into learning_session_event"));
    expect(event?.values).toEqual([
      sessionId,
      userId,
      `project-revision:${revisionId}`,
      projectId,
      JSON.stringify({ meaningful: true, policyVersion: "project-revision-meaningful-v1" }),
      now,
    ]);
    expect(harness.calls.at(-1)?.statement).toBe("commit");
    expect(harness.released()).toBe(true);
  });

  it("records durable meaningful activity without inventing a session event", async () => {
    const harness = createHarness({ activeSession: null });

    await expect(createProjectRevision(baseInput())).resolves.toMatchObject({ duplicate: false });

    expect(harness.calls.some((call) => call.statement.includes("from stored_object"))).toBe(false);
    expect(harness.calls.some((call) => call.statement.startsWith("insert into learning_session_event"))).toBe(false);
    expect(harness.calls.some((call) => call.statement.startsWith("update learning_session"))).toBe(false);
    expect(harness.calls.some((call) => call.statement.startsWith("update \"user\""))).toBe(true);
    expect(harness.calls.some((call) => call.statement.startsWith("update inactivity_episode"))).toBe(true);
  });

  it("uses the service clock when a caller does not supply one", async () => {
    const harness = createHarness({ activeSession: null });

    await expect(createProjectRevision({ ...baseInput(), now: undefined })).resolves.toMatchObject({
      duplicate: false,
    });

    const insert = harness.calls.find((call) => call.statement.startsWith("insert into project_revision "));
    expect(insert?.values[6]).toBeInstanceOf(Date);
    expect((insert?.values[6] as Date).getTime()).toBeGreaterThan(0);
  });

  it("returns an exact idempotent replay without reapplying milestone writes", async () => {
    const normalized = normalizeRevisionMutation(baseInput());
    const harness = createHarness({
      prior: { id: revisionId, input_hash: projectRevisionInputHash(normalized) },
      loadedFiles: [linkedFile({ available: false })],
    });

    await expect(createProjectRevision(baseInput())).resolves.toMatchObject({
      duplicate: true,
      revision: {
        id: revisionId,
        files: [{ available: false, objectId: null, downloadUrl: null }],
      },
    });

    expect(harness.calls.some((call) => call.statement.startsWith("select coalesce(max(sequence)"))).toBe(false);
    expect(harness.calls.some((call) => call.statement.startsWith("select id from learning_session"))).toBe(false);
    expect(harness.calls.at(-1)?.statement).toBe("commit");
  });

  it("rejects a missing project and rolls back the acquired client", async () => {
    const harness = createHarness({ owned: false });

    await expect(createProjectRevision(baseInput())).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(harness.calls.at(-1)?.statement).toBe("rollback");
    expect(harness.client.release).toHaveBeenCalledOnce();
  });

  it("rejects reuse of a request id with different input", async () => {
    const harness = createHarness({ prior: { id: revisionId, input_hash: "different" } });

    await expect(createProjectRevision(baseInput())).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    expect(harness.calls.at(-1)?.statement).toBe("rollback");
  });

  it("reports the current revision when optimistic concurrency loses", async () => {
    const harness = createHarness({ latest: 7 });

    await expect(createProjectRevision(baseInput())).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      currentLatestRevision: 7,
    });
    expect(harness.calls.at(-1)?.statement).toBe("rollback");
  });

  it("uses zero when an aggregate result is unexpectedly empty", async () => {
    createHarness({ omitLatestRow: true, activeSession: null });

    await expect(createProjectRevision(baseInput())).resolves.toMatchObject({
      duplicate: false,
      revision: { sequence: 1 },
    });
  });

  it("rejects files that are unavailable, unsafe, or not owned", async () => {
    const harness = createHarness({ objects: [] });

    await expect(createProjectRevision({ ...baseInput(), fileIds: [fileA] }))
      .rejects.toMatchObject({ code: "FILE_NOT_AVAILABLE" });
    expect(harness.calls.at(-1)?.statement).toBe("rollback");
  });

  it("rejects invalid stored file sizes as a write conflict", async () => {
    const harness = createHarness({
      objects: [{
        id: fileA,
        original_name: "unsafe.ts",
        media_type: "text/typescript",
        size_bytes: "not-a-number",
        sha256: "b".repeat(64),
      }],
    });

    await expect(createProjectRevision({ ...baseInput(), fileIds: [fileA] }))
      .rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    expect(harness.calls.at(-1)?.statement).toBe("rollback");
  });

  it("rejects an insert that returns no revision id", async () => {
    const harness = createHarness({ createdId: null });

    await expect(createProjectRevision(baseInput())).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    expect(harness.calls.at(-1)?.statement).toBe("rollback");
  });

  it("rolls back when the inserted revision cannot be reloaded", async () => {
    const harness = createHarness({ loadedRevision: null });

    await expect(createProjectRevision(baseInput())).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    expect(harness.calls.at(-1)?.statement).toBe("rollback");
  });

  it("preserves the original database failure when rollback also fails", async () => {
    const harness = createHarness({ failAt: "update project set updated_at", rollbackFails: true });

    await expect(createProjectRevision(baseInput())).rejects.toThrow("database failed at update project set updated_at");
    expect(harness.client.release).toHaveBeenCalledOnce();
  });

  it.each([
    { userId: "", now },
    { userId: "x".repeat(256), now },
    { userId, now: new Date(Number.NaN) },
  ])("rejects invalid owner/time input before acquiring a client: %#", async (override) => {
    await expect(createProjectRevision({ ...baseInput(), ...override })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(dbMocks.connect).not.toHaveBeenCalled();
  });
});

describe("listProjectRevisions", () => {
  it("paginates newest-first and groups available and unavailable file snapshots", async () => {
    const secondRevisionId = "11000000-0000-4000-8000-000000000007";
    const thirdRevisionId = "11000000-0000-4000-8000-000000000008";
    mockPoolQueries((statement) => {
      if (statement.startsWith("select coalesce(max(revision.sequence)")) return { rows: [{ latest: 3 }] };
      if (statement.startsWith("select id, project_id, sequence")) {
        return { rows: [
          revisionRow({ id: revisionId, sequence: 3 }),
          revisionRow({ id: secondRevisionId, sequence: 2, reflection: null }),
          revisionRow({ id: thirdRevisionId, sequence: 1 }),
        ] };
      }
      if (statement.includes("from project_revision_object link")) {
        return { rows: [
          linkedFile({ object_id: "folder/file #1", size_bytes: 42 }),
          linkedFile({
            revision_id: secondRevisionId,
            object_id: fileB,
            original_name: "deleted.txt",
            available: false,
          }),
          linkedFile({
            revision_id: secondRevisionId,
            object_id: null,
            original_name: "detached.txt",
            available: true,
          }),
        ] };
      }
      throw new Error(`Unexpected list query: ${statement}`);
    });

    await expect(listProjectRevisions({ userId, projectId, limit: 2, beforeSequence: 4 })).resolves.toEqual({
      latestSequence: 3,
      nextBeforeSequence: 2,
      revisions: [
        expect.objectContaining({
          id: revisionId,
          sequence: 3,
          createdAt: now.toISOString(),
          files: [expect.objectContaining({
            objectId: "folder/file #1",
            sizeBytes: 42,
            downloadUrl: "/api/files/folder%2Ffile%20%231",
          })],
        }),
        expect.objectContaining({
          id: secondRevisionId,
          sequence: 2,
          reflection: null,
          files: [
            expect.objectContaining({ objectId: null, available: false, downloadUrl: null }),
            expect.objectContaining({ objectId: null, available: true, downloadUrl: null }),
          ],
        }),
      ],
    });
    expect(dbMocks.query).toHaveBeenNthCalledWith(2, expect.any(String), [projectId, 4, 3]);
    expect(dbMocks.query).toHaveBeenNthCalledWith(3, expect.any(String), [userId, [revisionId, secondRevisionId]]);
  });

  it("returns an empty first page without issuing a file query", async () => {
    mockPoolQueries((statement) => {
      if (statement.startsWith("select coalesce(max(revision.sequence)")) return { rows: [{ latest: 0 }] };
      if (statement.startsWith("select id, project_id, sequence")) return { rows: [] };
      throw new Error(`Unexpected empty-page query: ${statement}`);
    });

    await expect(listProjectRevisions({ userId, projectId })).resolves.toEqual({
      latestSequence: 0,
      revisions: [],
      nextBeforeSequence: null,
    });
    expect(dbMocks.query).toHaveBeenCalledTimes(2);
    expect(dbMocks.query).toHaveBeenNthCalledWith(2, expect.any(String), [projectId, null, 21]);
  });

  it("returns a complete short page with no next cursor", async () => {
    mockPoolQueries((statement) => {
      if (statement.startsWith("select coalesce(max(revision.sequence)")) return { rows: [{ latest: 1 }] };
      if (statement.startsWith("select id, project_id, sequence")) return { rows: [revisionRow()] };
      if (statement.includes("from project_revision_object link")) return { rows: [] };
      throw new Error(`Unexpected short-page query: ${statement}`);
    });

    await expect(listProjectRevisions({ userId, projectId, limit: MAX_PROJECT_REVISION_PAGE }))
      .resolves.toMatchObject({ latestSequence: 1, nextBeforeSequence: null, revisions: [{ files: [] }] });
  });

  it("does not manufacture a cursor from malformed stored sequence metadata", async () => {
    mockPoolQueries((statement) => {
      if (statement.startsWith("select coalesce(max(revision.sequence)")) return { rows: [{ latest: 2 }] };
      if (statement.startsWith("select id, project_id, sequence")) {
        return { rows: [revisionRow({ sequence: undefined }), revisionRow({ id: fileB, sequence: 1 })] };
      }
      if (statement.includes("from project_revision_object link")) return { rows: [] };
      throw new Error(`Unexpected malformed-cursor query: ${statement}`);
    });

    await expect(listProjectRevisions({ userId, projectId, limit: 1 })).resolves.toMatchObject({
      latestSequence: 2,
      nextBeforeSequence: null,
    });
  });

  it("rejects a project not owned by the caller", async () => {
    mockPoolQueries(() => ({ rows: [] }));

    await expect(listProjectRevisions({ userId, projectId })).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    expect(dbMocks.query).toHaveBeenCalledOnce();
  });

  it.each([
    { projectId: "bad" },
    { limit: 0 },
    { limit: MAX_PROJECT_REVISION_PAGE + 1 },
    { limit: 1.5 },
    { beforeSequence: 0 },
    { beforeSequence: 1.5 },
  ])("rejects malformed pagination before querying: %#", async (override) => {
    await expect(listProjectRevisions({ userId, projectId, ...override }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(dbMocks.query).not.toHaveBeenCalled();
  });

  it.each(["invalid", -1, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid stored file size %s during mapping",
    async (sizeBytes) => {
      mockPoolQueries((statement) => {
        if (statement.startsWith("select coalesce(max(revision.sequence)")) return { rows: [{ latest: 1 }] };
        if (statement.startsWith("select id, project_id, sequence")) return { rows: [revisionRow()] };
        if (statement.includes("from project_revision_object link")) {
          return { rows: [linkedFile({ size_bytes: sizeBytes })] };
        }
        throw new Error(`Unexpected mapping query: ${statement}`);
      });

      await expect(listProjectRevisions({ userId, projectId })).rejects.toMatchObject({ code: "WRITE_CONFLICT" });
    },
  );
});

describe("getProjectRevision", () => {
  it("loads a detail record and preserves the immutable file snapshot", async () => {
    mockPoolQueries((statement) => {
      if (statement.startsWith("select revision.id, revision.project_id")) return { rows: [revisionRow()] };
      if (statement.includes("from project_revision_object link")) return { rows: [linkedFile()] };
      throw new Error(`Unexpected detail query: ${statement}`);
    });

    await expect(getProjectRevision({ userId, projectId, revisionId })).resolves.toMatchObject({
      id: revisionId,
      projectId,
      createdAt: now.toISOString(),
      files: [{ objectId: fileA, sizeBytes: 42, available: true }],
    });
    expect(dbMocks.query).toHaveBeenNthCalledWith(1, expect.any(String), [revisionId, projectId, userId]);
    expect(dbMocks.query).toHaveBeenNthCalledWith(2, expect.any(String), [userId, [revisionId]]);
  });

  it("returns an empty immutable file list when a revision has no links", async () => {
    mockPoolQueries((statement) => {
      if (statement.startsWith("select revision.id, revision.project_id")) return { rows: [revisionRow()] };
      if (statement.includes("from project_revision_object link")) return { rows: [] };
      throw new Error(`Unexpected empty-detail query: ${statement}`);
    });

    await expect(getProjectRevision({ userId, projectId, revisionId })).resolves.toMatchObject({ files: [] });
  });

  it("reports a missing or foreign revision without querying files", async () => {
    mockPoolQueries(() => ({ rows: [] }));

    await expect(getProjectRevision({ userId, projectId, revisionId }))
      .rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });
    expect(dbMocks.query).toHaveBeenCalledOnce();
  });

  it.each([
    { projectId: "bad", revisionId },
    { projectId, revisionId: "bad" },
  ])("rejects malformed detail identifiers before querying: %#", async (ids) => {
    await expect(getProjectRevision({ userId, ...ids })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(dbMocks.query).not.toHaveBeenCalled();
  });
});
