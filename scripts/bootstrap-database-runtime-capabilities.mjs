import {
  BOOTSTRAP_SESSION_AUTHORITY,
  CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
  DATABASE_RUNTIME_CAPABILITY_PHASES,
  DatabaseRuntimeCapabilityPhaseError,
  canonicalDatabaseRuntimeCapabilitiesJson,
  fingerprintDatabaseRuntimeCapabilities,
  planDatabaseRuntimeCapabilityReconciliation,
  resolveDatabaseRuntimeCapabilityPhase,
} from "./database-runtime-capabilities.mjs";
import {
  REVIEWED_MIGRATION_LEDGER,
  REVIEWED_MIGRATION_LEDGER_SHA256,
  verifyAppliedMigrationLedger,
} from "./lib/reviewed-migration-ledger.mjs";

const MANAGED_ROLE_NAMES = Object.freeze([
  "learncoding_owner",
  "learncoding_migrator",
  "learncoding_app",
  "learncoding_worker",
  "learncoding_ops",
  "learncoding_backup_reporter",
]);

const OBJECT_PRIVILEGES = Object.freeze({
  database: new Set(["CONNECT", "CREATE", "TEMPORARY"]),
  schema: new Set(["USAGE", "CREATE"]),
  table: new Set([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "MAINTAIN",
  ]),
  column: new Set(["SELECT", "INSERT", "UPDATE", "REFERENCES"]),
  sequence: new Set(["USAGE", "SELECT", "UPDATE"]),
  routine: new Set(["EXECUTE"]),
  type: new Set(["USAGE"]),
});

const DEFAULT_ACL_KIND_BY_CODE = Object.freeze({
  r: "table",
  S: "sequence",
  f: "routine",
  T: "type",
});

const DEFAULT_ACL_CLASSES = Object.freeze({
  table: Object.freeze({
    sql: "TABLES",
    privileges: Object.freeze([
      "SELECT",
      "INSERT",
      "UPDATE",
      "DELETE",
      "TRUNCATE",
      "REFERENCES",
      "TRIGGER",
      "MAINTAIN",
    ]),
  }),
  sequence: Object.freeze({
    sql: "SEQUENCES",
    privileges: Object.freeze(["USAGE", "SELECT", "UPDATE"]),
  }),
  routine: Object.freeze({
    sql: "ROUTINES",
    privileges: Object.freeze(["EXECUTE"]),
  }),
  type: Object.freeze({
    sql: "TYPES",
    privileges: Object.freeze(["USAGE"]),
  }),
});

export class BootstrapDatabaseRuntimeCapabilityError extends Error {
  constructor(section) {
    super(`database runtime capability bootstrap failed: ${section}`);
    this.name = "BootstrapDatabaseRuntimeCapabilityError";
  }
}

function fail(section) {
  throw new BootstrapDatabaseRuntimeCapabilityError(section);
}

function quoteIdentifier(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail("unsafe-identifier");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalOid(value, { allowZero = false } = {}) {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(value) ||
    (!allowZero && value === "0") ||
    BigInt(value) > 4_294_967_295n
  ) {
    return null;
  }
  return value;
}

function createOidNameEvidence() {
  return {
    byName: new Map(),
    byOid: new Map(),
  };
}

function bindOidName(evidence, name, oid, section) {
  const canonical = canonicalOid(oid);
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "PUBLIC" ||
    canonical === null
  ) {
    fail(section);
  }
  const knownOid = evidence.byName.get(name);
  const knownName = evidence.byOid.get(canonical);
  if (
    (knownOid !== undefined && knownOid !== canonical) ||
    (knownName !== undefined && knownName !== name)
  ) {
    fail(section);
  }
  evidence.byName.set(name, canonical);
  evidence.byOid.set(canonical, name);
  return name;
}

function requireOidName(evidence, name, oid, section) {
  const canonical = canonicalOid(oid);
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name === "PUBLIC" ||
    canonical === null ||
    evidence.byName.get(name) !== canonical ||
    evidence.byOid.get(canonical) !== name
  ) {
    fail(section);
  }
  return name;
}

function principalEvidenceRegistry(
  roleRows,
  membershipRows,
  bootstrapUser,
  section,
) {
  const evidence = createOidNameEvidence();
  for (const row of roleRows) {
    bindOidName(evidence, row.role_name, row.role_oid, section);
  }
  for (const row of membershipRows) {
    requireOidName(
      evidence,
      row.granted_role_name,
      row.granted_role_oid,
      section,
    );
    requireOidName(
      evidence,
      row.member_role_name,
      row.member_role_oid,
      section,
    );
    if (row.grantor_name === bootstrapUser) {
      bindOidName(evidence, row.grantor_name, row.grantor_oid, section);
    } else {
      requireOidName(evidence, row.grantor_name, row.grantor_oid, section);
    }
  }
  if (!evidence.byName.has(bootstrapUser)) fail(section);
  return evidence;
}

function oidPrincipal(evidence, name, oid, section) {
  return requireOidName(evidence, name, oid, section);
}

function symbolicPrincipal(evidence, name, oid, postgresUser, section) {
  const principal = requireOidName(evidence, name, oid, section);
  return name === postgresUser ? BOOTSTRAP_SESSION_AUTHORITY : principal;
}

function aclGrantee(evidence, name, oid, isPublic, postgresUser, section) {
  if (typeof isPublic !== "boolean") {
    fail(section);
  }
  if (isPublic) {
    if (String(oid) !== "0" || name !== "PUBLIC") {
      fail(section);
    }
    return "PUBLIC";
  }
  if (String(oid) === "0" || name === "PUBLIC") {
    fail(section);
  }
  return postgresUser === undefined
    ? oidPrincipal(evidence, name, oid, section)
    : symbolicPrincipal(evidence, name, oid, postgresUser, section);
}

function defaultAclSchemaEvidence(row, section, namespaceEvidence) {
  const expectedKind = DEFAULT_ACL_KIND_BY_CODE[row?.object_type_code];
  if (expectedKind === undefined || expectedKind !== row.object_kind) {
    fail(section);
  }
  if (
    typeof row.namespace_oid !== "string" ||
    canonicalOid(row.namespace_oid, { allowZero: true }) === null
  ) {
    fail(section);
  }
  if (row.namespace_oid === "0") {
    if (row.schema_name !== null) fail(section);
    return null;
  }
  if (typeof row.schema_name !== "string" || row.schema_name.length === 0) {
    fail(section);
  }
  return requireOidName(
    namespaceEvidence,
    row.schema_name,
    row.namespace_oid,
    section,
  );
}

const ACL_COMPANION_FIELDS = Object.freeze([
  "acl_ordinal",
  "grantor_oid",
  "grantor_name",
  "grantee_oid",
  "grantee_name",
  "grantee_is_public",
  "is_grantable",
]);

function hasAclEntry(row, section) {
  if (!Object.hasOwn(row, "privilege_type")) fail(section);
  if (row.privilege_type === null) {
    if (ACL_COMPANION_FIELDS.some((field) => row[field] !== null)) {
      fail(section);
    }
    return false;
  }
  if (
    typeof row.privilege_type !== "string" ||
    row.privilege_type.length === 0 ||
    !Number.isSafeInteger(row.acl_ordinal) ||
    row.acl_ordinal <= 0 ||
    canonicalOid(row.grantor_oid) === null ||
    typeof row.grantor_name !== "string" ||
    row.grantor_name.length === 0 ||
    canonicalOid(row.grantee_oid, { allowZero: true }) === null ||
    typeof row.grantee_name !== "string" ||
    row.grantee_name.length === 0 ||
    typeof row.grantee_is_public !== "boolean" ||
    typeof row.is_grantable !== "boolean"
  ) {
    fail(section);
  }
  return true;
}

function rejectDuplicateCatalogRow(seenRows, row, section) {
  const identity = canonicalDatabaseRuntimeCapabilitiesJson(row);
  if (seenRows.has(identity)) fail(section);
  seenRows.add(identity);
}

function recordAclOrdinalEvidence(rowsets, identity, ordinal) {
  const ordinals = rowsets.get(identity) ?? [];
  ordinals.push(ordinal);
  rowsets.set(identity, ordinals);
}

function assertCompleteAclOrdinalEvidence(rowsets, section) {
  for (const ordinals of rowsets.values()) {
    const nullCount = ordinals.filter((ordinal) => ordinal === null).length;
    if (nullCount > 0) {
      if (nullCount !== 1 || ordinals.length !== 1) fail(section);
      continue;
    }
    const ordered = [...ordinals].sort((left, right) => left - right);
    if (
      ordered.some(
        (ordinal, index) =>
          !Number.isSafeInteger(ordinal) || ordinal !== index + 1,
      )
    ) {
      fail(section);
    }
  }
}

function objectCatalogKey(row, section) {
  const expectedCatalog = {
    database: "pg_database",
    schema: "pg_namespace",
    table: "pg_class",
    sequence: "pg_class",
    type: "pg_type",
    routine: "pg_proc",
  }[row.object_kind];
  if (
    row.source_catalog !== expectedCatalog ||
    canonicalOid(row.object_oid) === null
  ) {
    fail(section);
  }
  return `${row.source_catalog}|${row.object_oid}`;
}

function codePointCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function principalLabel(value) {
  return value?.kind === BOOTSTRAP_SESSION_AUTHORITY.kind
    ? "bootstrap-session"
    : value;
}

function defaultAclRowIdentity({ creator, schema, objectKind }) {
  return [principalLabel(creator), schema ?? "@global", objectKind].join("|");
}

function defaultAclIdentity(entry) {
  return [
    principalLabel(entry.creator),
    entry.schema ?? "@global",
    entry.objectKind,
    principalLabel(entry.grantee),
    entry.privilege,
  ].join("|");
}

function exactOne(result, section) {
  if (result?.rows?.length !== 1) fail(section);
  return result.rows[0];
}

function phaseIdentity(value) {
  const ledgerIdentity = value?.ledgerIdentity;
  if (
    ledgerIdentity === null ||
    typeof ledgerIdentity !== "object" ||
    Array.isArray(ledgerIdentity) ||
    Object.keys(ledgerIdentity).toSorted().join("|") !==
      "appliedCount|journalPresent|reviewedLedgerSha256" ||
    typeof ledgerIdentity.journalPresent !== "boolean" ||
    !Number.isSafeInteger(ledgerIdentity.appliedCount) ||
    ledgerIdentity.appliedCount < 0 ||
    ledgerIdentity.appliedCount > REVIEWED_MIGRATION_LEDGER.length ||
    ledgerIdentity.journalPresent !== ledgerIdentity.appliedCount > 0 ||
    ledgerIdentity.reviewedLedgerSha256 !== REVIEWED_MIGRATION_LEDGER_SHA256
  ) {
    throw new Error("invalid database runtime capability ledger identity");
  }
  return {
    phase: value.phase,
    reconcileApplicationAcls: value.reconcileApplicationAcls,
    policyFingerprint:
      value.policy === null
        ? null
        : fingerprintDatabaseRuntimeCapabilities(value.policy),
    ledgerIdentity: {
      journalPresent: ledgerIdentity.journalPresent,
      appliedCount: ledgerIdentity.appliedCount,
      reviewedLedgerSha256: ledgerIdentity.reviewedLedgerSha256,
    },
  };
}

