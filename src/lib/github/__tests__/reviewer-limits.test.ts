import { afterEach, describe, expect, it, vi } from "vitest";
import { reviewPublicRepository } from "../reviewer";

const sha = "a".repeat(40);
const file = (path: string, size = 2) => ({ path, size, type: "blob", sha: path });
function transport(entries: ReturnType<typeof file>[], truncated = false) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/repos/octo/repo")) return Response.json({ private: false, default_branch: "main" });
    if (url.includes("/commits/")) return Response.json({ sha, commit: { tree: { sha } } });
    if (url.includes("/git/trees/")) return Response.json({ tree: entries, truncated });
    return Response.json({ content: Buffer.from("ok").toString("base64"), encoding: "base64", size: 2 });
  });
}
const missing = (result: Awaited<ReturnType<typeof reviewPublicRepository>>) =>
  result.findings.filter((finding) => /missing-(readme|tests)/.test(finding.ruleId ?? ""));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("GitHub reviewer fairness and whole-review limits", () => {
  it("uses full-tree existence and reserves late README, tests and entry points", async () => {
    const fetchMock = transport([...Array.from({ length: 125 }, (_, i) => file(`src/file${i}.ts`)),
      file("README.md"), file("tests/review.test.ts"), file("src/main.ts")]);
    const result = await reviewPublicRepository("https://github.com/octo/repo", fetchMock);
    expect(missing(result)).toEqual([]);
    expect(result.qualityAssessment?.score).toBe(100);
    const blobs = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/git/blobs/"));
    expect(blobs.slice(0, 3)).toEqual(["README.md", "tests/review.test.ts", "src/main.ts"].map((path) =>
      `https://api.github.com/repos/octo/repo/git/blobs/${path}`));
    expect(blobs).toHaveLength(120);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("?recursive=1"))).toHaveLength(1);
  });

  it("does not deduct for existing files excluded by the size filter", async () => {
    const result = await reviewPublicRepository("https://github.com/octo/repo", transport([
      file("README.md", 300_000), file("tests/check.test.ts", 300_000), file("main.js"),
    ]));
    expect(missing(result)).toEqual([]);
    expect(result.limitations?.join(" ")).toMatch(/skipped.*256 KB/i);
  });

  it("reports unknown existence without deductions for a truncated tree", async () => {
    const result = await reviewPublicRepository("https://github.com/octo/repo", transport([file("main.js")], true));
    expect(missing(result)).toEqual([]);
    expect(result.limitations?.join(" ")).toMatch(/existence.*unknown.*truncated/i);
  });

  it("returns only completed files at the whole-review deadline and cancels the active body", async () => {
    vi.useFakeTimers();
    const base = transport(Array.from({ length: 10 }, (_, i) => file(`src/${i}.ts`)));
    let active = 0;
    let peak = 0;
    let cancelled = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      active++; peak = Math.max(peak, active);
      const response = await base(input, init);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return new Response(new ReadableStream({
        start(controller) {
          const timer = setTimeout(() => { active--; controller.enqueue(bytes); controller.close(); }, 10_000);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer); active--; cancelled++; controller.error(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        },
      }));
    });
    const pending = reviewPublicRepository("https://github.com/octo/repo", fetchMock);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.filesReviewed).toBe(2);
    expect(result.limitations?.join(" ")).toMatch(/incomplete: time limit/i);
    expect(result.qualityAssessment?.limitations).toEqual(result.limitations);
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(cancelled).toBe(1);
    const count = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(count);
  });

  it.each([false, true])("skips oversized blob JSON before parsing (declared length: %s)", async (declared) => {
    const base = transport([file("main.js"), file("README.md"), file("tests/check.test.ts")]);
    let cancelled = false;
    let sent = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith("/git/blobs/main.js")) return base(input, init);
      return new Response(new ReadableStream({
        pull(controller) { if (sent) controller.close(); else { sent = true; controller.enqueue(new Uint8Array(600_000).fill(120)); } },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 }), { headers: declared ? { "content-length": "600000" } : {} });
    });
    const result = await reviewPublicRepository("https://github.com/octo/repo", fetchMock);
    expect(result.filesReviewed).toBe(2);
    expect(result.limitations?.join(" ")).toMatch(/skipped.*main.js.*256 KB/i);
    expect(cancelled).toBe(true);
  });

  it("rejects decoded blobs over 256 KB even with false size metadata", async () => {
    const base = transport([file("main.js"), file("README.md"), file("tests/check.test.ts")]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/git/blobs/main.js")
        ? Response.json({ content: Buffer.alloc(256 * 1024 + 1, 120).toString("base64"), encoding: "base64", size: 2 })
        : base(input, init));
    const result = await reviewPublicRepository("https://github.com/octo/repo", fetchMock);
    expect(result.filesReviewed).toBe(2);
    expect(result.limitations?.join(" ")).toMatch(/skipped.*main.js.*256 KB/i);
  });

  it("bounds error response bodies without exposing their content", async () => {
    let cancelled = false;
    let sent = false;
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { if (sent) controller.close(); else { sent = true; controller.enqueue(new Uint8Array(2 * 1024 * 1024).fill(120)); } },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { status: 403 }));
    await expect(reviewPublicRepository("https://github.com/octo/repo", fetchMock)).rejects.toThrow(/denied access/i);
    expect(cancelled).toBe(true);
  });
});
