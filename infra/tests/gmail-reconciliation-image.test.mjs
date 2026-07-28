import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { register } from "tsx/cjs/api";

const root = path.resolve(import.meta.dirname, "../..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const { reconciliationApi, lookupApi } = (() => {
  const unregisterTypescript = register();
  try {
    const requireTypescript = createRequire(import.meta.url);
    return {
      reconciliationApi: requireTypescript(
        path.join(root, "src/lib/notifications/gmail-reconciliation.ts"),
      ),
      lookupApi: requireTypescript(
        path.join(root, "src/lib/notifications/gmail-correlation-lookup.ts"),
      ),
    };
  } finally {
    unregisterTypescript();
  }
})();
const { reconcileGmailDelivery } = reconciliationApi;
const { findGmailMessageByMessageId } = lookupApi;

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function discoverPosixShell() {
  if (process.platform !== "win32") return "sh";
  const candidates = [];
  for (const rawDirectory of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"(.*)"$/u, "$1");
    if (directory === "") continue;
    candidates.push(path.join(directory, "sh.exe"));
    const parent = path.dirname(directory);
    if (
      path.basename(directory).toLowerCase() === "cmd"
      && path.basename(parent).toLowerCase() === "git"
    ) {
      candidates.push(
        path.join(parent, "bin", "sh.exe"),
        path.join(parent, "usr", "bin", "sh.exe"),
      );
    }
  }
  const shell = [...new Set(
    candidates.map((candidate) => path.resolve(candidate)),
  )].find(isExecutable);
  assert.ok(
    shell,
    "Git for Windows sh.exe must be discoverable through PATH.",
  );
  return shell;
}

const posixShell = discoverPosixShell();

function posixPath(file) {
  if (process.platform !== "win32") return file;
  assert.ok(
    !file.includes("\0") && !/[\r\n]/u.test(file),
    `unsafe Windows path for Git Bash: ${file}`,
  );
  const normalized = path.resolve(file).replaceAll("\\", "/");
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

function composeSecretTargets(service) {
  const lines = service.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === "    secrets:");
  assert.notEqual(
    start,
    -1,
    "mail-worker must declare a secrets block",
  );
  const targets = new Map();
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^    \S/u.test(line)) break;
    const longForm = /^      - source: ([a-z0-9_]+)$/u.exec(line);
    if (longForm) {
      const target =
        /^        target: ([a-z0-9_]+)$/u.exec(lines[index + 1] ?? "");
      assert.ok(target, `secret ${longForm[1]} must declare a target`);
      targets.set(longForm[1], target[1]);
      index += 1;
      continue;
    }
    const shorthand = /^      - ([a-z0-9_]+)$/u.exec(line);
    if (shorthand) targets.set(shorthand[1], shorthand[1]);
  }
  return targets;
}

const RECONCILIATION_OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const RECONCILIATION_PAYLOAD_SHA256 = "b".repeat(64);
const RECONCILIATION_EVIDENCE_SHA256 = "c".repeat(64);
const RECONCILIATION_REQUEST_BODY_SHA256 = "d".repeat(64);
const RECONCILIATION_RELEASE_RECEIPT_SHA256 = "e".repeat(64);

function opaqueReconciliationFence(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    operationId: RECONCILIATION_OPERATION_ID,
    claimVersion: 4,
    userId: "learner-1",
    deliveryScopeKey: "a:learner-1",
    claimToken: null,
    claimOwner: null,
    leaseExpiresAt: null,
    adapter: "gmail",
    providerCallStartedAt: "2026-07-22 19:00:05+00",
    dispatchBindingVersion: "gmail-raw-v1",
    dispatchBindingSha256: RECONCILIATION_PAYLOAD_SHA256,
    providerCorrelationVersion: "opaque-sha256-v1",
    providerEvidenceVersion: "gmail-header-evidence-v1",
    providerEvidenceSha256: RECONCILIATION_EVIDENCE_SHA256,
    providerRequestBodySha256: RECONCILIATION_REQUEST_BODY_SHA256,
    providerRequestBodyLength: 128,
    releaseReceiptSha256: RECONCILIATION_RELEASE_RECEIPT_SHA256,
    quarantinedAt: "2026-07-22 19:01:05+00",
    lastErrorCode: "PROVIDER_OUTCOME_AMBIGUOUS",
    ...overrides,
  };
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
  const inspectCommand =
    /^docker compose --env-file \/etc\/learncoding\/compose\.env -f \/opt\/learncoding\/compose\.yaml run --rm --no-deps -e GMAIL_RECONCILIATION_ENABLED=true mail-worker node --import tsx \/app\/scripts\/reconcile-gmail-outbox\.ts --operation-id <operation-uuid>$/mu;
  const applyCommand =
    /^docker compose --env-file \/etc\/learncoding\/compose\.env -f \/opt\/learncoding\/compose\.yaml run --rm --no-deps -e GMAIL_RECONCILIATION_ENABLED=true mail-worker node --import tsx \/app\/scripts\/reconcile-gmail-outbox\.ts --operation-id <operation-uuid> --apply --confirm-operation-id <same-operation-uuid>$/mu;

  assert.match(
    runbook,
    inspectCommand,
    "inspect must use the exact production Compose authority and operation ID",
  );
  assert.match(
    runbook,
    applyCommand,
    "apply must bind and confirm the same operation ID",
  );
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
  assert.doesNotMatch(
    workerService,
    /^    entrypoint:/mu,
    "mail-worker must inherit the reviewed image entrypoint",
  );
  const secretTargets = composeSecretTargets(workerService);
  for (const [source, target] of [
    ["database_worker_url", "database_url"],
    ["deletion_tombstone_key", "deletion_tombstone_key"],
    ["gmail_client_id", "gmail_client_id"],
    ["gmail_client_secret", "gmail_client_secret"],
    ["gmail_refresh_token", "gmail_refresh_token"],
  ]) {
    assert.equal(
      secretTargets.get(source),
      target,
      `mail-worker secret ${source} must mount at ${target}`,
    );
  }
  const entrypoint = read("infra/docker/entrypoint.sh");
  assert.match(entrypoint, /REQUIRE_DELETION_TOMBSTONE_KEY/u);
  assert.match(
    entrypoint,
    /DELETION_TOMBSTONE_KEY must be at least 32 characters/u,
  );
});

