import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import ts from "typescript";

import {
  BOOTSTRAP_SESSION_AUTHORITY,
  CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
  CURRENT_0069_REVIEWED_MIGRATION_TAG,
  DATABASE_RUNTIME_CAPABILITY_PHASES,
  DATABASE_RUNTIME_CAPABILITY_SCHEMA_VERSION,
  POST_CONTRACT_DATABASE_RUNTIME_CAPABILITIES,
  PREDECESSOR_0070_DATABASE_RUNTIME_CAPABILITY_ALLOWANCE,
  canonicalDatabaseRuntimeCapabilitiesJson,
  canonicalizeDatabaseRuntimeCapabilities,
  classifyDatabaseRuntimeCapabilityPredecessorDelta,
  classifyDatabaseRuntimeCapabilityGrantDelta,
  diffDatabaseRuntimeCapabilities,
  fingerprintDatabaseRuntimeCapabilities,
  planDatabaseRuntimeCapabilityReconciliation,
  resolveDatabaseRuntimeCapabilityPhase,
  validateDatabaseRuntimeCapabilityAllowance,
  validateDatabaseRuntimeCapabilities,
} from "./database-runtime-capabilities.mjs";
import {
  REVIEWED_MIGRATION_LEDGER,
  REVIEWED_MIGRATION_LEDGER_SHA256,
} from "./lib/reviewed-migration-ledger.mjs";

const clone = (value) => structuredClone(value);

function defaultAclRowIdentity(value) {
  const creator =
    typeof value.creator === "string" ? value.creator : value.creator.kind;
  return [creator, value.schema ?? "@global", value.objectKind].join("|");
}

function matchingParen(source, open) {
  let depth = 0;
  let single = false;
  let double = false;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (single) {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        single = false;
      }
      continue;
    }
    if (double) {
      if (character === '"' && next === '"') {
        index += 1;
      } else if (character === '"') {
        double = false;
      }
      continue;
    }
    if (character === "'") {
      single = true;
    } else if (character === '"') {
      double = true;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  assert.fail(`unterminated CREATE TABLE at byte ${open}`);
}

function splitTopLevel(source) {
  const entries = [];
  let start = 0;
  let depth = 0;
  let single = false;
  let double = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (single) {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        single = false;
      }
      continue;
    }
    if (double) {
      if (character === '"' && next === '"') {
        index += 1;
      } else if (character === '"') {
        double = false;
      }
      continue;
    }
    if (character === "'") {
      single = true;
    } else if (character === '"') {
      double = true;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    } else if (character === "," && depth === 0) {
      entries.push(source.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(source.slice(start));
  return entries;
}

function createdColumns(source, open) {
  const constraintKeywords = new Set([
    "check",
    "constraint",
    "exclude",
    "foreign",
    "like",
    "primary",
    "unique",
  ]);
  const close = matchingParen(source, open);
  const columns = [];
  for (const definition of splitTopLevel(source.slice(open + 1, close))) {
    const match = /^(?:"((?:[^"]|"")*)"|([a-z_][a-z0-9_]*))\s+/iu.exec(
      definition.trim(),
    );
    if (!match) continue;
    const name = (match[1] ?? match[2]).replaceAll('""', '"');
    if (!constraintKeywords.has(name.toLowerCase())) columns.push(name);
  }
  return columns;
}

async function deriveReviewedPublicColumnAttnums(journal) {
  const tables = new Map();
  let addedColumns = 0;
  for (const entry of journal.entries) {
    const source = await readFile(
      new URL(`../drizzle/${entry.tag}.sql`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /\b(?:DROP|RENAME)\s+COLUMN\b|\bDROP\s+TABLE\b/iu,
      entry.tag,
    );
    const events = [];
    const createPattern =
      /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"public"|public)\.)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))\s*(\()/giu;
    for (const match of source.matchAll(createPattern)) {
      events.push({
        kind: "create",
        position: match.index,
        table: match[1] ?? match[2],
        columns: createdColumns(source, match.index + match[0].length - 1),
      });
    }
    const alterPattern =
      /\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:(?:"public"|public)\.)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))([\s\S]{0,6000}?)(?=-->\s*statement-breakpoint|;\s*(?:\r?\n|$)|\$[a-z_]*\$\s*;)/giu;
    for (const match of source.matchAll(alterPattern)) {
      assert.doesNotMatch(match[3], /\bRENAME\s+TO\b/iu, entry.tag);
      const columns = Array.from(
        match[3].matchAll(
          /\bADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|([a-z_][a-z0-9_]*))/giu,
        ),
        (column) => column[1] ?? column[2],
      );
      if (columns.length > 0) {
        events.push({
          kind: "append",
          position: match.index,
          table: match[1] ?? match[2],
          columns,
        });
      }
    }
    events.sort((left, right) => left.position - right.position);
    for (const event of events) {
      const identity = `public.${event.table}`;
      if (event.kind === "create") {
        assert.equal(tables.has(identity), false, `duplicate ${identity}`);
        tables.set(identity, [...event.columns]);
        continue;
      }
      const existing = tables.get(identity);
      assert.ok(existing, `ADD COLUMN precedes CREATE TABLE ${identity}`);
      for (const column of event.columns) {
        assert.equal(
          existing.includes(column),
          false,
          `duplicate ${identity}.${column}`,
        );
        existing.push(column);
        addedColumns += 1;
      }
    }
  }
  return {
    addedColumns,
    tables: [...tables.entries()]
      .map(([identity, columns]) => ({
        identity,
        generation: 1,
        maxAttnum: columns.length,
        droppedAttnums: [],
        columns: columns.map((name, index) => ({
          identity: `${identity}.${name}`,
          name,
          attnum: index + 1,
        })),
      }))
      .sort((left, right) =>
        left.identity < right.identity
          ? -1
          : left.identity > right.identity
            ? 1
            : 0,
      ),
  };
}

function reverseUnorderedCollections(value, parentKey = null) {
  if (Array.isArray(value)) {
    const nested = value.map((entry) =>
      reverseUnorderedCollections(entry, parentKey),
    );
    return parentKey === "values" ? nested : nested.toReversed();
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toReversed()
        .map(([key, nested]) => [
          key,
          reverseUnorderedCollections(nested, key),
        ]),
    );
  }
  return value;
}

function assertDeeplyFrozenJson(value, path = "$") {
  if (value === null || ["string", "boolean"].includes(typeof value)) {
    return;
  }
  if (typeof value === "number") {
    assert.equal(Number.isFinite(value), true, `${path} must be finite`);
    assert.equal(
      Object.is(value, -0),
      false,
      `${path} must not be negative zero`,
    );
    return;
  }
  assert.equal(typeof value, "object", `${path} must be JSON-domain data`);
  assert.equal(
    Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype,
    true,
    `${path} must be an array or plain object`,
  );
  assert.equal(
    Reflect.ownKeys(value).some((key) => typeof key === "symbol"),
    false,
    `${path} must not contain symbol keys`,
  );
  if (Array.isArray(value)) {
    assert.equal(
      Object.keys(value).length,
      value.length,
      `${path} must be dense`,
    );
  }
  assert.equal(Object.isFrozen(value), true, `${path} must be frozen`);
  for (const [key, nested] of Object.entries(value)) {
    assertDeeplyFrozenJson(nested, `${path}.${key}`);
  }
}

function applyPlan(catalog, plan) {
  assert.equal(plan.blocked, false, "blocked plans are never executable");
  const next = clone(catalog);
  for (const mutation of plan.mutations) {
    const collection = next[mutation.collection];
    if (mutation.action === "add" || mutation.action === "ensure") {
      collection.push(clone(mutation.value));
    } else if (mutation.action === "remove") {
      const index = collection.findIndex((entry) =>
        isDeepStrictEqual(entry, mutation.value),
      );
      assert.notEqual(index, -1);
      collection.splice(index, 1);
    } else if (mutation.action === "replace") {
      const index = collection.findIndex(
        (entry) => entry.identity === mutation.identity,
      );
      assert.notEqual(index, -1);
      collection[index] = clone(mutation.value);
    } else {
      assert.fail(`unknown mutation action ${mutation.action}`);
    }
  }
  return next;
}

