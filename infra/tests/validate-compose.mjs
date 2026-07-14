import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "../..");
const envFile = path.join(root, "infra/env/compose.env.example");
const composeFile = path.join(root, "compose.yaml");
const failures = [];

const expect = (condition, message) => {
  if (!condition) failures.push(message);
};
const keys = (value) => Object.keys(value ?? {}).sort();
const same = (actual, expected) =>
  JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
const orderedSame = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);

const pilotServices = [
  "app",
  "cloudflared",
  "exam-finalization-worker",
  "mail-worker",
  "migrate",
  "postgres",
  "practice-runner-recovery-worker",
  "project-review-correction-worker",
  "regrade-worker",
  "reward-worker",
];
const operationServices = ["admin-bootstrap", "lifecycle", "platform-seed"];
const uploadServices = ["clamav", "scan-worker"];

const applicationImages = {
  APP_RUNTIME_IMAGE: `ghcr.io/thebrownhuman/compose-validator-runtime@sha256:${"1".repeat(64)}`,
  APP_TOOLING_IMAGE: `ghcr.io/thebrownhuman/compose-validator-tooling@sha256:${"2".repeat(64)}`,
  APP_WORKER_IMAGE: `ghcr.io/thebrownhuman/compose-validator-worker@sha256:${"3".repeat(64)}`,
  APP_REGRADE_WORKER_IMAGE: `ghcr.io/thebrownhuman/compose-validator-regrade@sha256:${"4".repeat(64)}`,
  APP_PROJECT_REVIEW_WORKER_IMAGE: `ghcr.io/thebrownhuman/compose-validator-project-review@sha256:${"5".repeat(64)}`,
  APP_SCANNER_WORKER_IMAGE: `ghcr.io/thebrownhuman/compose-validator-scanner@sha256:${"6".repeat(64)}`,
  APP_OPERATIONS_IMAGE: `ghcr.io/thebrownhuman/compose-validator-operations@sha256:${"7".repeat(64)}`,
};
const clamavImage = `clamav/clamav:compose-validator@sha256:${"8".repeat(64)}`;

function render(name, profiles, { allowFailure = false, environment = {} } = {}) {
  const profileArguments = profiles.flatMap((profile) => ["--profile", profile]);
  const rendered = spawnSync(
    "docker",
    [
      "compose",
      "--env-file",
      envFile,
      "-f",
      composeFile,
      ...profileArguments,
      "config",
      "--format",
      "json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        ...applicationImages,
        APP_NAME: "Compose Validator",
        APP_URL: "https://compose-validator.example",
        BOOTSTRAP_ADMIN_EMAIL: "admin@compose-validator.example",
        CLAMAV_IMAGE: clamavImage,
        COMPOSE_PROFILES: "",
        UPLOADS_ENABLED: profiles.includes("uploads") ? "true" : "false",
        ...environment,
      },
    },
  );
  if (rendered.error) throw rendered.error;
  if (rendered.status !== 0) {
    const details = (rendered.stderr || rendered.stdout).trim();
    if (allowFailure) {
      failures.push(`${name} Compose render failed: ${details}`);
      return null;
    }
    process.stderr.write(`${name} Compose render failed:\n${details}\n`);
    process.exit(rendered.status ?? 1);
  }
  return JSON.parse(rendered.stdout);
}

const models = {
  pilot: render("pilot", [], { environment: { CLAMAV_IMAGE: "" } }),
  operations: render("operations", ["operations"]),
  uploads: render("uploads", ["uploads"]),
  combined: render("combined", ["operations", "uploads"]),
};
const inactiveClamav = render("inactive ClamAV fallback", ["uploads"], {
  allowFailure: true,
  environment: { CLAMAV_IMAGE: "" },
});

