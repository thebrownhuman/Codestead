import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file) => readFileSync(path.join(root, file), "utf8");
const MAIL_WORKER_ENVIRONMENT_ALLOWLIST = [
  "APP_URL",
  "DATABASE_URL_FILE",
  "DELETION_TOMBSTONE_KEY_FILE",
  "GMAIL_CLIENT_ID_FILE",
  "GMAIL_CLIENT_SECRET_FILE",
  "GMAIL_OAUTH_SCOPES",
  "GMAIL_REFRESH_TOKEN_FILE",
  "GMAIL_REQUEST_TIMEOUT_MS",
  "LOG_LEVEL",
  "LOST_DEVICE_PROOF_KEY_FILE",
  "MAIL_ADAPTER",
  "MAIL_FROM",
  "MAIL_OUTBOX_PHASE",
  "NODE_ENV",
  "OUTBOX_POLL_SECONDS",
  "OUTBOX_WORKER_MODE",
  "REQUIRE_DELETION_TOMBSTONE_KEY",
  "REQUIRE_LOST_DEVICE_PROOF_KEY",
  "WORKER_HEALTH_ID",
  "WORKER_HEALTH_MAX_AGE_SECONDS",
  "WORKER_HEALTH_MAX_FAILURES",
].sort();
const RECONCILIATION_SCOPE_DECLARATION =
  "https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/gmail.readonly";


function sources(overrides = {}) {
  return {
    rootEnvironment: read(".env.example"),
    compose: read("compose.yaml"),
    infrastructureEnvironment: read("infra/env/compose.env.example"),
    mailer: read("src/lib/notifications/mailer.ts"),
    worker: read("scripts/process-outbox.ts"),
    store: read("src/lib/notifications/postgres-outbox-store.ts"),
    ...overrides,
  };
}

function serviceBlock(compose, name) {
  const start = compose.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `missing Compose service ${name}`);
  const remainder = compose.slice(start + 1);
  const next = remainder.search(/^  [a-zA-Z0-9][a-zA-Z0-9-]*:\s*$/mu);
  return next === -1 ? compose.slice(start) : compose.slice(start, start + 1 + next);
}

function environmentKeys(service) {
  const lines = service.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === "    environment:");
  assert.notEqual(start, -1, "mail-worker must declare an environment block");
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    const match = /^      ([A-Z][A-Z0-9_]*):/u.exec(line);
    if (match) {
      keys.push(match[1]);
      continue;
    }
    if (/^    \S/u.test(line)) break;
  }
  return keys.sort();
}

function environmentValue(document, name) {
  const pattern = new RegExp(`^${name}=([^\\r\\n]*)$`, "gmu");
  const matches = [...document.matchAll(pattern)];
  assert.equal(matches.length, 1, `${name} must have exactly one environment assignment`);
  return matches[0][1];
}

function integerConstant(document, name) {
  const pattern = new RegExp(`^const ${name} = ([0-9][0-9_]*);$`, "mu");
  const match = pattern.exec(document);
  assert.ok(match, `missing integer constant ${name}`);
  return Number(match[1].replaceAll("_", ""));
}

