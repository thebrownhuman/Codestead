import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

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
    store: read("src/lib/notifications/postgres-outbox-store.ts"),
    transport: read("src/lib/notifications/mailer-transport-internal.ts"),
    runtimePolicy: read("src/lib/notifications/mail-dispatch-runtime-policy.ts"),
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

function policyObjectBody(document, name) {
  const pattern = new RegExp(
    `export const ${name} = Object\\.freeze\\(\\{([\\s\\S]*?)\\n\\}\\);`,
    "u",
  );
  const match = pattern.exec(document);
  assert.ok(match, `missing runtime policy object ${name}`);
  return match[1];
}

function policyInteger(document, objectName, propertyName) {
  const body = policyObjectBody(document, objectName);
  const pattern = new RegExp(
    `^\\s*${propertyName}:\\s*([0-9][0-9_]*),\\s*$`,
    "mu",
  );
  const match = pattern.exec(body);
  assert.ok(match, `missing ${objectName}.${propertyName}`);
  return Number(match[1].replaceAll("_", ""));
}

function runtimePolicy(document) {
  const limit = (name) =>
    policyInteger(document, "MAIL_DISPATCH_RUNTIME_LIMITS", name);
  const defaultValue = (name) =>
    policyInteger(document, "MAIL_DISPATCH_RUNTIME_DEFAULTS", name);
  return {
    minimumHardWatchdogLeadMs: limit("minimumHardWatchdogLeadMs"),
    minimumPostProviderDatabaseFallbackLeadMs: limit(
      "minimumPostProviderDatabaseFallbackLeadMs",
    ),
    poolAcquireMs: policyInteger(
      document, "MAIL_DISPATCH_RUNTIME_BOOTSTRAP", "poolAcquireTimeoutMs",
    ),
    tx1Ms: defaultValue("tx1TimeoutMs"),
    oauthDeadlineMs: defaultValue("oauthDeadlineMs"),
    guardedSendDeadlineMs: defaultValue("guardedSendDeadlineMs"),
    providerAbortSettlementMs: defaultValue(
      "providerAbortSettlementTimeoutMs",
    ),
    fatalExitMarginMs: defaultValue("fatalExitMarginMs"),
    postProviderIdleMs: defaultValue(
      "postProviderInitiationIdleInTransactionSessionTimeoutMs",
    ),
    postProviderTransactionMs: defaultValue(
      "postProviderInitiationTransactionTimeoutMs",
    ),
    preProviderTx2PhaseMs: defaultValue("preProviderTx2PhaseBudgetMs"),
    postProviderTx2PhaseMs: defaultValue("postProviderTx2PhaseBudgetMs"),
    watchdogArmAckMs: defaultValue("watchdogArmAckTimeoutMs"),
    watchdogTeardownConfirmationMs: defaultValue(
      "watchdogTeardownConfirmationTimeoutMs",
    ),
    watchdogDisarmDeliveryMs: defaultValue(
      "watchdogDisarmDeliveryTimeoutMs",
    ),
    hardWatchdogMs: defaultValue("hardWatchdogMs"),
    persistenceMarginMs: defaultValue("persistenceMarginMs"),
    postCommitProviderLeaseMs: defaultValue("postCommitProviderLeaseMs"),
    providerLeaseStampMs: defaultValue("providerLeaseStampMs"),
  };
}

const plannedProviderLeasePolicies = new Map();

async function plannedProviderLeasePolicy(document) {
  let pending = plannedProviderLeasePolicies.get(document);
  if (pending !== undefined) return pending;
  pending = (async () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "codestead-mail-runtime-policy-"),
    );
    const source = path.join(directory, "mail-dispatch-runtime-policy.ts");
    try {
      writeFileSync(source, document, "utf8");
      const imported = await tsImport(
        pathToFileURL(source).href,
        import.meta.url,
      );
      const api = imported.default ?? imported;
      return api.planMailDispatchRuntime().providerLease;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  })();
  plannedProviderLeasePolicies.set(document, pending);
  return pending;
}

