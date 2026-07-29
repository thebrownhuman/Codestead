import { CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES } from "../database-runtime-capabilities.mjs";

export const CAPABILITY_TEST_BOOTSTRAP_USER = "legacy_bootstrap";
export const CAPABILITY_TEST_DATABASE = "learncoding";
export const CAPABILITY_TEST_AUTHENTICATED_ROLES = Object.freeze([
  "learncoding_app",
  "learncoding_migrator",
  "learncoding_worker",
  "learncoding_ops",
  "learncoding_backup_reporter",
]);

const POLICY = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
const ROLE_OIDS = new Map([
  [CAPABILITY_TEST_BOOTSTRAP_USER, "1"],
  ...POLICY.roles.map((role, index) => [role.name, String(index + 10)]),
]);

function principalName(value) {
  return value?.kind === "bootstrap-session"
    ? CAPABILITY_TEST_BOOTSTRAP_USER
    : value;
}

function principalOid(value) {
  return ROLE_OIDS.get(principalName(value)) ?? "9999";
}

function authorityObjects() {
  return [
    ...POLICY.inventory.databases.map((entry) => ({
      ...entry,
      objectKind: "database",
      schema: null,
      name: CAPABILITY_TEST_DATABASE,
      signature: null,
      nativeKind: "d",
    })),
    ...POLICY.inventory.schemas.map((entry) => ({
      ...entry,
      objectKind: "schema",
      schema: null,
      signature: null,
      nativeKind: "n",
    })),
    ...POLICY.inventory.tables.map((entry) => ({
      ...entry,
      objectKind: "table",
      signature: null,
      nativeKind: "r",
    })),
    ...POLICY.inventory.sequences.map((entry) => ({
      ...entry,
      objectKind: "sequence",
      signature: null,
      nativeKind: "S",
    })),
    ...POLICY.inventory.types.map((entry) => ({
      ...entry,
      objectKind: "type",
      signature: null,
      nativeKind: entry.kind === "enum" ? "e" : "c",
    })),
    ...POLICY.inventory.routines.map((entry) => ({
      ...entry,
      objectKind: "routine",
      name: entry.signature.slice(0, entry.signature.indexOf("(")),
      nativeKind: "f",
    })),
  ];
}

function sourceCatalogForObjectKind(objectKind) {
  return {
    database: "pg_database",
    schema: "pg_namespace",
    table: "pg_class",
    sequence: "pg_class",
    type: "pg_type",
    routine: "pg_proc",
  }[objectKind];
}

export function cloneDatabaseRuntimeCapabilityFixture(value) {
  return JSON.parse(JSON.stringify(value));
}

