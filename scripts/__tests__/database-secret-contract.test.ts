import { describe, expect, it } from "vitest";

import { validateDatabaseSecretValues } from "../../infra/ops/validate-database-secrets.mjs";

const values = {
  postgresUser: "learncoding",
  postgresDatabase: "learncoding",
  postgresPassword: "Bootstrap-Fake-A-0000000000000000",
  databaseBootstrapUrl:
    "postgresql://learncoding:Bootstrap-Fake-A-0000000000000000@postgres:5432/learncoding",
  databaseAppUrl:
    "postgresql://learncoding_app:App-Fake-B-000000000000000000000@postgres:5432/learncoding",
  databaseMigratorUrl:
    "postgresql://learncoding_migrator:Migrator-Fake-C-00000000000000000@postgres:5432/learncoding",
  databaseWorkerUrl:
    "postgresql://learncoding_worker:Worker-Fake-D-0000000000000000000@postgres:5432/learncoding",
  databaseOpsUrl:
    "postgresql://learncoding_ops:Ops-Fake-E-000000000000000000000@postgres:5432/learncoding",
};

describe("host database secret contract", () => {
  it("accepts the exact fixed topology and matching bootstrap password", () => {
    expect(validateDatabaseSecretValues(values)).toEqual({
      bootstrapUser: "learncoding",
      database: "learncoding",
      restrictedUsers: [
        "learncoding_app",
        "learncoding_migrator",
        "learncoding_worker",
        "learncoding_ops",
      ],
    });
  });

  it("rejects a stale bootstrap URL without echoing either credential", () => {
    const stale = "Stale-Bootstrap-Canary-000000000000";
    expect(() =>
      validateDatabaseSecretValues({
        ...values,
        databaseBootstrapUrl: values.databaseBootstrapUrl.replace(
          values.postgresPassword,
          stale,
        ),
      }),
    ).toThrowError("database secret topology is invalid");

    try {
      validateDatabaseSecretValues({
        ...values,
        databaseBootstrapUrl: values.databaseBootstrapUrl.replace(
          values.postgresPassword,
          stale,
        ),
      });
    } catch (error) {
      expect(String(error)).not.toContain(stale);
      expect(String(error)).not.toContain(values.postgresPassword);
    }
  });

  it.each([
    ["empty runtime password", { databaseAppUrl: "postgresql://learncoding_app:@postgres:5432/learncoding" }],
    ["short runtime password", { databaseAppUrl: "postgresql://learncoding_app:too-short@postgres:5432/learncoding" }],
    ["duplicate runtime password", { databaseOpsUrl: values.databaseWorkerUrl.replace("learncoding_worker", "learncoding_ops") }],
    ["wrong host", { databaseWorkerUrl: values.databaseWorkerUrl.replace("@postgres:", "@localhost:") }],
    ["query option", { databaseMigratorUrl: `${values.databaseMigratorUrl}?sslmode=disable` }],
  ])("rejects %s", (_name, override) => {
    expect(() => validateDatabaseSecretValues({ ...values, ...override })).toThrowError(
      "database secret topology is invalid",
    );
  });
});