export function assertBootstrapDatabaseRuntimeCapabilityPhaseRequest(
  requestedPhase,
) {
  if (requestedPhase === undefined) return;
  if (
    !Object.values(DATABASE_RUNTIME_CAPABILITY_PHASES).includes(requestedPhase)
  ) {
    throw new DatabaseRuntimeCapabilityPhaseError(
      `unknown requested capability phase: ${requestedPhase}`,
    );
  }
  if (
    requestedPhase === DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070 ||
    requestedPhase === DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071
  ) {
    throw new DatabaseRuntimeCapabilityPhaseError(
      `${requestedPhase} is unavailable until its reviewed migration exists`,
    );
  }
}

export async function resolveBootstrapDatabaseRuntimeCapabilityPhase(
  client,
  { requestedPhase, requireComplete = false } = {},
) {
  assertBootstrapDatabaseRuntimeCapabilityPhaseRequest(requestedPhase);
  const presence = exactOne(
    await client.query(`
      select pg_catalog.to_regclass(
               'drizzle.__drizzle_migrations'
             ) is not null capability_migration_journal_present`),
    "ledger-presence",
  );
  if (typeof presence.capability_migration_journal_present !== "boolean") {
    fail("ledger-presence");
  }
  const ledger = await verifyAppliedMigrationLedger(client, {
    requireComplete,
  });
  if (
    !Number.isInteger(ledger?.appliedCount) ||
    ledger.appliedCount < 0 ||
    ledger.appliedCount > REVIEWED_MIGRATION_LEDGER.length ||
    ledger.ledgerSha256 !== REVIEWED_MIGRATION_LEDGER_SHA256
  ) {
    fail("ledger-result");
  }
  const tail =
    ledger.appliedCount === 0
      ? null
      : REVIEWED_MIGRATION_LEDGER[ledger.appliedCount - 1];
  if (
    tail !== null &&
    (tail.idx !== ledger.appliedCount - 1 || !/^[0-9]{4}_/u.test(tail.tag))
  ) {
    fail("ledger-tail");
  }
  return resolveDatabaseRuntimeCapabilityPhase({
    journalPresent: presence.capability_migration_journal_present,
    reviewedMigrationTail: tail?.tag ?? null,
    reviewedPrefixExact:
      presence.capability_migration_journal_present && ledger.appliedCount > 0,
    reviewedMigrationCount: ledger.appliedCount,
    reviewedMigrationLedgerSha256: ledger.ledgerSha256,
    requestedPhase,
  });
}

export function assertSameBootstrapDatabaseRuntimeCapabilityPhase(
  expected,
  observed,
  section,
) {
  let expectedIdentity;
  let observedIdentity;
  try {
    expectedIdentity = canonicalDatabaseRuntimeCapabilitiesJson(
      phaseIdentity(expected),
    );
    observedIdentity = canonicalDatabaseRuntimeCapabilitiesJson(
      phaseIdentity(observed),
    );
  } catch {
    fail(section);
  }
  if (expectedIdentity !== observedIdentity) {
    fail(section);
  }
}

const CONTEXT_SQL = `
  select pg_catalog.current_setting('server_version_num')::integer
           server_version_num,
         database_row.datname::text database_name,
         database_owner.rolname::text database_owner_name,
         session_role.rolname::text session_user_name,
         current_role_row.rolname::text current_user_name
    from pg_catalog.pg_database database_row
    left join pg_catalog.pg_roles database_owner
      on database_owner.oid = database_row.datdba
    left join pg_catalog.pg_roles session_role
      on session_role.rolname = session_user
    left join pg_catalog.pg_roles current_role_row
      on current_role_row.rolname = current_user
   where database_row.datname = pg_catalog.current_database()
   /* bootstrap_database_runtime_capability_context */`;

const ROLES_SQL = `
  select auth.oid::text role_oid,
         auth.rolname::text role_name,
         auth.rolcanlogin can_login,
         auth.rolsuper superuser,
         auth.rolcreatedb create_database,
         auth.rolcreaterole create_role,
         auth.rolinherit inherit,
         auth.rolreplication replication,
         auth.rolbypassrls bypass_rls,
         auth.rolconnlimit connection_limit,
         auth.rolvaliduntil is null valid_until_is_null,
         auth.rolvaliduntil::text valid_until_raw,
         case
           when auth.rolpassword is null then 'none'
           when auth.rolpassword like 'SCRAM-SHA-256$%' then 'scram-managed'
           else 'unsupported'
         end credential
    from pg_catalog.pg_authid auth
   where auth.rolname::text = any($1::text[])
      or pg_catalog.starts_with(auth.rolname::text, 'learncoding_')
   order by auth.rolname::text collate "C", auth.oid
   /* bootstrap_database_runtime_capability_roles */`;

const PREDEFINED_PUBLIC_OWNER_SQL = `
  select auth.oid::text role_oid,
         auth.rolname::text role_name,
         auth.rolcanlogin can_login,
         auth.rolsuper superuser,
         auth.rolcreatedb create_database,
         auth.rolcreaterole create_role,
         auth.rolinherit inherit,
         auth.rolreplication replication,
         auth.rolbypassrls bypass_rls,
         auth.rolconnlimit connection_limit,
         auth.rolpassword is null password_is_null,
         auth.rolvaliduntil is null valid_until_is_null
    from pg_catalog.pg_authid auth
   where auth.oid = 6171::oid
     and auth.rolname = 'pg_database_owner'
   /* bootstrap_database_runtime_capability_predefined_public_owner */`;

const ROLE_SETTINGS_SQL = `
  select setting.setdatabase::text database_oid,
         case when setting.setdatabase = 0 then '@all-databases'
              else database_row.datname::text end database_name,
         setting.setrole::text role_oid,
         case when setting.setrole = 0 then '@all-roles'
              else role_row.rolname::text end role_name,
         setting_value.ordinality::integer setting_ordinal,
         setting_value.setting_text
    from pg_catalog.pg_db_role_setting setting
    left join pg_catalog.pg_database database_row
      on database_row.oid = setting.setdatabase
    left join pg_catalog.pg_roles role_row
      on role_row.oid = setting.setrole
    left join lateral pg_catalog.unnest(setting.setconfig)
      with ordinality setting_value(setting_text, ordinality) on true
   where setting.setrole in (
           select role_row.oid
             from pg_catalog.pg_roles role_row
            where role_row.rolname::text = any($1::text[])
               or pg_catalog.starts_with(
                    role_row.rolname::text,
                    'learncoding_'
                  )
         )
      or (
        setting.setrole = 0
        and setting.setdatabase in (
          0,
          (
            select database_row.oid
              from pg_catalog.pg_database database_row
             where database_row.datname = pg_catalog.current_database()
          )
        )
      )
   order by database_name collate "C",
            role_name collate "C",
            setting_value.ordinality nulls first
   /* bootstrap_database_runtime_capability_role_settings */`;

const MEMBERSHIPS_SQL = `
  with managed as (
    select role_row.oid
      from pg_catalog.pg_roles role_row
     where role_row.rolname::text = any($1::text[])
        or pg_catalog.starts_with(role_row.rolname::text, 'learncoding_')
  )
  select membership.oid::text membership_oid,
         membership.roleid::text granted_role_oid,
         granted_role.rolname::text granted_role_name,
         membership.member::text member_role_oid,
         member_role.rolname::text member_role_name,
         membership.grantor::text grantor_oid,
         grantor_role.rolname::text grantor_name,
         membership.admin_option,
         membership.inherit_option,
         membership.set_option
    from pg_catalog.pg_auth_members membership
    left join pg_catalog.pg_roles granted_role
      on granted_role.oid = membership.roleid
    left join pg_catalog.pg_roles member_role
      on member_role.oid = membership.member
    left join pg_catalog.pg_roles grantor_role
      on grantor_role.oid = membership.grantor
   where membership.roleid in (select oid from managed)
      or membership.member in (select oid from managed)
      or membership.grantor in (select oid from managed)
   order by membership.roleid,
            membership.member,
            membership.grantor,
            membership.oid
   /* bootstrap_database_runtime_capability_memberships */`;

const EFFECTIVE_MEMBERSHIPS_SQL = `
  with managed as (
    select role_row.oid, role_row.rolname
      from pg_catalog.pg_roles role_row
     where role_row.rolname::text = any($1::text[])
        or pg_catalog.starts_with(role_row.rolname::text, 'learncoding_')
  )
  select member.rolname::text member_name,
         granted.rolname::text granted_role_name,
         pg_catalog.pg_has_role(member.oid, granted.oid, 'MEMBER')
           effective_member,
         pg_catalog.pg_has_role(member.oid, granted.oid, 'USAGE')
           effective_usage,
         pg_catalog.pg_has_role(member.oid, granted.oid, 'SET')
           effective_set
    from managed member
    cross join managed granted
   where member.oid <> granted.oid
   order by member.rolname::text collate "C",
            granted.rolname::text collate "C"
   /* bootstrap_database_runtime_capability_effective_memberships */`;