function assertContract(input) {
  const defaultMs = integerConstant(input.mailer, "DEFAULT_GMAIL_REQUEST_TIMEOUT_MS");
  const minimumMs = integerConstant(input.mailer, "MIN_GMAIL_REQUEST_TIMEOUT_MS");
  const maximumMs = integerConstant(input.mailer, "MAX_GMAIL_REQUEST_TIMEOUT_MS");
  const providerLeaseMs = integerConstant(input.worker, "PROVIDER_LEASE_MS");
  const rootDefault = Number(environmentValue(input.rootEnvironment, "GMAIL_REQUEST_TIMEOUT_MS"));
  const infrastructureDefault = Number(
    environmentValue(input.infrastructureEnvironment, "GMAIL_REQUEST_TIMEOUT_MS"),
  );
  const rootScopes = environmentValue(input.rootEnvironment, "GMAIL_OAUTH_SCOPES");
  const infrastructureScopes = environmentValue(
    input.infrastructureEnvironment,
    "GMAIL_OAUTH_SCOPES",
  );
  const mailWorker = serviceBlock(input.compose, "mail-worker");
  const app = serviceBlock(input.compose, "app");

  assert.equal(rootDefault, defaultMs, "developer environment default drifted from the mailer");
  assert.equal(
    infrastructureDefault,
    defaultMs,
    "infrastructure environment default drifted from the mailer",
  );
  assert.equal(rootScopes, "", "developer scope declaration must default closed");
  assert.equal(
    infrastructureScopes,
    RECONCILIATION_SCOPE_DECLARATION,
    "infrastructure Gmail scope declaration drifted",
  );
  for (const [label, document] of [
    ["developer", input.rootEnvironment],
    ["infrastructure", input.infrastructureEnvironment],
  ]) {
    assert.equal(
      environmentValue(document, "MAIL_OUTBOX_PHASE"),
      "dual-write-v1",
      `${label} environment mail phase drifted`,
    );
    assert.equal(
      environmentValue(document, "OUTBOX_WORKER_MODE"),
      "fenced-postgres-v1",
      `${label} environment mail claimant drifted`,
    );
  }
  assert.deepEqual(
    environmentKeys(mailWorker),
    MAIL_WORKER_ENVIRONMENT_ALLOWLIST,
    "mail-worker environment allowlist drifted",
  );
  assert.match(
    mailWorker,
    /^      GMAIL_REQUEST_TIMEOUT_MS: \$\{GMAIL_REQUEST_TIMEOUT_MS:-10000\}$/mu,
    "mail-worker must forward the bounded setting with the reviewed default",
  );
  assert.match(
    mailWorker,
    /^      GMAIL_OAUTH_SCOPES: \$\{GMAIL_OAUTH_SCOPES:-\}$/mu,
    "mail-worker must forward only the explicit non-secret scope declaration",
  );
  assert.match(
    mailWorker,
    /^      REQUIRE_DELETION_TOMBSTONE_KEY: "1"$/mu,
    "mail-worker must fail closed when the deletion capability key is unavailable",
  );
  assert.doesNotMatch(app, /GMAIL_REQUEST_TIMEOUT_MS/u, "the app service must not receive the Gmail setting");
  assert.doesNotMatch(app, /GMAIL_OAUTH_SCOPES/u, "the app service must not receive Gmail scopes");
  assert.match(
    input.mailer,
    /process\.env\.GMAIL_REQUEST_TIMEOUT_MS\?\.trim\(\)/u,
    "the Gmail adapter must consume the configured deadline",
  );
  assert.ok(minimumMs > 0 && minimumMs <= defaultMs && defaultMs <= maximumMs);

  const graceMatches = [
    ...input.store.matchAll(
      /lease_expires_at < pg_catalog\.statement_timestamp\(\) - interval '([0-9]+) seconds'/gu,
    ),
  ].map((match) => Number(match[1]) * 1_000);
  assert.ok(graceMatches.length >= 2, "abandoned-work sweep grace must guard selection and update");
  assert.equal(new Set(graceMatches).size, 1, "abandoned-work sweep grace predicates drifted");
  const sweepGraceMs = graceMatches[0];
  assert.ok(maximumMs < sweepGraceMs, "one Gmail request can outlive abandoned-work sweep grace");
  assert.ok(
    maximumMs * 2 < providerLeaseMs,
    "sequential OAuth and delivery requests can exhaust the provider lease",
  );
}

function replaceExactly(document, needle, replacement, label) {
  const pieces = document.split(needle);
  assert.equal(pieces.length, 2, `mutation expected exactly one ${label}`);
  return `${pieces[0]}${replacement}${pieces[1]}`;
}

test("Gmail request timeout configuration is consistent and lease-safe", () => {
  assertContract(sources());
});

test("Gmail request timeout contract rejects cross-layer and safety drift", () => {
  const baseline = sources();
  const mutations = [
    [
      "developer default",
      { rootEnvironment: replaceExactly(
        baseline.rootEnvironment,
        "GMAIL_REQUEST_TIMEOUT_MS=10000",
        "GMAIL_REQUEST_TIMEOUT_MS=10001",
        "developer default",
      ) },
    ],
    [
      "infrastructure allowlist",
      { infrastructureEnvironment: replaceExactly(
        baseline.infrastructureEnvironment,
        "GMAIL_REQUEST_TIMEOUT_MS=10000",
        "",
        "infrastructure allowlist",
      ) },
    ],
    [
      "Compose forwarding",
      { compose: replaceExactly(
        baseline.compose,
        "      GMAIL_REQUEST_TIMEOUT_MS: ${GMAIL_REQUEST_TIMEOUT_MS:-10000}",
        "",
        "Compose forwarding",
      ) },
    ],
    [
      "OAuth scope declaration",
      { infrastructureEnvironment: replaceExactly(
        baseline.infrastructureEnvironment,
        `GMAIL_OAUTH_SCOPES=${RECONCILIATION_SCOPE_DECLARATION}`,
        "GMAIL_OAUTH_SCOPES=https://www.googleapis.com/auth/gmail.send",
        "OAuth scope declaration",
      ) },
    ],
    [
      "OAuth scope forwarding",
      { compose: replaceExactly(
        baseline.compose,
        "      GMAIL_OAUTH_SCOPES: ${GMAIL_OAUTH_SCOPES:-}",
        "",
        "OAuth scope forwarding",
      ) },
    ],
    [
      "deletion capability key requirement",
      { compose: replaceExactly(
        baseline.compose,
        '      REQUIRE_DELETION_TOMBSTONE_KEY: "1"',
        '      REQUIRE_DELETION_TOMBSTONE_KEY: "0"',
        "deletion capability key requirement",
      ) },
    ],
    [
      "sweep grace",
      { store: baseline.store.replaceAll("interval '30 seconds'", "interval '20 seconds'") },
    ],
    [
      "provider lease",
      { worker: replaceExactly(
        baseline.worker,
        "const PROVIDER_LEASE_MS = 300_000;",
        "const PROVIDER_LEASE_MS = 40_000;",
        "provider lease",
      ) },
    ],
  ];

  for (const [label, override] of mutations) {
    assert.throws(() => assertContract({ ...baseline, ...override }), undefined, label);
  }
});
