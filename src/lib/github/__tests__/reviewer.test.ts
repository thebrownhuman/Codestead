import { describe, expect, it, vi } from "vitest";

import {
  parsePublicGitHubUrl,
  projectReviewQualityAssessment,
  reviewPublicRepository,
  reviewPublicRepositoryAtCommit,
  scoreDeterministicProjectReview,
} from "../reviewer";

describe("GitHub static reviewer", () => {
  it("accepts only canonical public GitHub repository URLs", () => {
    expect(parsePublicGitHubUrl("https://github.com/octo/repo.git")).toMatchObject({ owner: "octo", repo: "repo" });
    expect(() => parsePublicGitHubUrl("http://127.0.0.1/admin")).toThrow();
    expect(() => parsePublicGitHubUrl("https://github.com/octo/repo/issues/1")).toThrow();
  });

  it("pins review to a commit and redacts matched secret values", async () => {
    const sha = "a".repeat(40);
    const tree = "b".repeat(40);
    const blob = "c".repeat(40);
    const source = "API_KEY = 'nvapi-this-is-a-fake-secret-value'\nprint('ok')";
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.endsWith("/repos/octo/repo")) return Response.json({ private: false, default_branch: "main" });
      if (url.includes("/commits/main")) return Response.json({ sha, commit: { tree: { sha: tree } } });
      if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: [{ path: "main.py", type: "blob", size: source.length, sha: blob }] });
      return Response.json({ content: Buffer.from(source).toString("base64"), encoding: "base64", size: source.length });
    });
    const result = await reviewPublicRepository("https://github.com/octo/repo", fetchMock as typeof fetch);
    expect(result.commitSha).toBe(sha);
    expect(result).toMatchObject({
      analyzerVersion: "static-review-v2",
      rubricVersion: "static-project-review-rubric-v2",
      provenance: {
        analysisMode: "deterministic_static",
        aiUsed: false,
        promptVersion: null,
        modelCallId: null,
        repositoryExecution: "none",
        runnerTemplateId: null,
        deterministicFindingsOnly: true,
        modelOpinionsIncluded: false,
      },
    });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        origin: "deterministic_static",
        ruleId: "security.possible-secret",
        category: "security",
      }),
    ]));
    expect(result.qualityAssessment).toMatchObject({
      origin: "deterministic_static",
      reviewedCommitSha: sha,
      filesReviewed: 1,
    });
    expect(result.qualityAssessment?.score).toBeGreaterThanOrEqual(0);
    expect(result.qualityAssessment?.score).toBeLessThan(100);
    expect(projectReviewQualityAssessment(result.provenance)).toEqual(result.qualityAssessment);
    expect(JSON.stringify(result)).not.toContain("nvapi-this-is-a-fake-secret-value");
  });

  it("computes a bounded versioned category breakdown and rejects tampered persisted totals", () => {
    const sha = "1".repeat(40);
    const assessment = scoreDeterministicProjectReview({
      commitSha: sha,
      filesReviewed: 4,
      findings: [
        { origin: "deterministic_static", ruleId: "likely-bug.swallowed-error", severity: "warning", category: "likely-bug", message: "Handle the error.", evidence: "Broad handler" },
        { origin: "deterministic_static", ruleId: "security.possible-secret", severity: "important", category: "security", message: "Remove the key.", evidence: "Pattern only" },
        { origin: "deterministic_static", ruleId: "testing.missing-tests", severity: "warning", category: "testing", message: "Add tests.", evidence: "No test path" },
      ],
    });
    expect(assessment.score).toBe(76);
    expect(assessment.categories).toEqual([
      expect.objectContaining({ id: "likely-bug", score: 19, maximum: 25, findingCount: 1 }),
      expect.objectContaining({ id: "security", score: 13, maximum: 25, findingCount: 1 }),
      expect.objectContaining({ id: "testing", score: 14, maximum: 20, findingCount: 1 }),
      expect.objectContaining({ id: "documentation", score: 15, maximum: 15, findingCount: 0 }),
      expect.objectContaining({ id: "maintainability", score: 15, maximum: 15, findingCount: 0 }),
    ]);
    const projected = projectReviewQualityAssessment({ qualityAssessment: assessment });
    expect(projected).toEqual(assessment);
    expect(projectReviewQualityAssessment({
      qualityAssessment: { ...assessment, score: 99 },
    })).toBeNull();
  });

  it("re-analyzes only the exact pinned SHA and never calls a repository execution endpoint", async () => {
    const sha = "d".repeat(40);
    const tree = "e".repeat(40);
    const seen: string[] = [];
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      seen.push(url);
      if (url.endsWith("/repos/octo/repo")) {
        return Response.json({ private: false, default_branch: "main" });
      }
      if (url.endsWith(`/commits/${sha}`)) {
        return Response.json({ sha, commit: { tree: { sha: tree } } });
      }
      if (url.includes("/git/trees/")) {
        return Response.json({ truncated: false, tree: [] });
      }
      throw new Error(`Unexpected corrective-review request: ${url}`);
    });
    const result = await reviewPublicRepositoryAtCommit(
      "https://github.com/octo/repo",
      sha,
      fetchMock as typeof fetch,
    );
    expect(result.commitSha).toBe(sha);
    expect(seen).toEqual([
      "https://api.github.com/repos/octo/repo",
      `https://api.github.com/repos/octo/repo/commits/${sha}`,
      `https://api.github.com/repos/octo/repo/git/trees/${tree}?recursive=1`,
    ]);
    expect(seen.every((url) => url.startsWith("https://api.github.com/"))).toBe(true);
    expect(JSON.stringify(result.provenance)).toContain('"repositoryExecution":"none"');
    expect(result.qualityAssessment?.reviewedCommitSha).toBe(sha);
    expect(result.limitations?.join(" ")).toMatch(/does not clone, install dependencies, build, execute code/i);
  });

  it("fails closed when GitHub resolves a different commit than the pinned correction target", async () => {
    const sha = "f".repeat(40);
    const fetchMock = vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url.endsWith("/repos/octo/repo")) {
        return Response.json({ private: false, default_branch: "main" });
      }
      return Response.json({
        sha: "a".repeat(40),
        commit: { tree: { sha: "b".repeat(40) } },
      });
    });
    await expect(reviewPublicRepositoryAtCommit(
      "https://github.com/octo/repo",
      sha,
      fetchMock as typeof fetch,
    )).rejects.toThrow("exact pinned commit");
  });
});
