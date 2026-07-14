import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  withRateLimit: vi.fn(),
  create: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/projects/revision-service", () => ({
  MAX_PROJECT_REVISION_FILES: 20,
  MAX_PROJECT_REVISION_PAGE: 50,
  ProjectRevisionError: class ProjectRevisionError extends Error {
    constructor(public readonly code: string, message: string, public readonly currentLatestRevision?: number) {
      super(message);
    }
  },
  createProjectRevision: mocks.create,
  listProjectRevisions: mocks.list,
}));

import { ProjectRevisionError } from "@/lib/projects/revision-service";

import { GET, POST } from "../route";

const projectId = "12000000-0000-4000-8000-000000000001";
const requestId = "12000000-0000-4000-8000-000000000002";
const fileId = "12000000-0000-4000-8000-000000000003";
const context = { params: Promise.resolve({ id: projectId }) };

function post(body: unknown) {
  return new NextRequest(`https://learn.example.test/api/projects/${projectId}/revisions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("project revision collection route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "authenticated-owner" }, session: { id: "session-1" } },
    });
    mocks.withRateLimit.mockImplementation(async (_input, handler) => handler());
    mocks.list.mockResolvedValue({ latestSequence: 0, revisions: [], nextBeforeSequence: null });
    mocks.create.mockResolvedValue({
      duplicate: false,
      revision: { id: "revision-1", projectId, sequence: 1, files: [] },
    });
  });

  it("authenticates before list or rate-limit work", async () => {
    mocks.requireAuth.mockResolvedValue({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    expect((await GET(new NextRequest(`https://learn.example.test/api/projects/${projectId}/revisions`), context)).status).toBe(401);
    expect((await POST(post({}), context)).status).toBe(401);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.withRateLimit).not.toHaveBeenCalled();
  });

  it("binds list pagination to the authenticated owner and rejects unknown or duplicate keys", async () => {
    const response = await GET(new NextRequest(
      `https://learn.example.test/api/projects/${projectId}/revisions?limit=12&beforeSequence=8`,
    ), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.list).toHaveBeenCalledWith({
      userId: "authenticated-owner",
      projectId,
      limit: 12,
      beforeSequence: 8,
    });
    expect((await GET(new NextRequest(
      `https://learn.example.test/api/projects/${projectId}/revisions?limit=2&limit=3`,
    ), context)).status).toBe(400);
    expect((await GET(new NextRequest(
      `https://learn.example.test/api/projects/${projectId}/revisions?owner=other`,
    ), context)).status).toBe(400);
  });

  it("strictly accepts an owner-independent mutation and returns a durable replay", async () => {
    const body = {
      clientRequestId: requestId,
      expectedLatestRevision: 2,
      changeSummary: "Added tests for the error boundary.",
      reflection: "I learned why deterministic failure cases matter.",
      fileIds: [fileId],
    };
    expect((await POST(post({ ...body, userId: "attacker", projectId: "attacker" }), context)).status).toBe(400);
    const created = await POST(post(body), context);
    expect(created.status).toBe(201);
    expect(mocks.withRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: "project_revision_user",
        identity: { kind: "user", value: "authenticated-owner" },
      }),
      expect.any(Function),
    );
    expect(mocks.create).toHaveBeenCalledWith({
      userId: "authenticated-owner",
      projectId,
      ...body,
    });

    mocks.create.mockResolvedValueOnce({ duplicate: true, revision: { id: "revision-1", sequence: 1 } });
    expect((await POST(post(body), context)).status).toBe(200);
  });

  it("returns the current sequence for an optimistic conflict without exposing foreign data", async () => {
    mocks.create.mockRejectedValueOnce(new ProjectRevisionError(
      "VERSION_CONFLICT",
      "Reload revision history.",
      5,
    ));
    const response = await POST(post({
      clientRequestId: requestId,
      expectedLatestRevision: 2,
      changeSummary: "Added tests for the error boundary.",
      reflection: null,
      fileIds: [],
    }), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "VERSION_CONFLICT", currentLatestRevision: 5 });

    mocks.list.mockRejectedValueOnce(new ProjectRevisionError("PROJECT_NOT_FOUND", "Foreign project."));
    const hidden = await GET(new NextRequest(`https://learn.example.test/api/projects/${projectId}/revisions`), context);
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(await hidden.json())).not.toContain("Foreign project");
  });

  it("returns the limiter response without writing a revision", async () => {
    mocks.withRateLimit.mockResolvedValue(NextResponse.json({ code: "RATE_LIMITED" }, { status: 429 }));
    const response = await POST(post({
      clientRequestId: requestId,
      expectedLatestRevision: 0,
      changeSummary: "Recorded a sufficiently clear checkpoint.",
      reflection: null,
      fileIds: [],
    }), context);
    expect(response.status).toBe(429);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
