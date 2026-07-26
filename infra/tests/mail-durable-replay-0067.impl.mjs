#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { createConnection } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { Client, Pool } from "pg";

import { allocateDisposableLoopbackPort } from
  "../../scripts/lib/disposable-loopback-port.mjs";
import {
  REVIEWED_MIGRATION_LEDGER,
} from "../../scripts/lib/reviewed-migration-ledger.mjs";
import {
  canonicalizePostgresStatement,
  splitPostgresStatements,
} from "../../scripts/lib/postgres-sql-statements.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const migrationDirectory = path.join(repositoryRoot, "drizzle");
const migration0067 = readFileSync(
  path.join(
    migrationDirectory,
    "0067_mail_outbox_durable_replay_authority.sql",
  ),
  "utf8",
);
const LIBPQ_ENVIRONMENT_KEYS = Object.freeze([
  "PGAPPNAME",
  "PGCHANNELBINDING",
  "PGCLIENTENCODING",
  "PGCONNECT_TIMEOUT",
  "PGDATABASE",
  "PGGSSENCMODE",
  "PGGSSLIB",
  "PGHOST",
  "PGHOSTADDR",
  "PGKRBSRVNAME",
  "PGLOADBALANCEHOSTS",
  "PGLOCALEDIR",
  "PGOPTIONS",
  "PGPASSFILE",
  "PGPASSWORD",
  "PGPORT",
  "PGREALM",
  "PGREQUIRESSL",
  "PGREQUIREAUTH",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGSSLCERT",
  "PGSSLCRL",
  "PGSSLCRLDIR",
  "PGSSLKEY",
  "PGSSLMODE",
  "PGSSLNEGOTIATION",
  "PGSSLROOTCERT",
  "PGSYSCONFDIR",
  "PGTARGETSESSIONATTRS",
  "PGUSER",
]);
for (const key of LIBPQ_ENVIRONMENT_KEYS) delete process.env[key];

const CUTOVER_PROOF_SOURCES = Object.freeze([
  'public."user"',
  "public.verification",
  "public.lost_device_proof",
  "public.session_revocation_request",
  "public.inactivity_episode",
  "public.smart_reminder_dispatch",
  "public.access_request",
  "public.invitation",
  "public.backup_status_mail_authority",
]);
const CUTOVER_LOCK_STATEMENTS = Object.freeze([
  "lock table public.email_outbox in access exclusive mode nowait;",
  `lock table ${CUTOVER_PROOF_SOURCES.join(", ")} in share mode nowait;`,
]);
const CUTOVER_SEARCH_PATH_STATEMENT =
  "set local search_path = pg_catalog, pg_temp;";

const CUTOVER_LOCK_PROBE_GATE = 67_006_701;
const CUTOVER_TOPOLOGY_PRODUCER_GATE = 67_006_702;
const COVERAGE_SNAPSHOT_GATE = 67_006_703;
const COVERAGE_SNAPSHOT_TOPOLOGY_TIMEOUT_MS = 4_000;
const CUTOVER_TOPOLOGY_MIGRATION_GATE = 67_006_704;
const WAIT_TOPOLOGY_TIMEOUT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 55_000;
const CLEANUP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 25;
const SETUP_TIMEOUT_MS = 5_000;
const CLIENT_CONNECT_TIMEOUT_MS = 5_000;
const CLIENT_CLOSE_TIMEOUT_MS = 5_000;
const CHILD_TIMEOUT_MS = 30_000;
const CHILD_TERMINATION_TIMEOUT_MS = 5_000;
const CHILD_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const TEMPORARY_LOG_MAX_BYTES = 64 * 1024;
let diagnosticTemporaryRoot;

const trackedPsqlChildren = new Set();
const trackedPsqlChildHandles = new Map();
const trackedClients = new Set();
const trackedPools = new Set();

function createTrackedClient(config) {
  const client = new Client(config);
  trackedClients.add(client);
  return client;
}

function createTrackedPool(config) {
  const pool = new Pool(config);
  trackedPools.add(pool);
  return pool;
}

function registerTrackedPsqlChild(child) {
  assert.equal(
    trackedPsqlChildren.has(child),
    false,
    "PostgreSQL child was already registered",
  );
  trackedPsqlChildren.add(child);
  const closed = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({
        code: child.exitCode,
        signal: child.signalCode,
        stdout: "",
        stderr: "",
      });
      return;
    }
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout: "", stderr: "" });
    });
  });
  trackedPsqlChildHandles.set(child, {
    completed: observePromiseOutcome(closed),
    terminate: () => terminateAndVerify(
      child,
      closed,
      "top-level tracked PostgreSQL child",
    ),
  });
}

function unregisterTrackedPsqlChild(child) {
  trackedPsqlChildHandles.delete(child);
  assert.equal(
    trackedPsqlChildren.delete(child),
    true,
    "PostgreSQL child settled without a registry entry",
  );
}

function actualSqlStatements(sql) {
  return splitPostgresStatements(sql).map(
    ({ sql: statement }) => canonicalizePostgresStatement(statement),
  );
}

function assertCutoverLockPreamble() {
  const statements = actualSqlStatements(migration0067);
  const lockStatements = statements.filter(
    (statement) => statement.startsWith("lock table "),
  );
  assert.deepEqual(statements.slice(0, 2), CUTOVER_LOCK_STATEMENTS);
  assert.equal(statements[2], CUTOVER_SEARCH_PATH_STATEMENT);
  assert.equal(
    statements.filter(
      (statement) => statement === CUTOVER_SEARCH_PATH_STATEMENT,
    ).length,
    1,
    "cutover search path statement must occur exactly once",
  );
  assert.deepEqual(lockStatements, CUTOVER_LOCK_STATEMENTS);
  for (const expected of CUTOVER_LOCK_STATEMENTS) {
    assert.equal(
      statements.filter((statement) => statement === expected).length,
      1,
      `cutover lock statement must occur exactly once: ${expected}`,
    );
  }
}

assertCutoverLockPreamble();
const MAIL_EVENT_V1_GOLDEN_VECTOR = Object.freeze(
  JSON.parse(
    readFileSync(
      path.join(
        testDirectory,
        "fixtures",
        "mail-event-v1-golden-vector.json",
      ),
      "utf8",
    ),
  ),
);
assert.deepEqual(MAIL_EVENT_V1_GOLDEN_VECTOR.accountInput, {
  template: MAIL_EVENT_V1_GOLDEN_VECTOR.template,
  userId: MAIL_EVENT_V1_GOLDEN_VECTOR.scope.slice(2),
  eventId: MAIL_EVENT_V1_GOLDEN_VECTOR.eventId,
});
assert.equal(MAIL_EVENT_V1_GOLDEN_VECTOR.authorityVersion, "event-v1-native");
assert.equal(MAIL_EVENT_V1_GOLDEN_VECTOR.domain, "mail-event-v1");
assert.equal(MAIL_EVENT_V1_GOLDEN_VECTOR.separatorCodePoint, 0x1f);
assert.match(MAIL_EVENT_V1_GOLDEN_VECTOR.sha256, /^[0-9a-f]{64}$/u);
const ORIGINAL_PAYLOAD_DIGEST_VECTOR_BYTES = readFileSync(
  path.join(
    testDirectory,
    "fixtures",
    "mail-original-payload-sha256-vectors.json",
  ),
);
const ORIGINAL_PAYLOAD_DIGEST_VECTOR_FIXTURE_SHA256 =
  "2f7d1794f671d75a92beed7bbc01ab1ee8f7c592a9fba8b2122f2d29f2ce9aa2";
assert.equal(
  createHash("sha256")
    .update(ORIGINAL_PAYLOAD_DIGEST_VECTOR_BYTES)
    .digest("hex"),
  ORIGINAL_PAYLOAD_DIGEST_VECTOR_FIXTURE_SHA256,
);
const ORIGINAL_PAYLOAD_DIGEST_VECTORS = Object.freeze(
  JSON.parse(
    ORIGINAL_PAYLOAD_DIGEST_VECTOR_BYTES.toString("utf8"),
  ),
);
assert.deepEqual(
  ORIGINAL_PAYLOAD_DIGEST_VECTORS.map(({ name }) => name),
  ["nested-json", "numeric-forms", "unicode", "system-envelope"],
);
for (const vector of ORIGINAL_PAYLOAD_DIGEST_VECTORS) {
  assert.equal(
    createHash("sha256")
      .update(vector.canonicalPayloadJson, "utf8")
      .digest("hex"),
    vector.sha256,
  );
}
const selectedRuntime = [
  ["17", process.env.POSTGRES_17_BIN],
  ["18", process.env.POSTGRES_18_BIN],
].filter(([, binaryDirectory]) => binaryDirectory !== undefined);
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const separator = "\u001f";

assert.equal(
  selectedRuntime.length,
  1,
  "exactly one of POSTGRES_17_BIN or POSTGRES_18_BIN must select the gate",
);
const [postgresMajor, postgresBin] = selectedRuntime[0];
assert.match(postgresMajor, /^(?:17|18)$/u);
assert.ok(postgresBin);

const ADMIN_ID = "mail-0067-admin";
const LEARNER_ID = "mail-0067-learner";
const DELETED_ID = "mail-0067-deleted";
const ADMIN_EMAIL = "admin-0067@example.invalid";
const LEARNER_EMAIL = "learner-0067@example.invalid";
const DELETED_EMAIL = "deleted-0067@example.invalid";
const SMART_SOURCE_MISMATCH_USER_ID = "mail-0067-smart-source-mismatch";
const SMART_SOURCE_MISMATCH_NAME = "Mail 0067 Source Mismatch";
const SMART_SOURCE_MISMATCH_EMAIL =
  "smart-source-mismatch-0067@example.invalid";
const RESET_VERIFICATION_ID = "reset-verification-0067";
const RESET_TOKEN = "reset-token-0067-abcdefghijklmnopqrstuvwxyz";
const RESET_WRONG_PURPOSE_ID = "reset-wrong-purpose-0067";
const RESET_WRONG_PURPOSE_TOKEN = "fixture-wrong-purpose-token-0067-abcdefghijklmnop";
const RESET_MISMATCH_ID = "reset-mismatch-0067";
const RESET_MISMATCH_SOURCE_TOKEN = "fixture-source-token-0067-abcdefghijklmnopqrst";
const RESET_MISMATCH_URL_TOKEN = "fixture-different-token-0067-abcdefghijklmnopq";
const RESET_WRONG_RECIPIENT_ID = "reset-wrong-recipient-0067";
const RESET_WRONG_RECIPIENT_TOKEN = "fixture-wrong-recipient-token-0067-abcdefghijklmn";
const RESET_SOURCE_VALUE_ID = "reset-source-value-0067";
const RESET_SOURCE_VALUE_TOKEN = "fixture-source-value-token-0067-abcdefghijklmnop";
const RESET_WRONG_VERSION_ID = "reset-wrong-version-0067";
const RESET_WRONG_VERSION_TOKEN = "fixture-wrong-version-token-0067-abcdefghijklmnop";
const RESET_WRONG_KEY_ID = "reset-wrong-key-0067";
const RESET_WRONG_KEY_TOKEN = "fixture-wrong-key-token-0067-abcdefghijklmnopqrstu";
const NON_ASCII_RESET_USER_ID = "mail-0067-non-ascii-reset";
const NON_ASCII_RESET_EMAIL = "tést-0067@example.invalid";
const NON_ASCII_RESET_ID = "reset-unsupported-non-ascii-0067";
const NON_ASCII_RESET_TOKEN =
  "unsupported-non-ascii-token-0067-abcdefghijklmnop";
const RESET_URL = "https://codestead.example.invalid/api/auth/reset-password/"
  + RESET_TOKEN
  + "?callbackURL=https%3A%2F%2Fcodestead.example.invalid%2Freset-password";
const LOST_DEVICE_ID = fixtureUuid("71", 1);
const SESSION_REVOCATION_ID = fixtureUuid("71", 2);
const INACTIVITY_EPISODE_ID = fixtureUuid("71", 3);
const DELETION_RUN_ID = fixtureUuid("71", 4);
const DELETION_TOMBSTONE_ID = fixtureUuid("71", 5);
const DELETION_OUTBOX_ID = fixtureUuid("73", 12);
const DELETION_OPERATION_ID = fixtureUuid("74", 12);
const DELETION_COMPLETED_AT = "2026-07-25T03:00:00.000Z";
const DELETION_BACKUP_RETENTION_UNTIL = "2027-07-25T03:00:00.000Z";
const NEAR_DELETED_USERS = Object.freeze([
  ["mail-0067-near-deleted-1", "near-deleted-1-0067@example.invalid"],
  ["mail-0067-near-deleted-2", "near-deleted-2-0067@example.invalid"],
  ["mail-0067-near-deleted-3", "near-deleted-3-0067@example.invalid"],
]);
const NEAR_INACTIVITY_EPISODES = Object.freeze([
  fixtureUuid("7e", 1),
  fixtureUuid("7e", 2),
  fixtureUuid("7e", 3),
  fixtureUuid("7e", 4),
]);
const NEAR_DELETION_RUNS = Object.freeze([
  fixtureUuid("7e", 11),
  fixtureUuid("7e", 12),
  fixtureUuid("7e", 13),
]);
const NEAR_DELETION_TOMBSTONES = Object.freeze([
  fixtureUuid("7e", 21),
  fixtureUuid("7e", 22),
  fixtureUuid("7e", 23),
]);
const DELETION_REPORT = Object.freeze({
  runId: DELETION_RUN_ID,
  tombstoneId: DELETION_TOMBSTONE_ID,
  policyVersion: "deletion-2026-07.v1",
  primaryStoreDeletionComplete: true,
  objectFileErasureComplete: true,
  backupStatus: "awaiting_retention_expiry",
  backupRetentionUntil: DELETION_BACKUP_RETENTION_UNTIL,
  deletionNotice: {
    outboxId: DELETION_OUTBOX_ID,
    operationId: DELETION_OPERATION_ID,
    recipientHmacSha256: "d".repeat(64),
    payloadSha256: "e".repeat(64),
  },
  learnerNotificationQueued: true,
});
const ACCESS_ADMIN_ID = fixtureUuid("71", 6);
const ACCESS_APPROVED_ID = fixtureUuid("71", 7);
const ACCESS_REJECTED_ID = fixtureUuid("71", 8);
const INVITATION_ID = fixtureUuid("71", 9);
const INVITATION_TOKEN = "i".repeat(43);
const INVITATION_URL =
  `https://codestead.example.invalid/activate?token=${INVITATION_TOKEN}`;
const SMART_REMINDER_POLICY_VERSION = "smart-reminders-2026-07.v1";
const SMART_REMINDER_WEEKLY_SUMMARY =
  "Your private, evidence-backed weekly summary is ready inside Codestead.";
const BACKUP_RUN_KEY = "20260725T010000Z";
const BACKUP_COMPATIBILITY_RUN_KEY = "20260725T020000Z";
const BACKUP_UUID_COMPATIBILITY_RUN_KEY =
  "8b4f9fbe-d45a-4e4d-9c90-dfef3c8fce31";
const BACKUP_UUID_SECOND_RUN_KEY =
  "57c7d8d7-7cf4-46d0-aecd-720102180fd7";
const SMART_REMINDERS = [
  [
    "daily-study-reminder", "daily_study", fixtureUuid("72", 1),
    "2026-07-25", "2026-07-25T12:00:00.000Z",
    "https://codestead.example.invalid/learn", "legacy",
  ],
  [
    "revision-reminder", "revision", fixtureUuid("72", 2),
    "2026-07-25", "2026-07-25T12:00:00.000Z",
    "https://codestead.example.invalid/review", "current",
  ],
  [
    "goal-reminder", "goal", fixtureUuid("72", 3),
    "2026-W30", "2026-07-20T12:00:00.000Z",
    "https://codestead.example.invalid/roadmap", "current",
  ],
  [
    "challenge-reminder", "challenge", fixtureUuid("72", 4),
    "2026-07-25", "2026-07-25T12:00:00.000Z",
    "https://codestead.example.invalid/community?section=battles", "current",
  ],
  [
    "weekly-summary", "weekly_summary", fixtureUuid("72", 5),
    "2026-W29", "2026-07-19T12:00:00.000Z",
    "https://codestead.example.invalid/learn", "current", "current-weekly",
  ],
  [
    "weekly-summary", "weekly_summary", fixtureUuid("72", 6),
    "2026-W28", "2026-07-12T12:00:00.000Z",
    "https://codestead.example.invalid/learn", "legacy", "legacy-weekly",
  ],
];
const SMART_NEAR_CASES = Object.freeze([
  {
    caseName: "smart-wrong-kind", template: "daily-study-reminder",
    kind: "revision", id: fixtureUuid("72", 101), period: "2026-07-18",
    scheduledAt: "2026-07-18T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
  },
  {
    caseName: "smart-wrong-period", template: "daily-study-reminder",
    kind: "daily_study", id: fixtureUuid("72", 102), period: "2026-07-01",
    scheduledAt: "2026-07-17T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
  },
  {
    caseName: "smart-wrong-evidence", template: "daily-study-reminder",
    kind: "daily_study", id: fixtureUuid("72", 103), period: "2026-07-11",
    scheduledAt: "2026-07-11T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
    evidencePatch: { reviewDue: true },
  },
  {
    caseName: "smart-wrong-name", template: "daily-study-reminder",
    kind: "daily_study", id: fixtureUuid("72", 104), period: "2026-07-10",
    scheduledAt: "2026-07-10T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
    variablePatch: { name: "Forged learner" },
  },
  {
    caseName: "smart-wrong-url", template: "daily-study-reminder",
    kind: "daily_study", id: fixtureUuid("72", 105), period: "2026-07-09",
    scheduledAt: "2026-07-09T12:00:00.000Z",
    url: "https://codestead.example.invalid/review", epoch: "current",
  },
  {
    caseName: "smart-extra-variable", template: "daily-study-reminder",
    kind: "daily_study", id: fixtureUuid("72", 106), period: "2026-07-08",
    scheduledAt: "2026-07-08T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
    variablePatch: { forged: "true" },
  },
  {
    caseName: "smart-weekly-missing-summary", template: "weekly-summary",
    kind: "weekly_summary", id: fixtureUuid("72", 107), period: "2026-W26",
    scheduledAt: "2026-06-28T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "legacy",
    omitSummary: true,
  },
  {
    caseName: "smart-invalid-timezone", template: "daily-study-reminder",
    kind: "daily_study", id: fixtureUuid("72", 108), period: "2026-07-04",
    scheduledAt: "2026-07-04T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
    timezone: "Mars/Olympus",
  },
  {
    caseName: "smart-goal-not-monday", template: "goal-reminder",
    kind: "goal", id: fixtureUuid("72", 109), period: "2026-W28",
    scheduledAt: "2026-07-07T12:00:00.000Z",
    url: "https://codestead.example.invalid/roadmap", epoch: "current",
  },
  {
    caseName: "smart-weekly-not-sunday", template: "weekly-summary",
    kind: "weekly_summary", id: fixtureUuid("72", 110), period: "2026-W27",
    scheduledAt: "2026-06-30T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
  },
  {
    caseName: "smart-daily-wrong-version", template: "daily-study-reminder",
    kind: "daily_study", id: fixtureUuid("72", 111), period: "2026-07-07",
    scheduledAt: "2026-07-07T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
    version: "2",
  },
  {
    caseName: "smart-revision-wrong-version", template: "revision-reminder",
    kind: "revision", id: fixtureUuid("72", 112), period: "2026-07-11",
    scheduledAt: "2026-07-11T12:00:00.000Z",
    url: "https://codestead.example.invalid/review", epoch: "current",
    version: "2",
  },
  {
    caseName: "smart-goal-wrong-version", template: "goal-reminder",
    kind: "goal", id: fixtureUuid("72", 113), period: "2026-W27",
    scheduledAt: "2026-06-29T12:00:00.000Z",
    url: "https://codestead.example.invalid/roadmap", epoch: "current",
    version: "2",
  },
  {
    caseName: "smart-challenge-wrong-version", template: "challenge-reminder",
    kind: "challenge", id: fixtureUuid("72", 114), period: "2026-07-11",
    scheduledAt: "2026-07-11T12:00:00.000Z",
    url: "https://codestead.example.invalid/community?section=battles",
    epoch: "current", version: "2",
  },
  {
    caseName: "smart-weekly-wrong-version", template: "weekly-summary",
    kind: "weekly_summary", id: fixtureUuid("72", 115), period: "2026-W25",
    scheduledAt: "2026-06-21T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
    version: "2",
  },
  {
    caseName: "smart-current-dispatch-id-mismatch",
    template: "daily-study-reminder", kind: "daily_study",
    id: fixtureUuid("72", 116), period: "2026-06-27",
    scheduledAt: "2026-06-27T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
    variablePatch: { smartReminderDispatchId: fixtureUuid("72", 9_001) },
  },
  {
    caseName: "smart-current-kind-mismatch",
    template: "daily-study-reminder", kind: "daily_study",
    id: fixtureUuid("72", 117), period: "2026-06-26",
    scheduledAt: "2026-06-26T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
    variablePatch: { smartReminderKind: "revision" },
  },
  {
    caseName: "smart-current-period-mismatch",
    template: "daily-study-reminder", kind: "daily_study",
    id: fixtureUuid("72", 118), period: "2026-06-25",
    scheduledAt: "2026-06-25T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
    variablePatch: { smartReminderPeriodKey: "2026-06-24" },
  },
  {
    caseName: "smart-current-policy-mismatch",
    template: "daily-study-reminder", kind: "daily_study",
    id: fixtureUuid("72", 119), period: "2026-06-24",
    scheduledAt: "2026-06-24T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
    variablePatch: { smartReminderPolicyVersion: "smart-reminders-forged" },
  },
  {
    caseName: "smart-source-user-mismatch",
    template: "daily-study-reminder", kind: "daily_study",
    id: fixtureUuid("72", 120), period: "2026-06-23",
    scheduledAt: "2026-06-23T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
    sourceUserId: SMART_SOURCE_MISMATCH_USER_ID,
    outboxTo: SMART_SOURCE_MISMATCH_EMAIL,
    variablePatch: { name: SMART_SOURCE_MISMATCH_NAME },
  },
  {
    caseName: "smart-recipient-mismatch",
    template: "daily-study-reminder", kind: "daily_study",
    id: fixtureUuid("72", 121), period: "2026-06-22",
    scheduledAt: "2026-06-22T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
    outboxTo: NEAR_DELETED_USERS[0][1],
  },
  {
    caseName: "smart-dispatched-scheduled-mismatch",
    template: "daily-study-reminder", kind: "daily_study",
    id: fixtureUuid("72", 122), period: "2026-06-21",
    scheduledAt: "2026-06-21T12:00:00.000Z",
    dispatchedAt: "2026-06-21T13:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
  },
  {
    caseName: "smart-future-dispatch",
    template: "daily-study-reminder", kind: "daily_study",
    id: fixtureUuid("72", 123), period: "2099-01-01",
    scheduledAt: "2099-01-01T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
  },
  {
    caseName: "smart-wrong-legacy-key",
    template: "daily-study-reminder", kind: "daily_study",
    id: fixtureUuid("72", 124), period: "2026-06-20",
    scheduledAt: "2026-06-20T12:00:00.000Z",
    url: "https://codestead.example.invalid/learn", epoch: "current",
    wrongLegacyKey: true,
  },
]);
const SYSTEM_NEAR_CASES = Object.freeze([
  ...[
    "invitation-wrong-status",
    "invitation-missing-decision-reason",
    "invitation-missing-decided-at",
    "invitation-missing-decided-by",
    "invitation-wrong-creator",
    "invitation-email-mismatch",
    "invitation-request-email-mismatch",
    "invitation-name-mismatch",
    "invitation-token-mismatch",
    "invitation-token-wrong-route",
    "invitation-duplicate-token-query",
    "invitation-token-query-suffix",
    "invitation-extra-variable",
    "invitation-audience-mismatch",
    "invitation-wrong-legacy-key",
    "invitation-whitespace-host",
  ].map((caseName, index) => ({
    caseName,
    template: "invitation",
    producer: "access-request-approved",
    requestId: fixtureUuid("81", index + 1),
    sourceId: fixtureUuid("82", index + 1),
    token: String.fromCharCode(65 + index).repeat(43),
  })),
  ...[
    "rejection-wrong-status",
    "rejection-missing-decision-reason",
    "rejection-missing-decided-at",
    "rejection-missing-decided-by",
    "rejection-email-mismatch",
    "rejection-name-mismatch",
    "rejection-extra-variable",
    "rejection-audience-mismatch",
    "rejection-wrong-legacy-key",
  ].map((caseName, index) => ({
    caseName,
    template: "access-rejected",
    producer: "access-request-rejected",
    requestId: fixtureUuid("81", index + 101),
    sourceId: fixtureUuid("81", index + 101),
  })),
]);
const BACKUP_NEAR_CASE = Object.freeze({
  caseName: "backup-status-wrong-version",
  id: fixtureUuid("83", 1),
  operationId: fixtureUuid("84", 1),
  authorityId: fixtureUuid("85", 1),
  runKey: "20260725T030000Z",
});
const SOURCE_MAP_POLICY = Object.freeze([
  "reset-password",
  "invitation",
  "lost-device-proof",
  "access-rejected",
  "session-revocation-requested",
  "account-deleted",
  "inactivity-reminder",
  "inactivity-reminder-followup",
  "inactivity-admin-notice",
  "daily-study-reminder",
  "revision-reminder",
  "goal-reminder",
  "challenge-reminder",
  "weekly-summary",
  "backup-status",
  "verify-email",
  "fallback-grant-changed",
  "learning-plan-changed",
  "storage-quota-changed",
  "mastery-awarded",
  "appeal-updated",
  "assessment-corrected",
]);
const RETAINED_LEGACY_STRATEGIES = Object.freeze({
  "access-request-admin": "legacy-key-source-one-shot-v1",
  "new-device": "legacy-key-source-one-shot-v1",
  "session-revoked": "legacy-key-source-one-shot-v1",
  "learning-request-updated": "legacy-key-terminal-cas-v1",
  "session-revocation-updated": "legacy-key-terminal-cas-v1",
  "credential-changed": "legacy-key-protocol-retired-v1",
  "credential-revealed": "legacy-key-fresh-action-v1",
});
const sourceMapPolicySet = new Set(SOURCE_MAP_POLICY);
const retainedLegacyStrategyMap = new Map(
  Object.entries(RETAINED_LEGACY_STRATEGIES),
);
assert.equal(sourceMapPolicySet.size, 22);
assert.equal(retainedLegacyStrategyMap.size, 7);
assert.equal(sourceMapPolicySet.size + retainedLegacyStrategyMap.size, 29);
assert.deepEqual(
  [...sourceMapPolicySet].filter((template) =>
    retainedLegacyStrategyMap.has(template)
  ),
  [],
);

function fixtureUuid(namespace, number) {
  assert.match(namespace, /^[0-9a-f]{2}$/u);
  assert.ok(Number.isSafeInteger(number) && number > 0 && number < 1_000_000);
  return `${namespace}000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function resetUrl(token) {
  return "https://codestead.example.invalid/api/auth/reset-password/"
    + token
    + "?callbackURL=https%3A%2F%2Fcodestead.example.invalid%2Freset-password";
}

function deletionReport({
  runId,
  tombstoneId,
  outboxId,
  operationId,
  backupRetentionUntil = DELETION_BACKUP_RETENTION_UNTIL,
}) {
  return {
    runId,
    tombstoneId,
    policyVersion: "deletion-2026-07.v1",
    primaryStoreDeletionComplete: true,
    objectFileErasureComplete: true,
    backupStatus: "awaiting_retention_expiry",
    backupRetentionUntil,
    deletionNotice: {
      outboxId,
      operationId,
      recipientHmacSha256: "d".repeat(64),
      payloadSha256: "e".repeat(64),
    },
    learnerNotificationQueued: true,
  };
}

function legacyRecipientKey(template, recipient, seed) {
  return digest(`${template}:${recipient.toLowerCase()}:${seed}`);
}

function accountEventKey(template, userId, eventId) {
  return digest(
    ["mail-event-v1", template, `a:${userId}`, eventId].join(separator),
  );
}

function systemEventKey(template, producer, sourceId, audienceId, eventId) {
  return digest([
    "mail-event-v1",
    template,
    `s:${producer}:${sourceId}:${audienceId}`,
    eventId,
  ].join(separator));
}

function executable(name) {
  return path.join(postgresBin, `${name}${executableSuffix}`);
}

function isolatedChildEnvironment() {
  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    PGCONNECT_TIMEOUT: "5",
    PGOPTIONS:
      "-c statement_timeout=25000 -c idle_in_transaction_session_timeout=25000",
  };
}

function isolatedClientConfig({ applicationName, database, port, user }) {
  return {
    application_name: applicationName,
    database,
    host: "127.0.0.1",
    port,
    user,
    password: "",
    ssl: false,
    options: "",
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    statement_timeout: 25_000,
    idle_in_transaction_session_timeout: 25_000,
  };
}

function isolatedPoolConfig({ applicationName, database, port, user }) {
  return {
    ...isolatedClientConfig({ applicationName, database, port, user }),
    allowExitOnIdle: true,
    idleTimeoutMillis: 5_000,
    max: 1,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: isolatedChildEnvironment(),
    input: options.input,
    maxBuffer: CHILD_OUTPUT_MAX_BYTES,
    stdio: options.stdio,
    timeout: options.timeoutMs ?? CHILD_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${path.basename(command)} failed with status ${result.status}\n`
      + `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    );
  }
  return result;
}

function connectionArgs(port, database, username = "postgres") {
  return [
    "--host=127.0.0.1",
    `--port=${port}`,
    `--username=${username}`,
    `--dbname=${database}`,
    "--no-psqlrc",
  ];
}

function psql(port, database, sql, options = {}) {
  return run(
    executable("psql"),
    [
      ...connectionArgs(port, database, options.username),
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      ...(options.scalar ? ["--tuples-only", "--no-align"] : []),
      ...(options.singleTransaction ? ["--single-transaction"] : []),
    ],
    {
      input: sql,
      allowFailure: options.allowFailure,
      timeoutMs: options.timeoutMs,
    },
  );
}

function scalar(
  port,
  database,
  sql,
  username = "postgres",
  timeoutMs,
) {
  return psql(port, database, sql, {
    username,
    scalar: true,
    timeoutMs,
  }).stdout.trim();
}

async function queryDatabase(port, database, username, sql) {
  const client = createTrackedClient(isolatedClientConfig({
    applicationName: "mail0067_query_database",
    database,
    port,
    user: username,
  }));
  let operationError;
  let result;
  const cleanupFailures = [];
  try {
    await connectClientWithin(client, "query database client");
    result = await client.query(sql);
  } catch (error) {
    operationError = error;
  } finally {
    await runCleanupStep(
      cleanupFailures,
      () => closeClientWithin(client, "query database client"),
      "query database client cleanup",
    );
  }
  if (operationError !== undefined || cleanupFailures.length > 0) {
    throw preserveOperationAndCleanupFailures(
      operationError,
      cleanupFailures,
      "query database operation and cleanup failed",
    );
  }
  return result;
}
async function expectDatabaseError(
  port,
  database,
  username,
  sql,
  { code, constraint, message },
) {
  const client = createTrackedClient(isolatedClientConfig({
    applicationName: "mail0067_expected_error",
    database,
    port,
    user: username,
  }));
  let operationError;
  let matchedError;
  const cleanupFailures = [];
  try {
    await connectClientWithin(client, "expected-error client");
    try {
      await client.query(sql);
      assert.fail(`expected PostgreSQL ${code}/${constraint}`);
    } catch (error) {
      assert.equal(error?.code, code);
      assert.equal(error?.constraint, constraint);
      if (message !== undefined) assert.equal(error?.message, message);
      matchedError = error;
    }
  } catch (error) {
    operationError = error;
  } finally {
    await runCleanupStep(
      cleanupFailures,
      () => closeClientWithin(client, "expected-error client"),
      "expected-error client cleanup",
    );
  }
  if (operationError !== undefined || cleanupFailures.length > 0) {
    throw preserveOperationAndCleanupFailures(
      operationError,
      cleanupFailures,
      "expected-error query and cleanup failed",
    );
  }
  return matchedError;
}
function ownerSql(port, database, sql) {
  return psql(
    port,
    database,
    `SET ROLE learncoding_owner;\n${sql}`,
    { username: "learncoding_migrator", timeoutMs: 55_000 },
  );
}

function expectSqlFailure(
  port,
  database,
  username,
  sql,
  expectedPattern,
) {
  const result = psql(port, database, sql, {
    username,
    allowFailure: true,
    timeoutMs: 30_000,
  });
  assert.notEqual(result.status, 0, `${username} statement unexpectedly passed`);
  assert.match(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    expectedPattern,
  );
}

function destroyChildStdio(child) {
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function terminateAndVerify(child, closed, label) {
  try {
    let result;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      try {
        result = await settleWithin(
          closed,
          `${label} graceful close`,
          CHILD_TERMINATION_TIMEOUT_MS,
        );
      } catch (gracefulError) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        try {
          result = await settleWithin(
            closed,
            `${label} forced close`,
            CHILD_TERMINATION_TIMEOUT_MS,
          );
        } catch (forcedError) {
          throw new AggregateError(
            [gracefulError, forcedError],
            `${label} did not close after forced termination`,
            { cause: gracefulError },
          );
        }
      }
    } else {
      result = await settleWithin(
        closed,
        `${label} observed close`,
        CHILD_TERMINATION_TIMEOUT_MS,
      );
    }
    assert.ok(
      child.exitCode !== null || child.signalCode !== null,
      `${label} did not report an exit status or signal`,
    );
    return result;
  } finally {
    destroyChildStdio(child);
  }
}

function spawnPsql(port, database, username, sql) {
  const child = spawn(
    executable("psql"),
    [
      ...connectionArgs(port, database, username),
      "--set=ON_ERROR_STOP=1",
      "--quiet",
      "--command",
      sql,
    ],
    {
      cwd: repositoryRoot,
      env: isolatedChildEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  registerTrackedPsqlChild(child);
  let stdout = "";
  let stderr = "";
  let launchError;
  let outputBytes = 0;
  let rejectOutputOverflow;
  let outputOverflowRejected = false;
  const outputOverflow = new Promise((resolve, reject) => {
    void resolve;
    rejectOutputOverflow = reject;
  });
  const captureOutput = (streamName, current, chunk) => {
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (outputBytes + chunkBytes > CHILD_OUTPUT_MAX_BYTES) {
      launchError ??= new Error(
        `live PostgreSQL child ${streamName} exceeded `
        + `${CHILD_OUTPUT_MAX_BYTES} bytes`,
      );
      if (!outputOverflowRejected) {
        outputOverflowRejected = true;
        rejectOutputOverflow(launchError);
      }
      return current;
    }
    outputBytes += chunkBytes;
    return current + chunk;
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = captureOutput("stdout", stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = captureOutput("stderr", stderr, chunk);
  });
  const closed = new Promise((resolve) => {
    child.once("error", (error) => {
      launchError ??= error;
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
  const completed = observePromiseOutcome(
    (async () => {
    let timeoutId;
    const timed = new Promise((resolve, reject) => {
      void resolve;
      timeoutId = setTimeout(() => {
        reject(new Error(
          `live PostgreSQL child exceeded ${CHILD_TIMEOUT_MS}ms`,
        ));
      }, CHILD_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([closed, timed, outputOverflow]);
      if (launchError !== undefined) throw launchError;
      return result;
    } catch (error) {
      try {
        await terminateAndVerify(child, closed, "failed PostgreSQL child");
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "PostgreSQL child failed and cleanup also failed",
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
    })(),
  );
  const completedAndUnregistered = completed.then((outcome) => {
    unregisterTrackedPsqlChild(child);
    return outcome;
  });
  const terminate = () => terminateAndVerify(
    child,
    closed,
    "requested PostgreSQL child",
  );
  trackedPsqlChildHandles.set(child, {
    completed: completedAndUnregistered,
    terminate,
  });
  return {
    get completed() {
      return unwrapObservedOutcome(completedAndUnregistered);
    },
    terminate,
  };
}

function createOperationDeadline(timeoutMs = OPERATION_TIMEOUT_MS) {
  assert.ok(
    Number.isFinite(timeoutMs) && timeoutMs > 0,
    "operation deadline must be positive and finite",
  );
  return Object.freeze({
    expiresAt: performance.now() + Math.min(timeoutMs, OPERATION_TIMEOUT_MS),
  });
}

function remainingDeadlineMs(deadline, label = "operation") {
  const remainingMs = Math.ceil(deadline.expiresAt - performance.now());
  if (remainingMs <= 0) {
    throw new Error(`${label} exceeded its monotonic operation deadline`);
  }
  return remainingMs;
}

async function waitForMarker(
  port,
  database,
  marker,
  waitEvent = "PgSleep",
  deadline = createOperationDeadline(OPERATION_TIMEOUT_MS),
) {
  while (true) {
    let remainingMs = remainingDeadlineMs(
      deadline,
      `marker wait ${marker}:${waitEvent}`,
    );
    if (
      scalar(
        port,
        database,
        `SELECT pg_catalog.count(*)::text
           FROM pg_catalog.pg_stat_activity
          WHERE pid <> pg_catalog.pg_backend_pid()
            AND state = 'active'
            AND wait_event = ${sqlLiteral(waitEvent)}
            AND query LIKE '%${marker}%';`,
        "postgres",
        remainingMs,
      ) === "1"
    ) {
      return;
    }
    remainingMs = remainingDeadlineMs(
      deadline,
      `marker wait ${marker}:${waitEvent}`,
    );
    await delay(Math.min(
      POLL_INTERVAL_MS,
      remainingMs,
    ));
  }
}
async function waitForAdvisoryLockWaiter(
  port,
  database,
  applicationName,
  deadline = createOperationDeadline(OPERATION_TIMEOUT_MS),
) {
  while (true) {
    let remainingMs = remainingDeadlineMs(
      deadline,
      `advisory-lock wait ${applicationName}`,
    );
    if (
      scalar(
        port,
        database,
        `SELECT (
           SELECT pg_catalog.count(*)
             FROM pg_catalog.pg_stat_activity AS activity
             JOIN pg_catalog.pg_locks AS lock
               ON lock.pid = activity.pid
            WHERE activity.pid <> pg_catalog.pg_backend_pid()
              AND activity.application_name = ${sqlLiteral(applicationName)}
              AND activity.state = 'active'
              AND activity.wait_event_type = 'Lock'
              AND activity.wait_event = 'advisory'
              AND lock.locktype = 'advisory'
              AND lock.granted IS FALSE
         )::text;`,
        "postgres",
        remainingMs,
      ) === "1"
    ) {
      return;
    }
    remainingMs = remainingDeadlineMs(
      deadline,
      `advisory-lock wait ${applicationName}`,
    );
    await delay(Math.min(
      POLL_INTERVAL_MS,
      remainingMs,
    ));
  }
}

async function waitForCutoverTopology(
  probe,
  label,
  deadline = createOperationDeadline(OPERATION_TIMEOUT_MS),
) {
  let lastRows = [];
  while (true) {
    let remainingMs = remainingDeadlineMs(deadline, label);
    const result = await settleWithin(
      probe(),
      `${label} probe`,
      Math.min(
        SETUP_TIMEOUT_MS,
        remainingMs,
      ),
    );
    lastRows = result.rows;
    if (lastRows.length === 1) return lastRows[0];
    remainingMs = remainingDeadlineMs(deadline, label);
    await delay(Math.min(
      POLL_INTERVAL_MS,
      remainingMs,
    ));
  }
}

async function waitForCutoverAdvisoryLockTopology(
  observer,
  {
    controllerApplicationName,
    gateKey,
    waiterApplicationName,
  },
) {
  assert.ok(Number.isSafeInteger(gateKey) && gateKey > 0);
  const topology = await waitForCutoverTopology(
    () => observer.query(
      `SELECT
         waiter.pid AS waiter_pid,
         waiter.application_name AS waiter_application_name,
         waiter.usename AS waiter_user,
         waiter.wait_event_type,
         waiter.wait_event,
         waiter.query AS waiter_query,
         controller.pid AS controller_pid,
         controller.application_name AS controller_application_name,
         controller.usename AS controller_user,
         pg_catalog.pg_blocking_pids(waiter.pid) AS blocker_pids
       FROM pg_catalog.pg_stat_activity AS waiter
       JOIN pg_catalog.pg_locks AS waiting_lock
         ON waiting_lock.pid = waiter.pid
        AND waiting_lock.locktype = 'advisory'
        AND waiting_lock.granted IS FALSE
        AND waiting_lock.classid = 0::pg_catalog.oid
        AND waiting_lock.objid = $3::pg_catalog.oid
        AND waiting_lock.objsubid = 1
       JOIN pg_catalog.pg_locks AS blocking_lock
         ON blocking_lock.pid = pg_catalog.pg_backend_pid()
        AND blocking_lock.locktype = waiting_lock.locktype
        AND blocking_lock.database = waiting_lock.database
        AND blocking_lock.classid = waiting_lock.classid
        AND blocking_lock.objid = waiting_lock.objid
        AND blocking_lock.objsubid = waiting_lock.objsubid
        AND blocking_lock.mode = waiting_lock.mode
        AND blocking_lock.granted IS TRUE
       JOIN pg_catalog.pg_stat_activity AS controller
         ON controller.pid = blocking_lock.pid
      WHERE waiter.datname = pg_catalog.current_database()
        AND waiter.application_name = $1
        AND waiter.usename = 'learncoding_migrator'
        AND waiter.state = 'active'
        AND waiter.wait_event_type = 'Lock'
        AND waiter.wait_event = 'advisory'
        AND waiter.query LIKE '%pg_advisory_xact_lock%'
        AND controller.application_name = $2
        AND controller.usename = 'postgres';`,
      [
        waiterApplicationName,
        controllerApplicationName,
        gateKey,
      ],
    ),
    `cutover advisory topology for ${waiterApplicationName}`,
  );
  assert.deepEqual(
    topology.blocker_pids.map(Number),
    [Number(topology.controller_pid)],
  );
  assert.equal(
    topology.waiter_application_name,
    waiterApplicationName,
  );
  assert.equal(
    topology.controller_application_name,
    controllerApplicationName,
  );
  assert.equal(topology.waiter_user, "learncoding_migrator");
  assert.equal(topology.controller_user, "postgres");
  assert.equal(topology.wait_event_type, "Lock");
  assert.equal(topology.wait_event, "advisory");
  assert.match(topology.waiter_query, /pg_advisory_xact_lock/iu);
  return topology;
}

async function waitForCoverageSnapshotTopology(
  observer,
  {
    controllerApplicationName,
    gateKey,
    holderApplicationName,
    waiterMarker,
  },
) {
  assert.ok(Number.isSafeInteger(gateKey) && gateKey > 0);
  const topology = await waitForCutoverTopology(
    () => observer.query(
      `SELECT
         waiter.pid AS waiter_pid,
         waiter.application_name AS waiter_application_name,
         waiter.usename AS waiter_user,
         waiter.wait_event_type AS waiter_wait_event_type,
         waiter.wait_event AS waiter_wait_event,
         waiter.query AS waiter_query,
         holder.pid AS holder_pid,
         holder.application_name AS holder_application_name,
         holder.usename AS holder_user,
         holder.wait_event_type AS holder_wait_event_type,
         holder.wait_event AS holder_wait_event,
         holder.query AS holder_query,
         controller.pid AS controller_pid,
         controller.application_name AS controller_application_name,
         controller.usename AS controller_user,
         pg_catalog.pg_blocking_pids(waiter.pid) AS blocker_pids,
         pg_catalog.pg_blocking_pids(holder.pid) AS holder_blocker_pids
       FROM pg_catalog.pg_stat_activity AS waiter
       JOIN pg_catalog.pg_stat_activity AS holder
         ON holder.datname = pg_catalog.current_database()
        AND holder.application_name = $2
       JOIN pg_catalog.pg_locks AS waiting_transaction
         ON waiting_transaction.pid = waiter.pid
        AND waiting_transaction.locktype = 'transactionid'
        AND waiting_transaction.granted IS FALSE
       JOIN pg_catalog.pg_locks AS blocking_transaction
         ON blocking_transaction.pid = holder.pid
        AND blocking_transaction.locktype =
            waiting_transaction.locktype
        AND blocking_transaction.database
            IS NOT DISTINCT FROM waiting_transaction.database
        AND blocking_transaction.transactionid =
            waiting_transaction.transactionid
        AND blocking_transaction.mode = 'ExclusiveLock'
        AND blocking_transaction.granted IS TRUE
       JOIN pg_catalog.pg_locks AS waiting_gate
         ON waiting_gate.pid = holder.pid
        AND waiting_gate.locktype = 'advisory'
        AND waiting_gate.granted IS FALSE
        AND waiting_gate.classid = 0::pg_catalog.oid
        AND waiting_gate.objid = $4::pg_catalog.oid
        AND waiting_gate.objsubid = 1
       JOIN pg_catalog.pg_locks AS blocking_gate
         ON blocking_gate.pid = pg_catalog.pg_backend_pid()
        AND blocking_gate.locktype = waiting_gate.locktype
        AND blocking_gate.database = waiting_gate.database
        AND blocking_gate.classid = waiting_gate.classid
        AND blocking_gate.objid = waiting_gate.objid
        AND blocking_gate.objsubid = waiting_gate.objsubid
        AND blocking_gate.mode = waiting_gate.mode
        AND blocking_gate.granted IS TRUE
       JOIN pg_catalog.pg_stat_activity AS controller
         ON controller.pid = blocking_gate.pid
      WHERE waiter.datname = pg_catalog.current_database()
        AND waiter.usename = 'learncoding_ops'
        AND waiter.state = 'active'
        AND waiter.wait_event_type = 'Lock'
        AND waiter.wait_event = 'transactionid'
        AND waiter.query LIKE ('%' || $1 || '%')
        AND holder.usename = 'learncoding_migrator'
        AND holder.state = 'active'
        AND holder.wait_event_type = 'Lock'
        AND holder.wait_event = 'advisory'
        AND holder.query LIKE '%FOR UPDATE%'
        AND holder.query LIKE '%pg_advisory_xact_lock%'
        AND controller.application_name = $3
        AND controller.usename = 'postgres';`,
      [
        waiterMarker,
        holderApplicationName,
        controllerApplicationName,
        gateKey,
      ],
    ),
    "coverage snapshot transaction/advisory topology",
    createOperationDeadline(COVERAGE_SNAPSHOT_TOPOLOGY_TIMEOUT_MS),
  );
  assert.deepEqual(
    topology.blocker_pids.map(Number),
    [Number(topology.holder_pid)],
  );
  assert.deepEqual(
    topology.holder_blocker_pids.map(Number),
    [Number(topology.controller_pid)],
  );
  assert.equal(
    topology.holder_application_name,
    holderApplicationName,
  );
  assert.equal(
    topology.controller_application_name,
    controllerApplicationName,
  );
  assert.equal(topology.waiter_user, "learncoding_ops");
  assert.equal(topology.holder_user, "learncoding_migrator");
  assert.equal(topology.controller_user, "postgres");
  assert.equal(topology.waiter_wait_event_type, "Lock");
  assert.equal(topology.waiter_wait_event, "transactionid");
  assert.equal(topology.holder_wait_event_type, "Lock");
  assert.equal(topology.holder_wait_event, "advisory");
  assert.match(topology.waiter_query, new RegExp(waiterMarker, "u"));
  assert.match(topology.holder_query, /FOR UPDATE/iu);
  assert.match(topology.holder_query, /pg_advisory_xact_lock/iu);
  return topology;
}

async function waitForCutoverRelationLockTopology(
  observer,
  {
    controllerApplicationName,
    migrationApplicationName,
    producerApplicationName,
  },
) {
  const topology = await waitForCutoverTopology(
    () => observer.query(
      `SELECT
         producer.pid AS producer_pid,
         producer.application_name AS producer_application_name,
         producer.usename AS producer_user,
         producer.wait_event_type AS producer_wait_event_type,
         producer.wait_event AS producer_wait_event,
         producer.query AS producer_query,
         migration.pid AS migration_pid,
         migration.application_name AS migration_application_name,
         migration.usename AS migration_user,
         migration.wait_event_type AS migration_wait_event_type,
         migration.wait_event AS migration_wait_event,
         controller.pid AS controller_pid,
         pg_catalog.pg_blocking_pids(producer.pid) AS blocker_pids,
         pg_catalog.pg_blocking_pids(migration.pid)
           AS migration_blocker_pids
       FROM pg_catalog.pg_stat_activity AS producer
       JOIN pg_catalog.pg_locks AS waiting_outbox
         ON waiting_outbox.pid = producer.pid
        AND waiting_outbox.locktype = 'relation'
        AND waiting_outbox.relation =
            'public.email_outbox'::pg_catalog.regclass
        AND waiting_outbox.mode = 'RowExclusiveLock'
        AND waiting_outbox.granted IS FALSE
       JOIN pg_catalog.pg_stat_activity AS migration
         ON migration.application_name = $2
        AND migration.datname = pg_catalog.current_database()
       JOIN pg_catalog.pg_locks AS blocking_outbox
         ON blocking_outbox.pid = migration.pid
        AND blocking_outbox.locktype = waiting_outbox.locktype
        AND blocking_outbox.relation = waiting_outbox.relation
        AND blocking_outbox.mode = 'AccessExclusiveLock'
        AND blocking_outbox.granted IS TRUE
       JOIN pg_catalog.pg_locks AS source_lock
         ON source_lock.pid = producer.pid
        AND source_lock.locktype = 'relation'
        AND source_lock.relation =
            'public.smart_reminder_dispatch'::pg_catalog.regclass
        AND source_lock.mode = 'RowExclusiveLock'
        AND source_lock.granted IS TRUE
       JOIN pg_catalog.pg_stat_activity AS controller
         ON controller.pid = pg_catalog.pg_backend_pid()
      WHERE producer.application_name = $1
        AND producer.datname = pg_catalog.current_database()
        AND producer.usename = 'learncoding_migrator'
        AND producer.state = 'active'
        AND producer.wait_event_type = 'Lock'
        AND producer.wait_event = 'relation'
        AND migration.usename = 'learncoding_migrator'
        AND migration.state = 'active'
        AND migration.wait_event_type = 'Lock'
        AND migration.wait_event = 'advisory'
        AND controller.application_name = $3
        AND controller.usename = 'postgres';`,
      [
        producerApplicationName,
        migrationApplicationName,
        controllerApplicationName,
      ],
    ),
    "cutover relation-lock topology",
  );
  assert.deepEqual(
    topology.blocker_pids.map(Number),
    [Number(topology.migration_pid)],
  );
  assert.deepEqual(
    topology.migration_blocker_pids.map(Number),
    [Number(topology.controller_pid)],
  );
  assert.equal(
    topology.producer_application_name,
    producerApplicationName,
  );
  assert.equal(
    topology.migration_application_name,
    migrationApplicationName,
  );
  assert.equal(topology.producer_user, "learncoding_migrator");
  assert.equal(topology.migration_user, "learncoding_migrator");
  assert.equal(topology.producer_wait_event_type, "Lock");
  assert.equal(topology.producer_wait_event, "relation");
  assert.equal(topology.migration_wait_event_type, "Lock");
  assert.equal(topology.migration_wait_event, "advisory");
  assert.match(topology.producer_query, /LOCK TABLE public\.email_outbox/iu);
  return topology;
}

async function waitForObservedOutcome(observed, timeoutMs) {
  if (timeoutMs <= 0) return { settled: false };
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(
      () => resolve({ settled: false }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      observed.then((outcome) => ({ settled: true, outcome })),
      timeout,
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function unwrapObservedOutcome(observed) {
  const outcome = await observed;
  if (outcome.status === "rejected") throw outcome.error;
  return outcome.value;
}

async function settleWithin(
  promise,
  label,
  timeoutMs = OPERATION_TIMEOUT_MS,
  {
    abort,
    cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  } = {},
) {
  const observed = observePromiseOutcome(promise);
  const initial = await waitForObservedOutcome(observed, timeoutMs);
  if (initial.settled) {
    if (initial.outcome.status === "rejected") throw initial.outcome.error;
    return initial.outcome.value;
  }

  const timeoutError = new Error(
    `${label} did not settle within ${timeoutMs}ms`,
  );
  timeoutError.name = "HarnessOperationTimeoutError";
  const cleanupFailures = [];
  const cleanupDeadline = performance.now() + cleanupTimeoutMs;
  const cleanupRemainingMs = () => Math.max(
    0,
    Math.ceil(cleanupDeadline - performance.now()),
  );

  if (abort !== undefined) {
    const abortObserved = observePromiseOutcome(
      Promise.resolve().then(abort),
    );
    const abortResult = await waitForObservedOutcome(
      abortObserved,
      cleanupRemainingMs(),
    );
    if (!abortResult.settled) {
      const error = new Error(
        `${label} abort exceeded the cleanup deadline`,
      );
      error.name = "HarnessCleanupTimeoutError";
      cleanupFailures.push(error);
    } else if (abortResult.outcome.status === "rejected") {
      cleanupFailures.push(abortResult.outcome.error);
    }
  }

  const lateResult = await waitForObservedOutcome(
    observed,
    cleanupRemainingMs(),
  );
  if (!lateResult.settled) {
    const error = new Error(
      `${label} remained unsettled after cleanup`,
    );
    error.name = "HarnessCleanupTimeoutError";
    cleanupFailures.push(error);
  } else if (lateResult.outcome.status === "rejected") {
    cleanupFailures.push(lateResult.outcome.error);
  }

  throw preserveOperationAndCleanupFailures(
    timeoutError,
    cleanupFailures,
    `${label} timed out and cleanup was incomplete`,
  );
}

function observePromiseOutcome(promise) {
  return Promise.resolve(promise).then(
    (value) => ({ status: "fulfilled", value }),
    (error) => ({ status: "rejected", error }),
  );
}

async function runCleanupStep(
  cleanupFailures,
  cleanup,
  label,
  timeoutMs = CLIENT_CLOSE_TIMEOUT_MS,
) {
  try {
    return await settleWithin(
      Promise.resolve().then(cleanup),
      label,
      timeoutMs,
      { cleanupTimeoutMs: 0 },
    );
  } catch (error) {
    cleanupFailures.push(error);
    return undefined;
  }
}

async function connectClientWithin(client, label) {
  try {
    await settleWithin(
      client.connect(),
      `${label} connect`,
      CLIENT_CONNECT_TIMEOUT_MS,
      {
        abort: async () => {
          client.connection?.stream?.destroy();
        },
      },
    );
  } catch (error) {
    client.connection?.stream?.destroy();
    throw error;
  }
}

async function closeClientWithin(client, label) {
  try {
    await settleWithin(
      client.end(),
      `${label} close`,
      CLIENT_CLOSE_TIMEOUT_MS,
      {
        abort: async () => {
          client.connection?.stream?.destroy();
        },
      },
    );
    trackedClients.delete(client);
  } catch (error) {
    client.connection?.stream?.destroy();
    throw error;
  }
}

async function cleanupTrackedResources(
  cleanupFailures,
  cleanupDeadline,
) {
  const runTrackedCleanup = async (operation, label) => {
    let timeoutMs;
    try {
      timeoutMs = remainingDeadlineMs(cleanupDeadline, label);
    } catch (error) {
      cleanupFailures.push(error);
      return;
    }
    await runCleanupStep(
      cleanupFailures,
      operation,
      label,
      timeoutMs,
    );
  };

  for (const child of [...trackedPsqlChildren]) {
    const handle = trackedPsqlChildHandles.get(child);
    if (handle === undefined) {
      cleanupFailures.push(new Error(
        "tracked PostgreSQL child is missing its cleanup handle",
      ));
      continue;
    }
    await runTrackedCleanup(
      async () => {
        await handle.terminate();
        const outcome = await handle.completed;
        if (outcome.status === "rejected") throw outcome.error;
        if (trackedPsqlChildren.has(child)) {
          unregisterTrackedPsqlChild(child);
        }
      },
      "top-level PostgreSQL child cleanup",
    );
  }

  for (const client of [...trackedClients]) {
    await runTrackedCleanup(
      () => closeClientWithin(
        client,
        "top-level tracked PostgreSQL client",
      ),
      "top-level PostgreSQL client cleanup",
    );
  }

  for (const pool of [...trackedPools]) {
    await runTrackedCleanup(
      async () => {
        await pool.end();
        trackedPools.delete(pool);
      },
      "top-level PostgreSQL pool cleanup",
    );
  }
}

function assertTrackedResourceRegistryEmpty() {
  assert.deepEqual(
    {
      children: trackedPsqlChildren.size,
      childHandles: trackedPsqlChildHandles.size,
      clients: trackedClients.size,
      pools: trackedPools.size,
    },
    {
      children: 0,
      childHandles: 0,
      clients: 0,
      pools: 0,
    },
    "PostgreSQL resource registry was not empty after cleanup",
  );
}

function stagedMigrationsThrough(temporaryRoot, maximumIndex) {
  const staged = path.join(
    temporaryRoot,
    `migrations-through-${String(maximumIndex).padStart(4, "0")}`,
  );
  const meta = path.join(staged, "meta");
  mkdirSync(meta, { recursive: true });
  for (const name of readdirSync(migrationDirectory)) {
    if (
      /^\d{4}_.+\.sql$/u.test(name)
      && Number.parseInt(name.slice(0, 4), 10) <= maximumIndex
    ) {
      cpSync(path.join(migrationDirectory, name), path.join(staged, name));
    }
  }
  const journal = JSON.parse(
    readFileSync(path.join(migrationDirectory, "meta", "_journal.json"), "utf8"),
  );
  journal.entries = journal.entries.filter(
    (entry) => entry.idx <= maximumIndex,
  );
  writeFileSync(
    path.join(meta, "_journal.json"),
    `${JSON.stringify(journal, null, 2)}\n`,
    "utf8",
  );
  return staged;
}

function migrationVerifierForExpected(expected) {
  assert.ok(expected.length > 0);
  const ledgerSha256 = createHash("sha256")
    .update(JSON.stringify(expected))
    .digest("hex");
  return {
    verifyReviewedMigrationRepository({ drizzleDirectory }) {
      const journal = JSON.parse(
        readFileSync(
          path.join(drizzleDirectory, "meta", "_journal.json"),
          "utf8",
        ),
      );
      assert.deepEqual(
        journal,
        {
          version: "7",
          dialect: "postgresql",
          entries: expected.map(({ sqlSha256: omitted, ...entry }) => {
            assert.match(omitted, /^[0-9a-f]{64}$/u);
            return entry;
          }),
        },
      );
      assert.deepEqual(
        readdirSync(drizzleDirectory)
          .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
          .sort(),
        expected.map(({ tag }) => `${tag}.sql`),
      );
      for (const entry of expected) {
        assert.equal(
          createHash("sha256")
            .update(
              readFileSync(
                path.join(drizzleDirectory, `${entry.tag}.sql`),
              ),
            )
            .digest("hex"),
          entry.sqlSha256,
        );
      }
      return {
        entryCount: expected.length,
        ledgerSha256,
        tailIndex: expected.at(-1).idx,
        tailTag: expected.at(-1).tag,
      };
    },
    async verifyAppliedMigrationLedgerPrefix(
      client,
      { requireComplete = false } = {},
    ) {
      const presence = await client.query(`
        SELECT pg_catalog.to_regclass(
                 'drizzle.__drizzle_migrations'
               ) IS NOT NULL AS present;
      `);
      assert.equal(presence.rows.length, 1);
      if (!presence.rows[0].present) {
        assert.equal(requireComplete, false);
        return { appliedCount: 0, complete: false, ledgerSha256 };
      }
      const result = await client.query(`
        SELECT journal.id::text, journal.hash::text, journal.created_at::text
          FROM drizzle.__drizzle_migrations AS journal
         ORDER BY journal.id;
      `);
      assert.ok(result.rows.length <= expected.length);
      let previousId = -1n;
      result.rows.forEach((row, index) => {
        const reviewed = expected[index];
        const id = BigInt(row.id);
        assert.ok(id > previousId);
        assert.equal(row.hash, reviewed.sqlSha256);
        assert.equal(row.created_at, String(reviewed.when));
        previousId = id;
      });
      if (requireComplete) assert.equal(result.rows.length, expected.length);
      return {
        appliedCount: result.rows.length,
        complete: result.rows.length === expected.length,
        ledgerSha256,
      };
    },
  };
}

function prefixMigrationVerifier(maximumIndex) {
  const expected = REVIEWED_MIGRATION_LEDGER.slice(0, maximumIndex + 1);
  assert.equal(expected.at(-1)?.idx, maximumIndex);
  return migrationVerifierForExpected(expected);
}

function assertCandidateDigestMatchesReviewedLedger() {
  const reviewed = REVIEWED_MIGRATION_LEDGER[67];
  assert.deepEqual(
    reviewed
      ? {
          idx: reviewed.idx,
          version: reviewed.version,
          when: reviewed.when,
          tag: reviewed.tag,
          breakpoints: reviewed.breakpoints,
        }
      : null,
    {
      idx: 67,
      version: "7",
      when: 1785002172253,
      tag: "0067_mail_outbox_durable_replay_authority",
      breakpoints: true,
    },
  );
  const candidateSha256 = createHash("sha256")
    .update(migration0067, "utf8")
    .digest("hex");
  assert.equal(
    candidateSha256,
    reviewed.sqlSha256,
    "0067 candidate bytes diverge from REVIEWED_MIGRATION_LEDGER[67]",
  );
  return candidateSha256;
}

function candidateMigrationVerifier() {
  const journal = JSON.parse(
    readFileSync(path.join(migrationDirectory, "meta", "_journal.json"), "utf8"),
  );
  const journalEntry = journal.entries.find((entry) => entry.idx === 67);
  assert.deepEqual(
    journalEntry,
    {
      idx: 67,
      version: "7",
      when: 1785002172253,
      tag: "0067_mail_outbox_durable_replay_authority",
      breakpoints: true,
    },
  );
  return migrationVerifierForExpected([
    ...REVIEWED_MIGRATION_LEDGER.slice(0, 67),
    {
      ...journalEntry,
      sqlSha256: createHash("sha256").update(migration0067).digest("hex"),
    },
  ]);
}
function sqlLiteral(value) {
  if (value === null) return "NULL";
  return `'${String(value).replaceAll("'", "''")}'`;
}

function insertOutboxSql(
  row,
  { deliveryScopeKey, eventAuthority = false, variablesSql } = {},
) {
  const columns = [
    "id",
    "operation_id",
    "user_id",
    "delivery_scope_key",
    "to_email",
    "template",
    "template_version",
    "variables",
    "idempotency_key",
  ];
  const values = [
    sqlLiteral(row.id),
    sqlLiteral(row.operationId),
    sqlLiteral(row.userId),
    sqlLiteral(
      deliveryScopeKey ??
        (row.userId === null ? `s:${row.operationId}` : `a:${row.userId}`),
    ),
    sqlLiteral(row.to),
    sqlLiteral(row.template),
    sqlLiteral(row.version),
    variablesSql ??
      `${sqlLiteral(JSON.stringify(row.variables))}::jsonb`,
    sqlLiteral(row.key),
  ];
  if (eventAuthority) {
    columns.push("idempotency_authority_version");
    values.push("'event-v1-native'");
  }
  return `INSERT INTO public.email_outbox (
    ${columns.join(", ")}
  ) VALUES (
    ${values.join(", ")}
  )`;
}

function insertExactEventRowsSql(rows) {
  assert.ok(rows.length >= 2);
  return `INSERT INTO public.email_outbox (
    id, operation_id, user_id, delivery_scope_key, to_email, template,
    template_version, variables, idempotency_key,
    idempotency_authority_version
  ) VALUES
    ${rows.map((row) => `(
      ${sqlLiteral(row.id)}, ${sqlLiteral(row.operationId)},
      ${sqlLiteral(row.userId)},
      ${sqlLiteral(row.userId === null
        ? `s:${row.operationId}`
        : `a:${row.userId}`)},
      ${sqlLiteral(row.to)}, ${sqlLiteral(row.template)},
      ${sqlLiteral(row.version)},
      ${sqlLiteral(JSON.stringify(row.variables))}::jsonb,
      ${sqlLiteral(row.key)}, 'event-v1-native'
    )`).join(",\n")}
  `;
}
function systemVariables(
  operationId,
  recipient,
  producer,
  sourceId,
  audienceId,
  payload = {},
) {
  return {
    ...payload,
    _mailOperationId: operationId,
    _mailRecipient: recipient,
    _mailProducer: producer,
    _mailSourceId: sourceId,
    ...(audienceId ? { _mailAudienceId: audienceId } : {}),
  };
}

function smartReminderEvidence(kind) {
  return {
    policyVersion: SMART_REMINDER_POLICY_VERSION,
    reviewDue: kind === "revision",
    activePlan: kind === "goal",
    upcomingBattle: kind === "challenge",
    noMeaningfulActivityToday: kind === "daily_study",
  };
}

function smartReminderVariables({
  template,
  kind,
  dispatchId,
  period,
  url,
  epoch,
}) {
  const base = {
    name: "Mail 0067 Learner",
    ...(template === "weekly-summary"
      ? { summary: SMART_REMINDER_WEEKLY_SUMMARY }
      : {}),
    url,
  };
  if (epoch === "legacy") return base;
  assert.equal(epoch, "current");
  return {
    name: base.name,
    smartReminderDispatchId: dispatchId,
    smartReminderKind: kind,
    smartReminderPeriodKey: period,
    smartReminderPolicyVersion: SMART_REMINDER_POLICY_VERSION,
    ...(template === "weekly-summary"
      ? { summary: SMART_REMINDER_WEEKLY_SUMMARY }
      : {}),
    url,
  };
}

function smartNearVariables(scenario) {
  let variables = smartReminderVariables({
    template: scenario.template,
    kind: scenario.kind,
    dispatchId: scenario.id,
    period: scenario.period,
    url: scenario.url,
    epoch: scenario.epoch,
  });
  if (scenario.omitSummary) {
    const withoutSummary = { ...variables };
    delete withoutSummary.summary;
    variables = withoutSummary;
  }
  return { ...variables, ...(scenario.variablePatch ?? {}) };
}

function systemNearSource(scenario) {
  const recipient = `${scenario.caseName}@example.invalid`;
  const name = `Candidate ${scenario.caseName}`;
  const missingDecidedBy = scenario.caseName.endsWith("missing-decided-by");
  const missingDecisionReason =
    scenario.caseName.endsWith("missing-decision-reason");
  const missingDecidedAt = scenario.caseName.endsWith("missing-decided-at");
  const wrongStatus = scenario.caseName.includes("wrong-status");
  const invitation = scenario.template === "invitation";
  const requestEmailMismatch = [
    "rejection-email-mismatch",
    "invitation-request-email-mismatch",
  ].includes(scenario.caseName);
  return {
    recipient,
    name,
    requestEmail: requestEmailMismatch ? `different-${recipient}` : recipient,
    invitationEmail: scenario.caseName === "invitation-email-mismatch"
      ? `different-${recipient}`
      : recipient,
    status: wrongStatus ? (invitation ? "pending" : "approved")
      : (invitation ? "approved" : "rejected"),
    decidedBy: missingDecidedBy ? null : ADMIN_ID,
    decisionReason: missingDecisionReason
      ? null
      : "Reviewed for hostile replay proof.",
    decidedAt: missingDecidedAt ? null : "2026-07-01T00:00:00.000Z",
    createdBy: scenario.caseName === "invitation-wrong-creator"
      ? LEARNER_ID
      : ADMIN_ID,
  };
}

function systemNearVariables(scenario, operationId) {
  const source = systemNearSource(scenario);
  const invitation = scenario.template === "invitation";
  let url = invitation
    ? `https://codestead.example.invalid/activate?token=${scenario.token}`
    : undefined;
  if (scenario.caseName === "invitation-token-mismatch") {
    url = `https://codestead.example.invalid/activate?token=${"z".repeat(43)}`;
  }
  if (scenario.caseName === "invitation-token-wrong-route") {
    url = `https://codestead.example.invalid/wrong-route?token=${scenario.token}`;
  }
  if (scenario.caseName === "invitation-duplicate-token-query") {
    url = `https://codestead.example.invalid/activate?token=${scenario.token}&token=${scenario.token}`;
  }
  if (scenario.caseName === "invitation-token-query-suffix") {
    url = `https://codestead.example.invalid/activate?token=${scenario.token}&next=learn`;
  }
  if (scenario.caseName === "invitation-whitespace-host") {
    url = `https://bad host.invalid/activate?token=${scenario.token}`;
  }
  const payload = {
    name: scenario.caseName.includes("name-mismatch")
      ? "Forged candidate"
      : source.name,
    ...(url === undefined ? {} : { url }),
    ...(scenario.caseName.includes("extra-variable")
      ? { forged: "true" }
      : {}),
  };
  const variables = systemVariables(
    operationId,
    source.recipient,
    scenario.producer,
    scenario.sourceId,
    null,
    payload,
  );
  if (scenario.caseName.includes("audience-mismatch")) {
    variables._mailAudienceId = "requester:forged";
  }
  return variables;
}
function aliasRows() {
  let sequence = 1;
  const account = (
    template,
    userId,
    recipient,
    version,
    variables,
    legacyKey,
    stableKey,
  ) => {
    const row = {
      id: fixtureUuid("73", sequence),
      operationId: fixtureUuid("74", sequence),
      userId,
      to: recipient,
      template,
      version,
      variables,
      key: legacyKey,
      stableKey,
    };
    sequence += 1;
    return row;
  };
  const system = (
    template,
    recipient,
    producer,
    sourceId,
    audienceId,
    stableKey,
    payload = {},
  ) => {
    const operationId = fixtureUuid("74", sequence);
    const row = {
      id: fixtureUuid("73", sequence),
      operationId,
      userId: null,
      to: recipient,
      template,
      version: "1",
      variables: systemVariables(
        operationId,
        recipient,
        producer,
        sourceId,
        null,
        payload,
      ),
      key: legacyRecipientKey(template, recipient, sourceId),
      stableKey,
      replayVariables: systemVariables(
        fixtureUuid("76", sequence),
        recipient,
        producer,
        sourceId,
        audienceId,
        payload,
      ),
    };
    sequence += 1;
    return row;
  };

  const rows = [
    account(
      "reset-password",
      LEARNER_ID,
      LEARNER_EMAIL,
      "1",
      {
        name: "Mail 0067 Learner",
        resetVerificationId: RESET_VERIFICATION_ID,
        url: RESET_URL,
      },
      legacyRecipientKey(
        "reset-password",
        LEARNER_EMAIL,
        `reset-password:${RESET_VERIFICATION_ID}`,
      ),
      accountEventKey(
        "reset-password",
        LEARNER_ID,
        `reset-password:${RESET_VERIFICATION_ID}`,
      ),
    ),
    account(
      "lost-device-proof",
      LEARNER_ID,
      LEARNER_EMAIL,
      "1",
      { recoveryRequestId: LOST_DEVICE_ID },
      legacyRecipientKey("lost-device-proof", LEARNER_EMAIL, LOST_DEVICE_ID),
      accountEventKey("lost-device-proof", LEARNER_ID, LOST_DEVICE_ID),
    ),
    account(
      "session-revocation-requested",
      ADMIN_ID,
      ADMIN_EMAIL,
      "1",
      { revocationRequestId: SESSION_REVOCATION_ID },
      legacyRecipientKey(
        "session-revocation-requested",
        ADMIN_EMAIL,
        SESSION_REVOCATION_ID,
      ),
      accountEventKey(
        "session-revocation-requested",
        ADMIN_ID,
        SESSION_REVOCATION_ID,
      ),
    ),
  ];
  for (const [template, stage, userId, recipient] of [
    ["inactivity-reminder", "learner-first", LEARNER_ID, LEARNER_EMAIL],
    [
      "inactivity-reminder-followup",
      "learner-second",
      LEARNER_ID,
      LEARNER_EMAIL,
    ],
    ["inactivity-admin-notice", "admin", ADMIN_ID, ADMIN_EMAIL],
  ]) {
    rows.push(account(
      template,
      userId,
      recipient,
      "2",
      {
        inactivityEpisodeId: INACTIVITY_EPISODE_ID,
        inactivityPolicyVersion: "inactivity-2026-07.v2",
        name: template === "inactivity-admin-notice"
          ? "administrator"
          : "Mail 0067 Learner",
        url: template === "inactivity-admin-notice"
          ? "https://codestead.example.invalid/admin"
          : "https://codestead.example.invalid/learn",
      },
      legacyRecipientKey(
        template,
        recipient,
        `${INACTIVITY_EPISODE_ID}:${stage}`,
      ),
      accountEventKey(
        template,
        userId,
        `inactivity-2026-07.v2:${INACTIVITY_EPISODE_ID}:${stage}`,
      ),
    ));
  }
  for (
    const [template, kind, dispatchId, period, , url, epoch]
      of SMART_REMINDERS
  ) {
    rows.push(account(
      template,
      LEARNER_ID,
      LEARNER_EMAIL,
      "1",
      smartReminderVariables({
        template,
        kind,
        dispatchId,
        period,
        url,
        epoch,
      }),
      legacyRecipientKey(
        template,
        LEARNER_EMAIL,
        `smart-reminder:${dispatchId}`,
      ),
      accountEventKey(
        template,
        LEARNER_ID,
        `smart-reminder:${dispatchId}`,
      ),
    ));
  }

  rows.push(account(
    "account-deleted",
    DELETED_ID,
    DELETED_EMAIL,
    "1",
    {
      deletionRunId: DELETION_RUN_ID,
      tombstoneId: DELETION_TOMBSTONE_ID,
      backupRetentionUntil: DELETION_BACKUP_RETENTION_UNTIL,
    },
    digest(`account-deleted:${DELETED_ID}:${DELETION_RUN_ID}`),
    accountEventKey("account-deleted", DELETED_ID, DELETION_RUN_ID),
  ));
  rows.push(
    system(
      "access-request-admin",
      ADMIN_EMAIL,
      "access-request-admin",
      ACCESS_ADMIN_ID,
      `admin:${ADMIN_ID}`,
      systemEventKey(
        "access-request-admin",
        "access-request-admin",
        ACCESS_ADMIN_ID,
        ADMIN_ID,
        ACCESS_ADMIN_ID,
      ),
    ),
    system(
      "invitation",
      "approved-0067@example.invalid",
      "access-request-approved",
      INVITATION_ID,
      `requester:${ACCESS_APPROVED_ID}`,
      systemEventKey(
        "invitation",
        "access-request-approved",
        INVITATION_ID,
        ACCESS_APPROVED_ID,
        INVITATION_ID,
      ),
      { name: "Approved candidate", url: INVITATION_URL },
    ),
    system(
      "access-rejected",
      "rejected-0067@example.invalid",
      "access-request-rejected",
      ACCESS_REJECTED_ID,
      ACCESS_REJECTED_ID,
      systemEventKey(
        "access-rejected",
        "access-request-rejected",
        ACCESS_REJECTED_ID,
        ACCESS_REJECTED_ID,
        ACCESS_REJECTED_ID,
      ),
      { name: "Rejected candidate" },
    ),
  );
  assert.equal(rows.length, 16);
  const sourceMapRows = rows.filter((row) =>
    sourceMapPolicySet.has(row.template)
  );
  const retainedStrategyRows = rows.filter((row) =>
    retainedLegacyStrategyMap.has(row.template)
  );
  assert.equal(sourceMapRows.length, 15);
  assert.equal(retainedStrategyRows.length, 1);
  assert.equal(sourceMapRows.length + retainedStrategyRows.length, rows.length);
  assert.ok(sourceMapRows.every((row) => sourceMapPolicySet.has(row.template)));
  assert.ok(retainedStrategyRows.every((row) =>
    retainedLegacyStrategyMap.has(row.template)
  ));
  return { sourceMapRows, retainedStrategyRows };
}

function nearMissRows() {
  let sequence = 1;
  const row = ({
    caseName,
    userId,
    to,
    template,
    version,
    variables,
    key,
    stableKey,
  }) => {
    const result = {
      caseName,
      id: fixtureUuid("7f", sequence),
      operationId: fixtureUuid("80", sequence),
      userId,
      to,
      template,
      version,
      variables,
      key,
      stableKey,
    };
    sequence += 1;
    return result;
  };
  const resetCase = ({
    caseName,
    sourceId,
    token,
    userId = LEARNER_ID,
    to = LEARNER_EMAIL,
    version = "1",
    key,
  }) => row({
    caseName,
    userId,
    to,
    template: "reset-password",
    version,
    variables: {
      name: "Mail 0067 Learner",
      resetVerificationId: sourceId,
      url: resetUrl(token),
    },
    key: key ?? legacyRecipientKey(
      "reset-password",
      to,
      `reset-password:${sourceId}`,
    ),
    stableKey: accountEventKey(
      "reset-password",
      userId,
      `reset-password:${sourceId}`,
    ),
  });
  const near = [
    resetCase({
      caseName: "reset-wrong-purpose",
      sourceId: RESET_WRONG_PURPOSE_ID,
      token: RESET_WRONG_PURPOSE_TOKEN,
    }),
    resetCase({
      caseName: "reset-token-mismatch",
      sourceId: RESET_MISMATCH_ID,
      token: RESET_MISMATCH_URL_TOKEN,
    }),
    resetCase({
      caseName: "reset-wrong-recipient",
      sourceId: RESET_WRONG_RECIPIENT_ID,
      token: RESET_WRONG_RECIPIENT_TOKEN,
      to: NEAR_DELETED_USERS[0][1],
    }),
    resetCase({
      caseName: "reset-source-user-mismatch",
      sourceId: RESET_SOURCE_VALUE_ID,
      token: RESET_SOURCE_VALUE_TOKEN,
    }),
    resetCase({
      caseName: "reset-wrong-version",
      sourceId: RESET_WRONG_VERSION_ID,
      token: RESET_WRONG_VERSION_TOKEN,
      version: "2",
    }),
    resetCase({
      caseName: "reset-wrong-legacy-key",
      sourceId: RESET_WRONG_KEY_ID,
      token: RESET_WRONG_KEY_TOKEN,
      key: digest("reset-wrong-reviewed-legacy-key-0067"),
    }),
    row({
      caseName: "inactivity-cross-user",
      userId: NEAR_DELETED_USERS[0][0],
      to: NEAR_DELETED_USERS[0][1],
      template: "inactivity-reminder",
      version: "2",
      variables: {
        inactivityEpisodeId: NEAR_INACTIVITY_EPISODES[0],
        inactivityPolicyVersion: "inactivity-2026-07.v2",
        name: "Near Deleted 1",
        url: "https://codestead.example.invalid/learn",
      },
      key: legacyRecipientKey(
        "inactivity-reminder",
        NEAR_DELETED_USERS[0][1],
        `${NEAR_INACTIVITY_EPISODES[0]}:learner-first`,
      ),
      stableKey: accountEventKey(
        "inactivity-reminder",
        NEAR_DELETED_USERS[0][0],
        `inactivity-2026-07.v2:${NEAR_INACTIVITY_EPISODES[0]}:learner-first`,
      ),
    }),
    row({
      caseName: "inactivity-non-admin",
      userId: NEAR_DELETED_USERS[1][0],
      to: NEAR_DELETED_USERS[1][1],
      template: "inactivity-admin-notice",
      version: "2",
      variables: {
        inactivityEpisodeId: NEAR_INACTIVITY_EPISODES[1],
        inactivityPolicyVersion: "inactivity-2026-07.v2",
        name: "administrator",
        url: "https://codestead.example.invalid/admin",
      },
      key: legacyRecipientKey(
        "inactivity-admin-notice",
        NEAR_DELETED_USERS[1][1],
        `${NEAR_INACTIVITY_EPISODES[1]}:admin`,
      ),
      stableKey: accountEventKey(
        "inactivity-admin-notice",
        NEAR_DELETED_USERS[1][0],
        `inactivity-2026-07.v2:${NEAR_INACTIVITY_EPISODES[1]}:admin`,
      ),
    }),
    row({
      caseName: "inactivity-missing-marker",
      userId: LEARNER_ID,
      to: LEARNER_EMAIL,
      template: "inactivity-reminder",
      version: "2",
      variables: {
        inactivityEpisodeId: NEAR_INACTIVITY_EPISODES[2],
        inactivityPolicyVersion: "inactivity-2026-07.v2",
        name: "Mail 0067 Learner",
        url: "https://codestead.example.invalid/learn",
      },
      key: legacyRecipientKey(
        "inactivity-reminder",
        LEARNER_EMAIL,
        `${NEAR_INACTIVITY_EPISODES[2]}:learner-first`,
      ),
      stableKey: accountEventKey(
        "inactivity-reminder",
        LEARNER_ID,
        `inactivity-2026-07.v2:${NEAR_INACTIVITY_EPISODES[2]}:learner-first`,
      ),
    }),
    row({
      caseName: "inactivity-bad-order",
      userId: LEARNER_ID,
      to: LEARNER_EMAIL,
      template: "inactivity-reminder-followup",
      version: "2",
      variables: {
        inactivityEpisodeId: NEAR_INACTIVITY_EPISODES[3],
        inactivityPolicyVersion: "inactivity-2026-07.v2",
        name: "Mail 0067 Learner",
        url: "https://codestead.example.invalid/learn",
      },
      key: legacyRecipientKey(
        "inactivity-reminder-followup",
        LEARNER_EMAIL,
        `${NEAR_INACTIVITY_EPISODES[3]}:learner-second`,
      ),
      stableKey: accountEventKey(
        "inactivity-reminder-followup",
        LEARNER_ID,
        `inactivity-2026-07.v2:${NEAR_INACTIVITY_EPISODES[3]}:learner-second`,
      ),
    }),
  ];
  for (const scenario of SMART_NEAR_CASES) {
    const outboxUserId = scenario.outboxUserId ?? LEARNER_ID;
    const recipient = scenario.outboxTo ?? LEARNER_EMAIL;
    near.push(row({
      caseName: scenario.caseName,
      userId: outboxUserId,
      to: recipient,
      template: scenario.template,
      version: scenario.version ?? "1",
      variables: smartNearVariables(scenario),
      key: scenario.wrongLegacyKey
        ? digest(`wrong:${scenario.caseName}`)
        : legacyRecipientKey(
            scenario.template,
            recipient,
            `smart-reminder:${scenario.id}`,
          ),
      stableKey: accountEventKey(
        scenario.template,
        outboxUserId,
        `smart-reminder:${scenario.id}`,
      ),
    }));
  }
  for (const scenario of SYSTEM_NEAR_CASES) {
    const source = systemNearSource(scenario);
    const operationId = fixtureUuid("80", sequence);
    const audienceId = scenario.requestId;
    near.push(row({
      caseName: scenario.caseName,
      userId: null,
      to: source.recipient,
      template: scenario.template,
      version: "1",
      variables: systemNearVariables(scenario, operationId),
      key: scenario.caseName.includes("wrong-legacy-key")
        ? digest(`wrong:${scenario.caseName}`)
        : legacyRecipientKey(
            scenario.template,
            source.recipient,
            scenario.sourceId,
          ),
      stableKey: systemEventKey(
        scenario.template,
        scenario.producer,
        scenario.sourceId,
        audienceId,
        scenario.sourceId,
      ),
    }));
  }
  near.push(row({
    caseName: BACKUP_NEAR_CASE.caseName,
    userId: ADMIN_ID,
    to: ADMIN_EMAIL,
    template: "backup-status",
    version: "2",
    variables: {
      name: "Administrator",
      summary:
        "The nightly encrypted backup completed and passed local verification. No archive is attached to this email.",
    },
    key: `backup-status:v1:${BACKUP_NEAR_CASE.runKey}`,
    stableKey: accountEventKey(
      "backup-status",
      ADMIN_ID,
      `success:${BACKUP_NEAR_CASE.runKey}`,
    ),
    id: BACKUP_NEAR_CASE.id,
    operationId: BACKUP_NEAR_CASE.operationId,
  }));
  for (let index = 0; index < 3; index += 1) {
    const [userId, recipient] = NEAR_DELETED_USERS[index];
    const runId = NEAR_DELETION_RUNS[index];
    const tombstoneId = NEAR_DELETION_TOMBSTONES[index];
    near.push(row({
      caseName: [
        "deletion-target-mismatch",
        "deletion-status-mismatch",
        "deletion-report-mismatch",
      ][index],
      userId,
      to: recipient,
      template: "account-deleted",
      version: "1",
      variables: {
        deletionRunId: runId,
        tombstoneId,
        backupRetentionUntil: DELETION_BACKUP_RETENTION_UNTIL,
      },
      key: digest(`account-deleted:${userId}:${runId}`),
      stableKey: accountEventKey("account-deleted", userId, runId),
    }));
  }
  assert.equal(near.length, 63);
  assert.ok(near.every((candidate) =>
    sourceMapPolicySet.has(candidate.template)
  ));
  return near;
}
function seedSources(port, database) {
  const smartSql = SMART_REMINDERS.map(
    ([, kind, id, period, scheduledAt]) => `(
      '${id}', '${LEARNER_ID}', '${kind}', '${period}', 'UTC',
      ${sqlLiteral(JSON.stringify(smartReminderEvidence(kind)))}::jsonb,
      '${scheduledAt}'::timestamptz, '${scheduledAt}'::timestamptz
    )`,
  ).join(",\n");
  ownerSql(
    port,
    database,
    `
      INSERT INTO public."user" (
        id, name, email, email_verified, role, status, banned,
        must_change_password
      ) VALUES
        (
          '${ADMIN_ID}', 'Mail 0067 Administrator', '${ADMIN_EMAIL}',
          true, 'admin', 'active', false, false
        ),
        (
          '${LEARNER_ID}', 'Mail 0067 Learner', '${LEARNER_EMAIL}',
          true, 'learner', 'active', false, false
        ),
        (
          '${DELETED_ID}', 'Deleted Mail Learner', '${DELETED_EMAIL}',
          true, 'learner', 'deleted', false, false
        );

      INSERT INTO public.verification (
        id, identifier, value, expires_at
      ) VALUES (
        '${RESET_VERIFICATION_ID}', 'reset-password:${RESET_TOKEN}', '${LEARNER_ID}',
        pg_catalog.statement_timestamp() + interval '10 minutes'
      );

      INSERT INTO public.lost_device_proof (
        id, user_id, session_id, proof_hash, expires_at
      ) VALUES (
        '${LOST_DEVICE_ID}', '${LEARNER_ID}', 'mail-0067-session',
        '${"a".repeat(64)}',
        pg_catalog.statement_timestamp() + interval '10 minutes'
      );

      INSERT INTO public.session_revocation_request (
        id, user_id, session_id, reason
      ) VALUES (
        '${SESSION_REVOCATION_ID}', '${LEARNER_ID}', 'mail-0067-session',
        'Remove the inaccessible test session.'
      );

      INSERT INTO public.inactivity_episode (
        id, user_id, last_activity_at, eligible_at, second_eligible_at,
        learner_first_queued_at, admin_notice_queued_at,
        learner_second_queued_at, policy_version
      ) VALUES (
        '${INACTIVITY_EPISODE_ID}', '${LEARNER_ID}',
        pg_catalog.statement_timestamp() - interval '40 days',
        pg_catalog.statement_timestamp() - interval '10 days',
        pg_catalog.statement_timestamp() - interval '1 day',
        pg_catalog.statement_timestamp() - interval '9 days',
        pg_catalog.statement_timestamp() - interval '8 days',
        pg_catalog.statement_timestamp() - interval '12 hours',
        'inactivity-2026-07.v2'
      );

      INSERT INTO public.smart_reminder_dispatch (
        id, user_id, kind, local_period_key, timezone, evidence,
        scheduled_for, dispatched_at
      ) VALUES
        ${smartSql};

      INSERT INTO public.data_lifecycle_run (
        id, operation, policy_version, idempotency_key, target_user_id,
        status, report, completed_at
      ) VALUES (
        '${DELETION_RUN_ID}', 'account_deletion', 'deletion-2026-07.v1',
        'mail-0067-deletion-run', '${DELETED_ID}', 'succeeded',
        ${sqlLiteral(JSON.stringify(DELETION_REPORT))}::jsonb,
        '${DELETION_COMPLETED_AT}'::timestamptz
      );

      INSERT INTO public.account_deletion_tombstone (
        id, user_id, identity_hash, policy_version, requested_by_user_id,
        primary_deletion_completed_at, backup_retention_until, report
      ) VALUES (
        '${DELETION_TOMBSTONE_ID}', '${DELETED_ID}', '${"b".repeat(64)}',
        'deletion-2026-07.v1', '${ADMIN_ID}',
        '${DELETION_COMPLETED_AT}'::timestamptz,
        '${DELETION_BACKUP_RETENTION_UNTIL}'::timestamptz,
        ${sqlLiteral(JSON.stringify(DELETION_REPORT))}::jsonb
      );

      INSERT INTO public.access_request (
        id, email, name, status, decided_by, decision_reason, decided_at
      ) VALUES
        (
          '${ACCESS_ADMIN_ID}', 'admin-source-0067@example.invalid',
          'Admin source', 'pending', NULL, NULL, NULL
        ),
        (
          '${ACCESS_APPROVED_ID}', 'approved-0067@example.invalid',
          'Approved candidate', 'approved', '${ADMIN_ID}',
          'Approved for the 0067 replay proof.',
          pg_catalog.statement_timestamp() - interval '1 hour'
        ),
        (
          '${ACCESS_REJECTED_ID}', 'rejected-0067@example.invalid',
          'Rejected candidate', 'rejected', '${ADMIN_ID}',
          'Rejected for the 0067 replay proof.',
          pg_catalog.statement_timestamp() - interval '1 hour'
        );

      INSERT INTO public.invitation (
        id, access_request_id, email, token_hash, expires_at,
        consumed_at, created_by
      ) VALUES (
        '${INVITATION_ID}', '${ACCESS_APPROVED_ID}',
        'approved-0067@example.invalid', '${digest(INVITATION_TOKEN)}',
        pg_catalog.statement_timestamp() - interval '1 day',
        pg_catalog.statement_timestamp() - interval '12 hours', '${ADMIN_ID}'
      );
    `,
  );
}

function seedHostileSources(port, database, hostileRows) {
  const deletionRows = new Map(
    hostileRows
      .filter((row) => row.template === "account-deleted")
      .map((row) => [row.caseName, row]),
  );
  const targetMismatch = deletionRows.get("deletion-target-mismatch");
  const statusMismatch = deletionRows.get("deletion-status-mismatch");
  const reportMismatch = deletionRows.get("deletion-report-mismatch");
  assert.ok(targetMismatch && statusMismatch && reportMismatch);
  const targetReport = deletionReport({
    runId: NEAR_DELETION_RUNS[0],
    tombstoneId: NEAR_DELETION_TOMBSTONES[0],
    outboxId: targetMismatch.id,
    operationId: targetMismatch.operationId,
  });
  const statusReport = deletionReport({
    runId: NEAR_DELETION_RUNS[1],
    tombstoneId: NEAR_DELETION_TOMBSTONES[1],
    outboxId: statusMismatch.id,
    operationId: statusMismatch.operationId,
  });
  const mismatchedReport = deletionReport({
    runId: NEAR_DELETION_RUNS[2],
    tombstoneId: NEAR_DELETION_TOMBSTONES[2],
    outboxId: fixtureUuid("7f", 99),
    operationId: reportMismatch.operationId,
  });
  const smartNearSql = SMART_NEAR_CASES.map((scenario) => `(
    '${scenario.id}', '${scenario.sourceUserId ?? LEARNER_ID}',
    '${scenario.kind}', '${scenario.period}', '${scenario.timezone ?? "UTC"}',
    ${sqlLiteral(JSON.stringify({
      ...smartReminderEvidence(scenario.kind),
      ...(scenario.evidencePatch ?? {}),
    }))}::jsonb,
    '${scenario.scheduledAt}'::timestamptz,
    '${scenario.dispatchedAt ?? scenario.scheduledAt}'::timestamptz
  )`).join(",\n");
  const systemRequestSql = SYSTEM_NEAR_CASES.map((scenario) => {
    const source = systemNearSource(scenario);
    return `(
      '${scenario.requestId}', ${sqlLiteral(source.requestEmail)},
      ${sqlLiteral(source.name)}, '${source.status}',
      ${source.decidedBy === null ? "NULL" : sqlLiteral(source.decidedBy)},
      ${source.decisionReason === null
        ? "NULL"
        : sqlLiteral(source.decisionReason)},
      ${source.decidedAt === null
        ? "NULL"
        : `${sqlLiteral(source.decidedAt)}::timestamptz`}
    )`;
  }).join(",\n");
  const systemInvitationSql = SYSTEM_NEAR_CASES
    .filter((scenario) => scenario.template === "invitation")
    .map((scenario) => {
      const source = systemNearSource(scenario);
      return `(
        '${scenario.sourceId}', '${scenario.requestId}',
        ${sqlLiteral(source.invitationEmail)}, '${digest(scenario.token)}',
        '2027-07-01T00:00:00.000Z'::timestamptz,
        ${sqlLiteral(source.createdBy)}
      )`;
    }).join(",\n");
  const backupNear = hostileRows.find(
    (row) => row.caseName === BACKUP_NEAR_CASE.caseName,
  );
  assert.ok(backupNear);
  ownerSql(
    port,
    database,
    `
      INSERT INTO public."user" (
        id, name, email, email_verified, role, status, banned,
        must_change_password
      ) VALUES
        (
          '${NEAR_DELETED_USERS[0][0]}', 'Near Deleted 1',
          '${NEAR_DELETED_USERS[0][1]}', true, 'learner', 'deleted', false, false
        ),
        (
          '${NEAR_DELETED_USERS[1][0]}', 'Near Deleted 2',
          '${NEAR_DELETED_USERS[1][1]}', true, 'learner', 'deleted', false, false
        ),
        (
          '${NEAR_DELETED_USERS[2][0]}', 'Near Deleted 3',
          '${NEAR_DELETED_USERS[2][1]}', true, 'learner', 'deleted', false, false
        ),
        (
          '${SMART_SOURCE_MISMATCH_USER_ID}', '${SMART_SOURCE_MISMATCH_NAME}',
          '${SMART_SOURCE_MISMATCH_EMAIL}', true,
          'learner', 'active', false, false
        ),
        (
          '${NON_ASCII_RESET_USER_ID}', 'Mail 0067 Learner',
          '${NON_ASCII_RESET_EMAIL}', true,
          'learner', 'active', false, false
        );

      INSERT INTO public.verification (
        id, identifier, value, expires_at
      ) VALUES
        (
          '${RESET_WRONG_PURPOSE_ID}',
          'verify-email:${RESET_WRONG_PURPOSE_TOKEN}', '${LEARNER_ID}',
          pg_catalog.statement_timestamp() + interval '10 minutes'
        ),
        (
          '${RESET_MISMATCH_ID}',
          'reset-password:${RESET_MISMATCH_SOURCE_TOKEN}', '${LEARNER_ID}',
          pg_catalog.statement_timestamp() + interval '10 minutes'
        ),
        (
          '${RESET_WRONG_RECIPIENT_ID}',
          'reset-password:${RESET_WRONG_RECIPIENT_TOKEN}', '${LEARNER_ID}',
          pg_catalog.statement_timestamp() + interval '10 minutes'
        ),
        (
          '${RESET_SOURCE_VALUE_ID}',
          'reset-password:${RESET_SOURCE_VALUE_TOKEN}', '${ADMIN_ID}',
          pg_catalog.statement_timestamp() + interval '10 minutes'
        ),
        (
          '${RESET_WRONG_VERSION_ID}',
          'reset-password:${RESET_WRONG_VERSION_TOKEN}', '${LEARNER_ID}',
          pg_catalog.statement_timestamp() + interval '10 minutes'
        ),
        (
          '${RESET_WRONG_KEY_ID}',
          'reset-password:${RESET_WRONG_KEY_TOKEN}', '${LEARNER_ID}',
          pg_catalog.statement_timestamp() + interval '10 minutes'
        ),
        (
          '${NON_ASCII_RESET_ID}',
          'reset-password:${NON_ASCII_RESET_TOKEN}',
          '${NON_ASCII_RESET_USER_ID}',
          pg_catalog.statement_timestamp() + interval '10 minutes'
        );

      INSERT INTO public.smart_reminder_dispatch (
        id, user_id, kind, local_period_key, timezone, evidence,
        scheduled_for, dispatched_at
      ) VALUES
        ${smartNearSql};

      INSERT INTO public.access_request (
        id, email, name, status, decided_by, decision_reason, decided_at
      ) VALUES
        ${systemRequestSql};

      INSERT INTO public.invitation (
        id, access_request_id, email, token_hash, expires_at, created_by
      ) VALUES
        ${systemInvitationSql};

      INSERT INTO public.backup_status_mail_authority (
        id, run_key, outcome, outbox_id, operation_id, authority_epoch
      )
      SELECT
        '${BACKUP_NEAR_CASE.authorityId}', '${BACKUP_NEAR_CASE.runKey}',
        'success', '${backupNear.id}', '${backupNear.operationId}',
        guard.authority_epoch
      FROM public.backup_status_mail_admin_guard AS guard
      WHERE guard.singleton IS TRUE;

      INSERT INTO public.inactivity_episode (
        id, user_id, last_activity_at, eligible_at, second_eligible_at,
        learner_first_queued_at, admin_notice_queued_at,
        learner_second_queued_at, policy_version, closed_at
      ) VALUES
        (
          '${NEAR_INACTIVITY_EPISODES[0]}', '${LEARNER_ID}',
          pg_catalog.statement_timestamp() - interval '40 days',
          pg_catalog.statement_timestamp() - interval '10 days',
          pg_catalog.statement_timestamp() - interval '5 days',
          pg_catalog.statement_timestamp() - interval '9 days', NULL, NULL,
          'inactivity-2026-07.v2', pg_catalog.statement_timestamp()
        ),
        (
          '${NEAR_INACTIVITY_EPISODES[1]}', '${LEARNER_ID}',
          pg_catalog.statement_timestamp() - interval '40 days',
          pg_catalog.statement_timestamp() - interval '10 days',
          pg_catalog.statement_timestamp() - interval '5 days',
          pg_catalog.statement_timestamp() - interval '9 days',
          pg_catalog.statement_timestamp() - interval '8 days', NULL,
          'inactivity-2026-07.v2', pg_catalog.statement_timestamp()
        ),
        (
          '${NEAR_INACTIVITY_EPISODES[2]}', '${LEARNER_ID}',
          pg_catalog.statement_timestamp() - interval '40 days',
          pg_catalog.statement_timestamp() - interval '10 days',
          pg_catalog.statement_timestamp() - interval '5 days',
          NULL, NULL, NULL,
          'inactivity-2026-07.v2', pg_catalog.statement_timestamp()
        ),
        (
          '${NEAR_INACTIVITY_EPISODES[3]}', '${LEARNER_ID}',
          pg_catalog.statement_timestamp() - interval '40 days',
          pg_catalog.statement_timestamp() - interval '10 days',
          pg_catalog.statement_timestamp() - interval '8 days',
          pg_catalog.statement_timestamp() - interval '2 days', NULL,
          pg_catalog.statement_timestamp() - interval '4 days',
          'inactivity-2026-07.v2', pg_catalog.statement_timestamp()
        );

      INSERT INTO public.data_lifecycle_run (
        id, operation, policy_version, idempotency_key, target_user_id,
        status, report, completed_at
      ) VALUES
        (
          '${NEAR_DELETION_RUNS[0]}', 'account_deletion',
          'deletion-2026-07.v1', 'near-deletion-target-mismatch-0067',
          '${ADMIN_ID}', 'succeeded',
          ${sqlLiteral(JSON.stringify(targetReport))}::jsonb,
          '${DELETION_COMPLETED_AT}'::timestamptz
        ),
        (
          '${NEAR_DELETION_RUNS[1]}', 'account_deletion',
          'deletion-2026-07.v1', 'near-deletion-status-mismatch-0067',
          '${NEAR_DELETED_USERS[1][0]}', 'running',
          ${sqlLiteral(JSON.stringify(statusReport))}::jsonb, NULL
        ),
        (
          '${NEAR_DELETION_RUNS[2]}', 'account_deletion',
          'deletion-2026-07.v1', 'near-deletion-report-mismatch-0067',
          '${NEAR_DELETED_USERS[2][0]}', 'succeeded',
          ${sqlLiteral(JSON.stringify(mismatchedReport))}::jsonb,
          '${DELETION_COMPLETED_AT}'::timestamptz
        );

      INSERT INTO public.account_deletion_tombstone (
        id, user_id, identity_hash, policy_version, requested_by_user_id,
        primary_deletion_completed_at, backup_retention_until, report
      ) VALUES
        (
          '${NEAR_DELETION_TOMBSTONES[0]}', '${NEAR_DELETED_USERS[0][0]}',
          '${"1".repeat(64)}', 'deletion-2026-07.v1', '${ADMIN_ID}',
          '${DELETION_COMPLETED_AT}'::timestamptz,
          '${DELETION_BACKUP_RETENTION_UNTIL}'::timestamptz,
          ${sqlLiteral(JSON.stringify(targetReport))}::jsonb
        ),
        (
          '${NEAR_DELETION_TOMBSTONES[1]}', '${NEAR_DELETED_USERS[1][0]}',
          '${"2".repeat(64)}', 'deletion-2026-07.v1', '${ADMIN_ID}',
          '${DELETION_COMPLETED_AT}'::timestamptz,
          '${DELETION_BACKUP_RETENTION_UNTIL}'::timestamptz,
          ${sqlLiteral(JSON.stringify(statusReport))}::jsonb
        ),
        (
          '${NEAR_DELETION_TOMBSTONES[2]}', '${NEAR_DELETED_USERS[2][0]}',
          '${"3".repeat(64)}', 'deletion-2026-07.v1', '${ADMIN_ID}',
          '${DELETION_COMPLETED_AT}'::timestamptz,
          '${DELETION_BACKUP_RETENTION_UNTIL}'::timestamptz,
          ${sqlLiteral(JSON.stringify(mismatchedReport))}::jsonb
        );
    `,
  );
}
function provePre0067SystemInvalidStatesRejected(port, database) {
  const baseOperationId = fixtureUuid("86", 1);
  const base = {
    id: fixtureUuid("86", 2),
    operationId: baseOperationId,
    userId: null,
    to: "pre0067-invalid@example.invalid",
    template: "invitation",
    version: "1",
    variables: systemVariables(
      baseOperationId,
      "pre0067-invalid@example.invalid",
      "access-request-approved",
      INVITATION_ID,
      `requester:${ACCESS_APPROVED_ID}`,
      { name: "Invalid state", url: INVITATION_URL },
    ),
    key: digest("pre0067-invalid-system-state"),
  };
  for (const [label, row] of [
    ["wrong-version", { ...base, id: fixtureUuid("86", 3), version: "2" }],
    [
      "operation-mismatch",
      {
        ...base,
        id: fixtureUuid("86", 4),
        variables: {
          ...base.variables,
          _mailOperationId: fixtureUuid("86", 5),
        },
        key: digest("pre0067-invalid-system-operation"),
      },
    ],
    [
      "recipient-mismatch",
      {
        ...base,
        id: fixtureUuid("86", 6),
        variables: {
          ...base.variables,
          _mailRecipient: "different-pre0067@example.invalid",
        },
        key: digest("pre0067-invalid-system-recipient"),
      },
    ],
  ]) {
    expectSqlFailure(
      port,
      database,
      "learncoding_migrator",
      `SET ROLE learncoding_owner;\n${insertOutboxSql(row)};`,
      /email_outbox_delivery_scope_valid/u,
    );
    assert.match(label, /^(?:wrong-version|operation-mismatch|recipient-mismatch)$/u);
  }
}
function seedLegacyOutbox(port, database) {
  const { sourceMapRows, retainedStrategyRows } = aliasRows();
  const missingSourceMapRows = SOURCE_MAP_POLICY
    .filter((template) =>
      template !== "backup-status"
      && !sourceMapRows.some((row) => row.template === template)
    )
    .map((template, index) => ({
    id: fixtureUuid("75", index + 1),
    operationId: fixtureUuid("76", index + 1),
    userId: LEARNER_ID,
    to: LEARNER_EMAIL,
    template,
    version: "1",
    variables: { fixture: `blocked-source-map-${template}` },
    key: legacyRecipientKey(
      template,
      LEARNER_EMAIL,
      `blocked-source-map-${template}`,
    ),
    stableKey: accountEventKey(
      template,
      LEARNER_ID,
      `blocked-source-map-${template}`,
    ),
  }));
  assert.equal(missingSourceMapRows.length, 7);
  const retainedTemplateRows = [...retainedLegacyStrategyMap.keys()]
    .filter((template) =>
      !retainedStrategyRows.some((row) => row.template === template)
    )
    .map((template, index) => ({
      id: fixtureUuid("75", index + 101),
      operationId: fixtureUuid("76", index + 201),
      userId: LEARNER_ID,
      to: LEARNER_EMAIL,
      template,
      version: "1",
      variables: { fixture: `retained-strategy-${template}` },
      key: legacyRecipientKey(
        template,
        LEARNER_EMAIL,
        `retained-strategy-${template}`,
      ),
    }));
  assert.equal(retainedTemplateRows.length, 6);
  const retained = [...retainedTemplateRows, ...retainedStrategyRows];
  const sourceMapNearMisses = nearMissRows();
  const blockedPolicyRows = [...sourceMapRows, ...missingSourceMapRows];
  const blockedRows = [
    ...blockedPolicyRows,
    ...sourceMapNearMisses,
  ];
  assert.equal(new Set(blockedRows.map((row) => row.template)).size, 21);
  const additionalSourceMapNearMissCaseNames = new Set([
    "inactivity-non-admin",
    "deletion-target-mismatch",
    "deletion-status-mismatch",
    "deletion-report-mismatch",
  ]);
  const primarySourceMapNearMisses = sourceMapNearMisses.filter((row) =>
    !additionalSourceMapNearMissCaseNames.has(row.caseName)
  );
  const additionalSourceMapNearMisses = sourceMapNearMisses.filter((row) =>
    additionalSourceMapNearMissCaseNames.has(row.caseName)
  );
  assert.equal(primarySourceMapNearMisses.length, 59);
  assert.equal(additionalSourceMapNearMisses.length, 4);
  seedHostileSources(port, database, sourceMapNearMisses);
  provePre0067SystemInvalidStatesRejected(port, database);
  ownerSql(
    port,
    database,
    [...blockedRows, ...retained]
      .map((row) => `${insertOutboxSql(row)};`)
      .join("\n"),
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT acknowledgement
         FROM public.enqueue_backup_status_mail_authority(
           '${BACKUP_RUN_KEY}', 'success'
         );`,
      "learncoding_backup_reporter",
    ),
    "queued",
  );
  const legacyRowCount = blockedRows.length + retained.length + 1;
  assert.equal(
    scalar(port, database, "SELECT count(*)::text FROM public.email_outbox;"),
    String(legacyRowCount),
  );
  return {
    blockedPolicyRows,
    blockedRows,
    retained,
    primarySourceMapNearMisses,
    additionalSourceMapNearMisses,
    sourceMapNearMisses,
    legacyRowCount,
  };
}
function poison0067DefaultAcls(port, database) {
  psql(
    port,
    database,
    `GRANT mail_acl_grantor TO learncoding_owner
       WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;`,
  );
  ownerSql(
    port,
    database,
    `
      GRANT USAGE ON SCHEMA public TO mail_acl_grantor;
      ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner IN SCHEMA public
        GRANT EXECUTE ON FUNCTIONS TO mail_default_grantee;
      ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner IN SCHEMA public
        GRANT EXECUTE ON FUNCTIONS TO mail_acl_grantor WITH GRANT OPTION;
      ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner IN SCHEMA public
        GRANT ALL PRIVILEGES ON TABLES TO mail_default_grantee;
      ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner IN SCHEMA public
        GRANT ALL PRIVILEGES ON TABLES TO mail_acl_grantor
        WITH GRANT OPTION;
    `,
  );
}

function migration0067WithHostileAcls() {
  const marker = "DO $codestead_idempotency_acl_scrub$";
  assert.equal(migration0067.split(marker).length, 2);
  const functionIdentities = [
    "public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)",
    "public.email_outbox_event_sha256(text,text,text)",
    "public.enforce_email_outbox_delivery_hold()",
    "public.claim_email_outbox_idempotency_authority()",
    "public.persist_email_outbox_idempotency_authority()",
    "public.enforce_email_outbox_idempotency_metadata_immutable()",
    "public.enforce_email_outbox_idempotency_append_only()",
    "public.email_outbox_idempotency_coverage_authority(uuid[])",
  ];
  const hostileDelegation = `
    GRANT INSERT (
      idempotency_authority_version,
      idempotency_authority_sha256,
      idempotency_original_payload_sha256,
      delivery_hold_version
    ) ON TABLE public.email_outbox
      TO mail_acl_grantor WITH GRANT OPTION;
    SET ROLE mail_acl_grantor;
    ${functionIdentities.map(
      (identity) => `GRANT EXECUTE ON FUNCTION ${identity} TO mail_acl_leaf;`,
    ).join("\n")}
    GRANT ALL PRIVILEGES
      ON TABLE public.email_outbox_idempotency_authority
      TO mail_acl_leaf;
    GRANT SELECT (idempotency_sha256),
          UPDATE (original_payload_sha256)
      ON TABLE public.email_outbox_idempotency_authority
      TO mail_acl_leaf;
    GRANT INSERT (
      idempotency_authority_version,
      idempotency_authority_sha256,
      idempotency_original_payload_sha256,
      delivery_hold_version
    ) ON TABLE public.email_outbox TO mail_acl_leaf;
    RESET ROLE;
    SET ROLE learncoding_owner;
  `;
  return migration0067.replace(
    marker,
    `${hostileDelegation}\n${marker}`,
  );
}

function migration0067WithControllerGate(gateKey) {
  const candidate = migration0067WithHostileAcls();
  const statements = splitPostgresStatements(candidate);
  const canonical = statements.map(
    ({ sql: statement }) => canonicalizePostgresStatement(statement),
  );
  assert.deepEqual(canonical.slice(0, 2), CUTOVER_LOCK_STATEMENTS);
  assert.deepEqual(
    canonical.filter((statement) => statement.startsWith("lock table ")),
    CUTOVER_LOCK_STATEMENTS,
  );
  const gateOffset = statements[1].end;
  return `${candidate.slice(0, gateOffset)}
SELECT pg_catalog.pg_advisory_xact_lock(${gateKey}::pg_catalog.int8);
${candidate.slice(gateOffset)}`;
}

function migration0067WithOutboxGate(gateKey) {
  assert.ok(Number.isSafeInteger(gateKey) && gateKey > 0);
  const candidate = migration0067WithHostileAcls();
  const statements = splitPostgresStatements(candidate);
  const canonical = statements.map(
    ({ sql: statement }) => canonicalizePostgresStatement(statement),
  );
  assert.deepEqual(canonical.slice(0, 2), CUTOVER_LOCK_STATEMENTS);
  assert.deepEqual(
    canonical.filter((statement) => statement.startsWith("lock table ")),
    CUTOVER_LOCK_STATEMENTS,
  );
  const gateOffset = statements[0].end;
  return `${candidate.slice(0, gateOffset)}
SELECT pg_catalog.pg_advisory_xact_lock(${gateKey}::pg_catalog.int8);
${candidate.slice(gateOffset)}`;
}
function apply0067WithHostileAcls(port, database) {
  psql(
    port,
    database,
    `SET ROLE learncoding_owner;\n${migration0067WithHostileAcls()}`,
    {
      username: "learncoding_migrator",
      singleTransaction: true,
      timeoutMs: 55_000,
    },
  );
}

function proveHostileTemporaryTypeSearchPath(port, templateDatabase) {
  const database = "mail0067_hostile_temp_types";
  const reviewedRoutines = Object.freeze([
    "public.enqueue_backup_status_mail_authority(pg_catalog.text,pg_catalog.text)",
    "public.email_outbox_original_payload_sha256(pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.text,pg_catalog.jsonb)",
    "public.email_outbox_event_sha256(pg_catalog.text,pg_catalog.text,pg_catalog.text)",
    "public.enforce_email_outbox_delivery_hold()",
    "public.claim_email_outbox_idempotency_authority()",
    "public.persist_email_outbox_idempotency_authority()",
    "public.enforce_email_outbox_idempotency_metadata_immutable()",
    "public.enforce_email_outbox_idempotency_append_only()",
    "public.email_outbox_idempotency_coverage_authority(pg_catalog.uuid[])",
  ]);
  const reviewedValues = reviewedRoutines
    .map((identity) => `(${sqlLiteral(identity)})`)
    .join(",\n");
  let operationError;
  const cleanupFailures = [];
  let databaseCreated = false;
  try {
    createOwnedDatabase(port, database, templateDatabase);
    databaseCreated = true;
    psql(
      port,
      database,
      `SET ROLE learncoding_owner;
       CREATE TEMP TABLE mail_0067_temp_namespace_seed (
         value pg_catalog.int4
       ) ON COMMIT DROP;
       CREATE DOMAIN pg_temp."text" AS pg_catalog.int4;
       CREATE DOMAIN pg_temp."uuid" AS pg_catalog.int4;
       CREATE DOMAIN pg_temp."jsonb" AS pg_catalog.int4;
       CREATE DOMAIN pg_temp."boolean" AS pg_catalog.int4;
       CREATE DOMAIN pg_temp."integer" AS pg_catalog.text;
       CREATE DOMAIN pg_temp."oid" AS pg_catalog.text;
       CREATE DOMAIN pg_temp."interval" AS pg_catalog.text;
       CREATE DOMAIN pg_temp."bool" AS pg_catalog.int4;
       CREATE DOMAIN pg_temp."int2" AS pg_catalog.text;
       CREATE DOMAIN pg_temp."int4" AS pg_catalog.text;
       CREATE DOMAIN pg_temp."int8" AS pg_catalog.text;
       CREATE DOMAIN pg_temp."regclass" AS pg_catalog.int4;
       CREATE DOMAIN pg_temp."regtype" AS pg_catalog.int4;
       CREATE TYPE pg_temp."record" AS (value pg_catalog.int4);
       CREATE TYPE pg_temp."trigger" AS (value pg_catalog.int4);
       SET LOCAL search_path = pg_temp, public, pg_catalog;
       ${migration0067}
       DO $mail_0067_hostile_temp_type_proof$
       DECLARE
         reviewed_count pg_catalog.int4;
       BEGIN
         WITH reviewed(identity) AS (
           VALUES ${reviewedValues}
         ), resolved AS (
           SELECT routine.*
             FROM reviewed
             JOIN pg_catalog.pg_proc AS routine
               ON routine.oid = pg_catalog.to_regprocedure(reviewed.identity)
         )
         SELECT pg_catalog.count(*)::pg_catalog.int4
           INTO reviewed_count
           FROM resolved;
         IF reviewed_count <> ${reviewedRoutines.length} THEN
           RAISE EXCEPTION
             '0067 hostile temporary type proof did not resolve every routine'
             USING ERRCODE = '23514';
         END IF;

         IF EXISTS (
           WITH reviewed(identity) AS (
             VALUES ${reviewedValues}
           ), resolved AS (
             SELECT routine.*
               FROM reviewed
               JOIN pg_catalog.pg_proc AS routine
                 ON routine.oid = pg_catalog.to_regprocedure(reviewed.identity)
           ), routine_type(type_oid) AS (
             SELECT routine.prorettype
               FROM resolved AS routine
             UNION ALL
             SELECT argument.type_oid
               FROM resolved AS routine
               CROSS JOIN LATERAL pg_catalog.unnest(
                 COALESCE(
                   routine.proallargtypes,
                   routine.proargtypes::pg_catalog.oid[]
                 )
               ) AS argument(type_oid)
           )
           SELECT 1
             FROM routine_type
             JOIN pg_catalog.pg_type AS type_row
               ON type_row.oid = routine_type.type_oid
            WHERE type_row.typnamespace = pg_catalog.pg_my_temp_schema()
         ) THEN
           RAISE EXCEPTION
             '0067 persistent routine depends on a hostile temporary type'
             USING ERRCODE = '23514';
         END IF;

         IF EXISTS (
           WITH reviewed(identity) AS (
             VALUES ${reviewedValues}
           ), resolved AS (
             SELECT routine.*
               FROM reviewed
               JOIN pg_catalog.pg_proc AS routine
                 ON routine.oid = pg_catalog.to_regprocedure(reviewed.identity)
           )
           SELECT 1
             FROM resolved AS routine
             JOIN pg_catalog.pg_depend AS dependency
               ON dependency.classid =
                    'pg_catalog.pg_proc'::pg_catalog.regclass
              AND dependency.objid = routine.oid
             LEFT JOIN pg_catalog.pg_type AS referenced_type
               ON dependency.refclassid =
                    'pg_catalog.pg_type'::pg_catalog.regclass
              AND referenced_type.oid = dependency.refobjid
             LEFT JOIN pg_catalog.pg_proc AS referenced_routine
               ON dependency.refclassid =
                    'pg_catalog.pg_proc'::pg_catalog.regclass
              AND referenced_routine.oid = dependency.refobjid
             LEFT JOIN pg_catalog.pg_class AS referenced_relation
               ON dependency.refclassid =
                    'pg_catalog.pg_class'::pg_catalog.regclass
              AND referenced_relation.oid = dependency.refobjid
             LEFT JOIN pg_catalog.pg_namespace AS referenced_namespace
               ON dependency.refclassid =
                    'pg_catalog.pg_namespace'::pg_catalog.regclass
              AND referenced_namespace.oid = dependency.refobjid
            WHERE pg_catalog.pg_my_temp_schema() IN (
                    referenced_type.typnamespace,
                    referenced_routine.pronamespace,
                    referenced_relation.relnamespace,
                    referenced_namespace.oid
                  )
         ) THEN
           RAISE EXCEPTION
             '0067 persistent routine has a hostile temporary dependency'
             USING ERRCODE = '23514';
         END IF;

         IF EXISTS (
           SELECT 1
             FROM pg_catalog.pg_attribute AS attribute
             JOIN pg_catalog.pg_type AS type_row
               ON type_row.oid = attribute.atttypid
            WHERE attribute.attrelid IN (
                    'public.email_outbox'::pg_catalog.regclass,
                    'public.email_outbox_idempotency_authority'::pg_catalog.regclass
                  )
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND type_row.typnamespace = pg_catalog.pg_my_temp_schema()
         ) THEN
           RAISE EXCEPTION
             '0067 persistent relation depends on a hostile temporary type'
             USING ERRCODE = '23514';
         END IF;

         IF EXISTS (
           WITH reviewed(identity) AS (
             VALUES ${reviewedValues}
           )
           SELECT 1
             FROM reviewed
             JOIN pg_catalog.pg_proc AS routine
               ON routine.oid = pg_catalog.to_regprocedure(reviewed.identity)
            WHERE routine.proconfig IS DISTINCT FROM
                    ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]
         ) THEN
           RAISE EXCEPTION
             '0067 routine search path changed under hostile temporary types'
             USING ERRCODE = '23514';
         END IF;
       END
       $mail_0067_hostile_temp_type_proof$;`,
      {
        username: "learncoding_migrator",
        singleTransaction: true,
        timeoutMs: OPERATION_TIMEOUT_MS,
      },
    );
    assert.equal(
      scalar(
        port,
        database,
        `WITH reviewed(identity) AS (
           VALUES ${reviewedValues}
         )
         SELECT pg_catalog.count(*)::pg_catalog.text
           FROM reviewed
           JOIN pg_catalog.pg_proc AS routine
             ON routine.oid = pg_catalog.to_regprocedure(reviewed.identity)
          WHERE routine.prosecdef
            AND routine.proconfig =
                  ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[];`,
      ),
      String(reviewedRoutines.length),
    );
    process.stdout.write(
      "mail_durable_replay_0067=hostile_temp_type_search_path:9:pass\n",
    );
  } catch (error) {
    operationError = error;
  } finally {
    if (databaseCreated) {
      try {
        dropDisposableDatabase(port, database);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  }
  if (operationError !== undefined || cleanupFailures.length > 0) {
    throw preserveOperationAndCleanupFailures(
      operationError,
      cleanupFailures,
      "hostile temporary type proof and database cleanup failed",
    );
  }
}

async function proveUnknownTemplateCutoverRollback(
  port,
  database,
  legacyRowCount,
  temporaryRoot,
  runProductionMigration,
) {
  const rollbackDatabase = "mail0067_unknown_template_rollback";
  const candidateMigrations = stagedMigrationsThrough(temporaryRoot, 67);
  const candidateVerifier = candidateMigrationVerifier();
  const migrateCandidate = () => runProductionMigration({
    connectionString:
      `postgresql://learncoding_migrator@127.0.0.1:${port}/${rollbackDatabase}`,
    migrationsFolder: candidateMigrations,
    operationTimeoutMs: OPERATION_TIMEOUT_MS,
    verifyReviewedMigrationRepository:
      candidateVerifier.verifyReviewedMigrationRepository,
    verifyAppliedMigrationLedger:
      candidateVerifier.verifyAppliedMigrationLedgerPrefix,
  });
  const ledgerBytes = () => scalar(
    port,
    rollbackDatabase,
    `SELECT pg_catalog.encode(
       pg_catalog.convert_to(
         COALESCE(
           pg_catalog.string_agg(
             pg_catalog.concat_ws(
               pg_catalog.chr(31),
               migration.id::pg_catalog.text,
               migration.hash::pg_catalog.text,
               migration.created_at::pg_catalog.text
             ),
             pg_catalog.chr(30)
             ORDER BY migration.id
           ),
           ''
         ),
         'UTF8'
       ),
       'hex'
     )
     FROM drizzle.__drizzle_migrations AS migration;`,
  );
  const ledgerTail = () => scalar(
    port,
    rollbackDatabase,
    `SELECT pg_catalog.concat_ws(
       pg_catalog.chr(31),
       migration.id::pg_catalog.text,
       migration.hash::pg_catalog.text,
       migration.created_at::pg_catalog.text
     )
     FROM drizzle.__drizzle_migrations AS migration
     ORDER BY migration.id DESC
     LIMIT 1;`,
  );
  const nonAscii = {
    caseName: "reset-unsupported-non-ascii-email",
    id: fixtureUuid("88", 2),
    operationId: fixtureUuid("89", 2),
    userId: NON_ASCII_RESET_USER_ID,
    to: NON_ASCII_RESET_EMAIL,
    template: "reset-password",
    version: "1",
    variables: {
      name: "Mail 0067 Learner",
      resetVerificationId: NON_ASCII_RESET_ID,
      url: resetUrl(NON_ASCII_RESET_TOKEN),
    },
    key: legacyRecipientKey(
      "reset-password",
      NON_ASCII_RESET_EMAIL,
      `reset-password:${NON_ASCII_RESET_ID}`,
    ),
  };
  const unknown = {
    caseName: "unknown-template",
    id: fixtureUuid("88", 1),
    operationId: fixtureUuid("89", 1),
    userId: LEARNER_ID,
    to: LEARNER_EMAIL,
    template: "unknown-mail-template-0067",
    version: "1",
    variables: { fixture: "unknown-template-cutover-rollback" },
    key: digest("unknown-template-cutover-rollback-0067"),
  };

  let operationError;
  const cleanupFailures = [];
  createOwnedDatabase(port, rollbackDatabase, database);
  const proveRejectedCutover = async (row, expectedMessage) => {
    ownerSql(port, rollbackDatabase, `${insertOutboxSql(row)};`);
    assert.equal(
      scalar(
        port,
        rollbackDatabase,
        "SELECT pg_catalog.count(*)::pg_catalog.text FROM public.email_outbox;",
      ),
      String(legacyRowCount + 1),
    );
    const ledgerBytesBefore = ledgerBytes();
    const ledgerTailBefore = ledgerTail();
    const hostileRowBefore = scalar(
      port,
      rollbackDatabase,
      `SELECT pg_catalog.row_to_json(hostile)::pg_catalog.text
         FROM (
           SELECT *
             FROM public.email_outbox
            WHERE id = '${row.id}'::pg_catalog.uuid
         ) AS hostile;`,
    );

    let migrationError;
    try {
      await migrateCandidate();
      assert.fail(`${row.caseName} candidate migration unexpectedly passed`);
    } catch (error) {
      migrationError = error;
    }
    assert.ok(migrationError instanceof Error);
    const postgresError = migrationError.cause;
    assert.equal(postgresError?.code, "23514");
    assert.equal(
      postgresError?.message,
      expectedMessage,
    );
    assert.equal(ledgerBytes(), ledgerBytesBefore);
    assert.equal(ledgerTail(), ledgerTailBefore);
    assert.equal(
      scalar(
        port,
        rollbackDatabase,
        `SELECT pg_catalog.row_to_json(hostile)::pg_catalog.text
           FROM (
             SELECT *
               FROM public.email_outbox
              WHERE id = '${row.id}'::pg_catalog.uuid
           ) AS hostile;`,
      ),
      hostileRowBefore,
      "failed framework migration must leave the hostile row byte-stable",
    );
    assert.equal(
      scalar(
        port,
        rollbackDatabase,
        `SELECT (
           pg_catalog.to_regclass(
             'public.email_outbox_idempotency_authority'
           ) IS NULL
           AND pg_catalog.to_regclass(
             'public.email_outbox_idempotency_authority_lookup_idx'
           ) IS NULL
           AND NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = 'public.email_outbox'::pg_catalog.regclass
                AND attribute.attname IN (
                  'idempotency_authority_version',
                  'idempotency_authority_sha256',
                  'idempotency_original_payload_sha256'
                )
                AND NOT attribute.attisdropped
           )
           AND NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_constraint AS reviewed_constraint
              WHERE reviewed_constraint.conrelid =
                'public.email_outbox'::pg_catalog.regclass
                AND reviewed_constraint.conname IN (
                  'email_outbox_idempotency_authority_valid',
                  'email_outbox_idempotency_authority_fk'
                )
           )
           AND NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_trigger AS reviewed_trigger
              WHERE reviewed_trigger.tgname IN (
                'email_outbox_idempotency_claim',
                '00_email_outbox_idempotency_persist',
                'email_outbox_idempotency_metadata_immutable',
                'email_outbox_idempotency_append_only',
                'email_outbox_idempotency_no_truncate'
              )
                AND NOT reviewed_trigger.tgisinternal
           )
           AND pg_catalog.to_regprocedure(
             'public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)'
           ) IS NULL
           AND pg_catalog.to_regprocedure(
             'public.email_outbox_event_sha256(text,text,text)'
           ) IS NULL
           AND pg_catalog.to_regprocedure(
             'public.claim_email_outbox_idempotency_authority()'
           ) IS NULL
           AND pg_catalog.to_regprocedure(
             'public.persist_email_outbox_idempotency_authority()'
           ) IS NULL
           AND pg_catalog.to_regprocedure(
             'public.enforce_email_outbox_idempotency_metadata_immutable()'
           ) IS NULL
           AND pg_catalog.to_regprocedure(
             'public.enforce_email_outbox_idempotency_append_only()'
           ) IS NULL
           AND pg_catalog.to_regprocedure(
             'public.email_outbox_idempotency_coverage_authority(uuid[])'
           ) IS NULL
         )::pg_catalog.text;`,
      ),
      "true",
      "23514 must roll back the ledger and every persistent 0067 object",
    );

    ownerSql(
      port,
      rollbackDatabase,
      `DELETE FROM public.email_outbox
        WHERE id = '${row.id}'::pg_catalog.uuid;`,
    );
    assert.equal(
      scalar(
        port,
        rollbackDatabase,
        "SELECT pg_catalog.count(*)::pg_catalog.text FROM public.email_outbox;",
      ),
      String(legacyRowCount),
    );
  };

  try {
    await proveRejectedCutover(nonAscii,
      "email outbox recipient must be canonical ASCII at idempotency authority cutover",
    );
    await proveRejectedCutover(unknown,
      "unknown email outbox template at idempotency authority cutover",
    );
    await migrateCandidate();
    assert.equal(
      scalar(
        port,
        rollbackDatabase,
        `SELECT (
           (SELECT pg_catalog.count(*)
              FROM drizzle.__drizzle_migrations) = 68
           AND pg_catalog.to_regclass(
             'public.email_outbox_idempotency_authority'
           ) IS NOT NULL
           AND pg_catalog.to_regprocedure(
             'public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)'
           ) IS NOT NULL
           AND pg_catalog.to_regprocedure(
             'public.email_outbox_event_sha256(text,text,text)'
           ) IS NOT NULL
         )::pg_catalog.text;`,
      ),
      "true",
      "repaired clone must accept one clean framework migration retry",
    );
    process.stdout.write(
      "mail_durable_replay_0067=unknown_template_framework_rollback:pass\n",
    );
  } catch (error) {
    operationError = error;
  } finally {
    await runCleanupStep(
      cleanupFailures,
      () => dropDisposableDatabase(port, rollbackDatabase),
      "unknown-template rollback database drop",
    );
  }
  if (operationError !== undefined || cleanupFailures.length > 0) {
    throw preserveOperationAndCleanupFailures(
      operationError,
      cleanupFailures,
      "unknown-template operation and drop failed",
    );
  }
}
async function releaseControllerGate(client, gateKey) {
  const released = await client.query(
    `SELECT pg_catalog.pg_advisory_unlock(
       ${gateKey}::pg_catalog.int8
     ) AS unlocked;`,
  );
  assert.equal(released.rows[0]?.unlocked, true);
}

async function proveGrantedCutoverLocks(
  port,
  database,
  applicationName,
) {
  const targets = ["public.email_outbox", ...CUTOVER_PROOF_SOURCES];
  const result = await queryDatabase(
    port,
    database,
    "postgres",
    `WITH target(relation_name) AS (
       VALUES ${targets.map((relation) => `(${sqlLiteral(relation)})`).join(",")}
     ), target_pid AS (
       SELECT activity.pid
         FROM pg_catalog.pg_stat_activity AS activity
        WHERE activity.datname = pg_catalog.current_database()
          AND activity.application_name = ${sqlLiteral(applicationName)}
     )
     SELECT target.relation_name,
            lock.mode,
            lock.granted,
            pg_catalog.count(*)::pg_catalog.int4 AS lock_count
       FROM target
       JOIN pg_catalog.pg_locks AS lock
         ON lock.relation = pg_catalog.to_regclass(target.relation_name)
       JOIN target_pid ON target_pid.pid = lock.pid
      WHERE lock.locktype = 'relation'
      GROUP BY target.relation_name, lock.mode, lock.granted
      ORDER BY target.relation_name, lock.mode, lock.granted;`,
  );
  const expected = [
    {
      relation_name: "public.email_outbox",
      mode: "AccessExclusiveLock",
      granted: true,
      lock_count: 1,
    },
    ...CUTOVER_PROOF_SOURCES.map((relationName) => ({
      relation_name: relationName,
      mode: "ShareLock",
      granted: true,
      lock_count: 1,
    })),
  ];
  const actual = new Map(
    result.rows.map((row) => [row.relation_name, row]),
  );
  assert.equal(result.rows.length, expected.length);
  assert.equal(actual.size, expected.length);
  for (const expectedLock of expected) {
    assert.deepEqual(actual.get(expectedLock.relation_name), expectedLock);
  }  process.stdout.write(
    "mail_durable_replay_0067=cutover_lock_catalog:10:pass\n",
  );
}

async function proveCutoverNowaitContention(port, database) {
  for (const source of CUTOVER_PROOF_SOURCES) {
    const error = await expectDatabaseError(
      port,
      database,
      "learncoding_migrator",
      `BEGIN;
       SET LOCAL statement_timeout = '5s';
       SET ROLE learncoding_owner;
       LOCK TABLE ${source} IN ROW EXCLUSIVE MODE NOWAIT;
       COMMIT;`,
      { code: "55P03", constraint: undefined, message: undefined },
    );
    assert.notEqual(error.code, "40P01", `source NOWAIT deadlocked: ${source}`);
  }
  process.stdout.write(
    "mail_durable_replay_0067=cutover_source_nowait:9:pass\n",
  );

  const outboxError = await expectDatabaseError(
    port,
    database,
    "learncoding_migrator",
    `BEGIN;
     SET LOCAL statement_timeout = '5s';
     SET ROLE learncoding_owner;
     LOCK TABLE public.email_outbox IN ACCESS EXCLUSIVE MODE NOWAIT;
     COMMIT;`,
    { code: "55P03", constraint: undefined, message: undefined },
  );
  assert.notEqual(outboxError.code, "40P01", "outbox NOWAIT deadlocked");
  process.stdout.write(
    "mail_durable_replay_0067=cutover_outbox_nowait:pass\n",
  );
}

async function proveCutoverLockGate(port, database) {
  const applicationName = "mail0067_cutover_lock_catalog";
  const controller = createTrackedClient(isolatedClientConfig({
    applicationName: "mail0067_cutover_lock_controller",
    database,
    port,
    user: "postgres",
  }));
  const migrationClient = createTrackedClient(isolatedClientConfig({
    applicationName,
    database,
    port,
    user: "learncoding_migrator",
  }));
  let gateHeld = false;
  let migrationWork;
  let migrationOutcome;
  let operationError;
  const cleanupFailures = [];
  try {
    await connectClientWithin(
      controller,
      "cutover lock-gate controller",
    );
    await connectClientWithin(
      migrationClient,
      "cutover lock-gate migration client",
    );
    await controller.query(
      `SELECT pg_catalog.pg_advisory_lock(
         ${CUTOVER_LOCK_PROBE_GATE}::pg_catalog.int8
       );`,
    );
    gateHeld = true;
    migrationWork = observePromiseOutcome(
      migrationClient.query(
        `BEGIN;
         SET LOCAL statement_timeout = '20s';
         SET ROLE learncoding_owner;
         ${migration0067WithControllerGate(CUTOVER_LOCK_PROBE_GATE)}
         ROLLBACK;`,
      ),
    );
    await waitForAdvisoryLockWaiter(port, database, applicationName);
    await proveGrantedCutoverLocks(port, database, applicationName);
    await proveCutoverNowaitContention(port, database);
    await releaseControllerGate(controller, CUTOVER_LOCK_PROBE_GATE);
    gateHeld = false;
    migrationOutcome = await settleWithin(
      migrationWork,
      "cutover lock-gate rollback",
    );
    if (migrationOutcome.status === "rejected") {
      throw migrationOutcome.error;
    }
  } catch (error) {
    operationError = error;
  } finally {
    if (gateHeld) {
      await runCleanupStep(
        cleanupFailures,
        () => releaseControllerGate(controller, CUTOVER_LOCK_PROBE_GATE),
        "cutover lock-gate release",
      );
    }
    if (migrationWork !== undefined && migrationOutcome === undefined) {
      await runCleanupStep(
        cleanupFailures,
        async () => {
          const outcome = await migrationWork;
          if (outcome.status === "rejected") throw outcome.error;
        },
        "cutover lock-gate migration cleanup",
      );
    }
    await runCleanupStep(
      cleanupFailures,
      () => closeClientWithin(
        migrationClient,
        "cutover lock-gate migration client",
      ),
      "cutover lock-gate migration client cleanup",
    );
    await runCleanupStep(
      cleanupFailures,
      () => closeClientWithin(
        controller,
        "cutover lock-gate controller",
      ),
      "cutover lock-gate controller cleanup",
    );
  }
  if (operationError !== undefined || cleanupFailures.length > 0) {
    throw preserveOperationAndCleanupFailures(
      operationError,
      cleanupFailures,
      "cutover lock-gate operation and cleanup failed",
    );
  }
}

async function proveSourceFirstCutoverTopology(
  port,
  database,
  legacyRowCount,
) {
  const controllerApplication = "mail0067_cutover_topology_controller";
  const migrationApplication = "mail0067_cutover_source_first_migration";
  const producerApplication = "mail0067_cutover_source_first_producer";
  const controller = createTrackedClient(isolatedClientConfig({
    applicationName: controllerApplication,
    database,
    port,
    user: "postgres",
  }));
  const migrationClient = createTrackedClient(isolatedClientConfig({
    applicationName: migrationApplication,
    database,
    port,
    user: "learncoding_migrator",
  }));
  const producer = createTrackedClient(isolatedClientConfig({
    applicationName: producerApplication,
    database,
    port,
    user: "learncoding_migrator",
  }));
  let migrationGateHeld = false;
  let migrationTransactionOpen = false;
  let migrationWork;
  let producerGateHeld = false;
  let producerWork;
  let migrationOutcome;
  let producerOutcome;
  let operationError;
  const cleanupFailures = [];
  try {
    await connectClientWithin(
      controller,
      "source-first controller",
    );
    await connectClientWithin(
      migrationClient,
      "source-first migration",
    );
    await connectClientWithin(
      producer,
      "source-first producer",
    );
    await controller.query(
      `SELECT pg_catalog.pg_advisory_lock(
         ${CUTOVER_TOPOLOGY_PRODUCER_GATE}::pg_catalog.int8
       );`,
    );
    producerGateHeld = true;
    await controller.query(
      `SELECT pg_catalog.pg_advisory_lock(
         ${CUTOVER_TOPOLOGY_MIGRATION_GATE}::pg_catalog.int8
       );`,
    );
    migrationGateHeld = true;

    producerWork = observePromiseOutcome(
      producer.query(
        `BEGIN;
         SET LOCAL statement_timeout = '20s';
         SET ROLE learncoding_owner;
         LOCK TABLE public.smart_reminder_dispatch IN ROW EXCLUSIVE MODE;
         SELECT pg_catalog.pg_advisory_xact_lock(
           ${CUTOVER_TOPOLOGY_PRODUCER_GATE}::pg_catalog.int8
         );
         LOCK TABLE public.email_outbox IN ROW EXCLUSIVE MODE;
         COMMIT;`,
      ),
    );
    await waitForCutoverAdvisoryLockTopology(
      controller,
      {
        controllerApplicationName: controllerApplication,
        gateKey: CUTOVER_TOPOLOGY_PRODUCER_GATE,
        waiterApplicationName: producerApplication,
      },
    );

    migrationTransactionOpen = true;
    migrationWork = observePromiseOutcome(
      migrationClient.query(
        `BEGIN;
         SET LOCAL statement_timeout = '20s';
         SET ROLE learncoding_owner;
         ${migration0067WithOutboxGate(CUTOVER_TOPOLOGY_MIGRATION_GATE)}`,
      ),
    );
    await waitForCutoverAdvisoryLockTopology(
      controller,
      {
        controllerApplicationName: controllerApplication,
        gateKey: CUTOVER_TOPOLOGY_MIGRATION_GATE,
        waiterApplicationName: migrationApplication,
      },
    );

    await releaseControllerGate(
      controller,
      CUTOVER_TOPOLOGY_PRODUCER_GATE,
    );
    producerGateHeld = false;
    await waitForCutoverRelationLockTopology(
      controller,
      {
        controllerApplicationName: controllerApplication,
        migrationApplicationName: migrationApplication,
        producerApplicationName: producerApplication,
      },
    );

    await releaseControllerGate(
      controller,
      CUTOVER_TOPOLOGY_MIGRATION_GATE,
    );
    migrationGateHeld = false;
    migrationOutcome = await settleWithin(
      migrationWork,
      "source-first migration outcome",
      WAIT_TOPOLOGY_TIMEOUT_MS,
    );
    assert.equal(migrationOutcome.value, undefined);
    assert.equal(migrationOutcome.error?.code, "55P03");
    assert.notEqual(
      migrationOutcome.error?.code,
      "40P01",
      "cutover migration unexpectedly reported 40P01",
    );
    await migrationClient.query("ROLLBACK");
    migrationTransactionOpen = false;
    producerOutcome = await settleWithin(
      producerWork,
      "source-first producer completion",
    );
    if (producerOutcome.status === "rejected") {
      throw producerOutcome.error;
    }
    process.stdout.write(
      "mail_durable_replay_0067=cutover_topology_55p03:pass\n",
    );
  } catch (error) {
    operationError = error;
  } finally {
    if (producerGateHeld) {
      await runCleanupStep(
        cleanupFailures,
        () => releaseControllerGate(
          controller,
          CUTOVER_TOPOLOGY_PRODUCER_GATE,
        ),
        "source-first producer gate release",
      );
    }
    if (migrationGateHeld) {
      await runCleanupStep(
        cleanupFailures,
        () => releaseControllerGate(
          controller,
          CUTOVER_TOPOLOGY_MIGRATION_GATE,
        ),
        "source-first migration gate release",
      );
    }
    if (migrationWork !== undefined && migrationOutcome === undefined) {
      await runCleanupStep(
        cleanupFailures,
        async () => {
          const outcome = await migrationWork;
          if (outcome.status === "rejected") throw outcome.error;
        },
        "source-first migration cleanup",
        WAIT_TOPOLOGY_TIMEOUT_MS,
      );
    }
    if (migrationTransactionOpen) {
      await runCleanupStep(
        cleanupFailures,
        () => migrationClient.query("ROLLBACK"),
        "source-first migration rollback",
      );
    }
    if (producerWork !== undefined && producerOutcome === undefined) {
      await runCleanupStep(
        cleanupFailures,
        async () => {
          const outcome = await producerWork;
          if (outcome.status === "rejected") throw outcome.error;
        },
        "source-first producer cleanup",
        WAIT_TOPOLOGY_TIMEOUT_MS,
      );
    }
    await runCleanupStep(
      cleanupFailures,
      () => closeClientWithin(producer, "source-first producer"),
      "source-first producer cleanup",
    );
    await runCleanupStep(
      cleanupFailures,
      () => closeClientWithin(migrationClient, "source-first migration"),
      "source-first migration client cleanup",
    );
    await runCleanupStep(
      cleanupFailures,
      () => closeClientWithin(
        controller,
        "source-first controller",
      ),
      "source-first controller cleanup",
    );
  }
  if (operationError !== undefined || cleanupFailures.length > 0) {
    throw preserveOperationAndCleanupFailures(
      operationError,
      cleanupFailures,
      "source-first topology operation and cleanup failed",
    );
  }

  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
         pg_catalog.to_regclass(
           'public.email_outbox_idempotency_authority'
         ) IS NULL
         AND NOT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_attribute
            WHERE attrelid = 'public.email_outbox'::regclass
              AND attname IN (
                'idempotency_authority_version',
                'idempotency_authority_sha256',
                'idempotency_original_payload_sha256'
              )
              AND NOT attisdropped
         )
         AND pg_catalog.to_regprocedure(
           'public.claim_email_outbox_idempotency_authority()'
         ) IS NULL
         AND (
           SELECT pg_catalog.count(*)
             FROM public.email_outbox
         ) = ${legacyRowCount}
       )::text;`,
    ),
    "true",
    "failed cutover must roll back every partial 0067 object and legacy row",
  );

  apply0067WithHostileAcls(port, database);
  process.stdout.write(
    "mail_durable_replay_0067=cutover_clean_retry:pass\n",
  );
}

async function proveCutoverNowaitAndAtomicRetry(port, database, legacyRowCount) {
  await proveCutoverLockGate(port, database);
  await proveSourceFirstCutoverTopology(port, database, legacyRowCount);
}
function proveCatalogAndAcl(port, database) {
  assert.equal(
    scalar(
      port,
      database,
      `SELECT public.email_outbox_event_sha256(
         ${sqlLiteral(MAIL_EVENT_V1_GOLDEN_VECTOR.template)},
         ${sqlLiteral(MAIL_EVENT_V1_GOLDEN_VECTOR.scope)},
         ${sqlLiteral(MAIL_EVENT_V1_GOLDEN_VECTOR.eventId)}
       );`,
    ),
    MAIL_EVENT_V1_GOLDEN_VECTOR.sha256,
    "SQL event authority must match the shared runtime golden vector",
  );
  assert.equal(
    scalar(
      port,
      database,
      `
        SELECT (
          (SELECT pg_catalog.count(*)
             FROM pg_catalog.pg_proc AS routine
            WHERE routine.oid = ANY(ARRAY[
              'public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)'::regprocedure,
              'public.email_outbox_event_sha256(text,text,text)'::regprocedure,
              'public.enforce_email_outbox_delivery_hold()'::regprocedure,
              'public.claim_email_outbox_idempotency_authority()'::regprocedure,
              'public.persist_email_outbox_idempotency_authority()'::regprocedure,
              'public.enforce_email_outbox_idempotency_metadata_immutable()'::regprocedure,
              'public.enforce_email_outbox_idempotency_append_only()'::regprocedure,
              'public.email_outbox_idempotency_coverage_authority(uuid[])'::regprocedure
            ])
              AND pg_catalog.pg_get_userbyid(routine.proowner) =
                'learncoding_owner'
              AND routine.prosecdef
              AND routine.proconfig =
                ARRAY['search_path=pg_catalog, pg_temp']::text[]) = 8
          AND NOT pg_catalog.has_function_privilege(
            'mail_default_grantee',
            'public.claim_email_outbox_idempotency_authority()',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_function_privilege(
            'mail_default_grantee',
            'public.enforce_email_outbox_delivery_hold()',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_function_privilege(
            'mail_acl_grantor',
            'public.enforce_email_outbox_delivery_hold()',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_function_privilege(
            'mail_acl_leaf',
            'public.enforce_email_outbox_delivery_hold()',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_function_privilege(
            'mail_acl_leaf',
            'public.persist_email_outbox_idempotency_authority()',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_function_privilege(
            'mail_acl_grantor',
            'public.email_outbox_idempotency_coverage_authority(uuid[])',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_function_privilege(
            'mail_acl_leaf',
            'public.email_outbox_idempotency_coverage_authority(uuid[])',
            'EXECUTE'
          )
          AND pg_catalog.has_function_privilege(
            'learncoding_ops',
            'public.email_outbox_idempotency_coverage_authority(uuid[])',
            'EXECUTE'
          )
          AND NOT pg_catalog.has_table_privilege(
            'mail_default_grantee',
            'public.email_outbox_idempotency_authority',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT pg_catalog.has_table_privilege(
            'mail_acl_grantor',
            'public.email_outbox_idempotency_authority',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
          AND NOT pg_catalog.has_table_privilege(
            'mail_acl_leaf',
            'public.email_outbox_idempotency_authority',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'
          )
           AND NOT EXISTS (
             SELECT 1
               FROM pg_catalog.pg_attribute AS attribute
               CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS access
              WHERE attribute.attrelid =
                'public.email_outbox_idempotency_authority'::regclass
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
           )
         )::text;
      `,
    ),
    "true",
  );
  assert.equal(
    scalar(
      port,
      database,
      `
        SELECT pg_catalog.string_agg(
                 attribute.attname || ':' ||
                 COALESCE((
                   SELECT pg_catalog.string_agg(
                            pg_catalog.pg_get_userbyid(access.grantee) || ':' ||
                            pg_catalog.lower(access.privilege_type) || ':' ||
                            access.is_grantable::text,
                            ',' ORDER BY
                              pg_catalog.pg_get_userbyid(access.grantee),
                              access.privilege_type
                          )
                     FROM pg_catalog.aclexplode(attribute.attacl) AS access
                 ), ''),
                 '|' ORDER BY attribute.attnum
               )
          FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.email_outbox'::regclass
           AND attribute.attname IN (
             'idempotency_authority_version',
             'idempotency_authority_sha256',
             'idempotency_original_payload_sha256',
             'delivery_hold_version'
           );
      `,
    ),
    "idempotency_authority_version:learncoding_app:insert:false,learncoding_worker:insert:false"
      + "|idempotency_authority_sha256:"
      + "|idempotency_original_payload_sha256:"
      + "|delivery_hold_version:",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT convalidated::text
         FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.email_outbox'::regclass
          AND conname = 'email_outbox_idempotency_authority_valid';`,
    ),
    "true",
  );
  assert.equal(
    scalar(
      port,
      database,
      `
        WITH fk AS (
          SELECT * FROM pg_catalog.pg_constraint
           WHERE conrelid = 'public.email_outbox'::regclass
             AND conname = 'email_outbox_idempotency_authority_fk'
        ), parent_unique AS (
          SELECT * FROM pg_catalog.pg_constraint
           WHERE conrelid =
             'public.email_outbox_idempotency_authority'::regclass
             AND conname =
               'email_outbox_idempotency_authority_payload_unique'
        )
        SELECT (
          fk.contype = 'f'
          AND fk.conkey = ARRAY[
            (SELECT attnum FROM pg_catalog.pg_attribute
              WHERE attrelid = 'public.email_outbox'::regclass
                AND attname = 'idempotency_authority_sha256'),
            (SELECT attnum FROM pg_catalog.pg_attribute
              WHERE attrelid = 'public.email_outbox'::regclass
                AND attname = 'idempotency_original_payload_sha256')
          ]::smallint[]
          AND fk.confkey = ARRAY[
            (SELECT attnum FROM pg_catalog.pg_attribute
              WHERE attrelid =
                'public.email_outbox_idempotency_authority'::regclass
                AND attname = 'idempotency_sha256'),
            (SELECT attnum FROM pg_catalog.pg_attribute
              WHERE attrelid =
                'public.email_outbox_idempotency_authority'::regclass
                AND attname = 'original_payload_sha256')
          ]::smallint[]
          AND fk.confrelid =
            'public.email_outbox_idempotency_authority'::regclass
          AND fk.convalidated
          AND fk.condeferrable
          AND fk.condeferred
          AND fk.confmatchtype = 's'
          AND fk.confupdtype = 'r'
          AND fk.confdeltype = 'r'
          AND parent_unique.contype = 'u'
          AND parent_unique.conkey = fk.confkey
          AND parent_unique.conindid = fk.conindid
          AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_index AS authority_index
             WHERE authority_index.indexrelid = parent_unique.conindid
               AND authority_index.indisunique
               AND authority_index.indisvalid
               AND authority_index.indimmediate
          )
        )::text
        FROM fk CROSS JOIN parent_unique;
      `,
    ),
    "true",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
         pg_catalog.count(*) = 1
         AND pg_catalog.bool_and(
           access_method.amname = 'btree'
           AND NOT lookup_index.indisunique
           AND lookup_index.indisvalid
           AND lookup_index.indisready
           AND lookup_index.indislive
           AND lookup_index.indimmediate
           AND lookup_index.indpred IS NOT NULL
           AND lookup_index.indexprs IS NULL
           AND lookup_index.indnkeyatts = 2
           AND lookup_index.indnatts = 2
           AND (
             SELECT pg_catalog.array_agg(
                      attribute.attname::text ORDER BY indexed.position
                    )
               FROM pg_catalog.unnest(lookup_index.indkey::smallint[])
                    WITH ORDINALITY indexed(attnum, position)
               JOIN pg_catalog.pg_attribute AS attribute
                 ON attribute.attrelid = lookup_index.indrelid
                AND attribute.attnum = indexed.attnum
           ) = ARRAY['idempotency_authority_sha256', 'id']::text[]
           AND pg_catalog.regexp_replace(
                 pg_catalog.lower(
                   pg_catalog.pg_get_expr(
                     lookup_index.indpred,
                     lookup_index.indrelid
                   )
                 ),
                 '[[:space:]()]',
                 '',
                 'g'
               ) = 'idempotency_authority_sha256isnotnull'
         )
       )::text
       FROM pg_catalog.pg_index AS lookup_index
       JOIN pg_catalog.pg_class AS index_relation
         ON index_relation.oid = lookup_index.indexrelid
       JOIN pg_catalog.pg_am AS access_method
         ON access_method.oid = index_relation.relam
       WHERE lookup_index.indrelid = 'public.email_outbox'::regclass
         AND index_relation.relname =
           'email_outbox_idempotency_authority_lookup_idx';`,
    ),
    "true",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.string_agg(
         reviewed_trigger.tgname || ':' || reviewed_trigger.tgenabled::text,
         ',' ORDER BY reviewed_trigger.tgname
       )
       FROM pg_catalog.pg_trigger AS reviewed_trigger
       WHERE reviewed_trigger.tgrelid IN (
         'public.email_outbox'::regclass,
         'public.email_outbox_idempotency_authority'::regclass
       )
         AND reviewed_trigger.tgname IN (
           'email_outbox_idempotency_claim',
           '00_email_outbox_idempotency_persist',
           'email_outbox_idempotency_metadata_immutable',
           'email_outbox_idempotency_append_only',
           'email_outbox_idempotency_no_truncate'
         );`,
    ),
    "00_email_outbox_idempotency_persist:A"
      + ",email_outbox_idempotency_append_only:A"
      + ",email_outbox_idempotency_claim:A"
      + ",email_outbox_idempotency_metadata_immutable:A"
      + ",email_outbox_idempotency_no_truncate:A",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
         pg_catalog.count(*) = 1
         AND pg_catalog.bool_and(
           NOT reviewed_persist_trigger.tgisinternal
           AND reviewed_persist_trigger.tgconstraint = 0
           AND reviewed_persist_trigger.tgconstrrelid = 0
           AND reviewed_persist_trigger.tgrelid =
                 reviewed_foreign_key.conrelid
           AND reviewed_persist_trigger.tgtype = 5
           AND reviewed_persist_trigger.tgenabled = 'A'
           AND reviewed_persist_trigger.tgfoid =
                 pg_catalog.to_regprocedure(
                   'public.persist_email_outbox_idempotency_authority()'
                 )
           AND reviewed_fk_trigger.tgisinternal
           AND reviewed_fk_trigger.tgconstraint = reviewed_foreign_key.oid
           AND reviewed_fk_trigger.tgrelid = reviewed_foreign_key.conrelid
           AND reviewed_fk_trigger.tgconstrrelid =
                 reviewed_foreign_key.confrelid
           AND reviewed_fk_trigger.tgtype = 5
           AND reviewed_fk_trigger.tgenabled IN ('O', 'A')
           AND reviewed_fk_trigger.tgdeferrable =
                 reviewed_foreign_key.condeferrable
           AND reviewed_fk_trigger.tginitdeferred =
                 reviewed_foreign_key.condeferred
           AND reviewed_fk_trigger.tgfoid =
                 pg_catalog.to_regprocedure(
                   'pg_catalog."RI_FKey_check_ins"()'
                 )
           AND pg_catalog.convert_to(
                 reviewed_persist_trigger.tgname::text,
                 'UTF8'
               ) < pg_catalog.convert_to(
                 reviewed_fk_trigger.tgname::text,
                 'UTF8'
               )
         )
       )::text
       FROM pg_catalog.pg_constraint AS reviewed_foreign_key
       JOIN pg_catalog.pg_trigger AS reviewed_fk_trigger
         ON reviewed_fk_trigger.tgconstraint = reviewed_foreign_key.oid
        AND reviewed_fk_trigger.tgrelid = reviewed_foreign_key.conrelid
        AND reviewed_fk_trigger.tgisinternal
        AND reviewed_fk_trigger.tgtype = 5
        AND reviewed_fk_trigger.tgfoid =
              pg_catalog.to_regprocedure(
                'pg_catalog."RI_FKey_check_ins"()'
              )
       JOIN pg_catalog.pg_trigger AS reviewed_persist_trigger
         ON reviewed_persist_trigger.tgrelid = reviewed_foreign_key.conrelid
        AND reviewed_persist_trigger.tgname =
              '00_email_outbox_idempotency_persist'
       WHERE reviewed_foreign_key.conrelid =
             'public.email_outbox'::regclass
         AND reviewed_foreign_key.conname =
             'email_outbox_idempotency_authority_fk'
         AND reviewed_foreign_key.contype = 'f';`,
    ),
    "true",
    "the AFTER persistence trigger must precede the exact immediate FK check",
  );
}

function proveOriginalPayloadDigestVectors(port, database) {
  for (const vector of ORIGINAL_PAYLOAD_DIGEST_VECTORS) {
    const variables = `${sqlLiteral(JSON.stringify(vector.variables))}::jsonb`;
    const canonicalRecipient = vector.toEmail.trim().toLowerCase();
    const logicalScope = vector.userId === null
      ? `s:${vector.variables._mailProducer}:`
        + `${vector.variables._mailSourceId}:`
        + vector.variables._mailAudienceId
      : `a:${vector.userId}`;
    const proof = JSON.parse(scalar(
      port,
      database,
      `SELECT pg_catalog.json_build_object(
         'sha256', public.email_outbox_original_payload_sha256(
           ${sqlLiteral(vector.userId)},
           ${sqlLiteral(canonicalRecipient)},
           ${sqlLiteral(vector.template)},
           ${sqlLiteral(vector.templateVersion)},
           ${variables}
         ),
         'canonicalPayloadJson', pg_catalog.jsonb_build_array(
           pg_catalog.to_jsonb('mail-replay-conflict-v1'::text),
           pg_catalog.to_jsonb(${sqlLiteral(vector.template)}::text),
           pg_catalog.to_jsonb(${sqlLiteral(logicalScope)}::text),
           pg_catalog.to_jsonb(${sqlLiteral(canonicalRecipient)}::text),
           pg_catalog.to_jsonb(${sqlLiteral(vector.templateVersion)}::text),
           ${variables} - ARRAY[
             '_mailOperationId',
             '_mailRecipient'
           ]
         )::text
       )::text;`,
    ));
    assert.deepEqual(proof, {
      sha256: vector.sha256,
      canonicalPayloadJson: vector.canonicalPayloadJson,
    });
  }
  process.stdout.write(
    "mail_durable_replay_0067=replay_fingerprint_vectors:4:pass\n",
  );
}

async function proveOriginalPayloadVariableSemantics(port, database) {
  const nestedMailVariables = {
    "_mailOperationId": "strip-top-level",
    "nested": { "_mailOperationId": "preserve-nested" },
  };
  const nestedMailExpected = {
    "nested": { "_mailOperationId": "preserve-nested" },
  };
  const nestedMailWithoutNestedOperation = {
    "nested": {},
  };
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
         public.email_outbox_original_payload_sha256(
           'mail-0067-vector-user',
           'vector@example.invalid',
           'storage-quota-changed',
           '1',
           ${sqlLiteral(JSON.stringify(nestedMailVariables))}::jsonb
         ) =
         public.email_outbox_original_payload_sha256(
           'mail-0067-vector-user',
           'vector@example.invalid',
           'storage-quota-changed',
           '1',
           ${sqlLiteral(JSON.stringify(nestedMailExpected))}::jsonb
         )
       )::text;`,
    ),
    "true",
    "nested-mail-preserved",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
         public.email_outbox_original_payload_sha256(
           'mail-0067-vector-user',
           'vector@example.invalid',
           'storage-quota-changed',
           '1',
           ${sqlLiteral(JSON.stringify(nestedMailExpected))}::jsonb
         ) <>
         public.email_outbox_original_payload_sha256(
           'mail-0067-vector-user',
           'vector@example.invalid',
           'storage-quota-changed',
           '1',
           ${sqlLiteral(JSON.stringify(nestedMailWithoutNestedOperation))}::jsonb
         )
       )::text;`,
    ),
    "true",
    "nested-mail-digest-distinct-from-empty-object",
  );

  const POSTGRES_NUMERIC_EDGE_PAIRS = Object.freeze([
    Object.freeze({
      name: "large-decimal-exponent-small",
      inputSql:
        `'{"large":123456789012345678901234567890.12345678901234567890,`
        + `"exponent":1.2300e+10,"small":1.23400e-19}'::jsonb`,
      equivalentSql:
        `'{"small":0.000000000000000000123400,`
        + `"exponent":12300000000,`
        + `"large":123456789012345678901234567890.12345678901234567890}'`
        + "::jsonb",
    }),
  ]);
  for (const numericPair of POSTGRES_NUMERIC_EDGE_PAIRS) {
    assert.equal(
      scalar(
        port,
        database,
        `SELECT (
           ${numericPair.inputSql} = ${numericPair.equivalentSql}
           AND public.email_outbox_original_payload_sha256(
             'mail-0067-vector-user',
             'vector@example.invalid',
             'storage-quota-changed',
             '1',
             ${numericPair.inputSql}
           ) = public.email_outbox_original_payload_sha256(
             'mail-0067-vector-user',
             'vector@example.invalid',
             'storage-quota-changed',
             '1',
             ${numericPair.equivalentSql}
           )
         )::text;`,
      ),
      "true",
      numericPair.name,
    );
  }

  for (const invalidVariables of [
    {
      name: "variables-array",
      variablesSql: "'[]'::jsonb",
      code: "23514",
      constraint: "email_outbox_variables_object_valid",
    },
    {
      name: "variables-scalar",
      variablesSql: "'17'::jsonb",
      code: "23514",
      constraint: "email_outbox_variables_object_valid",
    },
    {
      name: "variables-json-null",
      variablesSql: "'null'::jsonb",
      code: "23514",
      constraint: "email_outbox_variables_object_valid",
    },
    {
      name: "variables-sql-null",
      variablesSql: "NULL",
      code: "23502",
      constraint: undefined,
    },
  ]) {
    const row = newEventRow(150, invalidVariables.name);
    await expectDatabaseError(
      port,
      database,
      "learncoding_app",
      `${insertOutboxSql(row, {
        eventAuthority: true,
        variablesSql: invalidVariables.variablesSql,
      })};`,
      {
        code: invalidVariables.code,
        constraint: invalidVariables.constraint,
        message: undefined,
      },
    );
  }
}

async function proveReplayConflictFingerprintSemantics(port, database) {
  const fingerprintSql = (row) =>
    `public.email_outbox_original_payload_sha256(
      ${sqlLiteral(row.userId)},
      ${sqlLiteral(row.to)},
      ${sqlLiteral(row.template)},
      ${sqlLiteral(row.version)},
      ${sqlLiteral(JSON.stringify(row.variables))}::jsonb
    )`;
  const systemSourceId = fixtureUuid("aa", 1);
  const systemAudienceId = fixtureUuid("ab", 1);
  const systemOperationId = fixtureUuid("ac", 1);
  const systemRecipient = "fingerprint-system@example.invalid";
  const systemPayload = { fixture: "replay-fingerprint-system" };
  const systemBase = {
    id: fixtureUuid("8c", 1),
    operationId: systemOperationId,
    userId: null,
    to: systemRecipient,
    template: "invitation",
    version: "1",
    variables: systemVariables(
      systemOperationId,
      systemRecipient,
      "access-request-approved",
      systemSourceId,
      systemAudienceId,
      systemPayload,
    ),
    key: systemEventKey(
      "invitation",
      "access-request-approved",
      systemSourceId,
      systemAudienceId,
      "replay-fingerprint-system",
    ),
  };
  const systemAttemptOnly = {
    ...systemBase,
    operationId: fixtureUuid("ac", 2),
    variables: {
      ...systemBase.variables,
      _mailOperationId: fixtureUuid("ac", 2),
      _mailRecipient: systemRecipient,
    },
  };
  const changedSystem = (patch) => ({
    ...systemBase,
    ...patch,
    variables: { ...systemBase.variables, ...(patch.variables ?? {}) },
  });
  const accountFingerprint = (userId, recipient, template, version, variables) =>
    `public.email_outbox_original_payload_sha256(
      ${sqlLiteral(userId)}, ${sqlLiteral(recipient)}, ${sqlLiteral(template)},
      ${sqlLiteral(version)}, ${sqlLiteral(JSON.stringify(variables))}::jsonb
    )`;
  const accountBaseFingerprint = accountFingerprint(
    LEARNER_ID,
    LEARNER_EMAIL,
    "storage-quota-changed",
    "1",
    { fixture: "replay-fingerprint-account" },
  );

  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        ${fingerprintSql(systemBase)} = ${fingerprintSql(systemAttemptOnly)}
        AND ${fingerprintSql(systemBase)} <>
          ${fingerprintSql(changedSystem({
            variables: { _mailProducer: "access-request-rejected" },
          }))}
        AND ${fingerprintSql(systemBase)} <>
          ${fingerprintSql(changedSystem({
            variables: { _mailSourceId: fixtureUuid("aa", 2) },
          }))}
        AND ${fingerprintSql(systemBase)} <>
          ${fingerprintSql(changedSystem({
            variables: { _mailAudienceId: fixtureUuid("ab", 2) },
          }))}
        AND ${accountBaseFingerprint} <>
          ${accountFingerprint(
            ADMIN_ID,
            LEARNER_EMAIL,
            "storage-quota-changed",
            "1",
            { fixture: "replay-fingerprint-account" },
          )}
        AND ${accountBaseFingerprint} <>
          ${accountFingerprint(
            LEARNER_ID,
            "changed-fingerprint@example.invalid",
            "storage-quota-changed",
            "1",
            { fixture: "replay-fingerprint-account" },
          )}
        AND ${accountBaseFingerprint} <>
          ${accountFingerprint(
            LEARNER_ID,
            LEARNER_EMAIL,
            "learning-plan-changed",
            "1",
            { fixture: "replay-fingerprint-account" },
          )}
        AND ${accountBaseFingerprint} <>
          ${accountFingerprint(
            LEARNER_ID,
            LEARNER_EMAIL,
            "storage-quota-changed",
            "2",
            { fixture: "replay-fingerprint-account" },
          )}
        AND ${accountBaseFingerprint} <>
          ${accountFingerprint(
            LEARNER_ID,
            LEARNER_EMAIL,
            "storage-quota-changed",
            "1",
            { fixture: "changed-business-payload" },
          )}
      )::text;`,
    ),
    "true",
    "one PostgreSQL fingerprint must bind every logical replay axis",
  );

  const accountBase = newEventRow(151, "replay-envelope-account");
  assert.equal(
    scalar(
      port,
      database,
      `${insertOutboxSql(accountBase, { eventAuthority: true })} RETURNING id;`,
      "learncoding_app",
    ),
    accountBase.id,
  );
  const accountInvalid = [
    {
      name: "account-wrong-scope",
      row: { ...accountBase, id: fixtureUuid("8c", 10) },
      options: { deliveryScopeKey: `a:${ADMIN_ID}` },
      message: "account email outbox replay envelope is invalid",
    },
    ...Object.entries({
      _mailOperationId: fixtureUuid("8d", 11),
      _mailRecipient: LEARNER_EMAIL,
      _mailProducer: "access-request-approved",
      _mailSourceId: fixtureUuid("aa", 11),
      _mailAudienceId: fixtureUuid("ab", 11),
    }).map(([reservedKey, reservedValue], index) => ({
      name: `account-reserved-envelope-${reservedKey}`,
      row: {
        ...accountBase,
        id: fixtureUuid("8c", 11 + index),
        variables: {
          ...accountBase.variables,
          [reservedKey]: reservedValue,
        },
      },
      message: "account email outbox replay envelope is invalid",
    })),
    {
      name: "account-case-colliding-envelope",
      row: {
        ...accountBase,
        id: fixtureUuid("8c", 16),
        variables: {
          ...accountBase.variables,
          _MailProducer: "access-request-approved",
        },
      },
      message: "email outbox replay envelope key casing is invalid",
    },
    {
      name: "account-system-template",
      row: {
        ...accountBase,
        id: fixtureUuid("8c", 17),
        template: "invitation",
      },
      message: "account email outbox replay envelope is invalid",
    },
    {
      name: "account-noncanonical-recipient",
      row: {
        ...accountBase,
        id: fixtureUuid("8c", 18),
        to: "UPPERCASE@example.invalid",
      },
      message: "email outbox replay recipient must be canonical ASCII",
      constraint: "email_outbox_recipient_canonical_valid",
    },
  ];
  for (const candidate of accountInvalid) {
    await expectDatabaseError(
      port,
      database,
      "learncoding_app",
      `${insertOutboxSql(candidate.row, {
        eventAuthority: true,
        ...(candidate.options ?? {}),
      })} RETURNING id;`,
      {
        code: "23514",
        constraint: candidate.constraint
          ?? "email_outbox_idempotency_authority_valid",
        message: candidate.message,
      },
    );
  }
  await expectDatabaseError(
    port,
    database,
    "learncoding_app",
    `${insertOutboxSql(
      {
        ...accountBase,
        id: fixtureUuid("8c", 19),
        userId: ADMIN_ID,
      },
      { eventAuthority: true },
    )} RETURNING id;`,
    {
      code: "23505",
      constraint: "email_outbox_idempotency_authority_pkey",
      message: "email outbox idempotency event payload conflict",
    },
  );

  assert.equal(
    scalar(
      port,
      database,
      `${insertOutboxSql(systemBase, { eventAuthority: true })} RETURNING id;`,
      "learncoding_app",
    ),
    systemBase.id,
  );
  const exactSystemReplay = {
    ...systemBase,
    id: fixtureUuid("8c", 2),
    operationId: fixtureUuid("8d", 2),
    variables: {
      ...systemBase.variables,
      _mailOperationId: fixtureUuid("8d", 2),
    },
  };
  assert.equal(
    scalar(
      port,
      database,
      `${insertOutboxSql(
        exactSystemReplay,
        { eventAuthority: true },
      )} RETURNING id;`,
      "learncoding_app",
    ),
    "",
    "a canonical system replay with a fresh attempt operation must deduplicate",
  );

  const systemInvalid = [
    {
      name: "system-wrong-physical-scope",
      patch: {},
      options: { deliveryScopeKey: `s:${fixtureUuid("8d", 99)}` },
    },
    {
      name: "system-missing-operation",
      patch: { variables: { _mailOperationId: undefined } },
    },
    {
      name: "system-missing-recipient",
      patch: { variables: { _mailRecipient: undefined } },
    },
    {
      name: "system-missing-producer",
      patch: { variables: { _mailProducer: undefined } },
    },
    {
      name: "system-missing-source",
      patch: { variables: { _mailSourceId: undefined } },
    },
    {
      name: "system-missing-audience",
      patch: { variables: { _mailAudienceId: undefined } },
    },
    {
      name: "system-operation-mirror-mismatch",
      patch: { variables: { _mailOperationId: fixtureUuid("8d", 98) } },
    },
    {
      name: "system-recipient-mirror-mismatch",
      patch: { variables: { _mailRecipient: "mismatch@example.invalid" } },
    },
    {
      name: "system-template-producer-mismatch",
      patch: { variables: { _mailProducer: "access-request-rejected" } },
    },
    {
      name: "system-null-producer",
      patch: { variables: { _mailProducer: null } },
    },
    {
      name: "system-null-source",
      patch: { variables: { _mailSourceId: null } },
    },
    {
      name: "system-malformed-source",
      patch: { variables: { _mailSourceId: "not-a-uuid" } },
    },
    {
      name: "system-malformed-audience",
      patch: { variables: { _mailAudienceId: "not-a-uuid" } },
    },
    {
      name: "system-uppercase-source",
      patch: {
        variables: { _mailSourceId: systemSourceId.toUpperCase() },
      },
    },
    {
      name: "system-uppercase-audience",
      patch: {
        variables: { _mailAudienceId: systemAudienceId.toUpperCase() },
      },
    },
    {
      name: "system-case-colliding-envelope",
      patch: { variables: { _MailSourceId: systemSourceId } },
      message: "email outbox replay envelope key casing is invalid",
    },
    {
      name: "system-wrong-version",
      patch: { version: "2" },
    },
  ];
  for (const [index, candidate] of systemInvalid.entries()) {
    const operationId = fixtureUuid("8d", 20 + index);
    const variables = {
      ...systemBase.variables,
      _mailOperationId: operationId,
      ...(candidate.patch.variables ?? {}),
    };
    for (const key of Object.keys(variables)) {
      if (variables[key] === undefined) delete variables[key];
    }
    const row = {
      ...systemBase,
      ...candidate.patch,
      id: fixtureUuid("8c", 20 + index),
      operationId,
      variables,
    };
    await expectDatabaseError(
      port,
      database,
      "learncoding_app",
      `${insertOutboxSql(row, {
        eventAuthority: true,
        ...(candidate.options ?? {}),
      })} RETURNING id;`,
      {
        code: "23514",
        constraint: "email_outbox_idempotency_authority_valid",
        message: candidate.message
          ?? "system email outbox replay envelope is invalid",
      },
    );
  }

  for (const [index, patch] of [
    { variables: { _mailSourceId: fixtureUuid("aa", 2) } },
    { variables: { _mailAudienceId: fixtureUuid("ab", 2) } },
    {
      template: "access-rejected",
      variables: { _mailProducer: "access-request-rejected" },
    },
    {
      to: "changed-system-recipient@example.invalid",
      variables: {
        _mailRecipient: "changed-system-recipient@example.invalid",
      },
    },
    { variables: { fixture: "changed-system-business-payload" } },
  ].entries()) {
    const operationId = fixtureUuid("8d", 40 + index);
    const row = {
      ...systemBase,
      ...patch,
      id: fixtureUuid("8c", 40 + index),
      operationId,
      variables: {
        ...systemBase.variables,
        _mailOperationId: operationId,
        ...(patch.variables ?? {}),
      },
    };
    await expectDatabaseError(
      port,
      database,
      "learncoding_app",
      `${insertOutboxSql(row, { eventAuthority: true })} RETURNING id;`,
      {
        code: "23505",
        constraint: "email_outbox_idempotency_authority_pkey",
        message: "email outbox idempotency event payload conflict",
      },
    );
  }

  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        (SELECT pg_catalog.count(*) FROM public.email_outbox
          WHERE idempotency_authority_sha256 IN (
            '${accountBase.key}', '${systemBase.key}'
          )) = 2
        AND
        (SELECT pg_catalog.count(*)
          FROM public.email_outbox_idempotency_authority
          WHERE idempotency_sha256 IN (
            '${accountBase.key}', '${systemBase.key}'
          )) = 2
      )::text;`,
    ),
    "true",
    "invalid or divergent replays must leave one row and one authority",
  );
  process.stdout.write(
    "mail_durable_replay_0067=replay_fingerprint_matrix:pass\n",
  );
}

function proveCompositeAuthorityBackstop(port, database) {
  const triggerDisabled = newEventRow(61, "fk-trigger-disabled");
  const triggerDisabledDigest = `public.email_outbox_original_payload_sha256(
    '${triggerDisabled.userId}', '${triggerDisabled.to}',
    '${triggerDisabled.template}', '${triggerDisabled.version}',
    ${sqlLiteral(JSON.stringify(triggerDisabled.variables))}::jsonb
  )`;
  expectSqlFailure(
    port,
    database,
    "learncoding_migrator",
    `BEGIN;
     SET ROLE learncoding_owner;
     ALTER TABLE public.email_outbox DISABLE TRIGGER USER;
     INSERT INTO public.email_outbox (
       id, operation_id, user_id, delivery_scope_key, to_email, template,
       template_version, variables, idempotency_key,
       idempotency_authority_version, idempotency_authority_sha256,
       idempotency_original_payload_sha256
     ) VALUES (
       '${triggerDisabled.id}', '${triggerDisabled.operationId}',
       '${triggerDisabled.userId}', 'a:${triggerDisabled.userId}',
       '${triggerDisabled.to}', '${triggerDisabled.template}',
       '${triggerDisabled.version}',
       ${sqlLiteral(JSON.stringify(triggerDisabled.variables))}::jsonb,
       '${triggerDisabled.key}', 'event-v1-native', '${triggerDisabled.key}',
       ${triggerDisabledDigest}
     );
     SET CONSTRAINTS email_outbox_idempotency_authority_fk IMMEDIATE;
     COMMIT;`,
    /email_outbox_idempotency_authority_fk/u,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        NOT EXISTS (
          SELECT 1 FROM public.email_outbox
           WHERE id = '${triggerDisabled.id}'::uuid
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.email_outbox_idempotency_authority
           WHERE idempotency_sha256 = '${triggerDisabled.key}'
        )
      )::text;`,
    ),
    "true",
  );

  const replica = newEventRow(62, "replica-trigger-proof");
  const replicaDigest = `public.email_outbox_original_payload_sha256(
    '${replica.userId}', '${replica.to}', '${replica.template}',
    '${replica.version}', ${sqlLiteral(JSON.stringify(replica.variables))}::jsonb
  )`;
  expectSqlFailure(
    port,
    database,
    "postgres",
    `BEGIN;
     SET LOCAL session_replication_role = replica;
     SET ROLE learncoding_owner;
     INSERT INTO public.email_outbox (
       id, operation_id, user_id, delivery_scope_key, to_email, template,
       template_version, variables, idempotency_key,
       idempotency_authority_version, idempotency_authority_sha256,
       idempotency_original_payload_sha256
     ) VALUES (
       '${replica.id}', '${replica.operationId}', '${replica.userId}',
       'a:${replica.userId}', '${replica.to}', '${replica.template}',
       '${replica.version}',
       ${sqlLiteral(JSON.stringify(replica.variables))}::jsonb,
       '${replica.key}', 'event-v1-native', '${replica.key}', ${replicaDigest}
     );
     COMMIT;`,
    /payload authority digest is database-owned/u,
  );
}
function proveLegacyClassification(
  port,
  database,
  blockedPolicyRows,
  retained,
  primarySourceMapNearMisses,
  additionalSourceMapNearMisses,
) {
  const backupStableKey = accountEventKey(
    "backup-status",
    ADMIN_ID,
    `success:${BACKUP_RUN_KEY}`,
  );
  const expectedSourceMaps = [["backup-status", backupStableKey]];
  assert.equal(expectedSourceMaps.length, 1);
  assert.equal(blockedPolicyRows.length, 22);
  assert.equal(
    new Set(blockedPolicyRows.map((row) => row.template)).size,
    21,
  );
  assert.ok(blockedPolicyRows.every((row) =>
    row.template !== "backup-status"
    && sourceMapPolicySet.has(row.template)
  ));
  assert.equal(retained.length, 7);
  assert.deepEqual(
    retained
      .map((row) => [row.template, retainedLegacyStrategyMap.get(row.template)])
      .sort(([left], [right]) => left.localeCompare(right)),
    [...retainedLegacyStrategyMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  assert.deepEqual(
    primarySourceMapNearMisses.map((row) => row.caseName),
    [
      "reset-wrong-purpose",
      "reset-token-mismatch",
      "reset-wrong-recipient",
      "reset-source-user-mismatch",
      "reset-wrong-version",
      "reset-wrong-legacy-key",
      "inactivity-cross-user",
      "inactivity-missing-marker",
      "inactivity-bad-order",
      ...SMART_NEAR_CASES.map((scenario) => scenario.caseName),
      ...SYSTEM_NEAR_CASES.map((scenario) => scenario.caseName),
      BACKUP_NEAR_CASE.caseName,
    ],
  );
  assert.deepEqual(
    additionalSourceMapNearMisses.map((row) => row.caseName),
    [
      "inactivity-non-admin",
      "deletion-target-mismatch",
      "deletion-status-mismatch",
      "deletion-report-mismatch",
    ],
  );
  const values = expectedSourceMaps
    .map(
      ([template, key]) => `(${sqlLiteral(template)}, ${sqlLiteral(key)})`,
    )
    .join(",");
  const retainedValues = retained
    .map((row) =>
      `('${row.id}'::uuid, ${sqlLiteral(
        retainedLegacyStrategyMap.get(row.template),
      )})`
    )
    .join(",");
  const sourceMapCount = expectedSourceMaps.length;
  const blockedCount = blockedPolicyRows.length
    + primarySourceMapNearMisses.length
    + additionalSourceMapNearMisses.length;
  const outboxCount = blockedCount + retained.length + sourceMapCount;
  const authorityCount = blockedCount + retained.length + 2;
  assert.equal(blockedCount, 85);
  assert.equal(outboxCount, 93);
  assert.equal(authorityCount, 94);
  const classificationOk = scalar(
    port,
    database,
    `
      WITH expected(template, digest) AS (VALUES ${values}),
      expected_retained(id, authority_version) AS (
        VALUES ${retainedValues}),
      expected_authority(idempotency_sha256, original_payload_sha256) AS (
        SELECT DISTINCT
          pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(outbox.idempotency_key, 'UTF8')
            ),
            'hex'
          ),
          outbox.idempotency_original_payload_sha256
        FROM public.email_outbox AS outbox
        UNION
        SELECT outbox.idempotency_authority_sha256,
               outbox.idempotency_original_payload_sha256
          FROM public.email_outbox AS outbox
         WHERE outbox.idempotency_authority_version = 'event-v1-source-map'
      ), actual_authority(idempotency_sha256, original_payload_sha256) AS (
        SELECT authority.idempotency_sha256,
               authority.original_payload_sha256
          FROM public.email_outbox_idempotency_authority AS authority
      )
      SELECT (
        (SELECT pg_catalog.count(*)
           FROM public.email_outbox
          WHERE idempotency_authority_version =
            'event-v1-source-map') = ${sourceMapCount}
        AND (SELECT pg_catalog.count(*)
               FROM public.email_outbox
              WHERE idempotency_authority_version = 'legacy-key-blocked-v1'
                AND idempotency_authority_sha256 IS NULL) = ${blockedCount}
        AND (SELECT pg_catalog.count(*) FROM public.email_outbox) =
              ${outboxCount}
        AND (SELECT pg_catalog.count(*) FROM public.email_outbox
              WHERE idempotency_authority_version =
                'legacy-key-source-one-shot-v1') = 3
        AND (SELECT pg_catalog.count(*) FROM public.email_outbox
              WHERE idempotency_authority_version =
                'legacy-key-terminal-cas-v1') = 2
        AND (SELECT pg_catalog.count(*) FROM public.email_outbox
              WHERE idempotency_authority_version =
                'legacy-key-protocol-retired-v1') = 1
        AND (SELECT pg_catalog.count(*) FROM public.email_outbox
              WHERE idempotency_authority_version =
                'legacy-key-fresh-action-v1') = 1
        AND NOT EXISTS (
          SELECT 1
            FROM expected_retained
            JOIN public.email_outbox AS outbox USING (id)
           WHERE outbox.idempotency_authority_version IS DISTINCT FROM
                   expected_retained.authority_version
              OR outbox.idempotency_authority_sha256 IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM expected
            LEFT JOIN public.email_outbox AS outbox
              ON outbox.template = expected.template
             AND outbox.idempotency_authority_sha256 = expected.digest
           WHERE outbox.id IS NULL
        )
        AND (SELECT pg_catalog.count(*)
               FROM public.email_outbox_idempotency_authority) = ${authorityCount}
        AND NOT EXISTS (
          (
            SELECT * FROM expected_authority
            EXCEPT ALL
            SELECT * FROM actual_authority
          )
          UNION ALL
          (
            SELECT * FROM actual_authority
            EXCEPT ALL
            SELECT * FROM expected_authority
          )
        )
      )::text;
    `,
  );
  if (classificationOk !== "true") {
    const classificationDiagnostic = scalar(
      port,
      database,
      `
        WITH expected(template, digest) AS (VALUES ${values})
        SELECT pg_catalog.json_build_object(
          'source_map_count', (
            SELECT pg_catalog.count(*) FROM public.email_outbox
             WHERE idempotency_authority_version = 'event-v1-source-map'
          ),
          'blocked_count', (
            SELECT pg_catalog.count(*) FROM public.email_outbox
             WHERE idempotency_authority_version = 'legacy-key-blocked-v1'
               AND idempotency_authority_sha256 IS NULL
          ),
          'authority_count', (
            SELECT pg_catalog.count(*)
              FROM public.email_outbox_idempotency_authority
          ),
          'missing', COALESCE((
            SELECT pg_catalog.json_agg(expected.template ORDER BY expected.template)
              FROM expected
             WHERE NOT EXISTS (
               SELECT 1 FROM public.email_outbox AS outbox
                WHERE outbox.template = expected.template
                  AND outbox.idempotency_authority_sha256 = expected.digest
             )
          ), '[]'::json)
        )::text;
      `,
    );
    assert.equal(
      classificationOk,
      "true",
      `replay classification mismatch: ${classificationDiagnostic}`,
    );
  }
  const weeklyCurrent = blockedPolicyRows.find((row) =>
    row.template === "weekly-summary"
    && row.variables.smartReminderDispatchId !== undefined
  );
  const weeklyLegacy = blockedPolicyRows.find((row) =>
    row.template === "weekly-summary"
    && row.variables.smartReminderDispatchId === undefined
  );
  const currentWeeklySource = SMART_REMINDERS.find(
    ([,,,,,,, fixtureName]) => fixtureName === "current-weekly",
  );
  const legacyWeeklySource = SMART_REMINDERS.find(
    ([,,,,,,, fixtureName]) => fixtureName === "legacy-weekly",
  );
  const terminalInvitation = blockedPolicyRows.find(
    (row) => row.template === "invitation",
  );
  assert.ok(
    weeklyCurrent
      && weeklyLegacy
      && currentWeeklySource
      && legacyWeeklySource
      && terminalInvitation,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
         EXISTS (
           SELECT 1
             FROM public.email_outbox
            WHERE id = '${weeklyCurrent.id}'::uuid
              AND idempotency_authority_version = 'legacy-key-blocked-v1'
              AND variables ->> 'smartReminderDispatchId' = '${currentWeeklySource[2]}'
              AND variables ->> 'smartReminderKind' = 'weekly_summary'
              AND variables ->> 'smartReminderPeriodKey' = '2026-W29'
              AND variables ->> 'smartReminderPolicyVersion' =
                '${SMART_REMINDER_POLICY_VERSION}'
         )
         AND EXISTS (
           SELECT 1
             FROM public.email_outbox
            WHERE id = '${weeklyLegacy.id}'::uuid
              AND idempotency_authority_version = 'legacy-key-blocked-v1'
              AND variables = pg_catalog.jsonb_build_object(
                'name', 'Mail 0067 Learner',
                'summary', '${SMART_REMINDER_WEEKLY_SUMMARY}',
                'url', '${legacyWeeklySource[5]}'
              )
         )
         AND EXISTS (
           SELECT 1
             FROM public.email_outbox AS outbox
             JOIN public.invitation AS source
               ON source.id = '${INVITATION_ID}'::uuid
            WHERE outbox.id = '${terminalInvitation.id}'::uuid
              AND outbox.idempotency_authority_version =
                    'legacy-key-blocked-v1'
              AND source.expires_at < pg_catalog.statement_timestamp()
              AND source.consumed_at IS NOT NULL
         )
       )::text;`,
    ),
    "true",
    "non-backup source-map candidates must remain blocked",
  );
  const smartSourceMismatch = primarySourceMapNearMisses.find(
    (row) => row.caseName === "smart-source-user-mismatch",
  );
  assert.ok(smartSourceMismatch);
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
         source.user_id = '${SMART_SOURCE_MISMATCH_USER_ID}'
         AND source.user_id <> outbox.user_id
         AND outbox.user_id = '${LEARNER_ID}'
         AND recipient_user.role = 'learner'
         AND pg_catalog.lower(pg_catalog.btrim(recipient_user.email)) =
               outbox.to_email
         AND outbox.template = 'daily-study-reminder'
         AND outbox.template_version = '1'
         AND source.kind = 'daily_study'
         AND source.evidence = pg_catalog.jsonb_build_object(
           'policyVersion', '${SMART_REMINDER_POLICY_VERSION}',
           'reviewDue', false,
           'activePlan', false,
           'upcomingBattle', false,
           'noMeaningfulActivityToday', true
         )
         AND source.local_period_key = pg_catalog.to_char(
           source.scheduled_for AT TIME ZONE source_timezone.name,
           'YYYY-MM-DD'
         )
         AND source.dispatched_at = source.scheduled_for
         AND source.dispatched_at <= pg_catalog.statement_timestamp()
         AND outbox.variables = pg_catalog.jsonb_build_object(
           'name', recipient_user.name,
           'smartReminderDispatchId', source.id::text,
           'smartReminderKind', source.kind,
           'smartReminderPeriodKey', source.local_period_key,
           'smartReminderPolicyVersion', '${SMART_REMINDER_POLICY_VERSION}',
           'url', outbox.variables ->> 'url'
         )
         AND outbox.variables ->> 'url' ~
               '^https://[^/?#@[:space:]]+/learn$'
         AND outbox.idempotency_key = pg_catalog.encode(
           pg_catalog.sha256(
             pg_catalog.convert_to(
               outbox.template || ':' ||
               pg_catalog.lower(outbox.to_email COLLATE "C") || ':' ||
               'smart-reminder:' || source.id::text,
               'UTF8'
             )
           ),
           'hex'
         )
       )::text
       FROM public.email_outbox AS outbox
       JOIN public.smart_reminder_dispatch AS source
         ON source.id = '${smartSourceMismatch.variables.smartReminderDispatchId}'::uuid
       JOIN public."user" AS recipient_user
         ON recipient_user.id = source.user_id
       JOIN pg_catalog.pg_timezone_names AS source_timezone
         ON source_timezone.name = source.timezone
       WHERE outbox.id = '${smartSourceMismatch.id}'::uuid;`,
    ),
    "true",
    "smart-source-user-mismatch must fail only source-to-outbox user equality",
  );

  const primaryNearMissValues = primarySourceMapNearMisses
    .map((row) => `('${row.id}'::uuid, '${row.stableKey}')`)
    .join(",");
  const additionalNearMissValues = additionalSourceMapNearMisses
    .map((row) => `('${row.id}'::uuid, '${row.stableKey}')`)
    .join(",");
  assert.equal(
    scalar(
      port,
      database,
      `
        WITH primary_near_miss(id, stable_digest) AS (
          VALUES ${primaryNearMissValues}
        ), additional_near_miss(id, stable_digest) AS (
          VALUES ${additionalNearMissValues}
        )
        SELECT (
          (SELECT pg_catalog.count(*)
             FROM primary_near_miss
             JOIN public.email_outbox AS outbox USING (id)
            WHERE outbox.idempotency_authority_version = 'legacy-key-blocked-v1'
              AND outbox.idempotency_authority_sha256 IS NULL) =
            (SELECT pg_catalog.count(*) FROM primary_near_miss)
          AND NOT EXISTS (
            SELECT 1
              FROM primary_near_miss
              JOIN public.email_outbox_idempotency_authority AS authority
                ON authority.idempotency_sha256 =
                     primary_near_miss.stable_digest
          )
          AND (SELECT pg_catalog.count(*)
                 FROM additional_near_miss
                 JOIN public.email_outbox AS outbox USING (id)
                WHERE outbox.idempotency_authority_version =
                        'legacy-key-blocked-v1'
                  AND outbox.idempotency_authority_sha256 IS NULL) =
                (SELECT pg_catalog.count(*) FROM additional_near_miss)
          AND NOT EXISTS (
            SELECT 1
              FROM additional_near_miss
              JOIN public.email_outbox_idempotency_authority AS authority
                ON authority.idempotency_sha256 =
                     additional_near_miss.stable_digest
          )
        )::text;
      `,
    ),
    "true",
    "all source-map near misses must remain blocked and distinct",
  );
  const sourceMapIds = scalar(
    port,
    database,
    `SELECT pg_catalog.string_agg(id::text, ',' ORDER BY id)
       FROM public.email_outbox
      WHERE idempotency_authority_version = 'event-v1-source-map';`,
  ).split(",");
  assert.equal(sourceMapIds.length, sourceMapCount);
  assert.equal(
    scalar(
      port,
      database,
      `SELECT public.email_outbox_idempotency_coverage_authority(
         ARRAY[${sourceMapIds.map((id) => `'${id}'::uuid`).join(",")}]
       )::text;`,
      "learncoding_ops",
    ),
    "true",
  );
  for (const candidateIds of [
    blockedPolicyRows.map((row) => row.id),
    [retained[0].id],
    primarySourceMapNearMisses.map((row) => row.id),
    additionalSourceMapNearMisses.map((row) => row.id),
  ]) {
    assert.equal(
      scalar(
        port,
        database,
        `SELECT public.email_outbox_idempotency_coverage_authority(
           ARRAY[${candidateIds.map((id) => `'${id}'::uuid`).join(",")}]
         )::text;`,
        "learncoding_ops",
      ),
      "true",
    );
  }
}
async function proveBlockedRowsDoNotAliasNativeEvents(
  port,
  database,
  blockedPolicyRows,
) {
  const systemBlockedRows = blockedPolicyRows.filter((row) => row.userId === null);
  assert.equal(systemBlockedRows.length, 2);
  for (const row of systemBlockedRows) {
    assert.equal(
      scalar(
        port,
        database,
        `SELECT (
          outbox.idempotency_original_payload_sha256 =
            public.email_outbox_original_payload_sha256(
              NULL,
              ${sqlLiteral(row.to)},
              ${sqlLiteral(row.template)},
              ${sqlLiteral(row.version)},
              ${sqlLiteral(JSON.stringify(row.variables))}::jsonb
            )
          AND outbox.idempotency_original_payload_sha256 <>
            public.email_outbox_original_payload_sha256(
              NULL,
              ${sqlLiteral(row.to)},
              ${sqlLiteral(row.template)},
              ${sqlLiteral(row.version)},
              ${sqlLiteral(JSON.stringify(row.replayVariables))}::jsonb
            )
        )::text
        FROM public.email_outbox AS outbox
        WHERE outbox.id = '${row.id}'::uuid;`,
      ),
      "true",
      `${row.template} blocked row did not preserve its exact stored payload`,
    );
  }
  for (const [index, row] of blockedPolicyRows.entries()) {
    const replayOperationId = fixtureUuid("77", index + 1);
    const replay = {
      ...row,
      id: fixtureUuid("78", index + 1),
      operationId: replayOperationId,
      key: row.stableKey,
      variables: row.userId === null
        ? {
            ...row.replayVariables,
            _mailOperationId: replayOperationId,
          }
        : row.variables,
    };
    assert.equal(
      scalar(
        port,
        database,
        `${insertOutboxSql(replay, { eventAuthority: true })}
         RETURNING id;`,
        "learncoding_app",
      ),
      replay.id,
      `${row.template} native replay was suppressed by a blocked legacy row`,
    );
  }
  assert.equal(
    scalar(
      port,
      database,
      `SELECT count(*)::text FROM public.email_outbox
        WHERE id = ANY(ARRAY[
          ${blockedPolicyRows.map(
            (_row, index) => `'${fixtureUuid("78", index + 1)}'::uuid`,
          ).join(",")}
        ]);`,
    ),
    String(blockedPolicyRows.length),
  );
  const inactivityV2BlockedRows = blockedPolicyRows.filter((row) =>
    ["inactivity-reminder", "inactivity-reminder-followup"].includes(
      row.template,
    )
  );
  assert.deepEqual(
    inactivityV2BlockedRows.map((row) => [row.template, row.version]),
    [
      ["inactivity-reminder", "2"],
      ["inactivity-reminder-followup", "2"],
    ],
  );
  const inactivityV2DirectConflict = inactivityV2BlockedRows[0];
  assert.ok(inactivityV2DirectConflict);
  await expectDatabaseError(
    port,
    database,
    "learncoding_app",
    `${insertOutboxSql(
      {
        ...inactivityV2DirectConflict,
        id: fixtureUuid("78", 88),
        operationId: fixtureUuid("77", 88),
        variables: {
          ...inactivityV2DirectConflict.variables,
          name: "Forged inactivity-v2-direct-conflict",
        },
        key: inactivityV2DirectConflict.stableKey,
      },
      { eventAuthority: true },
    )};`,
    {
      code: "23505",
      constraint: "email_outbox_idempotency_authority_pkey",
      message: "email outbox idempotency event payload conflict",
    },
  );
  const reset = blockedPolicyRows.find(
    (row) => row.template === "reset-password",
  );
  assert.ok(reset);
  expectSqlFailure(
    port,
    database,
    "learncoding_app",
    `${insertOutboxSql(
      {
        ...reset,
        id: fixtureUuid("78", 90),
        operationId: fixtureUuid("77", 90),
        to: "changed-0067@example.invalid",
        key: reset.stableKey,
      },
      { eventAuthority: true },
    )};`,
    /idempotency event payload conflict/u,
  );
}

function newEventRow(sequence, eventId, overrides = {}) {
  const template = overrides.template ?? "storage-quota-changed";
  return {
    id: fixtureUuid("79", sequence),
    operationId: fixtureUuid("7a", sequence),
    userId: LEARNER_ID,
    to: LEARNER_EMAIL,
    template,
    version: "1",
    variables: overrides.variables ?? { fixture: eventId },
    key: accountEventKey(template, LEARNER_ID, eventId),
    ...overrides,
  };
}

async function proveSameStatementAuthority(port, database) {
  const constraintImmediate = newEventRow(89, "constraint-immediate-novel");
  assert.equal(
    scalar(
      port,
      database,
      `BEGIN;
       SET CONSTRAINTS email_outbox_idempotency_authority_fk IMMEDIATE;
       ${insertOutboxSql(
         constraintImmediate,
         { eventAuthority: true },
       )} RETURNING id;
       COMMIT;`,
      "learncoding_app",
    ),
    constraintImmediate.id,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        (SELECT id::text FROM public.email_outbox
          WHERE idempotency_key = '${constraintImmediate.key}')
            = '${constraintImmediate.id}'
        AND EXISTS (
          SELECT 1
          FROM public.email_outbox_idempotency_authority AS authority
          JOIN public.email_outbox AS outbox
            ON outbox.idempotency_authority_sha256 =
               authority.idempotency_sha256
           AND outbox.idempotency_original_payload_sha256 =
               authority.original_payload_sha256
          WHERE outbox.id = '${constraintImmediate.id}'::uuid
            AND authority.idempotency_sha256 = '${constraintImmediate.key}'
        )
      )::text;`,
    ),
    "true",
    "an immediate FK must retain the novel row and matching authority",
  );
  const allImmediate = newEventRow(94, "constraint-all-immediate-novel");
  assert.equal(
    scalar(
      port,
      database,
      `BEGIN;
       SET CONSTRAINTS ALL IMMEDIATE;
       ${insertOutboxSql(
         allImmediate,
         { eventAuthority: true },
       )} RETURNING id;
       COMMIT;`,
      "learncoding_app",
    ),
    allImmediate.id,
  );
  const retroactiveImmediate = newEventRow(
    95,
    "constraint-retroactive-immediate-novel",
  );
  assert.equal(
    scalar(
      port,
      database,
      `BEGIN;
       SET CONSTRAINTS email_outbox_idempotency_authority_fk DEFERRED;
       ${insertOutboxSql(
         retroactiveImmediate,
         { eventAuthority: true },
       )} RETURNING id;
       SET CONSTRAINTS email_outbox_idempotency_authority_fk IMMEDIATE;
       COMMIT;`,
      "learncoding_app",
    ),
    retroactiveImmediate.id,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.count(*)::text
         FROM public.email_outbox AS outbox
         JOIN public.email_outbox_idempotency_authority AS authority
           ON authority.idempotency_sha256 =
                outbox.idempotency_authority_sha256
          AND authority.original_payload_sha256 =
                outbox.idempotency_original_payload_sha256
        WHERE outbox.id = ANY(ARRAY[
          '${constraintImmediate.id}'::uuid,
          '${allImmediate.id}'::uuid,
          '${retroactiveImmediate.id}'::uuid
        ]);`,
    ),
    "3",
  );
  process.stdout.write(
    "mail_durable_replay_0067=immediate_fk_modes:3:pass\n",
  );
  const exactFirst = newEventRow(90, "same-statement-exact");
  const exactSecond = {
    ...exactFirst,
    id: fixtureUuid("79", 91),
    operationId: fixtureUuid("7a", 91),
  };
  assert.equal(
    scalar(
      port,
      database,
      `${insertExactEventRowsSql([exactFirst, exactSecond])} RETURNING id;`,
      "learncoding_app",
    ),
    exactFirst.id,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        (SELECT id::text FROM public.email_outbox
          WHERE idempotency_key = '${exactFirst.key}') = '${exactFirst.id}'
        AND (SELECT pg_catalog.count(*)
          FROM public.email_outbox
          WHERE idempotency_key = '${exactFirst.key}') = 1
        AND (SELECT pg_catalog.count(*)
          FROM public.email_outbox_idempotency_authority
          WHERE idempotency_sha256 = '${exactFirst.key}') = 1
      )::text;`,
    ),
    "true",
  );

  const divergentFirst = newEventRow(92, "same-statement-divergent");
  const divergentSecond = {
    ...divergentFirst,
    id: fixtureUuid("79", 93),
    operationId: fixtureUuid("7a", 93),
    variables: { fixture: "same-statement-forged-payload" },
  };
  await expectDatabaseError(
    port,
    database,
    "learncoding_app",
    `${insertExactEventRowsSql([divergentFirst, divergentSecond])} RETURNING id;`,
    {
      code: "23505",
      constraint: "email_outbox_idempotency_authority_pkey",
    },
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        NOT EXISTS (
          SELECT 1 FROM public.email_outbox
           WHERE id = ANY(ARRAY[
             '${divergentFirst.id}'::uuid,
             '${divergentSecond.id}'::uuid
           ])
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.email_outbox_idempotency_authority
           WHERE idempotency_sha256 = '${divergentFirst.key}'
        )
      )::text;`,
    ),
    "true",
    "a divergent multi-row statement must roll back its row and authority",
  );
  const divergentRetry = {
    ...divergentFirst,
    id: fixtureUuid("79", 96),
    operationId: fixtureUuid("7a", 96),
  };
  assert.equal(
    scalar(
      port,
      database,
      `${insertOutboxSql(divergentRetry, { eventAuthority: true })}
       RETURNING id;`,
      "learncoding_app",
    ),
    divergentRetry.id,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
         (SELECT id::text FROM public.email_outbox
           WHERE idempotency_key = '${divergentRetry.key}')
           = '${divergentRetry.id}'
         AND (SELECT pg_catalog.count(*)
                FROM public.email_outbox
               WHERE idempotency_key = '${divergentRetry.key}') = 1
         AND (SELECT pg_catalog.count(*)
                FROM public.email_outbox_idempotency_authority
               WHERE idempotency_sha256 = '${divergentRetry.key}') = 1
       )::text;`,
    ),
    "true",
    "a clean retry must persist one row and one authority after rollback",
  );
}
function proveNewReplayAndRollback(port, database) {
  const row = newEventRow(1, "new-event");
  assert.equal(
    scalar(
      port,
      database,
      `${insertOutboxSql(row, { eventAuthority: true })} RETURNING id;`,
      "learncoding_app",
    ),
    row.id,
  );
  assert.equal(
    scalar(
      port,
      database,
      `${insertOutboxSql(
        {
          ...row,
          id: fixtureUuid("79", 2),
          operationId: fixtureUuid("7a", 2),
        },
        { eventAuthority: true },
      )} RETURNING id;`,
      "learncoding_app",
    ),
    "",
  );
  ownerSql(
    port,
    database,
    `DELETE FROM public.email_outbox WHERE id = '${row.id}'::uuid;`,
  );
  assert.equal(
    scalar(
      port,
      database,
      `${insertOutboxSql(
        {
          ...row,
          id: fixtureUuid("79", 3),
          operationId: fixtureUuid("7a", 3),
        },
        { eventAuthority: true },
      )} RETURNING id;`,
      "learncoding_app",
    ),
    "",
  );

  const rollback = newEventRow(10, "rollback-event");
  psql(
    port,
    database,
    `BEGIN;
     ${insertOutboxSql(rollback, { eventAuthority: true })};
     ROLLBACK;`,
    { username: "learncoding_app" },
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        NOT EXISTS (
          SELECT 1 FROM public.email_outbox
           WHERE idempotency_key = '${rollback.key}'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.email_outbox_idempotency_authority
           WHERE idempotency_sha256 = '${rollback.key}'
        )
      )::text;`,
    ),
    "true",
  );
  assert.equal(
    scalar(
      port,
      database,
      `${insertOutboxSql(
        {
          ...rollback,
          id: fixtureUuid("79", 11),
          operationId: fixtureUuid("7a", 11),
        },
        { eventAuthority: true },
      )} RETURNING id;`,
      "learncoding_app",
    ),
    fixtureUuid("79", 11),
  );
}

async function proveUnrelatedConflictCannotOrphanAuthority(port, database) {
  const duplicateOperationId = fixtureUuid("76", 100);
  const row = newEventRow(50, "unrelated-operation-conflict", {
    operationId: duplicateOperationId,
  });
  assert.equal(
    scalar(
      port,
      database,
      `BEGIN;
       SET CONSTRAINTS ALL IMMEDIATE;
       ${insertOutboxSql(row, { eventAuthority: true })}
       ON CONFLICT DO NOTHING
       RETURNING id;
       COMMIT;`,
      "learncoding_app",
    ),
    "",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        NOT EXISTS (
          SELECT 1 FROM public.email_outbox
           WHERE idempotency_key = '${row.key}'
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.email_outbox_idempotency_authority
           WHERE idempotency_sha256 = '${row.key}'
        )
      )::text;`,
    ),
    "true",
    "an unrelated ON CONFLICT must not create replay authority",
  );
  const retry = {
    ...row,
    id: fixtureUuid("79", 51),
    operationId: fixtureUuid("7a", 51),
  };
  assert.equal(
    scalar(
      port,
      database,
      `${insertOutboxSql(retry, { eventAuthority: true })} RETURNING id;`,
      "learncoding_app",
    ),
    retry.id,
  );

  const heldOperationId = fixtureUuid("87", 1);
  const heldBlocker = newEventRow(120, "held-conflict-blocker", {
    operationId: heldOperationId,
  });
  const heldSkipped = newEventRow(121, "held-conflict-skipped", {
    operationId: heldOperationId,
  });
  const heldCommitMarker = "mail_0067_held_conflict_commit";
  const heldCommitWaiterMarker = "mail_0067_held_conflict_commit_waiter";
  const heldCommit = spawnPsql(
    port,
    database,
    "learncoding_app",
    `/* ${heldCommitMarker} */
     BEGIN;
     ${insertOutboxSql(heldBlocker, { eventAuthority: true })};
     SELECT pg_catalog.pg_sleep(1.5);
     COMMIT;`,
  );
  await waitForMarker(port, database, heldCommitMarker);
  const heldSkippedWaiter = spawnPsql(
    port,
    database,
    "learncoding_app",
    `/* ${heldCommitWaiterMarker} */
     ${insertOutboxSql(heldSkipped, { eventAuthority: true })}
     ON CONFLICT DO NOTHING;`,
  );
  await waitForMarker(
    port,
    database,
    heldCommitWaiterMarker,
    "transactionid",
  );
  const [heldCommitResult, heldSkippedResult] = await Promise.all([
    heldCommit.completed,
    heldSkippedWaiter.completed,
  ]);
  assert.equal(heldCommitResult.code, 0, heldCommitResult.stderr);
  assert.equal(heldSkippedResult.code, 0, heldSkippedResult.stderr);
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        NOT EXISTS (SELECT 1 FROM public.email_outbox
          WHERE idempotency_key = '${heldSkipped.key}')
        AND NOT EXISTS (
          SELECT 1 FROM public.email_outbox_idempotency_authority
           WHERE idempotency_sha256 = '${heldSkipped.key}'
        )
      )::text;`,
    ),
    "true",
  );
  const heldRetry = {
    ...heldSkipped,
    id: fixtureUuid("79", 122),
    operationId: fixtureUuid("7a", 122),
  };
  assert.equal(
    scalar(
      port,
      database,
      `${insertOutboxSql(heldRetry, { eventAuthority: true })} RETURNING id;`,
      "learncoding_app",
    ),
    heldRetry.id,
  );

  const rolledBackOperationId = fixtureUuid("87", 2);
  const rolledBackBlocker = newEventRow(123, "held-conflict-rollback", {
    operationId: rolledBackOperationId,
  });
  const rollbackWinner = newEventRow(124, "held-conflict-rollback-winner", {
    operationId: rolledBackOperationId,
  });
  const heldRollbackMarker = "mail_0067_held_conflict_rollback";
  const heldRollbackWaiterMarker = "mail_0067_held_conflict_rollback_waiter";
  const heldRollback = spawnPsql(
    port,
    database,
    "learncoding_app",
    `/* ${heldRollbackMarker} */
     BEGIN;
     ${insertOutboxSql(rolledBackBlocker, { eventAuthority: true })};
     SELECT pg_catalog.pg_sleep(1.5);
     ROLLBACK;`,
  );
  await waitForMarker(port, database, heldRollbackMarker);
  const rollbackWaiter = spawnPsql(
    port,
    database,
    "learncoding_app",
    `/* ${heldRollbackWaiterMarker} */
     ${insertOutboxSql(rollbackWinner, { eventAuthority: true })}
     ON CONFLICT DO NOTHING;`,
  );
  await waitForMarker(
    port,
    database,
    heldRollbackWaiterMarker,
    "transactionid",
  );
  const [heldRollbackResult, rollbackWaiterResult] = await Promise.all([
    heldRollback.completed,
    rollbackWaiter.completed,
  ]);
  assert.equal(heldRollbackResult.code, 0, heldRollbackResult.stderr);
  assert.equal(rollbackWaiterResult.code, 0, rollbackWaiterResult.stderr);
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        (SELECT id::text FROM public.email_outbox
          WHERE idempotency_key = '${rollbackWinner.key}') =
          '${rollbackWinner.id}'
        AND (SELECT pg_catalog.count(*)
          FROM public.email_outbox_idempotency_authority
          WHERE idempotency_sha256 = '${rollbackWinner.key}') = 1
      )::text;`,
    ),
    "true",
  );

  const doUpdateAttempt = newEventRow(125, "held-conflict-do-update", {
    operationId: heldOperationId,
  });
  assert.equal(
    scalar(
      port,
      database,
      `BEGIN;
       SET CONSTRAINTS ALL IMMEDIATE;
       ${insertOutboxSql(doUpdateAttempt, { eventAuthority: true })}
       ON CONFLICT (operation_id) DO UPDATE
         SET updated_at = email_outbox.updated_at
       RETURNING id;
       COMMIT;`,
      "learncoding_app",
    ),
    heldBlocker.id,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        NOT EXISTS (SELECT 1 FROM public.email_outbox
          WHERE idempotency_key = '${doUpdateAttempt.key}')
        AND NOT EXISTS (
          SELECT 1 FROM public.email_outbox_idempotency_authority
           WHERE idempotency_sha256 = '${doUpdateAttempt.key}'
        )
      )::text;`,
    ),
    "true",
  );
  const doUpdateRetry = {
    ...doUpdateAttempt,
    id: fixtureUuid("79", 126),
    operationId: fixtureUuid("7a", 126),
  };
  assert.equal(
    scalar(
      port,
      database,
      `${insertOutboxSql(doUpdateRetry, { eventAuthority: true })}
       RETURNING id;`,
      "learncoding_app",
    ),
    doUpdateRetry.id,
  );
  process.stdout.write(
    "mail_durable_replay_0067=unrelated_conflict_no_orphan:pass\n",
  );
}

function proveNullDigestConstraintIsFailClosed(port, database) {
  const originalDigest = `public.email_outbox_original_payload_sha256(
    '${LEARNER_ID}', '${LEARNER_EMAIL}', 'storage-quota-changed', '1',
    '{"fixture":"null-digest"}'::jsonb
  )`;
  for (const [index, version] of [
    "event-v1-native",
    "event-v1-source-map",
  ].entries()) {
    const key = accountEventKey(
      "storage-quota-changed",
      LEARNER_ID,
      `null-digest-${version}`,
    );
    expectSqlFailure(
      port,
      database,
      "learncoding_migrator",
      `BEGIN;
       SET ROLE learncoding_owner;
       ALTER TABLE public.email_outbox DISABLE TRIGGER USER;
       INSERT INTO public.email_outbox (
         id, operation_id, user_id, delivery_scope_key, to_email, template,
         template_version, variables, idempotency_key,
         idempotency_authority_version, idempotency_authority_sha256,
         idempotency_original_payload_sha256, delivery_hold_version
       ) VALUES (
         '${fixtureUuid("7c", index + 1)}', '${fixtureUuid("7d", index + 1)}',
         '${LEARNER_ID}', 'a:${LEARNER_ID}', '${LEARNER_EMAIL}',
         'storage-quota-changed', '1', '{"fixture":"null-digest"}'::jsonb,
         '${key}', '${version}', NULL, ${originalDigest}, 'task7-v1'
       );
       ROLLBACK;`,
      /email_outbox_idempotency_authority_valid/u,
    );
  }
  const legacyId = fixtureUuid("7c", 3);
  assert.equal(
    scalar(
      port,
      database,
      `BEGIN;
       SET ROLE learncoding_owner;
       ALTER TABLE public.email_outbox DISABLE TRIGGER USER;
       INSERT INTO public.email_outbox (
         id, operation_id, user_id, delivery_scope_key, to_email, template,
         template_version, variables, idempotency_key,
         idempotency_authority_version, idempotency_authority_sha256,
         idempotency_original_payload_sha256, delivery_hold_version
       ) VALUES (
         '${legacyId}', '${fixtureUuid("7d", 3)}', '${LEARNER_ID}',
         'a:${LEARNER_ID}', '${LEARNER_EMAIL}', 'storage-quota-changed',
         '1', '{"fixture":"legacy-null"}'::jsonb, 'legacy-null-digest-proof',
         'legacy-key-blocked-v1', NULL,
         public.email_outbox_original_payload_sha256(
           '${LEARNER_ID}', '${LEARNER_EMAIL}', 'storage-quota-changed',
           '1', '{"fixture":"legacy-null"}'::jsonb
         ), 'task7-v1'
       ) RETURNING id;
       ROLLBACK;`,
      "learncoding_migrator",
    ),
    legacyId,
  );
}

async function proveClaimIsolationAndTimeout(port, database) {
  for (const [index, isolation] of [
    "REPEATABLE READ",
    "SERIALIZABLE",
  ].entries()) {
    const row = newEventRow(63 + index, `isolation-${index}`);
    expectSqlFailure(
      port,
      database,
      "learncoding_app",
      `BEGIN ISOLATION LEVEL ${isolation};
       ${insertOutboxSql(row, { eventAuthority: true })};
       COMMIT;`,
      /replay authority requires read committed isolation/u,
    );
  }
  const readCommitted = newEventRow(65, "isolation-read-committed");
  psql(
    port,
    database,
    `BEGIN ISOLATION LEVEL READ COMMITTED;
     ${insertOutboxSql(readCommitted, { eventAuthority: true })};
     ROLLBACK;`,
    { username: "learncoding_app" },
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        NOT EXISTS (SELECT 1 FROM public.email_outbox
          WHERE id = '${readCommitted.id}'::uuid)
        AND NOT EXISTS (
          SELECT 1 FROM public.email_outbox_idempotency_authority
          WHERE idempotency_sha256 = '${readCommitted.key}'
        )
      )::text;`,
    ),
    "true",
  );

  const successfulRestore = newEventRow(66, "lock-timeout-success-restore");
  assert.equal(
    scalar(
      port,
      database,
      `BEGIN;
       SET LOCAL lock_timeout = '0';
       ${insertOutboxSql(successfulRestore, { eventAuthority: true })};
       SELECT pg_catalog.current_setting('lock_timeout');
       ROLLBACK;`,
      "learncoding_app",
    ),
    "0",
  );

  const runBlockedProbe = async ({
    row,
    marker,
    callerTimeout,
    expectedSetting,
    holderSeconds,
    minimumMs,
    maximumMs,
  }) => {
    const holder = spawnPsql(
      port,
      database,
      "learncoding_app",
      `/* ${marker} */
       BEGIN;
       SELECT pg_catalog.pg_advisory_xact_lock(
         pg_catalog.hashtextextended('${row.key}', 0)
       );
       SELECT pg_catalog.pg_sleep(${holderSeconds});
       COMMIT;`,
    );
    await waitForMarker(port, database, marker);
    const startedAt = Date.now();
    const observedSetting = scalar(
      port,
      database,
      `SET lock_timeout = '${callerTimeout}';
       DO $lock_timeout_probe$
       BEGIN
         BEGIN
           ${insertOutboxSql(row, { eventAuthority: true })};
           RAISE EXCEPTION 'lock timeout probe unexpectedly inserted';
         EXCEPTION
           WHEN lock_not_available THEN
             IF pg_catalog.current_setting('lock_timeout') <>
                '${expectedSetting}'
             THEN
               RAISE EXCEPTION 'claim trigger did not restore lock_timeout';
             END IF;
         END;
       END
       $lock_timeout_probe$;
       SELECT pg_catalog.current_setting('lock_timeout');`,
      "learncoding_app",
    );
    const elapsedMs = Date.now() - startedAt;
    assert.equal(observedSetting, expectedSetting);
    assert.ok(
      elapsedMs >= minimumMs && elapsedMs <= maximumMs,
      `${marker} elapsed ${elapsedMs}ms outside ${minimumMs}-${maximumMs}ms`,
    );
    assert.equal(
      scalar(
        port,
        database,
        `SELECT (
          NOT EXISTS (SELECT 1 FROM public.email_outbox
            WHERE id = '${row.id}'::uuid)
          AND NOT EXISTS (
            SELECT 1 FROM public.email_outbox_idempotency_authority
             WHERE idempotency_sha256 = '${row.key}'
          )
        )::text;`,
      ),
      "true",
    );
    const holderResult = await holder.completed;
    assert.equal(holderResult.code, 0, holderResult.stderr);
    assert.equal(
      scalar(
        port,
        database,
        `${insertOutboxSql(row, { eventAuthority: true })} RETURNING id;`,
        "learncoding_app",
      ),
      row.id,
    );
  };

  await runBlockedProbe({
    row: newEventRow(67, "lock-timeout-default"),
    marker: "mail_0067_lock_timeout_default",
    callerTimeout: "0",
    expectedSetting: "0",
    holderSeconds: 7,
    minimumMs: 4_000,
    maximumMs: 6_500,
  });
  await runBlockedProbe({
    row: newEventRow(68, "lock-timeout-strict"),
    marker: "mail_0067_lock_timeout_strict",
    callerTimeout: "125ms",
    expectedSetting: "125ms",
    holderSeconds: 2,
    minimumMs: 75,
    maximumMs: 1_500,
  });
}
async function proveConcurrentClaims(port, database) {
  const committed = newEventRow(20, "concurrent-commit");
  const commitMarker = "mail_0067_concurrent_commit";
  const commitWaiterApplication = "mail_0067_concurrent_commit_waiter";
  const winner = spawnPsql(
    port,
    database,
    "learncoding_app",
    `/* ${commitMarker} */
     BEGIN;
     ${insertOutboxSql(committed, { eventAuthority: true })};
     SELECT pg_catalog.pg_sleep(2);
     COMMIT;`,
  );
  await waitForMarker(port, database, commitMarker);
  const replay = spawnPsql(
    port,
    database,
    "learncoding_app",
    `SET application_name = ${sqlLiteral(commitWaiterApplication)};
     ${insertOutboxSql(
      {
        ...committed,
        id: fixtureUuid("79", 21),
        operationId: fixtureUuid("7a", 21),
      },
      { eventAuthority: true },
    )};`,
  );
  await waitForAdvisoryLockWaiter(port, database, commitWaiterApplication);
  const [winnerResult, replayResult] = await Promise.all([
    winner.completed,
    replay.completed,
  ]);
  assert.equal(winnerResult.code, 0, winnerResult.stderr);
  assert.equal(replayResult.code, 0, replayResult.stderr);
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        (SELECT id::text FROM public.email_outbox
          WHERE idempotency_key = '${committed.key}') = '${committed.id}'
        AND (SELECT count(*)
          FROM public.email_outbox_idempotency_authority
          WHERE idempotency_sha256 = '${committed.key}') = 1
      )::text;`,
    ),
    "true",
  );

  const rolledBack = newEventRow(30, "concurrent-rollback");
  const rollbackMarker = "mail_0067_concurrent_rollback";
  const rollbackWaiterApplication = "mail_0067_concurrent_rollback_waiter";
  const transient = spawnPsql(
    port,
    database,
    "learncoding_app",
    `/* ${rollbackMarker} */
     BEGIN;
     ${insertOutboxSql(rolledBack, { eventAuthority: true })};
     SELECT pg_catalog.pg_sleep(2);
     ROLLBACK;`,
  );
  await waitForMarker(port, database, rollbackMarker);
  const retryRow = {
    ...rolledBack,
    id: fixtureUuid("79", 31),
    operationId: fixtureUuid("7a", 31),
  };
  const retry = spawnPsql(
    port,
    database,
    "learncoding_app",
    `SET application_name = ${sqlLiteral(rollbackWaiterApplication)};
     ${insertOutboxSql(retryRow, { eventAuthority: true })};`,
  );
  await waitForAdvisoryLockWaiter(port, database, rollbackWaiterApplication);
  const [transientResult, retryResult] = await Promise.all([
    transient.completed,
    retry.completed,
  ]);
  assert.equal(transientResult.code, 0, transientResult.stderr);
  assert.equal(retryResult.code, 0, retryResult.stderr);
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        (SELECT id::text FROM public.email_outbox
          WHERE idempotency_key = '${rolledBack.key}') = '${retryRow.id}'
        AND (SELECT count(*)
          FROM public.email_outbox_idempotency_authority
          WHERE idempotency_sha256 = '${rolledBack.key}') = 1
      )::text;`,
    ),
    "true",
  );

  const committedDivergent = newEventRow(100, "concurrent-divergent-commit");
  const divergentCommitMarker = "mail_0067_divergent_commit_holder";
  const divergentCommitWaiterMarker = "mail_0067_divergent_commit_waiter";
  const divergentCommitHolder = spawnPsql(
    port,
    database,
    "learncoding_app",
    `/* ${divergentCommitMarker} */
     BEGIN;
     ${insertOutboxSql(committedDivergent, { eventAuthority: true })};
     SELECT pg_catalog.pg_sleep(1.5);
     COMMIT;`,
  );
  await waitForMarker(port, database, divergentCommitMarker);
  const divergentLoser = {
    ...committedDivergent,
    id: fixtureUuid("79", 101),
    operationId: fixtureUuid("7a", 101),
    variables: { fixture: "concurrent-divergent-forged" },
  };
  const divergentLoserError = expectDatabaseError(
    port,
    database,
    "learncoding_app",
    `/* ${divergentCommitWaiterMarker} */
     ${insertOutboxSql(divergentLoser, { eventAuthority: true })}
     ON CONFLICT (idempotency_key) DO NOTHING;`,
    {
      code: "23505",
      constraint: "email_outbox_idempotency_authority_pkey",
    },
  );
  await waitForMarker(
    port,
    database,
    divergentCommitWaiterMarker,
    "advisory",
  );
  const [divergentCommitHolderResult] = await Promise.all([
    divergentCommitHolder.completed,
    divergentLoserError,
  ]);
  assert.equal(
    divergentCommitHolderResult.code,
    0,
    divergentCommitHolderResult.stderr,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        (SELECT id::text FROM public.email_outbox
          WHERE idempotency_key = '${committedDivergent.key}') =
          '${committedDivergent.id}'
        AND NOT EXISTS (SELECT 1 FROM public.email_outbox
          WHERE id = '${divergentLoser.id}'::uuid)
        AND (SELECT original_payload_sha256
          FROM public.email_outbox_idempotency_authority
          WHERE idempotency_sha256 = '${committedDivergent.key}') =
          public.email_outbox_original_payload_sha256(
            '${committedDivergent.userId}', '${committedDivergent.to}',
            '${committedDivergent.template}', '${committedDivergent.version}',
            ${sqlLiteral(JSON.stringify(committedDivergent.variables))}::jsonb
          )
      )::text;`,
    ),
    "true",
  );

  const rolledBackDivergent = newEventRow(
    102,
    "concurrent-divergent-rollback",
  );
  const divergentRollbackMarker = "mail_0067_divergent_rollback_holder";
  const divergentRollbackWaiterMarker = "mail_0067_divergent_rollback_waiter";
  const divergentRollbackHolder = spawnPsql(
    port,
    database,
    "learncoding_app",
    `/* ${divergentRollbackMarker} */
     BEGIN;
     ${insertOutboxSql(rolledBackDivergent, { eventAuthority: true })};
     SELECT pg_catalog.pg_sleep(1.5);
     ROLLBACK;`,
  );
  await waitForMarker(port, database, divergentRollbackMarker);
  const divergentRollbackWinner = {
    ...rolledBackDivergent,
    id: fixtureUuid("79", 103),
    operationId: fixtureUuid("7a", 103),
    variables: { fixture: "concurrent-divergent-survivor" },
  };
  const divergentRollbackWaiter = spawnPsql(
    port,
    database,
    "learncoding_app",
    `/* ${divergentRollbackWaiterMarker} */
     ${insertOutboxSql(divergentRollbackWinner, { eventAuthority: true })}
     ON CONFLICT (idempotency_key) DO NOTHING;`,
  );
  await waitForMarker(
    port,
    database,
    divergentRollbackWaiterMarker,
    "advisory",
  );
  const [divergentRollbackHolderResult, divergentRollbackWaiterResult] =
    await Promise.all([
      divergentRollbackHolder.completed,
      divergentRollbackWaiter.completed,
    ]);
  assert.equal(
    divergentRollbackHolderResult.code,
    0,
    divergentRollbackHolderResult.stderr,
  );
  assert.equal(
    divergentRollbackWaiterResult.code,
    0,
    divergentRollbackWaiterResult.stderr,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        (SELECT id::text FROM public.email_outbox
          WHERE idempotency_key = '${rolledBackDivergent.key}') =
          '${divergentRollbackWinner.id}'
        AND (SELECT original_payload_sha256
          FROM public.email_outbox_idempotency_authority
          WHERE idempotency_sha256 = '${rolledBackDivergent.key}') =
          public.email_outbox_original_payload_sha256(
            '${divergentRollbackWinner.userId}',
            '${divergentRollbackWinner.to}',
            '${divergentRollbackWinner.template}',
            '${divergentRollbackWinner.version}',
            ${sqlLiteral(JSON.stringify(divergentRollbackWinner.variables))}::jsonb
          )
      )::text;`,
    ),
    "true",
  );}

async function proveCoverageTimeoutSemantics(port, database) {
  const runCoverageBlockedProbe = async ({
    row,
    marker,
    callerTimeout,
    expectedSetting,
    holderSeconds,
    minimumMs,
    maximumMs,
  }) => {
    assert.equal(
      scalar(
        port,
        database,
        `${insertOutboxSql(row, { eventAuthority: true })} RETURNING id;`,
        "learncoding_app",
      ),
      row.id,
    );
    const holder = spawnPsql(
      port,
      database,
      "learncoding_migrator",
      `/* ${marker} */
       BEGIN;
       SET ROLE learncoding_owner;
       SELECT id
         FROM public.email_outbox
        WHERE id = '${row.id}'::uuid
        FOR UPDATE;
       SELECT pg_catalog.pg_sleep(${holderSeconds});
       COMMIT;`,
    );
    await waitForMarker(port, database, marker);

    let probeError;
    let observedSetting;
    let elapsedMs;
    const startedAt = Date.now();
    try {
      observedSetting = scalar(
        port,
        database,
        `SET lock_timeout = '${callerTimeout}';
         DO $coverage_timeout_probe$
         BEGIN
           BEGIN
             PERFORM
               public.email_outbox_idempotency_coverage_authority(
                 ARRAY['${row.id}'::uuid]
               );
             RAISE EXCEPTION
               'coverage timeout probe unexpectedly acquired the row';
           EXCEPTION
             WHEN lock_not_available THEN
               IF pg_catalog.current_setting('lock_timeout') <>
                  '${expectedSetting}'
               THEN
                 RAISE EXCEPTION
                   'coverage authority did not restore lock_timeout';
               END IF;
           END;
         END
         $coverage_timeout_probe$;
         SELECT pg_catalog.current_setting('lock_timeout');`,
        "learncoding_ops",
      );
      elapsedMs = Date.now() - startedAt;
    } catch (error) {
      probeError = error;
    }

    let holderResult;
    try {
      holderResult = await settleWithin(
        holder.completed,
        `${marker} holder completion`,
        CHILD_TIMEOUT_MS,
      );
    } catch (cleanupError) {
      if (probeError !== undefined) {
        throw new AggregateError(
          [probeError, cleanupError],
          `${marker} probe and holder cleanup failed`,
          { cause: probeError },
        );
      }
      throw cleanupError;
    }
    if (probeError !== undefined) throw probeError;
    assert.equal(holderResult.code, 0, holderResult.stderr);
    assert.equal(observedSetting, expectedSetting);
    assert.ok(
      elapsedMs >= minimumMs && elapsedMs <= maximumMs,
      `${marker} elapsed ${elapsedMs}ms outside ${minimumMs}-${maximumMs}ms`,
    );
    assert.equal(
      scalar(
        port,
        database,
        `SELECT public.email_outbox_idempotency_coverage_authority(
           ARRAY['${row.id}'::uuid]
         )::text;`,
        "learncoding_ops",
      ),
      "true",
    );
  };

  await runCoverageBlockedProbe({
    row: newEventRow(140, "coverage-timeout-default"),
    marker: "mail_0067_coverage_timeout_default",
    callerTimeout: "0",
    expectedSetting: "0",
    holderSeconds: 7,
    minimumMs: 4_000,
    maximumMs: 6_500,
  });
  await runCoverageBlockedProbe({
    row: newEventRow(141, "coverage-timeout-strict"),
    marker: "mail_0067_coverage_timeout_strict",
    callerTimeout: "125ms",
    expectedSetting: "125ms",
    holderSeconds: 2,
    minimumMs: 75,
    maximumMs: 1_500,
  });
  process.stdout.write(
    "mail_durable_replay_0067=coverage_timeout_restore:2:pass\n",
  );
}

async function proveCoverageLockAndTerminalReplay(
  port,
  database,
  terminalReplayRow,
) {
  await proveCoverageTimeoutSemantics(port, database);
  const row = terminalReplayRow;
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.concat_ws(
         '|', status, idempotency_authority_version,
         idempotency_authority_sha256
       )
       FROM public.email_outbox
       WHERE id = '${row.id}'::pg_catalog.uuid;`,
    ),
    `sent|event-v1-source-map|${row.stableKey}`,
    "terminal replay fixture was not atomically held by the cutover",
  );
  const marker = "mail_0067_coverage_lock";
  const holder = spawnPsql(
    port,
    database,
    "learncoding_ops",
    `/* ${marker} */
     BEGIN;
     SELECT public.email_outbox_idempotency_coverage_authority(
       ARRAY['${row.id}'::uuid]
     );
     SELECT pg_catalog.pg_sleep(0.75);
     COMMIT;`,
  );
  await waitForMarker(port, database, marker);
  const blocked = psql(
    port,
    database,
    `SET lock_timeout = '150ms';
     SET ROLE learncoding_owner;
     DELETE FROM public.email_outbox WHERE id = '${row.id}'::uuid;`,
    {
      username: "learncoding_migrator",
      allowFailure: true,
      timeoutMs: 5_000,
    },
  );
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /lock timeout/u);
  const holderResult = await holder.completed;
  assert.equal(holderResult.code, 0, holderResult.stderr);

  assert.equal(
    scalar(
      port,
      database,
      `BEGIN;
       SELECT public.email_outbox_idempotency_coverage_authority(
         ARRAY['${row.id}'::uuid]
       )::text;
       DELETE FROM public.email_outbox WHERE id = '${row.id}'::uuid;
       COMMIT;`,
      "learncoding_ops",
    ),
    "true",
  );
  assert.equal(
    scalar(
      port,
      database,
      `${insertOutboxSql(
        {
          ...row,
          id: fixtureUuid("79", 41),
          operationId: fixtureUuid("7a", 41),
          key: row.stableKey,
        },
        { eventAuthority: true },
      )} RETURNING id;`,
      "learncoding_app",
    ),
    "",
  );

  const snapshotExisting = newEventRow(130, "coverage-snapshot-existing", {
    id: fixtureUuid("8a", 1),
    operationId: fixtureUuid("8b", 1),
  });
  const snapshotLate = newEventRow(131, "coverage-snapshot-late", {
    id: fixtureUuid("8a", 2),
    operationId: fixtureUuid("8b", 2),
  });
  assert.equal(
    scalar(
      port,
      database,
      `${insertOutboxSql(snapshotExisting, { eventAuthority: true })}
       RETURNING id;`,
      "learncoding_app",
    ),
    snapshotExisting.id,
  );
  const snapshotControllerApplication =
    "mail_0067_coverage_snapshot_controller";
  const snapshotHolderApplication = "mail_0067_coverage_snapshot_holder";
  const snapshotWaiterMarker = "mail_0067_coverage_snapshot_waiter";
  const coverageSnapshotController = createTrackedClient(isolatedClientConfig({
    applicationName: snapshotControllerApplication,
    database,
    port,
    user: "postgres",
  }));
  let coverageGateHeld = false;
  let snapshotHolder;
  let snapshotCoverage;
  let snapshotHolderWork;
  let snapshotHolderOutcome;
  let snapshotCoverageOutcome;
  let operationError;
  const cleanupFailures = [];
  try {
    await connectClientWithin(
      coverageSnapshotController,
      "coverage snapshot controller",
    );
    await coverageSnapshotController.query(
      `SELECT pg_catalog.pg_advisory_lock(
         ${COVERAGE_SNAPSHOT_GATE}::pg_catalog.int8
       );`,
    );
    coverageGateHeld = true;
    snapshotHolder = spawnPsql(
      port,
      database,
      "learncoding_migrator",
      `SET application_name = ${sqlLiteral(snapshotHolderApplication)};
       BEGIN;
       SET ROLE learncoding_owner;
       SELECT id FROM public.email_outbox
        WHERE id = '${snapshotExisting.id}'::uuid
        FOR UPDATE;
       SELECT pg_catalog.pg_advisory_xact_lock(
         ${COVERAGE_SNAPSHOT_GATE}::pg_catalog.int8
       );
       COMMIT;`,
    );
    snapshotHolderWork = observePromiseOutcome(
      snapshotHolder.completed,
    );
    await waitForCutoverAdvisoryLockTopology(
      coverageSnapshotController,
      {
        controllerApplicationName: snapshotControllerApplication,
        gateKey: COVERAGE_SNAPSHOT_GATE,
        waiterApplicationName: snapshotHolderApplication,
      },
    );
    snapshotCoverage = observePromiseOutcome(
      queryDatabase(
        port,
        database,
        "learncoding_ops",
        `/* ${snapshotWaiterMarker} */
         SELECT public.email_outbox_idempotency_coverage_authority(
           ARRAY[
             '${snapshotExisting.id}'::uuid,
             '${snapshotLate.id}'::uuid
           ]
         ) AS covered;`,
      ),
    );
    await waitForCoverageSnapshotTopology(
      coverageSnapshotController,
      {
        controllerApplicationName: snapshotControllerApplication,
        gateKey: COVERAGE_SNAPSHOT_GATE,
        holderApplicationName: snapshotHolderApplication,
        waiterMarker: snapshotWaiterMarker,
      },
    );
    const snapshotLateCommitted = scalar(
      port,
      database,
      `${insertOutboxSql(snapshotLate, { eventAuthority: true })}
       RETURNING id;`,
      "learncoding_app",
    );
    assert.equal(snapshotLateCommitted, snapshotLate.id);
    await releaseControllerGate(
      coverageSnapshotController,
      COVERAGE_SNAPSHOT_GATE,
    );
    coverageGateHeld = false;
    snapshotHolderOutcome = await settleWithin(
      snapshotHolderWork,
      "coverage snapshot holder",
    );
    if (snapshotHolderOutcome.status === "rejected") {
      throw snapshotHolderOutcome.error;
    }
    const snapshotHolderResult = snapshotHolderOutcome.value;
    snapshotCoverageOutcome = await settleWithin(
      snapshotCoverage,
      "coverage snapshot query",
    );
    if (snapshotCoverageOutcome.status === "rejected") {
      throw snapshotCoverageOutcome.error;
    }
    const snapshotCoverageResult = snapshotCoverageOutcome.value;
    assert.equal(
      snapshotHolderResult.code,
      0,
      snapshotHolderResult.stderr,
    );
    assert.equal(snapshotCoverageResult.rows[0]?.covered, false);
  } catch (error) {
    operationError = error;
  } finally {
    if (coverageGateHeld) {
      await runCleanupStep(
        cleanupFailures,
        () => releaseControllerGate(
          coverageSnapshotController,
          COVERAGE_SNAPSHOT_GATE,
        ),
        "coverage snapshot gate release",
      );
    }
    if (snapshotHolder !== undefined) {
      await runCleanupStep(
        cleanupFailures,
        () => snapshotHolder.terminate(),
        "coverage snapshot holder termination",
      );
    }
    if (
      snapshotHolderWork !== undefined
      && snapshotHolderOutcome === undefined
    ) {
      await runCleanupStep(
        cleanupFailures,
        async () => {
          const outcome = await snapshotHolderWork;
          if (outcome.status === "rejected") throw outcome.error;
        },
        "coverage snapshot holder observation",
      );
    }
    if (
      snapshotCoverage !== undefined
      && snapshotCoverageOutcome === undefined
    ) {
      await runCleanupStep(
        cleanupFailures,
        async () => {
          const outcome = await snapshotCoverage;
          if (outcome.status === "rejected") throw outcome.error;
        },
        "coverage snapshot query cleanup",
      );
    }
    await runCleanupStep(
      cleanupFailures,
      () => closeClientWithin(
        coverageSnapshotController,
        "coverage snapshot controller",
      ),
      "coverage snapshot controller cleanup",
    );
  }
  if (operationError !== undefined || cleanupFailures.length > 0) {
    throw preserveOperationAndCleanupFailures(
      operationError,
      cleanupFailures,
      "coverage snapshot operation and cleanup failed",
    );
  }
  ownerSql(
    port,
    database,
    `
      WITH generated AS (
        SELECT
          sequence,
          ('88000000-0000-4000-8000-' ||
            pg_catalog.lpad(sequence::text, 12, '0'))::uuid AS id,
          ('89000000-0000-4000-8000-' ||
            pg_catalog.lpad(sequence::text, 12, '0'))::uuid AS operation_id,
          pg_catalog.jsonb_build_object(
            'fixture', 'coverage-bulk-' || sequence::text
          ) AS variables,
          pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                'coverage-bulk-key:' || sequence::text,
                'UTF8'
              )
            ),
            'hex'
          ) AS authority_sha256
        FROM pg_catalog.generate_series(1, 5000) AS source(sequence)
      ), authority_rows AS (
        SELECT
          authority_sha256,
          public.email_outbox_original_payload_sha256(
            '${LEARNER_ID}', '${LEARNER_EMAIL}',
            'storage-quota-changed', '1', variables
          ) AS original_payload_sha256
        FROM generated
      )
      INSERT INTO public.email_outbox_idempotency_authority (
        idempotency_sha256, original_payload_sha256
      )
      SELECT authority_sha256, original_payload_sha256
      FROM authority_rows;

      ALTER TABLE public.email_outbox
        DISABLE TRIGGER email_outbox_idempotency_claim;
      ALTER TABLE public.email_outbox
        DISABLE TRIGGER "00_email_outbox_idempotency_persist";
      ALTER TABLE public.email_outbox
        DISABLE TRIGGER email_outbox_idempotency_metadata_immutable;

      WITH generated AS (
        SELECT
          sequence,
          ('88000000-0000-4000-8000-' ||
            pg_catalog.lpad(sequence::text, 12, '0'))::uuid AS id,
          ('89000000-0000-4000-8000-' ||
            pg_catalog.lpad(sequence::text, 12, '0'))::uuid AS operation_id,
          pg_catalog.jsonb_build_object(
            'fixture', 'coverage-bulk-' || sequence::text
          ) AS variables,
          pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                'coverage-bulk-key:' || sequence::text,
                'UTF8'
              )
            ),
            'hex'
          ) AS authority_sha256
        FROM pg_catalog.generate_series(1, 5000) AS source(sequence)
      )
      INSERT INTO public.email_outbox (
        id, operation_id, user_id, delivery_scope_key, to_email, template,
        template_version, variables, idempotency_key,
        idempotency_authority_version, idempotency_authority_sha256,
        idempotency_original_payload_sha256, delivery_hold_version
      )
      SELECT
        id, operation_id, '${LEARNER_ID}', 'a:${LEARNER_ID}',
        '${LEARNER_EMAIL}', 'storage-quota-changed', '1', variables,
        authority_sha256, 'event-v1-native', authority_sha256,
        public.email_outbox_original_payload_sha256(
          '${LEARNER_ID}', '${LEARNER_EMAIL}',
          'storage-quota-changed', '1', variables
        ), 'task7-v1'
      FROM generated;

      ALTER TABLE public.email_outbox
        ENABLE ALWAYS TRIGGER email_outbox_idempotency_claim;
      ALTER TABLE public.email_outbox
        ENABLE ALWAYS TRIGGER "00_email_outbox_idempotency_persist";
      ALTER TABLE public.email_outbox
        ENABLE ALWAYS TRIGGER email_outbox_idempotency_metadata_immutable;
    `,
  );
  psql(
    port,
    database,
    "ANALYZE public.email_outbox;",
  );
  const replayLookupDigest = digest("coverage-bulk-key:1");
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.count(*)::text
         FROM public.email_outbox
        WHERE idempotency_authority_sha256 = '${replayLookupDigest}';`,
    ),
    "1",
  );
  const replayLookupPlan = await queryDatabase(
    port,
    database,
    "postgres",
    `EXPLAIN (FORMAT JSON)
     SELECT prior_outbox.idempotency_original_payload_sha256
       FROM public.email_outbox AS prior_outbox
      WHERE prior_outbox.idempotency_authority_sha256 =
        '${replayLookupDigest}'
      ORDER BY prior_outbox.id
      LIMIT 1;`,
  );
  const replayLookupPlanDocument = replayLookupPlan.rows[0]?.["QUERY PLAN"];
  assert.ok(Array.isArray(replayLookupPlanDocument));
  assert.match(
    JSON.stringify(replayLookupPlanDocument),
    /"Index Name":"email_outbox_idempotency_authority_lookup_idx"/u,
  );
  process.stdout.write(
    "mail_durable_replay_0067=lookup_index_catalog_planner_cardinality:pass\n",
  );

  const boundedIds = `ARRAY(
    SELECT ('88000000-0000-4000-8000-' ||
      pg_catalog.lpad(sequence::text, 12, '0'))::uuid
    FROM pg_catalog.generate_series(1, 5000) AS source(sequence)
  )`;
  assert.equal(
    scalar(
      port,
      database,
      `SELECT public.email_outbox_idempotency_coverage_authority(
         ${boundedIds}
       )::text;`,
      "learncoding_ops",
    ),
    "true",
  );
  const uncoveredFinalSentinel = fixtureUuid("8d", 1);
  const coveredWithMissingSentinelIds = `ARRAY(
    SELECT candidate.id
    FROM (
      SELECT
        sequence,
        ('88000000-0000-4000-8000-' ||
          pg_catalog.lpad(sequence::text, 12, '0'))::uuid AS id
      FROM pg_catalog.generate_series(1, 4999) AS source(sequence)
      UNION ALL
      SELECT 5000, '${uncoveredFinalSentinel}'::uuid
    ) AS candidate
    ORDER BY candidate.sequence
  )`;
  assert.equal(
    scalar(
      port,
      database,
      `SELECT public.email_outbox_idempotency_coverage_authority(
         ${coveredWithMissingSentinelIds}
       )::text;`,
      "learncoding_ops",
    ),
    "false",
    "4,999 covered rows plus an uncovered final sentinel must be false",
  );
  await expectDatabaseError(
    port,
    database,
    "learncoding_ops",
    `SELECT public.email_outbox_idempotency_coverage_authority(
       ARRAY(
         SELECT ('8c000000-0000-4000-8000-' ||
           pg_catalog.lpad(sequence::text, 12, '0'))::uuid
         FROM pg_catalog.generate_series(1, 5001) AS source(sequence)
       )
     );`,
    {
      code: "22023",
      constraint: undefined,
      message: "invalid email outbox idempotency coverage request",
    },
  );}

function proveFailClosedAndMutationProtection(port, database, retained) {
  for (const invalidInput of [
    "NULL::uuid[]",
    "ARRAY[]::uuid[]",
    `ARRAY['${retained[0].id}'::uuid, '${retained[0].id}'::uuid]`,
    `ARRAY['${retained[0].id}'::uuid, NULL::uuid]`,
  ]) {
    expectSqlFailure(
      port,
      database,
      "learncoding_ops",
      `SELECT public.email_outbox_idempotency_coverage_authority(
        ${invalidInput}
      );`,
      /invalid email outbox idempotency coverage request/u,
    );
  }
  assert.equal(
    scalar(
      port,
      database,
      `SELECT public.email_outbox_idempotency_coverage_authority(
        ARRAY['${fixtureUuid("7b", 1)}'::uuid]
      )::text;`,
      "learncoding_ops",
    ),
    "false",
  );
  expectSqlFailure(
    port,
    database,
    "learncoding_app",
    `INSERT INTO public.email_outbox_idempotency_authority (
       idempotency_sha256, original_payload_sha256
     ) VALUES ('${"d".repeat(64)}', '${"e".repeat(64)}');`,
    /permission denied/u,
  );
  for (const statement of [
    `UPDATE public.email_outbox_idempotency_authority
       SET original_payload_sha256 = '${"f".repeat(64)}'`,
    "DELETE FROM public.email_outbox_idempotency_authority",
    "TRUNCATE TABLE public.email_outbox_idempotency_authority, public.email_outbox",
  ]) {
    expectSqlFailure(
      port,
      database,
      "learncoding_migrator",
      `SET ROLE learncoding_owner;\n${statement};`,
      /idempotency authority is append-only/u,
    );
  }
  expectSqlFailure(
    port,
    database,
    "learncoding_migrator",
    `BEGIN;
     SET ROLE learncoding_owner;
     ALTER TABLE public.email_outbox
       DISABLE TRIGGER email_outbox_delivery_hold;
     UPDATE public.email_outbox
        SET idempotency_authority_version = 'event-v1-native'
      WHERE id = '${retained[0].id}'::uuid;`,
    /idempotency authority metadata is immutable/u,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT tgenabled::pg_catalog.text
         FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.email_outbox'::pg_catalog.regclass
          AND tgname = 'email_outbox_delivery_hold';`,
    ),
    "A",
    "failed metadata mutation must roll back the temporary trigger disable",
  );
}

function proveBackupCompatibility(port, database) {
  assert.equal(
    scalar(
      port,
      database,
      `SELECT acknowledgement
         FROM public.enqueue_backup_status_mail_authority(
           '${BACKUP_COMPATIBILITY_RUN_KEY}', 'failure'
         );`,
      "learncoding_backup_reporter",
    ),
    "queued",
  );
  const expectedKey = accountEventKey(
    "backup-status",
    ADMIN_ID,
    `failure:${BACKUP_COMPATIBILITY_RUN_KEY}`,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        outbox.idempotency_authority_version = 'event-v1-source-map'
        AND outbox.idempotency_authority_sha256 = '${expectedKey}'
        AND authority.original_payload_sha256 =
          outbox.idempotency_original_payload_sha256
      )::text
      FROM public.backup_status_mail_authority AS source
      JOIN public.email_outbox AS outbox ON outbox.id = source.outbox_id
      JOIN public.email_outbox_idempotency_authority AS authority
        ON authority.idempotency_sha256 =
          outbox.idempotency_authority_sha256
      WHERE source.run_key = '${BACKUP_COMPATIBILITY_RUN_KEY}';`,
    ),
    "true",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT acknowledgement
         FROM public.enqueue_backup_status_mail_authority(
           '${BACKUP_COMPATIBILITY_RUN_KEY}', 'failure'
         );`,
      "learncoding_backup_reporter",
    ),
    "existing",
  );
  expectSqlFailure(
    port,
    database,
    "learncoding_backup_reporter",
    `SELECT *
       FROM public.enqueue_backup_status_mail_authority(
         '${BACKUP_COMPATIBILITY_RUN_KEY}', 'success'
       );`,
    /replay conflicts with durable authority/u,
  );

  assert.equal(
    scalar(
      port,
      database,
      `SELECT acknowledgement
         FROM public.enqueue_backup_status_mail_authority(
           '${BACKUP_UUID_COMPATIBILITY_RUN_KEY}', 'success'
         );`,
      "learncoding_backup_reporter",
    ),
    "queued",
  );
  const expectedUuidKey = accountEventKey(
    "backup-status",
    ADMIN_ID,
    `success:${BACKUP_UUID_COMPATIBILITY_RUN_KEY}`,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        outbox.idempotency_authority_version = 'event-v1-source-map'
        AND outbox.idempotency_authority_sha256 = '${expectedUuidKey}'
        AND authority.original_payload_sha256 =
          outbox.idempotency_original_payload_sha256
      )::text
      FROM public.backup_status_mail_authority AS source
      JOIN public.email_outbox AS outbox ON outbox.id = source.outbox_id
      JOIN public.email_outbox_idempotency_authority AS authority
        ON authority.idempotency_sha256 =
          outbox.idempotency_authority_sha256
      WHERE source.run_key = '${BACKUP_UUID_COMPATIBILITY_RUN_KEY}';`,
    ),
    "true",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT acknowledgement
         FROM public.enqueue_backup_status_mail_authority(
           '${BACKUP_UUID_COMPATIBILITY_RUN_KEY}', 'success'
         );`,
      "learncoding_backup_reporter",
    ),
    "existing",
  );
  expectSqlFailure(
    port,
    database,
    "learncoding_backup_reporter",
    `SELECT *
       FROM public.enqueue_backup_status_mail_authority(
         '${BACKUP_UUID_COMPATIBILITY_RUN_KEY}', 'failure'
       );`,
    /replay conflicts with durable authority/u,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT acknowledgement
         FROM public.enqueue_backup_status_mail_authority(
           '${BACKUP_UUID_SECOND_RUN_KEY}', 'failure'
         );`,
      "learncoding_backup_reporter",
    ),
    "queued",
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT count(*)::text
         FROM public.backup_status_mail_authority
        WHERE run_key IN (
          '${BACKUP_UUID_COMPATIBILITY_RUN_KEY}',
          '${BACKUP_UUID_SECOND_RUN_KEY}'
        );`,
    ),
    "2",
  );
  for (const invalidRunKey of [
    BACKUP_UUID_COMPATIBILITY_RUN_KEY.toUpperCase(),
    "8b4f9fbe-d45a-1e4d-9c90-dfef3c8fce31",
  ]) {
    expectSqlFailure(
      port,
      database,
      "learncoding_backup_reporter",
      `SELECT *
         FROM public.enqueue_backup_status_mail_authority(
           '${invalidRunKey}', 'success'
         );`,
      /run key is invalid/u,
    );
  }
}

async function proveWriterInventoryRoutineCatalog(port, database) {
  const { BACKUP_STATUS_AUTHORITY_ROUTINES } =
    await import("../../scripts/verify-backup-status-mail-authority.mjs");
  const signature =
    "public.enqueue_backup_status_mail_authority(text,text)";
  const reviewed = BACKUP_STATUS_AUTHORITY_ROUTINES.find(
    (routine) => routine.signature === signature,
  );
  assert.ok(
    reviewed,
    "the writer inventory must bind to the reviewed backup authority manifest",
  );
  const expectedIdentityArguments = reviewed.argumentNames
    .slice(0, reviewed.inputArgumentCount)
    .map((name, index) => `${name} ${reviewed.argumentTypes[index]}`)
    .join(", ");
  const writerCatalogGraph = scalar(
    port,
    database,
    `WITH RECURSIVE user_routines AS (
       SELECT
         routine.oid,
         namespace.nspname AS schema_name,
         routine.proname AS routine_name,
         routine.prokind,
         language.lanname,
         pg_catalog.pg_get_function_identity_arguments(routine.oid)
           AS identity_arguments,
         pg_catalog.pg_get_functiondef(routine.oid) AS definition,
         routine.prosrc AS source,
         pg_catalog.regexp_count(
           routine.prosrc,
           '(^|[^[:alnum:]_])(insert[[:space:]]+into|copy|merge[[:space:]]+into)[[:space:]]+("?public"?[[:space:]]*[.][[:space:]]*)?"?email_outbox"?([^[:alnum:]_]|$)',
           1,
           'in'
         ) AS direct_write_count
       FROM pg_catalog.pg_proc AS routine
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = routine.pronamespace
       JOIN pg_catalog.pg_language AS language
         ON language.oid = routine.prolang
      WHERE routine.prokind IN ('f', 'p')
        AND namespace.nspname <> 'information_schema'
        AND namespace.nspname !~ '^pg_'
        AND NOT EXISTS (
          SELECT 1
            FROM pg_catalog.pg_depend AS dependency
           WHERE dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
             AND dependency.objid = routine.oid
             AND dependency.deptype = 'e'
        )
     ),
     direct_writers AS (
       SELECT *
         FROM user_routines
        WHERE direct_write_count > 0
     ),
     dynamic_routines AS (
       SELECT oid
         FROM user_routines
        WHERE lanname NOT IN ('sql', 'plpgsql')
           OR pg_catalog.regexp_count(
                source,
                '(^|[^[:alnum:]_])execute([[:space:]]|$)',
                1,
                'in'
              ) > 0
     ),
     call_edges AS (
       SELECT
         caller.oid AS caller_oid,
         callee.oid AS callee_oid
       FROM user_routines AS caller
       CROSS JOIN user_routines AS callee
      WHERE caller.oid <> callee.oid
        AND pg_catalog.strpos(
              pg_catalog.regexp_replace(
                pg_catalog.lower(caller.source),
                '[[:space:]"]+',
                '',
                'g'
              ),
              pg_catalog.lower(callee.routine_name) || '('
            ) > 0
     ),
     writer_reachable(oid) AS (
       SELECT oid FROM direct_writers
       UNION
       SELECT edge.caller_oid
         FROM call_edges AS edge
         JOIN writer_reachable AS target
           ON target.oid = edge.callee_oid
     ),
     user_triggers AS (
       SELECT trigger.oid, trigger.tgfoid
         FROM pg_catalog.pg_trigger AS trigger
        WHERE NOT trigger.tgisinternal
     ),
     trigger_writers AS (
       SELECT trigger.oid
         FROM user_triggers AS trigger
         JOIN writer_reachable AS target
           ON target.oid = trigger.tgfoid
     ),
     reviewed_writer AS (
       SELECT *
         FROM direct_writers
        WHERE oid = pg_catalog.to_regprocedure(${sqlLiteral(signature)})::oid
     )
     SELECT pg_catalog.concat_ws(
       '|',
       (SELECT pg_catalog.count(*)::text FROM direct_writers),
       (SELECT pg_catalog.count(*)::text FROM writer_reachable),
       (SELECT pg_catalog.count(*)::text FROM trigger_writers),
       (SELECT pg_catalog.count(*)::text FROM dynamic_routines),
       (SELECT pg_catalog.count(*)::text FROM reviewed_writer),
       pg_catalog.coalesce(
         (
           SELECT (
             writer.prokind = ${sqlLiteral(reviewed.kind)}
             AND writer.lanname = ${sqlLiteral(reviewed.language)}
             AND writer.identity_arguments =
               ${sqlLiteral(expectedIdentityArguments)}
             AND writer.direct_write_count = 1
             AND pg_catalog.encode(
                   pg_catalog.sha256(
                     pg_catalog.convert_to(writer.source, 'UTF8')
                   ),
                   'hex'
                 ) = ${sqlLiteral(reviewed.bodySha256)}
             AND pg_catalog.encode(
                   pg_catalog.sha256(
                     pg_catalog.convert_to(writer.definition, 'UTF8')
                   ),
                   'hex'
                 ) = ${sqlLiteral(reviewed.definitionSha256)}
           )::text
           FROM reviewed_writer AS writer
         ),
         'false'
       ),
       (
         SELECT pg_catalog.count(*)::text
           FROM call_edges AS edge
          WHERE edge.callee_oid =
            pg_catalog.to_regprocedure(${sqlLiteral(signature)})::oid
       ),
       (
         SELECT pg_catalog.count(*)::text
           FROM call_edges AS edge
          WHERE edge.caller_oid =
            pg_catalog.to_regprocedure(${sqlLiteral(signature)})::oid
       )
     );`,
  );
  assert.equal(
    writerCatalogGraph,
    "1|1|0|0|1|true|0|0",
    "the final catalog must expose only the exact reviewed non-dynamic writer, with no helper callers, outbound user-routine calls, or trigger reachability",
  );
  process.stdout.write(
    "mail_durable_replay_0067=writer_inventory_catalog_graph:pass\n",
  );
}

async function reconcileReviewedPrivileges(
  port,
  database,
  { phase, phaseIndex, beforeCommit },
) {
  const {
    REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES,
    runDatabaseRoleBootstrap,
  } = await import("../../scripts/bootstrap-database-roles.mjs");
  const { verifyReviewedMailAuthorityCatalogContracts } =
    await import("../../scripts/verify-database-role-boundaries.mjs");
  const reviewedPhase = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === phaseIndex,
  );
  assert.ok(reviewedPhase, `${phase} canonical phase is not registered`);
  const credentialUrl = (username, label) =>
    `postgresql://${username}:codestead-0067-${label}-${"x".repeat(32)}`
    + `@postgres/${database}`;
  const bootstrapPool = createTrackedPool(isolatedPoolConfig({
    applicationName: `codestead_mail_${phase}_role_bootstrap`,
    database,
    port,
    user: "postgres",
  }));
  try {
    await runDatabaseRoleBootstrap({
      cleanupTimeoutMs: CLIENT_CLOSE_TIMEOUT_MS,
      databaseAppUrl: credentialUrl("learncoding_app", "app"),
      databaseBackupReporterUrl: credentialUrl(
        "learncoding_backup_reporter",
        "backup-reporter",
      ),
      databaseBootstrapUrl: credentialUrl("postgres", "bootstrap"),
      databaseMigratorUrl: credentialUrl(
        "learncoding_migrator",
        "migrator",
      ),
      databaseOpsUrl: credentialUrl("learncoding_ops", "ops"),
      databaseWorkerUrl: credentialUrl("learncoding_worker", "worker"),
      lockTimeoutMs: 30_000,
      pool: bootstrapPool,
      postgresDatabase: database,
      postgresUser: "postgres",
      beforeCommit,
    });
    process.stdout.write(
      `mail_durable_replay_0067=bootstrap_apply_${phaseIndex}:pass\n`,
    );
  } catch (error) {
    const cause = error instanceof Error ? error.cause : undefined;
    throw new Error(
      `${phase} bootstrap reconciliation failed: ${
        cause instanceof Error ? (cause.stack ?? cause.message) : String(error)
      }`,
      { cause: error },
    );
  } finally {
    trackedPools.delete(bootstrapPool);
  }

  const client = createTrackedClient(isolatedClientConfig({
    applicationName: `codestead_mail_${phase}_bootstrap_proof`,
    database,
    port,
    user: "postgres",
  }));
  let operationError;
  const cleanupFailures = [];
  try {
    await connectClientWithin(client, `${phase} bootstrap proof client`);
    assert.deepEqual(
      await verifyReviewedMailAuthorityCatalogContracts(
        client,
        reviewedPhase,
      ),
      {
        routinesVerified: reviewedPhase.routines.length,
        triggersVerified: reviewedPhase.triggers.length,
        workerContractsVerified: 1,
        totalVerified:
          reviewedPhase.routines.length
          + reviewedPhase.triggers.length
          + 1,
      },
    );
    process.stdout.write(
      `mail_durable_replay_0067=bootstrap_catalog_verify_${phaseIndex}:pass\n`,
    );
  } catch (error) {
    operationError = error;
  } finally {
    await runCleanupStep(
      cleanupFailures,
      () => closeClientWithin(client, `${phase} bootstrap proof client`),
      `${phase} bootstrap proof client cleanup`,
    );
  }
  if (operationError !== undefined || cleanupFailures.length > 0) {
    throw preserveOperationAndCleanupFailures(
      operationError,
      cleanupFailures,
      `${phase} bootstrap catalog verification and cleanup failed`,
    );
  }
}
function reportReplayAuthorityConstraintCatalog(port, database) {
  const reviewedCatalog = JSON.parse(scalar(
    port,
    database,
    `SET search_path = pg_catalog, pg_temp;
     WITH reviewed AS (
       SELECT namespace.nspname || '.' || relation.relname AS relation_name,
              constraint_row.conname,
              constraint_row.contype::text AS constraint_type,
              constraint_row.convalidated,
              constraint_row.connoinherit,
              pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(
                    pg_catalog.regexp_replace(
                      pg_catalog.regexp_replace(
                        pg_catalog.pg_get_expr(
                          constraint_row.conbin,
                          constraint_row.conrelid,
                          true
                        ),
                        '"?' || relation.relname || '"?[.]',
                        '',
                        'g'
                      ),
                      '[[:space:]"]',
                      '',
                      'g'
                    ),
                    'UTF8'
                  )
                ),
                'hex'
              ) AS normalized_expression_sha256,
              COALESCE(
                (
                  SELECT pg_catalog.array_agg(
                           attribute.attname::text ORDER BY attribute.attname
                         )
                    FROM pg_catalog.unnest(constraint_row.conkey)
                         constrained(attnum)
                    JOIN pg_catalog.pg_attribute AS attribute
                      ON attribute.attrelid = constraint_row.conrelid
                     AND attribute.attnum = constrained.attnum
                ),
                '{}'::text[]
              ) AS columns
         FROM pg_catalog.pg_constraint AS constraint_row
         JOIN pg_catalog.pg_class AS relation
           ON relation.oid = constraint_row.conrelid
         JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
        WHERE (
          constraint_row.conrelid =
            'public.email_outbox_idempotency_authority'::regclass
          AND constraint_row.conname IN (
            'email_outbox_idempotency_authority_digest_valid',
            'email_outbox_idempotency_authority_payload_valid'
          )
        ) OR (
          constraint_row.conrelid = 'public.email_outbox'::regclass
          AND constraint_row.conname = 'email_outbox_delivery_scope_valid'
        )
     )
     SELECT COALESCE(
       pg_catalog.json_agg(
         pg_catalog.json_build_object(
           'relation', reviewed.relation_name,
           'name', reviewed.conname,
           'type', reviewed.constraint_type,
           'validated', reviewed.convalidated,
           'noInherit', reviewed.connoinherit,
           'columns', reviewed.columns,
           'normalizedExpressionSha256',
             reviewed.normalized_expression_sha256
         ) ORDER BY reviewed.relation_name, reviewed.conname
       ),
       '[]'::json
     )::text
     FROM reviewed;`,
  ));
  assert.ok(Array.isArray(reviewedCatalog));
  const constraints = reviewedCatalog.map((reviewed) => {
    assert.equal(typeof reviewed.relation, "string");
    assert.equal(typeof reviewed.name, "string");
    assert.equal(typeof reviewed.type, "string");
    assert.equal(typeof reviewed.validated, "boolean");
    assert.equal(typeof reviewed.noInherit, "boolean");
    assert.ok(Array.isArray(reviewed.columns));
    assert.ok(
      reviewed.columns.every((column) => typeof column === "string"),
    );
    assert.match(
      reviewed.normalizedExpressionSha256,
      /^[0-9a-f]{64}$/u,
    );
    return {
      relation: reviewed.relation,
      name: reviewed.name,
      type: reviewed.type,
      validated: reviewed.validated,
      noInherit: reviewed.noInherit,
      columns: reviewed.columns,
      normalizedExpressionSha256:
        reviewed.normalizedExpressionSha256,
    };
  });
  assert.deepEqual(constraints, [
    {
      relation: "public.email_outbox",
      name: "email_outbox_delivery_scope_valid",
      type: "c",
      validated: true,
      noInherit: false,
      columns: [
        "delivery_scope_key",
        "operation_id",
        "status",
        "template",
        "template_version",
        "to_email",
        "user_id",
        "variables",
      ],
      normalizedExpressionSha256:
        "c904768e4ecc145fc108de90adf0d0b5373f3330fb706ec34ff4b07d2711b94f",
    },
    {
      relation: "public.email_outbox_idempotency_authority",
      name: "email_outbox_idempotency_authority_digest_valid",
      type: "c",
      validated: true,
      noInherit: false,
      columns: ["idempotency_sha256"],
      normalizedExpressionSha256:
        "8e6471c0b1bf0fd09c9f9f37b6735e345030506017e78de7c2deba7f79bd6f6d",
    },
    {
      relation: "public.email_outbox_idempotency_authority",
      name: "email_outbox_idempotency_authority_payload_valid",
      type: "c",
      validated: true,
      noInherit: false,
      columns: ["original_payload_sha256"],
      normalizedExpressionSha256:
        "aca0ad0a3d605439d115ce9283ef22b98a28c71e85f4e7e89de406e90dee11e6",
    },
  ]);
  process.stdout.write(
    "mail_durable_replay_0067=constraint_catalog:pass\n",
  );
}
function reviewedBootstrapPhaseSnapshot(port, database) {
  return scalar(
    port,
    database,
    `WITH reviewed_state AS (
       SELECT 'journal:' || journal.id::text AS object_key,
              journal.hash || ':' || journal.created_at::text AS object_state
         FROM drizzle.__drizzle_migrations AS journal
       UNION ALL
       SELECT 'relation:' || namespace.nspname || '.' || relation.relname,
              pg_catalog.pg_get_userbyid(relation.relowner) || ':' ||
                COALESCE(relation.relacl::text, '<null>')
         FROM pg_catalog.pg_class AS relation
         JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('public', 'drizzle')
          AND relation.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
       UNION ALL
       SELECT 'column:' || namespace.nspname || '.' || relation.relname ||
                '.' || attribute.attname,
              COALESCE(attribute.attacl::text, '<null>')
         FROM pg_catalog.pg_attribute AS attribute
         JOIN pg_catalog.pg_class AS relation
           ON relation.oid = attribute.attrelid
         JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('public', 'drizzle')
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
       UNION ALL
       SELECT 'routine:' || namespace.nspname || '.' || routine.oid::text,
              pg_catalog.pg_get_userbyid(routine.proowner) || ':' ||
                routine.prosecdef::text || ':' ||
                COALESCE(routine.proconfig::text, '<null>') || ':' ||
                COALESCE(routine.proacl::text, '<null>')
         FROM pg_catalog.pg_proc AS routine
         JOIN pg_catalog.pg_namespace AS namespace
           ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname IN ('public', 'drizzle')
     )
     SELECT pg_catalog.encode(
       pg_catalog.sha256(
         pg_catalog.convert_to(
           COALESCE(
             pg_catalog.string_agg(
               object_key || pg_catalog.chr(31) || object_state,
               pg_catalog.chr(30) ORDER BY object_key
             ),
             ''
           ),
           'UTF8'
         )
       ),
       'hex'
     )
       FROM reviewed_state;`,
  );
}

async function proveBeforeCommitJournalMutationRollback(port, database) {
  const beforeMutationSnapshot = reviewedBootstrapPhaseSnapshot(
    port,
    database,
  );
  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.count(*)::text
         FROM drizzle.__drizzle_migrations
        WHERE created_at = 1785002172253;`,
    ),
    "0",
    "phase 0067 journal marker must be absent before the mutation proof",
  );

  await assert.rejects(
    reconcileReviewedPrivileges(port, database, {
      phase: "0066-before-commit-journal-mutation",
      phaseIndex: 66,
      beforeCommit: async (client) => {
        await client.query(`
          INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
          VALUES (
            'ccb3e093847fb875ded41ec0c36d0ff8405c04d1546ba9dd21696e86a73a6817',
            1785002172253
          )
        `);
      },
    }),
    /0066-before-commit-journal-mutation bootstrap reconciliation failed/u,
  );

  assert.equal(
    scalar(
      port,
      database,
      `SELECT pg_catalog.count(*)::text
         FROM drizzle.__drizzle_migrations
        WHERE created_at = 1785002172253;`,
    ),
    "0",
    "failed post-callback phase verification must roll back the journal marker",
  );
  assert.equal(
    reviewedBootstrapPhaseSnapshot(port, database),
    beforeMutationSnapshot,
    "failed post-callback phase verification must roll back catalog and ACL state",
  );

  await reconcileReviewedPrivileges(port, database, {
    phase: "0066-after-journal-mutation-rollback",
    phaseIndex: 66,
  });
  process.stdout.write(
    "mail_durable_replay_0067=bootstrap_journal_mutation_rollback:pass\n",
  );
}
async function proveBootstrapReconciliation(port, database) {
  function bootstrapAclSnapshot() {
    return scalar(
      port,
      database,
      `WITH acl_state AS (
         SELECT 'relation'::text AS object_key, relation.relacl::text AS acl
           FROM pg_catalog.pg_class AS relation
          WHERE relation.oid = 'public.email_outbox'::pg_catalog.regclass
         UNION ALL
         SELECT 'column:' || attribute.attname, attribute.attacl::text
           FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid =
                  'public.email_outbox'::pg_catalog.regclass
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
       )
       SELECT pg_catalog.encode(
         pg_catalog.sha256(
           pg_catalog.convert_to(
             COALESCE(
               pg_catalog.string_agg(
                 object_key || pg_catalog.chr(31) || COALESCE(acl, '<null>'),
                 pg_catalog.chr(30) ORDER BY object_key
               ),
               ''
             ),
             'UTF8'
           )
         ),
         'hex'
       )
       FROM acl_state;`,
    );
  }
  ownerSql(
    port,
    database,
    `ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner IN SCHEMA public
       REVOKE EXECUTE ON FUNCTIONS
       FROM mail_default_grantee, mail_acl_grantor;
     ALTER DEFAULT PRIVILEGES FOR ROLE learncoding_owner IN SCHEMA public
       REVOKE ALL PRIVILEGES ON TABLES
       FROM mail_default_grantee, mail_acl_grantor;`,
  );
  psql(
    port,
    database,
    `REVOKE USAGE ON SCHEMA public FROM mail_acl_grantor;
     REVOKE mail_acl_grantor FROM learncoding_owner;`,
  );
  ownerSql(
    port,
    database,
    `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
     VALUES (
       'ccb3e093847fb875ded41ec0c36d0ff8405c04d1546ba9dd21696e86a73a6817',
       1785002172253
     );`,
  );
  const beforeMutationSnapshot = bootstrapAclSnapshot(port, database);
  await assert.rejects(
    reconcileReviewedPrivileges(port, database, {
      phase: "0067-before-commit-rollback",
      phaseIndex: 67,
      beforeCommit: async (client) => {
        await client.query(
          "GRANT SELECT ON TABLE public.email_outbox TO learncoding_backup_reporter",
        );
      },
    }),
  );
  assert.equal(
    bootstrapAclSnapshot(port, database),
    beforeMutationSnapshot,
  );
  process.stdout.write(
    "mail_durable_replay_0067=bootstrap_before_commit_rollback:pass\n",
  );
  await reconcileReviewedPrivileges(port, database, {
    phase: "0067",
    phaseIndex: 67,
  });
}
async function proveWorkerRoleSharedWriter(port, database) {
  const accountOperationId = fixtureUuid("9f", 1);
  const accountReplayOperationId = fixtureUuid("9f", 2);
  const accountConflictOperationId = fixtureUuid("9f", 3);
  const systemOperationId = fixtureUuid("9f", 4);
  const systemSourceId = fixtureUuid("9f", 5);
  const forbiddenOperationId = fixtureUuid("9f", 6);
  const accountVariables = { fixture: "worker-shared-writer-account" };
  const accountKey = accountEventKey(
    "storage-quota-changed",
    LEARNER_ID,
    "worker-shared-writer-account",
  );
  const systemVariables = {
    fixture: "worker-shared-writer-system",
    _mailOperationId: systemOperationId,
    _mailRecipient: ADMIN_EMAIL,
    _mailProducer: "access-request-admin",
    _mailSourceId: systemSourceId,
    _mailAudienceId: fixtureUuid("71", 10),
  };
  const systemKey = systemEventKey(
    "access-request-admin",
    "access-request-admin",
    systemSourceId,
    fixtureUuid("71", 10),
    "worker-shared-writer-system",
  );

  function sharedWorkerWriterSql({
    operationId,
    userId,
    recipient,
    template,
    variables,
    idempotencyKey,
  }) {
    const deliveryScopeKey = userId === null
      ? `s:${operationId}`
      : `a:${userId}`;
    return `INSERT INTO public.email_outbox (
      operation_id,
      user_id,
      delivery_scope_key,
      to_email,
      template,
      template_version,
      variables,
      idempotency_key,
      idempotency_authority_version,
      status,
      next_attempt_at
    ) VALUES (
      ${sqlLiteral(operationId)},
      ${sqlLiteral(userId)},
      ${sqlLiteral(deliveryScopeKey)},
      ${sqlLiteral(recipient)},
      ${sqlLiteral(template)},
      '1',
      ${sqlLiteral(JSON.stringify(variables))}::pg_catalog.jsonb,
      ${sqlLiteral(idempotencyKey)},
      'event-v1-native',
      'pending',
      pg_catalog.now()
    )
    ON CONFLICT (idempotency_key) DO NOTHING`;
  }

  const accountInsert = await queryDatabase(
    port,
    database,
    "learncoding_worker",
    `${sharedWorkerWriterSql({
      operationId: accountOperationId,
      userId: LEARNER_ID,
      recipient: LEARNER_EMAIL,
      template: "storage-quota-changed",
      variables: accountVariables,
      idempotencyKey: accountKey,
    })} RETURNING id;`,
  );
  assert.equal(accountInsert.rowCount, 1);

  const systemInsert = await queryDatabase(
    port,
    database,
    "learncoding_worker",
    `${sharedWorkerWriterSql({
      operationId: systemOperationId,
      userId: null,
      recipient: ADMIN_EMAIL,
      template: "access-request-admin",
      variables: systemVariables,
      idempotencyKey: systemKey,
    })} RETURNING id;`,
  );
  assert.equal(systemInsert.rowCount, 1);

  const exactAccountReplay = await queryDatabase(
    port,
    database,
    "learncoding_worker",
    `${sharedWorkerWriterSql({
      operationId: accountReplayOperationId,
      userId: LEARNER_ID,
      recipient: LEARNER_EMAIL,
      template: "storage-quota-changed",
      variables: accountVariables,
      idempotencyKey: accountKey,
    })} RETURNING id;`,
  );
  assert.equal(exactAccountReplay.rowCount, 0);
  assert.equal(
    scalar(
      port,
      database,
      `SELECT (
        (SELECT pg_catalog.count(*) = 2
           FROM public.email_outbox AS outbox
          WHERE outbox.idempotency_authority_sha256 IN (
            '${accountKey}', '${systemKey}'
          ))
        AND
        (SELECT pg_catalog.count(*) = 2
           FROM public.email_outbox_idempotency_authority AS authority
          WHERE authority.idempotency_sha256 IN (
            '${accountKey}', '${systemKey}'
          ))
        AND NOT EXISTS (
          SELECT 1
            FROM public.email_outbox AS outbox
            JOIN public.email_outbox_idempotency_authority AS authority
              ON authority.idempotency_sha256 =
                   outbox.idempotency_authority_sha256
           WHERE outbox.idempotency_authority_sha256 IN (
             '${accountKey}', '${systemKey}'
           )
             AND authority.original_payload_sha256 IS DISTINCT FROM
                   outbox.idempotency_original_payload_sha256
        )
      )::text;`,
    ),
    "true",
  );

  await expectDatabaseError(
    port,
    database,
    "learncoding_worker",
    `${sharedWorkerWriterSql({
      operationId: accountConflictOperationId,
      userId: LEARNER_ID,
      recipient: LEARNER_EMAIL,
      template: "storage-quota-changed",
      variables: { fixture: "worker-shared-writer-conflict" },
      idempotencyKey: accountKey,
    })} RETURNING id;`,
    {
      code: "23505",
      constraint: "email_outbox_idempotency_authority_pkey",
      message: "email outbox idempotency event payload conflict",
    },
  );

  await expectDatabaseError(
    port,
    database,
    "learncoding_worker",
    `INSERT INTO public.email_outbox (
      id, user_id, to_email, template, template_version, variables,
      idempotency_key, idempotency_authority_version,
      idempotency_authority_sha256, idempotency_original_payload_sha256,
      operation_id, delivery_scope_key, status, attempt_count, claim_token,
      claim_owner, claim_version, lease_expires_at, provider_call_started,
      adapter, dispatch_binding_version, dispatch_binding_sha256,
      provider_correlation_version, provider_evidence_version,
      provider_evidence_sha256, provider_message_id, next_attempt_at, sent_at,
      quarantined_at, last_error_code, created_at, updated_at
    ) VALUES (
      DEFAULT, '${LEARNER_ID}', '${LEARNER_EMAIL}', 'storage-quota-changed',
      '1', '{"fixture":"worker-full-column-negative"}'::pg_catalog.jsonb,
      '${accountEventKey(
        "storage-quota-changed",
        LEARNER_ID,
        "worker-full-column-negative",
      )}', 'event-v1-native', DEFAULT, DEFAULT, '${forbiddenOperationId}',
      'a:${LEARNER_ID}', 'pending', DEFAULT, DEFAULT, DEFAULT, DEFAULT,
      DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT,
      DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT, DEFAULT
    );`,
    { code: "42501", constraint: undefined },
  );

  process.stdout.write(
    "mail_durable_replay_0067=worker_shared_writer:pass\n",
  );
}
async function proveDeliveryHoldAuthority(port, database) {
  const proofDatabase = "mail0067_delivery_hold";
  const holdError = Object.freeze({
    code: "23514",
    constraint: "email_outbox_delivery_hold_valid",
    message: "email outbox delivery remains held for task7-v1",
  });
  const holdOwnershipError = Object.freeze({
    code: "23514",
    constraint: "email_outbox_delivery_hold_valid",
    message: "email outbox delivery hold is database-owned",
  });
  const nonPristineInsertError = Object.freeze({
    code: "23514",
    constraint: "email_outbox_delivery_hold_valid",
    message: "email outbox delivery state must be pristine while held",
  });
  const quiescenceRow = newEventRow(
    690,
    "delivery-hold-quiescence",
  );
  const redactionRow = newEventRow(
    691,
    "delivery-hold-redaction",
  );
  const explicitNullRow = newEventRow(
    701,
    "delivery-hold-explicit-null",
  );
  const explicitOtherRow = newEventRow(
    702,
    "delivery-hold-explicit-other",
  );
  const copyRow = newEventRow(703, "delivery-hold-copy");
  const reclaimRow = newEventRow(704, "delivery-hold-reclaim");
  const providerRow = newEventRow(705, "delivery-hold-provider");
  const sweepRow = newEventRow(706, "delivery-hold-sweep");
  const replicaInsertRow = newEventRow(707, "delivery-hold-replica-insert");
  const nonPristineRow = newEventRow(708, "delivery-hold-nonpristine");
  const pass = (marker) => {
    process.stdout.write(`mail_durable_replay_0067=${marker}:pass\n`);
  };
  const insertHeldEventSql = (row, holdSql) => `
    INSERT INTO public.email_outbox (
      id, operation_id, user_id, delivery_scope_key, to_email, template,
      template_version, variables, idempotency_key,
      idempotency_authority_version, delivery_hold_version
    ) VALUES (
      ${sqlLiteral(row.id)}, ${sqlLiteral(row.operationId)},
      ${sqlLiteral(row.userId)}, ${sqlLiteral(`a:${row.userId}`)},
      ${sqlLiteral(row.to)}, ${sqlLiteral(row.template)},
      ${sqlLiteral(row.version)},
      ${sqlLiteral(JSON.stringify(row.variables))}::pg_catalog.jsonb,
      ${sqlLiteral(row.key)}, 'event-v1-native', ${holdSql}
    )`;
  const insertHeldSendingSql = (
    row,
    { claimToken, claimOwner, leaseSql },
  ) => `
    INSERT INTO public.email_outbox (
      id, operation_id, user_id, delivery_scope_key, to_email, template,
      template_version, variables, idempotency_key,
      idempotency_authority_version, delivery_hold_version,
      status, attempt_count, claim_token, claim_owner, claim_version,
      lease_expires_at
    ) VALUES (
      ${sqlLiteral(row.id)}, ${sqlLiteral(row.operationId)},
      ${sqlLiteral(row.userId)}, ${sqlLiteral(`a:${row.userId}`)},
      ${sqlLiteral(row.to)}, ${sqlLiteral(row.template)},
      ${sqlLiteral(row.version)},
      ${sqlLiteral(JSON.stringify(row.variables))}::pg_catalog.jsonb,
      ${sqlLiteral(row.key)}, 'event-v1-native', NULL,
      'sending', 1, ${sqlLiteral(claimToken)}, ${sqlLiteral(claimOwner)}, 1,
      ${leaseSql}
    )`;
  const expectHoldError = async (username, sql, marker) => {
    await expectDatabaseError(
      port,
      proofDatabase,
      username,
      sql,
      holdError,
    );
    pass(marker);
  };
  const quiescenceSnapshot = () => scalar(
    port,
    proofDatabase,
    `SELECT pg_catalog.row_to_json(state)::pg_catalog.text
       FROM (
         SELECT status::pg_catalog.text AS status,
                claim_token::pg_catalog.text AS claim_token,
                claim_owner,
                lease_expires_at::pg_catalog.text AS lease_expires_at
           FROM public.email_outbox
          WHERE id = '${quiescenceRow.id}'::pg_catalog.uuid
       ) AS state;`,
  );
  const assertHoldTriggerCatalog = () => {
    assert.equal(
      scalar(
        port,
        proofDatabase,
        `SELECT (
           NOT hold_trigger.tgisinternal
           AND hold_trigger.tgconstraint = 0
           AND hold_trigger.tgconstrrelid = 0
           AND hold_trigger.tgtype = 19
           AND hold_trigger.tgenabled = 'A'
           AND hold_trigger.tgfoid =
                 pg_catalog.to_regprocedure(
                   'public.enforce_email_outbox_delivery_hold()'
                 )
           AND (
             SELECT pg_catalog.array_agg(
                      attribute.attname::pg_catalog.text
                      ORDER BY attribute.attname::pg_catalog.text
                    )
               FROM pg_catalog.unnest(
                      hold_trigger.tgattr::pg_catalog.int2[]
                    ) AS trigger_attribute(attnum)
               JOIN pg_catalog.pg_attribute AS attribute
                 ON attribute.attrelid =
                      'public.email_outbox'::pg_catalog.regclass
                AND attribute.attnum = trigger_attribute.attnum
           ) IS NOT DISTINCT FROM ARRAY[
             'adapter',
             'attempt_count',
             'claim_owner',
             'claim_token',
             'claim_version',
             'delivery_hold_version',
             'dispatch_binding_sha256',
             'dispatch_binding_version',
             'idempotency_authority_sha256',
             'idempotency_authority_version',
             'idempotency_original_payload_sha256',
             'last_error_code',
             'lease_expires_at',
             'next_attempt_at',
             'provider_call_started',
             'provider_correlation_version',
             'provider_evidence_sha256',
             'provider_evidence_version',
             'provider_message_id',
             'quarantined_at',
             'sent_at',
             'status'
           ]::pg_catalog.text[]
         )::pg_catalog.text
         FROM pg_catalog.pg_trigger AS hold_trigger
         WHERE hold_trigger.tgrelid =
                 'public.email_outbox'::pg_catalog.regclass
           AND hold_trigger.tgname = 'email_outbox_delivery_hold';`,
      ),
      "true",
      "delivery-hold fixture setup did not restore the exact ALWAYS trigger",
    );
  };
  const withHoldUpdateTriggerDisabled = (label, mutateFixture) => {
    let disabled = false;
    let operationError;
    const restorationFailures = [];
    try {
      psql(
        port,
        proofDatabase,
        `ALTER TABLE public.email_outbox
           DISABLE TRIGGER email_outbox_delivery_hold;`,
      );
      disabled = true;
      mutateFixture();
    } catch (error) {
      operationError = error;
    } finally {
      if (disabled) {
        try {
          psql(
            port,
            proofDatabase,
            `ALTER TABLE public.email_outbox
               ENABLE ALWAYS TRIGGER email_outbox_delivery_hold;`,
          );
        } catch (error) {
          restorationFailures.push(error);
        }
      }
      try {
        assertHoldTriggerCatalog();
      } catch (error) {
        restorationFailures.push(error);
      }
    }
    if (operationError !== undefined || restorationFailures.length > 0) {
      throw preserveOperationAndCleanupFailures(
        operationError,
        restorationFailures,
        `${label} delivery-hold fixture setup failed`,
      );
    }
  };
  const insertHeldPending = (row) => {
    assert.equal(
      scalar(
        port,
        proofDatabase,
        `${insertHeldEventSql(row, "NULL")}
         RETURNING delivery_hold_version;`,
        "learncoding_app",
      ),
      "task7-v1",
    );
  };

  let operationError;
  const cleanupFailures = [];
  let proofDatabaseCreated = false;
  try {
    createOwnedDatabase(port, proofDatabase, database);
    proofDatabaseCreated = true;

    ownerSql(
      port,
      proofDatabase,
      `${insertOutboxSql(quiescenceRow)};`,
    );
    ownerSql(
      port,
      proofDatabase,
      `BEGIN;
       ALTER TABLE public.email_outbox
         DISABLE TRIGGER email_outbox_dispatch_binding_guard;
       ALTER TABLE public.email_outbox
         DISABLE TRIGGER email_outbox_provider_correlation_evidence_guard;
       INSERT INTO public.email_outbox (
         id, operation_id, user_id, delivery_scope_key, to_email, template,
         template_version, variables, idempotency_key, status, attempt_count,
         claim_version, provider_call_started, adapter,
         dispatch_binding_version, dispatch_binding_sha256,
         provider_correlation_version, provider_evidence_version,
         provider_evidence_sha256, next_attempt_at, quarantined_at,
         last_error_code, created_at, updated_at
       ) VALUES (
         '${redactionRow.id}'::pg_catalog.uuid,
         '${redactionRow.operationId}'::pg_catalog.uuid,
         '${LEARNER_ID}', 'a:${LEARNER_ID}', '${LEARNER_EMAIL}',
         'storage-quota-changed', '1',
         ${sqlLiteral(JSON.stringify(redactionRow.variables))}::pg_catalog.jsonb,
         '${redactionRow.key}', 'quarantined', 1, 1,
         pg_catalog.statement_timestamp() - interval '45 days',
         'gmail', 'gmail-raw-v1', '${"a".repeat(64)}',
         'opaque-sha256-v1', 'gmail-header-evidence-v1',
         '${"b".repeat(64)}',
         pg_catalog.statement_timestamp() - interval '45 days',
         pg_catalog.statement_timestamp() - interval '45 days',
         'DELIVERY_UNCERTAIN',
         pg_catalog.statement_timestamp() - interval '45 days',
         pg_catalog.statement_timestamp() - interval '45 days'
       );
       ALTER TABLE public.email_outbox
         ENABLE ALWAYS TRIGGER email_outbox_provider_correlation_evidence_guard;
       ALTER TABLE public.email_outbox
         ENABLE ALWAYS TRIGGER email_outbox_dispatch_binding_guard;
       COMMIT;`,
    );

    const quiescenceCases = Object.freeze([
      {
        marker: "delivery-hold-quiescence-sending",
        mutation: "status = 'sending'",
      },
      {
        marker: "delivery-hold-quiescence-claim-token",
        mutation:
          `claim_token = '${fixtureUuid("90", 1)}'::pg_catalog.uuid`,
      },
      {
        marker: "delivery-hold-quiescence-claim-owner",
        mutation: "claim_owner = 'delivery-hold-quiescence-owner'",
      },
      {
        marker: "delivery-hold-quiescence-live-lease",
        mutation:
          "lease_expires_at = pg_catalog.statement_timestamp() + interval '5 minutes'",
      },
    ]);
    for (const { marker, mutation } of quiescenceCases) {
      ownerSql(
        port,
        proofDatabase,
        `UPDATE public.email_outbox
            SET status = 'pending',
                claim_token = NULL,
                claim_owner = NULL,
                lease_expires_at = NULL
          WHERE id = '${quiescenceRow.id}'::pg_catalog.uuid;
         UPDATE public.email_outbox
            SET ${mutation}
          WHERE id = '${quiescenceRow.id}'::pg_catalog.uuid;`,
      );
      const stateBefore = quiescenceSnapshot();
      const rejected = psql(
        port,
        proofDatabase,
        `SET ROLE learncoding_owner;
         ${migration0067WithHostileAcls()}`,
        {
          username: "learncoding_migrator",
          singleTransaction: true,
          allowFailure: true,
          timeoutMs: 55_000,
        },
      );
      assert.notEqual(
        rejected.status,
        0,
        `${marker} migration unexpectedly passed`,
      );
      assert.match(
        `${rejected.stdout ?? ""}\n${rejected.stderr ?? ""}`,
        /email outbox delivery cutover requires quiescence/u,
        `${marker} did not fail at the delivery quiescence preflight`,
      );
      assert.equal(
        quiescenceSnapshot(),
        stateBefore,
        `${marker} changed the rejected live row`,
      );
      assert.equal(
        scalar(
          port,
          proofDatabase,
          `SELECT (
             pg_catalog.to_regclass(
               'public.email_outbox_idempotency_authority'
             ) IS NULL
             AND pg_catalog.to_regprocedure(
               'public.claim_email_outbox_idempotency_authority()'
             ) IS NULL
             AND pg_catalog.to_regprocedure(
               'public.enforce_email_outbox_delivery_hold()'
             ) IS NULL
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_attribute
                WHERE attrelid =
                      'public.email_outbox'::pg_catalog.regclass
                  AND attname = ANY (ARRAY[
                    'delivery_hold_version',
                    'idempotency_authority_version',
                    'idempotency_authority_sha256',
                    'idempotency_original_payload_sha256'
                  ])
                  AND NOT attisdropped
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM pg_catalog.pg_constraint
                WHERE conrelid =
                      'public.email_outbox'::pg_catalog.regclass
                  AND conname = 'email_outbox_delivery_hold_valid'
             )
           )::pg_catalog.text;`,
        ),
        "true",
        `${marker} left persistent 0067 state behind`,
      );
      pass(marker);
    }
    pass("delivery-hold-cutover-rollback");

    ownerSql(
      port,
      proofDatabase,
      `UPDATE public.email_outbox
          SET status = 'pending',
              claim_token = NULL,
              claim_owner = NULL,
              lease_expires_at = NULL
        WHERE id = '${quiescenceRow.id}'::pg_catalog.uuid;`,
    );
    apply0067WithHostileAcls(port, proofDatabase);
    assertHoldTriggerCatalog();
    assert.equal(
      scalar(
        port,
        proofDatabase,
        `SELECT (
           pg_catalog.count(*) > 0
           AND pg_catalog.bool_and(
             delivery_hold_version = 'task7-v1'
           )
           AND pg_catalog.count(*) FILTER (
             WHERE delivery_hold_version IS NULL
           ) = 0
         )::pg_catalog.text
         FROM public.email_outbox;`,
      ),
      "true",
      "0067 did not hold every pre-existing outbox row",
    );
    pass("delivery-hold-backfill-all");

    assert.equal(
      scalar(
        port,
        proofDatabase,
        `${insertHeldEventSql(explicitNullRow, "NULL")}
         RETURNING delivery_hold_version;`,
        "learncoding_app",
      ),
      "task7-v1",
    );
    pass("delivery-hold-explicit-null-insert");

    await expectDatabaseError(
      port,
      proofDatabase,
      "learncoding_app",
      `${insertHeldEventSql(explicitOtherRow, "'task8-v1'")}
       RETURNING delivery_hold_version;`,
      holdOwnershipError,
    );
    pass("delivery-hold-explicit-other-insert");

    await expectDatabaseError(
      port,
      proofDatabase,
      "learncoding_app",
      `${insertHeldSendingSql(nonPristineRow, {
        claimToken: fixtureUuid("90", 7),
        claimOwner: "delivery-hold-nonpristine",
        leaseSql:
          "pg_catalog.statement_timestamp() + interval '60 seconds'",
      })}
       RETURNING id;`,
      nonPristineInsertError,
    );
    pass("delivery-hold-nonpristine-insert-denied");

    const copyInput = (holdField) => [
      copyRow.id,
      copyRow.operationId,
      copyRow.userId,
      `a:${copyRow.userId}`,
      copyRow.to,
      copyRow.template,
      copyRow.version,
      JSON.stringify(copyRow.variables),
      copyRow.key,
      "event-v1-native",
      holdField,
    ].join("\t");
    const rejectedCopy = psql(
      port,
      proofDatabase,
      `\\set VERBOSITY verbose
COPY public.email_outbox (
  id, operation_id, user_id, delivery_scope_key, to_email, template,
  template_version, variables, idempotency_key,
  idempotency_authority_version, delivery_hold_version
) FROM STDIN;
${copyInput("task8-v1")}
\\.
`,
      { username: "learncoding_app", allowFailure: true },
    );
    assert.notEqual(rejectedCopy.status, 0);
    const rejectedCopyDiagnostic =
      `${rejectedCopy.stdout ?? ""}\n${rejectedCopy.stderr ?? ""}`;
    assert.match(
      rejectedCopyDiagnostic,
      /23514:[^\r\n]*email outbox delivery hold is database-owned/u,
    );
    assert.match(
      rejectedCopyDiagnostic,
      /CONSTRAINT NAME:[^\r\n]*email_outbox_delivery_hold_valid/u,
    );
    assert.equal(
      scalar(
        port,
        proofDatabase,
        `SELECT pg_catalog.count(*)::pg_catalog.text
           FROM public.email_outbox
          WHERE id = '${copyRow.id}'::pg_catalog.uuid;`,
      ),
      "0",
      "rejected COPY must remain statement-atomic",
    );
    pass("delivery-hold-copy-nonnull-denied");

    psql(
      port,
      proofDatabase,
      `COPY public.email_outbox (
         id, operation_id, user_id, delivery_scope_key, to_email, template,
         template_version, variables, idempotency_key,
         idempotency_authority_version, delivery_hold_version
       ) FROM STDIN;
${copyInput("\\N")}
\\.
`,
      { username: "learncoding_app" },
    );
    assert.equal(
      scalar(
        port,
        proofDatabase,
        `SELECT delivery_hold_version
           FROM public.email_outbox
          WHERE id = '${copyRow.id}'::pg_catalog.uuid;`,
      ),
      "task7-v1",
    );
    pass("delivery-hold-copy-forced");

    await expectHoldError(
      "learncoding_worker",
      `MERGE INTO public.email_outbox AS target
       USING (
         VALUES ('${explicitNullRow.id}'::pg_catalog.uuid)
       ) AS source(id)
          ON target.id = source.id
       WHEN MATCHED THEN
         UPDATE SET status = 'sent';`,
      "delivery-hold-merge-denied",
    );

    await expectHoldError(
      "postgres",
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       UPDATE public.email_outbox
          SET status = 'sent'
        WHERE id = '${explicitNullRow.id}'::pg_catalog.uuid;
       COMMIT;`,
      "delivery-hold-replica-update-denied",
    );

    for (const [status, marker] of [
      ["sent", "delivery-hold-direct-sent-denied"],
      ["failed", "delivery-hold-direct-failed-denied"],
      ["suppressed", "delivery-hold-direct-suppressed-denied"],
    ]) {
      await expectHoldError(
        "learncoding_worker",
        `UPDATE public.email_outbox
            SET status = '${status}',
                updated_at = pg_catalog.statement_timestamp()
          WHERE id = '${explicitNullRow.id}'::pg_catalog.uuid;`,
        marker,
      );
    }

    await expectHoldError(
      "learncoding_worker",
      `UPDATE public.email_outbox
          SET status = 'sending',
              attempt_count = attempt_count + 1,
              claim_token = '${fixtureUuid("90", 2)}'::pg_catalog.uuid,
              claim_owner = 'delivery-hold-claimer',
              claim_version = claim_version + 1,
              lease_expires_at =
                pg_catalog.statement_timestamp() + interval '60 seconds',
              last_error_code = NULL,
              updated_at = pg_catalog.statement_timestamp()
        WHERE id = '${explicitNullRow.id}'::pg_catalog.uuid
          AND status = 'pending'
          AND claim_token IS NULL
          AND claim_owner IS NULL
          AND lease_expires_at IS NULL;`,
      "delivery-hold-claim-denied",
    );

    insertHeldPending(reclaimRow);
    withHoldUpdateTriggerDisabled("reclaim", () => {
      psql(
        port,
        proofDatabase,
        `UPDATE public.email_outbox
            SET status = 'sending',
                attempt_count = 1,
                claim_token = '${fixtureUuid("90", 3)}'::pg_catalog.uuid,
                claim_owner = 'delivery-hold-reclaimer-old',
                claim_version = 1,
                lease_expires_at =
                  pg_catalog.statement_timestamp() - interval '60 seconds',
                updated_at = pg_catalog.statement_timestamp()
          WHERE id = '${reclaimRow.id}'::pg_catalog.uuid
            AND status = 'pending';`,
        { username: "learncoding_worker" },
      );
    });
    assert.equal(
      scalar(
        port,
        proofDatabase,
        `SELECT (status = 'sending'
                 AND delivery_hold_version = 'task7-v1'
                 AND lease_expires_at < pg_catalog.statement_timestamp()
               )::pg_catalog.text
           FROM public.email_outbox
          WHERE id = '${reclaimRow.id}'::pg_catalog.uuid;`,
      ),
      "true",
    );
    await expectHoldError(
      "learncoding_worker",
      `UPDATE public.email_outbox
          SET attempt_count = attempt_count + 1,
              claim_token = '${fixtureUuid("90", 4)}'::pg_catalog.uuid,
              claim_owner = 'delivery-hold-reclaimer-new',
              claim_version = claim_version + 1,
              lease_expires_at =
                pg_catalog.statement_timestamp() + interval '60 seconds',
              last_error_code = NULL,
              updated_at = pg_catalog.statement_timestamp()
        WHERE id = '${reclaimRow.id}'::pg_catalog.uuid
          AND status = 'sending'
          AND lease_expires_at < pg_catalog.statement_timestamp()
          AND provider_call_started IS NULL
          AND adapter IS NULL
          AND provider_message_id IS NULL;`,
      "delivery-hold-reclaim-denied",
    );

    insertHeldPending(providerRow);
    withHoldUpdateTriggerDisabled("provider", () => {
      psql(
        port,
        proofDatabase,
        `UPDATE public.email_outbox
            SET status = 'sending',
                attempt_count = 1,
                claim_token = '${fixtureUuid("90", 5)}'::pg_catalog.uuid,
                claim_owner = 'delivery-hold-provider',
                claim_version = 1,
                lease_expires_at =
                  pg_catalog.statement_timestamp() + interval '5 minutes',
                updated_at = pg_catalog.statement_timestamp()
          WHERE id = '${providerRow.id}'::pg_catalog.uuid
            AND status = 'pending';`,
        { username: "learncoding_worker" },
      );
    });
    await expectHoldError(
      "learncoding_worker",
      `UPDATE public.email_outbox
          SET lease_expires_at =
                pg_catalog.statement_timestamp() + interval '60 seconds',
              provider_call_started = pg_catalog.statement_timestamp(),
              adapter = 'gmail',
              dispatch_binding_version = 'gmail-raw-v1',
              dispatch_binding_sha256 = '${"c".repeat(64)}',
              provider_correlation_version = 'opaque-sha256-v1',
              provider_evidence_version = 'gmail-header-evidence-v1',
              provider_evidence_sha256 = '${"d".repeat(64)}',
              updated_at = pg_catalog.statement_timestamp()
        WHERE id = '${providerRow.id}'::pg_catalog.uuid
          AND claim_token =
                '${fixtureUuid("90", 5)}'::pg_catalog.uuid
          AND claim_owner = 'delivery-hold-provider'
          AND claim_version = 1
          AND status = 'sending'
          AND provider_call_started IS NULL;`,
      "delivery-hold-provider-denied",
    );

    await expectDatabaseError(
      port,
      proofDatabase,
      "postgres",
      `BEGIN;
       SET LOCAL session_replication_role = replica;
       ${insertHeldEventSql(replicaInsertRow, "'task8-v1'")};
       COMMIT;`,
      holdOwnershipError,
    );
    pass("delivery-hold-replica-insert-nonnull-denied");
    assert.equal(
      scalar(
        port,
        proofDatabase,
        `BEGIN;
         SET LOCAL session_replication_role = replica;
         ${insertHeldEventSql(replicaInsertRow, "NULL")}
         RETURNING delivery_hold_version;
         COMMIT;`,
        "postgres",
      ),
      "task7-v1",
    );
    pass("delivery-hold-replica-insert-forced");

    insertHeldPending(sweepRow);
    withHoldUpdateTriggerDisabled("sweeper", () => {
      psql(
        port,
        proofDatabase,
        `UPDATE public.email_outbox
            SET status = 'sending',
                attempt_count = 1,
                claim_token = '${fixtureUuid("90", 6)}'::pg_catalog.uuid,
                claim_owner = 'delivery-hold-sweeper',
                claim_version = 1,
                lease_expires_at =
                  pg_catalog.statement_timestamp() + interval '5 minutes',
                updated_at = pg_catalog.statement_timestamp()
          WHERE id = '${sweepRow.id}'::pg_catalog.uuid
            AND status = 'pending';
         UPDATE public.email_outbox
            SET lease_expires_at =
                  pg_catalog.statement_timestamp() + interval '60 seconds',
                provider_call_started = pg_catalog.statement_timestamp(),
                adapter = 'gmail',
                dispatch_binding_version = 'gmail-raw-v1',
                dispatch_binding_sha256 = '${"e".repeat(64)}',
                provider_correlation_version = 'opaque-sha256-v1',
                provider_evidence_version = 'gmail-header-evidence-v1',
                provider_evidence_sha256 = '${"f".repeat(64)}',
                updated_at = pg_catalog.statement_timestamp()
          WHERE id = '${sweepRow.id}'::pg_catalog.uuid
            AND status = 'sending'
            AND provider_call_started IS NULL;
         UPDATE public.email_outbox
            SET lease_expires_at =
                  pg_catalog.statement_timestamp() - interval '2 minutes',
                updated_at = pg_catalog.statement_timestamp()
          WHERE id = '${sweepRow.id}'::pg_catalog.uuid
            AND status = 'sending'
            AND provider_call_started IS NOT NULL;`,
        { username: "learncoding_worker" },
      );
    });
    assert.equal(
      scalar(
        port,
        proofDatabase,
        `SELECT (delivery_hold_version = 'task7-v1'
                 AND status = 'sending'
                 AND provider_call_started IS NOT NULL
                 AND lease_expires_at <
                       pg_catalog.statement_timestamp() - interval '30 seconds'
               )::pg_catalog.text
           FROM public.email_outbox
          WHERE id = '${sweepRow.id}'::pg_catalog.uuid;`,
      ),
      "true",
    );
    await expectHoldError(
      "learncoding_worker",
      `UPDATE public.email_outbox
          SET status = 'quarantined',
              quarantined_at = pg_catalog.statement_timestamp(),
              last_error_code = 'ABANDONED_POST_PROVIDER_BOUNDARY',
              claim_token = NULL,
              claim_owner = NULL,
              claim_version = claim_version + 1,
              lease_expires_at = NULL,
              updated_at = pg_catalog.statement_timestamp()
        WHERE id = '${sweepRow.id}'::pg_catalog.uuid
          AND claim_token =
                '${fixtureUuid("90", 6)}'::pg_catalog.uuid
          AND claim_owner = 'delivery-hold-sweeper'
          AND claim_version = 1
          AND lease_expires_at <
                pg_catalog.statement_timestamp() - interval '30 seconds'
          AND provider_call_started IS NOT NULL
          AND adapter IS NOT NULL
          AND provider_message_id IS NULL
          AND quarantined_at IS NULL
          AND status = 'sending';`,
      "delivery-hold-sweep-denied",
    );

    const redactionPayloadDigest = scalar(
      port,
      proofDatabase,
      `SELECT idempotency_original_payload_sha256
         FROM public.email_outbox
        WHERE id = '${redactionRow.id}'::pg_catalog.uuid;`,
    );
    assert.match(redactionPayloadDigest, /^[0-9a-f]{64}$/u);
    assert.equal(
      scalar(
        port,
        proofDatabase,
        `SELECT transitioned::pg_catalog.text
           FROM public.redact_unresolved_email_outbox_authority(
             pg_catalog.statement_timestamp() - interval '30 days',
             1
           )
          WHERE disposition = 'eligible';`,
        "learncoding_ops",
      ),
      "1",
      "0063 redaction did not transition the held eligible row",
    );
    assert.equal(
      scalar(
        port,
        proofDatabase,
        `SELECT (
           to_email =
             'redacted+' || id::pg_catalog.text || '@invalid.local'
           AND variables = '{}'::pg_catalog.jsonb
           AND delivery_hold_version = 'task7-v1'
           AND idempotency_original_payload_sha256 =
                 '${redactionPayloadDigest}'
         )::pg_catalog.text
         FROM public.email_outbox
         WHERE id = '${redactionRow.id}'::pg_catalog.uuid;`,
      ),
      "true",
      "redaction must preserve both the hold and immutable replay digest",
    );
    pass("delivery-hold-redaction-preserved");

    await expectHoldError(
      "learncoding_worker",
      `UPDATE public.email_outbox
          SET status = 'sent',
              provider_message_id = 'gmail-delivery-hold-reconciled',
              sent_at = pg_catalog.statement_timestamp(),
              quarantined_at = NULL,
              last_error_code = NULL,
              claim_token = NULL,
              claim_owner = NULL,
              lease_expires_at = NULL,
              updated_at = pg_catalog.statement_timestamp()
        WHERE id = '${redactionRow.id}'::pg_catalog.uuid
          AND operation_id =
                '${redactionRow.operationId}'::pg_catalog.uuid
          AND claim_version = 1
          AND adapter = 'gmail'
          AND provider_call_started IS NOT NULL
          AND dispatch_binding_version = 'gmail-raw-v1'
          AND dispatch_binding_sha256 = '${"a".repeat(64)}'
          AND provider_correlation_version = 'opaque-sha256-v1'
          AND provider_evidence_version = 'gmail-header-evidence-v1'
          AND provider_evidence_sha256 = '${"b".repeat(64)}'
          AND provider_message_id IS NULL
          AND sent_at IS NULL
          AND status = 'quarantined';`,
      "delivery-hold-reconcile-denied",
    );

    psql(
      port,
      proofDatabase,
      `INSERT INTO public.email_outbox (
         id, operation_id, user_id, delivery_scope_key, to_email, template,
         template_version, variables, idempotency_key,
         idempotency_authority_version, delivery_hold_version,
         next_attempt_at
       )
       SELECT (
                '9e000000-0000-4000-8000-' ||
                pg_catalog.lpad(series::pg_catalog.text, 12, '0')
              )::pg_catalog.uuid,
              (
                '9f000000-0000-4000-8000-' ||
                pg_catalog.lpad(series::pg_catalog.text, 12, '0')
              )::pg_catalog.uuid,
              '${LEARNER_ID}', 'a:${LEARNER_ID}', '${LEARNER_EMAIL}',
              'storage-quota-changed', '1',
              pg_catalog.jsonb_build_object(
                'fixture',
                'delivery-hold-starvation-' || series::pg_catalog.text
              ),
              pg_catalog.encode(
                pg_catalog.sha256(
                  pg_catalog.convert_to(
                    'delivery-hold-starvation-ordering:' ||
                      series::pg_catalog.text,
                    'UTF8'
                  )
                ),
                'hex'
              ),
              'event-v1-native', NULL,
              pg_catalog.statement_timestamp() - interval '1 hour'
         FROM pg_catalog.generate_series(1, 17) AS series;`,
      { username: "learncoding_app" },
    );
    assert.equal(
      scalar(
        port,
        proofDatabase,
        `SELECT (
           EXISTS (
             SELECT 1
               FROM public.email_outbox AS active
              WHERE active.id =
                    '${redactionRow.id}'::pg_catalog.uuid
                AND active.delivery_scope_key = 'a:${LEARNER_ID}'
                AND active.delivery_hold_version = 'task7-v1'
                AND active.status = 'quarantined'
                AND active.provider_call_started IS NOT NULL
                AND active.provider_message_id IS NULL
           )
           AND NOT EXISTS (
             SELECT 1
               FROM public.email_outbox AS candidate
              WHERE candidate.id =
                    '9e000000-0000-4000-8000-000000000001'::pg_catalog.uuid
                AND NOT EXISTS (
                  SELECT 1
                    FROM public.email_outbox AS active
                   WHERE active.delivery_scope_key =
                         candidate.delivery_scope_key
                     AND active.id <> candidate.id
                     AND (
                       (
                         active.status = 'sending'
                         AND (
                           active.provider_call_started IS NOT NULL
                           OR active.lease_expires_at IS NULL
                           OR active.lease_expires_at >=
                                pg_catalog.statement_timestamp()
                         )
                       )
                       OR (
                         active.status = 'quarantined'
                         AND active.provider_call_started IS NOT NULL
                         AND active.provider_message_id IS NULL
                       )
                     )
                )
           )
         )::pg_catalog.text;`,
      ),
      "true",
      "a held ambiguous row must remain an active same-scope blocker",
    );
    pass("delivery-hold-scope-blocker");

    assert.equal(
      scalar(
        port,
        proofDatabase,
        `SELECT (
           (
             SELECT pg_catalog.count(*)
               FROM public.email_outbox
              WHERE id::pg_catalog.text LIKE
                    '9e000000-0000-4000-8000-%'
                AND status = 'pending'
                AND delivery_hold_version = 'task7-v1'
           ) = 17
           AND NOT EXISTS (
             SELECT 1
               FROM (
                 SELECT candidate.id,
                        candidate.next_attempt_at,
                        candidate.created_at,
                        pg_catalog.row_number() OVER (
                          PARTITION BY candidate.delivery_scope_key
                          ORDER BY candidate.next_attempt_at,
                                   candidate.created_at,
                                   candidate.id
                        ) AS scope_rank
                   FROM public.email_outbox AS candidate
                  WHERE candidate.delivery_hold_version IS NULL
                    AND candidate.status = 'pending'
                    AND candidate.next_attempt_at <=
                          pg_catalog.statement_timestamp()
                    AND candidate.claim_token IS NULL
                    AND candidate.claim_owner IS NULL
                    AND candidate.lease_expires_at IS NULL
                    AND candidate.provider_call_started IS NULL
                    AND candidate.adapter IS NULL
                    AND candidate.provider_message_id IS NULL
                    AND candidate.quarantined_at IS NULL
               ) AS eligible
              WHERE eligible.scope_rank = 1
              ORDER BY eligible.next_attempt_at,
                       eligible.created_at,
                       eligible.id
              LIMIT 16
           )
         )::pg_catalog.text;`,
      ),
      "true",
      "Task 5 has no eligible row; released-row ordering belongs to Task 7",
    );
    pass("delivery-hold-zero-eligible");

    assert.equal(
      scalar(
        port,
        proofDatabase,
        `${insertHeldEventSql(
          {
            ...explicitNullRow,
            id: fixtureUuid("79", 711),
            operationId: fixtureUuid("7a", 711),
          },
          "NULL",
        )}
         RETURNING id;`,
        "learncoding_app",
      ),
      "",
      "an exact replay must remain suppressed while the original is held",
    );
    await expectDatabaseError(
      port,
      proofDatabase,
      "learncoding_app",
      `${insertHeldEventSql(
        {
          ...explicitNullRow,
          id: fixtureUuid("79", 712),
          operationId: fixtureUuid("7a", 712),
          variables: { fixture: "delivery-hold-divergent-replay" },
        },
        "NULL",
      )}
       RETURNING id;`,
      {
        code: "23505",
        constraint: "email_outbox_idempotency_authority_pkey",
        message: "email outbox idempotency event payload conflict",
      },
    );

    const deletedAccountRows = Number(
      scalar(
        port,
        proofDatabase,
        `WITH deleted AS (
           DELETE FROM public.email_outbox
            WHERE user_id = '${LEARNER_ID}'
               OR pg_catalog.lower(to_email) =
                    pg_catalog.lower('${LEARNER_EMAIL}')
           RETURNING 1
         )
         SELECT pg_catalog.count(*)::pg_catalog.text FROM deleted;`,
        "learncoding_app",
      ),
    );
    assert.ok(
      deletedAccountRows > 0,
      "the account-deletion path did not physically delete held rows",
    );
    assert.equal(
      scalar(
        port,
        proofDatabase,
        `SELECT (
           NOT EXISTS (
             SELECT 1
               FROM public.email_outbox
              WHERE id = '${explicitNullRow.id}'::pg_catalog.uuid
           )
           AND EXISTS (
             SELECT 1
               FROM public.email_outbox_idempotency_authority
              WHERE idempotency_sha256 = '${explicitNullRow.key}'
           )
         )::pg_catalog.text;`,
      ),
      "true",
      "physical deletion must preserve durable replay authority",
    );
    pass("delivery-hold-account-delete-preserved");

    assert.equal(
      scalar(
        port,
        proofDatabase,
        `${insertHeldEventSql(
          {
            ...explicitNullRow,
            id: fixtureUuid("79", 713),
            operationId: fixtureUuid("7a", 713),
          },
          "NULL",
        )}
         RETURNING id;`,
        "learncoding_app",
      ),
      "",
      "durable authority must suppress replay after physical deletion",
    );
    pass("delivery-hold-replay-guard-preserved");
  } catch (error) {
    operationError = error;
  } finally {
    if (proofDatabaseCreated) {
      await runCleanupStep(
        cleanupFailures,
        () => dropDisposableDatabase(port, proofDatabase),
        "delivery-hold proof database cleanup",
      );
    }
  }
  if (operationError !== undefined || cleanupFailures.length > 0) {
    throw preserveOperationAndCleanupFailures(
      operationError,
      cleanupFailures,
      "delivery-hold proof operation and cleanup failed",
    );
  }
}
function createOwnedDatabase(port, database, template) {
  run(executable("createdb"), [
    "--host=127.0.0.1",
    `--port=${port}`,
    "--username=postgres",
    "--owner=learncoding_owner",
    ...(template === undefined ? [] : [`--template=${template}`]),
    database,
  ]);
}

function dropDisposableDatabase(port, database) {
  run(executable("dropdb"), [
    "--host=127.0.0.1",
    `--port=${port}`,
    "--username=postgres",
    database,
  ]);
}
async function proveProductionMigrationFramework(
  port,
  temporaryRoot,
  runProductionMigration,
) {
  const candidateMigrations = stagedMigrationsThrough(temporaryRoot, 67);
  const candidateVerifier = candidateMigrationVerifier();
  const migrateCandidate = (database) => runProductionMigration({
    connectionString:
      `postgresql://learncoding_migrator@127.0.0.1:${port}/${database}`,
    migrationsFolder: candidateMigrations,
    operationTimeoutMs: OPERATION_TIMEOUT_MS,
    verifyReviewedMigrationRepository:
      candidateVerifier.verifyReviewedMigrationRepository,
    verifyAppliedMigrationLedger:
      candidateVerifier.verifyAppliedMigrationLedgerPrefix,
  });

  let operationError;
  const cleanupFailures = [];
  let frameworkDatabaseCreated = false;
  let rollbackDatabaseCreated = false;
  try {
  createOwnedDatabase(port, "mail0067_framework", "mail0067");
  frameworkDatabaseCreated = true;
  await migrateCandidate("mail0067_framework");
  const appliedState = scalar(
    port,
    "mail0067_framework",
    `
      SELECT pg_catalog.concat_ws('|',
        (SELECT pg_catalog.count(*)::text
           FROM drizzle.__drizzle_migrations),
        (pg_catalog.to_regclass(
          'public.email_outbox_idempotency_authority'
        ) IS NOT NULL)::text,
        (SELECT pg_catalog.count(*)::text
           FROM pg_catalog.pg_proc
          WHERE oid = pg_catalog.to_regprocedure(
            'public.claim_email_outbox_idempotency_authority()'
          ))
      );
    `,
  );
  assert.equal(appliedState, "68|true|1");
  await migrateCandidate("mail0067_framework");
  assert.equal(
    scalar(
      port,
      "mail0067_framework",
      `
        SELECT pg_catalog.concat_ws('|',
          (SELECT pg_catalog.count(*)::text
             FROM drizzle.__drizzle_migrations),
          (pg_catalog.to_regclass(
            'public.email_outbox_idempotency_authority'
          ) IS NOT NULL)::text,
          (SELECT pg_catalog.count(*)::text
             FROM pg_catalog.pg_proc
            WHERE oid = pg_catalog.to_regprocedure(
              'public.claim_email_outbox_idempotency_authority()'
            ))
        );
      `,
    ),
    appliedState,
    "unchanged framework replay must not duplicate journal or authority objects",
  );

  createOwnedDatabase(port, "mail0067_framework_rollback", "mail0067");
  rollbackDatabaseCreated = true;

  ownerSql(
    port,
    "mail0067_framework_rollback",
    `ALTER TABLE public.email_outbox
       ADD CONSTRAINT email_outbox_idempotency_authority_fk CHECK (true);`,
  );
  await assert.rejects(
    migrateCandidate("mail0067_framework_rollback"),
    /email_outbox_idempotency_authority_fk/u,
  );
  assert.equal(
    scalar(
      port,
      "mail0067_framework_rollback",
      `
        SELECT (
          (SELECT pg_catalog.count(*)
             FROM drizzle.__drizzle_migrations) = 67
          AND pg_catalog.to_regclass(
            'public.email_outbox_idempotency_authority'
          ) IS NULL
          AND NOT EXISTS (
            SELECT 1
              FROM pg_catalog.pg_attribute
             WHERE attrelid = 'public.email_outbox'::regclass
               AND attname IN (
                 'idempotency_authority_version',
                 'idempotency_authority_sha256',
                 'idempotency_original_payload_sha256'
               )
               AND NOT attisdropped
          )
          AND EXISTS (
            SELECT 1
              FROM pg_catalog.pg_constraint
             WHERE conrelid = 'public.email_outbox'::regclass
               AND conname = 'email_outbox_idempotency_authority_fk'
               AND contype = 'c'
          )
        )::text;
      `,
    ),
    "true",
    "late 0067 failure must preserve the 0066 journal and roll back early DDL",
  );
  ownerSql(
    port,
    "mail0067_framework_rollback",
    `ALTER TABLE public.email_outbox
       DROP CONSTRAINT email_outbox_idempotency_authority_fk;`,
  );
  await migrateCandidate("mail0067_framework_rollback");
  assert.equal(
    scalar(
      port,
      "mail0067_framework_rollback",
      `
        SELECT (
          (SELECT pg_catalog.count(*)
             FROM drizzle.__drizzle_migrations) = 68
          AND pg_catalog.to_regclass(
            'public.email_outbox_idempotency_authority'
          ) IS NOT NULL
        )::text;
      `,
    ),
    "true",
    "clean framework retry must apply the complete 0067 migration",
  );
  } catch (error) {
    operationError = error;
  } finally {
    if (rollbackDatabaseCreated) {
      await runCleanupStep(
        cleanupFailures,
        () => dropDisposableDatabase(
          port,
          "mail0067_framework_rollback",
        ),
        "rollback framework database cleanup",
      );
    }
    if (frameworkDatabaseCreated) {
      await runCleanupStep(
        cleanupFailures,
        () => dropDisposableDatabase(port, "mail0067_framework"),
        "framework database cleanup",
      );
    }
  }
  if (operationError !== undefined || cleanupFailures.length > 0) {
    throw preserveOperationAndCleanupFailures(
      operationError,
      cleanupFailures,
      "production migration framework operation and cleanup failed",
    );
  }
}

function assertExactClusterPaths({
  temporaryRoot,
  dataDirectory,
  logFile,
  socketDirectory,
}) {
  const resolvedRoot = path.resolve(temporaryRoot);
  assert.equal(path.dirname(resolvedRoot), path.resolve(os.tmpdir()));
  assert.match(
    path.basename(resolvedRoot),
    new RegExp(
      `^codestead-mail-0067-pg${postgresMajor}-[A-Za-z0-9_-]{6,}$`,
      "u",
    ),
  );
  assert.equal(path.resolve(dataDirectory), path.join(resolvedRoot, "data"));
  assert.equal(
    path.resolve(logFile),
    path.join(resolvedRoot, "postgres.log"),
  );
  assert.equal(
    path.resolve(socketDirectory),
    path.join(resolvedRoot, "socket"),
  );
}

function sanitizeHarnessDiagnostic(value) {
  let result = String(value);
  if (diagnosticTemporaryRoot !== undefined) {
    const resolvedRoot = path.resolve(diagnosticTemporaryRoot);
    for (const exposedRoot of new Set([
      diagnosticTemporaryRoot,
      resolvedRoot,
      resolvedRoot.replaceAll("\\", "/"),
    ])) {
      result = result.replaceAll(exposedRoot, "<temporary-root>");
    }
  }
  return result;
}

function readTemporaryPostgresLog(logFile) {
  try {
    const bytes = readFileSync(logFile);
    const truncated = bytes.length > TEMPORARY_LOG_MAX_BYTES;
    const excerpt = bytes.subarray(
      Math.max(0, bytes.length - TEMPORARY_LOG_MAX_BYTES),
    ).toString("utf8");
    return sanitizeHarnessDiagnostic(
      `${truncated ? "<temporary PostgreSQL log tail>" : ""}${excerpt}`,
    );
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? error.code
      : "unknown";
    return `<temporary PostgreSQL log unavailable:${String(code)}>`;
  }
}

function preserveOperationAndCleanupFailures(
  operationError,
  cleanupFailures,
  message,
) {
  if (operationError !== undefined) {
    if (cleanupFailures.length === 0) return operationError;
    return new AggregateError(
      [operationError, ...cleanupFailures],
      message,
      { cause: operationError },
    );
  }
  if (cleanupFailures.length === 1) return cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    return new AggregateError(cleanupFailures, message, {
      cause: cleanupFailures[0],
    });
  }
  return undefined;
}

function readExactPostmasterPid(dataDirectory) {
  try {
    const firstLine = readFileSync(
      path.join(dataDirectory, "postmaster.pid"),
      "utf8",
    ).split(/\r?\n/u, 1)[0];
    assert.match(firstLine, /^[1-9][0-9]*$/u);
    return Number.parseInt(firstLine, 10);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function processStillExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ESRCH") {
      return false;
    }
    if (error && typeof error === "object" && error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

async function countLoopbackListeners(port) {
  return await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (error, count) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolve(count);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => finish(undefined, 1));
    socket.once("error", (error) => {
      if (error && error.code === "ECONNREFUSED") finish(undefined, 0);
      else finish(error);
    });
    socket.once("timeout", () => {
      finish(new Error(`loopback listener probe timed out for port ${port}`));
    });
  });
}

async function verifyExactClusterCleanup({
  temporaryRoot,
  dataDirectory,
  logFile,
  socketDirectory,
  port,
  postmasterPid,
}) {
  assertExactClusterPaths({
    temporaryRoot,
    dataDirectory,
    logFile,
    socketDirectory,
  });
  const status = run(
    executable("pg_ctl"),
    ["-D", dataDirectory, "status"],
    { allowFailure: true, stdio: "ignore", timeoutMs: 5_000 },
  );
  assert.notEqual(status.status, 0, "exact temporary cluster is still active");
  assert.equal(
    await countLoopbackListeners(port),
    0,
    "temporary PostgreSQL port still has a loopback listener",
  );
  if (postmasterPid !== undefined) {
    assert.equal(
      processStillExists(postmasterPid),
      false,
      `temporary PostgreSQL PID ${postmasterPid} survived pg_ctl stop`,
    );
  }
  const lingeringPid = readExactPostmasterPid(dataDirectory);
  if (lingeringPid !== undefined) {
    assert.equal(
      processStillExists(lingeringPid),
      false,
      `postmaster.pid still names a live process ${lingeringPid}`,
    );
  }
}

export async function main() {
  const version = run(executable("postgres"), ["--version"]).stdout.trim();
  assert.match(
    version,
    new RegExp(`PostgreSQL\\) ${postgresMajor}\\.`, "u"),
  );
  assertCandidateDigestMatchesReviewedLedger();
  let dataDirectory;
  let logFile;
  let socketDirectory;
  let socketOption;
  let phase0065Migrations;
  let phase0065Verifier;
  let phase0066Migrations;
  let phase0066Verifier;
  let port;
  let startAttempted = false;
  let startCompleted = false;
  let postmasterPid;
  let operationError;
  const cleanupFailures = [];
  const temporaryRoot = mkdtempSync(
    path.join(os.tmpdir(), `codestead-mail-0067-pg${postgresMajor}-`),
  );
  try {
    diagnosticTemporaryRoot = temporaryRoot;
    dataDirectory = path.join(temporaryRoot, "data");
    logFile = path.join(temporaryRoot, "postgres.log");
    socketDirectory = path.join(temporaryRoot, "socket");
    assertExactClusterPaths({
      temporaryRoot,
      dataDirectory,
      logFile,
      socketDirectory,
    });
    mkdirSync(socketDirectory);
    socketOption = process.platform === "win32"
      ? ""
      : ` -k "${socketDirectory}"`;
    phase0065Migrations = stagedMigrationsThrough(temporaryRoot, 65);
    phase0065Verifier = prefixMigrationVerifier(65);
    phase0066Migrations = stagedMigrationsThrough(temporaryRoot, 66);
    phase0066Verifier = prefixMigrationVerifier(66);
    port = await settleWithin(
      allocateDisposableLoopbackPort(),
      "allocate disposable loopback port",
      SETUP_TIMEOUT_MS,
    );
    assert.notEqual(
      port,
      5432,
      "0067 disposable PostgreSQL port must not be 5432",
    );
    assert.equal(await countLoopbackListeners(port), 0);
    run(executable("initdb"), [
      `--pgdata=${dataDirectory}`,
      "--username=postgres",
      "--auth=trust",
      "--data-checksums",
      "--encoding=UTF8",
      "--no-locale",
    ]);
    startAttempted = true;
    run(
      executable("pg_ctl"),
      [
        "-D",
        dataDirectory,
        "-l",
        logFile,
        "-o",
        `-p ${port} -h 127.0.0.1 -c max_connections=30${socketOption}`,
        "-w",
        "start",
      ],
      { stdio: "ignore", timeoutMs: 55_000 },
    );
    startCompleted = true;
    postmasterPid = readExactPostmasterPid(dataDirectory);
    assert.ok(postmasterPid !== undefined);
    assert.match(
      scalar(
        port,
        "postgres",
        "SELECT pg_catalog.current_setting('server_version_num');",
      ),
      new RegExp(`^${postgresMajor}[0-9]{4}$`, "u"),
    );
    assert.equal(
      scalar(
        port,
        "postgres",
        "SELECT pg_catalog.current_setting('data_checksums');",
      ),
      "on",
    );
    psql(
      port,
      "postgres",
      `
        CREATE ROLE learncoding_owner NOLOGIN NOINHERIT;
        CREATE ROLE learncoding_migrator LOGIN NOINHERIT;
        CREATE ROLE learncoding_app LOGIN NOINHERIT;
        CREATE ROLE learncoding_worker LOGIN NOINHERIT;
        CREATE ROLE learncoding_ops LOGIN NOINHERIT;
        CREATE ROLE learncoding_backup_reporter LOGIN NOINHERIT;
        CREATE ROLE mail_default_grantee NOLOGIN NOINHERIT;
        CREATE ROLE mail_acl_grantor NOLOGIN NOINHERIT;
        CREATE ROLE mail_acl_leaf NOLOGIN NOINHERIT;
        GRANT learncoding_owner TO learncoding_migrator
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
        GRANT mail_acl_grantor TO learncoding_owner
          WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
      `,
    );
    run(executable("createdb"), [
      "--host=127.0.0.1",
      `--port=${port}`,
      "--username=postgres",
      "--owner=learncoding_owner",
      "mail0067",
    ]);
    const { runProductionMigration } =
      await import("../../scripts/migrate-production.mjs");
    await runProductionMigration({
      connectionString:
        `postgresql://learncoding_migrator@127.0.0.1:${port}/mail0067`,
      migrationsFolder: phase0065Migrations,
      operationTimeoutMs: OPERATION_TIMEOUT_MS,
      verifyReviewedMigrationRepository:
        phase0065Verifier.verifyReviewedMigrationRepository,
      verifyAppliedMigrationLedger:
        phase0065Verifier.verifyAppliedMigrationLedgerPrefix,
    });
    await reconcileReviewedPrivileges(port, "mail0067", {
      phase: "0065",
      phaseIndex: 65,
    });
    await runProductionMigration({
      connectionString:
        `postgresql://learncoding_migrator@127.0.0.1:${port}/mail0067`,
      migrationsFolder: phase0066Migrations,
      operationTimeoutMs: OPERATION_TIMEOUT_MS,
      verifyReviewedMigrationRepository:
        phase0066Verifier.verifyReviewedMigrationRepository,
      verifyAppliedMigrationLedger:
        phase0066Verifier.verifyAppliedMigrationLedgerPrefix,
    });
    await reconcileReviewedPrivileges(port, "mail0067", {
      phase: "0066",
      phaseIndex: 66,
    });
    proveHostileTemporaryTypeSearchPath(port, "mail0067");
    await proveBeforeCommitJournalMutationRollback(port, "mail0067");
    await proveProductionMigrationFramework(
      port,
      temporaryRoot,
      runProductionMigration,
    );

    seedSources(port, "mail0067");
    const {
      blockedPolicyRows,
      retained,
      primarySourceMapNearMisses,
      additionalSourceMapNearMisses,
      legacyRowCount,
    } = seedLegacyOutbox(port, "mail0067");
    const terminalReplayRow = {
      id: scalar(
        port,
        "mail0067",
        `SELECT outbox_id::pg_catalog.text
           FROM public.backup_status_mail_authority
          WHERE run_key = '${BACKUP_RUN_KEY}';`,
      ),
      userId: ADMIN_ID,
      stableKey: accountEventKey(
        "backup-status",
        ADMIN_ID,
        `success:${BACKUP_RUN_KEY}`,
      ),
    };
    assert.match(terminalReplayRow.id, /^[0-9a-f-]{36}$/u);
    assert.match(terminalReplayRow.stableKey, /^[0-9a-f]{64}$/u);
    ownerSql(
      port,
      "mail0067",
      `UPDATE public.email_outbox
          SET status = 'sent',
              sent_at = pg_catalog.statement_timestamp(),
              updated_at = pg_catalog.statement_timestamp()
        WHERE id = '${terminalReplayRow.id}'::pg_catalog.uuid
          AND status = 'pending';`,
    );
    poison0067DefaultAcls(port, "mail0067");
    await proveUnknownTemplateCutoverRollback(
      port,
      "mail0067",
      legacyRowCount,
      temporaryRoot,
      runProductionMigration,
    );
    await proveDeliveryHoldAuthority(port, "mail0067");
    await proveCutoverNowaitAndAtomicRetry(
      port,
      "mail0067",
      legacyRowCount,
    );
    proveCatalogAndAcl(port, "mail0067");
    await proveWriterInventoryRoutineCatalog(port, "mail0067");
    proveOriginalPayloadDigestVectors(port, "mail0067");
    await proveOriginalPayloadVariableSemantics(port, "mail0067");
    await proveReplayConflictFingerprintSemantics(port, "mail0067");
    proveCompositeAuthorityBackstop(port, "mail0067");
    proveLegacyClassification(
      port,
      "mail0067",
      blockedPolicyRows,
      retained,
      primarySourceMapNearMisses,
      additionalSourceMapNearMisses,
    );
    await proveBlockedRowsDoNotAliasNativeEvents(
      port,
      "mail0067",
      blockedPolicyRows,
    );
    proveNewReplayAndRollback(port, "mail0067");
    await proveSameStatementAuthority(port, "mail0067");
    await proveUnrelatedConflictCannotOrphanAuthority(port, "mail0067");
    proveNullDigestConstraintIsFailClosed(port, "mail0067");
    await proveClaimIsolationAndTimeout(port, "mail0067");
    await proveConcurrentClaims(port, "mail0067");
    await proveCoverageLockAndTerminalReplay(
      port,
      "mail0067",
      terminalReplayRow,
    );
    proveFailClosedAndMutationProtection(port, "mail0067", retained);
    process.stdout.write(
      "mail_durable_replay_0067=fail_closed_mutation:pass\n",
    );
    proveBackupCompatibility(port, "mail0067");
    process.stdout.write(
      "mail_durable_replay_0067=backup_compatibility:pass\n",
    );
    reportReplayAuthorityConstraintCatalog(port, "mail0067");
    await proveBootstrapReconciliation(port, "mail0067");
    process.stdout.write(
      "mail_durable_replay_0067=bootstrap_reconciliation:pass\n",
    );
    await proveWorkerRoleSharedWriter(port, "mail0067");

  } catch (error) {
    operationError = error;
  } finally {
    const cleanupDeadline = createOperationDeadline(CLEANUP_TIMEOUT_MS);
    await cleanupTrackedResources(cleanupFailures, cleanupDeadline);
    try {
      assertTrackedResourceRegistryEmpty();
    } catch (error) {
      cleanupFailures.push(error);
    }

    const rememberCleanupError = (error) => {
      cleanupFailures.push(error);
    };
    if (dataDirectory && logFile && socketDirectory && port !== undefined) {
      try {
        assertExactClusterPaths({
          temporaryRoot,
          dataDirectory,
          logFile,
          socketDirectory,
        });
        const listenerCountBeforeStop = await countLoopbackListeners(port);
        process.stdout.write(
          `mail_durable_replay_0067=listener_count_before_stop:${listenerCountBeforeStop}\n`,
        );
        if (startCompleted && operationError === undefined) {
          assert.equal(listenerCountBeforeStop, 1);
        }
      } catch (error) {
        rememberCleanupError(error);
      }
    }

    if (startAttempted && dataDirectory && logFile) {
      try {
        const stopped = run(
          executable("pg_ctl"),
          ["-D", dataDirectory, "stop", "-m", "immediate", "-w"],
          {
            allowFailure: true,
            stdio: "ignore",
            timeoutMs: 30_000,
          },
        );
        if (startCompleted && stopped.status !== 0) {
          rememberCleanupError(new Error(
            `temporary PostgreSQL shutdown failed\n${
              readTemporaryPostgresLog(logFile)
            }`,
          ));
        }
      } catch (error) {
        rememberCleanupError(error);
      }
    }

    let cleanupVerified = !startAttempted;
    if (dataDirectory && logFile && socketDirectory && port !== undefined) {
      try {
        await verifyExactClusterCleanup({
          temporaryRoot,
          dataDirectory,
          logFile,
          socketDirectory,
          port,
          postmasterPid,
        });
        cleanupVerified = true;
      } catch (error) {
        cleanupVerified = false;
        rememberCleanupError(error);
      }
    }
    if (cleanupVerified) {
      try {
        rmSync(temporaryRoot, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } catch (error) {
        rememberCleanupError(error);
      }
    }
  }
  if (operationError !== undefined || cleanupFailures.length > 0) {
    throw preserveOperationAndCleanupFailures(
      operationError,
      cleanupFailures,
      "0067 PostgreSQL operation and cleanup failed",
    );
  }
  process.stdout.write(
    `mail_durable_replay_0067=postgres:${postgresMajor}:pass\n`,
  );
  process.stdout.write(
    "mail_durable_replay_0067=source_map:1:pass\n",
  );
  process.stdout.write(
    "mail_durable_replay_0067=blocked:85:pass\n",
  );
  process.stdout.write(
    "mail_durable_replay_0067=retained:7:pass\n",
  );
  process.stdout.write(
    "mail_durable_replay_0067=conflict_covered:93:pass\n",
  );
  process.stdout.write(
    "mail_durable_replay_0067=authority:94:pass\n",
  );
  process.stdout.write(
    "mail_durable_replay_0067=replay_races_acl_backup:pass\n",
  );
  process.stdout.write(
    "mail_durable_replay_0067=bootstrap_catalog_acl:pass\n",
  );
}