test("publishes the exact migration-derived 0069 public and Drizzle inventory", async () => {
  const [snapshot, journal, physicalManifest] = await Promise.all([
    readFile(
      new URL("../drizzle/meta/0069_snapshot.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
    readFile(
      new URL("../drizzle/meta/_journal.json", import.meta.url),
      "utf8",
    ).then(JSON.parse),
    readFile(
      new URL(
        "../drizzle/meta/0069_public_column_attnums.json",
        import.meta.url,
      ),
      "utf8",
    ).then(JSON.parse),
  ]);
  const snapshotPublicTables = Object.entries(snapshot.tables).filter(
    ([identity]) => identity.startsWith("public."),
  );
  assert.equal(snapshotPublicTables.length, 125);
  assert.equal(
    snapshotPublicTables.reduce(
      (count, [, table]) => count + Object.keys(table.columns).length,
      0,
    ),
    1_480,
  );
  assert.equal(journal.entries.length, REVIEWED_MIGRATION_LEDGER.length);
  assert.deepEqual(
    journal.entries.map((entry) => entry.tag),
    REVIEWED_MIGRATION_LEDGER.map((entry) => entry.tag),
  );
  assert.equal(physicalManifest.schemaVersion, 1);
  assert.equal(
    physicalManifest.contract,
    "codestead-public-column-attnums-0069-v1",
  );
  assert.equal(
    physicalManifest.reviewedMigrationTail,
    CURRENT_0069_REVIEWED_MIGRATION_TAG,
  );
  assert.equal(
    physicalManifest.reviewedMigrationLedgerSha256,
    REVIEWED_MIGRATION_LEDGER_SHA256,
  );
  assert.equal(
    createHash("sha256")
      .update(`${JSON.stringify(physicalManifest)}\n`, "utf8")
      .digest("hex"),
    "b64e0934d046eb1cc4b1609ffbaf309cccdc2fa12fd4154ace19c9f63a0859af",
  );

  const derived = await deriveReviewedPublicColumnAttnums(journal);
  assert.equal(derived.tables.length, 127);
  assert.equal(
    derived.tables.reduce((count, table) => count + table.columns.length, 0),
    1_489,
  );
  assert.equal(derived.addedColumns, 97);
  assert.deepEqual(physicalManifest.tables, derived.tables);

  const publicTables =
    CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.inventory.tables
      .filter((table) => table.schema === "public")
      .map(({ identity, columns }) => ({
        identity,
        columns: columns.map(({ identity: columnIdentity, name, ordinal }) => ({
          identity: columnIdentity,
          name,
          ordinal,
        })),
      }))
      .sort((left, right) =>
        left.identity < right.identity
          ? -1
          : left.identity > right.identity
            ? 1
            : 0,
      );
  const expected = physicalManifest.tables.map(({ identity, columns }) => ({
    identity,
    columns: columns.map(({ identity: columnIdentity, name, attnum }) => ({
      identity: columnIdentity,
      name,
      ordinal: attnum,
    })),
  }));
  assert.deepEqual(publicTables, expected);
  assert.equal(publicTables.length, 127);
  assert.equal(
    publicTables.reduce((count, table) => count + table.columns.length, 0),
    1_489,
  );

  const physicalOrdinals = new Map(
    physicalManifest.tables.flatMap((table) =>
      table.columns.map((column) => [column.identity, column.attnum]),
    ),
  );
  assert.deepEqual(
    Object.fromEntries(
      [
        "public.email_outbox.status",
        "public.email_outbox.operation_id",
        "public.email_outbox.delivery_scope_key",
        "public.email_outbox.delivery_release_insert_xid",
        "public.email_outbox.provider_request_body_sha256",
        "public.email_outbox.provider_request_body_length",
        "public.email_outbox.delivery_release_insert_system_identifier",
        "public.learner_profile.onboarding_step",
        "public.learner_profile.selected_tracks",
        "public.learner_profile.dsa_language",
        "public.learner_profile.storage_quota_bytes",
        "public.stored_object.updated_at",
        "public.stored_object.scan_attempts",
        "public.stored_object.retention_class",
      ].map((identity) => [identity, physicalOrdinals.get(identity)]),
    ),
    {
      "public.email_outbox.status": 8,
      "public.email_outbox.operation_id": 15,
      "public.email_outbox.delivery_scope_key": 24,
      "public.email_outbox.delivery_release_insert_xid": 34,
      "public.email_outbox.provider_request_body_sha256": 35,
      "public.email_outbox.provider_request_body_length": 36,
      "public.email_outbox.delivery_release_insert_system_identifier": 37,
      "public.learner_profile.onboarding_step": 8,
      "public.learner_profile.selected_tracks": 16,
      "public.learner_profile.dsa_language": 17,
      "public.learner_profile.storage_quota_bytes": 18,
      "public.stored_object.updated_at": 12,
      "public.stored_object.scan_attempts": 13,
      "public.stored_object.retention_class": 19,
    },
  );

  assert.deepEqual(
    CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.inventory.tables.filter(
      (table) => table.schema === "drizzle",
    ),
    [
      {
        identity: "drizzle.__drizzle_migrations",
        schema: "drizzle",
        name: "__drizzle_migrations",
        owner: "learncoding_owner",
        columns: [
          {
            identity: "drizzle.__drizzle_migrations.id",
            name: "id",
            ordinal: 1,
          },
          {
            identity: "drizzle.__drizzle_migrations.hash",
            name: "hash",
            ordinal: 2,
          },
          {
            identity: "drizzle.__drizzle_migrations.created_at",
            name: "created_at",
            ordinal: 3,
          },
        ],
      },
    ],
  );
  assert.deepEqual(
    CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.inventory.databases,
    [{ identity: "@database", owner: "learncoding_owner" }],
  );
  assert.deepEqual(
    CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.inventory.sequences,
    [
      {
        identity: "drizzle.__drizzle_migrations_id_seq",
        schema: "drizzle",
        name: "__drizzle_migrations_id_seq",
        owner: "learncoding_owner",
      },
    ],
  );
  assert.deepEqual(
    CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.inventory.types.filter(
      (type) => type.schema === "drizzle",
    ),
    [
      {
        identity: "drizzle.__drizzle_migrations",
        schema: "drizzle",
        name: "__drizzle_migrations",
        kind: "composite",
        owner: "learncoding_owner",
      },
    ],
  );
  assert.equal(
    CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.inventory.sequences.filter(
      (sequence) => sequence.schema === "public",
    ).length,
    0,
  );
  assert.deepEqual(
    CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.provenance.expected,
    {
      publicTables: 127,
      publicColumns: 1_489,
      publicTypes: 140,
      publicRoutines: 76,
      publicSequences: 0,
    },
  );
  assert.equal(
    CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.provenance.inventorySources[0]
      .physicalOrderSha256,
    "b64e0934d046eb1cc4b1609ffbaf309cccdc2fa12fd4154ace19c9f63a0859af",
  );
});

test("pins independently reconstructed 0069 authority counts and digests", () => {
  const policy = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
  const enums = policy.inventory.types
    .filter((entry) => entry.kind === "enum")
    .map(({ identity, values }) => ({ identity, values }));
  const routineIdentities = policy.inventory.routines.map(
    (entry) => entry.identity,
  );

  assert.deepEqual(
    {
      roles: policy.roles.length,
      memberships: policy.memberships.length,
      grants: policy.grants.length,
      defaultAclRows: policy.defaultAclRows.length,
      defaultAcls: policy.defaultAcls.length,
      publicTypes: policy.inventory.types.filter(
        (entry) => entry.schema === "public",
      ).length,
      managedTypes: policy.inventory.types.length,
      routines: routineIdentities.length,
      enums: enums.length,
      enumLabels: enums.reduce(
        (count, entry) => count + entry.values.length,
        0,
      ),
    },
    {
      roles: 6,
      memberships: 1,
      grants: 3_213,
      defaultAclRows: 7,
      defaultAcls: 28,
      publicTypes: 140,
      managedTypes: 141,
      routines: 76,
      enums: 13,
      enumLabels: 78,
    },
  );
  const compareAscii = (left, right) =>
    left < right ? -1 : left > right ? 1 : 0;
  const tableColumnFacts = policy.inventory.tables
    .map(({ identity, columns }) => ({
      identity,
      columns: columns
        .map(({ identity: columnIdentity, name, ordinal }) => ({
          identity: columnIdentity,
          name,
          ordinal,
        }))
        .toSorted(
          (left, right) =>
            left.ordinal - right.ordinal ||
            compareAscii(left.identity, right.identity),
        ),
    }))
    .toSorted((left, right) => compareAscii(left.identity, right.identity));
  assert.equal(tableColumnFacts.length, 128);
  assert.equal(
    tableColumnFacts.reduce((count, table) => count + table.columns.length, 0),
    1_492,
  );
  assert.equal(
    createHash("sha256")
      .update(`${JSON.stringify(tableColumnFacts)}\n`, "utf8")
      .digest("hex"),
    "47d662eab56331ce714127a0e3b020eb2c1e0e70c19005cf9654226fc7738d0c",
  );
  assert.deepEqual(
    {
      roles: fingerprintDatabaseRuntimeCapabilities(policy.roles),
      memberships: fingerprintDatabaseRuntimeCapabilities(policy.memberships),
      grants: fingerprintDatabaseRuntimeCapabilities(policy.grants),
      defaultAclRows: fingerprintDatabaseRuntimeCapabilities(
        policy.defaultAclRows,
      ),
      defaultAcls: fingerprintDatabaseRuntimeCapabilities(policy.defaultAcls),
      types: fingerprintDatabaseRuntimeCapabilities(policy.inventory.types),
      routines: fingerprintDatabaseRuntimeCapabilities(routineIdentities),
      enums: fingerprintDatabaseRuntimeCapabilities(enums),
    },
    {
      roles: "b3e9583f198a9afebe7870a5feefd059459b86486c7e47ef3f6ffaad91eefe36",
      memberships:
        "fc4a87027f6c9fdef31a85e92844288d72e0900ab924f0bda178b443ca7f5a7c",
      grants:
        "c526c0eb406df10a32ef99c9445dc345ce9373a9553646d78d624f3887b12c08",
      defaultAclRows:
        "700207ccf9e4790442c586343b235a6d1778f5dad5463c43a89f1bd726374de7",
      defaultAcls:
        "a2b591a761e6f4e1e5e1b1c4b03cc53abd480191b345a741cfdc2892e543c201",
      types: "b831dd25967bf48e1d15ef5f1e3273c72d714a5a4f2e95aa310a464d042160fd",
      routines:
        "f6090e4701c361678f475cfdf7b9f56d162edb09ee5cee71cf50455ae7ef1bfb",
      enums: "38eaed74f67a47298214fb8995b4fea131fd4ec794897ed724da11ffeaf21eb7",
    },
  );
});

test("rejects unreviewed snapshot, enum, attnum, and journal authority", async () => {
  const source = await readFile(
    new URL("./database-runtime-capabilities.mjs", import.meta.url),
    "utf8",
  );
  const [reviewedSnapshot, reviewedJournal, reviewedPhysical] =
    await Promise.all([
      readFile(
        new URL("../drizzle/meta/0069_snapshot.json", import.meta.url),
        "utf8",
      ).then(JSON.parse),
      readFile(
        new URL("../drizzle/meta/_journal.json", import.meta.url),
        "utf8",
      ).then(JSON.parse),
      readFile(
        new URL(
          "../drizzle/meta/0069_public_column_attnums.json",
          import.meta.url,
        ),
        "utf8",
      ).then(JSON.parse),
    ]);

  async function assertRejected(label, mutate, message) {
    const mutationRoot = await mkdtemp(
      path.join(tmpdir(), `codestead-capability-pin-${label}-`),
    );
    try {
      const scripts = path.join(mutationRoot, "scripts");
      const metadata = path.join(mutationRoot, "drizzle", "meta");
      await mkdir(scripts, { recursive: true });
      await mkdir(metadata, { recursive: true });
      const snapshot = clone(reviewedSnapshot);
      const journal = clone(reviewedJournal);
      const physical = clone(reviewedPhysical);
      mutate({ snapshot, journal, physical });
      const modulePath = path.join(
        scripts,
        "database-runtime-capabilities.mjs",
      );
      await Promise.all([
        writeFile(modulePath, source),
        writeFile(
          path.join(metadata, "0069_snapshot.json"),
          JSON.stringify(snapshot),
        ),
        writeFile(
          path.join(metadata, "_journal.json"),
          JSON.stringify(journal),
        ),
        writeFile(
          path.join(metadata, "0069_public_column_attnums.json"),
          JSON.stringify(physical),
        ),
      ]);
      await assert.rejects(
        import(`${pathToFileURL(modulePath).href}?${label}=${Date.now()}`),
        {
          name: "DatabaseRuntimeCapabilityValidationError",
          message,
        },
      );
    } finally {
      await rm(mutationRoot, { recursive: true, force: true });
    }
  }

  await assertRejected(
    "snapshot-table",
    ({ snapshot }) => {
      snapshot.tables["public.unreviewed_runtime_authority"] = {
        name: "unreviewed_runtime_authority",
        schema: "public",
        columns: {
          id: {
            name: "id",
            type: "uuid",
            primaryKey: true,
            notNull: true,
          },
        },
        indexes: {},
        foreignKeys: {},
        compositePrimaryKeys: {},
        uniqueConstraints: {},
        policies: {},
        checkConstraints: {},
        isRLSEnabled: false,
      };
    },
    /physical column authority/u,
  );
  await assertRejected(
    "snapshot-enum",
    ({ snapshot }) => {
      const enumIdentity = Object.keys(snapshot.enums)[0];
      snapshot.enums[enumIdentity].values.push("unreviewed_enum_authority");
    },
    /inventory pin/u,
  );
  await assertRejected(
    "physical-attnum",
    ({ physical }) => {
      physical.tables[0].columns[0].attnum = 2;
    },
    /inventory pin/u,
  );
  await assertRejected(
    "journal-tag",
    ({ journal }) => {
      journal.entries.at(-1).tag = "0069_unreviewed_suffix";
    },
    /inventory pin/u,
  );
});

test("exports deeply frozen JSON-domain policy and symbolic session authority", () => {
  assert.equal(DATABASE_RUNTIME_CAPABILITY_SCHEMA_VERSION, 1);
  assert.deepEqual(BOOTSTRAP_SESSION_AUTHORITY, {
    kind: "bootstrap-session",
  });
  assertDeeplyFrozenJson(BOOTSTRAP_SESSION_AUTHORITY);
  assertDeeplyFrozenJson(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
  assertDeeplyFrozenJson(POST_CONTRACT_DATABASE_RUNTIME_CAPABILITIES);
  assertDeeplyFrozenJson(
    PREDECESSOR_0070_DATABASE_RUNTIME_CAPABILITY_ALLOWANCE,
  );
  assert.doesNotThrow(() =>
    validateDatabaseRuntimeCapabilities(
      CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
    ),
  );
  assert.doesNotThrow(() =>
    validateDatabaseRuntimeCapabilities(
      clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES),
    ),
  );
  assert.doesNotThrow(() =>
    validateDatabaseRuntimeCapabilities(
      POST_CONTRACT_DATABASE_RUNTIME_CAPABILITIES,
    ),
  );
  assert.doesNotThrow(() =>
    validateDatabaseRuntimeCapabilityAllowance(
      PREDECESSOR_0070_DATABASE_RUNTIME_CAPABILITY_ALLOWANCE,
    ),
  );
});

test("the declaration surface exactly covers runtime values without unsafe any", async () => {
  const declarationPath = new URL(
    "./database-runtime-capabilities.d.mts",
    import.meta.url,
  );
  const declarationSource = await readFile(declarationPath, "utf8");
  const declarationFile = ts.createSourceFile(
    declarationPath.pathname,
    declarationSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hasExportModifier = (node) =>
    node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ) === true;
  const declaredValues = [];
  for (const statement of declarationFile.statements) {
    if (!hasExportModifier(statement)) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        assert.equal(
          ts.isIdentifier(declaration.name),
          true,
          "exported runtime declarations must use identifiers",
        );
        declaredValues.push(declaration.name.text);
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      declaredValues.push(statement.name.text);
    }
  }
  const runtime = await import("./database-runtime-capabilities.mjs");
  assert.deepEqual(
    declaredValues.toSorted(),
    Object.keys(runtime).toSorted(),
    "runtime values and declaration values must remain in exact parity",
  );
  const unsafeAnyLocations = [];
  const inspect = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const position = declarationFile.getLineAndCharacterOfPosition(
        node.getStart(declarationFile),
      );
      unsafeAnyLocations.push(`${position.line + 1}:${position.character + 1}`);
    }
    ts.forEachChild(node, inspect);
  };
  inspect(declarationFile);
  assert.deepEqual(
    unsafeAnyLocations,
    [],
    "the capability declaration must not expose any",
  );
});

