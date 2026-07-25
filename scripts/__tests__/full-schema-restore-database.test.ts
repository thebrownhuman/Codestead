import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  collectFullSchemaRestoreSnapshot,
  hashFullSchemaObjectContract,
  runFullSchemaRestoreDatabaseSmoke,
  stableSha256,
  type FullSchemaRestoreQueryClient,
} from "../lib/full-schema-restore-database";

const hex = (character: string) => character.repeat(64);

describe("full-schema restore catalog and row snapshot", () => {
  it("hashes recursively canonicalized data without depending on object key order", () => {
    expect(stableSha256([
      { z: 1, nested: { beta: true, alpha: null }, a: "x" },
    ])).toBe(stableSha256([
      { a: "x", nested: { alpha: null, beta: true }, z: 1 },
    ]));
    expect(stableSha256([{ a: 1 }, { a: 2 }]))
      .not.toBe(stableSha256([{ a: 2 }, { a: 1 }]));
  });

  it("collects a dynamic journal tail, complete object contract, and future-column mail rows", async () => {
    const queries: string[] = [];
    const responses = [
      { rows: [{ server_version_num: "170006" }] },
      {
        rows: [
          {
            migration_index: "0",
            migration_sha256: hex("0"),
            migration_when: "1784999999999",
          },
          {
            migration_index: "1",
            migration_sha256: hex("a"),
            migration_when: "1785000000000",
          },
        ],
      },
      {
        rows: [
          {
            kind: "routine",
            schema_name: "public",
            object_name: "redact_unresolved_email_outbox_authority",
            identity: "timestamp with time zone, integer",
            owner_name: "learncoding_owner",
            attributes: {
              security_definer: true,
              configuration: ["search_path=pg_catalog"],
              definition: "CREATE FUNCTION authority() RETURNS void",
              acl: ["learncoding_ops=X/learncoding_owner"],
            },
          },
          {
            kind: "trigger",
            schema_name: "public",
            object_name: "email_outbox_dispatch_binding_guard",
            identity: "public.email_outbox",
            owner_name: "learncoding_owner",
            attributes: {
              enabled: "O",
              force_row_security: false,
              policies: [],
              row_security: false,
            },
          },
        ],
      },
      {
        rows: [
          {
            payload: {
              idempotency_key: "full-schema-restore:account-pending:v1",
              dispatch_binding_sha256: null,
              future_column: "preserved",
            },
          },
          {
            payload: {
              idempotency_key: "full-schema-restore:account-quarantined:v1",
              dispatch_binding_sha256: hex("b"),
              future_column: "preserved",
            },
          },
        ],
      },
      { rows: [{ authority_table_present: true }] },
      {
        rows: [{
          payload: {
            id: "50000000-0000-4000-8000-000000000001",
            run_key: "20260725T000000Z",
            outbox_id: "50000000-0000-4000-8000-000000000002",
          },
        }],
      },
    ];
    const client: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql.replace(/\s+/gu, " ").trim());
        return responses.shift()!;
      }),
    };

    const result = await collectFullSchemaRestoreSnapshot(client);

    expect(result).toEqual({
      postgresMajor: 17,
      journalEntryCount: 2,
      journalTailSha256: hex("a"),
      journalTailWhen: 1_785_000_000_000,
      migrationLedgerSha256: stableSha256({
        version: "drizzle-migration-ledger-v1",
        entries: [
          { migration_index: "0", migration_sha256: hex("0"), migration_when: "1784999999999" },
          { migration_index: "1", migration_sha256: hex("a"), migration_when: "1785000000000" },
        ],
      }),
      objectContractSha256: stableSha256({
        version: "postgres-object-contract-v2",
        objects: [
        {
          kind: "routine",
          schema_name: "public",
          object_name: "redact_unresolved_email_outbox_authority",
          identity: "timestamp with time zone, integer",
          owner_name: "learncoding_owner",
          attributes: {
            security_definer: true,
            configuration: ["search_path=pg_catalog"],
            definition: "CREATE FUNCTION authority() RETURNS void",
            acl: ["learncoding_ops=X/learncoding_owner"],
          },
        },
        {
          kind: "trigger",
          schema_name: "public",
          object_name: "email_outbox_dispatch_binding_guard",
          identity: "public.email_outbox",
          owner_name: "learncoding_owner",
          attributes: {
            enabled: "O",
            force_row_security: false,
            policies: [],
            row_security: false,
          },
        },
      ]}),
      mailRowsSha256: stableSha256({
        version: "mail-authority-rows-v2",
        outbox: [
          {
            idempotency_key: "full-schema-restore:account-pending:v1",
            dispatch_binding_sha256: null,
            future_column: "preserved",
          },
          {
            idempotency_key: "full-schema-restore:account-quarantined:v1",
            dispatch_binding_sha256: hex("b"),
            future_column: "preserved",
          },
        ],
        backupStatusAuthority: [{
          id: "50000000-0000-4000-8000-000000000001",
          run_key: "20260725T000000Z",
          outbox_id: "50000000-0000-4000-8000-000000000002",
        }],
      }),
      mailRowCount: 2,
    });
    expect(queries).toHaveLength(6);
    expect(queries[1]).toContain("drizzle.__drizzle_migrations");
    expect(queries[2]).toContain("pg_catalog.pg_proc");
    expect(queries[2]).toContain("pg_catalog.pg_trigger");
    expect(queries[2]).toContain("pg_catalog.pg_attribute");
    expect(queries[2]).toContain("pg_catalog.pg_constraint");
    expect(queries[2]).toContain("pg_catalog.pg_get_functiondef");
    expect(queries[2]).toContain("pg_catalog.pg_get_indexdef");
    expect(queries[2]).toContain("pg_catalog.pg_get_viewdef");
    expect(queries[2]).toContain("relation.relrowsecurity");
    expect(queries[2]).toContain("relation.relforcerowsecurity");
    expect(queries[2]).toContain("pg_catalog.pg_policy");
    expect(queries[2]).toContain("pg_catalog.pg_enum");
    expect(queries[2]).toContain("type_row.typbasetype");
    expect(queries[2]).toContain("pg_catalog.pg_range");
    expect(queries[2]).toContain("pg_catalog.pg_sequence");
    expect(queries[2]).toContain("pg_catalog.pg_sequence_last_value");
    expect(queries[2]).toContain("'learncoding_backup_reporter'");
    expect(queries[2]).toContain(
      "namespace.nspname in ('public', 'drizzle')",
    );
    expect(queries[2]).not.toContain("relation.relname = 'email_outbox'");
    expect(queries[2]).not.toContain("routine.proname like");
    expect(queries[3]).toContain("pg_catalog.to_jsonb(outbox)");
    expect(queries[3]).toContain("backup-status:v1:20260725T000000Z");
    expect(queries[5]).toContain("backup_status_mail_authority");
    expect(queries[3]).not.toMatch(/select\s+[a-z_, ]+\s+from public\.email_outbox/iu);
  });

  it("fails closed instead of hashing a missing journal or empty fixture set", async () => {
    const client: FullSchemaRestoreQueryClient = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ server_version_num: "170006" }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    await expect(collectFullSchemaRestoreSnapshot(client))
      .rejects.toThrow("full-schema restore database snapshot failed");
  });

  const baseObject = {
    kind: "routine",
    schema_name: "public",
    object_name: "authority",
    identity: "uuid",
    owner_name: "learncoding_owner",
    attributes: {
      acl: ["learncoding_worker=X/learncoding_owner"],
      definition: "CREATE FUNCTION authority(uuid) RETURNS boolean AS 'SELECT true'",
      policies: [],
    },
  } as const;

  it.each([
    ["routine body", {
      definition: "CREATE FUNCTION authority(uuid) RETURNS boolean AS 'SELECT false'",
    }],
    ["index definition", {
      definition: "CREATE UNIQUE INDEX authority_idx ON authority (id, operation_id)",
    }],
    ["view definition", {
      definition: "SELECT id, operation_id FROM authority WHERE active",
    }],
    ["RLS policy", {
      policies: [{
        name: "worker_scope",
        command: "r",
        permissive: true,
        roles: ["learncoding_worker"],
        using: "tenant_id = current_setting('app.tenant')",
        with_check: null,
      }],
    }],
    ["enum labels", {
      enum_labels: [
        { label: "pending", sort_order: "1" },
        { label: "quarantined", sort_order: "2" },
      ],
    }],
    ["domain semantics", {
      domain: {
        base_type: "text",
        default: "'pending'::text",
        not_null: true,
        constraints: [{
          name: "status_valid",
          definition: "CHECK (VALUE <> '')",
          validated: true,
        }],
      },
    }],
    ["range semantics", {
      range: {
        kind: "range",
        subtype: "timestamp with time zone",
        collation: null,
        opclass: "pg_catalog.timestamptz_ops",
        canonical: null,
        subdiff: "pg_catalog.tstzrange_subdiff(timestamp with time zone,timestamp with time zone)",
      },
    }],
    ["sequence state", {
      sequence: {
        data_type: "bigint",
        start: "1",
        minimum: "1",
        maximum: "9223372036854775807",
        increment: "1",
        cache: "1",
        cycle: false,
        last_value: "42",
      },
    }],
  ])("changes the versioned object digest for mutated %s with equal metadata", (
    _label,
    changedAttributes,
  ) => {
    const baseline = hashFullSchemaObjectContract([baseObject]);
    const mutated = hashFullSchemaObjectContract([{
      ...baseObject,
      attributes: {
        ...baseObject.attributes,
        ...changedAttributes,
      },
    }]);
    expect(mutated).not.toBe(baseline);
  });

  it("requires the database object manifest to be canonically sorted", () => {
    expect(() => hashFullSchemaObjectContract([
      { ...baseObject, object_name: "z" },
      { ...baseObject, object_name: "a" },
    ])).toThrow("full-schema restore object contract is invalid");
  });
});

