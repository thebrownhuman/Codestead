import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ pool: { connect: mocks.connect, query: mocks.query } }));

import { PublicPortfolioError, updatePublicPortfolio } from "../service";

const projectId = "71000000-0000-4000-8000-000000000001";
const now = new Date("2026-07-14T12:00:00.000Z");
const awsAccessKey = ["AKIA", "A1B2C3D4E5F6G7H8"].join("");
const credentialCandidates = [
  ["21st", "21st_sk_A1B2C3D4E5F6G7H8"],
  ["NVIDIA", "nvapi-A1B2C3D4E5F6G7H8"],
  ["AWS", awsAccessKey],
  ["Slack", "xoxb-A1B2C3D4E5"],
  ["labelled custom", "access token=frostedMoonRiver7"],
] as const;

const baseInput = {
  userId: "portfolio-user",
  requestId: "72000000-0000-4000-8000-000000000001",
  expectedVersion: 0,
  slug: "safe-learner",
  displayName: "Safe Learner",
  headline: "Building reviewed projects in public",
  about: "An ordinary learner-selected introduction.",
  publish: true,
  confirmPublicDisclosure: true,
  selectedProjectIds: [projectId],
  selectedAchievementIds: [],
  selectedCertificateIds: [],
  now,
} as const;

function clientFor(project: { title: string; summary: string }) {
  const observed: Array<{ sql: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    observed.push({ sql, values });
    if (sql.includes('select role,status from "user"')) return { rows: [{ role: "learner", status: "active" }] };
    if (sql.includes("select input_hash,event,resulting_version from public_portfolio_event")) return { rows: [] };
    if (sql.includes("select row_version,is_published from public_portfolio")) return { rows: [] };
    if (sql.includes("select id,title,summary,status,github_url,updated_at from project")) {
      return { rows: [{
        id: projectId,
        title: project.title,
        summary: project.summary,
        status: "reviewed",
        github_url: "https://github.com/safe/project",
        updated_at: now,
      }] };
    }
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  mocks.connect.mockResolvedValue(client);
  return { observed, client };
}

async function capturedFailure(work: () => Promise<unknown>) {
  try {
    await work();
    throw new Error("Expected portfolio publication to fail.");
  } catch (error) {
    return error;
  }
}

describe("public portfolio credential boundary", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(credentialCandidates)("rejects a synthetic %s credential in profile metadata before hashing or persistence", async (_provider, candidate) => {
    const error = await capturedFailure(() => updatePublicPortfolio({
      ...baseInput,
      about: `Public learner introduction ${candidate}`,
      selectedProjectIds: [],
    }));
    expect(error).toBeInstanceOf(PublicPortfolioError);
    expect(error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(String(error)).not.toContain(candidate);
    expect(JSON.stringify(error)).not.toContain(candidate);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it.each(credentialCandidates)("rejects a synthetic %s credential in selected project metadata before public rows or events", async (_provider, candidate) => {
    const { observed, client } = clientFor({
      title: "Reviewed learning project",
      summary: `A selected public project summary containing ${candidate}`,
    });
    const error = await capturedFailure(() => updatePublicPortfolio(baseInput));
    expect(error).toBeInstanceOf(PublicPortfolioError);
    expect(error).toMatchObject({ code: "INVALID_SELECTION" });
    expect(String(error)).not.toContain(candidate);
    expect(JSON.stringify(error)).not.toContain(candidate);
    expect(observed.some(({ sql }) => sql.startsWith("insert into public_portfolio "))).toBe(false);
    expect(observed.some(({ sql }) => sql.includes("insert into public_portfolio_project "))).toBe(false);
    expect(observed.some(({ sql }) => sql.includes("insert into public_portfolio_project_snapshot"))).toBe(false);
    expect(observed.some(({ sql }) => sql.includes("insert into public_portfolio_event"))).toBe(false);
    expect(observed.some(({ sql }) => sql === "rollback")).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("accepts ordinary educational prose and snapshots the exact reviewed project projection", async () => {
    const title = "API key safety checklist";
    const summary = "Explains how access tokens work and why credentials stay out of source control.";
    const { observed } = clientFor({ title, summary });
    await expect(updatePublicPortfolio({
      ...baseInput,
      about: "Learning how API keys and access tokens work without publishing any credential.",
    })).resolves.toMatchObject({ event: "published", rowVersion: 1, replayed: false });

    const snapshotInsert = observed.find(({ sql }) => sql.includes("insert into public_portfolio_project_snapshot"));
    expect(snapshotInsert?.values).toEqual([
      baseInput.userId,
      projectId,
      1,
      title,
      summary,
      "reviewed",
      "https://github.com/safe/project",
      now,
      now,
    ]);
    expect(observed.some(({ sql }) => sql === "commit")).toBe(true);
  });
});
