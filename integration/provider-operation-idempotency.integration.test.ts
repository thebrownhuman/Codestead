import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const validation = vi.hoisted(() => ({ call: vi.fn() }));

vi.mock("@/lib/ai/credential-validation", () => ({
  validateProviderCredential: validation.call,
}));

import { performAdminCredentialOperation } from "@/lib/admin-credentials/service";
import {
  canonicalProviderOperationHash,
  executeProviderOperationIdempotently,
  PostgresProviderOperationReceiptStore,
} from "@/lib/ai/provider-operation-idempotency";
import { db, pool } from "@/lib/db/client";
import {
  auditEvent,
  chatMessage,
  chatThread,
  consentRecord,
  emailOutbox,
  modelCall,
  notification,
  providerCredential,
  providerOperationReceipt,
  user,
} from "@/lib/db/schema";
import { consentInsert } from "@/lib/privacy/consent";
import { sealCredential } from "@/lib/security/credential-vault";

const ADMIN_ID = "provider-idempotency-admin";
const LEARNER_ID = "provider-idempotency-learner";
const LEARNER_PUBLIC_ID = "71000000-0000-4000-8000-000000000001";
const CREDENTIAL_ID = "72000000-0000-4000-8000-000000000001";
const THREAD_ID = "73000000-0000-4000-8000-000000000001";
const MODEL_CALL_ID = "74000000-0000-4000-8000-000000000001";
const REQUEST_ID = "75000000-0000-4000-8000-000000000001";
const masterKey = Buffer.alloc(32, 17);
const storedSecret = "synthetic-provider-material-ABCD";

function assertDisposableDatabase() {
  const connectionString = process.env.DATABASE_URL ?? "";
  if (process.env.INTEGRATION_TEST !== "1" || !/\/learncoding_integration(?:\?|$)/.test(connectionString)) {
    throw new Error("Provider-operation idempotency tests require the disposable learncoding_integration database.");
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
  validation.call.mockReset().mockResolvedValue({ status: "active", failureCode: null, model: "reviewed-test-model" });
  process.env.CREDENTIAL_MASTER_KEY = masterKey.toString("base64");
  await db.insert(user).values([
    {
      id: ADMIN_ID,
      name: "Provider Receipt Admin",
      email: "provider-receipt-admin@integration.invalid",
      role: "admin",
      status: "active",
    },
    {
      id: LEARNER_ID,
      publicId: LEARNER_PUBLIC_ID,
      name: "Provider Receipt Learner",
      email: "provider-receipt-learner@integration.invalid",
      role: "learner",
      status: "active",
    },
  ]);
  const sealed = sealCredential(storedSecret, {
    credentialId: CREDENTIAL_ID,
    userId: LEARNER_ID,
    provider: "nvidia_nim",
    keyVersion: 1,
  }, masterKey);
  await db.insert(providerCredential).values({
    id: CREDENTIAL_ID,
    userId: LEARNER_ID,
    provider: "nvidia_nim",
    label: "Integration provider",
    ...sealed,
    status: "active",
  });
  await db.insert(consentRecord).values(consentInsert({
    userId: LEARNER_ID,
    purpose: "provider:nvidia_nim",
    decision: "accepted",
    source: "settings",
    requestId: "provider-receipt-consent",
  }));
});

afterAll(async () => {
  delete process.env.CREDENTIAL_MASTER_KEY;
  await pool.end();
});

