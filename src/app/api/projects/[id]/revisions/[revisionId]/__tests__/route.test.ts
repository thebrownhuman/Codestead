import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/projects/revision-service", () => ({
  ProjectRevisionError: class ProjectRevisionError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
  },
  getProjectRevision: mocks.get,
}));

import { ProjectRevisionError } from "@/lib/projects/revision-service";

import { GET } from "../route";

const projectId = "13000000-0000-4000-8000-000000000001";
const revisionId = "13000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({ id: projectId, revisionId }) };

describe("project revision detail route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "owner" }, session: { id: "session" } } });
    mocks.get.mockResolvedValue({ id: revisionId, projectId, sequence: 1, files: [] });
  });

  it("binds the project and revision to the authenticated owner", async () => {
    const response = await GET(new NextRequest(
      `https://learn.example.test/api/projects/${projectId}/revisions/${revisionId}`,
    ), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(mocks.get).toHaveBeenCalledWith({ userId: "owner", projectId, revisionId });
  });

  it("fails before storage when unauthenticated and hides foreign revision details", async () => {
    mocks.requireAuth.mockResolvedValueOnce({
      session: null,
      response: NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    });
    expect((await GET(new NextRequest("https://learn.example.test/api/x"), context)).status).toBe(401);
    expect(mocks.get).not.toHaveBeenCalled();

    mocks.get.mockRejectedValueOnce(new ProjectRevisionError("REVISION_NOT_FOUND", "Foreign title"));
    const response = await GET(new NextRequest("https://learn.example.test/api/x"), context);
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain("Foreign title");
  });

  it("rejects query parameters so detail reads have one exact meaning", async () => {
    const response = await GET(new NextRequest("https://learn.example.test/api/x?include=bytes"), context);
    expect(response.status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
