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
  "postgres",
  "practice-runner-recovery-worker",
  "project-review-correction-worker",
  "regrade-worker",
  "reward-worker",
  "runner-egress-gateway",
  "file-erasure-worker",
];
const operationServices = [
  "admin-bootstrap",
  "database-boundary-verifier",
  "database-negative-probes",
  "database-role-bootstrap",
  "lifecycle",
  "migrate",
  "platform-seed",
];
const uploadServices = ["clamav", "scan-worker"];
const internalLongRunningServices = [
  ...pilotServices.filter((name) => name !== "cloudflared"),
  ...uploadServices,
];
const oneShotServices = operationServices;
const databaseMutatingServices = [
  "app",
  "exam-finalization-worker",
  "mail-worker",
  "practice-runner-recovery-worker",
  "project-review-correction-worker",
  "regrade-worker",
  "reward-worker",
  "scan-worker",
  "file-erasure-worker",
];

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
  expect(
    config.services?.["mail-worker"]?.environment?.MAIL_OUTBOX_PHASE === "dual-write-v1",
    `${modelName} mail worker must render the reviewed dual-write phase`,
  );
  expect(
    config.services?.["mail-worker"]?.environment?.OUTBOX_WORKER_MODE === "fenced-postgres-v1",
    `${modelName} mail worker must render the exact fenced claimant`,
  );
  for (const [name, service] of Object.entries(config.services ?? {})) {
    const consumesSecrets = (service.secrets?.length ?? 0) > 0;
    const expectedGroups = consumesSecrets ? ["2000"] : [];
    expect(
      same((service.group_add ?? []).map(String), expectedGroups),
      `${modelName} ${name} supplemental groups must exactly match secret consumption`,
    );
  }
}

const config = models.combined;
expect(
  orderedSame(config.services?.postgres?.command ?? [], [
    "postgres",
    "-c",
    "fsync=on",
    "-c",
    "synchronous_commit=on",
    "-c",
    "full_page_writes=on",
    "-c",
    "unix_socket_directories=/run/learncoding-postgres",
    "-c",
    "unix_socket_permissions=0700",
  ]),
  "postgres command must contain only the reviewed durability and control-socket settings",
);
expect(
  String(config.services?.postgres?.environment?.POSTGRES_INITDB_ARGS ?? "")
    .split(/\s+/u)
    .includes("--data-checksums"),
  "postgres must retain data checksums for newly initialized clusters",
);
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
for (const name of ["app", "scan-worker", "file-erasure-worker", "lifecycle"]) {
  expect(
    config.services?.[name]?.user === "1000:1000",
    `${name} must pin the reviewed object-writer uid/gid`,
  );
}
for (const name of internalLongRunningServices) {
  expect(config.services?.[name]?.restart === "unless-stopped", `${name} must restart unless stopped`);
}
expect(
  config.services?.cloudflared?.restart === "on-failure:5",
  "cloudflared must be the sole bounded restart-policy exception",
);
for (const name of oneShotServices) {
  expect(config.services?.[name]?.restart === "no", `${name} must remain a non-restarting one-shot`);
}
expect(
  config.services?.postgres?.stop_grace_period === "2m0s",
  "postgres must receive a two-minute stop budget",
);
for (const name of databaseMutatingServices) {
  expect(
    config.services?.[name]?.stop_grace_period === "1m0s",
    `${name} must receive a one-minute stop budget`,
  );
}
expect(config.services?.cloudflared?.stop_grace_period === "30s", "cloudflared must receive a 30-second stop budget");

