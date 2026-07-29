import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  REVIEWED_0069_APPLICATION_FUNCTIONS,
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES,
  reviewedApplicationFunctionPrivilegesSql,
} from "../../scripts/bootstrap-database-roles.mjs";

import {
  CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
  DATABASE_RUNTIME_CAPABILITY_PHASES,
  planDatabaseRuntimeCapabilityReconciliation,
} from "../../scripts/database-runtime-capabilities.mjs";

const REVIEWED_PHASE_0069 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
  ({ index }) => index === 69,
);
assert.equal(REVIEWED_PHASE_0069?.index, 69);
const root = path.resolve(import.meta.dirname, "../..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

function serviceBlock(compose, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const serviceMatch = new RegExp(`^  ${escapedName}:\\s*$`, "mu").exec(
    compose,
  );
  assert.ok(serviceMatch, `missing Compose service ${name}`);
  const start = serviceMatch.index;
  const remainder = compose.slice(start + 1);
  const next = remainder.search(/^  [a-zA-Z0-9][a-zA-Z0-9-]*:\s*$/mu);
  return next === -1
    ? compose.slice(start)
    : compose.slice(start, start + 1 + next);
}

function databaseSecretTargets(block) {
  const databaseSources = [
    "database_bootstrap_url",
    "database_url",
    "database_migrator_url",
    "database_worker_url",
    "database_ops_url",
    "database_backup_reporter_url",
    "postgres_password",
  ];
  return databaseSources.flatMap((source) => {
    const longForm = new RegExp(
      `- source: ${source}\\r?\\n\\s+target: ([^\\r\\n]+)`,
      "gu",
    );
    const matches = [...block.matchAll(longForm)].map(
      (match) => `${source}:${match[1].trim()}`,
    );
    if (matches.length > 0) return matches;
    return new RegExp(`^\\s+- ${source}\\s*$`, "mu").test(block)
      ? [`${source}:${source}`]
      : [];
  });
}

test("Compose mounts the exact database credential matrix", () => {
  const compose = read("compose.yaml");
  const expected = {
    postgres: ["postgres_password:postgres_password"],
    "database-role-bootstrap": [
      "database_bootstrap_url:database_bootstrap_url",
      "database_url:database_app_url",
      "database_migrator_url:database_migrator_url",
      "database_worker_url:database_worker_url",
      "database_ops_url:database_ops_url",
      "database_backup_reporter_url:database_backup_reporter_url",
    ],
    "database-negative-probes": [
      "database_bootstrap_url:database_bootstrap_url",
      "database_url:database_app_url",
      "database_migrator_url:database_migrator_url",
      "database_worker_url:database_worker_url",
      "database_ops_url:database_ops_url",
      "database_backup_reporter_url:database_backup_reporter_url",
    ],
    "database-boundary-verifier": [
      "database_bootstrap_url:database_bootstrap_url",
      "database_url:database_app_url",
      "database_migrator_url:database_migrator_url",
      "database_worker_url:database_worker_url",
      "database_ops_url:database_ops_url",
      "database_backup_reporter_url:database_backup_reporter_url",
    ],
    migrate: ["database_migrator_url:database_url"],
    app: ["database_url:database_url"],
    "mail-worker": ["database_worker_url:database_url"],
    "reward-worker": ["database_worker_url:database_url"],
    "regrade-worker": ["database_worker_url:database_url"],
    "exam-finalization-worker": ["database_worker_url:database_url"],
    "practice-runner-recovery-worker": ["database_worker_url:database_url"],
    "project-review-correction-worker": ["database_worker_url:database_url"],
    "scan-worker": ["database_worker_url:database_url"],
    lifecycle: ["database_ops_url:database_url"],
    "platform-seed": ["database_ops_url:database_url"],
    "admin-bootstrap": ["database_ops_url:database_url"],
    "backup-status-reporter": [
      "database_backup_reporter_url:database_backup_reporter_url",
    ],
  };

  for (const [service, mounts] of Object.entries(expected)) {
    assert.deepEqual(
      databaseSecretTargets(serviceBlock(compose, service)),
      mounts,
    );
  }
});

test("PostgreSQL is fixed-user, capability-free, and custom-socket-only", () => {
  const compose = read("compose.yaml");
  const postgres = serviceBlock(compose, "postgres");
  const prep = read("infra/ops/prepare-postgres-control-socket.sh");

  assert.match(
    postgres,
    /user: "\$\{POSTGRES_UID:\?[^}]+\}:\$\{POSTGRES_GID:\?[^}]+\}"/u,
  );
  assert.match(postgres, /cap_drop:\s*\r?\n\s+- ALL/u);
  assert.match(postgres, /pg_isready -h \/run\/learncoding-postgres/u);
  assert.doesNotMatch(prep, /expected_uid=999|expected_gid=999/u);
  assert.match(prep, /POSTGRES_UID/u);
  assert.match(prep, /POSTGRES_GID/u);
  assert.match(prep, /find[^\n]+-xdev/u);
  assert.match(
    prep,
    /realpath[^\n]+--canonicalize-existing[^\n]+--no-symlinks/u,
  );
  assert.match(prep, /canonical_data_root[^\n]+==[^\n]+data_root/u);
  assert.doesNotMatch(prep, /findmnt[^\n]*\|\| true/u);

  const unit = read("infra/systemd/learncoding-compose.service");
  const guardedStart = read("infra/ops/start-production-stack.sh");
  const starts = [...unit.matchAll(/^ExecStart=(.+)$/gmu)].map(
    (match) => match[1],
  );
  const reloads = [...unit.matchAll(/^ExecReload=(.+)$/gmu)].map(
    (match) => match[1],
  );
  const pinned = "/usr/bin/env PATH=/usr/sbin:/usr/bin:/sbin:/bin";
  const guardedCommand = `${pinned} /usr/bin/bash /opt/learncoding/infra/ops/start-production-stack.sh --startup-wait 600`;
  assert.deepEqual(starts, [guardedCommand]);
  assert.deepEqual(reloads, [guardedCommand]);
  assert.doesNotMatch(unit, /^ExecStartPre=|^ExecStartPost=/mu);

  const stopIngress = guardedStart.indexOf(
    "quarantine_public_ingress || fatal 'unable to quarantine public ingress'",
  );
  const confirmIngressStopped = guardedStart.indexOf(
    "stop_compose_tunnel || fatal 'unable to confirm Compose ingress quarantine'",
  );
  const preflight = guardedStart.indexOf(
    'run_with_deadline 120 "$bash_bin" "$validator" --pre-privileged',
  );
  const preparePostgres = guardedStart.indexOf(
    'run_with_deadline 120 "$bash_bin" "$postgres_preparer"',
  );
  const prepareObjects = guardedStart.indexOf(
    'NODE_OPTIONS=\'\' run_with_deadline 120 "$node_bin" "$object_preparer"',
  );
  const fullValidation = guardedStart.indexOf(
    'run_with_deadline 120 "$bash_bin" "$validator" ||',
  );
  const internalStart = guardedStart.indexOf(
    'up -d --no-build --pull never --no-deps "${selected_internal_services[@]}"',
  );
  assert.ok(
    stopIngress >= 0 &&
      stopIngress < confirmIngressStopped &&
      confirmIngressStopped < preflight,
  );
  assert.ok(preflight < prepareObjects && prepareObjects < preparePostgres);
  assert.ok(preparePostgres < fullValidation && fullValidation < internalStart);
});

test("bootstrap and migration share the administration lock without broad reassignment", () => {
  const bootstrap = read("scripts/bootstrap-database-roles.mjs");
  const migration = read("scripts/migrate-production.mjs");

  for (const source of [bootstrap, migration]) {
    assert.match(source, /codestead:database-administration:v1/u);
  }
  assert.doesNotMatch(bootstrap, /REASSIGN\s+OWNED/iu);
  assert.match(bootstrap, /pg_database_owner/u);
  assert.match(bootstrap, /learncoding_owner/u);
  assert.match(bootstrap, /learncoding_migrator/u);
  assert.doesNotMatch(
    bootstrap,
    /\bgrant\b[^;]*\bon\s+all\s+(?:tables|sequences|routines)\b[^;]*\bto\s+learncoding_(?:app|worker|ops|migrator|backup_reporter)\b/iu,
  );
  assert.doesNotMatch(
    bootstrap,
    /alter default privileges[^;]*\bgrant\b[^;]*\bto\s+learncoding_(?:app|worker|ops|migrator|backup_reporter)\b/iu,
  );
  assert.doesNotMatch(
    bootstrap,
    /applyDatabaseRolePrivilegeReconciliation|reconcileRestoredNoAclDatabaseRolePrivileges/u,
  );
  const bootstrapRun =
    bootstrap.match(
      /export async function runDatabaseRoleBootstrap\(options\) \{([\s\S]*?)\n\}/u,
    )?.[1] ?? "";
  const roleRepair = bootstrapRun.indexOf("createAndResetRoles(");
  const ownership = bootstrapRun.indexOf(
    "transferBootstrapDatabaseRuntimeCapabilityOwnership(",
  );
  const reconcile = bootstrapRun.indexOf(
    "reconcileBootstrapDatabaseRuntimeCapabilities(",
  );
  const exactVerify = bootstrapRun.indexOf(
    "verifyBootstrapDatabaseRuntimeCapabilities(",
  );
  const foundation = bootstrapRun.indexOf(
    "establishBootstrapDatabaseRuntimeCapabilityFoundation(",
  );
  const foundationVerify = bootstrapRun.indexOf(
    "verifyBootstrapDatabaseRuntimeCapabilityFoundation(",
  );
  assert.ok(roleRepair >= 0);
  assert.ok(ownership > roleRepair);
  assert.ok(reconcile > ownership);
  assert.ok(exactVerify > reconcile);
  assert.ok(foundation > reconcile);
  assert.ok(foundationVerify > foundation);
  assert.match(migration, /SET ROLE learncoding_owner/u);
  assert.match(migration, /RESET ROLE/u);
  assert.match(migration, /current_user/u);
  assert.match(migration, /session_user/u);
});

test("manifest reconciliation is behaviorally exact and fail-closed", () => {
  const policy = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
  const exactCatalog = structuredClone(policy);
  const exactPlan = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog: exactCatalog,
  });
  assert.equal(exactPlan.blocked, false);
  assert.deepEqual(exactPlan.mutations, []);

  const missingCatalog = structuredClone(policy);
  const missing = missingCatalog.grants.find(
    (entry) =>
      entry.objectKind === "table" &&
      entry.object === "public.access_request" &&
      entry.grantee === "learncoding_app" &&
      entry.privilege === "SELECT",
  );
  assert.ok(missing);
  missingCatalog.grants = missingCatalog.grants.filter(
    (entry) => JSON.stringify(entry) !== JSON.stringify(missing),
  );
  const repairPlan = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog: missingCatalog,
  });
  assert.equal(repairPlan.blocked, false);
  assert.deepEqual(repairPlan.mutations, [
    {
      action: "add",
      collection: "grants",
      value: missing,
    },
  ]);

  const malformedCatalog = structuredClone(policy);
  malformedCatalog.grants[0].objectKind = "cluster";
  assert.throws(
    () =>
      planDatabaseRuntimeCapabilityReconciliation({
        phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
        policy,
        catalog: malformedCatalog,
      }),
    { name: "DatabaseRuntimeCapabilityValidationError" },
  );
});

