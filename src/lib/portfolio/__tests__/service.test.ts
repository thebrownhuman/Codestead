import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ pool: { query: mocks.poolQuery, connect: mocks.connect } }));

import { hashSocialEvidence } from "@/lib/social/hash";

import {
  loadOwnPublicPortfolioSettings,
  loadPublicPortfolio,
  normalizePublicGithubRepositoryUrl,
  updatePublicPortfolio,
} from "../service";

const userId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";

function baseInput(overrides: Partial<Parameters<typeof updatePublicPortfolio>[0]> = {}) {
  return {
    userId,
    requestId,
    expectedVersion: 0,
    slug: "my-portfolio",
    displayName: "Learner",
    headline: "Building deterministic tools and reviewed projects.",
    about: null,
    publish: false,
    confirmPublicDisclosure: false,
    selectedProjectIds: [],
    selectedAchievementIds: [],
    selectedCertificateIds: [],
    now: new Date("2026-07-12T00:00:00.000Z"),
    ...overrides,
  };
}

describe("normalizePublicGithubRepositoryUrl", () => {
  it("accepts a canonical owner/repo GitHub URL and strips a .git suffix", () => {
    expect(normalizePublicGithubRepositoryUrl("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
    expect(normalizePublicGithubRepositoryUrl("https://github.com/owner/repo")).toBe("https://github.com/owner/repo");
  });

  it.each([
    "not a url",
    "http://github.com/owner/repo",
    "https://gitlab.com/owner/repo",
    "https://github.com/owner",
    "https://github.com/owner/repo/extra",
    "https://user:pass@github.com/owner/repo",
    "https://github.com/owner/repo?query=1",
    "https://github.com/owner/repo#fragment",
  ])("rejects %s", (value) => {
    expect(() => normalizePublicGithubRepositoryUrl(value)).toThrowError(
      expect.objectContaining({ code: "INVALID_SELECTION" }),
    );
  });
});

describe("updatePublicPortfolio validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an invalid slug, headline, or duplicate/invalid selection ids before connecting", async () => {
    await expect(updatePublicPortfolio(baseInput({ slug: "no" })))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(updatePublicPortfolio(baseInput({ headline: "short" })))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(updatePublicPortfolio(baseInput({ selectedProjectIds: ["not-a-uuid"] })))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("requires explicit disclosure confirmation to publish", async () => {
    await expect(updatePublicPortfolio(baseInput({ publish: true, confirmPublicDisclosure: false })))
      .rejects.toMatchObject({ code: "DISCLOSURE_CONFIRMATION_REQUIRED" });
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});

function fakeClient(handlers: Record<string, unknown[] | ((text: string, values?: unknown[]) => unknown[])>) {
  const client = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      const normalized = text.replace(/\s+/g, " ");
      const key = Object.keys(handlers).find((candidate) => normalized.includes(candidate));
      if (!key) return { rows: [] };
      const handler = handlers[key]!;
      const rows = typeof handler === "function" ? handler(text, values) : handler;
      return { rows };
    }),
    release: vi.fn(),
  };
  return client;
}

describe("updatePublicPortfolio transaction behaviour", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND when the account is not an active learner", async () => {
    mocks.connect.mockResolvedValue(fakeClient({
      'from "user" where id=$1 for update': [],
    }));

    await expect(updatePublicPortfolio(baseInput())).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("throws VERSION_CONFLICT when the expected version does not match", async () => {
    mocks.connect.mockResolvedValue(fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from public_portfolio_event": [],
      "from public_portfolio where user_id=$1 for update": [{ row_version: 3, is_published: false }],
    }));

    await expect(updatePublicPortfolio(baseInput({ expectedVersion: 0 })))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("throws INVALID_SELECTION when a selected project has no GitHub URL", async () => {
    const projectId = "30000000-0000-4000-8000-000000000001";
    mocks.connect.mockResolvedValue(fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from public_portfolio_event": [],
      "from public_portfolio where user_id=$1 for update": [],
      "from project": [{
        id: projectId, title: "Project", summary: "A project summary.", status: "reviewed",
        github_url: null, updated_at: new Date(),
      }],
    }));

    await expect(updatePublicPortfolio(baseInput({ selectedProjectIds: [projectId] })))
      .rejects.toMatchObject({ code: "INVALID_SELECTION" });
  });

  it("creates a fresh portfolio and reports the created event", async () => {
    mocks.connect.mockResolvedValue(fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from public_portfolio_event": [],
      "from public_portfolio where user_id=$1 for update": [],
    }));

    const result = await updatePublicPortfolio(baseInput());

    expect(result).toMatchObject({ rowVersion: 1, event: "created", replayed: false });
  });

  it("reports a published event when publishing for the first time with confirmation", async () => {
    mocks.connect.mockResolvedValue(fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from public_portfolio_event": [],
      "from public_portfolio where user_id=$1 for update": [],
    }));

    const result = await updatePublicPortfolio(baseInput({ publish: true, confirmPublicDisclosure: true }));

    expect(result).toMatchObject({ event: "published" });
  });

  it("reports a withdrawn event when un-publishing an existing published portfolio", async () => {
    mocks.connect.mockResolvedValue(fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from public_portfolio_event": [],
      "from public_portfolio where user_id=$1 for update": [{ row_version: 2, is_published: true }],
    }));

    const result = await updatePublicPortfolio(baseInput({ expectedVersion: 2, publish: false }));

    expect(result).toMatchObject({ event: "withdrawn", rowVersion: 3 });
  });

  it("replays an identical prior request without a second write", async () => {
    const input = baseInput();
    const normalized = {
      slug: input.slug,
      displayName: input.displayName,
      headline: input.headline,
      about: input.about,
      selectedProjectIds: [],
      selectedAchievementIds: [],
      selectedCertificateIds: [],
    };
    const expectedHash = hashSocialEvidence({
      operation: "public-portfolio-update",
      requestId: input.requestId,
      expectedVersion: input.expectedVersion,
      publish: input.publish,
      confirmPublicDisclosure: input.confirmPublicDisclosure,
      ...normalized,
    });
    const client = fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from public_portfolio_event": [{ input_hash: expectedHash, event: "created", resulting_version: 1 }],
    });
    mocks.connect.mockResolvedValue(client);

    const result = await updatePublicPortfolio(input);

    expect(result).toMatchObject({ replayed: true, event: "created", rowVersion: 1 });
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining("insert into public_portfolio ("), expect.anything());
  });

  it("rejects a reused request id bound to different mutation inputs", async () => {
    const client = fakeClient({
      'from "user" where id=$1 for update': [{ role: "learner", status: "active" }],
      "from public_portfolio_event": [{ input_hash: "0".repeat(64), event: "created", resulting_version: 1 }],
    });
    mocks.connect.mockResolvedValue(client);

    await expect(updatePublicPortfolio(baseInput())).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });

  it("maps a unique slug violation to SLUG_TAKEN", async () => {
    mocks.connect.mockResolvedValue({
      query: vi.fn(async (text: string) => {
        if (text.includes('from "user" where id=$1 for update')) return { rows: [{ role: "learner", status: "active" }] };
        if (text.includes("insert into public_portfolio")) {
          throw Object.assign(new Error("duplicate"), { code: "23505", constraint: "public_portfolio_slug_unique" });
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    });

    await expect(updatePublicPortfolio(baseInput())).rejects.toMatchObject({ code: "SLUG_TAKEN" });
  });

  it("maps a check-constraint violation to INVALID_SELECTION", async () => {
    mocks.connect.mockResolvedValue({
      query: vi.fn(async (text: string) => {
        if (text.includes('from "user" where id=$1 for update')) return { rows: [{ role: "learner", status: "active" }] };
        if (text.includes("insert into public_portfolio")) {
          throw Object.assign(new Error("check failed"), { code: "23514" });
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    });

    await expect(updatePublicPortfolio(baseInput())).rejects.toMatchObject({ code: "INVALID_SELECTION" });
  });
});

describe("loadPublicPortfolio", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed slug without querying the database", async () => {
    await expect(loadPublicPortfolio("no")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
  });

  it("throws NOT_FOUND when no published portfolio matches the slug", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });

    await expect(loadPublicPortfolio("my-portfolio")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("returns the published projection, silently dropping an unparsable GitHub URL and sensitive text", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{
        user_id: userId, slug: "my-portfolio", display_name: "Learner", headline: "Building reviewed tools.",
        about: null, is_published: true, row_version: 1, published_at: new Date("2026-07-12T00:00:00.000Z"), withdrawn_at: null,
      }] })
      .mockResolvedValueOnce({ rows: [
        { id: "p1", title: "Good project", summary: "A safe summary.", status: "reviewed", github_url: "https://github.com/owner/repo", position: 1 },
        { id: "p2", title: "Bad project", summary: "s", status: "reviewed", github_url: "not-a-url", position: 2 },
      ] })
      .mockResolvedValueOnce({ rows: [{ id: "a1", title: "Badge", description: "d", icon: "medal", position: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: "c1", title: "Python", version: "1.0.0", verification_id: "v".repeat(40), issued_at: new Date("2026-07-11T00:00:00.000Z"), position: 1 }] });

    const result = await loadPublicPortfolio("my-portfolio");

    expect(result.projects).toHaveLength(1);
    expect(result.projects[0]).toMatchObject({ id: "p1", githubUrl: "https://github.com/owner/repo" });
    expect(result.achievements[0]).toMatchObject({ id: "a1", title: "Badge" });
    expect(result.certificates[0]).toMatchObject({ id: "c1", verificationPath: `/verify/${"v".repeat(40)}` });
  });
});