async function assertContract(input) {
  const defaultMs = integerConstant(input.transport, "DEFAULT_GMAIL_REQUEST_TIMEOUT_MS");
  const minimumMs = integerConstant(input.transport, "MIN_GMAIL_REQUEST_TIMEOUT_MS");
  const maximumMs = integerConstant(input.transport, "MAX_GMAIL_REQUEST_TIMEOUT_MS");
  const abortSettlementMs = integerConstant(
    input.transport,
    "GMAIL_ABORT_SETTLEMENT_RESERVE_MS",
  );
  const exactOauthDeadlineMs = integerConstant(
    input.transport,
    "EXACT_OAUTH_DEADLINE_MS",
  );
  const exactGuardedSendDeadlineMs = integerConstant(
    input.transport,
    "EXACT_GUARDED_SEND_DEADLINE_MS",
  );
  const parsedPolicy = runtimePolicy(input.runtimePolicy);
  const plannedLease = await plannedProviderLeasePolicy(input.runtimePolicy);
  const policy = {
    ...parsedPolicy,
    tx1Ms: plannedLease.tx1CommitAckAllowanceMs,
    postCommitProviderLeaseMs: plannedLease.postCommitProviderLeaseMs,
    providerLeaseStampMs: plannedLease.providerLeaseStampMs,
  };
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

  assert.equal(rootDefault, defaultMs, "developer environment default drifted from the transport");
  assert.equal(
    infrastructureDefault,
    defaultMs,
    "infrastructure environment default drifted from the transport",
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
    input.transport,
    /process\.env\.GMAIL_REQUEST_TIMEOUT_MS\?\.trim\(\)/u,
    "the Gmail adapter must consume the configured deadline",
  );
  assert.ok(minimumMs > 0 && minimumMs <= defaultMs && defaultMs <= maximumMs);
  assert.equal(
    maximumMs + abortSettlementMs,
    exactOauthDeadlineMs,
    "the configured request ceiling plus abort settlement must fill the aggregate OAuth deadline",
  );
  assert.equal(policy.oauthDeadlineMs, exactOauthDeadlineMs);
  assert.equal(policy.guardedSendDeadlineMs, exactGuardedSendDeadlineMs);
  assert.equal(policy.providerAbortSettlementMs, abortSettlementMs);
  assert.match(
    input.store,
    /const leaseStampMs =\s*storeRuntime\.startupInspection\.plan\.providerLease\.providerLeaseStampMs;/u,
    "the outbox store must consume the planner-derived provider lease stamp",
  );
  assert.equal(
    policy.providerLeaseStampMs,
    policy.tx1Ms + policy.postCommitProviderLeaseMs,
    "the physical provider lease stamp must include the complete TX1 acknowledgement allowance",
  );
  const leasedDispatchPathMs =
    policy.oauthDeadlineMs +
    policy.watchdogArmAckMs +
    policy.poolAcquireMs +
    policy.postProviderTransactionMs +
    policy.persistenceMarginMs;
  assert.ok(
    leasedDispatchPathMs < policy.postCommitProviderLeaseMs,
    "the post-COMMIT OAuth and guarded TX2 path can exhaust the provider lease",
  );
  const lockedProviderWindowMs =
    policy.guardedSendDeadlineMs +
    policy.providerAbortSettlementMs +
    policy.fatalExitMarginMs;
  const tx2PathMs =
    policy.preProviderTx2PhaseMs +
    lockedProviderWindowMs +
    policy.postProviderTx2PhaseMs;
  const watchdogControlPathMs =
    policy.watchdogArmAckMs +
    policy.poolAcquireMs +
    tx2PathMs +
    policy.watchdogTeardownConfirmationMs +
    policy.watchdogDisarmDeliveryMs;
  assert.ok(
    watchdogControlPathMs + policy.minimumHardWatchdogLeadMs <=
      policy.hardWatchdogMs,
    "the guarded TX2 control path does not retain the hard-watchdog lead",
  );
  const minimumDatabaseFallbackMs =
    policy.hardWatchdogMs +
    policy.minimumPostProviderDatabaseFallbackLeadMs;
  assert.ok(
    minimumDatabaseFallbackMs <= policy.postProviderIdleMs,
    "the post-provider idle fallback can fire before the hard watchdog",
  );
  assert.ok(
    minimumDatabaseFallbackMs <= policy.postProviderTransactionMs,
    "the post-provider transaction fallback can fire before the hard watchdog",
  );
}

