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

    expect(selfRows).toHaveLength(84);
    expect(report.identifierOwnershipContracts).toBe(36);
    expect(report.supportingOwnershipProofs).toHaveLength(17);
    expect(report.supportingOwnershipProofs.every((proof) => proof.anchors > 0)).toBe(true);
    expect(report.supportingOwnershipProofs.every((proof) => /^[0-9a-f]{64}$/.test(proof.sourceSha256))).toBe(true);
    expect(selfRows.every((row) => row.ownershipProof.length > 20)).toBe(true);
    expect(learnerRows
      .filter((row) => row.objectAuthorization === "no-user-object")
      .map((row) => row.operation)
      .sort())
      .toEqual([
        "GET /api/code/run",
        "POST /api/onboarding/interests/preview",
      ]);
  });
});
