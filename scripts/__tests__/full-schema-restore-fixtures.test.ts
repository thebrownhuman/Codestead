import { describe, expect, it, vi } from "vitest";

import {
  seedRepresentativeMailAuthorityRows,
  verifyRestoredBackupAuthorityRows,
} from "../lib/full-schema-restore-fixtures";
import type { FullSchemaRestoreQueryClient } from "../lib/full-schema-restore-database";

const absentBackupAuthorityCatalog = {
  authority_table_present: false,
  enqueue_routine_present: false,
  authorize_routine_present: false,
};

describe("full-schema restore representative mail fixtures", () => {
  it("arms and terminally releases account and system rows when 0064 binding exists", async () => {
    const ownerTrace: string[] = [];
    const workerTrace: string[] = [];
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        ownerTrace.push(sql.replace(/\s+/gu, " ").trim());
        if (sql.includes("from pg_catalog.pg_attribute")) {
          return {
            rows: [
              { attname: "dispatch_binding_sha256" },
              { attname: "dispatch_binding_version" },
            ],
          };
        }
        if (sql.includes("authority_table_present")) {
          return { rows: [absentBackupAuthorityCatalog] };
        }
        if (
          sql.includes("status = 'quarantined'") &&
          sql.includes("returning id")
        ) {
          return { rows: [{ id: "2" }, { id: "4" }] };
        }
        if (sql.includes("as fixture_count")) {
          return { rows: [{ fixture_count: "4" }] };
        }
        return { rows: [] };
      }),
    };
    const worker: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        workerTrace.push(sql.replace(/\s+/gu, " ").trim());
        return {
          rows: [
            { id: "00000000-0000-4000-8000-000000000002" },
            { id: "00000000-0000-4000-8000-000000000004" },
          ],
        };
      }),
    };
    const backupReporter = { query: vi.fn() };

    await seedRepresentativeMailAuthorityRows({
      owner,
      worker,
      backupReporter,
    });

    expect(ownerTrace[0]).toContain("insert into public.user");
    expect(ownerTrace[0]).toContain("insert into public.access_request");
    expect(ownerTrace[0]).toContain(
      "full-schema-restore:system-quarantined:v1",
    );
    expect(ownerTrace[1]).toContain("from pg_catalog.pg_attribute");
    expect(workerTrace).toHaveLength(2);
    expect(workerTrace[0]).toContain("claim_token");
    expect(workerTrace[1]).toContain("dispatch_binding_version");
    expect(workerTrace[1]).toContain("'gmail-raw-v1'");
    expect(ownerTrace[2]).toContain("status = 'quarantined'");
    expect(ownerTrace[2]).toContain("claim_token = null");
    expect(ownerTrace[2]).toContain("lease_expires_at = null");
    expect(ownerTrace[2]).toContain("returning id");
    expect(ownerTrace.at(-1)).toContain("as fixture_count");
  });

  it("arms the exact 0066 correlation and evidence tuple when its columns exist", async () => {
    const workerTrace: string[] = [];
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from pg_catalog.pg_attribute")) {
          return {
            rows: [
              { attname: "dispatch_binding_sha256" },
              { attname: "dispatch_binding_version" },
              { attname: "provider_correlation_version" },
              { attname: "provider_evidence_sha256" },
              { attname: "provider_evidence_version" },
            ],
          };
        }
        if (sql.includes("authority_table_present")) {
          return { rows: [absentBackupAuthorityCatalog] };
        }
        if (
          sql.includes("status = 'quarantined'") &&
          sql.includes("returning id")
        ) {
          return { rows: [{ id: "2" }, { id: "4" }] };
        }
        if (sql.includes("as fixture_count")) {
          return { rows: [{ fixture_count: "4" }] };
        }
        return { rows: [] };
      }),
    };
    const worker: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        workerTrace.push(sql.replace(/\s+/gu, " ").trim());
        return {
          rows: [
            { id: "00000000-0000-4000-8000-000000000002" },
            { id: "00000000-0000-4000-8000-000000000004" },
          ],
        };
      }),
    };

    await seedRepresentativeMailAuthorityRows({
      owner,
      worker,
      backupReporter: { query: vi.fn() },
    });

    expect(workerTrace).toHaveLength(2);
    expect(workerTrace[1]).toContain(
      "provider_correlation_version = 'opaque-sha256-v1'",
    );
    expect(workerTrace[1]).toContain(
      "provider_evidence_version = 'gmail-header-evidence-v1'",
    );
    expect(workerTrace[1]).toContain("provider_evidence_sha256 = case id");
    expect(workerTrace[1]).toContain(`'${"c".repeat(64)}'`);
    expect(workerTrace[1]).toContain(`'${"d".repeat(64)}'`);
  });
  it("uses the released 0063 fixture shape before binding columns exist", async () => {
    const ownerTrace: string[] = [];
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        ownerTrace.push(sql.replace(/\s+/gu, " ").trim());
        if (sql.includes("from pg_catalog.pg_attribute")) {
          return { rows: [] };
        }
        if (sql.includes("authority_table_present")) {
          return { rows: [absentBackupAuthorityCatalog] };
        }
        if (
          sql.includes("status = 'quarantined'") &&
          sql.includes("returning id")
        ) {
          return { rows: [{ id: "2" }, { id: "4" }] };
        }
        if (sql.includes("as fixture_count")) {
          return { rows: [{ fixture_count: "4" }] };
        }
        return { rows: [] };
      }),
    };
    const worker = { query: vi.fn() };
    const backupReporter = { query: vi.fn() };

    await seedRepresentativeMailAuthorityRows({
      owner,
      worker,
      backupReporter,
    });

    expect(worker.query).not.toHaveBeenCalled();
    expect(ownerTrace[2]).toContain("provider_call_started");
    expect(ownerTrace[2]).not.toContain("dispatch_binding_version");
    expect(ownerTrace[2]).toContain("lease_expires_at = null");
  });

  it("fails closed unless both quarantine fixtures reach terminal state", async () => {
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from pg_catalog.pg_attribute")) {
          return { rows: [] };
        }
        if (sql.includes("authority_table_present")) {
          return { rows: [absentBackupAuthorityCatalog] };
        }
        if (
          sql.includes("status = 'quarantined'") &&
          sql.includes("returning id")
        ) {
          return { rows: [{ id: "2" }] };
        }
        if (sql.includes("as fixture_count")) {
          return { rows: [{ fixture_count: "4" }] };
        }
        return { rows: [] };
      }),
    };

    await expect(
      seedRepresentativeMailAuthorityRows({
        owner,
        worker: { query: vi.fn() },
        backupReporter: { query: vi.fn() },
      }),
    ).rejects.toThrow("full-schema restore fixture transition failed");
  });

  it("fails closed on a partial 0064 catalog", async () => {
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from pg_catalog.pg_attribute")) {
          return { rows: [{ attname: "dispatch_binding_sha256" }] };
        }
        return { rows: [] };
      }),
    };

    await expect(
      seedRepresentativeMailAuthorityRows({
        owner,
        worker: { query: vi.fn() },
        backupReporter: { query: vi.fn() },
      }),
    ).rejects.toThrow(
      "full-schema restore dispatch-binding catalog is invalid",
    );
  });

  it("fails closed on a partial 0066 correlation catalog", async () => {
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from pg_catalog.pg_attribute")) {
          return {
            rows: [
              { attname: "dispatch_binding_sha256" },
              { attname: "dispatch_binding_version" },
              { attname: "provider_correlation_version" },
            ],
          };
        }
        return { rows: [] };
      }),
    };

    await expect(
      seedRepresentativeMailAuthorityRows({
        owner,
        worker: { query: vi.fn() },
        backupReporter: { query: vi.fn() },
      }),
    ).rejects.toThrow(
      "full-schema restore dispatch-binding catalog is invalid",
    );
  });
  it("fails if the exact four-fixture inventory is not present", async () => {
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from pg_catalog.pg_attribute")) return { rows: [] };
        if (sql.includes("authority_table_present")) {
          return { rows: [absentBackupAuthorityCatalog] };
        }
        if (
          sql.includes("status = 'quarantined'") &&
          sql.includes("returning id")
        ) {
          return { rows: [{ id: "2" }, { id: "4" }] };
        }
        if (sql.includes("as fixture_count")) {
          return { rows: [{ fixture_count: "3" }] };
        }
        return { rows: [] };
      }),
    };

    await expect(
      seedRepresentativeMailAuthorityRows({
        owner,
        worker: { query: vi.fn() },
        backupReporter: { query: vi.fn() },
      }),
    ).rejects.toThrow("full-schema restore fixture verification failed");
  });

  it("seeds and verifies an exact durable 0065 backup authority/outbox pair", async () => {
    const queued = {
      acknowledgement: "queued",
      authority_id: "50000000-0000-4000-8000-000000000001",
      outbox_id: "50000000-0000-4000-8000-000000000002",
      operation_id: "50000000-0000-4000-8000-000000000003",
    };
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from pg_catalog.pg_attribute")) return { rows: [] };
        if (sql.includes("authority_table_present")) {
          return {
            rows: [
              {
                authority_table_present: true,
                enqueue_routine_present: true,
                authorize_routine_present: true,
              },
            ],
          };
        }
        if (sql.includes("status = 'quarantined'")) {
          return { rows: [{ id: "2" }, { id: "4" }] };
        }
        if (sql.includes("from public.backup_status_mail_authority")) {
          return {
            rows: [
              {
                id: queued.authority_id,
                run_key: "20260725T000000Z",
                outcome: "success",
                recipient_user_id: "full-schema-restore-admin",
                recipient_email: "admin.restore@invalid.local",
                outbox_id: queued.outbox_id,
                operation_id: queued.operation_id,
                user_id: "full-schema-restore-admin",
                delivery_scope_key: "a:full-schema-restore-admin",
                to_email: "admin.restore@invalid.local",
                template: "backup-status",
                template_version: "1",
                variables: {
                  name: "Administrator",
                  summary:
                    "The nightly encrypted backup completed and passed local verification. No archive is attached to this email.",
                },
                idempotency_key: "backup-status:v1:20260725T000000Z",
              },
            ],
          };
        }
        if (sql.includes("as fixture_count")) {
          return { rows: [{ fixture_count: "5" }] };
        }
        return { rows: [] };
      }),
    };
    const worker: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("backup_status_mail_authorized")) {
          return { rows: [{ authorized: true }] };
        }
        return { rows: [] };
      }),
    };
    const backupReporter: FullSchemaRestoreQueryClient = {
      query: vi.fn(async () => ({ rows: [queued] })),
    };

    await seedRepresentativeMailAuthorityRows({
      owner,
      worker,
      backupReporter,
    });

    expect(backupReporter.query).toHaveBeenCalledWith(
      expect.stringContaining("enqueue_backup_status_mail_authority"),
      ["20260725T000000Z", "success"],
    );
    expect(worker.query).toHaveBeenCalledWith(
      expect.stringContaining("backup_status_mail_authorized"),
      [queued.outbox_id],
    );
  });

  it("fails closed on a partial 0065 authority catalog", async () => {
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from pg_catalog.pg_attribute")) return { rows: [] };
        if (sql.includes("authority_table_present")) {
          return {
            rows: [
              {
                authority_table_present: true,
                enqueue_routine_present: false,
                authorize_routine_present: true,
              },
            ],
          };
        }
        if (sql.includes("status = 'quarantined'")) {
          return { rows: [{ id: "2" }, { id: "4" }] };
        }
        return { rows: [] };
      }),
    };

    await expect(
      seedRepresentativeMailAuthorityRows({
        owner,
        worker: { query: vi.fn() },
        backupReporter: { query: vi.fn() },
      }),
    ).rejects.toThrow(
      "full-schema restore backup authority catalog is invalid",
    );
  });

  it("fails closed when the 0065 predicate rejects the restored row", async () => {
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from pg_catalog.pg_attribute")) return { rows: [] };
        if (sql.includes("authority_table_present")) {
          return {
            rows: [
              {
                authority_table_present: true,
                enqueue_routine_present: true,
                authorize_routine_present: true,
              },
            ],
          };
        }
        if (sql.includes("status = 'quarantined'")) {
          return { rows: [{ id: "2" }, { id: "4" }] };
        }
        if (sql.includes("from public.backup_status_mail_authority")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const queued = {
      acknowledgement: "queued",
      authority_id: "50000000-0000-4000-8000-000000000001",
      outbox_id: "50000000-0000-4000-8000-000000000002",
      operation_id: "50000000-0000-4000-8000-000000000003",
    };

    await expect(
      seedRepresentativeMailAuthorityRows({
        owner,
        worker: {
          query: vi.fn(async () => ({ rows: [{ authorized: false }] })),
        },
        backupReporter: {
          query: vi.fn(async () => ({ rows: [queued] })),
        },
      }),
    ).rejects.toThrow(
      "full-schema restore backup authority verification failed",
    );
  });

  const restoredIds = {
    authorityId: "50000000-0000-4000-8000-000000000001",
    outboxId: "50000000-0000-4000-8000-000000000002",
    operationId: "50000000-0000-4000-8000-000000000003",
  } as const;
  const exactRestoredAuthorityRow = {
    id: restoredIds.authorityId,
    run_key: "20260725T000000Z",
    outcome: "success",
    recipient_user_id: "full-schema-restore-admin",
    recipient_email: "admin.restore@invalid.local",
    outbox_id: restoredIds.outboxId,
    operation_id: restoredIds.operationId,
    user_id: "full-schema-restore-admin",
    delivery_scope_key: "a:full-schema-restore-admin",
    to_email: "admin.restore@invalid.local",
    template: "backup-status",
    template_version: "1",
    variables: {
      name: "Administrator",
      summary:
        "The nightly encrypted backup completed and passed local verification. No archive is attached to this email.",
    },
    idempotency_key: "backup-status:v1:20260725T000000Z",
  } as const;

  function restoredOwner(): FullSchemaRestoreQueryClient {
    return {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("authority_table_present")) {
          return {
            rows: [
              {
                authority_table_present: true,
                enqueue_routine_present: true,
                authorize_routine_present: true,
              },
            ],
          };
        }
        if (sql.includes("as authority_id")) {
          return {
            rows: [
              {
                authority_id: restoredIds.authorityId,
                outbox_id: restoredIds.outboxId,
                operation_id: restoredIds.operationId,
              },
            ],
          };
        }
        if (sql.includes("from public.backup_status_mail_authority")) {
          return { rows: [exactRestoredAuthorityRow] };
        }
        return { rows: [] };
      }),
    };
  }

  it("replays restored 0065 authority as existing with exact durable IDs", async () => {
    const owner = restoredOwner();
    const worker: FullSchemaRestoreQueryClient = {
      query: vi.fn(async () => ({ rows: [{ authorized: true }] })),
    };
    const backupReporter: FullSchemaRestoreQueryClient = {
      query: vi.fn(async () => ({
        rows: [
          {
            acknowledgement: "existing",
            authority_id: restoredIds.authorityId,
            outbox_id: restoredIds.outboxId,
            operation_id: restoredIds.operationId,
          },
        ],
      })),
    };

    await verifyRestoredBackupAuthorityRows({
      owner,
      worker,
      backupReporter,
    });

    expect(backupReporter.query).toHaveBeenCalledWith(
      expect.stringContaining("enqueue_backup_status_mail_authority"),
      ["20260725T000000Z", "success"],
    );
    expect(worker.query).toHaveBeenCalledWith(
      expect.stringContaining("backup_status_mail_authorized"),
      [restoredIds.outboxId],
    );
  });

  it.each([
    ["acknowledgement", { acknowledgement: "queued" }],
    [
      "authority ID",
      {
        authority_id: "50000000-0000-4000-8000-000000000099",
      },
    ],
    [
      "outbox ID",
      {
        outbox_id: "50000000-0000-4000-8000-000000000099",
      },
    ],
    [
      "operation ID",
      {
        operation_id: "50000000-0000-4000-8000-000000000099",
      },
    ],
  ])(
    "rejects restored 0065 replay with a mismatched %s",
    async (_field, override) => {
      const worker = { query: vi.fn() };
      await expect(
        verifyRestoredBackupAuthorityRows({
          owner: restoredOwner(),
          worker,
          backupReporter: {
            query: vi.fn(async () => ({
              rows: [
                {
                  acknowledgement: "existing",
                  authority_id: restoredIds.authorityId,
                  outbox_id: restoredIds.outboxId,
                  operation_id: restoredIds.operationId,
                  ...override,
                },
              ],
            })),
          },
        }),
      ).rejects.toThrow("full-schema restore backup authority replay failed");
      expect(worker.query).not.toHaveBeenCalled();
    },
  );

  it("skips replay only when all 0065 authority objects are absent", async () => {
    const owner: FullSchemaRestoreQueryClient = {
      query: vi.fn(async () => ({
        rows: [absentBackupAuthorityCatalog],
      })),
    };
    const worker = { query: vi.fn() };
    const backupReporter = { query: vi.fn() };

    await verifyRestoredBackupAuthorityRows({
      owner,
      worker,
      backupReporter,
    });

    expect(owner.query).toHaveBeenCalledOnce();
    expect(worker.query).not.toHaveBeenCalled();
    expect(backupReporter.query).not.toHaveBeenCalled();
  });
});