test("the reconciliation operator preserves the guarded exact-evidence fence", async () => {
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

  const rejectedFences = await Promise.all([
    { providerRequestBodySha256: null },
    { providerRequestBodyLength: null },
    { releaseReceiptSha256: null },
  ].map(async (missingEvidence) => {
    let lookupCalls = 0;
    let finalizeCalls = 0;
    const result = await reconcileGmailDelivery({
      operationId: RECONCILIATION_OPERATION_ID,
      apply: true,
      confirmOperationId: RECONCILIATION_OPERATION_ID,
    }, {
      store: {
        async findGmailReconciliationFence() {
          return {
            kind: "ready",
            fence: opaqueReconciliationFence(missingEvidence),
          };
        },
        async finalizeGmailReconciliation() {
          finalizeCalls += 1;
          return { kind: "applied" };
        },
      },
      gmail: {
        async findByMessageId() {
          lookupCalls += 1;
          return {
            kind: "matched",
            providerMessageId: "gmail-missing-evidence",
            proof: {
              kind: "header-evidence-v1",
              providerEvidenceSha256: RECONCILIATION_EVIDENCE_SHA256,
            },
          };
        },
      },
    });
    return { result, lookupCalls, finalizeCalls };
  }));
  assert.deepEqual(
    rejectedFences,
    [
      { result: { kind: "not-reconcilable" }, lookupCalls: 0, finalizeCalls: 0 },
      { result: { kind: "not-reconcilable" }, lookupCalls: 0, finalizeCalls: 0 },
      { result: { kind: "not-reconcilable" }, lookupCalls: 0, finalizeCalls: 0 },
    ],
    "an incomplete exact-delivery fence must fail before Gmail lookup",
  );

  const legacyBoundFence = opaqueReconciliationFence({
    providerCorrelationVersion: "legacy-raw-v0",
    providerEvidenceVersion: null,
    providerEvidenceSha256: null,
    providerRequestBodySha256: null,
    providerRequestBodyLength: null,
  });
  async function reconcileLegacyProof(proof) {
    let finalizeCalls = 0;
    const result = await reconcileGmailDelivery({
      operationId: RECONCILIATION_OPERATION_ID,
      apply: true,
      confirmOperationId: RECONCILIATION_OPERATION_ID,
    }, {
      store: {
        async findGmailReconciliationFence() {
          return { kind: "ready", fence: legacyBoundFence };
        },
        async finalizeGmailReconciliation() {
          finalizeCalls += 1;
          return { kind: "applied" };
        },
      },
      gmail: {
        async findByMessageId() {
          return {
            kind: "matched",
            providerMessageId: "gmail-legacy-bound",
            proof,
          };
        },
      },
    });
    return { result, finalizeCalls };
  }
  assert.deepEqual(
    await reconcileLegacyProof({
      kind: "raw-sha256-v1",
      adapterPayloadSha256: "f".repeat(64),
    }),
    { result: { kind: "ambiguous" }, finalizeCalls: 0 },
    "a mismatched raw proof must not authorize finalization",
  );
  assert.deepEqual(
    await reconcileLegacyProof({
      kind: "raw-sha256-v1",
      adapterPayloadSha256: RECONCILIATION_PAYLOAD_SHA256,
    }),
    { result: { kind: "applied" }, finalizeCalls: 1 },
    "the exact raw proof should authorize one finalization",
  );

  const lookupMessageId =
    `<codestead.outbox.${RECONCILIATION_OPERATION_ID}@mail.codestead.invalid>`;
  const rawLookupMessage = Buffer.from(
    `Message-ID: ${lookupMessageId}\r\n\r\nbody`,
    "ascii",
  ).toString("base64url");
  const lookupEnvironmentNames = [
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REFRESH_TOKEN",
    "GMAIL_REQUEST_TIMEOUT_MS",
  ];
  const originalLookupEnvironment = new Map(
    lookupEnvironmentNames.map((name) => [name, process.env[name]]),
  );
  const originalFetch = globalThis.fetch;
  const lookupRequests = [];
  const lookupResponses = [
    new Response(JSON.stringify({ access_token: "access-token" }), {
      status: 200,
    }),
    new Response(JSON.stringify({ messages: [{ id: "gmail-mismatch" }] }), {
      status: 200,
    }),
    new Response(JSON.stringify({
      id: "gmail-mismatch",
      labelIds: ["SENT"],
      raw: rawLookupMessage,
    }), { status: 200 }),
  ];
  try {
    process.env.GMAIL_CLIENT_ID = "client-id";
    process.env.GMAIL_CLIENT_SECRET = "client-secret";
    process.env.GMAIL_REFRESH_TOKEN = "refresh-token";
    process.env.GMAIL_REQUEST_TIMEOUT_MS = "10000";
    globalThis.fetch = async (input) => {
      lookupRequests.push(String(input));
      const response = lookupResponses.shift();
      assert.ok(response, "unexpected extra Gmail request");
      return response;
    };
    assert.deepEqual(
      await findGmailMessageByMessageId({
        messageId: lookupMessageId,
        authority: {
          kind: "legacy-raw-bound-v1",
          adapterPayloadSha256: RECONCILIATION_PAYLOAD_SHA256,
        },
      }),
      { kind: "ambiguous" },
      "a mismatched Gmail RAW body must fail closed",
    );
    assert.equal(lookupRequests.length, 3);
    assert.equal(
      new URL(lookupRequests[2]).searchParams.get("format"),
      "raw",
      "bound lookup must fetch Gmail RAW bytes before deciding",
    );
  } finally {
    for (const [name, value] of originalLookupEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
  }

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
  const observedFinalizer = sourceBetween(
    finalizeFence,
    "      const observed = await client.query<CandidateRow>(",
    "      const row = observed.rows[0];",
    "Gmail reconciliation observed-row finalizer",
  );
  const updateFinalizer = sourceBetween(
    finalizeFence,
    "      const result = await client.query<ReconciliationTerminalRow>(",
    "      const updated = result.rows[0];",
    "Gmail reconciliation terminal update finalizer",
  );
  const finalizerPredicates = [
    "where id = $1::uuid",
    "and operation_id = $2::uuid",
    "and claim_version = $3::integer",
    "and user_id is not distinct from $4::text",
    "and delivery_scope_key = $5::text",
    "and (${OUTBOX_EXACT_DELIVERY_RELEASE_SQL})",
    "and adapter = $6::text",
    "and claim_token is not distinct from $7::uuid",
    "and claim_owner is not distinct from $8::text",
    "and lease_expires_at is not distinct from $9::timestamptz",
    "and provider_call_started = $10::timestamptz",
    "and quarantined_at = $11::timestamptz",
    "and last_error_code = $12::text",
    "and dispatch_binding_version is not distinct from $13::text",
    "and dispatch_binding_sha256 is not distinct from $14::text",
    "and provider_correlation_version = $15::text",
    "and provider_evidence_version is not distinct from $16::text",
    "and provider_evidence_sha256 is not distinct from $17::text",
    "and provider_request_body_sha256 is not distinct from $18::text",
    "and provider_request_body_length is not distinct from $19::bigint",
    "and (${OUTBOX_EXACT_DELIVERY_RELEASE_RECEIPT_SQL}) = $20::text",
    "and provider_message_id is null",
    "and sent_at is null",
    "and status = 'quarantined'",
  ];
  for (const [label, query] of [
    ["observed-row query", observedFinalizer],
    ["terminal update query", updateFinalizer],
  ]) {
    for (const predicate of finalizerPredicates) {
      assert.ok(
        query.includes(predicate),
        `${label} must retain exact fence predicate: ${predicate}`,
      );
    }
  }

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
      const environment = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        NODE_ENV: "test",
      };
      for (const [name, value] of Object.entries(values)) {
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
      assert.ifError(result.error);
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
      assert.ifError(result.error);
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
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "ok");
    assert.equal(result.stderr, "");
  },
);