test("bootstrap preserves exact reviewed application routine grants", () => {
  const bootstrap = read("scripts/bootstrap-database-roles.mjs");
  const reviewedGrantSql =
    reviewedApplicationFunctionPrivilegesSql(REVIEWED_PHASE_0069);
  const opsRoutineSignatures = REVIEWED_0069_APPLICATION_FUNCTIONS.filter(
    ({ allowedRoles }) => allowedRoles.includes("learncoding_ops"),
  ).map(({ signature }) => signature);

  assert.deepEqual(opsRoutineSignatures, [
    "public.email_outbox_idempotency_coverage_authority(uuid[])",
    "public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)",
  ]);
  assert.match(
    reviewedGrantSql,
    /grant execute on function public\.redact_quarantined_email_outbox_authority_v2\(timestamp with time zone,integer\) to learncoding_ops/iu,
  );
  assert.match(
    reviewedGrantSql,
    /grant execute on function public\.email_outbox_idempotency_coverage_authority\(uuid\[\]\) to learncoding_ops/iu,
  );
  assert.match(
    reviewedGrantSql,
    /grant execute on function public\.enqueue_backup_status_mail_authority\(text,text\) to learncoding_backup_reporter/iu,
  );
  assert.match(
    reviewedGrantSql,
    /grant execute on function public\.backup_status_mail_authorized\(uuid\) to learncoding_worker/iu,
  );
  assert.match(
    reviewedGrantSql,
    /grant execute on function public\.mail_delivery_release_receipt_sha256\(uuid,uuid,text,text,text,text\) to learncoding_worker/iu,
  );
  assert.match(
    reviewedGrantSql,
    /grant execute on function public\.release_email_outbox_delivery\(uuid,uuid,text,text,text\) to learncoding_app/iu,
  );
  assert.match(
    reviewedGrantSql,
    /grant execute on function public\.release_email_outbox_delivery\(uuid,uuid,text,text,text\) to learncoding_worker/iu,
  );
  assert.match(
    reviewedGrantSql,
    /grant execute on function public\.verify_email_outbox_delivery_release\(uuid,uuid,text,text,text\) to learncoding_app/iu,
  );
  assert.match(
    reviewedGrantSql,
    /grant execute on function public\.attest_email_outbox_delivery_release_lineage\(text\) to learncoding_worker/iu,
  );
  assert.match(
    reviewedGrantSql,
    /pg_catalog\.aclexplode\(\s*coalesce\(\s*routine\.proacl,\s*pg_catalog\.acldefault\('f', routine\.proowner\)\s*\)\s*\)/iu,
  );
  assert.match(reviewedGrantSql, /revoke all on function %s from %I cascade/iu);
  assert.match(
    reviewedGrantSql,
    /revoke all on function %s from public cascade/iu,
  );
  assert.match(
    bootstrap,
    /has_function_privilege\(0, p\.oid, 'EXECUTE'\)[\s\S]+is distinct from exists/iu,
  );
  assert.match(bootstrap, /routine_security_exact/u);
});