test("the declaration compiles every runtime export and nested result contract", async () => {
  const fixtureRoot = await mkdtemp(
    path.join(tmpdir(), "codestead-capability-declaration-"),
  );
  try {
    const modulePath = fileURLToPath(
      new URL("./database-runtime-capabilities.mjs", import.meta.url),
    );
    let moduleSpecifier = path
      .relative(fixtureRoot, modulePath)
      .replaceAll(path.sep, "/");
    if (!moduleSpecifier.startsWith(".")) {
      moduleSpecifier = `./${moduleSpecifier}`;
    }
    const fixturePath = path.join(fixtureRoot, "contract.mts");
    await writeFile(
      fixturePath,
      `
import {
  BOOTSTRAP_SESSION_AUTHORITY,
  CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
  CURRENT_0069_REVIEWED_MIGRATION_TAG,
  DATABASE_RUNTIME_CAPABILITY_PHASES,
  DATABASE_RUNTIME_CAPABILITY_SCHEMA_VERSION,
  POST_CONTRACT_DATABASE_RUNTIME_CAPABILITIES,
  PREDECESSOR_0070_DATABASE_RUNTIME_CAPABILITY_ALLOWANCE,
  DatabaseRuntimeCapabilityPhaseError,
  DatabaseRuntimeCapabilityValidationError,
  canonicalDatabaseRuntimeCapabilitiesJson,
  canonicalizeDatabaseRuntimeCapabilities,
  classifyDatabaseRuntimeCapabilityGrantDelta,
  classifyDatabaseRuntimeCapabilityPredecessorDelta,
  diffDatabaseRuntimeCapabilities,
  fingerprintDatabaseRuntimeCapabilities,
  planDatabaseRuntimeCapabilityReconciliation,
  resolveDatabaseRuntimeCapabilityPhase,
  validateDatabaseRuntimeCapabilities,
  validateDatabaseRuntimeCapabilityAllowance,
} from ${JSON.stringify(moduleSpecifier)};
import type {
  DatabaseRuntimeCapabilityCatalog,
  DatabaseRuntimeCapabilityJsonValue,
} from ${JSON.stringify(moduleSpecifier)};

const schemaVersion: 1 = DATABASE_RUNTIME_CAPABILITY_SCHEMA_VERSION;
const reviewedTag: "0069_mail_outbox_guarded_delivery_authority" =
  CURRENT_0069_REVIEWED_MIGRATION_TAG;
const bootstrapKind: "bootstrap-session" = BOOTSTRAP_SESSION_AUTHORITY.kind;
const phase = DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069;
const catalog: DatabaseRuntimeCapabilityCatalog =
  CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
const canonical: DatabaseRuntimeCapabilityJsonValue =
  canonicalizeDatabaseRuntimeCapabilities(catalog);
const canonicalJson: string =
  canonicalDatabaseRuntimeCapabilitiesJson(canonical);
const fingerprint: string =
  fingerprintDatabaseRuntimeCapabilities(catalog);
const validated = validateDatabaseRuntimeCapabilities(catalog);
const owner: string = validated.inventory.tables[0]!.owner;
const enumValues = validated.inventory.types.find(
  (entry) => entry.kind === "enum",
);
if (enumValues?.kind === "enum") {
  const firstEnumValue: string | undefined = enumValues.values[0];
  void firstEnumValue;
}
const drift = diffDatabaseRuntimeCapabilities(
  CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
  catalog,
);
const observedGrantable: boolean | undefined =
  drift.extra.grants[0]?.grantable;
const policyGrant = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.grants[0]!;
const grantDelta = classifyDatabaseRuntimeCapabilityGrantDelta({
  phase,
  expectedGrants: [policyGrant],
  observedGrants: [policyGrant],
});
const predecessorDelta = classifyDatabaseRuntimeCapabilityPredecessorDelta({
  phase,
  collection: "roles",
  expected: CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.roles,
  observed: CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.roles,
});
const plan = planDatabaseRuntimeCapabilityReconciliation({
  phase,
  policy: CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
  catalog,
});
for (const mutation of plan.mutations) {
  if (mutation.action === "replace") {
    const replacementIdentity: string = mutation.identity;
    void replacementIdentity;
  }
}
const allowance = validateDatabaseRuntimeCapabilityAllowance(
  PREDECESSOR_0070_DATABASE_RUNTIME_CAPABILITY_ALLOWANCE,
);
const resolution = resolveDatabaseRuntimeCapabilityPhase({
  journalPresent: false,
  reviewedMigrationTail: null,
  reviewedPrefixExact: false,
  reviewedMigrationCount: 0,
  reviewedMigrationLedgerSha256:
    "20b480c7dd694d6e8e243704f14aeb05aa42fda4c5b7e863f6c357bf095a2551",
});
if (resolution.phase === DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION) {
  const absentPolicy: null = resolution.policy;
  void absentPolicy;
}
const validationError: Error =
  new DatabaseRuntimeCapabilityValidationError("validation");
const phaseError: Error = new DatabaseRuntimeCapabilityPhaseError("phase");
void [
  schemaVersion,
  reviewedTag,
  bootstrapKind,
  canonicalJson,
  fingerprint,
  owner,
  observedGrantable,
  grantDelta,
  predecessorDelta,
  allowance,
  POST_CONTRACT_DATABASE_RUNTIME_CAPABILITIES,
  validationError,
  phaseError,
];
`,
      "utf8",
    );
    const program = ts.createProgram({
      rootNames: [fixturePath],
      options: {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        target: ts.ScriptTarget.ES2022,
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      assert.fail(
        ts.formatDiagnosticsWithColorAndContext(diagnostics, {
          getCanonicalFileName: (fileName) => fileName,
          getCurrentDirectory: () => process.cwd(),
          getNewLine: () => "\n",
        }),
      );
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("models normalized owner ACLs and physical default ACL rows exactly", () => {
  const policy = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
  assert.equal(
    policy.inventory.types.filter((entry) => entry.schema === "public").length,
    140,
  );
  assert.equal(policy.inventory.types.length, 141);
  const ownerGrants = policy.grants.filter(
    (entry) => entry.grantee === "learncoding_owner",
  );
  assert.equal(ownerGrants.length, 1_251);
  const ownerPrivileges = (objectKind, object) =>
    ownerGrants
      .filter(
        (entry) => entry.objectKind === objectKind && entry.object === object,
      )
      .map((entry) => entry.privilege)
      .toSorted();
  assert.deepEqual(ownerPrivileges("database", "@database"), [
    "CONNECT",
    "CREATE",
    "TEMPORARY",
  ]);
  assert.deepEqual(ownerPrivileges("schema", "public"), ["CREATE", "USAGE"]);
  assert.deepEqual(
    ownerPrivileges("table", policy.inventory.tables[0].identity),
    [
      "DELETE",
      "INSERT",
      "MAINTAIN",
      "REFERENCES",
      "SELECT",
      "TRIGGER",
      "TRUNCATE",
      "UPDATE",
    ],
  );
  assert.deepEqual(
    ownerPrivileges("sequence", policy.inventory.sequences[0].identity),
    ["SELECT", "UPDATE", "USAGE"],
  );
  assert.deepEqual(
    ownerPrivileges("routine", policy.inventory.routines[0].identity),
    ["EXECUTE"],
  );
  assert.deepEqual(ownerPrivileges("type", "drizzle.__drizzle_migrations"), [
    "USAGE",
  ]);
  assert.deepEqual(
    policy.defaultAclRows.map((entry) => entry.identity),
    [
      "learncoding_owner|@global|routine",
      "learncoding_owner|@global|type",
      "bootstrap-session|@global|routine",
      "bootstrap-session|@global|type",
      "learncoding_owner|public|table",
      "learncoding_owner|public|sequence",
      "learncoding_owner|public|type",
    ],
  );
  assert.deepEqual(
    POST_CONTRACT_DATABASE_RUNTIME_CAPABILITIES.defaultAclRows.map(
      (entry) => entry.identity,
    ),
    [
      "learncoding_owner|@global|routine",
      "learncoding_owner|@global|type",
      "bootstrap-session|@global|routine",
      "bootstrap-session|@global|type",
    ],
  );
});

test("schema validation rejects closed-world and authority mutations", () => {
  const firstTable =
    CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.inventory.tables[0];
  const firstGrant = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.grants[0];
  const cases = [
    [
      "unknown key",
      (manifest) => {
        manifest.unreviewed = true;
      },
    ],
    [
      "wildcard object",
      (manifest) => {
        manifest.grants[0].object = "public.*";
      },
    ],
    [
      "ALL privilege",
      (manifest) => {
        manifest.grants[0].privilege = "ALL";
      },
    ],
    [
      "duplicate tuple",
      (manifest) => {
        manifest.grants.push(clone(firstGrant));
      },
    ],
    [
      "dangling object",
      (manifest) => {
        manifest.grants[0].object = "public.not_reviewed";
      },
    ],
    [
      "dangling column",
      (manifest) => {
        manifest.grants.push({
          objectKind: "column",
          object: `${firstTable.identity}.not_reviewed`,
          grantor: "learncoding_owner",
          grantee: "learncoding_app",
          privilege: "SELECT",
          grantable: false,
        });
      },
    ],
    [
      "unknown object kind",
      (manifest) => {
        manifest.grants[0].objectKind = "cluster";
      },
    ],
    [
      "unknown privilege",
      (manifest) => {
        manifest.grants[0].privilege = "BECOME";
      },
    ],
    [
      "grant option",
      (manifest) => {
        manifest.grants[0].grantable = true;
      },
    ],
    [
      "PUBLIC authority",
      (manifest) => {
        manifest.grants[0].grantee = "PUBLIC";
      },
    ],
    [
      "delegated grantor",
      (manifest) => {
        manifest.grants[0].grantor = "learncoding_app";
      },
    ],
    [
      "unknown role",
      (manifest) => {
        manifest.grants[0].grantee = "learncoding_unknown";
      },
    ],
    [
      "unknown default ACL creator",
      (manifest) => {
        manifest.defaultAcls[0].creator = "learncoding_unknown";
      },
    ],
    [
      "schema-local broad default ACL",
      (manifest) => {
        manifest.defaultAcls[0].schema = "public";
      },
    ],
    [
      "default ACL grant option",
      (manifest) => {
        manifest.defaultAcls[0].grantable = true;
      },
    ],
    [
      "PUBLIC default ACL authority",
      (manifest) => {
        const entry = manifest.defaultAcls[0];
        entry.grantee = "PUBLIC";
        entry.identity = [
          typeof entry.creator === "string"
            ? entry.creator
            : entry.creator.kind,
          entry.schema ?? "@global",
          entry.objectKind,
          "PUBLIC",
          entry.privilege,
        ].join("|");
      },
    ],
    [
      "missing provenance",
      (manifest) => {
        delete manifest.provenance;
      },
    ],
    [
      "foundation policy object",
      (manifest) => {
        manifest.phase = DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION;
      },
    ],
    [
      "phase and migration tail mismatch",
      (manifest) => {
        manifest.ledger.reviewedMigrationTail = "0071";
      },
    ],
    [
      "current policy marked unavailable",
      (manifest) => {
        manifest.available = false;
      },
    ],
    [
      "owner login escalation",
      (manifest) => {
        manifest.roles[0].login = true;
        manifest.roles[0].credential = "scram-managed";
      },
    ],
    [
      "unreviewed role",
      (manifest) => {
        manifest.roles.push({
          ...clone(manifest.roles[1]),
          identity: "learncoding_unknown",
          name: "learncoding_unknown",
        });
      },
    ],
    [
      "owner to application SET ROLE edge",
      (manifest) => {
        manifest.memberships.push({
          ...clone(manifest.memberships[0]),
          identity: "learncoding_owner->learncoding_app",
          member: "learncoding_app",
        });
      },
    ],
    [
      "missing sole reviewed membership",
      (manifest) => {
        manifest.memberships = [];
      },
    ],
    [
      "application schema CREATE authority",
      (manifest) => {
        manifest.grants.push({
          objectKind: "schema",
          object: "public",
          grantor: "learncoding_owner",
          grantee: "learncoding_app",
          privilege: "CREATE",
          grantable: false,
        });
      },
    ],
    [
      "forged default ACL identity",
      (manifest) => {
        manifest.defaultAcls[0].identity = "forged";
      },
    ],
    [
      "missing Drizzle schema",
      (manifest) => {
        manifest.inventory.schemas = manifest.inventory.schemas.filter(
          (entry) => entry.identity !== "drizzle",
        );
      },
    ],
    [
      "unreviewed zero-column table",
      (manifest) => {
        manifest.inventory.tables.push({
          identity: "public.unreviewed",
          schema: "public",
          name: "unreviewed",
          owner: "learncoding_owner",
          columns: [],
        });
      },
    ],
    [
      "duplicate column ordinal",
      (manifest) => {
        manifest.inventory.tables[0].columns[1].ordinal =
          manifest.inventory.tables[0].columns[0].ordinal;
      },
    ],
    [
      "malformed grant collection",
      (manifest) => {
        manifest.grants = "not-an-array";
      },
    ],
    [
      "non-finite provenance number",
      (manifest) => {
        manifest.provenance.expected.publicTables = Number.NaN;
      },
    ],
    [
      "accessor-backed provenance",
      (manifest) => {
        const provenance = manifest.provenance;
        Object.defineProperty(manifest, "provenance", {
          enumerable: true,
          get: () => provenance,
        });
      },
    ],
    [
      "delegated default ACL grantor",
      (manifest) => {
        manifest.defaultAcls[0].grantor = "learncoding_app";
      },
    ],
    [
      "null role entry",
      (manifest) => {
        manifest.roles = [null];
      },
    ],
    [
      "scalar database entry",
      (manifest) => {
        manifest.inventory.databases = ["not-an-object"];
      },
    ],
    [
      "null schema entry",
      (manifest) => {
        manifest.inventory.schemas = [null];
      },
    ],
    [
      "scalar sequence entry",
      (manifest) => {
        manifest.inventory.sequences = [42];
      },
    ],
    [
      "null type entry",
      (manifest) => {
        manifest.inventory.types = [null];
      },
    ],
    [
      "scalar routine entry",
      (manifest) => {
        manifest.inventory.routines = [false];
      },
    ],
    [
      "null membership entry",
      (manifest) => {
        manifest.memberships = [null];
      },
    ],
    [
      "duplicate physical default ACL row",
      (manifest) => {
        manifest.defaultAclRows.push(clone(manifest.defaultAclRows[0]));
      },
    ],
    [
      "default ACL tuple without its physical row",
      (manifest) => {
        const rowIdentity = defaultAclRowIdentity(manifest.defaultAcls[0]);
        manifest.defaultAclRows = manifest.defaultAclRows.filter(
          (entry) => entry.identity !== rowIdentity,
        );
      },
    ],
  ];

  for (const [label, mutate] of cases) {
    const manifest = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
    mutate(manifest);
    assert.throws(
      () => validateDatabaseRuntimeCapabilities(manifest),
      { name: "DatabaseRuntimeCapabilityValidationError" },
      label,
    );
  }
});

test("canonicalization is code-point deterministic and fingerprint sensitive", () => {
  const oracleValue = {
    z: 3,
    "\u00e4": 2,
    items: [{ name: "\u03b2" }, { name: "A" }],
    a: 1,
  };
  const oracleJson =
    '{"a":1,"items":[{"name":"A"},{"name":"\u03b2"}],"z":3,"\u00e4":2}';
  const oracleSha256 = createHash("sha256")
    .update(`${oracleJson}\n`, "utf8")
    .digest("hex");
  assert.equal(
    canonicalDatabaseRuntimeCapabilitiesJson(oracleValue),
    oracleJson,
  );
  assert.equal(
    fingerprintDatabaseRuntimeCapabilities(oracleValue),
    oracleSha256,
  );

  const scalarOracle = {
    "\u{10000}": 2,
    "\ue000": 1,
  };
  assert.equal(
    canonicalDatabaseRuntimeCapabilitiesJson(scalarOracle),
    '{"":1,"𐀀":2}',
  );

  const manifest = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
  const reversed = reverseUnorderedCollections(manifest);
  assert.deepEqual(
    canonicalizeDatabaseRuntimeCapabilities(reversed),
    canonicalizeDatabaseRuntimeCapabilities(manifest),
  );
  assert.equal(
    canonicalDatabaseRuntimeCapabilitiesJson(reversed),
    canonicalDatabaseRuntimeCapabilitiesJson(manifest),
  );
  assert.equal(
    fingerprintDatabaseRuntimeCapabilities(reversed),
    fingerprintDatabaseRuntimeCapabilities(manifest),
  );
  assert.match(
    fingerprintDatabaseRuntimeCapabilities(manifest),
    /^[0-9a-f]{64}$/u,
  );

  const ordered = { values: ["first", "second"] };
  const reordered = { values: ["second", "first"] };
  assert.notEqual(
    fingerprintDatabaseRuntimeCapabilities(ordered),
    fingerprintDatabaseRuntimeCapabilities(reordered),
  );

  const illegalManifestMutation = clone(manifest);
  illegalManifestMutation.grants[0].privilege =
    illegalManifestMutation.grants[0].privilege === "CONNECT"
      ? "CREATE"
      : "CONNECT";
  assert.throws(
    () => fingerprintDatabaseRuntimeCapabilities(illegalManifestMutation),
    { name: "DatabaseRuntimeCapabilityValidationError" },
  );
  const duplicateManifest = clone(manifest);
  duplicateManifest.grants.push(clone(duplicateManifest.grants[0]));
  for (const canonicalizer of [
    canonicalizeDatabaseRuntimeCapabilities,
    canonicalDatabaseRuntimeCapabilitiesJson,
    fingerprintDatabaseRuntimeCapabilities,
  ]) {
    assert.throws(
      () => canonicalizer(duplicateManifest),
      { name: "DatabaseRuntimeCapabilityValidationError" },
      canonicalizer.name,
    );
  }

  const sparse = [];
  sparse.length = 1;
  const cycle = {};
  cycle.self = cycle;
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get: () => 1,
  });
  const symbolKey = { safe: true };
  symbolKey[Symbol("secret")] = true;
  for (const value of [
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: -0 },
    new Date(0),
    new Map([["key", "value"]]),
    sparse,
    cycle,
    accessor,
    symbolKey,
    { 10: "ten", 2: "two" },
  ]) {
    assert.throws(() => canonicalDatabaseRuntimeCapabilitiesJson(value), {
      name: "DatabaseRuntimeCapabilityValidationError",
    });
  }
});

test("diff reports exact missing, extra, owner, membership, grant, and default ACL drift", () => {
  const expected = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
  const observed = clone(expected);
  const missingTable = observed.inventory.tables.pop();
  const extraTable = clone(observed.inventory.tables[0]);
  extraTable.identity = "public.zzz_unknown";
  extraTable.name = "zzz_unknown";
  extraTable.columns = [
    {
      identity: "public.zzz_unknown.id",
      name: "id",
      ordinal: 1,
    },
  ];
  observed.inventory.tables.push(extraTable);
  observed.inventory.tables[0].owner = "learncoding_app";
  observed.memberships[0].setOption = !observed.memberships[0].setOption;
  const missingGrant = observed.grants.pop();
  const extraGrant = {
    objectKind: "database",
    object: "@database",
    grantor: "learncoding_owner",
    grantee: "learncoding_app",
    privilege: "TEMPORARY",
    grantable: false,
  };
  observed.grants.push(extraGrant);
  const missingDefaultAclRow = observed.defaultAclRows.pop();
  const missingDefaultAcls = expected.defaultAcls
    .filter(
      (entry) => defaultAclRowIdentity(entry) === missingDefaultAclRow.identity,
    )
    .toSorted((left, right) =>
      left.identity < right.identity
        ? -1
        : left.identity > right.identity
          ? 1
          : 0,
    );
  observed.defaultAcls = observed.defaultAcls.filter(
    (entry) => defaultAclRowIdentity(entry) !== missingDefaultAclRow.identity,
  );
  const extraDefaultAclRow = {
    identity: "learncoding_app|@global|routine",
    creator: "learncoding_app",
    schema: null,
    objectKind: "routine",
  };
  observed.defaultAclRows.push(extraDefaultAclRow);

  const drift = diffDatabaseRuntimeCapabilities(expected, observed);
  assert.equal(drift.matches, false);
  assert.deepEqual(
    drift.missing.inventory.tables.map((table) => table.identity),
    [missingTable.identity],
  );
  assert.deepEqual(
    drift.extra.inventory.tables.map((table) => table.identity),
    ["public.zzz_unknown"],
  );
  assert.equal(drift.mismatched.owners.length, 1);
  assert.equal(drift.mismatched.memberships.length, 1);
  assert.deepEqual(drift.missing.grants, [missingGrant]);
  assert.deepEqual(drift.extra.grants, [extraGrant]);
  assert.deepEqual(drift.missing.defaultAcls, missingDefaultAcls);
  assert.deepEqual(drift.missing.defaultAclRows, [missingDefaultAclRow]);
  assert.deepEqual(drift.extra.defaultAclRows, [extraDefaultAclRow]);
  assert.equal(
    drift.extra.inventory.columns.some(
      (column) => column.identity === "public.zzz_unknown.id",
    ),
    true,
  );
});

test("inventory planning fails closed for missing and extra schema, sequence, type, and routine identities", () => {
  const expected = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
  const extras = {
    schemas: {
      identity: "unreviewed",
      name: "unreviewed",
      owner: "learncoding_owner",
    },
    sequences: {
      identity: "public.unreviewed_sequence",
      schema: "public",
      name: "unreviewed_sequence",
      owner: "learncoding_owner",
    },
    types: {
      identity: "public.unreviewed_type",
      schema: "public",
      name: "unreviewed_type",
      owner: "learncoding_owner",
      kind: "composite",
    },
    routines: {
      identity: "public.unreviewed_routine()",
      schema: "public",
      signature: "unreviewed_routine()",
      kind: "function",
      owner: "learncoding_owner",
    },
  };

  for (const collection of Object.keys(extras)) {
    const missing = clone(expected);
    const removed = missing.inventory[collection].pop();
    const missingPlan = planDatabaseRuntimeCapabilityReconciliation({
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
      policy: expected,
      catalog: missing,
    });
    assert.equal(missingPlan.blocked, true, `${collection} missing`);
    assert.deepEqual(missingPlan.mutations, [], `${collection} missing`);
    assert.deepEqual(
      missingPlan.drift.missing.inventory[collection].map(
        (entry) => entry.identity,
      ),
      [removed.identity],
      `${collection} missing`,
    );

    const extra = clone(expected);
    extra.inventory[collection].push(extras[collection]);
    const extraPlan = planDatabaseRuntimeCapabilityReconciliation({
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
      policy: expected,
      catalog: extra,
    });
    assert.equal(extraPlan.blocked, true, `${collection} extra`);
    assert.deepEqual(extraPlan.mutations, [], `${collection} extra`);
    assert.deepEqual(
      extraPlan.drift.extra.inventory[collection].map(
        (entry) => entry.identity,
      ),
      [extras[collection].identity],
      `${collection} extra`,
    );
  }
});

test("diff detects every same-identity definition drift and rejects duplicates", () => {
  const expected = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
  const mutations = [
    [
      "databases",
      (catalog) => {
        catalog.inventory.databases[0].owner = "learncoding_app";
      },
    ],
    [
      "schemas",
      (catalog) => {
        catalog.inventory.schemas[0].name = "renamed";
      },
    ],
    [
      "tables",
      (catalog) => {
        catalog.inventory.tables[0].name = "renamed";
      },
    ],
    [
      "columns",
      (catalog) => {
        catalog.inventory.tables[0].columns[0].name = "renamed";
      },
    ],
    [
      "sequences",
      (catalog) => {
        catalog.inventory.sequences[0].name = "renamed";
      },
    ],
    [
      "types",
      (catalog) => {
        catalog.inventory.types
          .find((entry) => entry.kind === "enum")
          .values.reverse();
      },
    ],
    [
      "routines",
      (catalog) => {
        catalog.inventory.routines[0].kind = "procedure";
      },
    ],
  ];
  for (const [collection, mutate] of mutations) {
    const catalog = clone(expected);
    mutate(catalog);
    const drift = diffDatabaseRuntimeCapabilities(expected, catalog);
    assert.equal(drift.matches, false, collection);
    assert.ok(drift.mismatched.inventory[collection].length > 0, collection);
  }

  const physicalOrdinalDrift = clone(expected);
  physicalOrdinalDrift.inventory.tables[0].columns[0].ordinal = 99;
  const physicalOrdinalDiff = diffDatabaseRuntimeCapabilities(
    expected,
    physicalOrdinalDrift,
  );
  assert.equal(physicalOrdinalDiff.matches, false);
  assert.ok(physicalOrdinalDiff.mismatched.inventory.tables.length > 0);

  const reorderedColumns = clone(expected);
  reorderedColumns.inventory.tables[0].columns.reverse();
  assert.equal(
    diffDatabaseRuntimeCapabilities(expected, reorderedColumns).matches,
    true,
  );

  for (const [label, duplicate] of [
    [
      "table",
      (catalog) =>
        catalog.inventory.tables.push(clone(catalog.inventory.tables[0])),
    ],
    [
      "column",
      (catalog) =>
        catalog.inventory.tables[0].columns.push(
          clone(catalog.inventory.tables[0].columns[0]),
        ),
    ],
    [
      "type",
      (catalog) =>
        catalog.inventory.types.push(clone(catalog.inventory.types[0])),
    ],
    ["role", (catalog) => catalog.roles.push(clone(catalog.roles[0]))],
    [
      "default ACL row",
      (catalog) =>
        catalog.defaultAclRows.push(clone(catalog.defaultAclRows[0])),
    ],
    [
      "membership",
      (catalog) => catalog.memberships.push(clone(catalog.memberships[0])),
    ],
  ]) {
    const catalog = clone(expected);
    duplicate(catalog);
    assert.throws(
      () => diffDatabaseRuntimeCapabilities(expected, catalog),
      { name: "DatabaseRuntimeCapabilityValidationError" },
      label,
    );
  }
});

test("comparable catalogs reject malformed grant tuples before planning", () => {
  for (const [label, mutate] of [
    [
      "unknown key",
      (grant) => {
        grant.unreviewed = true;
      },
    ],
    [
      "unknown object kind",
      (grant) => {
        grant.objectKind = "cluster";
      },
    ],
    [
      "unknown privilege",
      (grant) => {
        grant.privilege = "BECOME";
      },
    ],
    [
      "dangling object",
      (grant) => {
        grant.object = "public.unreviewed";
      },
    ],
    [
      "delegated grantor",
      (grant) => {
        grant.grantor = "learncoding_app";
      },
    ],
  ]) {
    const catalog = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
    mutate(catalog.grants[0]);
    assert.throws(
      () =>
        planDatabaseRuntimeCapabilityReconciliation({
          phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
          policy: CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
          catalog,
        }),
      { name: "DatabaseRuntimeCapabilityValidationError" },
      label,
    );
  }

  const duplicate = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
  duplicate.grants.push(clone(duplicate.grants[0]));
  assert.throws(
    () =>
      planDatabaseRuntimeCapabilityReconciliation({
        phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
        policy: CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
        catalog: duplicate,
      }),
    {
      name: "DatabaseRuntimeCapabilityValidationError",
      message: /duplicate observed grant tuple/u,
    },
  );

  const conflicting = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
  conflicting.grants.push({
    ...clone(conflicting.grants[0]),
    grantable: true,
  });
  assert.throws(
    () =>
      planDatabaseRuntimeCapabilityReconciliation({
        phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
        policy: CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
        catalog: conflicting,
      }),
    {
      name: "DatabaseRuntimeCapabilityValidationError",
      message: /duplicate observed grant authority/u,
    },
  );

  const repairable = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
  repairable.grants[0].grantable = true;
  const repairPlan = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy: CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
    catalog: repairable,
  });
  assert.equal(repairPlan.blocked, false);
  assert.deepEqual(
    repairPlan.mutations
      .filter((mutation) => mutation.collection === "grants")
      .map((mutation) => [
        mutation.action,
        mutation.value.grantable,
      ]),
    [
      ["add", false],
      ["remove", true],
    ],
  );
});

test("comparable catalogs reject unknown observed table and column keys", () => {
  for (const [label, mutate] of [
    [
      "table",
      (catalog) => {
        catalog.inventory.tables[0].unreviewedAuthority = true;
      },
    ],
    [
      "column",
      (catalog) => {
        catalog.inventory.tables[0].columns[0].unreviewedAuthority = true;
      },
    ],
  ]) {
    const catalog = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
    mutate(catalog);
    assert.throws(
      () =>
        planDatabaseRuntimeCapabilityReconciliation({
          phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
          policy: CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
          catalog,
        }),
      {
        name: "DatabaseRuntimeCapabilityValidationError",
        message: new RegExp(`unknown catalog ${label} key`, "u"),
      },
      label,
    );
  }
});

test("comparable catalog metadata is bound before diffing or planning", () => {
  for (const [label, mutate] of [
    ["schemaVersion", (catalog) => {
      catalog.schemaVersion = 2;
    }],
    ["contract", (catalog) => {
      catalog.contract = "unreviewed-contract";
    }],
    ["phase", (catalog) => {
      catalog.phase = DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071;
    }],
    ["available", (catalog) => {
      catalog.available = false;
    }],
    ["ledger", (catalog) => {
      catalog.ledger.reason = "unreviewed";
    }],
    ["provenance", (catalog) => {
      catalog.provenance.expected.publicTables += 1;
    }],
  ]) {
    const catalog = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
    mutate(catalog);
    for (const operation of [
      () =>
        diffDatabaseRuntimeCapabilities(
          CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
          catalog,
        ),
      () =>
        planDatabaseRuntimeCapabilityReconciliation({
          phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
          policy: CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
          catalog,
        }),
    ]) {
      assert.throws(operation, {
        name: "DatabaseRuntimeCapabilityValidationError",
        message: new RegExp(`catalog metadata mismatch: ${label}`, "u"),
      });
    }
  }
});

test("comparable catalogs reject malformed default ACL tuples before planning", () => {
  const run = (catalog) =>
    planDatabaseRuntimeCapabilityReconciliation({
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
      policy: CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
      catalog,
    });
  for (const [label, mutate] of [
    [
      "unknown key",
      (tuple) => {
        tuple.unreviewed = true;
      },
    ],
    [
      "unknown creator",
      (tuple) => {
        tuple.creator = "learncoding_unknown";
      },
    ],
    [
      "unknown object kind",
      (tuple) => {
        tuple.objectKind = "cluster";
      },
    ],
    [
      "unknown privilege",
      (tuple) => {
        tuple.privilege = "BECOME";
      },
    ],
    [
      "non-boolean grant option",
      (tuple) => {
        tuple.grantable = "false";
      },
    ],
    [
      "delegated grantor",
      (tuple) => {
        tuple.grantor = "learncoding_app";
      },
    ],
    [
      "unknown grantee",
      (tuple) => {
        tuple.grantee = "learncoding_unknown";
      },
    ],
    [
      "unknown schema",
      (tuple) => {
        tuple.schema = "unreviewed";
      },
    ],
    [
      "forged identity",
      (tuple) => {
        tuple.identity = "forged";
      },
    ],
    [
      "literal creator sentinel",
      (tuple) => {
        tuple.creator = "@bootstrap-session";
        tuple.grantor = "@bootstrap-session";
        tuple.identity =
          "bootstrap-session|@global|routine|learncoding_owner|EXECUTE";
      },
    ],
    [
      "literal grantee sentinel",
      (tuple) => {
        tuple.grantee = "@bootstrap-session";
        tuple.identity =
          "learncoding_owner|@global|routine|bootstrap-session|EXECUTE";
      },
    ],
  ]) {
    const catalog = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
    mutate(catalog.defaultAcls[0]);
    assert.throws(
      () => run(catalog),
      { name: "DatabaseRuntimeCapabilityValidationError" },
      label,
    );
  }

  const missingRow = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
  const tuple = missingRow.defaultAcls[0];
  const rowIdentity = defaultAclRowIdentity(tuple);
  missingRow.defaultAclRows = missingRow.defaultAclRows.filter(
    (row) => row.identity !== rowIdentity,
  );
  assert.throws(
    () => run(missingRow),
    { name: "DatabaseRuntimeCapabilityValidationError" },
    "missing physical row",
  );

  for (const variant of ["exact", "same-identity"]) {
    const duplicate = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
    const copy = clone(duplicate.defaultAcls[0]);
    if (variant === "same-identity") copy.grantable = true;
    duplicate.defaultAcls.push(copy);
    assert.throws(
      () => run(duplicate),
      { name: "DatabaseRuntimeCapabilityValidationError" },
      variant,
    );
  }

  const exact = run(clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES));
  assert.equal(exact.blocked, false);
  assert.deepEqual(exact.mutations, []);

  const removable = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
  removable.defaultAcls.push({
    identity: "learncoding_owner|@global|routine|PUBLIC|EXECUTE",
    creator: "learncoding_owner",
    schema: null,
    objectKind: "routine",
    grantor: "learncoding_owner",
    grantee: "PUBLIC",
    privilege: "EXECUTE",
    grantable: true,
  });
  const removalPlan = run(removable);
  assert.equal(removalPlan.blocked, false);
  assert.equal(
    removalPlan.mutations.some(
      (mutation) =>
        mutation.action === "remove" &&
        mutation.collection === "defaultAcls" &&
        mutation.value.grantee === "PUBLIC" &&
        mutation.value.grantable === true,
    ),
    true,
  );
});