const expectedNetworks = {
  postgres: ["data"],
  migrate: ["data"],
  "database-role-bootstrap": ["data"],
  "database-negative-probes": ["data"],
  "database-boundary-verifier": ["data"],
  app: ["data", "frontend", "runner-client"],
  "mail-worker": ["data", "mail-egress"],
  "reward-worker": ["data"],
  "regrade-worker": ["data", "runner-client"],
  "exam-finalization-worker": ["data", "runner-client"],
  "practice-runner-recovery-worker": ["data", "runner-client"],
  "runner-egress-gateway": ["runner-client", "runner-egress"],
  "project-review-correction-worker": ["data", "github-egress"],
  clamav: ["scanner", "signature-egress"],
  "scan-worker": ["data", "scanner"],
  "file-erasure-worker": ["data"],
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
    "runner-client",
    "runner-egress",
    "scanner",
    "signature-egress",
  ]),
  "Compose network inventory drifted",
);
expect(config.networks?.data?.internal === true, "database network must be internal");
expect(config.networks?.scanner?.internal === true, "scanner network must be internal");
expect(config.networks?.["runner-client"]?.internal === true, "runner client network must be internal");
expect(
  same(
    (config.networks?.["runner-client"]?.ipam?.config ?? []).map((entry) => entry.subnet),
    ["172.29.41.0/24"],
  ),
  "runner-client must have only the reviewed 172.29.41.0/24 subnet",
);
expect(config.networks?.["runner-egress"]?.driver === "bridge", "runner-egress must use the bridge driver");
expect(
  same(
    (config.networks?.["runner-egress"]?.ipam?.config ?? []).map((entry) => entry.subnet),
    ["172.29.40.0/24"],
  ),
  "runner-egress must have only the reviewed 172.29.40.0/24 subnet",
);
expect(
  config.networks?.["runner-egress"]?.driver_opts?.["com.docker.network.bridge.name"] === "cdst-run0",
  "runner-egress must request Linux bridge cdst-run0",
);
const actualRunnerConsumers = Object.entries(config.services ?? {})
  .filter(([, service]) => Object.hasOwn(service.networks ?? {}, "runner-egress"))
  .map(([name]) => name);
expect(
  same(actualRunnerConsumers, [
    "runner-egress-gateway",
  ]),
  "runner-egress must be attached only to the secretless runner gateway",
);
const actualRunnerClientConsumers = Object.entries(config.services ?? {})
  .filter(([, service]) => Object.hasOwn(service.networks ?? {}, "runner-client"))
  .map(([name]) => name);
expect(
  same(actualRunnerClientConsumers, [
    "app",
    "exam-finalization-worker",
    "practice-runner-recovery-worker",
    "regrade-worker",
    "runner-egress-gateway",
  ]),
  "runner-client consumers must be limited to the four runner clients and their gateway",
);
for (const name of [
  "app",
  "exam-finalization-worker",
  "practice-runner-recovery-worker",
  "regrade-worker",
]) {
  expect(
    config.services?.[name]?.environment?.RUNNER_BASE_URL === "http://runner-egress-gateway:4100",
    `${name} must address the internal runner gateway`,
  );
}
const gateway = config.services?.["runner-egress-gateway"];
expect(
  gateway?.environment?.RUNNER_GATEWAY_UPSTREAM === "http://192.168.122.12:4100",
  "runner gateway must target only the fixed private runner address",
);
expect((gateway?.secrets ?? []).length === 0, "runner gateway must receive no secrets");
expect(gateway?.image === applicationImages.APP_RUNTIME_IMAGE, "runner gateway must reuse the reviewed runtime image");
expect(gateway?.user === "1000:1000", "runner gateway must run as the unprivileged node identity");
expect(Array.isArray(gateway?.entrypoint) && gateway.entrypoint.length === 0, "runner gateway must clear the app-only secret-loading entrypoint");
expect(gateway?.networks?.["runner-egress"]?.ipv4_address === "172.29.40.2", "runner gateway must use its reviewed fixed egress address");
expect(gateway?.networks?.["runner-egress"]?.interface_name === "runner-egress", "runner gateway egress interface must be deterministic");
expect(gateway?.networks?.["runner-egress"]?.gw_priority === 100, "runner gateway must use runner-egress as its only default egress");
expect(gateway?.networks?.["runner-client"]?.ipv4_address === "172.29.41.2", "runner gateway must use its reviewed fixed client address");
expect(gateway?.networks?.["runner-client"]?.interface_name === "runner-client", "runner gateway client interface must be deterministic");
expect(config.services?.app?.networks?.frontend?.interface_name === "frontend", "app frontend interface must be deterministic");
expect(config.services?.app?.networks?.frontend?.gw_priority === 100, "app provider/default egress must remain on frontend");
expect(config.services?.app?.networks?.["runner-client"]?.interface_name === "runner-client", "app runner-client interface must be deterministic");

