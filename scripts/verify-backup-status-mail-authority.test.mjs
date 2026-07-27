import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  BACKUP_STATUS_AUTHORITY_0065_CONTRACT,
  BACKUP_STATUS_AUTHORITY_0067_CONTRACT,
  BACKUP_STATUS_AUTHORITY_GUARD_STATE,
  BACKUP_STATUS_AUTHORITY_RELATIONS,
  BACKUP_STATUS_AUTHORITY_ROUTINES,
  BACKUP_STATUS_AUTHORITY_TRIGGERS,
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
      if (normalized.includes("trusted_search_path")) {
        return {
          rows: [
            {
              trusted_search_path:
                tamper === "trusted-search-path"
                  ? "public,pg_catalog"
                  : "pg_catalog,pg_temp",
            },
          ],
        };
      }
      if (normalized.includes("effective_table_acl_exact")) {
        const relation = parameters[0];
        const prefix = relation?.includes("admin_guard") ? "guard" : "ledger";
        const row = Object.fromEntries(
          [
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
          ].map((key) => [key, tamper !== `${prefix}:${key}`]),
        );
        return {
          rows: [
            {
              ...row,
            },
          ],
        };
      }
      if (normalized.includes("routine_kind_exact")) {
        if (tamper === `missing:${parameters[0]}`) return { rows: [] };
        const row = Object.fromEntries(
          [
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
          ].map((key) => [key, tamper !== `routine:${parameters[0]}:${key}`]),
        );
        return { rows: [row] };
      }
      if (normalized.includes("triggers_exact")) {
        return {
          rows: [
            {
              relations_present: true,
              guard_state_exact: tamper !== "guard-state",
              triggers_exact: tamper !== "triggers",
            },
          ],
        };
      }
      throw new Error("unexpected verifier query");
    },
  };
}

