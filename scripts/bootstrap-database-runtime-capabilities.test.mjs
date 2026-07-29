import assert from "node:assert/strict";
import test from "node:test";

import {
  CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
  DATABASE_RUNTIME_CAPABILITY_PHASES,
} from "./database-runtime-capabilities.mjs";
import {
  BootstrapDatabaseRuntimeCapabilityError,
  assertSameBootstrapDatabaseRuntimeCapabilityPhase,
  assertBootstrapDatabaseRuntimeCapabilityPhaseRequest,
  establishBootstrapDatabaseRuntimeCapabilityFoundation,
  observeBootstrapDatabaseRuntimeCapabilityCatalog,
  reconcileBootstrapDatabaseRuntimeCapabilities,
  resolveBootstrapDatabaseRuntimeCapabilityPhase,
  transferBootstrapDatabaseRuntimeCapabilityOwnership,
  verifyBootstrapDatabaseRuntimeCapabilities,
  verifyBootstrapDatabaseRuntimeCapabilityFoundation,
} from "./bootstrap-database-runtime-capabilities.mjs";
import {
  REVIEWED_MIGRATION_LEDGER,
  REVIEWED_MIGRATION_LEDGER_SHA256,
} from "./lib/reviewed-migration-ledger.mjs";

const POLICY = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
const CURRENT_POLICY_FINGERPRINT =
  "fa4f5ef2b8f0c1e00f7118b4ea48f3b5c006be6eda0b81c1f498051f324ef86a";
