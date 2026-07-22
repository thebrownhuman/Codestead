import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const paths = Object.freeze({
  control: "infra/systemd/learncoding-production-load-control.service",
  testControl: "infra/systemd/learncoding-production-load-test-control.service",
  gate: "infra/systemd/learncoding-production-load-gate.service",
  recovery: "infra/systemd/learncoding-production-load-recovery.path",
  recoveryService: "infra/systemd/learncoding-production-load-recovery.service",
  sysusers: "infra/sysusers.d/learncoding-production-load.conf",
  tmpfiles: "infra/tmpfiles.d/learncoding-production-load.conf",
  environment: "infra/env/production-load.env.example",
  installer: "infra/ops/install-systemd.sh",
  hostRuntime: "infra/ops/validate-production-load-host-runtime.sh",
  testControlRuntime: "infra/ops/validate-production-load-test-control-runtime.sh",
  runbook: "docs/runbooks/load-testing.md",
});

function directives(source) {
  assert.doesNotMatch(source, /\r|[ \t]+$/m);
  const parsed = [];
  let section = "";
  for (const line of source.split("\n")) {
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    const assignment = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line);
    assert.ok(assignment && section, `non-canonical systemd line: ${line}`);
    parsed.push({ section, key: assignment[1], value: assignment[2] });
  }
  return parsed;
}

function values(source, section, key) {
  return directives(source)
    .filter((entry) => entry.section === section && entry.key === key)
    .map((entry) => entry.value);
}

function exact(source, section, key, value) {
  assert.deepEqual(values(source, section, key), [value], `${section}.${key}`);
}

test("root load-control daemon has a fixed, credential-backed, bounded contract", () => {
  const source = read(paths.control);
  exact(source, "Service", "User", "root");
  exact(source, "Service", "Group", "learncoding-load-gate");
  exact(source, "Unit", "Requires", "learncoding-compose.service learncoding-production-load-test-control.service");
  exact(source, "Unit", "StopWhenUnneeded", "yes");
  exact(source, "Unit", "RefuseManualStart", "yes");
  exact(source, "Service", "WorkingDirectory", "/opt/learncoding");
  exact(source, "Unit", "ConditionFileIsExecutable", "/usr/bin/node");
  exact(source, "Unit", "AssertPathExists", "/opt/learncoding/node_modules/tsx/package.json");
  assert.deepEqual(values(source, "Service", "ExecStartPre"), [
    "/usr/bin/bash /opt/learncoding/infra/ops/validate-production-load-host-runtime.sh",
    "/usr/bin/test -f /etc/learncoding/production-load-manifest.json",
  ]);
  exact(source, "Service", "ExecStart", "/usr/bin/node --import tsx /opt/learncoding/scripts/start-production-load-control-service.ts");
  exact(source, "Service", "EnvironmentFile", "/etc/learncoding/production-load.env");
  assert.deepEqual(values(source, "Service", "LoadCredential"), [
    "database_url:/etc/learncoding/secrets/database_url",
    "better_auth_secret:/etc/learncoding/secrets/better_auth_secret",
  ]);
  assert.deepEqual(values(source, "Service", "Environment"), [
    "NODE_ENV=production",
    "LOAD_MODE=production",
    "LOAD_ALLOW_REMOTE=1",
    "LOAD_SCOPE=codestead-project-only",
    "LOAD_PROJECT=learncoding",
    "LOAD_DISPOSABLE_FAULTS_CONFIRMED=1",
    "LOAD_EVIDENCE_ROOT=/var/lib/learncoding-production-load-evidence",
    "LOAD_CONTROL_SOCKET=/run/learncoding/load-control.sock",
    "LOAD_ACTIVE_RELEASE_PATH=/etc/learncoding/active-release.env",
    "LOAD_JOURNAL_ROOT=/var/lib/learncoding-production-load",
    "LOAD_MANIFEST_PATH=/etc/learncoding/production-load-manifest.json",
  ]);
  exact(source, "Service", "Restart", "on-failure");
  exact(source, "Service", "RuntimeMaxSec", "5h30m");
  exact(source, "Service", "TimeoutStopSec", "2min");
  exact(source, "Service", "LimitCORE", "0");
  exact(source, "Service", "UMask", "0077");
  exact(source, "Service", "ProtectSystem", "strict");
  exact(source, "Service", "ReadWritePaths", "/run/learncoding /var/lib/learncoding-production-load");
  assert.deepEqual(values(source, "Install", "WantedBy"), []);
});

