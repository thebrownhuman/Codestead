import { randomUUID } from "node:crypto";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { learnerProfile, providerPolicy, user } from "@/lib/db/schema";
import { writeAuditEventInTransaction } from "@/lib/security/audit-writer";
import type { SealedCredential } from "@/lib/security/credential-vault";
import type { SupportedProvider } from "./types";
import { ProviderError } from "./types";

export type PolicyRow = typeof providerPolicy.$inferSelect;
export type ConnectionChange = { id: string; provider: SupportedProvider; baseUrl: string; platformCredential: SealedCredential | null; version: number };
export interface AdminModelsStore {
  list(): Promise<PolicyRow[]>;
  learnerChoiceCounts?(): Promise<Record<string, number>>;
  connection(provider: SupportedProvider): Promise<PolicyRow | undefined>;
  configure(actorId: string, change: ConnectionChange): Promise<void>;
  save(actorId: string, input: { provider: SupportedProvider; model: string; priority: number; baseUrl: string; version: number; verified: boolean; reportedModel?: string }): Promise<void>;
}
const connectionWhere = (provider: SupportedProvider) => and(eq(providerPolicy.provider, provider), eq(providerPolicy.operation, "provider_configuration"), eq(providerPolicy.model, "connection"));
async function assertVersion(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], provider: SupportedProvider, version: number) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'admin-ai-provider:' + provider}))`);
  const [current] = await tx.select().from(providerPolicy).where(connectionWhere(provider)).limit(1);
  if ((current?.configurationVersion ?? 0) !== version) throw new ProviderError("Connection changed. Reload before continuing.", "POLICY", 409);
}
export const adminModelsStore: AdminModelsStore = {
  async learnerChoiceCounts() {
    const rows = await db.select({ key: learnerProfile.preferredAiModelPolicyId, count: count() })
      .from(learnerProfile).innerJoin(user, eq(user.id, learnerProfile.userId))
      .where(eq(user.role, "learner")).groupBy(learnerProfile.preferredAiModelPolicyId);
    return Object.fromEntries(rows.filter((row) => row.key !== null).map((row) => [row.key, row.count]));
  },
  list: () => db.select().from(providerPolicy).where(inArray(providerPolicy.operation, ["tutor", "provider_configuration"])).orderBy(asc(providerPolicy.priority)),
  async connection(provider) { return (await db.select().from(providerPolicy).where(connectionWhere(provider)).limit(1))[0]; },
  async configure(actorId, change) {
    await db.transaction(async (tx) => {
      await assertVersion(tx, change.provider, change.version);
      const now = new Date();
      await tx.insert(providerPolicy).values({
        id: change.id, provider: change.provider, operation: "provider_configuration", model: "connection", priority: 0,
        baseUrl: change.baseUrl, platformCredential: change.platformCredential, configurationVersion: change.version + 1,
      }).onConflictDoUpdate({ target: [providerPolicy.provider, providerPolicy.operation, providerPolicy.model], set: {
        baseUrl: change.baseUrl, platformCredential: change.platformCredential, configurationVersion: change.version + 1, updatedAt: now,
      } });
      // Endpoint/key changes invalidate model verification and keep the saved
      // policies bound to the current connection revision for tutor routing.
      await tx.update(providerPolicy).set({ baseUrl: change.baseUrl, configurationVersion: change.version + 1, verificationStatus: "untested", verifiedReportedModel: null, verifiedAt: null, updatedAt: now })
        .where(and(eq(providerPolicy.provider, change.provider), inArray(providerPolicy.operation, ["tutor", "credential_validation"])));
      await writeAuditEventInTransaction(tx, { actorUserId: actorId, action: "ai_models.configure", resourceType: "provider_policy", outcome: "success", metadata: { provider: change.provider, revision: change.version + 1, platformAccessConfigured: Boolean(change.platformCredential) } });
    });
  },
  async save(actorId, input) {
    await db.transaction(async (tx) => {
      await assertVersion(tx, input.provider, input.version);
      const now = new Date();
      await tx.update(providerPolicy).set({ enabled: false, updatedAt: now })
        .where(and(eq(providerPolicy.provider, input.provider), inArray(providerPolicy.operation, ["tutor", "credential_validation"])));
      for (const operation of ["tutor", "credential_validation"]) {
        const values = { provider: input.provider, operation, model: input.model, priority: input.priority, enabled: true, baseUrl: input.baseUrl,
          configurationVersion: input.version, verificationStatus: input.verified ? "verified" : "untested", verifiedAt: input.verified ? now : null, verifiedReportedModel: input.verified ? input.reportedModel ?? input.model : null };
        await tx.insert(providerPolicy).values({ id: randomUUID(), ...values }).onConflictDoUpdate({ target: [providerPolicy.provider, providerPolicy.operation, providerPolicy.model], set: { ...values, updatedAt: now } });
      }
      await writeAuditEventInTransaction(tx, { actorUserId: actorId, action: "ai_models.save", resourceType: "provider_policy", outcome: "success", metadata: { provider: input.provider, model: input.model, priority: input.priority, state: input.verified ? "verified" : "untested" } });
    });
  },
};
