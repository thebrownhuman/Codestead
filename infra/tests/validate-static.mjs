import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  parseGitIndexModes,
  validateProductionExecutableModes,
} from "./production-executable-modes.mjs";

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

function sha256File(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return "";
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function sourceManipulatesHarnessPath(content) {
  const pathToken = /(^|[^A-Za-z0-9_])PATH([^A-Za-z0-9_]|$)/u;
  const approvedHermeticChildEnvironments = new Set([
    '  launcher=("$production_env" -i HOME=/nonexistent LANG=C LC_ALL=C PATH=/usr/bin:/bin)',
    "  PATH=/usr/sbin:/usr/bin:/sbin:/bin \\",
  ]);
  return content
    .split(/\r?\n/u)
    .some(
      (line) =>
        !/^\s*(?:#|$)/u.test(line) &&
        !approvedHermeticChildEnvironments.has(line) &&
        pathToken.test(line),
    );
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
    ["[Path]", "Path"],
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
const releaseProduction = read("infra/ops/release-production.sh");
const releaseProductionHarness = read("infra/tests/release-production.test.sh");
read("infra/tests/smoke-production.test.sh");
read("infra/tests/systemd-recovery.test.sh");
const monitoringRunbook = read("docs/runbooks/logs-and-monitoring.md");
const composeUnit = read("infra/systemd/learncoding-compose.service");
const retentionUnit = read("infra/systemd/learncoding-retention.service");
const ingressRecoveryService = read("infra/systemd/learncoding-ingress-recovery.service");
const ingressRecoveryTimer = read("infra/systemd/learncoding-ingress-recovery.timer");
const ingressControlTmpfiles = read("infra/tmpfiles.d/learncoding-ingress-control.conf");
const ingressRecoveryScript = read("infra/ops/recover-production-ingress.sh");
const ingressRecoveryHarness = read("infra/tests/ingress-recovery.test.sh");
const ingressRecoveryDesign = read("docs/superpowers/specs/2026-07-20-ingress-quarantine-recovery-design.md");
const ingressRecoveryPlan = read("docs/superpowers/plans/2026-07-20-ingress-quarantine-recovery.md");
const persistentTimers = [
  ["infra/systemd/learncoding-backup.timer", read("infra/systemd/learncoding-backup.timer")],
  ["infra/systemd/learncoding-backup-check.timer", read("infra/systemd/learncoding-backup-check.timer")],
  ["infra/systemd/learncoding-retention.timer", read("infra/systemd/learncoding-retention.timer")],
  ["infra/systemd/learncoding-restore-drill-reminder.timer", read("infra/systemd/learncoding-restore-drill-reminder.timer")],
  ["infra/systemd/learncoding-ingress-recovery.timer", ingressRecoveryTimer],
];
const packageJson = read("package.json");
const composeValidator = read("infra/tests/validate-compose.mjs");
const retentionPolicy = read("src/lib/data-lifecycle/policy.ts");
const retentionPolicyTest = read("src/lib/data-lifecycle/__tests__/policy.test.ts");
const retentionRuntimeTest = read("src/lib/data-lifecycle/__tests__/retention-runtime.test.ts");
const deploymentGuide = read("docs/deployment.md");
const loadTestingRunbook = read("docs/runbooks/load-testing.md");
const runnerIsolationGuide = read("docs/runbooks/runner-isolation.md");
const updatesRunbook = read("docs/runbooks/updates-and-rollback.md");
const lifecycleRunbook = read("docs/runbooks/data-lifecycle.md");
const draftSyncGuide = read("docs/draft-sync.md");
const projectRevisionsGuide = read("docs/project-revisions.md");
const runnerNetworkXml = read("infra/runner-vm/codestead-runner-network.xml");
read("infra/runner-vm/cloud-init/meta-data");
read("infra/runner-vm/cloud-init/user-data.template");
const runnerProvisioner = read("infra/runner-vm/provision-host.sh");
const runnerProvisionHelper = read("infra/runner-vm/codestead_runner_provision.py");
const runnerProvisionContract = read("infra/runner-vm/runner-contract.json");
const runnerGuestInstaller = read("infra/runner-vm/install-guest.sh");
const runnerReleaseVerifier = read("infra/runner-vm/verify-release-tree.py");
const runnerRuntimeRecordVerifier = read("infra/runner-vm/verify-runtime-record.mjs");
const composeCiInstaller = read("infra/ops/install-compose-ci.sh");
const runnerFirewall = read("infra/runner-vm/host-runner.nft");
const runnerGuestFirewall = read("infra/runner-vm/guest-runner.nft");
const runnerFirewallUnit = read("infra/systemd/learncoding-runner-firewall.service");
const runnerGuestFirewallUnit = read("infra/systemd/learncoding-runner-guest-firewall.service");
const recoveryChecker = read("infra/ops/check-recovery.sh");
const existingContainerBaseline = read("infra/ops/existing_container_baseline.py");
const captureExistingContainers = read("infra/ops/capture-existing-containers.py");
const existingContainerFixture = read("infra/tests/fixtures/create-existing-container-baseline.py");
const recoveryService = read("infra/systemd/learncoding-recovery-check.service");
const recoveryTimer = read("infra/systemd/learncoding-recovery-check.timer");
const productionLoadControlUnit = read("infra/systemd/learncoding-production-load-control.service");
const productionLoadGateUnit = read("infra/systemd/learncoding-production-load-gate.service");
const productionLoadRecoveryUnit = read("infra/systemd/learncoding-production-load-recovery.service");
const productionLoadRecoveryPath = read("infra/systemd/learncoding-production-load-recovery.path");
const productionLoadSysusers = read("infra/sysusers.d/learncoding-production-load.conf");
const productionLoadTmpfiles = read("infra/tmpfiles.d/learncoding-production-load.conf");
const productionLoadEnvironment = read("infra/env/production-load.env.example");
const productionLoadHostRuntime = read("infra/ops/validate-production-load-host-runtime.sh");
read("infra/tests/production-load-systemd.test.mjs");
const productionLoadHostRuntimeHarness = read("infra/tests/production-load-host-runtime.test.sh");
const recoveryEvidence = read("infra/ops/capture-recovery-evidence.sh");
const recoveryEvidenceHelper = read("infra/ops/recovery-evidence.py");
const systemdInstaller = read("infra/ops/install-systemd.sh");
const provisionHarness = read("infra/tests/runner-vm-provision.test.sh");
const recoveryHarness = read("infra/tests/power-recovery-check.test.sh");
const runnerHarness = read("infra/tests/runner-reconciliation.test.sh");
const systemdHarness = read("infra/tests/systemd-recovery.test.sh");
const evidenceHarness = read("infra/tests/power-evidence.test.sh");
const evidenceEntryHarness = read("infra/tests/recovery-evidence-entry.test.sh");
const evidenceMainHarness = read("infra/tests/recovery-evidence-main.test.sh");
const evidenceStorageHarness = read("infra/tests/recovery-evidence-storage-health.test.py");
const runnerGuestInstallerHarness = read("infra/tests/runner-guest-installer.test.sh");
const runnerReleaseVerifierHarness = read("infra/tests/runner-release-tree.test.py");
const runnerFirewallPacketHarness = read("infra/tests/runner-firewall-packets.test.sh");
const runtimeHarness = read("infra/tests/runtime-config.test.sh");

for (const mutation of [
  "PATH=/usr/bin:/bin",
  "export PATH=/usr/bin:/bin",
  "unset PATH",
  "readonly PATH=/usr/bin:/bin",
]) {
  expect(sourceManipulatesHarnessPath(mutation), `PATH static guard missed mutation: ${mutation}`);
}
expect(
  !sourceManipulatesHarnessPath("RUNNER_PATH=/fixture/bin"),
  "PATH static guard must distinguish PATH from longer variable names",
);
expect(
  !sourceManipulatesHarnessPath(
    '  launcher=("$production_env" -i HOME=/nonexistent LANG=C LC_ALL=C PATH=/usr/bin:/bin)',
  ),
  "PATH static guard must allow the reviewed hermetic child environment",
);
for (const mutation of [
  'launcher=("$production_env" HOME=/nonexistent PATH=/usr/bin:/bin)',
  'launcher=(env -i HOME=/nonexistent PATH=/usr/bin:/bin)',
  'PATH=/usr/bin:/bin command',
  '  launcher=("$production_env"\u000b-i HOME=/nonexistent LANG=C LC_ALL=C PATH=/usr/bin:/bin)',
  '  launcher=("$production_env"\u000c-i HOME=/nonexistent LANG=C LC_ALL=C PATH=/usr/bin:/bin)',
  '  launcher=("$production_env"\r-i HOME=/nonexistent LANG=C LC_ALL=C PATH=/usr/bin:/bin)',
  '  launcher=("$production_env"\u00a0-i HOME=/nonexistent LANG=C LC_ALL=C PATH=/usr/bin:/bin)',
  '  launcher=("$production_env"\u2028-i HOME=/nonexistent LANG=C LC_ALL=C PATH=/usr/bin:/bin)',
]) {
  expect(
    sourceManipulatesHarnessPath(mutation),
    `PATH static guard must reject near-miss child environment: ${mutation}`,
  );
}
for (const [label, source] of [
  ["runtime validator", runtimeValidation],
  ["sourced Compose environment", composeEnv],
  ["recovery checker", recoveryChecker],
  ["recovery evidence collector", recoveryEvidence],
  ["systemd installer", systemdInstaller],
  ["runner launcher", read("infra/runner/run-runner.sh")],
]) {
  if (source) {
    expect(
      !sourceManipulatesHarnessPath(source),
      `${label} may not reference or mutate the test harness-owned PATH`,
    );
  }
}

const shellHarnesses = [
  ["power recovery checker", recoveryHarness],
  ["runner reconciliation", runnerHarness],
  ["Systemd recovery", systemdHarness],
  ["runtime config", runtimeHarness],
];
const requiredIdentityMutations = [
  "dynamic-command-p",
  "dynamic-hash-p",
  "assembled-absolute",
  "new-shell",
  "dynamic-source",
  "dynamic-dot-source",
  "dynamic-env",
  "dynamic-builtin",
  "dynamic-exec",
];
const requiredContainmentTokens = [
  "/usr/bin/bwrap",
  "--die-with-parent",
  "--new-session",
  "--unshare-user",
  "--unshare-pid",
  "--unshare-net",
  "--unshare-ipc",
  "--unshare-uts",
  "--disable-userns",
  "--cap-drop ALL",
  "--as-pid-1",
  "--tmpfs /",
  "--remount-ro /",
  "--proc /proc",
  "--dev /dev",
  "/usr/bin/timeout",
  "/usr/bin/prlimit",
  "/usr/bin/setpriv",
  "--no-new-privs",
  "CapEff:",
  "CapBnd:",
  "Groups:",
  "NoNewPrivs:",
  "--clear-groups",
  "/run/docker.sock",
  "/run/libvirt/libvirt-sock",
  "/dev/kvm",
  "/etc/learncoding",
  "/var/lib/learncoding",
  '"$containment_repo/.env"',
  '"$containment_repo/.git"',
  "verify_fixed_outer_binary",
  "assert_containment_gate_mutations",
  "minimal_runtime_mounts",
  "prepare_minimal_runtime_mounts",
  "/usr/bin/ldd",
  "containment_ro_mounts",
  "containment_rw_mounts",
];
const requiredSourceStagingTokens = [
  "stage_live_source_once",
  "O_NOFOLLOW",
  "O_CLOEXEC",
  "fstat",
  "path-swap-restore",
  "inplace-restore",
  "verify_exact_staged_shell_source",
  "expected_transformed_sha256",
];
const requiredResourceLimitTokens = [
  "--nproc=64:64",
  "--nofile=128:128",
  "--core=0:0",
  "--cpu=30:30",
  "--as=536870912:536870912",
  "--fsize=1048576:1048576",
  "--data=268435456:268435456",
  "--stack=16777216:16777216",
  "--rss=268435456:268435456",
  "assert_exact_resource_limits",
  "missing-address-space-limit",
  "weakened-address-space-limit",
  "missing-file-size-limit",
  "weakened-file-size-limit",
  "missing-data-limit",
  "weakened-data-limit",
  "missing-stack-limit",
  "weakened-stack-limit",
  "missing-rss-limit",
  "weakened-rss-limit",
  "missing-process-count-limit",
  "weakened-process-count-limit",
  "missing-file-descriptor-limit",
  "weakened-file-descriptor-limit",
  "missing-core-limit",
  "weakened-core-limit",
  "missing-cpu-limit",
  "weakened-cpu-limit",
  "duplicate-resource-limit",
  "Max processes",
  "Max open files",
  "Max core file size",
  "Max cpu time",
  "Max address space",
  "Max file size",
  "Max data size",
  "Max stack size",
  "Max resident set",
];
for (const [label, harness] of shellHarnesses) {
  expect(harness.includes("verify_exact_staged_shell_source"), `${label} harness must verify the exact one-FD staged source identity`);
  expect(harness.includes("sha256_file"), `${label} harness must verify reviewed SHA-256 identities`);
  expect(harness.includes("shebang_count"), `${label} harness must verify exactly one reviewed shebang`);
  expect(harness.includes("$'\\r'"), `${label} harness must reject CR/CRLF reviewed source`);
  expect(harness.includes('"$interpreter" -n "$staged_source"'), `${label} harness must syntax-check the exact immutable stage`);
  expect(harness.includes("'PATH='") && harness.includes("'readonly PATH'"), `${label} harness must use an empty readonly SUT PATH`);
  for (const mutation of requiredIdentityMutations) {
    expect(harness.includes(mutation), `${label} harness is missing the ${mutation} source-identity mutation`);
  }
  for (const token of requiredContainmentTokens) {
    expect(harness.includes(token), `${label} harness is missing mandatory containment token: ${token}`);
  }
  for (const token of requiredSourceStagingTokens) {
    expect(harness.includes(token), `${label} harness is missing mandatory one-FD staging token: ${token}`);
  }
  for (const token of requiredResourceLimitTokens) {
    expect(harness.includes(token), `${label} harness is missing mandatory hard resource-limit token: ${token}`);
  }
  expect(!harness.includes("--ro-bind / /"), `${label} harness must not expose the host root inside containment`);
  expect(
    !/--ro-bind\s+"\$(work|parser_work|case_dir|repo_root|host_root)"\s+"\$\1"/u.test(harness),
    `${label} harness must not expose a broad fixture or worktree root read-only`,
  );
  expect(
    !/--bind\s+"\$(work|parser_work|case_dir|repo_root|host_root)"\s+"\$\1"/u.test(harness),
    `${label} harness must not bind its whole fixture tree read-write`,
  );
  expect(!harness.includes("--unshare-all"), `${label} harness must not use best-effort --unshare-all`);
  expect(!harness.includes("--unshare-user-try"), `${label} harness must not use best-effort user namespaces`);
  expect(/\/usr\/bin\/env -i[\s\S]{0,1200}PATH=/u.test(harness), `${label} harness must enter containment from an empty environment and PATH`);
}

const reviewedSourceContracts = [
  [
    "runner launcher",
    runnerHarness,
    "launcher_reviewed_sha256",
    sha256File("infra/runner/run-runner.sh"),
  ],
  [
    "Systemd installer",
    systemdHarness,
    "installer_reviewed_sha256",
    sha256File("infra/ops/install-systemd.sh"),
  ],
  [
    "runtime validator",
    runtimeHarness,
    "validator_reviewed_sha256",
    sha256File("infra/ops/validate-runtime.sh"),
  ],
  [
    "power recovery checker",
    recoveryHarness,
    "checker_reviewed_sha256",
    sha256File("infra/ops/check-recovery.sh"),
  ],
  [
    "existing-container baseline module",
    recoveryHarness,
    "checker_baseline_module_reviewed_sha256",
    sha256File("infra/ops/existing_container_baseline.py"),
  ],
];
for (const [label, harness, variable, digest] of reviewedSourceContracts) {
  expect(/^[0-9a-f]{64}$/u.test(digest), `${label} production source must exist for its reviewed hash contract`);
  expect(harness.includes(`${variable}='${digest}'`), `${label} harness reviewed SHA must match the exact production bytes`);
}
expect(
  /recovery-evidence-helper\.test\.py/.test(evidenceHarness) &&
    /recovery-evidence-provenance\.test\.py/.test(evidenceHarness) &&
    /recovery-evidence-storage-health\.test\.py/.test(evidenceHarness) &&
    /recovery-evidence-atomic\.test\.py/.test(evidenceHarness) &&
    /recovery-evidence-collection\.test\.py/.test(evidenceHarness) &&
    /recovery-evidence-entry\.test\.sh/.test(evidenceHarness) &&
    /recovery-evidence-main\.test\.sh/.test(evidenceHarness) &&
    !/collector_reviewed_sha256|verify_exact_staged_shell_source/.test(evidenceHarness),
  "power evidence gate must aggregate exact production-byte behavioral tests without transforming the collector",
);
expect(
  /--ro-bind "\$collector" \/opt\/learncoding\/infra\/ops\/capture-recovery-evidence\.sh/.test(evidenceEntryHarness) &&
    /--ro-bind "\$helper" \/opt\/learncoding\/infra\/ops\/recovery-evidence\.py/.test(evidenceEntryHarness) &&
    /cp -- "\$collector"/.test(evidenceMainHarness) &&
    /cp -- "\$helper"/.test(evidenceMainHarness) &&
    /must-not-be-published/.test(evidenceMainHarness) &&
    /SMART media error/.test(evidenceMainHarness) &&
    /parse_smart_summary/.test(evidenceStorageHarness),
  "recovery evidence tests must execute unmodified production entry/helper bytes and cover privacy-safe SMART failure",
);

for (const mutation of [
  "missing-flock",
  "duplicate-flock",
  "changed-flock",
  "missing-node",
  "duplicate-node",
  "changed-node",
  "reordered",
]) {
  expect(runnerHarness.includes(mutation), `runner harness is missing exact ${mutation} command-site mutation`);
}
expect(
  runnerHarness.includes("if ! /usr/bin/flock --exclusive --nonblock 9; then") &&
    runnerHarness.includes("exec /usr/bin/node /opt/learncoding/services/runner/dist/index.js"),
  "runner transformer must name both exact canonical production command sites",
);
expect(
  runnerHarness.includes('[[ "$#" == 3 && "$1" == --exclusive && "$2" == --nonblock && "$3" == 9 ]]') &&
    runnerHarness.includes('/proc/self/fd/9 -ef "$expected_lock"') &&
    runnerHarness.includes("exec /usr/bin/flock --exclusive --nonblock 9"),
  "runner strict flock wrapper must preserve exact argv and lock-file descriptor semantics",
);
expect(
  runnerHarness.includes('[[ "$#" == 1 && "$1" == /opt/learncoding/services/runner/dist/index.js ]]') &&
    runnerHarness.includes("node-terminal /opt/learncoding/services/runner/dist/index.js") &&
    runnerHarness.includes("exit 86"),
  "runner Node site must terminate at a fixed event wrapper without launching the application",
);
for (const mutation of [
  "missing-stat",
  "duplicate-stat",
  "changed-stat",
  "missing-realpath",
  "duplicate-realpath",
  "changed-realpath",
  "missing-docker",
  "duplicate-docker",
  "changed-docker",
]) {
  expect(runtimeHarness.includes(mutation), `runtime harness is missing exact ${mutation} transformation mutation`);
}
expect(
  runtimeHarness.includes("Compose environment must contain only strict data assignments before source") &&
    runtimeHarness.includes('stage_live_source_once "$config" "$runtime_config_stage"') &&
    runtimeHarness.includes('source_manipulates_path "$runtime_config_stage"') &&
    runtimeHarness.includes('verify_compose_env_fixture "$runtime_config_stage"') &&
    runtimeHarness.includes("verify_staged_runtime_config") &&
    runtimeHarness.includes("RUNTIME_CONFIG_VERIFY_SHA256") &&
    runtimeHarness.includes('source "$compose_env"') &&
    runtimeHarness.includes('--ro-bind "$runtime_config_stage" "$config"'),
  "runtime harness must validate and hash the sole sourced Compose environment immediately before execution",
);

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
  /codestead:database-administration:v1/.test(migrationScript) &&
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
expect(/scripts\/process-file-erasures\.ts/.test(dockerfile), "generic worker image must ship the dedicated file-erasure worker");
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
expect(
  /runner-client:\s*\r?\n\s*driver: bridge\s*\r?\n\s*internal: true\s*\r?\n\s*ipam:\s*\r?\n\s*config:\s*\r?\n\s*- subnet: 172\.29\.41\.0\/24\s*\r?\n\s*gateway: 172\.29\.41\.1\s*\r?\n\s*ip_range: 172\.29\.41\.128\/25/.test(
    compose,
  ) &&
    /runner-egress:\s*\r?\n\s*driver: bridge[\s\S]*?subnet: 172\.29\.40\.0\/24\s*\r?\n\s*gateway: 172\.29\.40\.1\s*\r?\n\s*ip_range: 172\.29\.40\.128\/25/.test(
      compose,
    ),
  "runner network dynamic pools must reserve each static .2 gateway address",
);
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
const scanWorkerService = composeService("scan-worker");
expect(
  /profiles: \["uploads"\]/u.test(scanWorkerService) &&
    /source: \$\{LEARN_DATA_ROOT:-\/srv\/learncoding\}\/app-data\/objects\s+target: \/var\/lib\/learncoding\/objects\s+read_only: true/u.test(scanWorkerService),
  "scan worker must remain upload-profile-only with a read-only dedicated object root",
);
expect(
  !/source: \$\{LEARN_DATA_ROOT:-\/srv\/learncoding\}\/app-data\s+target: \/var\/lib\/learncoding(?:\s|$)/u.test(scanWorkerService),
  "scan worker must not mount the parent app-data directory",
);
const fileErasureWorkerService = composeService("file-erasure-worker");
expect(
  /target: worker/.test(fileErasureWorkerService) &&
    /process-file-erasures\.ts/.test(fileErasureWorkerService) &&
    /WORKER_HEALTH_ID: file-erasure-worker/.test(fileErasureWorkerService),
  "dedicated always-on file-erasure worker and health identity are required",
);
expect(
  !/profiles:/.test(fileErasureWorkerService) &&
    !/CLAMD_|UPLOADS_ENABLED|scanner/.test(fileErasureWorkerService) &&
    /source: \$\{LEARN_DATA_ROOT:-\/srv\/learncoding\}\/app-data\/objects\s+target: \/var\/lib\/learncoding\/objects\s+read_only: false/u.test(fileErasureWorkerService),
  "file-erasure worker must be profile-independent, scanner-independent, and limited to the dedicated writable object root",
);
expect(/^  regrade-worker:/m.test(compose), "dedicated assessment regrade worker service is required");
expect(/regrade-worker:[\s\S]*?target: regrade-worker[\s\S]*?RUNNER_SHARED_SECRET_FILE: \/run\/secrets\/runner_shared_secret[\s\S]*?REGRADE_BATCH_SIZE: \$\{REGRADE_BATCH_SIZE:-2\}/.test(compose), "regrade worker must use the dedicated target, runner secret, and two-job batch cap");
expect(/regrade-worker:[\s\S]*?networks:[\s\S]*?data:[\s\S]*?runner-client:/.test(compose), "regrade worker must have only database and runner-client network paths");
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
  ["infra/systemd/learncoding-runner-guest-firewall.service", runnerGuestFirewallUnit],
  ["infra/systemd/learncoding-recovery-check.service", recoveryService],
  ["infra/systemd/learncoding-recovery-check.timer", recoveryTimer],
  ["infra/systemd/learncoding-ingress-recovery.service", ingressRecoveryService],
  ["infra/systemd/learncoding-production-load-control.service", productionLoadControlUnit],
  ["infra/systemd/learncoding-production-load-gate.service", productionLoadGateUnit],
  ["infra/systemd/learncoding-production-load-recovery.service", productionLoadRecoveryUnit],
  ["infra/systemd/learncoding-production-load-recovery.path", productionLoadRecoveryPath],
  ...persistentTimers,
]) {
  expect(
    systemdDirectives(systemdContent) !== null,
    `${systemdPath} must use canonical physical systemd syntax`,
  );
}

const expectedComposeUp =
  "/usr/bin/env PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/bash /opt/learncoding/infra/ops/start-production-stack.sh --startup-wait 600";
const expectedComposeStop =
  "/usr/bin/env -i HOME=/nonexistent LANG=C LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin DOCKER_CONFIG=/nonexistent DOCKER_HOST=unix:///var/run/docker.sock COMPOSE_PROJECT_NAME=learncoding COMPOSE_PROFILES= /usr/bin/docker compose --project-name learncoding --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml down --remove-orphans";
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
    hasSingleSystemdDirective(
      composeUnit,
      "Unit",
      "Requires",
      "docker.service learncoding-runner-firewall.service",
    ) &&
    hasSingleSystemdDirective(
      composeUnit,
      "Unit",
      "Wants",
      "network-online.target libvirtd.service",
    ),
  "Compose systemd unit must retain Docker/local-fs ordering and fail closed when the runner firewall fails",
);
const composePreflightValues = (systemdDirectives(composeUnit) ?? [])
  .filter((directive) => directive.section === "Service" && directive.key === "ExecStartPre")
  .map((directive) => directive.value);
