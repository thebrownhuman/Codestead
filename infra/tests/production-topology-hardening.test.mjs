#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");
const harness = read("infra/tests/production-topology.test.sh");
const workflow = read(".github/workflows/ci.yml");
const job = workflow.match(
  /^  production-topology:\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\n|(?![\s\S]))/mu,
)?.[0] ?? "";
const functionBlock = (name) => harness.match(
  new RegExp(`^${name}\\(\\) \\{\\n([\\s\\S]*?)^\\}`, "mu"),
)?.[0] ?? "";

test("daemon restart is restricted to an empty local system Docker socket and rechecked", () => {
  const scope = functionBlock("assert_disposable_daemon_scope");
  assert.match(scope, /docker context show/u);
  assert.match(scope, /docker context inspect/u);
  assert.match(scope, /unix:\/\/\/var\/run\/docker\.sock/u);
  assert.match(scope, /-S \/var\/run\/docker\.sock/u);
  assert.match(scope, /docker ps -aq/u);
  assert.match(scope, /if ! container_ids="\$\(docker ps -aq\)"; then/u);
  assert.doesNotMatch(scope, /done < <\(docker ps -aq\)/u);
  assert.match(scope, /com\.docker\.compose\.project/u);
  assert.match(harness, /assert_disposable_daemon_scope empty[\s\S]*reserve_runner_client_network/u);
  assert.match(
    harness,
    /capture_daemon_restart_baseline\n  assert_disposable_daemon_scope project-only\n  sudo -n systemctl restart docker\.service/u,
  );
});

test("daemon restart separates policy-recovered internals from guarded ingress recovery", () => {
  const capture = functionBlock("capture_daemon_restart_baseline");
  const policyProof = functionBlock("assert_policy_recovered_generations_changed");
  const quarantineProof = functionBlock("assert_cloudflared_quarantined_after_daemon_restart");
  const guardedRecovery = functionBlock("recover_ingress_after_daemon_restart");
  const ingressProof = functionBlock("assert_cloudflared_generation_changed_after_guarded_recovery");
  const parseServiceInventory = (name) =>
    (harness.match(new RegExp(`${name}=\\(([^)]*)\\)`, "u"))?.[1] ?? "")
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
  const internalServices = [
    "postgres", "app", "runner-stub", "runner-egress-gateway", "mail-worker",
    "reward-worker", "regrade-worker", "exam-finalization-worker",
    "practice-runner-recovery-worker", "project-review-correction-worker",
    "file-erasure-worker",
  ];
  assert.deepEqual(
    parseServiceInventory("long_running_services"),
    [...internalServices, "cloudflared"],
    "ordinary restart coverage must retain the exact ordered pilot service set",
  );
  assert.deepEqual(
    parseServiceInventory("policy_recovered_services"),
    internalServices,
    "Docker policy recovery must retain every internal service and exclude guarded ingress",
  );
  assert.match(capture, /long_running_services/u);
  assert.match(capture, /\.State\.StartedAt/u);
  assert.match(capture, /container_id/u);
  assert.match(policyProof, /policy_recovered_services/u);
  assert.match(policyProof, /\.State\.StartedAt/u);
  assert.match(policyProof, /daemon_started_before/u);
  assert.match(policyProof, /daemon_container_before/u);
  assert.match(quarantineProof, /false\|on-failure\|5/u);
  assert.match(guardedRecovery, /up --detach --no-build --pull never --no-deps cloudflared/u);
  assert.match(ingressProof, /daemon_started_before\[cloudflared\]/u);
  assert.doesNotMatch(
    harness.match(/policy_recovered_services=\([^)]*\)/u)?.[0] ?? "",
    /cloudflared/u,
  );
  const restart = harness.indexOf("sudo -n systemctl restart docker.service");
  const policyRecovered = harness.indexOf("wait_for_policy_recovered_stack", restart);
  const policyGenerationProof = harness.indexOf("assert_policy_recovered_generations_changed", policyRecovered);
  const quarantined = harness.indexOf("assert_cloudflared_quarantined_after_daemon_restart", policyGenerationProof);
  const recovered = harness.indexOf("recover_ingress_after_daemon_restart", quarantined);
  const fullStackReady = harness.indexOf("wait_for_existing_stack", recovered);
  const ingressGenerationProof = harness.indexOf("assert_cloudflared_generation_changed_after_guarded_recovery", fullStackReady);
  assert.ok(restart >= 0 && policyRecovered > restart && policyGenerationProof > policyRecovered);
  assert.ok(quarantined > policyGenerationProof && recovered > quarantined);
  assert.ok(fullStackReady > recovered && ingressGenerationProof > fullStackReady);
});

