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

function systemdDirectives(content) {
  const recognizedSections = new Map([
    ["[Unit]", "Unit"],
    ["[Service]", "Service"],
    ["[Install]", "Install"],
    ["[Timer]", "Timer"],
  ]);
  const directives = [];
  let section = "";
  for (const line of content.split(/\r?\n/u)) {
    if (!line) continue;
    if (line !== line.trim() || line.includes("\\")) return null;
    if (line.startsWith("#") || line.startsWith(";")) continue;

    const recognizedSection = recognizedSections.get(line);
    if (recognizedSection) {
      section = recognizedSection;
      continue;
    }

    const assignment = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/u.exec(line);
    if (!assignment || /^\s/u.test(assignment[2])) return null;
    directives.push({
      key: assignment[1],
      section,
      value: assignment[2],
    });
  }
  return directives;
}

function hasSingleSystemdDirective(content, section, key, value) {
  const directives = systemdDirectives(content);
  if (!directives) return false;
  const matches = directives.filter((directive) => directive.key === key);
  return matches.length === 1 && matches[0].section === section && matches[0].value === value;
}

function hasSystemdDirectiveTokens(content, section, key, requiredTokens) {
  const directives = systemdDirectives(content);
  if (!directives) return false;
  const matches = directives.filter((directive) => directive.key === key);
  if (matches.length !== 1 || matches[0].section !== section) return false;
  const actual = new Set(matches[0].value.split(/\s+/u));
  return requiredTokens.every((token) => actual.has(token));
}

function shellAssignments(content) {
  const assignments = [];
  for (const line of content.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    if (line !== line.trim() || line.includes("\\")) return null;
    const assignment = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!assignment) return null;
    assignments.push({ key: assignment[1], value: assignment[2] });
  }
  return assignments;
}

function hasSingleShellAssignment(content, key, value) {
  const assignments = shellAssignments(content);
  if (!assignments) return false;
  const matches = assignments.filter((assignment) => assignment.key === key);
  return matches.length === 1 && matches[0].value === value;
}

function enabledSystemdUnits(content) {
  const units = [];
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!/\bsystemctl\s+enable\b/u.test(line)) continue;
    const match = /^systemctl enable --now ([A-Za-z0-9@_.-]+(?: [A-Za-z0-9@_.-]+)*)$/u.exec(line);
    if (!match) return null;
    units.push(...match[1].split(" "));
  }
  return units;
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
read("infra/tests/systemd-recovery.test.sh");
const monitoringRunbook = read("docs/runbooks/logs-and-monitoring.md");
const composeUnit = read("infra/systemd/learncoding-compose.service");
const retentionUnit = read("infra/systemd/learncoding-retention.service");
const persistentTimers = [
  ["infra/systemd/learncoding-backup.timer", read("infra/systemd/learncoding-backup.timer")],
  ["infra/systemd/learncoding-backup-check.timer", read("infra/systemd/learncoding-backup-check.timer")],
  ["infra/systemd/learncoding-retention.timer", read("infra/systemd/learncoding-retention.timer")],
];
const packageJson = read("package.json");
const composeValidator = read("infra/tests/validate-compose.mjs");
const retentionPolicy = read("src/lib/data-lifecycle/policy.ts");
const retentionPolicyTest = read("src/lib/data-lifecycle/__tests__/policy.test.ts");
const retentionRuntimeTest = read("src/lib/data-lifecycle/__tests__/retention-runtime.test.ts");
const deploymentGuide = read("docs/deployment.md");
const updatesRunbook = read("docs/runbooks/updates-and-rollback.md");
const lifecycleRunbook = read("docs/runbooks/data-lifecycle.md");
const draftSyncGuide = read("docs/draft-sync.md");
const projectRevisionsGuide = read("docs/project-revisions.md");
const runnerNetworkXml = read("infra/runner-vm/codestead-runner-network.xml");
read("infra/runner-vm/cloud-init/meta-data");
read("infra/runner-vm/cloud-init/user-data.template");
const runnerProvisioner = read("infra/runner-vm/provision-host.sh");
const runnerGuestInstaller = read("infra/runner-vm/install-guest.sh");
const runnerFirewall = read("infra/runner-vm/host-runner.nft");
const runnerFirewallUnit = read("infra/systemd/learncoding-runner-firewall.service");
const recoveryChecker = read("infra/ops/check-recovery.sh");
const recoveryService = read("infra/systemd/learncoding-recovery-check.service");
const recoveryTimer = read("infra/systemd/learncoding-recovery-check.timer");
const recoveryEvidence = read("infra/ops/capture-recovery-evidence.sh");
const systemdInstaller = read("infra/ops/install-systemd.sh");

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
const postgresService = composeService("postgres");
expect(
  /command:\s*\r?\n\s*- postgres\s*\r?\n\s*- -c\s*\r?\n\s*- fsync=on\s*\r?\n\s*- -c\s*\r?\n\s*- synchronous_commit=on\s*\r?\n\s*- -c\s*\r?\n\s*- full_page_writes=on/.test(postgresService),
  "PostgreSQL must explicitly enable fsync, synchronous_commit, and full_page_writes",
);
expect(/internal: true/.test(compose), "database network must be internal");
expect(/condition: service_healthy/.test(compose), "migration must wait for PostgreSQL health");
const migrateService = composeService("migrate");
expect(/profiles:\s*\["operations"\]/.test(migrateService), "migrate must be isolated behind the operations profile");
const appService = composeService("app");
expect(!/depends_on:[\s\S]*?\bmigrate:/.test(appService), "ordinary app boot must not invoke or wait for migration");
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

