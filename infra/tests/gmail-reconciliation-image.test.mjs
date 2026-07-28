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
const posixShell = process.platform === "win32"
  ? "C:/Program Files/Git/bin/sh.exe"
  : "sh";

function posixPath(file) {
  if (process.platform !== "win32") return file;
  const normalized = file.replaceAll("\\", "/");
  const match = /^([A-Za-z]):\/(.*)$/u.exec(normalized);
  assert.ok(match, `cannot normalize Windows path for Git Bash: ${file}`);
  return `/${match[1].toLowerCase()}/${match[2]}`;
}

function sourceBetween(document, start, end, label) {
  const startIndex = document.indexOf(start);
  assert.notEqual(startIndex, -1, `missing ${label} start`);
  const endIndex = document.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing ${label} end`);
  return document.slice(startIndex, endIndex);
}

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
  assert.match(
    runbook,
    /after its read-only database runtime inspection\s+and\s+before any Gmail call/u,
  );
  assert.match(runbook, /Bound legacy and current rows are fetched as raw messages/u);
  assert.match(
    runbook,
    /Legacy unbound rows use metadata-only verification\s+and\s+remain inspection-only/u,
  );

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
});

test("the reconciliation operator preserves the guarded exact-evidence fence", () => {
  const operator = read("scripts/reconcile-gmail-outbox.ts");
  assert.match(
    operator,
    /const result = await reconcileGmailDelivery\(input, \{\s*store,\s*gmail: \{ findByMessageId: findGmailMessageByMessageId \},\s*\}\);/u,
  );
  assert.doesNotMatch(
    operator,
    /\b(?:beginProviderCall|dispatchAfterProviderBoundary)\b/u,
    "the reconciliation operator must never open a new provider-send boundary",
  );
  const operatorMain = sourceBetween(
    operator,
    "async function main() {",
    "async function closePoolWithinDeadline()",
    "Gmail reconciliation operator main",
  );
  const runtimeInspectionIndex = operatorMain.indexOf(
    "startupInspection = await inspectMailDispatchRuntime(resources.pool)",
  );
  const scopeValidationIndex = operatorMain.indexOf(
    "assertGmailReconciliationOAuthScopes(process.env.GMAIL_OAUTH_SCOPES)",
  );
  const reconciliationIndex = operatorMain.indexOf(
    "const result = await reconcileGmailDelivery(input",
  );
  assert.ok(
    runtimeInspectionIndex !== -1 &&
      runtimeInspectionIndex < scopeValidationIndex &&
      scopeValidationIndex < reconciliationIndex,
    "database runtime inspection, scope validation, and Gmail reconciliation order drifted",
  );

  const reconciliation = read("src/lib/notifications/gmail-reconciliation.ts");
  const authority = sourceBetween(
    reconciliation,
    "export function gmailReconciliationAuthority(",
    "export function gmailProofAuthorizesFence(",
    "Gmail reconciliation authority",
  );
  for (const field of [
    "providerRequestBodySha256",
    "providerRequestBodyLength",
    "releaseReceiptSha256",
  ]) {
    assert.match(
      authority,
      new RegExp(`fence\\.${field}`, "u"),
      `reconciliation authority must bind ${field}`,
    );
  }
  assert.match(
    authority,
    /LOWERCASE_SHA256\.test\(fence\.providerRequestBodySha256\)/u,
  );
  assert.match(
    authority,
    /Number\.isSafeInteger\(fence\.providerRequestBodyLength\)/u,
  );
  assert.match(
    authority,
    /LOWERCASE_SHA256\.test\(fence\.releaseReceiptSha256\)/u,
  );
  assert.match(
    reconciliation,
    /gmailProofAuthorizesFence\(authority, lookup\.proof\)/u,
  );
  assert.match(
    reconciliation,
    /deps\.store\.finalizeGmailReconciliation\(\{\s*fence: candidate\.fence,\s*providerMessageId: lookup\.providerMessageId,\s*proof: lookup\.proof,\s*\}\)/u,
  );

  const lookup = read("src/lib/notifications/gmail-correlation-lookup.ts");
  assert.match(
    lookup,
    /if \(input\.authority\.kind === "legacy-unbound-v0"\) \{[\s\S]*?format", "metadata"[\s\S]*?\} else \{[\s\S]*?format", "raw"/u,
  );
  assert.match(
    lookup,
    /const proof = verifiedProof\(rawBytes, headers, input\.authority\)/u,
  );

  const store = read("src/lib/notifications/postgres-outbox-store.ts");
  const findFence = sourceBetween(
    store,
    "  async findGmailReconciliationFence(",
    "  async finalizeGmailReconciliation(",
    "Gmail reconciliation fence reader",
  );
  const finalizeFence = sourceBetween(
    store,
    "  async finalizeGmailReconciliation(",
    "  async claimNext(",
    "Gmail reconciliation finalizer",
  );
  for (const field of [
    "provider_request_body_sha256",
    "provider_request_body_length",
    "release_receipt_sha256",
  ]) {
    assert.match(findFence, new RegExp(field, "u"));
    assert.match(finalizeFence, new RegExp(field, "u"));
  }
  assert.match(
    findFence,
    /\$\{OUTBOX_EXACT_DELIVERY_RELEASE_RECEIPT_SQL\}/u,
  );
  assert.match(
    finalizeFence,
    /gmailProofAuthorizesFence\(authorityClass, input\.proof\)/u,
  );
  assert.match(
    finalizeFence,
    /\$\{OUTBOX_EXACT_DELIVERY_RELEASE_RECEIPT_SQL\}[\s\S]*?= \$20::text/u,
  );
});

test(
  "the image entrypoint expands database and Gmail file secrets before exec",
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
        environment[`${name}_FILE`] = posixPath(file);
      }
      const result = spawnSync(
        posixShell,
        [
          posixPath(path.join(root, "infra/docker/entrypoint.sh")),
          posixPath(process.execPath),
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
  () => {
    const entrypoint = posixPath(path.join(root, "infra/docker/entrypoint.sh"));
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
        posixShell,
        [entrypoint, posixPath(process.execPath), "-e", 'process.stdout.write("unexpected")'],
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
      posixShell,
      [entrypoint, posixPath(process.execPath), "-e", 'process.stdout.write("ok")'],
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