test("cleanup proves fallback network, Compose resources, images, and workdir are absent", () => {
  const cleanup = functionBlock("cleanup");
  const fallbackRemoval = cleanup.indexOf('docker network rm "$runner_client_network"');
  const remnantRecheck = cleanup.indexOf('remnants="$(project_resources)"');
  assert.ok(fallbackRemoval >= 0 && remnantRecheck > fallbackRemoval);
  assert.match(cleanup, /for image in "\$\{images\[@\]\}"/u);
  assert.match(cleanup, /docker image inspect "\$image"/u);
  assert.match(cleanup, /Disposable image remains after teardown/u);
  assert.match(cleanup, /docker image ls --quiet --filter "label=\$image_label"/u);
  assert.match(cleanup, /rm -rf -- "\$workdir_real"/u);
  assert.match(cleanup, /\[\[ ! -e "\$workdir_real" \]\]/u);
  assert.match(cleanup, /cleanup_failed/u);
  assert.match(cleanup, /status == 0 && cleanup_failed != 0/u);
  assert.doesNotMatch(cleanup, /docker network rm[^\n]*\|\| true/u);
});

test("seed and bootstrap proof uses explicit unique identities and an exact replay snapshot", () => {
  assert.match(harness, /expected_policy_identities=/u);
  assert.match(harness, /nvidia_nim:credential_validation:meta\/llama-3\.1-8b-instruct/u);
  assert.match(harness, /nvidia_nim:tutor:meta\/llama-3\.1-8b-instruct/u);
  assert.match(harness, /expected_achievement_identities=/u);
  for (const slug of [
    "first-independent-skill",
    "mastery-95",
    "project-evidence",
    "retained-one-week",
    "review-rhythm-8",
  ]) assert.match(harness, new RegExp(slug, "u"));
  assert.match(harness, /expected_course_identities=/u);
  const expectedCourses = [
    "ai",
    "c",
    "cpp",
    "css",
    "dsa",
    "git-tooling",
    "html",
    "java",
    "javascript",
    "programming-foundations",
    "python",
    "react",
  ];
  const courseLiteral = harness.match(
    /readonly expected_course_identities="([^"]+)"/u,
  )?.[1];
  assert.ok(courseLiteral, "expected course identity literal is missing");
  assert.deepEqual(courseLiteral.split(","), expectedCourses);
  assert.match(harness, /expected_curriculum_artifacts=964/u);
  assert.match(harness, /expected_module_project_templates=119/u);
  assert.match(harness, /assessment_bank:476,authored_lesson:476,course_manifest:12/u);
  assert.match(harness, /count\(distinct \(provider, operation, model\)\)/u);
  assert.match(harness, /count\(distinct slug\)/u);
  assert.match(harness, /count\(distinct \(course_version_id, artifact_key\)\)/u);
  assert.match(harness, /count\(distinct template_key\)/u);
  assert.match(harness, /where role='admin';/u);
  assert.match(harness, /where role='admin' and lower\(email\)=lower/u);
  assert.match(harness, /seed_snapshot_query=.*jsonb_build_object/u);
  assert.match(harness, /seed_snapshot_after.*==.*seed_snapshot_before/u);
});

