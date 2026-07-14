import { describe, expect, it } from "vitest";

import { auditApiSurface } from "../api-surface";

describe("complete API authorization surface", () => {
  it("keeps every HTTP operation behind its reviewed direct boundary", async () => {
    const report = await auditApiSurface(process.cwd());
    expect(report.errors).toEqual([]);
    expect(report.files).toBeGreaterThanOrEqual(80);
    expect(report.operations).toBeGreaterThanOrEqual(90);
    expect(report.boundaryCounts.public).toBe(5);
    expect(report.boundaryCounts["auth-handler"]).toBe(2);
    expect(report.boundaryCounts.admin).toBeGreaterThan(30);
    expect(report.boundaryCounts.authenticated).toBeGreaterThan(50);
    expect(report.entries.every((entry) => /^[0-9a-f]{64}$/.test(entry.sourceSha256))).toBe(true);
  });

  it("keeps the public allowlist exact and small", async () => {
    const report = await auditApiSurface(process.cwd());
    expect(report.entries.filter((entry) => entry.boundary === "public").map((entry) => entry.route)).toEqual([
      "/api/access-requests",
      "/api/invitations/activate",
      "/api/invitations/validate",
      "/api/lost-device/request",
      "/api/lost-device/verify",
    ]);
  });
});