describe("full-schema restore SQL-only smoke", () => {
  it("rolls back the worker claim probe and commits ops redaction without any provider call", async () => {
    const workerTrace: string[] = [];
    const opsTrace: string[] = [];
    const verifierTrace: string[] = [];
    const worker: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        workerTrace.push(sql.replace(/\s+/gu, " ").trim());
        if (sql.includes("returning id")) {
          return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }] };
        }
        return { rows: [] };
      }),
    };
    const redactionSummary = [
      { disposition: "eligible", eligible: "2", transitioned: "2" },
      { disposition: "blocked", eligible: "0", transitioned: "0" },
      { disposition: "malformed", eligible: "0", transitioned: "0" },
    ];
    const ops: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        opsTrace.push(sql.replace(/\s+/gu, " ").trim());
        return { rows: redactionSummary };
      }),
    };
    const verifier: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        verifierTrace.push(sql.replace(/\s+/gu, " ").trim());
        return {
          rows: [
            {
              id: "20000000-0000-4000-8000-000000000002",
              idempotency_key: "full-schema-restore:account-quarantined:v1",
              user_id: "full-schema-restore-learner",
              to_email:
                "redacted+20000000-0000-4000-8000-000000000002@invalid.local",
              variables: {},
            },
            {
              id: "20000000-0000-4000-8000-000000000004",
              idempotency_key: "full-schema-restore:system-quarantined:v1",
              user_id: null,
              to_email:
                "redacted+20000000-0000-4000-8000-000000000004@invalid.local",
              variables: {
                _mailOperationId: "30000000-0000-4000-8000-000000000004",
                _mailRecipient:
                  "redacted+20000000-0000-4000-8000-000000000004@invalid.local",
                _mailProducer: "access-request-admin",
                _mailSourceId: "10000000-0000-4000-8000-000000000001",
              },
            },
          ],
        };
      }),
    };

    const result = await runFullSchemaRestoreDatabaseSmoke({
      worker,
      ops,
      verifier,
    });

    expect(result).toEqual({
      claimedRows: 1,
      redactedRows: 2,
      externalCalls: 0,
    });
    expect(workerTrace[0]).toBe("begin");
    expect(workerTrace).toContain("rollback");
    expect(workerTrace.some((sql) =>
      sql.includes("pg_catalog.pg_advisory_xact_lock"))).toBe(true);
    expect(opsTrace).toHaveLength(1);
    expect(opsTrace[0]).toContain(
      "public.redact_unresolved_email_outbox_authority",
    );
    expect(opsTrace[0]).toContain("transitioned");
    expect(opsTrace[0]).toContain("disposition");
    expect(opsTrace[0]).not.toContain("count(*)");
    expect(verifierTrace[0]).toContain("idempotency_key");
    expect(verifierTrace[0]).toContain("variables");
    expect(verifierTrace[0]).not.toContain("jsonb_object_length");
    expect([
      ...workerTrace,
      ...opsTrace,
      ...verifierTrace,
    ].join("\n")).not.toMatch(/gmail|fetch|oauth|provider\.send/iu);
  });

  it("requires both account and system quarantine rows to be redacted", async () => {
    const worker: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("returning id")) {
          return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }] };
        }
        return { rows: [] };
      }),
    };
    const ops = {
      query: vi.fn(async () => ({
        rows: [
          { disposition: "eligible", eligible: "2", transitioned: "1" },
          { disposition: "blocked", eligible: "0", transitioned: "0" },
          { disposition: "malformed", eligible: "0", transitioned: "0" },
        ],
      })),
    };
    const verifier = {
      query: vi.fn(async () => ({ rows: [{ redacted_rows: "1" }] })),
    };

    await expect(runFullSchemaRestoreDatabaseSmoke({
      worker,
      ops,
      verifier,
    })).rejects.toThrow("full-schema restore database smoke failed");
  });

  it("rejects the legacy count-of-summary-rows interpretation", async () => {
    const worker: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("returning id")) {
          return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }] };
        }
        return { rows: [] };
      }),
    };

    await expect(runFullSchemaRestoreDatabaseSmoke({
      worker,
      ops: {
        query: vi.fn(async () => ({ rows: [{ redacted_rows: "3" }] })),
      },
      verifier: {
        query: vi.fn(async () => ({ rows: [{ redacted_rows: "2" }] })),
      },
    })).rejects.toThrow("full-schema restore database smoke failed");
  });

  it("rejects unexpected 0063 disposition counts", async () => {
    const worker: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("returning id")) {
          return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }] };
        }
        return { rows: [] };
      }),
    };

    await expect(runFullSchemaRestoreDatabaseSmoke({
      worker,
      ops: {
        query: vi.fn(async () => ({
          rows: [
            { disposition: "eligible", eligible: "2", transitioned: "2" },
            { disposition: "blocked", eligible: "1", transitioned: "0" },
            { disposition: "malformed", eligible: "0", transitioned: "0" },
          ],
        })),
      },
      verifier: {
        query: vi.fn(async () => ({ rows: [{ redacted_rows: "2" }] })),
      },
    })).rejects.toThrow("full-schema restore database smoke failed");
  });

  it.each([
    ["_mailOperationId", "30000000-0000-4000-8000-000000000099"],
    ["_mailRecipient", "mutated-recipient@invalid.local"],
    ["_mailProducer", "access-request-approved"],
    ["_mailSourceId", "10000000-0000-4000-8000-000000000099"],
    ["_unexpected", "extra-value"],
  ])("rejects a mutated restored system envelope field %s", async (
    field,
    value,
  ) => {
    const worker: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("returning id")) {
          return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }] };
        }
        return { rows: [] };
      }),
    };
    const systemVariables: Record<string, string> = {
      _mailOperationId: "30000000-0000-4000-8000-000000000004",
      _mailRecipient:
        "redacted+20000000-0000-4000-8000-000000000004@invalid.local",
      _mailProducer: "access-request-admin",
      _mailSourceId: "10000000-0000-4000-8000-000000000001",
    };
    systemVariables[field] = value;

    await expect(runFullSchemaRestoreDatabaseSmoke({
      worker,
      ops: {
        query: vi.fn(async () => ({
          rows: [
            { disposition: "eligible", eligible: "2", transitioned: "2" },
            { disposition: "blocked", eligible: "0", transitioned: "0" },
            { disposition: "malformed", eligible: "0", transitioned: "0" },
          ],
        })),
      },
      verifier: {
        query: vi.fn(async () => ({
          rows: [
            {
              id: "20000000-0000-4000-8000-000000000002",
              idempotency_key: "full-schema-restore:account-quarantined:v1",
              user_id: "full-schema-restore-learner",
              to_email:
                "redacted+20000000-0000-4000-8000-000000000002@invalid.local",
              variables: {},
            },
            {
              id: "20000000-0000-4000-8000-000000000004",
              idempotency_key: "full-schema-restore:system-quarantined:v1",
              user_id: null,
              to_email:
                "redacted+20000000-0000-4000-8000-000000000004@invalid.local",
              variables: systemVariables,
            },
          ],
        })),
      },
    })).rejects.toThrow("full-schema restore database smoke failed");
  });

  it("always rolls back a failed worker probe", async () => {
    const trace: string[] = [];
    const worker: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        const normalized = sql.trim().toLowerCase();
        trace.push(normalized);
        if (normalized.startsWith("update")) {
          throw new Error("synthetic claim failure");
        }
        return { rows: [] };
      }),
    };

    await expect(runFullSchemaRestoreDatabaseSmoke({
      worker,
      ops: { query: vi.fn() },
      verifier: { query: vi.fn() },
    })).rejects.toThrow("synthetic claim failure");
    expect(trace.at(-1)).toBe("rollback");
  });

  it("uses SHA-256 rather than a weak catalog checksum", () => {
    expect(stableSha256({ value: "catalog" })).toBe(
      createHash("sha256")
        .update('{"value":"catalog"}', "utf8")
        .digest("hex"),
    );
  });
});