test("verifies the exact owner-inclusive 0065 security manifest", async () => {
  const client = exactClient();
  assert.equal(
    await verifyBackupStatusMailAuthorityObjects(
      client,
      restrictedRoles,
      BACKUP_STATUS_AUTHORITY_0065_CONTRACT,
    ),
    7,
  );
  assert.equal(
    client.calls[0]?.normalized,
    "select pg_catalog.set_config('search_path', 'pg_catalog,pg_temp', false) trusted_search_path",
  );
  for (const relation of BACKUP_STATUS_AUTHORITY_RELATIONS) {
    for (const index of relation.indexes) {
      assert.match(index.definition, /\sON public\./u);
    }
  }
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
  assert.equal(client.calls.length, 8);
  for (const [index, relation] of BACKUP_STATUS_AUTHORITY_RELATIONS.entries()) {
    assert.deepEqual(client.calls[index + 1].parameters, [
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
    assert.deepEqual(client.calls[index + 3].parameters, [
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

test("binds exact owner-inclusive ACL and topology queries to the manifest", () => {
  const source = readFileSync(
    new URL("./verify-backup-status-mail-authority.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /acl\.grantee\s*<>\s*p\.proowner/u);
  assert.match(source, /pg_catalog\.acldefault\('f', p\.proowner\)/u);
  assert.match(source, /where acl\.grantee = p\.proowner/u);
  assert.match(source, /pg_catalog\.acldefault\('r', target\.relowner\)/u);
  assert.match(source, /pg_catalog\.has_column_privilege/u);
  assert.match(source, /column_definitions_exact/u);
  assert.match(source, /constraints_exact/u);
  assert.match(source, /indexes_exact/u);
  assert.match(source, /body_sha256_exact/u);
  assert.match(source, /definition_sha256_exact/u);
  assert.match(source, /pg_catalog\.jsonb_to_recordset\(\$1::jsonb\)/u);
  assert.match(source, /pg_catalog\.unnest\(manifest\.watched_columns\)/u);
  assert.match(source, /order by watched_column\.declared_order/u);
  assert.doesNotMatch(
    source,
    /ORDER BY attribute\.attnum/u,
    "the expected tgattr order must follow the trigger declaration",
  );
  assert.match(source, /pg_catalog\.left\(\s*trigger\.tgname/u);
  assert.match(source, /pg_catalog\.to_jsonb\(authority_guard\)/u);
  assert.match(source, /trigger\.tgnargs/u);
  assert.match(source, /pg_catalog\.octet_length\(trigger\.tgargs\)/u);
  assert.doesNotMatch(
    source,
    /contract\s*=\s*BACKUP_STATUS_AUTHORITY_0065_CONTRACT/u,
  );
});

test("rejects missing, partial, and cloned phase contracts before querying", async () => {
  const client = {
    calls: 0,
    async query() {
      this.calls += 1;
      throw new Error("contract rejection must precede every query");
    },
  };
  const invalidContracts = [
    undefined,
    Object.freeze({ phase: 65 }),
    Object.freeze({ ...BACKUP_STATUS_AUTHORITY_0065_CONTRACT }),
    Object.freeze({
      ...BACKUP_STATUS_AUTHORITY_0065_CONTRACT,
      triggers: Object.freeze([...BACKUP_STATUS_AUTHORITY_TRIGGERS]),
    }),
    Object.freeze({
      ...BACKUP_STATUS_AUTHORITY_0065_CONTRACT,
      guardState: Object.freeze({ ...BACKUP_STATUS_AUTHORITY_GUARD_STATE }),
    }),
  ];
  for (const contract of invalidContracts) {
    await assert.rejects(
      verifyBackupStatusMailAuthorityObjects(client, restrictedRoles, contract),
      (error) =>
        error instanceof BackupStatusMailAuthorityContractError &&
        error.message.endsWith(": contract"),
    );
  }
  assert.equal(client.calls, 0);
});

test("passes the selected canonical trigger and guard topology to SQL", async () => {
  const client = exactClient();
  await verifyBackupStatusMailAuthorityObjects(
    client,
    restrictedRoles,
    BACKUP_STATUS_AUTHORITY_0065_CONTRACT,
  );
  const triggerCall = client.calls.at(-1);
  assert.deepEqual(
    JSON.parse(triggerCall.parameters[0]),
    BACKUP_STATUS_AUTHORITY_TRIGGERS.map((trigger) => ({
      relation_name: trigger.relation,
      trigger_name: trigger.name,
      trigger_type: trigger.type,
      enabled: trigger.enabled,
      function_signature: trigger.functionSignature,
      watched_columns: trigger.watchedColumns,
      condition_absent: trigger.predicate === null,
      argument_count: trigger.arguments.length,
      argument_bytes: 0,
    })),
  );
  assert.deepEqual(triggerCall.parameters.slice(1), [
    [
      "public.backup_status_mail_authority",
      "public.backup_status_mail_admin_guard",
    ],
    'public."user"',
    "backup_status_mail_admin_",
    BACKUP_STATUS_AUTHORITY_GUARD_STATE.relation,
    BACKUP_STATUS_AUTHORITY_GUARD_STATE.singletonColumn,
    BACKUP_STATUS_AUTHORITY_GUARD_STATE.authorityEpochColumn,
    BACKUP_STATUS_AUTHORITY_GUARD_STATE.expectedRows,
    BACKUP_STATUS_AUTHORITY_GUARD_STATE.singletonValue,
    BACKUP_STATUS_AUTHORITY_GUARD_STATE.requiresNonZeroAuthorityEpoch,
  ]);
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
  await assert.rejects(
    verifyBackupStatusMailAuthorityObjects(
      exactClient("ledger:owner_exact"),
      restrictedRoles,
      BACKUP_STATUS_AUTHORITY_0065_CONTRACT,
    ),
    (error) =>
      error instanceof BackupStatusMailAuthorityContractError &&
      error.message.includes("relation:public.backup_status_mail_authority") &&
      error.message.includes("owner_exact"),
  );
  const tampers = [
    "trusted-search-path",
    ...["ledger", "guard"].flatMap((prefix) =>
      relationChecks.map((check) => `${prefix}:${check}`),
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
        BACKUP_STATUS_AUTHORITY_0065_CONTRACT,
      ),
      BackupStatusMailAuthorityContractError,
    );
  }
});

test("selects the widened 0067 contract without changing frozen 0065 bytes", async () => {
  const legacyConstraint =
    BACKUP_STATUS_AUTHORITY_0065_CONTRACT.relations[0].constraints.find(
      ({ name }) => name === "backup_status_mail_authority_run_key_valid",
    );
  const replayConstraint =
    BACKUP_STATUS_AUTHORITY_0067_CONTRACT.relations[0].constraints.find(
      ({ name }) => name === "backup_status_mail_authority_run_key_valid",
    );
  assert.equal(
    legacyConstraint?.definition,
    "CHECK (run_key ~ '^[0-9]{8}T[0-9]{6}Z$'::text)",
  );
  assert.equal(
    replayConstraint?.definition,
    "CHECK (run_key ~ '^[0-9]{8}T[0-9]{6}Z$'::text OR " +
      "run_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-" +
      "[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)",
  );

  const legacyEnqueue = BACKUP_STATUS_AUTHORITY_0065_CONTRACT.routines.find(
    ({ signature }) =>
      signature === "public.enqueue_backup_status_mail_authority(text,text)",
  );
  const replayEnqueue = BACKUP_STATUS_AUTHORITY_0067_CONTRACT.routines.find(
    ({ signature }) =>
      signature === "public.enqueue_backup_status_mail_authority(text,text)",
  );
  assert.deepEqual(legacyEnqueue?.configuration, ["search_path=pg_catalog"]);
  assert.equal(
    legacyEnqueue?.bodySha256,
    "e2d042d4948b883aa3ee307b360fc386367a496f672c37a3ba278e93cc6e2aae",
  );
  assert.deepEqual(replayEnqueue?.configuration, [
    "search_path=pg_catalog, pg_temp",
  ]);
  assert.equal(
    replayEnqueue?.bodySha256,
    "ac406b4dff127c10f791267c1464faddbe93e8ce88faa0a52c215881ac1b7480",
  );
  assert.equal(replayEnqueue?.definitionSha256, null);

  const client = exactClient();
  assert.equal(
    await verifyBackupStatusMailAuthorityObjects(
      client,
      restrictedRoles,
      BACKUP_STATUS_AUTHORITY_0067_CONTRACT,
    ),
    7,
  );
  const authorityRelationCall = client.calls.find(
    ({ parameters }) => parameters[0] === "public.backup_status_mail_authority",
  );
  assert.equal(
    JSON.parse(authorityRelationCall.parameters[8]).find(
      ({ name }) => name === "backup_status_mail_authority_run_key_valid",
    ).definition,
    replayConstraint.definition,
  );
  const enqueueCall = client.calls.find(
    ({ parameters }) =>
      parameters[0] ===
      "public.enqueue_backup_status_mail_authority(text,text)",
  );
  assert.deepEqual(enqueueCall.parameters[3], [
    "search_path=pg_catalog, pg_temp",
  ]);
  assert.equal(enqueueCall.parameters[6], replayEnqueue.bodySha256);
  assert.equal(enqueueCall.parameters[27], replayEnqueue.definitionSha256);
});