const POSTGRES_USER = "legacy_bootstrap";
const POSTGRES_DATABASE = "learncoding";
const ROLE_OIDS = new Map([
  [POSTGRES_USER, "1"],
  ...POLICY.roles.map((role, index) => [role.name, String(index + 10)]),
]);
const PG_DATABASE_OWNER_EVIDENCE = Object.freeze({
  role_oid: "6171",
  role_name: "pg_database_owner",
  can_login: false,
  superuser: false,
  create_database: false,
  create_role: false,
  inherit: true,
  replication: false,
  bypass_rls: false,
  connection_limit: -1,
  password_is_null: true,
  valid_until_is_null: true,
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function principalName(value) {
  return value?.kind === "bootstrap-session" ? POSTGRES_USER : value;
}

function principalOid(value) {
  return ROLE_OIDS.get(principalName(value)) ?? "9999";
}

function inventoryObjects(policy) {
  return [
    ...policy.inventory.databases.map((entry) => ({
      ...entry,
      objectKind: "database",
      schema: null,
      name: POSTGRES_DATABASE,
      signature: null,
      nativeKind: "d",
    })),
    ...policy.inventory.schemas.map((entry) => ({
      ...entry,
      objectKind: "schema",
      schema: null,
      signature: null,
      nativeKind: "n",
    })),
    ...policy.inventory.tables.map((entry) => ({
      ...entry,
      objectKind: "table",
      signature: null,
      nativeKind: "r",
    })),
    ...policy.inventory.sequences.map((entry) => ({
      ...entry,
      objectKind: "sequence",
      signature: null,
      nativeKind: "S",
    })),
    ...policy.inventory.types.map((entry) => ({
      ...entry,
      objectKind: "type",
      signature: null,
      nativeKind: entry.kind === "enum" ? "e" : "c",
    })),
    ...policy.inventory.routines.map((entry) => ({
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
  const objectRows = [];
  const objects = inventoryObjects(POLICY);
  for (const [index, object] of objects.entries()) {
    const objectOid = String(1_000 + index);
    const grants = POLICY.grants.filter(
      (grant) =>
        grant.objectKind === object.objectKind &&
        grant.object === object.identity,
    );
    assert.ok(grants.length > 0, object.identity);
    for (const [ordinal, grant] of grants.entries()) {
      objectRows.push({
        source_catalog: sourceCatalogForObjectKind(object.objectKind),
        object_kind: object.objectKind,
        object_identity: object.identity,
        schema_name: object.schema,
        object_name: object.name,
        signature: object.signature,
        native_kind: object.nativeKind,
        object_oid: objectOid,
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
      });
    }
  }

  const namespaceOidByName = new Map(
    objectRows
      .filter((row) => row.object_kind === "schema")
      .map((row) => [row.object_identity, row.object_oid]),
  );
  const columnRows = [];
  for (const table of POLICY.inventory.tables) {
    for (const column of table.columns) {
      const grants = POLICY.grants.filter(
        (grant) =>
          grant.objectKind === "column" && grant.object === column.identity,
      );
      const rows = grants.length === 0 ? [null] : grants;
      for (const [ordinal, grant] of rows.entries()) {
        columnRows.push({
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
        });
      }
    }
  }

  const defaultAclRows = [];
  for (const [rowIndex, physical] of POLICY.defaultAclRows.entries()) {
    const tuples = POLICY.defaultAcls
      .filter(
        (entry) =>
          entry.creator === physical.creator ||
          principalName(entry.creator) === principalName(physical.creator),
      )
      .filter(
        (entry) =>
          entry.schema === physical.schema &&
          entry.objectKind === physical.objectKind,
      );
    assert.ok(tuples.length > 0, physical.identity);
    for (const [ordinal, entry] of tuples.entries()) {
      defaultAclRows.push({
        default_acl_oid: String(5_000 + rowIndex),
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
      });
    }
  }

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
    credential: role.credential,
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
    roleRows,
    membershipRows,
    effectiveMembershipRows,
    objectRows,
    columnRows,
    defaultAclRows,
    predefinedPublicOwnerRows: [clone(PG_DATABASE_OWNER_EVIDENCE)],
    databaseOwnerName: "learncoding_owner",
  };
}

function makeFoundationFixture({ drizzlePresent = true } = {}) {
  const fixture = makeFixture();
  fixture.drizzlePresent = drizzlePresent;
  fixture.defaultAclRows = fixture.defaultAclRows.filter(
    (row) =>
      row.schema_name === null &&
      ["routine", "type"].includes(row.object_kind) &&
      [POSTGRES_USER, "learncoding_owner"].includes(row.creator_name),
  );
  const authority = [];
  const authorityOrdinals = new Map();
  const add = (scopeKind, scopeIdentity, grantee, privilege) => {
    const ordinal = (authorityOrdinals.get(scopeIdentity) ?? 0) + 1;
    authorityOrdinals.set(scopeIdentity, ordinal);
    authority.push({
      scope_kind: scopeKind,
      scope_identity: scopeIdentity,
      scope_oid: fixture.objectRows.find(
        (row) => row.object_identity === scopeIdentity,
      )?.object_oid,
      owner_oid: ROLE_OIDS.get("learncoding_owner"),
      owner_name: "learncoding_owner",
      acl_ordinal: ordinal,
      grantor_oid: ROLE_OIDS.get("learncoding_owner"),
      grantor_name: "learncoding_owner",
      grantee_oid: grantee === "PUBLIC" ? "0" : ROLE_OIDS.get(grantee),
      grantee_name: grantee,
      grantee_is_public: grantee === "PUBLIC",
      privilege_type: privilege,
      is_grantable: false,
    });
  };
  for (const privilege of ["CONNECT", "CREATE", "TEMPORARY"]) {
    add("database", "@database", "learncoding_owner", privilege);
  }
  for (const role of POLICY.roles) {
    if (role.login) add("database", "@database", role.name, "CONNECT");
  }
  for (const schema of ["public", ...(drizzlePresent ? ["drizzle"] : [])]) {
    for (const privilege of ["USAGE", "CREATE"]) {
      add("schema", schema, "learncoding_owner", privilege);
    }
  }
  fixture.foundationAuthorityRows = authority;
  return fixture;
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
  const mutations = [];
  let journalPresent = options.journalPresent ?? true;
  let appliedCount =
    options.appliedCount ??
    (journalPresent ? REVIEWED_MIGRATION_LEDGER.length : 0);
  return {
    fixture,
    queries,
    mutations,
    setLedger(nextPresent, nextAppliedCount) {
      journalPresent = nextPresent;
      appliedCount = nextAppliedCount;
    },
    async query(sql, values) {
      const normalized = String(sql).replace(/\s+/gu, " ").trim().toLowerCase();
      queries.push(normalized);
      if (
        /\bgrant\b.*\bon\s+all\s+(?:tables|sequences|routines)\b/u.test(
          normalized,
        )
      ) {
        throw new Error("blanket runtime grant authority is forbidden");
      }
      if (normalized.includes("capability_migration_journal_present")) {
        return {
          rows: [
            {
              capability_migration_journal_present: journalPresent,
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
      if (
        normalized.includes("bootstrap_database_runtime_capability_context")
      ) {
        return {
          rows: [
            {
              server_version_num: 170_000,
              database_name: POSTGRES_DATABASE,
              database_owner_name:
                fixture.databaseOwnerName ?? "learncoding_owner",
              session_user_name: POSTGRES_USER,
              current_user_name: POSTGRES_USER,
            },
          ],
        };
      }
      if (normalized.includes("bootstrap_database_runtime_capability_roles")) {
        assertManagedRoleDiscovery(normalized, values);
        return { rows: fixture.roleRows };
      }
      if (
        normalized.includes(
          "bootstrap_database_runtime_capability_predefined_public_owner",
        )
      ) {
        return { rows: fixture.predefinedPublicOwnerRows ?? [] };
      }
      if (
        normalized.includes(
          "bootstrap_database_runtime_capability_role_settings",
        )
      ) {
        assertManagedRoleDiscovery(normalized, values);
        return { rows: [] };
      }
      if (
        normalized.includes(
          "bootstrap_database_runtime_capability_effective_memberships",
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
        normalized.includes("bootstrap_database_runtime_capability_memberships")
      ) {
        assertManagedRoleDiscovery(normalized, values);
        assert.match(normalized, /membership\.roleid in/u);
        assert.match(normalized, /membership\.member in/u);
        assert.match(normalized, /membership\.grantor in/u);
        return { rows: fixture.membershipRows };
      }
      if (
        normalized.includes(
          "bootstrap_database_runtime_capability_foundation_authority",
        )
      ) {
        assert.match(normalized, /target\.scope_oid::text scope_oid/u);
        assertAllUserNamespaceDiscovery(normalized);
        assertAclEvidence(normalized);
        return { rows: fixture.foundationAuthorityRows ?? [] };
      }
      if (normalized.includes("foundation_drizzle_schema_present")) {
        return {
          rows: [
            {
              foundation_drizzle_schema_present:
                fixture.drizzlePresent ?? false,
            },
          ],
        };
      }
      if (
        normalized.includes("bootstrap_database_runtime_capability_objects")
      ) {
        assert.match(normalized, /object_row\.source_catalog/u);
        assertAllUserNamespaceDiscovery(normalized);
        assertAclEvidence(normalized);
        assert.match(normalized, /aclexplode\( coalesce\(/u);
        assert.match(normalized, /acldefault\(/u);
        return { rows: fixture.objectRows };
      }
      if (
        normalized.includes("bootstrap_database_runtime_capability_columns")
      ) {
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
        normalized.includes(
          "bootstrap_database_runtime_capability_default_acls",
        )
      ) {
        assertAclEvidence(normalized);
        assert.match(normalized, /defaclobjtype::text object_type_code/u);
        assert.match(normalized, /from pg_catalog\.pg_default_acl/u);
        assert.doesNotMatch(normalized, /\bwhere\b/u);
        return { rows: fixture.defaultAclRows };
      }
      mutations.push(normalized);
      options.applyMutation?.({ fixture, normalized });
      return { rows: [] };
    },
  };
}

function quoteTestIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function makeOwnershipEffectApplier() {
  const ownerName = "learncoding_owner";
  const ownerOid = ROLE_OIDS.get(ownerName);
  const effects = new Map();
  const applied = [];
  const register = (statement, effect) => {
    assert.equal(effects.has(statement), false, statement);
    effects.set(statement, effect);
  };
  const updateObjects = (mutable, predicate, label) => {
    const rows = mutable.objectRows.filter(predicate);
    assert.ok(rows.length > 0, label);
    for (const row of rows) {
      row.owner_name = ownerName;
      row.owner_oid = ownerOid;
    }
  };

  register(
    `alter database ${quoteTestIdentifier(POSTGRES_DATABASE)} owner to ${quoteTestIdentifier(ownerName)}`,
    (mutable) => {
      mutable.databaseOwnerName = ownerName;
      updateObjects(
        mutable,
        (row) =>
          row.object_kind === "database" && row.object_identity === "@database",
        "@database",
      );
    },
  );
  for (const schema of POLICY.inventory.schemas) {
    register(
      `alter schema ${quoteTestIdentifier(schema.name)} owner to ${quoteTestIdentifier(ownerName)}`,
      (mutable) =>
        updateObjects(
          mutable,
          (row) =>
            row.object_kind === "schema" &&
            row.object_identity === schema.identity,
          schema.identity,
        ),
    );
  }
  for (const table of POLICY.inventory.tables) {
    register(
      `alter table ${quoteTestIdentifier(table.schema)}.${quoteTestIdentifier(table.name)} owner to ${quoteTestIdentifier(ownerName)}`,
      (mutable) =>
        updateObjects(
          mutable,
          (row) =>
            row.object_identity === table.identity &&
            (row.object_kind === "table" ||
              (row.object_kind === "type" && row.native_kind === "c")),
          table.identity,
        ),
    );
  }
  for (const sequence of POLICY.inventory.sequences) {
    register(
      `alter sequence ${quoteTestIdentifier(sequence.schema)}.${quoteTestIdentifier(sequence.name)} owner to ${quoteTestIdentifier(ownerName)}`,
      (mutable) =>
        updateObjects(
          mutable,
          (row) =>
            row.object_kind === "sequence" &&
            row.object_identity === sequence.identity,
          sequence.identity,
        ),
    );
  }
  for (const type of POLICY.inventory.types.filter(
    (entry) => entry.kind !== "composite",
  )) {
    register(
      `alter type ${quoteTestIdentifier(type.schema)}.${quoteTestIdentifier(type.name)} owner to ${quoteTestIdentifier(ownerName)}`,
      (mutable) =>
        updateObjects(
          mutable,
          (row) =>
            row.object_kind === "type" && row.object_identity === type.identity,
          type.identity,
        ),
    );
  }
  for (const routine of POLICY.inventory.routines) {
    const open = routine.signature.indexOf("(");
    assert.ok(open > 0, routine.identity);
    register(
      `alter function ${quoteTestIdentifier(routine.schema)}.${quoteTestIdentifier(
        routine.signature.slice(0, open),
      )}${routine.signature.slice(open)} owner to ${quoteTestIdentifier(ownerName)}`,
      (mutable) =>
        updateObjects(
          mutable,
          (row) =>
            row.object_kind === "routine" &&
            row.object_identity === routine.identity,
          routine.identity,
        ),
    );
  }
  assert.equal(effects.size, 221);

  return {
    applyMutation({ fixture: mutable, normalized }) {
      if (!normalized.includes(" owner to ")) return;
      const effect = effects.get(normalized);
      assert.ok(effect, `unexpected ownership statement: ${normalized}`);
      effect(mutable);
      effects.delete(normalized);
      applied.push(normalized);
    },
    assertComplete() {
      assert.equal(effects.size, 0);
      assert.equal(applied.length, 221);
      assert.equal(new Set(applied).size, 221);
    },
  };
}

test("phase authority comes only from an exact sealed reviewed prefix", async () => {
  assert.doesNotThrow(() =>
    assertBootstrapDatabaseRuntimeCapabilityPhaseRequest(
      DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    ),
  );
  for (const phase of [
    "unknown",
    DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070,
    DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071,
  ]) {
    assert.throws(
      () => assertBootstrapDatabaseRuntimeCapabilityPhaseRequest(phase),
      { name: "DatabaseRuntimeCapabilityPhaseError" },
    );
  }

  const current =
    await resolveBootstrapDatabaseRuntimeCapabilityPhase(makeClient());
  assert.equal(current.phase, DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069);
  assert.equal(current.policy, POLICY);
  assert.deepEqual(
    current.ledgerIdentity,
    ledgerIdentity(REVIEWED_MIGRATION_LEDGER.length),
  );
  assert.equal(Object.isFrozen(current), true);
  assert.equal(Object.isFrozen(current.ledgerIdentity), true);

  const foundationClient = makeClient(makeFixture(), {
    journalPresent: false,
    appliedCount: 0,
  });
  const foundation =
    await resolveBootstrapDatabaseRuntimeCapabilityPhase(foundationClient);
  assert.deepEqual(foundation, foundationResolution());
  assert.equal(Object.isFrozen(foundation), true);

  await assert.rejects(
    resolveBootstrapDatabaseRuntimeCapabilityPhase(
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
    assertSameBootstrapDatabaseRuntimeCapabilityPhase(
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
        assertSameBootstrapDatabaseRuntimeCapabilityPhase(
          expected,
          observed,
          "phase-seal",
        ),
      {
        name: "BootstrapDatabaseRuntimeCapabilityError",
        message: /phase-seal/u,
      },
    );
  }

  const client = makeClient(makeFixture(), {
    journalPresent: true,
    appliedCount: 68,
  });
  const phase0067 =
    await resolveBootstrapDatabaseRuntimeCapabilityPhase(client);
  client.setLedger(true, 69);
  const phase0068 =
    await resolveBootstrapDatabaseRuntimeCapabilityPhase(client);
  assert.deepEqual(phase0067, foundationResolution(68));
  assert.deepEqual(phase0068, foundationResolution(69));
  assert.throws(
    () =>
      assertSameBootstrapDatabaseRuntimeCapabilityPhase(
        phase0067,
        phase0068,
        "same-phase-ledger-drift",
      ),
    {
      name: "BootstrapDatabaseRuntimeCapabilityError",
      message: /same-phase-ledger-drift/u,
    },
  );
});

test("catalog observation rejects reserved bootstrap identities before querying", async () => {
  for (const postgresUser of ["learncoding_owner", "learncoding_it"]) {
    const queries = [];
    const client = {
      async query(sql) {
        queries.push(sql);
        throw new Error("query must not execute");
      },
    };
    await assert.rejects(
      observeBootstrapDatabaseRuntimeCapabilityCatalog(client, {
        postgresUser,
        postgresDatabase: POSTGRES_DATABASE,
        policy: POLICY,
      }),
      {
        name: "BootstrapDatabaseRuntimeCapabilityError",
        message: /bootstrap-user/u,
      },
    );
    assert.deepEqual(queries, []);
  }
});

test("normalizes the complete current catalog with exact physical ordinals", async () => {
  const client = makeClient();
  const catalog = await observeBootstrapDatabaseRuntimeCapabilityCatalog(
    client,
    {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
      policy: POLICY,
    },
  );
  assert.equal(catalog.inventory.tables.length, 128);
  assert.equal(
    catalog.inventory.tables.reduce(
      (count, table) => count + table.columns.length,
      0,
    ),
    1_492,
  );
  assert.equal(catalog.grants.length, 3_213);
  assert.equal(catalog.defaultAclRows.length, 7);
  assert.equal(catalog.defaultAcls.length, 28);
  assert.equal(
    catalog.inventory.tables[0].columns[0].ordinal,
    POLICY.inventory.tables[0].columns[0].ordinal,
  );
});

test("reconciliation is zero-mutation for the exact current catalog", async () => {
  const client = makeClient();
  const result = await reconcileBootstrapDatabaseRuntimeCapabilities(client, {
    postgresUser: POSTGRES_USER,
    postgresDatabase: POSTGRES_DATABASE,
    resolution: currentResolution(),
  });
  assert.equal(result.phase, DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069);
  assert.equal(result.policyFingerprint, CURRENT_POLICY_FINGERPRINT);
  assert.equal(result.mutationCount, 0);
  assert.deepEqual(client.mutations, []);
});

test("SQL recorder rejects blanket runtime grant authority", async () => {
  const client = makeClient();
  for (const sql of [
    'grant select on all tables in schema public to "learncoding_app"',
    'grant usage on all sequences in schema public to "learncoding_worker"',
    'grant execute on all routines in schema public to "learncoding_ops"',
  ]) {
    await assert.rejects(
      client.query(sql),
      /blanket runtime grant authority is forbidden/u,
      sql,
    );
  }
  assert.deepEqual(client.mutations, []);
});

test("missing direct grants render exact per-object SQL and converge", async () => {
  const cases = [
    {
      collection: "objectRows",
      locate: (row) =>
        row.object_kind === "database" &&
        row.object_identity === "@database" &&
        row.grantee_name === "learncoding_migrator" &&
        row.privilege_type === "CONNECT",
      statement:
        'grant connect on database "learncoding" to "learncoding_migrator"',
    },
    {
      collection: "objectRows",
      locate: (row) =>
        row.object_kind === "schema" &&
        row.object_identity === "public" &&
        row.grantee_name === "learncoding_app" &&
        row.privilege_type === "USAGE",
      statement: 'grant usage on schema "public" to "learncoding_app"',
    },
    {
      collection: "objectRows",
      locate: (row) =>
        row.object_kind === "table" &&
        row.object_identity === "public.access_request" &&
        row.grantee_name === "learncoding_app" &&
        row.privilege_type === "SELECT",
      statement:
        'grant select on table "public"."access_request" to "learncoding_app"',
    },
    {
      collection: "columnRows",
      locate: (row) =>
        row.column_identity === "public.email_outbox.id" &&
        row.grantee_name === "learncoding_app" &&
        row.privilege_type === "INSERT",
      statement:
        'grant insert ("id") on table "public"."email_outbox" to "learncoding_app"',
    },
    {
      collection: "objectRows",
      locate: (row) =>
        row.object_kind === "sequence" &&
        row.object_identity === "drizzle.__drizzle_migrations_id_seq" &&
        row.grantee_name === "learncoding_owner" &&
        row.privilege_type === "USAGE",
      statement:
        'grant usage on sequence "drizzle"."__drizzle_migrations_id_seq" to "learncoding_owner"',
    },
    {
      collection: "objectRows",
      locate: (row) =>
        row.object_kind === "type" &&
        row.object_identity === "public.access_request" &&
        row.grantee_name === "learncoding_app" &&
        row.privilege_type === "USAGE",
      statement:
        'grant usage on type "public"."access_request" to "learncoding_app"',
    },
    {
      collection: "objectRows",
      locate: (row) =>
        row.object_kind === "routine" &&
        row.object_identity ===
          "public.enqueue_reward_jobs_for_attempt_v1(uuid,text,timestamp with time zone)" &&
        row.grantee_name === "learncoding_app" &&
        row.privilege_type === "EXECUTE",
      statement:
        'grant execute on routine "public"."enqueue_reward_jobs_for_attempt_v1"(uuid,text,timestamp with time zone) to "learncoding_app"',
    },
  ];
  for (const scenario of cases) {
    const fixture = makeFixture();
    const rows = fixture[scenario.collection];
    const index = rows.findIndex(scenario.locate);
    assert.notEqual(index, -1, scenario.statement);
    const removed = clone(rows[index]);
    const sameSource =
      scenario.collection === "objectRows"
        ? (row) =>
            row.source_catalog === removed.source_catalog &&
            row.object_oid === removed.object_oid
        : (row) =>
            row.relation_identity === removed.relation_identity &&
            row.physical_ordinal === removed.physical_ordinal;
    rows.splice(index, 1);
    const reindex = (sourceRows) => {
      const group = sourceRows
        .filter(sameSource)
        .sort((left, right) => left.acl_ordinal - right.acl_ordinal);
      for (const [ordinal, row] of group.entries()) {
        row.acl_ordinal = ordinal + 1;
      }
      return group;
    };
    if (reindex(rows).length === 0) {
      rows.push({
        ...removed,
        acl_ordinal: null,
        grantor_oid: null,
        grantor_name: null,
        grantee_oid: null,
        grantee_name: null,
        grantee_is_public: null,
        privilege_type: null,
        is_grantable: null,
      });
    }
    let applied = 0;
    const client = makeClient(fixture, {
      applyMutation({ fixture: mutable, normalized }) {
        if (normalized === scenario.statement) {
          const mutableRows = mutable[scenario.collection];
          const sentinelIndex = mutableRows.findIndex(
            (row) => sameSource(row) && row.privilege_type === null,
          );
          if (sentinelIndex >= 0) mutableRows.splice(sentinelIndex, 1);
          mutableRows.push(removed);
          reindex(mutableRows);
          applied += 1;
        }
      },
    });
    const result = await reconcileBootstrapDatabaseRuntimeCapabilities(client, {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
      resolution: currentResolution(),
    });
    assert.equal(result.mutationCount, 1, scenario.statement);
    assert.deepEqual(
      client.mutations,
      ['set local role "learncoding_owner"', scenario.statement, "reset role"],
      scenario.statement,
    );
    assert.equal(
      client.mutations.some((sql) => /\bon all\b/u.test(sql)),
      false,
    );
    assert.equal(applied, 1);

    const secondClient = makeClient(fixture);
    const second = await reconcileBootstrapDatabaseRuntimeCapabilities(
      secondClient,
      {
        postgresUser: POSTGRES_USER,
        postgresDatabase: POSTGRES_DATABASE,
        resolution: currentResolution(),
      },
    );
    assert.equal(second.mutationCount, 0);
    assert.deepEqual(secondClient.mutations, []);
  }
});

test("table revoke plus column grant-option correction emits every required regrant and converges", async () => {
  const fixture = makeFixture();
  const tableIdentity = "public.email_outbox";
  const grantee = "learncoding_worker";
  const privilege = "UPDATE";
  const affectedColumns = fixture.columnRows.filter(
    (row) =>
      row.relation_identity === tableIdentity &&
      row.grantee_name === grantee &&
      row.privilege_type === privilege,
  );
  assert.equal(affectedColumns.length, 21);
  const expectedColumnRows = affectedColumns.map((row) => clone(row));
  affectedColumns[0].is_grantable = true;

  const existingTableRows = fixture.objectRows.filter(
    (row) => row.object_identity === tableIdentity,
  );
  assert.ok(existingTableRows.length > 0);
  const tableGrant = {
    ...clone(existingTableRows[0]),
    acl_ordinal:
      Math.max(...existingTableRows.map((row) => row.acl_ordinal)) + 1,
    grantor_oid: ROLE_OIDS.get("learncoding_owner"),
    grantor_name: "learncoding_owner",
    grantee_oid: ROLE_OIDS.get(grantee),
    grantee_name: grantee,
    grantee_is_public: false,
    privilege_type: privilege,
    is_grantable: false,
  };
  fixture.objectRows.push(tableGrant);

  const grantOptionStatement =
    'revoke grant option for update ("status") on table "public"."email_outbox" from "learncoding_worker" cascade';
  const tableRevokeStatement =
    'revoke update on table "public"."email_outbox" from "learncoding_worker" cascade';
  const columnStatements = new Map(
    expectedColumnRows.map((row) => [
      `grant update ("${row.column_name}") on table "public"."email_outbox" to "learncoding_worker"`,
      row,
    ]),
  );
  const expectedColumnStatements = [...columnStatements.keys()].toSorted();
  const appliedStatements = [];
  const withoutAcl = (row) => ({
    ...clone(row),
    acl_ordinal: null,
    grantor_oid: null,
    grantor_name: null,
    grantee_oid: null,
    grantee_name: null,
    grantee_is_public: null,
    privilege_type: null,
    is_grantable: null,
  });
  const removeColumnGrantRows = (mutable) => {
    const removed = mutable.columnRows.filter(
      (row) =>
        row.relation_identity === tableIdentity &&
        row.grantee_name === grantee &&
        row.privilege_type === privilege,
    );
    mutable.columnRows = mutable.columnRows.filter(
      (row) => !removed.includes(row),
    );
    for (const row of removed) {
      if (
        !mutable.columnRows.some(
          (candidate) => candidate.column_identity === row.column_identity,
        )
      ) {
        mutable.columnRows.push(withoutAcl(row));
      }
    }
  };
  const addColumnGrantRow = (mutable, row) => {
    const emptyIndex = mutable.columnRows.findIndex(
      (candidate) =>
        candidate.column_identity === row.column_identity &&
        candidate.privilege_type === null,
    );
    if (emptyIndex >= 0) {
      mutable.columnRows[emptyIndex] = clone(row);
    } else {
      mutable.columnRows.push(clone(row));
    }
  };
  const client = makeClient(fixture, {
    applyMutation({ fixture: mutable, normalized }) {
      if (normalized === grantOptionStatement) {
        const targets = mutable.columnRows.filter(
          (row) =>
            row.column_identity === "public.email_outbox.status" &&
            row.grantee_name === grantee &&
            row.privilege_type === privilege &&
            row.is_grantable === true,
        );
        assert.equal(targets.length, 1);
        targets[0].is_grantable = false;
        appliedStatements.push(normalized);
        return;
      }
      if (normalized === tableRevokeStatement) {
        const before = mutable.objectRows.length;
        mutable.objectRows = mutable.objectRows.filter(
          (row) =>
            !(
              row.object_kind === "table" &&
              row.object_identity === tableIdentity &&
              row.grantee_name === grantee &&
              row.privilege_type === privilege
            ),
        );
        assert.equal(before - mutable.objectRows.length, 1);
        removeColumnGrantRows(mutable);
        appliedStatements.push(normalized);
        return;
      }
      const expectedRow = columnStatements.get(normalized);
      if (expectedRow !== undefined) {
        addColumnGrantRow(mutable, expectedRow);
        columnStatements.delete(normalized);
        appliedStatements.push(normalized);
        return;
      }
      if (
        normalized.startsWith("grant update (") ||
        normalized.includes("revoke update") ||
        normalized.includes("revoke grant option for update")
      ) {
        assert.fail(`unexpected UPDATE repair statement: ${normalized}`);
      }
    },
  });
  const result = await reconcileBootstrapDatabaseRuntimeCapabilities(client, {
    postgresUser: POSTGRES_USER,
    postgresDatabase: POSTGRES_DATABASE,
    resolution: currentResolution(),
  });
  assert.deepEqual(appliedStatements, [
    grantOptionStatement,
    tableRevokeStatement,
    ...expectedColumnStatements,
  ]);
  assert.equal(columnStatements.size, 0);
  const columnRegrants = client.mutations.filter(
    (sql) =>
      sql.startsWith("grant update (") &&
      sql.includes('on table "public"."email_outbox"') &&
      sql.endsWith('to "learncoding_worker"'),
  );
  assert.equal(columnRegrants.length, 21);
  assert.equal(new Set(columnRegrants).size, 21);
  assert.equal(
    client.mutations.includes(
      'revoke update on table "public"."email_outbox" from "learncoding_worker" cascade',
    ),
    true,
  );
  assert.equal(
    client.mutations.some(
      (sql) =>
        sql.startsWith("revoke grant option for update (") &&
        sql.includes('on table "public"."email_outbox"') &&
        sql.endsWith('from "learncoding_worker" cascade'),
    ),
    true,
  );
  assert.equal(result.mutationCount, 23);

  const secondClient = makeClient(fixture);
  const second = await reconcileBootstrapDatabaseRuntimeCapabilities(
    secondClient,
    {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
      resolution: currentResolution(),
    },
  );
  assert.equal(second.mutationCount, 0);
  assert.deepEqual(secondClient.mutations, []);
});

test("unknown inventory, roles, grantors, and physical default rows block before mutation", async () => {
  const cases = [
    (fixture) => {
      fixture.roleRows.push({
        ...clone(fixture.roleRows.at(-1)),
        role_oid: "9991",
        role_name: "learncoding_unknown",
      });
    },
    (fixture) => {
      const row = clone(fixture.objectRows[0]);
      row.object_oid = "9992";
      row.object_kind = "table";
      row.object_identity = "public.unknown_runtime_table";
      row.schema_name = "public";
      row.object_name = "unknown_runtime_table";
      row.native_kind = "r";
      fixture.objectRows.push(row);
      fixture.columnRows.push({
        ...clone(fixture.columnRows[0]),
        relation_identity: row.object_identity,
        column_identity: `${row.object_identity}.id`,
        column_name: "id",
      });
    },
    (fixture) => {
      const target = fixture.objectRows.find(
        (row) =>
          row.grantor_name === "learncoding_owner" &&
          row.grantee_name === "learncoding_app",
      );
      target.grantor_oid = ROLE_OIDS.get("learncoding_app");
      target.grantor_name = "learncoding_app";
    },
    (fixture) => {
      const row = clone(fixture.defaultAclRows[0]);
      row.default_acl_oid = "9994";
      row.creator_oid = "9994";
      row.creator_name = "learncoding_unknown";
      fixture.defaultAclRows.push(row);
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
  for (const mutate of cases) {
    const fixture = makeFixture();
    mutate(fixture);
    const client = makeClient(fixture);
    await assert.rejects(
      reconcileBootstrapDatabaseRuntimeCapabilities(client, {
        postgresUser: POSTGRES_USER,
        postgresDatabase: POSTGRES_DATABASE,
        resolution: currentResolution(),
      }),
      BootstrapDatabaseRuntimeCapabilityError,
    );
    assert.deepEqual(client.mutations, []);
  }
});

test("a missing physical global routine row emits an explicit PUBLIC suppression baseline", async () => {
  const fixture = makeFixture();
  const missingOid = fixture.defaultAclRows.find(
    (row) =>
      row.creator_name === "learncoding_owner" &&
      row.schema_name === null &&
      row.object_kind === "routine",
  ).default_acl_oid;
  const removedRows = fixture.defaultAclRows
    .filter((row) => row.default_acl_oid === missingOid)
    .map(clone);
  fixture.defaultAclRows = fixture.defaultAclRows.filter(
    (row) => row.default_acl_oid !== missingOid,
  );
  const revokePublic =
    'alter default privileges for role "learncoding_owner" revoke execute on routines from public cascade';
  const grantOwner =
    'alter default privileges for role "learncoding_owner" grant execute on routines to "learncoding_owner"';
  let revokeCount = 0;
  let grantCount = 0;
  const client = makeClient(fixture, {
    applyMutation({ fixture: mutable, normalized }) {
      if (normalized === revokePublic) {
        assert.equal(
          mutable.defaultAclRows.some(
            (row) => row.default_acl_oid === missingOid,
          ),
          false,
        );
        mutable.defaultAclRows.push(...removedRows.map(clone));
        revokeCount += 1;
      } else if (normalized === grantOwner) {
        assert.equal(
          mutable.defaultAclRows.some(
            (row) => row.default_acl_oid === missingOid,
          ),
          true,
        );
        grantCount += 1;
      }
    },
  });
  const result = await reconcileBootstrapDatabaseRuntimeCapabilities(client, {
    postgresUser: POSTGRES_USER,
    postgresDatabase: POSTGRES_DATABASE,
    resolution: currentResolution(),
  });
  assert.equal(result.mutationCount, 3);
  assert.equal(revokeCount, 1);
  assert.equal(grantCount, 2);
  assert.deepEqual(
    client.mutations.filter(
      (sql) =>
        sql !== 'set local role "learncoding_owner"' && sql !== "reset role",
    ),
    [revokePublic, grantOwner, grantOwner],
  );

  const secondClient = makeClient(fixture);
  const second = await reconcileBootstrapDatabaseRuntimeCapabilities(
    secondClient,
    {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
      resolution: currentResolution(),
    },
  );
  assert.equal(second.mutationCount, 0);
  assert.deepEqual(secondClient.mutations, []);
});

test("schema-local default ACL cleanup removes only exact tuples and the final physical row", async () => {
  const makeExtraRows = (fixture, defaultAclOid = "99001") => {
    const ownerOid = ROLE_OIDS.get("learncoding_owner");
    const drizzleOid = fixture.objectRows.find(
      (row) =>
        row.object_kind === "schema" && row.object_identity === "drizzle",
    )?.object_oid;
    assert.ok(drizzleOid);
    return [
      {
        default_acl_oid: defaultAclOid,
        creator_oid: ownerOid,
        creator_name: "learncoding_owner",
        namespace_oid: drizzleOid,
        schema_name: "drizzle",
        object_type_code: "r",
        object_kind: "table",
        acl_ordinal: 1,
        grantor_oid: ownerOid,
        grantor_name: "learncoding_owner",
        grantee_oid: ROLE_OIDS.get("learncoding_app"),
        grantee_name: "learncoding_app",
        grantee_is_public: false,
        privilege_type: "SELECT",
        is_grantable: false,
      },
      {
        default_acl_oid: defaultAclOid,
        creator_oid: ownerOid,
        creator_name: "learncoding_owner",
        namespace_oid: drizzleOid,
        schema_name: "drizzle",
        object_type_code: "r",
        object_kind: "table",
        acl_ordinal: 2,
        grantor_oid: ownerOid,
        grantor_name: "learncoding_owner",
        grantee_oid: ROLE_OIDS.get("learncoding_ops"),
        grantee_name: "learncoding_ops",
        grantee_is_public: false,
        privilege_type: "INSERT",
        is_grantable: false,
      },
    ];
  };
  const statementFor = (row) =>
    `alter default privileges for role "learncoding_owner" in schema "drizzle" revoke ${row.privilege_type.toLowerCase()} on tables from "${row.grantee_name}" cascade`;

  const fixture = makeFixture();
  const extraRows = makeExtraRows(fixture);
  fixture.defaultAclRows.push(...extraRows.map(clone));
  const effects = new Map(extraRows.map((row) => [statementFor(row), row]));
  const expectedStatements = [...effects.keys()].toSorted();
  const remainingCounts = [];
  const client = makeClient(fixture, {
    applyMutation({ fixture: mutable, normalized }) {
      const target = effects.get(normalized);
      if (target === undefined) return;
      const before = mutable.defaultAclRows.length;
      mutable.defaultAclRows = mutable.defaultAclRows.filter(
        (row) =>
          !(
            row.default_acl_oid === target.default_acl_oid &&
            row.privilege_type === target.privilege_type &&
            row.grantee_name === target.grantee_name
          ),
      );
      assert.equal(before - mutable.defaultAclRows.length, 1);
      effects.delete(normalized);
      remainingCounts.push(
        mutable.defaultAclRows.filter(
          (row) => row.default_acl_oid === target.default_acl_oid,
        ).length,
      );
    },
  });
  const result = await reconcileBootstrapDatabaseRuntimeCapabilities(client, {
    postgresUser: POSTGRES_USER,
    postgresDatabase: POSTGRES_DATABASE,
    resolution: currentResolution(),
  });
  assert.equal(result.mutationCount, 2);
  assert.equal(effects.size, 0);
  assert.deepEqual(remainingCounts, [1, 0]);
  assert.deepEqual(
    client.mutations.filter((sql) =>
      sql.startsWith("alter default privileges"),
    ),
    expectedStatements,
  );
  const secondClient = makeClient(fixture);
  const second = await reconcileBootstrapDatabaseRuntimeCapabilities(
    secondClient,
    {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
      resolution: currentResolution(),
    },
  );
  assert.equal(second.mutationCount, 0);
  assert.deepEqual(secondClient.mutations, []);

  const residualFixture = makeFixture();
  const residualRow = makeExtraRows(residualFixture, "99002")[0];
  residualFixture.defaultAclRows.push(clone(residualRow));
  const residualStatement = statementFor(residualRow);
  const residualClient = makeClient(residualFixture, {
    applyMutation({ fixture: mutable, normalized }) {
      if (normalized !== residualStatement) return;
      const row = mutable.defaultAclRows.find(
        (entry) => entry.default_acl_oid === residualRow.default_acl_oid,
      );
      assert.ok(row);
      Object.assign(row, {
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
  });
  await assert.rejects(
    reconcileBootstrapDatabaseRuntimeCapabilities(residualClient, {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
      resolution: currentResolution(),
    }),
    BootstrapDatabaseRuntimeCapabilityError,
  );
  assert.equal(residualClient.mutations.includes(residualStatement), true);

  const mixedFixture = makeFixture();
  mixedFixture.defaultAclRows.push(...makeExtraRows(mixedFixture).map(clone));
  mixedFixture.defaultAclRows.push({
    ...clone(mixedFixture.defaultAclRows[0]),
    default_acl_oid: "99003",
    creator_oid: "99003",
    creator_name: "learncoding_unknown",
    grantor_oid: "99003",
    grantor_name: "learncoding_unknown",
  });
  const mixedClient = makeClient(mixedFixture);
  await assert.rejects(
    reconcileBootstrapDatabaseRuntimeCapabilities(mixedClient, {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
      resolution: currentResolution(),
    }),
    BootstrapDatabaseRuntimeCapabilityError,
  );
  assert.deepEqual(mixedClient.mutations, []);
});

test("ownership repair enumerates the reviewed inventory and rejects unknown structure first", async () => {
  const fixture = makeFixture();
  fixture.databaseOwnerName = POSTGRES_USER;
  for (const row of fixture.objectRows) {
    row.owner_name = POSTGRES_USER;
    row.owner_oid = ROLE_OIDS.get(POSTGRES_USER);
  }
  const ownershipEffects = makeOwnershipEffectApplier();
  const client = makeClient(fixture, {
    applyMutation: ownershipEffects.applyMutation,
  });
  await transferBootstrapDatabaseRuntimeCapabilityOwnership(client, {
    postgresUser: POSTGRES_USER,
    postgresDatabase: POSTGRES_DATABASE,
    policy: POLICY,
  });
  ownershipEffects.assertComplete();
  assert.equal(
    client.mutations.some((sql) => /\bon all\b/u.test(sql)),
    false,
  );
  assert.equal(
    client.mutations.filter((sql) => sql.startsWith("alter table ")).length,
    POLICY.inventory.tables.length,
  );
  assert.equal(
    client.mutations.filter((sql) => sql.startsWith("alter function ")).length,
    POLICY.inventory.routines.length,
  );
});

test("ownership repair is zero-DDL when exact and repairs only mismatched object classes", async () => {
  const exactClient = makeClient(makeFixture());
  await transferBootstrapDatabaseRuntimeCapabilityOwnership(exactClient, {
    postgresUser: POSTGRES_USER,
    postgresDatabase: POSTGRES_DATABASE,
    policy: POLICY,
  });
  assert.deepEqual(exactClient.mutations, []);

  const fixture = makeFixture();
  const postgresOid = ROLE_OIDS.get(POSTGRES_USER);
  const markOwner = (objectKind, identity) => {
    const rows = fixture.objectRows.filter(
      (row) =>
        row.object_kind === objectKind && row.object_identity === identity,
    );
    assert.ok(rows.length > 0, `${objectKind}:${identity}`);
    for (const row of rows) {
      row.owner_name = POSTGRES_USER;
      row.owner_oid = postgresOid;
    }
  };
  const schema =
    POLICY.inventory.schemas.find((entry) => entry.name === "drizzle") ??
    POLICY.inventory.schemas[0];
  const table = POLICY.inventory.tables[0];
  const sequence = POLICY.inventory.sequences[0];
  const type = POLICY.inventory.types.find(
    (entry) => entry.kind !== "composite",
  );
  const routine = POLICY.inventory.routines[0];
  assert.ok(schema);
  assert.ok(table);
  assert.ok(sequence);
  assert.ok(type);
  assert.ok(routine);

  fixture.databaseOwnerName = POSTGRES_USER;
  markOwner("database", "@database");
  markOwner("schema", schema.identity);
  markOwner("table", table.identity);
  markOwner("type", table.identity);
  markOwner("sequence", sequence.identity);
  markOwner("type", type.identity);
  markOwner("routine", routine.identity);

  const ownershipEffects = makeOwnershipEffectApplier();
  const repairClient = makeClient(fixture, {
    applyMutation: ownershipEffects.applyMutation,
  });
  await transferBootstrapDatabaseRuntimeCapabilityOwnership(repairClient, {
    postgresUser: POSTGRES_USER,
    postgresDatabase: POSTGRES_DATABASE,
    policy: POLICY,
  });
  const routineOpen = routine.signature.indexOf("(");
  assert.ok(routineOpen > 0);
  assert.deepEqual(repairClient.mutations, [
    `alter database ${quoteTestIdentifier(
      POSTGRES_DATABASE,
    )} owner to ${quoteTestIdentifier("learncoding_owner")}`,
    `alter schema ${quoteTestIdentifier(schema.name)} owner to ${quoteTestIdentifier(
      schema.owner,
    )}`,
    `alter table ${quoteTestIdentifier(table.schema)}.${quoteTestIdentifier(
      table.name,
    )} owner to ${quoteTestIdentifier(table.owner)}`,
    `alter sequence ${quoteTestIdentifier(
      sequence.schema,
    )}.${quoteTestIdentifier(sequence.name)} owner to ${quoteTestIdentifier(
      sequence.owner,
    )}`,
    `alter type ${quoteTestIdentifier(type.schema)}.${quoteTestIdentifier(
      type.name,
    )} owner to ${quoteTestIdentifier(type.owner)}`,
    `alter function ${quoteTestIdentifier(
      routine.schema,
    )}.${quoteTestIdentifier(
      routine.signature.slice(0, routineOpen),
    )}${routine.signature.slice(routineOpen)} owner to ${quoteTestIdentifier(
      routine.owner,
    )}`,
  ]);
  const mutationCount = repairClient.mutations.length;
  await transferBootstrapDatabaseRuntimeCapabilityOwnership(repairClient, {
    postgresUser: POSTGRES_USER,
    postgresDatabase: POSTGRES_DATABASE,
    policy: POLICY,
  });
  assert.equal(repairClient.mutations.length, mutationCount);
});

test("ownership repair narrowly accepts sealed pg_database_owner evidence for public schema only", async () => {
  const makePredefinedOwnerFixture = () => {
    const fixture = makeFixture();
    for (const row of fixture.objectRows.filter(
      (entry) =>
        entry.object_kind === "schema" && entry.object_identity === "public",
    )) {
      row.owner_name = "pg_database_owner";
      row.owner_oid = "6171";
    }
    return fixture;
  };

  const ordinaryFixture = makePredefinedOwnerFixture();
  const ordinaryClient = makeClient(ordinaryFixture);
  await assert.rejects(
    observeBootstrapDatabaseRuntimeCapabilityCatalog(ordinaryClient, {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
      policy: POLICY,
    }),
    BootstrapDatabaseRuntimeCapabilityError,
  );
  assert.deepEqual(ordinaryClient.mutations, []);

  const repairFixture = makePredefinedOwnerFixture();
  const repairEffects = makeOwnershipEffectApplier();
  const repairClient = makeClient(repairFixture, {
    applyMutation: repairEffects.applyMutation,
  });
  await transferBootstrapDatabaseRuntimeCapabilityOwnership(repairClient, {
    postgresUser: POSTGRES_USER,
    postgresDatabase: POSTGRES_DATABASE,
    policy: POLICY,
  });
  assert.deepEqual(repairClient.mutations, [
    'alter schema "public" owner to "learncoding_owner"',
  ]);

  for (const mutateEvidence of [
    (fixture) => {
      fixture.predefinedPublicOwnerRows = [];
    },
    (fixture) => {
      fixture.predefinedPublicOwnerRows[0].role_oid = "6172";
    },
    (fixture) => {
      fixture.predefinedPublicOwnerRows[0].can_login = true;
    },
    (fixture) => {
      fixture.predefinedPublicOwnerRows[0].superuser = true;
    },
    (fixture) => {
      fixture.predefinedPublicOwnerRows[0].inherit = false;
    },
    (fixture) => {
      fixture.predefinedPublicOwnerRows[0].password_is_null = false;
    },
  ]) {
    const fixture = makePredefinedOwnerFixture();
    mutateEvidence(fixture);
    const client = makeClient(fixture);
    await assert.rejects(
      transferBootstrapDatabaseRuntimeCapabilityOwnership(client, {
        postgresUser: POSTGRES_USER,
        postgresDatabase: POSTGRES_DATABASE,
        policy: POLICY,
      }),
      BootstrapDatabaseRuntimeCapabilityError,
    );
    assert.deepEqual(client.mutations, []);
  }

  const wrongObjectFixture = makePredefinedOwnerFixture();
  for (const row of wrongObjectFixture.objectRows.filter(
    (entry) => entry.object_kind === "table",
  )) {
    row.owner_name = "pg_database_owner";
    row.owner_oid = "6171";
  }
  const wrongObjectClient = makeClient(wrongObjectFixture);
  await assert.rejects(
    transferBootstrapDatabaseRuntimeCapabilityOwnership(wrongObjectClient, {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
      policy: POLICY,
    }),
    BootstrapDatabaseRuntimeCapabilityError,
  );
  assert.deepEqual(wrongObjectClient.mutations, []);
});

test("foundation verification accepts only the exact sealed role, database, schema, and default ACL envelope", async () => {
  const client = makeClient(makeFoundationFixture());
  const result = await verifyBootstrapDatabaseRuntimeCapabilityFoundation(
    client,
    {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
      resolution: foundationResolution(),
    },
  );
  assert.equal(result.phase, DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION);
  assert.equal(result.policyFingerprint, null);
  assert.equal(
    client.queries.some((sql) =>
      sql.includes("bootstrap_database_runtime_capability_objects"),
    ),
    false,
  );
  assert.equal(
    client.queries.some((sql) =>
      sql.includes("bootstrap_database_runtime_capability_columns"),
    ),
    false,
  );

  const withoutDrizzle = makeClient(
    makeFoundationFixture({ drizzlePresent: false }),
  );
  await verifyBootstrapDatabaseRuntimeCapabilityFoundation(withoutDrizzle, {
    postgresUser: POSTGRES_USER,
    postgresDatabase: POSTGRES_DATABASE,
    resolution: foundationResolution(),
  });
  await assert.rejects(
    verifyBootstrapDatabaseRuntimeCapabilityFoundation(
      makeClient(makeFoundationFixture({ drizzlePresent: false })),
      {
        postgresUser: POSTGRES_USER,
        postgresDatabase: POSTGRES_DATABASE,
        resolution: foundationResolution(1),
      },
    ),
    {
      name: "BootstrapDatabaseRuntimeCapabilityError",
      message: /foundation-schema-inventory/u,
    },
  );
});

test("foundation establishment revokes PUBLIC CONNECT and post-verifies exact authority", async () => {
  const client = makeClient(makeFoundationFixture());
  const result = await establishBootstrapDatabaseRuntimeCapabilityFoundation(
    client,
    {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
    },
  );
  assert.equal(result.phase, DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION);
  assert.equal(
    client.mutations.some((sql) =>
      sql.includes(
        'revoke connect, create, temporary on database "learncoding" from public',
      ),
    ),
    true,
  );
  assert.equal(
    client.mutations.some((sql) =>
      sql.includes(
        "revoke usage, create on schema public from public, pg_database_owner",
      ),
    ),
    true,
  );
  assert.equal(
    client.mutations.some((sql) => /\bgrant\b[\s\S]*\bon all\b/u.test(sql)),
    false,
  );
  assert.equal(
    client.queries.some((sql) => sql.includes("foundation_denial")),
    false,
  );
  assert.equal(
    client.mutations.filter((sql) => sql === "reset role").length,
    2,
  );
});

test("foundation establishment repairs creator deficits and schema-local additions", async () => {
  const fixture = makeFoundationFixture();
  const ownerOid = ROLE_OIDS.get("learncoding_owner");
  const publicNamespaceOid = fixture.objectRows.find(
    (row) => row.object_kind === "schema" && row.object_identity === "public",
  )?.object_oid;
  assert.ok(publicNamespaceOid);
  fixture.defaultAclRows.push(
    {
      default_acl_oid: "8801",
      creator_oid: ownerOid,
      creator_name: "learncoding_owner",
      namespace_oid: "0",
      schema_name: null,
      object_type_code: "r",
      object_kind: "table",
      acl_ordinal: 1,
      grantor_oid: ownerOid,
      grantor_name: "learncoding_owner",
      grantee_oid: ownerOid,
      grantee_name: "learncoding_owner",
      grantee_is_public: false,
      privilege_type: "SELECT",
      is_grantable: false,
    },
    {
      default_acl_oid: "8801",
      creator_oid: ownerOid,
      creator_name: "learncoding_owner",
      namespace_oid: "0",
      schema_name: null,
      object_type_code: "r",
      object_kind: "table",
      acl_ordinal: 2,
      grantor_oid: ownerOid,
      grantor_name: "learncoding_owner",
      grantee_oid: ROLE_OIDS.get("learncoding_app"),
      grantee_name: "learncoding_app",
      grantee_is_public: false,
      privilege_type: "SELECT",
      is_grantable: false,
    },
    {
      default_acl_oid: "8802",
      creator_oid: ownerOid,
      creator_name: "learncoding_owner",
      namespace_oid: publicNamespaceOid,
      schema_name: "public",
      object_type_code: "r",
      object_kind: "table",
      acl_ordinal: 1,
      grantor_oid: ownerOid,
      grantor_name: "learncoding_owner",
      grantee_oid: ownerOid,
      grantee_name: "learncoding_owner",
      grantee_is_public: false,
      privilege_type: "SELECT",
      is_grantable: false,
    },
  );
  const classes = [
    {
      sql: "tables",
      kind: "table",
      code: "r",
      privileges: [
        "INSERT",
        "SELECT",
        "UPDATE",
        "DELETE",
        "TRUNCATE",
        "REFERENCES",
        "TRIGGER",
      ],
    },
    {
      sql: "sequences",
      kind: "sequence",
      code: "S",
      privileges: ["USAGE", "SELECT", "UPDATE"],
    },
    {
      sql: "routines",
      kind: "routine",
      code: "f",
      privileges: ["EXECUTE"],
    },
    {
      sql: "types",
      kind: "type",
      code: "T",
      privileges: ["USAGE"],
    },
  ];
  const creators = ["learncoding_owner", POSTGRES_USER];
  const loginRoles = POLICY.roles
    .map((entry) => entry.name)
    .filter((name) => name !== "learncoding_owner");
  const effects = new Map();
  const scopeOids = new Map();
  const scopeKey = (creator, schema, kind) =>
    `${creator}|${schema ?? "@global"}|${kind}`;
  for (const row of fixture.defaultAclRows) {
    scopeOids.set(
      scopeKey(row.creator_name, row.schema_name, row.object_kind),
      row.default_acl_oid,
    );
  }
  let nextOid = 89_000;
  const oidFor = (creator, schema, kind) => {
    const key = scopeKey(creator, schema, kind);
    const existing = scopeOids.get(key);
    if (existing !== undefined) return existing;
    const created = String(nextOid);
    nextOid += 1;
    scopeOids.set(key, created);
    return created;
  };
  const scopeRows = (mutable, creator, schema, kind) =>
    mutable.defaultAclRows.filter(
      (row) =>
        row.creator_name === creator &&
        row.schema_name === schema &&
        row.object_kind === kind,
    );
  const replaceScopeRows = (mutable, creator, schema, kind, rows) => {
    mutable.defaultAclRows = mutable.defaultAclRows.filter(
      (row) =>
        !(
          row.creator_name === creator &&
          row.schema_name === schema &&
          row.object_kind === kind
        ),
    );
    mutable.defaultAclRows.push(...rows);
  };
  const rawRows = (mutable, creator, schema, objectClass, grantees) => {
    const creatorOid = ROLE_OIDS.get(creator);
    const namespaceOid =
      schema === null
        ? "0"
        : mutable.objectRows.find(
            (row) =>
              row.object_kind === "schema" && row.object_identity === schema,
          )?.object_oid;
    assert.ok(creatorOid);
    assert.ok(namespaceOid);
    const oid = oidFor(creator, schema, objectClass.kind);
    return grantees
      .flatMap(({ name, privileges }) =>
        privileges.map((privilege) => ({
          default_acl_oid: oid,
          creator_oid: creatorOid,
          creator_name: creator,
          namespace_oid: namespaceOid,
          schema_name: schema,
          object_type_code: objectClass.code,
          object_kind: objectClass.kind,
          acl_ordinal: 0,
          grantor_oid: creatorOid,
          grantor_name: creator,
          grantee_oid: ROLE_OIDS.get(name),
          grantee_name: name,
          grantee_is_public: false,
          privilege_type: privilege,
          is_grantable: false,
        })),
      )
      .map((row, index) => ({ ...row, acl_ordinal: index + 1 }));
  };
  const register = (statement, effect) => {
    assert.equal(effects.has(statement), false, statement);
    effects.set(statement, effect);
  };
  for (const creator of creators) {
    const quotedCreator = quoteTestIdentifier(creator);
    const allGrantees = [
      "public",
      quoteTestIdentifier("learncoding_owner"),
      quoteTestIdentifier(POSTGRES_USER),
      ...loginRoles.map(quoteTestIdentifier),
    ];
    const nonCreatorGrantees = [
      ...new Set(allGrantees.filter((grantee) => grantee !== quotedCreator)),
    ].join(", ");
    const schemaGrantees = [...new Set(allGrantees)].join(", ");
    for (const objectClass of classes) {
      register(
        `alter default privileges for role ${quotedCreator} revoke all privileges on ${objectClass.sql} from ${nonCreatorGrantees} cascade`,
        (mutable) => {
          const retained = scopeRows(
            mutable,
            creator,
            null,
            objectClass.kind,
          ).filter((row) => row.grantee_name === creator);
          replaceScopeRows(mutable, creator, null, objectClass.kind, retained);
        },
      );
      register(
        `alter default privileges for role ${quotedCreator} grant all privileges on ${objectClass.sql} to ${quotedCreator}`,
        (mutable) => {
          const nonCreator = scopeRows(
            mutable,
            creator,
            null,
            objectClass.kind,
          ).filter((row) => row.grantee_name !== creator);
          if (
            ["table", "sequence"].includes(objectClass.kind) &&
            nonCreator.length === 0
          ) {
            replaceScopeRows(mutable, creator, null, objectClass.kind, []);
            return;
          }
          const creatorRows = rawRows(mutable, creator, null, objectClass, [
            { name: creator, privileges: objectClass.privileges },
          ]);
          replaceScopeRows(
            mutable,
            creator,
            null,
            objectClass.kind,
            [...nonCreator, ...creatorRows].map((row, index) => ({
              ...row,
              acl_ordinal: index + 1,
            })),
          );
        },
      );
      for (const schema of ["public", "drizzle"]) {
        register(
          `alter default privileges for role ${quotedCreator} in schema ${quoteTestIdentifier(
            schema,
          )} revoke all privileges on ${objectClass.sql} from ${schemaGrantees} cascade`,
          (mutable) =>
            replaceScopeRows(mutable, creator, schema, objectClass.kind, []),
        );
      }
    }
  }
  assert.equal(effects.size, 32);
  const consumed = [];
  const client = makeClient(fixture, {
    applyMutation({ fixture: mutable, normalized }) {
      const effect = effects.get(normalized);
      if (effect === undefined) return;
      effect(mutable);
      effects.delete(normalized);
      consumed.push(normalized);
    },
  });
  const result = await establishBootstrapDatabaseRuntimeCapabilityFoundation(
    client,
    {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
    },
  );
  assert.equal(result.phase, DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION);
  assert.equal(effects.size, 0);
  assert.equal(consumed.length, 32);
  assert.equal(new Set(consumed).size, 32);
  for (const creator of ['"learncoding_owner"', '"legacy_bootstrap"']) {
    for (const objectClass of ["tables", "sequences", "routines", "types"]) {
      assert.equal(
        client.mutations.includes(
          `alter default privileges for role ${creator} grant all privileges on ${objectClass} to ${creator}`,
        ),
        true,
      );
      assert.equal(
        client.mutations.some(
          (sql) =>
            sql.startsWith(
              `alter default privileges for role ${creator} in schema "public" revoke all privileges on ${objectClass} from `,
            ) && sql.includes(creator),
        ),
        true,
      );
    }
  }
});

test("foundation verification rejects hostile topology and envelope drift without mutation", async () => {
  const cases = [
    (fixture) => {
      fixture.roleRows.push({
        ...clone(fixture.roleRows[0]),
        role_oid: "9991",
        role_name: "learncoding_unknown",
      });
    },
    (fixture) => {
      fixture.effectiveMembershipRows.pop();
    },
    (fixture) => {
      const target = fixture.foundationAuthorityRows[0];
      const nextOrdinal =
        Math.max(
          ...fixture.foundationAuthorityRows
            .filter((row) => row.scope_oid === target.scope_oid)
            .map((row) => row.acl_ordinal),
        ) + 1;
      fixture.foundationAuthorityRows.push({
        ...clone(target),
        acl_ordinal: nextOrdinal,
        grantee_oid: "0",
        grantee_name: "PUBLIC",
        grantee_is_public: true,
        privilege_type: "CONNECT",
      });
    },
    (fixture) => {
      const appOid = ROLE_OIDS.get("learncoding_app");
      fixture.foundationAuthorityRows.push({
        scope_kind: "schema",
        scope_oid: "9998",
        scope_identity: "learncoding_app",
        owner_oid: appOid,
        owner_name: "learncoding_app",
        acl_ordinal: 1,
        grantor_oid: appOid,
        grantor_name: "learncoding_app",
        grantee_oid: appOid,
        grantee_name: "learncoding_app",
        grantee_is_public: false,
        privilege_type: "USAGE",
        is_grantable: false,
      });
    },
    (fixture) => {
      fixture.defaultAclRows.push({
        ...clone(fixture.defaultAclRows[0]),
        default_acl_oid: "9992",
        creator_oid: "9992",
        creator_name: "learncoding_unknown",
      });
    },
    (fixture) => {
      fixture.defaultAclRows[0].namespace_oid = "9993";
      fixture.defaultAclRows[0].schema_name = null;
    },
    (fixture) => {
      fixture.defaultAclRows[0].object_type_code = "r";
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
      verifyBootstrapDatabaseRuntimeCapabilityFoundation(client, {
        postgresUser: POSTGRES_USER,
        postgresDatabase: POSTGRES_DATABASE,
        resolution: foundationResolution(),
      }),
      BootstrapDatabaseRuntimeCapabilityError,
    );
    assert.deepEqual(client.mutations, []);
  }
});

test("current verification is read-only and rejects closed-world drift", async () => {
  const exactClient = makeClient();
  const resolution = currentResolution();
  const result = await verifyBootstrapDatabaseRuntimeCapabilities(exactClient, {
    postgresUser: POSTGRES_USER,
    postgresDatabase: POSTGRES_DATABASE,
    resolution,
  });
  assert.equal(result.phase, DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069);
  assert.deepEqual(exactClient.mutations, []);

  const fixture = makeFixture();
  fixture.objectRows.push({
    ...clone(fixture.objectRows.find((row) => row.object_kind === "table")),
    object_oid: "9993",
    object_identity: "public.unreviewed_runtime_table",
    object_name: "unreviewed_runtime_table",
  });
  fixture.columnRows.push({
    ...clone(fixture.columnRows[0]),
    relation_identity: "public.unreviewed_runtime_table",
    column_identity: "public.unreviewed_runtime_table.id",
  });
  const hostileClient = makeClient(fixture);
  await assert.rejects(
    verifyBootstrapDatabaseRuntimeCapabilities(hostileClient, {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
      resolution,
    }),
    BootstrapDatabaseRuntimeCapabilityError,
  );
  assert.deepEqual(hostileClient.mutations, []);
});

test("current read-only verification rejects the complete hostile ACL and inventory matrix", async () => {
  const cases = [
    {
      label: "grant option",
      mutate(fixture) {
        const target = fixture.objectRows.find(
          (row) => row.grantee_name === "learncoding_app",
        );
        assert.ok(target);
        target.is_grantable = true;
      },
    },
    {
      label: "wrong grantor",
      mutate(fixture) {
        const target = fixture.objectRows.find(
          (row) => row.grantee_name === "learncoding_app",
        );
        assert.ok(target);
        target.grantor_oid = ROLE_OIDS.get("learncoding_app");
        target.grantor_name = "learncoding_app";
      },
    },
    {
      label: "PUBLIC grant",
      mutate(fixture) {
        const target = fixture.objectRows.find(
          (row) => row.grantee_name === "learncoding_app",
        );
        assert.ok(target);
        const nextOrdinal =
          Math.max(
            ...fixture.objectRows
              .filter(
                (row) =>
                  row.source_catalog === target.source_catalog &&
                  row.object_oid === target.object_oid,
              )
              .map((row) => row.acl_ordinal),
          ) + 1;
        fixture.objectRows.push({
          ...clone(target),
          acl_ordinal: nextOrdinal,
          grantee_oid: "0",
          grantee_name: "PUBLIC",
          grantee_is_public: true,
        });
      },
    },
    {
      label: "unknown object",
      mutate(fixture) {
        const target = fixture.objectRows.find(
          (row) => row.object_kind === "table",
        );
        assert.ok(target);
        fixture.objectRows.push({
          ...clone(target),
          object_oid: "99_002",
          object_identity: "public.unreviewed_runtime_table",
          object_name: "unreviewed_runtime_table",
        });
      },
    },
    {
      label: "unknown column on a known table",
      mutate(fixture) {
        const relationIdentity = "public.email_outbox";
        const relationRows = fixture.columnRows.filter(
          (row) => row.relation_identity === relationIdentity,
        );
        assert.ok(relationRows.length > 0);
        const nextOrdinal = relationRows[0].relation_max_attnum + 1;
        for (const row of relationRows) {
          row.relation_max_attnum = nextOrdinal;
        }
        fixture.columnRows.push({
          ...clone(relationRows[0]),
          relation_max_attnum: nextOrdinal,
          physical_ordinal: nextOrdinal,
          column_name: "unreviewed_runtime_column",
          column_identity: `${relationIdentity}.unreviewed_runtime_column`,
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
      label: "unknown schema",
      mutate(fixture) {
        const target = fixture.objectRows.find(
          (row) => row.object_kind === "schema",
        );
        assert.ok(target);
        fixture.objectRows.push({
          ...clone(target),
          object_oid: "99_003",
          object_identity: "unreviewed_runtime_schema",
          object_name: "unreviewed_runtime_schema",
        });
      },
    },
    {
      label: "unknown default ACL creator",
      mutate(fixture) {
        const target = clone(fixture.defaultAclRows[0]);
        target.default_acl_oid = "99_004";
        target.creator_oid = "99_004";
        target.creator_name = "learncoding_unknown";
        target.grantor_oid = "99_004";
        target.grantor_name = "learncoding_unknown";
        fixture.defaultAclRows.push(target);
      },
    },
  ];

  for (const { label, mutate } of cases) {
    const fixture = makeFixture();
    mutate(fixture);
    const client = makeClient(fixture);
    await assert.rejects(
      verifyBootstrapDatabaseRuntimeCapabilities(client, {
        postgresUser: POSTGRES_USER,
        postgresDatabase: POSTGRES_DATABASE,
        resolution: currentResolution(),
      }),
      BootstrapDatabaseRuntimeCapabilityError,
      label,
    );
    assert.deepEqual(client.mutations, [], label);
  }
});

test("current verification rejects contradictory raw OID and ACL envelopes", async () => {
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
    {
      label: "duplicate raw object catalog row",
      section: "duplicate-object-catalog-row",
      mutate(fixture) {
        fixture.objectRows.push(clone(fixture.objectRows[0]));
      },
    },
    {
      label: "duplicate raw column catalog row",
      section: "duplicate-column-catalog-row",
      mutate(fixture) {
        const empty = fixture.columnRows.find(
          (row) => row.privilege_type === null,
        );
        assert.ok(empty);
        fixture.columnRows.push(clone(empty));
      },
    },
    {
      label: "duplicate raw default ACL catalog row",
      section: "duplicate-default-acl-catalog-row",
      mutate(fixture) {
        fixture.defaultAclRows.push(clone(fixture.defaultAclRows[0]));
      },
    },
    {
      label: "non-contiguous object ACL ordinality",
      section: "object-acl-rowset",
      mutate(fixture) {
        fixture.objectRows[0].acl_ordinal = 99_101;
      },
    },
    {
      label: "non-contiguous column ACL ordinality",
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
      label: "mixed column ACL sentinel and populated row",
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
      label: "mixed object ACL sentinel and populated row",
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
      label: "non-contiguous default ACL ordinality",
      section: "default-acl-rowset",
      mutate(fixture) {
        fixture.defaultAclRows[0].acl_ordinal = 99_103;
      },
    },
    {
      label: "mixed default ACL sentinel and populated row",
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
  ];
  for (const { label, section, mutate } of cases) {
    const fixture = makeFixture();
    mutate(fixture);
    await assert.rejects(
      verifyBootstrapDatabaseRuntimeCapabilities(makeClient(fixture), {
        postgresUser: POSTGRES_USER,
        postgresDatabase: POSTGRES_DATABASE,
        resolution: currentResolution(),
      }),
      section === undefined
        ? BootstrapDatabaseRuntimeCapabilityError
        : {
            name: "BootstrapDatabaseRuntimeCapabilityError",
            message: new RegExp(`${section}$`, "u"),
          },
      label,
    );
  }
});

test("current verification accepts equal OIDs from different PostgreSQL catalogs", async () => {
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
  await verifyBootstrapDatabaseRuntimeCapabilities(makeClient(fixture), {
    postgresUser: POSTGRES_USER,
    postgresDatabase: POSTGRES_DATABASE,
    resolution: currentResolution(),
  });
});

test("current reconciliation removes a PUBLIC default tuple with the raw pseudo-role", async () => {
  const fixture = makeFixture();
  const row = fixture.defaultAclRows.find(
    (entry) =>
      entry.creator_name === "learncoding_owner" &&
      entry.schema_name === null &&
      entry.object_kind === "routine",
  );
  assert.ok(row);
  const nextOrdinal =
    Math.max(
      ...fixture.defaultAclRows
        .filter((entry) => entry.default_acl_oid === row.default_acl_oid)
        .map((entry) => entry.acl_ordinal),
    ) + 1;
  fixture.defaultAclRows.push({
    ...clone(row),
    acl_ordinal: nextOrdinal,
    grantee_oid: "0",
    grantee_name: "PUBLIC",
    grantee_is_public: true,
  });
  const targetOid = row.default_acl_oid;
  const adjacentBefore = clone(
    fixture.defaultAclRows.filter(
      (entry) => entry.default_acl_oid !== targetOid,
    ),
  );
  const exactStatement =
    'alter default privileges for role "learncoding_owner" revoke execute on routines from public cascade';
  let applied = 0;
  const client = makeClient(fixture, {
    applyMutation({ fixture: mutable, normalized }) {
      if (normalized !== exactStatement) return;
      const before = mutable.defaultAclRows.length;
      mutable.defaultAclRows = mutable.defaultAclRows.filter(
        (entry) =>
          !(
            entry.default_acl_oid === targetOid &&
            entry.grantee_is_public === true &&
            entry.privilege_type === "EXECUTE"
          ),
      );
      const remaining = mutable.defaultAclRows
        .filter((entry) => entry.default_acl_oid === targetOid)
        .sort((left, right) => left.acl_ordinal - right.acl_ordinal);
      for (const [ordinal, entry] of remaining.entries()) {
        entry.acl_ordinal = ordinal + 1;
      }
      assert.equal(before - mutable.defaultAclRows.length, 1);
      applied += 1;
    },
  });
  const result = await reconcileBootstrapDatabaseRuntimeCapabilities(client, {
    postgresUser: POSTGRES_USER,
    postgresDatabase: POSTGRES_DATABASE,
    resolution: currentResolution(),
  });
  assert.equal(result.mutationCount, 1);
  assert.equal(applied, 1);
  assert.equal(client.mutations.includes(exactStatement), true);
  assert.deepEqual(
    fixture.defaultAclRows.filter(
      (entry) => entry.default_acl_oid !== targetOid,
    ),
    adjacentBefore,
  );
  assert.equal(
    client.mutations.some((sql) => sql.includes('from "public"')),
    false,
  );
  const secondClient = makeClient(fixture);
  const second = await reconcileBootstrapDatabaseRuntimeCapabilities(
    secondClient,
    {
      postgresUser: POSTGRES_USER,
      postgresDatabase: POSTGRES_DATABASE,
      resolution: currentResolution(),
    },
  );
  assert.equal(second.mutationCount, 0);
  assert.deepEqual(secondClient.mutations, []);
});
