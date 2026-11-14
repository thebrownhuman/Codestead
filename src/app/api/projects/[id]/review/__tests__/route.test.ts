import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  withRateLimit: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
}));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/db/client", () => ({ db: {
  select: mocks.select, transaction: mocks.transaction, update: mocks.update, insert: mocks.insert,
} }));

import { POST } from "../route";

const token = ["test", "github", "credential"].join("_");
const projectId = "9a000000-0000-4000-8000-000000000001";

describe("GitHub review failures preserve stored results", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GITHUB_TOKEN", token);
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "owner-1" } } });
    mocks.withRateLimit.mockImplementation(async (_input, handler) => handler());
    mocks.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ id: projectId }] }) }) });
    mocks.transaction.mockImplementation(() => { throw new Error("A failed review must never begin a write transaction."); });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["primary limit", "secondary limit", "blob limit", "network failure"])("returns a safe error without any writes on %s", async (failure) => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (failure === "network failure") throw new Error(`Bearer ${token}`);
      if (failure === "blob limit") {
        if (url.endsWith("/repos/octo/repo")) return Response.json({ private: false, default_branch: "main" });
        if (url.includes("/commits/")) return Response.json({ sha: "a".repeat(40), commit: { tree: { sha: "b".repeat(40) } } });
        if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: [
          { path: "main.js", type: "blob", size: 1, sha: "c".repeat(40) },
        ] });
      }
      return Response.json({ message: `You have exceeded a secondary rate limit. ${token}` }, {
        status: failure === "blob limit" ? 429 : 403,
        headers: failure === "primary limit" ? { "x-ratelimit-remaining": "0" } : {},
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const logSpies = ["log", "info", "warn", "error", "debug"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined));
    const response = await POST(new NextRequest("https://learn.example.test/api/projects/project-1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryUrl: "https://github.com/octo/repo" }),
    }), { params: Promise.resolve({ id: projectId }) });

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe(failure === "network failure"
      ? "GitHub is temporarily unavailable. Please try again later."
      : "GitHub review is temporarily rate limited. Please try again later.");
    expect(JSON.stringify(body)).not.toContain(token);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(logSpies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });

  it("answers 404 for a malformed project id without querying the uuid column", async () => {
    const response = await POST(new NextRequest("https://learn.example.test/api/projects/not-a-uuid/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryUrl: "https://github.com/octo/repo" }),
    }), { params: Promise.resolve({ id: "not-a-uuid" }) });

    expect(response.status).toBe(404);
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
