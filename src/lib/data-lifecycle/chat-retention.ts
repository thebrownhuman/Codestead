import type { PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { writeAuditEventInTransaction } from "@/lib/security/audit-writer";
import { RETENTION_POLICY_VERSION, TUTOR_CONVERSATION_LIMIT } from "./policy";

// Creation order defines the latest conversations. Reopening or archiving an
// older thread does not evict a newer conversation. The UUID breaks ties.
const rankedThreads = `select id, user_id, created_at,
  row_number() over (partition by user_id order by created_at desc, id desc) as position
  from chat_thread`;

export async function countExcessTutorConversations(client: Pick<PoolClient, "query">) {
  const result = await client.query<{ count: string }>(
    `select count(*)::text as count from (${rankedThreads}) ranked where position > $1`, [TUTOR_CONVERSATION_LIMIT]);
  return Number(result.rows[0]?.count ?? 0);
}

// Called only inside the existing retention transaction. Cascading FK deletion
// removes messages; each deletion and its audit roll back together. The
// lifecycle checkpoint also records counts for crash-safe sweep resumption.
export async function deleteExcessTutorConversations(client: PoolClient, batchSize: number, lifecycleRunId: string) {
  const result = await client.query<{ id: string; user_id: string }>(
    `delete from chat_thread target using (
       select id, user_id from (${rankedThreads}) ranked
       where position > $1 order by created_at asc, id asc limit $2
     ) excess where target.id = excess.id and target.user_id = excess.user_id returning target.id, target.user_id`,
    [TUTOR_CONVERSATION_LIMIT, batchSize]);
  const auditTransaction = drizzle(client);
  for (const thread of result.rows) {
    await writeAuditEventInTransaction(auditTransaction, {
      subjectUserId: thread.user_id,
      action: "retention.deleted",
      resourceType: "chat_thread",
      resourceId: thread.id,
      reason: "Conversation exceeds the per-user latest-10 retention cap.",
      outcome: "success",
      metadata: { category: "tutorConversationCap", policyVersion: RETENTION_POLICY_VERSION, lifecycleRunId },
    });
  }
  return result.rowCount ?? 0;
}
