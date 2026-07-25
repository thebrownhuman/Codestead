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
        const row = Object.fromEntries([
          "owner_exact",
          "relation_kind_exact",
          "persistence_exact",
          "access_method_exact",
          "replica_identity_exact",
          "reloptions_exact",
          "tablespace_exact",
          "row_security_exact",
          "forced_row_security_exact",
          "columns_exact",
          "column_definitions_exact",
          "constraints_exact",
          "indexes_exact",
          "effective_table_acl_exact",
          "effective_column_acl_exact",
          "direct_acl_exact",
        ].map((key) => [key, tamper !== `${prefix}:${key}`]));
        return { rows: [{
          ...row,
        }] };
      }
      if (normalized.includes("routine_kind_exact")) {
        if (tamper === `missing:${parameters[0]}`) return { rows: [] };
        const row = Object.fromEntries([
          "body_sha256_exact",
          "definition_sha256_exact",
          "owner_exact",
          "language_exact",
          "routine_kind_exact",
          "security_definer_exact",
          "configuration_exact",
          "volatility_exact",
          "strict_exact",
          "parallel_exact",
          "leakproof_exact",
          "argument_names_exact",
          "argument_modes_exact",
          "argument_types_exact",
          "input_argument_count_exact",
          "argument_defaults_exact",
          "return_type_exact",
          "returns_set_exact",
          "variadic_exact",
          "cost_exact",
          "rows_exact",
          "support_exact",
          "transform_types_exact",
          "binary_exact",
          "sql_body_exact",
          "effective_execute_exact",
          "direct_acl_exact",
        ].map((key) => [
          key,
          tamper !== `routine:${parameters[0]}:${key}`,
        ]));
        return { rows: [row] };
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
  assert.deepEqual(
    BACKUP_STATUS_AUTHORITY_ROUTINES.map((routine) => ({
      signature: routine.signature,
      securityDefiner: routine.securityDefiner,
      allowedRoles: routine.allowedRoles,
    })),
    [
      {
        signature: "public.reject_backup_status_mail_authority_mutation()",
        securityDefiner: false,
        allowedRoles: [],
      },
      {
        signature: "public.lock_backup_status_mail_admin_authority()",
        securityDefiner: true,
        allowedRoles: [],
      },
      {
        signature: "public.enqueue_backup_status_mail_authority(text,text)",
        securityDefiner: true,
        allowedRoles: ["learncoding_backup_reporter"],
      },
      {
        signature: "public.backup_status_mail_authorized(uuid)",
        securityDefiner: true,
        allowedRoles: ["learncoding_worker"],
      },
    ],
  );
  for (const routine of BACKUP_STATUS_AUTHORITY_ROUTINES) {
    assert.equal(routine.owner, "learncoding_owner");
    assert.deepEqual(routine.configuration, ["search_path=pg_catalog"]);
    assert.match(routine.bodySha256, /^[0-9a-f]{64}$/u);
    assert.match(routine.definitionSha256, /^[0-9a-f]{64}$/u);
  }
  assert.deepEqual(
    BACKUP_STATUS_AUTHORITY_RELATIONS.map((relation) => ({
      name: relation.name,
      columns: relation.columns.map(({ name }) => name),
      constraints: relation.constraints.map(({ name }) => name),
      indexes: relation.indexes.map(({ name }) => name),
    })),
    [
    {
      name: "public.backup_status_mail_authority",
      columns: [
        "id",
        "run_key",
        "outcome",
        "outbox_id",
        "operation_id",
        "authority_epoch",
        "created_at",
      ],
      constraints: [
        "backup_status_mail_authority_epoch_valid",
        "backup_status_mail_authority_operation_id_key",
        "backup_status_mail_authority_outbox_id_key",
        "backup_status_mail_authority_outcome_valid",
        "backup_status_mail_authority_pkey",
        "backup_status_mail_authority_run_key_key",
        "backup_status_mail_authority_run_key_valid",
      ],
      indexes: [
        "backup_status_mail_authority_operation_id_key",
        "backup_status_mail_authority_outbox_id_key",
        "backup_status_mail_authority_pkey",
        "backup_status_mail_authority_run_key_key",
      ],
    },
    {
      name: "public.backup_status_mail_admin_guard",
      columns: ["singleton", "authority_epoch"],
      constraints: [
        "backup_status_mail_admin_guard_epoch_valid",
        "backup_status_mail_admin_guard_pkey",
        "backup_status_mail_admin_guard_singleton",
      ],
      indexes: ["backup_status_mail_admin_guard_pkey"],
    },
    ],
  );
  for (const relation of BACKUP_STATUS_AUTHORITY_RELATIONS) {
    assert.equal(relation.accessMethod, "heap");
    assert.equal(relation.replicaIdentity, "d");
    assert.equal(relation.reloptions, null);
    assert.equal(relation.tablespace, 0);
  }
  assert.equal(client.calls.length, 7);
  for (const [index, relation] of
    BACKUP_STATUS_AUTHORITY_RELATIONS.entries()) {
    assert.deepEqual(client.calls[index].parameters, [
      relation.name,
      restrictedRoles,
      relation.columns.map(({ name }) => name),
      JSON.stringify(relation.columns),
      relation.accessMethod,
      relation.replicaIdentity,
      relation.reloptions,
      relation.tablespace,
      JSON.stringify(relation.constraints),
      JSON.stringify(relation.indexes),
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
      routine.bodySha256,
      routine.language,
      routine.kind,
      routine.volatility,
      routine.strict,
      routine.parallel,
      routine.leakproof,
      routine.argumentNames,
      routine.argumentModes,
      routine.argumentTypes,
      routine.inputArgumentCount,
      routine.argumentDefaultCount,
      routine.returnType,
      routine.returnsSet,
      routine.variadic,
      routine.cost,
      routine.rows,
      routine.supportFunction,
      routine.transformTypes,
      routine.binary,
      routine.sqlBody,
      routine.definitionSha256,
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
  assert.match(source, /constraints_exact/u);
  assert.match(source, /\$9::jsonb/u);
  assert.match(
    source,
    /constraint_definition\.contype <> 'n'/u,
  );
  assert.match(source, /indexes_exact/u);
  assert.match(source, /\$10::jsonb/u);
  assert.match(source, /index_definition\.indnullsnotdistinct/u);
  assert.match(source, /index_definition\.indcheckxmin/u);
  assert.match(source, /pg_catalog\.pg_get_indexdef/u);
  assert.match(source, /body_sha256_exact/u);
  assert.match(source, /definition_sha256_exact/u);
  assert.match(source, /p\.procost/u);
  assert.match(
    source,
    /trigger\.tgrelid = pg_catalog\.to_regclass\(\s*'public\.backup_status_mail_admin_guard'/u,
  );
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
  const relationChecks = [
    "owner_exact",
    "relation_kind_exact",
    "persistence_exact",
    "access_method_exact",
    "replica_identity_exact",
    "reloptions_exact",
    "tablespace_exact",
    "row_security_exact",
    "forced_row_security_exact",
    "columns_exact",
    "column_definitions_exact",
    "constraints_exact",
    "indexes_exact",
    "effective_table_acl_exact",
    "effective_column_acl_exact",
    "direct_acl_exact",
  ];
  const routineChecks = [
    "body_sha256_exact",
    "definition_sha256_exact",
    "owner_exact",
    "security_definer_exact",
    "configuration_exact",
    "argument_types_exact",
    "cost_exact",
    "effective_execute_exact",
    "direct_acl_exact",
  ];
  const tampers = [
    ...["ledger", "guard"].flatMap((prefix) =>
      relationChecks.map((check) => `${prefix}:${check}`)
    ),
    "guard-state",
    `missing:${routine}`,
    ...routineChecks.map((check) => `routine:${routine}:${check}`),
    "triggers",
  ];
  for (const tamper of tampers) {
    await assert.rejects(
      verifyBackupStatusMailAuthorityObjects(
        exactClient(tamper),
        restrictedRoles,
      ),
      BackupStatusMailAuthorityContractError,
    );
  }
});