export function makeDatabaseRuntimeCapabilityCatalogFixture() {
  const objectRows = authorityObjects().flatMap((object, index) => {
    const grants = POLICY.grants.filter(
      (grant) =>
        grant.objectKind === object.objectKind &&
        grant.object === object.identity,
    );
    if (grants.length === 0) {
      throw new Error(`missing capability fixture grant: ${object.identity}`);
    }
    return grants.map((grant, ordinal) => ({
      source_catalog: sourceCatalogForObjectKind(object.objectKind),
      object_kind: object.objectKind,
      object_identity: object.identity,
      schema_name: object.schema,
      object_name: object.name,
      signature: object.signature,
      native_kind: object.nativeKind,
      object_oid: String(1_000 + index),
      owner_oid: ROLE_OIDS.get(object.owner),
      owner_name: object.owner,
      enum_values: object.values ?? null,
      acl_ordinal: ordinal + 1,
      grantor_oid: principalOid(grant.grantor),
      grantor_name: principalName(grant.grantor),
      grantee_oid: principalOid(grant.grantee),
      grantee_name: principalName(grant.grantee),
      grantee_is_public: grant.grantee === "PUBLIC",
      privilege_type: grant.privilege,
      is_grantable: grant.grantable,
    }));
  });
  const namespaceOidByName = new Map(
    objectRows
      .filter((row) => row.object_kind === "schema")
      .map((row) => [row.object_identity, row.object_oid]),
  );
  const columnRows = POLICY.inventory.tables.flatMap((table) =>
    table.columns.flatMap((column) => {
      const grants = POLICY.grants.filter(
        (grant) =>
          grant.objectKind === "column" && grant.object === column.identity,
      );
      return (grants.length === 0 ? [null] : grants).map((grant, ordinal) => ({
        relation_kind: "r",
        relation_identity: table.identity,
        relation_max_attnum: table.columns.length,
        physical_ordinal: column.ordinal,
        is_dropped: false,
        column_name: column.name,
        column_identity: column.identity,
        acl_ordinal: grant === null ? null : ordinal + 1,
        grantor_oid: grant === null ? null : principalOid(grant.grantor),
        grantor_name: grant === null ? null : principalName(grant.grantor),
        grantee_oid: grant === null ? null : principalOid(grant.grantee),
        grantee_name: grant === null ? null : principalName(grant.grantee),
        grantee_is_public: grant === null ? null : grant.grantee === "PUBLIC",
        privilege_type: grant?.privilege ?? null,
        is_grantable: grant?.grantable ?? null,
      }));
    }),
  );
  const defaultAclRows = POLICY.defaultAclRows.flatMap((physical, index) => {
    const tuples = POLICY.defaultAcls.filter(
      (entry) =>
        principalName(entry.creator) === principalName(physical.creator) &&
        entry.schema === physical.schema &&
        entry.objectKind === physical.objectKind,
    );
    if (tuples.length === 0) {
      throw new Error(`missing default ACL fixture: ${physical.identity}`);
    }
    return tuples.map((entry, ordinal) => ({
      default_acl_oid: String(5_000 + index),
      creator_oid: principalOid(entry.creator),
      creator_name: principalName(entry.creator),
      namespace_oid:
        entry.schema === null
          ? "0"
          : namespaceOidByName.get(entry.schema),
      schema_name: entry.schema,
      object_type_code: {
        table: "r",
        sequence: "S",
        routine: "f",
        type: "T",
      }[entry.objectKind],
      object_kind: entry.objectKind,
      acl_ordinal: ordinal + 1,
      grantor_oid: principalOid(entry.grantor),
      grantor_name: principalName(entry.grantor),
      grantee_oid: principalOid(entry.grantee),
      grantee_name: principalName(entry.grantee),
      grantee_is_public: entry.grantee === "PUBLIC",
      privilege_type: entry.privilege,
      is_grantable: entry.grantable,
    }));
  });
  const roleRows = POLICY.roles.map((role) => ({
    role_oid: ROLE_OIDS.get(role.name),
    role_name: role.name,
    can_login: role.login,
    superuser: role.superuser,
    create_database: role.createDatabase,
    create_role: role.createRole,
    inherit: role.inherit,
    replication: role.replication,
    bypass_rls: role.bypassRls,
    connection_limit: role.connectionLimit,
    valid_until_is_null: true,
    valid_until_raw: null,
  }));
  const membershipRows = POLICY.memberships.map((membership, index) => ({
    membership_oid: String(7_000 + index),
    granted_role_oid: principalOid(membership.role),
    granted_role_name: membership.role,
    member_role_oid: principalOid(membership.member),
    member_role_name: membership.member,
    grantor_oid: principalOid(membership.grantor),
    grantor_name: principalName(membership.grantor),
    admin_option: membership.adminOption,
    inherit_option: membership.inheritOption,
    set_option: membership.setOption,
  }));
  const effectiveMembershipRows = POLICY.roles.flatMap((member) =>
    POLICY.roles
      .filter((granted) => granted.name !== member.name)
      .map((granted) => {
        const expected =
          member.name === "learncoding_migrator" &&
          granted.name === "learncoding_owner";
        return {
          member_name: member.name,
          granted_role_name: granted.name,
          effective_member: expected,
          effective_usage: false,
          effective_set: expected,
        };
      }),
  );
  const credentialRows = POLICY.roles.map((role) => ({
    role_oid: ROLE_OIDS.get(role.name),
    role_name: role.name,
    can_login: role.login,
    password_is_null: role.credential === "none",
    password_is_scram: role.credential === "scram-managed",
  }));
  const foundationSchemaNames = ["drizzle", "public"];
  const owner = "learncoding_owner";
  const foundationAuthorities = [
    {
      scopeKind: "database",
      scopeIdentity: "@database",
      scopeOid: "8100",
      privileges: [
        ...["CONNECT", "CREATE", "TEMPORARY"].map((privilege) => ({
          grantor: owner,
          grantee: owner,
          privilege,
        })),
        ...POLICY.roles
          .filter((role) => role.name !== owner)
          .map((role) => ({
            grantor: owner,
            grantee: role.name,
            privilege: "CONNECT",
          })),
      ],
    },
    ...foundationSchemaNames.map((schema, index) => ({
      scopeKind: "schema",
      scopeIdentity: schema,
      scopeOid: String(8200 + index),
      privileges: ["USAGE", "CREATE"].map((privilege) => ({
        grantor: owner,
        grantee: owner,
        privilege,
      })),
    })),
  ];
  const foundationAuthorityRows = foundationAuthorities.flatMap((authority) =>
    authority.privileges.map((grant, index) => ({
      scope_kind: authority.scopeKind,
      scope_identity: authority.scopeIdentity,
      scope_oid: authority.scopeOid,
      owner_oid: ROLE_OIDS.get(owner),
      owner_name: owner,
      acl_ordinal: index + 1,
      grantor_oid: ROLE_OIDS.get(grant.grantor),
      grantor_name: grant.grantor,
      grantee_oid: ROLE_OIDS.get(grant.grantee),
      grantee_name: grant.grantee,
      grantee_is_public: false,
      privilege_type: grant.privilege,
      is_grantable: false,
    })),
  );
  return {
    objectRows,
    columnRows,
    defaultAclRows,
    foundationDefaultAclRows: defaultAclRows.filter(
      (row) => row.schema_name === null,
    ),
    foundationAuthorityRows,
    credentialRows,
    roleRows,
    membershipRows,
    effectiveMembershipRows,
  };
}

