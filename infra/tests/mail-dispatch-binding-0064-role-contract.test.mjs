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
const release = repositoryFile("infra/ops/release-production.sh");
const productionCompose = repositoryFile("compose.yaml");
const restore = repositoryFile("scripts/backup/restore-drill-isolated.sh");
const restoreCompose = repositoryFile(
  "infra/restore/restore-drill.compose.yaml",
);

test("post-migration worker manifest retains both 0064 columns", () => {
  const allColumns = frozenStringArray(
    bootstrap,
    "MAIL_WORKER_OUTBOX_COLUMNS",
  );
  const insertColumns = frozenStringArray(
    bootstrap,
    "MAIL_WORKER_OUTBOX_INSERT_COLUMNS",
  );
  const updateColumns = frozenStringArray(
    bootstrap,
    "MAIL_WORKER_OUTBOX_UPDATE_COLUMNS",
  );

  for (const column of [
    "dispatch_binding_version",
    "dispatch_binding_sha256",
  ]) {
    assert.ok(allColumns.includes(column), `${column} missing from worker ACL`);
    assert.ok(updateColumns.includes(column), `${column} UPDATE missing`);
    assert.ok(!insertColumns.includes(column), `${column} INSERT must be denied`);
  }
});

test("bootstrap and production verifier own the exact 0064 object contract", () => {
  const requiredBootstrapTerms = [
    "public.enforce_email_outbox_dispatch_binding()",
    "email_outbox_dispatch_binding_guard",
    "email_outbox_dispatch_binding_valid",
    "dispatch_binding_version",
    "dispatch_binding_sha256",
  ];
  for (const term of requiredBootstrapTerms) {
    assert.ok(
      bootstrap.includes(term),
      `bootstrap 0064 manifest is missing ${term}`,
    );
  }

  const requiredVerifierTerms = [
    "public.enforce_email_outbox_dispatch_binding()",
    "email_outbox_dispatch_binding_guard",
    "email_outbox_dispatch_binding_valid",
    "dispatch_binding_version",
    "dispatch_binding_sha256",
    "learncoding_owner",
    "search_path=pg_catalog",
    "aclexplode",
    "pg_trigger",
    "tgqual",
    "tgnargs",
    "tgattr",
  ];
  for (const term of requiredVerifierTerms) {
    assert.ok(
      verifier.includes(term),
      `production verifier 0064 contract is missing ${term}`,
    );
  }
  assert.match(
    verifier,
    /prosecdef[\s\S]{0,240}(?:false|IS FALSE)|(?:false|IS FALSE)[\s\S]{0,240}prosecdef/u,
    "production verifier must require SECURITY INVOKER",
  );
});

test("release and restore execute the production verifier after migration", () => {
  assert.match(
    productionCompose,
    /database-boundary-verifier:[\s\S]*?verify-database-role-boundaries\.mjs", "--require-application-objects"/u,
  );
  assert.match(
    restoreCompose,
    /database-boundary-verifier:[\s\S]*?verify-database-role-boundaries\.mjs", "--require-application-objects"/u,
  );

  const releaseMigration = release.indexOf('current_stage="migrate"');
  const releaseReconciliation = release.indexOf(
    'current_stage="database-role-reconciliation"',
  );
  const releaseVerifier = release.indexOf(
    'current_stage="database-boundary-verifier"',
  );
  assert.ok(releaseMigration >= 0);
  assert.ok(releaseReconciliation > releaseMigration);
  assert.ok(releaseVerifier > releaseReconciliation);
  assert.ok(
    release.includes("run_one_shot database-boundary-verifier"),
    "release must execute the production application-object verifier",
  );

  const restoreDump = restore.indexOf("exec pg_restore");
  const restoreReconciliation = restore.indexOf(
    "restore_one_shot database-role-bootstrap",
    restoreDump,
  );
  const restoreVerifier = restore.indexOf(
    "restore_one_shot database-boundary-verifier",
  );
  assert.ok(restoreDump >= 0);
  assert.ok(restoreReconciliation > restoreDump);
  assert.ok(restoreVerifier > restoreReconciliation);
});
