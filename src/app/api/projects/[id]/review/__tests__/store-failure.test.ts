import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  withRateLimit: vi.fn(),
  select: vi.fn(),
  transaction: vi.fn(),
  review: vi.fn(),
}));

vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({ withRateLimit: mocks.withRateLimit }));
vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select, transaction: mocks.transaction } }));
vi.mock("@/lib/github/reviewer", () => ({ reviewPublicRepository: mocks.review }));

import { POST } from "../route";

const projectId = "9a000000-0000-4000-8000-000000000001";

describe("project review storage failure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuth.mockResolvedValue({ session: { user: { id: "owner-1" } } });
    mocks.withRateLimit.mockImplementation(async (_input, handler) => handler());
    mocks.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{ id: projectId }] }) }) });
    mocks.review.mockResolvedValue({
      findings: [], commitSha: "a".repeat(40), analyzerVersion: "v", rubricVersion: "r", provenance: {}, filesReviewed: 1,
    });
    mocks.transaction.mockRejectedValue(new Error('relation "project_review" violates constraint secret_internal'));
  });

  it("does not return the raw database error message", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await POST(new NextRequest("https://learn.example.test/api/projects/x/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repositoryUrl: "https://github.com/octo/repo" }),
    }), { params: Promise.resolve({ id: projectId }) });

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain("secret_internal");
    expect(body.error).toBe("Repository review could not be saved. Please try again.");
  });
});