test("test-control daemon is a distinct root-private dependency with no application credentials", () => {
  const source = read(paths.testControl);
  exact(source, "Unit", "Requires", "learncoding-compose.service learncoding-production-load-fixture-runtime.service");
  exact(source, "Unit", "StopWhenUnneeded", "yes");
  exact(source, "Unit", "RefuseManualStart", "yes");
  exact(source, "Service", "User", "root");
  exact(source, "Service", "Group", "root");
  exact(source, "Service", "SupplementaryGroups", "learncoding-load-gate");
  exact(source, "Service", "WorkingDirectory", "/opt/learncoding");
  assert.deepEqual(values(source, "Unit", "ConditionFileIsExecutable"), [
    "/usr/bin/node",
    "/usr/bin/python3.12",
  ]);
  assert.deepEqual(values(source, "Unit", "AssertPathExists"), [
    "/opt/learncoding/infra/runtime/production-load-test-control-service.mjs",
    "/opt/learncoding/infra/ops/production-load-peer-credentials.py",
  ]);
  assert.deepEqual(values(source, "Service", "ExecStartPre"), [
    "/usr/bin/bash /opt/learncoding/infra/ops/validate-production-load-host-runtime.sh",
    "/usr/bin/bash /opt/learncoding/infra/ops/validate-production-load-test-control-runtime.sh",
    "/usr/bin/test -f /etc/learncoding/production-load-manifest.json",
  ]);
  exact(source, "Service", "ExecStart", "/usr/bin/node /opt/learncoding/infra/runtime/production-load-test-control-service.mjs");
  exact(source, "Service", "EnvironmentFile", "/etc/learncoding/production-load.env");
  assert.deepEqual(values(source, "Service", "LoadCredential"), []);
  exact(source, "Service", "Restart", "on-failure");
  exact(source, "Service", "RuntimeMaxSec", "5h30m");
  exact(source, "Service", "TimeoutStopSec", "2min");
  exact(source, "Service", "LimitCORE", "0");
  exact(source, "Service", "UMask", "0077");
  exact(source, "Service", "ProtectSystem", "strict");
  exact(source, "Service", "RestrictAddressFamilies", "AF_UNIX");
  exact(source, "Service", "ReadWritePaths", "/run/learncoding /run/learncoding-production-load-fixtures");
  exact(source, "Service", "InaccessiblePaths", "-/etc/learncoding/secrets -/var/lib/learncoding-production-load -/run/docker.sock -/run/libvirt -/dev/kvm");
  assert.deepEqual(values(source, "Install", "WantedBy"), []);
});

test("manual gate runs only as the non-login client with no secret or host-control access", () => {
  const source = read(paths.gate);
  exact(source, "Service", "Type", "exec");
  exact(source, "Service", "User", "learncoding-load-gate");
  exact(source, "Service", "Group", "learncoding-load-gate");
  exact(source, "Unit", "Requires", "learncoding-production-load-control.service");
  exact(source, "Unit", "ConditionFileIsExecutable", "/usr/bin/node");
  exact(source, "Unit", "AssertPathExists", "/opt/learncoding/node_modules/tsx/package.json");
  exact(source, "Service", "ExecStartPre", "/usr/bin/bash /opt/learncoding/infra/ops/validate-production-load-host-runtime.sh");
  exact(source, "Service", "EnvironmentFile", "/etc/learncoding/production-load.env");
  assert.deepEqual(values(source, "Service", "Environment"), [
    "LOAD_MODE=production",
    "LOAD_ALLOW_REMOTE=1",
    "LOAD_SCOPE=codestead-project-only",
    "LOAD_PROJECT=learncoding",
    "LOAD_DISPOSABLE_FAULTS_CONFIRMED=1",
    "LOAD_EVIDENCE_ROOT=/var/lib/learncoding-production-load-evidence",
    "LOAD_ACTIVE_RELEASE_PATH=/etc/learncoding/active-release.env",
    "LOAD_CONTROL_SOCKET=/run/learncoding/load-control.sock",
  ]);
  exact(source, "Service", "ExecStart", "/usr/bin/node --import tsx /opt/learncoding/scripts/load-smoke.ts");
  exact(source, "Service", "RuntimeMaxSec", "5h");
  exact(source, "Service", "Restart", "no");
  exact(source, "Service", "CapabilityBoundingSet", "");
  exact(source, "Service", "NoNewPrivileges", "yes");
  exact(source, "Service", "ProtectSystem", "strict");
  exact(source, "Service", "ReadWritePaths", "/var/lib/learncoding-production-load-evidence");
  exact(source, "Service", "InaccessiblePaths", "-/etc/learncoding/secrets -/var/lib/learncoding-production-load -/run/docker.sock -/run/libvirt -/dev/kvm");
  assert.deepEqual(values(source, "Service", "LoadCredential"), []);
  assert.deepEqual(values(source, "Install", "WantedBy"), []);
});