const OBJECTS_SQL = `
  with user_namespaces as materialized (
    select namespace_row.*
      from pg_catalog.pg_namespace namespace_row
     where namespace_row.nspname not in (
             'pg_catalog',
             'information_schema',
             'pg_toast'
           )
       and namespace_row.nspname not like 'pg_temp_%'
       and namespace_row.nspname not like 'pg_toast_temp_%'
  ),
  objects as (
    select 'pg_database'::text source_catalog,
           'database'::text object_kind,
           '@database'::text object_identity,
           null::text schema_name,
           database_row.datname::text object_name,
           null::text signature,
           'd'::text native_kind,
           database_row.oid object_oid,
           database_row.datdba owner_oid,
           database_row.datacl raw_acl,
           'd'::"char" acldefault_code,
           null::text[] enum_values
      from pg_catalog.pg_database database_row
     where database_row.datname = pg_catalog.current_database()
    union all
    select 'pg_namespace',
           'schema',
           namespace_row.nspname::text,
           null,
           namespace_row.nspname::text,
           null,
           'n',
           namespace_row.oid,
           namespace_row.nspowner,
           namespace_row.nspacl,
           'n'::"char",
           null::text[]
      from user_namespaces namespace_row
    union all
    select 'pg_class',
           case when relation.relkind = 'S' then 'sequence'
                else 'table' end,
           namespace_row.nspname::text || '.' ||
             relation.relname::text,
           namespace_row.nspname::text,
           relation.relname::text,
           null,
           relation.relkind::text,
           relation.oid,
           relation.relowner,
           relation.relacl,
           case when relation.relkind = 'S' then 's'::"char"
                else 'r'::"char" end,
           null::text[]
      from pg_catalog.pg_class relation
      join user_namespaces namespace_row
        on namespace_row.oid = relation.relnamespace
     where relation.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
    union all
    select 'pg_type',
           'type',
           namespace_row.nspname::text || '.' ||
             type_row.typname::text,
           namespace_row.nspname::text,
           type_row.typname::text,
           null,
           type_row.typtype::text,
           type_row.oid,
           type_row.typowner,
           type_row.typacl,
           'T'::"char",
           case when type_row.typtype = 'e' then array(
             select enum_row.enumlabel::text
               from pg_catalog.pg_enum enum_row
              where enum_row.enumtypid = type_row.oid
              order by enum_row.enumsortorder, enum_row.oid
           ) else null::text[] end
      from pg_catalog.pg_type type_row
      join user_namespaces namespace_row
        on namespace_row.oid = type_row.typnamespace
     where type_row.typisdefined
       and not exists (
         select 1
           from pg_catalog.pg_type element_type
          where element_type.typarray = type_row.oid
       )
    union all
    select 'pg_proc',
           'routine',
           namespace_row.nspname::text || '.' ||
             routine.proname::text || '(' ||
             pg_catalog.pg_get_function_identity_arguments(routine.oid) || ')',
           namespace_row.nspname::text,
           routine.proname::text,
           routine.proname::text || '(' ||
             pg_catalog.pg_get_function_identity_arguments(routine.oid) ||
             ')',
           routine.prokind::text,
           routine.oid,
           routine.proowner,
           routine.proacl,
           'f'::"char",
           null::text[]
      from pg_catalog.pg_proc routine
      join user_namespaces namespace_row
        on namespace_row.oid = routine.pronamespace
  )
  select object_row.source_catalog,
         object_row.object_kind,
         object_row.object_identity,
         object_row.schema_name,
         object_row.object_name,
         object_row.signature,
         object_row.native_kind,
         object_row.object_oid::text object_oid,
         object_row.owner_oid::text owner_oid,
         owner_role.rolname::text owner_name,
         object_row.enum_values,
         acl_item.ordinality::integer acl_ordinal,
         acl_item.grantor::text grantor_oid,
         grantor_role.rolname::text grantor_name,
         acl_item.grantee::text grantee_oid,
         case when acl_item.grantee = 0 then 'PUBLIC'
              else grantee_role.rolname::text end grantee_name,
         acl_item.grantee = 0 grantee_is_public,
         acl_item.privilege_type,
         acl_item.is_grantable
    from objects object_row
    left join pg_catalog.pg_roles owner_role
      on owner_role.oid = object_row.owner_oid
    left join lateral pg_catalog.aclexplode(
      coalesce(
        object_row.raw_acl,
        pg_catalog.acldefault(
          object_row.acldefault_code,
          object_row.owner_oid
        )
      )
    ) with ordinality acl_item(
      grantor,
      grantee,
      privilege_type,
      is_grantable,
      ordinality
    ) on true
    left join pg_catalog.pg_roles grantor_role
      on grantor_role.oid = acl_item.grantor
    left join pg_catalog.pg_roles grantee_role
      on grantee_role.oid = acl_item.grantee
   order by object_row.object_kind collate "C",
            object_row.object_identity collate "C",
            acl_item.ordinality nulls first
   /* bootstrap_database_runtime_capability_objects */`;

const COLUMNS_SQL = `
  with user_namespaces as materialized (
    select namespace_row.oid, namespace_row.nspname
      from pg_catalog.pg_namespace namespace_row
     where namespace_row.nspname not in (
             'pg_catalog',
             'information_schema',
             'pg_toast'
           )
       and namespace_row.nspname not like 'pg_temp_%'
       and namespace_row.nspname not like 'pg_toast_temp_%'
  )
  select relation.relkind::text relation_kind,
         namespace_row.nspname::text || '.' ||
           relation.relname::text relation_identity,
         relation.relnatts::integer relation_max_attnum,
         attribute.attnum::integer physical_ordinal,
         attribute.attisdropped is_dropped,
         attribute.attname::text column_name,
         namespace_row.nspname::text || '.' ||
           relation.relname::text || '.' ||
           attribute.attname::text column_identity,
         acl_item.ordinality::integer acl_ordinal,
         acl_item.grantor::text grantor_oid,
         grantor_role.rolname::text grantor_name,
         acl_item.grantee::text grantee_oid,
         case when acl_item.grantee = 0 then 'PUBLIC'
              else grantee_role.rolname::text end grantee_name,
         acl_item.grantee = 0 grantee_is_public,
         acl_item.privilege_type,
         acl_item.is_grantable
    from pg_catalog.pg_class relation
    join user_namespaces namespace_row
      on namespace_row.oid = relation.relnamespace
    join pg_catalog.pg_attribute attribute
      on attribute.attrelid = relation.oid
    left join lateral pg_catalog.aclexplode(attribute.attacl)
      with ordinality acl_item(
        grantor,
        grantee,
        privilege_type,
        is_grantable,
        ordinality
      ) on true
    left join pg_catalog.pg_roles grantor_role
      on grantor_role.oid = acl_item.grantor
    left join pg_catalog.pg_roles grantee_role
      on grantee_role.oid = acl_item.grantee
   where relation.relkind in ('r', 'p', 'v', 'm', 'f')
     and attribute.attnum > 0
   order by relation_identity collate "C",
            attribute.attnum,
            acl_item.ordinality nulls first
   /* bootstrap_database_runtime_capability_columns */`;

const DEFAULT_ACLS_SQL = `
  select default_row.oid::text default_acl_oid,
         default_row.defaclrole::text creator_oid,
         creator_role.rolname::text creator_name,
         default_row.defaclnamespace::text namespace_oid,
         case when default_row.defaclnamespace = 0 then null
              else namespace_row.nspname::text end schema_name,
         default_row.defaclobjtype::text object_type_code,
         case default_row.defaclobjtype
           when 'r' then 'table'
           when 'S' then 'sequence'
           when 'f' then 'routine'
           when 'T' then 'type'
           when 'n' then 'schema'
           when 'L' then 'large-object'
           else 'unsupported:' ||
             default_row.defaclobjtype::text
         end object_kind,
         acl_item.ordinality::integer acl_ordinal,
         acl_item.grantor::text grantor_oid,
         grantor_role.rolname::text grantor_name,
         acl_item.grantee::text grantee_oid,
         case when acl_item.grantee = 0 then 'PUBLIC'
              else grantee_role.rolname::text end grantee_name,
         acl_item.grantee = 0 grantee_is_public,
         acl_item.privilege_type,
         acl_item.is_grantable
    from pg_catalog.pg_default_acl default_row
    left join pg_catalog.pg_namespace namespace_row
      on namespace_row.oid = default_row.defaclnamespace
    left join pg_catalog.pg_roles creator_role
      on creator_role.oid = default_row.defaclrole
    left join lateral pg_catalog.aclexplode(default_row.defaclacl)
      with ordinality acl_item(
        grantor,
        grantee,
        privilege_type,
        is_grantable,
        ordinality
      ) on true
    left join pg_catalog.pg_roles grantor_role
      on grantor_role.oid = acl_item.grantor
    left join pg_catalog.pg_roles grantee_role
      on grantee_role.oid = acl_item.grantee
   order by default_row.defaclrole,
            default_row.defaclnamespace,
            default_row.defaclobjtype,
            default_row.oid,
            acl_item.ordinality nulls first
   /* bootstrap_database_runtime_capability_default_acls */`;

const FOUNDATION_AUTHORITY_SQL = `
  with targets as (
    select 'database'::text scope_kind,
           '@database'::text scope_identity,
           database_row.oid scope_oid,
           database_row.datdba owner_oid,
           database_row.datacl raw_acl,
           'd'::"char" acldefault_code
      from pg_catalog.pg_database database_row
     where database_row.datname = pg_catalog.current_database()
    union all
    select 'schema',
           namespace_row.nspname::text,
           namespace_row.oid,
           namespace_row.nspowner,
           namespace_row.nspacl,
           'n'::"char"
      from pg_catalog.pg_namespace namespace_row
     where namespace_row.nspname not in (
             'pg_catalog',
             'information_schema',
             'pg_toast'
           )
       and namespace_row.nspname not like 'pg_temp_%'
       and namespace_row.nspname not like 'pg_toast_temp_%'
  )
  select target.scope_kind,
         target.scope_identity,
         target.scope_oid::text scope_oid,
         target.owner_oid::text owner_oid,
         owner_role.rolname::text owner_name,
         acl_item.ordinality::integer acl_ordinal,
         acl_item.grantor::text grantor_oid,
         grantor_role.rolname::text grantor_name,
         acl_item.grantee::text grantee_oid,
         case when acl_item.grantee = 0 then 'PUBLIC'
              else grantee_role.rolname::text end grantee_name,
         acl_item.grantee = 0 grantee_is_public,
         acl_item.privilege_type,
         acl_item.is_grantable
    from targets target
    left join pg_catalog.pg_roles owner_role
      on owner_role.oid = target.owner_oid
    left join lateral pg_catalog.aclexplode(
      coalesce(
        target.raw_acl,
        pg_catalog.acldefault(target.acldefault_code, target.owner_oid)
      )
    ) with ordinality acl_item(
      grantor, grantee, privilege_type, is_grantable, ordinality
    ) on true
    left join pg_catalog.pg_roles grantor_role
      on grantor_role.oid = acl_item.grantor
    left join pg_catalog.pg_roles grantee_role
      on grantee_role.oid = acl_item.grantee
   order by target.scope_kind collate "C",
            target.scope_identity collate "C",
            acl_item.ordinality nulls first
   /* bootstrap_database_runtime_capability_foundation_authority */`;

function validateEffectiveMemberships(rows) {
  const expected = new Map();
  for (const member of MANAGED_ROLE_NAMES) {
    for (const granted of MANAGED_ROLE_NAMES) {
      if (member === granted) continue;
      const ownerPath =
        member === "learncoding_migrator" && granted === "learncoding_owner";
      expected.set(`${member}|${granted}`, {
        effectiveMember: ownerPath,
        effectiveUsage: false,
        effectiveSet: ownerPath,
      });
    }
  }
  if (rows.length !== expected.size) {
    fail("effective-membership-cardinality");
  }
  const observed = new Set();
  for (const row of rows) {
    const identity = `${row.member_name}|${row.granted_role_name}`;
    const required = expected.get(identity);
    if (
      required === undefined ||
      observed.has(identity) ||
      row.effective_member !== required.effectiveMember ||
      row.effective_usage !== required.effectiveUsage ||
      row.effective_set !== required.effectiveSet
    ) {
      fail("effective-membership");
    }
    observed.add(identity);
  }
  if (observed.size !== expected.size) {
    fail("effective-membership-cardinality");
  }
}

