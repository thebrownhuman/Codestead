const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function exactColumn(name, type, notNull, defaultExpression = null) {
  return Object.freeze({
    name,
    type,
    notNull,
    default: defaultExpression,
  });
}

export const BACKUP_STATUS_AUTHORITY_RELATIONS = Object.freeze([
  Object.freeze({
    name: "public.backup_status_mail_authority",
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
    epochConstraint: Object.freeze({
      name: "backup_status_mail_authority_epoch_valid",
      definition:
        `CHECK (authority_epoch <> '${ZERO_UUID}'::uuid)`,
    }),
  }),
  Object.freeze({
    name: "public.backup_status_mail_admin_guard",
    columns: Object.freeze([
      exactColumn("singleton", "boolean", true, "true"),
      exactColumn("authority_epoch", "uuid", true, "gen_random_uuid()"),
    ]),
    epochConstraint: Object.freeze({
      name: "backup_status_mail_admin_guard_epoch_valid",
      definition:
        `CHECK (authority_epoch <> '${ZERO_UUID}'::uuid)`,
    }),
  }),
]);

function exactRoutine(contract) {
  if (
    !/^[0-9a-f]{64}$/u.test(contract.bodySha256) ||
    !/^[0-9a-f]{64}$/u.test(contract.definitionSha256)
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
      "7a1fff52745e58ac45f1840e88c437a59a7d669d25a86fa5fcf259959024efef",
    definitionSha256:
      "f942cdda522f28a0cc8f6446c7ea7ff0615743363c9182e71e12179e425d8eef",
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
      "62f209f2ccfd469078900bf87ed920f04869629aa67dad224694f50ca3da67ba",
    definitionSha256:
      "b33f672d6be288af17835f24b831154a6f85f46d555d2822e38217f0506ae835",
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
      "a8acb4f84b1e72fa78a69e5334bfa695dc8256c523271b54150172d69e8ac227",
    definitionSha256:
      "0eaa1f83e8e83c241421a510c6a5c6c887536a92e031aad05ed0cb34ba32f813",
    argumentNames: ["p_candidate_outbox_id"],
    argumentModes: [],
    argumentTypes: ["uuid"],
    inputArgumentCount: 1,
    returnType: "boolean",
    returnsSet: false,
  }),
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

function exactTrueRow(row, keys) {
  return row !== undefined && keys.every((key) => row[key] === true);
}

