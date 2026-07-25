import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const modulePath = new URL("./enqueue-backup-status.mjs", import.meta.url);
const implementation = existsSync(modulePath)
  ? await import(modulePath)
  : null;

const reporterUrl =
  "postgresql://learncoding_backup_reporter:"
  + "a".repeat(64)
  + "@postgres:5432/learncoding";

const reporterEnvironment = Object.freeze({
  BACKUP_STATUS_REPORTER_CONNECTION_TIMEOUT_MS: "5000",
  BACKUP_STATUS_REPORTER_QUERY_TIMEOUT_MS: "6000",
  BACKUP_STATUS_REPORTER_STATEMENT_TIMEOUT_MS: "5000",
  BACKUP_STATUS_REPORTER_LOCK_TIMEOUT_MS: "3000",
  BACKUP_STATUS_REPORTER_IDLE_IN_TRANSACTION_TIMEOUT_MS: "5000",
  BACKUP_STATUS_REPORTER_POOL_IDLE_TIMEOUT_MS: "2000",
  BACKUP_STATUS_REPORTER_POOL_SHUTDOWN_TIMEOUT_MS: "2000",
});

const authorityRow = Object.freeze({
  acknowledgement: "queued",
  authority_id: "11111111-1111-4111-8111-111111111111",
  outbox_id: "22222222-2222-4222-8222-222222222222",
  operation_id: "33333333-3333-4333-8333-333333333333",
});

function reporterInput(overrides = {}) {
  return {
    databaseUrl: reporterUrl,
    databaseName: "learncoding",
    environment: reporterEnvironment,
    outcome: "success",
    runReceiptId: "44444444-4444-4444-8444-444444444444",
    ...overrides,
  };
}

function immediateDeadlineDependencies() {
  const delays = [];
  return {
    delays,
    setTimeout(callback, delay) {
      delays.push(delay);
      return setImmediate(callback);
    },
    clearTimeout(handle) {
      clearImmediate(handle);
    },
  };
}

let temporaryDirectory;

before(() => {
  temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "codestead-backup-status-reporter-"),
  );
});

after(() => {
  if (temporaryDirectory) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the dedicated backup-status reporter implementation exists", () => {
  assert.notEqual(implementation, null);
});

test("request validation accepts only the fixed outcome and durable run receipt UUID", {
  skip: implementation === null,
}, () => {
  assert.deepEqual(
    implementation.validateBackupStatusRequest({
      outcome: "success",
      runReceiptId: "44444444-4444-4444-8444-444444444444",
    }),
    { outcome: "success", runReceiptId: "44444444-4444-4444-8444-444444444444" },
  );
  assert.deepEqual(
    implementation.validateBackupStatusRequest({
      outcome: "failure",
      runReceiptId: "55555555-5555-4555-8555-555555555555",
    }),
    { outcome: "failure", runReceiptId: "55555555-5555-4555-8555-555555555555" },
  );
  for (const input of [
    { outcome: "SUCCESS", runReceiptId: "44444444-4444-4444-8444-444444444444" },
    { outcome: "success", runReceiptId: "../unsafe" },
    { outcome: "success", runReceiptId: "20260725T051500Z" },
    { outcome: "success", runReceiptId: "44444444-4444-4444-8444-444444444444\n" },
    { outcome: "success", runReceiptId: "44444444-4444-1444-8444-444444444444" },
  ]) {
    assert.throws(
      () => implementation.validateBackupStatusRequest(input),
      { message: "backup status reporter input is invalid" },
    );
  }
});

test("database URL validation accepts only the dedicated reporter topology", {
  skip: implementation === null,
}, () => {
  assert.equal(
    implementation.validateReporterDatabaseUrl(reporterUrl, "learncoding"),
    reporterUrl,
  );
  for (const candidate of [
    reporterUrl.replace("learncoding_backup_reporter", "learncoding"),
    reporterUrl.replace("@postgres:", "@localhost:"),
    reporterUrl.replace("/learncoding", "/postgres"),
    `${reporterUrl}?options=-csearch_path%3Dpublic`,
    reporterUrl.replace("a".repeat(64), "short"),
    `${reporterUrl}\n`,
  ]) {
    assert.throws(
      () => implementation.validateReporterDatabaseUrl(candidate, "learncoding"),
      { message: "backup status reporter database secret is invalid" },
    );
  }
});