test("predecessor allowance is finite and phase-safe across all collections", () => {
  const policy = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
  const predecessors = {
    roles: [clone(policy.roles.at(-1))],
    memberships: [clone(policy.memberships.at(-1))],
    grants: [clone(policy.grants.at(-1))],
    defaultAcls: [clone(policy.defaultAcls.at(-1))],
    defaultAclRows: [clone(policy.defaultAclRows.at(-1))],
  };
  const allowance = {
    schemaVersion: DATABASE_RUNTIME_CAPABILITY_SCHEMA_VERSION,
    allowance: "codestead-database-runtime-predecessor-0070-v1",
    available: true,
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070,
    validOnlyAtMigrationIndex: 70,
    expiresAtMigrationIndex: 71,
    reason: null,
    ...predecessors,
  };
  assert.doesNotThrow(() =>
    validateDatabaseRuntimeCapabilityAllowance(allowance),
  );
  const tupleWithoutPhysicalRow = clone(allowance);
  const tupleRowIdentity = defaultAclRowIdentity(
    tupleWithoutPhysicalRow.defaultAcls[0],
  );
  tupleWithoutPhysicalRow.defaultAclRows =
    tupleWithoutPhysicalRow.defaultAclRows.filter(
      (entry) => entry.identity !== tupleRowIdentity,
    );
  assert.throws(
    () => validateDatabaseRuntimeCapabilityAllowance(tupleWithoutPhysicalRow),
    {
      name: "DatabaseRuntimeCapabilityValidationError",
      message: /allowance default ACL tuple has no physical default ACL row/u,
    },
  );
  assert.doesNotThrow(() =>
    validateDatabaseRuntimeCapabilityAllowance(tupleWithoutPhysicalRow, policy),
  );
  const unreviewedEntries = {
    roles: {
      ...clone(policy.roles.at(-1)),
      identity: "learncoding_ghost",
      name: "learncoding_ghost",
    },
    memberships: {
      ...clone(policy.memberships[0]),
      identity: "learncoding_owner->learncoding_app",
      member: "learncoding_app",
    },
    grants: {
      objectKind: "database",
      object: "@database",
      grantor: "learncoding_owner",
      grantee: "learncoding_app",
      privilege: "TEMPORARY",
      grantable: false,
    },
    defaultAcls: {
      ...clone(policy.defaultAcls[0]),
      identity: "learncoding_owner|@global|routine|learncoding_app|EXECUTE",
      grantee: "learncoding_app",
    },
    defaultAclRows: {
      identity: "learncoding_unknown|other|schema",
      creator: "learncoding_unknown",
      schema: "other",
      objectKind: "schema",
    },
  };
  for (const [collection, entry] of Object.entries(unreviewedEntries)) {
    const invalid = clone(allowance);
    invalid[collection].push(entry);
    assert.throws(
      () => validateDatabaseRuntimeCapabilityAllowance(invalid),
      {
        name: "DatabaseRuntimeCapabilityValidationError",
        message: new RegExp(
          `allowance ${collection} contains non-predecessor authority`,
          "u",
        ),
      },
      collection,
    );
  }
  const nonBooleanLogin = clone(allowance);
  nonBooleanLogin.roles[0].login = "true";
  assert.throws(
    () => validateDatabaseRuntimeCapabilityAllowance(nonBooleanLogin),
    {
      name: "DatabaseRuntimeCapabilityValidationError",
      message: /invalid allowance role/u,
    },
  );

  for (const collection of [
    "roles",
    "memberships",
    "grants",
    "defaultAcls",
    "defaultAclRows",
  ]) {
    const predecessor = predecessors[collection][0];
    const present = classifyDatabaseRuntimeCapabilityPredecessorDelta({
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070,
      collection,
      expected: [],
      observed: [predecessor],
      allowance,
    });
    assert.deepEqual(present.reportOnly, [predecessor], collection);
    assert.deepEqual(present.grant, [], collection);
    assert.deepEqual(present.revoke, [], collection);
    assert.deepEqual(present.forbidden, [], collection);

    const absent = classifyDatabaseRuntimeCapabilityPredecessorDelta({
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070,
      collection,
      expected: [],
      observed: [],
      allowance,
    });
    assert.deepEqual(absent.grant, [], collection);
    assert.deepEqual(absent.reportOnly, [], collection);

    const contracted = classifyDatabaseRuntimeCapabilityPredecessorDelta({
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071,
      collection,
      expected: [],
      observed: [predecessor],
      allowance: null,
    });
    assert.deepEqual(contracted.reportOnly, [], collection);
    assert.deepEqual(contracted.revoke, [], collection);
    assert.deepEqual(contracted.forbidden, [predecessor], collection);

    const nearMatch = clone(predecessor);
    if (collection === "roles") nearMatch.connectionLimit = 7;
    if (collection === "memberships") nearMatch.setOption = false;
    if (collection === "grants" || collection === "defaultAcls") {
      nearMatch.grantable = true;
    }
    if (collection === "defaultAclRows") {
      nearMatch.schema = "other";
      nearMatch.identity = `${nearMatch.creator}|other|${nearMatch.objectKind}`;
    }
    const forbidden = classifyDatabaseRuntimeCapabilityPredecessorDelta({
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070,
      collection,
      expected: [],
      observed: [nearMatch],
      allowance,
    });
    assert.deepEqual(forbidden.reportOnly, [], collection);
    assert.deepEqual(forbidden.forbidden, [nearMatch], collection);
  }

  for (const collection of ["roles", "memberships"]) {
    const predecessor = predecessors[collection][0];
    const replacement = clone(predecessor);
    if (collection === "roles") replacement.connectionLimit = 7;
    if (collection === "memberships") replacement.setOption = false;
    const expanded = classifyDatabaseRuntimeCapabilityPredecessorDelta({
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070,
      collection,
      expected: [replacement],
      observed: [predecessor],
      allowance,
    });
    assert.deepEqual(expanded.reportOnly, [predecessor], collection);
    assert.deepEqual(expanded.grant, [], collection);
    assert.deepEqual(expanded.revoke, [], collection);
    const contracted = classifyDatabaseRuntimeCapabilityPredecessorDelta({
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071,
      collection,
      expected: [replacement],
      observed: [predecessor],
      allowance: null,
    });
    assert.deepEqual(contracted.reportOnly, [], collection);
    assert.deepEqual(contracted.grant, [replacement], collection);
    assert.deepEqual(contracted.revoke, [], collection);
    assert.deepEqual(contracted.forbidden, [predecessor], collection);
  }

  const allowedGrant = predecessors.grants[0];
  const cardinality = classifyDatabaseRuntimeCapabilityGrantDelta({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070,
    expectedGrants: [],
    observedGrants: [allowedGrant, clone(allowedGrant)],
    allowance,
  });
  assert.equal(cardinality.reportOnly.length, 1);
  assert.equal(cardinality.forbidden.length, 1);

  const expectedPolicyGrant = clone(policy.grants[0]);
  const missingPolicyAuthority = classifyDatabaseRuntimeCapabilityGrantDelta({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070,
    expectedGrants: [expectedPolicyGrant],
    observedGrants: [],
    allowance,
  });
  assert.deepEqual(missingPolicyAuthority.grant, [expectedPolicyGrant]);

  assert.throws(
    () =>
      classifyDatabaseRuntimeCapabilityPredecessorDelta({
        phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071,
        collection: "grants",
        expected: [],
        observed: [predecessors.grants[0]],
        allowance,
      }),
    { name: "DatabaseRuntimeCapabilityPhaseError" },
  );

  for (const mutate of [
    (value) => {
      value.available = false;
      value.reason = "unavailable";
    },
    (value) => {
      value.validOnlyAtMigrationIndex = 69;
    },
    (value) => {
      value.expiresAtMigrationIndex = 72;
    },
    (value) => {
      value.phase = DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071;
    },
  ]) {
    const invalid = clone(allowance);
    mutate(invalid);
    assert.throws(() => validateDatabaseRuntimeCapabilityAllowance(invalid), {
      name: "DatabaseRuntimeCapabilityValidationError",
    });
  }
});

