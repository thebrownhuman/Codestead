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
  "mail-quarantine-redaction-0068.integration.mjs",
);
const wrapper = read("mail-quarantine-redaction-0068.integration.mjs");
const implementation = read("mail-quarantine-redaction-0068.impl.mjs");

test("0068 wrapper exposes only a fixed failure diagnostic", () => {
  assert.match(
    wrapper,
    /"mail_quarantine_redaction_0068_error=HARNESS_FAILED\\n"/u,
  );
  assert.match(wrapper, /process[.]stderr[.]write[(]HARNESS_FAILURE[)]/u);
  assert.doesNotMatch(
    wrapper,
    /[.]stack|[.]message|[.]cause|String[(]|console[.]/u,
  );
});

test("0068 implementation selects one native major and isolates libpq", () => {
  assert.match(implementation, /POSTGRES_17_BIN/u);
  assert.match(implementation, /POSTGRES_18_BIN/u);
  assert.match(implementation, /selected[.]length,\s*1/u);
  assert.match(implementation, /expectedMajor/u);
  assert.match(implementation, /LIBPQ_ENVIRONMENT_KEYS/u);
  assert.doesNotMatch(implementation, /[.][.][.]process[.]env/u);
});

test("0068 fixtures cross final 0067 without weakening its final catalog", () => {
  for (const marker of [
    "eligible-account",
    "eligible-system",
    "eligible-operation",
    "partial-claim",
    "expired-claim",
    "live-claim",
    "already-redacted",
  ]) {
    assert.match(implementation, new RegExp(marker, "u"));
  }
  const mainStart = implementation.indexOf("export async function main()");
  assert.ok(mainStart >= 0);
  const main = implementation.slice(mainStart);
  const through0066 = main.indexOf("migrationFilesThrough(66)");
  const seed = main.indexOf("seedQuiescentFixtures");
  const apply0067 = main.indexOf("applyAsOwner(port, migration0067)");
  const claimSetup = main.indexOf("installClaimStateFixtures");
  const apply0068 = main.indexOf("applyAsOwner(port, migration0068Hostile)");
  assert.ok(through0066 >= 0);
  assert.ok(seed > through0066);
  assert.ok(apply0067 > seed);
  assert.ok(claimSetup > apply0067);
  assert.ok(apply0068 > claimSetup);
  assert.match(
    implementation,
    /DISABLE TRIGGER email_outbox_delivery_hold/u,
  );
  assert.match(
    implementation,
    /ENABLE ALWAYS TRIGGER email_outbox_delivery_hold/u,
  );
  assert.match(implementation, /assertFinal0067Hold/u);

  assert.doesNotMatch(
    implementation,
    /DROP\s+CONSTRAINT[\s\S]{0,160}email_outbox_delivery_scope/iu,
  );
  assert.doesNotMatch(
    implementation,
    /email_outbox_delivery_scope[\s\S]{0,160}NOT\s+VALID/iu,
  );
  assert.doesNotMatch(
    implementation,
    /email_outbox_delivery_scope_immutable/u,
  );

  const providerEvidence = main.indexOf("installProtectedProviderEvidence(port)");
  const migration0067Read = main.indexOf("const migration0067");
  assert.ok(providerEvidence >= 0);
  assert.ok(migration0067Read > providerEvidence);
  assert.match(
    implementation,
    /ENABLE ALWAYS TRIGGER\s+email_outbox_dispatch_binding_guard/u,
  );
  assert.match(
    implementation,
    /ENABLE ALWAYS TRIGGER\s+email_outbox_provider_correlation_evidence_guard/u,
  );
  for (const evidence of [
    "provider_call_started = '2025-01-01T00:00:00Z'::timestamptz",
    "adapter = 'gmail'",
    "dispatch_binding_version = 'gmail-raw-v1'",
    "provider_correlation_version = 'opaque-sha256-v1'",
    "provider_evidence_version = 'gmail-header-evidence-v1'",
    "provider_message_id = 'retention-0068-expired-gmail-message'",
  ]) {
    assert.ok(implementation.includes(evidence));
  }
  assert.match(implementation, /dispatch_binding_sha256 = '\$\{"a"[.]repeat\(64\)\}'/u);
  assert.match(implementation, /provider_evidence_sha256 = '\$\{"b"[.]repeat\(64\)\}'/u);
});

test("0068 proves catalog ACL behavior replay and protected state", () => {
  for (const marker of [
    "idempotency_authority_version",
    "idempotency_authority_sha256",
    "idempotency_original_payload_sha256",
    "delivery_hold_version",
    "provider_correlation_version",
    "provider_evidence_sha256",
    "dispatch_binding_sha256",
    "operation_id",
    "claim_token",
    "lease_expires_at",
  ]) {
    assert.match(implementation, new RegExp(marker, "u"));
  }
  assert.match(implementation, /pg_catalog[.]aclexplode/u);
  assert.match(implementation, /has_function_privilege/u);
  assert.match(implementation, /learncoding_acl_leaf/u);
  assert.match(implementation, /assertDenied/u);
  assert.match(implementation, /report-only/u);
  assert.match(implementation, /apply-redaction/u);
  assert.match(implementation, /migration-replay/u);
  assert.match(implementation, /protectedDigest/u);
  assert.match(implementation, /authorityDigest/u);

  for (const roleDeclaration of [
    "CREATE ROLE learncoding_acl_default LOGIN NOINHERIT;",
    "CREATE ROLE learncoding_acl_grantor NOLOGIN NOINHERIT;",
    "CREATE ROLE learncoding_acl_leaf LOGIN NOINHERIT;",
  ]) {
    assert.ok(implementation.includes(roleDeclaration));
  }
  for (const exactAcl of [
    "{learncoding_owner|learncoding_owner|execute|false}",
    "{learncoding_ops|learncoding_owner|execute|false,learncoding_owner|learncoding_owner|execute|false}",
  ]) {
    assert.ok(implementation.includes(exactAcl));
  }
  for (const role of [
    "learncoding_acl_default",
    "learncoding_acl_grantor",
    "learncoding_acl_leaf",
  ]) {
    assert.match(implementation, new RegExp(role, "u"));
  }
  assert.doesNotMatch(
    implementation,
    /has_function_privilege\(\s*'PUBLIC'/u,
  );

  const repoisonStart = implementation.indexOf(
    "function repoisonExisting0068Acl",
  );
  const repoisonEnd = implementation.indexOf(
    "function injectHostile0068Acl",
    repoisonStart,
  );
  const repoison = implementation.slice(repoisonStart, repoisonEnd);
  assert.ok(repoison.indexOf("RESET ROLE;") >= 0);
  assert.ok(
    repoison.indexOf("SET ROLE learncoding_owner;") >
      repoison.indexOf("RESET ROLE;"),
  );

  const replayStart = implementation.indexOf(
    "function assertEmptyReportApplyReplay",
  );
  const replayEnd = implementation.indexOf(
    "function preserveOperationAndCleanupFailures",
    replayStart,
  );
  const replay = implementation.slice(replayStart, replayEnd);
  const repoisonCall = replay.indexOf("repoisonExisting0068Acl(port);");
  const rawMigrationReplay = replay.indexOf("applyAsOwner(port, migration0068);");
  assert.ok(repoisonCall >= 0);
  assert.ok(rawMigrationReplay > repoisonCall);

  for (const exactSummary of [
    "blocked:2:0,eligible:5:0,malformed:3:0",
    "blocked:2:0,eligible:5:5,malformed:3:3",
    "blocked:2:0,eligible:0:0,malformed:0:0",
  ]) {
    assert.ok(implementation.includes(exactSummary));
  }
});

test("0068 cleanup verifies the exact cluster before deleting its root", () => {
  const stop = implementation.indexOf('"stop"');
  const listener = implementation.lastIndexOf("assertNoListener");
  const pid = implementation.lastIndexOf("assertPostmasterStopped");
  const remove = implementation.lastIndexOf("rmSync");
  assert.ok(stop >= 0);
  assert.ok(listener > stop);
  assert.ok(pid > stop);
  assert.ok(remove > listener);
  assert.ok(remove > pid);
  assert.match(implementation, /preserveOperationAndCleanupFailures/u);
  assert.match(implementation, /AggregateError/u);

  const main = implementation.slice(
    implementation.indexOf("export async function main()"),
  );
  const topLevelTry = main.indexOf("\n  try {");
  const allocatePort = main.indexOf(
    "port = await allocateDisposableLoopbackPort()",
  );
  const mainListener = main.lastIndexOf("assertNoListener");
  const mainPid = main.lastIndexOf("assertPostmasterStopped");
  const guardedRemoval = main.indexOf(
    "if (listenerStopped && postmasterStopped)",
  );
  const mainRemove = main.lastIndexOf("rmSync");
  const preservedFailure = main.lastIndexOf(
    "preserveOperationAndCleanupFailures",
  );
  const pass = main.lastIndexOf(
    'process.stdout.write("mail_quarantine_redaction_0068=PASS\\n")',
  );
  assert.ok(topLevelTry >= 0);
  assert.ok(allocatePort > topLevelTry);
  assert.ok(guardedRemoval > mainListener);
  assert.ok(guardedRemoval > mainPid);
  assert.ok(mainRemove > guardedRemoval);
  assert.ok(pass > mainRemove);
  assert.ok(pass > preservedFailure);
});

test("0068 wrapper fails closed with exactly one fixed diagnostic", () => {
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
    "mail_quarantine_redaction_0068_error=HARNESS_FAILED\n",
  );
});

test("0068 executable main order crosses final 0067 before 0068", () => {
  const mainStart = implementation.indexOf("export async function main()");
  assert.ok(mainStart >= 0);
  const main = implementation.slice(mainStart);
  const markers = [
    "for (const migrationFile of migrationFilesThrough(66))",
    "seedQuiescentFixtures(port);",
    "installProtectedProviderEvidence(port);",
    "const migration0067 = readFileSync(",
    "applyAsOwner(port, migration0067);",
    "installClaimStateFixtures(port);",
    "const migration0068 = readFileSync(",
    "applyAsOwner(port, migration0068Hostile);",
  ];
  let previous = -1;
  for (const marker of markers) {
    const index = main.indexOf(marker);
    assert.ok(index > previous, `${marker} must follow its predecessor`);
    previous = index;
  }
});

test("0068 owner work and replay use real migrator delegation", () => {
  const helperStart = implementation.indexOf("function ownerTransactionSql");
  const helperEnd = implementation.indexOf("const FIXTURE_IDS", helperStart);
  const helper = implementation.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0);
  assert.ok(helper.includes('username: "learncoding_migrator"'));
  assert.ok(helper.includes("session_user <> 'learncoding_migrator'"));
  assert.ok(helper.includes("current_user <> 'learncoding_migrator'"));
  assert.ok(helper.includes("SET ROLE learncoding_owner"));
  assert.ok(helper.includes("current_user <> 'learncoding_owner'"));
  assert.ok(helper.includes("RESET ROLE"));
  assert.doesNotMatch(helper, /username:\s*"postgres"/u);
  assert.match(
    implementation,
    /function assertMigratorDelegationCannotInvokeRedactor/u,
  );
  assert.match(
    implementation,
    /email outbox redaction caller is not authorized/u,
  );
  assert.match(
    implementation,
    /function assertDelegatedOwnerCannotMutatePayload/u,
  );
  assert.ok(
    implementation.includes("email_outbox[.]to_email is immutable"),
  );
});

