import assert from "node:assert/strict";

// Run only against the disposable PostgreSQL replay as its administrator.
// Isolate the real trigger functions so another trigger cannot mask an actor
// rejection. Both allowed actors must complete a valid arm transition.
export async function verifyMailWorkerInvokerGuards(client) {
  const identity = await client.query("select session_user principal");
  const administrator = identity.rows[0].principal;
  assert.match(administrator, /^[a-z_][a-z0-9_]*$/u);
  const schema = "mail_worker_guard_fixture_0074";
  await client.query(`create schema ${schema}`);
  let assertions = 0;
  try {
    await client.query(`grant usage on schema ${schema} to
      learncoding_app, learncoding_worker, learncoding_mail_worker`);
    for (const [name, routine] of [
      ["dispatch", "enforce_email_outbox_dispatch_binding"],
      ["correlation", "enforce_email_outbox_provider_correlation_evidence"],
    ]) {
      await client.query("reset session authorization; reset role");
      const table = `${schema}.${name}`;
      await client.query(`create table ${table} as
        select * from public.email_outbox with no data`);
      await client.query(`create trigger actor_guard before update on ${table}
        for each row execute function public.${routine}()`);
      await client.query(`grant select, update on ${table} to
        learncoding_app, learncoding_worker, learncoding_mail_worker`);
      const arm = `update ${table} set
        provider_call_started=statement_timestamp(), adapter='console',
        dispatch_binding_version='console-json-v1',
        dispatch_binding_sha256=repeat('a',64),
        lease_expires_at=statement_timestamp()+interval '120 seconds',
        updated_at=statement_timestamp()
        ${name === "correlation" ? ", provider_correlation_version='opaque-sha256-v1'" : ""}`;
      for (const [session, role, allowed] of [
        ["learncoding_worker", null, true],
        ["learncoding_mail_worker", null, true],
        ["learncoding_app", null, false],
        [administrator, "learncoding_worker", false],
        [administrator, "learncoding_mail_worker", false],
      ]) {
        await client.query("reset session authorization; reset role");
        await client.query(`truncate ${table}`);
        await client.query(`insert into ${table}
          (id, status, attempt_count, claim_token, claim_owner, claim_version,
           lease_expires_at, created_at, updated_at)
          values (gen_random_uuid(), 'sending', 0, gen_random_uuid(),
            'actor-guard-fixture', 1, now()+interval '60 seconds', now(), now())`);
        await client.query(`set session authorization "${session}"`);
        if (role) await client.query(`set role ${role}`);
        try {
        if (allowed) {
          assert.equal((await client.query(arm)).rowCount, 1,
            `${name}: ${session} must complete the transition`);
          // Actor authorization does not bypass the original shape validator.
          await assert.rejects(client.query(`update ${table} set
            ${name === "correlation" ? "provider_correlation_version" : "dispatch_binding_version"}
            ='invalid-rearm'`), { code: "23514" });
          assertions++;
        } else {
          await assert.rejects(client.query(arm), error =>
            error.code === "42501" && /requires worker identity/u.test(error.message));
        }
        } catch (error) {
          error.message = `${name}: session=${session}, role=${role ?? "none"}: ${error.message}`;
          throw error;
        }
        assertions++;
      }
    }
    await client.query("reset session authorization; reset role");
    await client.query("set session authorization learncoding_mail_worker");
    for (const role of ["learncoding_worker", "learncoding_app", "learncoding_owner"]) {
      await assert.rejects(client.query(`set role ${role}`), { code: "42501" });
      assertions++;
    }
  } finally {
    await client.query("reset session authorization; reset role");
    await client.query(`drop schema ${schema} cascade`);
  }
  return { assertions };
}