const expectedInventories = {
  pilot: pilotServices,
  operations: [...pilotServices, ...operationServices],
  uploads: [...pilotServices, ...uploadServices],
  combined: [...pilotServices, ...operationServices, ...uploadServices],
};
for (const [modelName, config] of Object.entries(models)) {
  expect(config.name === "learncoding", `${modelName} Compose project name must be learncoding`);
  expect(
    same(keys(config.services), expectedInventories[modelName]),
    `${modelName} Compose service inventory drifted`,
  );
  expect(!Object.hasOwn(config.services ?? {}, "runner"), `${modelName} model must exclude the untrusted runner`);
  expect(
    config.services?.app?.environment?.UPLOADS_ENABLED === (modelName === "uploads" || modelName === "combined" ? "true" : "false"),
    `${modelName} app must receive UPLOADS_ENABLED`,
  );
}

const config = models.combined;
const expectedProfiles = Object.fromEntries([
  ...pilotServices.map((name) => [name, []]),
  ...operationServices.map((name) => [name, ["operations"]]),
  ...uploadServices.map((name) => [name, ["uploads"]]),
]);
for (const [name, profiles] of Object.entries(expectedProfiles)) {
  expect(same(config.services?.[name]?.profiles ?? [], profiles), `${name} profile allowlist drifted`);
}

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
  expect(
    service.labels?.["com.centurylinklabs.watchtower.enable"] === "false",
    `${name} must opt out of Watchtower`,
  );
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
  "reward-worker": ["data"],
  "regrade-worker": ["data", "runner-egress"],
  "exam-finalization-worker": ["data", "runner-egress"],
  "practice-runner-recovery-worker": ["data", "runner-egress"],
  "project-review-correction-worker": ["data", "github-egress"],
  clamav: ["scanner", "signature-egress"],
  "scan-worker": ["data", "scanner"],
  lifecycle: ["data"],
  "platform-seed": ["data"],
  "admin-bootstrap": ["data"],
  cloudflared: ["frontend"],
};
for (const [name, networks] of Object.entries(expectedNetworks)) {
  expect(same(keys(config.services?.[name]?.networks), networks), `${name} network allowlist drifted`);
}
expect(
  same(keys(config.networks), [
    "data",
    "frontend",
    "github-egress",
    "mail-egress",
    "runner-egress",
    "scanner",
    "signature-egress",
  ]),
  "Compose network inventory drifted",
);
expect(config.networks?.data?.internal === true, "database network must be internal");
expect(config.networks?.scanner?.internal === true, "scanner network must be internal");

const expectedSecretSources = {
  postgres: ["postgres_password"],
  migrate: ["database_url"],
  app: [
    "better_auth_secret",
    "credential_master_key",
    "database_url",
    "deletion_tombstone_key",
    "google_client_secret",
    "lost_device_proof_key",
    "runner_shared_secret",
  ],
  "mail-worker": [
    "database_url",
    "gmail_client_id",
    "gmail_client_secret",
    "gmail_refresh_token",
    "lost_device_proof_key",
  ],
  "reward-worker": ["database_url"],
  "regrade-worker": ["database_url", "runner_shared_secret"],
  "exam-finalization-worker": ["database_url", "runner_shared_secret"],
  "practice-runner-recovery-worker": ["database_url", "runner_shared_secret"],
  "project-review-correction-worker": ["database_url"],
  clamav: [],
  "scan-worker": ["database_url"],
  lifecycle: ["database_url"],
  "platform-seed": ["database_url"],
  "admin-bootstrap": ["better_auth_secret", "bootstrap_admin_password", "database_url"],
  cloudflared: ["cloudflare_tunnel_credentials"],
};
for (const [name, sources] of Object.entries(expectedSecretSources)) {
  const actual = (config.services?.[name]?.secrets ?? []).map((secret) => secret.source);
  expect(same(actual, sources), `${name} secret allowlist drifted`);
}
expect(
  same(keys(config.secrets), [
    "better_auth_secret",
    "bootstrap_admin_password",
    "cloudflare_tunnel_credentials",
    "credential_master_key",
    "database_url",
    "deletion_tombstone_key",
    "gmail_client_id",
    "gmail_client_secret",
    "gmail_refresh_token",
    "google_client_secret",
    "lost_device_proof_key",
    "postgres_password",
    "runner_shared_secret",
  ]),
  "Compose secret inventory drifted",
);
expect(
  config.secrets?.bootstrap_admin_password?.file === "/etc/learncoding/secrets/bootstrap_admin_password",
  "bootstrap_admin_password must be file-backed",
);

