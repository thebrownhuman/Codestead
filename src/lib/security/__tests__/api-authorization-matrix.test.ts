import { beforeAll, describe, expect, it } from "vitest";

import { auditApiAuthorizationMatrix } from "../api-authorization-matrix";

let report: Awaited<ReturnType<typeof auditApiAuthorizationMatrix>>;

beforeAll(async () => {
  report = await auditApiAuthorizationMatrix(process.cwd());
}, 30_000);

describe("API authorization and IDOR contract matrix", () => {
  it("has one reviewed executable row for every HTTP operation", async () => {
    expect(report.errors).toEqual([]);
    expect(report.files).toBeGreaterThanOrEqual(80);
    expect(report.operations).toBeGreaterThanOrEqual(100);
    expect(report.matrixRows).toBe(report.operations);
    expect(report.rows.map((row) => row.operation).sort()).toEqual(
      [...new Set(report.rows.map((row) => row.operation))].sort(),
    );
    expect(report.rows.every((row) => /^[0-9a-f]{64}$/.test(row.operationSourceSha256))).toBe(true);
  });

  it("models anonymous, learner, and administrator role decisions for every row", async () => {
    const authenticated = report.rows.filter((row) => row.boundary === "authenticated");
    const administrator = report.rows.filter((row) => row.boundary === "admin");

    expect(authenticated).toHaveLength(report.boundaryCounts.authenticated);
    expect(administrator).toHaveLength(report.boundaryCounts.admin);
    expect(authenticated.every((row) => row.anonymous === "authenticated")).toBe(true);
    expect(authenticated.every((row) => row.learner === "allowed")).toBe(true);
    expect(administrator.every((row) => row.anonymous === "authenticated")).toBe(true);
    expect(administrator.every((row) => row.learner === "administrator")).toBe(true);
    expect(administrator.every((row) => row.admin === "allowed")).toBe(true);
  });

  it("keeps cross-user reads limited to reviewed consent projections", async () => {
    const cohortReads = report.rows
      .filter((row) => row.objectAuthorization === "consent-projected-cohort")
      .map((row) => row.operation)
      .sort();

    expect(cohortReads).toEqual([
      "GET /api/community",
      "GET /api/community/profiles/[publicId]",
    ]);
  });

  it("binds every other learner object to the authenticated session identity", async () => {
    const learnerRows = report.rows.filter((row) => row.boundary === "authenticated");
    const selfRows = learnerRows.filter((row) => row.objectAuthorization === "session-user");

    expect(selfRows).toHaveLength(94);
    expect(report.identifierOwnershipContracts).toBe(39);
    expect(selfRows.find((row) => row.operation === "GET /api/certificates/[certificateId]/pdf")).toMatchObject({
      objectAuthorization: "session-user",
      ownershipProof: "identifier bound by loadOwnCertificate((await params).certificateId, authz.session!.user.id)",
    });
    expect(report.supportingOwnershipProofs).toHaveLength(21);
    for (const operation of ["POST /api/code/interactive", "DELETE /api/code/interactive/[sessionId]", "GET /api/code/interactive/[sessionId]/authorize"]) {
      expect(selfRows.find(row => row.operation === operation)).toMatchObject({ objectAuthorization: "session-user", anonymous: "authenticated" });
    }
    expect(report.supportingOwnershipProofs.every((proof) => proof.anchors > 0)).toBe(true);
    expect(report.supportingOwnershipProofs.every((proof) => /^[0-9a-f]{64}$/.test(proof.sourceSha256))).toBe(true);
    expect(selfRows.every((row) => row.ownershipProof.length > 20)).toBe(true);
    expect(learnerRows
      .filter((row) => row.objectAuthorization === "no-user-object")
      .map((row) => row.operation)
      .sort())
      .toEqual([
        "GET /api/code/run",
        "GET /api/monitoring/envelope",
        "POST /api/monitoring/envelope",
        "POST /api/onboarding/interests/preview",
      ]);
  });
});

it("binds both AI model preference operations to the authenticated session owner", () => {
  const rows = report.rows.filter((row) => row.route === "/api/settings/ai-model");
  expect(rows).toHaveLength(2);
  expect(rows.map((row) => row.operation).sort()).toEqual([
    "GET /api/settings/ai-model", "PATCH /api/settings/ai-model",
  ]);
  for (const row of rows) {
    expect(row).toMatchObject({
      boundary: "authenticated", objectAuthorization: "session-user",
      anonymous: "authenticated", learner: "allowed",
      ownershipProof: "all user context is derived from authz.session.user.id",
    });
  }
});

it("binds both password settings operations to the authenticated owner", async () => {
  for (const operation of ["GET /api/security/password-status", "POST /api/security/change-password"]) {
    expect(report.rows.find((row) => row.operation === operation)).toMatchObject({ boundary: "authenticated", objectAuthorization: "session-user", anonymous: "authenticated" });
  }
});
