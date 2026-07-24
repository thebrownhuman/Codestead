import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

function serviceBlock(compose, name) {
  const start = compose.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing Compose service ${name}`);
  const remainder = compose.slice(start + 1);
  const next = remainder.search(/^  [a-zA-Z0-9][a-zA-Z0-9-]*:\s*$/mu);
  return next === -1 ? compose.slice(start) : compose.slice(start, start + 1 + next);
}

function databaseSecretTargets(block) {
  const databaseSources = [
    "database_bootstrap_url",
    "database_url",
    "database_migrator_url",
    "database_worker_url",
    "database_ops_url",
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
  };

  for (const [service, mounts] of Object.entries(expected)) {
    assert.deepEqual(databaseSecretTargets(serviceBlock(compose, service)), mounts);
  }
});

test("PostgreSQL is fixed-user, capability-free, and custom-socket-only", () => {
  const compose = read("compose.yaml");
  const postgres = serviceBlock(compose, "postgres");
  const prep = read("infra/ops/prepare-postgres-control-socket.sh");

  assert.match(postgres, /user: "\$\{POSTGRES_UID:\?[^}]+\}:\$\{POSTGRES_GID:\?[^}]+\}"/u);
  assert.match(postgres, /cap_drop:\s*\r?\n\s+- ALL/u);
  assert.match(postgres, /pg_isready -h \/run\/learncoding-postgres/u);
  assert.doesNotMatch(prep, /expected_uid=999|expected_gid=999/u);
  assert.match(prep, /POSTGRES_UID/u);
  assert.match(prep, /POSTGRES_GID/u);
  assert.match(prep, /find[^\n]+-xdev/u);
  assert.match(prep, /realpath[^\n]+--canonicalize-existing[^\n]+--no-symlinks/u);
  assert.match(prep, /canonical_data_root[^\n]+==[^\n]+data_root/u);
  assert.doesNotMatch(prep, /findmnt[^\n]*\|\| true/u);

  const unit = read("infra/systemd/learncoding-compose.service");
  const guardedStart = read("infra/ops/start-production-stack.sh");
  const starts = [...unit.matchAll(/^ExecStart=(.+)$/gmu)].map((match) => match[1]);
  const reloads = [...unit.matchAll(/^ExecReload=(.+)$/gmu)].map((match) => match[1]);
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
    "NODE_OPTIONS='' run_with_deadline 120 \"$node_bin\" \"$object_preparer\"",
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
  assert.match(bootstrap, /ALTER DEFAULT PRIVILEGES/iu);
  assert.match(migration, /SET ROLE learncoding_owner/u);
  assert.match(migration, /RESET ROLE/u);
  assert.match(migration, /current_user/u);
  assert.match(migration, /session_user/u);
});

test("mail worker outbox grants allow queue state changes but deny payload mutation", () => {
  const bootstrap = read("scripts/bootstrap-database-roles.mjs");
  const migration = read("drizzle/0061_mail_worker_outbox_privileges.sql");

  for (const source of [bootstrap, migration]) {
    assert.match(source, /revoke all on table public\.email_outbox from learncoding_worker/iu);
    assert.match(source, /grant select on table public\.email_outbox to learncoding_worker/iu);
    assert.match(source, /grant insert \([^)]+\)[\s\S]+public\.email_outbox to learncoding_worker/iu);
    assert.match(source, /grant update \([^)]+\)[\s\S]+public\.email_outbox to learncoding_worker/iu);
    assert.doesNotMatch(source, /grant (delete|truncate) on table public\.email_outbox to learncoding_worker/iu);
  }
  assert.doesNotMatch(migration, /grant update \([^)]*(variables|to_email|template|user_id)/iu);
});

test("release stops mutators and rejects residual sessions before credential rotation", () => {
  const release = read("infra/ops/release-production.sh");
  const stop = release.indexOf('current_stage="stop-database-mutators"');
  const sessions = release.indexOf('current_stage="reject-residual-database-sessions"');
  const roles = release.indexOf('current_stage="database-role-bootstrap"');
  const probes = release.indexOf('current_stage="database-negative-probes"');
  const migrate = release.indexOf('current_stage="migrate"');
  const seed = release.indexOf('current_stage="platform-seed"');

  assert.ok(stop >= 0 && stop < sessions);
  assert.ok(sessions < roles && roles < probes);
  assert.ok(probes < migrate && migrate < seed);
  assert.match(release, /pg_stat_activity/u);
});

test("restore reconstructs owner and ACL topology and smokes restricted roles", () => {
  const restore = read("scripts/backup/restore-drill-isolated.sh");
  const restoreCompose = read("infra/restore/restore-drill.compose.yaml");

  assert.match(restore, /--role=learncoding_owner/u);
  assert.match(restore, /database-role-bootstrap/u);
  assert.match(restore, /learncoding_app/u);
  assert.match(restore, /learncoding_worker/u);
  assert.match(restore, /learncoding_ops/u);
  assert.match(restore, /negative/u);
  assert.match(restoreCompose, /\/run\/learncoding-postgres/u);
  assert.match(restoreCompose, /cap_drop:\s*\r?\n\s+- ALL/u);
});

test("operator PostgreSQL clients name the custom socket", () => {
  for (const file of [
    "scripts/backup/backup.sh",
    "scripts/backup/common.sh",
    "scripts/backup/emergency-backup.sh",
    "scripts/backup/restore.sh",
    "scripts/backup/restore-drill-isolated.sh",
    "infra/ops/smoke-production.sh",
    "infra/ops/validate-runtime.sh",
  ]) {
    const source = read(file);
    const clientLines = source
      .split(/\r?\n/u)
      .filter((line) => /\b(pg_dump|pg_restore|psql|createdb|dropdb|pg_isready)\b/u.test(line));
    assert.ok(clientLines.length > 0, `${file} must contain a PostgreSQL client`);
    for (const line of clientLines) {
      assert.match(
        line,
        /\/run\/learncoding-postgres|POSTGRES_SOCKET/u,
        `${file} has an implicit-socket client: ${line.trim()}`,
      );
    }
  }
});
