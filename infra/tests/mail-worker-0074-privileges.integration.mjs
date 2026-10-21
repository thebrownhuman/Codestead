import assert from "node:assert/strict";
import inventory from "../../drizzle/meta/0074_mail_runtime.json" with { type: "json" };

// Run against the disposable replay before role activation. SET SESSION
// AUTHORIZATION uses the actual principal without fabricating membership.
export async function verifyMailWorkerColumnPrivileges(client) {
  let assertions = 0;
  await client.query("set session authorization learncoding_mail_worker");
  try {
    const groups = new Map();
    for (const grant of inventory.grants.filter(row => row.objectKind === "column")) {
      const parts = grant.objectIdentity.split(".");
      const column = parts.pop();
      const table = parts.map(part => `"${part}"`).join(".");
      const key = `${grant.privilege}:${table}`;
      const group = groups.get(key) ?? { table, privilege: grant.privilege, columns: [] };
      group.columns.push(`"${column}"`);
      groups.set(key, group);
    }
    for (const { table, privilege, columns } of groups.values()) {
      if (privilege === "SELECT") {
        await client.query(`select ${columns.join(",")} from ${table} limit 0`);
      } else if (privilege === "UPDATE") {
        await client.query(`update ${table} set
          ${columns.map(column => `${column}=NULL`).join(",")} where false`);
      } else {
        // EXPLAIN without ANALYZE checks INSERT privileges without inventing
        // business fixtures or relaxing constraints for the role.
        await client.query(`explain insert into ${table} (${columns.join(",")})
          values (${columns.map(() => "NULL").join(",")})`);
      }
      assertions++;
    }
    for (const query of [
      'select token from public.session limit 0',
      'select ip_address from public.session limit 0',
      'select user_agent from public.session limit 0',
      'select preferred_ai_model_policy_id from public.learner_profile limit 0',
      'select delivery_release_insert_xid from public.email_outbox limit 0',
      'select delivery_release_insert_system_identifier from public.email_outbox limit 0',
      'select * from public.account limit 0',
      'select * from public.provider_policy limit 0',
      'select * from drizzle.__drizzle_migrations limit 0',
      'delete from public.email_outbox where false',
      'update public."user" set status=status where false',
      'select id from public."user" where false for share',
      'set role learncoding_owner',
      'set role learncoding_worker',
      'set role learncoding_app',
    ]) {
      await assert.rejects(client.query(query), { code: "42501" });
      assertions++;
    }
    for (const source of ["user", "notification_preference"]) {
      assert.equal((await client.query(
        "select public.mail_worker_lock_source_v1($1,$2,'update') locked",
        [source, "nonexistent-mail-role-fixture"],
      )).rows[0].locked, false);
      assertions++;
    }
    for (const [source, mode] of [["account", "share"], ["session", "update"]]) {
      await assert.rejects(client.query(
        "select public.mail_worker_lock_source_v1($1,$2,$3)",
        [source, "nonexistent-mail-role-fixture", mode],
      ), { code: "42501" });
      assertions++;
    }
  } finally {
    await client.query("reset session authorization; reset role");
  }
  return { assertions };
}
