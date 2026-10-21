const mailExecutors = new WeakSet<object>();

export function registerMailWorkerResources(
  pool: object,
  database: object,
  connectionString: string,
) {
  // This only chooses the SQL adapter. PostgreSQL independently authenticates
  // the principal and every SECURITY DEFINER helper checks session_user.
  let username: string;
  try { username = decodeURIComponent(new URL(connectionString).username); }
  catch { throw new Error("Mail database configuration is invalid."); }
  if (username === "learncoding_mail_worker") {
    mailExecutors.add(pool);
    mailExecutors.add(database);
  }
}

export function usesMailWorkerRole(executor: object) {
  return mailExecutors.has(executor);
}

export function inheritMailWorkerRole(parent: object, executor: object) {
  if (usesMailWorkerRole(parent)) mailExecutors.add(executor);
}

export type MailWorkerLockSource =
  | "user" | "notification_preference" | "access_request" | "invitation"
  | "verification" | "lost_device_proof" | "session"
  | "session_revocation_request" | "inactivity_episode" | "smart_reminder_dispatch";

export async function lockMailWorkerSource(
  client: { query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> },
  source: MailWorkerLockSource,
  id: string,
  mode: "share" | "update" = "share",
) {
  const result = await client.query(
    "select public.mail_worker_lock_source_v1($1,$2,$3) as locked",
    [source, id, mode],
  );
  const row = result.rows[0] as { locked?: unknown } | undefined;
  if (result.rows.length !== 1 || typeof row?.locked !== "boolean") {
    throw new Error("Mail source lock result is invalid.");
  }
  return row.locked;
}

export function mailWorkerReleaseRoutine(executor: object) {
  return usesMailWorkerRole(executor)
    ? "public.mail_worker_release_email_outbox_delivery"
    : "public.release_email_outbox_delivery";
}

export function mailWorkerCallableQuery(executor: object, text: string) {
  if (!usesMailWorkerRole(executor)) return text;
  // Preserve every authority predicate. The two private-marker checks are
  // delegated to the reviewed owner helper, which returns NULL unless the
  // exact six-field tuple exists and both markers are NULL. Receipt matching
  // remains in the caller. Lock clauses are handled explicitly by callers.
  return text
    .replace(/(?<!['"\w])public\.mail_delivery_release_receipt_sha256\s*\(/gu,
      "public.mail_worker_mail_delivery_release_receipt_sha256(")
    .replace(/(?<!['"\w])public\.backup_status_mail_authorized\s*\(/gu,
      "public.mail_worker_backup_status_mail_authorized(")
    .replace(/\b(outbox|candidate)\.delivery_release_insert_xid\s+is\s+null\s+and\s+\1\.delivery_release_insert_system_identifier\s+is\s+null/giu,
      (_match, alias: "outbox" | "candidate") =>
        `public.mail_worker_mail_delivery_release_receipt_sha256(${alias}.id, ${alias}.operation_id, ` +
        `${alias}.idempotency_authority_version, ${alias}.idempotency_authority_sha256, ` +
        `${alias}.idempotency_original_payload_sha256, ${alias}.delivery_hold_version) is not null`);
}