test("mail worker outbox grants allow queue state changes but deny payload mutation", () => {
  const bootstrap = read("scripts/bootstrap-database-roles.mjs");
  const migration = read("drizzle/0061_mail_worker_outbox_privileges.sql");

  assert.match(
    bootstrap,
    /revoke all on table public\.email_outbox from learncoding_app, learncoding_worker, learncoding_ops/iu,
  );
  assert.match(
    bootstrap,
    /grant select on table public\.email_outbox to learncoding_app, learncoding_worker, learncoding_ops/iu,
  );
  assert.match(
    migration,
    /revoke all on table public\.email_outbox from learncoding_worker/iu,
  );
  assert.match(
    migration,
    /grant select on table public\.email_outbox to learncoding_worker/iu,
  );
  for (const source of [bootstrap, migration]) {
    assert.match(
      source,
      /grant insert \([^)]+\)[\s\S]+public\.email_outbox to learncoding_worker/iu,
    );
    assert.match(
      source,
      /grant update \([^)]+\)[\s\S]+public\.email_outbox to learncoding_worker/iu,
    );
    assert.doesNotMatch(
      source,
      /grant (delete|truncate) on table public\.email_outbox to learncoding_worker/iu,
    );
  }
  assert.doesNotMatch(
    migration,
    /grant update \([^)]*(variables|to_email|template|user_id)/iu,
  );
});