test("contracted policy rejects broad table and sequence default ACLs", () => {
  for (const objectKind of ["table", "sequence"]) {
    const manifest = clone(POST_CONTRACT_DATABASE_RUNTIME_CAPABILITIES);
    const broad = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.defaultAcls.find(
      (entry) => entry.schema === "public" && entry.objectKind === objectKind,
    );
    assert.ok(broad, objectKind);
    manifest.defaultAcls.push(clone(broad));
    assert.throws(
      () => validateDatabaseRuntimeCapabilities(manifest),
      {
        name: "DatabaseRuntimeCapabilityValidationError",
        message: /broad post-contract default ACL is forbidden/u,
      },
      objectKind,
    );
  }
});

test("planner rejects unavailable authority and returns no executable blocked mutations", () => {
  const policy = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
  const catalog = clone(policy);
  assert.throws(
    () =>
      planDatabaseRuntimeCapabilityReconciliation({
        phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071,
        policy: POST_CONTRACT_DATABASE_RUNTIME_CAPABILITIES,
        catalog: clone(POST_CONTRACT_DATABASE_RUNTIME_CAPABILITIES),
      }),
    { name: "DatabaseRuntimeCapabilityPhaseError" },
  );
  assert.throws(
    () =>
      planDatabaseRuntimeCapabilityReconciliation({
        phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071,
        policy,
        catalog,
      }),
    { name: "DatabaseRuntimeCapabilityPhaseError" },
  );
  assert.throws(
    () =>
      planDatabaseRuntimeCapabilityReconciliation({
        phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
        policy,
        catalog,
        allowance: PREDECESSOR_0070_DATABASE_RUNTIME_CAPABILITY_ALLOWANCE,
      }),
    { name: "DatabaseRuntimeCapabilityPhaseError" },
  );

  const blockedCatalog = clone(policy);
  blockedCatalog.grants.pop();
  const unknownTable = clone(blockedCatalog.inventory.tables[0]);
  unknownTable.identity = "public.unreviewed";
  unknownTable.name = "unreviewed";
  unknownTable.columns = [
    { identity: "public.unreviewed.id", name: "id", ordinal: 1 },
  ];
  blockedCatalog.inventory.tables.push(unknownTable);
  const blocked = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog: blockedCatalog,
  });
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.mutations, []);
  assert.equal(Object.hasOwn(blocked, "proposedMutations"), false);

  const emptyDefaultAclRowCatalog = clone(policy);
  emptyDefaultAclRowCatalog.defaultAclRows.push({
    identity: "learncoding_unknown|other|schema",
    creator: "learncoding_unknown",
    schema: "other",
    objectKind: "schema",
  });
  const emptyDefaultAclRowPlan = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog: emptyDefaultAclRowCatalog,
  });
  assert.equal(emptyDefaultAclRowPlan.blocked, true);
  assert.deepEqual(emptyDefaultAclRowPlan.mutations, []);

  const hiddenAuthorityCatalog = clone(policy);
  hiddenAuthorityCatalog.effectiveGrants = [
    {
      objectKind: "schema",
      object: "public",
      grantor: "learncoding_owner",
      grantee: "learncoding_app",
      privilege: "CREATE",
      grantable: false,
    },
  ];
  assert.throws(
    () =>
      planDatabaseRuntimeCapabilityReconciliation({
        phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
        policy,
        catalog: hiddenAuthorityCatalog,
      }),
    { name: "DatabaseRuntimeCapabilityValidationError" },
  );

  const unknownRoleCatalog = clone(policy);
  unknownRoleCatalog.roles.push({
    ...clone(policy.roles.at(-1)),
    identity: "learncoding_ghost",
    name: "learncoding_ghost",
  });
  const unknownRole = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog: unknownRoleCatalog,
  });
  assert.equal(unknownRole.blocked, true);
  assert.deepEqual(unknownRole.mutations, []);
  assert.equal(Object.hasOwn(unknownRole, "proposedMutations"), false);

  const extraCatalog = clone(policy);
  const extraMembership = {
    ...clone(policy.memberships[0]),
    identity: "learncoding_owner->learncoding_app",
    member: "learncoding_app",
  };
  const extraGrant = {
    objectKind: "database",
    object: "@database",
    grantor: "learncoding_owner",
    grantee: "learncoding_app",
    privilege: "TEMPORARY",
    grantable: false,
  };
  const extraDefaultAcl = {
    ...clone(policy.defaultAcls[0]),
    identity: "learncoding_owner|@global|routine|learncoding_app|EXECUTE",
    grantee: "learncoding_app",
  };
  extraCatalog.memberships.push(extraMembership);
  extraCatalog.grants.push(extraGrant);
  extraCatalog.defaultAcls.push(extraDefaultAcl);
  const removalPlan = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog: extraCatalog,
  });
  assert.equal(removalPlan.blocked, false);
  assert.deepEqual(
    removalPlan.mutations.map(
      ({ action, collection }) => `${action}:${collection}`,
    ),
    ["remove:defaultAcls", "remove:grants", "remove:memberships"],
  );
  assert.deepEqual(applyPlan(extraCatalog, removalPlan), clone(policy));
});

