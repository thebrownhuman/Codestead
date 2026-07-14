import { describe, expect, it } from "vitest";

import { normalizePublicGithubRepositoryUrl, PublicPortfolioError } from "../service";

describe("public portfolio repository boundary", () => {
  it.each([
    ["https://github.com/learner/project", "https://github.com/learner/project"],
    ["https://github.com/learner/project.git", "https://github.com/learner/project"],
    ["https://GITHUB.com/org/repo-name", "https://github.com/org/repo-name"],
  ])("accepts canonical public repository %s", (value, expected) => {
    expect(normalizePublicGithubRepositoryUrl(value)).toBe(expected);
  });

  it.each([
    "http://github.com/learner/project",
    "https://github.com/learner/project/issues",
    "https://github.com/learner/project?tab=readme",
    "https://github.com/learner/project#readme",
    "https://user:secret@github.com/learner/project",
    "https://github.example/learner/project",
    "https://github.com/learner",
    "not a URL",
  ])("rejects a non-canonical or non-public selection: %s", (value) => {
    expect(() => normalizePublicGithubRepositoryUrl(value)).toThrowError(
      expect.objectContaining<Partial<PublicPortfolioError>>({ code: "INVALID_SELECTION" }),
    );
  });
});
