import { describe, expect, it } from "vitest";

import { buildDisposableIntegrationRuntimeEnvironment } from
  "../lib/disposable-integration-runtime";

type RuntimeInput = Parameters<
  typeof buildDisposableIntegrationRuntimeEnvironment
>[1];
type DatabaseUrlKey = Exclude<
  keyof RuntimeInput,
  "taskHomeDirectory" | "betterAuthSecret"
>;

const PORT = "49152";
const DATABASE = "learncoding_integration";
const PASSWORDS = Object.freeze({
  app: "app-password",
  migrator: "migrator-password",
  worker: "worker-password",
  ops: "ops-password",
  backupReporter: "backup-reporter-password",
});

function validInput(): RuntimeInput {
  const migrator =
    `postgresql://learncoding_migrator:${PASSWORDS.migrator}`
    + `@127.0.0.1:${PORT}/${DATABASE}`;
  return {
    taskHomeDirectory: process.cwd(),
    databaseAppUrl:
      `postgresql://learncoding_app:${PASSWORDS.app}`
      + `@127.0.0.1:${PORT}/${DATABASE}`,
    databaseMigratorUrl: migrator,
    databaseWorkerUrl:
      `postgresql://learncoding_worker:${PASSWORDS.worker}`
      + `@127.0.0.1:${PORT}/${DATABASE}`,
    databaseOpsUrl:
      `postgresql://learncoding_ops:${PASSWORDS.ops}`
      + `@127.0.0.1:${PORT}/${DATABASE}`,
    databaseBackupReporterUrl:
      `postgresql://learncoding_backup_reporter:${PASSWORDS.backupReporter}`
      + `@127.0.0.1:${PORT}/${DATABASE}`,
    databaseOwnerUrl:
      `${migrator}?options=-c+role%3Dlearncoding_owner`,
    betterAuthSecret: "explicit-integration-auth-secret",
  };
}

function alterUrl(
  input: RuntimeInput,
  key: DatabaseUrlKey,
  alter: (url: URL) => void,
): RuntimeInput {
  const url = new URL(input[key]);
  alter(url);
  return { ...input, [key]: url.href };
}

const roleUrls = Object.freeze([
  ["app", "databaseAppUrl", "learncoding_app"],
  ["migrator", "databaseMigratorUrl", "learncoding_migrator"],
  ["worker", "databaseWorkerUrl", "learncoding_worker"],
  ["ops", "databaseOpsUrl", "learncoding_ops"],
  [
    "backup reporter",
    "databaseBackupReporterUrl",
    "learncoding_backup_reporter",
  ],
  ["owner", "databaseOwnerUrl", "learncoding_migrator"],
] as const satisfies readonly [string, DatabaseUrlKey, string][]);

const roleUrlCases = roleUrls.flatMap(([label, key]) => [
  [`${label}: malformed`, { ...validInput(), [key]: "not-a-url" }],
  [`${label}: empty password`, alterUrl(validInput(), key, (url) => {
    url.password = "";
  })],
  [`${label}: wrong username`, alterUrl(validInput(), key, (url) => {
    url.username = "unexpected_role";
  })],
  [`${label}: remote host`, alterUrl(validInput(), key, (url) => {
    url.hostname = "localhost";
  })],
  [`${label}: protected port`, alterUrl(validInput(), key, (url) => {
    url.port = "5432";
  })],
  [`${label}: implicit port`, alterUrl(validInput(), key, (url) => {
    url.port = "";
  })],
  [`${label}: wrong database`, alterUrl(validInput(), key, (url) => {
    url.pathname = "/learncoding";
  })],
  [`${label}: fragment`, alterUrl(validInput(), key, (url) => {
    url.hash = "#unsafe";
  })],
] as const);

const nonOwnerQueryCases = roleUrls
  .filter(([, key]) => key !== "databaseOwnerUrl")
  .map(([label, key]) => [
    `${label}: query option`,
    alterUrl(validInput(), key, (url) => {
      url.searchParams.set("options", "-c role=learncoding_owner");
    }),
  ] as const);

const topologyCases = [
  ["different port", alterUrl(validInput(), "databaseOpsUrl", (url) => {
    url.port = "49153";
  })],
  ["different database", alterUrl(
    validInput(),
    "databaseWorkerUrl",
    (url) => {
      url.pathname = "/other_integration";
    },
  )],
  ["duplicate URLs", {
    ...validInput(),
    databaseWorkerUrl: validInput().databaseAppUrl,
  }],
  ["owner option missing", {
    ...validInput(),
    databaseOwnerUrl: validInput().databaseMigratorUrl,
  }],
  ["owner option key wrong", alterUrl(
    validInput(),
    "databaseOwnerUrl",
    (url) => {
      const value = url.searchParams.get("options")!;
      url.search = "";
      url.searchParams.set("role", value);
    },
  )],
  ["owner option value wrong", alterUrl(
    validInput(),
    "databaseOwnerUrl",
    (url) => {
      url.searchParams.set("options", "-c role=learncoding_ops");
    },
  )],
  ["owner extra option", alterUrl(
    validInput(),
    "databaseOwnerUrl",
    (url) => {
      url.searchParams.set("sslmode", "disable");
    },
  )],
  ["empty auth secret", {
    ...validInput(),
    betterAuthSecret: "",
  }],
] as const;

const invalidCases = [
  ...roleUrlCases,
  ...nonOwnerQueryCases,
  ...topologyCases,
] as const;

describe("disposable integration runtime URL validation", () => {
  it("accepts only the exact six-URL loopback topology", () => {
    const input = validInput();

    const environment = buildDisposableIntegrationRuntimeEnvironment(
      { PATH: "C:\\runtime\\bin" },
      input,
    );

    expect(environment).toMatchObject({
      DATABASE_APP_URL: input.databaseAppUrl,
      DATABASE_MIGRATOR_URL: input.databaseMigratorUrl,
      DATABASE_WORKER_URL: input.databaseWorkerUrl,
      DATABASE_OPS_URL: input.databaseOpsUrl,
      DATABASE_BACKUP_REPORTER_URL: input.databaseBackupReporterUrl,
      DATABASE_OWNER_URL: input.databaseOwnerUrl,
      DATABASE_URL: input.databaseAppUrl,
      INTEGRATION_TEST: "1",
    });
  });

  it.each(invalidCases)(
    "rejects %s before emitting a child environment",
    (_name, input) => {
      expect(() => buildDisposableIntegrationRuntimeEnvironment(
        { PATH: "C:\\runtime\\bin" },
        input,
      )).toThrowError(
        "disposable integration runtime database validation failed",
      );
    },
  );
});