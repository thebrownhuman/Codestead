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

const DEFAULT_ACL_KIND_BY_CODE = Object.freeze({
  r: "table",
  S: "sequence",
  f: "routine",
  T: "type",
});

const EXPECTED_ROLES = Object.freeze([
  "learncoding_owner",
  "learncoding_migrator",
  "learncoding_app",
  "learncoding_worker",
  "learncoding_ops",
  "learncoding_backup_reporter",
]);

export class VerifierDatabaseRuntimeCapabilityError extends Error {
  constructor(section) {
    super(`database runtime capability verification failed: ${section}`);
    this.name = "VerifierDatabaseRuntimeCapabilityError";
  }
}

function fail(section) {
  throw new VerifierDatabaseRuntimeCapabilityError(section);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertExactObjectKeys(value, expectedKeys, section) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).toSorted().join("|") !==
      [...expectedKeys].toSorted().join("|")
  ) {
    fail(section);
  }
}

function validateVerifierCredentialEvidence(
  value,
  { policy, postgresDatabase, bootstrapUser, roleRows },
) {
  assertExactObjectKeys(
    value,
    ["postgresDatabase", "postgresUser", "roles"],
    "credential-evidence-envelope",
  );
  if (
    value.postgresDatabase !== postgresDatabase ||
    value.postgresUser !== bootstrapUser ||
    !Array.isArray(value.roles) ||
    !Array.isArray(policy?.roles) ||
    value.roles.length !== policy.roles.length
  ) {
    fail("credential-evidence-envelope");
  }
  const expectedByName = new Map(policy.roles.map((role) => [role.name, role]));
  const observedByName = new Map();
  const observedByOid = new Map();
  for (const row of value.roles) {
    assertExactObjectKeys(
      row,
      ["roleOid", "roleName", "credential"],
      "credential-evidence-row",
    );
    const oid = canonicalOid(row.roleOid);
    const expected = expectedByName.get(row.roleName);
    if (
      oid === null ||
      expected === undefined ||
      !["none", "scram-managed"].includes(row.credential) ||
      row.credential !== expected.credential ||
      observedByName.has(row.roleName) ||
      observedByOid.has(oid)
    ) {
      fail("credential-evidence-row");
    }
    observedByName.set(row.roleName, row);
    observedByOid.set(oid, row.roleName);
  }
  if (observedByName.size !== expectedByName.size) {
    fail("credential-evidence-cardinality");
  }
  if (roleRows !== undefined) {
    if (!Array.isArray(roleRows) || roleRows.length !== expectedByName.size) {
      fail("credential-catalog-binding");
    }
    for (const roleRow of roleRows) {
      const evidence = observedByName.get(roleRow.role_name);
      if (
        evidence === undefined ||
        canonicalOid(roleRow.role_oid) !== evidence.roleOid
      ) {
        fail("credential-catalog-binding");
      }
    }
  }
  return observedByName;
}

