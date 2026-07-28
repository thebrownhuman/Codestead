const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function exactColumn(name, type, notNull, defaultExpression = null) {
  return Object.freeze({
    name,
    type,
    notNull,
    default: defaultExpression,
  });
}

function exactConstraint(name, type, keyColumns, definition) {
  return Object.freeze({
    name,
    type,
    validated: true,
    deferrable: false,
    initiallyDeferred: false,
    keyColumns: Object.freeze([...keyColumns]),
    definition,
  });
}

function exactIndex(name, keyColumn, primary) {
  const relationName = name.startsWith("backup_status_mail_admin_guard")
    ? "public.backup_status_mail_admin_guard"
    : "public.backup_status_mail_authority";
  return Object.freeze({
    name,
    owner: "learncoding_owner",
    relationKind: "i",
    persistence: "p",
    accessMethod: "btree",
    unique: true,
    nullsNotDistinct: false,
    primary,
    exclusion: false,
    immediate: true,
    clustered: false,
    valid: true,
    checkXmin: false,
    ready: true,
    live: true,
    replicaIdentity: false,
    attributes: 1,
    keyAttributes: 1,
    keyColumns: Object.freeze([keyColumn]),
    expressions: null,
    predicate: null,
    definition:
      `CREATE UNIQUE INDEX ${name} ON ${relationName} ` +
      `USING btree (${keyColumn})`,
    reloptions: null,
    tablespace: 0,
  });
}

export const BACKUP_STATUS_AUTHORITY_RELATIONS = Object.freeze([
  Object.freeze({
    name: "public.backup_status_mail_authority",
    accessMethod: "heap",
    replicaIdentity: "d",
    reloptions: null,
    tablespace: 0,
    columns: Object.freeze([
      exactColumn("id", "uuid", true),
      exactColumn("run_key", "text", true),
      exactColumn("outcome", "text", true),
      exactColumn("outbox_id", "uuid", true),
      exactColumn("operation_id", "uuid", true),
      exactColumn("authority_epoch", "uuid", true),
      exactColumn(
        "created_at",
        "timestamp with time zone",
        true,
        "statement_timestamp()",
      ),
    ]),
    constraints: Object.freeze([
      exactConstraint(
        "backup_status_mail_authority_epoch_valid",
        "c",
        ["authority_epoch"],
        `CHECK (authority_epoch <> '${ZERO_UUID}'::uuid)`,
      ),
      exactConstraint(
        "backup_status_mail_authority_operation_id_key",
        "u",
        ["operation_id"],
        "UNIQUE (operation_id)",
      ),
      exactConstraint(
        "backup_status_mail_authority_outbox_id_key",
        "u",
        ["outbox_id"],
        "UNIQUE (outbox_id)",
      ),
      exactConstraint(
        "backup_status_mail_authority_outcome_valid",
        "c",
        ["outcome"],
        "CHECK (outcome = ANY (ARRAY['success'::text, 'failure'::text]))",
      ),
      exactConstraint(
        "backup_status_mail_authority_pkey",
        "p",
        ["id"],
        "PRIMARY KEY (id)",
      ),
      exactConstraint(
        "backup_status_mail_authority_run_key_key",
        "u",
        ["run_key"],
        "UNIQUE (run_key)",
      ),
      exactConstraint(
        "backup_status_mail_authority_run_key_valid",
        "c",
        ["run_key"],
        "CHECK (run_key ~ '^[0-9]{8}T[0-9]{6}Z$'::text)",
      ),
    ]),
    indexes: Object.freeze([
      exactIndex(
        "backup_status_mail_authority_operation_id_key",
        "operation_id",
        false,
      ),
      exactIndex(
        "backup_status_mail_authority_outbox_id_key",
        "outbox_id",
        false,
      ),
      exactIndex("backup_status_mail_authority_pkey", "id", true),
      exactIndex("backup_status_mail_authority_run_key_key", "run_key", false),
    ]),
  }),
  Object.freeze({
    name: "public.backup_status_mail_admin_guard",
    accessMethod: "heap",
    replicaIdentity: "d",
    reloptions: null,
    tablespace: 0,
    columns: Object.freeze([
      exactColumn("singleton", "boolean", true, "true"),
      exactColumn("authority_epoch", "uuid", true, "gen_random_uuid()"),
    ]),
    constraints: Object.freeze([
      exactConstraint(
        "backup_status_mail_admin_guard_epoch_valid",
        "c",
        ["authority_epoch"],
        `CHECK (authority_epoch <> '${ZERO_UUID}'::uuid)`,
      ),
      exactConstraint(
        "backup_status_mail_admin_guard_pkey",
        "p",
        ["singleton"],
        "PRIMARY KEY (singleton)",
      ),
      exactConstraint(
        "backup_status_mail_admin_guard_singleton",
        "c",
        ["singleton"],
        "CHECK (singleton IS TRUE)",
      ),
    ]),
    indexes: Object.freeze([
      exactIndex("backup_status_mail_admin_guard_pkey", "singleton", true),
    ]),
  }),
]);