test("boot recovery watches only the exact active fault journal", () => {
  const source = read(paths.recovery);
  exact(source, "Path", "PathExists", "/var/lib/learncoding-production-load/production-load-fault-journal.json");
  exact(source, "Path", "Unit", "learncoding-production-load-recovery.service");
  exact(source, "Path", "MakeDirectory", "false");
  exact(source, "Install", "WantedBy", "multi-user.target");
  assert.deepEqual(values(source, "Path", "DirectoryNotEmpty"), []);
  assert.deepEqual(values(source, "Timer", "Persistent"), []);
});

test("recovery service resets one journal-bound fault without opening the control socket", () => {
  const source = read(paths.recoveryService);
  exact(source, "Service", "Type", "exec");
  exact(source, "Service", "User", "root");
  exact(source, "Service", "Group", "root");
  exact(source, "Unit", "RefuseManualStart", "yes");
  exact(source, "Unit", "Requires", "learncoding-compose.service");
  exact(source, "Unit", "RequiresMountsFor", "/opt/learncoding /etc/learncoding /var/lib/learncoding-production-load /var/lib/learncoding-production-load-evidence");
  exact(source, "Unit", "ConditionFileIsExecutable", "/usr/bin/node");
  exact(source, "Unit", "AssertPathExists", "/opt/learncoding/node_modules/tsx/package.json");
  assert.deepEqual(values(source, "Service", "LoadCredential"), []);
  assert.deepEqual(values(source, "Service", "ExecStartPre"), [
    "/usr/bin/bash /opt/learncoding/infra/ops/validate-production-load-host-runtime.sh",
    "/usr/bin/test -f /etc/learncoding/production-load-manifest.json",
    "/usr/bin/test -f /var/lib/learncoding-production-load/production-load-fault-journal.json",
  ]);
  exact(source, "Service", "ExecStart", "/usr/bin/node --import tsx /opt/learncoding/scripts/start-production-load-control-service.ts --recover-only");
  exact(source, "Service", "EnvironmentFile", "/etc/learncoding/production-load.env");
  assert.deepEqual(values(source, "Service", "Environment"), [
    "NODE_ENV=production",
    "LOAD_MODE=production",
    "LOAD_ALLOW_REMOTE=1",
    "LOAD_SCOPE=codestead-project-only",
    "LOAD_PROJECT=learncoding",
    "LOAD_DISPOSABLE_FAULTS_CONFIRMED=1",
    "LOAD_EVIDENCE_ROOT=/var/lib/learncoding-production-load-evidence",
    "LOAD_CONTROL_SOCKET=/run/learncoding/load-control.sock",
    "LOAD_ACTIVE_RELEASE_PATH=/etc/learncoding/active-release.env",
    "LOAD_JOURNAL_ROOT=/var/lib/learncoding-production-load",
    "LOAD_MANIFEST_PATH=/etc/learncoding/production-load-manifest.json",
  ]);
  assert.doesNotMatch(source, /LOAD_RECOVERY_ONLY|RuntimeDirectory=|ListenStream=|SocketMode=/);
  exact(source, "Service", "RuntimeMaxSec", "10min");
  assert.deepEqual(values(source, "Install", "WantedBy"), []);
});

