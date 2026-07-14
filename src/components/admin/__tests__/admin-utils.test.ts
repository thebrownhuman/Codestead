import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdminApiError,
  credentialTail,
  formatBytes,
  formatMinutes,
  formatPercent,
  formatRelativeTime,
  humanize,
  percentage,
  requestAdminJson,
  safeLastFour,
  safeOperationalCode,
  statusTone,
} from "../admin-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("administrator presentation helpers", () => {
  it("normalizes percentages without allowing invalid ranges", () => {
    expect(percentage(3, 4)).toBe(75);
    expect(percentage(1, 3)).toBe(33.3);
    expect(percentage(4, 2)).toBe(100);
    expect(percentage(1, 0)).toBe(0);
    expect(percentage(Number.NaN, 5)).toBe(0);
    expect(formatPercent(33.3)).toBe("33.3%");
    expect(formatPercent(200)).toBe("100%");
  });

  it("formats byte and time totals for compact operations cards", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1_024)).toBe("1.0 KB");
    expect(formatBytes(10 * 1_024 * 1_024)).toBe("10 MB");
    expect(formatMinutes(42)).toBe("42 min");
    expect(formatMinutes(125)).toBe("2h 5m");
  });

  it("maps known states to accessible semantic tones", () => {
    expect(statusTone("succeeded")).toBe("good");
    expect(statusTone("queued")).toBe("warning");
    expect(statusTone("failed")).toBe("danger");
    expect(statusTone("retired")).toBe("neutral");
    expect(statusTone("custom-state")).toBe("info");
    expect(humanize("pending_validation")).toBe("pending validation");
  });

  it("accepts exactly four safe credential-tail characters and rejects key-like input", () => {
    expect(safeLastFour("aB_9")).toBe("aB_9");
    expect(credentialTail("aB_9")).toBe("•••• aB_9");
    expect(safeLastFour("sk-live-this-is-a-full-key-1234")).toBe("????");
    expect(credentialTail("sk-live-this-is-a-full-key-1234")).not.toContain("1234");
    expect(safeLastFour("12 4")).toBe("????");
    expect(safeLastFour("")).toBe("????");
  });

  it("allows bounded operational codes but redacts free-form or secret-like values", () => {
    expect(safeOperationalCode("RATE_LIMIT:429")).toBe("RATE_LIMIT:429");
    expect(safeOperationalCode("connection refused with credential sk-live-secret"))
      .toBe("REDACTED");
    expect(safeOperationalCode("x".repeat(65))).toBe("REDACTED");
    expect(safeOperationalCode(null)).toBeNull();
  });

  it("formats deterministic relative timestamps", () => {
    const now = Date.parse("2026-07-12T12:00:00.000Z");
    expect(formatRelativeTime("2026-07-12T11:55:00.000Z", now)).toBe("5 minutes ago");
    expect(formatRelativeTime("2026-07-13T12:00:00.000Z", now)).toBe("tomorrow");
    expect(formatRelativeTime(null, now)).toBe("never");
  });
});

describe("administrator API client", () => {
  it("requests a no-store JSON response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestAdminJson<{ ok: boolean }>("/api/admin/dashboard"))
      .resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/dashboard",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("returns the safe API error without exposing an unknown response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Administrator access required." }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const promise = requestAdminJson("/api/admin/dashboard");
    await expect(promise).rejects.toBeInstanceOf(AdminApiError);
    await expect(promise).rejects.toMatchObject({
      message: "Administrator access required.",
      status: 403,
    });
  });
});