function exactRoutine(contract) {
  if (
    !/^[0-9a-f]{64}$/u.test(contract.bodySha256) ||
    (contract.definitionSha256 !== undefined &&
      contract.definitionSha256 !== null &&
      !/^[0-9a-f]{64}$/u.test(contract.definitionSha256))
  ) {
    throw new Error("backup status routine digest is invalid");
  }
  return Object.freeze({
    language: "plpgsql",
    kind: "f",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentDefaultCount: 0,
    variadic: false,
    cost: 100,
    rows: contract.returnsSet ? 1_000 : 0,
    supportFunction: null,
    transformTypes: Object.freeze([]),
    binary: null,
    sqlBody: null,
    ...contract,
    configuration: Object.freeze([...contract.configuration]),
    allowedRoles: Object.freeze([...contract.allowedRoles]),
    argumentNames: Object.freeze([...contract.argumentNames]),
    argumentModes: Object.freeze([...contract.argumentModes]),
    argumentTypes: Object.freeze([...contract.argumentTypes]),
  });
}

export const BACKUP_STATUS_AUTHORITY_ROUTINES = Object.freeze([
  exactRoutine({
    signature: "public.reject_backup_status_mail_authority_mutation()",
    owner: "learncoding_owner",
    securityDefiner: false,
    configuration: ["search_path=pg_catalog"],
    allowedRoles: [],
    bodySha256:
      "821807d9e78e8d31b0c6ebb567a51c92f04830848de2d555e4f8be8fd370c0db",
    definitionSha256:
      "30414dca0ae964f5275372bc0c8f1607417c0fa5d22786977b25c21be877d240",
    argumentNames: [],
    argumentModes: [],
    argumentTypes: [],
    inputArgumentCount: 0,
    returnType: "trigger",
    returnsSet: false,
  }),
  exactRoutine({
    signature: "public.lock_backup_status_mail_admin_authority()",
    owner: "learncoding_owner",
    securityDefiner: true,
    configuration: ["search_path=pg_catalog"],
    allowedRoles: [],
    bodySha256:
      "3c9e8f9ba6e0095a3f6868150677cf450942d9ffc91d0a34b7c2a65d044ccb1f",
    definitionSha256:
      "58188d5627aed8c443f506e3cda54ac171c2f8219bad481f26a832ace66df3bc",
    argumentNames: [],
    argumentModes: [],
    argumentTypes: [],
    inputArgumentCount: 0,
    returnType: "trigger",
    returnsSet: false,
  }),
  exactRoutine({
    signature: "public.enqueue_backup_status_mail_authority(text,text)",
    owner: "learncoding_owner",
    securityDefiner: true,
    configuration: ["search_path=pg_catalog"],
    allowedRoles: ["learncoding_backup_reporter"],
    bodySha256:
      "e2d042d4948b883aa3ee307b360fc386367a496f672c37a3ba278e93cc6e2aae",
    definitionSha256:
      "25e91d413020f5ef0d6965b32079b38fa9f26cd5b75fc7eedfb131080dd705b9",
    argumentNames: [
      "p_run_key",
      "p_outcome",
      "acknowledgement",
      "authority_id",
      "outbox_id",
      "operation_id",
    ],
    argumentModes: ["i", "i", "t", "t", "t", "t"],
    argumentTypes: ["text", "text", "text", "uuid", "uuid", "uuid"],
    inputArgumentCount: 2,
    returnType: "record",
    returnsSet: true,
  }),
  exactRoutine({
    signature: "public.backup_status_mail_authorized(uuid)",
    owner: "learncoding_owner",
    securityDefiner: true,
    configuration: ["search_path=pg_catalog"],
    allowedRoles: ["learncoding_worker"],
    bodySha256:
      "c947fcc0d019174fcb76c39d61fa736bd552dd6f2eeae6f46cfc772aa4dc95ae",
    definitionSha256:
      "bb7765a31c1e9e2796e554cb1445ddeba3f8ff078e210312486b817db1da4180",
    argumentNames: ["p_candidate_outbox_id"],
    argumentModes: [],
    argumentTypes: ["uuid"],
    inputArgumentCount: 1,
    returnType: "boolean",
    returnsSet: false,
  }),
]);

const BACKUP_STATUS_ENQUEUE_ROUTINE_SIGNATURE =
  "public.enqueue_backup_status_mail_authority(text,text)";
const BACKUP_STATUS_UUID_V4_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export const BACKUP_STATUS_AUTHORITY_TRIGGERS = Object.freeze([
  Object.freeze({
    relation: "public.backup_status_mail_authority",
    name: "backup_status_mail_authority_immutable",
    functionSignature: "public.reject_backup_status_mail_authority_mutation()",
    enabled: "O",
    type: 27,
    predicate: null,
    arguments: Object.freeze([]),
    watchedColumns: Object.freeze([]),
  }),
  Object.freeze({
    relation: "public.backup_status_mail_authority",
    name: "backup_status_mail_authority_no_truncate",
    functionSignature: "public.reject_backup_status_mail_authority_mutation()",
    enabled: "O",
    type: 34,
    predicate: null,
    arguments: Object.freeze([]),
    watchedColumns: Object.freeze([]),
  }),
  Object.freeze({
    relation: 'public."user"',
    name: "backup_status_mail_admin_insert_lock",
    functionSignature: "public.lock_backup_status_mail_admin_authority()",
    enabled: "O",
    type: 7,
    predicate: null,
    arguments: Object.freeze([]),
    watchedColumns: Object.freeze([]),
  }),
  Object.freeze({
    relation: 'public."user"',
    name: "backup_status_mail_admin_update_lock",
    functionSignature: "public.lock_backup_status_mail_admin_authority()",
    enabled: "O",
    type: 19,
    predicate: null,
    arguments: Object.freeze([]),
    watchedColumns: Object.freeze(["id", "email", "role", "status", "banned"]),
  }),
  Object.freeze({
    relation: 'public."user"',
    name: "backup_status_mail_admin_delete_lock",
    functionSignature: "public.lock_backup_status_mail_admin_authority()",
    enabled: "O",
    type: 11,
    predicate: null,
    arguments: Object.freeze([]),
    watchedColumns: Object.freeze([]),
  }),
]);

