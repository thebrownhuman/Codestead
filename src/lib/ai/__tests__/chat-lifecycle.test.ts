import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  pool: {
    query: mocks.query,
    connect: mocks.connect,
  },
}));

import {
  ChatThreadLifecycleError,
  decodeChatCursor,
  encodeChatCursor,
  listOwnedChatThreads,
  readOwnedChatThread,
  setOwnedChatThreadStatus,
} from "../chat-lifecycle";

const THREAD = "10000000-0000-4000-8000-000000000001";
const MESSAGE_ONE = "20000000-0000-4000-8000-000000000001";
const MESSAGE_TWO = "20000000-0000-4000-8000-000000000002";
const CREATED = new Date("2026-07-12T08:00:00.000Z");
const UPDATED = new Date("2026-07-12T09:00:00.000Z");

describe("chat thread lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
  });

  it("round-trips opaque stable cursors and rejects malformed, oversized, or non-UUID cursors", () => {
    const encoded = encodeChatCursor({ at: UPDATED.toISOString(), id: THREAD });
    expect(decodeChatCursor(encoded)).toEqual({ at: UPDATED.toISOString(), id: THREAD });
    expect(decodeChatCursor(null)).toBeNull();
    for (const cursor of [
      "not-base64-json",
      Buffer.from(JSON.stringify({ at: "not-a-date", id: THREAD })).toString("base64url"),
      Buffer.from(JSON.stringify({ at: UPDATED.toISOString(), id: "not-a-uuid" })).toString("base64url"),
      "x".repeat(501),
    ]) {
      expect(() => decodeChatCursor(cursor)).toThrowError(ChatThreadLifecycleError);
    }
  });

  it("lists only the authenticated owner's active/archive domain with bounded keyset pagination", async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [
        {
          id: THREAD,
          title: "Loop help",
          status: "active",
          created_at: CREATED,
          updated_at: UPDATED,
          message_count: "4",
          latest_provider: "nvidia_nim",
          latest_model: "meta/test",
          latest_source: "learner",
        },
        {
          id: "10000000-0000-4000-8000-000000000002",
          title: "Next page",
          status: "archived",
          created_at: CREATED,
          updated_at: CREATED,
          message_count: "2",
          latest_provider: null,
          latest_model: null,
          latest_source: null,
        },
      ],
    });

    const result = await listOwnedChatThreads({ userId: "learner-1", limit: 1, includeArchived: true });
    expect(result.threads).toEqual([expect.objectContaining({
      id: THREAD,
      messageCount: 4,
      provider: "nvidia_nim",
      model: "meta/test",
      credentialSource: "learner",
    })]);
    expect(result.nextCursor).toBeTruthy();
    const [sql, parameters] = mocks.query.mock.calls[0]!;
    expect(sql).toContain("t.user_id = $1");
    expect(sql).toContain("t.status in ('active', 'archived')");
    expect(parameters).toEqual(["learner-1", true, null, null, 2]);
  });

  it("reads an owned thread in chronological display order with per-message provider provenance", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: THREAD, title: "Loop help", status: "archived", created_at: CREATED, updated_at: UPDATED }] })
      .mockResolvedValueOnce({ rows: [
        {
          id: MESSAGE_TWO,
          role: "assistant",
          content: "Trace the loop.",
          curriculum_refs: ["python.loops"],
          safety_labels: [],
          created_at: UPDATED,
          call_id: "30000000-0000-4000-8000-000000000001",
          provider: "openrouter",
          model: "test/model",
          prompt_version: "buddy-v1",
          credential_source: "admin_fallback",
          context_manifest: {
            promptVersion: "buddy-tutor-v3",
            contextPolicyVersion: "tutor-context-v2",
            included: ["concept_mastery.current_skill", "unknown.private"],
            provenance: { "concept_mastery.current_skill": "untrusted persisted label" },
            caps: { evidenceRows: 40, secretCap: 999 },
            explicitlyExcluded: ["hidden_tests", "not-allowlisted"],
          },
        },
        {
          id: MESSAGE_ONE,
          role: "user",
          content: "Help with loops.",
          curriculum_refs: ["python.loops"],
          safety_labels: [],
          created_at: CREATED,
          call_id: null,
          provider: null,
          model: null,
          prompt_version: null,
          credential_source: null,
          context_manifest: null,
        },
      ] });

    const result = await readOwnedChatThread({ userId: "learner-1", threadId: THREAD, limit: 1 });
    expect(result.thread).toMatchObject({ id: THREAD, status: "archived" });
    expect(result.messages).toEqual([expect.objectContaining({
      id: MESSAGE_TWO,
      provider: "openrouter",
      model: "test/model",
      credentialSource: "admin_fallback",
      contextManifest: expect.objectContaining({
        included: ["concept_mastery.current_skill"],
        caps: { evidenceRows: 40 },
        explicitlyExcluded: ["hidden_tests"],
      }),
    })]);
    expect(result.nextCursor).toBeTruthy();
    expect(mocks.query.mock.calls[0]![0]).toContain("user_id = $2");
  });

  it("returns one indistinguishable not-found error for missing, deleted, or another owner's thread", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(readOwnedChatThread({ userId: "learner-1", threadId: THREAD }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("archives with a row lock and commits an optimistic version change", async () => {
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === "begin" || sql === "commit") return { rows: [] };
      if (sql.includes("select status,updated_at")) return { rows: [{ status: "active", updated_at: UPDATED }] };
      if (sql.includes("update chat_thread")) return { rows: [{ status: "archived", updated_at: new Date("2026-07-12T10:00:00.000Z") }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(setOwnedChatThreadStatus({
      userId: "learner-1",
      threadId: THREAD,
      status: "archived",
      expectedUpdatedAt: UPDATED.toISOString(),
      now: new Date("2026-07-12T10:00:00.000Z"),
    })).resolves.toEqual({ status: "archived", updatedAt: "2026-07-12T10:00:00.000Z", replayed: false });
    expect(mocks.clientQuery.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(["begin", "commit"]));
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("treats a lost-response retry as an idempotent replay before comparing its stale version", async () => {
    const current = new Date("2026-07-12T10:00:00.000Z");
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === "begin" || sql === "commit") return { rows: [] };
      if (sql.includes("select status,updated_at")) return { rows: [{ status: "archived", updated_at: current }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });

    await expect(setOwnedChatThreadStatus({
      userId: "learner-1",
      threadId: THREAD,
      status: "archived",
      expectedUpdatedAt: UPDATED.toISOString(),
    })).resolves.toEqual({ status: "archived", updatedAt: current.toISOString(), replayed: true });
    expect(mocks.clientQuery.mock.calls.some(([sql]) => String(sql).includes("update chat_thread"))).toBe(false);
  });

  it("rolls back a stale conflicting mutation and rejects invalid requests before connecting", async () => {
    const current = new Date("2026-07-12T10:00:00.000Z");
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === "begin" || sql === "rollback") return { rows: [] };
      if (sql.includes("select status,updated_at")) return { rows: [{ status: "archived", updated_at: current }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    await expect(setOwnedChatThreadStatus({
      userId: "learner-1",
      threadId: THREAD,
      status: "active",
      expectedUpdatedAt: UPDATED.toISOString(),
    })).rejects.toMatchObject({
      code: "VERSION_CONFLICT",
      current: { status: "archived", updatedAt: current.toISOString() },
    });
    expect(mocks.clientQuery).toHaveBeenCalledWith("rollback");

    mocks.connect.mockClear();
    await expect(setOwnedChatThreadStatus({
      userId: "learner-1",
      threadId: "not-a-uuid",
      status: "active",
      expectedUpdatedAt: UPDATED.toISOString(),
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