test("release brackets migration with canonical role reconciliation", () => {
  const release = read("infra/ops/release-production.sh");
  const stop = release.indexOf('current_stage="stop-database-mutators"');
  const postgresVersion = release.indexOf(
    'current_stage="postgres-version-authority"',
  );
  const sessions = release.indexOf(
    'current_stage="reject-residual-database-sessions"',
  );
  const roles = release.indexOf('current_stage="database-role-bootstrap"');
  const probes = release.indexOf('current_stage="database-negative-probes"');
  const migrate = release.indexOf('current_stage="migrate"');
  const reconciliation = release.indexOf(
    'current_stage="database-role-reconciliation"',
  );
  const reconciliationService = release.indexOf(
    "run_one_shot database-role-bootstrap",
    reconciliation,
  );
  const seed = release.indexOf('current_stage="platform-seed"');

  assert.ok(stop >= 0 && stop < postgresVersion);
  assert.ok(postgresVersion < sessions && sessions < roles);
  assert.ok(roles < probes);
  assert.ok(probes < migrate && migrate < reconciliation);
  assert.ok(reconciliation < reconciliationService);
  assert.ok(reconciliationService < seed);
  assert.match(release, /pg_stat_activity/u);
  assert.match(release, /pg_catalog\.current_setting\('server_version_num'\)/u);
  assert.match(release, /production_postgres_major=17/u);
});

test("post-migration reconciliation is an app-rollback-eligible stage", () => {
  const rollback = read("infra/ops/rollback-production.sh");

  assert.match(
    rollback,
    /migrate\|database-role-reconciliation\|platform-seed/u,
  );
});