export const BACKUP_STATUS_AUTHORITY_GUARD_STATE = Object.freeze({
  relation: "public.backup_status_mail_admin_guard",
  singletonColumn: "singleton",
  authorityEpochColumn: "authority_epoch",
  expectedRows: 1,
  singletonValue: true,
  requiresNonZeroAuthorityEpoch: true,
});

export const BACKUP_STATUS_AUTHORITY_0065_CONTRACT = Object.freeze({
  phase: 65,
  relations: BACKUP_STATUS_AUTHORITY_RELATIONS,
  routines: BACKUP_STATUS_AUTHORITY_ROUTINES,
  triggers: BACKUP_STATUS_AUTHORITY_TRIGGERS,
  guardState: BACKUP_STATUS_AUTHORITY_GUARD_STATE,
});

export const BACKUP_STATUS_AUTHORITY_0067_RELATIONS = Object.freeze(
  BACKUP_STATUS_AUTHORITY_RELATIONS.map((relation) => {
    if (relation.name !== "public.backup_status_mail_authority") {
      return relation;
    }
    return Object.freeze({
      ...relation,
      constraints: Object.freeze(
        relation.constraints.map((constraint) =>
          constraint.name === "backup_status_mail_authority_run_key_valid"
            ? exactConstraint(
                constraint.name,
                constraint.type,
                constraint.keyColumns,
                "CHECK (run_key ~ '^[0-9]{8}T[0-9]{6}Z$'::text OR " +
                  `run_key ~ '${BACKUP_STATUS_UUID_V4_PATTERN}'::text)`,
              )
            : constraint,
        ),
      ),
    });
  }),
);

export const BACKUP_STATUS_AUTHORITY_0067_ROUTINES = Object.freeze(
  BACKUP_STATUS_AUTHORITY_ROUTINES.map((routine) =>
    routine.signature === BACKUP_STATUS_ENQUEUE_ROUTINE_SIGNATURE
      ? exactRoutine({
          ...routine,
          configuration: ["search_path=pg_catalog, pg_temp"],
          bodySha256:
            "ac406b4dff127c10f791267c1464faddbe93e8ce88faa0a52c215881ac1b7480",
          definitionSha256:
            "9da144a39b11b808c114068c9bf32b4ff45b63b1be20e680f79804c01db30ea2",
        })
      : routine,
  ),
);

export const BACKUP_STATUS_AUTHORITY_0067_CONTRACT = Object.freeze({
  phase: 67,
  relations: BACKUP_STATUS_AUTHORITY_0067_RELATIONS,
  routines: BACKUP_STATUS_AUTHORITY_0067_ROUTINES,
  triggers: BACKUP_STATUS_AUTHORITY_TRIGGERS,
  guardState: BACKUP_STATUS_AUTHORITY_GUARD_STATE,
});

const BACKUP_STATUS_AUTHORITY_0067_ENQUEUE_ROUTINE =
  BACKUP_STATUS_AUTHORITY_0067_ROUTINES.find(
    ({ signature }) => signature === BACKUP_STATUS_ENQUEUE_ROUTINE_SIGNATURE,
  );
if (BACKUP_STATUS_AUTHORITY_0067_ENQUEUE_ROUTINE === undefined) {
  throw new Error("backup status 0067 enqueue routine is missing");
}

export const BACKUP_STATUS_AUTHORITY_0069_ROUTINES = Object.freeze([
  ...BACKUP_STATUS_AUTHORITY_0067_ROUTINES.filter(
    ({ signature }) => signature !== BACKUP_STATUS_ENQUEUE_ROUTINE_SIGNATURE,
  ),
  exactRoutine({
    ...BACKUP_STATUS_AUTHORITY_0067_ENQUEUE_ROUTINE,
    signature:
      "public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)",
    allowedRoles: [],
    bodySha256:
      "ac406b4dff127c10f791267c1464faddbe93e8ce88faa0a52c215881ac1b7480",
    definitionSha256:
      "30138cd5d305d74407dc3f294177d4ea9fa7155672d1dcf089b44fe010dd2b59",
  }),
  exactRoutine({
    ...BACKUP_STATUS_AUTHORITY_0067_ENQUEUE_ROUTINE,
    allowedRoles: ["learncoding_backup_reporter"],
    bodySha256:
      "2cc0bf920b31af64566f1eb0352bd63f078bcccab3d064748ba5af226805c81b",
    definitionSha256:
      "6d944b1dd9ef5cfaa4371d204569f27134bf2431dd61a078b0722a3a782da6b6",
  }),
]);

export const BACKUP_STATUS_AUTHORITY_0069_CONTRACT = Object.freeze({
  phase: 69,
  relations: BACKUP_STATUS_AUTHORITY_0067_RELATIONS,
  routines: BACKUP_STATUS_AUTHORITY_0069_ROUTINES,
  triggers: BACKUP_STATUS_AUTHORITY_TRIGGERS,
  guardState: BACKUP_STATUS_AUTHORITY_GUARD_STATE,
});

