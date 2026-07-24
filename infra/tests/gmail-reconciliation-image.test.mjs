import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

test("the production worker image ships the reconciliation operator", () => {
  const dockerfile = read("Dockerfile");
  const workerStage =
    dockerfile.match(/FROM final-base AS worker([\s\S]*?)\nFROM worker AS operations/u)?.[1] ?? "";

  assert.match(
    workerStage,
    /COPY --chown=node:node scripts\/reconcile-gmail-outbox\.ts \.\/scripts\/reconcile-gmail-outbox\.ts/u,
  );
  assert.match(workerStage, /COPY --from=production-dependencies[\s\S]*\/app\/node_modules/u);
  assert.match(workerStage, /ENTRYPOINT \["\/usr\/local\/bin\/learncoding-entrypoint"\]/u);
});

test("the production runbook invokes the image entrypoint with a one-session gate", () => {
  const runbook = read("docs/runbooks/gmail-outbox-reconciliation.md");
  const command =
    /docker compose run --rm --no-deps -e GMAIL_RECONCILIATION_ENABLED=true mail-worker node --import tsx \/app\/scripts\/reconcile-gmail-outbox\.ts/u;

  assert.match(runbook, command);
  assert.doesNotMatch(runbook, /npm run worker:email:reconcile/u);
  assert.doesNotMatch(runbook, /docker compose exec/u);

  const compose = read("compose.yaml");
  const workerService =
    compose.match(/\n  mail-worker:\n([\s\S]*?)(?=\n  [a-z0-9-]+:\n)/u)?.[1] ?? "";
  for (const required of [
    "DATABASE_URL_FILE: /run/secrets/database_url",
    "DELETION_TOMBSTONE_KEY_FILE: /run/secrets/deletion_tombstone_key",
    'REQUIRE_DELETION_TOMBSTONE_KEY: "1"',
    "GMAIL_CLIENT_ID_FILE: /run/secrets/gmail_client_id",
    "GMAIL_CLIENT_SECRET_FILE: /run/secrets/gmail_client_secret",
    "GMAIL_REFRESH_TOKEN_FILE: /run/secrets/gmail_refresh_token",
    "GMAIL_OAUTH_SCOPES:",
  ]) {
    assert.match(workerService, new RegExp(required.replaceAll("/", "\\/"), "u"));
  }
  assert.match(workerService, /\n      - deletion_tombstone_key/u);
  const entrypoint = read("infra/docker/entrypoint.sh");
  assert.match(entrypoint, /REQUIRE_DELETION_TOMBSTONE_KEY/u);
  assert.match(
    entrypoint,
    /DELETION_TOMBSTONE_KEY must be at least 32 characters/u,
  );

  const storeTest = read("src/lib/notifications/__tests__/postgres-outbox-store.test.ts");
  assert.match(storeTest, /process\.env\.DELETION_TOMBSTONE_KEY =/u);
  assert.match(
    storeTest,
    /template: "account-deleted"[\s\S]*?beginProviderCall\(deletionClaim,/u,
  );
});

test(
  "the image entrypoint expands database and Gmail file secrets before exec",
  { skip: process.platform === "win32" },
  () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codestead-gmail-entrypoint-"));
    const values = {
      DATABASE_URL: "postgresql://worker:example@postgres/codestead",
      DELETION_TOMBSTONE_KEY: "deletion-tombstone-key.example-0123456789",
      GMAIL_CLIENT_ID: "client-id.example",
      GMAIL_CLIENT_SECRET: "client-secret.example",
      GMAIL_REFRESH_TOKEN: "refresh-token.example",
    };
    try {
      const environment = { ...process.env, NODE_ENV: "test" };
      for (const [name, value] of Object.entries(values)) {
        delete environment[name];
        const file = path.join(directory, name.toLowerCase());
        writeFileSync(file, value, { encoding: "utf8", mode: 0o600 });
        environment[`${name}_FILE`] = file;
      }
      const result = spawnSync(
        "sh",
        [
          path.join(root, "infra/docker/entrypoint.sh"),
          process.execPath,
          "-e",
          `process.stdout.write(JSON.stringify({
            DATABASE_URL: process.env.DATABASE_URL,
            GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID,
            GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET,
            GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN,
            DELETION_TOMBSTONE_KEY: process.env.DELETION_TOMBSTONE_KEY,
          }))`,
        ],
        { cwd: root, env: environment, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), values);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "the production entrypoint rejects an unusable deletion capability key",
  { skip: process.platform === "win32" },
  () => {
    const entrypoint = path.join(root, "infra/docker/entrypoint.sh");
    const baseEnvironment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://worker:example@postgres/codestead",
      REQUIRE_DELETION_TOMBSTONE_KEY: "1",
    };
    delete baseEnvironment.DELETION_TOMBSTONE_KEY;
    delete baseEnvironment.DELETION_TOMBSTONE_KEY_FILE;

    for (const deletionKey of [undefined, "too-short"]) {
      const environment = { ...baseEnvironment };
      if (deletionKey !== undefined) {
        environment.DELETION_TOMBSTONE_KEY = deletionKey;
      }
      const result = spawnSync(
        "sh",
        [entrypoint, process.execPath, "-e", 'process.stdout.write("unexpected")'],
        { cwd: root, env: environment, encoding: "utf8" },
      );
      assert.equal(result.status, 64);
      assert.equal(result.stdout, "");
      assert.equal(
        result.stderr,
        "fatal: DELETION_TOMBSTONE_KEY must be at least 32 characters\n",
      );
    }

    const result = spawnSync(
      "sh",
      [entrypoint, process.execPath, "-e", 'process.stdout.write("ok")'],
      {
        cwd: root,
        env: {
          ...baseEnvironment,
          DELETION_TOMBSTONE_KEY: "x".repeat(32),
        },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "ok");
    assert.equal(result.stderr, "");
  },
);
