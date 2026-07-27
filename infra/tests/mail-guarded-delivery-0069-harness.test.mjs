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
const runtimeProof = read("mail-guarded-delivery-0069-runtime.impl.ts");
const migration = readFileSync(
  path.join(testDirectory, "../../drizzle/0069_mail_outbox_guarded_delivery_authority.sql"),
  "utf8",
);

function implementationFunction(name, nextName) {
  const start = implementation.indexOf(`function ${name}(`);
  const end = implementation.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${name} must be bounded by ${nextName}`);
  return implementation.slice(start, end);
}

function runtimeFunction(name, nextName) {
  const start = runtimeProof.indexOf(`function ${name}(`);
  const end = runtimeProof.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0, `${name} must exist in the runtime proof`);
  assert.ok(end > start, `${name} must be bounded by ${nextName}`);
  return runtimeProof.slice(start, end);
}

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
    "captureMigrationManifest(69)",
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
    "for (const migration of predecessorMigrations)",
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

test("0069 rejects physical catalog drift for all four guarded outbox columns", () => {
  const catalog = implementationFunction("assertCatalogAndAcl", "seedAdministrator");
  for (const marker of [
    "expected_guarded_outbox_columns",
    "actual_guarded_outbox_columns",
    "guarded_outbox_column_delta",
    "attribute.attlen = type_row.typlen",
    "attribute.attbyval = type_row.typbyval",
    "attribute.attalign = type_row.typalign",
    "attribute.attstorage = type_row.typstorage",
    "attribute.attcompression = ''::\"char\"",
    "attribute.attstattarget IS NULL",
    "attribute.attoptions IS NULL",
    "attribute.attfdwoptions IS NULL",
  ]) {
    assert.ok(catalog.includes(marker), `missing guarded-column ${marker}`);
  }
  for (const columnName of [
    "delivery_release_insert_xid",
    "delivery_release_insert_system_identifier",
    "provider_request_body_sha256",
    "provider_request_body_length",
  ]) {
    assert.ok(catalog.includes(columnName), `missing guarded column ${columnName}`);
  }
  assert.match(
    implementation,
    /function proveOutboxGuardedColumnCatalogTamperRollback[(]/u,
  );
  assert.match(
    implementation,
    /ALTER TABLE ONLY public[.]email_outbox[\s\S]*ALTER COLUMN provider_request_body_sha256[\s\S]*SET COMPRESSION pglz/u,
  );
  assert.match(
    implementation,
    /proveOutboxGuardedColumnCatalogTamperRollback[(]\s*port,\s*migration0069/u,
  );
});

test("0069 independently inventories and repoison-tests the release verifier", () => {
  const verifier =
    "public.verify_email_outbox_delivery_release(uuid,uuid,text,text,text)";
  const footprint = implementationFunction("assertNo0069Footprint", "poison0069Acl");
  const digest = implementationFunction("guardedAclDigest", "predecessorDigest");
  const repoison = implementationFunction("repoison0069Acl", "proveTask5RelationAclTamperRollback");
  const catalog = implementationFunction("assertCatalogAndAcl", "seedAdministrator");

  assert.ok(footprint.includes(verifier), "verifier missing from footprint");
  assert.ok(digest.includes(verifier), "verifier missing from ACL digest");
  assert.equal(
    repoison.split(verifier).length - 1,
    2,
    "both repoison and delegated-grant loops must include verifier",
  );
  assert.ok(catalog.includes(verifier), "verifier missing from guarded inventory");
  for (const marker of [
    "b3277feeb2ed099406e17a3fe548bae580f978f5cd94a7f55f28687c81d9042c",
    "8e50e51aae34e3657a6a2d9d90fc546025512f2678b083e824a5cc0f8457ee5f",
    "pg_catalog.pg_get_userbyid(verifier_routine.proowner) =",
    "verifier_routine.prosecdef",
    "ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]",
    "verifier_routine.proargmodes",
    "verifier_routine.proacl",
  ]) {
    assert.ok(catalog.includes(marker), `missing verifier contract ${marker}`);
  }
});

test("0069 live ACL proof permits only app owner and worker issuer authority", () => {
  const catalog = implementationFunction("assertCatalogAndAcl", "seedAdministrator");
  const releaseProof = implementationFunction(
    "proveApplicationRelease",
    "proveMarkerPairIsolation",
  );
  const issuer = "public.release_email_outbox_delivery(uuid,uuid,text,text,text)";
  const workerReplayStart = releaseProof.indexOf(
    "const beforeUnauthorizedRelease = mailAuthorityDigest(port);",
  );
  const workerReplayEnd = releaseProof.indexOf(
    "const missingCandidate",
    workerReplayStart,
  );
  assert.ok(workerReplayStart >= 0);
  assert.ok(workerReplayEnd > workerReplayStart);
  const workerReplay = releaseProof.slice(workerReplayStart, workerReplayEnd);

  assert.match(
    catalog,
    new RegExp(
      `AND pg_catalog[.]has_function_privilege[(]\\s*'learncoding_worker',\\s*'${issuer.replace(/[.()]/gu, "\\$&")}',\\s*'EXECUTE'\\s*[)]`,
      "u",
    ),
  );
  assert.doesNotMatch(
    catalog,
    /AND NOT pg_catalog[.]has_function_privilege[(]\s*'learncoding_worker',\s*'public[.]release_email_outbox_delivery/u,
  );
  for (const role of ["learncoding_ops", "learncoding_backup_reporter"]) {
    assert.match(
      catalog,
      new RegExp(
        `AND NOT pg_catalog[.]has_function_privilege[(]\\s*'${role}',\\s*'${issuer.replace(/[.()]/gu, "\\$&")}',\\s*'EXECUTE'\\s*[)]`,
        "u",
      ),
    );
  }
  assert.match(
    catalog,
    /AND NOT pg_catalog[.]has_function_privilege[(]\s*0,\s*pg_catalog[.]to_regprocedure[(]\s*'public[.]release_email_outbox_delivery/u,
  );
  assert.doesNotMatch(
    workerReplay,
    /workerDenied|permission denied for function release_email_outbox_delivery/u,
  );
  assert.match(
    workerReplay,
    /assert[.]equal[(][\s\S]*scalar[(][\s\S]*appReleaseSql[(]FIXTURES[.]main[)][\s\S]*"learncoding_worker"[\s\S]*receiptDigest[\s\S]*[)];/u,
  );
  assert.match(
    workerReplay,
    /assert[.]equal[(]\s*mailAuthorityDigest[(]port[)],\s*beforeUnauthorizedRelease,?\s*[)];/u,
  );
});

test("0069 runs the strict production runtime proof after final replay repair", () => {
  const runHelper = implementationFunction("run", "connectionArgs");
  const capture = implementationFunction(
    "captureUtf8File",
    "captureMigrationManifest",
  );
  const manifest = implementationFunction(
    "captureMigrationManifest",
    "captureRuntimeProofInputs",
  );
  const inputs = implementationFunction(
    "captureRuntimeProofInputs",
    "ownerTransactionSql",
  );
  const runtimeUrl = implementationFunction(
    "runtimeDatabaseUrl",
    "prepareRuntimeProofJournal",
  );
  const journal = implementationFunction(
    "prepareRuntimeProofJournal",
    "recordRuntimeProofMigration",
  );
  const record = implementationFunction(
    "recordRuntimeProofMigration",
    "prepareRuntimeProofState",
  );
  const prepare = implementationFunction(
    "prepareRuntimeProofState",
    "runRuntimeProof",
  );
  const runtime = implementationFunction(
    "runRuntimeProof",
    "readExactPostmasterPid",
  );
  const main = implementation.slice(
    implementation.indexOf("export async function main()"),
  );

  assert.ok(runHelper.includes("env: options.env ?? childEnvironment"));
  assert.match(implementation, /max_connections=100/u);
  assert.doesNotMatch(implementation, /max_connections=20/u);
  assert.match(runtimeUrl, /127[.]0[.]0[.]1/u);
  assert.match(runtimeUrl, /assert[.]notEqual[(]port,\s*5432[)]/u);
  assert.match(runtimeUrl, /sslmode/u);
  assert.match(runtimeUrl, /disable/u);
  for (const role of [
    "postgres",
    "learncoding_app",
    "learncoding_ops",
    "learncoding_worker",
  ]) {
    assert.ok(runtimeUrl.includes(role), `missing runtime role ${role}`);
  }

  assert.match(prepare, /DELETE FROM public[.]email_outbox/u);
  assert.match(prepare, /mail_delivery_release_receipt/u);
  for (const marker of [
    "Runtime-only parity",
    'public."user"',
    "public.verification",
    "public.access_request",
    "public.invitation",
    "public.account_deletion_tombstone",
    "public.data_lifecycle_run",
    "GRANT SELECT ON TABLE",
    "GRANT UPDATE (id)",
    "TO learncoding_worker",
    "pg_catalog.count(*) = 6",
    "pg_catalog.has_table_privilege",
    "pg_catalog.has_column_privilege",
    "forbidden_update_column",
    "requires_row_lock",
    "MAINTAIN",
  ]) {
    assert.ok(
      prepare.includes(marker),
      `missing worker source-authority parity proof ${marker}`,
    );
  }
  assert.match(journal, /CREATE SCHEMA drizzle AUTHORIZATION learncoding_owner/u);
  assert.match(journal, /CREATE TABLE drizzle[.]__drizzle_migrations/u);
  assert.match(journal, /REVOKE ALL ON SCHEMA drizzle/u);
  assert.match(journal, /REVOKE ALL ON TABLE drizzle[.]__drizzle_migrations/u);
  assert.match(journal, /journalEntries[.]length,\s*migrationsThrough0069[.]length/u);
  assert.match(journal, /reviewedEntries[.]slice[(]0,\s*-1[)]/u);
  assert.match(journal, /reviewedEntries[.]at[(]-1[)]/u);
  assert.match(journal, /return reviewedCandidate/u);
  assert.doesNotMatch(journal, /178[0-9]{10}/u);
  assert.doesNotMatch(journal, /readFileSync|createHash/u);
  assert.match(capture, /readFileSync/u);
  assert.match(capture, /Buffer[.]from[(]text,\s*"utf8"[)]/u);
  assert.match(capture, /createHash[(]"sha256"[)]/u);
  assert.match(manifest, /Object[.]freeze/u);
  assert.match(inputs, /meta[\s\S]*_journal[.]json/u);
  assert.match(journal, /has_schema_privilege/u);
  assert.match(journal, /has_table_privilege/u);
  assert.match(journal, /assert[.]equal/u);
  assert.doesNotMatch(record, /readFileSync|createHash/u);
  for (const field of ["id", "hash", "createdAt"]) {
    assert.ok(record.includes(`reviewedCandidate.${field}`));
  }
  assert.doesNotMatch(record, /178[0-9]{10}/u);
  assert.match(record, /INSERT INTO drizzle[.]__drizzle_migrations/u);
  assert.match(record, /assert[.]equal/u);
  assert.match(prepare, /"0[|]0"/u);

  for (const marker of [
    "MAIL_RUNTIME_EXPECTED_POSTGRES_MAJOR",
    "MAIL_RUNTIME_ADMIN_DATABASE_URL",
    "MAIL_RUNTIME_APPLICATION_DATABASE_URL",
    "MAIL_RUNTIME_OPS_DATABASE_URL",
    "MAIL_RUNTIME_WORKER_DATABASE_URL",
    '"--import"',
    '"tsx"',
    "mail-guarded-delivery-0069-runtime.impl.ts",
    "env: runtimeEnvironment",
    "timeoutMs: 180_000",
    '"mail_guarded_delivery_0069_runtime=PASS\\n"',
    '"0069 production runtime proof failed"',
  ]) {
    assert.ok(runtime.includes(marker), `missing runtime proof ${marker}`);
  }
  assert.doesNotMatch(runtime, /[.][.][.]process[.]env/u);

  const envelope = runtimeFunction("envelopeFor", "beginProviderBoundary");
  const lateSuccess = runtimeFunction(
    "proveLateSuccessAfterAbandonedQuarantine",
    "proveFailedAfterAbandonedQuarantine",
  );
  const definiteFailure = runtimeFunction(
    "proveFailedAfterAbandonedQuarantine",
    "proveGmailRedactionReconciliation",
  );
  const requestBodyGuard = runtimeFunction(
    "mutateRequestBodyWithDeliveryGuardsDisabled",
    "setReplicaRole",
  );
  const bodyMismatch = runtimeFunction("proveBodyMismatch", "releaseTuple");
  const abandonedSweepAging = runtimeFunction(
    "ageArmedLeaseForAbandonedSweep",
    "ageQuarantinedFixtureForRedaction",
  );
  const gmail = runtimeFunction(
    "proveGmailRedactionReconciliation",
    "dropTerminalGate",
  );
  const abandonedProviderBoundary = runtimeFunction(
    "armAbandonedProviderBoundary",
    "persistedAuthority",
  );
  const runtimeEntry = runtimeFunction(
    "runMailGuardedDeliveryRuntimeProof",
    "main",
  );
  for (const marker of [
    "dispatchAfterProviderBoundary",
    "quarantineAbandoned",
    "finishGuardedDispatchUnknown",
    "ABANDONED_POST_PROVIDER_BOUNDARY",
    "provider_message_id",
    "sent_at",
    "releaseAuthorityEvidence",
    "replayAndDeliveryBindingEvidence",
  ]) {
    assert.ok(lateSuccess.includes(marker), `missing late-success ${marker}`);
  }
  for (const marker of [
    "quarantineAbandoned",
    "finishAfterProvider",
    'kind: "failed"',
    "PROVIDER_DEFINITELY_REJECTED",
    "releaseAuthorityEvidence",
    "replayAndDeliveryBindingEvidence",
  ]) {
    assert.ok(
      definiteFailure.includes(marker),
      `missing definite-failure ${marker}`,
    );
  }
  for (const marker of [
    "DELIVERY_HOLD_TRIGGER",
    "DELIVERY_HOLD_FINAL_TRIGGER",
    "REQUEST_BODY_TRIGGER",
    "mutateWithAlwaysTriggerDisabled",
  ]) {
    assert.ok(requestBodyGuard.includes(marker), `missing body guard ${marker}`);
  }
  assert.equal(
    bodyMismatch.split("mutateRequestBodyWithDeliveryGuardsDisabled(").length - 1,
    2,
  );
  for (const marker of [
    "REQUEST_BODY_TRIGGER",
    "DELIVERY_HOLD_TRIGGER",
    "DELIVERY_HOLD_FINAL_TRIGGER",
  ]) {
    assert.ok(bodyMismatch.includes(marker), `missing restoration ${marker}`);
  }
  assert.ok(runtimeProof.includes("ABANDONED_SWEEP_EXPIRED_LEASE_AT"));
  assert.ok(runtimeProof.includes("1900-01-01T00:00:00.000Z"));
  assert.ok(abandonedSweepAging.includes("$2::pg_catalog.timestamptz"));
  assert.doesNotMatch(abandonedSweepAging, /interval '31 seconds'/u);
  assert.match(envelope, /captureMailTransportConfiguration[(]adapter[)]/u);
  for (const marker of [
    'armAbandonedProviderBoundary(runtime, fixture, "gmail")',
    "redact_quarantined_email_outbox_authority_v2",
    "reconcileGmailDelivery",
    "findByMessageId",
    'kind: "header-evidence-v1"',
    "networkCalls",
    "releaseAuthorityEvidence",
    "redactionPreservedEvidence",
    "previousGmailEnvironment",
    "previousFetch",
    "globalThis.fetch = previousFetch",
    "delete process.env[name]",
  ]) {
    assert.ok(gmail.includes(marker), `missing Gmail composition ${marker}`);
  }
  for (const marker of [
    "beginProviderBoundary",
    "discardCommittedPreparedDispatchReceipt",
    "boundary.permit",
    "boundary.receipt",
  ]) {
    assert.ok(
      abandonedProviderBoundary.includes(marker),
      `missing abandoned provider boundary guard ${marker}`,
    );
  }
  assert.ok(!gmail.includes('armBoundary(runtime, fixture, "gmail")'));
  assert.ok(!gmail.includes("authorizeCommittedPreparedDispatch"));
  assert.match(
    lateSuccess,
    /assert[.]equal[(]terminal[.]sent_at, terminal[.]updated_at[)]/u,
  );
  for (const marker of [
    "opsDatabaseUrl",
    '"learncoding_ops"',
    "current_user",
    "session_user",
    "proveLateSuccessAfterAbandonedQuarantine(",
    "proveFailedAfterAbandonedQuarantine(",
    "proveGmailRedactionReconciliation(",
  ]) {
    assert.ok(runtimeEntry.includes(marker), `missing runtime entry ${marker}`);
  }
  const runtimeOrder = [
    "proveLateSuccessAfterAbandonedQuarantine(",
    "proveFailedAfterAbandonedQuarantine(",
    "proveGmailRedactionReconciliation(",
  ];
  let previousRuntime = -1;
  for (const marker of runtimeOrder) {
    assert.equal(
      runtimeEntry.split(marker).length - 1,
      1,
      `${marker} must occur exactly once`,
    );
    const index = runtimeEntry.indexOf(marker, previousRuntime + 1);
    assert.ok(index > previousRuntime, `${marker} must follow its predecessor`);
    previousRuntime = index;
  }

  const repaired = main.indexOf(
    "assert.equal(guardedAclDigest(port), populatedCatalogAndAclDigest);",
  );
  const captured = main.indexOf("captureRuntimeProofInputs();");
  const temporaryRoot = main.indexOf("mkdtempSync(");
  const journalPrepared = main.indexOf("prepareRuntimeProofJournal(");
  const migrationApplied = main.indexOf("applyAsOwner(port, migration0069);");
  const migrationRecorded = main.indexOf(
    "recordRuntimeProofMigration(port, reviewedCandidate);",
    migrationApplied,
  );
  const prepared = main.indexOf("prepareRuntimeProofState(port);", repaired);
  const invoked = main.indexOf("runRuntimeProof(port);", prepared);
  const reverified = main.indexOf("assertCatalogAndAcl(port);", invoked);
  assert.ok(captured >= 0);
  assert.ok(temporaryRoot > captured);
  assert.ok(journalPrepared >= 0);
  assert.ok(migrationApplied > journalPrepared);
  assert.ok(migrationRecorded > migrationApplied);
  assert.ok(repaired >= 0);
  assert.ok(prepared > repaired);
  assert.ok(invoked > prepared);
  assert.ok(reverified > invoked);
});

test("0069 installs and live-proves a closed-world lineage attestor", () => {
  const signature =
    "public.attest_email_outbox_delivery_release_lineage(text)";
  for (const marker of [
    "CREATE OR REPLACE FUNCTION",
    signature,
    "RETURNS TABLE",
    "phase_0066_count",
    "phase_0067_count",
    "phase_0068_count",
    "phase_0069_count",
    "candidate_hash_count",
    "lineage_window_count",
    "LANGUAGE plpgsql",
    "STABLE",
    "SECURITY DEFINER",
    "PARALLEL UNSAFE",
    "SET search_path TO 'pg_catalog', 'pg_temp'",
    "session_user",
    "learncoding_owner",
    "learncoding_worker",
    "^[0-9a-f]{64}$",
    "FROM ONLY drizzle.__drizzle_migrations",
  ]) {
    assert.ok(migration.includes(marker), `missing attestor SQL ${marker}`);
  }
  assert.match(
    migration,
    /AND ARRAY\(\s*SELECT key_column[.]attnum\s*FROM pg_catalog[.]unnest\(\s*index_row[.]indkey::pg_catalog[.]int2\[\]\s*\) WITH ORDINALITY AS key_column\(attnum, ordinality\)\s*ORDER BY key_column[.]ordinality\s*\)::pg_catalog[.]int2\[\] = ARRAY\[1\]::pg_catalog[.]int2\[\]/u,
    "journal primary-key columns must be normalized before comparison",
  );
  assert.doesNotMatch(
    migration,
    /index_row[.]indkey::pg_catalog[.]int2\[\]\s*=\s*ARRAY\[1\]::pg_catalog[.]int2\[\]/u,
    "zero-based int2vector casts must not be compared directly",
  );
  assert.match(
    migration,
    /ALTER FUNCTION public[.]attest_email_outbox_delivery_release_lineage[(][\s\S]*OWNER TO learncoding_owner/u,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION public[.]attest_email_outbox_delivery_release_lineage[(][\s\S]*TO learncoding_worker/u,
  );

  for (const functionName of [
    "guardedAclDigest",
    "assertNo0069Footprint",
    "repoison0069Acl",
    "assertCatalogAndAcl",
  ]) {
    assert.ok(
      implementationFunction(
        functionName,
        functionName === "guardedAclDigest"
          ? "predecessorDigest"
          : functionName === "assertNo0069Footprint"
            ? "poison0069Acl"
            : functionName === "repoison0069Acl"
              ? "proveTask5RelationAclTamperRollback"
              : "seedAdministrator",
      ).includes(signature),
      `${functionName} must inventory the lineage attestor`,
    );
  }

  const catalogProof = implementationFunction(
    "assertLineageAttestorCatalog",
    "migrationJournalDigest",
  );
  const attestorProsrcFingerprint =
    "5963663f65d5be7e4e44c1ab1b1daa17a04d4bd711a9af9abc5bf2d1bb62bd91";
  const attestorDefinitionFingerprint =
    "261d8137a8ad635af563b6e5478ad3ebc7579c68c5693ff87a7e2fe517e5dbbf";
  for (const marker of [
    signature,
    "routine.prosrc",
    "pg_get_functiondef",
    attestorProsrcFingerprint,
    attestorDefinitionFingerprint,
    "learncoding_owner|learncoding_owner|execute|false",
    "learncoding_worker|learncoding_owner|execute|false",
    "has_function_privilege",
  ]) {
    assert.ok(catalogProof.includes(marker), `missing catalog proof ${marker}`);
  }
  assert.doesNotMatch(
    catalogProof,
    /0{64}/u,
    "attestor catalog fingerprints must not use a zero placeholder",
  );

  const liveProof = implementationFunction(
    "proveLineageAttestor",
    "assertCatalogAndAcl",
  );
  for (const marker of [
    '"1|1|1|1|1|4"',
    '"1|1|1|0|0|4"',
    '"1|1|1|1|2|4"',
    '"1|1|2|1|1|5"',
    '"1|1|0|1|1|3"',
    "email outbox delivery lineage candidate is invalid",
    "email outbox delivery lineage attestor caller is invalid",
    "migrationJournalDigest(port)",
    "journalPrimaryKeyVector",
    "pg_catalog.array_lower",
    '"0|t"',
    "stableJournal",
    "1785012972253",
    "1785016572253",
    "1785020172253",
    "1b9e669025e2dccb54099fd99adbf26c8c6eccf5a10a39f3319772b2fdef4b0f",
  ]) {
    assert.ok(liveProof.includes(marker), `missing live lineage proof ${marker}`);
  }

  const main = implementation.slice(
    implementation.indexOf("export async function main()"),
  );
  const proofOffsets = [
    ...main.matchAll(/proveLineageAttestor[(]port, candidate[.]hash[)];/gu),
  ].map((match) => match.index);
  assert.equal(proofOffsets.length, 3);
  let previousProof = -1;
  for (const proofOffset of proofOffsets) {
    const catalogOffset = main.lastIndexOf(
      "assertCatalogAndAcl(port);",
      proofOffset,
    );
    assert.ok(catalogOffset > previousProof);
    assert.ok(catalogOffset < proofOffset);
    previousProof = proofOffset;
  }
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