function objectKindFromRow(row) {
  if (row.object_kind === "table") {
    if (!["r", "p"].includes(row.native_kind)) {
      fail("unsupported-relation-kind");
    }
    return "table";
  }
  if (row.object_kind === "type") {
    if (row.native_kind === "c") return "composite";
    if (row.native_kind === "e") return "enum";
    fail("unsupported-type-kind");
  }
  if (row.object_kind === "routine") {
    if (row.native_kind !== "f") fail("unsupported-routine-kind");
    return "function";
  }
  return row.object_kind;
}

function normalizeCatalog({
  policy,
  postgresUser,
  roleRows,
  settingRows,
  membershipRows,
  effectiveMembershipRows,
  objectRows,
  columnRows,
  defaultAclRows,
  predefinedPublicOwner = null,
}) {
  if (settingRows.length !== 0) fail("role-settings");
  validateEffectiveMemberships(effectiveMembershipRows);
  const principalEvidence = principalEvidenceRegistry(
    roleRows,
    membershipRows,
    postgresUser,
    "principal-identity-evidence",
  );
  const namespaceEvidence = createOidNameEvidence();

  const objects = new Map();
  const grants = [];
  const seenObjectRows = new Set();
  const objectAclRowsets = new Map();
  for (const row of objectRows) {
    rejectDuplicateCatalogRow(
      seenObjectRows,
      row,
      "duplicate-object-catalog-row",
    );
    if (
      typeof row.object_oid !== "string" ||
      typeof row.object_identity !== "string" ||
      typeof row.object_kind !== "string"
    ) {
      fail("object-row");
    }
    const objectKey = objectCatalogKey(row, "object-catalog-evidence");
    if (row.object_kind === "schema") {
      if (row.schema_name !== null || row.object_identity !== row.object_name) {
        fail("schema-object-evidence");
      }
      bindOidName(
        namespaceEvidence,
        row.object_name,
        row.object_oid,
        "schema-object-evidence",
      );
    }
    const kind = objectKindFromRow(row);
    const existing = objects.get(objectKey);
    const predefinedOwnerAllowed =
      predefinedPublicOwner !== null &&
      row.object_kind === "schema" &&
      row.object_identity === "public" &&
      row.owner_name === predefinedPublicOwner.name &&
      canonicalOid(row.owner_oid) === predefinedPublicOwner.oid;
    const object = {
      objectKind: row.object_kind,
      kind,
      identity: row.object_identity,
      schema: row.schema_name,
      name: row.object_name,
      signature: row.signature,
      owner: predefinedOwnerAllowed
        ? predefinedPublicOwner.name
        : oidPrincipal(
            principalEvidence,
            row.owner_name,
            row.owner_oid,
            "object-owner-evidence",
          ),
      enumValues: row.enum_values,
    };
    if (
      existing !== undefined &&
      canonicalDatabaseRuntimeCapabilitiesJson(existing) !==
        canonicalDatabaseRuntimeCapabilitiesJson(object)
    ) {
      fail("object-row-drift");
    }
    objects.set(objectKey, object);
    const populated = hasAclEntry(row, "object-acl-envelope");
    recordAclOrdinalEvidence(
      objectAclRowsets,
      objectKey,
      populated ? row.acl_ordinal : null,
    );
    if (populated) {
      grants.push({
        objectKind: row.object_kind,
        object: row.object_identity,
        grantor: oidPrincipal(
          principalEvidence,
          row.grantor_name,
          row.grantor_oid,
          "object-acl-grantor",
        ),
        grantee: aclGrantee(
          principalEvidence,
          row.grantee_name,
          row.grantee_oid,
          row.grantee_is_public,
          undefined,
          "object-acl-grantee",
        ),
        privilege: row.privilege_type,
        grantable: row.is_grantable,
      });
    }
  }
  assertCompleteAclOrdinalEvidence(objectAclRowsets, "object-acl-rowset");

  const expectedColumns = new Map();
  const expectedTables = new Map();
  for (const table of policy.inventory.tables) {
    const columnsByOrdinal = new Map();
    let maxAttnum = 0;
    for (const column of table.columns) {
      if (
        !Number.isSafeInteger(column.ordinal) ||
        column.ordinal <= 0 ||
        columnsByOrdinal.has(column.ordinal) ||
        expectedColumns.has(column.identity)
      ) {
        fail("invalid-policy-column-envelope");
      }
      columnsByOrdinal.set(column.ordinal, column);
      expectedColumns.set(column.identity, column);
      maxAttnum = Math.max(maxAttnum, column.ordinal);
    }
    if (maxAttnum !== table.columns.length) {
      fail("invalid-policy-column-envelope");
    }
    expectedTables.set(table.identity, { maxAttnum, columnsByOrdinal });
  }

  const columnsByTable = new Map();
  const seenColumns = new Map();
  const seenPhysicalSlots = new Map();
  const seenColumnRows = new Set();
  const columnAclRowsets = new Map();
  for (const row of columnRows) {
    rejectDuplicateCatalogRow(
      seenColumnRows,
      row,
      "duplicate-column-catalog-row",
    );
    if (!["r", "p"].includes(row.relation_kind)) {
      fail("unsupported-column-relation-kind");
    }
    const expectedTable = expectedTables.get(row.relation_identity);
    if (
      expectedTable === undefined ||
      !Number.isSafeInteger(row.relation_max_attnum) ||
      row.relation_max_attnum <= 0 ||
      row.relation_max_attnum !== expectedTable.maxAttnum ||
      !Number.isSafeInteger(row.physical_ordinal) ||
      row.physical_ordinal <= 0 ||
      row.physical_ordinal > row.relation_max_attnum ||
      typeof row.is_dropped !== "boolean"
    ) {
      fail("column-physical-envelope");
    }
    const slotIdentity = `${row.relation_identity}|${row.physical_ordinal}`;
    const slot = {
      relationIdentity: row.relation_identity,
      maxAttnum: row.relation_max_attnum,
      ordinal: row.physical_ordinal,
      dropped: row.is_dropped,
    };
    const priorSlot = seenPhysicalSlots.get(slotIdentity);
    if (
      priorSlot !== undefined &&
      canonicalDatabaseRuntimeCapabilitiesJson(priorSlot) !==
        canonicalDatabaseRuntimeCapabilitiesJson(slot)
    ) {
      fail("column-physical-row-drift");
    }
    seenPhysicalSlots.set(slotIdentity, slot);
    if (row.is_dropped) {
      fail("column-tombstone-drift");
    }
    const expectedColumn = expectedTable.columnsByOrdinal.get(
      row.physical_ordinal,
    );
    if (
      expectedColumn === undefined ||
      row.column_identity !== expectedColumn.identity ||
      row.column_name !== expectedColumn.name
    ) {
      fail("column-physical-envelope");
    }
    const column = {
      identity: row.column_identity,
      name: row.column_name,
      ordinal: row.physical_ordinal,
    };
    const existing = seenColumns.get(row.column_identity);
    if (
      existing !== undefined &&
      canonicalDatabaseRuntimeCapabilitiesJson(existing) !==
        canonicalDatabaseRuntimeCapabilitiesJson(column)
    ) {
      fail("column-row-drift");
    }
    if (existing === undefined) {
      seenColumns.set(row.column_identity, column);
      const local = columnsByTable.get(row.relation_identity) ?? [];
      local.push(column);
      columnsByTable.set(row.relation_identity, local);
    }
    const populated = hasAclEntry(row, "column-acl-envelope");
    recordAclOrdinalEvidence(
      columnAclRowsets,
      slotIdentity,
      populated ? row.acl_ordinal : null,
    );
    if (populated) {
      grants.push({
        objectKind: "column",
        object: row.column_identity,
        grantor: oidPrincipal(
          principalEvidence,
          row.grantor_name,
          row.grantor_oid,
          "column-acl-grantor",
        ),
        grantee: aclGrantee(
          principalEvidence,
          row.grantee_name,
          row.grantee_oid,
          row.grantee_is_public,
          postgresUser,
          "column-acl-grantee",
        ),
        privilege: row.privilege_type,
        grantable: row.is_grantable,
      });
    }
  }
  assertCompleteAclOrdinalEvidence(columnAclRowsets, "column-acl-rowset");
  if (
    seenPhysicalSlots.size !== expectedColumns.size ||
    [...expectedColumns.keys()].some((identity) => !seenColumns.has(identity))
  ) {
    fail("column-physical-envelope");
  }

  const inventory = {
    databases: [],
    schemas: [],
    tables: [],
    sequences: [],
    types: [],
    routines: [],
  };
  for (const columns of columnsByTable.values()) {
    columns.sort(
      (left, right) =>
        left.ordinal - right.ordinal ||
        codePointCompare(left.identity, right.identity),
    );
  }
  for (const object of objects.values()) {
    if (object.objectKind === "database") {
      inventory.databases.push({
        identity: "@database",
        owner: object.owner,
      });
    } else if (object.objectKind === "schema") {
      inventory.schemas.push({
        identity: object.identity,
        name: object.name,
        owner: object.owner,
      });
    } else if (object.objectKind === "table") {
      inventory.tables.push({
        identity: object.identity,
        schema: object.schema,
        name: object.name,
        owner: object.owner,
        columns: columnsByTable.get(object.identity) ?? [],
      });
    } else if (object.objectKind === "sequence") {
      inventory.sequences.push({
        identity: object.identity,
        schema: object.schema,
        name: object.name,
        owner: object.owner,
      });
    } else if (object.objectKind === "type") {
      inventory.types.push({
        identity: object.identity,
        schema: object.schema,
        name: object.name,
        kind: object.kind,
        owner: object.owner,
        ...(object.kind === "enum" ? { values: object.enumValues ?? [] } : {}),
      });
    } else if (object.objectKind === "routine") {
      inventory.routines.push({
        identity: object.identity,
        schema: object.schema,
        signature: object.signature,
        kind: object.kind,
        owner: object.owner,
      });
    } else {
      fail("unknown-object-kind");
    }
  }

  const roles = roleRows.map((row) => ({
    identity: row.role_name,
    name: row.role_name,
    login: row.can_login,
    superuser: row.superuser,
    createDatabase: row.create_database,
    createRole: row.create_role,
    inherit: row.inherit,
    replication: row.replication,
    bypassRls: row.bypass_rls,
    connectionLimit: row.connection_limit,
    validUntil:
      row.valid_until_is_null === true || row.valid_until_raw === "infinity"
        ? "infinity"
        : row.valid_until_raw,
    settings: [],
    credential: row.credential,
  }));
  const memberships = membershipRows.map((row) => {
    const role = oidPrincipal(
      principalEvidence,
      row.granted_role_name,
      row.granted_role_oid,
      "membership-role-evidence",
    );
    const member = oidPrincipal(
      principalEvidence,
      row.member_role_name,
      row.member_role_oid,
      "membership-member-evidence",
    );
    return {
      identity: `${role}->${member}`,
      role,
      member,
      grantor: symbolicPrincipal(
        principalEvidence,
        row.grantor_name,
        row.grantor_oid,
        postgresUser,
        "membership-grantor-evidence",
      ),
      adminOption: row.admin_option,
      inheritOption: row.inherit_option,
      setOption: row.set_option,
    };
  });

  const physicalRows = new Map();
  const defaultAcls = [];
  const seenDefaultAclRows = new Set();
  const defaultAclRowsets = new Map();
  for (const row of defaultAclRows) {
    rejectDuplicateCatalogRow(
      seenDefaultAclRows,
      row,
      "duplicate-default-acl-catalog-row",
    );
    const schema = defaultAclSchemaEvidence(
      row,
      "default-acl-namespace",
      namespaceEvidence,
    );
    const creator = symbolicPrincipal(
      principalEvidence,
      row.creator_name,
      row.creator_oid,
      postgresUser,
      "default-acl-creator-evidence",
    );
    const physical = {
      identity: "",
      creator,
      schema,
      objectKind: row.object_kind,
    };
    physical.identity = defaultAclRowIdentity(physical);
    const existing = physicalRows.get(row.default_acl_oid);
    if (
      existing !== undefined &&
      canonicalDatabaseRuntimeCapabilitiesJson(existing) !==
        canonicalDatabaseRuntimeCapabilitiesJson(physical)
    ) {
      fail("default-acl-row-drift");
    }
    physicalRows.set(row.default_acl_oid, physical);
    const populated = hasAclEntry(row, "default-acl-envelope");
    recordAclOrdinalEvidence(
      defaultAclRowsets,
      row.default_acl_oid,
      populated ? row.acl_ordinal : null,
    );
    if (populated) {
      const entry = {
        identity: "",
        creator,
        schema,
        objectKind: row.object_kind,
        grantor: symbolicPrincipal(
          principalEvidence,
          row.grantor_name,
          row.grantor_oid,
          postgresUser,
          "default-acl-grantor-evidence",
        ),
        grantee: aclGrantee(
          principalEvidence,
          row.grantee_name,
          row.grantee_oid,
          row.grantee_is_public,
          postgresUser,
          "default-acl-grantee-evidence",
        ),
        privilege: row.privilege_type,
        grantable: row.is_grantable,
      };
      entry.identity = defaultAclIdentity(entry);
      defaultAcls.push(entry);
    }
  }
  assertCompleteAclOrdinalEvidence(defaultAclRowsets, "default-acl-rowset");

  return {
    schemaVersion: policy.schemaVersion,
    contract: policy.contract,
    phase: policy.phase,
    available: policy.available,
    ledger: cloneJson(policy.ledger),
    provenance: cloneJson(policy.provenance),
    inventory,
    roles,
    memberships,
    grants,
    defaultAclRows: [...physicalRows.values()],
    defaultAcls,
  };
}

