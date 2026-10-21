import {
  lockMailWorkerSource,
  usesMailWorkerRole,
  type MailWorkerLockSource,
} from "./mail-worker-role";
import type { RevocableSourceAuthorityQuery } from "./revocable-source-authority";

type Client = {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
};

const SOURCE_LOCKS = {
  "reset-password": ["verification", ["recipient_user", "source_verification"]],
  "lost-device-proof": ["lost_device_proof", ["recipient_user", "source_proof", "source_session"]],
  "session-revocation-requested": ["session_revocation_request", ["recipient_user", "source_request", "subject_user"]],
  inactivity: ["inactivity_episode", ["recipient_user", "learner_user", "source_episode"]],
  "smart-reminder": ["smart_reminder_dispatch", ["recipient_user", "recipient_preference", "source_dispatch"]],
} as const;

export async function lockMailWorkerRevocableSources(
  client: Client,
  recipientId: string | null,
  query: RevocableSourceAuthorityQuery,
): Promise<RevocableSourceAuthorityQuery | null> {
  if (!usesMailWorkerRole(client)) return query;
  const sourceId = query.values[1];
  if (typeof sourceId !== "string" || !recipientId) return null;
  const [source, aliases] = SOURCE_LOCKS[query.kind];
  if (!await lockMailWorkerSource(client, "user", recipientId)) return null;

  const values = [...query.values];
  let extraPredicate = "";
  let sessionId: string | null = null;
  const bind = (value: string) => { values.push(value); return `$${values.length}::text`; };
  // These reads are hints. Lock the hinted account before the source, then
  // constrain the fresh authority query to the exact locked association.
  // A reassignment committed while waiting therefore fails closed.
  if (source === "lost_device_proof" || source === "session_revocation_request" || source === "inactivity_episode") {
    const projection = source === "lost_device_proof" ? "user_id, session_id" : "user_id";
    const result = await client.query(
      `select ${projection} from public.${source} where id=$1::uuid`, [sourceId],
    );
    const row = result.rows[0] as { user_id?: unknown; session_id?: unknown } | undefined;
    if (result.rows.length !== 1 || typeof row?.user_id !== "string") return null;
    if (row.user_id !== recipientId && !await lockMailWorkerSource(client, "user", row.user_id)) return null;
    const userAlias = source === "lost_device_proof" ? "source_proof"
      : source === "inactivity_episode" ? "source_episode" : "source_request";
    extraPredicate += ` and ${userAlias}.user_id=${bind(row.user_id)}`;
    if (source === "lost_device_proof") {
      if (typeof row.session_id !== "string") return null;
      sessionId = row.session_id;
      extraPredicate += ` and source_proof.session_id=${bind(sessionId)}`;
    }
  }
  if (source === "smart_reminder_dispatch" &&
    !await lockMailWorkerSource(client, "notification_preference", recipientId)) return null;
  if (!await lockMailWorkerSource(client, source as MailWorkerLockSource, sourceId)) return null;
  if (sessionId && !await lockMailWorkerSource(client, "session", sessionId)) return null;

  const clause = /\s+for share of\s+([a-z_,\s]+)\s*$/iu.exec(query.text);
  if (!clause || clause[1].split(",").map(value => value.trim()).join(",") !== aliases.join(",")) {
    throw new Error("Mail source authority lock contract is invalid.");
  }
  if (values.some(value => value instanceof Date)) {
    const clock = await client.query("select pg_catalog.statement_timestamp() as mail_source_now");
    const row = clock.rows[0] as { mail_source_now?: unknown } | undefined;
    const raw = row?.mail_source_now;
    const now = raw instanceof Date ? raw : typeof raw === "string" ? new Date(raw) : null;
    if (clock.rows.length !== 1 || !now || !Number.isFinite(now.getTime())) {
      throw new Error("Mail source authority clock is invalid.");
    }
    for (let index = 0; index < values.length; index++) {
      if (values[index] instanceof Date) values[index] = now;
    }
  }
  return Object.freeze({
    ...query,
    // The caller executes this only after the helper locks finish, giving all
    // unchanged source predicates a fresh READ COMMITTED statement snapshot.
    text: query.text.slice(0, clause.index) + extraPredicate,
    values: Object.freeze(values),
  });
}
