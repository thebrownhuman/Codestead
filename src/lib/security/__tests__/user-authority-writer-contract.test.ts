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

    expect(deletion).toContain(
      'import { lockUserAuthorityOnPgClient } from "@/lib/security/user-authority-lock"',
    );
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

  it("serializes lost-device issuance in canonical authority order", () => {
    const recoverySource = source(
      "src/lib/security/lost-device-recovery.ts",
    );
    expect(recoverySource).toContain(
      'import { lockUserAuthority } from "@/lib/security/user-authority-lock"',
    );

    const issueProof = compact(
      recoverySource.slice(
        recoverySource.indexOf("export async function issueLostDeviceProof"),
        recoverySource.indexOf("type VerifiedProof"),
      ),
    );
    const transaction = issueProof.indexOf(
      "return database.transaction(async (tx)",
    );
    const accountLock = issueProof.indexOf(
      "await lockUserAuthority(tx, candidate.userId)",
      transaction,
    );
    const activeUserRead = issueProof.indexOf(
      ".select({ id: user.id, name: user.name, email: user.email })",
      accountLock,
    );
    const activeUserLock = issueProof.indexOf(
      '.for("update")',
      activeUserRead,
    );
    const requestLock = issueProof.indexOf(
      "`lost-device:${candidate.userId}`",
      activeUserLock,
    );
    const sessionRead = issueProof.indexOf(
      ".from(session)",
      requestLock,
    );
    const sessionLock = issueProof.indexOf(
      '.for("update")',
      sessionRead,
    );
    const proofRead = issueProof.indexOf(
      ".from(lostDeviceProof)",
      sessionLock,
    );
    const proofLock = issueProof.indexOf(
      '.for("update")',
      proofRead,
    );
    const outboxEnqueue = issueProof.indexOf(
      "await enqueueEmailInTransaction(tx",
      proofLock,
    );

    expect(transaction).toBeGreaterThanOrEqual(0);
    for (const [earlier, later] of [
      [transaction, accountLock],
      [accountLock, activeUserRead],
      [activeUserRead, activeUserLock],
      [activeUserLock, requestLock],
      [requestLock, sessionRead],
      [sessionRead, sessionLock],
      [sessionLock, proofRead],
      [proofRead, proofLock],
      [proofLock, outboxEnqueue],
    ]) {
      expect(later).toBeGreaterThan(earlier);
    }

    const activeUserBoundary = issueProof.slice(
      activeUserRead,
      activeUserLock,
    );
    expect(activeUserBoundary).toContain(
      "eq(user.id, candidate.userId)",
    );
    expect(activeUserBoundary).toContain(
      "sql`lower(${user.email}) = ${normalizedEmail}`",
    );
    expect(activeUserBoundary).toContain('eq(user.role, "learner")');
    expect(activeUserBoundary).toContain('eq(user.status, "active")');
    expect(activeUserBoundary).toContain("eq(user.emailVerified, true)");
    expect(activeUserBoundary).toContain("eq(user.banned, false)");

    const afterAccountLock = issueProof.slice(accountLock);
    expect(afterAccountLock).toContain("to: activeUser.email");
    expect(afterAccountLock).toContain("name: activeUser.name");
    expect(afterAccountLock).not.toContain("to: candidate.email");
    expect(afterAccountLock).not.toContain("name: candidate.name");
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