test("sysusers and tmpfiles establish the least-privilege filesystem boundary", () => {
  const sysusers = read(paths.sysusers).trim().split(/\r?\n/).filter((line) => !line.startsWith("#"));
  assert.deepEqual(sysusers, [
    "u learncoding-load-gate - \"Codestead production load gate client\" /nonexistent /usr/sbin/nologin",
    "u learncoding-load-fixture 65532 \"Codestead production load fixture\" /nonexistent /usr/sbin/nologin",
  ]);
  const tmpfiles = read(paths.tmpfiles).trim().split(/\r?\n/).filter((line) => !line.startsWith("#"));
  assert.deepEqual(tmpfiles, [
    "d /run/learncoding 0750 root learncoding-load-gate -",
    "d /run/learncoding-production-load-fixtures 0700 65532 65532 -",
    "d /var/lib/learncoding-production-load 0700 root root -",
    "d /var/lib/learncoding-production-load-evidence 0700 learncoding-load-gate learncoding-load-gate -",
  ]);
});

test("operator environment example contains only the three dynamic non-secret identities", () => {
  const source = read(paths.environment);
  assert.doesNotMatch(source, /(?:SECRET|TOKEN|PASSWORD|DATABASE_URL|COOKIE|KEY)=/i);
  const names = source.split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.slice(0, line.indexOf("=")));
  assert.deepEqual(names, ["LOAD_BASE_URL", "LOAD_NUC_HOST_ID", "LOAD_RUNNER_VM_ID"]);
});

test("host runtime validator pins the fixed Node floor and reviewed tsx package", () => {
  const source = read(paths.hostRuntime);
  assert.match(source, /^#!\/usr\/bin\/bash$/m);
  assert.match(source, /readonly node_bin=\/usr\/bin\/node/);
  assert.match(source, /minimum_node_version=22\.22\.0/);
  assert.match(source, /readonly tsx_manifest=\/opt\/learncoding\/node_modules\/tsx\/package\.json/);
  assert.match(source, /expected_tsx_version=4\.23\.0/);
  assert.match(source, /stat -Lc/);
  assert.doesNotMatch(source, /NODE_OPTIONS|npm_config|eval|source /);
});

test("installer publishes identities and directories but enables only journal recovery", () => {
  const source = read(paths.installer);
  assert.match(source, /validate-production-load-host-runtime\.sh/);
  assert.match(source, /infra\/sysusers\.d\/\*/);
  assert.match(source, /\/etc\/sysusers\.d\/\$\(basename -- "\$definition"\)/);
  assert.match(source, /systemd-sysusers \/etc\/sysusers\.d\/learncoding-production-load\.conf/);
  assert.match(source, /infra\/tmpfiles\.d\/\*/);
  assert.match(source, /\/etc\/tmpfiles\.d\/\$\(basename -- "\$definition"\)/);
  assert.match(source, /systemd-tmpfiles --create \/etc\/tmpfiles\.d\/learncoding-production-load\.conf/);
  assert.match(source, /systemctl enable --now learncoding-production-load-recovery\.path/);
  assert.doesNotMatch(source, /systemctl enable --now learncoding-production-load-(?:control|gate)\.service/);
});

test("operator runbook names the root-private fixture boundary and its honest release blocker", () => {
  const source = read(paths.runbook);
  assert.match(source, /codestead-production-load-test-control\.sock/);
  assert.match(source, /mode `0600`/);
  assert.match(source, /learncoding-production-load-test-control\.service/);
  assert.match(source, /learncoding-production-load-fixture-runtime\.service/);
  assert.match(source, /ten distinct authenticated synthetic learner sessions/);
  assert.match(source, /measured two-slot runner queue/);
  assert.match(source, /all seven disposable fault lifecycles/);
  assert.match(source, /does \*\*not\*\* replace physical NUC evidence/);
});

test("test-control runtime is a single release-bound immutable bundle", () => {
  const source = read(paths.testControlRuntime);
  assert.match(source, /^#!\/usr\/bin\/bash$/m);
  assert.match(source, /runtime_bundle=\/opt\/learncoding\/infra\/runtime\/production-load-test-control-service\.mjs/);
  assert.match(source, /release_manifest=\/opt\/learncoding\/RELEASE\.SHA256SUMS/);
  assert.match(source, /active_release=\/etc\/learncoding\/active-release\.env/);
  assert.match(source, /RELEASE_MANIFEST_SHA256/);
  assert.match(source, /sha256sum/);
  assert.match(source, /unexpected hard-link count/);
  assert.doesNotMatch(source, /NODE_OPTIONS|npm_config|eval|source /);
});
