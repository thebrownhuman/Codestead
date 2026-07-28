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
  const allColumns = frozenStringArray(bootstrap, "MAIL_WORKER_OUTBOX_COLUMNS");
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
    assert.ok(
      !insertColumns.includes(column),
      `${column} INSERT must be denied`,
    );
  }
});

test("bootstrap and production verifier own the exact 0064 object contract", () => {
  const requiredBootstrapTerms = [
    "public.enforce_email_outbox_dispatch_binding()",
    "email_outbox_dispatch_binding_guard",
    "email_outbox_dispatch_binding_valid",
    "dispatch_binding_version",
    "dispatch_binding_sha256",
    "learncoding_owner",
    "search_path=pg_catalog",
    "bodySha256",
    "definitionSha256",
    "migrationSha256",
  ];
  for (const term of requiredBootstrapTerms) {
    assert.ok(
      bootstrap.includes(term),
      `bootstrap 0064 manifest is missing ${term}`,
    );
  }

  const requiredVerifierTerms = [
    "REVIEWED_APPLICATION_FUNCTIONS",
    "REVIEWED_APPLICATION_TRIGGERS",
    "REVIEWED_APPLICATION_CONSTRAINTS",
    "dispatch_binding_version",
    "dispatch_binding_sha256",
    "body_sha256_exact",
    "definition_sha256_exact",
    "p.proargnames",
    "p.proargmodes",
    "p.proallargtypes",
    "p.pronargdefaults",
    "p.prorettype",
    "p.procost",
    "p.prorows",
    "p.prosupport",
    "p.protrftypes",
    "p.probin",
    "p.prosqlbody",
    "pg_get_functiondef",
    "outbox_owner_exact",
    "routine_direct_acl_exact",
    "worker_column_direct_acl_exact",
    "aclexplode",
    "pg_trigger",
    "pg_get_expr",
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
  assert.doesNotMatch(
    bootstrap,
    /readFileSync|new URL\(`\.\.\/drizzle\//u,
    "operations-image bootstrap must not read migration files at import time",
  );
  assert.match(
    verifier,
    /pg_catalog\.sha256[\s\S]*?pg_catalog\.pg_get_functiondef/u,
  );
  assert.ok(
    verifier.includes(
      "p.prosecdef is not distinct from $3::boolean security_definer_exact",
    ),
    "production verifier must compare SECURITY DEFINER/INVOKER exactly",
  );
});

test("bootstrap verifies raw reviewed contracts before role normalization", () => {
  const bootstrapStart = bootstrap.indexOf(
    "export async function runDatabaseRoleBootstrap(options)",
  );
  const rawContractCheck = bootstrap.indexOf(
    "await verifyPostMigrationReviewedContractsBeforeReconciliation(",
    bootstrapStart,
  );
  const roleReset = bootstrap.indexOf(
    "await createAndResetRoles(client)",
    bootstrapStart,
  );
  const ownershipRepair = bootstrap.indexOf(
    "await transferApplicationOwnership(",
    bootstrapStart,
  );

  assert.ok(bootstrapStart >= 0);
  assert.ok(rawContractCheck > bootstrapStart);
  assert.ok(roleReset > rawContractCheck);
  assert.ok(ownershipRepair > roleReset);
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
  const restoreNoAclReconciliation = restore.indexOf(
    "RESTORE_NO_ACL_RECONCILIATION=true",
  );
  const restoreVerifier = restore.indexOf(
    "restore_one_shot database-boundary-verifier",
  );
  assert.ok(restoreDump >= 0);
  assert.ok(restoreNoAclReconciliation > restoreDump);
  assert.ok(restoreReconciliation > restoreNoAclReconciliation);
  assert.ok(restoreVerifier > restoreReconciliation);
  assert.equal(
    (restore.match(/^RESTORE_NO_ACL_RECONCILIATION=true\s*\\$/gmu) ?? []).length,
    1,
  );
  assert.doesNotMatch(
    restore.slice(0, restoreDump),
    /RESTORE_NO_ACL_RECONCILIATION=true/u,
  );
});