test("reporter policy requires finite ordered bounds with no implicit defaults", {
  skip: implementation === null,
}, () => {
  assert.deepEqual(
    implementation.validateBackupStatusReporterPolicy(reporterEnvironment),
    {
      connectionTimeoutMillis: 5000,
      queryTimeoutMillis: 6000,
      statementTimeoutMillis: 5000,
      lockTimeoutMillis: 3000,
      idleInTransactionSessionTimeoutMillis: 5000,
      idleTimeoutMillis: 2000,
      shutdownTimeoutMillis: 2000,
    },
  );

  const {
    BACKUP_STATUS_REPORTER_QUERY_TIMEOUT_MS: omitted,
    ...missingQueryTimeout
  } = reporterEnvironment;
  assert.equal(omitted, "6000");
  for (const environment of [
    missingQueryTimeout,
    {
      ...reporterEnvironment,
      BACKUP_STATUS_REPORTER_QUERY_TIMEOUT_MS: "5000",
    },
    {
      ...reporterEnvironment,
      BACKUP_STATUS_REPORTER_LOCK_TIMEOUT_MS: "5000",
    },
    {
      ...reporterEnvironment,
      BACKUP_STATUS_REPORTER_CONNECTION_TIMEOUT_MS: "5001",
    },
    {
      ...reporterEnvironment,
      BACKUP_STATUS_REPORTER_QUERY_TIMEOUT_MS: "6001",
    },
  ]) {
    assert.throws(
      () => implementation.validateBackupStatusReporterPolicy(environment),
      { message: "backup status reporter policy is invalid" },
    );
  }
});

test("secret loading requires a bounded regular file and preserves no newline", {
  skip: implementation === null,
}, () => {
  const secretPath = path.join(temporaryDirectory, "database_backup_reporter_url");
  writeFileSync(secretPath, reporterUrl, { mode: 0o600 });
  assert.equal(implementation.readReporterDatabaseUrl(secretPath), reporterUrl);

  writeFileSync(secretPath, `${reporterUrl}\n`, { mode: 0o600 });
  assert.throws(
    () => implementation.readReporterDatabaseUrl(secretPath),
    { message: "backup status reporter database secret is invalid" },
  );
  assert.throws(
    () => implementation.readReporterDatabaseUrl(temporaryDirectory),
    { message: "backup status reporter database secret is invalid" },
  );
});

test("enqueue uses one private bounded connection and only the owner routine", {
  skip: implementation === null,
}, async () => {
  const calls = [];
  const releases = [];
  let ended = 0;
  const result = await implementation.enqueueBackupStatus(reporterInput(), {
    createPool: (options) => {
      assert.deepEqual(options, {
        connectionString: reporterUrl,
        max: 1,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 2000,
        query_timeout: 6000,
        statement_timeout: 5000,
        lock_timeout: 3000,
        idle_in_transaction_session_timeout: 5000,
        application_name: "codestead-backup-status-reporter",
      });
      return {
        async connect() {
          return {
            async query(sql, values) {
              calls.push({ sql, values });
              return {
                rowCount: 1,
                rows: [authorityRow],
              };
            },
            release(destroy) {
              releases.push(destroy);
            },
          };
        },
        async end() {
          ended += 1;
        },
      };
    },
  });

  assert.equal(result, "queued");
  assert.equal(ended, 1);
  assert.deepEqual(releases, [false]);
  assert.equal(calls.length, 1);
  assert.match(
    calls[0].sql,
    /^select acknowledgement, authority_id::text, outbox_id::text, operation_id::text\s+from public\.enqueue_backup_status_mail_authority\(\$1::uuid, \$2::text\)$/u,
  );
  assert.deepEqual(calls[0].values, ["44444444-4444-4444-8444-444444444444", "success"]);
  assert.doesNotMatch(calls[0].sql, /postgresql:|learncoding_backup_reporter|a{32}/u);
});