const expectedSecretSources = {
  postgres: ["postgres_password"],
  "database-role-bootstrap": [
    "database_bootstrap_url",
    "database_migrator_url",
    "database_ops_url",
    "database_url",
    "database_worker_url",
  ],
  "database-negative-probes": [
    "database_migrator_url",
    "database_ops_url",
    "database_url",
    "database_worker_url",
  ],
  "database-boundary-verifier": [
    "database_migrator_url",
    "database_ops_url",
    "database_url",
    "database_worker_url",
  ],
  migrate: ["database_migrator_url"],
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
    "database_worker_url",
    "deletion_tombstone_key",
    "gmail_client_id",
    "gmail_client_secret",
    "gmail_refresh_token",
    "lost_device_proof_key",
  ],
  "reward-worker": ["database_worker_url"],
  "regrade-worker": ["database_worker_url", "runner_shared_secret"],
  "exam-finalization-worker": ["database_worker_url", "runner_shared_secret"],
  "practice-runner-recovery-worker": ["database_worker_url", "runner_shared_secret"],
  "project-review-correction-worker": ["database_worker_url"],
  clamav: [],
  "scan-worker": ["database_worker_url"],
  "file-erasure-worker": ["database_worker_url"],
  lifecycle: ["database_ops_url"],
  "platform-seed": ["database_ops_url"],
  "admin-bootstrap": ["better_auth_secret", "bootstrap_admin_password", "database_ops_url"],
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
    "database_bootstrap_url",
    "database_migrator_url",
    "database_ops_url",
    "database_worker_url",
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
  postgres: [
    "bind:/run/learncoding-postgres:/run/learncoding-postgres:rw",
    "bind:/srv/learncoding/postgres:/var/lib/postgresql/data:rw",
  ],
  migrate: [],
  "database-role-bootstrap": [],
  "database-negative-probes": [],
  "database-boundary-verifier": [],
  app: [
    "bind:/srv/learncoding/next-cache:/app/.next/cache:rw",
    "bind:/srv/learncoding/app-data/objects:/var/lib/learncoding/objects:rw",
  ],
  "mail-worker": [],
  "reward-worker": [],
  "regrade-worker": [],
  "exam-finalization-worker": [],
  "practice-runner-recovery-worker": [],
  "project-review-correction-worker": [],
  clamav: ["volume:clamav-signatures:/var/lib/clamav:rw"],
  "scan-worker": ["bind:/srv/learncoding/app-data/objects:/var/lib/learncoding/objects:ro"],
  "file-erasure-worker": ["bind:/srv/learncoding/app-data/objects:/var/lib/learncoding/objects:rw"],
  lifecycle: ["bind:/srv/learncoding/app-data/objects:/var/lib/learncoding/objects:rw"],
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
    same(config.services?.[name]?.cap_drop ?? [], ["ALL"]),
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
  "database-role-bootstrap": ["postgres:service_healthy"],
  "database-negative-probes": ["postgres:service_healthy"],
  "database-boundary-verifier": ["postgres:service_healthy"],
  app: ["postgres:service_healthy", "runner-egress-gateway:service_healthy"],
  "runner-egress-gateway": [],
  "mail-worker": ["postgres:service_healthy"],
  "reward-worker": ["postgres:service_healthy"],
  "regrade-worker": ["postgres:service_healthy"],
  "exam-finalization-worker": ["postgres:service_healthy"],
  "practice-runner-recovery-worker": ["postgres:service_healthy"],
  "project-review-correction-worker": ["postgres:service_healthy"],
  clamav: [],
  "scan-worker": ["clamav:service_healthy", "postgres:service_healthy"],
  "file-erasure-worker": ["postgres:service_healthy"],
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
  "database-role-bootstrap": "operations",
  "database-negative-probes": "operations",
  "database-boundary-verifier": "operations",
  app: "runtime",
  "mail-worker": "worker",
  "reward-worker": "worker",
  "regrade-worker": "regrade-worker",
  "exam-finalization-worker": "regrade-worker",
  "practice-runner-recovery-worker": "regrade-worker",
  "project-review-correction-worker": "project-review-correction-worker",
  clamav: null,
  "scan-worker": "scanner-worker",
  "file-erasure-worker": "worker",
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
  "database-role-bootstrap": applicationImages.APP_OPERATIONS_IMAGE,
  "database-negative-probes": applicationImages.APP_OPERATIONS_IMAGE,
  "database-boundary-verifier": applicationImages.APP_OPERATIONS_IMAGE,
  "mail-worker": applicationImages.APP_WORKER_IMAGE,
  "reward-worker": applicationImages.APP_WORKER_IMAGE,
  "regrade-worker": applicationImages.APP_REGRADE_WORKER_IMAGE,
  "exam-finalization-worker": applicationImages.APP_REGRADE_WORKER_IMAGE,
  "practice-runner-recovery-worker": applicationImages.APP_REGRADE_WORKER_IMAGE,
  "project-review-correction-worker": applicationImages.APP_PROJECT_REVIEW_WORKER_IMAGE,
  "scan-worker": applicationImages.APP_SCANNER_WORKER_IMAGE,
  "file-erasure-worker": applicationImages.APP_WORKER_IMAGE,
  lifecycle: applicationImages.APP_OPERATIONS_IMAGE,
  "platform-seed": applicationImages.APP_OPERATIONS_IMAGE,
  "admin-bootstrap": applicationImages.APP_OPERATIONS_IMAGE,
};
for (const [name, image] of Object.entries(expectedImages)) {
  expect(config.services?.[name]?.image === image, `${name} application image input drifted`);
}
expect(inactiveClamav?.services?.clamav?.image === "clamav/clamav:pilot-disabled", "ClamAV inactive fallback drifted");