for (const [systemdPath, systemdContent] of [
  ["infra/systemd/learncoding-compose.service", composeUnit],
  ["infra/systemd/learncoding-retention.service", retentionUnit],
  ["infra/systemd/learncoding-runner-firewall.service", runnerFirewallUnit],
  ["infra/systemd/learncoding-recovery-check.service", recoveryService],
  ["infra/systemd/learncoding-recovery-check.timer", recoveryTimer],
  ...persistentTimers,
]) {
  expect(
    systemdDirectives(systemdContent) !== null,
    `${systemdPath} must use canonical physical systemd syntax`,
  );
}

const expectedComposeUp =
  "/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans";
const expectedComposeStop =
  "/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml down --remove-orphans";
const whitespaceMutationUnit = [
  composeUnit,
  " [Service]",
  " ExecStart = /usr/bin/docker compose \\",
  "   --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build",
  " ExecReload = /usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build",
  " ExecStop = /usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml down --volumes",
  " Restart = no",
].join("\n");
const whitespaceMutationTimer = [
  persistentTimers[0][1],
  " [Timer]",
  " Persistent = false",
].join("\n");
const commentMutationUnit = [
  composeUnit,
  " [Service]",
  "# harmless recovery comment \\",
  " ExecReload = /usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build",
  " ; harmless restart comment \\",
  " Restart = no",
].join("\n");
const commentMutationTimer = [
  persistentTimers[0][1],
  " [Timer]",
  "# harmless timer comment \\",
  " Persistent = false",
].join("\n");
const spacedSectionUnit = [
  "[ Service ]",
  `ExecStart=${expectedComposeUp}`,
].join("\n");
const paddedAssignmentUnit = [
  "[Service]",
  ` ExecStart = ${expectedComposeUp}`,
].join("\n");
const trailingWhitespaceUnit = [
  "[Service] ",
  `ExecStart=${expectedComposeUp} `,
].join("\n");
const oddBackslashUnit = [
  "[Service]",
  "Restart=on-failure\\   ",
].join("\n");
const evenBackslashUnit = [
  "[Service]",
  "Restart=on-failure\\\\   ",
].join("\n");
const standaloneCommentBackslashUnit = [
  "[Service]",
  "# standalone comment backslash \\",
  "Restart=on-failure",
].join("\n");
const hiddenExecUnit = [
  composeUnit,
  "[Service]",
  "Description=noncanonical continuation \\",
  "# ignored comment block",
  "ExecStart=/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build",
].join("\n");
const hiddenRestartUnit = [
  composeUnit,
  "[Service]",
  "Description=noncanonical continuation \\",
  "; ignored comment block",
  "Restart=no",
].join("\n");
const hiddenPersistentTimer = [
  persistentTimers[0][1],
  "[Timer]",
  "Description=noncanonical continuation \\",
  "# ignored comment block",
  "Persistent=false",
].join("\n");
expect(
  !hasSingleSystemdDirective(spacedSectionUnit, "Service", "ExecStart", expectedComposeUp),
  "systemd parser must reject a section header with internal padding",
);
expect(
  !hasSingleSystemdDirective(paddedAssignmentUnit, "Service", "ExecStart", expectedComposeUp),
  "systemd parser must reject leading and around-equals assignment whitespace",
);
expect(
  !hasSingleSystemdDirective(trailingWhitespaceUnit, "Service", "ExecStart", expectedComposeUp),
  "systemd parser must reject trailing physical-line whitespace",
);
expect(
  !hasSingleSystemdDirective(oddBackslashUnit, "Service", "Restart", "on-failure"),
  "systemd parser must reject an odd trailing backslash followed by spaces",
);
expect(
  !hasSingleSystemdDirective(evenBackslashUnit, "Service", "Restart", "on-failure\\"),
  "systemd parser must reject even trailing backslashes followed by spaces",
);
expect(
  !hasSingleSystemdDirective(
    standaloneCommentBackslashUnit,
    "Service",
    "Restart",
    "on-failure",
  ),
  "systemd parser must reject a standalone comment containing a backslash",
);
expect(
  !hasSingleSystemdDirective(hiddenExecUnit, "Service", "ExecStart", expectedComposeUp),
  "systemd parser must not hide an unsafe ExecStart after a continuation/comment block",
);
expect(
  !hasSingleSystemdDirective(hiddenRestartUnit, "Service", "Restart", "on-failure"),
  "systemd parser must not hide an unsafe Restart after a continuation/comment block",
);
expect(
  !hasSingleSystemdDirective(hiddenPersistentTimer, "Timer", "Persistent", "true"),
  "systemd parser must not hide an unsafe Persistent value after a continuation/comment block",
);
expect(
  !hasSingleSystemdDirective(whitespaceMutationUnit, "Service", "ExecStart", expectedComposeUp),
  "systemd parser must reject a whitespace-indented continued ExecStart build override",
);
expect(
  !hasSingleSystemdDirective(whitespaceMutationUnit, "Service", "ExecReload", expectedComposeUp),
  "systemd parser must reject a whitespace-around-equals ExecReload build override",
);
expect(
  !hasSingleSystemdDirective(whitespaceMutationUnit, "Service", "ExecStop", expectedComposeStop),
  "systemd parser must reject a whitespace-around-equals volume-removing ExecStop override",
);
expect(
  !hasSingleSystemdDirective(whitespaceMutationUnit, "Service", "Restart", "on-failure"),
  "systemd parser must reject a whitespace-around-equals Restart override",
);
expect(
  !hasSingleSystemdDirective(whitespaceMutationTimer, "Timer", "Persistent", "true"),
  "systemd parser must reject a whitespace-around-equals Persistent override",
);
expect(
  !hasSingleSystemdDirective(commentMutationUnit, "Service", "ExecReload", expectedComposeUp),
  "systemd parser must reject an ExecReload build override after a backslash comment",
);
expect(
  !hasSingleSystemdDirective(commentMutationUnit, "Service", "Restart", "on-failure"),
  "systemd parser must reject a Restart override after a backslash semicolon comment",
);
expect(
  !hasSingleSystemdDirective(commentMutationTimer, "Timer", "Persistent", "true"),
  "systemd parser must reject a Persistent override after a backslash comment",
);
expect(
  hasSingleSystemdDirective(
    composeUnit,
    "Unit",
    "RequiresMountsFor",
    "/opt/learncoding /etc/learncoding /srv/learncoding",
  ),
  "Compose systemd unit must require only the application, configuration, and primary data mounts",
);
expect(
  hasSystemdDirectiveTokens(
    composeUnit,
    "Unit",
    "After",
    [
      "docker.service",
      "network-online.target",
      "local-fs.target",
      "libvirtd.service",
      "learncoding-runner-firewall.service",
    ],
  ) &&
    hasSingleSystemdDirective(composeUnit, "Unit", "Requires", "docker.service") &&
    hasSystemdDirectiveTokens(composeUnit, "Unit", "Wants", [
      "network-online.target",
      "libvirtd.service",
      "learncoding-runner-firewall.service",
    ]),
  "Compose systemd unit must retain Docker/local-fs and include network, libvirt, and firewall ordering",
);
expect(
  hasSingleSystemdDirective(
    composeUnit,
    "Service",
    "ExecStartPre",
    "/usr/bin/bash /opt/learncoding/infra/ops/validate-runtime.sh",
  ) &&
    hasSingleSystemdDirective(
      composeUnit,
      "Service",
      "ExecStartPost",
      "/usr/bin/bash /opt/learncoding/infra/ops/smoke-production.sh --startup-wait 600",
    ),
  "Compose systemd unit must run preflight and the bounded startup smoke",
);
expect(
  hasSingleSystemdDirective(composeUnit, "Service", "ExecStart", expectedComposeUp) &&
    hasSingleSystemdDirective(composeUnit, "Service", "ExecReload", expectedComposeUp),
  "Compose systemd start and reload must use explicit inputs with no build or implicit pull",
);
const composeExecLines = (systemdDirectives(composeUnit) ?? [])
  .filter((directive) => directive.key === "ExecStart" || directive.key === "ExecReload")
  .map((directive) => directive.value);