const volumeSignature = (volume) =>
  `${volume.type}:${volume.source}:${volume.target}:${volume.read_only === true ? "ro" : "rw"}`;
const expectedVolumes = {
  postgres: ["bind:/srv/learncoding/postgres:/var/lib/postgresql/data:rw"],
  migrate: [],
  app: [
    "bind:/srv/learncoding/next-cache:/app/.next/cache:rw",
    "bind:/srv/learncoding/app-data:/var/lib/learncoding:rw",
  ],
  "mail-worker": [],
  "reward-worker": [],
  "regrade-worker": [],
  "exam-finalization-worker": [],
  "practice-runner-recovery-worker": [],
  "project-review-correction-worker": [],
  clamav: ["volume:clamav-signatures:/var/lib/clamav:rw"],
  "scan-worker": ["bind:/srv/learncoding/app-data:/var/lib/learncoding:ro"],
  lifecycle: ["bind:/srv/learncoding/app-data:/var/lib/learncoding:rw"],
  "platform-seed": [],
  "admin-bootstrap": [],
  cloudflared: [],
};
for (const [name, volumes] of Object.entries(expectedVolumes)) {
  const actual = (config.services?.[name]?.volumes ?? []).map(volumeSignature);
  expect(same(actual, volumes), `${name} mount allowlist drifted`);
}

const expectedCapAdd = {
  clamav: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"],
};
for (const name of expectedInventories.combined) {
  expect(
    same(config.services?.[name]?.cap_drop ?? [], name === "postgres" ? [] : ["ALL"]),
    `${name} capability drop allowlist drifted`,
  );
  expect(
    same(config.services?.[name]?.cap_add ?? [], expectedCapAdd[name] ?? []),
    `${name} capability add allowlist drifted`,
  );
}

const dependencySignature = (service) =>
  Object.entries(service?.depends_on ?? {}).map(([name, dependency]) => `${name}:${dependency.condition}`);
const expectedDependencies = {
  postgres: [],
  migrate: ["postgres:service_healthy"],
  app: ["migrate:service_completed_successfully"],
  "mail-worker": ["migrate:service_completed_successfully"],
  "reward-worker": ["migrate:service_completed_successfully"],
  "regrade-worker": ["migrate:service_completed_successfully"],
  "exam-finalization-worker": ["migrate:service_completed_successfully"],
  "practice-runner-recovery-worker": ["migrate:service_completed_successfully"],
  "project-review-correction-worker": ["migrate:service_completed_successfully"],
  clamav: [],
  "scan-worker": ["clamav:service_healthy", "migrate:service_completed_successfully"],
  lifecycle: ["migrate:service_completed_successfully"],
  "platform-seed": ["migrate:service_completed_successfully"],
  "admin-bootstrap": ["migrate:service_completed_successfully"],
  cloudflared: ["app:service_healthy"],
};
for (const [name, dependencies] of Object.entries(expectedDependencies)) {
  expect(same(dependencySignature(config.services?.[name]), dependencies), `${name} dependency allowlist drifted`);
}

const expectedBuildTargets = {
  postgres: null,
  migrate: "tooling",
  app: "runtime",
  "mail-worker": "worker",
  "reward-worker": "worker",
  "regrade-worker": "regrade-worker",
  "exam-finalization-worker": "regrade-worker",
  "practice-runner-recovery-worker": "regrade-worker",
  "project-review-correction-worker": "project-review-correction-worker",
  clamav: null,
  "scan-worker": "scanner-worker",
  lifecycle: "operations",
  "platform-seed": "operations",
  "admin-bootstrap": "operations",
  cloudflared: null,
};
for (const [name, target] of Object.entries(expectedBuildTargets)) {
  expect((config.services?.[name]?.build?.target ?? null) === target, `${name} build target drifted`);
}