test("table privilege revocation restores every expected column grant removed by PostgreSQL CASCADE", () => {
  const policy = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
  const tableByColumn = new Map(
    policy.inventory.tables.flatMap((table) =>
      table.columns.map((column) => [column.identity, table.identity]),
    ),
  );
  const tupleKey = (entry) =>
    [
      entry.objectKind,
      entry.object,
      entry.grantor,
      entry.grantee,
      entry.privilege,
      entry.grantable,
    ].join("|");
  const sameAuthority = (left, right) =>
    left.grantor === right.grantor &&
    left.grantee === right.grantee &&
    left.privilege === right.privilege;
  const scenarios = [
    {
      table: "public.email_outbox",
      grantee: "learncoding_app",
      privilege: "INSERT",
      expectedColumnCount: 12,
    },
    {
      table: "public.email_outbox",
      grantee: "learncoding_worker",
      privilege: "INSERT",
      expectedColumnCount: 11,
    },
    {
      table: "public.email_outbox",
      grantee: "learncoding_worker",
      privilege: "UPDATE",
      expectedColumnCount: 21,
    },
    {
      table: "public.mail_delivery_release_receipt",
      grantee: "learncoding_worker",
      privilege: "SELECT",
      expectedColumnCount: 7,
    },
  ];

  for (const scenario of scenarios) {
    const extraTableGrant = {
      objectKind: "table",
      object: scenario.table,
      grantor: "learncoding_owner",
      grantee: scenario.grantee,
      privilege: scenario.privilege,
      grantable: false,
    };
    const catalog = clone(policy);
    catalog.grants.push(extraTableGrant);
    const plan = planDatabaseRuntimeCapabilityReconciliation({
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
      policy,
      catalog,
    });
    assert.equal(plan.blocked, false, scenario.table);
    const columnRegrants = plan.mutations.filter(
      (mutation) =>
        mutation.action === "add" &&
        mutation.collection === "grants" &&
        mutation.value.objectKind === "column" &&
        tableByColumn.get(mutation.value.object) === scenario.table &&
        sameAuthority(mutation.value, extraTableGrant),
    );
    assert.equal(
      columnRegrants.length,
      scenario.expectedColumnCount,
      `${scenario.table} ${scenario.grantee} ${scenario.privilege}`,
    );
    assert.equal(
      new Set(columnRegrants.map((mutation) => tupleKey(mutation.value))).size,
      scenario.expectedColumnCount,
      "synthetic column regrants must be exact and unique",
    );

    const afterPostgresCascade = clone(catalog);
    afterPostgresCascade.grants = afterPostgresCascade.grants.filter(
      (entry) =>
        tupleKey(entry) !== tupleKey(extraTableGrant) &&
        !(
          entry.objectKind === "column" &&
          tableByColumn.get(entry.object) === scenario.table &&
          sameAuthority(entry, extraTableGrant)
        ),
    );
    afterPostgresCascade.grants.push(
      ...columnRegrants.map((mutation) => clone(mutation.value)),
    );
    const converged = planDatabaseRuntimeCapabilityReconciliation({
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
      policy,
      catalog: afterPostgresCascade,
    });
    assert.equal(converged.blocked, false);
    assert.deepEqual(converged.mutations, []);
  }
});