function validateBootstrapCatalogUser(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(value) ||
    value.startsWith("learncoding_")
  ) {
    fail("bootstrap-user");
  }
  return value;
}

function validatePredefinedPublicOwner(result) {
  const row = exactOne(result, "predefined-public-owner");
  if (
    row.role_oid !== "6171" ||
    row.role_name !== "pg_database_owner" ||
    row.can_login !== false ||
    row.superuser !== false ||
    row.create_database !== false ||
    row.create_role !== false ||
    row.inherit !== true ||
    row.replication !== false ||
    row.bypass_rls !== false ||
    row.connection_limit !== -1 ||
    row.password_is_null !== true ||
    row.valid_until_is_null !== true
  ) {
    fail("predefined-public-owner");
  }
  return Object.freeze({
    name: row.role_name,
    oid: row.role_oid,
  });
}

async function observeBootstrapDatabaseRuntimeCapabilityCatalogInternal(
  client,
  { postgresUser, postgresDatabase, policy },
  { allowPredefinedPublicOwner = false } = {},
) {
  postgresUser = validateBootstrapCatalogUser(postgresUser);
  const context = exactOne(await client.query(CONTEXT_SQL), "catalog-context");
  const major = Math.trunc(context.server_version_num / 10_000);
  if (
    ![17, 18].includes(major) ||
    context.database_name !== postgresDatabase ||
    context.session_user_name !== postgresUser ||
    context.current_user_name !== postgresUser
  ) {
    fail("catalog-context");
  }
  const parameters = [MANAGED_ROLE_NAMES];
  const observations = await Promise.all([
    client.query(ROLES_SQL, parameters),
    client.query(ROLE_SETTINGS_SQL, parameters),
    client.query(MEMBERSHIPS_SQL, parameters),
    client.query(EFFECTIVE_MEMBERSHIPS_SQL, parameters),
    client.query(OBJECTS_SQL),
    client.query(COLUMNS_SQL),
    client.query(DEFAULT_ACLS_SQL),
    ...(allowPredefinedPublicOwner
      ? [client.query(PREDEFINED_PUBLIC_OWNER_SQL)]
      : []),
  ]);
  const [
    roles,
    settings,
    memberships,
    effectiveMemberships,
    objects,
    columns,
    defaultAcls,
    predefinedPublicOwnerResult,
  ] = observations;
  return normalizeCatalog({
    policy,
    postgresUser,
    roleRows: roles.rows,
    settingRows: settings.rows,
    membershipRows: memberships.rows,
    effectiveMembershipRows: effectiveMemberships.rows,
    objectRows: objects.rows,
    columnRows: columns.rows,
    defaultAclRows: defaultAcls.rows,
    predefinedPublicOwner:
      predefinedPublicOwnerResult === undefined
        ? null
        : validatePredefinedPublicOwner(predefinedPublicOwnerResult),
  });
}

export async function observeBootstrapDatabaseRuntimeCapabilityCatalog(
  client,
  options,
) {
  return observeBootstrapDatabaseRuntimeCapabilityCatalogInternal(
    client,
    options,
  );
}

function sortedFoundationCollection(values) {
  return values.toSorted((left, right) =>
    codePointCompare(
      canonicalDatabaseRuntimeCapabilitiesJson(left),
      canonicalDatabaseRuntimeCapabilitiesJson(right),
    ),
  );
}

function normalizeFoundationRoleTopology({
  postgresUser,
  roleRows,
  settingRows,
  membershipRows,
  effectiveMembershipRows,
}) {
  if (settingRows.length !== 0) fail("foundation-role-settings");
  validateEffectiveMemberships(effectiveMembershipRows);
  const principalEvidence = principalEvidenceRegistry(
    roleRows,
    membershipRows,
    postgresUser,
    "foundation-principal-identity-evidence",
  );
  const roles = roleRows.map((row) => ({
    identity: row.role_name,
    name: row.role_name,
    login: row.can_login,
    superuser: row.superuser,
    createDatabase: row.create_database,
    createRole: row.create_role,
    inherit: row.inherit,
    replication: row.replication,
    bypassRls: row.bypass_rls,
    connectionLimit: row.connection_limit,
    validUntil:
      row.valid_until_is_null === true || row.valid_until_raw === "infinity"
        ? "infinity"
        : row.valid_until_raw,
    settings: [],
    credential: row.credential,
  }));
  const memberships = membershipRows.map((row) => {
    const role = oidPrincipal(
      principalEvidence,
      row.granted_role_name,
      row.granted_role_oid,
      "foundation-membership-role-evidence",
    );
    const member = oidPrincipal(
      principalEvidence,
      row.member_role_name,
      row.member_role_oid,
      "foundation-membership-member-evidence",
    );
    return {
      identity: `${role}->${member}`,
      role,
      member,
      grantor: symbolicPrincipal(
        principalEvidence,
        row.grantor_name,
        row.grantor_oid,
        postgresUser,
        "foundation-membership-grantor-evidence",
      ),
      adminOption: row.admin_option,
      inheritOption: row.inherit_option,
      setOption: row.set_option,
    };
  });
  return {
    roles: sortedFoundationCollection(roles),
    memberships: sortedFoundationCollection(memberships),
    principalEvidence,
  };
}

function normalizeFoundationAuthority(
  rows,
  principalEvidence,
  namespaceEvidence,
) {
  const objects = new Map();
  const grants = [];
  const seenRows = new Set();
  const aclRowsets = new Map();
  for (const row of rows) {
    rejectDuplicateCatalogRow(
      seenRows,
      row,
      "duplicate-foundation-authority-row",
    );
    if (
      canonicalOid(row.scope_oid) === null ||
      !["database", "schema"].includes(row.scope_kind) ||
      (row.scope_kind === "database" && row.scope_identity !== "@database")
    ) {
      fail("foundation-authority-object-evidence");
    }
    if (row.scope_kind === "schema") {
      bindOidName(
        namespaceEvidence,
        row.scope_identity,
        row.scope_oid,
        "foundation-schema-evidence",
      );
    }
    const object = {
      identity: row.scope_identity,
      kind: row.scope_kind,
      owner: oidPrincipal(
        principalEvidence,
        row.owner_name,
        row.owner_oid,
        "foundation-authority-owner-evidence",
      ),
    };
    const existing = objects.get(row.scope_identity);
    if (
      existing !== undefined &&
      canonicalDatabaseRuntimeCapabilitiesJson(existing) !==
        canonicalDatabaseRuntimeCapabilitiesJson(object)
    ) {
      fail("foundation-authority-row-drift");
    }
    objects.set(row.scope_identity, object);
    const populated = hasAclEntry(row, "foundation-authority-acl-envelope");
    recordAclOrdinalEvidence(
      aclRowsets,
      `${row.scope_kind}|${row.scope_oid}`,
      populated ? row.acl_ordinal : null,
    );
    if (populated) {
      grants.push({
        object: row.scope_identity,
        grantor: oidPrincipal(
          principalEvidence,
          row.grantor_name,
          row.grantor_oid,
          "foundation-authority-grantor-evidence",
        ),
        grantee: aclGrantee(
          principalEvidence,
          row.grantee_name,
          row.grantee_oid,
          row.grantee_is_public,
          undefined,
          "foundation-authority-grantee-evidence",
        ),
        privilege: row.privilege_type,
        grantable: row.is_grantable,
      });
    }
  }
  assertCompleteAclOrdinalEvidence(
    aclRowsets,
    "foundation-authority-acl-rowset",
  );
  return {
    objects: sortedFoundationCollection([...objects.values()]),
    grants: sortedFoundationCollection(grants),
  };
}

