import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("credential mutation security boundaries", () => {
  it("requires durable recent MFA before adding a credential", () => {
    const source = read("src/app/api/credentials/route.ts");
    expect(source).toContain("requireRecentMfa");
    expect(source).toContain('action: "credential.add"');
  });

  it("requires durable recent MFA before every per-credential mutation", () => {
    const source = read("src/app/api/credentials/[id]/route.ts");
    expect(source).toContain("requireRecentMfa");
    expect(source).toContain("`credential.${body.data.action}`");
    expect(source).toContain('action: "credential.delete"');
  });

  it("records onboarding verification through the same durable fresh-MFA route", () => {
    const source = read("src/components/onboarding/onboarding-wizard.tsx");
    expect(source).toContain('fetch("/api/security/fresh-mfa"');
    expect(source).not.toContain("authClient.twoFactor.verifyTotp");
  });

  it("gates every administrator credential mutation by role, rate limit, fresh MFA, and reason", () => {
    const source = read("src/app/api/admin/credentials/[id]/route.ts");
    expect(source).toContain("requireAdmin()");
    expect(source).toContain('policy: "credential_mutation_admin"');
    expect(source).toContain("authorizePrivilegedAction");
    expect(source).toContain("reason: input.reason");
    for (const action of ["test", "replace", "enable", "disable", "delete"]) {
      expect(read("src/lib/security/privileged-access.ts")).toContain(`"credential.${action}"`);
    }
  });

  it("binds administrator operations to the named learner role and commits audit/notices atomically", () => {
    const source = read("src/lib/admin-credentials/service.ts");
    expect(source.match(/eq\(user\.publicId, input\.learnerPublicId\)/g)).toHaveLength(2);
    expect(source.match(/eq\(user\.role, "learner"\)/g)).toHaveLength(2);
    expect(source.match(/eq\(user\.role, "admin"\)/g)).toHaveLength(2);
    expect(source).toContain("return db.transaction(async (tx)");
    expect(source).toContain("writeAuditEventInTransaction(tx");
    expect(source).toContain("await tx.insert(notification)");
    expect(source).toContain(".insert(emailOutbox)");
    expect(source).not.toMatch(/console\.(?:log|info|warn|error)/);
  });

  it("adds only an opaque ID to the deliberate last-four administrator projection", () => {
    const types = read("src/components/admin/types.ts");
    const start = types.indexOf("export interface SafeCredentialSummary");
    const end = types.indexOf("export interface LearnerSummary");
    const projection = types.slice(start, end);
    expect(projection).toContain("readonly id: string");
    expect(projection).toContain("readonly lastFour: string");
    expect(projection).not.toMatch(/ciphertext|wrappedDataKey|authTag|dataIv|wrapIv|secret/i);
  });
});