const CANONICAL_BACKUP_STATUS_AUTHORITY_CONTRACTS = new Map([
  [65, BACKUP_STATUS_AUTHORITY_0065_CONTRACT],
  [67, BACKUP_STATUS_AUTHORITY_0067_CONTRACT],
  [69, BACKUP_STATUS_AUTHORITY_0069_CONTRACT],
]);

export class BackupStatusMailAuthorityContractError extends Error {
  constructor(component) {
    const base =
      "backup status mail authority database contract verification failed";
    super(component ? `${base}: ${component}` : base);
    this.name = "BackupStatusMailAuthorityContractError";
  }
}

function fail(component) {
  throw new BackupStatusMailAuthorityContractError(component);
}

const STRICT_ACL_MODE = Symbol("strict-acl");
const RESTORED_NO_ACL_STRUCTURAL_MODE = Symbol(
  "restored-no-acl-structural",
);

function exactChecksForMode(structuralChecks, aclChecks, mode) {
  if (mode === STRICT_ACL_MODE) {
    return [...structuralChecks, ...aclChecks];
  }
  if (mode === RESTORED_NO_ACL_STRUCTURAL_MODE) {
    return structuralChecks;
  }
  fail("verification-mode");
}

function canonicalBackupStatusAuthorityContract(contract) {
  const canonical = CANONICAL_BACKUP_STATUS_AUTHORITY_CONTRACTS.get(
    contract?.phase,
  );
  if (
    canonical === undefined ||
    canonical !== contract ||
    contract.relations !== canonical.relations ||
    contract.routines !== canonical.routines ||
    contract.triggers !== canonical.triggers ||
    contract.guardState !== canonical.guardState
  ) {
    fail("contract");
  }
  return canonical;
}

function exactTrueRow(row, keys) {
  return row !== undefined && keys.every((key) => row[key] === true);
}