function normalizeFoundationDefaultAcls(
  rows,
  postgresUser,
  principalEvidence,
  namespaceEvidence,
) {
  const physicalRows = new Map();
  const tuples = [];
  const seenRows = new Set();
  const aclRowsets = new Map();
  for (const row of rows) {
    rejectDuplicateCatalogRow(
      seenRows,
      row,
      "duplicate-foundation-default-acl-row",
    );
    const schema = defaultAclSchemaEvidence(
      row,
      "foundation-default-acl-namespace",
      namespaceEvidence,
    );
    const creator = symbolicPrincipal(
      principalEvidence,
      row.creator_name,
      row.creator_oid,
      postgresUser,
      "foundation-default-acl-creator-evidence",
    );
    const physical = {
      identity: "",
      creator,
      schema,
      objectKind: row.object_kind,
    };
    physical.identity = defaultAclRowIdentity(physical);
    const existing = physicalRows.get(row.default_acl_oid);
    if (
      existing !== undefined &&
      canonicalDatabaseRuntimeCapabilitiesJson(existing) !==
        canonicalDatabaseRuntimeCapabilitiesJson(physical)
    ) {
      fail("foundation-default-acl-row-drift");
    }
    physicalRows.set(row.default_acl_oid, physical);
    const populated = hasAclEntry(row, "foundation-default-acl-envelope");
    recordAclOrdinalEvidence(
      aclRowsets,
      row.default_acl_oid,
      populated ? row.acl_ordinal : null,
    );
    if (populated) {
      const tuple = {
        identity: "",
        creator,
        schema,
        objectKind: row.object_kind,
        grantor: symbolicPrincipal(
          principalEvidence,
          row.grantor_name,
          row.grantor_oid,
          postgresUser,
          "foundation-default-acl-grantor-evidence",
        ),
        grantee: aclGrantee(
          principalEvidence,
          row.grantee_name,
          row.grantee_oid,
          row.grantee_is_public,
          postgresUser,
          "foundation-default-acl-grantee-evidence",
        ),
        privilege: row.privilege_type,
        grantable: row.is_grantable,
      };
      tuple.identity = defaultAclIdentity(tuple);
      tuples.push(tuple);
    }
  }
  assertCompleteAclOrdinalEvidence(aclRowsets, "foundation-default-acl-rowset");
  return {
    rows: sortedFoundationCollection([...physicalRows.values()]),
    tuples: sortedFoundationCollection(tuples),
  };
}

function expectedFoundationEnvelope(schemaNames) {
  const owner = "learncoding_owner";
  const loginRoles = MANAGED_ROLE_NAMES.filter((role) => role !== owner);
  const objects = [
    { identity: "@database", kind: "database", owner },
    ...schemaNames.map((identity) => ({
      identity,
      kind: "schema",
      owner,
    })),
  ];
  const grants = [
    ...["CONNECT", "CREATE", "TEMPORARY"].map((privilege) => ({
      object: "@database",
      grantor: owner,
      grantee: owner,
      privilege,
      grantable: false,
    })),
    ...loginRoles.map((grantee) => ({
      object: "@database",
      grantor: owner,
      grantee,
      privilege: "CONNECT",
      grantable: false,
    })),
    ...schemaNames.flatMap((object) =>
      ["USAGE", "CREATE"].map((privilege) => ({
        object,
        grantor: owner,
        grantee: owner,
        privilege,
        grantable: false,
      })),
    ),
  ];
  const defaultRows =
    CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.defaultAclRows.filter(
      (entry) =>
        entry.schema === null &&
        ["routine", "type"].includes(entry.objectKind) &&
        (entry.creator === owner ||
          entry.creator?.kind === BOOTSTRAP_SESSION_AUTHORITY.kind),
    );
  const defaultAcls =
    CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.defaultAcls.filter(
      (entry) =>
        entry.schema === null &&
        ["routine", "type"].includes(entry.objectKind) &&
        (entry.creator === owner ||
          entry.creator?.kind === BOOTSTRAP_SESSION_AUTHORITY.kind),
    );
  return {
    roles: sortedFoundationCollection(
      CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.roles,
    ),
    memberships: sortedFoundationCollection(
      CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.memberships,
    ),
    authority: {
      objects: sortedFoundationCollection(objects),
      grants: sortedFoundationCollection(grants),
    },
    defaultAcls: {
      rows: sortedFoundationCollection(defaultRows),
      tuples: sortedFoundationCollection(defaultAcls),
    },
  };
}

function assertFoundationRepairableDefaultAcls(rows, postgresUser) {
  const allowedCreators = new Set(["learncoding_owner", postgresUser]);
  const allowedGrantees = new Set([
    "PUBLIC",
    postgresUser,
    ...MANAGED_ROLE_NAMES,
  ]);
  const allowedSchemas = new Set([null, "public", "drizzle"]);
  const seenRows = new Map();
  const seenRawRows = new Set();
  const seenTuples = new Set();
  const aclRowsets = new Map();
  const principalEvidence = createOidNameEvidence();
  const namespaceEvidence = createOidNameEvidence();
  for (const row of rows) {
    rejectDuplicateCatalogRow(
      seenRawRows,
      row,
      "foundation-default-acl-preflight",
    );
    if (
      !allowedCreators.has(row.creator_name) ||
      !Object.hasOwn(DEFAULT_ACL_CLASSES, row.object_kind)
    ) {
      fail("foundation-default-acl-preflight");
    }
    bindOidName(
      principalEvidence,
      row.creator_name,
      row.creator_oid,
      "foundation-default-acl-preflight",
    );
    if (row.namespace_oid !== "0") {
      bindOidName(
        namespaceEvidence,
        row.schema_name,
        row.namespace_oid,
        "foundation-default-acl-preflight",
      );
    }
    const schema = defaultAclSchemaEvidence(
      row,
      "foundation-default-acl-preflight",
      namespaceEvidence,
    );
    if (!allowedSchemas.has(schema)) {
      fail("foundation-default-acl-preflight");
    }
    const populated = hasAclEntry(row, "foundation-default-acl-preflight");
    const physicalIdentity = [
      row.creator_oid,
      row.namespace_oid,
      row.object_type_code,
    ].join("|");
    const priorPhysical = seenRows.get(row.default_acl_oid);
    if (priorPhysical !== undefined && priorPhysical !== physicalIdentity) {
      fail("foundation-default-acl-preflight");
    }
    seenRows.set(row.default_acl_oid, physicalIdentity);
    recordAclOrdinalEvidence(
      aclRowsets,
      row.default_acl_oid,
      populated ? row.acl_ordinal : null,
    );
    if (!populated) continue;
    if (
      row.grantor_name !== row.creator_name ||
      row.grantor_oid !== row.creator_oid
    ) {
      fail("foundation-default-acl-preflight");
    }
    requireOidName(
      principalEvidence,
      row.grantor_name,
      row.grantor_oid,
      "foundation-default-acl-preflight",
    );
    if (!row.grantee_is_public) {
      if (!allowedGrantees.has(row.grantee_name)) {
        fail("foundation-default-acl-preflight");
      }
      bindOidName(
        principalEvidence,
        row.grantee_name,
        row.grantee_oid,
        "foundation-default-acl-preflight",
      );
    }
    const grantee = aclGrantee(
      principalEvidence,
      row.grantee_name,
      row.grantee_oid,
      row.grantee_is_public,
      postgresUser,
      "foundation-default-acl-preflight",
    );
    const granteeName =
      grantee?.kind === BOOTSTRAP_SESSION_AUTHORITY.kind
        ? postgresUser
        : grantee;
    if (
      !allowedGrantees.has(granteeName) ||
      row.is_grantable !== false ||
      !DEFAULT_ACL_CLASSES[row.object_kind].privileges.includes(
        row.privilege_type,
      )
    ) {
      fail("foundation-default-acl-preflight");
    }
    const tupleIdentity = [
      physicalIdentity,
      row.grantor_oid,
      row.grantee_oid,
      row.privilege_type,
      row.is_grantable,
    ].join("|");
    if (seenTuples.has(tupleIdentity)) {
      fail("foundation-default-acl-preflight");
    }
    seenTuples.add(tupleIdentity);
  }
  assertCompleteAclOrdinalEvidence(
    aclRowsets,
    "foundation-default-acl-preflight",
  );
}

export async function verifyBootstrapDatabaseRuntimeCapabilityFoundation(
  client,
  { postgresUser, postgresDatabase, resolution },
) {
  if (
    resolution?.phase !== DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION ||
    resolution.policy !== null ||
    resolution.reconcileApplicationAcls !== false
  ) {
    fail("unsupported-foundation-verification-phase");
  }
  const context = exactOne(
    await client.query(CONTEXT_SQL),
    "foundation-context",
  );
  const major = Math.trunc(context.server_version_num / 10_000);
  if (
    ![17, 18].includes(major) ||
    context.database_name !== postgresDatabase ||
    context.database_owner_name !== "learncoding_owner" ||
    context.session_user_name !== postgresUser ||
    context.current_user_name !== postgresUser
  ) {
    fail("foundation-context");
  }
  const parameters = [MANAGED_ROLE_NAMES];
  const [
    roles,
    settings,
    memberships,
    effectiveMemberships,
    authority,
    defaultAcls,
  ] = await Promise.all([
    client.query(ROLES_SQL, parameters),
    client.query(ROLE_SETTINGS_SQL, parameters),
    client.query(MEMBERSHIPS_SQL, parameters),
    client.query(EFFECTIVE_MEMBERSHIPS_SQL, parameters),
    client.query(FOUNDATION_AUTHORITY_SQL),
    client.query(DEFAULT_ACLS_SQL),
  ]);
  const topology = normalizeFoundationRoleTopology({
    postgresUser,
    roleRows: roles.rows,
    settingRows: settings.rows,
    membershipRows: memberships.rows,
    effectiveMembershipRows: effectiveMemberships.rows,
  });
  const namespaceEvidence = createOidNameEvidence();
  const observedAuthority = normalizeFoundationAuthority(
    authority.rows,
    topology.principalEvidence,
    namespaceEvidence,
  );
  const observedDefaultAcls = normalizeFoundationDefaultAcls(
    defaultAcls.rows,
    postgresUser,
    topology.principalEvidence,
    namespaceEvidence,
  );
  const schemaNames = observedAuthority.objects
    .filter((entry) => entry.kind === "schema")
    .map((entry) => entry.identity)
    .toSorted(codePointCompare);
  const exactPublicOnly =
    schemaNames.length === 1 && schemaNames[0] === "public";
  const exactPublicAndDrizzle =
    schemaNames.length === 2 &&
    schemaNames[0] === "drizzle" &&
    schemaNames[1] === "public";
  const reviewedPrefixApplied = resolution.ledgerIdentity?.appliedCount > 0;
  if (
    (reviewedPrefixApplied && !exactPublicAndDrizzle) ||
    (!reviewedPrefixApplied && !exactPublicOnly && !exactPublicAndDrizzle)
  ) {
    fail("foundation-schema-inventory");
  }
  const expected = expectedFoundationEnvelope(schemaNames);
  const observed = {
    roles: topology.roles,
    memberships: topology.memberships,
    authority: observedAuthority,
    defaultAcls: observedDefaultAcls,
  };
  if (
    canonicalDatabaseRuntimeCapabilitiesJson(observed) !==
    canonicalDatabaseRuntimeCapabilitiesJson(expected)
  ) {
    fail("foundation-catalog-drift");
  }
  return {
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION,
    policyFingerprint: null,
  };
}