expect(
  composeExecLines.every((line) => !/(?:^|\s)--build(?:\s|$)/u.test(line)),
  "Compose systemd start and reload must never contain the --build token",
);
expect(
  hasSingleSystemdDirective(
    composeUnit,
    "Service",
    "ExecStop",
    "/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml down --remove-orphans",
  ) && !composeUnit.includes("down -v"),
  "Compose systemd stop must preserve durable volumes",
);
expect(
  hasSingleSystemdDirective(composeUnit, "Service", "Type", "oneshot") &&
    hasSingleSystemdDirective(composeUnit, "Service", "RemainAfterExit", "yes") &&
    hasSingleSystemdDirective(composeUnit, "Install", "WantedBy", "multi-user.target"),
  "Compose systemd unit must retain its oneshot boot lifecycle",
);
expect(
  hasSingleSystemdDirective(composeUnit, "Service", "Restart", "on-failure") &&
    hasSingleSystemdDirective(composeUnit, "Service", "RestartSec", "15s") &&
    hasSingleSystemdDirective(composeUnit, "Service", "TimeoutStartSec", "15min") &&
    hasSingleSystemdDirective(composeUnit, "Service", "TimeoutStopSec", "5min") &&
    hasSingleSystemdDirective(composeUnit, "Unit", "OnFailure", "learncoding-alert@%n.service") &&
    hasSingleSystemdDirective(composeUnit, "Unit", "StartLimitIntervalSec", "15min") &&
    hasSingleSystemdDirective(composeUnit, "Unit", "StartLimitBurst", "5"),
  "Compose systemd unit must bound and alert on transient startup failures",
);

