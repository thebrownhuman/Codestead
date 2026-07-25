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

test("enqueue calls only the owner routine with parameterized non-secret fields", {
  skip: implementation === null,
}, async () => {
  const calls = [];
  let ended = 0;
  const result = await implementation.enqueueBackupStatus({
    databaseUrl: reporterUrl,
    databaseName: "learncoding",
    outcome: "success",
    runKey: "20260725T051500Z",
  }, {
    createPool: (options) => {
      assert.deepEqual(options, {
        connectionString: reporterUrl,
        max: 1,
        application_name: "codestead-backup-status-reporter",
      });
      return {
        async query(sql, values) {
          calls.push({ sql, values });
          return {
            rowCount: 1,
            rows: [{
              acknowledgement: "queued",
              authority_id: "11111111-1111-4111-8111-111111111111",
              outbox_id: "22222222-2222-4222-8222-222222222222",
              operation_id: "33333333-3333-4333-8333-333333333333",
            }],
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
    const action = implementation.enqueueBackupStatus({
      databaseUrl: reporterUrl,
      databaseName: "learncoding",
      outcome: "failure",
      runKey: "20260725T051501Z",
    }, {
      createPool: () => ({
        async query() {
          return {
            rowCount: 1,
            rows: [{
              acknowledgement,
              authority_id: "11111111-1111-4111-8111-111111111111",
              outbox_id: "22222222-2222-4222-8222-222222222222",
              operation_id: "33333333-3333-4333-8333-333333333333",
            }],
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
    assert.equal(ended, 1);
  }
});