test("missing physical default ACL rows require an explicit owner-only baseline action", () => {
  const policy = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
  const catalog = clone(policy);
  const rowIdentity = "learncoding_owner|@global|routine";
  const rowIndex = catalog.defaultAclRows.findIndex(
    (entry) => entry.identity === rowIdentity,
  );
  assert.notEqual(rowIndex, -1);
  catalog.defaultAclRows.splice(rowIndex, 1);
  const tupleIndex = catalog.defaultAcls.findIndex(
    (entry) =>
      entry.identity ===
      "learncoding_owner|@global|routine|learncoding_owner|EXECUTE",
  );
  assert.notEqual(tupleIndex, -1);
  catalog.defaultAcls.splice(tupleIndex, 1);

  const firstPlan = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog,
  });
  assert.equal(firstPlan.blocked, false);
  assert.deepEqual(
    firstPlan.mutations
      .filter((mutation) =>
        ["defaultAclRows", "defaultAcls"].includes(mutation.collection),
      )
      .map(({ action, collection, identity }) => ({
        action,
        collection,
        identity,
      })),
    [
      {
        action: "ensure",
        collection: "defaultAclRows",
        identity: rowIdentity,
      },
      {
        action: "add",
        collection: "defaultAcls",
        identity: undefined,
      },
    ],
  );
  const reconciled = applyPlan(catalog, firstPlan);
  assert.equal(
    diffDatabaseRuntimeCapabilities(policy, reconciled).matches,
    true,
  );
  const secondPlan = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog: reconciled,
  });
  assert.equal(secondPlan.blocked, false);
  assert.deepEqual(secondPlan.mutations, []);
});