test("enqueue accepts exact and terminal-ledger replay acknowledgements", {
  skip: implementation === null,
}, async () => {
  for (const acknowledgement of ["existing", "suppressed", "forged"]) {
    let ended = 0;
    let released = 0;
    const action = implementation.enqueueBackupStatus(reporterInput({
      outcome: "failure",
      runReceiptId: "55555555-5555-4555-8555-555555555555",
    }), {
      createPool: () => ({
        async connect() {
          return {
            async query() {
              return {
                rowCount: 1,
                rows: acknowledgement === "suppressed"
                  ? [{
                      acknowledgement,
                      authority_id: null,
                      outbox_id: null,
                      operation_id: null,
                    }]
                  : [{ ...authorityRow, acknowledgement }],
              };
            },
            release(destroy) {
              assert.equal(destroy, acknowledgement === "forged");
              released += 1;
            },
          };
        },
        async end() {
          ended += 1;
        },
      }),
    });

    if (["existing", "suppressed"].includes(acknowledgement)) {
      assert.equal(await action, acknowledgement);
    } else {
      await assert.rejects(action, {
        message: "backup status reporter acknowledgement is invalid",
      });
    }
    assert.equal(released, 1);
    assert.equal(ended, 1);
  }
});

test("terminal-ledger suppression requires the explicit null identifier shape", {
  skip: implementation === null,
}, async () => {
  for (const row of [
    { ...authorityRow, acknowledgement: "suppressed" },
    {
      acknowledgement: "existing",
      authority_id: null,
      outbox_id: null,
      operation_id: null,
    },
  ]) {
    await assert.rejects(
      implementation.enqueueBackupStatus(reporterInput(), {
        createPool: () => ({
          async connect() {
            return {
              async query() {
                return { rowCount: 1, rows: [row] };
              },
              release() {},
            };
          },
          async end() {},
        }),
      }),
      { message: "backup status reporter acknowledgement is invalid" },
    );
  }
});

test("a hung connection fails with a fixed deadline and bounded pool shutdown", {
  skip: implementation === null,
}, async () => {
  const deadline = immediateDeadlineDependencies();
  let ended = 0;
  await assert.rejects(
    implementation.enqueueBackupStatus(reporterInput(), {
      ...deadline,
      createPool: () => ({
        connect() {
          return new Promise(() => {});
        },
        async end() {
          ended += 1;
        },
      }),
    }),
    { message: "backup status reporter connection timed out" },
  );
  assert.equal(ended, 1);
  assert.deepEqual(deadline.delays, [5000, 2000]);
});