function replaceExactly(document, needle, replacement, label) {
  const pieces = document.split(needle);
  assert.equal(pieces.length, 2, `mutation expected exactly one ${label}`);
  return `${pieces[0]}${replacement}${pieces[1]}`;
}

test("Gmail request timeout configuration is consistent and lease-safe", async () => {
  await assertContract(sources());
});

test("Gmail request timeout contract rejects cross-layer and safety drift", async () => {
  const baseline = sources();
  const dormantProviderLeaseDefault = replaceExactly(
    baseline.runtimePolicy,
    "  providerLeaseStampMs: 110_000,",
    "  providerLeaseStampMs: 109_999,",
    "dormant provider lease stamp default",
  );
  await assert.doesNotReject(() =>
    assertContract({
      ...baseline,
      runtimePolicy: dormantProviderLeaseDefault,
    }),
  );
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
      "transport request ceiling",
      { transport: replaceExactly(
        baseline.transport,
        "const MAX_GMAIL_REQUEST_TIMEOUT_MS = 15_000;",
        "const MAX_GMAIL_REQUEST_TIMEOUT_MS = 15_001;",
        "transport request ceiling",
      ) },
    ],
    [
      "active provider lease stamp derivation",
      { runtimePolicy: replaceExactly(
        baseline.runtimePolicy,
        "const expectedProviderLeaseStampMs = tx1TimeoutMs + postCommitProviderLeaseMs;",
        "const expectedProviderLeaseStampMs = tx1TimeoutMs + postCommitProviderLeaseMs + 1;",
        "active provider lease stamp derivation",
      ) },
    ],
    [
      "runtime provider lease stamp consumer",
      { store: replaceExactly(
        baseline.store,
        "startupInspection.plan.providerLease.providerLeaseStampMs",
        "startupInspection.plan.providerLease.postCommitProviderLeaseMs",
        "runtime provider lease stamp consumer",
      ) },
    ],
    [
      "provider persistence margin",
      { runtimePolicy: replaceExactly(
        baseline.runtimePolicy,
        "  persistenceMarginMs: 5_000,",
        "  persistenceMarginMs: 11_000,",
        "provider persistence margin",
      ) },
    ],
    [
      "hard-watchdog lead",
      { runtimePolicy: replaceExactly(
        baseline.runtimePolicy,
        "  hardWatchdogMs: 55_000,",
        "  hardWatchdogMs: 54_999,",
        "hard-watchdog lead",
      ) },
    ],
    [
      "post-provider idle fallback",
      { runtimePolicy: replaceExactly(
        baseline.runtimePolicy,
        "  postProviderInitiationIdleInTransactionSessionTimeoutMs: 60_000,",
        "  postProviderInitiationIdleInTransactionSessionTimeoutMs: 59_999,",
        "post-provider idle fallback",
      ) },
    ],
    [
      "post-provider transaction fallback",
      { runtimePolicy: replaceExactly(
        baseline.runtimePolicy,
        "  postProviderInitiationTransactionTimeoutMs: 60_000,",
        "  postProviderInitiationTransactionTimeoutMs: 59_999,",
        "post-provider transaction fallback",
      ) },
    ],
  ];

  for (const [label, override] of mutations) {
    await assert.rejects(
      () => assertContract({ ...baseline, ...override }),
      undefined,
      label,
    );
  }
});