if (recoveryService) {
  const recoveryRequires = (systemdDirectives(recoveryService) ?? []).filter(
    (directive) => directive.section === "Unit" && directive.key === "Requires",
  );
  expect(
    hasSystemdDirectiveTokens(recoveryService, "Unit", "Wants", ["learncoding-compose.service"]) &&
      !recoveryRequires.some((directive) => directive.value.split(/\s+/u).includes("learncoding-compose.service")) &&
      hasSingleSystemdDirective(recoveryService, "Unit", "OnFailure", "learncoding-alert@%n.service") &&
      hasSingleSystemdDirective(recoveryService, "Service", "Type", "oneshot") &&
      hasSingleSystemdDirective(recoveryService, "Service", "User", "root") &&
      hasSingleSystemdDirective(recoveryService, "Service", "Group", "root") &&
      hasSingleSystemdDirective(
        recoveryService,
        "Service",
        "ExecStart",
        "/usr/bin/bash /opt/learncoding/infra/ops/check-recovery.sh",
      ),
    "recovery service must want (not require) Compose and run the alerting root-owned oneshot checker",
  );
}
if (recoveryTimer) {
  expect(
    hasSingleSystemdDirective(recoveryTimer, "Timer", "OnBootSec", "2m") &&
      hasSingleSystemdDirective(recoveryTimer, "Timer", "OnUnitActiveSec", "15m") &&
      hasSingleSystemdDirective(recoveryTimer, "Timer", "Persistent", "true") &&
      hasSingleSystemdDirective(recoveryTimer, "Timer", "Unit", "learncoding-recovery-check.service"),
    "recovery timer must use the final boot, repeat, persistence, and service selectors",
  );
}
const expectedEnabledUnits = [
  "learncoding-runner-firewall.service",
  "learncoding-compose.service",
  "learncoding-recovery-check.timer",
  "learncoding-backup.timer",
  "learncoding-backup-check.timer",
  "learncoding-retention.timer",
];
const actualEnabledUnits = enabledSystemdUnits(systemdInstaller);
const canonicalInstallLines = systemdInstaller
  .split(/\r?\n/u)
  .map((line) => line.trim())
  .filter(
    (line) =>
      line ===
      'install -o root -g root -m 0644 "$unit" "/etc/systemd/system/$(basename -- "$unit")"',
  );