async function verifyRestrictedRelation(
  client,
  relation,
  restrictedRoles,
  verificationMode,
) {
  const expectedColumns = relation.columns.map(({ name }) => name);
  const structuralChecks = [
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
  ];
  const aclChecks = [
    "effective_table_acl_exact",
    "effective_column_acl_exact",
    "direct_acl_exact",
  ];
  const exactKeys = exactChecksForMode(
    structuralChecks,
    aclChecks,
    verificationMode,
  );
  const result = await client.query(
    `
    with target as (
      select c.*
        from pg_catalog.pg_class c
       where c.oid = pg_catalog.to_regclass($1::text)
    ),
    observed_acl(
      grantor, grantee, privilege_type, is_grantable
    ) as (
      select acl.grantor,
             acl.grantee,
             acl.privilege_type,
             acl.is_grantable
        from target
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            target.relacl,
            pg_catalog.acldefault('r', target.relowner)
          )
        ) acl
    ),
    expected_acl(
      grantor, grantee, privilege_type, is_grantable
    ) as (
      select acl.grantor,
             acl.grantee,
             acl.privilege_type,
             acl.is_grantable
        from target
        cross join lateral pg_catalog.aclexplode(
          pg_catalog.acldefault('r', target.relowner)
        ) acl
    )
    select pg_catalog.pg_get_userbyid(target.relowner) =
             'learncoding_owner' owner_exact,
           target.relkind = 'r' relation_kind_exact,
           target.relpersistence = 'p' persistence_exact,
           (
             select pg_catalog.count(*) = 1
                    and pg_catalog.bool_and(
                      access_method.amname = $5::name
                    )
               from pg_catalog.pg_am access_method
              where access_method.oid = target.relam
           ) access_method_exact,
           target.relreplident::text is not distinct from
             $6::text replica_identity_exact,
           target.reloptions is not distinct from $7::text[] reloptions_exact,
           target.reltablespace is not distinct from $8::oid tablespace_exact,
           target.relrowsecurity = false row_security_exact,
           target.relforcerowsecurity = false forced_row_security_exact,
           ARRAY(
             select attribute.attname
               from pg_catalog.pg_attribute attribute
              where attribute.attrelid = target.oid
                and attribute.attnum > 0
                and not attribute.attisdropped
              order by attribute.attnum
           )::name[] = $3::name[] columns_exact,
           (
             select coalesce(
                      pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                          'name', attribute.attname,
                          'type', pg_catalog.format_type(
                            attribute.atttypid, attribute.atttypmod
                          ),
                          'notNull', attribute.attnotnull,
                          'default', pg_catalog.pg_get_expr(
                            default_value.adbin, default_value.adrelid
                          )
                        )
                        order by attribute.attnum
                      ),
                      '[]'::jsonb
                    ) = $4::jsonb
               from pg_catalog.pg_attribute attribute
               left join pg_catalog.pg_attrdef default_value
                 on default_value.adrelid = attribute.attrelid
                and default_value.adnum = attribute.attnum
              where attribute.attrelid = target.oid
                and attribute.attnum > 0
                and not attribute.attisdropped
           ) column_definitions_exact,
           (
             select coalesce(
                      pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                          'name', constraint_definition.conname,
                          'type', constraint_definition.contype::text,
                          'validated',
                            constraint_definition.convalidated,
                          'deferrable',
                            constraint_definition.condeferrable,
                          'initiallyDeferred',
                            constraint_definition.condeferred,
                          'keyColumns',
                            ARRAY(
                              select attribute.attname::text
                                from pg_catalog.unnest(
                                  constraint_definition.conkey
                                ) with ordinality key_column(
                                  attnum, key_order
                                )
                                join pg_catalog.pg_attribute attribute
                                  on attribute.attrelid =
                                       constraint_definition.conrelid
                                 and attribute.attnum = key_column.attnum
                               order by key_column.key_order
                            ),
                          'definition',
                            pg_catalog.pg_get_constraintdef(
                              constraint_definition.oid,
                              true
                            )
                        )
                        order by constraint_definition.conname
                      ),
                      '[]'::jsonb
                    ) = $9::jsonb
               from pg_catalog.pg_constraint constraint_definition
              where constraint_definition.conrelid = target.oid
                and constraint_definition.contype <> 'n'
           ) constraints_exact,
           (
             select coalesce(
                      pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                          'name', index_relation.relname,
                          'owner',
                            pg_catalog.pg_get_userbyid(
                              index_relation.relowner
                            ),
                          'relationKind',
                            index_relation.relkind::text,
                          'persistence',
                            index_relation.relpersistence::text,
                          'accessMethod', access_method.amname,
                          'unique', index_definition.indisunique,
                          'nullsNotDistinct',
                            index_definition.indnullsnotdistinct,
                          'primary', index_definition.indisprimary,
                          'exclusion', index_definition.indisexclusion,
                          'immediate', index_definition.indimmediate,
                          'clustered', index_definition.indisclustered,
                          'valid', index_definition.indisvalid,
                          'checkXmin', index_definition.indcheckxmin,
                          'ready', index_definition.indisready,
                          'live', index_definition.indislive,
                          'replicaIdentity',
                            index_definition.indisreplident,
                          'attributes', index_definition.indnatts,
                          'keyAttributes', index_definition.indnkeyatts,
                          'keyColumns',
                            ARRAY(
                              select case key_column.attnum
                                       when 0 then null
                                       else attribute.attname::text
                                     end
                                from pg_catalog.unnest(
                                  index_definition.indkey
                                ) with ordinality key_column(
                                  attnum, key_order
                                )
                                left join pg_catalog.pg_attribute attribute
                                  on attribute.attrelid = target.oid
                                 and attribute.attnum = key_column.attnum
                               order by key_column.key_order
                            ),
                          'expressions',
                            pg_catalog.pg_get_expr(
                              index_definition.indexprs,
                              index_definition.indrelid,
                              true
                            ),
                          'predicate',
                            pg_catalog.pg_get_expr(
                              index_definition.indpred,
                              index_definition.indrelid,
                              true
                            ),
                          'definition',
                            pg_catalog.pg_get_indexdef(
                              index_definition.indexrelid,
                              0,
                              true
                            ),
                          'reloptions', index_relation.reloptions,
                          'tablespace',
                            index_relation.reltablespace::integer
                        )
                        order by index_relation.relname
                      ),
                      '[]'::jsonb
                    ) = $10::jsonb
               from pg_catalog.pg_index index_definition
               join pg_catalog.pg_class index_relation
                 on index_relation.oid =
                      index_definition.indexrelid
               join pg_catalog.pg_am access_method
                 on access_method.oid = index_relation.relam
              where index_definition.indrelid = target.oid
           ) indexes_exact,
           (
             not pg_catalog.has_table_privilege(
               0, target.oid, 'SELECT'
             )
             and not pg_catalog.has_table_privilege(
               0, target.oid, 'INSERT'
             )
             and not pg_catalog.has_table_privilege(
               0, target.oid, 'UPDATE'
             )
             and not pg_catalog.has_table_privilege(
               0, target.oid, 'DELETE'
             )
             and not pg_catalog.has_table_privilege(
               0, target.oid, 'TRUNCATE'
             )
             and not pg_catalog.has_table_privilege(
               0, target.oid, 'REFERENCES'
             )
             and not pg_catalog.has_table_privilege(
               0, target.oid, 'TRIGGER'
             )
             and not exists (
               select 1
                 from pg_catalog.unnest($2::text[]) restricted(role_name)
                where pg_catalog.has_table_privilege(
                        restricted.role_name, target.oid, 'SELECT'
                      )
                   or pg_catalog.has_table_privilege(
                        restricted.role_name, target.oid, 'INSERT'
                      )
                   or pg_catalog.has_table_privilege(
                        restricted.role_name, target.oid, 'UPDATE'
                      )
                   or pg_catalog.has_table_privilege(
                        restricted.role_name, target.oid, 'DELETE'
                      )
                   or pg_catalog.has_table_privilege(
                        restricted.role_name, target.oid, 'TRUNCATE'
                      )
                   or pg_catalog.has_table_privilege(
                        restricted.role_name, target.oid, 'REFERENCES'
                      )
                   or pg_catalog.has_table_privilege(
                        restricted.role_name, target.oid, 'TRIGGER'
                      )
             )
           ) effective_table_acl_exact,
           (
             not exists (
               select 1
                 from pg_catalog.pg_attribute attribute
                where attribute.attrelid = target.oid
                  and attribute.attnum > 0
                  and not attribute.attisdropped
                  and (
                    pg_catalog.has_column_privilege(
                      0, target.oid, attribute.attnum, 'SELECT'
                    )
                    or pg_catalog.has_column_privilege(
                      0, target.oid, attribute.attnum, 'INSERT'
                    )
                    or pg_catalog.has_column_privilege(
                      0, target.oid, attribute.attnum, 'UPDATE'
                    )
                    or pg_catalog.has_column_privilege(
                      0, target.oid, attribute.attnum, 'REFERENCES'
                    )
                    or exists (
                      select 1
                        from pg_catalog.unnest($2::text[])
                             restricted(role_name)
                       where pg_catalog.has_column_privilege(
                               restricted.role_name,
                               target.oid,
                               attribute.attnum,
                               'SELECT'
                             )
                          or pg_catalog.has_column_privilege(
                               restricted.role_name,
                               target.oid,
                               attribute.attnum,
                               'INSERT'
                             )
                          or pg_catalog.has_column_privilege(
                               restricted.role_name,
                               target.oid,
                               attribute.attnum,
                               'UPDATE'
                             )
                          or pg_catalog.has_column_privilege(
                               restricted.role_name,
                               target.oid,
                               attribute.attnum,
                               'REFERENCES'
                             )
                    )
                  )
             )
           ) effective_column_acl_exact,
           not exists (
             select 1
               from (
                 (select * from observed_acl except all select * from expected_acl)
                 union all
                 (select * from expected_acl except all select * from observed_acl)
               ) difference
           ) direct_acl_exact
      from target`,
    [
      relation.name,
      restrictedRoles,
      expectedColumns,
      JSON.stringify(relation.columns),
      relation.accessMethod,
      relation.replicaIdentity,
      relation.reloptions,
      relation.tablespace,
      JSON.stringify(relation.constraints),
      JSON.stringify(relation.indexes),
    ],
  );
  const failedKeys = exactKeys.filter((key) => result.rows[0]?.[key] !== true);
  if (result.rows.length !== 1 || failedKeys.length > 0) {
    const detail =
      failedKeys.length > 0 ? `[${failedKeys.join(",")}]` : "[row_count]";
    fail(`relation:${relation.name}${detail}`);
  }
}

