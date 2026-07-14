import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.query } }));

import { loadPublicPortfolio, PublicPortfolioError } from "../service";

describe("public portfolio projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql.startsWith("select portfolio.*")) return { rows: [{
        user_id: "learner-private-id",
        slug: "safe-learner",
        display_name: "Safe Learner",
        headline: "Building public, verified projects",
        about: "A learner-selected introduction.",
        is_published: true,
        row_version: 4,
        published_at: new Date("2026-07-14T00:00:00.000Z"),
        withdrawn_at: null,
        email: "must-not-leak@example.test",
      }] };
      if (sql.includes("from public_portfolio_project")) return { rows: [{
        id: "project-1", title: "Public project", summary: "A bounded public summary.",
        status: "complete", github_url: "https://github.com/safe/project", position: 1,
      }] };
      if (sql.includes("from public_portfolio_achievement")) return { rows: [{
        id: "achievement-1", title: "Python complete", description: "Verified path completed.", icon: "award", position: 1,
      }] };
      if (sql.includes("from public_portfolio_certificate")) return { rows: [{
        id: "certificate-1", title: "Python foundations", version: "1.0.0",
        verification_id: "public-verifier-token", issued_at: new Date("2026-07-14T00:00:00.000Z"), position: 1,
      }] };
      return { rows: [] };
    });
  });

  it("returns only the explicit public projection", async () => {
    const portfolio = await loadPublicPortfolio("safe-learner");
    expect(Object.keys(portfolio).sort()).toEqual([
      "about", "achievements", "certificates", "displayName", "headline", "privacyNotice",
      "projects", "publishedAt", "slug",
    ]);
    expect(portfolio.projects[0]?.githubUrl).toBe("https://github.com/safe/project");
    expect(portfolio.certificates[0]?.verificationPath).toBe("/verify/public-verifier-token");
    expect(JSON.stringify(portfolio)).not.toMatch(/must-not-leak@example|evidenceHash|user_id|administratorReason|providerCredential/);
    const projectRead = mocks.query.mock.calls.find(([statement]) => String(statement).includes("from public_portfolio_project selected"));
    expect(String(projectRead?.[0])).toContain("join public_portfolio_project_snapshot snapshot");
    expect(String(projectRead?.[0])).not.toContain("join project on");
  });

  it("fails a legacy profile closed instead of exposing credential-shaped text", async () => {
    const candidate = "nvapi-A1B2C3D4E5F6G7H8";
    mocks.query.mockResolvedValueOnce({ rows: [{
      user_id: "learner-private-id",
      slug: "safe-learner",
      display_name: "Safe Learner",
      headline: `Building with ${candidate}`,
      about: null,
      is_published: true,
      row_version: 4,
      published_at: new Date("2026-07-14T00:00:00.000Z"),
      withdrawn_at: null,
    }] });
    const error = await loadPublicPortfolio("safe-learner").catch((caught) => caught);
    expect(error).toMatchObject({ code: "NOT_FOUND" });
    expect(String(error)).not.toContain(candidate);
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it("omits a corrupted legacy project snapshot instead of exposing credential-shaped text", async () => {
    const candidate = "21st_sk_A1B2C3D4E5F6G7H8";
    const safeImplementation = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (statement: string) => {
      const sql = statement.replace(/\s+/g, " ").trim().toLowerCase();
      if (sql.includes("from public_portfolio_project")) return { rows: [{
        id: "project-1",
        title: "Public project",
        summary: `Corrupted legacy snapshot ${candidate}`,
        status: "complete",
        github_url: "https://github.com/safe/project",
        position: 1,
      }] };
      return safeImplementation(statement);
    });
    const portfolio = await loadPublicPortfolio("safe-learner");
    expect(portfolio.projects).toEqual([]);
    expect(JSON.stringify(portfolio)).not.toContain(candidate);
  });

  it("rejects an invalid slug before any database query", async () => {
    await expect(loadPublicPortfolio("../../private"))
      .rejects.toMatchObject({ code: "NOT_FOUND" } satisfies Partial<PublicPortfolioError>);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
