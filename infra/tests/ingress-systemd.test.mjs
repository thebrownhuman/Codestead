import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const compose = read("../../compose.yaml");
const stackUnit = read("../systemd/learncoding-compose.service");
const recoveryUnit = read("../systemd/learncoding-ingress-recovery.service");
const recoveryTimer = read("../systemd/learncoding-ingress-recovery.timer");
const tmpfiles = read("../tmpfiles.d/learncoding-ingress-control.conf");
const releaseLockTmpfiles = read("../tmpfiles.d/learncoding-release-lock.conf");
const installer = read("../ops/install-systemd.sh");
const start = read("../ops/start-production-stack.sh");
const recovery = read("../ops/recover-production-ingress.sh");
const recoveryDesign = read("../../docs/superpowers/specs/2026-07-20-ingress-quarantine-recovery-design.md");
const recoveryPlan = read("../../docs/superpowers/plans/2026-07-20-ingress-quarantine-recovery.md");

assert.match(compose, /cloudflared:[\s\S]*?restart: on-failure:5/u);
assert.doesNotMatch(compose.match(/cloudflared:[\s\S]*?(?=\nnetworks:)/u)?.[0] ?? "", /ports:/u);
assert.match(start, /up -d --no-build --pull never --no-deps cloudflared/u);
assert.doesNotMatch(start, /--test-harness-root.*status/u, "production control invocation must not carry the test seam");

const fixedPath = "/usr/bin/env PATH=/usr/sbin:/usr/bin:/sbin:/bin";
assert.match(stackUnit, new RegExp(`ExecStart=${fixedPath.replaceAll("/", "\\/")} \\/usr\\/bin\\/bash \\/opt\\/learncoding\\/infra\\/ops\\/start-production-stack\\.sh --startup-wait 600`, "u"));
assert.match(stackUnit, /ExecReload=.*start-production-stack\.sh --startup-wait 600/u);
assert.doesNotMatch(stackUnit, /ExecStartPre=|ExecStartPost=|docker compose.*up/u);
assert.match(recoveryUnit, /After=docker\.service/u);
assert.match(recoveryUnit, /EnvironmentFile=\/etc\/learncoding\/compose\.env/u);
assert.match(recoveryUnit, /ExecStart=.*recover-production-ingress\.sh/u);
assert.match(recoveryUnit, /TimeoutStartSec=90s/u);
assert.match(recoveryUnit, /OnFailure=learncoding-alert@%n\.service/u);
assert.match(recovery, /DOCKER_HOST=unix:\/\/\/var\/run\/docker\.sock/u);
assert.match(recovery, /unset DOCKER_CONTEXT[\s\S]*?COMPOSE_PROJECT_NAME/u);
assert.match(recovery, /compose=\("\$docker_bin" compose --project-name learncoding/u);
assert.match(recovery, /readonly recovery_attempt_budget_seconds=60/u);
assert.match(recovery, /readonly recovery_cleanup_budget_seconds=10/u);
assert.match(recovery, /recovery_attempt_budget_seconds \+ recovery_cleanup_budget_seconds < systemd_deadline_seconds/u);
assert.match(recovery, /"\$current" != "\$release_lock_parent" \|\| "\$mode" != 1777/u);
assert.match(recovery, /case "\$start_result" in[\s\S]*?75\)[\s\S]*?quarantine_required=false/u);
assert.match(recoveryDesign, /Internal containers retain `unless-stopped`; the tunnel alone uses `on-failure:5`/u);
assert.match(recoveryDesign, /forced worst-path timeout trace totaling exactly 60 seconds/u);
assert.match(recoveryPlan, /Docker authority to `unix:\/\/\/var\/run\/docker\.sock` and Compose project `learncoding`/u);
assert.match(recoveryPlan, /Never quarantine outside the release lock/u);
assert.match(recoveryTimer, /OnBootSec=1min/u);
assert.match(recoveryTimer, /OnUnitActiveSec=1min/u);
assert.match(recoveryTimer, /Persistent=true/u);
assert.equal(tmpfiles, "d /var/lib/learncoding/ingress-control 0700 root root - -\n");
assert.equal(releaseLockTmpfiles, "f /run/lock/codestead-release.lock 0600 root root - -\n");
assert.match(installer, /systemd-tmpfiles --create \/etc\/tmpfiles\.d\/learncoding-ingress-control\.conf/u);
assert.match(installer, /systemd-tmpfiles --create \/etc\/tmpfiles\.d\/learncoding-release-lock\.conf/u);
assert.ok(
  installer.indexOf("systemd-tmpfiles --create /etc/tmpfiles.d/learncoding-release-lock.conf") < installer.indexOf("for unit in"),
  "the shared release lock must be provisioned before systemd units are installed",
);
assert.match(installer, /systemctl enable --now learncoding-ingress-recovery\.timer/u);

console.log("ingress-systemd-tests-ok");