test("0068 live proof rolls back predecessor tampering and retries", () => {
  const start = implementation.indexOf(
    "function prove0067PredecessorTamperRollbackAndCleanRetry",
  );
  const end = implementation.indexOf(
    "function assertEmptyReportApplyReplay",
    start,
  );
  const proof = implementation.slice(start, end);
  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(proof, /predecessorCatalogDigest/u);
  assert.match(
    proof,
    /CREATE OR REPLACE FUNCTION\s+public[.]enforce_email_outbox_delivery_hold/u,
  );
  assert.match(
    proof,
    /CREATE OR REPLACE FUNCTION\s+public[.]email_outbox_idempotency_coverage_authority/u,
  );
  assert.match(proof, /RETURN TRUE/u);
  assert.match(proof, /WHEN [(]false[)]/u);
  assert.match(proof, /delivery-hold predecessor function is invalid/u);
  assert.match(
    proof,
    /idempotency coverage predecessor function is invalid/u,
  );
  assert.match(proof, /delivery-hold predecessor trigger is invalid/u);
  assert.match(proof, /allowFailure:\s*true/u);
  assert.match(proof, /applyAsOwner[(]port, migration0068[)]/u);
  assert.match(proof, /assertStableProtectedState/u);
});

test("0068 proves bounded oldest-then-id redaction and owner denial", () => {
  for (const fixture of [
    "batch-oldest-a",
    "batch-oldest-b",
    "batch-next",
  ]) {
    assert.match(implementation, new RegExp(fixture, "u"));
  }
  assert.match(
    implementation,
    /function assertBoundedOldestFirstRedaction/u,
  );
  assert.match(
    implementation,
    /blocked:2:0,eligible:8:1,malformed:3:0/u,
  );
  assert.match(
    implementation,
    /blocked:2:0,eligible:7:2,malformed:3:0/u,
  );
  assert.match(implementation, /transitionedTotal/u);
  assert.match(implementation, /<= batchLimit/u);
  const replayStart = implementation.indexOf(
    "function assertEmptyReportApplyReplay",
  );
  const replayEnd = implementation.indexOf(
    "function preserveOperationAndCleanupFailures",
    replayStart,
  );
  const replay = implementation.slice(replayStart, replayEnd);
  assert.ok(
    replay.indexOf("assertDelegatedOwnerCannotMutatePayload(port)") >= 0,
  );
  assert.ok(
    replay.indexOf("assertBoundedOldestFirstRedaction(") >
      replay.indexOf("assertDelegatedOwnerCannotMutatePayload(port)"),
  );
  assert.ok(
    replay.indexOf("apply-redaction") >
      replay.indexOf("assertBoundedOldestFirstRedaction("),
  );
});
