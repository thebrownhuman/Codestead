import { describe, expect, it, vi } from "vitest";

import { deriveFullSchemaArchiveEvidence } from "../lib/full-schema-restore-archive";
import {
  prepareFullSchemaAclSuppressionControl,
  requireFullSchemaAclSuppressionControl,
  requireExactFullSchemaRestoreOwnerRole,
} from "../lib/full-schema-restore-database";
import {
  deriveMigrationLedgerContract,
  runFullSchemaRestoreVerification,
} from "../lib/full-schema-restore-gate";
import { buildPostgresArchiveCommands } from "../lib/full-schema-restore-runtime";

type Query = (
  sql: string,
  values?: readonly unknown[],
) => Promise<
  Readonly<{
    rows: readonly Record<string, unknown>[];
  }>
>;

const sourceId = "a".repeat(64);
const targetId = "b".repeat(64);
const sha = (value: string) => value.repeat(64).slice(0, 64);

const migration = deriveMigrationLedgerContract(
  {
    version: "7",
    dialect: "postgresql",
    entries: Array.from({ length: 64 }, (_, idx) => ({
      idx,
      version: "7",
      when: 1_780_000_000_000 + idx,
      tag: `${String(idx).padStart(4, "0")}_restore_acl_${idx}`,
      breakpoints: true,
    })),
  },
  Array.from({ length: 64 }, (_, idx) => `select ${idx};`),
);

const snapshot = (objectContractSha256 = sha("a")) => ({
  postgresMajor: 17,
  journalEntryCount: migration.entryCount,
  journalTailSha256: migration.tailSha256,
  journalTailWhen: migration.tailWhen,
  migrationLedgerSha256: migration.databaseLedgerSha256,
  objectContractSha256,
  mailRowsSha256: sha("b"),
  mailRowCount: 4,
});

const archiveEvidence = {
  archiveSha256: sha("c"),
  tocSha256: sha("d"),
  sourceObjectContractSha256: sha("a"),
  sourceBindingSha256: sha("e"),
  aclEntryCount: 2,
  routineAclEntryCount: 1,
};

