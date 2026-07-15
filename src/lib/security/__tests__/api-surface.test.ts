import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  auditApiSurface,
  extractExportedHttpOperations,
  normalizeSourceText,
} from "../api-surface";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

describe("complete API authorization surface", () => {
  it("canonicalizes LF, CRLF, and legacy CR before parsing anchors and hashes", () => {
    const lf = [
      "export async function POST() {",
      "  const authz = await requireAuth();",
      "  return startItem(authz.session.user.id,",
      "    params.sessionId);",
      "}",
      "",
    ].join("\n");
    const variants = [lf, lf.replaceAll("\n", "\r\n"), lf.replaceAll("\n", "\r")];

    const normalized = variants.map(normalizeSourceText);
    const operations = normalized.map((source) =>
      extractExportedHttpOperations(source, "src/app/api/example/route.ts").get("POST"),
    );

    expect(new Set(normalized)).toEqual(new Set([lf]));
    expect(new Set(operations)).toEqual(new Set([operations[0]]));
    expect(operations.every((operation) => operation?.includes("authz.session.user.id,\n    params.sessionId"))).toBe(true);
    expect(new Set(normalized.map(sha256))).toHaveLength(1);
    expect(new Set(operations.map((operation) => sha256(operation ?? "")))).toHaveLength(1);
  });

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
