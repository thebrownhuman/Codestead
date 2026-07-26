import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REVIEWED_APPLICATION_CONSTRAINTS,
  REVIEWED_APPLICATION_FUNCTIONS,
  REVIEWED_APPLICATION_TRIGGERS,
  REVIEWED_0066_APPLICATION_FUNCTIONS,
  REVIEWED_0066_APPLICATION_TRIGGERS,
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES,
} from "../../scripts/bootstrap-database-roles.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");

function repositoryFile(relativePath) {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function frozenStringArray(source, name) {
  const match = source.match(
    new RegExp(
      `(?:export\\s+)?const\\s+${name}\\s*=\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\);`,
      "u",
    ),
  );
  assert.ok(match, `${name} must remain a checked-in frozen manifest`);
  return [...match[1].matchAll(/"([^"]+)"/gu)].map((entry) => entry[1]);
}

const bootstrap = repositoryFile("scripts/bootstrap-database-roles.mjs");
const verifier = repositoryFile("scripts/verify-database-role-boundaries.mjs");
const migration = repositoryFile(
  "drizzle/0066_mail_outbox_provider_correlation_evidence.sql",
);
const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const authorityColumns = [
  "provider_correlation_version",
  "provider_evidence_version",
  "provider_evidence_sha256",
];

test("worker manifests preserve the 0066 authority columns only for SELECT and UPDATE", () => {
  const allColumns = frozenStringArray(bootstrap, "MAIL_WORKER_OUTBOX_COLUMNS");
  const insertColumns = frozenStringArray(
    bootstrap,
    "MAIL_WORKER_OUTBOX_INSERT_COLUMNS",
  );
  const updateColumns = frozenStringArray(
    bootstrap,
    "MAIL_WORKER_OUTBOX_UPDATE_COLUMNS",
  );

  for (const column of authorityColumns) {
    assert.ok(allColumns.includes(column), `${column} missing from worker ACL`);
    assert.ok(updateColumns.includes(column), `${column} UPDATE missing`);
    assert.ok(!insertColumns.includes(column), `${column} INSERT must be denied`);
  }
  assert.match(
    bootstrap,
    /MAIL_WORKER_OUTBOX_PRE_EVIDENCE_UPDATE_COLUMNS/u,
  );
});

test("bootstrap detects only exact 0-or-3 provider evidence column states", () => {
  for (const column of authorityColumns) {
    assert.ok(bootstrap.includes(column), `bootstrap detector missing ${column}`);
  }
  assert.match(bootstrap, /provider_evidence_column_count\s+not\s+in\s+\(0,\s*3\)/u);
  assert.match(
    bootstrap,
    /provider_evidence_column_count\s*=\s*3[\s\S]*?provider_evidence_column_exact_count\s*<>\s*3/u,
  );
  assert.match(
    bootstrap,
    /binding_column_count\s*<>\s*2[\s\S]*?provider_evidence_column_count\s*=\s*3/u,
  );
});

test("production verifier models the intermediate 0064/0065 and final 0066 grants separately", () => {
  assert.ok(
    verifier.includes("MAIL_WORKER_OUTBOX_PRE_EVIDENCE_UPDATE_COLUMNS"),
  );
  assert.ok(verifier.includes("requiresProviderEvidence"));
  assert.match(
    verifier,
    /expectedProviderEvidenceColumnCount/u,
  );
  for (const column of authorityColumns) {
    assert.ok(verifier.includes(column), `verifier missing ${column}`);
  }
});

test("0066 migration seals its privileged objects without relying on bootstrap ordering", () => {
  assert.equal(
    sha256(migration),
    "3d4962ed82c0209245ca7e0a0e9ea667001eab7ae864f89120894cc1fa915ec9",
  );
  assert.match(
    migration,
    /CREATE FUNCTION\s+"public"\."enforce_email_outbox_provider_correlation_evidence"\(\)[\s\S]*?SECURITY INVOKER\s+SET search_path = pg_catalog/u,
  );
  assert.match(
    migration,
    /ALTER FUNCTION\s+"public"\."enforce_email_outbox_provider_correlation_evidence"\(\)\s+OWNER TO learncoding_owner/u,
  );
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION ' \|\|\s*'public\.enforce_email_outbox_provider_correlation_evidence\(\) ' \|\|\s*'FROM PUBLIC CASCADE'/u,
  );
  assert.match(
    migration,
    /public\.enforce_email_outbox_provider_correlation_evidence\(\) ' \|\|\s*'FROM %I CASCADE'/u,
  );
  assert.match(
    migration,
    /\) ON TABLE public\.email_outbox FROM PUBLIC CASCADE'/u,
  );
  assert.match(
    migration,
    /\) ON TABLE public\.email_outbox FROM %I CASCADE'/u,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION\s+"public"\."enforce_email_outbox_provider_correlation_evidence"\(\)\s+TO learncoding_owner/u,
  );
  assert.doesNotMatch(
    migration,
    /GRANT EXECUTE ON FUNCTION[\s\S]{0,180}\b(?:PUBLIC|learncoding_app|learncoding_worker|learncoding_ops)\b/u,
  );
  assert.match(
    migration,
    /GRANT UPDATE \(\s*provider_correlation_version,\s*provider_evidence_version,\s*provider_evidence_sha256\s*\) ON TABLE public\.email_outbox TO learncoding_worker/u,
  );
});

