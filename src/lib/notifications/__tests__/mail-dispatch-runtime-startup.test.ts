import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { planMailDispatchRuntime } from "../mail-dispatch-runtime-policy";
import * as runtimeStartup from "../mail-dispatch-runtime-startup";

import {
  parsePostgresServerVersionNum,
  requireMailDeliveryAuthorityRuntime,
  requireMailDispatchPostgresRuntime,
} from "../mail-dispatch-runtime-startup";

describe("mail dispatch PostgreSQL runtime authority", () => {
  it.each([
    ["170000", 17],
    ["170012", 17],
    ["180000", 18],
  ])("accepts server_version_num %s as major %i", (versionNum, major) => {
    expect(parsePostgresServerVersionNum(versionNum)).toEqual({
      major,
      versionNum: Number(versionNum),
    });
  });

  it.each(["", "17", "17.5", " 170000", "170000 ", "0160000", "not-a-version"])(
    "rejects malformed server_version_num %j",
    (versionNum) => {
      expect(() => parsePostgresServerVersionNum(versionNum)).toThrow(
        expect.objectContaining({ name: "POSTGRES_RUNTIME_UNSUPPORTED" }),
      );
    },
  );

  it("accepts targeted PostgreSQL 18 while rejecting runtime majors below 17", async () => {
    const pg18 = {
      query: vi.fn(async () => ({
        rows: [{ server_version_num: "180000" }],
      })),
    };
    await expect(requireMailDispatchPostgresRuntime(pg18)).resolves.toEqual({
      major: 18,
      versionNum: 180000,
    });

    const pg16 = {
      query: vi.fn(async () => ({
        rows: [{ server_version_num: "160011" }],
      })),
    };
    await expect(requireMailDispatchPostgresRuntime(pg16)).rejects.toEqual(
      expect.objectContaining({ name: "POSTGRES_RUNTIME_UNSUPPORTED" }),
    );
  });

  it.each([
    ["zero rows", []],
    [
      "multiple rows",
      [{ server_version_num: "170000" }, { server_version_num: "170000" }],
    ],
    ["null value", [{ server_version_num: null }]],
    ["numeric value", [{ server_version_num: 170000 }]],
  ])("fails closed for %s", async (_label, rows) => {
    const database = { query: vi.fn(async () => ({ rows })) };

    await expect(requireMailDispatchPostgresRuntime(database)).rejects.toEqual(
      expect.objectContaining({ name: "POSTGRES_RUNTIME_UNSUPPORTED" }),
    );
  });

  it("normalizes query failures to the fixed operational error", async () => {
    const database = {
      query: vi.fn(async () => {
        throw new Error("private connection detail");
      }),
    };

    await expect(requireMailDispatchPostgresRuntime(database)).rejects.toEqual(
      expect.objectContaining({
        name: "POSTGRES_RUNTIME_UNSUPPORTED",
        message: "Mail dispatch requires PostgreSQL 17 or newer.",
      }),
    );
  });
});