expect(
  composePreflightValues.length === 0 &&
    (systemdDirectives(composeUnit) ?? []).filter(
      (directive) => directive.section === "Service" && directive.key === "ExecStartPost",
    ).length === 0 &&
    /object_storage_preparer_metadata/.test(runtimeValidation) &&
    /"\$resolved_node_bin" --check "\$object_storage_preparer"/.test(runtimeValidation),
  "Compose systemd must delegate the whole authenticated transaction to the guarded start authority",
);
const composeReloadValues = (systemdDirectives(composeUnit) ?? [])
  .filter((directive) => directive.section === "Service" && directive.key === "ExecReload")
  .map((directive) => directive.value);
expect(
  JSON.stringify(composeReloadValues) === JSON.stringify([expectedComposeUp]),
  "Compose reload must invoke only the guarded start authority",
);
expect(
  hasSingleSystemdDirective(composeUnit, "Service", "ExecStart", expectedComposeUp) &&
    JSON.stringify(composeReloadValues) === JSON.stringify([expectedComposeUp]),
  "Compose systemd start and reload must use the fixed-PATH guarded transaction",
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
    expectedComposeStop,
  ) && !composeUnit.includes("down -v"),
  "Compose systemd stop must preserve durable volumes, use the reviewed env file for interpolation, and pin local Docker/project authority",
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
const ingressRecoveryRequires = (systemdDirectives(ingressRecoveryService) ?? []).filter(
  (directive) => directive.section === "Unit" && directive.key === "Requires",
);
expect(
  hasSingleSystemdDirective(ingressRecoveryService, "Unit", "After", "docker.service local-fs.target") &&
    hasSingleSystemdDirective(ingressRecoveryService, "Unit", "Wants", "docker.service") &&
    !ingressRecoveryRequires.some((directive) => directive.value.split(/\s+/u).includes("docker.service")) &&
    hasSingleSystemdDirective(
      ingressRecoveryService,
      "Unit",
      "RequiresMountsFor",
      "/opt/learncoding /etc/learncoding /var/lib/learncoding",
    ) &&
    hasSingleSystemdDirective(ingressRecoveryService, "Unit", "OnFailure", "learncoding-alert@%n.service") &&
    hasSingleSystemdDirective(ingressRecoveryService, "Service", "Type", "oneshot") &&
    hasSingleSystemdDirective(ingressRecoveryService, "Service", "User", "root") &&
    hasSingleSystemdDirective(ingressRecoveryService, "Service", "Group", "root") &&
    hasSingleSystemdDirective(
      ingressRecoveryService,
      "Service",
      "ExecStart",
      "/usr/bin/env PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/bin/bash /opt/learncoding/infra/ops/recover-production-ingress.sh",
    ) &&
    hasSingleSystemdDirective(ingressRecoveryService, "Service", "TimeoutStartSec", "90s"),
  "ingress recovery must be a bounded root oneshot with an alerting Docker-unavailable path",
);
expect(
  /DOCKER_HOST=unix:\/\/\/var\/run\/docker\.sock/u.test(ingressRecoveryScript) &&
    /unset DOCKER_CONTEXT[\s\S]*?COMPOSE_PROJECT_NAME/u.test(ingressRecoveryScript) &&
    /compose=\("\$docker_bin" compose --project-name learncoding/u.test(ingressRecoveryScript) &&
    /readonly recovery_attempt_budget_seconds=60/u.test(ingressRecoveryScript) &&
    /readonly recovery_cleanup_budget_seconds=10/u.test(ingressRecoveryScript) &&
    /recovery_attempt_budget_seconds \+ recovery_cleanup_budget_seconds < systemd_deadline_seconds/u.test(
      ingressRecoveryScript,
    ) &&
    /forced worst-case trace was \$\{traced_seconds\}s instead of 60s/u.test(ingressRecoveryHarness) &&
    /five concurrent timer ticks did not reach the serialized decision point/u.test(ingressRecoveryHarness) &&
    /persistent discovery uncertainty was silently accepted/u.test(ingressRecoveryHarness) &&
    /Internal containers retain `unless-stopped`; the tunnel alone uses `on-failure:5`/u.test(
      ingressRecoveryDesign,
    ) &&
    /Docker authority to `unix:\/\/\/var\/run\/docker\.sock` and Compose project `learncoding`/u.test(
      ingressRecoveryPlan,
    ),
  "ingress recovery must bind local authority, prove concurrency and persistent uncertainty, and fit 60+10 inside 90 seconds",
);
expect(
  hasSingleSystemdDirective(ingressRecoveryTimer, "Timer", "OnBootSec", "1min") &&
    hasSingleSystemdDirective(ingressRecoveryTimer, "Timer", "OnUnitActiveSec", "1min") &&
    hasSingleSystemdDirective(ingressRecoveryTimer, "Timer", "AccuracySec", "5s") &&
    hasSingleSystemdDirective(ingressRecoveryTimer, "Timer", "Persistent", "true") &&
    hasSingleSystemdDirective(
      ingressRecoveryTimer,
      "Timer",
      "Unit",
      "learncoding-ingress-recovery.service",
    ) &&
    hasSingleSystemdDirective(ingressRecoveryTimer, "Install", "WantedBy", "timers.target"),
  "ingress recovery timer must retry once per minute with persistent bounded activation",
);
expect(
  ingressControlTmpfiles.trim() === "d /var/lib/learncoding/ingress-control 0700 root root - -",
  "ingress control state must be provisioned as a root-private persistent directory",
);
expect(
  /systemctl start learncoding-production-load-gate\.service/.test(loadTestingRunbook) &&
    /\/etc\/learncoding\/production-load\.env/.test(loadTestingRunbook) &&
    /learncoding-production-load-recovery\.path/.test(loadTestingRunbook) &&
    /Do not start `learncoding-production-load-control\.service` directly/.test(loadTestingRunbook) &&
    !/npm run test:load:production/.test(loadTestingRunbook),
  "production load runbook must use only the supervised manual gate and exact-journal boot recovery",
);
const loadCredentials = [
  "database_url:/etc/learncoding/secrets/database_url",
  "better_auth_secret:/etc/learncoding/secrets/better_auth_secret",
];
const productionLoadServiceValues = (source, section, key) =>
  (systemdDirectives(source) ?? [])
    .filter((directive) => directive.section === section && directive.key === key)
    .map((directive) => directive.value);
const productionLoadRuntimePreflight = "/usr/bin/bash /opt/learncoding/infra/ops/validate-production-load-host-runtime.sh";
const productionLoadTsxManifest = "/opt/learncoding/node_modules/tsx/package.json";
expect(
  /node-floor v22\.22\.0/.test(productionLoadHostRuntimeHarness) &&
    /below-floor v22\.21\.99/.test(productionLoadHostRuntimeHarness) &&
    /malformed-version/.test(productionLoadHostRuntimeHarness) &&
    /wrong-tsx/.test(productionLoadHostRuntimeHarness) &&
    /loader-import-failure/.test(productionLoadHostRuntimeHarness) &&
    /group-writable Node executable was accepted/.test(productionLoadHostRuntimeHarness) &&
    /symlinked tsx manifest was accepted/.test(productionLoadHostRuntimeHarness) &&
    /hard-linked Node executable was accepted/.test(productionLoadHostRuntimeHarness),
  "production load host runtime must have deterministic boundary and unsafe-path rejection fixtures",
);
expect(
  /readonly node_bin=\/usr\/bin\/node/.test(productionLoadHostRuntime) &&
    /minimum_node_version=22\.22\.0/.test(productionLoadHostRuntime) &&
    /readonly tsx_manifest=\/opt\/learncoding\/node_modules\/tsx\/package\.json/.test(productionLoadHostRuntime) &&
    /expected_tsx_version=4\.23\.0/.test(productionLoadHostRuntime) &&
    /stat -Lc/.test(productionLoadHostRuntime) &&
    !/NODE_OPTIONS|npm_config|eval|source /.test(productionLoadHostRuntime),
  "production load host runtime validator must pin fixed, secure Node >=22.22.0 and tsx 4.23.0 inputs",
);
for (const unit of [productionLoadControlUnit, productionLoadGateUnit, productionLoadRecoveryUnit]) {
  expect(
    hasSingleSystemdDirective(unit, "Unit", "ConditionFileIsExecutable", "/usr/bin/node") &&
      hasSingleSystemdDirective(unit, "Unit", "AssertPathExists", productionLoadTsxManifest) &&
      productionLoadServiceValues(unit, "Service", "ExecStartPre").includes(productionLoadRuntimePreflight),
    "every host-Node production load unit must fail closed on the reviewed Node/tsx runtime",
  );
}
expect(
  hasSingleSystemdDirective(productionLoadControlUnit, "Service", "User", "root") &&
    hasSingleSystemdDirective(productionLoadControlUnit, "Service", "Group", "learncoding-load-gate") &&
    hasSingleSystemdDirective(productionLoadControlUnit, "Unit", "RefuseManualStart", "yes") &&
    hasSingleSystemdDirective(productionLoadControlUnit, "Unit", "StopWhenUnneeded", "yes") &&
    productionLoadServiceValues(productionLoadControlUnit, "Service", "ExecStartPre").includes(
      "/usr/bin/test -f /etc/learncoding/production-load-manifest.json",
    ) &&
    hasSingleSystemdDirective(
      productionLoadControlUnit,
      "Service",
      "ExecStart",
      "/usr/bin/node --import tsx /opt/learncoding/scripts/start-production-load-control-service.ts",
    ) &&
    JSON.stringify(productionLoadServiceValues(productionLoadControlUnit, "Service", "LoadCredential")) ===
      JSON.stringify(loadCredentials) &&
    hasSingleSystemdDirective(productionLoadControlUnit, "Service", "RuntimeMaxSec", "5h30m") &&
    hasSingleSystemdDirective(productionLoadControlUnit, "Service", "UMask", "0077") &&
    hasSingleSystemdDirective(productionLoadControlUnit, "Service", "LimitCORE", "0") &&
    !productionLoadControlUnit.includes("WantedBy="),
  "production load control must be a bounded root daemon with systemd credentials, an exact manifest, and no boot enablement",
);
expect(
  hasSingleSystemdDirective(productionLoadGateUnit, "Service", "User", "learncoding-load-gate") &&
    hasSingleSystemdDirective(productionLoadGateUnit, "Service", "Group", "learncoding-load-gate") &&
    hasSingleSystemdDirective(
      productionLoadGateUnit,
      "Unit",
      "Requires",
      "learncoding-production-load-control.service",
    ) &&
    hasSingleSystemdDirective(
      productionLoadGateUnit,
      "Service",
      "ExecStart",
      "/usr/bin/node --import tsx /opt/learncoding/scripts/load-smoke.ts",
    ) &&
    hasSingleSystemdDirective(productionLoadGateUnit, "Service", "RuntimeMaxSec", "5h") &&
    hasSingleSystemdDirective(productionLoadGateUnit, "Service", "CapabilityBoundingSet", "") &&
    hasSingleSystemdDirective(productionLoadGateUnit, "Service", "NoNewPrivileges", "yes") &&
    productionLoadServiceValues(productionLoadGateUnit, "Service", "LoadCredential").length === 0 &&
    /InaccessiblePaths=.*\/etc\/learncoding\/secrets.*\/run\/docker\.sock.*\/run\/libvirt.*\/dev\/kvm/.test(
      productionLoadGateUnit,
    ) &&
    !productionLoadGateUnit.includes("WantedBy="),
  "production load gate must be manual, bounded, unprivileged, and unable to read secrets or host-control sockets",
);
expect(
  hasSingleSystemdDirective(productionLoadRecoveryUnit, "Service", "User", "root") &&
    hasSingleSystemdDirective(productionLoadRecoveryUnit, "Service", "Group", "root") &&
    hasSingleSystemdDirective(productionLoadRecoveryUnit, "Unit", "RefuseManualStart", "yes") &&
    hasSingleSystemdDirective(
      productionLoadRecoveryUnit,
      "Service",
      "ExecStart",
      "/usr/bin/node --import tsx /opt/learncoding/scripts/start-production-load-control-service.ts --recover-only",
    ) &&
    productionLoadServiceValues(productionLoadRecoveryUnit, "Service", "LoadCredential").length === 0 &&
    hasSingleSystemdDirective(
      productionLoadRecoveryUnit,
      "Unit",
      "RequiresMountsFor",
      "/opt/learncoding /etc/learncoding /var/lib/learncoding-production-load /var/lib/learncoding-production-load-evidence",
    ) &&
    productionLoadServiceValues(productionLoadRecoveryUnit, "Service", "ExecStartPre").includes(
      "/usr/bin/test -f /var/lib/learncoding-production-load/production-load-fault-journal.json",
    ) &&
    !/LOAD_RECOVERY_ONLY|RuntimeDirectory=|ListenStream=|SocketMode=/.test(productionLoadRecoveryUnit) &&
    hasSingleSystemdDirective(productionLoadRecoveryUnit, "Service", "RuntimeMaxSec", "10min") &&
    !productionLoadRecoveryUnit.includes("WantedBy="),
  "boot recovery must use the sole recovery-only argv, exact journal, bounded root service, and no listening socket",
);
expect(
  hasSingleSystemdDirective(
    productionLoadRecoveryPath,
    "Path",
    "PathExists",
    "/var/lib/learncoding-production-load/production-load-fault-journal.json",
  ) &&
    hasSingleSystemdDirective(
      productionLoadRecoveryPath,
      "Path",
      "Unit",
      "learncoding-production-load-recovery.service",
    ) &&
    hasSingleSystemdDirective(productionLoadRecoveryPath, "Path", "MakeDirectory", "false") &&
    hasSingleSystemdDirective(productionLoadRecoveryPath, "Install", "WantedBy", "multi-user.target") &&
    !productionLoadRecoveryPath.includes("DirectoryNotEmpty=") &&
    !productionLoadRecoveryPath.includes("[Timer]"),
  "boot recovery must activate only for the exact active fault journal and target only recovery-only execution",
);
expect(
  /^u learncoding-load-gate - "Codestead production load gate client" \/nonexistent \/usr\/sbin\/nologin$/m.test(
    productionLoadSysusers,
  ) &&
    /^d \/run\/learncoding 0750 root learncoding-load-gate -$/m.test(productionLoadTmpfiles) &&
    /^d \/var\/lib\/learncoding-production-load 0700 root root -$/m.test(productionLoadTmpfiles) &&
    /^d \/var\/lib\/learncoding-production-load-evidence 0700 learncoding-load-gate learncoding-load-gate -$/m.test(
      productionLoadTmpfiles,
    ),
  "production load sysusers/tmpfiles must establish a nologin client, fixed socket parent, root-private journal, and private evidence root",
);
const productionLoadEnvironmentNames = productionLoadEnvironment
  .split(/\r?\n/u)
  .filter((line) => line && !line.startsWith("#"))
  .map((line) => line.slice(0, line.indexOf("=")));
expect(
  JSON.stringify(productionLoadEnvironmentNames) === JSON.stringify([
    "LOAD_BASE_URL",
    "LOAD_NUC_HOST_ID",
    "LOAD_RUNNER_VM_ID",
  ]) && !/(?:SECRET|TOKEN|PASSWORD|DATABASE_URL|COOKIE|KEY)=/i.test(productionLoadEnvironment),
  "production load environment example may contain only the three dynamic non-secret identities",
);
const expectedEnabledUnits = [
  "learncoding-runner-firewall.service",
  "learncoding-compose.service",
  "learncoding-recovery-check.timer",
  "learncoding-ingress-recovery.timer",
  "learncoding-backup.timer",
  "learncoding-backup-check.timer",
  "learncoding-offsite-sync.timer",
  "learncoding-offsite-retention.timer",
  "learncoding-restore-drill-reminder.timer",
  "learncoding-retention.timer",
  "learncoding-production-load-recovery.path",
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
    !actualEnabledUnits.includes("learncoding-restore-drill.service") &&
    !actualEnabledUnits.includes("learncoding-production-load-control.service") &&
    !actualEnabledUnits.includes("learncoding-production-load-gate.service") &&
    !actualEnabledUnits.includes("learncoding-production-load-recovery.service"),
  "systemd installer must enable only the reviewed automatic units plus exact-journal load recovery, never a manual load service",
);
expect(
  /"\$repo_root\/infra\/ops\/validate-production-load-host-runtime\.sh"/.test(systemdInstaller),
  "systemd installer must validate the fixed host Node and reviewed tsx tree before publishing units",
);
expect(
  /systemd-sysusers \/etc\/sysusers\.d\/learncoding-production-load\.conf/.test(systemdInstaller) &&
    /systemd-tmpfiles --create \/etc\/tmpfiles\.d\/learncoding-production-load\.conf/.test(systemdInstaller) &&
    /systemd-tmpfiles --create \/etc\/tmpfiles\.d\/learncoding-ingress-control\.conf/.test(systemdInstaller),
  "systemd installer must provision the reviewed production-load and ingress-control filesystem boundaries",
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
  /NODEJS_APT_VERSION=22\.23\.1-1nodesource1/.test(deploymentGuide) &&
    /\/usr\/bin\/node --version/.test(deploymentGuide) &&
    /npm ci --omit=dev --ignore-scripts --prefix \/opt\/learncoding/.test(deploymentGuide) &&
    /validate-production-load-host-runtime\.sh/.test(deploymentGuide),
  "deployment guide must install and validate the reviewed host Node and production-only tsx tree",
);
expect(
  /sudo apt-get install --yes --no-install-recommends[\s\S]*qemu-kvm[\s\S]*libvirt-daemon-system[\s\S]*libvirt-clients[\s\S]*virtinst[\s\S]*cloud-image-utils/.test(
    deploymentGuide,
  ) &&
    /sudo apt-get install --yes --no-install-recommends[\s\S]*dnsmasq-base/.test(
      deploymentGuide,
    ) &&
    /sudo systemctl enable --now libvirtd\.service/.test(deploymentGuide) &&
    /test "\$\(command -v dnsmasq\)" = \/usr\/sbin\/dnsmasq/.test(deploymentGuide) &&
    /sudo test -c \/dev\/kvm/.test(deploymentGuide) &&
    /sudo virsh --connect qemu:\/\/\/system list --all/.test(deploymentGuide),
  "deployment guide must explicitly install and verify dnsmasq plus provide paste-ready libvirt/KVM activation and verification commands",
);
expect(
  /REPO_ROOT=\/opt\/learncoding bash \/opt\/learncoding\/infra\/ops\/install-systemd\.sh --enable/.test(
    deploymentGuide,
  ) &&
    /systemctl is-active --quiet learncoding-runner-firewall\.service/.test(deploymentGuide) &&
    /systemctl is-active --quiet learncoding-compose\.service/.test(deploymentGuide) &&
    /systemctl is-enabled --quiet learncoding-recovery-check\.timer/.test(deploymentGuide) &&
    /systemctl is-enabled --quiet learncoding-ingress-recovery\.timer/.test(deploymentGuide) &&
    /enables the eight reviewed recovery, backup, offsite-publication, restore-drill reminder, and retention timers/.test(
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
    /browser-durable outbox that persists locally before displaying `Saved locally`/.test(deploymentGuide) &&
    /survive browser close\/reopen and synchronize exactly once after recovery/.test(deploymentGuide) &&
    /Logout, session revocation, exam finalization, and administrator deletion must purge the scoped local records\./.test(
      deploymentGuide,
    ) &&
    /cannot truthfully guarantee the final keystroke before browser persistence, an unacknowledged network request, or a hardware write falsely reported as durable/.test(
      deploymentGuide,
    ),
  "deployment guide must document the interim boot seam and unfinished external power-loss evidence",
);
expect(
  /AccountTag.*lowercase 32-hex/.test(deploymentGuide) &&
    /TunnelSecret.*canonical base64 for exactly 32 bytes/.test(deploymentGuide) &&
    /TunnelID.*lowercase RFC 4122 UUID/.test(deploymentGuide) &&
    /validator never prints them/.test(deploymentGuide) &&
    /\/mnt\/learncoding-backups` with `rw,nodev,nosuid,noexec`/.test(deploymentGuide) &&
    /different physical disk from `\/srv\/learncoding`/.test(deploymentGuide) &&
    /\/etc\/learncoding\/active-release\.env/.test(deploymentGuide) &&
    /\/etc\/learncoding\/managed-containers\.<MANAGED_INVENTORY_SHA256>\.tsv/.test(deploymentGuide) &&
    /\/etc\/learncoding\/application-images\.<APPLICATION_IMAGE_RECORD_SHA256>\.json/.test(deploymentGuide) &&
    /capture-recovery-evidence\.sh pre/.test(deploymentGuide) &&
    /capture-recovery-evidence\.sh post/.test(deploymentGuide) &&
    /sha256sum --check/.test(deploymentGuide) &&
    /technical evidence only; they do not prove a physical cut occurred/.test(deploymentGuide) &&
    /Never claim the hard-cut gate passed from CI/.test(deploymentGuide),
  "deployment guide must document canonical tunnel credentials and the fail-closed physical recovery evidence procedure",
);
expect(
  /runtime-images\.env` first and `dist\/runtime-images\.json` last/.test(runnerIsolationGuide) &&
    /JSON file is the commit marker/.test(runnerIsolationGuide) &&
    /RELEASE\.SHA256SUMS/.test(runnerIsolationGuide) &&
    /learncoding-runner-guest-firewall\.service/.test(runnerIsolationGuide) &&
    /learncoding-runner-firewall\.service/.test(runnerIsolationGuide) &&
    /192\.168\.122\.12:4100/.test(runnerIsolationGuide),
  "runner-isolation guide must bind the runtime commit pair, exact release tree, and dual firewall order",
);
expect(
  /`learncoding-backup\.timer`, `learncoding-offsite-sync\.timer`, `learncoding-offsite-retention\.timer`, `learncoding-restore-drill-reminder\.timer`, and `learncoding-retention\.timer` use `OnCalendar=` with `Persistent=true`, so systemd catches up a missed calendar run after downtime\./.test(
    deploymentGuide,
  ) &&
    /`learncoding-backup-check\.timer`, `learncoding-recovery-check\.timer`, and `learncoding-ingress-recovery\.timer` use monotonic boot\/active intervals; after a reboot they schedule fresh post-boot checks rather than replaying a missed wall-clock event\./.test(
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
expect(
  /cloudflare_credential_pattern/.test(runtimeValidation) &&
    /AccountTag/.test(runtimeValidation) &&
    /TunnelSecret/.test(runtimeValidation) &&
    /TunnelID/.test(runtimeValidation) &&
    /decoded_cloudflare_secret_bytes/.test(runtimeValidation) &&
    /missing-tunnel-id/.test(runtimeHarness) &&
    /extra-field/.test(runtimeHarness) &&
    /malformed-account/.test(runtimeHarness) &&
    /invalid-secret/.test(runtimeHarness),
  "runtime validation must parse exact Cloudflare tunnel credentials and retain negative structure tests",
);
expect(/SOURCE_CODE_URL must be an HTTPS URL/.test(runtimeValidation), "runtime validation must reject a missing or non-HTTPS source-code URL");
expect(
  /--post-start/.test(runtimeValidation) &&
    /\btimeout\b/.test(runtimeValidation) &&
    /runner client URL must be exactly http:\/\/runner-egress-gateway:4100/.test(runtimeValidation) &&
    /runner gateway upstream must be exactly http:\/\/192\.168\.122\.12:4100/.test(runtimeValidation) &&
    /172\.29\.41\.0\/24/.test(runtimeValidation) &&
    /172\.29\.40\.0\/24/.test(runtimeValidation) &&
    /172\.29\.40\.2/.test(runtimeValidation) &&
    /cdst-run0/.test(runtimeValidation),
  "runtime validation must expose only the post-start selector and require the exact gateway URLs, networks, and source",
);

if (runnerNetworkXml) {
  expect(
    /<name>default<\/name>/.test(runnerNetworkXml) &&
      /<forward\s+mode=["']nat["']/.test(runnerNetworkXml) &&
      /<bridge\s+name=["']virbr0["']/.test(runnerNetworkXml) &&
      /address=["']192\.168\.122\.1["']/.test(runnerNetworkXml) &&
      /netmask=["']255\.255\.255\.0["']/.test(runnerNetworkXml) &&
      /<range\s+start=["']192\.168\.122\.2["']\s+end=["']192\.168\.122\.254["']/.test(runnerNetworkXml) &&
      /mac=["']52:54:00:20:00:12["']/.test(runnerNetworkXml) &&
      /ip=["']192\.168\.122\.12["']/.test(runnerNetworkXml),
    "runner network XML must define the reviewed libvirt default NAT identity",
  );
}
if (runnerProvisioner) {
  expect(
    /trusted_bootstrap=/.test(runnerProvisioner) &&
      /O_NOFOLLOW/.test(runnerProvisioner) &&
      /os\.fstat/.test(runnerProvisioner) &&
      /hashlib\.sha256/.test(runnerProvisioner) &&
      /compile\(source, path, "exec"\)/.test(runnerProvisioner) &&
      /exec\(code, namespace, namespace\)/.test(runnerProvisioner) &&
      !/\/usr\/bin\/python3 -I -B "\$helper"/.test(runnerProvisioner),
    "provisioner wrapper must verify and execute the same no-follow helper bytes before any helper code runs",
  );
  expect(
    /^helper_sha256='[0-9a-f]{64}'$/m.test(runnerProvisioner) &&
      /^contract_sha256='[0-9a-f]{64}'$/m.test(runnerProvisioner),
    "provisioner wrapper must pin both helper and contract bytes",
  );
  expect(
    !/virsh\s+(?:--connect\s+\S+\s+)?(?:destroy|undefine|vol-delete)\b|--remove-all-storage|\b(?:br0|wlo1)\b|--network\s+(?:bridge|direct)=/i.test(
      `${runnerProvisioner}\n${runnerProvisionHelper}`,
    ),
    "provisioner must not contain destructive libvirt/disk or Wi-Fi bridge operations",
  );
  expect(
    /host-passthrough/.test(runnerProvisionHelper) &&
      /"--osinfo", EXPECTED_OSINFO/.test(runnerProvisionHelper) &&
      /EXPECTED_OSINFO: Final = "ubuntu24\.04"/.test(runnerProvisionHelper) &&
      /"osinfo": "ubuntu24\.04"/.test(runnerProvisionContract) &&
      /cache=none/.test(runnerProvisionHelper) &&
      /100G/.test(runnerProvisionHelper) &&
      /"vcpus": 4/.test(runnerProvisionContract) &&
      /"memory_mib": 8192/.test(runnerProvisionContract) &&
      /"disk_bytes": 107374182400/.test(runnerProvisionContract),
    "provisioner must encode host-passthrough, cache=none, and the 100 GiB disk",
  );
  expect(
    /selectors\.DefaultSelector/.test(runnerProvisionHelper) &&
      /OUTPUT_LIMIT_BYTES/.test(runnerProvisionHelper) &&
      /_terminate_process_group/.test(runnerProvisionHelper) &&
      /_wait_for_process_group_exit/.test(runnerProvisionHelper) &&
      /external process group survived SIGKILL/.test(runnerProvisionHelper),
    "provisioner helper must incrementally bound command output and terminate overflowing process groups",
  );
  expect(
    /_renameat2_noreplace/.test(runnerProvisionHelper) &&
      /publication_checkpoint\("stage-fsynced"\)/.test(runnerProvisionHelper) &&
      /publication_checkpoint\("destination-directory-fsynced"\)/.test(runnerProvisionHelper),
    "provisioner helper must durably fsync stages before no-clobber publication",
  );
  expect(
    /build_network_update_command\(before\.uuid/.test(runnerProvisionHelper) &&
      /"bridge_mac": bridge_mac/.test(runnerProvisionHelper),
    "provisioner helper must bind updates to the captured UUID and fingerprint bridge-MAC drift",
  );
  expect(
    /tampered helper executed a top-level side effect/.test(provisionHarness) &&
      /test_actual_network_convergence_clean_rerun_and_partial_live_repair/.test(provisionHarness) &&
      /test_actual_domain_define_autostart_and_start_lifecycle_uses_no_destructive_action/.test(provisionHarness) &&
      /test_integrated_transaction_clean_rerun_and_domain_cutpoint_recovery/.test(provisionHarness) &&
      /test_network_name_replacement_race_fails_without_updating_replacement/.test(provisionHarness) &&
      /test_signal_cleanup_escalates_from_term_to_kill_for_a_stuck_group/.test(provisionHarness) &&
      /test_output_cleanup_kills_descendant_group_after_parent_exits/.test(provisionHarness) &&
      /test_signal_cleanup_rejects_a_group_that_survives_sigkill/.test(provisionHarness) &&
      /test_signal_cleanup_stops_after_group_disappears_before_id_reuse/.test(provisionHarness) &&
      /test_linux_root_self_test_covers_a_real_descendant_group/.test(provisionHarness) &&
      /test_osinfo_catalog_requires_exact_pinned_ubuntu_short_id/.test(provisionHarness) &&
      /test_wrong_source_sha_fails_before_verified_bytes_are_returned/.test(provisionHarness) &&
      /test_domain_rejects_unreviewed_optional_security_and_lifecycle_state/.test(provisionHarness) &&
      /test_bridge_mac_is_part_of_non_target_network_fingerprint/.test(provisionHarness) &&
      /publication_events/.test(runnerProvisionHelper) &&
      /command output-bound self-test/.test(runnerProvisionHelper),
    "runner VM harness must cover bootstrap tampering, fake lifecycle, cut points, bounded output, and fail-closed XML drift",
  );
}
if (runnerReleaseVerifier) {
  expect(
    /os\.O_NOFOLLOW/.test(runnerReleaseVerifier) &&
      /follow_symlinks=False/.test(runnerReleaseVerifier) &&
      /st_uid != 0 or info\.st_gid != 0/.test(runnerReleaseVerifier) &&
      /info\.st_nlink != 1/.test(runnerReleaseVerifier) &&
      /release manifest must describe the exact complete file tree/.test(runnerReleaseVerifier) &&
      /second_manifest != manifest_identity or second != first/.test(runnerReleaseVerifier) &&
      /test_concurrent_mutate_and_restore_is_rejected/.test(runnerReleaseVerifierHarness),
    "release-tree verifier must reject symlink/hardlink/ownership/exact-tree/race drift with a behavioral mutation test",
  );
}
expect(
  /compose_version=5\.1\.4/.test(composeCiInstaller) &&
    /33b208d7e76639db742fae84b966cc01dacae58ca3fc4dabbc907045aefdf0c4/.test(composeCiInstaller) &&
    /github\.com\/docker\/compose\/releases\/download\/v\$\{compose_version\}\/docker-compose-linux-x86_64/.test(composeCiInstaller) &&
    /actual_sha256.*compose_sha256/s.test(composeCiInstaller) &&
    /installed_version.*compose_version/s.test(composeCiInstaller),
  "CI must install the reviewed Docker Compose v5 binary only after exact checksum verification",
);
expect(
  /O_NOFOLLOW/.test(runnerRuntimeRecordVerifier) &&
    /before\.uid !== 0/.test(runnerRuntimeRecordVerifier) &&
    /before\.gid !== 0/.test(runnerRuntimeRecordVerifier) &&
    /before\.nlink !== 1/.test(runnerRuntimeRecordVerifier) &&
    /runtime-record-id=/.test(runnerRuntimeRecordVerifier) &&
    /runtime image environment projection does not match its canonical record id/.test(runnerRuntimeRecordVerifier) &&
    /runtime-env-mismatch/.test(runnerGuestInstallerHarness) &&
    /runtime-record-id-mismatch/.test(runnerGuestInstallerHarness),
  "guest runtime publication must bind a root-owned JSON commit marker to its exact environment projection",
);
if (runnerGuestInstaller) {
  const dockerStartup = runnerGuestInstaller.indexOf("systemctl enable --now docker.service");
  const runtimeBuild = runnerGuestInstaller.indexOf("run runtime:build");
  expect(
    /^#!\/usr\/bin\/bash -p$/mu.test(runnerGuestInstaller) &&
      /VERSION_ID.*24\.04/.test(runnerGuestInstaller) &&
      /192\.168\.122\.12/.test(runnerGuestInstaller) &&
      /RUNNER_MAX_CONCURRENCY=2/.test(runnerGuestInstaller) &&
      /RUNNER_RELEASE_MANIFEST_SHA256/.test(runnerGuestInstaller) &&
      /verify-release-tree\.py/.test(runnerGuestInstaller) &&
      /verify-runtime-record\.mjs/.test(runnerGuestInstaller) &&
      /runtime-images\.json/.test(runnerGuestInstaller) &&
      /\/usr\/bin\/python3\.12 "\$release_verifier" "\$release_root" "\$expected_manifest_sha256"/.test(runnerGuestInstaller) &&
      /cmp -s -- .*tr -d '\\000'/s.test(runnerGuestInstaller) &&
      !/\$'\\0'/.test(runnerGuestInstaller) &&
      dockerStartup >= 0 &&
      runtimeBuild > dockerStartup &&
      /runtime:build/.test(runnerGuestInstaller) &&
      /runtime:inspect/.test(runnerGuestInstaller) &&
      /runtime:test/.test(runnerGuestInstaller) &&
      /runtime:scan/.test(runnerGuestInstaller) &&
      /runtime:record/.test(runnerGuestInstaller) &&
      /RUNNER_IMAGE_C/.test(runnerGuestInstaller) &&
      /RUNNER_IMAGE_CPP/.test(runnerGuestInstaller) &&
      /RUNNER_IMAGE_JAVA/.test(runnerGuestInstaller) &&
      /RUNNER_IMAGE_PYTHON/.test(runnerGuestInstaller) &&
      /RUNNER_IMAGE_JAVASCRIPT/.test(runnerGuestInstaller),
    "guest installer must verify the reviewed release, current fixed guest address, five exact images, and runtime gates",
  );
}
if (runnerFirewall) {
  const allowRule = runnerFirewall.indexOf(
    'iifname "cdst-run0" ip saddr 172.29.40.2 ip daddr 192.168.122.12 tcp dport 4100 accept',
  );
  const runnerSourceDrop = runnerFirewall.indexOf('iifname "cdst-run0" drop');
  const dropRule = runnerFirewall.indexOf('ip daddr 192.168.122.12 tcp dport 4100 drop');
  const establishedRule = runnerFirewall.indexOf('ct state established,related accept');
  expect(
    /table inet codestead_runner/.test(runnerFirewall) &&
      /type filter hook forward priority filter \+ 10; policy accept;/.test(runnerFirewall) &&
      establishedRule >= 0 &&
      allowRule >= 0 &&
      runnerSourceDrop > allowRule &&
      dropRule > runnerSourceDrop &&
      establishedRule > dropRule &&
      !/flush ruleset/.test(runnerFirewall),
    "runner firewall must allow only gateway source 172.29.40.2 on cdst-run0, drop every other runner-egress flow including established ones, then preserve unrelated established traffic",
  );
}
if (runnerGuestFirewall) {
  const guestInputPolicy = runnerGuestFirewall.indexOf(
    "add chain inet codestead_runner_guest input { type filter hook input priority filter; policy drop; }",
  );
  const guestHostRunnerAllow = runnerGuestFirewall.indexOf(
    "add rule inet codestead_runner_guest input ip saddr 192.168.122.1 tcp dport 4100 accept",
  );
  const guestAppAllow = runnerGuestFirewall.indexOf(
    "add rule inet codestead_runner_guest input ip saddr 172.29.40.2 tcp dport 4100 accept",
  );
  expect(
    /destroy table inet codestead_runner_guest/.test(runnerGuestFirewall) &&
      guestInputPolicy >= 0 &&
      guestHostRunnerAllow > guestInputPolicy &&
      guestAppAllow > guestHostRunnerAllow &&
      !/flush ruleset/.test(runnerGuestFirewall) &&
      /an untrusted routed IPv4 client reached the runner API/.test(runnerFirewallPacketHarness) &&
      /the runner gateway reached the runner API over an unreviewed IPv6 path/.test(runnerFirewallPacketHarness),
    "guest firewall must default-deny ingress, allow only the host/gateway paths, and retain real routed IPv4/IPv6 packet tests",
  );
}
if (runnerGuestFirewallUnit) {
  expect(
    hasSingleSystemdDirective(runnerGuestFirewallUnit, "Service", "Type", "oneshot") &&
      hasSingleSystemdDirective(runnerGuestFirewallUnit, "Service", "User", "root") &&
      hasSingleSystemdDirective(runnerGuestFirewallUnit, "Service", "RemainAfterExit", "yes") &&
      hasSingleSystemdDirective(
        runnerGuestFirewallUnit,
        "Service",
        "ExecStartPre",
        "/usr/sbin/nft --check --file /opt/learncoding/infra/runner-vm/guest-runner.nft",
      ) &&
      hasSystemdDirectiveTokens(runnerGuestFirewallUnit, "Unit", "Before", [
        "network-pre.target",
        "learncoding-runner.service",
      ]) &&
      /CapabilityBoundingSet=CAP_NET_ADMIN/.test(runnerGuestFirewallUnit) &&
      /ProtectSystem=strict/.test(runnerGuestFirewallUnit) &&
      /learncoding-runner-guest-firewall\.service/.test(runnerGuestInstallerHarness),
    "guest firewall unit must validate before apply, precede runner startup, and run with only NET_ADMIN",
  );
}
if (runnerFirewallUnit) {
  expect(
    hasSingleSystemdDirective(runnerFirewallUnit, "Service", "Type", "oneshot") &&
      hasSingleSystemdDirective(runnerFirewallUnit, "Service", "RemainAfterExit", "yes") &&
      hasSingleSystemdDirective(
        runnerFirewallUnit,
        "Service",
        "ExecStartPre",
        "/usr/sbin/nft --check --file /opt/learncoding/infra/runner-vm/host-runner.nft",
      ) &&
      hasSystemdDirectiveTokens(runnerFirewallUnit, "Unit", "After", [
        "network-online.target",
        "libvirtd.service",
      ]) &&
      hasSystemdDirectiveTokens(runnerFirewallUnit, "Unit", "Before", ["learncoding-compose.service"]),
    "runner firewall unit must validate the reviewed policy and order it before Compose",
  );
}
if (recoveryChecker) {
  expect(
    /\/etc\/learncoding\/existing-containers\.txt/.test(recoveryChecker) &&
      /production_baseline_helper='\/opt\/learncoding\/infra\/ops\/existing_container_baseline\.py'/.test(
        recoveryChecker,
      ) &&
      /RECOVERY_CHECK_TEST_ROOT/.test(recoveryChecker) &&
      /900/.test(recoveryChecker) &&
      /x-runner-response-signature/i.test(recoveryChecker) &&
      /concurrency/.test(recoveryChecker),
    "recovery checker must use the protected baseline, 900-second bound, and signed two-slot runner health",
  );
}
expect(
  recoveryChecker.includes(`production_baseline_helper_sha256='${sha256File("infra/ops/existing_container_baseline.py")}'`) &&
    /production_baseline_cache_dir='\/opt\/learncoding\/infra\/ops\/__pycache__'/.test(recoveryChecker) &&
    /existing_container_baseline\.\*\.pyc/.test(recoveryChecker) &&
    /"\$python" -B "\$helper"/.test(recoveryChecker) &&
    /identity_from_inspection/.test(existingContainerBaseline) &&
    /serialize_baseline/.test(existingContainerBaseline) &&
    /containerId/.test(existingContainerBaseline) &&
    /PRIVATE_FIXTURE/.test(existingContainerFixture) &&
    /existing-id-drift/.test(recoveryHarness) &&
    /existing-image-drift/.test(recoveryHarness) &&
    /existing-config-drift/.test(recoveryHarness) &&
    /existing-restart-drift/.test(recoveryHarness) &&
    /existing-health-drift/.test(recoveryHarness) &&
    /existing-paused/.test(recoveryHarness) &&
    /existing-restarting/.test(recoveryHarness) &&
    /existing-dead/.test(recoveryHarness) &&
    /existing-status-drift/.test(recoveryHarness) &&
    /capture_records/.test(captureExistingContainers) &&
    /--no-trunc/.test(captureExistingContainers) &&
    /\{\{\.ID\}\}\\t\{\{\.Names\}\}/.test(captureExistingContainers) &&
    /running container inventory changed during capture/.test(captureExistingContainers),
  "pre-existing container recovery must bind exact instance identity, image, configuration, restart policy, and strict live state without publishing raw configuration",
);
expect(
  /runtime_state_root="\$\{RUNTIME_STATE_ROOT:-\/etc\/learncoding\}"/.test(releaseProduction) &&
    /active_release_state="\$runtime_state_root\/active-release\.env"/.test(releaseProduction) &&
    /inventory_target="\$runtime_state_root\/managed-containers\.\$\{inventory_sha\}\.tsv"/.test(releaseProduction) &&
    /application_target="\$runtime_state_root\/application-images\.\$\{application_sha\}\.json"/.test(releaseProduction) &&
    /record_managed_runtime_state[\s\S]*?publish_runtime_state[\s\S]*?update_release_pointer/.test(
      releaseProduction,
    ) &&
    /active release state was not atomically published/.test(releaseProductionHarness) &&
    /hash-addressed managed inventory was not published/.test(releaseProductionHarness) &&
    /hash-addressed application record was not published/.test(releaseProductionHarness) &&
    /published active state is not retained in its release record/.test(releaseProductionHarness) &&
    /managed inventory order or coverage is invalid/.test(releaseProductionHarness) &&
    /RUNTIME_STATE_ROOT: Final = Path\("\/etc\/learncoding"\)/.test(recoveryEvidenceHelper) &&
    /ACTIVE_RELEASE_PATH: Final = RUNTIME_STATE_ROOT \/ "active-release\.env"/.test(
      recoveryEvidenceHelper,
    ) &&
    /def managed_inventory_path\(active: ActiveRelease\)/.test(recoveryEvidenceHelper) &&
    /f"managed-containers\.\{active\.managed_inventory_sha256\}\.tsv"/.test(recoveryEvidenceHelper) &&
    /def application_image_record_path\(active: ActiveRelease\)/.test(recoveryEvidenceHelper) &&
    /f"application-images\.\{active\.application_image_record_sha256\}\.json"/.test(
      recoveryEvidenceHelper,
    ),
  "successful releases must publish immutable hash-addressed runtime records before the sole active manifest commit marker",
);
if (recoveryEvidence && recoveryEvidenceHelper) {
  const combinedEvidenceSource = `${recoveryEvidence}\n${recoveryEvidenceHelper}`;
  expect(
    /EVIDENCE_ROOT: Final = PurePosixPath\("\/var\/lib\/learncoding\/recovery-evidence"\)/.test(
      recoveryEvidenceHelper,
    ) &&
      /readonly helper=\/opt\/learncoding\/infra\/ops\/recovery-evidence\.py/.test(recoveryEvidence) &&
      /exec \/usr\/bin\/env -i/.test(recoveryEvidence) &&
      /BACKUP_MARKER_PATH: Final = Path\("\/mnt\/learncoding-backups\/state\/local-last-success\.env"\)/.test(
        recoveryEvidenceHelper,
      ) &&
      /parse_smart_summary/.test(recoveryEvidenceHelper) &&
      /parse_managed_inventory/.test(recoveryEvidenceHelper) &&
      !/RECOVERY_EVIDENCE_TEST_ROOT/.test(combinedEvidenceSource) &&
      !/\/var\/lib\/learncoding-runner|RUNNER_STATE_ROOT|journalctl[^\n]*learncoding-runner/i.test(
        combinedEvidenceSource,
      ) &&
      !/\/etc\/learncoding\/secrets|\/secrets\/|runner_shared_secret|RUNNER_[A-Z0-9_]*SECRET/i.test(
        combinedEvidenceSource,
      ),
    "recovery evidence must use fixed protected inputs, exact managed inventory, and privacy-safe SMART without test-root, runner-state, journal, or secret access",
  );
  expect(
    /RECOVERY_TARGET_SECONDS: Final = 900/.test(recoveryEvidenceHelper) &&
      /def validate_post_recovery_timing\(/.test(recoveryEvidenceHelper) &&
      /operatorObservedPowerRestoredAtUtc/.test(recoveryEvidenceHelper) &&
      /operatorObservedPublicReadyAtUtc/.test(recoveryEvidenceHelper) &&
      /publicReadinessSecondsFromPowerRestoration/.test(recoveryEvidenceHelper) &&
      /collectorVerifiedPhysicalPowerCycle": False/.test(recoveryEvidenceHelper) &&
      /uptime_at_capture_seconds=uptime_seconds \+ elapsed/.test(recoveryEvidenceHelper) &&
      /phase == "post"/.test(recoveryEvidenceHelper) &&
      /len\(sys\.argv\) != 5/.test(recoveryEvidenceHelper) &&
      /post ABSOLUTE_EVENT_JSON_PATH POWER_RESTORED_UTC PUBLIC_READY_UTC/.test(
        recoveryEvidence,
      ) &&
      /power_restored_at_utc=sys\.argv\[3\]/.test(recoveryEvidenceHelper) &&
      /public_ready_at_utc=sys\.argv\[4\]/.test(recoveryEvidenceHelper),
    "post recovery evidence must bind both manual UTC observations, reject clock-inconsistent or late recovery, and preserve the physical-verification boundary",
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
  hasSingleShellAssignment(runnerEnv, "RUNNER_HOST", "192.168.122.12") &&
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
  "infra/systemd/learncoding-restore-drill-reminder.service",
  "infra/systemd/learncoding-restore-drill-reminder.timer",
]) read(required);

expect(/compose\.yaml ps --all/.test(monitoringRunbook), "monitoring must include one-shot services in Compose status checks");
expect(
  /exactly eleven long-running services[^\n]*must be `running`/i.test(monitoringRunbook) &&
    /file-erasure-worker/i.test(monitoringRunbook),
  "monitoring must describe all eleven running pilot services including durable erasure",
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

const executableManifestRelative = "infra/release/production-executable-entrypoints.json";
const executableManifestRaw = read(executableManifestRelative);
let productionExecutables = [];
try {
  const manifest = JSON.parse(executableManifestRaw);
  productionExecutables = manifest.requiredExecutables ?? [];
  expect(manifest.schemaVersion === 1, "production executable manifest must use schema version 1");
  expect(Array.isArray(productionExecutables), "production executable manifest must contain requiredExecutables");
} catch {
  failures.push("production executable manifest must be valid JSON");
}

if (Array.isArray(productionExecutables)) {
  const uniqueProductionExecutables = new Set(productionExecutables);
  expect(
    uniqueProductionExecutables.size === productionExecutables.length,
    "production executable manifest must not contain duplicate paths",
  );
  expect(
    productionExecutables.every(
      (relative) =>
        typeof relative === "string" &&
        relative.length > 0 &&
        relative === relative.replaceAll("\\", "/") &&
        !path.isAbsolute(relative) &&
        !relative.split("/").includes(".."),
    ),
    "production executable manifest paths must be normalized workspace-relative paths",
  );
  expect(
    productionExecutables.every((relative, index) => index === 0 || productionExecutables[index - 1] < relative),
    "production executable manifest paths must be sorted",
  );

  const fixturePath = "infra/ops/example-entrypoint.sh";
  expect(
    validateProductionExecutableModes({
      requiredPaths: [fixturePath],
      indexModes: new Map([[fixturePath, "100755"]]),
      worktreeRegularFiles: new Set([fixturePath]),
    }).length === 0,
    "production executable mode validator must accept a tracked 100755 regular file",
  );
  expect(
    validateProductionExecutableModes({
      requiredPaths: [fixturePath],
      indexModes: new Map(),
      worktreeRegularFiles: new Set([fixturePath]),
    }).some((failure) => /not tracked in the Git index/u.test(failure)),
    "production executable mode validator must reject untracked entrypoints",
  );
  expect(
    validateProductionExecutableModes({
      requiredPaths: [fixturePath],
      indexModes: new Map([[fixturePath, "100755"]]),
      worktreeRegularFiles: new Set(),
    }).some((failure) => /missing or not a regular file/u.test(failure)),
    "production executable mode validator must reject missing entrypoints",
  );
  expect(
    validateProductionExecutableModes({
      requiredPaths: [fixturePath],
      indexModes: new Map([[fixturePath, "100644"]]),
      worktreeRegularFiles: new Set([fixturePath]),
    }).some((failure) => /expected 100755/u.test(failure)),
    "production executable mode validator must reject non-executable Git index modes",
  );

  if (productionExecutables.length > 0) {
    let indexModes = new Map();
    try {
      const indexOutput = execFileSync(
        "git",
        ["-C", root, "ls-files", "--stage", "-z", "--", ...productionExecutables],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      );
      indexModes = parseGitIndexModes(indexOutput);
    } catch {
      failures.push("production executable Git index metadata could not be read safely");
    }

    const worktreeRegularFiles = new Set(
      productionExecutables.filter((relative) => {
        const candidate = path.join(root, relative);
        try {
          const stat = fs.lstatSync(candidate);
          return stat.isFile() && !stat.isSymbolicLink();
        } catch {
          return false;
        }
      }),
    );
    failures.push(
      ...validateProductionExecutableModes({
        requiredPaths: productionExecutables,
        indexModes,
        worktreeRegularFiles,
      }),
    );
  }
}

const powerLossRecoveryRunbook = read("docs/runbooks/power-loss-recovery.md");
const runnerRolloutPlan = read("docs/superpowers/plans/2026-07-14-runner-nuc-rollout.md");
const productionDeploymentDesign = read(
  "docs/superpowers/specs/2026-07-14-nuc-production-deployment-design.md",
);
const firewallNetworkRunbook = read("docs/runbooks/firewall-and-network.md");
const baselineCaptureIndex = deploymentGuide.indexOf(
  "sudo /usr/bin/python3 -B /opt/learncoding/infra/ops/capture-existing-containers.py",
);
const recoveryEnableCheckIndex = deploymentGuide.indexOf(
  "sudo systemctl is-enabled --quiet learncoding-recovery-check.timer",
);

expect(
  /Documentation=\/opt\/learncoding\/docs\/runbooks\/power-loss-recovery\.md/.test(recoveryService) &&
    /# Power-loss recovery runbook/.test(powerLossRecoveryRunbook) &&
    /\/etc\/learncoding\/existing-containers\.txt/.test(powerLossRecoveryRunbook) &&
    /virsh --connect qemu:\/\/\/system net-info default/.test(powerLossRecoveryRunbook) &&
    /virsh --connect qemu:\/\/\/system dominfo codestead-runner/.test(powerLossRecoveryRunbook) &&
    /192\.168\.122\.12/.test(powerLossRecoveryRunbook) &&
    /capture-recovery-evidence\.sh pre/.test(powerLossRecoveryRunbook) &&
    /capture-recovery-evidence\.sh post/.test(powerLossRecoveryRunbook) &&
    /check-recovery\.sh/.test(powerLossRecoveryRunbook),
  "power-loss recovery service must reference a complete operator runbook for baseline, default-network, checks, and evidence",
);
expect(
  /EXT-PHYSICAL-AC-LOSS = NOT_RUN/.test(powerLossRecoveryRunbook) &&
    /### Reviewed two-request hold controller/.test(powerLossRecoveryRunbook) &&
    /runner-power-rehearsal-control\.sh arm/.test(powerLossRecoveryRunbook) &&
    /runner-power-rehearsal-control\.sh status/.test(powerLossRecoveryRunbook) &&
    /runner-power-rehearsal-control\.sh (?:release|abort)/.test(powerLossRecoveryRunbook) &&
    /learner_draft_mutation/.test(powerLossRecoveryRunbook) &&
    /reward_ledger/.test(powerLossRecoveryRunbook) &&
    /audit_event/.test(powerLossRecoveryRunbook) &&
    /email_outbox/.test(powerLossRecoveryRunbook) &&
    /code_submission/.test(powerLossRecoveryRunbook) &&
    /runner_job/.test(powerLossRecoveryRunbook) &&
    /notification_preferences\.updated/.test(powerLossRecoveryRunbook) &&
    /reset-password/.test(powerLossRecoveryRunbook) &&
    /codestead-browser-outbox-v1/.test(powerLossRecoveryRunbook) &&
    /object store `entries`/.test(powerLossRecoveryRunbook) &&
    /requestId/.test(powerLossRecoveryRunbook) &&
    /clientMutationId/.test(powerLossRecoveryRunbook) &&
    /Saved locally on this browser\. Codestead will retry automatically\./.test(
      powerLossRecoveryRunbook,
    ) &&
    /exact original body and `idempotencyKey`/.test(powerLossRecoveryRunbook) &&
    /require zero lesson\/exam records/.test(
      powerLossRecoveryRunbook,
    ) &&
    /Saved locally; Codestead will retry\./.test(powerLossRecoveryRunbook) &&
    /Close every window.*reopen the same persistent profile/.test(powerLossRecoveryRunbook) &&
    /public `\/health\/ready` endpoint/.test(powerLossRecoveryRunbook) &&
    /Reconciliation must finish first\./.test(powerLossRecoveryRunbook) &&
    /systemctl start learncoding-backup\.service/.test(powerLossRecoveryRunbook) &&
    /"\$power_restored_utc"/.test(powerLossRecoveryRunbook) &&
    /"\$public_ready_utc"/.test(powerLossRecoveryRunbook) &&
    /collectorVerifiedPhysicalPowerCycle: false/.test(powerLossRecoveryRunbook) &&
    /capture-recovery-evidence\.sh post[\s\S]*?"\$power_restored_utc"[\s\S]*?"\$public_ready_utc"/.test(
      deploymentGuide,
    ),
  "physical AC-loss instructions must create every truthful marker, prove browser reopen and exact reconciliation, take the immediate backup, and pass both observed UTC values",
);
expect(
  /libvirt `default` network/.test(runnerIsolationGuide) &&
    /bridge `virbr0`/.test(runnerIsolationGuide) &&
    /192\.168\.122\.12/.test(runnerIsolationGuide) &&
    !/10\.20\.0\.12|10\.20\.0\.0\/24|virbr-cdst|network=codestead-runner/.test(runnerIsolationGuide),
  "runner-isolation guide must name only the canonical default/virbr0/192.168.122.12 network",
);
expect(
  /libvirt `default` network/.test(runnerRolloutPlan) &&
    /bridge `virbr0`/.test(runnerRolloutPlan) &&
    /192\.168\.122\.12/.test(runnerRolloutPlan) &&
    !/10\.20\.0\.12|10\.20\.0\.0\/24|10\.20\.0\.1|virbr-cdst|network=codestead-runner|grep -Fq 'net-define'|default\/dedicated network/.test(
      runnerRolloutPlan,
    ),
  "runner rollout instructions must not retain the superseded custom-network topology",
);
expect(
  /internal runner-client.*secretless `runner-egress-gateway`.*`runner-egress`.*runner VM/s.test(
    deploymentGuide,
  ) &&
    /deployment-level `RUNNER_BASE_URL`.*private runner VM upstream/s.test(deploymentGuide) &&
    /effective container `RUNNER_BASE_URL`.*`http:\/\/runner-egress-gateway:4100`/s.test(
      deploymentGuide,
    ) &&
    /eleven managed Compose container\/image identities/.test(deploymentGuide) &&
    !/workers also join `runner-egress`/.test(deploymentGuide) &&
    !/app's `RUNNER_BASE_URL` must be a private RFC 1918 address/.test(deploymentGuide),
  "deployment guide must document the secretless runner gateway, distinguish deployment and container URLs, and count all eleven managed services",
);
expect(
  /effective container `RUNNER_BASE_URL`.*`http:\/\/runner-egress-gateway:4100`/s.test(
    productionDeploymentDesign,
  ) &&
    /deployment-level `RUNNER_BASE_URL`.*private runner VM upstream/s.test(
      productionDeploymentDesign,
    ) &&
    !/app uses the stable private guest address as `RUNNER_BASE_URL`/.test(
      productionDeploymentDesign,
    ) &&
    /secretless `runner-egress-gateway`/.test(runnerRolloutPlan) &&
    !/Join only app and runner-consuming workers to it/.test(runnerRolloutPlan) &&
    /update the deployment-level `RUNNER_BASE_URL`/.test(runnerIsolationGuide) &&
    /gateway's private upstream/.test(runnerIsolationGuide) &&
    !/change the app to the new private runner address/.test(runnerIsolationGuide),
  "runner design, rollout, and incident guidance must preserve the internal-client to secretless-gateway boundary",
);
expect(
  /libvirt `default` network/.test(firewallNetworkRunbook) &&
    /bridge `virbr0`/.test(firewallNetworkRunbook) &&
    /192\.168\.122\.12/.test(firewallNetworkRunbook) &&
    /172\.29\.40\.2/.test(firewallNetworkRunbook) &&
    /learncoding-runner-guest-firewall\.service/.test(firewallNetworkRunbook) &&
    !/10\.20\.0\.11|10\.20\.0\.12|virbr-cdst|network=codestead-runner/.test(firewallNetworkRunbook),
  "firewall runbook must use the reviewed host/guest nftables path and canonical runner addresses",
);
expect(
  baselineCaptureIndex >= 0 &&
    recoveryEnableCheckIndex > baselineCaptureIndex &&
    /capture-existing-containers\.py[\s\S]*?--replace/.test(deploymentGuide) &&
    /immutable Docker image ID/.test(deploymentGuide) &&
    /SHA-256 fingerprint/.test(deploymentGuide) &&
    /Raw environment values[\s\S]*?never written to the baseline/.test(deploymentGuide) &&
    /sudo test -s \/etc\/learncoding\/existing-containers\.txt/.test(deploymentGuide),
  "deployment must atomically capture a secret-free identity-bound existing-container baseline before recovery checks",
);

if (failures.length > 0) {
  console.error("Static deployment validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Static deployment validation passed (trusted stack, runner boundary, backups, and runbooks). ");