test("0066 exact routine, trigger, constraint, and phase are frozen in the verifier manifest", () => {
  const routine = REVIEWED_APPLICATION_FUNCTIONS.find(
    ({ signature }) =>
      signature
      === "public.enforce_email_outbox_provider_correlation_evidence()",
  );
  assert.deepEqual(
    routine
      ? {
          migrationFile: routine.migrationFile,
          owner: routine.owner,
          securityDefiner: routine.securityDefiner,
          configuration: routine.configuration,
          allowedRoles: routine.allowedRoles,
          bodySha256: routine.bodySha256,
          definitionSha256: routine.definitionSha256,
          returnType: routine.returnType,
        }
      : null,
    {
      migrationFile: "0066_mail_outbox_provider_correlation_evidence.sql",
      owner: "learncoding_owner",
      securityDefiner: false,
      configuration: ["search_path=pg_catalog"],
      allowedRoles: [],
      bodySha256:
        "62ff4885055979fb7eaf0fda3ae8170a14a430cb69d8f310e6aba742cf700e1a",
      definitionSha256:
        "afaab6796f97aa0294ff5a761679895f9ccfb78fea21e0be362979c5c4e5ab11",
      returnType: "trigger",
    },
  );

  const trigger = REVIEWED_APPLICATION_TRIGGERS.find(
    ({ name }) => name === "email_outbox_provider_correlation_evidence_guard",
  );
  assert.deepEqual(
    trigger ?? null,
    {
      relation: "public.email_outbox",
      name: "email_outbox_provider_correlation_evidence_guard",
      functionSignature:
        "public.enforce_email_outbox_provider_correlation_evidence()",
      enabled: "O",
      type: 23,
      predicate: null,
      arguments: [],
      watchedColumns: [],
    },
  );

  const constraint = REVIEWED_APPLICATION_CONSTRAINTS.find(
    ({ name }) => name === "email_outbox_provider_correlation_evidence_valid",
  );
  assert.ok(constraint);
  assert.equal(constraint.relation, "public.email_outbox");
  assert.equal(constraint.relationOwner, "learncoding_owner");
  assert.equal(constraint.type, "c");
  assert.equal(constraint.validated, true);
  assert.deepEqual(constraint.columns, [
    "adapter",
    "claim_owner",
    "claim_token",
    "claim_version",
    "dispatch_binding_sha256",
    "dispatch_binding_version",
    "last_error_code",
    "lease_expires_at",
    "provider_call_started",
    "provider_correlation_version",
    "provider_evidence_sha256",
    "provider_evidence_version",
    "provider_message_id",
    "quarantined_at",
    "sent_at",
    "status",
  ]);
  assert.equal(
    constraint.normalizedExpressionSha256,
    "2594dd57e4115fe9296d03888d8d1771b98e90725bce7e0d66c753eb1f0dba82",
  );

  assert.deepEqual(
    REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.map(({ index }) => index),
    [62, 63, 64, 65, 66, 67],
  );
  const phase0065 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === 65,
  );
  const phase0066 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === 66,
  );
  assert.equal(phase0065?.index, 65);
  assert.equal(phase0065?.requiresProviderEvidence, false);
  assert.deepEqual(
    phase0066
      ? {
          index: phase0066.index,
          createdAt: phase0066.createdAt,
          migrationFile: phase0066.migrationFile,
          migrationSha256: phase0066.migrationSha256,
          requiresWorkerContract: phase0066.requiresWorkerContract,
          requiresProviderEvidence: phase0066.requiresProviderEvidence,
          requiresReplayAuthority: phase0066.requiresReplayAuthority,
        }
      : null,
    {
      index: 66,
      createdAt: "1784997273087",
      migrationFile: "0066_mail_outbox_provider_correlation_evidence.sql",
      migrationSha256:
        "3d4962ed82c0209245ca7e0a0e9ea667001eab7ae864f89120894cc1fa915ec9",
      requiresWorkerContract: true,
      requiresProviderEvidence: true,
      requiresReplayAuthority: false,
    },
  );
  assert.equal(phase0066?.routines, REVIEWED_0066_APPLICATION_FUNCTIONS);
  assert.equal(phase0066?.triggers, REVIEWED_0066_APPLICATION_TRIGGERS);
  assert.equal(
    phase0066?.backupStatusAuthority,
    phase0065?.backupStatusAuthority,
  );
});
