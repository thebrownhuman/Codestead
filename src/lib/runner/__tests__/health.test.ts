import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PISTON_RUNTIMES } from "../piston-client";
import { createRunnerHealth } from "../health";

const inventory = Object.values(PISTON_RUNTIMES).map(({ language, version }) => ({ language, version }));
describe("bounded runner health", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.stubEnv("CODE_RUNNER_PROVIDER", "piston"); vi.stubEnv("PISTON_URL", "http://piston:2000"); vi.stubEnv("PISTON_IMAGE", `codestead-piston@sha256:${"a".repeat(64)}`); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  function fixture() {
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(inventory));
    const legacy = vi.fn().mockResolvedValue({ available: true });
    const warn = vi.fn();
    return { request, legacy, warn, health: createRunnerHealth({ request, warn }) };
  }
  it("probes runtimes without executing code and exposes only status and latency", async () => {
    const f = fixture();
    expect(await f.health()).toEqual({ status: "ready", latencyMs: 0 });
    expect(f.request).toHaveBeenCalledWith("http://piston:2000/api/v2/runtimes", expect.objectContaining({ cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) }));
    expect(f.warn).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled();
  });
  it("coalesces concurrent requests and caches for thirty seconds", async () => {
    const f = fixture();
    await Promise.all(Array.from({ length: 20 }, () => f.health()));
    expect(f.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(29_999); await f.health(); expect(f.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await f.health(); expect(f.request).toHaveBeenCalledTimes(2);
  });
  it.each([Response.json([]), Response.json(inventory.slice(1)), Response.json({ secret: "private" }), new Response("private", { status: 503 }), new Response("not-json")])("fails closed and caches unavailable results", async (response) => {
    const f = fixture(); f.request.mockResolvedValue(response);
    expect(await f.health()).toEqual({ status: "unavailable", latencyMs: 0 }); await f.health();
    expect(f.request).toHaveBeenCalledOnce(); expect(f.warn).toHaveBeenCalledExactlyOnceWith("Runner health probe failed");
  });
  it("bounds even a transport that ignores abort and caches the timeout", async () => {
    const f = fixture(); f.request.mockImplementation(() => new Promise(() => {}));
    const pending = f.health(); await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toEqual({ status: "unavailable", latencyMs: 3_000 }); await f.health(); expect(f.request).toHaveBeenCalledOnce();
  });
  it("measures probe latency and never logs transport details", async () => {
    const f = fixture();
    f.request.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      throw new Error("http://piston:2000/private credential-secret");
    });
    const pending = f.health(); await vi.advanceTimersByTimeAsync(75);
    expect(await pending).toEqual({ status: "unavailable", latencyMs: 75 });
    expect(f.warn).toHaveBeenCalledExactlyOnceWith("Runner health probe failed");
  });
  it("requires the selected runner configuration without probing another backend", async () => {
    const f = fixture(); vi.stubEnv("PISTON_IMAGE", "");
    expect((await f.health()).status).toBe("unavailable");
    expect(f.request).not.toHaveBeenCalled(); expect(f.legacy).not.toHaveBeenCalled();
  });
  it("bounds a stalled response body", async () => {
    const f = fixture(); f.request.mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    const pending = f.health(); await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).status).toBe("unavailable");
  });
  it("rejects oversized runtime responses", async () => {
    const f = fixture(); f.request.mockResolvedValue(new Response("x".repeat(65_537)));
    expect((await f.health()).status).toBe("unavailable");
  });
  it.each(["", "https://user:secret@piston:2000", "http://piston:2000/private", "file:///private"])("rejects invalid configuration without sending a request", async (url) => {
    const f = fixture(); vi.stubEnv("PISTON_URL", url);
    expect((await f.health()).status).toBe("unavailable"); expect(f.request).not.toHaveBeenCalled();
  });
  it("rejects legacy mode without making any request", async () => {
    const f = fixture(); vi.stubEnv("CODE_RUNNER_PROVIDER", "legacy");
    expect((await f.health()).status).toBe("unavailable"); expect(f.legacy).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });
  it("does not fall back after an invalid provider or offline legacy runner", async () => {
    const f = fixture(); vi.stubEnv("CODE_RUNNER_PROVIDER", "unknown"); expect((await f.health()).status).toBe("unavailable");
    const second = fixture(); vi.stubEnv("CODE_RUNNER_PROVIDER", "legacy"); second.legacy.mockResolvedValue({ available: false });
    expect((await second.health()).status).toBe("unavailable"); expect(f.request).not.toHaveBeenCalled(); expect(second.legacy).not.toHaveBeenCalled();
  });
  it("limits requests globally without attacker-controlled buckets", async () => {
    const f = fixture(); for (let i = 0; i < 120; i++) await f.health();
    expect(await f.health()).toEqual({ status: "unavailable", latencyMs: 0, limited: true }); expect(f.request).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000); expect((await f.health()).status).toBe("ready");
  });
});