expect(
  systemdInstaller.split(/\r?\n/u).filter((line) => line === 'for unit in "$repo_root"/infra/systemd/*; do')
    .length === 1 && canonicalInstallLines.length === 1,
  "systemd installer must publish every owned unit exactly once as root:root mode 0644",
);
expect(
  actualEnabledUnits !== null &&
    actualEnabledUnits.length === expectedEnabledUnits.length &&
    expectedEnabledUnits.every(
      (unit) => actualEnabledUnits.filter((actualUnit) => actualUnit === unit).length === 1,
    ) &&
    !actualEnabledUnits.includes("learncoding-restore-drill.service"),
  "systemd installer must canonically enable exactly firewall, Compose, recovery, backup/check, and retention, once each, but not restore drill",
);

expect(
  hasSingleSystemdDirective(retentionUnit, "Unit", "After", "learncoding-compose.service") &&
    hasSingleSystemdDirective(retentionUnit, "Unit", "Requires", "learncoding-compose.service"),
  "retention systemd unit must require the trusted Compose stack",
);
expect(
  hasSingleSystemdDirective(
    retentionUnit,
    "Service",
    "ExecStart",
    "/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml --profile operations run --rm --no-deps lifecycle",
  ) && !retentionUnit.includes("2026-07-14.v4"),
  "retention systemd unit must consume the versioned Compose lifecycle command through explicit inputs",
);
for (const [timerPath, timer] of persistentTimers) {
  expect(
    hasSingleSystemdDirective(timer, "Timer", "Persistent", "true"),
    `${timerPath} must contain exactly one effective Persistent=true in [Timer]`,
  );
}

