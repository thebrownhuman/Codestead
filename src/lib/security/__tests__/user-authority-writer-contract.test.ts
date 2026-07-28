import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

function compact(value: string) {
  return value.replace(/\s+/g, " ");
}

describe("production user-authority writers", () => {
  it("takes the shared account lock before every account-deletion user/outbox phase", () => {
    const deletion = source("src/lib/data-lifecycle/deletion.ts");
    const normalized = compact(deletion);

    expect(deletion).toContain("lockAccessRequestAuthorityOnPgClient");
    expect(deletion).toContain("lockUserAuthorityOnPgClient");
    expect(deletion).not.toContain("userAuthorityLockKey");
    expect(
      normalized.match(
        /await lockUserAuthorityOnPgClient\(client, input\.learnerId\)/g,
      ),
    ).toHaveLength(3);

    const phases = normalized.split(
      "await lockUserAuthorityOnPgClient(client, input.learnerId)",
    ).slice(1);
    expect(phases).toHaveLength(3);
    for (const phase of phases) {
      const nextAuthorityOperation = phase.search(
        /select role, status from "user"|select status from "user"|lockDeletionOutboxRows\(/,
      );
      expect(nextAuthorityOperation).toBeGreaterThanOrEqual(0);
      expect(phase.slice(0, nextAuthorityOperation)).not.toMatch(
        /from "user"|update "user"|delete from email_outbox|lockDeletionOutboxRows\(/,
      );
    }
  });

  it("locks onboarding activation before selecting or updating the user", () => {
    const activation = compact(
      source("src/app/api/onboarding/complete/route.ts"),
    );
    const lock = activation.indexOf(
      "await lockUserAuthority(tx, authz.session.user.id)",
    );
    const accountRead = activation.indexOf(
      ".select({ status: user.status })",
      lock,
    );
    const activationWrite = activation.indexOf(
      '.set({ status: "active" })',
      accountRead,
    );

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(accountRead).toBeGreaterThan(lock);
    expect(activationWrite).toBeGreaterThan(accountRead);
  });

  it("locks bootstrap role/status mutation before touching the created user", () => {
    const bootstrap = compact(source("scripts/bootstrap-admin.ts"));
    const transaction = bootstrap.indexOf("await db.transaction(async (tx)");
    const lock = bootstrap.indexOf(
      "await lockUserAuthority(tx, result.user.id)",
      transaction,
    );
    const update = bootstrap.indexOf(".update(user)", lock);

    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(lock).toBeGreaterThan(transaction);
    expect(update).toBeGreaterThan(lock);
  });

  it("locks quota mutation and revalidates the active public identity before recreating learner rows", () => {
    const quota = compact(source("src/lib/storage/admin-quota.ts"));
    const identity = quota.indexOf("const [identity] = await tx");
    const authorityLock = quota.indexOf(
      "await lockUserAuthority(tx, identity.id)",
      identity,
    );
    const uploadLock = quota.indexOf(
      "pg_advisory_xact_lock(hashtext(${identity.id}))",
      authorityLock,
    );
    const current = quota.indexOf("const [current] = await tx", uploadLock);
    const profileInsert = quota.indexOf("tx.insert(learnerProfile)", current);
    const notificationInsert = quota.indexOf("tx.insert(notification)", current);

    expect(identity).toBeGreaterThanOrEqual(0);
    expect(authorityLock).toBeGreaterThan(identity);
    expect(uploadLock).toBeGreaterThan(authorityLock);
    expect(current).toBeGreaterThan(uploadLock);
    expect(quota.slice(current, profileInsert)).toContain(
      "eq(user.publicId, request.learnerPublicId)",
    );
    expect(quota.slice(current, profileInsert)).toContain(
      'eq(user.status, "active")',
    );
    expect(profileInsert).toBeGreaterThan(current);
    expect(notificationInsert).toBeGreaterThan(profileInsert);
  });

  it("keeps generic Better Auth user/admin mutations outside the raw HTTP surface", () => {
    const managementPolicy = source(
      "src/lib/security/better-auth-management-policy.ts",
    );
    for (const path of [
      "/update-user",
      "/delete-user",
      "/admin/set-role",
      "/admin/ban-user",
      "/admin/unban-user",
      "/admin/remove-user",
    ]) {
      expect(managementPolicy).not.toContain(`"${path}"`);
    }
    expect(managementPolicy).toContain('if (method !== "POST") return "deny"');
    expect(managementPolicy).toContain("return ALLOWED_POST_PATHS.has(path)");
  });
});
