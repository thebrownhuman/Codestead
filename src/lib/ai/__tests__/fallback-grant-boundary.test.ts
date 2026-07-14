import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

describe("administrator fallback grant boundaries", () => {
  it("requires fresh MFA and transactionally revalidates grant authority", () => {
    const route = read("src/app/api/admin/fallback-grants/route.ts");
    const command = read("src/lib/ai/fallback-grants.ts");
    expect(route).toContain('action: "fallback_grant.manage"');
    expect(route).toContain("mfaVerifiedAt");
    expect(route).toContain("requestId: z.string().uuid()");
    expect(route).toContain("model: z.string().trim().min(1).max(200)");
    expect(route).toContain("tokenBudget: z.number().int().min(100).max(10_000_000)");
    expect(route).toContain("rupeeBudgetPaise: z.number().int().min(100).max(10_000_000)");
    expect(command).toContain("30 * 24 * 60 * 60_000");
    expect(command).toContain('eq(user.role, "learner")');
    expect(command).toContain("eq(providerCredential.userId, input.actorUserId)");
    expect(command).toContain('eq(providerCredential.status, "active")');
    expect(command).toContain("eq(providerPolicy.model, input.model)");
    expect(command).toContain("getCurrentConsentsFrom(tx, input.learnerId)");
    expect(command.indexOf("lockUserAuthority(tx, input.learnerId)")).toBeLessThan(
      command.indexOf("fallback-create:${input.actorUserId}:${input.requestId}"),
    );
    expect(command).toContain("ACTIVE_GRANT_CONFLICT");
    expect(command).toContain("writeAuditEventInTransaction(tx");
    expect(command).toContain("notifyFallbackGrantChangedInTransaction(tx");
    expect(command).toContain("usageUnitLimit: grant.tokenBudget");
    expect(command).toContain("currencyLimitPaise: grant.rupeeBudgetPaise");
  });

  it("returns only masked credential metadata from the list endpoint", () => {
    const source = read("src/app/api/admin/fallback-grants/route.ts");
    const safeColumns = source.slice(
      source.indexOf("const safeGrantColumns"),
      source.indexOf("export async function GET"),
    );
    expect(safeColumns).toContain("credentialLastFour");
    expect(safeColumns).not.toMatch(/ciphertext|wrappedDataKey|wrapIv|dataIv|authTag/);
    expect(source).toContain("availableCredentials");
    expect(source).toContain("lastFour: providerCredential.lastFour");
    expect(source).not.toContain("ciphertext: providerCredential.ciphertext");
  });

  it("allows an authorized administrator to revoke any active grant with an idempotent audited command", () => {
    const route = read("src/app/api/admin/fallback-grants/[id]/revoke/route.ts");
    const command = read("src/lib/ai/fallback-grants.ts");
    const revokeCommand = command.slice(command.indexOf("export async function revokeFallbackGrantCommand"));
    expect(route).toContain("requestId: z.string().uuid()");
    expect(route).toContain('action: "fallback_grant.manage"');
    expect(revokeCommand).not.toContain("eq(adminFallbackGrant.grantedBy, input.actorUserId)");
    expect(revokeCommand).toContain("eq(adminFallbackGrant.id, input.grantId)");
    expect(revokeCommand).toContain('.for("update")');
    expect(revokeCommand).toContain('eq(adminFallbackGrant.status, "active")');
    expect(revokeCommand).toContain("revokeRequestHash");
    expect(revokeCommand).toContain("writeAuditEventInTransaction(tx");
    expect(revokeCommand).toContain("notifyFallbackGrantChangedInTransaction(tx");
    expect(revokeCommand).toContain('action: "fallback_grant.revoke"');
  });

  it("uses a dual-budget reservation ledger before fallback transmission", () => {
    const source = read("src/app/api/ai/tutor/route.ts");
    const budget = read("src/lib/ai/fallback-budget.ts");
    expect(source).toContain("reserveFallback:");
    expect(source).toContain("reconcileFallback:");
    expect(source).toContain("fallbackGrantId: row.grantId");
    expect(source).toContain("fallbackCostRemainingPaise");
    expect(source).toContain("fallbackStartsAt: row.startsAt");
    expect(budget).toContain("lockUserAuthority(tx, input.learnerId)");
    expect(budget).toContain('eq(user.status, "active")');
  });

  it("allows grant deletion only inside the explicit account-deletion transaction", () => {
    const migration = read("drizzle/0034_fallback_authority_delete_guard.sql");
    expect(migration).toContain("admin_fallback_grant_delete_guard");
    expect(migration).toContain("app.account_deletion_authorized");
    expect(migration).toContain("Fallback grants cannot be deleted");
  });
});