describe("mail delivery authority runtime gate", () => {
  it("allows the pre-0067 catalog while exposing no release capability", async () => {
    const database = {
      query: vi.fn(async () => ({
        rows: [
          {
            hold_catalog_present: false,
            hold_catalog_exact: false,
            delivery_release_capability_exact: false,
          },
        ],
      })),
    };

    await expect(
      requireMailDeliveryAuthorityRuntime(database),
    ).resolves.toEqual({
      holdCatalogExact: false,
      deliveryReleaseCapabilityExact: false,
    });
  });

  it("detects the exact Task 5 hold but cannot authorize Task 7 delivery", async () => {
    const database = {
      query: vi.fn(async (queryText: string) => {
        void queryText;
        return {
          rows: [
            {
              hold_catalog_present: true,
              hold_catalog_exact: true,
              delivery_release_capability_exact: false,
            },
          ],
        };
      }),
    };

    await expect(
      requireMailDeliveryAuthorityRuntime(database),
    ).resolves.toEqual({
      holdCatalogExact: true,
      deliveryReleaseCapabilityExact: false,
    });
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining("delivery_hold_version"),
    );
    expect(database.query).toHaveBeenCalledWith(
      expect.stringContaining(
        "public.attest_email_outbox_delivery_release_lineage",
      ),
    );
    const query = database.query.mock.calls[0]?.[0] ?? "";
    expect(query).not.toContain("FROM drizzle.__drizzle_migrations");
    expect(query).not.toContain("JOIN drizzle.__drizzle_migrations");
  });

  it("authorizes only the exact applied 0069 hash plus live catalog and ACLs", async () => {
    const database = {
      query: vi.fn(async (queryText: string) => {
        void queryText;
        return {
          rows: [
            {
              hold_catalog_present: true,
              hold_catalog_exact: true,
              delivery_release_capability_exact: true,
            },
          ],
        };
      }),
    };

    await expect(
      requireMailDeliveryAuthorityRuntime(database),
    ).resolves.toEqual({
      holdCatalogExact: true,
      deliveryReleaseCapabilityExact: true,
    });

    const query = database.query.mock.calls[0]?.[0] ?? "";
    expect(query).toMatch(
      /public[.]attest_email_outbox_delivery_release_lineage[(]\s*'[0-9a-f]{64}'\s*[)]/u,
    );
    expect(query).not.toContain("FROM drizzle.__drizzle_migrations");
    expect(query).not.toContain("JOIN drizzle.__drizzle_migrations");
    expect(query).not.toContain("migration.hash");
    expect(query).not.toContain("migration.created_at");
    expect(query).toContain("COALESCE(");
    expect(query).not.toContain("pg_catalog.coalesce");
    for (const marker of [
      "lineage_attestor_catalog",
      "attestor.provolatile = 's'",
      "attestor.prosecdef",
      "attestor.proparallel = 'u'",
      "search_path=pg_catalog, pg_temp",
      "candidate_migration_sha256",
      "phase_0066_count",
      "phase_0067_count",
      "phase_0068_count",
      "phase_0069_count",
      "candidate_hash_count",
      "lineage_window_count",
      "ef2bcb7f6642b27b9e30fd0c91a9d3d031f8d5a5e0f3647a9f7a57cab7bdc57a",
      "57e575a169040050c389d00c766cc35e32e0b32fae9c4f369e598f506aceb21d",
      "learncoding_owner|learncoding_owner|execute|false",
      "learncoding_worker|learncoding_owner|execute|false",
      "pg_catalog.aclexplode",
    ]) {
      expect(query).toContain(marker);
    }
    expect(query).not.toContain("FALSE AS delivery_release_capability_exact");
    expect(query).toContain(
      "relation.relname = 'mail_delivery_release_receipt'",
    );
    expect(query).toContain(
      "public.release_email_outbox_delivery(uuid,uuid,text,text,text)",
    );
    expect(query).toContain("pg_catalog.pg_get_functiondef");
    expect(query).toContain(
      "b90df49087aa1ca69e80fc18a4963d5fc724d91db8612b338c2d2b98f2a3db0f",
    );
    expect(query).toContain(
      "9516f96ef9133bdf61f6db352422d521cf4616c6bd5b365888f1c614670ed409",
    );
    expect(query).toContain(
      "63614be0762f14c3593ef05fc9f5f440a67a65bec27e703b59a18cd60273057d",
    );
    expect(query).not.toContain(
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(query).toContain(
      "public.verify_email_outbox_delivery_release(uuid,uuid,text,text,text)",
    );
    expect(query).toContain(
      "b3277feeb2ed099406e17a3fe548bae580f978f5cd94a7f55f28687c81d9042c",
    );
    expect(query).toContain(
      "8e50e51aae34e3657a6a2d9d90fc546025512f2678b083e824a5cc0f8457ee5f",
    );
    expect(query).toContain("verifier_catalog.structure_exact");
    expect(query).toContain("verifier_catalog.acl_exact");
    expect(query).toContain("pg_catalog.aclexplode");
    expect(query).not.toContain("ORDER BY 1");
    expect(query).not.toContain("pg_catalog.has_function_privilege(0");
    expect(query).toContain("pg_catalog.pg_rewrite");
    expect(query).toContain("pg_catalog.pg_partitioned_table");
    expect(query).toContain("attribute.attcompression");
    expect(query).toContain("constraint_row.contype = 'n'");
    expect(query).toContain("pg_catalog.pg_get_constraintdef");
    expect(query).toContain("constraint_row.conindid = expected.index_oid");
    expect(query).toContain("mail_delivery_release_receipt_digest_exact");
    expect(query).toContain("mail_delivery_release_receipt_insert_authority");
    expect(query).toContain("mail_delivery_release_receipt_delete_exact");
    expect(query).toContain("actual_receipt_triggers");
    expect(query).toContain("managed_receipt_principal");
    expect(query).toContain(
      "'learncoding_owner|learncoding_owner|maintain|false'",
    );
    expect(query).toContain("('MAINTAIN')");
    expect(query).toContain(
      "public.mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)",
    );
    expect(query).toContain("digest_helper_catalog");
    expect(query).toContain("helper.provolatile = 'i'");
    expect(query).toContain("helper.prosecdef");
    expect(query).toContain("helper.proparallel = 's'");
    expect(query).toContain(
      "95169176e113b1a65fe08428dbec49e0b943b41a03867c3ed309141b3d011676",
    );
    expect(query).toContain(
      "'learncoding_worker|learncoding_owner|execute|false'",
    );
    expect(query).toContain("digest_helper_catalog.structure_exact");
    expect(query).toContain("digest_helper_catalog.acl_exact");
    expect(query).toContain("provider_request_body_sha256");
    expect(query).toContain("provider_request_body_length");
    expect(query).toContain("delivery_release_insert_xid");
    expect(query).toContain("delivery_release_insert_system_identifier");
    expect(query).toContain("pg_catalog.has_column_privilege");
    expect(query).toMatch(
      /delivery_release_insert_system_identifier', 'UPDATE'\s*\)\), FALSE\) AS acl_exact/u,
    );
    expect(query).toContain("learncoding_worker");
    expect(query).toContain("learncoding_backup_reporter");
  });

  it("binds the startup attestation to the exact candidate migration bytes", async () => {
    const migrationSha256 = createHash("sha256")
      .update(
        readFileSync(
          resolve(process.cwd(), "drizzle/0069_mail_outbox_guarded_delivery_authority.sql"),
        ),
      )
      .digest("hex");
    const database = {
      query: vi.fn(async (queryText: string) => {
        void queryText;
        return {
          rows: [
            {
              hold_catalog_present: true,
              hold_catalog_exact: true,
              delivery_release_capability_exact: true,
            },
          ],
        };
      }),
    };

    await requireMailDeliveryAuthorityRuntime(database);

    const query = database.query.mock.calls[0]?.[0] ?? "";
    expect(query).toContain(
      `public.attest_email_outbox_delivery_release_lineage(
          '${migrationSha256}'
        )`,
    );
  });

  it.each([
    [
      "a missing or duplicate 0066 row",
      "lineage.phase_0066_count = 1",
    ],
    [
      "a missing or duplicate 0067 row",
      "lineage.phase_0067_count = 1",
    ],
    [
      "a missing or duplicate 0068 row",
      "lineage.phase_0068_count = 1",
    ],
    [
      "a missing or duplicate 0069 row",
      "lineage.phase_0069_count = 1",
    ],
    [
      "the candidate hash appearing outside its exact 0069 row",
      "lineage.candidate_hash_count = 1",
    ],
    [
      "a missing, duplicate, or extra post-0066 row",
      "lineage.lineage_window_count = 4",
    ],
  ])("fails closed for %s", async (_label, exactPredicate) => {
    const database = {
      query: vi.fn(async (queryText: string) => {
        void queryText;
        return {
          rows: [
            {
              hold_catalog_present: true,
              hold_catalog_exact: true,
              delivery_release_capability_exact: false,
            },
          ],
        };
      }),
    };

    await requireMailDeliveryAuthorityRuntime(database);

    const query = database.query.mock.calls[0]?.[0] ?? "";
    expect(query).toContain(exactPredicate);
  });

  it.each([
    [
      "partial hold catalog",
      {
        hold_catalog_present: true,
        hold_catalog_exact: false,
        delivery_release_capability_exact: false,
      },
    ],
    [
      "release without its hold",
      {
        hold_catalog_present: false,
        hold_catalog_exact: false,
        delivery_release_capability_exact: true,
      },
    ],
    [
      "malformed value",
      {
        hold_catalog_present: "true",
        hold_catalog_exact: true,
        delivery_release_capability_exact: false,
      },
    ],
  ])("normalizes %s to the fixed operational error", async (_label, row) => {
    const database = {
      query: vi.fn(async () => ({ rows: [row] })),
    };

    await expect(requireMailDeliveryAuthorityRuntime(database)).rejects.toEqual(
      expect.objectContaining({
        name: "MAIL_DELIVERY_AUTHORITY_UNAVAILABLE",
        message: "Mail delivery authority is unavailable.",
      }),
    );
  });
});
type StartupInspection = Readonly<{
  plan: ReturnType<typeof planMailDispatchRuntime>;
  postgresMajor: number;
}>;

