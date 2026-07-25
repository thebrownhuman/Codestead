import assert from "node:assert/strict";
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
    runKey: "20260725T051500Z",
    ...overrides,
  };
}

function immediateDeadlineDependencies() {
  const delays = [];
  return {
    delays,
    setTimeout(callback, delay) {
      delays.push(delay);
      queueMicrotask(callback);
      return { unref() {} };
    },
    clearTimeout() {},
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

test("request validation accepts only the fixed outcome and run-key grammar", {
  skip: implementation === null,
}, () => {
  assert.deepEqual(
    implementation.validateBackupStatusRequest({
      outcome: "success",
      runKey: "20260725T051500Z",
    }),
    { outcome: "success", runKey: "20260725T051500Z" },
  );
  assert.deepEqual(
    implementation.validateBackupStatusRequest({
      outcome: "failure",
      runKey: "20260725T051501Z",
    }),
    { outcome: "failure", runKey: "20260725T051501Z" },
  );
  for (const input of [
    { outcome: "SUCCESS", runKey: "20260725T051500Z" },
    { outcome: "success", runKey: "../unsafe" },
    { outcome: "success", runKey: "20260725t051500z" },
    { outcome: "success", runKey: "20260725T051500Z\n" },
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
    /^select acknowledgement, authority_id::text, outbox_id::text, operation_id::text\s+from public\.enqueue_backup_status_mail_authority\(\$1::text, \$2::text\)$/u,
  );
  assert.deepEqual(calls[0].values, ["20260725T051500Z", "success"]);
  assert.doesNotMatch(calls[0].sql, /postgresql:|learncoding_backup_reporter|a{32}/u);
});

test("enqueue accepts exact replay and closes the pool on malformed acknowledgement", {
  skip: implementation === null,
}, async () => {
  for (const acknowledgement of ["existing", "forged"]) {
    let ended = 0;
    let released = 0;
    const action = implementation.enqueueBackupStatus(reporterInput({
      outcome: "failure",
      runKey: "20260725T051501Z",
    }), {
      createPool: () => ({
        async connect() {
          return {
            async query() {
              return {
                rowCount: 1,
                rows: [{ ...authorityRow, acknowledgement }],
              };
            },
            release(destroy) {
              assert.equal(destroy, false);
              released += 1;
            },
          };
        },
        async end() {
          ended += 1;
        },
      }),
    });

    if (acknowledgement === "existing") {
      assert.equal(await action, "existing");
    } else {
      await assert.rejects(action, {
        message: "backup status reporter acknowledgement is invalid",
      });
    }
    assert.equal(released, 1);
    assert.equal(ended, 1);
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

test("a hung query destroys its connection and fails with a fixed deadline", {
  skip: implementation === null,
}, async () => {
  const deadline = immediateDeadlineDependencies();
  const releases = [];
  await assert.rejects(
    implementation.enqueueBackupStatus(reporterInput(), {
      ...deadline,
      createPool: () => ({
        async connect() {
          return {
            query() {
              return new Promise(() => {});
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
              assert.equal(destroy, false);
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
