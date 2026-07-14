import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  AdminCredentialError,
  performAdminCredentialOperation,
} from "@/lib/admin-credentials/service";
import { db, pool } from "@/lib/db/client";
import {
  auditEvent,
  consentRecord,
  emailOutbox,
  notification,
  providerCredential,
  user,
} from "@/lib/db/schema";
import { consentInsert } from "@/lib/privacy/consent";

const ADMIN_ID = "credential-admin-integration";
const LEARNER_ID = "credential-learner-integration";
const LEARNER_PUBLIC_ID = "b1000000-0000-4000-8000-000000000002";
const CREDENTIAL_ID = "a1000000-0000-4000-8000-000000000001";

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Administrator credential integration tests require the disposable learncoding_integration database.");
  }
}

async function truncateApplicationTables() {
  assertDisposableDatabase();
  const result = await pool.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  if (!result.rows.length) return;
  const names = result.rows.map(({ table_name }) => `"${table_name.replaceAll('"', '""')}"`).join(", ");
  await pool.query(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
}

beforeEach(async () => {
  await truncateApplicationTables();
  await db.insert(user).values([
    {
      id: ADMIN_ID,
      name: "Credential Administrator",
      email: "credential-admin@integration.invalid",
      status: "active",
      role: "admin",
    },
    {
      id: LEARNER_ID,
      publicId: LEARNER_PUBLIC_ID,
      name: "Credential Learner",
      email: "credential-learner@integration.invalid",
      status: "active",
      role: "learner",
    },
  ]);
  await db.insert(providerCredential).values({
    id: CREDENTIAL_ID,
    userId: LEARNER_ID,
    provider: "nvidia_nim",
    label: "Learner NIM",
    ciphertext: "opaque-ciphertext",
    wrappedDataKey: "opaque-wrapped-key",
    wrapIv: "opaque-wrap-iv",
    dataIv: "opaque-data-iv",
    authTag: "opaque-auth-tag",
    lastFour: "ABCD",
    status: "active",
  });
  await db.insert(consentRecord).values(consentInsert({
    userId: LEARNER_ID,
    purpose: "provider:nvidia_nim",
    decision: "accepted",
    source: "settings",
    requestId: "admin-credential-integration-consent",
  }));
});

afterAll(async () => {
  await pool.end();
});

describe("real PostgreSQL administrator credential operations", () => {
  it("atomically persists the owner-bound change, audit, in-app notice, and email outbox", async () => {
    await expect(performAdminCredentialOperation({
      actorUserId: ADMIN_ID,
      learnerPublicId: LEARNER_PUBLIC_ID,
      credentialId: CREDENTIAL_ID,
      action: "disable",
      reason: "Disable the learner key while the provider issue is reviewed.",
    })).resolves.toMatchObject({ action: "disable", status: "disabled" });

    expect(await db.select({ status: providerCredential.status }).from(providerCredential)).toEqual([
      { status: "disabled" },
    ]);
    expect(await db.select().from(auditEvent)).toEqual([
      expect.objectContaining({
        actorUserId: ADMIN_ID,
        subjectUserId: LEARNER_ID,
        action: "credential.disable",
        resourceId: CREDENTIAL_ID,
        outcome: "success",
      }),
    ]);
    expect(await db.select().from(notification)).toEqual([
      expect.objectContaining({ userId: LEARNER_ID, type: "credential-changed" }),
    ]);
    expect(await db.select().from(emailOutbox)).toEqual([
      expect.objectContaining({ userId: LEARNER_ID, template: "credential-changed" }),
    ]);
  });

  it("rejects a learner actor and a credential that does not belong to the named learner", async () => {
    await expect(performAdminCredentialOperation({
      actorUserId: LEARNER_ID,
      learnerPublicId: LEARNER_PUBLIC_ID,
      credentialId: CREDENTIAL_ID,
      action: "disable",
      reason: "A learner cannot perform this administrator operation.",
    })).rejects.toMatchObject({ code: "ADMIN_REQUIRED" });

    await expect(performAdminCredentialOperation({
      actorUserId: ADMIN_ID,
      learnerPublicId: "b1000000-0000-4000-8000-000000000099",
      credentialId: CREDENTIAL_ID,
      action: "disable",
      reason: "This mismatched learner must not receive the operation.",
    })).rejects.toMatchObject({ code: "CREDENTIAL_NOT_FOUND" });

    const [stored] = await db
      .select({ status: providerCredential.status })
      .from(providerCredential)
      .where(eq(providerCredential.id, CREDENTIAL_ID));
    expect(stored?.status).toBe("active");
    expect(await db.select().from(auditEvent)).toHaveLength(0);
    expect(await db.select().from(notification)).toHaveLength(0);
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });

  it("rolls the credential mutation back when safe audit persistence rejects secret-like reason data", async () => {
    const secretCanary = ["nv", "api-secret-canary-never-persist-123456"].join("");
    await expect(performAdminCredentialOperation({
      actorUserId: ADMIN_ID,
      learnerPublicId: LEARNER_PUBLIC_ID,
      credentialId: CREDENTIAL_ID,
      action: "disable",
      reason: secretCanary,
    })).rejects.toThrow();

    const [stored] = await db
      .select({ status: providerCredential.status })
      .from(providerCredential)
      .where(eq(providerCredential.id, CREDENTIAL_ID));
    expect(stored?.status).toBe("active");
    expect(JSON.stringify(await db.select().from(auditEvent))).not.toContain(secretCanary);
    expect(await db.select().from(auditEvent)).toHaveLength(0);
    expect(await db.select().from(notification)).toHaveLength(0);
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });

  it("commits audit and learner notices before any test can open or transmit a key", async () => {
    const secretCanary = ["nv", "api-preflight-canary-never-persist-123456"].join("");
    delete process.env.CREDENTIAL_MASTER_KEY;
    await expect(performAdminCredentialOperation({
      actorUserId: ADMIN_ID,
      learnerPublicId: LEARNER_PUBLIC_ID,
      credentialId: CREDENTIAL_ID,
      action: "test",
      reason: secretCanary,
    })).rejects.toThrow(/Secret-like value/i);

    expect(JSON.stringify(await db.select().from(auditEvent))).not.toContain(secretCanary);
    expect(await db.select().from(auditEvent)).toHaveLength(0);
    expect(await db.select().from(notification)).toHaveLength(0);
    expect(await db.select().from(emailOutbox)).toHaveLength(0);
  });

  it("does not accept secret material on a non-replacement action", async () => {
    await expect(performAdminCredentialOperation({
      actorUserId: ADMIN_ID,
      learnerPublicId: LEARNER_PUBLIC_ID,
      credentialId: CREDENTIAL_ID,
      action: "disable",
      reason: "Reject replacement material on this disable operation.",
      replacementSecret: "must-never-be-accepted-here",
    })).rejects.toEqual(expect.any(AdminCredentialError));
  });
});