describe("real PostgreSQL provider-operation idempotency", () => {
  it("recovers an expired lease without another provider call and fences the stale completion", async () => {
    const requestId = "75000000-0000-4000-8000-000000000099";
    const inputHash = canonicalProviderOperationHash({ message: "Expired synthetic operation" });
    const staleLease = {
      leaseId: "76000000-0000-4000-8000-000000000001",
      leaseVersion: 7,
    } as const;
    await db.insert(providerOperationReceipt).values({
      ownerUserId: LEARNER_ID,
      action: "tutor.post",
      requestId,
      inputHash,
      ...staleLease,
      leaseExpiresAt: new Date("2026-07-11T00:00:00.000Z"),
    });
    const execute = vi.fn(async () => ({ status: 200, body: { content: "must not execute" } }));

    const recovered = await executeProviderOperationIdempotently({
      ownerUserId: LEARNER_ID,
      action: "tutor.post",
      requestId,
      inputHash,
      execute,
      pollIntervalMs: 1,
    });
    expect(recovered).toEqual({
      status: 503,
      body: expect.objectContaining({
        code: "PROVIDER_OPERATION_INDETERMINATE",
        degraded: true,
      }),
      replayed: true,
    });
    expect(execute).not.toHaveBeenCalled();
    const [receipt] = await db.select().from(providerOperationReceipt);
    expect(receipt).toMatchObject({
      status: "completed",
      responseStatus: 503,
      leaseVersion: 8,
    });
    expect(receipt!.leaseId).not.toBe(staleLease.leaseId);

    await expect(new PostgresProviderOperationReceiptStore().complete({
      ownerUserId: LEARNER_ID,
      action: "tutor.post",
      requestId,
      inputHash,
    }, {
      status: 200,
      body: { content: "late stale response" },
    }, staleLease)).rejects.toMatchObject({ code: "IDEMPOTENCY_RECEIPT_UNAVAILABLE" });
    expect((await db.select().from(providerOperationReceipt))[0]).toMatchObject({
      status: "completed",
      responseStatus: 503,
      leaseVersion: 8,
    });
  });

  it("serializes concurrent tutor retries to one provider call and one persisted chat/model-call set", async () => {
    let providerCalls = 0;
    const input = {
      ownerUserId: LEARNER_ID,
      action: "tutor.post" as const,
      requestId: REQUEST_ID,
      inputHash: canonicalProviderOperationHash({
        courseId: "python",
        skillId: "python.values.scalars",
        message: "Explain scalar values.",
        threadId: null,
      }),
    };
    const execute = async () => {
      providerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      await db.transaction(async (tx) => {
        await tx.insert(modelCall).values({
          id: MODEL_CALL_ID,
          userId: LEARNER_ID,
          provider: "nvidia_nim",
          model: "reviewed-test-model",
          operation: "tutor",
          promptVersion: "buddy-tutor-v3",
          status: "succeeded",
          requestHash: input.inputHash,
          responseHash: "b".repeat(64),
        });
        await tx.insert(chatThread).values({ id: THREAD_ID, userId: LEARNER_ID, title: "Python: Scalars" });
        await tx.insert(chatMessage).values([
          { threadId: THREAD_ID, role: "user", content: "Explain scalar values." },
          { threadId: THREAD_ID, role: "assistant", content: "A scalar is one value.", modelCallId: MODEL_CALL_ID },
        ]);
      });
      return {
        status: 200,
        body: { content: "A scalar is one value.", threadId: THREAD_ID, callId: MODEL_CALL_ID },
      };
    };

    const [first, concurrent] = await Promise.all([
      executeProviderOperationIdempotently({ ...input, execute, pollIntervalMs: 5 }),
      executeProviderOperationIdempotently({ ...input, execute, pollIntervalMs: 5 }),
    ]);
    const lostResponseReplay = await executeProviderOperationIdempotently({
      ...input,
      execute: async () => ({ status: 500, body: { error: "must not execute" } }),
    });

    expect(providerCalls).toBe(1);
    expect([first.replayed, concurrent.replayed].sort()).toEqual([false, true]);
    expect(lostResponseReplay).toEqual({ ...first, replayed: true });
    expect(await db.select().from(modelCall)).toHaveLength(1);
    expect(await db.select().from(chatThread)).toHaveLength(1);
    expect(await db.select().from(chatMessage)).toHaveLength(2);
    expect(await db.select().from(providerOperationReceipt)).toEqual([
      expect.objectContaining({
        ownerUserId: LEARNER_ID,
        action: "tutor.post",
        requestId: REQUEST_ID,
        inputHash: input.inputHash,
        status: "completed",
        responseStatus: 200,
      }),
    ]);

    await expect(executeProviderOperationIdempotently({
      ...input,
      inputHash: canonicalProviderOperationHash({ message: "Changed payload" }),
      execute,
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(providerCalls).toBe(1);
  });

  it.each(["test", "replace"] as const)(
    "serializes concurrent administrator credential %s operations through the actual service",
    async (action) => {
      const reason = `Validate the learner credential through one durable ${action} request.`;
      const replacementSecret = "synthetic-replacement-material-WXYZ";
      const inputHash = canonicalProviderOperationHash({
        credentialId: CREDENTIAL_ID,
        learnerId: LEARNER_PUBLIC_ID,
        action,
        reason,
        ...(action === "replace" ? { replacementSecret } : {}),
      });
      const input = {
        ownerUserId: ADMIN_ID,
        action: `credential.${action}` as const,
        requestId: REQUEST_ID,
        inputHash,
      };
      const execute = async () => {
        const result = await performAdminCredentialOperation({
          actorUserId: ADMIN_ID,
          learnerPublicId: LEARNER_PUBLIC_ID,
          credentialId: CREDENTIAL_ID,
          action,
          reason,
          ...(action === "replace" ? { replacementSecret } : {}),
        });
        return {
          status: 200,
          body: {
            ok: true,
            action: result.action,
            status: result.status,
            auditCorrelationId: result.auditCorrelationId,
          },
        };
      };

      const [first, concurrent] = await Promise.all([
        executeProviderOperationIdempotently({ ...input, execute, pollIntervalMs: 5 }),
        executeProviderOperationIdempotently({ ...input, execute, pollIntervalMs: 5 }),
      ]);
      const replay = await executeProviderOperationIdempotently({
        ...input,
        execute: async () => ({ status: 500, body: { error: "must not execute" } }),
      });

      expect(validation.call).toHaveBeenCalledTimes(1);
      expect([first.replayed, concurrent.replayed].sort()).toEqual([false, true]);
      expect(replay).toEqual({ ...first, replayed: true });
      expect(await db.select().from(auditEvent)).toHaveLength(2);
      expect(await db.select().from(notification)).toHaveLength(2);
      expect(await db.select().from(emailOutbox)).toHaveLength(2);
      expect(await db.select().from(providerOperationReceipt)).toEqual([
        expect.objectContaining({
          ownerUserId: ADMIN_ID,
          action: `credential.${action}`,
          requestId: REQUEST_ID,
          inputHash,
          status: "completed",
          responseStatus: 200,
        }),
      ]);
      const [credential] = await db.select({
        keyVersion: providerCredential.keyVersion,
        status: providerCredential.status,
      }).from(providerCredential);
      expect(credential).toEqual({ keyVersion: action === "replace" ? 2 : 1, status: "active" });
      expect(JSON.stringify(await db.select().from(providerOperationReceipt))).not.toContain(replacementSecret);
    },
  );
});