async function verifyRestrictedRelation(
  client,
  relation,
  restrictedRoles,
) {
  const expectedColumns = relation.columns.map(({ name }) => name);
  const result = await client.query(`
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
             select pg_catalog.count(*) = 1
                    and pg_catalog.bool_and(
                      pg_catalog.pg_get_constraintdef(
                        constraint_definition.oid, true
                      ) = $6::text
                    )
               from pg_catalog.pg_constraint constraint_definition
              where constraint_definition.conrelid = target.oid
                and constraint_definition.conname = $5::name
                and constraint_definition.contype = 'c'
                and constraint_definition.convalidated is true
           ) epoch_constraint_exact,
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
      relation.epochConstraint.name,
      relation.epochConstraint.definition,
    ],
  );
  if (
    result.rows.length !== 1 ||
    !exactTrueRow(result.rows[0], [
      "owner_exact",
      "relation_kind_exact",
      "persistence_exact",
      "row_security_exact",
      "forced_row_security_exact",
      "columns_exact",
      "column_definitions_exact",
      "epoch_constraint_exact",
      "effective_table_acl_exact",
      "effective_column_acl_exact",
      "direct_acl_exact",
    ])
  ) fail(`relation:${relation.name}`);
}

async function verifyRoutine(client, routine, restrictedRoles) {
  const result = await client.query(`
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
           coalesce(
             p.proallargtypes,
             p.proargtypes::oid[]
           ) is not distinct from (
             select coalesce(
                      pg_catalog.array_agg(
                        pg_catalog.to_regtype(argument_type)::oid
                        order by argument_order
                      ),
                      '{}'::oid[]
                    )
               from pg_catalog.unnest($16::text[])
                    with ordinality expected(
                      argument_type, argument_order
                    )
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
  const routineChecks = [
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
  ];
  if (result.rows.length !== 1 || !exactTrueRow(result.rows[0], routineChecks)) {
    const failures = result.rows.length === 1
      ? routineChecks.filter((key) => result.rows[0][key] !== true)
      : ["missing"];
    fail(`routine:${routine.signature}:${failures.join(",")}`);
  }
}

async function verifyTriggers(client) {
  const result = await client.query(`
    with expected(
      relation_name, trigger_name, trigger_type, enabled, function_oid,
      attribute_numbers, condition_absent, argument_count, argument_bytes
    ) as (
      values
        (
          'public.backup_status_mail_authority'::text,
          'backup_status_mail_authority_immutable'::name,
          27::smallint,
          'O'::"char",
          pg_catalog.to_regprocedure(
            'public.reject_backup_status_mail_authority_mutation()'
          )::oid,
          ARRAY[]::smallint[],
          true,
          0::smallint,
          0::integer
        ),
        (
          'public.backup_status_mail_authority'::text,
          'backup_status_mail_authority_no_truncate'::name,
          34::smallint,
          'O'::"char",
          pg_catalog.to_regprocedure(
            'public.reject_backup_status_mail_authority_mutation()'
          )::oid,
          ARRAY[]::smallint[],
          true,
          0::smallint,
          0::integer
        ),
        (
          'public."user"'::text,
          'backup_status_mail_admin_insert_lock'::name,
          7::smallint,
          'O'::"char",
          pg_catalog.to_regprocedure(
            'public.lock_backup_status_mail_admin_authority()'
          )::oid,
          ARRAY[]::smallint[],
          true,
          0::smallint,
          0::integer
        ),
        (
          'public."user"'::text,
          'backup_status_mail_admin_update_lock'::name,
          19::smallint,
          'O'::"char",
          pg_catalog.to_regprocedure(
            'public.lock_backup_status_mail_admin_authority()'
          )::oid,
          ARRAY(
            SELECT attribute.attnum::smallint
              FROM pg_catalog.pg_attribute attribute
             WHERE attribute.attrelid = pg_catalog.to_regclass('public."user"')
               AND attribute.attname = ANY(
                 ARRAY['email', 'role', 'status', 'banned']::name[]
               )
             ORDER BY attribute.attnum
          )::smallint[],
          true,
          0::smallint,
          0::integer
        ),
        (
          'public."user"'::text,
          'backup_status_mail_admin_delete_lock'::name,
          11::smallint,
          'O'::"char",
          pg_catalog.to_regprocedure(
            'public.lock_backup_status_mail_admin_authority()'
          )::oid,
          ARRAY[]::smallint[],
          true,
          0::smallint,
          0::integer
        )
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
           trigger.tgrelid = pg_catalog.to_regclass(
             'public.backup_status_mail_authority'
           )
           or (
             trigger.tgrelid = pg_catalog.to_regclass('public."user"')
             and trigger.tgname in (
               'backup_status_mail_admin_insert_lock',
               'backup_status_mail_admin_update_lock',
               'backup_status_mail_admin_delete_lock'
             )
           )
         )
    )
    select (
             pg_catalog.to_regclass(
               'public.backup_status_mail_authority'
             ) is not null
             and pg_catalog.to_regclass(
               'public.backup_status_mail_admin_guard'
             ) is not null
             and pg_catalog.to_regclass('public."user"') is not null
           ) relations_present,
           (
             select pg_catalog.count(*) = 1
                    and pg_catalog.bool_and(
                      authority_guard.singleton is true
                      and authority_guard.authority_epoch is not null
                      and authority_guard.authority_epoch <>
                        '00000000-0000-0000-0000-000000000000'::uuid
                    )
               from public.backup_status_mail_admin_guard authority_guard
           ) guard_state_exact,
           not exists (
             select 1
               from (
                 (select * from observed except all select * from expected)
                 union all
                 (select * from expected except all select * from observed)
               ) difference
           ) triggers_exact`,
  );
  if (
    result.rows.length !== 1 ||
    !exactTrueRow(
      result.rows[0],
      ["relations_present", "guard_state_exact", "triggers_exact"],
    )
  ) fail("triggers");
}

export async function verifyBackupStatusMailAuthorityObjects(
  client,
  restrictedRoles,
) {
  if (
    !Array.isArray(restrictedRoles) ||
    restrictedRoles.length === 0 ||
    new Set(restrictedRoles).size !== restrictedRoles.length
  ) fail();
  for (const relation of BACKUP_STATUS_AUTHORITY_RELATIONS) {
    await verifyRestrictedRelation(client, relation, restrictedRoles);
  }
  for (const routine of BACKUP_STATUS_AUTHORITY_ROUTINES) {
    await verifyRoutine(client, routine, restrictedRoles);
  }
  await verifyTriggers(client);
  return 7;
}
