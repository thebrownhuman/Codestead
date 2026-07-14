import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { auditApiAuthorizationMatrix } from "../src/lib/security/api-authorization-matrix";

async function main() {
  const root = process.cwd();
  const report = await auditApiAuthorizationMatrix(root);
  const output = process.argv.find((argument) => argument.startsWith("--output="))?.slice("--output=".length) ??
    path.join("docs", "evidence", "api-authorization-matrix-2026-07-12.json");
  const evidence = {
    ...report,
    generatedAt: new Date().toISOString(),
    scope: "Complete static role/object-authorization source inventory. The endpoint sweep verifies guard invocation, while authz.test.ts verifies real guard decisions and runtime-authorization.integration.test.ts behaviorally covers a representative owner-bound route set. This report alone is not runtime cross-user proof, deployed proxy/browser evidence, or PostgreSQL RLS evidence.",
    runtimeVerification: {
      guardInvocationTest: "src/lib/security/__tests__/endpoint-auth-boundaries.test.ts",
      guardDecisionTest: "src/lib/http/__tests__/authz.test.ts",
      representativeObjectAuthorizationTest: "integration/runtime-authorization.integration.test.ts",
      protectedOperationInvocations: {
        anonymousAuthenticated: report.boundaryCounts.authenticated,
        anonymousAdmin: report.boundaryCounts.admin,
        learnerAdmin: report.boundaryCounts.admin,
      },
      betterAuthAdminPolicyTest: "src/lib/security/__tests__/better-auth-admin-policy.test.ts",
    },
  };
  if (output) {
    const target = path.resolve(root, output);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({
    files: report.files,
    operations: report.operations,
    boundaryCounts: report.boundaryCounts,
    matrixRows: report.matrixRows,
    objectAuthorizationCounts: report.objectAuthorizationCounts,
    identifierOwnershipContracts: report.identifierOwnershipContracts,
    supportingOwnershipContracts: report.supportingOwnershipProofs.length,
    errors: report.errors.length,
    output: output ?? null,
  }, null, 2));
  if (report.errors.length) {
    for (const error of report.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