type StartupPool = Readonly<{
  options?: Readonly<{
    max?: unknown;
    connectionTimeoutMillis?: unknown;
    idleTimeoutMillis?: unknown;
  }>;
  connect(): Promise<Readonly<{
    query(
      text: string,
    ): Promise<Readonly<{ rows: readonly unknown[] }>>;
    release(destroy?: boolean): void;
  }>>;
}>;

type StartupApi = Readonly<{
  MAIL_DISPATCH_OTHER_PROCESS_POOL_MAXIMUM_CONNECTIONS: number;
  MAIL_DISPATCH_PRODUCTION_CONCURRENCY: number;
  inspectMailDispatchRuntime(pool: StartupPool): Promise<StartupInspection>;
  isMailDispatchRuntimeStartupInspection(value: unknown): boolean;
  isMailDispatchRuntimeStartupInspectionForPool(
    value: unknown,
    pool: StartupPool,
  ): boolean;
}>;

const EXACT_STARTUP_POOL_OPTIONS = Object.freeze({
  max: 3,
  connectionTimeoutMillis: 2_000,
  idleTimeoutMillis: 30_000,
});

function startupApi(): StartupApi {
  const candidate = runtimeStartup as unknown as Partial<StartupApi>;
  expect(candidate.inspectMailDispatchRuntime).toBeTypeOf("function");
  expect(candidate.isMailDispatchRuntimeStartupInspection).toBeTypeOf(
    "function",
  );
  expect(candidate.isMailDispatchRuntimeStartupInspectionForPool).toBeTypeOf(
    "function",
  );
  return candidate as StartupApi;
}

