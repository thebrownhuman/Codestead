import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resetDisposableIntegrationDatabase } from
  "../../integration/support/reset-disposable-database";
import {
  installDisposableIntegrationReset,
  uninstallDisposableIntegrationReset,
  withDisposableIntegrationReset,
} from "../lib/disposable-integration-reset";

type QueryResult = Readonly<{
  rowCount?: number | null;
  rows: readonly Record<string, unknown>[];
}>;

type CallerQueryResult = Readonly<{
  rowCount: number | null;
  rows: readonly Record<string, unknown>[];
}>;

type InstallerIdentity = Readonly<{
  current_database: string;
  current_user: string;
  is_superuser: boolean;
  session_user: string;
}>;

const validIdentity: InstallerIdentity = Object.freeze({
  current_database: "learncoding_integration",
  current_user: "learncoding_it",
  is_superuser: true,
  session_user: "learncoding_it",
});
const validAppDatabaseUrl =
  "postgresql://learncoding_app:app-password@127.0.0.1:49152/learncoding_integration";

function installationClient(input: Readonly<{
  contractAbsent?: boolean;
  contractInstalled?: boolean;
  contractInstalledRows?: readonly Record<string, unknown>[];
  identity?: typeof validIdentity;
  identityRows?: readonly Record<string, unknown>[];
  queryFailure?: Readonly<{
    error: unknown;
    match: string;
  }>;
}> = {}) {
  const statements: string[] = [];
  const query = vi.fn(async (statement: string): Promise<QueryResult> => {
    statements.push(statement);
    if (
      input.queryFailure
      && statement.includes(input.queryFailure.match)
    ) {
      throw input.queryFailure.error;
    }
    if (statement.includes("roles.rolsuper AS is_superuser")) {
      return { rows: input.identityRows ?? [input.identity ?? validIdentity] };
    }
    if (statement.includes("AS contract_installed")) {
      return {
        rows: input.contractInstalledRows ?? [{
          contract_installed: input.contractInstalled ?? true,
        }],
      };
    }
    if (statement.includes("AS contract_absent")) {
      return {
        rows: [{
          contract_absent: input.contractAbsent ?? true,
        }],
      };
    }
    return { rows: [] };
  });
  return { client: { query }, query, statements };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("disposable integration reset installer", () => {
  it("installs a private, role-bound reset that changes only three no-truncate triggers", async () => {
    const { client, statements } = installationClient();

    await installDisposableIntegrationReset(client);

    const install = statements.find((statement) =>
      statement.includes("CREATE SCHEMA codestead_disposable_test")
    );
    expect(install).toBeDefined();
    if (install === undefined) {
      throw new Error("reset installation SQL was not captured");
    }
    expect(install).toContain(
      "CREATE SCHEMA codestead_disposable_test AUTHORIZATION learncoding_owner",
    );
    expect(install).toContain("SECURITY DEFINER");
    expect(install).toContain("SET search_path = pg_catalog");
    expect(install).toContain(
      "current_database() IS DISTINCT FROM 'learncoding_integration'",
    );
    expect(install).toContain(
      "session_user IS DISTINCT FROM 'learncoding_app'",
    );
    expect(install).toContain(
      "current_user IS DISTINCT FROM 'learncoding_owner'",
    );
    expect(install).toContain(
      "backup_status_mail_authority_no_truncate",
    );
    expect(install).toContain("email_outbox_idempotency_no_truncate");
    expect(install).toContain("mail_delivery_release_receipt_no_truncate");
    expect(install).toContain(
      "candidate.tgtype = expected.trigger_type",
    );
    expect(install).toContain("guard_exact pg_catalog.bool;");
    expect(install).toContain("trigger_contract_exact pg_catalog.bool;");
    expect(install).not.toContain("pg_catalog.boolean");
    expect(install).toContain("pg_catalog.pg_try_advisory_xact_lock");
    expect(install).not.toContain(
      "PERFORM pg_catalog.pg_advisory_xact_lock",
    );
    expect(install).toContain(
      "pg_catalog.set_config('lock_timeout', '5000ms', true)",
    );
    expect(install).toContain("pg_catalog.clock_timestamp()");
    expect(install).toContain("pg_catalog.pg_sleep(0.01)");
    expect(install).toContain("ERRCODE = '55P03'");
    for (const digest of [
      "821807d9e78e8d31b0c6ebb567a51c92f04830848de2d555e4f8be8fd370c0db",
      "30414dca0ae964f5275372bc0c8f1607417c0fa5d22786977b25c21be877d240",
      "164b71af1bca387a599b64246851b7ba3e66c8a9557a60581dec54eb4d757370",
      "2ae733ebe79975ce70fa9427ccb92295ecf8acad75797e8541bbb15bd9318790",
      "ba3b8d7a3dd78f927778d41856c8c57430d188de2c3b05f8a7c3173776bed131",
      "88e9e02ba13bfd210a724e56e6216c9e0375c046b6d904307d51c50cbae4cd3a",
    ]) {
      expect(install?.match(new RegExp(digest, "gu"))).toHaveLength(2);
    }
    expect(install?.match(/actual_execute_acl/gu)).toHaveLength(4);
    expect(install?.match(/routine\.prosecdef/gu)).toHaveLength(4);
    expect(install?.match(/routine\.proconfig/gu)).toHaveLength(4);
    expect(install).toContain(
      "ARRAY['search_path=pg_catalog']::pg_catalog.text[]",
    );
    expect(install).toContain(
      "ARRAY['search_path=pg_catalog, pg_temp']::pg_catalog.text[]",
    );
    expect(install).toContain(
      "learncoding_owner|learncoding_owner|execute|f",
    );
    expect(install).toContain("candidate.tgconstraint = 0");
    expect(install).toContain("candidate.tgparentid = 0");
    expect(install).toContain("candidate.tgnargs = 0");
    expect(install).toContain(
      "candidate.tgattr = ''::pg_catalog.int2vector",
    );
    expect(install).not.toContain("candidate.tgattr::pg_catalog.int2[]");
    expect(install).toContain("candidate.tgqual IS NULL");
    expect(install?.match(/DISABLE TRIGGER/gu)).toHaveLength(3);
    expect(install).not.toMatch(
      /DISABLE TRIGGER (?:ALL|USER)|session_replication_role/iu,
    );
    expect(install).toContain(
      "TRUNCATE TABLE %s RESTART IDENTITY CASCADE",
    );
    expect(install).toContain(
      "INSERT INTO public.backup_status_mail_admin_guard (singleton)",
    );
    expect(install).toContain(
      "ENABLE TRIGGER backup_status_mail_authority_no_truncate",
    );
    expect(install).toContain(
      "ENABLE ALWAYS TRIGGER email_outbox_idempotency_no_truncate",
    );
    expect(install).toContain(
      "ENABLE ALWAYS TRIGGER mail_delivery_release_receipt_no_truncate",
    );
    expect(install).toContain(
      "REVOKE ALL ON FUNCTION codestead_disposable_test.reset_database()",
    );
    expect(install).toContain(
      "GRANT EXECUTE ON FUNCTION codestead_disposable_test.reset_database()",
    );
    expect(install).toContain(
      "GRANT CREATE, USAGE ON SCHEMA codestead_disposable_test",
    );
    expect(install).toContain(
      "TO learncoding_owner;",
    );
    expect(install).toContain(
      "GRANT USAGE ON SCHEMA codestead_disposable_test TO learncoding_app",
    );
    expect(install).toContain("TO learncoding_app;");
    const installedContract = statements.find((statement) =>
      statement.includes("AS contract_installed")
    );
    if (installedContract === undefined) {
      throw new Error("reset installation contract SQL was not captured");
    }
    expect(installedContract).toContain("routine.provolatile = 'v'");
    expect(installedContract).toContain("routine.proisstrict IS FALSE");
    expect(installedContract).toContain("routine.proparallel = 'u'");
    expect(installedContract).toContain("routine.proleakproof IS FALSE");
    expect(installedContract).toContain("pg_catalog.pg_get_functiondef");
    const resetDelimiter = "$codestead_disposable_reset$";
    const resetSourceStart = install.indexOf(`AS ${resetDelimiter}`)
      + `AS ${resetDelimiter}`.length;
    const resetSourceEnd = install.indexOf(
      resetDelimiter,
      resetSourceStart,
    );
    expect(resetSourceStart).toBeGreaterThan(`AS ${resetDelimiter}`.length);
    expect(resetSourceEnd).toBeGreaterThan(resetSourceStart);
    const resetSourceSha256 = createHash("sha256")
      .update(install.slice(resetSourceStart, resetSourceEnd), "utf8")
      .digest("hex");
    expect(installedContract).toContain(resetSourceSha256);
    expect(installedContract).toMatch(/[a-f0-9]{64}'\n  AND pg_catalog\.pg_get_userbyid/u);
    expect(installedContract).not.toContain("__RESET_DEFINITION_SHA256__");
    expect(installedContract).toContain(
      "pg_catalog.count(*) = 1\n      FROM pg_catalog.pg_proc AS schema_routine",
    );
    expect(installedContract).toContain(
      "pg_catalog.pg_proc AS overload",
    );
    expect(installedContract).toContain(
      "access.grantor = namespace.nspowner",
    );
    expect(installedContract).toContain(
      "access.grantor = routine.proowner",
    );
    for (const catalog of [
      "pg_catalog.pg_aggregate",
      "pg_catalog.pg_class",
      "pg_catalog.pg_collation",
      "pg_catalog.pg_constraint",
      "pg_catalog.pg_conversion",
      "pg_catalog.pg_default_acl",
      "pg_catalog.pg_depend",
      "pg_catalog.pg_extension",
      "pg_catalog.pg_opclass",
      "pg_catalog.pg_operator",
      "pg_catalog.pg_opfamily",
      "pg_catalog.pg_proc",
      "pg_catalog.pg_publication_namespace",
      "pg_catalog.pg_statistic_ext",
      "pg_catalog.pg_ts_config",
      "pg_catalog.pg_ts_dict",
      "pg_catalog.pg_ts_parser",
      "pg_catalog.pg_ts_template",
      "pg_catalog.pg_type",
    ]) {
      expect(installedContract).toContain(catalog);
    }
    expect(installedContract).toContain("observed_outgoing_dependencies");
    expect(installedContract).toContain("expected_outgoing_dependencies");
    expect(installedContract).toContain("pg_catalog.pg_language");
    expect(installedContract.match(/EXCEPT ALL/gu)).toHaveLength(2);
    expect(install).toContain("reset_namespace_contract_exact");
    expect(install).toContain("namespace_dependency_contract_exact");
    expect(
      install?.match(/reset_namespace_contract_exact IS NOT TRUE/gu),
    ).toHaveLength(2);
    expect(
      install?.match(/namespace_dependency_contract_exact IS NOT TRUE/gu),
    ).toHaveLength(2);
    expect(statements.at(0)).toBe("BEGIN");
    expect(statements.at(1)).toContain(
      "SET LOCAL lock_timeout = '5000ms'",
    );
    expect(statements.at(1)).toContain(
      "SET LOCAL statement_timeout = '30000ms'",
    );
    expect(statements.at(1)).toContain(
      "SET LOCAL idle_in_transaction_session_timeout = '30000ms'",
    );
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("rolls back if transaction bounds cannot be established", async () => {
    const timeoutFailure = new Error("timeout setup failed");
    const { client, statements } = installationClient({
      queryFailure: {
        error: timeoutFailure,
        match: "SET LOCAL lock_timeout",
      },
    });

    await expect(
      installDisposableIntegrationReset(client),
    ).rejects.toBe(timeoutFailure);

    expect(statements).toEqual([
      "BEGIN",
      expect.stringContaining("SET LOCAL lock_timeout = '5000ms'"),
      "ROLLBACK",
    ]);
    expect(statements.some((statement) =>
      statement.includes("CREATE SCHEMA codestead_disposable_test")
    )).toBe(false);
  });
  it.each([
    ["wrong database", [{
      ...validIdentity,
      current_database: "learncoding",
    }]],
    ["wrong current user", [{
      ...validIdentity,
      current_user: "learncoding_owner",
    }]],
    ["wrong session user", [{
      ...validIdentity,
      session_user: "learncoding_owner",
    }]],
    ["non-superuser installer", [{
      ...validIdentity,
      is_superuser: false,
    }]],
    ["missing identity", []],
    ["duplicate identity", [validIdentity, validIdentity]],
  ] as const)(
    "rolls back without installing for %s",
    async (_name, identityRows) => {
      const { client, statements } = installationClient({ identityRows });

      await expect(installDisposableIntegrationReset(client)).rejects.toThrow(
        "disposable integration reset installer identity mismatch",
      );

      expect(statements).toEqual([
        "BEGIN",
        expect.stringContaining(
          "SET LOCAL idle_in_transaction_session_timeout = '30000ms'",
        ),
        expect.stringContaining("roles.rolsuper AS is_superuser"),
        "ROLLBACK",
      ]);
    },
  );

  it("rolls back when the installed owner, security, search path, or ACL contract is not exact", async () => {
    const { client, statements } = installationClient({
      contractInstalled: false,
    });

    await expect(installDisposableIntegrationReset(client)).rejects.toThrow(
      "disposable integration reset installation verification failed",
    );

    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("verifies the exact capability, drops it restrictively, and proves absence", async () => {
    const { client, statements } = installationClient();

    await uninstallDisposableIntegrationReset(client);

    const contractIndex = statements.findIndex((statement) =>
      statement.includes("AS contract_installed")
    );
    const dropFunctionIndex = statements.indexOf(
      "DROP FUNCTION codestead_disposable_test.reset_database()",
    );
    const dropSchemaIndex = statements.indexOf(
      "DROP SCHEMA codestead_disposable_test RESTRICT",
    );
    const absenceIndex = statements.findIndex((statement) =>
      statement.includes("AS contract_absent")
    );
    expect(statements.at(0)).toBe("BEGIN");
    expect(statements.at(1)).toContain(
      "SET LOCAL lock_timeout = '5000ms'",
    );
    expect(statements.at(1)).toContain(
      "SET LOCAL statement_timeout = '30000ms'",
    );
    expect(statements.at(1)).toContain(
      "SET LOCAL idle_in_transaction_session_timeout = '30000ms'",
    );
    expect(contractIndex).toBeGreaterThan(2);
    expect(dropFunctionIndex).toBeGreaterThan(contractIndex);
    expect(dropSchemaIndex).toBeGreaterThan(dropFunctionIndex);
    expect(absenceIndex).toBeGreaterThan(dropSchemaIndex);
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("accepts exact absence without issuing any DROP", async () => {
    const { client, statements } = installationClient({
      contractAbsent: true,
      contractInstalledRows: [],
    });

    await uninstallDisposableIntegrationReset(client);

    expect(statements.some((statement) =>
      statement.includes("AS contract_absent")
    )).toBe(true);
    expect(statements).not.toContain(
      "DROP FUNCTION codestead_disposable_test.reset_database()",
    );
    expect(statements).not.toContain(
      "DROP SCHEMA codestead_disposable_test RESTRICT",
    );
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it.each([
    ["one false row", [{ contract_installed: false }]],
    ["one partial row", [{}]],
    [
      "duplicate exact rows",
      [
        { contract_installed: true },
        { contract_installed: true },
      ],
    ],
  ] as const)(
    "refuses teardown for %s from the installation contract",
    async (_case, contractInstalledRows) => {
      const { client, statements } = installationClient({
        contractInstalledRows,
      });

      await expect(
        uninstallDisposableIntegrationReset(client),
      ).rejects.toThrow(
        "disposable integration reset teardown precondition failed",
      );

      expect(statements.at(-1)).toBe("ROLLBACK");
      expect(statements.some((statement) =>
        statement.includes("AS contract_absent")
      )).toBe(false);
      expect(statements).not.toContain(
        "DROP FUNCTION codestead_disposable_test.reset_database()",
      );
      expect(statements).not.toContain(
        "DROP SCHEMA codestead_disposable_test RESTRICT",
      );
    },
  );

  it("rejects zero contract rows when exact absence cannot be proven", async () => {
    const { client, statements } = installationClient({
      contractAbsent: false,
      contractInstalledRows: [],
    });

    await expect(uninstallDisposableIntegrationReset(client)).rejects.toThrow(
      "disposable integration reset teardown precondition failed",
    );

    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements.some((statement) =>
      statement.includes("AS contract_absent")
    )).toBe(true);
    expect(statements).not.toContain(
      "DROP FUNCTION codestead_disposable_test.reset_database()",
    );
    expect(statements).not.toContain(
      "DROP SCHEMA codestead_disposable_test RESTRICT",
    );
  });

  it("rolls back teardown when absence cannot be proven", async () => {
    const { client, statements } = installationClient({
      contractAbsent: false,
    });

    await expect(uninstallDisposableIntegrationReset(client)).rejects.toThrow(
      "disposable integration reset teardown verification failed",
    );

    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("converges to absence when the first pool connection fails", async () => {
    const connectFailure = new Error("installer connection failed");
    const statements: string[] = [];
    const action = vi.fn(async () => "must not run");
    const cleanupRelease = vi.fn();
    let connection = 0;
    const pool = {
      connect: vi.fn(async () => {
        connection += 1;
        if (connection === 1) throw connectFailure;
        return {
          query: vi.fn(async (statement: string): Promise<QueryResult> => {
            statements.push(`${connection}:${statement}`);
            if (statement.includes("roles.rolsuper AS is_superuser")) {
              return { rows: [validIdentity] };
            }
            if (statement.includes("AS contract_installed")) {
              return { rows: [] };
            }
            if (statement.includes("AS contract_absent")) {
              return { rows: [{ contract_absent: true }] };
            }
            return { rows: [] };
          }),
          release: cleanupRelease,
        };
      }),
      end: vi.fn(async () => undefined),
    };

    await expect(
      withDisposableIntegrationReset(pool, action),
    ).rejects.toBe(connectFailure);

    expect(action).not.toHaveBeenCalled();
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(statements.at(-1)).toBe("2:COMMIT");
    expect(cleanupRelease).toHaveBeenCalledOnce();
    expect(cleanupRelease).toHaveBeenCalledWith(true);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("returns a successfully resolved undefined action value", async () => {
    const beforeTeardown = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({
        ...installationClient().client,
        release: vi.fn(),
      })),
      end: vi.fn(async () => undefined),
    };

    await expect(
      withDisposableIntegrationReset(
        pool,
        async () => undefined,
        beforeTeardown,
      ),
    ).resolves.toBeUndefined();

    expect(beforeTeardown).toHaveBeenCalledWith({ status: "fulfilled" });
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("preserves an undefined action rejection through successful teardown", async () => {
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const beforeTeardown = vi.fn();
    const pool = {
      connect: vi.fn(async () => {
        const release = vi.fn();
        releases.push(release);
        return {
          ...installationClient().client,
          release,
        };
      }),
      end: vi.fn(async () => undefined),
    };
    let caught = false;
    let thrown: unknown = Symbol("not thrown");

    try {
      await withDisposableIntegrationReset(
        pool,
        async () => Promise.reject(undefined),
        beforeTeardown,
      );
    } catch (error) {
      caught = true;
      thrown = error;
    }

    expect(caught).toBe(true);
    expect(thrown).toBeUndefined();
    expect(beforeTeardown).toHaveBeenCalledWith({
      status: "rejected",
      reason: undefined,
    });
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(releases).toHaveLength(2);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("preserves an undefined lifecycle release failure", async () => {
    const action = vi.fn(async () => "must not run");
    let connection = 0;
    const pool = {
      connect: vi.fn(async () => {
        connection += 1;
        const currentConnection = connection;
        return {
          ...installationClient().client,
          release: vi.fn(() => {
            if (currentConnection === 1) throw undefined;
          }),
        };
      }),
      end: vi.fn(async () => undefined),
    };
    let caught = false;
    let thrown: unknown = Symbol("not thrown");

    try {
      await withDisposableIntegrationReset(pool, action);
    } catch (error) {
      caught = true;
      thrown = error;
    }

    expect(caught).toBe(true);
    expect(thrown).toBeUndefined();
    expect(action).not.toHaveBeenCalled();
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it("aggregates undefined primary and cleanup failures in order", async () => {
    let connection = 0;
    const pool = {
      connect: vi.fn(async () => {
        connection += 1;
        const currentConnection = connection;
        return {
          ...installationClient().client,
          release: vi.fn(() => {
            if (currentConnection === 2) throw undefined;
          }),
        };
      }),
      end: vi.fn(async () => Promise.reject(undefined)),
    };
    let thrown: unknown;

    try {
      await withDisposableIntegrationReset(
        pool,
        async () => Promise.reject(undefined),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(Object.hasOwn(thrown as object, "cause")).toBe(true);
    expect((thrown as AggregateError).cause).toBeUndefined();
    expect(pool.connect).toHaveBeenCalledTimes(3);
    expect(pool.end).toHaveBeenCalledOnce();
  });

  it.each([
    ["server committed", true],
    ["server rolled back", false],
  ] as const)(
    "converges to absence after an install COMMIT acknowledgement is lost when %s",
    async (_outcome, serverCommitted) => {
      const commitAcknowledgementUnknown =
        new Error("install commit acknowledgement unknown");
      const statements: string[] = [];
      const releases: Array<ReturnType<typeof vi.fn>> = [];
      let capabilityInstalled = false;
      let connection = 0;
      const action = vi.fn(async () => "must not run");
      const pool = {
        connect: vi.fn(async () => {
          connection += 1;
          const currentConnection = connection;
          const release = vi.fn();
          releases.push(release);
          return {
            query: vi.fn(async (statement: string): Promise<QueryResult> => {
              statements.push(`${currentConnection}:${statement}`);
              if (statement.includes("roles.rolsuper AS is_superuser")) {
                return { rows: [validIdentity] };
              }
              if (
                statement.includes(
                  "CREATE SCHEMA codestead_disposable_test",
                )
              ) {
                capabilityInstalled = true;
                return { rows: [] };
              }
              if (statement.includes("AS contract_installed")) {
                return {
                  rows: capabilityInstalled
                    ? [{ contract_installed: true }]
                    : [],
                };
              }
              if (
                statement
                  === "DROP SCHEMA codestead_disposable_test RESTRICT"
              ) {
                capabilityInstalled = false;
                return { rows: [] };
              }
              if (statement.includes("AS contract_absent")) {
                return {
                  rows: [{ contract_absent: !capabilityInstalled }],
                };
              }
              if (statement === "COMMIT" && currentConnection === 1) {
                throw commitAcknowledgementUnknown;
              }
              if (statement === "ROLLBACK" && currentConnection === 1) {
                if (!serverCommitted) capabilityInstalled = false;
                return { rows: [] };
              }
              return { rows: [] };
            }),
            release,
          };
        }),
        end: vi.fn(async () => undefined),
      };

      await expect(
        withDisposableIntegrationReset(pool, action),
      ).rejects.toBe(commitAcknowledgementUnknown);

      expect(action).not.toHaveBeenCalled();
      expect(pool.connect).toHaveBeenCalledTimes(2);
      expect(pool.end).toHaveBeenCalledOnce();
      expect(capabilityInstalled).toBe(false);
      expect(statements.at(-1)).toBe("2:COMMIT");
      if (serverCommitted) {
        expect(statements).toContain(
          "2:DROP FUNCTION codestead_disposable_test.reset_database()",
        );
        expect(statements).toContain(
          "2:DROP SCHEMA codestead_disposable_test RESTRICT",
        );
      } else {
        expect(statements).not.toContain(
          "2:DROP FUNCTION codestead_disposable_test.reset_database()",
        );
        expect(statements.some((statement) =>
          statement.includes("AS contract_absent")
        )).toBe(true);
      }
      expect(releases).toHaveLength(2);
      for (const release of releases) {
        expect(release).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledWith(true);
      }
    },
  );  it.each([
    ["server committed", true],
    ["server rolled back", false],
  ] as const)(
    "uses a fresh client after teardown COMMIT acknowledgement loss when %s",
    async (_outcome, serverCommitted) => {
      const commitAcknowledgementUnknown =
        new Error("teardown commit acknowledgement unknown");
      const statements: string[] = [];
      const releases: Array<ReturnType<typeof vi.fn>> = [];
      let capabilityInstalled = false;
      let connection = 0;
      const pool = {
        connect: vi.fn(async () => {
          connection += 1;
          const currentConnection = connection;
          const release = vi.fn();
          releases.push(release);
          return {
            query: vi.fn(async (statement: string): Promise<QueryResult> => {
              statements.push(`${currentConnection}:${statement}`);
              if (statement.includes("roles.rolsuper AS is_superuser")) {
                return { rows: [validIdentity] };
              }
              if (
                statement.includes(
                  "CREATE SCHEMA codestead_disposable_test",
                )
              ) {
                capabilityInstalled = true;
                return { rows: [] };
              }
              if (statement.includes("AS contract_installed")) {
                return {
                  rows: capabilityInstalled
                    ? [{ contract_installed: true }]
                    : [],
                };
              }
              if (
                statement
                  === "DROP SCHEMA codestead_disposable_test RESTRICT"
              ) {
                capabilityInstalled = false;
                return { rows: [] };
              }
              if (statement.includes("AS contract_absent")) {
                return {
                  rows: [{ contract_absent: !capabilityInstalled }],
                };
              }
              if (statement === "COMMIT" && currentConnection === 2) {
                throw commitAcknowledgementUnknown;
              }
              if (statement === "ROLLBACK" && currentConnection === 2) {
                if (!serverCommitted) capabilityInstalled = true;
                return { rows: [] };
              }
              return { rows: [] };
            }),
            release,
          };
        }),
        end: vi.fn(async () => undefined),
      };

      await expect(
        withDisposableIntegrationReset(pool, async () => "complete"),
      ).rejects.toBe(commitAcknowledgementUnknown);

      expect(pool.connect).toHaveBeenCalledTimes(3);
      expect(pool.end).toHaveBeenCalledOnce();
      expect(capabilityInstalled).toBe(false);
      expect(statements.at(-1)).toBe("3:COMMIT");
      if (serverCommitted) {
        expect(statements).not.toContain(
          "3:DROP FUNCTION codestead_disposable_test.reset_database()",
        );
      } else {
        expect(statements).toContain(
          "3:DROP FUNCTION codestead_disposable_test.reset_database()",
        );
        expect(statements).toContain(
          "3:DROP SCHEMA codestead_disposable_test RESTRICT",
        );
      }
      expect(releases).toHaveLength(3);
      for (const release of releases) {
        expect(release).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledWith(true);
      }
    },
  );
  it("preserves the primary error and every teardown or pool-close failure", async () => {
    const primary = new Error("application tests failed");
    const teardown = new Error("teardown failed");
    const convergence = new Error("convergence failed");
    const poolClose = new Error("pool close failed");
    const statements: string[] = [];
    let connection = 0;
    const pool = {
      connect: vi.fn(async () => {
        connection += 1;
        const currentConnection = connection;
        return {
          query: vi.fn(async (statement: string): Promise<QueryResult> => {
            statements.push(`${currentConnection}:${statement}`);
            if (statement.includes("roles.rolsuper AS is_superuser")) {
              return { rows: [validIdentity] };
            }
            if (statement.includes("AS contract_installed")) {
              if (currentConnection === 2) throw teardown;
              if (currentConnection === 3) throw convergence;
              return { rows: [{ contract_installed: true }] };
            }
            return { rows: [] };
          }),
          release: vi.fn(),
        };
      }),
      end: vi.fn(async () => {
        throw poolClose;
      }),
    };

    let thrown: unknown;
    try {
      await withDisposableIntegrationReset(pool, async () => {
        throw primary;
      });
    } catch (error) {
      thrown = error;
    }

    expect(pool.connect).toHaveBeenCalledTimes(3);
    expect(pool.end).toHaveBeenCalledOnce();
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      primary,
      teardown,
      convergence,
      poolClose,
    ]);
    expect((thrown as AggregateError).cause).toBe(primary);
    expect(statements).toContain("2:ROLLBACK");
  });
});


describe("disposable integration reset failure-phase handoff", () => {
  it("passes the primary install or action failure to the teardown observer", async () => {
    const primary = new Error("application tests failed");
    const beforeTeardown = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({
        ...installationClient().client,
        release: vi.fn(),
      })),
      end: vi.fn(async () => undefined),
    };

    await expect(
      withDisposableIntegrationReset(
        pool,
        async () => {
          throw primary;
        },
        beforeTeardown,
      ),
    ).rejects.toBe(primary);

    expect(beforeTeardown).toHaveBeenCalledOnce();
    expect(beforeTeardown).toHaveBeenCalledWith({
      status: "rejected",
      reason: primary,
    });
    expect(pool.connect).toHaveBeenCalledTimes(2);
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
describe("disposable integration reset caller", () => {
  const validCallerIdentity = Object.freeze({
    current_database: "learncoding_integration",
    current_user: "learncoding_app",
    session_user: "learncoding_app",
  });

  function callerPool(input: Readonly<{
    identityRows?: readonly Record<string, unknown>[];
    resetResult?: CallerQueryResult;
    queryFailure?: Readonly<{
      match: string;
      error: unknown;
    }>;
    rollbackError?: Readonly<{ error: unknown }>;
    releaseError?: Readonly<{ error: unknown }>;
  }> = {}) {
    const statements: string[] = [];
    const query = vi.fn(async (statement: string): Promise<CallerQueryResult> => {
      statements.push(statement);
      if (
        input.queryFailure
        && statement.includes(input.queryFailure.match)
      ) {
        throw input.queryFailure.error;
      }
      if (statement === "ROLLBACK" && input.rollbackError) {
        throw input.rollbackError.error;
      }
      if (statement.includes("current_database()")) {
        return {
          rowCount: input.identityRows?.length ?? 1,
          rows: input.identityRows ?? [validCallerIdentity],
        };
      }
      if (statement.includes("reset_database()")) {
        return input.resetResult ?? {
          rowCount: 1,
          rows: [{ reset_database: "" }],
        };
      }
      return { rowCount: null, rows: [] };
    });
    const release = vi.fn(() => {
      if (input.releaseError) throw input.releaseError.error;
    });
    const client = { query, release };
    const connect = vi.fn(async () => client);
    return { pool: { connect }, client, connect, query, release, statements };
  }

  function useValidCallerEnvironment(databaseUrl = validAppDatabaseUrl) {
    vi.stubEnv("INTEGRATION_TEST", "1");
    vi.stubEnv("DATABASE_URL", databaseUrl);
  }

  it("leases one app client and performs the complete reset in one bounded transaction", async () => {
    useValidCallerEnvironment();
    const fixture = callerPool();

    await resetDisposableIntegrationDatabase(fixture.pool);

    expect(fixture.connect).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.statements).toHaveLength(5);
    expect(fixture.statements[0]).toBe("BEGIN");
    expect(fixture.statements[1]).toContain(
      "SET LOCAL lock_timeout = '5000ms'",
    );
    expect(fixture.statements[1]).toContain(
      "SET LOCAL statement_timeout = '30000ms'",
    );
    expect(fixture.statements[1]).toContain(
      "SET LOCAL idle_in_transaction_session_timeout = '30000ms'",
    );
    expect(fixture.statements[2]).toContain("current_database()::text");
    expect(fixture.statements[2]).toContain("session_user::text");
    expect(fixture.statements[2]).toContain("current_user::text");
    expect(fixture.statements[3]).toBe(
      "select codestead_disposable_test.reset_database()",
    );
    expect(fixture.statements[4]).toBe("COMMIT");
  });

  it("rolls back if caller transaction bounds cannot be established", async () => {
    useValidCallerEnvironment();
    const timeoutFailure = new Error("caller timeout setup failed");
    const fixture = callerPool({
      queryFailure: {
        error: timeoutFailure,
        match: "SET LOCAL lock_timeout",
      },
    });

    await expect(
      resetDisposableIntegrationDatabase(fixture.pool),
    ).rejects.toBe(timeoutFailure);

    expect(fixture.statements).toEqual([
      "BEGIN",
      expect.stringContaining("SET LOCAL lock_timeout = '5000ms'"),
      "ROLLBACK",
    ]);
    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledWith();
  });

  it.each([
    ["BEGIN", "lost BEGIN acknowledgement"],
    ["COMMIT", "lost COMMIT acknowledgement"],
  ] as const)(
    "rolls back after %s",
    async (statement, message) => {
      useValidCallerEnvironment();
      const acknowledgementUnknown = new Error(message);
      const fixture = callerPool({
        queryFailure: {
          error: acknowledgementUnknown,
          match: statement,
        },
      });

      await expect(
        resetDisposableIntegrationDatabase(fixture.pool),
      ).rejects.toBe(acknowledgementUnknown);

      expect(fixture.statements.at(-1)).toBe("ROLLBACK");
      expect(fixture.release).toHaveBeenCalledOnce();
      expect(fixture.release).toHaveBeenCalledWith();
    },
  );
  it.each([
    ["wrong database", [{
      ...validCallerIdentity,
      current_database: "learncoding",
    }]],
    ["wrong session user", [{
      ...validCallerIdentity,
      session_user: "learncoding_worker",
    }]],
    ["wrong current user", [{
      ...validCallerIdentity,
      current_user: "learncoding_owner",
    }]],
    ["missing identity row", []],
    ["duplicate identity rows", [validCallerIdentity, validCallerIdentity]],
  ] as const)(
    "rolls back before invoking reset for %s",
    async (_name, identityRows) => {
      useValidCallerEnvironment();
      const fixture = callerPool({ identityRows });

      await expect(
        resetDisposableIntegrationDatabase(fixture.pool),
      ).rejects.toThrow("disposable integration reset caller identity mismatch");

      expect(fixture.statements.at(-1)).toBe("ROLLBACK");
      expect(fixture.statements).not.toContain(
        "select codestead_disposable_test.reset_database()",
      );
      expect(fixture.statements).not.toContain("COMMIT");
      expect(fixture.release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["missing integration marker", "0", validAppDatabaseUrl],
    ["malformed URL", "1", "not-a-url"],
    ["wrong protocol", "1", validAppDatabaseUrl.replace(
      "postgresql:",
      "https:",
    )],
    ["wrong username", "1", validAppDatabaseUrl.replace(
      "learncoding_app",
      "learncoding_worker",
    )],
    ["empty password", "1", validAppDatabaseUrl.replace(
      ":app-password@",
      "@",
    )],
    ["remote host", "1", validAppDatabaseUrl.replace(
      "127.0.0.1",
      "localhost",
    )],
    ["protected port", "1", validAppDatabaseUrl.replace(
      ":49152",
      ":5432",
    )],
    ["implicit port", "1", validAppDatabaseUrl.replace(":49152", "")],
    ["wrong database", "1", validAppDatabaseUrl.replace(
      "learncoding_integration",
      "learncoding",
    )],
    ["query option", "1", `${validAppDatabaseUrl}?sslmode=disable`],
    ["fragment", "1", `${validAppDatabaseUrl}#unsafe`],
  ] as const)(
    "rejects %s before acquiring a client",
    async (_name, integrationMarker, databaseUrl) => {
      vi.stubEnv("INTEGRATION_TEST", integrationMarker);
      vi.stubEnv("DATABASE_URL", databaseUrl);
      const fixture = callerPool();

      await expect(
        resetDisposableIntegrationDatabase(fixture.pool),
      ).rejects.toThrow("disposable integration reset is unavailable");

      expect(fixture.connect).not.toHaveBeenCalled();
      expect(fixture.query).not.toHaveBeenCalled();
      expect(fixture.release).not.toHaveBeenCalled();
    },
  );

  it("rolls back when the reset result is not exactly one row", async () => {
    useValidCallerEnvironment();
    const fixture = callerPool({
      resetResult: { rowCount: 0, rows: [] },
    });

    await expect(
      resetDisposableIntegrationDatabase(fixture.pool),
    ).rejects.toThrow("disposable integration reset did not complete");

    expect(fixture.statements.at(-1)).toBe("ROLLBACK");
    expect(fixture.statements).not.toContain("COMMIT");
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("preserves primary, rollback, and release failures in order", async () => {
    useValidCallerEnvironment();
    const primary = new Error("primary reset failure");
    const rollback = new Error("rollback cleanup failure");
    const release = new Error("release cleanup failure");
    const fixture = callerPool({
      queryFailure: { match: "reset_database()", error: primary },
      rollbackError: { error: rollback },
      releaseError: { error: release },
    });

    let thrown: unknown;
    try {
      await resetDisposableIntegrationDatabase(fixture.pool);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      primary,
      rollback,
      release,
    ]);
    expect((thrown as AggregateError).cause).toBe(primary);
    expect(fixture.statements.at(-1)).toBe("ROLLBACK");
    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledWith(true);
  });

  it("preserves undefined primary, rollback, and release failures in order", async () => {
    useValidCallerEnvironment();
    const fixture = callerPool({
      queryFailure: { match: "reset_database()", error: undefined },
      rollbackError: { error: undefined },
      releaseError: { error: undefined },
    });
    let thrown: unknown;

    try {
      await resetDisposableIntegrationDatabase(fixture.pool);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(Object.hasOwn(thrown as object, "cause")).toBe(true);
    expect((thrown as AggregateError).cause).toBeUndefined();
    expect(fixture.statements.at(-1)).toBe("ROLLBACK");
    expect(fixture.release).toHaveBeenCalledOnce();
    expect(fixture.release).toHaveBeenCalledWith(true);
  });
});