const operationCommands = {
  "database-role-bootstrap": ["node", "/app/scripts/bootstrap-database-roles.mjs"],
  "database-negative-probes": ["node", "/app/scripts/verify-database-role-boundaries.mjs"],
  "database-boundary-verifier": ["node", "/app/scripts/verify-database-role-boundaries.mjs", "--require-application-objects"],
  lifecycle: [
    "node",
    "--import",
    "tsx",
    "/app/scripts/data-lifecycle.ts",
    "retention",
    "--apply",
    "--confirm",
    "2026-07-14.v4",
  ],
  "platform-seed": ["node", "--import", "tsx", "/app/scripts/seed-platform.ts"],
  "admin-bootstrap": ["node", "--import", "tsx", "/app/scripts/bootstrap-admin.ts"],
};
for (const name of Object.keys(operationCommands)) {
  expect(config.services?.[name]?.restart === "no", `${name} must remain a one-shot service`);
  expect(orderedSame(config.services?.[name]?.command ?? [], operationCommands[name]), `${name} command drifted`);
}
expect(config.services?.migrate?.restart === "no", "migrate must remain a one-shot service");
const databaseBoundaryEnvironments = {
  "database-role-bootstrap": {
    DATABASE_APP_URL_FILE: "/run/secrets/database_app_url",
    DATABASE_BOOTSTRAP_URL_FILE: "/run/secrets/database_bootstrap_url",
    DATABASE_MIGRATOR_URL_FILE: "/run/secrets/database_migrator_url",
    DATABASE_OPS_URL_FILE: "/run/secrets/database_ops_url",
    DATABASE_WORKER_URL_FILE: "/run/secrets/database_worker_url",
    POSTGRES_DB: "learncoding",
    POSTGRES_USER: "learncoding",
  },
  "database-negative-probes": {
    DATABASE_MIGRATOR_URL_FILE: "/run/secrets/database_migrator_url",
    DATABASE_OPS_URL_FILE: "/run/secrets/database_ops_url",
    DATABASE_URL_FILE: "/run/secrets/database_url",
    DATABASE_WORKER_URL_FILE: "/run/secrets/database_worker_url",
    POSTGRES_DB: "learncoding",
  },
  "database-boundary-verifier": {
    DATABASE_MIGRATOR_URL_FILE: "/run/secrets/database_migrator_url",
    DATABASE_OPS_URL_FILE: "/run/secrets/database_ops_url",
    DATABASE_URL_FILE: "/run/secrets/database_url",
    DATABASE_WORKER_URL_FILE: "/run/secrets/database_worker_url",
    POSTGRES_DB: "learncoding",
  },
};
for (const [name, expectedEnvironment] of Object.entries(databaseBoundaryEnvironments)) {
  expect(
    orderedSame(config.services?.[name]?.environment ?? {}, expectedEnvironment),
    `${name} environment allowlist drifted`,
  );
}
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

const gmailRequestTimeoutContract = spawnSync(
  process.execPath,
  ["--test", path.join(root, "infra/tests/gmail-request-timeout-config.test.mjs")],
  { cwd: root, encoding: "utf8" },
);
expect(
  gmailRequestTimeoutContract.status === 0,
  `Gmail request timeout configuration contract failed: ${(
    gmailRequestTimeoutContract.stderr || gmailRequestTimeoutContract.stdout
  ).trim()}`,
);

const gmailReconciliationImageContract = spawnSync(
  process.execPath,
  ["--test", path.join(root, "infra/tests/gmail-reconciliation-image.test.mjs")],
  { cwd: root, encoding: "utf8" },
);
expect(
  gmailReconciliationImageContract.status === 0,
  `Gmail reconciliation image contract failed: ${(
    gmailReconciliationImageContract.stderr || gmailReconciliationImageContract.stdout
  ).trim()}`,
);

if (failures.length > 0) {
  console.error("Semantic Compose validation failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  "Semantic Compose validation passed (durability, profiles, restart/stop classes, networks, dependencies, images, mounts, secrets, and hardening).",
);