describe("loadOwnPublicPortfolioSettings", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NOT_FOUND when the account is missing or inactive", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [] });

    await expect(loadOwnPublicPortfolioSettings(userId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("suggests a default slug and marks selected items when no profile row exists yet", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ name: "Learner", public_id: "a1b2c3d4-0000-4000-8000-000000000001" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "p1", title: "Project", summary: "Summary", status: "reviewed", github_url: "https://github.com/owner/repo" }] })
      .mockResolvedValueOnce({ rows: [{ id: "a1", title: "Badge", description: "d", icon: "medal" }] })
      .mockResolvedValueOnce({ rows: [{ id: "c1", title: "Python", version: "1.0.0", verification_id: "v".repeat(40), issued_at: new Date("2026-07-11T00:00:00.000Z") }] })
      .mockResolvedValueOnce({ rows: [{ project_id: "p1" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ certificate_id: "c1" }] });

    const settings = await loadOwnPublicPortfolioSettings(userId);

    expect(settings.profile.slug).toBe("learner-a1b2c3d40000");
    expect(settings.profile.isPublished).toBe(false);
    expect(settings.projects[0]).toMatchObject({ id: "p1", selected: true });
    expect(settings.achievements[0]).toMatchObject({ id: "a1", selected: false });
    expect(settings.certificates[0]).toMatchObject({ id: "c1", selected: true });
  });
});