describe("ACL-preserving full-schema archive commands", () => {
  it("keeps ACLs while remapping ownership through the exact owner role", () => {
    const commands = buildPostgresArchiveCommands({
      dockerCommand: "docker",
      sourceContainerId: sourceId,
      targetContainerId: targetId,
      sourceDatabase: "learncoding_restore_source",
      targetDatabase: "learncoding_restore_target",
      postgresUser: "learncoding_restore_it",
    });

    expect(commands.dump.args).toContain("--no-owner");
    expect(commands.dump.args).not.toContain("--no-acl");
    expect(commands.list.args).toContain("--list");
    expect(commands.restore.args).toContain("--no-owner");
    expect(commands.restore.args).toContain("--role=learncoding_owner");
    expect(commands.restore.args).not.toContain("--no-acl");
    expect(commands.restoreWithoutAcl.args).toContain("--no-acl");
    expect(commands.restoreWithoutAcl.args).toContain(
      "--role=learncoding_owner",
    );
  });

  it("rejects the ACL-free TOC produced by --no-acl", () => {
    expect(() =>
      deriveFullSchemaArchiveEvidence({
        archive: Buffer.from("opaque-custom-archive"),
        toc: Buffer.from(
          "4101; 1255 9001 FUNCTION public reviewed(uuid) learncoding_owner\n",
        ),
        sourceObjectContractSha256: sha("a"),
      }),
    ).toThrow("full-schema restore archive ACL evidence failed");
  });

  it("binds routine ACL TOC evidence to the source object contract", () => {
    const evidence = deriveFullSchemaArchiveEvidence({
      archive: Buffer.from("opaque-custom-archive"),
      toc: Buffer.from(
        [
          "4102; 0 0 ACL public FUNCTION reviewed(uuid) learncoding_owner",
          "4103; 0 0 ACL public TABLE email_outbox learncoding_owner",
          "",
        ].join("\n"),
      ),
      sourceObjectContractSha256: sha("a"),
    });

    expect(evidence).toMatchObject({
      aclEntryCount: 2,
      routineAclEntryCount: 1,
      sourceObjectContractSha256: sha("a"),
    });
    expect(evidence.sourceBindingSha256).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("controlled restore role prerequisite", () => {
  it("requires one exact non-login owner role", async () => {
    const query = vi.fn<Query>(async () => ({
      rows: [
        {
          rolname: "learncoding_owner",
          rolcanlogin: false,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolreplication: false,
          rolbypassrls: false,
          rolconnlimit: -1,
          valid_until_infinity: true,
          password_is_null: true,
          role_settings_empty: true,
          membership_contract_exact: true,
        },
      ],
    }));

    await expect(
      requireExactFullSchemaRestoreOwnerRole({ query }),
    ).resolves.toBeUndefined();
    expect(query.mock.calls[0]?.[0]).toContain("pg_catalog.pg_authid");
    expect(query.mock.calls[0]?.[0]).toContain("pg_catalog.pg_auth_members");
    expect(query.mock.calls[0]?.[0]).toContain("membership.inherit_option");
    expect(query.mock.calls[0]?.[0]).toContain("membership.set_option");
    expect(query.mock.calls[0]?.[0]).toContain("'learncoding_backup_reporter'");
  });

  it("rejects any noncanonical membership involving an application role", async () => {
    await expect(
      requireExactFullSchemaRestoreOwnerRole({
        query: async () => ({
          rows: [
            {
              rolname: "learncoding_owner",
              rolcanlogin: false,
              rolsuper: false,
              rolcreatedb: false,
              rolcreaterole: false,
              rolinherit: false,
              rolreplication: false,
              rolbypassrls: false,
              rolconnlimit: -1,
              valid_until_infinity: true,
              password_is_null: true,
              role_settings_empty: true,
              membership_contract_exact: false,
            },
          ],
        }),
      }),
    ).rejects.toThrow("full-schema restore owner role is invalid");
  });

  it("rejects a PUBLIC-capable login role substitute", async () => {
    await expect(
      requireExactFullSchemaRestoreOwnerRole({
        query: async () => ({
          rows: [
            {
              rolname: "learncoding_owner",
              rolcanlogin: true,
              rolsuper: false,
              rolcreatedb: false,
              rolcreaterole: false,
              rolinherit: false,
              rolreplication: false,
              rolbypassrls: false,
              rolconnlimit: -1,
              valid_until_infinity: true,
              password_is_null: false,
              role_settings_empty: true,
            },
          ],
        }),
      }),
    ).rejects.toThrow("full-schema restore owner role is invalid");
  });
});

describe("live ACL-suppression negative control", () => {
  it("temporarily restores PostgreSQL's PUBLIC routine default", async () => {
    const query = vi.fn<Query>(async () => ({ rows: [] }));

    await expect(
      prepareFullSchemaAclSuppressionControl({ query }),
    ).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain(
      "alter default privileges for role learncoding_owner",
    );
    expect(query.mock.calls[0]?.[0]).toContain(
      "grant execute on routines to public",
    );
  });

  it("requires --no-acl to produce proacl NULL and effective PUBLIC EXECUTE", async () => {
    const query = vi.fn<Query>(async () => ({
      rows: [
        {
          proacl_is_null: true,
          public_execute: true,
          routine:
            "public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)",
        },
      ],
    }));

    await expect(
      requireFullSchemaAclSuppressionControl({ query }),
    ).resolves.toEqual({
      proaclIsNull: true,
      publicExecute: true,
      routine:
        "public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)",
    });
    const sql = query.mock.calls[0]?.[0] ?? "";
    expect(sql).toContain("pg_catalog.aclexplode");
    expect(sql).toContain("acl.grantee = 0");
    expect(sql).toContain(
      "public.redact_quarantined_email_outbox_authority_v2",
    );
    expect(query.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("fails closed unless both suppression properties are observed", async () => {
    await expect(
      requireFullSchemaAclSuppressionControl({
        query: async () => ({
          rows: [
            {
              proacl_is_null: false,
              public_execute: true,
            },
          ],
        }),
      }),
    ).rejects.toThrow("ACL suppression control failed");
  });
});

describe("raw pre-repair restore evidence", () => {
  it("source-binds archive ACL evidence and raw catalog before reconciliation", async () => {
    const trace: string[] = [];
    let sourceSnapshots = 0;
    let targetSnapshots = 0;
    const result = await runFullSchemaRestoreVerification({
      expectedPostgresMajor: 17,
      migration,
      source: {
        reconcileRoles: async () => {
          trace.push("source.roles");
        },
        verifyRoleBoundaries: async (full) => {
          trace.push(`source.boundary:${String(full)}`);
        },
        verifyPreRepairMailAuthorityCatalog: async () => {
          trace.push("source.catalog.raw");
        },
        verifyMailAuthorityCatalog: async () => {
          trace.push("source.catalog.reviewed");
        },
        migrate: async () => {
          trace.push("source.migrate");
        },
        seedRepresentativeMailRows: async () => {
          trace.push("source.seed");
        },
        snapshot: async () => {
          sourceSnapshots += 1;
          trace.push(`source.snapshot:${sourceSnapshots}`);
          return snapshot();
        },
      },
      target: {
        reconcileRoles: async () => {
          trace.push("target.roles");
        },
        verifyRoleBoundaries: async (full) => {
          trace.push(`target.boundary:${String(full)}`);
        },
        requireRestoreOwnerRole: async () => {
          trace.push("target.restore-role");
        },
        prepareAclSuppressionControl: async () => {
          trace.push("target.acl-suppression.prepare");
        },
        verifyPreRepairMailAuthorityCatalog: async () => {
          trace.push("target.catalog.raw");
        },
        verifyAclSuppressionControl: async () => {
          trace.push("target.acl-suppression");
          return {
            proaclIsNull: true,
            publicExecute: true,
            routine:
              "public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)",
          };
        },
        resetAfterAclSuppressionControl: async () => {
          trace.push("target.reset-after-acl-suppression");
        },
        verifyMailAuthorityCatalog: async () => {
          trace.push("target.catalog.reviewed");
        },
        snapshot: async () => {
          targetSnapshots += 1;
          trace.push(`target.snapshot:${targetSnapshots}`);
          return snapshot();
        },
        runNonNetworkSmoke: async () => {
          trace.push("target.smoke");
          return { claimedRows: 1, redactedRows: 2, externalCalls: 0 };
        },
      },
      dumpSource: async () => {
        trace.push("archive.dump");
        return { opaque: true };
      },
      inspectArchive: async (_archive, source) => {
        trace.push("archive.inspect");
        expect(source).toEqual(snapshot());
        return archiveEvidence;
      },
      restoreTargetWithoutAcl: async () => {
        trace.push("archive.restore.no-acl");
      },
      restoreTarget: async () => {
        trace.push("archive.restore");
      },
      disposeArchive: () => {
        trace.push("archive.dispose");
      },
    });

    expect(trace).toEqual([
      "source.roles",
      "source.boundary:false",
      "source.migrate",
      "source.catalog.raw",
      "source.seed",
      "source.snapshot:1",
      "source.roles",
      "source.boundary:true",
      "source.catalog.reviewed",
      "source.snapshot:2",
      "archive.dump",
      "archive.inspect",
      "target.roles",
      "target.boundary:false",
      "target.restore-role",
      "target.acl-suppression.prepare",
      "archive.restore.no-acl",
      "target.acl-suppression",
      "target.reset-after-acl-suppression",
      "target.roles",
      "target.boundary:false",
      "target.restore-role",
      "archive.restore",
      "archive.dispose",
      "target.catalog.raw",
      "target.snapshot:1",
      "target.roles",
      "target.boundary:true",
      "target.catalog.reviewed",
      "target.snapshot:2",
      "target.smoke",
    ]);
    expect(result.archive).toEqual(archiveEvidence);
    expect(result.rawSource).toEqual(snapshot());
    expect(result.rawRestored).toEqual(snapshot());
  });

  it("rejects a stripped or over-granted raw ACL before repair can run", async () => {
    const targetReconcile = vi.fn(async () => undefined);
    let targetSnapshots = 0;

    await expect(
      runFullSchemaRestoreVerification({
        expectedPostgresMajor: 17,
        migration,
        source: {
          reconcileRoles: async () => undefined,
          verifyRoleBoundaries: async () => undefined,
          verifyPreRepairMailAuthorityCatalog: async () => undefined,
          verifyMailAuthorityCatalog: async () => undefined,
          migrate: async () => undefined,
          seedRepresentativeMailRows: async () => undefined,
          snapshot: async () => snapshot(),
        },
        target: {
          reconcileRoles: targetReconcile,
          verifyRoleBoundaries: async () => undefined,
          requireRestoreOwnerRole: async () => undefined,
          prepareAclSuppressionControl: async () => undefined,
          verifyAclSuppressionControl: async () => ({
            proaclIsNull: true,
            publicExecute: true,
            routine:
              "public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)",
          }),
          resetAfterAclSuppressionControl: async () => undefined,
          verifyPreRepairMailAuthorityCatalog: async () => undefined,
          verifyMailAuthorityCatalog: async () => undefined,
          snapshot: async () => {
            targetSnapshots += 1;
            return snapshot(sha("f"));
          },
          runNonNetworkSmoke: async () => ({
            claimedRows: 1,
            redactedRows: 2,
            externalCalls: 0,
          }),
        },
        dumpSource: async () => "archive",
        inspectArchive: async () => archiveEvidence,
        restoreTargetWithoutAcl: async () => undefined,
        restoreTarget: async () => undefined,
        disposeArchive: () => undefined,
      }),
    ).rejects.toThrow("full-schema restore verification failed");

    expect(targetSnapshots).toBe(1);
    expect(targetReconcile).toHaveBeenCalledTimes(2);
  });
});
