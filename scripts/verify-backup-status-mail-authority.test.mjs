import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BACKUP_STATUS_AUTHORITY_RELATIONS,
  BACKUP_STATUS_AUTHORITY_ROUTINES,
  BackupStatusMailAuthorityContractError,
  verifyBackupStatusMailAuthorityObjects,
} from "./verify-backup-status-mail-authority.mjs";

const restrictedRoles = Object.freeze([
  "learncoding_app",
  "learncoding_migrator",
  "learncoding_worker",
  "learncoding_ops",
  "learncoding_backup_reporter",
]);

function exactClient(tamper = "") {
  const calls = [];
  return {
    calls,
    async query(sql, parameters = []) {
      const normalized = String(sql).replace(/\s+/gu, " ").trim().toLowerCase();
      calls.push({ normalized, parameters });
      if (normalized.includes("effective_table_acl_exact")) {
        const relation = parameters[0];
        const prefix = relation?.includes("admin_guard") ? "guard" : "ledger";
        return { rows: [{
          owner_exact: tamper !== `${prefix}-owner`,
          relation_kind_exact: true,
          persistence_exact: true,
          row_security_exact: true,
          forced_row_security_exact: true,
          columns_exact: tamper !== `${prefix}-columns`,
          column_definitions_exact: tamper !== `${prefix}-definitions`,
          epoch_constraint_exact: tamper !== `${prefix}-epoch-constraint`,
          effective_table_acl_exact: tamper !== `${prefix}-effective-acl`,
          effective_column_acl_exact: tamper !== `${prefix}-column-acl`,
          direct_acl_exact: tamper !== `${prefix}-direct-acl`,
        }] };
      }
      if (normalized.includes("routine_kind_exact")) {
        if (tamper === `missing:${parameters[0]}`) return { rows: [] };
        return { rows: [{
          owner_exact: tamper !== `owner:${parameters[0]}`,
          routine_kind_exact: true,
          security_definer_exact: true,
          configuration_exact: true,
          effective_execute_exact: tamper !== `effective:${parameters[0]}`,
          direct_acl_exact: tamper !== `direct:${parameters[0]}`,
        }] };
      }
      if (normalized.includes("triggers_exact")) {
        return { rows: [{
          relations_present: true,
          guard_state_exact: tamper !== "guard-state",
          triggers_exact: tamper !== "triggers",
        }] };
      }
      throw new Error("unexpected verifier query");
    },
  };
}

test("verifies the exact owner-inclusive 0065 security manifest", async () => {
  const client = exactClient();
  assert.equal(
    await verifyBackupStatusMailAuthorityObjects(client, restrictedRoles),
    7,
  );
  assert.deepEqual(BACKUP_STATUS_AUTHORITY_ROUTINES, [
    {
      signature: "public.reject_backup_status_mail_authority_mutation()",
      owner: "learncoding_owner",
      securityDefiner: false,
      configuration: ["search_path=pg_catalog"],
      allowedRoles: [],
    },
    {
      signature: "public.lock_backup_status_mail_admin_authority()",
      owner: "learncoding_owner",
      securityDefiner: true,
      configuration: ["search_path=pg_catalog"],
      allowedRoles: [],
    },
    {
      signature: "public.enqueue_backup_status_mail_authority(text,text)",
      owner: "learncoding_owner",
      securityDefiner: true,
      configuration: ["search_path=pg_catalog"],
      allowedRoles: ["learncoding_backup_reporter"],
    },
    {
      signature: "public.backup_status_mail_authorized(uuid)",
      owner: "learncoding_owner",
      securityDefiner: true,
      configuration: ["search_path=pg_catalog"],
      allowedRoles: ["learncoding_worker"],
    },
  ]);
  assert.deepEqual(BACKUP_STATUS_AUTHORITY_RELATIONS, [
    {
      name: "public.backup_status_mail_authority",
      columns: [
        { name: "id", type: "uuid", notNull: true, default: null },
        { name: "run_key", type: "text", notNull: true, default: null },
        { name: "outcome", type: "text", notNull: true, default: null },
        { name: "outbox_id", type: "uuid", notNull: true, default: null },
        { name: "operation_id", type: "uuid", notNull: true, default: null },
        { name: "authority_epoch", type: "uuid", notNull: true, default: null },
        {
          name: "created_at",
          type: "timestamp with time zone",
          notNull: true,
          default: "statement_timestamp()",
        },
      ],
      epochConstraint: {
        name: "backup_status_mail_authority_epoch_valid",
        definition:
          "CHECK (authority_epoch <> '00000000-0000-0000-0000-000000000000'::uuid)",
      },
    },
    {
      name: "public.backup_status_mail_admin_guard",
      columns: [
        { name: "singleton", type: "boolean", notNull: true, default: "true" },
        {
          name: "authority_epoch",
          type: "uuid",
          notNull: true,
          default: "gen_random_uuid()",
        },
      ],
      epochConstraint: {
        name: "backup_status_mail_admin_guard_epoch_valid",
        definition:
          "CHECK (authority_epoch <> '00000000-0000-0000-0000-000000000000'::uuid)",
      },
    },
  ]);
  assert.equal(client.calls.length, 7);
  for (const [index, relation] of
    BACKUP_STATUS_AUTHORITY_RELATIONS.entries()) {
    assert.deepEqual(client.calls[index].parameters, [
      relation.name,
      restrictedRoles,
      relation.columns.map(({ name }) => name),
      JSON.stringify(relation.columns),
      relation.epochConstraint.name,
      relation.epochConstraint.definition,
    ]);
  }
  for (const [index, routine] of BACKUP_STATUS_AUTHORITY_ROUTINES.entries()) {
    assert.deepEqual(client.calls[index + 2].parameters, [
      routine.signature,
      routine.owner,
      routine.securityDefiner,
      routine.configuration,
      restrictedRoles,
      routine.allowedRoles,
    ]);
  }
});

