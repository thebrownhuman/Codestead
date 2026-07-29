import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
  DATABASE_RUNTIME_CAPABILITY_PHASES,
} from "./database-runtime-capabilities.mjs";
import {
  VerifierDatabaseRuntimeCapabilityError,
  assertSameVerifierDatabaseRuntimeCapabilityPhase,
  assertVerifierDatabaseRuntimeCapabilityPhaseRequest,
  observeVerifierDatabaseRuntimeCredentialEvidence,
  observeVerifierDatabaseRuntimeCapabilityCatalog,
  resolveVerifierDatabaseRuntimeCapabilityPhase,
  verifyDatabaseRuntimeCapabilityCatalog,
} from "./verify-database-runtime-capabilities.mjs";
import {
  REVIEWED_MIGRATION_LEDGER,
  REVIEWED_MIGRATION_LEDGER_SHA256,
} from "./lib/reviewed-migration-ledger.mjs";

const POLICY = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
const CURRENT_POLICY_FINGERPRINT =
  "fa4f5ef2b8f0c1e00f7118b4ea48f3b5c006be6eda0b81c1f498051f324ef86a";
const BOOTSTRAP_USER = "legacy_bootstrap";
const DATABASE = "learncoding";
const AUTHENTICATED_ROLES = Object.freeze([
  "learncoding_app",
  "learncoding_migrator",
  "learncoding_worker",
  "learncoding_ops",
  "learncoding_backup_reporter",
]);
const ROLE_OIDS = new Map([
  [BOOTSTRAP_USER, "1"],
  ...POLICY.roles.map((role, index) => [role.name, String(index + 10)]),
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function principalName(value) {
  return value?.kind === "bootstrap-session" ? BOOTSTRAP_USER : value;
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
      name: DATABASE,
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

function makeFixture() {
  const objectRows = authorityObjects().flatMap((object, index) => {
    const grants = POLICY.grants.filter(
      (grant) =>
        grant.objectKind === object.objectKind &&
        grant.object === object.identity,
    );
    assert.ok(grants.length > 0, object.identity);
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
    assert.ok(tuples.length > 0, physical.identity);
    return tuples.map((entry, ordinal) => ({
      default_acl_oid: String(5_000 + index),
      creator_oid: principalOid(entry.creator),
      creator_name: principalName(entry.creator),
      namespace_oid:
        entry.schema === null ? "0" : namespaceOidByName.get(entry.schema),
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
  return {
    objectRows,
    columnRows,
    defaultAclRows,
    roleRows,
    membershipRows,
    effectiveMembershipRows,
  };
}

function credentialRows() {
  return POLICY.roles.map((role) => ({
    role_oid: ROLE_OIDS.get(role.name),
    role_name: role.name,
    can_login: role.login,
    password_is_null: role.credential === "none",
    password_is_scram: role.credential === "scram-managed",
  }));
}

function exactCredentialEvidence() {
  return Object.freeze({
    postgresDatabase: DATABASE,
    postgresUser: BOOTSTRAP_USER,
    roles: Object.freeze(
      POLICY.roles.map((role) =>
        Object.freeze({
          roleOid: ROLE_OIDS.get(role.name),
          roleName: role.name,
          credential: role.credential,
        }),
      ),
    ),
  });
}

function makeCredentialClient(
  rows = credentialRows(),
  context = {
    server_version_num: 170_000,
    database_name: DATABASE,
    session_user_name: BOOTSTRAP_USER,
    current_user_name: BOOTSTRAP_USER,
    current_user_superuser: true,
  },
) {
  const queries = [];
  return {
    queries,
    async query(sql, values) {
      const normalized = String(sql).replace(/\s+/gu, " ").trim().toLowerCase();
      queries.push(normalized);
      if (
        normalized.includes(
          "verifier_database_runtime_credential_evidence_context",
        )
      ) {
        return {
          rows: [context],
        };
      }
      if (
        normalized.includes(
          "verifier_database_runtime_credential_evidence_roles",
        )
      ) {
        assertManagedRoleDiscovery(normalized, values);
        assert.match(normalized, /from pg_catalog\.pg_authid/u);
        assert.match(normalized, /rolpassword is null password_is_null/u);
        assert.match(
          normalized,
          /rolpassword like 'scram-sha-256\$%'[\s\S]*password_is_scram/u,
        );
        assert.doesNotMatch(
          normalized,
          /rolpassword(?:\s+as)?\s+role_password/u,
        );
        return { rows };
      }
      throw new Error(`unexpected credential query: ${normalized}`);
    },
  };
}

function makeFoundationFixture({ includeDrizzle = true } = {}) {
  const base = makeFixture();
  const schemas = includeDrizzle ? ["drizzle", "public"] : ["public"];
  const owner = "learncoding_owner";
  const loginRoles = POLICY.roles
    .filter((role) => role.name !== owner)
    .map((role) => role.name);
  const authorities = [
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
        ...loginRoles.map((grantee) => ({
          grantor: owner,
          grantee,
          privilege: "CONNECT",
        })),
      ],
    },
    ...schemas.map((schema, index) => ({
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
  const foundationAuthorityRows = authorities.flatMap((authority) =>
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
    ...base,
    foundationAuthorityRows,
    defaultAclRows: base.defaultAclRows.filter(
      (row) => row.schema_name === null,
    ),
  };
}

function assertManagedRoleDiscovery(normalized, values) {
  assert.deepEqual(values, [POLICY.roles.map((role) => role.name)]);
  assert.match(normalized, /rolname::text = any\(\$1::text\[\]\)/u);
  assert.match(
    normalized,
    /starts_with\(\s*[^)]*rolname::text,\s*'learncoding_'\s*\)/u,
  );
}

function assertAllUserNamespaceDiscovery(normalized) {
  assert.match(normalized, /from pg_catalog\.pg_namespace/u);
  for (const name of ["'pg_catalog'", "'information_schema'", "'pg_toast'"]) {
    assert.match(normalized, new RegExp(name, "u"));
  }
  assert.match(normalized, /not like 'pg_temp_%'/u);
  assert.match(normalized, /not like 'pg_toast_temp_%'/u);
  assert.doesNotMatch(normalized, /nspname\s+in\s+\('public', 'drizzle'\)/u);
}

function assertAclEvidence(normalized) {
  assert.match(normalized, /with ordinality acl_item/u);
  assert.match(normalized, /acl_item\.grantor::text grantor_oid/u);
  assert.match(normalized, /acl_item\.grantee = 0 grantee_is_public/u);
  assert.match(normalized, /acl_item\.privilege_type/u);
  assert.match(normalized, /acl_item\.is_grantable/u);
  assert.match(normalized, /acl_item\.ordinality::integer acl_ordinal/u);
}

function makeClient(fixture = makeFixture(), options = {}) {
  const queries = [];
  let journalPresent = options.journalPresent ?? true;
  let appliedCount =
    options.appliedCount ??
    (journalPresent ? REVIEWED_MIGRATION_LEDGER.length : 0);
  return {
    fixture,
    queries,
    setLedger(present, count) {
      journalPresent = present;
      appliedCount = count;
    },
    async query(sql, values) {
      const normalized = String(sql).replace(/\s+/gu, " ").trim().toLowerCase();
      queries.push(normalized);
      if (
        normalized.includes("verifier_capability_migration_journal_present")
      ) {
        return {
          rows: [
            {
              verifier_capability_migration_journal_present: journalPresent,
            },
          ],
        };
      }
      if (normalized.includes("reviewed_migration_journal_present")) {
        return {
          rows: [
            {
              reviewed_migration_journal_present: journalPresent,
            },
          ],
        };
      }
      if (normalized.includes("reviewed_full_migration_journal_rows")) {
        return {
          rows: REVIEWED_MIGRATION_LEDGER.slice(0, appliedCount).map(
            (entry, index) => ({
              id: String(index + 1),
              hash: entry.sqlSha256,
              created_at: String(entry.when),
            }),
          ),
        };
      }
      if (normalized.includes("verifier_database_runtime_capability_context")) {
        return {
          rows: [
            {
              server_version_num: 170_000,
              database_name: DATABASE,
              session_user_name: "learncoding_migrator",
              current_user_name: "learncoding_owner",
            },
          ],
        };
      }
      if (normalized.includes("verifier_database_runtime_capability_roles")) {
        assertManagedRoleDiscovery(normalized, values);
        return { rows: fixture.roleRows };
      }
      if (
        normalized.includes(
          "verifier_database_runtime_capability_role_settings",
        )
      ) {
        assertManagedRoleDiscovery(normalized, values);
        return { rows: fixture.roleSettingRows ?? [] };
      }
      if (
        normalized.includes(
          "verifier_database_runtime_capability_effective_memberships",
        )
      ) {
        assertManagedRoleDiscovery(normalized, values);
        assert.match(normalized, /cross join managed granted/u);
        for (const mode of ["member", "usage", "set"]) {
          assert.match(normalized, new RegExp(`'${mode}'`, "u"));
        }
        return { rows: fixture.effectiveMembershipRows };
      }
      if (
        normalized.includes("verifier_database_runtime_capability_memberships")
      ) {
        assertManagedRoleDiscovery(normalized, values);
        assert.match(normalized, /membership\.roleid in/u);
        assert.match(normalized, /membership\.member in/u);
        assert.match(normalized, /membership\.grantor in/u);
        return { rows: fixture.membershipRows };
      }
      if (normalized.includes("verifier_database_runtime_capability_objects")) {
        assert.match(normalized, /object_row\.source_catalog/u);
        assertAllUserNamespaceDiscovery(normalized);
        assertAclEvidence(normalized);
        assert.match(normalized, /aclexplode\( coalesce\(/u);
        assert.match(normalized, /acldefault\(/u);
        return { rows: fixture.objectRows };
      }
      if (normalized.includes("verifier_database_runtime_capability_columns")) {
        assertAllUserNamespaceDiscovery(normalized);
        assertAclEvidence(normalized);
        assert.match(
          normalized,
          /relation\.relnatts::integer relation_max_attnum/u,
        );
        assert.match(normalized, /attribute\.attisdropped is_dropped/u);
        assert.doesNotMatch(normalized, /not attribute\.attisdropped/u);
        assert.match(normalized, /aclexplode\(attribute\.attacl\)/u);
        return { rows: fixture.columnRows };
      }
      if (
        normalized.includes("verifier_database_runtime_capability_default_acls")
      ) {
        assertAclEvidence(normalized);
        assert.match(normalized, /defaclobjtype::text object_type_code/u);
        assert.match(normalized, /from pg_catalog\.pg_default_acl/u);
        assert.doesNotMatch(normalized, /\bwhere\b/u);
        return { rows: fixture.defaultAclRows };
      }
      if (
        normalized.includes(
          "verifier_database_runtime_capability_foundation_authority",
        )
      ) {
        assertAllUserNamespaceDiscovery(normalized);
        assertAclEvidence(normalized);
        return { rows: fixture.foundationAuthorityRows ?? [] };
      }
      throw new Error(`unexpected verifier query: ${normalized}`);
    },
  };
}

function ledgerIdentity(appliedCount) {
  return {
    journalPresent: appliedCount > 0,
    appliedCount,
    reviewedLedgerSha256: REVIEWED_MIGRATION_LEDGER_SHA256,
  };
}

function currentResolution() {
  return {
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy: POLICY,
    reconcileApplicationAcls: true,
    ledgerIdentity: ledgerIdentity(REVIEWED_MIGRATION_LEDGER.length),
  };
}

function foundationResolution(appliedCount = 0) {
  return {
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION,
    policy: null,
    reconcileApplicationAcls: false,
    ledgerIdentity: ledgerIdentity(appliedCount),
  };
}

const verificationInput = Object.freeze({
  postgresDatabase: DATABASE,
  bootstrapUser: BOOTSTRAP_USER,
  authenticatedRoles: AUTHENTICATED_ROLES,
  credentialEvidence: exactCredentialEvidence(),
  resolution: Object.freeze(currentResolution()),
});

test("resolves only exact current or foundation reviewed phases", async () => {
  assert.doesNotThrow(() =>
    assertVerifierDatabaseRuntimeCapabilityPhaseRequest(
      DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    ),
  );
  for (const phase of [
    "unknown",
    DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070,
    DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071,
  ]) {
    assert.throws(
      () => assertVerifierDatabaseRuntimeCapabilityPhaseRequest(phase),
      { name: "DatabaseRuntimeCapabilityPhaseError" },
    );
  }
  const current =
    await resolveVerifierDatabaseRuntimeCapabilityPhase(makeClient());
  assert.equal(current.policy, POLICY);
  assert.deepEqual(
    current.ledgerIdentity,
    ledgerIdentity(REVIEWED_MIGRATION_LEDGER.length),
  );
  assert.equal(Object.isFrozen(current), true);
  assert.equal(Object.isFrozen(current.ledgerIdentity), true);

  const absent = await resolveVerifierDatabaseRuntimeCapabilityPhase(
    makeClient(makeFixture(), {
      journalPresent: false,
      appliedCount: 0,
    }),
  );
  assert.deepEqual(absent, foundationResolution());
  await assert.rejects(
    resolveVerifierDatabaseRuntimeCapabilityPhase(
      makeClient(makeFixture(), {
        journalPresent: true,
        appliedCount: 0,
      }),
    ),
    { name: "DatabaseRuntimeCapabilityPhaseError" },
  );
});

test("phase seals bind policy and exact same-phase ledger identity", async () => {
  const expected = currentResolution();
  assert.doesNotThrow(() =>
    assertSameVerifierDatabaseRuntimeCapabilityPhase(
      expected,
      clone(expected),
      "phase-seal",
    ),
  );
  for (const mutate of [
    (value) => {
      value.phase = DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION;
    },
    (value) => {
      value.reconcileApplicationAcls = false;
    },
    (value) => {
      value.policy.grants[0].privilege =
        value.policy.grants[0].privilege === "CONNECT" ? "CREATE" : "CONNECT";
    },
    (value) => {
      value.ledgerIdentity.appliedCount -= 1;
    },
    (value) => {
      value.ledgerIdentity.journalPresent = false;
    },
    (value) => {
      value.ledgerIdentity.reviewedLedgerSha256 = "0".repeat(64);
    },
    (value) => {
      delete value.ledgerIdentity;
    },
    (value) => {
      value.ledgerIdentity.unreviewed = true;
    },
  ]) {
    const observed = clone(expected);
    mutate(observed);
    assert.throws(
      () =>
        assertSameVerifierDatabaseRuntimeCapabilityPhase(
          expected,
          observed,
          "phase-seal",
        ),
      {
        name: "VerifierDatabaseRuntimeCapabilityError",
        message: /phase-seal/u,
      },
    );
  }

  const client = makeClient(makeFixture(), {
    journalPresent: true,
    appliedCount: 68,
  });
  const phase0067 = await resolveVerifierDatabaseRuntimeCapabilityPhase(client);
  client.setLedger(true, 69);
  const phase0068 = await resolveVerifierDatabaseRuntimeCapabilityPhase(client);
  assert.deepEqual(phase0067, foundationResolution(68));
  assert.deepEqual(phase0068, foundationResolution(69));
  assert.throws(
    () =>
      assertSameVerifierDatabaseRuntimeCapabilityPhase(
        phase0067,
        phase0068,
        "same-phase-ledger-drift",
      ),
    {
      name: "VerifierDatabaseRuntimeCapabilityError",
      message: /same-phase-ledger-drift/u,
    },
  );
});

test("catalog observation rejects reserved bootstrap identities before querying", async () => {
  for (const bootstrapUser of ["learncoding_owner", "learncoding_it"]) {
    const queries = [];
    const client = {
      async query(sql) {
        queries.push(sql);
        throw new Error("query must not execute");
      },
    };
    await assert.rejects(
      observeVerifierDatabaseRuntimeCapabilityCatalog(client, {
        postgresDatabase: DATABASE,
        bootstrapUser,
        authenticatedRoles: AUTHENTICATED_ROLES,
        policy: POLICY,
      }),
      {
        name: "VerifierDatabaseRuntimeCapabilityError",
        message: /bootstrap-user/u,
      },
    );
    assert.deepEqual(queries, []);
  }
});

test("credential evidence is privileged, exact, boolean-only, and redacted", async () => {
  const client = makeCredentialClient();
  const evidence = await observeVerifierDatabaseRuntimeCredentialEvidence(
    client,
    {
      postgresDatabase: DATABASE,
      postgresUser: BOOTSTRAP_USER,
      policy: POLICY,
    },
  );
  assert.deepEqual(evidence, exactCredentialEvidence());
  assert.equal(Object.isFrozen(evidence), true);
  assert.equal(Object.isFrozen(evidence.roles), true);
  assert.equal(evidence.roles.every(Object.isFrozen), true);
  assert.equal(JSON.stringify(evidence).includes("SCRAM-SHA-256$"), false);

  const exactContext = {
    server_version_num: 170_000,
    database_name: DATABASE,
    session_user_name: BOOTSTRAP_USER,
    current_user_name: BOOTSTRAP_USER,
    current_user_superuser: true,
  };
  for (const mutate of [
    (context) => {
      context.current_user_superuser = false;
    },
    (context) => {
      context.session_user_name = "learncoding_migrator";
    },
    (context) => {
      context.server_version_num = 160_000;
    },
  ]) {
    const context = clone(exactContext);
    mutate(context);
    await assert.rejects(
      observeVerifierDatabaseRuntimeCredentialEvidence(
        makeCredentialClient(credentialRows(), context),
        {
          postgresDatabase: DATABASE,
          postgresUser: BOOTSTRAP_USER,
          policy: POLICY,
        },
      ),
      {
        name: "VerifierDatabaseRuntimeCapabilityError",
        message: /credential-evidence-context$/u,
      },
    );
  }

  const canary =
    "SCRAM-SHA-256$4096:credential-canary:credential-canary-verifier";
  const hostileCases = [
    (rows) => {
      rows.find(
        (row) => row.role_name === "learncoding_owner",
      ).password_is_null = false;
    },
    (rows) => {
      const row = rows.find((entry) => entry.role_name === "learncoding_app");
      row.password_is_scram = false;
    },
    (rows) => {
      rows.pop();
    },
    (rows) => {
      rows.push({
        ...rows.at(-1),
        role_oid: "9990",
        role_name: "learncoding_unknown",
      });
    },
    (rows) => {
      rows[1].role_oid = rows[0].role_oid;
    },
    (rows) => {
      rows[1].unreviewed_password_verifier = canary;
    },
  ];
  for (const mutate of hostileCases) {
    const rows = credentialRows();
    mutate(rows);
    let failure;
    try {
      await observeVerifierDatabaseRuntimeCredentialEvidence(
        makeCredentialClient(rows),
        {
          postgresDatabase: DATABASE,
          postgresUser: BOOTSTRAP_USER,
          policy: POLICY,
        },
      );
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof VerifierDatabaseRuntimeCapabilityError);
    assert.equal(String(failure).includes(canary), false);
    assert.equal(JSON.stringify(failure).includes(canary), false);
  }
});

test("independently normalizes and accepts the exact current catalog", async () => {
  const client = makeClient();
  const catalog = await observeVerifierDatabaseRuntimeCapabilityCatalog(
    client,
    {
      postgresDatabase: DATABASE,
      bootstrapUser: BOOTSTRAP_USER,
      authenticatedRoles: AUTHENTICATED_ROLES,
      credentialEvidence: exactCredentialEvidence(),
      policy: POLICY,
    },
  );
  assert.equal(catalog.inventory.tables.length, 128);
  assert.equal(catalog.grants.length, 3_213);
  assert.equal(catalog.defaultAclRows.length, 7);
  assert.equal(catalog.defaultAcls.length, 28);
  const result = await verifyDatabaseRuntimeCapabilityCatalog(
    makeClient(),
    verificationInput,
  );
  assert.equal(result.phase, DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069);
  assert.equal(result.policyFingerprint, CURRENT_POLICY_FINGERPRINT);
});

test("independently verifies the exact foundation envelope with optional drizzle", async () => {
  for (const includeDrizzle of [false, true]) {
    const client = makeClient(makeFoundationFixture({ includeDrizzle }), {
      journalPresent: false,
      appliedCount: 0,
    });
    const result = await verifyDatabaseRuntimeCapabilityCatalog(client, {
      postgresDatabase: DATABASE,
      bootstrapUser: BOOTSTRAP_USER,
      authenticatedRoles: AUTHENTICATED_ROLES,
      credentialEvidence: exactCredentialEvidence(),
      resolution: foundationResolution(),
    });
    assert.deepEqual(result, {
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION,
      policyFingerprint: null,
    });
    assert.equal(
      client.queries.some((query) =>
        query.includes(
          "verifier_database_runtime_capability_foundation_authority",
        ),
      ),
      true,
    );
    assert.equal(
      client.queries.some((query) =>
        query.includes("verifier_database_runtime_capability_objects"),
      ),
      false,
    );
    assert.equal(
      client.queries.some((query) =>
        query.includes("verifier_database_runtime_capability_columns"),
      ),
      false,
    );
  }
  await assert.rejects(
    verifyDatabaseRuntimeCapabilityCatalog(
      makeClient(makeFoundationFixture({ includeDrizzle: false })),
      {
        postgresDatabase: DATABASE,
        bootstrapUser: BOOTSTRAP_USER,
        authenticatedRoles: AUTHENTICATED_ROLES,
        credentialEvidence: exactCredentialEvidence(),
        resolution: foundationResolution(1),
      },
    ),
    {
      name: "VerifierDatabaseRuntimeCapabilityError",
      message: /foundation-schema-inventory/u,
    },
  );
});

test("foundation verification rejects topology, authority, and default ACL drift", async () => {
  const cases = [
    (fixture) => {
      fixture.roleRows[0].superuser = true;
    },
    (fixture) => {
      fixture.roleSettingRows = [
        {
          role_name: "learncoding_app",
          setting_name: "statement_timeout",
          setting_value: "0",
        },
      ];
    },
    (fixture) => {
      fixture.roleRows.push({
        ...clone(fixture.roleRows.at(-1)),
        role_oid: "99992",
        role_name: "learncoding_unknown",
      });
    },
    (fixture) => {
      fixture.membershipRows[0].set_option = false;
    },
    (fixture) => {
      fixture.membershipRows[0].grantor_oid = ROLE_OIDS.get("learncoding_app");
    },
    (fixture) => {
      fixture.effectiveMembershipRows[0].effective_member = true;
    },
    (fixture) => {
      fixture.foundationAuthorityRows[0].owner_name = "learncoding_app";
      fixture.foundationAuthorityRows[0].owner_oid =
        ROLE_OIDS.get("learncoding_app");
    },
    (fixture) => {
      const row = clone(fixture.foundationAuthorityRows[0]);
      row.acl_ordinal =
        Math.max(
          ...fixture.foundationAuthorityRows
            .filter((entry) => entry.scope_oid === row.scope_oid)
            .map((entry) => entry.acl_ordinal),
        ) + 1;
      row.grantee_oid = "0";
      row.grantee_name = "PUBLIC";
      row.grantee_is_public = true;
      fixture.foundationAuthorityRows.push(row);
    },
    (fixture) => {
      fixture.foundationAuthorityRows[0].is_grantable = true;
    },
    (fixture) => {
      const row = clone(
        fixture.foundationAuthorityRows.find(
          (entry) =>
            entry.scope_kind === "database" &&
            entry.grantee_name === "learncoding_worker",
        ),
      );
      row.acl_ordinal =
        Math.max(
          ...fixture.foundationAuthorityRows
            .filter((entry) => entry.scope_oid === row.scope_oid)
            .map((entry) => entry.acl_ordinal),
        ) + 1;
      row.privilege_type = "CREATE";
      fixture.foundationAuthorityRows.push(row);
    },
    (fixture) => {
      const row = fixture.foundationAuthorityRows.find(
        (entry) =>
          entry.scope_kind === "database" &&
          entry.grantee_name === "learncoding_worker",
      );
      row.grantor_oid = ROLE_OIDS.get("learncoding_app");
      row.grantor_name = "learncoding_app";
    },
    (fixture) => {
      const row = clone(fixture.foundationAuthorityRows.at(-1));
      row.scope_kind = "schema";
      row.scope_identity = "unreviewed";
      row.scope_oid = "9998";
      fixture.foundationAuthorityRows.push(row);
    },
    (fixture) => {
      fixture.defaultAclRows[0].creator_name = "learncoding_app";
      fixture.defaultAclRows[0].creator_oid = ROLE_OIDS.get("learncoding_app");
    },
    (fixture) => {
      fixture.defaultAclRows[0].namespace_oid = "8200";
      fixture.defaultAclRows[0].schema_name = "drizzle";
    },
    (fixture) => {
      const row = clone(fixture.defaultAclRows[0]);
      row.default_acl_oid = "99993";
      for (const field of [
        "acl_ordinal",
        "grantor_oid",
        "grantor_name",
        "grantee_oid",
        "grantee_name",
        "grantee_is_public",
        "privilege_type",
        "is_grantable",
      ]) {
        row[field] = null;
      }
      fixture.defaultAclRows.push(row);
    },
    (fixture) => {
      fixture.foundationAuthorityRows[0].acl_ordinal = 99_101;
    },
    (fixture) => {
      const populated = fixture.foundationAuthorityRows[0];
      fixture.foundationAuthorityRows.push({
        ...clone(populated),
        acl_ordinal: null,
        grantor_oid: null,
        grantor_name: null,
        grantee_oid: null,
        grantee_name: null,
        grantee_is_public: null,
        privilege_type: null,
        is_grantable: null,
      });
    },
    (fixture) => {
      fixture.defaultAclRows[0].acl_ordinal = 99_102;
    },
    (fixture) => {
      const populated = fixture.defaultAclRows[0];
      fixture.defaultAclRows.push({
        ...clone(populated),
        acl_ordinal: null,
        grantor_oid: null,
        grantor_name: null,
        grantee_oid: null,
        grantee_name: null,
        grantee_is_public: null,
        privilege_type: null,
        is_grantable: null,
      });
    },
  ];
  for (const mutate of cases) {
    const fixture = makeFoundationFixture();
    mutate(fixture);
    const client = makeClient(fixture);
    await assert.rejects(
      verifyDatabaseRuntimeCapabilityCatalog(client, {
        postgresDatabase: DATABASE,
        bootstrapUser: BOOTSTRAP_USER,
        authenticatedRoles: AUTHENTICATED_ROLES,
        credentialEvidence: exactCredentialEvidence(),
        resolution: foundationResolution(),
      }),
      VerifierDatabaseRuntimeCapabilityError,
    );
    assert.equal(
      client.queries.every(
        (query) => query.startsWith("select ") || query.startsWith("with "),
      ),
      true,
    );
  }
});

test("hostile catalog mutations fail independently and never execute SQL", async () => {
  const mutations = [
    (fixture) => {
      fixture.roleRows.push({
        ...clone(fixture.roleRows.at(-1)),
        role_oid: "9901",
        role_name: "learncoding_unknown",
      });
    },
    (fixture) => {
      const target = fixture.objectRows.find(
        (row) => row.grantee_name === "learncoding_app",
      );
      target.is_grantable = true;
    },
    (fixture) => {
      const target = fixture.objectRows.find(
        (row) => row.grantee_name === "learncoding_app",
      );
      target.grantor_oid = ROLE_OIDS.get("learncoding_app");
      target.grantor_name = "learncoding_app";
    },
    (fixture) => {
      fixture.objectRows[0].owner_oid = ROLE_OIDS.get("learncoding_app");
      fixture.objectRows[0].owner_name = "learncoding_app";
    },
    {
      section: "duplicate-object-catalog-row",
      mutate(fixture) {
        fixture.objectRows.push(clone(fixture.objectRows[0]));
      },
    },
    {
      section: "catalog-drift",
      mutate(fixture) {
        const row = clone(
          fixture.objectRows.find((entry) => entry.object_kind === "schema"),
        );
        assert.ok(row);
        row.object_oid = "9904";
        row.object_identity = "unreviewed";
        row.object_name = "unreviewed";
        fixture.objectRows.push(row);
      },
    },
    {
      section: "catalog-drift",
      mutate(fixture) {
        const row = clone(
          fixture.objectRows.find((entry) => entry.object_kind === "table"),
        );
        assert.ok(row);
        row.object_oid = "9905";
        row.object_identity = "public.unreviewed_runtime_table";
        row.object_name = "unreviewed_runtime_table";
        fixture.objectRows.push(row);
      },
    },
    (fixture) => {
      fixture.columnRows.push({
        ...clone(fixture.columnRows[0]),
        column_identity: `${fixture.columnRows[0].relation_identity}.unknown`,
        column_name: "unknown",
      });
    },
    {
      section: "duplicate-column-catalog-row",
      mutate(fixture) {
        const empty = fixture.columnRows.find(
          (row) => row.privilege_type === null,
        );
        assert.ok(empty);
        fixture.columnRows.push(clone(empty));
      },
    },
    (fixture) => {
      const row = clone(fixture.defaultAclRows[0]);
      row.default_acl_oid = "9906";
      row.creator_oid = "9906";
      row.creator_name = "learncoding_unknown";
      fixture.defaultAclRows.push(row);
    },
    {
      section: "duplicate-default-acl-catalog-row",
      mutate(fixture) {
        fixture.defaultAclRows.push(clone(fixture.defaultAclRows[0]));
      },
    },
    {
      section: "object-acl-rowset",
      mutate(fixture) {
        fixture.objectRows[0].acl_ordinal = 99_101;
      },
    },
    {
      section: "column-acl-rowset",
      mutate(fixture) {
        const populated = fixture.columnRows.find(
          (row) => row.privilege_type !== null,
        );
        assert.ok(populated);
        populated.acl_ordinal = 99_102;
      },
    },
    {
      section: "column-acl-rowset",
      mutate(fixture) {
        const populated = fixture.columnRows.find(
          (row) => row.privilege_type !== null,
        );
        assert.ok(populated);
        fixture.columnRows.push({
          ...clone(populated),
          acl_ordinal: null,
          grantor_oid: null,
          grantor_name: null,
          grantee_oid: null,
          grantee_name: null,
          grantee_is_public: null,
          privilege_type: null,
          is_grantable: null,
        });
      },
    },
    {
      section: "object-acl-rowset",
      mutate(fixture) {
        const populated = fixture.objectRows[0];
        fixture.objectRows.push({
          ...clone(populated),
          acl_ordinal: null,
          grantor_oid: null,
          grantor_name: null,
          grantee_oid: null,
          grantee_name: null,
          grantee_is_public: null,
          privilege_type: null,
          is_grantable: null,
        });
      },
    },
    {
      section: "default-acl-rowset",
      mutate(fixture) {
        fixture.defaultAclRows[0].acl_ordinal = 99_103;
      },
    },
    {
      section: "default-acl-rowset",
      mutate(fixture) {
        const populated = fixture.defaultAclRows[0];
        fixture.defaultAclRows.push({
          ...clone(populated),
          acl_ordinal: null,
          grantor_oid: null,
          grantor_name: null,
          grantee_oid: null,
          grantee_name: null,
          grantee_is_public: null,
          privilege_type: null,
          is_grantable: null,
        });
      },
    },
    (fixture) => {
      fixture.membershipRows[0].admin_option =
        !fixture.membershipRows[0].admin_option;
    },
    (fixture) => {
      fixture.membershipRows[0].inherit_option =
        !fixture.membershipRows[0].inherit_option;
    },
    (fixture) => {
      fixture.effectiveMembershipRows[0].effective_usage =
        !fixture.effectiveMembershipRows[0].effective_usage;
    },
    (fixture) => {
      fixture.effectiveMembershipRows[0].effective_set =
        !fixture.effectiveMembershipRows[0].effective_set;
    },
    (fixture) => {
      const target = fixture.objectRows.find(
        (row) => row.object_kind === "routine",
      );
      target.native_kind = "a";
    },
    (fixture) => {
      fixture.columnRows[0].relation_max_attnum += 1;
    },
    (fixture) => {
      fixture.columnRows[0].is_dropped = true;
    },
    (fixture) => {
      fixture.columnRows[0].physical_ordinal += 1;
    },
    (fixture) => {
      fixture.defaultAclRows[0].namespace_oid = "9999";
      fixture.defaultAclRows[0].schema_name = null;
    },
    (fixture) => {
      fixture.defaultAclRows[0].object_type_code = "S";
    },
  ];
  for (const [mutationIndex, entry] of mutations.entries()) {
    const { mutate, section } =
      typeof entry === "function"
        ? { mutate: entry, section: undefined }
        : entry;
    const fixture = makeFixture();
    mutate(fixture);
    const client = makeClient(fixture);
    await assert.rejects(
      verifyDatabaseRuntimeCapabilityCatalog(client, verificationInput),
      section === undefined
        ? VerifierDatabaseRuntimeCapabilityError
        : {
            name: "VerifierDatabaseRuntimeCapabilityError",
            message: new RegExp(`${section}$`, "u"),
          },
      `hostile catalog mutation ${mutationIndex} must fail closed`,
    );
    assert.equal(
      client.queries.every(
        (query) => query.startsWith("select ") || query.startsWith("with "),
      ),
      true,
    );
  }
});

test("independent verifier rejects contradictory raw OID and ACL envelopes", async () => {
  const cases = [
    {
      label: "grantor OID-only mutation",
      mutate(fixture) {
        const row = fixture.objectRows.find(
          (entry) => entry.grantor_name === "learncoding_owner",
        );
        assert.ok(row);
        row.grantor_oid = ROLE_OIDS.get("learncoding_app");
      },
    },
    {
      label: "grantee OID-only mutation",
      mutate(fixture) {
        const row = fixture.objectRows.find(
          (entry) => entry.grantee_name === "learncoding_app",
        );
        assert.ok(row);
        row.grantee_oid = ROLE_OIDS.get("learncoding_worker");
      },
    },
    {
      label: "creator OID-only mutation",
      mutate(fixture) {
        const oid = fixture.defaultAclRows[0].default_acl_oid;
        for (const row of fixture.defaultAclRows.filter(
          (entry) => entry.default_acl_oid === oid,
        )) {
          row.creator_oid = ROLE_OIDS.get("learncoding_app");
        }
      },
    },
    {
      label: "namespace OID-only mutation",
      mutate(fixture) {
        const row = fixture.defaultAclRows.find(
          (entry) => entry.schema_name === "public",
        );
        assert.ok(row);
        row.namespace_oid = "9997";
      },
    },
    {
      label: "residual empty ACL evidence",
      mutate(fixture) {
        const row = fixture.columnRows.find(
          (entry) => entry.privilege_type === null,
        );
        assert.ok(row);
        row.grantor_oid = ROLE_OIDS.get("learncoding_owner");
      },
    },
    {
      label: "missing ACL discriminator",
      mutate(fixture) {
        const row = fixture.columnRows.find(
          (entry) => entry.privilege_type === null,
        );
        assert.ok(row);
        delete row.privilege_type;
      },
    },
  ];
  for (const { label, mutate } of cases) {
    const fixture = makeFixture();
    mutate(fixture);
    await assert.rejects(
      verifyDatabaseRuntimeCapabilityCatalog(
        makeClient(fixture),
        verificationInput,
      ),
      VerifierDatabaseRuntimeCapabilityError,
      label,
    );
  }
});

test("independent verifier accepts equal OIDs from different PostgreSQL catalogs", async () => {
  const fixture = makeFixture();
  const schemaOid = fixture.objectRows.find(
    (row) => row.object_kind === "schema",
  )?.object_oid;
  const tableIdentity = fixture.objectRows.find(
    (row) => row.object_kind === "table",
  )?.object_identity;
  assert.ok(schemaOid);
  assert.ok(tableIdentity);
  for (const row of fixture.objectRows.filter(
    (entry) => entry.object_identity === tableIdentity,
  )) {
    row.object_oid = schemaOid;
  }
  await verifyDatabaseRuntimeCapabilityCatalog(
    makeClient(fixture),
    verificationInput,
  );
});

test("PUBLIC and membership evidence mutations fail for their exact reason", async () => {
  const aclSurface = [
    {
      rows: "objectRows",
      locate: (row) => row.grantee_name === "learncoding_app",
      granteeSection: "object-acl-grantee",
    },
    {
      rows: "columnRows",
      locate: (row) => row.grantee_name === "learncoding_app",
      granteeSection: "column-acl-grantee",
    },
    {
      rows: "defaultAclRows",
      locate: (row) => row.grantee_name === "learncoding_app",
      granteeSection: "default-acl-grantee-evidence",
    },
  ];
  const cases = [];
  for (const surface of aclSurface) {
    cases.push(
      {
        section: "catalog-drift",
        mutate(fixture) {
          const target = fixture[surface.rows].find(surface.locate);
          assert.ok(target, surface.rows);
          const sameSource =
            surface.rows === "objectRows"
              ? (row) =>
                  row.source_catalog === target.source_catalog &&
                  row.object_oid === target.object_oid
              : surface.rows === "columnRows"
                ? (row) =>
                    row.relation_identity === target.relation_identity &&
                    row.physical_ordinal === target.physical_ordinal
                : (row) => row.default_acl_oid === target.default_acl_oid;
          const nextOrdinal =
            Math.max(
              ...fixture[surface.rows]
                .filter(sameSource)
                .map((row) => row.acl_ordinal),
            ) + 1;
          fixture[surface.rows].push({
            ...clone(target),
            acl_ordinal: nextOrdinal,
            grantee_oid: "0",
            grantee_name: "PUBLIC",
            grantee_is_public: true,
          });
        },
      },
      {
        section: surface.granteeSection,
        mutate(fixture) {
          const target = fixture[surface.rows].find(surface.locate);
          assert.ok(target, surface.rows);
          target.grantee_oid = "9900";
          target.grantee_name = "PUBLIC";
          target.grantee_is_public = false;
        },
      },
    );
  }
  cases.push(
    {
      section: "principal-identity-evidence",
      mutate(fixture) {
        fixture.membershipRows.pop();
      },
    },
    {
      section: "principal-identity-evidence",
      mutate(fixture) {
        fixture.membershipRows[0].grantor_oid =
          ROLE_OIDS.get("learncoding_app");
        fixture.membershipRows[0].grantor_name = "learncoding_app";
      },
    },
    {
      section: "catalog-drift",
      mutate(fixture) {
        fixture.membershipRows[0].set_option =
          !fixture.membershipRows[0].set_option;
      },
    },
    {
      section: "effective-membership-cardinality",
      mutate(fixture) {
        fixture.effectiveMembershipRows.pop();
      },
    },
    {
      section: "effective-membership-identity",
      mutate(fixture) {
        fixture.effectiveMembershipRows[1] = clone(
          fixture.effectiveMembershipRows[0],
        );
      },
    },
    {
      section: "effective-membership",
      mutate(fixture) {
        const target = fixture.effectiveMembershipRows.find(
          (row) =>
            row.member_name !== "learncoding_migrator" ||
            row.granted_role_name !== "learncoding_owner",
        );
        assert.ok(target);
        target.effective_member = true;
      },
    },
  );

  for (const { section, mutate } of cases) {
    const fixture = makeFixture();
    mutate(fixture);
    await assert.rejects(
      verifyDatabaseRuntimeCapabilityCatalog(
        makeClient(fixture),
        verificationInput,
      ),
      {
        name: "VerifierDatabaseRuntimeCapabilityError",
        message: new RegExp(`${section}$`, "u"),
      },
      section,
    );
  }
});

test("catalog observers are independent and use PostgreSQL's exact sequence ACL code", async () => {
  const verifierSource = await readFile(
    new URL("./verify-database-runtime-capabilities.mjs", import.meta.url),
    "utf8",
  );
  const bootstrapSource = await readFile(
    new URL("./bootstrap-database-runtime-capabilities.mjs", import.meta.url),
    "utf8",
  );
  for (const source of [verifierSource, bootstrapSource]) {
    assert.match(source, /from "\.\/database-runtime-capabilities[.]mjs";/u);
    assert.match(
      source,
      /import\s*\{[\s\S]*?\bCURRENT_0069_DATABASE_RUNTIME_CAPABILITIES\b[\s\S]*?\}\s*from "\.\/database-runtime-capabilities[.]mjs";/u,
    );
  }
  assert.doesNotMatch(
    verifierSource,
    /from "\.\/bootstrap-database-runtime-capabilities[.]mjs";/u,
  );
  assert.doesNotMatch(
    bootstrapSource,
    /from "\.\/verify-database-runtime-capabilities[.]mjs";/u,
  );
  assert.match(verifierSource, /verifier_database_runtime_capability_objects/u);
  assert.match(
    verifierSource,
    /verifier_database_runtime_capability_foundation_authority/u,
  );
  assert.doesNotMatch(
    verifierSource,
    /bootstrap_database_runtime_capability_foundation_authority/u,
  );
  assert.doesNotMatch(
    verifierSource,
    /observeBootstrapDatabaseRuntimeCapabilityCatalog/u,
  );
  assert.match(verifierSource, /relation\.relkind = 'S' then 's'::"char"/u);
  assert.match(
    bootstrapSource,
    /bootstrap_database_runtime_capability_objects/u,
  );
  assert.match(
    bootstrapSource,
    /bootstrap_database_runtime_capability_foundation_authority/u,
  );
  assert.doesNotMatch(
    bootstrapSource,
    /verifier_database_runtime_capability_foundation_authority/u,
  );
  assert.doesNotMatch(
    bootstrapSource,
    /verifier_database_runtime_capability_objects/u,
  );
  assert.doesNotMatch(
    `${verifierSource}\n${bootstrapSource}`,
    /acldefault\(\s*'S'/u,
  );
  for (const source of [verifierSource, bootstrapSource]) {
    assert.match(source, /relation\.relnatts::integer relation_max_attnum/u);
    assert.match(source, /attribute\.attisdropped is_dropped/u);
    assert.doesNotMatch(source, /not attribute\.attisdropped/u);
    assert.match(source, /defaclobjtype::text object_type_code/u);
  }
});