test("a connection acquired after timeout is destroyed without becoming usable", {
  skip: implementation === null,
}, async () => {
  const deadline = immediateDeadlineDependencies();
  const releases = [];
  let resolveConnection;
  let queryCalls = 0;
  const action = implementation.enqueueBackupStatus(reporterInput(), {
    ...deadline,
    createPool: () => ({
      connect() {
        return new Promise((resolve) => {
          resolveConnection = resolve;
        });
      },
      async end() {},
    }),
  });
  await assert.rejects(action, {
    message: "backup status reporter connection timed out",
  });
  resolveConnection({
    query() {
      queryCalls += 1;
    },
    release(destroy) {
      releases.push(destroy);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queryCalls, 0);
  assert.deepEqual(releases, [true]);
});

test("a hung query destroys its connection and fails with a fixed deadline", {
  skip: implementation === null,
}, async () => {
  const deadline = immediateDeadlineDependencies();
  const releases = [];
  let resolveQuery;
  await assert.rejects(
    implementation.enqueueBackupStatus(reporterInput(), {
      ...deadline,
      createPool: () => ({
        async connect() {
          return {
            query() {
              return new Promise((resolve) => {
                resolveQuery = resolve;
              });
            },
            release(destroy) {
              releases.push(destroy);
            },
          };
        },
        async end() {},
      }),
    }),
    { message: "backup status reporter query timed out" },
  );
  resolveQuery({ rowCount: 1, rows: [authorityRow] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(releases, [true]);
  assert.deepEqual(deadline.delays, [5000, 6000, 2000]);
});

test("a hung pool shutdown fails with its fixed deadline after a valid query", {
  skip: implementation === null,
}, async () => {
  const deadline = immediateDeadlineDependencies();
  await assert.rejects(
    implementation.enqueueBackupStatus(reporterInput(), {
      ...deadline,
      createPool: () => ({
        async connect() {
          return {
            async query() {
              return { rowCount: 1, rows: [authorityRow] };
            },
            release(destroy) {
              assert.equal(destroy, false);
            },
          };
        },
        end() {
          return new Promise(() => {});
        },
      }),
    }),
    { message: "backup status reporter pool shutdown timed out" },
  );
  assert.deepEqual(deadline.delays, [5000, 6000, 2000]);
});

test("the one-shot process remains alive until its hard shutdown deadline fires", {
  skip: implementation === null,
}, () => {
  const proof = `
    import { enqueueBackupStatus } from ${JSON.stringify(modulePath.href)};
    const environment = {
      BACKUP_STATUS_REPORTER_CONNECTION_TIMEOUT_MS: "10",
      BACKUP_STATUS_REPORTER_QUERY_TIMEOUT_MS: "30",
      BACKUP_STATUS_REPORTER_STATEMENT_TIMEOUT_MS: "20",
      BACKUP_STATUS_REPORTER_LOCK_TIMEOUT_MS: "10",
      BACKUP_STATUS_REPORTER_IDLE_IN_TRANSACTION_TIMEOUT_MS: "20",
      BACKUP_STATUS_REPORTER_POOL_IDLE_TIMEOUT_MS: "10",
      BACKUP_STATUS_REPORTER_POOL_SHUTDOWN_TIMEOUT_MS: "20",
    };
    const input = {
      databaseUrl:
        "postgresql://learncoding_backup_reporter:"
        + "a".repeat(64)
        + "@postgres:5432/learncoding",
      databaseName: "learncoding",
      environment,
      outcome: "success",
      runReceiptId: "44444444-4444-4444-8444-444444444444",
    };
    const row = {
      acknowledgement: "queued",
      authority_id: "11111111-1111-4111-8111-111111111111",
      outbox_id: "22222222-2222-4222-8222-222222222222",
      operation_id: "33333333-3333-4333-8333-333333333333",
    };
    void enqueueBackupStatus(input, {
      createPool: () => ({
        async connect() {
          return {
            async query() {
              return { rowCount: 1, rows: [row] };
            },
            release() {},
          };
        },
        end() {
          return new Promise(() => {});
        },
      }),
    }).then(
      () => process.stdout.write("unexpected-success"),
      (error) => process.stdout.write(error.message),
    );
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", proof],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    child.stdout,
    "backup status reporter pool shutdown timed out",
  );
  assert.equal(child.stderr, "");
});

test("shutdown failure cannot mask the primary query failure", {
  skip: implementation === null,
}, async () => {
  const deadline = immediateDeadlineDependencies();
  const primary = new Error("primary reporter query failure");
  await assert.rejects(
    implementation.enqueueBackupStatus(reporterInput(), {
      ...deadline,
      createPool: () => ({
        async connect() {
          return {
            async query() {
              throw primary;
            },
            release(destroy) {
              assert.equal(destroy, true);
            },
          };
        },
        end() {
          return new Promise(() => {});
        },
      }),
    }),
    (error) => {
      assert.equal(error, primary);
      assert.equal(
        error.cause?.message,
        "backup status reporter pool shutdown timed out",
      );
      return true;
    },
  );
});
