import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  collectFullSchemaRestoreSnapshot,
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
        rows: [{
          journal_entry_count: "65",
          journal_tail_sha256: hex("a"),
          journal_tail_when: "1785000000000",
        }],
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
              acl: ["learncoding_ops=X/learncoding_owner"],
            },
          },
          {
            kind: "trigger",
            schema_name: "public",
            object_name: "email_outbox_dispatch_binding_guard",
            identity: "public.email_outbox",
            owner_name: "learncoding_owner",
            attributes: { enabled: "O" },
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
      journalEntryCount: 65,
      journalTailSha256: hex("a"),
      journalTailWhen: 1_785_000_000_000,
      objectContractSha256: stableSha256([
        {
          kind: "routine",
          schema_name: "public",
          object_name: "redact_unresolved_email_outbox_authority",
          identity: "timestamp with time zone, integer",
          owner_name: "learncoding_owner",
          attributes: {
            security_definer: true,
            configuration: ["search_path=pg_catalog"],
            acl: ["learncoding_ops=X/learncoding_owner"],
          },
        },
        {
          kind: "trigger",
          schema_name: "public",
          object_name: "email_outbox_dispatch_binding_guard",
          identity: "public.email_outbox",
          owner_name: "learncoding_owner",
          attributes: { enabled: "O" },
        },
      ]),
      mailRowsSha256: stableSha256([
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
      ]),
      mailRowCount: 2,
    });
    expect(queries).toHaveLength(4);
    expect(queries[1]).toContain("drizzle.__drizzle_migrations");
    expect(queries[2]).toContain("pg_catalog.pg_proc");
    expect(queries[2]).toContain("pg_catalog.pg_trigger");
    expect(queries[2]).toContain("pg_catalog.pg_attribute");
    expect(queries[2]).toContain("pg_catalog.pg_constraint");
    expect(queries[2]).toContain(
      "namespace.nspname in ('public', 'drizzle')",
    );
    expect(queries[2]).not.toContain("relation.relname = 'email_outbox'");
    expect(queries[2]).not.toContain("routine.proname like");
    expect(queries[3]).toContain("pg_catalog.to_jsonb(outbox)");
    expect(queries[3]).not.toMatch(/select\s+[a-z_, ]+\s+from public\.email_outbox/iu);
  });

  it("fails closed instead of hashing a missing journal or empty fixture set", async () => {
    const client: FullSchemaRestoreQueryClient = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ server_version_num: "170006" }] })
        .mockResolvedValueOnce({ rows: [{
          journal_entry_count: "0",
          journal_tail_sha256: null,
          journal_tail_when: null,
        }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };

    await expect(collectFullSchemaRestoreSnapshot(client))
      .rejects.toThrow("full-schema restore database snapshot failed");
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
    const ops: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        opsTrace.push(sql.replace(/\s+/gu, " ").trim());
        return { rows: [{ redacted_rows: "2" }] };
      }),
    };
    const verifier: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        verifierTrace.push(sql.replace(/\s+/gu, " ").trim());
        return { rows: [{ redacted_rows: "2" }] };
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
    expect(verifierTrace[0]).toContain("redacted+");
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
    const oneRow = {
      query: vi.fn(async () => ({ rows: [{ redacted_rows: "1" }] })),
    };

    await expect(runFullSchemaRestoreDatabaseSmoke({
      worker,
      ops: oneRow,
      verifier: oneRow,
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
