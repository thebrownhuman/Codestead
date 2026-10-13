import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { reviewPublicRepository, reviewPublicRepositoryAtCommit } from "../reviewer";

const token = ["test", "github", "credential"].join("_");
const sha = "a".repeat(40);
const tree = "b".repeat(40);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function repositoryFetch() {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/repos/octo/repo")) return Response.json({ private: false, default_branch: "main" });
    if (url.includes("/commits/")) return Response.json({ sha, commit: { tree: { sha: tree } } });
    if (url.includes("/git/trees/")) return Response.json({ truncated: false, tree: [
      { path: "README.md", type: "blob", size: 2, sha: "c".repeat(40) },
    ] });
    return Response.json({ content: Buffer.from("ok").toString("base64"), encoding: "base64", size: 2 });
  });
}

describe("GitHub review authentication and availability", () => {
  it.each([reviewPublicRepository, (url: string, fetchImpl: typeof fetch) =>
    reviewPublicRepositoryAtCommit(url, sha, fetchImpl)])("uses the optional token for every public API request without changing the review", async (review) => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const anonymousFetch = repositoryFetch();
    const anonymous = await review("https://github.com/octo/repo", anonymousFetch as typeof fetch);
    expect(anonymousFetch).toHaveBeenCalledTimes(4);
    for (const [, init] of anonymousFetch.mock.calls) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }

    vi.stubEnv("GITHUB_TOKEN", `  ${token}  `);
    const authenticatedFetch = repositoryFetch();
    const authenticated = await review("https://github.com/octo/repo", authenticatedFetch as typeof fetch);
    expect(authenticated).toEqual(anonymous);
    for (const [url, init] of authenticatedFetch.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/api\.github\.com\//);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
      expect(init).toMatchObject({ redirect: "error", cache: "no-store" });
    }
    expect(JSON.stringify(authenticated)).not.toContain(token);
  });

  it.each([undefined, "", " \t "])("treats missing or blank tokens as anonymous (%s)", async (value) => {
    vi.stubEnv("GITHUB_TOKEN", value);
    const fetchMock = repositoryFetch();
    await reviewPublicRepository("https://github.com/octo/repo", fetchMock as typeof fetch);
    expect(fetchMock.mock.calls.every(([, init]) => !new Headers(init?.headers).has("authorization"))).toBe(true);
  });

  it("passes the optional server-side token only to the two Compose services that read GitHub", () => {
    const compose = readFileSync("compose.yaml", "utf8");
    const consumers = [...compose.matchAll(/^  ([\w-]+):\r?\n((?:(?!^  [\w-]+:)[\s\S])*)/gm)]
      .filter(([, , block]) => /^      GITHUB_TOKEN:/m.test(block));
    expect(consumers.map(([, name]) => name)).toEqual(["app", "project-review-correction-worker"]);
    for (const [, , block] of consumers) {
      expect(block).toMatch(/^      GITHUB_TOKEN: \$\{GITHUB_TOKEN:-\}\r?$/m);
    }
    expect(compose).not.toMatch(/NEXT_PUBLIC_\w*(?:GITHUB|TOKEN)/);
  });

  it("still rejects private repositories even when the optional token can access them", async () => {
    vi.stubEnv("GITHUB_TOKEN", token);
    const fetchMock = vi.fn(async () => Response.json({ private: true, default_branch: "main" }));
    await expect(reviewPublicRepository("https://github.com/octo/repo", fetchMock as typeof fetch))
      .rejects.toThrow("Private repositories require the future read-only GitHub App flow.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, { "x-ratelimit-remaining": "0" }, "untrusted response"],
    [403, { "retry-after": "60" }, "untrusted response"],
    [403, {}, "You have exceeded a secondary rate limit."],
    [429, {}, "untrusted response"],
  ])("fails gracefully on GitHub rate limiting (%s) without retrying or producing a review", async (status, headers, message) => {
    vi.stubEnv("GITHUB_TOKEN", token);
    const fetchMock = vi.fn(async () => Response.json({ message: `${message} ${token}` }, { status, headers }));
    await expect(reviewPublicRepository("https://github.com/octo/repo", fetchMock as typeof fetch))
      .rejects.toThrow("GitHub review is temporarily rate limited. Please try again later.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops on a blob rate limit rather than returning a partial scored review", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    const fetchMock = repositoryFetch();
    fetchMock.mockImplementationOnce(async () => Response.json({ private: false, default_branch: "main" }))
      .mockImplementationOnce(async () => Response.json({ sha, commit: { tree: { sha: tree } } }))
      .mockImplementationOnce(async () => Response.json({ truncated: false, tree: [
        { path: "README.md", type: "blob", size: 2, sha: "c".repeat(40) },
      ] }))
      .mockImplementationOnce(async () => Response.json({}, { status: 429 }));
    await expect(reviewPublicRepositoryAtCommit("https://github.com/octo/repo", sha, fetchMock as typeof fetch))
      .rejects.toThrow("temporarily rate limited");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([401, 403, 404, 500, 503])("never exposes HTTP failure bodies or retries with anonymous credentials (%s)", async (status) => {
    vi.stubEnv("GITHUB_TOKEN", token);
    const fetchMock = vi.fn(async () => Response.json({ message: token }, { status }));
    const error = await reviewPublicRepository("https://github.com/octo/repo", fetchMock as typeof fetch).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["fetch", "body"])("replaces raw %s errors that could include credentials and does not log them", async (failure) => {
    vi.stubEnv("GITHUB_TOKEN", token);
    const spies = ["log", "info", "warn", "error", "debug"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined));
    const fetchMock = vi.fn(async () => {
      if (failure === "fetch") throw new Error(`Authorization: Bearer ${token}`);
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(token)); } }));
    });
    const error = await reviewPublicRepository("https://github.com/octo/repo", fetchMock as typeof fetch).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/GitHub.*try again later/);
    expect(String(error)).not.toContain(token);
    expect((error as Error).cause).toBeUndefined();
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });
});