test("restore reconstructs owner and ACL topology and smokes restricted roles", () => {
  const restore = read("scripts/backup/restore-drill-isolated.sh");
  const restoreCompose = read("infra/restore/restore-drill.compose.yaml");

  const restoreVersion = restore.indexOf("codestead-restore-drill-pg-major-v1");
  const firstBootstrap = restore.indexOf(
    "restore_one_shot database-role-bootstrap",
  );
  const restoreDatabase = restore.indexOf("exec pg_restore");
  const secondBootstrap = restore.indexOf(
    "restore_one_shot database-role-bootstrap",
    firstBootstrap + 1,
  );
  const noAclReconciliation = restore.indexOf(
    "RESTORE_NO_ACL_RECONCILIATION=true",
  );
  const verifier = restore.indexOf(
    "restore_one_shot database-boundary-verifier",
  );

  assert.match(restore, /--role=learncoding_owner/u);
  assert.match(restore, /database-role-bootstrap/u);
  assert.match(restore, /learncoding_app/u);
  assert.match(restore, /learncoding_worker/u);
  assert.match(restore, /learncoding_ops/u);
  assert.match(restore, /learncoding_backup_reporter/u);
  assert.match(restore, /negative/u);
  assert.match(restore, /pg_catalog\.current_setting\('server_version_num'\)/u);
  assert.ok(restoreVersion >= 0 && restoreVersion < firstBootstrap);
  assert.ok(firstBootstrap < restoreDatabase);
  assert.ok(restoreDatabase < noAclReconciliation);
  assert.ok(
    noAclReconciliation < secondBootstrap && secondBootstrap < verifier,
  );
  assert.equal(
    (restore.match(/^RESTORE_NO_ACL_RECONCILIATION=true\s*\\$/gmu) ?? [])
      .length,
    1,
  );
  assert.match(
    restore,
    /REQUIRE_COMPLETE_MIGRATION_LEDGER=true\s*\\\s*\n\s*RESTORE_NO_ACL_RECONCILIATION=true\s*\\\s*\n\s*restore_one_shot database-role-bootstrap/u,
  );
  assert.doesNotMatch(
    restore.slice(firstBootstrap - 120, restoreDatabase),
    /RESTORE_NO_ACL_RECONCILIATION=true/u,
  );
  assert.match(
    restoreCompose,
    /RESTORE_NO_ACL_RECONCILIATION:\s*\$\{RESTORE_NO_ACL_RECONCILIATION:-false\}/u,
  );
  assert.match(restoreCompose, /\/run\/learncoding-postgres/u);
  assert.match(restoreCompose, /cap_drop:\s*\r?\n\s+- ALL/u);
});

test("operator PostgreSQL clients name the custom socket", () => {
  for (const file of [
    "scripts/backup/backup.sh",
    "scripts/backup/emergency-backup.sh",
    "scripts/backup/restore.sh",
    "scripts/backup/restore-drill-isolated.sh",
    "infra/ops/smoke-production.sh",
    "infra/ops/validate-runtime.sh",
  ]) {
    const source = read(file);
    const clientLines = source
      .split(/\r?\n/u)
      .filter((line) =>
        /\b(pg_dump|pg_restore|psql|createdb|dropdb|pg_isready)\b/u.test(line),
      );
    assert.ok(
      clientLines.length > 0,
      `${file} must contain a PostgreSQL client`,
    );
    for (const line of clientLines) {
      assert.match(
        line,
        /\/run\/learncoding-postgres|POSTGRES_SOCKET/u,
        `${file} has an implicit-socket client: ${line.trim()}`,
      );
    }
  }
});

test("host backup status reporting contains no direct PostgreSQL client", () => {
  const common = read("scripts/backup/common.sh");
  assert.doesNotMatch(
    common,
    /\b(pg_dump|pg_restore|psql|createdb|dropdb|pg_isready)\b/u,
  );
});

test("disposable least-privilege concurrency uses an asserted short authentication horizon", () => {
  const shell = read("infra/tests/database-least-privilege-integration.sh");
  const harness = read("infra/tests/database-least-privilege-integration.mjs");

  assert.match(
    shell,
    /"\$postgres_image"\s+-c authentication_timeout=1s\s+>\/dev\/null/u,
  );
  assert.match(
    harness,
    /current_setting\('authentication_timeout'\)[\s\S]*authentication_timeout_ms/u,
  );
  assert.match(harness, /authentication_timeout_ms,\s*1000/u);
  assert.match(harness, /lockTimeoutMs:\s*30_000/u);
});