test("known extra physical default ACL rows converge only through their exact last tuple", () => {
  const policy = CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES;
  const catalog = clone(policy);
  const extraRow = {
    identity: "learncoding_owner|drizzle|table",
    creator: "learncoding_owner",
    schema: "drizzle",
    objectKind: "table",
  };
  const extraTuple = {
    identity:
      "learncoding_owner|drizzle|table|learncoding_ops|SELECT",
    creator: "learncoding_owner",
    schema: "drizzle",
    objectKind: "table",
    grantor: "learncoding_owner",
    grantee: "learncoding_ops",
    privilege: "SELECT",
    grantable: false,
  };
  catalog.defaultAclRows.push(extraRow);
  catalog.defaultAcls.push(extraTuple);

  const firstPlan = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog,
  });
  assert.equal(firstPlan.blocked, false);
  assert.deepEqual(firstPlan.mutations, [
    {
      action: "remove",
      collection: "defaultAcls",
      value: extraTuple,
    },
  ]);

  const reconciled = clone(catalog);
  reconciled.defaultAcls = reconciled.defaultAcls.filter(
    (entry) => entry.identity !== extraTuple.identity,
  );
  reconciled.defaultAclRows = reconciled.defaultAclRows.filter(
    (entry) => entry.identity !== extraRow.identity,
  );
  const secondPlan = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog: reconciled,
  });
  assert.equal(secondPlan.blocked, false);
  assert.deepEqual(secondPlan.mutations, []);

  const tupleless = clone(policy);
  tupleless.defaultAclRows.push(extraRow);
  const tuplelessPlan = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog: tupleless,
  });
  assert.equal(tuplelessPlan.blocked, true);
  assert.deepEqual(tuplelessPlan.mutations, []);

  for (const { row, tuple } of [
    {
      row: {
        identity: "learncoding_app|public|table",
        creator: "learncoding_app",
        schema: "public",
        objectKind: "table",
      },
      tuple: {
        identity:
          "learncoding_app|public|table|learncoding_ops|SELECT",
        creator: "learncoding_app",
        schema: "public",
        objectKind: "table",
        grantor: "learncoding_app",
        grantee: "learncoding_ops",
        privilege: "SELECT",
        grantable: false,
      },
    },
    {
      row: {
        identity: "learncoding_owner|@global|table",
        creator: "learncoding_owner",
        schema: null,
        objectKind: "table",
      },
      tuple: {
        identity:
          "learncoding_owner|@global|table|learncoding_ops|SELECT",
        creator: "learncoding_owner",
        schema: null,
        objectKind: "table",
        grantor: "learncoding_owner",
        grantee: "learncoding_ops",
        privilege: "SELECT",
        grantable: false,
      },
    },
  ]) {
    const unsafe = clone(policy);
    unsafe.defaultAclRows.push(row);
    unsafe.defaultAcls.push(tuple);
    const unsafePlan = planDatabaseRuntimeCapabilityReconciliation({
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
      policy,
      catalog: unsafe,
    });
    assert.equal(unsafePlan.blocked, true, row.identity);
    assert.deepEqual(unsafePlan.mutations, [], row.identity);
  }
});

test("phase resolution binds the exact frozen reviewed ledger prefix", () => {
  const request = (count, overrides = {}) => ({
    journalPresent: count > 0,
    reviewedMigrationTail:
      count === 0 ? null : REVIEWED_MIGRATION_LEDGER[count - 1]?.tag,
    reviewedPrefixExact: count > 0,
    reviewedMigrationCount: count,
    reviewedMigrationLedgerSha256: REVIEWED_MIGRATION_LEDGER_SHA256,
    ...overrides,
  });
  const expectedFoundation = (count) => ({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION,
    policy: null,
    reconcileApplicationAcls: false,
    ledgerIdentity: {
      journalPresent: count > 0,
      appliedCount: count,
      reviewedLedgerSha256: REVIEWED_MIGRATION_LEDGER_SHA256,
    },
  });

  const absent = resolveDatabaseRuntimeCapabilityPhase(request(0));
  assert.deepEqual(absent, expectedFoundation(0));
  assert.equal(Object.isFrozen(absent), true);
  assert.equal(Object.isFrozen(absent.ledgerIdentity), true);

  const phase0067 = resolveDatabaseRuntimeCapabilityPhase(request(68));
  const phase0068 = resolveDatabaseRuntimeCapabilityPhase(request(69));
  assert.deepEqual(phase0067, expectedFoundation(68));
  assert.deepEqual(phase0068, expectedFoundation(69));
  assert.notDeepEqual(phase0067.ledgerIdentity, phase0068.ledgerIdentity);

  const current = resolveDatabaseRuntimeCapabilityPhase({
    ...request(REVIEWED_MIGRATION_LEDGER.length),
    requestedPhase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
  });
  assert.equal(current.policy, CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
  assert.equal(current.phase, DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069);
  assert.equal(Object.isFrozen(current), true);
  assert.equal(Object.isFrozen(current.ledgerIdentity), true);

  for (const invalid of [
    {},
    request(0, { journalPresent: true }),
    request(0, { reviewedPrefixExact: true }),
    request(0, { reviewedMigrationTail: "0069_unreviewed" }),
    request(68, { reviewedMigrationTail: REVIEWED_MIGRATION_LEDGER[68].tag }),
    request(69, {
      reviewedMigrationTail:
        "0068_mail_outbox_quarantine_redaction_authority_v2_forged",
    }),
    request(69, { reviewedPrefixExact: false }),
    request(69, { reviewedMigrationCount: 68 }),
    request(69, {
      reviewedMigrationLedgerSha256: "0".repeat(64),
    }),
    request(70, { reviewedMigrationCount: 71 }),
    {
      ...request(70),
      requestedPhase: DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070,
    },
    {
      ...request(0),
      requestedPhase: "unknown",
    },
  ]) {
    assert.throws(() => resolveDatabaseRuntimeCapabilityPhase(invalid), {
      name: "DatabaseRuntimeCapabilityPhaseError",
    });
  }
  assert.equal(POST_CONTRACT_DATABASE_RUNTIME_CAPABILITIES.available, false);
});

test("structured reconciliation is statefully idempotent", () => {
  const policy = clone(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
  const catalog = clone(policy);
  catalog.grants.pop();
  catalog.defaultAcls.pop();
  catalog.grants.push({
    objectKind: "database",
    object: "@database",
    grantor: "learncoding_owner",
    grantee: "learncoding_app",
    privilege: "TEMPORARY",
    grantable: false,
  });
  catalog.roles[0] = {
    ...catalog.roles[0],
    connectionLimit: 7,
  };

  const firstPlan = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog,
  });
  assert.equal(firstPlan.blocked, false);
  assert.ok(firstPlan.mutations.length > 0);
  assert.equal(
    new Set(
      firstPlan.mutations.map((mutation) => mutation.action),
    ).isSupersetOf(new Set(["add", "remove", "replace"])),
    true,
  );
  const permutedPlan = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog: reverseUnorderedCollections(catalog),
  });
  assert.deepEqual(
    {
      blocked: permutedPlan.blocked,
      mutations: permutedPlan.mutations,
      reports: permutedPlan.reports,
      policyFingerprint: permutedPlan.policyFingerprint,
    },
    {
      blocked: firstPlan.blocked,
      mutations: firstPlan.mutations,
      reports: firstPlan.reports,
      policyFingerprint: firstPlan.policyFingerprint,
    },
  );
  const reconciled = applyPlan(catalog, firstPlan);
  assert.deepEqual(reconciled, policy);
  const secondPlan = planDatabaseRuntimeCapabilityReconciliation({
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    policy,
    catalog: reconciled,
  });
  assert.equal(secondPlan.blocked, false);
  assert.deepEqual(secondPlan.mutations, []);
  assert.equal(secondPlan.policyFingerprint, firstPlan.policyFingerprint);
  assert.equal(
    fingerprintDatabaseRuntimeCapabilities(reconciled),
    fingerprintDatabaseRuntimeCapabilities(policy),
  );
});