const lifecycleService = composeService("lifecycle");
expect(
  /data-lifecycle\.ts[\s\S]*?- retention[\s\S]*?- --apply[\s\S]*?- --confirm[\s\S]*?- 2026-07-14\.v4/.test(
    lifecycleService,
  ),
  "Compose lifecycle command must use canonical retention version 2026-07-14.v4",
);
expect(
  /"worker:retention": "tsx scripts\/data-lifecycle\.ts retention --apply --confirm 2026-07-14\.v4"/.test(
    packageJson,
  ) &&
    /RETENTION_POLICY_VERSION = "2026-07-14\.v4"/.test(retentionPolicy) &&
    /2026-07-14\.v4/.test(retentionPolicyTest) &&
    /2026-07-14\.v4/.test(retentionRuntimeTest) &&
    /2026-07-14\.v4/.test(composeValidator),
  "active retention runtime and validation surfaces must agree on 2026-07-14.v4",
);
expect(
  /Policy version `2026-07-14\.v4` is authoritative/.test(lifecycleRunbook) &&
    /Version v4 adds/.test(lifecycleRunbook) &&
    /version v3 added/.test(lifecycleRunbook) &&
    /version v2 added/.test(lifecycleRunbook) &&
    (lifecycleRunbook.match(/retention:2026-07-14\.v4:/g) ?? []).length === 2 &&
    !/2026-07-12\.v3/.test(lifecycleRunbook),
  "lifecycle runbook must make v4 authoritative while preserving v2/v3 history",
);
expect(
  /docker compose --env-file \/etc\/learncoding\/compose\.env \\\r?\n\s+-f \/opt\/learncoding\/compose\.yaml --profile operations run --rm --no-deps lifecycle \\\r?\n\s+node --import tsx \/app\/scripts\/data-lifecycle\.ts retention --apply \\\r?\n\s+--confirm 2026-07-14\.v4 \\\r?\n\s+--idempotency-key retention:2026-07-14\.v4:YYYY-MM-DD:apply/.test(
    lifecycleRunbook,
  ) && !/npm run lifecycle -- retention --apply/.test(lifecycleRunbook),
  "lifecycle runbook apply example must use the explicit Compose lifecycle container and v4 confirmation",
);
expect(
  /Retention policy `2026-07-14\.v4`/.test(draftSyncGuide) &&
    /Retention policy `2026-07-14\.v4`/.test(projectRevisionsGuide),
  "draft and project-revision product guides must name active retention v4",
);
expect(
  /2026-07-14\.v4/.test(deploymentGuide) &&
    /runbooks\/data-lifecycle\.md/.test(deploymentGuide) &&
    /2026-07-14\.v4/.test(updatesRunbook) &&
    /\(data-lifecycle\.md\)/.test(updatesRunbook),
  "deployment and update guides must link to the canonical v4 lifecycle procedure",
);
expect(
  /systemctl daemon-reload/.test(deploymentGuide) &&
    /systemctl enable --now learncoding-compose\.service/.test(deploymentGuide) &&
    /systemctl enable --now learncoding-backup\.timer learncoding-backup-check\.timer learncoding-retention\.timer/.test(
      deploymentGuide,
    ) &&
    /firmware setting \*\*Restore on AC Power Loss: Power On\*\*, separate libvirt autostart and guest-service evidence for the runner VM, and the later supervised hard-cut rehearsal/.test(
      deploymentGuide,
    ) &&
    /Those NUC and runner gates are unfinished[\s\S]*?does not claim that a reboot, AC removal, public recovery, or the 15-minute recovery target has passed\./.test(
      deploymentGuide,
    ) &&
    /preserve every acknowledged server record marked `Saved to Codestead` and create no duplicate XP, mail, or evidence\./.test(
      deploymentGuide,
    ) &&
    /Browser text still marked `Unsynced` is outside this Task 6 guarantee\./.test(deploymentGuide) &&
    /Browser-local crash durability remains a separate implementation and verification plan\./.test(
      deploymentGuide,
    ),
  "deployment guide must document the interim boot seam and unfinished external power-loss evidence",
);
expect(
  /`learncoding-backup\.timer` and `learncoding-retention\.timer` use `OnCalendar=` with `Persistent=true`, so systemd catches up a missed calendar run after downtime\./.test(
    deploymentGuide,
  ) &&
    /`learncoding-backup-check\.timer` uses `OnBootSec=` and `OnUnitActiveSec=`; after a reboot it schedules a fresh post-boot check rather than replaying a missed wall-clock event\./.test(
      deploymentGuide,
    ) &&
    !/All three timers use `Persistent=true`, so systemd catches up a missed run/.test(deploymentGuide),
  "deployment guide must distinguish persistent calendar catch-up from the monotonic backup check",
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
expect(
  /--post-start/.test(runtimeValidation) &&
    /\btimeout\b/.test(runtimeValidation) &&
    /runner URL must be exactly http:\/\/10\.20\.0\.12:4100/.test(runtimeValidation) &&
    /172\.29\.40\.0\/24/.test(runtimeValidation) &&
    /cdst-run0/.test(runtimeValidation),
  "runtime validation must expose only the post-start selector and require the exact runner URL/network",
);

if (runnerNetworkXml) {
  expect(
    /<name>codestead-runner<\/name>/.test(runnerNetworkXml) &&
      /<forward\s+mode=["']nat["']/.test(runnerNetworkXml) &&
      /<bridge\s+name=["']virbr-cdst["']/.test(runnerNetworkXml) &&
      /address=["']10\.20\.0\.1["']/.test(runnerNetworkXml) &&
      /mac=["']52:54:00:20:00:12["']/.test(runnerNetworkXml) &&
      /ip=["']10\.20\.0\.12["']/.test(runnerNetworkXml),
    "runner network XML must define only the reviewed dedicated NAT identity",
  );
}
if (runnerProvisioner) {
  expect(/RUNNER_PROVISION_TEST_ROOT/.test(runnerProvisioner), "provisioner must expose only the narrow test-root seam");
  expect(
    !/virsh\s+(?:--connect\s+\S+\s+)?(?:destroy|undefine|vol-delete)\b|--remove-all-storage|\b(?:br0|wlo1)\b|--network\s+(?:bridge|direct)=/i.test(
      runnerProvisioner,
    ),
    "provisioner must not contain destructive libvirt/disk or Wi-Fi bridge operations",
  );
  expect(
    /host-passthrough/.test(runnerProvisioner) && /cache=none/.test(runnerProvisioner) && /100G/.test(runnerProvisioner),
    "provisioner must encode host-passthrough, cache=none, and the 100 GiB disk",
  );
}
if (runnerGuestInstaller) {
  expect(
    /10\.20\.0\.12/.test(runnerGuestInstaller) && /RUNNER_MAX_CONCURRENCY=2/.test(runnerGuestInstaller),
    "guest installer must retain the fixed private address and two-slot runner",
  );
}
if (runnerFirewall) {
  expect(
    /cdst-run0/.test(runnerFirewall) && /172\.29\.40\.0\/24/.test(runnerFirewall) && /10\.20\.0\.12/.test(runnerFirewall) && /4100/.test(runnerFirewall),
    "runner firewall must scope cdst-run0/172.29.40.0/24 to the private runner port",
  );
}
if (runnerFirewallUnit) {
  expect(/nft/.test(runnerFirewallUnit), "runner firewall unit must install the reviewed nftables policy");
}
if (recoveryChecker) {
  expect(
    /\/etc\/learncoding\/existing-containers\.txt/.test(recoveryChecker) &&
      /RECOVERY_CHECK_TEST_ROOT/.test(recoveryChecker) &&
      /900/.test(recoveryChecker) &&
      /x-runner-response-signature/i.test(recoveryChecker) &&
      /concurrency/.test(recoveryChecker),
    "recovery checker must use the protected baseline, 900-second bound, and signed two-slot runner health",
  );
}
if (recoveryEvidence) {
  expect(
    /\/var\/lib\/learncoding\/recovery-evidence/.test(recoveryEvidence) &&
      /RECOVERY_EVIDENCE_TEST_ROOT/.test(recoveryEvidence) &&
      !/\/var\/lib\/learncoding-runner|RUNNER_STATE_ROOT|journalctl[^\n]*learncoding-runner/i.test(recoveryEvidence),
    "recovery evidence must stay below its fixed root and never inspect runner state or journal data",
  );
}

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

expect(
  hasSingleSystemdDirective(runnerUnit, "Service", "SupplementaryGroups", "docker"),
  "runner reference unit must explicitly contain Docker privilege inside its VM",
);
expect(
  hasSingleSystemdDirective(runnerUnit, "Service", "ProtectSystem", "strict"),
  "runner service must harden its host filesystem view",
);
expect(
  hasSingleSystemdDirective(runnerUnit, "Service", "Restart", "on-failure") &&
    hasSingleSystemdDirective(runnerUnit, "Service", "RestartSec", "5s") &&
    (systemdDirectives(runnerUnit) ?? []).filter(
      (directive) =>
        directive.key === "StartLimitBurst" &&
        directive.section === "Unit" &&
        /^(?:[1-9]|10)$/u.test(directive.value),
    ).length === 1,
  "runner unit must use bounded five-second failure recovery",
);
expect(
  hasSingleSystemdDirective(runnerUnit, "Service", "StateDirectory", "learncoding-runner") &&
    hasSingleSystemdDirective(runnerUnit, "Service", "StateDirectoryMode", "0700"),
  "runner unit must provision its private durable state directory",
);
expect(
  hasSingleSystemdDirective(runnerUnit, "Service", "LimitCORE", "0"),
  "runner service must disable core dumps containing learner memory",
);
expect(
  hasSingleShellAssignment(runnerEnv, "RUNNER_HOST", "10.20.0.12") &&
    hasSingleShellAssignment(runnerEnv, "RUNNER_PORT", "4100") &&
    hasSingleShellAssignment(runnerEnv, "RUNNER_MAX_CONCURRENCY", "2") &&
    hasSingleShellAssignment(runnerEnv, "RUNNER_MAX_QUEUE_DEPTH", "100"),
  "runner environment must bind the fixed private guest address with exactly two slots",
);
expect(
  hasSingleShellAssignment(runnerEnv, "RUNNER_STATE_ROOT", "/var/lib/learncoding-runner"),
  "runner environment must use the systemd-managed state directory",
);
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