export async function establishBootstrapDatabaseRuntimeCapabilityFoundation(
  client,
  { postgresUser, postgresDatabase },
) {
  const owner = quoteIdentifier("learncoding_owner");
  const bootstrap = quoteIdentifier(postgresUser);
  const loginRoleNames = MANAGED_ROLE_NAMES.filter(
    (role) => role !== "learncoding_owner",
  );
  const loginRoles = loginRoleNames.map(quoteIdentifier).join(", ");
  const database = quoteIdentifier(postgresDatabase);
  const existingDefaultAcls = await client.query(DEFAULT_ACLS_SQL);
  assertFoundationRepairableDefaultAcls(existingDefaultAcls.rows, postgresUser);
  await client.query(`alter database ${database} owner to ${owner}`);
  await client.query(`alter schema public owner to ${owner}`);
  await client.query(
    `revoke connect, create, temporary on database ${database} from PUBLIC, ${loginRoles}, ${bootstrap}`,
  );
  await client.query(`grant connect on database ${database} to ${loginRoles}`);
  await client.query(
    `revoke usage, create on schema public from PUBLIC, pg_database_owner, ${loginRoles}, ${bootstrap}`,
  );
  const drizzlePresence = exactOne(
    await client.query(`
      select pg_catalog.to_regnamespace('drizzle') is not null
               foundation_drizzle_schema_present`),
    "foundation-drizzle-presence",
  );
  if (typeof drizzlePresence.foundation_drizzle_schema_present !== "boolean") {
    fail("foundation-drizzle-presence");
  }
  const schemaNames = ["public"];
  if (drizzlePresence.foundation_drizzle_schema_present) {
    schemaNames.push("drizzle");
    await client.query(`alter schema drizzle owner to ${owner}`);
    await client.query(
      `revoke usage, create on schema drizzle from PUBLIC, pg_database_owner, ${loginRoles}, ${bootstrap}`,
    );
  }

  for (const creator of [owner, bootstrap]) {
    await client.query(`set local role ${creator}`);
    try {
      const allGrantees = [
        "PUBLIC",
        owner,
        bootstrap,
        ...loginRoleNames.map(quoteIdentifier),
      ];
      const nonCreatorGrantees = [
        ...new Set(allGrantees.filter((grantee) => grantee !== creator)),
      ].join(", ");
      const schemaGrantees = [...new Set(allGrantees)].join(", ");
      for (const objectClass of Object.values(DEFAULT_ACL_CLASSES)) {
        await client.query(
          `alter default privileges for role ${creator} revoke all privileges on ${objectClass.sql} from ${nonCreatorGrantees} cascade`,
        );
        await client.query(
          `alter default privileges for role ${creator} grant all privileges on ${objectClass.sql} to ${creator}`,
        );
        for (const schemaName of schemaNames) {
          await client.query(
            `alter default privileges for role ${creator} in schema ${quoteIdentifier(
              schemaName,
            )} revoke all privileges on ${objectClass.sql} from ${schemaGrantees} cascade`,
          );
        }
      }
    } finally {
      await client.query("reset role");
    }
  }
  return verifyBootstrapDatabaseRuntimeCapabilityFoundation(client, {
    postgresUser,
    postgresDatabase,
    resolution: {
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION,
      policy: null,
      reconcileApplicationAcls: false,
    },
  });
}

function structuralInventory(value) {
  return {
    databases: value.databases.map(({ identity }) => ({ identity })),
    schemas: value.schemas.map(({ identity, name }) => ({
      identity,
      name,
    })),
    tables: value.tables.map(({ identity, schema, name, columns }) => ({
      identity,
      schema,
      name,
      columns: columns.map(
        ({ identity: columnIdentity, name: columnName }) => ({
          identity: columnIdentity,
          name: columnName,
        }),
      ),
    })),
    sequences: value.sequences.map(({ identity, schema, name }) => ({
      identity,
      schema,
      name,
    })),
    types: value.types.map(({ identity, schema, name, kind, values }) => ({
      identity,
      schema,
      name,
      kind,
      ...(values === undefined ? {} : { values }),
    })),
    routines: value.routines.map(({ identity, schema, signature, kind }) => ({
      identity,
      schema,
      signature,
      kind,
    })),
  };
}

function assertBootstrapStructuralInventory(catalog, policy, postgresUser) {
  if (
    canonicalDatabaseRuntimeCapabilitiesJson(
      structuralInventory(catalog.inventory),
    ) !==
    canonicalDatabaseRuntimeCapabilitiesJson(
      structuralInventory(policy.inventory),
    )
  ) {
    fail("structural-inventory");
  }
  for (const collection of [
    "databases",
    "schemas",
    "tables",
    "sequences",
    "types",
    "routines",
  ]) {
    for (const object of catalog.inventory[collection]) {
      const allowed =
        object.owner === "learncoding_owner" ||
        object.owner === postgresUser ||
        (collection === "schemas" &&
          object.identity === "public" &&
          object.owner === "pg_database_owner");
      if (!allowed) fail("pre-ownership-owner");
    }
  }
}

function routineLocator(value) {
  const open = value.signature.indexOf("(");
  if (
    open <= 0 ||
    !value.signature.endsWith(")") ||
    /[;\u0000-\u001f\u007f]/u.test(value.signature)
  ) {
    fail("routine-identity");
  }
  return `${quoteIdentifier(value.schema)}.${quoteIdentifier(
    value.signature.slice(0, open),
  )}${value.signature.slice(open)}`;
}

export async function transferBootstrapDatabaseRuntimeCapabilityOwnership(
  client,
  { postgresUser, postgresDatabase, policy },
) {
  const catalog =
    await observeBootstrapDatabaseRuntimeCapabilityCatalogInternal(
      client,
      { postgresUser, postgresDatabase, policy },
      { allowPredefinedPublicOwner: true },
    );
  assertBootstrapStructuralInventory(catalog, policy, postgresUser);
  const observedOwners = Object.fromEntries(
    ["databases", "schemas", "tables", "sequences", "types", "routines"].map(
      (collection) => [
        collection,
        new Map(
          catalog.inventory[collection].map((entry) => [
            entry.identity,
            entry.owner,
          ]),
        ),
      ],
    ),
  );
  const compositeTypePolicy = new Map(
    policy.inventory.types
      .filter((entry) => entry.kind === "composite")
      .map((entry) => [entry.identity, entry]),
  );
  const tableNeedsOwnershipRepair = (entry) => {
    const composite = compositeTypePolicy.get(entry.identity);
    if (composite === undefined) {
      fail("table-composite-owner-policy");
    }
    return (
      observedOwners.tables.get(entry.identity) !== entry.owner ||
      observedOwners.types.get(composite.identity) !== composite.owner
    );
  };
  const statements = [
    ...policy.inventory.databases
      .filter(
        (entry) => observedOwners.databases.get(entry.identity) !== entry.owner,
      )
      .map(
        () =>
          `alter database ${quoteIdentifier(
            postgresDatabase,
          )} owner to ${quoteIdentifier("learncoding_owner")}`,
      ),
    ...policy.inventory.schemas
      .filter(
        (entry) => observedOwners.schemas.get(entry.identity) !== entry.owner,
      )
      .map(
        (entry) =>
          `alter schema ${quoteIdentifier(
            entry.name,
          )} owner to ${quoteIdentifier(entry.owner)}`,
      ),
    ...policy.inventory.tables
      .filter(tableNeedsOwnershipRepair)
      .map(
        (entry) =>
          `alter table ${quoteIdentifier(entry.schema)}.${quoteIdentifier(
            entry.name,
          )} owner to ${quoteIdentifier(entry.owner)}`,
      ),
    ...policy.inventory.sequences
      .filter(
        (entry) => observedOwners.sequences.get(entry.identity) !== entry.owner,
      )
      .map(
        (entry) =>
          `alter sequence ${quoteIdentifier(
            entry.schema,
          )}.${quoteIdentifier(entry.name)} owner to ${quoteIdentifier(
            entry.owner,
          )}`,
      ),
    ...policy.inventory.types
      .filter(
        (entry) =>
          entry.kind !== "composite" &&
          observedOwners.types.get(entry.identity) !== entry.owner,
      )
      .map(
        (entry) =>
          `alter type ${quoteIdentifier(entry.schema)}.${quoteIdentifier(
            entry.name,
          )} owner to ${quoteIdentifier(entry.owner)}`,
      ),
    ...policy.inventory.routines
      .filter(
        (entry) => observedOwners.routines.get(entry.identity) !== entry.owner,
      )
      .map(
        (entry) =>
          `alter function ${routineLocator(
            entry,
          )} owner to ${quoteIdentifier(entry.owner)}`,
      ),
  ];
  for (const statement of statements) {
    await client.query(statement);
  }
  const after = await observeBootstrapDatabaseRuntimeCapabilityCatalog(client, {
    postgresUser,
    postgresDatabase,
    policy,
  });
  assertBootstrapStructuralInventory(after, policy, postgresUser);
  for (const collection of [
    "databases",
    "schemas",
    "tables",
    "sequences",
    "types",
    "routines",
  ]) {
    if (
      after.inventory[collection].some(
        (entry) => entry.owner !== "learncoding_owner",
      )
    ) {
      fail("post-ownership-owner");
    }
  }
}

function policyLookups(policy) {
  return {
    schemas: new Map(
      policy.inventory.schemas.map((entry) => [entry.identity, entry]),
    ),
    tables: new Map(
      policy.inventory.tables.map((entry) => [entry.identity, entry]),
    ),
    columns: new Map(
      policy.inventory.tables.flatMap((table) =>
        table.columns.map((column) => [column.identity, { table, column }]),
      ),
    ),
    sequences: new Map(
      policy.inventory.sequences.map((entry) => [entry.identity, entry]),
    ),
    types: new Map(
      policy.inventory.types.map((entry) => [entry.identity, entry]),
    ),
    routines: new Map(
      policy.inventory.routines.map((entry) => [entry.identity, entry]),
    ),
  };
}