function startupPool(
  input: Readonly<{
    options?: StartupPool["options"];
    rows?: readonly unknown[];
    authorityRows?: readonly unknown[];
  }> = {},
) {
  const query = vi.fn(async (queryText: string) => {
      if (
        queryText.includes("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") ||
        queryText.trim() === "COMMIT" ||
        queryText.trim().startsWith("SET LOCAL ") ||
        queryText.trim() === "ROLLBACK"
      ) {
        return { rows: [] };
      }
      if (queryText.includes("current_setting('max_connections')")) {
        return {
          rows: input.rows ?? [
            {
              max_connections: "89",
              admin_reserved_connections: "3",
              server_version_num: "170005",
            },
          ],
        };
      }

      return {
        rows: input.authorityRows ?? [
          {
            hold_catalog_present: true,
            hold_catalog_exact: true,
            delivery_release_capability_exact: true,
          },
        ],
      };
    });
  const release = vi.fn<(destroy?: boolean) => void>();
  const client = { query, release };
  return {
    options: input.options ?? EXACT_STARTUP_POOL_OPTIONS,
    connect: vi.fn(async () => client),
    client,
    query,
    release,
  };
}

describe("mail dispatch pool-bound runtime startup inspection", () => {
  it("inspects the exact production pool and one PostgreSQL 17+ snapshot", async () => {
    const api = startupApi();
    const database = startupPool();

    const inspection = await api.inspectMailDispatchRuntime(database);

    expect(api.MAIL_DISPATCH_PRODUCTION_CONCURRENCY).toBe(1);
    expect(api.MAIL_DISPATCH_OTHER_PROCESS_POOL_MAXIMUM_CONNECTIONS).toBe(80);
    expect(database.connect).toHaveBeenCalledTimes(1);
    expect(database.query).toHaveBeenCalledTimes(4);
    expect(database.release).toHaveBeenCalledTimes(1);
    const beginSql = String(database.query.mock.calls[0]?.[0]);
    expect(beginSql).toContain(
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(beginSql).toContain("SET LOCAL search_path = pg_catalog, pg_temp");
    expect(beginSql).toContain("SET LOCAL quote_all_identifiers = false");
    expect(beginSql).toContain("SET LOCAL statement_timeout");
    expect(beginSql).toContain("SET LOCAL idle_in_transaction_session_timeout");
    expect(beginSql).toContain("SET LOCAL transaction_timeout");
    expect(database.release).toHaveBeenCalledWith(false);
    const sql = String(database.query.mock.calls[1]?.[0]);
    expect(sql).toContain("current_setting('max_connections')");
    expect(sql).toContain("current_setting('superuser_reserved_connections')");
    expect(sql).toContain("current_setting('reserved_connections', true)");
    expect(sql).toContain("current_setting('server_version_num')");
    const authoritySql = String(database.query.mock.calls[2]?.[0]);
    expect(authoritySql).toContain(
      "public.attest_email_outbox_delivery_release_lineage",
    );
    expect(authoritySql).not.toContain("drizzle.__drizzle_migrations");
    expect(authoritySql).toContain("delivery_release_capability_exact");
    expect(authoritySql).toContain("mail_delivery_release_receipt");
    expect(inspection.postgresMajor).toBe(17);
    expect(String(database.query.mock.calls[3]?.[0]).trim()).toBe("COMMIT");
    expect(inspection.plan.dispatch).toEqual({
      concurrency: 1,
      maximumParallelSends: 1,
    });
    expect(inspection.plan.pool).toEqual({
      maximumConnections: 3,
      dispatchConnections: 1,
      localReserves: {
        schedulerConnections: 1,
        maintenanceConnections: 1,
        totalConnections: 2,
      },
      serverCapacity: {
        maximumConnections: 89,
        adminReservedConnections: 3,
        otherProcessPoolMaximumConnections: 80,
        sumProcessPoolMaximumConnections: 83,
        gmailReconciliationReserveConnections: 3,
        remainingConnections: 0,
      },
    });
    expect(inspection.plan.timeouts).toMatchObject({
      poolAcquireMs: 2_000,
      poolIdleMs: 30_000,
    });
    expect(Object.isFrozen(inspection)).toBe(true);
    expect(Object.isFrozen(inspection.plan)).toBe(true);
    expect(api.isMailDispatchRuntimeStartupInspection(inspection)).toBe(true);
  });

  it("binds the opaque inspection and issued plan to one pool identity", async () => {
    const api = startupApi();
    const poolA = startupPool();
    const poolB = startupPool();
    const inspection = await api.inspectMailDispatchRuntime(poolA);
    const matchingFactoryPlan = planMailDispatchRuntime({
      concurrency: 1,
      poolMaximumConnections: 3,
      serverMaximumConnections: 89,
      serverAdminReserveConnections: 3,
      otherProcessPoolMaximumConnections: 80,
      poolAcquireTimeoutMs: 2_000,
      poolIdleTimeoutMs: 30_000,
    });

    expect(
      api.isMailDispatchRuntimeStartupInspectionForPool(inspection, poolA),
    ).toBe(true);
    expect(
      api.isMailDispatchRuntimeStartupInspectionForPool(inspection, poolB),
    ).toBe(false);
    expect(api.isMailDispatchRuntimeStartupInspection({ ...inspection })).toBe(
      false,
    );
    expect(
      api.isMailDispatchRuntimeStartupInspection({
        plan: matchingFactoryPlan,
        postgresMajor: 17,
      }),
    ).toBe(false);
  });

  it("does not reread ambient pool capacity after the startup gate", async () => {
    const api = startupApi();
    let configuredMaximum = 3;
    let maximumReads = 0;
    const query = vi.fn(async (queryText: string) => {
      if (
        queryText.includes("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") ||
        queryText.trim() === "COMMIT" ||
        queryText.trim() === "ROLLBACK"
      ) {
        return { rows: [] };
      }
      if (queryText.includes("current_setting('max_connections')")) {
        configuredMaximum = 99;
        return {
          rows: [
            {
              max_connections: "89",
              admin_reserved_connections: "3",
              server_version_num: "170005",
            },
          ],
        };
      }

      return {
        rows: [
          {
            hold_catalog_present: true,
            hold_catalog_exact: true,
            delivery_release_capability_exact: true,
          },
        ],
      };
    });
    const release = vi.fn<(destroy?: boolean) => void>();
    const client = { query, release };
    const database = {
      options: {
        get max() {
          maximumReads += 1;
          return configuredMaximum;
        },
        connectionTimeoutMillis: 2_000,
        idleTimeoutMillis: 30_000,
      },
      connect: vi.fn(async () => client),
    };

    const inspection = await api.inspectMailDispatchRuntime(database);

    expect(maximumReads).toBe(1);
    expect(inspection.plan.pool.maximumConnections).toBe(3);
  });

  it.each([
    [
      "missing authority",
      {
        hold_catalog_present: false,
        hold_catalog_exact: false,
        delivery_release_capability_exact: false,
      },
    ],
    [
      "hold without release",
      {
        hold_catalog_present: true,
        hold_catalog_exact: true,
        delivery_release_capability_exact: false,
      },
    ],
    [
      "partial hold",
      {
        hold_catalog_present: true,
        hold_catalog_exact: false,
        delivery_release_capability_exact: false,
      },
    ],
    [
      "release without hold",
      {
        hold_catalog_present: false,
        hold_catalog_exact: false,
        delivery_release_capability_exact: true,
      },
    ],
  ])("withholds the opaque inspection for %s", async (_label, authority) => {
    const api = startupApi();
    const database = startupPool({ authorityRows: [authority] });

    await expect(api.inspectMailDispatchRuntime(database)).rejects.toEqual(
      expect.objectContaining({
        name: "MAIL_DELIVERY_AUTHORITY_UNAVAILABLE",
        message: "Mail delivery authority is unavailable.",
      }),
    );

    expect(database.query).toHaveBeenCalledTimes(4);
    expect(
      api.isMailDispatchRuntimeStartupInspectionForPool(
        Object.freeze({ plan: {}, postgresMajor: 17 }),
        database,
      ),
    ).toBe(false);
  });

  it.each([
    [[]],
    [
      [
        {
          hold_catalog_present: true,
          hold_catalog_exact: true,
          delivery_release_capability_exact: true,
        },
        {
          hold_catalog_present: true,
          hold_catalog_exact: true,
          delivery_release_capability_exact: true,
        },
      ],
    ],
    [
      [
        {
          hold_catalog_present: "true",
          hold_catalog_exact: true,
          delivery_release_capability_exact: true,
        },
      ],
    ],
  ])(
    "withholds the opaque inspection for malformed authority rows %#",
    async (authorityRows) => {
      const database = startupPool({ authorityRows });

      await expect(
        startupApi().inspectMailDispatchRuntime(database),
      ).rejects.toMatchObject({
        name: "MAIL_DELIVERY_AUTHORITY_UNAVAILABLE",
        message: "Mail delivery authority is unavailable.",
      });
      expect(database.query).toHaveBeenCalledTimes(4);
    },
  );

  it("proves authority before constructing a capacity plan", async () => {
    const database = startupPool({
      rows: [
        {
          max_connections: "1",
          admin_reserved_connections: "0",
          server_version_num: "170005",
        },
      ],

      authorityRows: [
        {
          hold_catalog_present: false,
          hold_catalog_exact: false,
          delivery_release_capability_exact: false,
        },
      ],
    });

    await expect(
      startupApi().inspectMailDispatchRuntime(database),
    ).rejects.toMatchObject({ name: "MAIL_DELIVERY_AUTHORITY_UNAVAILABLE" });
    expect(database.query).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["maximum", { ...EXACT_STARTUP_POOL_OPTIONS, max: 2 }],
    ["maximum", { ...EXACT_STARTUP_POOL_OPTIONS, max: 4 }],
    [
      "acquire timeout",
      { ...EXACT_STARTUP_POOL_OPTIONS, connectionTimeoutMillis: 1_999 },
    ],
    [
      "acquire timeout",
      { ...EXACT_STARTUP_POOL_OPTIONS, connectionTimeoutMillis: 2_001 },
    ],
    [
      "idle timeout",
      { ...EXACT_STARTUP_POOL_OPTIONS, idleTimeoutMillis: 29_999 },
    ],
    [
      "idle timeout",
      { ...EXACT_STARTUP_POOL_OPTIONS, idleTimeoutMillis: 30_001 },
    ],
  ])("rejects exact production pool %s drift", async (_label, options) => {
    await expect(
      startupApi().inspectMailDispatchRuntime(startupPool({ options })),
    ).rejects.toThrow(/pool configuration/i);
  });

  it("requires PostgreSQL 17+ and preserves the inspected major", async () => {
    const api = startupApi();
    await expect(
      api.inspectMailDispatchRuntime(
        startupPool({
          rows: [
            {
              max_connections: "89",
              admin_reserved_connections: "3",
              server_version_num: "160009",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/PostgreSQL 17 or newer/i);

    await expect(
      api.inspectMailDispatchRuntime(
        startupPool({
          rows: [
            {
              max_connections: "89",
              admin_reserved_connections: "3",
              server_version_num: "180002",
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ postgresMajor: 18 });
  });

  it("rejects capacity without the Gmail reconciliation reserve", async () => {
    await expect(
      startupApi().inspectMailDispatchRuntime(
        startupPool({
          rows: [
            {
              max_connections: "88",
              admin_reserved_connections: "3",
              server_version_num: "170005",
            },
          ],
        }),
      ),
    ).rejects.toThrow(/reconciliation reserve/i);
  });

  it.each([
    [[]],
    [
      [
        {
          max_connections: "89",
          admin_reserved_connections: "3",
          server_version_num: "170005",
        },
        {
          max_connections: "89",
          admin_reserved_connections: "3",
          server_version_num: "170005",
        },
      ],
    ],
    [
      [
        {
          max_connections: "89.0",
          admin_reserved_connections: "3",
          server_version_num: "170005",
        },
      ],
    ],
    [
      [
        {
          max_connections: "89",
          admin_reserved_connections: "-1",
          server_version_num: "170005",
        },
      ],
    ],
    [
      [
        {
          max_connections: "89",
          admin_reserved_connections: "3",
          server_version_num: 170_005,
        },
      ],
    ],
  ])("rejects malformed PostgreSQL startup snapshot %#", async (rows) => {
    await expect(
      startupApi().inspectMailDispatchRuntime(startupPool({ rows })),
    ).rejects.toThrow(/startup snapshot/i);
  });

  it("sanitizes startup query failures", async () => {
    const database = startupPool();
    database.query.mockRejectedValueOnce(
      new Error("credential=do-not-leak operation=raw-id"),
    );

    await expect(
      startupApi().inspectMailDispatchRuntime(database),
    ).rejects.toEqual(
      expect.objectContaining({
        message: "Mail dispatch startup database inspection failed.",
      }),
    );
  });

  it("sanitizes delivery-authority query failures before issuing inspection", async () => {
    const database = startupPool();
    database.query.mockImplementation(async (queryText: string) => {
      if (queryText.includes("delivery_release_capability_exact")) {
        throw new Error(
          "credential=do-not-leak operation=raw-authority-id",
        );
      }
      if (
        queryText.includes("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY") ||
        queryText.trim() === "ROLLBACK"
      ) {
        return { rows: [] };
      }
      return {
        rows: [
          {
            max_connections: "89",
            admin_reserved_connections: "3",
            server_version_num: "170005",
          },
        ],
      };
    });

    await expect(
      startupApi().inspectMailDispatchRuntime(database),
    ).rejects.toMatchObject({
      name: "MAIL_DELIVERY_AUTHORITY_UNAVAILABLE",
      message: "Mail delivery authority is unavailable.",
    });

    expect(database.query).toHaveBeenCalledTimes(4);
    expect(
      database.query.mock.calls.some(([queryText]) =>
        String(queryText).includes("delivery_release_capability_exact"),
      ),
    ).toBe(true);
  });

  it("destroys a checkout exactly once when it resolves after the absolute startup deadline", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn<(destroy?: boolean) => void>();
      const query = vi.fn(async () => ({ rows: [] }));
      let resolveClient:
        | ((client: Awaited<ReturnType<StartupPool["connect"]>>) => void)
        | undefined;
      const database: StartupPool = {
        options: EXACT_STARTUP_POOL_OPTIONS,
        connect: vi.fn(
          () =>
            new Promise<
              Awaited<ReturnType<StartupPool["connect"]>>
            >((resolve) => {
              resolveClient = resolve;
            }),
        ),
      };
      const pending = startupApi().inspectMailDispatchRuntime(database);
      const rejection = expect(pending).rejects.toMatchObject({
        message: "Mail dispatch startup database inspection failed.",
      });

      await vi.advanceTimersByTimeAsync(6_000);
      await rejection;
      expect(release).not.toHaveBeenCalled();

      expect(resolveClient).toBeTypeOf("function");
      resolveClient?.({ query, release });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(true);
      expect(query).not.toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("destroys the leased client when the startup snapshot query hangs", async () => {
    vi.useFakeTimers();
    try {
      const database = startupPool();
      database.query.mockImplementation(async (queryText: string) => {
        if (
          queryText.includes(
            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
          )
        ) {
          return { rows: [] };
        }
        if (queryText.includes("current_setting('max_connections')")) {
          return await new Promise<never>(() => undefined);
        }
        throw new Error("unexpected query");
      });
      const pending = startupApi().inspectMailDispatchRuntime(database);
      const rejection = expect(pending).rejects.toMatchObject({
        message: "Mail dispatch startup database inspection failed.",
      });

      await vi.advanceTimersByTimeAsync(6_000);
      await rejection;
      expect(database.query).toHaveBeenCalledTimes(2);
      expect(database.release).toHaveBeenCalledTimes(1);
      expect(database.release).toHaveBeenCalledWith(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("destroys the leased client when the authority query hangs", async () => {
    vi.useFakeTimers();
    try {
      const database = startupPool();
      database.query.mockImplementation(async (queryText: string) => {
        if (
          queryText.includes(
            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
          )
        ) {
          return { rows: [] };
        }
        if (queryText.includes("current_setting('max_connections')")) {
          return {
            rows: [
              {
                max_connections: "89",
                admin_reserved_connections: "3",
                server_version_num: "170005",
              },
            ],
          };
        }
        if (queryText.includes("delivery_release_capability_exact")) {
          return await new Promise<never>(() => undefined);
        }
        throw new Error("unexpected query");
      });
      const pending = startupApi().inspectMailDispatchRuntime(database);
      const rejection = expect(pending).rejects.toMatchObject({
        name: "MAIL_DELIVERY_AUTHORITY_UNAVAILABLE",
        message: "Mail delivery authority is unavailable.",
      });

      await vi.advanceTimersByTimeAsync(6_000);
      await rejection;
      expect(database.query).toHaveBeenCalledTimes(3);
      expect(database.release).toHaveBeenCalledTimes(1);
      expect(database.release).toHaveBeenCalledWith(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("does not renew the absolute deadline between snapshot and authority", async () => {
    vi.useFakeTimers();
    try {
      const database = startupPool();
      database.query.mockImplementation(async (queryText: string) => {
        if (
          queryText.includes(
            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
          )
        ) {
          return { rows: [] };
        }
        if (queryText.includes("current_setting('max_connections')")) {
          return await new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  rows: [
                    {
                      max_connections: "89",
                      admin_reserved_connections: "3",
                      server_version_num: "170005",
                    },
                  ],
                }),
              5_000,
            );
          });
        }
        if (queryText.includes("delivery_release_capability_exact")) {
          return await new Promise<never>(() => undefined);
        }
        throw new Error("unexpected query");
      });
      let settled = false;
      const pending = startupApi().inspectMailDispatchRuntime(database);
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const rejection = expect(pending).rejects.toMatchObject({
        name: "MAIL_DELIVERY_AUTHORITY_UNAVAILABLE",
      });

      await vi.advanceTimersByTimeAsync(5_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(settled).toBe(true);
      expect(database.release).toHaveBeenCalledTimes(1);
      expect(database.release).toHaveBeenCalledWith(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("rolls back and releases normally after ordinary snapshot validation failure", async () => {
    const database = startupPool({ rows: [] });

    await expect(
      startupApi().inspectMailDispatchRuntime(database),
    ).rejects.toThrow(/startup snapshot/i);

    expect(database.query).toHaveBeenCalledTimes(3);
    expect(String(database.query.mock.calls[2]?.[0]).trim()).toBe("ROLLBACK");
    expect(database.release).toHaveBeenCalledTimes(1);
    expect(database.release).toHaveBeenCalledWith(false);
  });

  it("rolls back and releases normally after ordinary authority rejection", async () => {
    const database = startupPool({
      authorityRows: [
        {
          hold_catalog_present: true,
          hold_catalog_exact: true,
          delivery_release_capability_exact: false,
        },
      ],
    });

    await expect(
      startupApi().inspectMailDispatchRuntime(database),
    ).rejects.toMatchObject({
      name: "MAIL_DELIVERY_AUTHORITY_UNAVAILABLE",
    });

    expect(database.query).toHaveBeenCalledTimes(4);
    expect(String(database.query.mock.calls[3]?.[0]).trim()).toBe("ROLLBACK");
    expect(database.release).toHaveBeenCalledTimes(1);
    expect(database.release).toHaveBeenCalledWith(false);
  });

  it("destroys the leased client when rollback itself fails", async () => {
    const database = startupPool();
    database.query.mockImplementation(async (queryText: string) => {
      if (
        queryText.includes("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
      ) {
        return { rows: [] };
      }
      if (queryText.includes("current_setting('max_connections')")) {
        return {
          rows: [
            {
              max_connections: "89",
              admin_reserved_connections: "3",
              server_version_num: "170005",
            },
          ],
        };
      }
      if (queryText.includes("delivery_release_capability_exact")) {
        return {
          rows: [
            {
              hold_catalog_present: true,
              hold_catalog_exact: true,
              delivery_release_capability_exact: false,
            },
          ],
        };
      }
      if (queryText.trim() === "ROLLBACK") {
        throw new Error("private rollback failure");
      }
      throw new Error("unexpected query");
    });

    await expect(
      startupApi().inspectMailDispatchRuntime(database),
    ).rejects.toMatchObject({
      message: "Mail dispatch startup database inspection failed.",
    });
    expect(database.query).toHaveBeenCalledTimes(4);
    expect(database.release).toHaveBeenCalledTimes(1);
    expect(database.release).toHaveBeenCalledWith(true);
  });

  it("destroys the leased client when COMMIT does not settle by the deadline", async () => {
    vi.useFakeTimers();
    try {
      const database = startupPool();
      database.query.mockImplementation(async (queryText: string) => {
        if (queryText.trim() === "COMMIT") {
          return await new Promise<never>(() => undefined);
        }
        if (
          queryText.includes(
            "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
          )
        ) {
          return { rows: [] };
        }
        if (queryText.includes("current_setting('max_connections')")) {
          return {
            rows: [
              {
                max_connections: "89",
                admin_reserved_connections: "3",
                server_version_num: "170005",
              },
            ],
          };
        }
        return {
          rows: [
            {
              hold_catalog_present: true,
              hold_catalog_exact: true,
              delivery_release_capability_exact: true,
            },
          ],
        };
      });
      const pending = startupApi().inspectMailDispatchRuntime(database);
      const rejection = expect(pending).rejects.toMatchObject({
        message: "Mail dispatch startup database inspection failed.",
      });

      await vi.advanceTimersByTimeAsync(6_000);
      await rejection;
      expect(database.query).toHaveBeenCalledTimes(4);
      expect(database.release).toHaveBeenCalledTimes(1);
      expect(database.release).toHaveBeenCalledWith(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