test("includes owners, grantors, grant options, columns, and exact triggers", () => {
  const source = readFileSync(
    new URL("./verify-backup-status-mail-authority.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /acl\.grantee\s*<>\s*p\.proowner/u);
  assert.match(source, /pg_catalog\.acldefault\('f', p\.proowner\)/u);
  assert.match(source, /where acl\.grantee = p\.proowner/u);
  assert.match(source, /pg_catalog\.acldefault\('r', target\.relowner\)/u);
  assert.match(source, /pg_catalog\.has_column_privilege/u);
  assert.match(source, /columns_exact/u);
  assert.match(source, /\$3::name\[\]/u);
  assert.match(source, /column_definitions_exact/u);
  assert.match(source, /\$4::jsonb/u);
  assert.match(source, /constraint_definition\.convalidated is true/u);
  assert.match(source, /guard_state_exact/u);
  assert.match(source, /'backup_status_mail_authority_immutable'::name,\s*27::smallint/u);
  assert.match(source, /'backup_status_mail_authority_no_truncate'::name,\s*34::smallint/u);
  assert.match(source, /'backup_status_mail_admin_insert_lock'::name,\s*7::smallint/u);
  assert.match(source, /'backup_status_mail_admin_update_lock'::name,\s*19::smallint/u);
  assert.match(source, /'backup_status_mail_admin_delete_lock'::name,\s*11::smallint/u);
  assert.match(source, /trigger\.tgnargs/u);
  assert.match(source, /pg_catalog\.octet_length\(trigger\.tgargs\)/u);
});

test("fails closed for every missing or altered manifest component", async () => {
  const routine = BACKUP_STATUS_AUTHORITY_ROUTINES[1].signature;
  for (const tamper of [
    "ledger-owner",
    "ledger-columns",
    "ledger-definitions",
    "ledger-epoch-constraint",
    "ledger-effective-acl",
    "ledger-column-acl",
    "ledger-direct-acl",
    "guard-owner",
    "guard-columns",
    "guard-definitions",
    "guard-epoch-constraint",
    "guard-effective-acl",
    "guard-column-acl",
    "guard-direct-acl",
    "guard-state",
    `missing:${routine}`,
    `owner:${routine}`,
    `effective:${routine}`,
    `direct:${routine}`,
    "triggers",
  ]) {
    await assert.rejects(
      verifyBackupStatusMailAuthorityObjects(
        exactClient(tamper),
        restrictedRoles,
      ),
      BackupStatusMailAuthorityContractError,
    );
  }
});
