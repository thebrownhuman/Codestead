import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(path.join(testDirectory, name), "utf8");
const wrapperPath = path.join(
  testDirectory,
  "mail-guarded-delivery-0069.integration.mjs",
);
const wrapper = read("mail-guarded-delivery-0069.integration.mjs");
const implementation = read("mail-guarded-delivery-0069.impl.mjs");

test("0069 wrapper exposes only one fixed failure diagnostic", () => {
  assert.match(
    wrapper,
    /"mail_guarded_delivery_0069_error=HARNESS_FAILED\\n"/u,
  );
  assert.match(wrapper, /process[.]stderr[.]write[(]HARNESS_FAILURE[)]/u);
  assert.doesNotMatch(
    wrapper,
    /[.]stack|[.]message|[.]cause|String[(]|console[.]/u,
  );
});

test("0069 full-apply failures roll back with zero successor footprint", () => {
  for (const marker of [
    "applyAsOwnerFromFile",
    "writeFileSync",
    "`--file=${sqlFile}`",
    "proveDrainedBacklogRollback",
    "0069 requires a drained nonterminal outbox backlog",
    "proveLateCatalogRollback",
    "mail_delivery_release_receipt_authority_fk_idx",
    "0069 terminal catalog contract is invalid",
    "assertNo0069Footprint",
    "predecessorDigest",
  ]) {
    assert.ok(implementation.includes(marker), `missing ${marker}`);
  }
  assert.doesNotMatch(implementation, /pg_catalog[.]md5/u);
});

test("0069 populated replay restores data and hostile ACLs exactly", () => {
  const main = implementation.slice(
    implementation.indexOf("export async function main()"),
  );
  const ordered = [
    "proveIssuanceAndRequestHold(port)",
    "const populatedDataDigest = mailAuthorityDigest(port)",
    "const populatedCatalogAndAclDigest = guardedAclDigest(port)",
    "repoison0069Acl(port)",
    "assert.notEqual(guardedAclDigest(port), populatedCatalogAndAclDigest)",
    "applyAsOwnerFromFile(",
    '"migration-0069-repoison-repair.sql"',
    "assert.equal(mailAuthorityDigest(port), populatedDataDigest)",
    "assert.equal(guardedAclDigest(port), populatedCatalogAndAclDigest)",
  ];
  let previous = -1;
  for (const marker of ordered) {
    const index = main.indexOf(marker, previous + 1);
    assert.ok(index > previous, `${marker} must follow its predecessor`);
    previous = index;
  }
});

test("0069 selects exactly one native major and isolates libpq", () => {
  assert.match(implementation, /POSTGRES_17_BIN/u);
  assert.match(implementation, /POSTGRES_18_BIN/u);
  assert.match(implementation, /selected[.]length,\s*1/u);
  assert.match(implementation, /expectedMajor/u);
  assert.match(implementation, /LIBPQ_ENVIRONMENT_KEYS/u);
  assert.match(implementation, /PGCHANNELBINDING/u);
  assert.match(implementation, /PGSSLNEGOTIATION/u);
  assert.match(implementation, /statement_timeout=25000/u);
  assert.match(implementation, /idle_in_transaction_session_timeout=25000/u);
  assert.doesNotMatch(implementation, /[.][.][.]process[.]env/u);
  assert.doesNotMatch(implementation, /docker/iu);
});

test("0069 applies the contiguous raw ledger, tamper-probes, and replays", () => {
  for (const marker of [
    "migrationFilesThrough(68)",
    "0069_mail_outbox_guarded_delivery_authority.sql",
    "provePredecessorTamperRollback",
    "enforce_email_outbox_delivery_hold",
    "applyAsOwner(port, migration0069)",
    "assertCatalogAndAcl",
  ]) {
    assert.ok(implementation.includes(marker));
  }
  const main = implementation.slice(
    implementation.indexOf("export async function main()"),
  );
  const ordered = [
    "for (const migrationFile of migrationFilesThrough(68))",
    "proveInheritedAclTamperRollback(port, migration0069, temporaryRoot)",
    "proveDigestHelperTamperRollback(port, migration0069, temporaryRoot)",
    "seedAdministrator(port)",
    "provePredecessorTamperRollback(port, migration0069)",
    "proveDrainedBacklogRollback(port, migration0069, temporaryRoot)",
    "proveLateCatalogRollback(port, migration0069, temporaryRoot)",
    "applyAsOwner(port, migration0069);",
    "assertCatalogAndAcl(port);",
    '"migration-0069-idempotent-replay.sql"',
    "assertCatalogAndAcl(port);",
    "proveTask5RelationAclTamperRollback(port, migration0069, temporaryRoot);",
    "assertCatalogAndAcl(port);",
    "proveIssuanceAndRequestHold(port);",
  ];
  let previous = -1;
  for (const marker of ordered) {
    const index = main.indexOf(marker, previous + 1);
    assert.ok(index > previous, `${marker} must follow its predecessor`);
    previous = index;
  }
});

test("0069 independently proves catalog ACL issuance and request hold", () => {
  for (const marker of [
    "mail_delivery_release_receipt",
    "release_email_outbox_delivery",
    "enqueue_backup_status_mail_authority",
    "learncoding_backup_reporter",
    "learncoding_worker",
    "pg_catalog.aclexplode",
    "assertDigestHelperCatalog",
    "pg_catalog.pg_get_functiondef",
    "6b7100af8bd25093520317e67d5a06b40848b192ca94eb4b6c63ef48adcf89a2",
    "dbb1e105e567de47875c1bdd433b61cc78745fc0bc7953daa68b6f3f2bf83315",
    "has_function_privilege",
    "has_column_privilege",
    "idempotency_original_payload_sha256\\|learncoding_owner\\|learncoding_worker\\|select\\|false",
    "indclass::pg_catalog.oid\\[\\]",
    "indcollation::pg_catalog.oid\\[\\]",
    "indoption::pg_catalog.int2\\[\\]",
    "WITH ORDINALITY AS indexed_attribute",
    "WITH ORDINALITY AS indexed_class",
    "WITH ORDINALITY AS indexed_collation",
    "WITH ORDINALITY AS indexed_option",
    "WITH ORDINALITY AS routine_argument",
    "pg_catalog.cardinality\\(\\s*trigger_row.tgattr::pg_catalog.int2\\[\\]",
    "'MAINTAIN'::pg_catalog.text",
    "relation.relnatts = 8",
    "NOT attribute.atthasmissing",
    "attribute.attmissingval IS NULL",
    "attribute.attoptions IS NULL",
    "attribute.attfdwoptions IS NULL",
    "attribute.attcompression = ''::\"char\"",
    "not_null_constraint.contype = 'n'",
    "constraint_row.conindid = expected.index_oid",
    "relation\\.relnamespace = namespace\\.oid",
    "provider_request_body_sha256",
    "provider_request_body_length",
    "delivery_release_insert_system_identifier",
    "email_outbox_delivery_release_insert_identity_valid",
    "console-json-v1",
    "opaque-sha256-v1",
    "assertExactFirstClaim",
    "RETURNING pg_catalog.concat_ws",
    "ON DELETE CASCADE",
    "mail_delivery_release_receipt_authority_fk_idx",
    "proveStateArcBounds",
    "proveLateInsertMutationRollback",
    "enforce_email_outbox_delivery_release_insert_final",
    "zz_email_outbox_delivery_release_insert_final",
    "email outbox delivery release final insert state is invalid",
    "proveDeferredInitialTimestampRollback",
    "DISABLE TRIGGER zz_email_outbox_delivery_release_insert_final",
    "SET SESSION AUTHORIZATION learncoding_app",
    "email_outbox_delivery_release_commit_exact IMMEDIATE",
    "email outbox initial timestamps are invalid",
    "proveReplicaDeleteRollback",
    "session_replication_role = replica",
    "email outbox deletion would orphan a durable release receipt",
    "mail delivery release receipt parent still exists",
    "enforce_email_outbox_delivery_release_commit_exact",
    "enforce_email_outbox_delivery_release_delete_exact",
    "enforce_mail_delivery_release_receipt_delete_exact",
    "pg_sleep",
    "'infinity'::pg_catalog.timestamptz",
    "interval '7 hours'",
    "email outbox idempotency event payload conflict",
    "permission denied for table mail_delivery_release_receipt",
    "mail delivery release receipts are append-only",
    "request-body binding is immutable",
    "pg_catalog.transaction_timestamp",
    "beforeUnreleasedInsert",
    "email outbox delivery release is incomplete at commit",
  ]) {
    assert.match(implementation, new RegExp(marker, "u"));
  }
  assert.doesNotMatch(implementation, /MAIL_0069_LIFECYCLE_CATALOG_PROBE/u);
  assert.doesNotMatch(
    implementation,
    /index_row\.ind(?:key|class|collation|option)::pg_catalog\.(?:int2|oid)\[\]\s*=/u,
  );
  assert.doesNotMatch(
    implementation,
    /trigger_row\.tgattr::pg_catalog\.int2\[\]\s*=\s*ARRAY/u,
  );
  assert.doesNotMatch(
    implementation,
    /routine\.proargtypes::pg_catalog\.oid\[\]\s*=/u,
  );
  assert.doesNotMatch(implementation, /GRANT SELECT, INSERT/u);
  const appInsert = implementation.slice(
    implementation.indexOf("function appInsertSql"),
    implementation.indexOf("function appReleaseSql"),
  );
  assert.doesNotMatch(
    appInsert,
    /attempt_count|claim_version|created_at|updated_at/u,
  );
});

test("0069 cleanup verifies the exact process and listener before removal", () => {
  const stop = implementation.indexOf('"stop"');
  const listener = implementation.lastIndexOf("assertNoListener");
  const pid = implementation.lastIndexOf("assertPostmasterStopped");
  const guardedRemoval = implementation.lastIndexOf(
    "if (listenerStopped && postmasterStopped)",
  );
  const remove = implementation.lastIndexOf("rmSync");
  assert.ok(stop >= 0);
  assert.ok(listener > stop);
  assert.ok(pid > stop);
  assert.ok(guardedRemoval > listener);
  assert.ok(guardedRemoval > pid);
  assert.ok(remove > guardedRemoval);
  assert.match(implementation, /preserveOperationAndCleanupFailures/u);
  assert.match(implementation, /AggregateError/u);
  assert.match(implementation, /assert[.]notEqual[(]port,\s*5432[)]/u);
  assert.match(implementation, /--data-checksums/u);
  assert.match(implementation, /127[.]0[.]0[.]1/u);
});

test("0069 wrapper fails closed without a native major selection", () => {
  const environment = { ...process.env };
  delete environment.POSTGRES_17_BIN;
  delete environment.POSTGRES_18_BIN;
  const result = spawnSync(process.execPath, [wrapperPath], {
    cwd: testDirectory,
    encoding: "utf8",
    env: environment,
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "mail_guarded_delivery_0069_error=HARNESS_FAILED\n",
  );
});