export function databaseRuntimeCapabilityCatalogQueryResult(
  normalizedSql,
  fixture,
) {
  if (
    normalizedSql.includes(
      "verifier_database_runtime_credential_evidence_context",
    )
  ) {
    return {
      rows: [
        {
          server_version_num: 170_000,
          database_name: CAPABILITY_TEST_DATABASE,
          session_user_name: CAPABILITY_TEST_BOOTSTRAP_USER,
          current_user_name: CAPABILITY_TEST_BOOTSTRAP_USER,
          current_user_superuser: true,
        },
      ],
    };
  }
  if (
    normalizedSql.includes(
      "verifier_database_runtime_credential_evidence_roles",
    )
  ) {
    return { rows: fixture.credentialRows };
  }
  if (normalizedSql.includes("verifier_database_runtime_capability_context")) {
    return {
      rows: [
        {
          server_version_num: 170_000,
          database_name: CAPABILITY_TEST_DATABASE,
          session_user_name: "learncoding_migrator",
          current_user_name: "learncoding_owner",
        },
      ],
    };
  }
  if (normalizedSql.includes("verifier_database_runtime_capability_roles")) {
    return { rows: fixture.roleRows };
  }
  if (
    normalizedSql.includes("verifier_database_runtime_capability_role_settings")
  ) {
    return { rows: [] };
  }
  if (
    normalizedSql.includes(
      "verifier_database_runtime_capability_effective_memberships",
    )
  ) {
    return { rows: fixture.effectiveMembershipRows };
  }
  if (
    normalizedSql.includes("verifier_database_runtime_capability_memberships")
  ) {
    return { rows: fixture.membershipRows };
  }
  if (normalizedSql.includes("verifier_database_runtime_capability_objects")) {
    return { rows: fixture.objectRows };
  }
  if (normalizedSql.includes("verifier_database_runtime_capability_columns")) {
    return { rows: fixture.columnRows };
  }
  if (
    normalizedSql.includes("verifier_database_runtime_capability_default_acls")
  ) {
    return {
      rows:
        fixture.foundationMode === true
          ? fixture.foundationDefaultAclRows
          : fixture.defaultAclRows,
    };
  }
  if (
    normalizedSql.includes(
      "verifier_database_runtime_capability_foundation_authority",
    )
  ) {
    return { rows: fixture.foundationAuthorityRows };
  }
  return undefined;
}