async function verifyRoutine(
  client,
  routine,
  restrictedRoles,
  verificationMode,
) {
  const result = await client.query(
    `
    select pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(p.prosrc, 'UTF8')
             ),
             'hex'
           ) is not distinct from $7::text body_sha256_exact,
           pg_catalog.encode(
             pg_catalog.sha256(
               pg_catalog.convert_to(
                 pg_catalog.pg_get_functiondef(p.oid),
                 'UTF8'
               )
             ),
             'hex'
           ) is not distinct from $28::text definition_sha256_exact,
           pg_catalog.pg_get_userbyid(p.proowner) = $2 owner_exact,
           language.lanname is not distinct from $8::text language_exact,
           p.prokind::text is not distinct from $9::text routine_kind_exact,
           p.prosecdef is not distinct from $3::boolean security_definer_exact,
           p.proconfig is not distinct from $4::text[] configuration_exact,
           p.provolatile::text is not distinct from $10::text volatility_exact,
           p.proisstrict is not distinct from $11::boolean strict_exact,
           p.proparallel::text is not distinct from $12::text parallel_exact,
           p.proleakproof is not distinct from $13::boolean leakproof_exact,
           coalesce(
             p.proargnames,
             '{}'::text[]
           ) is not distinct from $14::text[] argument_names_exact,
           coalesce(
             (
               select pg_catalog.array_agg(
                        argument_mode::text order by argument_order
                      )
                 from pg_catalog.unnest(p.proargmodes)
                      with ordinality argument(
                        argument_mode, argument_order
                      )
             ),
             '{}'::text[]
           ) is not distinct from $15::text[] argument_modes_exact,
           ARRAY(
             select argument_type
               from pg_catalog.unnest(
                 coalesce(
                   p.proallargtypes,
                   p.proargtypes::oid[]
                 )
               ) with ordinality observed(
                 argument_type, argument_order
               )
              order by argument_order
           ) is not distinct from ARRAY(
             select pg_catalog.to_regtype(argument_type)::oid
               from pg_catalog.unnest($16::text[])
                    with ordinality expected(
                      argument_type, argument_order
                    )
              order by argument_order
           ) argument_types_exact,
           p.pronargs::integer is not distinct from
             $17::integer input_argument_count_exact,
           (
             p.pronargdefaults::integer is not distinct from $18::integer
             and (p.proargdefaults is null) is not distinct from
                 ($18::integer = 0)
           ) argument_defaults_exact,
           p.prorettype is not distinct from
             pg_catalog.to_regtype($19::text)::oid return_type_exact,
           p.proretset is not distinct from $20::boolean returns_set_exact,
           (p.provariadic <> 0) is not distinct from
             $21::boolean variadic_exact,
           p.procost is not distinct from $22::real cost_exact,
           p.prorows is not distinct from $23::real rows_exact,
           p.prosupport is not distinct from coalesce(
             pg_catalog.to_regprocedure($24::text)::oid,
             0::oid
           ) support_exact,
           coalesce(
             p.protrftypes,
             '{}'::oid[]
           ) is not distinct from (
             select coalesce(
                      pg_catalog.array_agg(
                        pg_catalog.to_regtype(transform_type)::oid
                        order by transform_order
                      ),
                      '{}'::oid[]
                    )
               from pg_catalog.unnest($25::text[])
                    with ordinality expected(
                      transform_type, transform_order
                    )
           ) transform_types_exact,
           p.probin is not distinct from $26::text binary_exact,
           p.prosqlbody::text is not distinct from
             $27::text sql_body_exact,
           (
             not pg_catalog.has_function_privilege(0, p.oid, 'EXECUTE')
             and pg_catalog.has_function_privilege(
               $2::name, p.oid, 'EXECUTE WITH GRANT OPTION'
             )
             and not exists (
               select 1
                 from pg_catalog.unnest($5::text[]) restricted(role_name)
                where pg_catalog.has_function_privilege(
                        restricted.role_name, p.oid, 'EXECUTE'
                      ) is distinct from
                      (restricted.role_name = any($6::text[]))
             )
           ) effective_execute_exact,
           (
             with observed(
               grantor, grantee, privilege_type, is_grantable
             ) as (
               select acl.grantor,
                      acl.grantee,
                      acl.privilege_type,
                      acl.is_grantable
                 from pg_catalog.aclexplode(
                   coalesce(
                     p.proacl,
                     pg_catalog.acldefault('f', p.proowner)
                   )
                 ) acl
             ),
             expected(
               grantor, grantee, privilege_type, is_grantable
             ) as (
               select acl.grantor,
                      acl.grantee,
                      acl.privilege_type,
                      acl.is_grantable
                 from pg_catalog.aclexplode(
                   pg_catalog.acldefault('f', p.proowner)
                 ) acl
                where acl.grantee = p.proowner
               union all
               select p.proowner,
                      grantee.oid,
                      'EXECUTE'::text,
                      false
                 from pg_catalog.unnest($6::text[]) allowed(role_name)
                 join pg_catalog.pg_roles grantee
                   on grantee.rolname = allowed.role_name
             )
             select not exists (
               select 1
                 from (
                   (select * from observed except all select * from expected)
                   union all
                   (select * from expected except all select * from observed)
                 ) difference
             )
           ) direct_acl_exact
      from pg_catalog.pg_proc p
      join pg_catalog.pg_language language on language.oid = p.prolang
     where p.oid = pg_catalog.to_regprocedure($1::text)::oid`,
    [
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
    ],
  );
  const structuralChecks = [
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
  ];
  const aclChecks = ["effective_execute_exact", "direct_acl_exact"];
  const routineChecks = exactChecksForMode(
    structuralChecks,
    aclChecks,
    verificationMode,
  );
  if (
    result.rows.length !== 1 ||
    !exactTrueRow(result.rows[0], routineChecks)
  ) {
    const failures =
      result.rows.length === 1
        ? routineChecks.filter((key) => result.rows[0][key] !== true)
        : ["missing"];
    fail(`routine:${routine.signature}:${failures.join(",")}`);
  }
}