function exactOne(result, section) {
  if (result?.rows?.length !== 1) fail(section);
  return result.rows[0];
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

function symbolicPrincipal(evidence, name, oid, bootstrapUser, section) {
  const principal = requireOidName(evidence, name, oid, section);
  return name === bootstrapUser ? BOOTSTRAP_SESSION_AUTHORITY : principal;
}

function aclGrantee(evidence, name, oid, isPublic, bootstrapUser, section) {
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
  return bootstrapUser === undefined
    ? oidPrincipal(evidence, name, oid, section)
    : symbolicPrincipal(evidence, name, oid, bootstrapUser, section);
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

function defaultAclRowIdentity(entry) {
  return [
    principalLabel(entry.creator),
    entry.schema ?? "@global",
    entry.objectKind,
  ].join("|");
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

export function assertVerifierDatabaseRuntimeCapabilityPhaseRequest(
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

export async function resolveVerifierDatabaseRuntimeCapabilityPhase(
  client,
  { requestedPhase } = {},
) {
  assertVerifierDatabaseRuntimeCapabilityPhaseRequest(requestedPhase);
  const presence = exactOne(
    await client.query(`
      select pg_catalog.to_regclass(
               'drizzle.__drizzle_migrations'
             ) is not null verifier_capability_migration_journal_present`),
    "ledger-presence",
  );
  if (
    typeof presence.verifier_capability_migration_journal_present !== "boolean"
  ) {
    fail("ledger-presence");
  }
  const ledger = await verifyAppliedMigrationLedger(client);
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
    journalPresent: presence.verifier_capability_migration_journal_present,
    reviewedMigrationTail: tail?.tag ?? null,
    reviewedPrefixExact:
      presence.verifier_capability_migration_journal_present &&
      ledger.appliedCount > 0,
    reviewedMigrationCount: ledger.appliedCount,
    reviewedMigrationLedgerSha256: ledger.ledgerSha256,
    requestedPhase,
  });
}

export function assertSameVerifierDatabaseRuntimeCapabilityPhase(
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

const VERIFIER_CONTEXT_SQL = `
  select pg_catalog.current_setting('server_version_num')::integer
           server_version_num,
         pg_catalog.current_database()::text database_name,
         session_user::text session_user_name,
         current_user::text current_user_name
  /* verifier_database_runtime_capability_context */`;

const VERIFIER_CREDENTIAL_CONTEXT_SQL = `
  select pg_catalog.current_setting('server_version_num')::integer
           server_version_num,
         pg_catalog.current_database()::text database_name,
         session_user::text session_user_name,
         current_user::text current_user_name,
         role_row.rolsuper current_user_superuser
    from pg_catalog.pg_roles role_row
   where role_row.rolname = current_user
   /* verifier_database_runtime_credential_evidence_context */`;

const VERIFIER_CREDENTIAL_ROLES_SQL = `
  select auth.oid::text role_oid,
         auth.rolname::text role_name,
         auth.rolcanlogin can_login,
         auth.rolpassword is null password_is_null,
         coalesce(
           auth.rolpassword like 'SCRAM-SHA-256$%',
           false
         ) password_is_scram
    from pg_catalog.pg_authid auth
   where auth.rolname::text = any($1::text[])
      or pg_catalog.starts_with(auth.rolname::text, 'learncoding_')
   order by auth.rolname::text collate "C", auth.oid
   /* verifier_database_runtime_credential_evidence_roles */`;

const VERIFIER_ROLES_SQL = `
  select role_row.oid::text role_oid,
         role_row.rolname::text role_name,
         role_row.rolcanlogin can_login,
         role_row.rolsuper superuser,
         role_row.rolcreatedb create_database,
         role_row.rolcreaterole create_role,
         role_row.rolinherit inherit,
         role_row.rolreplication replication,
         role_row.rolbypassrls bypass_rls,
         role_row.rolconnlimit connection_limit,
         role_row.rolvaliduntil is null valid_until_is_null,
         role_row.rolvaliduntil::text valid_until_raw
    from pg_catalog.pg_roles role_row
   where role_row.rolname::text = any($1::text[])
      or pg_catalog.starts_with(
           role_row.rolname::text,
           'learncoding_'
         )
   order by role_row.rolname::text collate "C", role_row.oid
   /* verifier_database_runtime_capability_roles */`;

const VERIFIER_SETTINGS_SQL = `
  select setting.setdatabase::text database_oid,
         setting.setrole::text role_oid,
         case when setting.setrole = 0 then '@all-roles'
              else role_row.rolname::text end role_name,
         setting_value.ordinality::integer setting_ordinal,
         setting_value.setting_text
    from pg_catalog.pg_db_role_setting setting
    left join pg_catalog.pg_roles role_row
      on role_row.oid = setting.setrole
    left join lateral pg_catalog.unnest(setting.setconfig)
      with ordinality setting_value(setting_text, ordinality) on true
   where setting.setrole in (
           select candidate.oid
             from pg_catalog.pg_roles candidate
            where candidate.rolname::text = any($1::text[])
               or pg_catalog.starts_with(
                    candidate.rolname::text,
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
             where database_row.datname =
                   pg_catalog.current_database()
          )
        )
      )
   order by setting.setdatabase,
            setting.setrole,
            setting_value.ordinality nulls first
   /* verifier_database_runtime_capability_role_settings */`;

const VERIFIER_MEMBERSHIPS_SQL = `
  with managed as (
    select role_row.oid
      from pg_catalog.pg_roles role_row
     where role_row.rolname::text = any($1::text[])
        or pg_catalog.starts_with(
             role_row.rolname::text,
             'learncoding_'
           )
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
   /* verifier_database_runtime_capability_memberships */`;

const VERIFIER_EFFECTIVE_MEMBERSHIPS_SQL = `
  with managed as (
    select role_row.oid, role_row.rolname
      from pg_catalog.pg_roles role_row
     where role_row.rolname::text = any($1::text[])
        or pg_catalog.starts_with(
             role_row.rolname::text,
             'learncoding_'
           )
  )
  select member.rolname::text member_name,
         granted.rolname::text granted_role_name,
         pg_catalog.pg_has_role(
           member.oid,
           granted.oid,
           'MEMBER'
         ) effective_member,
         pg_catalog.pg_has_role(
           member.oid,
           granted.oid,
           'USAGE'
         ) effective_usage,
         pg_catalog.pg_has_role(
           member.oid,
           granted.oid,
           'SET'
         ) effective_set
    from managed member
    cross join managed granted
   where member.oid <> granted.oid
   order by member.rolname::text collate "C",
            granted.rolname::text collate "C"
   /* verifier_database_runtime_capability_effective_memberships */`;

const VERIFIER_OBJECTS_SQL = `
  with namespaces as materialized (
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
  authority_objects as (
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
           'd'::"char" default_code,
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
      from namespaces namespace_row
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
      join namespaces namespace_row
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
      join namespaces namespace_row
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
             pg_catalog.pg_get_function_identity_arguments(routine.oid) ||
             ')',
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
      join namespaces namespace_row
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
    from authority_objects object_row
    left join pg_catalog.pg_roles owner_role
      on owner_role.oid = object_row.owner_oid
    left join lateral pg_catalog.aclexplode(
      coalesce(
        object_row.raw_acl,
        pg_catalog.acldefault(
          object_row.default_code,
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
   /* verifier_database_runtime_capability_objects */`;

const VERIFIER_COLUMNS_SQL = `
  with namespaces as materialized (
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
    join namespaces namespace_row
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
   /* verifier_database_runtime_capability_columns */`;

const VERIFIER_DEFAULT_ACLS_SQL = `
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
   /* verifier_database_runtime_capability_default_acls */`;

const VERIFIER_FOUNDATION_AUTHORITY_SQL = `
  with targets as (
    select 'database'::text scope_kind,
           '@database'::text scope_identity,
           database_row.oid scope_oid,
           database_row.datdba owner_oid,
           database_row.datacl raw_acl,
           'd'::"char" default_code
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
        pg_catalog.acldefault(target.default_code, target.owner_oid)
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
   order by target.scope_kind collate "C",
            target.scope_identity collate "C",
            acl_item.ordinality nulls first
   /* verifier_database_runtime_capability_foundation_authority */`;

function validateEffectiveMemberships(rows) {
  const expectedIdentities = new Set(
    EXPECTED_ROLES.flatMap((member) =>
      EXPECTED_ROLES.filter((granted) => granted !== member).map(
        (granted) => `${member}->${granted}`,
      ),
    ),
  );
  if (rows.length !== expectedIdentities.size) {
    fail("effective-membership-cardinality");
  }
  const seen = new Set();
  for (const row of rows) {
    const identity = `${row.member_name}->${row.granted_role_name}`;
    if (!expectedIdentities.has(identity) || seen.has(identity)) {
      fail("effective-membership-identity");
    }
    seen.add(identity);
    const expected =
      row.member_name === "learncoding_migrator" &&
      row.granted_role_name === "learncoding_owner";
    if (
      row.effective_member !== expected ||
      row.effective_usage !== false ||
      row.effective_set !== expected
    ) {
      fail("effective-membership");
    }
  }
  if (seen.size !== expectedIdentities.size) {
    fail("effective-membership-cardinality");
  }
}

function normalizeVerifierObjectKind(row) {
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

function normalizeVerifierCatalog({
  policy,
  postgresDatabase,
  bootstrapUser,
  authenticatedRoles,
  credentialEvidence,
  roleRows,
  settingRows,
  membershipRows,
  effectiveMembershipRows,
  objectRows,
  columnRows,
  defaultAclRows,
}) {
  if (settingRows.length !== 0) fail("role-settings");
  if (
    canonicalDatabaseRuntimeCapabilitiesJson(
      [...authenticatedRoles].toSorted(),
    ) !==
    canonicalDatabaseRuntimeCapabilitiesJson(
      EXPECTED_ROLES.filter((role) => role !== "learncoding_owner"),
    )
  ) {
    fail("authenticated-role-set");
  }
  validateEffectiveMemberships(effectiveMembershipRows);
  const principalEvidence = principalEvidenceRegistry(
    roleRows,
    membershipRows,
    bootstrapUser,
    "principal-identity-evidence",
  );
  const credentialsByRole = validateVerifierCredentialEvidence(
    credentialEvidence,
    {
      policy,
      postgresDatabase,
      bootstrapUser,
      roleRows,
    },
  );
  const namespaceEvidence = createOidNameEvidence();
  const objects = new Map();
  const grants = [];
  const seenObjectRows = new Set();
  const objectAclRowsets = new Map();
  for (const row of objectRows) {
    const rawObjectRow = canonicalDatabaseRuntimeCapabilitiesJson(row);
    if (seenObjectRows.has(rawObjectRow)) {
      fail("duplicate-object-catalog-row");
    }
    seenObjectRows.add(rawObjectRow);
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
    const kind = normalizeVerifierObjectKind(row);
    const object = {
      objectKind: row.object_kind,
      kind,
      identity: row.object_identity,
      schema: row.schema_name,
      name: row.object_name,
      signature: row.signature,
      owner: oidPrincipal(
        principalEvidence,
        row.owner_name,
        row.owner_oid,
        "object-owner-evidence",
      ),
      enumValues: row.enum_values,
    };
    const previous = objects.get(objectKey);
    if (
      previous !== undefined &&
      canonicalDatabaseRuntimeCapabilitiesJson(previous) !==
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
    const rawColumnRow = canonicalDatabaseRuntimeCapabilitiesJson(row);
    if (seenColumnRows.has(rawColumnRow)) {
      fail("duplicate-column-catalog-row");
    }
    seenColumnRows.add(rawColumnRow);
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
          bootstrapUser,
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
        columns: (columnsByTable.get(object.identity) ?? []).toSorted(
          (left, right) =>
            left.ordinal - right.ordinal ||
            codePointCompare(left.identity, right.identity),
        ),
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
    credential:
      credentialsByRole.get(row.role_name)?.credential ?? "unsupported",
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
        bootstrapUser,
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
    const rawDefaultAclRow = canonicalDatabaseRuntimeCapabilitiesJson(row);
    if (seenDefaultAclRows.has(rawDefaultAclRow)) {
      fail("duplicate-default-acl-catalog-row");
    }
    seenDefaultAclRows.add(rawDefaultAclRow);
    const schema = defaultAclSchemaEvidence(
      row,
      "default-acl-namespace",
      namespaceEvidence,
    );
    const creator = symbolicPrincipal(
      principalEvidence,
      row.creator_name,
      row.creator_oid,
      bootstrapUser,
      "default-acl-creator-evidence",
    );
    const physical = {
      identity: "",
      creator,
      schema,
      objectKind: row.object_kind,
    };
    physical.identity = defaultAclRowIdentity(physical);
    const previous = physicalRows.get(row.default_acl_oid);
    if (
      previous !== undefined &&
      canonicalDatabaseRuntimeCapabilitiesJson(previous) !==
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
          bootstrapUser,
          "default-acl-grantor-evidence",
        ),
        grantee: aclGrantee(
          principalEvidence,
          row.grantee_name,
          row.grantee_oid,
          row.grantee_is_public,
          bootstrapUser,
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

function sortedVerifierFoundationCollection(values) {
  return values.toSorted((left, right) =>
    codePointCompare(
      canonicalDatabaseRuntimeCapabilitiesJson(left),
      canonicalDatabaseRuntimeCapabilitiesJson(right),
    ),
  );
}

function normalizeVerifierFoundationRoleTopology({
  postgresDatabase,
  bootstrapUser,
  authenticatedRoles,
  credentialEvidence,
  roleRows,
  settingRows,
  membershipRows,
  effectiveMembershipRows,
}) {
  if (settingRows.length !== 0) fail("foundation-role-settings");
  if (
    canonicalDatabaseRuntimeCapabilitiesJson(
      [...authenticatedRoles].toSorted(),
    ) !==
    canonicalDatabaseRuntimeCapabilitiesJson(
      EXPECTED_ROLES.filter((role) => role !== "learncoding_owner"),
    )
  ) {
    fail("foundation-authenticated-role-set");
  }
  validateEffectiveMemberships(effectiveMembershipRows);
  const principalEvidence = principalEvidenceRegistry(
    roleRows,
    membershipRows,
    bootstrapUser,
    "foundation-principal-identity-evidence",
  );
  const credentialsByRole = validateVerifierCredentialEvidence(
    credentialEvidence,
    {
      policy: CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
      postgresDatabase,
      bootstrapUser,
      roleRows,
    },
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
    credential:
      credentialsByRole.get(row.role_name)?.credential ?? "unsupported",
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
        bootstrapUser,
        "foundation-membership-grantor-evidence",
      ),
      adminOption: row.admin_option,
      inheritOption: row.inherit_option,
      setOption: row.set_option,
    };
  });
  return {
    roles: sortedVerifierFoundationCollection(roles),
    memberships: sortedVerifierFoundationCollection(memberships),
    principalEvidence,
  };
}

function normalizeVerifierFoundationAuthority(
  rows,
  principalEvidence,
  namespaceEvidence,
) {
  const objects = new Map();
  const grants = [];
  const aclRowsets = new Map();
  for (const row of rows) {
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
    const previous = objects.get(row.scope_identity);
    if (
      previous !== undefined &&
      canonicalDatabaseRuntimeCapabilitiesJson(previous) !==
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
    objects: sortedVerifierFoundationCollection([...objects.values()]),
    grants: sortedVerifierFoundationCollection(grants),
  };
}

function normalizeVerifierFoundationDefaultAcls(
  rows,
  bootstrapUser,
  principalEvidence,
  namespaceEvidence,
) {
  const physicalRows = new Map();
  const tuples = [];
  const aclRowsets = new Map();
  for (const row of rows) {
    const schema = defaultAclSchemaEvidence(
      row,
      "foundation-default-acl-namespace",
      namespaceEvidence,
    );
    const creator = symbolicPrincipal(
      principalEvidence,
      row.creator_name,
      row.creator_oid,
      bootstrapUser,
      "foundation-default-acl-creator-evidence",
    );
    const physical = {
      identity: "",
      creator,
      schema,
      objectKind: row.object_kind,
    };
    physical.identity = defaultAclRowIdentity(physical);
    const previous = physicalRows.get(row.default_acl_oid);
    if (
      previous !== undefined &&
      canonicalDatabaseRuntimeCapabilitiesJson(previous) !==
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
          bootstrapUser,
          "foundation-default-acl-grantor-evidence",
        ),
        grantee: aclGrantee(
          principalEvidence,
          row.grantee_name,
          row.grantee_oid,
          row.grantee_is_public,
          bootstrapUser,
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
    rows: sortedVerifierFoundationCollection([...physicalRows.values()]),
    tuples: sortedVerifierFoundationCollection(tuples),
  };
}

function expectedVerifierFoundationEnvelope(schemaNames) {
  const policy = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
  const owner = "learncoding_owner";
  const loginRoles = EXPECTED_ROLES.filter((role) => role !== owner);
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
  const defaultAclRows = policy.defaultAclRows.filter(
    (entry) =>
      entry.schema === null &&
      ["routine", "type"].includes(entry.objectKind) &&
      (entry.creator === owner ||
        entry.creator?.kind === BOOTSTRAP_SESSION_AUTHORITY.kind),
  );
  const defaultAcls = policy.defaultAcls.filter(
    (entry) =>
      entry.schema === null &&
      ["routine", "type"].includes(entry.objectKind) &&
      (entry.creator === owner ||
        entry.creator?.kind === BOOTSTRAP_SESSION_AUTHORITY.kind),
  );
  return {
    roles: sortedVerifierFoundationCollection(policy.roles),
    memberships: sortedVerifierFoundationCollection(policy.memberships),
    authority: {
      objects: sortedVerifierFoundationCollection(objects),
      grants: sortedVerifierFoundationCollection(grants),
    },
    defaultAcls: {
      rows: sortedVerifierFoundationCollection(defaultAclRows),
      tuples: sortedVerifierFoundationCollection(defaultAcls),
    },
  };
}

function validateVerifierBootstrapUser(value) {
  if (
    typeof value !== "string" ||
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(value) ||
    value.startsWith("learncoding_")
  ) {
    fail("bootstrap-user");
  }
  return value;
}

export async function observeVerifierDatabaseRuntimeCredentialEvidence(
  client,
  {
    postgresDatabase,
    postgresUser,
    policy = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
  },
) {
  postgresUser = validateVerifierBootstrapUser(postgresUser);
  const context = exactOne(
    await client.query(VERIFIER_CREDENTIAL_CONTEXT_SQL),
    "credential-evidence-context",
  );
  const major = Math.trunc(context.server_version_num / 10_000);
  if (
    ![17, 18].includes(major) ||
    context.database_name !== postgresDatabase ||
    context.session_user_name !== postgresUser ||
    context.current_user_name !== postgresUser ||
    context.current_user_superuser !== true
  ) {
    fail("credential-evidence-context");
  }
  const result = await client.query(VERIFIER_CREDENTIAL_ROLES_SQL, [
    EXPECTED_ROLES,
  ]);
  if (!Array.isArray(result?.rows)) {
    fail("credential-evidence-query");
  }
  const rowsByName = new Map();
  const rowsByOid = new Map();
  for (const row of result.rows) {
    assertExactObjectKeys(
      row,
      [
        "role_oid",
        "role_name",
        "can_login",
        "password_is_null",
        "password_is_scram",
      ],
      "credential-evidence-query-row",
    );
    const oid = canonicalOid(row.role_oid);
    const expected = policy.roles.find((role) => role.name === row.role_name);
    const expectedNone = expected?.credential === "none";
    const expectedScram = expected?.credential === "scram-managed";
    if (
      oid === null ||
      expected === undefined ||
      typeof row.can_login !== "boolean" ||
      typeof row.password_is_null !== "boolean" ||
      typeof row.password_is_scram !== "boolean" ||
      row.can_login !== expected.login ||
      row.password_is_null !== expectedNone ||
      row.password_is_scram !== expectedScram ||
      expectedNone === expectedScram ||
      rowsByName.has(row.role_name) ||
      rowsByOid.has(oid)
    ) {
      fail("credential-evidence-query-row");
    }
    rowsByName.set(row.role_name, {
      roleOid: oid,
      roleName: row.role_name,
      credential: expected.credential,
    });
    rowsByOid.set(oid, row.role_name);
  }
  if (
    rowsByName.size !== policy.roles.length ||
    policy.roles.some((role) => !rowsByName.has(role.name))
  ) {
    fail("credential-evidence-cardinality");
  }
  const evidence = {
    postgresDatabase,
    postgresUser,
    roles: policy.roles.map((role) =>
      Object.freeze({ ...rowsByName.get(role.name) }),
    ),
  };
  Object.freeze(evidence.roles);
  Object.freeze(evidence);
  validateVerifierCredentialEvidence(evidence, {
    policy,
    postgresDatabase,
    bootstrapUser: postgresUser,
  });
  return evidence;
}

export async function verifyVerifierDatabaseRuntimeCapabilityFoundation(
  client,
  {
    postgresDatabase,
    bootstrapUser,
    authenticatedRoles,
    credentialEvidence,
    resolution,
  },
) {
  bootstrapUser = validateVerifierBootstrapUser(bootstrapUser);
  if (
    resolution?.phase !== DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION ||
    resolution.policy !== null ||
    resolution.reconcileApplicationAcls !== false
  ) {
    fail("unsupported-foundation-verification-phase");
  }
  const context = exactOne(
    await client.query(VERIFIER_CONTEXT_SQL),
    "foundation-context",
  );
  const major = Math.trunc(context.server_version_num / 10_000);
  if (
    ![17, 18].includes(major) ||
    context.database_name !== postgresDatabase ||
    context.session_user_name !== "learncoding_migrator" ||
    context.current_user_name !== "learncoding_owner"
  ) {
    fail("foundation-context");
  }
  const parameters = [EXPECTED_ROLES];
  const [
    roles,
    settings,
    memberships,
    effectiveMemberships,
    authority,
    defaultAcls,
  ] = await Promise.all([
    client.query(VERIFIER_ROLES_SQL, parameters),
    client.query(VERIFIER_SETTINGS_SQL, parameters),
    client.query(VERIFIER_MEMBERSHIPS_SQL, parameters),
    client.query(VERIFIER_EFFECTIVE_MEMBERSHIPS_SQL, parameters),
    client.query(VERIFIER_FOUNDATION_AUTHORITY_SQL),
    client.query(VERIFIER_DEFAULT_ACLS_SQL),
  ]);
  const topology = normalizeVerifierFoundationRoleTopology({
    postgresDatabase,
    bootstrapUser,
    authenticatedRoles: new Set(authenticatedRoles),
    credentialEvidence,
    roleRows: roles.rows,
    settingRows: settings.rows,
    membershipRows: memberships.rows,
    effectiveMembershipRows: effectiveMemberships.rows,
  });
  const namespaceEvidence = createOidNameEvidence();
  const observedAuthority = normalizeVerifierFoundationAuthority(
    authority.rows,
    topology.principalEvidence,
    namespaceEvidence,
  );
  const observedDefaultAcls = normalizeVerifierFoundationDefaultAcls(
    defaultAcls.rows,
    bootstrapUser,
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
  const observed = {
    roles: topology.roles,
    memberships: topology.memberships,
    authority: observedAuthority,
    defaultAcls: observedDefaultAcls,
  };
  const expected = expectedVerifierFoundationEnvelope(schemaNames);
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

export async function observeVerifierDatabaseRuntimeCapabilityCatalog(
  client,
  {
    postgresDatabase,
    bootstrapUser,
    authenticatedRoles,
    credentialEvidence,
    policy,
  },
) {
  bootstrapUser = validateVerifierBootstrapUser(bootstrapUser);
  const context = exactOne(
    await client.query(VERIFIER_CONTEXT_SQL),
    "catalog-context",
  );
  const major = Math.trunc(context.server_version_num / 10_000);
  if (
    ![17, 18].includes(major) ||
    context.database_name !== postgresDatabase ||
    context.session_user_name !== "learncoding_migrator" ||
    context.current_user_name !== "learncoding_owner" ||
    !/^[a-z_][a-z0-9_]{0,62}$/u.test(bootstrapUser ?? "")
  ) {
    fail("catalog-context");
  }
  const parameters = [EXPECTED_ROLES];
  const [
    roles,
    settings,
    memberships,
    effectiveMemberships,
    objects,
    columns,
    defaultAcls,
  ] = await Promise.all([
    client.query(VERIFIER_ROLES_SQL, parameters),
    client.query(VERIFIER_SETTINGS_SQL, parameters),
    client.query(VERIFIER_MEMBERSHIPS_SQL, parameters),
    client.query(VERIFIER_EFFECTIVE_MEMBERSHIPS_SQL, parameters),
    client.query(VERIFIER_OBJECTS_SQL),
    client.query(VERIFIER_COLUMNS_SQL),
    client.query(VERIFIER_DEFAULT_ACLS_SQL),
  ]);
  return normalizeVerifierCatalog({
    policy,
    postgresDatabase,
    bootstrapUser,
    authenticatedRoles: new Set(authenticatedRoles),
    credentialEvidence,
    roleRows: roles.rows,
    settingRows: settings.rows,
    membershipRows: memberships.rows,
    effectiveMembershipRows: effectiveMemberships.rows,
    objectRows: objects.rows,
    columnRows: columns.rows,
    defaultAclRows: defaultAcls.rows,
  });
}

export async function verifyDatabaseRuntimeCapabilityCatalog(
  client,
  {
    postgresDatabase,
    bootstrapUser,
    authenticatedRoles,
    credentialEvidence,
    resolution,
  },
) {
  if (resolution?.phase === DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION) {
    return verifyVerifierDatabaseRuntimeCapabilityFoundation(client, {
      postgresDatabase,
      bootstrapUser,
      authenticatedRoles,
      credentialEvidence,
      resolution,
    });
  }
  if (
    resolution.phase !== DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069 ||
    resolution.reconcileApplicationAcls !== true ||
    resolution.policy === null
  ) {
    fail("unsupported-verification-phase");
  }
  const catalog = await observeVerifierDatabaseRuntimeCapabilityCatalog(
    client,
    {
      postgresDatabase,
      bootstrapUser,
      authenticatedRoles,
      credentialEvidence,
      policy: resolution.policy,
    },
  );
  let plan;
  try {
    plan = planDatabaseRuntimeCapabilityReconciliation({
      phase: resolution.phase,
      policy: resolution.policy,
      catalog,
    });
  } catch {
    fail("catalog-drift");
  }
  if (plan.blocked || plan.mutations.length !== 0) {
    fail("catalog-drift");
  }
  return {
    phase: resolution.phase,
    policyFingerprint: plan.policyFingerprint,
  };
}