const expectedImages = {
  app: applicationImages.APP_RUNTIME_IMAGE,
  migrate: applicationImages.APP_TOOLING_IMAGE,
  "mail-worker": applicationImages.APP_WORKER_IMAGE,
  "reward-worker": applicationImages.APP_WORKER_IMAGE,
  "regrade-worker": applicationImages.APP_REGRADE_WORKER_IMAGE,
  "exam-finalization-worker": applicationImages.APP_REGRADE_WORKER_IMAGE,
  "practice-runner-recovery-worker": applicationImages.APP_REGRADE_WORKER_IMAGE,
  "project-review-correction-worker": applicationImages.APP_PROJECT_REVIEW_WORKER_IMAGE,
  "scan-worker": applicationImages.APP_SCANNER_WORKER_IMAGE,
  lifecycle: applicationImages.APP_OPERATIONS_IMAGE,
  "platform-seed": applicationImages.APP_OPERATIONS_IMAGE,
  "admin-bootstrap": applicationImages.APP_OPERATIONS_IMAGE,
};
for (const [name, image] of Object.entries(expectedImages)) {
  expect(config.services?.[name]?.image === image, `${name} application image input drifted`);
}
expect(inactiveClamav?.services?.clamav?.image === "clamav/clamav:pilot-disabled", "ClamAV inactive fallback drifted");

const operationCommands = {
  lifecycle: [
    "node",
    "--import",
    "tsx",
    "/app/scripts/data-lifecycle.ts",
    "retention",
    "--apply",
    "--confirm",
    "2026-07-12.v3",
  ],
  "platform-seed": ["node", "--import", "tsx", "/app/scripts/seed-platform.ts"],
  "admin-bootstrap": ["node", "--import", "tsx", "/app/scripts/bootstrap-admin.ts"],
};
for (const name of operationServices) {
  expect(config.services?.[name]?.restart === "no", `${name} must remain a one-shot service`);
  expect(orderedSame(config.services?.[name]?.command ?? [], operationCommands[name]), `${name} command drifted`);
}
expect(config.services?.migrate?.restart === "no", "migrate must remain a one-shot service");
expect(
  same(keys(config.services?.["platform-seed"]?.environment), ["DATABASE_URL_FILE"]),
  "platform-seed environment allowlist drifted",
);
expect(
  config.services?.["platform-seed"]?.environment?.DATABASE_URL_FILE === "/run/secrets/database_url",
  "platform-seed must read DATABASE_URL from its file secret",
);
expect(
  same(keys(config.services?.["admin-bootstrap"]?.environment), [
    "APP_NAME",
    "APP_URL",
    "BETTER_AUTH_SECRET_FILE",
    "BOOTSTRAP_ADMIN_EMAIL",
    "BOOTSTRAP_ADMIN_PASSWORD_FILE",
    "DATABASE_URL_FILE",
  ]),
  "admin-bootstrap environment allowlist drifted",
);
expect(
  config.services?.["admin-bootstrap"]?.environment?.DATABASE_URL_FILE === "/run/secrets/database_url" &&
    config.services?.["admin-bootstrap"]?.environment?.BETTER_AUTH_SECRET_FILE === "/run/secrets/better_auth_secret" &&
    config.services?.["admin-bootstrap"]?.environment?.BOOTSTRAP_ADMIN_PASSWORD_FILE ===
      "/run/secrets/bootstrap_admin_password" &&
    config.services?.["admin-bootstrap"]?.environment?.APP_NAME === "Compose Validator" &&
    config.services?.["admin-bootstrap"]?.environment?.APP_URL === "https://compose-validator.example" &&
    config.services?.["admin-bootstrap"]?.environment?.BOOTSTRAP_ADMIN_EMAIL ===
      "admin@compose-validator.example",
  "admin-bootstrap environment interpolation drifted",
);
expect(
  config.services?.cloudflared?.configs?.some(
    (entry) => entry.target === "/etc/cloudflared/config.yml" && entry.mode === "0444",
  ),
  "Cloudflare config must be mounted read-only",
);

if (failures.length > 0) {
  console.error("Semantic Compose validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "Semantic Compose validation passed (profiles, images, operations, network, capability, mount, and secret allowlists).",
);