async function verifyTriggers(
  client,
  contract,
  { requireGuardState = true } = {},
) {
  if (typeof requireGuardState !== "boolean") fail("triggers:guard-state-mode");
  const expectedTriggers = contract.triggers.map((trigger) => ({
    relation_name: trigger.relation,
    trigger_name: trigger.name,
    trigger_type: trigger.type,
    enabled: trigger.enabled,
    function_signature: trigger.functionSignature,
    watched_columns: trigger.watchedColumns,
    condition_absent: trigger.predicate === null,
    argument_count: trigger.arguments.length,
    argument_bytes: trigger.arguments.reduce(
      (total, argument) =>
        total + new TextEncoder().encode(argument).byteLength + 1,
      0,
    ),
  }));
  const authorityTriggerRelations = [
    ...new Set([
      ...contract.relations.map(({ name }) => name),
      contract.guardState.relation,
    ]),
  ];
  const userTrigger = contract.triggers.find(
    ({ relation }) => relation === 'public."user"',
  );
  if (userTrigger === undefined) fail("contract:triggers:user");
  const guardStateProjection = requireGuardState
    ? `,
            (
              $5::text =
                'public.backup_status_mail_admin_guard'
              and $6::name = 'singleton'::name
              and $7::name = 'authority_epoch'::name
              and (
              select pg_catalog.count(*) = $8::integer
                     and pg_catalog.bool_and(
                       (
                         pg_catalog.to_jsonb(authority_guard) ->> $6::text
                       )::boolean is not distinct from $9::boolean
                       and (
                         not $10::boolean
                         or (
                           pg_catalog.to_jsonb(authority_guard) ->> $7::text
                         )::uuid <>
                           '00000000-0000-0000-0000-000000000000'::uuid
                       )
                     )
                from public.backup_status_mail_admin_guard authority_guard
              )
            ) guard_state_exact`
    : "";
  const parameters = [
    JSON.stringify(expectedTriggers),
    authorityTriggerRelations,
    userTrigger.relation,
    "backup_status_mail_admin_",
    ...(requireGuardState
      ? [
          contract.guardState.relation,
          contract.guardState.singletonColumn,
          contract.guardState.authorityEpochColumn,
          contract.guardState.expectedRows,
          contract.guardState.singletonValue,
          contract.guardState.requiresNonZeroAuthorityEpoch,
        ]
      : []),
  ];

  const result = await client.query(
    `
    with expected_manifest as (
      select manifest.relation_name,
             manifest.trigger_name::name trigger_name,
             manifest.trigger_type,
             manifest.enabled::"char" enabled,
             manifest.function_signature,
             manifest.watched_columns,
             manifest.condition_absent,
             manifest.argument_count,
             manifest.argument_bytes
        from pg_catalog.jsonb_to_recordset($1::jsonb) manifest(
          relation_name text,
          trigger_name text,
          trigger_type smallint,
          enabled text,
          function_signature text,
          watched_columns text[],
          condition_absent boolean,
          argument_count smallint,
          argument_bytes integer
        )
    ),
    expected as (
      select manifest.relation_name,
             manifest.trigger_name,
             manifest.trigger_type,
             manifest.enabled,
             pg_catalog.to_regprocedure(
               manifest.function_signature
             )::oid function_oid,
             coalesce(
               ARRAY(
                 select attribute.attnum::smallint
                   from pg_catalog.unnest(manifest.watched_columns)
                        with ordinality as watched_column(
                          attname, declared_order
                        )
                   join pg_catalog.pg_attribute attribute
                     on attribute.attrelid =
                          pg_catalog.to_regclass(manifest.relation_name)
                    and attribute.attname = watched_column.attname
                  order by watched_column.declared_order
               ),
               ARRAY[]::smallint[]
             ) attribute_numbers,
             manifest.condition_absent,
             manifest.argument_count,
             manifest.argument_bytes
        from expected_manifest manifest
    ),
    observed as (
      select pg_catalog.format(
               '%I.%I', namespace.nspname, relation.relname
             ) relation_name,
             trigger.tgname,
             trigger.tgtype,
             trigger.tgenabled,
             trigger.tgfoid,
             pg_catalog.string_to_array(
               trigger.tgattr::text, ' '
             )::smallint[] attribute_numbers,
             trigger.tgqual is null condition_absent,
             trigger.tgnargs,
             pg_catalog.octet_length(trigger.tgargs)
        from pg_catalog.pg_trigger trigger
        join pg_catalog.pg_class relation on relation.oid = trigger.tgrelid
        join pg_catalog.pg_namespace namespace
          on namespace.oid = relation.relnamespace
       where not trigger.tgisinternal
         and (
           trigger.tgrelid = any (
             ARRAY(
               select pg_catalog.to_regclass(relation_name)
                 from pg_catalog.unnest($2::text[]) relation_name
             )
           )
           or (
             trigger.tgrelid = pg_catalog.to_regclass($3::text)
             and pg_catalog.left(
                   trigger.tgname,
                   pg_catalog.length($4::text)
                 ) = $4::text
           )
         )
    )
    select (
             not exists (
               select 1
                 from pg_catalog.unnest(
                   $2::text[] || ARRAY[$3::text]
                 ) relation_name
                where pg_catalog.to_regclass(relation_name) is null
             )
           ) relations_present
           ${guardStateProjection},
           not exists (
             select 1
               from (
                 (select * from observed except all select * from expected)
                 union all
                 (select * from expected except all select * from observed)
               ) difference
           ) triggers_exact`,
    parameters,
  );
  if (
    result.rows.length !== 1 ||
    !exactTrueRow(result.rows[0], [
      "relations_present",
      ...(requireGuardState ? ["guard_state_exact"] : []),
      "triggers_exact",
    ])
  )
    fail("triggers");
}
async function verifyBackupStatusMailAuthorityObjectsInternal(
  client,
  restrictedRoles,
  contract,
  requireGuardState,
  verificationMode,
) {
  const canonicalContract = canonicalBackupStatusAuthorityContract(contract);
  if (
    !Array.isArray(restrictedRoles) ||
    restrictedRoles.length === 0 ||
    new Set(restrictedRoles).size !== restrictedRoles.length ||
    canonicalContract.relations.length === 0 ||
    canonicalContract.routines.length === 0
  )
    fail();
  const trustedSearchPath = await client.query(
    "select pg_catalog.set_config('search_path', 'pg_catalog,pg_temp', false) trusted_search_path",
  );
  if (
    trustedSearchPath.rows.length !== 1 ||
    trustedSearchPath.rows[0]?.trusted_search_path !== "pg_catalog,pg_temp"
  ) {
    fail("trusted_search_path");
  }
  for (const relation of canonicalContract.relations) {
    await verifyRestrictedRelation(
      client,
      relation,
      restrictedRoles,
      verificationMode,
    );
  }
  for (const routine of canonicalContract.routines) {
    await verifyRoutine(client, routine, restrictedRoles, verificationMode);
  }
  await verifyTriggers(client, canonicalContract, { requireGuardState });
  return (
    canonicalContract.relations.length + canonicalContract.routines.length + 1
  );
}

export function verifyBackupStatusMailAuthorityCatalogObjects(
  client,
  restrictedRoles,
  contract,
) {
  return verifyBackupStatusMailAuthorityObjectsInternal(
    client,
    restrictedRoles,
    contract,
    false,
    STRICT_ACL_MODE,
  );
}

export function verifyBackupStatusMailAuthorityObjects(
  client,
  restrictedRoles,
  contract,
) {
  return verifyBackupStatusMailAuthorityObjectsInternal(
    client,
    restrictedRoles,
    contract,
    true,
    STRICT_ACL_MODE,
  );
}

export function verifyRestoredBackupStatusMailAuthorityStructuralObjects(
  client,
  restrictedRoles,
  contract,
) {
  return verifyBackupStatusMailAuthorityObjectsInternal(
    client,
    restrictedRoles,
    contract,
    true,
    RESTORED_NO_ACL_STRUCTURAL_MODE,
  );
}
