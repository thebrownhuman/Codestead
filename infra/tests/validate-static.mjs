import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");
const failures = [];

function read(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) {
    failures.push(`missing required file: ${relative}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function expect(condition, message) {
  if (!condition) failures.push(message);
}

function dockerStage(name) {
  const marker = new RegExp(`^FROM [^\\n]+ AS ${name}\\s*$`, "m").exec(dockerfile);
  if (!marker) return "";

  const bodyStart = marker.index + marker[0].length;
  const remaining = dockerfile.slice(bodyStart);
  const nextStage = /^FROM\s+/m.exec(remaining);
  return nextStage ? remaining.slice(0, nextStage.index) : remaining;
}

function composeService(name) {
  return new RegExp(
    `^  ${name}:\\s*\\r?\\n([\\s\\S]*?)(?=^  [a-z0-9-]+:\\s*\\r?$|^networks:\\s*\\r?$)`,
    "m",
  ).exec(compose)?.[1] ?? "";
}

const dockerfile = read("Dockerfile");
const compose = read("compose.yaml");
const composeEnv = read("infra/env/compose.env.example");
const toolingStage = dockerStage("tooling");
const operationsStage = dockerStage("operations");
const migrationScript = read("scripts/migrate-production.mjs");
const cloudflare = read("infra/cloudflare/config.example.yml");
const entrypoint = read("infra/docker/entrypoint.sh");
const backup = read("scripts/backup/backup.sh");
const common = read("scripts/backup/common.sh");
const prune = read("scripts/backup/prune.sh");
const restore = read("scripts/backup/restore.sh");
const check = read("scripts/backup/check-backups.sh");
const runnerUnit = read("infra/runner/learncoding-runner.service.example");
const runnerEnv = read("infra/env/runner.env.example");
const runnerDockerfile = read("services/runner/Dockerfile");
const runnerReadme = read("services/runner/README.md");
const runtimeValidation = read("infra/ops/validate-runtime.sh");
const liveHealthRoute = read("src/app/health/live/route.ts");
const readyHealthRoute = read("src/app/health/ready/route.ts");
const productionSmoke = read("infra/ops/smoke-production.sh");
read("infra/tests/smoke-production.test.sh");
const monitoringRunbook = read("docs/runbooks/logs-and-monitoring.md");

expect(/@sha256:[0-9a-f]{64}/i.test(dockerfile), "Docker base image must be digest-pinned");
expect(
  /ARG NODE_IMAGE=node:22\.23\.1-alpine3\.23@sha256:4848379985144e72c7537574c1a894d4ec096704b21ce45e5eee386be9fab737/.test(dockerfile),
  "application images must use the reviewed linux/amd64 Node 22.23.1 Alpine 3.23 digest",
);
expect(/\.next\/standalone/.test(dockerfile), "runtime must copy Next standalone output");
expect(/npm run build/.test(dockerfile), "container must use the verified application production build");
expect(/COPY[^\n]+\/content\s+\.\/content/.test(dockerfile), "runtime must include dynamic curriculum content");
expect(/USER node/.test(dockerfile), "long-running Node targets must use the node user");
expect(
  /FROM base AS final-base[\s\S]*?\/usr\/local\/lib\/node_modules\/npm[\s\S]*?\/usr\/local\/lib\/node_modules\/corepack[\s\S]*?\/opt\/yarn-\*[\s\S]*?\/sbin\/apk/.test(dockerfile),
  "shipped application stages must remove apk plus global npm, Corepack, and Yarn executables",
);
expect(/! command -v apk/.test(dockerfile), "final application stages must assert apk is not executable");
expect(
  /FROM final-base AS tooling/.test(dockerfile) &&
    /FROM final-base AS worker/.test(dockerfile) &&
    /FROM final-base AS runtime/.test(dockerfile),
  "all shipped application image families must inherit the package-manager-free final base",
);
expect(
    /COPY --from=production-dependencies[^\n]+\/app\/node_modules/.test(toolingStage) &&
    /COPY --chown=node:node drizzle \.\/drizzle/.test(toolingStage) &&
    /COPY --chown=node:node scripts\/migrate-production\.mjs \.\/scripts\/migrate-production\.mjs/.test(toolingStage) &&
    (toolingStage.match(/COPY --chown=node:node scripts\//g) ?? []).length === 1 &&
    !/COPY --chown=node:node (?:package\.json|tsconfig\.json|content|src)(?:\s|\/)/.test(toolingStage) &&
    /CMD \["node", "\/app\/scripts\/migrate-production\.mjs"\]/.test(toolingStage) &&
    !/CMD \["npm", "run", "db:migrate"\]/.test(toolingStage),
  "tooling migrations must use production dependencies and invoke the advisory-locked migration script",
);
expect(
  /codestead:production-migration:v1/.test(migrationScript) &&
    /select pg_try_advisory_lock\(hashtextextended\(\$1, 0\)\) acquired/.test(migrationScript) &&
    /select pg_advisory_unlock\(hashtextextended\(\$1, 0\)\) released/.test(migrationScript) &&
    /migrationsFolder = options\.migrationsFolder \?\? "\/app\/drizzle"/.test(migrationScript),
  "production migrations must use the reviewed advisory lock and bundled Drizzle migrations",
);
expect(
  /FROM worker AS operations/.test(dockerfile) &&
    /COPY --chown=node:node content \.\/content/.test(operationsStage) &&
    /COPY --chown=node:node scripts\/bootstrap-admin\.ts \.\/scripts\/bootstrap-admin\.ts/.test(operationsStage) &&
    /COPY --chown=node:node scripts\/seed-platform\.ts \.\/scripts\/seed-platform\.ts/.test(operationsStage) &&
    /CMD \["node", "--import", "tsx", "\/app\/scripts\/seed-platform\.ts"\]/.test(operationsStage),
  "operations image must include curriculum content plus the bootstrap and seed scripts",
);
expect(/FROM worker AS scanner-worker/.test(dockerfile) && /scripts\/scan-uploads\.ts/.test(dockerfile), "scanner worker image target is required");
expect(/FROM worker AS regrade-worker/.test(dockerfile) && /scripts\/process-assessment-regrades\.ts/.test(dockerfile), "assessment regrade worker image target is required");
expect(/FROM final-base AS worker[\s\S]*?scripts\/data-lifecycle\.ts/.test(dockerfile), "worker image must retain the lifecycle operations entrypoint");
expect(
  /lifecycle:[\s\S]*?image: \$\{APP_OPERATIONS_IMAGE:\?[^}\n]+\}[\s\S]*?target: operations[\s\S]*?data-lifecycle\.ts/.test(compose),
  "lifecycle operations must use the dedicated operations image and target",
);

const applicationImageVariables = [
  "APP_RUNTIME_IMAGE",
  "APP_TOOLING_IMAGE",
  "APP_WORKER_IMAGE",
  "APP_REGRADE_WORKER_IMAGE",
  "APP_PROJECT_REVIEW_WORKER_IMAGE",
  "APP_SCANNER_WORKER_IMAGE",
  "APP_OPERATIONS_IMAGE",
];
const applicationImageRepositories = [];
for (const variable of applicationImageVariables) {
  const value = new RegExp(`^${variable}=(\\S+)$`, "m").exec(composeEnv)?.[1] ?? "";
  const image = /^(ghcr\.io\/thebrownhuman\/[a-z0-9][a-z0-9._-]*):[^@\s]+@sha256:(?:[0-9a-f]{64}|REPLACE_WITH_64_HEX)$/.exec(value);
  expect(Boolean(image), `${variable} must be a GHCR digest-form example under ghcr.io/thebrownhuman/`);
  if (image) applicationImageRepositories.push(image[1]);
}
expect(
  new Set(applicationImageRepositories).size === applicationImageVariables.length,
  "application image examples must use seven independently named repositories",
);
expect(!/^APP_IMAGE(?:_TAG)?=/m.test(composeEnv), "derived APP_IMAGE tags must not remain in the Compose environment");

expect(!/^\s+ports:/m.test(compose), "trusted Compose stack must publish no host ports");
expect(!/^  runner:/m.test(compose), "runner must not be a service in the trusted Compose stack");
const servicesSection = /^services:\s*$([\s\S]*?)^networks:\s*$/m.exec(compose)?.[1] ?? "";
const serviceCount = [...servicesSection.matchAll(/^  [a-z0-9-]+:\s*$/gm)].length;
expect(
  serviceCount > 0 && (servicesSection.match(/platform: \$\{DEPLOY_PLATFORM:-linux\/amd64\}/g) ?? []).length === serviceCount,
  "all trusted services must target the reviewed Intel NUC architecture",
);
expect(/^  postgres:/m.test(compose) && /pg_isready/.test(compose), "PostgreSQL healthcheck is required");
expect(/\/var\/lib\/postgresql\/data/.test(compose), "PostgreSQL persistent storage is required");
expect(/internal: true/.test(compose), "database network must be internal");
expect(/condition: service_healthy/.test(compose), "migration must wait for PostgreSQL health");
expect(/condition: service_completed_successfully/.test(compose), "app must wait for migration success");
const appService = composeService("app");
expect(
  /healthcheck:[\s\S]*?test:\s*\["CMD", "node", "-e", "[^"\r\n]*\/health\/ready[^"\r\n]*redirect:\s*'manual'[^"\r\n]*status\s*!==\s*200[^"\r\n]*"\]/.test(appService),
  "app healthcheck must use native fetch against readiness, reject redirects, and require status 200",
);
const cloudflaredService = composeService("cloudflared");
expect(
  /command:\s+tunnel\b[^\r\n]*--metrics 0\.0\.0\.0:20241[^\r\n]*\brun\s*$/m.test(cloudflaredService),
  "cloudflared must expose internal metrics on 0.0.0.0:20241 before tunnel run",
);
expect(
  /healthcheck:[\s\S]*?test:\s*\["CMD", "cloudflared", "tunnel", "--metrics", "127\.0\.0\.1:20241", "ready"\]/.test(cloudflaredService),
  "cloudflared healthcheck must query its internal metrics listener",
);
expect(/^  clamav:/m.test(compose) && /^  scan-worker:/m.test(compose), "isolated ClamAV and upload scanner services are required");
expect(
  /image: \$\{CLAMAV_IMAGE:-clamav\/clamav:pilot-disabled\}/.test(compose),
  "ClamAV must use the harmless pilot-disabled fallback when inactive",
);
expect(/scan-worker:[\s\S]*?target: scanner-worker[\s\S]*?CLAMD_HOST: clamav/.test(compose), "scan worker must use the dedicated image target and clamd service");
expect(/scan-worker:[\s\S]*?target: \/var\/lib\/learncoding[\s\S]*?read_only: true/.test(compose), "scan worker object storage mount must be read-only");
expect(/^  regrade-worker:/m.test(compose), "dedicated assessment regrade worker service is required");
expect(/regrade-worker:[\s\S]*?target: regrade-worker[\s\S]*?RUNNER_SHARED_SECRET_FILE: \/run\/secrets\/runner_shared_secret[\s\S]*?REGRADE_BATCH_SIZE: \$\{REGRADE_BATCH_SIZE:-2\}/.test(compose), "regrade worker must use the dedicated target, runner secret, and two-job batch cap");
expect(/regrade-worker:[\s\S]*?networks:[\s\S]*?- data[\s\S]*?- runner-egress/.test(compose), "regrade worker must have only database and runner network paths");
expect(/^  practice-runner-recovery-worker:/m.test(compose), "dedicated stale practice runner recovery is required");
expect(/practice-runner-recovery-worker:[\s\S]*?process-practice-runner-recoveries\.ts[\s\S]*?RUNNER_SHARED_SECRET_FILE: \/run\/secrets\/runner_shared_secret[\s\S]*?PRACTICE_RECOVERY_BATCH_SIZE: \$\{PRACTICE_RECOVERY_BATCH_SIZE:-2\}/.test(compose), "practice recovery must use the exact-request worker, runner secret, and bounded batch");
expect(/scanner:\s*\n\s*driver: bridge\s*\n\s*internal: true/.test(compose), "scanner transport network must be internal");
expect(/clamav-signatures:\s*$/m.test(compose), "ClamAV signatures need a persistent cache volume");
expect((compose.match(/read_only: true/g) ?? []).length >= 1, "hardened services must use read-only roots");
expect(/cap_drop:\s*\n\s*- ALL/.test(compose), "hardened services must drop capabilities");
expect(/no-new-privileges:true/.test(compose), "hardened services need no-new-privileges");
expect(/cloudflared:[\s\S]*http:\/\/app:3000/.test(`${compose}\n${cloudflare}`), "tunnel must route only to the app service");
expect(/service: http_status:404\s*$/.test(cloudflare.trim()), "Cloudflare ingress must end with a 404 catch-all");
expect(/status:\s*"ok"/.test(liveHealthRoute) && !/\b(?:pool|query)\b/.test(liveHealthRoute), "liveness must not access the database");
expect(
  /text:\s*"select 1"/.test(readyHealthRoute) && /query_timeout:\s*2_000/.test(readyHealthRoute),
  "readiness must use the bounded SELECT 1 database probe",
);
expect(
  /timeout_bin/.test(productionSmoke) && /--env-file/.test(productionSmoke) && /production smoke passed/.test(productionSmoke),
  "production smoke must be bounded, use explicit Compose inputs, and emit the canonical success marker",
);

expect(/_FILE/.test(entrypoint) && /exec "\$@"/.test(entrypoint), "entrypoint must load file secrets then exec");
expect(
  /for variable in[\s\S]*?BOOTSTRAP_ADMIN_PASSWORD[\s\S]*?do/.test(entrypoint),
  "entrypoint must support BOOTSTRAP_ADMIN_PASSWORD_FILE",
);
read("scripts/bootstrap-admin.ts");
read("scripts/seed-platform.ts");
read("content/catalog.json");
expect(!/RUNNER_SHARED_SECRET=[^$\n]{32,}/.test(compose), "Compose must not contain a literal runner secret");
expect(/required_secrets=\([^)]*deletion_tombstone_key/.test(runtimeValidation), "runtime validation must require the deletion tombstone key");
expect(/SOURCE_CODE_URL must be an HTTPS URL/.test(runtimeValidation), "runtime validation must reject a missing or non-HTTPS source-code URL");

expect(/age --encrypt --recipients-file/.test(backup), "full backups must use age recipient encryption");
expect(/sha256sum/.test(backup) && /SHA256SUMS/.test(backup), "full backups need external and internal checksums");
expect(/flock/.test(common), "backup operations must lock against concurrency");
expect(/LEARNCODING_BACKUP_V1/.test(common), "backup target marker is required");
expect(/RETENTION_DAILY=7/.test(prune), "retention must keep seven daily points");
expect(/RETENTION_WEEKLY=4/.test(prune), "retention must keep four weekly points");
expect(/RETENTION_MONTHLY=12/.test(prune), "retention must keep twelve monthly points");
expect(/learncoding_restore_/.test(restore), "database restores must use an isolated restore name");
expect(/destination must be empty/.test(restore), "filesystem restores must require an empty destination");
expect(/MAX_BACKUP_AGE_HOURS/.test(check) && /FILESYSTEM_CRITICAL_PERCENT/.test(check), "backup checks need age and capacity alerts");
expect(/FILESYSTEM_WARN_PERCENT:=70/.test(common), "backup capacity warning must begin at 70 percent");
expect(/FILESYSTEM_CRITICAL_PERCENT:=85/.test(common), "backup capacity alert must become critical at 85 percent");
expect(/contains_email_exports=false/.test(backup), "backup manifest must explicitly exclude email exports");

expect(/SupplementaryGroups=docker/.test(runnerUnit), "runner reference unit must explicitly contain Docker privilege inside its VM");
expect(/ProtectSystem=strict/.test(runnerUnit), "runner service must harden its host filesystem view");
expect(/StateDirectory=learncoding-runner/.test(runnerUnit) && /StateDirectoryMode=0700/.test(runnerUnit), "runner unit must provision its private durable state directory");
expect(/^LimitCORE=0$/m.test(runnerUnit), "runner service must disable core dumps containing learner memory");
expect(/^RUNNER_STATE_ROOT=\/var\/lib\/learncoding-runner$/m.test(runnerEnv), "runner environment must use the systemd-managed state directory");
const runnerLaunch = read("infra/runner/run-runner.sh");
expect(/RUNNER_SHARED_SECRET_FILE/.test(runnerLaunch), "runner secret must come from a file");
expect(/RUNNER_STATE_ROOT/.test(runnerLaunch) && /mode-0700/.test(runnerLaunch), "runner startup must validate its private state root");
expect(/flock --exclusive --nonblock 9/.test(runnerLaunch), "runner startup must hold a kernel lifetime lock before reconciliation");
expect(/AS verification-artifact/.test(runnerDockerfile) && /io\.learncoding\.runner\.image-role="verification-only"/.test(runnerDockerfile), "runner Dockerfile must identify its verification-only artifact role");
expect(!/apt-get install[\s\S]*(?:docker\.io|util-linux)/.test(runnerDockerfile), "runner verification image must not install unpinned service packages");
expect(/process\.exit\(64\)/.test(runnerDockerfile) && !/CMD[^\n]*dist\/index\.js/.test(runnerDockerfile), "runner verification image must fail closed instead of starting the service");
expect(/not deployment-ready/.test(runnerReadme) && /external release gate/.test(runnerReadme), "runner documentation must distinguish verification artifacts from external Linux deployment evidence");
expect(/label=io\.learncoding\.runner\.job=true/.test(runnerLaunch), "runner startup must reconcile only labeled stale job containers");
expect(/io\.learncoding\.runner\.job=true/.test(read("services/runner/src/docker-executor.ts")), "runner jobs must carry the reconciliation label");

for (const required of [
  "docs/deployment.md",
  "docs/runbooks/firewall-and-network.md",
  "docs/runbooks/updates-and-rollback.md",
  "docs/runbooks/logs-and-monitoring.md",
  "docs/runbooks/backup-and-restore.md",
  "docs/runbooks/runner-isolation.md",
  "docs/runbooks/incident-response.md",
  "docs/runbooks/upload-scanning.md",
  "docs/runbooks/assessment-corrections.md",
  "infra/systemd/learncoding-compose.service",
  "infra/systemd/learncoding-backup.timer",
  "infra/systemd/learncoding-backup-check.timer",
  "infra/systemd/learncoding-retention.timer",
  "infra/systemd/learncoding-restore-drill.service",
]) read(required);

expect(/compose\.yaml ps --all/.test(monitoringRunbook), "monitoring must include one-shot services in Compose status checks");
expect(
  /exactly nine long-running services must be `running`/i.test(monitoringRunbook) &&
    /migrate[^\n]*`Exited \(0\)`/i.test(monitoringRunbook),
  "monitoring must describe nine running pilot services and successful migration completion",
);
expect(
  /`clamav` and `scan-worker` must not appear[^\n]*pilot/i.test(monitoringRunbook),
  "monitoring must reject upload services in pilot mode",
);
expect(
  /\/health\/live/.test(monitoringRunbook) && /\/health\/ready/.test(monitoringRunbook) && /SELECT 1/i.test(monitoringRunbook),
  "monitoring must distinguish liveness from database-backed readiness",
);
expect(
  /smoke-production\.sh --startup-wait 600/.test(monitoringRunbook),
  "monitoring must document the bounded production smoke command",
);

const scanned = [
  compose,
  composeEnv,
  read("infra/env/backup.env.example"),
  cloudflare,
].join("\n");
for (const [name, pattern] of [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["OpenAI-style token", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["age private identity", /AGE-SECRET-KEY-/],
]) expect(!pattern.test(scanned), `example configuration contains a ${name}`);

if (failures.length > 0) {
  console.error("Static deployment validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Static deployment validation passed (trusted stack, runner boundary, backups, and runbooks). ");
