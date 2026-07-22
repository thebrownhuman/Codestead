import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { validateDatabaseSecretValues } from "../ops/validate-database-secrets.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const ceremonyPath = path.join(root, "infra/ops/create-database-secrets.sh");
const atomicCeremonyTestPath = path.join(
  root, "infra/tests/database-secret-ceremony-atomic.test.sh",
);
const secretNames = [
  "postgres_password",
  "database_bootstrap_url",
  "database_url",
  "database_migrator_url",
  "database_worker_url",
  "database_ops_url",
];

let temporaryRoot;
let values;

function bashPath(filePath) {
  if (process.platform !== "win32") return filePath;
  const match = /^([A-Za-z]):[\\/](.*)$/u.exec(filePath);
  assert.ok(match, `cannot convert Windows path for bash: ${filePath}`);
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function readSecret(name) {
  return readFileSync(path.join(temporaryRoot, name), "utf8");
}

function expectInvalid(overrides) {
  assert.throws(
    () => validateDatabaseSecretValues({ ...values, ...overrides }),
    { message: "database secret topology is invalid" },
  );
}

before(() => {
  temporaryRoot = mkdtempSync(path.join(root, ".database-secret-ceremony-"));
  const commandArguments =
    process.platform === "win32"
      ? ["-lc", `CODESTEAD_SECRETS_DIR=${shellQuote(
          bashPath(temporaryRoot),
        )} bash ${shellQuote(bashPath(ceremonyPath))}`]
      : [bashPath(ceremonyPath)];
  const result = spawnSync("bash", commandArguments, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...(process.platform === "win32"
        ? {}
        : { CODESTEAD_SECRETS_DIR: bashPath(temporaryRoot) }),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout, "", "the ceremony must not print secret values");

  values = {
    postgresUser: "learncoding",
    postgresDatabase: "learncoding",
    postgresPassword: readSecret("postgres_password"),
    databaseBootstrapUrl: readSecret("database_bootstrap_url"),
    databaseAppUrl: readSecret("database_url"),
    databaseMigratorUrl: readSecret("database_migrator_url"),
    databaseWorkerUrl: readSecret("database_worker_url"),
    databaseOpsUrl: readSecret("database_ops_url"),
  };
});

after(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
});

test("the public ceremony creates a clean validator-compatible inventory", () => {
  assert.deepEqual(validateDatabaseSecretValues(values), {
    bootstrapUser: "learncoding",
    database: "learncoding",
    restrictedUsers: [
      "learncoding_app",
      "learncoding_migrator",
      "learncoding_worker",
      "learncoding_ops",
    ],
  });

  for (const name of secretNames) {
    const bytes = readFileSync(path.join(temporaryRoot, name));
    assert.ok(bytes.length > 0, `${name} must not be empty`);
    assert.doesNotMatch(bytes.toString("latin1"), /[\x00-\x20\x7f]/u);
  }

  const passwords = [
    values.postgresPassword,
    values.databaseAppUrl,
    values.databaseMigratorUrl,
    values.databaseWorkerUrl,
    values.databaseOpsUrl,
  ].map((value) => (value.includes("://") ? new URL(value).password : value));
  assert.equal(new Set(passwords).size, 5);
  for (const password of passwords) assert.match(password, /^[0-9a-f]{64}$/u);
});

test("a missing database URL fails closed", () => {
  expectInvalid({ databaseOpsUrl: undefined });
});

test("a wrong fixed role user fails closed", () => {
  expectInvalid({
    databaseWorkerUrl: values.databaseWorkerUrl.replace(
      "learncoding_worker",
      "learncoding_wrong",
    ),
  });
});

test("duplicate restricted-role passwords fail closed", () => {
  const workerPassword = new URL(values.databaseWorkerUrl).password;
  const ops = new URL(values.databaseOpsUrl);
  ops.password = workerPassword;
  expectInvalid({ databaseOpsUrl: ops.href });
});

test("a restricted-role password equal to the bootstrap password fails closed", () => {
  const app = new URL(values.databaseAppUrl);
  app.password = values.postgresPassword;
  expectInvalid({ databaseAppUrl: app.href });
});

test("a superuser URL mounted as the app URL fails closed", () => {
  expectInvalid({ databaseAppUrl: values.databaseBootstrapUrl });
});

test("the executable ceremony pins the production ownership and cleanup contract", () => {
  const ceremony = readFileSync(ceremonyPath, "utf8");
  assert.match(ceremony, /install -d -o root -g codestead-secrets -m 0750/u);
  assert.match(ceremony, /chown root:codestead-secrets/u);
  assert.match(ceremony, /chmod 0440/u);
  assert.match(ceremony, /unset[\s\S]*postgres_password[\s\S]*app_password/u);
  assert.doesNotMatch(ceremony, /openssl rand[^\n]*>/u);
});

test("the ceremony is atomic, no-clobbering, concurrent-safe, and metadata-exact", () => {
  const commandArguments =
    process.platform === "win32"
      ? ["-lc", `bash ${shellQuote(bashPath(atomicCeremonyTestPath))}`]
      : [atomicCeremonyTestPath];
  const result = spawnSync("bash", commandArguments, {
    cwd: root,
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    /^database secret atomic ceremony tests passed \(root_fixture=(?:passed|skipped)\)\n$/u,
  );
});

test("the deployment guide and secret inventories name the same database ceremony", () => {
  const deployment = readFileSync(path.join(root, "docs/deployment.md"), "utf8");
  const inventory = readFileSync(path.join(root, "infra/secrets/README.md"), "utf8");
  const design = readFileSync(
    path.join(root, "docs/superpowers/specs/2026-07-14-nuc-production-deployment-design.md"),
    "utf8",
  );

  assert.match(deployment, /infra\/ops\/create-database-secrets[.]sh/u);
  for (const name of secretNames) {
    assert.match(deployment, new RegExp(`\\b${name}\\b`, "u"));
    assert.match(inventory, new RegExp(`\\b${name}\\b`, "u"));
    assert.match(design, new RegExp(`\\b${name}\\b`, "u"));
  }
  assert.doesNotMatch(
    deployment,
    /openssl rand -base64 [0-9]+ > \/etc\/learncoding\/secrets\//u,
  );
  assert.match(inventory, /openssl rand -base64 48` piped through `tr -d '\\n'`/u);
  assert.match(deployment, /initial creation only/iu);
  assert.match(inventory, /initial creation only/iu);
});

test("CI runs the database secret ceremony regression", () => {
  const workflow = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(
    workflow,
    /node --test infra\/tests\/database-secret-ceremony[.]test[.]mjs/u,
  );
  assert.match(
    workflow,
    /shellcheck[^\n]*infra\/ops\/create-database-secrets[.]sh/u,
  );
});
