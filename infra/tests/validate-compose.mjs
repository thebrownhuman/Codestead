import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");
const rendered = spawnSync(
  "docker",
  [
    "compose",
    "--env-file",
    path.join(root, "infra/env/compose.env.example"),
    "--profile",
    "operations",
    "-f",
    path.join(root, "compose.yaml"),
    "config",
    "--format",
    "json",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (rendered.error) throw rendered.error;
if (rendered.status !== 0) {
  process.stderr.write(rendered.stderr || rendered.stdout);
  process.exit(rendered.status ?? 1);
}

const config = JSON.parse(rendered.stdout);
const failures = [];
const expect = (condition, message) => {
  if (!condition) failures.push(message);
};
const keys = (value) => Object.keys(value ?? {}).sort();
const same = (actual, expected) =>
  JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());

const expectedServices = [
  "app",
  "clamav",
  "cloudflared",
  "exam-finalization-worker",
  "lifecycle",
  "mail-worker",
  "migrate",
  "postgres",
  "practice-runner-recovery-worker",
  "project-review-correction-worker",
  "regrade-worker",
  "scan-worker",
];
expect(config.name === "learncoding", "Compose project name must be learncoding");
expect(same(keys(config.services), expectedServices), "trusted Compose service inventory drifted");
expect(!Object.hasOwn(config.services, "runner"), "untrusted runner entered the trusted stack");

for (const [name, service] of Object.entries(config.services ?? {})) {
  expect(service.platform === "linux/amd64", `${name} must target linux/amd64`);
  expect(service.read_only === true, `${name} must use a read-only root filesystem`);
  expect(service.privileged !== true, `${name} must not be privileged`);
  expect(service.network_mode !== "host", `${name} must not use host networking`);
  expect(service.pid !== "host" && service.ipc !== "host", `${name} must not share host PID/IPC namespaces`);
  expect(!service.ports || service.ports.length === 0, `${name} must publish no host port`);
  expect(
    (service.security_opt ?? []).includes("no-new-privileges:true"),
    `${name} must set no-new-privileges`,
  );
  if (name !== "postgres") {
    expect((service.cap_drop ?? []).includes("ALL"), `${name} must drop all Linux capabilities`);
  }
  for (const volume of service.volumes ?? []) {
    expect(!String(volume.source ?? "").includes("docker.sock"), `${name} must not mount the Docker socket`);
    expect(volume.source !== "/", `${name} must not mount the host root`);
  }
}

const expectedNetworks = {
  postgres: ["data"],
  migrate: ["data"],
  app: ["data", "frontend"],
  "mail-worker": ["data", "mail-egress"],
  "regrade-worker": ["data", "runner-egress"],
  "exam-finalization-worker": ["data", "runner-egress"],
  "practice-runner-recovery-worker": ["data", "runner-egress"],
  "project-review-correction-worker": ["data", "github-egress"],
  clamav: ["scanner", "signature-egress"],
  "scan-worker": ["data", "scanner"],
  lifecycle: ["data"],
  cloudflared: ["frontend"],
};
for (const [name, networks] of Object.entries(expectedNetworks)) {
  expect(same(keys(config.services[name]?.networks), networks), `${name} network allowlist drifted`);
}
expect(config.networks?.data?.internal === true, "database network must be internal");
expect(config.networks?.scanner?.internal === true, "scanner network must be internal");
expect(
  same(config.services.clamav?.cap_add ?? [], ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"]),
  "ClamAV capability exception drifted",
);
expect(same(config.services.lifecycle?.profiles ?? [], ["operations"]), "lifecycle must remain opt-in");
expect(config.services.lifecycle?.build?.target === "worker", "lifecycle must use the operations-capable worker target");
expect(
  config.services.lifecycle?.image === "learncoding-app:local-worker",
  "lifecycle must reuse the hardened worker image",
);

const appSecretSources = (config.services.app?.secrets ?? []).map((secret) => secret.source);
expect(appSecretSources.includes("deletion_tombstone_key"), "app must receive deletion_tombstone_key as a file secret");
expect(appSecretSources.includes("credential_master_key"), "app must receive credential_master_key as a file secret");
expect(appSecretSources.includes("runner_shared_secret"), "app must receive runner_shared_secret as a file secret");
expect(
  config.services.app?.environment?.RUNNER_MAX_CONCURRENCY === "2",
  "trusted app and runner must agree on concurrency two",
);

const scannerStorage = (config.services["scan-worker"]?.volumes ?? []).find(
  (volume) => volume.target === "/var/lib/learncoding",
);
expect(scannerStorage?.read_only === true, "scan worker must receive object storage read-only");
expect(
  config.services["regrade-worker"]?.build?.target === "regrade-worker",
  "regrade worker must use its dedicated image target",
);
expect(
  config.services["exam-finalization-worker"]?.build?.target === "regrade-worker",
  "exam-finalization worker must use the hardened regrade-worker image target",
);
expect(
  config.services["practice-runner-recovery-worker"]?.build?.target === "regrade-worker",
  "practice recovery worker must use the hardened regrade-worker image target",
);
expect(
  config.services["project-review-correction-worker"]?.build?.target === "project-review-correction-worker",
  "project-review correction worker must use its dedicated image target",
);
expect(
  config.services.cloudflared?.configs?.some(
    (entry) => entry.target === "/etc/cloudflared/config.yml" && entry.mode === "0444",
  ),
  "Cloudflare config must be mounted read-only",
);

if (failures.length > 0) {
  console.error("Semantic Compose validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Semantic Compose validation passed (service, network, capability, mount, and secret allowlists).");
