import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