function grantTarget(entry, lookups, postgresDatabase) {
  if (!OBJECT_PRIVILEGES[entry.objectKind]?.has(entry.privilege)) {
    fail("grant-privilege");
  }
  if (entry.objectKind === "database") {
    if (entry.object !== "@database") fail("grant-database");
    return `on database ${quoteIdentifier(postgresDatabase)}`;
  }
  if (entry.objectKind === "schema") {
    const object = lookups.schemas.get(entry.object);
    if (!object) fail("grant-schema");
    return `on schema ${quoteIdentifier(object.name)}`;
  }
  if (entry.objectKind === "table") {
    const object = lookups.tables.get(entry.object);
    if (!object) fail("grant-table");
    return `on table ${quoteIdentifier(object.schema)}.${quoteIdentifier(
      object.name,
    )}`;
  }
  if (entry.objectKind === "column") {
    const object = lookups.columns.get(entry.object);
    if (!object) fail("grant-column");
    return `(${quoteIdentifier(object.column.name)}) on table ${quoteIdentifier(
      object.table.schema,
    )}.${quoteIdentifier(object.table.name)}`;
  }
  if (entry.objectKind === "sequence") {
    const object = lookups.sequences.get(entry.object);
    if (!object) fail("grant-sequence");
    return `on sequence ${quoteIdentifier(
      object.schema,
    )}.${quoteIdentifier(object.name)}`;
  }
  if (entry.objectKind === "type") {
    const object = lookups.types.get(entry.object);
    if (!object) fail("grant-type");
    return `on type ${quoteIdentifier(object.schema)}.${quoteIdentifier(
      object.name,
    )}`;
  }
  if (entry.objectKind === "routine") {
    const object = lookups.routines.get(entry.object);
    if (!object) fail("grant-routine");
    return `on routine ${routineLocator(object)}`;
  }
  fail("grant-kind");
}

function resolvedDefaultPrincipal(value, postgresUser) {
  if (value?.kind === BOOTSTRAP_SESSION_AUTHORITY.kind) {
    return postgresUser;
  }
  if (typeof value !== "string" || !MANAGED_ROLE_NAMES.includes(value)) {
    fail("default-acl-principal");
  }
  return value;
}

function renderedDefaultGrantee(value, postgresUser, action) {
  if (value === "PUBLIC") {
    if (action !== "remove") fail("default-acl-public-add");
    return "PUBLIC";
  }
  return quoteIdentifier(resolvedDefaultPrincipal(value, postgresUser));
}

function defaultAclPrefix(entry, postgresUser) {
  const creator = resolvedDefaultPrincipal(entry.creator, postgresUser);
  const objectClass = DEFAULT_ACL_CLASSES[entry.objectKind];
  if (!objectClass) fail("default-acl-kind");
  const schema =
    entry.schema === null ? "" : ` in schema ${quoteIdentifier(entry.schema)}`;
  return {
    creator,
    objectClass,
    sql: `alter default privileges for role ${quoteIdentifier(
      creator,
    )}${schema}`,
  };
}

function grantTupleKey(entry) {
  return [
    entry.objectKind,
    entry.object,
    entry.grantor,
    entry.grantee,
    entry.privilege,
  ].join("|");
}

function renderPlanActions({ plan, policy, postgresUser, postgresDatabase }) {
  if (plan.blocked || plan.mutations.length === 0) return [];
  const lookups = policyLookups(policy);
  const additions = new Map(
    plan.mutations
      .filter(
        (mutation) =>
          mutation.action === "add" && mutation.collection === "grants",
      )
      .map((mutation) => [grantTupleKey(mutation.value), mutation]),
  );
  const corrected = new Set();
  const actions = [];

  for (const mutation of plan.mutations) {
    if (
      mutation.collection === "roles" ||
      mutation.collection === "memberships"
    ) {
      fail("role-topology-drift-after-reset");
    }
    if (
      mutation.collection === "grants" &&
      mutation.action === "remove" &&
      mutation.value.grantable === true &&
      additions.has(grantTupleKey(mutation.value))
    ) {
      const entry = mutation.value;
      if (
        entry.grantor !== "learncoding_owner" ||
        (entry.grantee !== "PUBLIC" &&
          !MANAGED_ROLE_NAMES.includes(entry.grantee))
      ) {
        fail("grant-option-principal");
      }
      actions.push({
        priority: 20,
        role: entry.grantor,
        sql: `revoke grant option for ${entry.privilege} ${grantTarget(
          entry,
          lookups,
          postgresDatabase,
        )} from ${
          entry.grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(entry.grantee)
        } cascade`,
      });
      corrected.add(grantTupleKey(entry));
    }
  }

  for (const mutation of plan.mutations) {
    const entry = mutation.value;
    if (mutation.collection === "grants") {
      if (mutation.action === "remove" && corrected.has(grantTupleKey(entry)))
        continue;
      if (
        entry.grantor !== "learncoding_owner" ||
        (entry.grantee !== "PUBLIC" &&
          !MANAGED_ROLE_NAMES.includes(entry.grantee))
      ) {
        fail("grant-principal");
      }
      const principal =
        entry.grantee === "PUBLIC" ? "PUBLIC" : quoteIdentifier(entry.grantee);
      if (mutation.action === "add") {
        if (entry.grantable !== false || entry.grantee === "PUBLIC") {
          fail("grant-add-authority");
        }
        actions.push({
          priority: 50,
          role: entry.grantor,
          sql: `grant ${entry.privilege} ${grantTarget(
            entry,
            lookups,
            postgresDatabase,
          )} to ${principal}`,
        });
      } else if (mutation.action === "remove") {
        actions.push({
          priority: 30,
          role: entry.grantor,
          sql: `revoke ${entry.privilege} ${grantTarget(
            entry,
            lookups,
            postgresDatabase,
          )} from ${principal} cascade`,
        });
      } else {
        fail("grant-mutation");
      }
    } else if (
      mutation.collection === "defaultAclRows" &&
      mutation.action === "ensure"
    ) {
      const prefix = defaultAclPrefix(entry, postgresUser);
      actions.push({
        priority: 10,
        role: prefix.creator,
        sql: `${prefix.sql} revoke ${prefix.objectClass.privileges.join(
          ", ",
        )} on ${prefix.objectClass.sql} from PUBLIC cascade`,
      });
      if (entry.schema === null) {
        const ownerPrivilege =
          entry.objectKind === "routine" ? "EXECUTE" : "USAGE";
        actions.push({
          priority: 11,
          role: prefix.creator,
          sql: `${prefix.sql} grant ${ownerPrivilege} on ${
            prefix.objectClass.sql
          } to ${quoteIdentifier(prefix.creator)}`,
        });
      }
    } else if (mutation.collection === "defaultAcls") {
      const prefix = defaultAclPrefix(entry, postgresUser);
      const grantor = resolvedDefaultPrincipal(entry.grantor, postgresUser);
      const grantee = renderedDefaultGrantee(
        entry.grantee,
        postgresUser,
        mutation.action,
      );
      if (
        grantor !== prefix.creator ||
        !prefix.objectClass.privileges.includes(entry.privilege)
      ) {
        fail("default-acl-authority");
      }
      if (mutation.action === "add") {
        if (entry.grantable !== false) fail("default-acl-grant-option");
        actions.push({
          priority: 60,
          role: prefix.creator,
          sql: `${prefix.sql} grant ${entry.privilege} on ${
            prefix.objectClass.sql
          } to ${grantee}`,
        });
      } else if (mutation.action === "remove") {
        actions.push({
          priority: 15,
          role: prefix.creator,
          sql: `${prefix.sql} revoke ${entry.privilege} on ${
            prefix.objectClass.sql
          } from ${grantee} cascade`,
        });
      } else {
        fail("default-acl-mutation");
      }
    } else if (!["roles", "memberships"].includes(mutation.collection)) {
      fail("unknown-mutation");
    }
  }
  return actions.toSorted(
    (left, right) =>
      left.priority - right.priority ||
      codePointCompare(left.role, right.role) ||
      codePointCompare(left.sql, right.sql),
  );
}

async function executeActions(client, actions) {
  for (const action of actions) {
    await client.query(`set local role ${quoteIdentifier(action.role)}`);
    try {
      await client.query(action.sql);
    } finally {
      await client.query("reset role");
    }
  }
}

function planCatalog(input, section) {
  try {
    return planDatabaseRuntimeCapabilityReconciliation(input);
  } catch {
    fail(section);
  }
}

export async function verifyBootstrapDatabaseRuntimeCapabilities(
  client,
  { postgresUser, postgresDatabase, resolution },
) {
  if (
    resolution.phase !== DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069 ||
    resolution.reconcileApplicationAcls !== true ||
    resolution.policy === null
  ) {
    fail("unsupported-verification-phase");
  }
  const catalog = await observeBootstrapDatabaseRuntimeCapabilityCatalog(
    client,
    {
      postgresUser,
      postgresDatabase,
      policy: resolution.policy,
    },
  );
  const plan = planCatalog(
    {
      phase: resolution.phase,
      policy: resolution.policy,
      catalog,
    },
    "verification-drift",
  );
  if (plan.blocked || plan.mutations.length !== 0) {
    fail("verification-drift");
  }
  return {
    phase: resolution.phase,
    policyFingerprint: plan.policyFingerprint,
  };
}

export async function reconcileBootstrapDatabaseRuntimeCapabilities(
  client,
  { postgresUser, postgresDatabase, resolution },
) {
  if (
    resolution.phase !== DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069 ||
    resolution.reconcileApplicationAcls !== true ||
    resolution.policy === null
  ) {
    fail("unsupported-reconciliation-phase");
  }
  const catalog = await observeBootstrapDatabaseRuntimeCapabilityCatalog(
    client,
    {
      postgresUser,
      postgresDatabase,
      policy: resolution.policy,
    },
  );
  const plan = planCatalog(
    {
      phase: resolution.phase,
      policy: resolution.policy,
      catalog,
    },
    "blocked-plan",
  );
  if (plan.blocked) fail("blocked-plan");
  const actions = renderPlanActions({
    plan,
    policy: resolution.policy,
    postgresUser,
    postgresDatabase,
  });
  await executeActions(client, actions);

  const verifiedCatalog =
    await observeBootstrapDatabaseRuntimeCapabilityCatalog(client, {
      postgresUser,
      postgresDatabase,
      policy: resolution.policy,
    });
  const verifiedPlan = planCatalog(
    {
      phase: resolution.phase,
      policy: resolution.policy,
      catalog: verifiedCatalog,
    },
    "post-reconciliation-drift",
  );
  if (verifiedPlan.blocked || verifiedPlan.mutations.length !== 0) {
    fail("post-reconciliation-drift");
  }
  return {
    phase: resolution.phase,
    policyFingerprint: verifiedPlan.policyFingerprint,
    mutationCount: actions.length,
  };
}