test("workflow installs and harness refuses drift from reviewed Docker and Compose versions", () => {
  assert.match(
    job,
    /docker\/setup-compose-action@112d3e30db3bf437d207fea57f22510569d1ab97[^\n]*# v2\.0\.0/u,
  );
  assert.match(job, /version: v5\.3\.1/u);
  assert.match(job, /download\.docker\.com\/linux\/ubuntu\/gpg/u);
  assert.match(job, /1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570/u);
  assert.match(job, /docker-ce=\$docker_package_version/u);
  assert.match(job, /docker-ce-cli=\$docker_package_version/u);
  assert.match(job, /5:29\.6\.1-1~ubuntu\.24\.04~noble/u);
  assert.match(job, /docker version --format '\{\{\.Client\.Version\}\}'/u);
  assert.match(job, /docker version --format '\{\{\.Server\.Version\}\}'/u);
  assert.match(job, /docker compose version --short/u);
  assert.equal(
    job.match(/container_ids="\$\(docker ps -aq\)"/gu)?.length,
    2,
  );
  assert.doesNotMatch(job, /\[\[[^\n]*"\$\(docker ps -aq\)"/u);
  assert.match(harness, /expected_engine_version="29\.6\.1"/u);
  assert.match(harness, /expected_compose_version="5\.3\.1"/u);
  assert.match(harness, /docker version --format '\{\{\.Client\.Version\}\}'/u);
  assert.match(harness, /docker version --format '\{\{\.Server\.Version\}\}'/u);
  assert.match(harness, /docker compose version --short/u);
  assert.match(harness, /Docker Engine version drift/u);
  assert.match(harness, /Docker Compose version drift/u);
});

test("pilot inventory fails closed when project container enumeration fails", () => {
  const inventory = functionBlock("assert_pilot_inventory");
  assert.match(
    inventory,
    /if ! project_ids="\$\(docker ps -aq --filter "label=com\.docker\.compose\.project=\$COMPOSE_PROJECT_NAME"\)"; then/u,
  );
  assert.doesNotMatch(inventory, /done < <\(docker ps -aq/u);
});

test("ordinary runs enforce the empty local system daemon before mutation", () => {
  const scope = functionBlock("assert_disposable_daemon_scope");
  const preflight = harness.indexOf("\nassert_disposable_daemon_scope empty\n");
  const restartGuard = harness.indexOf('if [[ "${CODESTEAD_TOPOLOGY_RESTART_DOCKER:-0}" == 1 ]]');
  const firstMutation = harness.lastIndexOf('workdir="$(mktemp -d');
  assert.equal(
    harness.match(/^assert_disposable_daemon_scope empty$/gmu)?.length,
    1,
  );
  assert.ok(preflight >= 0 && preflight < restartGuard && restartGuard < firstMutation);
  assert.match(scope, /context_endpoint.*unix:\/\/\/var\/run\/docker\.sock/u);
  assert.match(scope, /effective_endpoint.*unix:\/\/\/var\/run\/docker\.sock/u);
  assert.match(scope, /Docker-daemon restart host contains a pre-existing container/u);
});

test("an early marker-aware EXIT trap owns the workdir before full cleanup exists", () => {
  const earlyCleanup = functionBlock("topology_early_cleanup");
  const workdirCreate = harness.lastIndexOf('workdir="$(mktemp -d');
  const earlyTrap = harness.indexOf("trap topology_early_cleanup EXIT", workdirCreate);
  const canonicalize = harness.indexOf('workdir_real="$(realpath -e -- "$workdir")"');
  const markerCreate = harness.lastIndexOf('touch "$workdir/.codestead-topology-owned"');
  const composeDefinition = harness.indexOf("compose=(docker compose");
  const fullTrap = harness.indexOf("trap cleanup EXIT");
  assert.match(earlyCleanup, /status=\$\?/u);
  assert.match(earlyCleanup, /workdir_marker_created/u);
  assert.match(earlyCleanup, /\.codestead-topology-owned/u);
  assert.match(earlyCleanup, /status == 0 && cleanup_failed != 0/u);
  assert.ok(
    workdirCreate >= 0 &&
    earlyTrap > workdirCreate &&
    earlyTrap < canonicalize &&
    canonicalize < markerCreate &&
    markerCreate < composeDefinition &&
    composeDefinition < fullTrap,
  );
  assert.match(job, /bash infra\/tests\/production-topology-early-cleanup\.test\.sh/u);
});

test("the exact pinned PostgreSQL identity owns both disposable bind directories", () => {
  const inspectIdentity = functionBlock("inspect_postgres_identity");
  const prepareDirs = functionBlock("prepare_postgres_bind_dirs");
  const pull = harness.indexOf('timeout 300 docker pull "$postgres_image"');
  const inspect = harness.indexOf("\ninspect_postgres_identity\n", pull);
  const prepare = harness.indexOf("\nprepare_postgres_bind_dirs\n", inspect);
  const composeConfig = harness.indexOf('timeout 180 "${compose[@]}" config --quiet');

  assert.match(inspectIdentity, /\/etc\/passwd/u);
  assert.match(inspectIdentity, /\/etc\/group/u);
  assert.match(inspectIdentity, /--pull never/u);
  assert.match(inspectIdentity, /--user 65534:65534/u);
  assert.match(inspectIdentity, /--read-only/u);
  assert.match(inspectIdentity, /--cap-drop ALL/u);
  assert.match(inspectIdentity, /--security-opt no-new-privileges:true/u);
  assert.match(inspectIdentity, /--pids-limit 32/u);
  assert.match(inspectIdentity, /--memory 64m/u);
  assert.match(inspectIdentity, /passwd_gid/u);
  assert.match(inspectIdentity, /999:999:999/u);
  assert.match(inspectIdentity, /999:999/u);
  assert.match(inspectIdentity, /export POSTGRES_UID POSTGRES_GID/u);
  assert.match(prepareDirs, /chown -- "\$POSTGRES_UID:\$POSTGRES_GID" "\$data_root\/postgres" "\$postgres_socket_dir"/u);
  assert.match(prepareDirs, /chmod 0700 "\$data_root\/postgres" "\$postgres_socket_dir"/u);
  assert.ok(pull >= 0 && pull < inspect && inspect < prepare && prepare < composeConfig);
});

test("live PostgreSQL proves its fixed user and zero capabilities before and after restart", () => {
  const proof = functionBlock("assert_postgres_least_privilege");
  const firstUp = harness.indexOf('up --detach --no-build --wait --wait-timeout 150 postgres');
  const firstProof = harness.indexOf("\nassert_postgres_least_privilege\n", firstUp);
  const restart = harness.indexOf('"${compose[@]}" restart postgres app');
  const secondProof = harness.indexOf("\nassert_postgres_least_privilege\n", restart);

  assert.match(proof, /\.Config\.User/u);
  assert.match(proof, /\.HostConfig\.CapDrop/u);
  assert.match(proof, /\.HostConfig\.CapAdd/u);
  assert.match(proof, /\.HostConfig\.SecurityOpt/u);
  assert.match(proof, /CapEff/u);
  assert.match(proof, /CapBnd/u);
  assert.match(proof, /NoNewPrivs/u);
  assert.match(proof, /process_identity/u);
  assert.match(proof, /\^\(Uid\|Gid\)/u);
  assert.match(proof, /Uid:\$POSTGRES_UID:\$POSTGRES_UID:\$POSTGRES_UID:\$POSTGRES_UID/u);
  assert.match(proof, /Gid:\$POSTGRES_GID:\$POSTGRES_GID:\$POSTGRES_GID:\$POSTGRES_GID/u);
  assert.match(proof, /unix_socket_directories/u);
  assert.match(proof, /stat -c/u);
  assert.ok(firstUp >= 0 && firstUp < firstProof && firstProof < restart && restart < secondProof);
});

test("database role bootstrap precedes migration and both contend on the shared administration lock", () => {
  const firstBootstrap = harness.indexOf("--no-deps database-role-bootstrap");
  const firstMigration = harness.indexOf("--no-deps migrate");
  assert.ok(firstBootstrap >= 0 && firstBootstrap < firstMigration);
  assert.match(harness, /codestead:database-administration:v1/u);
  assert.match(harness, /bootstrap-contended\.log/u);
  assert.match(harness, /migrate-one\.log/u);
  const observation = functionBlock("wait_for_database_admin_contenders");
  const observationCall = harness.indexOf("\nwait_for_database_admin_contenders\n");
  const contendersHeld = harness.indexOf('kill -0 "$lock_holder_pid" "$bootstrap_pid" "$migrate_pid"', observationCall);
  const noSuccess = harness.indexOf("if grep -F", contendersHeld);
  const lockReleased = harness.indexOf('wait "$lock_holder_pid"', noSuccess);
  assert.match(observation, /pg_stat_activity/u);
  assert.match(observation, /select pg_try_advisory_lock\(hashtextextended\(\$1, 0\)\) acquired/u);
  assert.match(observation, /learncoding:codestead-topology-role-bootstrap/u);
  assert.match(observation, /learncoding_migrator:codestead-topology-migrate/u);
  assert.match(observation, /kill -0 "\$lock_holder_pid" "\$bootstrap_pid" "\$migrate_pid"/u);
  assert.ok(observationCall >= 0 && observationCall < contendersHeld && contendersHeld < noSuccess && noSuccess < lockReleased);
  assert.doesNotMatch(harness.slice(observationCall, lockReleased), /sleep 3/u);
  assert.match(harness.slice(noSuccess, lockReleased), /database\.roles_bootstrapped[\s\S]*database\.migrated/u);
  assert.match(harness, /wait "\$bootstrap_pid"[\s\S]*wait "\$migrate_pid"/u);
});
test("topology database fixture passwords are distinct and at least 32 bytes", () => {
  const rawPassword = harness.match(/printf '%s' '([^']+)' >"\$secrets_dir\/postgres_password"/u)?.[1];
  const urlPasswords = [...harness.matchAll(/postgresql:\/\/[^:']+:([^@']+)@postgres:5432\/learncoding/gmu)]
    .map((match) => match[1]);
  assert.ok(rawPassword);
  assert.equal(urlPasswords.length, 5);
  assert.equal(urlPasswords[0], rawPassword);
  assert.equal(new Set(urlPasswords).size, 5);
  for (const password of urlPasswords) assert.ok(Buffer.byteLength(password, "utf8") >= 32);
});
test("topology psql clients pin the custom control socket", () => {
  const query = functionBlock("psql_query");
  assert.match(query, /--host \/run\/learncoding-postgres/u);
  assert.match(
    harness,
    /exec -T -e PGAPPNAME=codestead-topology-lock-holder postgres psql[\s\S]*--host \/run\/learncoding-postgres[\s\S]*codestead:database-administration:v1/u,
  );
});