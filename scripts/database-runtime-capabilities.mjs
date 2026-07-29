import { createHash } from "node:crypto";

import journal0069 from "../drizzle/meta/_journal.json" with { type: "json" };
import physicalPublicColumns0069 from "../drizzle/meta/0069_public_column_attnums.json" with { type: "json" };
import snapshot0069 from "../drizzle/meta/0069_snapshot.json" with { type: "json" };

export const DATABASE_RUNTIME_CAPABILITY_SCHEMA_VERSION = 1;

export const DATABASE_RUNTIME_CAPABILITY_PHASES = Object.freeze({
  FOUNDATION: "foundation",
  CURRENT_0069: "0069-current",
  EXPAND_PREPARE_0070: "0070-expand-prepare",
  CONTRACTED_0071: "0071-contracted",
});

export const CURRENT_0069_REVIEWED_MIGRATION_TAG =
  "0069_mail_outbox_guarded_delivery_authority";

const REVIEWED_0069_FULL_LEDGER_SHA256 =
  "20b480c7dd694d6e8e243704f14aeb05aa42fda4c5b7e863f6c357bf095a2551";
const REVIEWED_0069_JOURNAL_TAGS_SHA256 =
  "4b3163fd24c181107a891b42de1095f5137b366f8fb5429a2845753146adba08";
const REVIEWED_0069_PUBLIC_COLUMN_MANIFEST_SHA256 =
  "b64e0934d046eb1cc4b1609ffbaf309cccdc2fa12fd4154ace19c9f63a0859af";
const REVIEWED_MIGRATION_TAGS = Object.freeze(
  Array.isArray(journal0069.entries)
    ? journal0069.entries.map((entry) => entry.tag)
    : [],
);

export class DatabaseRuntimeCapabilityValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseRuntimeCapabilityValidationError";
  }
}

export class DatabaseRuntimeCapabilityPhaseError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseRuntimeCapabilityPhaseError";
  }
}

function compareCodePoints(left, right) {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0));
  const rightPoints = Array.from(right, (character) =>
    character.codePointAt(0),
  );
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] < rightPoints[index] ? -1 : 1;
    }
  }
  return leftPoints.length < rightPoints.length
    ? -1
    : leftPoints.length > rightPoints.length
      ? 1
      : 0;
}

function domainFailure(message) {
  throw new DatabaseRuntimeCapabilityValidationError(message);
}

function isArrayIndexKey(key) {
  return /^(?:0|[1-9][0-9]*)$/u.test(key) && Number(key) < 4_294_967_295;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export const BOOTSTRAP_SESSION_AUTHORITY = deepFreeze({
  kind: "bootstrap-session",
});

function assertStrictJsonDomain(value, path = "$", ancestors = new WeakSet()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      domainFailure(`${path} contains a non-JSON number`);
    }
    return;
  }
  if (typeof value !== "object") {
    domainFailure(`${path} contains a non-JSON value`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    (!Array.isArray(value) && prototype !== Object.prototype) ||
    (Array.isArray(value) && prototype !== Array.prototype)
  ) {
    domainFailure(`${path} must contain only arrays and plain objects`);
  }
  if (ancestors.has(value)) {
    domainFailure(`${path} contains a cycle`);
  }
  ancestors.add(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    domainFailure(`${path} contains a symbol key`);
  }
  if (Array.isArray(value)) {
    const stringKeys = ownKeys.filter((key) => key !== "length");
    if (
      stringKeys.length !== value.length ||
      Array.from({ length: value.length }, (_, index) => String(index)).some(
        (key) => !Object.hasOwn(value, key),
      )
    ) {
      domainFailure(`${path} must not contain sparse or decorated arrays`);
    }
  }
  for (const key of ownKeys) {
    if (key === "length" && Array.isArray(value)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      domainFailure(`${path}.${key} must be an enumerable data property`);
    }
    if (!Array.isArray(value) && isArrayIndexKey(key)) {
      domainFailure(`${path}.${key} uses an integer-like object key`);
    }
    assertStrictJsonDomain(descriptor.value, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function canonicalizeValue(value, parentKey = null) {
  if (Array.isArray(value)) {
    const canonical = value.map((entry) => canonicalizeValue(entry, parentKey));
    if (parentKey === "values") {
      return canonical;
    }
    return canonical.toSorted((left, right) =>
      compareCodePoints(JSON.stringify(left), JSON.stringify(right)),
    );
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted(compareCodePoints)
        .map((key) => [key, canonicalizeValue(value[key], key)]),
    );
  }
  return value;
}

function canonicalizeDatabaseRuntimeCapabilitiesUnchecked(value) {
  return canonicalizeValue(value);
}

function canonicalDatabaseRuntimeCapabilitiesJsonUnchecked(value) {
  return JSON.stringify(
    canonicalizeDatabaseRuntimeCapabilitiesUnchecked(value),
  );
}

export function canonicalizeDatabaseRuntimeCapabilities(value) {
  assertStrictJsonDomain(value);
  if (resemblesCapabilityManifest(value)) {
    validateDatabaseRuntimeCapabilities(value);
  }
  return canonicalizeDatabaseRuntimeCapabilitiesUnchecked(value);
}

export function canonicalDatabaseRuntimeCapabilitiesJson(value) {
  assertStrictJsonDomain(value);
  if (resemblesCapabilityManifest(value)) {
    validateDatabaseRuntimeCapabilities(value);
  }
  return canonicalDatabaseRuntimeCapabilitiesJsonUnchecked(value);
}

function resemblesCapabilityManifest(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.hasOwn(value, "contract") ||
      Object.hasOwn(value, "inventory") ||
      (Object.hasOwn(value, "grants") && Object.hasOwn(value, "defaultAcls")))
  );
}

export function fingerprintDatabaseRuntimeCapabilities(value) {
  return createHash("sha256")
    .update(`${canonicalDatabaseRuntimeCapabilitiesJson(value)}\n`, "utf8")
    .digest("hex");
}

const OWNER_ROLE = "learncoding_owner";
const MIGRATOR_ROLE = "learncoding_migrator";
const APP_ROLE = "learncoding_app";
const WORKER_ROLE = "learncoding_worker";
const OPS_ROLE = "learncoding_ops";
const BACKUP_REPORTER_ROLE = "learncoding_backup_reporter";

const LOGIN_ROLES = Object.freeze([
  MIGRATOR_ROLE,
  APP_ROLE,
  WORKER_ROLE,
  OPS_ROLE,
  BACKUP_REPORTER_ROLE,
]);

function role(name, login) {
  return {
    identity: name,
    name,
    login,
    superuser: false,
    createDatabase: false,
    createRole: false,
    inherit: false,
    replication: false,
    bypassRls: false,
    connectionLimit: -1,
    validUntil: "infinity",
    settings: [],
    credential: login ? "scram-managed" : "none",
  };
}

const CURRENT_ROLES = [
  role(OWNER_ROLE, false),
  ...LOGIN_ROLES.map((name) => role(name, true)),
];

const CURRENT_MEMBERSHIPS = [
  {
    identity: `${OWNER_ROLE}->${MIGRATOR_ROLE}`,
    role: OWNER_ROLE,
    member: MIGRATOR_ROLE,
    grantor: BOOTSTRAP_SESSION_AUTHORITY,
    adminOption: false,
    inheritOption: false,
    setOption: true,
  },
];

const PHYSICAL_PUBLIC_TABLES = new Map(
  physicalPublicColumns0069.tables.map((table) => [table.identity, table]),
);

function physicalPublicColumns(identity) {
  const physical = PHYSICAL_PUBLIC_TABLES.get(identity);
  if (physical === undefined) {
    throw new DatabaseRuntimeCapabilityValidationError(
      `missing physical column authority: ${identity}`,
    );
  }
  return physical.columns.map((column) => ({
    identity: column.identity,
    name: column.name,
    ordinal: column.attnum,
  }));
}

function tableFromSnapshot(identity, table) {
  const [schema] = identity.split(".", 1);
  const columns = physicalPublicColumns(identity);
  const logicalNames = new Set(
    Object.values(table.columns).map((column) => column.name),
  );
  if (
    logicalNames.size !== columns.length ||
    columns.some((column) => !logicalNames.has(column.name))
  ) {
    throw new DatabaseRuntimeCapabilityValidationError(
      `physical and logical columns disagree: ${identity}`,
    );
  }
  return {
    identity,
    schema,
    name: table.name,
    owner: OWNER_ROLE,
    columns,
  };
}

const SNAPSHOT_PUBLIC_TABLES = Object.entries(snapshot0069.tables)
  .filter(([identity]) => identity.startsWith("public."))
  .map(([identity, table]) => tableFromSnapshot(identity, table));

const RAW_0065_TABLES = [
  "public.backup_status_mail_admin_guard",
  "public.backup_status_mail_authority",
].map((identity) => ({
  identity,
  schema: "public",
  name: identity.slice("public.".length),
  owner: OWNER_ROLE,
  columns: physicalPublicColumns(identity),
}));

const DRIZZLE_TABLE = {
  identity: "drizzle.__drizzle_migrations",
  schema: "drizzle",
  name: "__drizzle_migrations",
  owner: OWNER_ROLE,
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
};

const DRIZZLE_TYPE = {
  identity: "drizzle.__drizzle_migrations",
  schema: "drizzle",
  name: "__drizzle_migrations",
  kind: "composite",
  owner: OWNER_ROLE,
};

const PUBLIC_TABLES = [...SNAPSHOT_PUBLIC_TABLES, ...RAW_0065_TABLES].toSorted(
  (left, right) => compareCodePoints(left.identity, right.identity),
);

const ENUM_TYPES = Object.entries(snapshot0069.enums)
  .filter(([identity]) => identity.startsWith("public."))
  .map(([identity, definition]) => ({
    identity,
    schema: "public",
    name: definition.name,
    kind: "enum",
    owner: OWNER_ROLE,
    values: [...definition.values],
  }));

const PUBLIC_TYPES = [
  ...PUBLIC_TABLES.map((table) => ({
    identity: table.identity,
    schema: table.schema,
    name: table.name,
    kind: "composite",
    owner: OWNER_ROLE,
  })),
  ...ENUM_TYPES,
].toSorted((left, right) => compareCodePoints(left.identity, right.identity));

const PUBLIC_ROUTINE_SIGNATURES = [
  "attest_email_outbox_delivery_release_lineage(text)",
  "backup_status_mail_authorized(uuid)",
  "career_card_authority_guard()",
  "career_certificate_history_append_only()",
  "certificate_issue_guard()",
  "certificate_revocation_authority_guard()",
  "claim_email_outbox_idempotency_authority()",
  "classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)",
  "coding_battle_immutable_guard()",
  "coding_battle_submission_shape_guard()",
  "community_battle_append_only_guard()",
  "email_outbox_event_sha256(text,text,text)",
  "email_outbox_idempotency_coverage_authority(uuid[])",
  "email_outbox_original_payload_sha256(text,text,text,text,jsonb)",
  "enforce_admin_fallback_grant_delete()",
  "enforce_admin_fallback_grant_update()",
  "enforce_admin_fallback_reservation_immutability()",
  "enforce_email_outbox_delivery_hold()",
  "enforce_email_outbox_delivery_release_commit_exact()",
  "enforce_email_outbox_delivery_release_delete_exact()",
  "enforce_email_outbox_delivery_release_identity()",
  "enforce_email_outbox_delivery_release_insert_final()",
  "enforce_email_outbox_delivery_release_insert_xid()",
  "enforce_email_outbox_dispatch_binding()",
  "enforce_email_outbox_idempotency_append_only()",
  "enforce_email_outbox_idempotency_metadata_immutable()",
  "enforce_email_outbox_payload_immutable()",
  "enforce_email_outbox_provider_correlation_evidence()",
  "enforce_email_outbox_provider_request_body_immutable()",
  "enforce_mail_delivery_release_receipt_append_only()",
  "enforce_mail_delivery_release_receipt_delete_exact()",
  "enforce_mail_delivery_release_receipt_insert()",
  "enforce_reward_ledger_insert_v1()",
  "enqueue_backup_status_mail_authority(text,text)",
  "enqueue_backup_status_mail_authority_unreleased_0067(text,text)",
  "enqueue_reward_attempt_change_v1()",
  "enqueue_reward_effective_result_change_v1()",
  "enqueue_reward_jobs_for_attempt_v1(uuid,text,timestamp with time zone)",
  "enqueue_reward_jobs_for_mastery_scope_v1(uuid,text,timestamp with time zone)",
  "enqueue_reward_mastery_change_v1()",
  "exam_mastery_recheck_immutable_guard()",
  "exam_reexam_grant_immutable_guard()",
  "guard_module_project_assignment()",
  "guard_module_project_start_receipt()",
  "guard_module_project_template()",
  "guard_module_project_template_event()",
  "guard_project_revision_object_update()",
  "learner_draft_enforce_account_quota()",
  "lock_backup_status_mail_admin_authority()",
  "mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)",
  "persist_email_outbox_idempotency_authority()",
  "protect_appeal_event_update()",
  "protect_appeal_immutable_fields()",
  "protect_assessment_correction_identity()",
  "protect_course_version_content()",
  "protect_curriculum_artifact_content()",
  "protect_project_review_correction_event_update()",
  "protect_project_review_correction_evidence()",
  "protect_project_review_effective_projection()",
  "protect_project_review_evidence()",
  "protect_reward_append_only_history()",
  "protect_runner_dispatch_request()",
  "public_portfolio_achievement_selection_guard()",
  "public_portfolio_certificate_selection_guard()",
  "public_portfolio_project_selection_guard()",
  "public_portfolio_project_snapshot_update_guard()",
  "redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)",
  "reject_assessment_correction_evidence_update()",
  "reject_backup_status_mail_authority_mutation()",
  "reject_curriculum_append_only_update()",
  "reject_project_revision_update()",
  "reject_social_evidence_update()",
  "release_email_outbox_delivery(uuid,uuid,text,text,text)",
  "require_account_deletion_for_project_review_evidence()",
  "require_module_project_transition_event()",
  "verify_email_outbox_delivery_release(uuid,uuid,text,text,text)",
];

const PUBLIC_ROUTINES = PUBLIC_ROUTINE_SIGNATURES.map((signature) => ({
  identity: `public.${signature}`,
  schema: "public",
  signature,
  kind: "function",
  owner: OWNER_ROLE,
}));

const CURRENT_INVENTORY = {
  databases: [{ identity: "@database", owner: OWNER_ROLE }],
  schemas: [
    { identity: "public", name: "public", owner: OWNER_ROLE },
    { identity: "drizzle", name: "drizzle", owner: OWNER_ROLE },
  ],
  tables: [...PUBLIC_TABLES, DRIZZLE_TABLE],
  sequences: [
    {
      identity: "drizzle.__drizzle_migrations_id_seq",
      schema: "drizzle",
      name: "__drizzle_migrations_id_seq",
      owner: OWNER_ROLE,
    },
  ],
  types: [...PUBLIC_TYPES, DRIZZLE_TYPE].toSorted((left, right) =>
    compareCodePoints(left.identity, right.identity),
  ),
  routines: PUBLIC_ROUTINES,
};

const REVIEWED_0069_TABLE_COLUMN_SHA256 =
  "47d662eab56331ce714127a0e3b020eb2c1e0e70c19005cf9654226fc7738d0c";
const REVIEWED_0069_ENUM_SHA256 =
  "38eaed74f67a47298214fb8995b4fea131fd4ec794897ed724da11ffeaf21eb7";

function assertReviewed0069InventoryPins() {
  const publicTables = CURRENT_INVENTORY.tables.filter(
    (table) => table.schema === "public",
  );
  const publicColumns = publicTables.reduce(
    (count, table) => count + table.columns.length,
    0,
  );
  const tableColumnFacts = CURRENT_INVENTORY.tables
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
            compareCodePoints(left.identity, right.identity),
        ),
    }))
    .toSorted((left, right) =>
      compareCodePoints(left.identity, right.identity),
    );
  const enums = CURRENT_INVENTORY.types
    .filter((entry) => entry.kind === "enum")
    .map(({ identity, values }) => ({ identity, values }));
  const enumLabelCount = enums.reduce(
    (count, entry) => count + entry.values.length,
    0,
  );
  const digest = createHash("sha256")
    .update(`${JSON.stringify(tableColumnFacts)}\n`, "utf8")
    .digest("hex");
  const journalTagsDigest = createHash("sha256")
    .update(`${JSON.stringify(REVIEWED_MIGRATION_TAGS)}\n`, "utf8")
    .digest("hex");
  const physicalManifestDigest = createHash("sha256")
    .update(`${JSON.stringify(physicalPublicColumns0069)}\n`, "utf8")
    .digest("hex");
  const physicalManifestExact =
    physicalPublicColumns0069.schemaVersion === 1 &&
    physicalPublicColumns0069.contract ===
      "codestead-public-column-attnums-0069-v1" &&
    physicalPublicColumns0069.reviewedMigrationTail ===
      CURRENT_0069_REVIEWED_MIGRATION_TAG &&
    physicalPublicColumns0069.reviewedMigrationLedgerSha256 ===
      REVIEWED_0069_FULL_LEDGER_SHA256 &&
    physicalPublicColumns0069.tables.length === 127 &&
    physicalPublicColumns0069.tables.reduce(
      (count, table) => count + table.columns.length,
      0,
    ) === 1_489 &&
    physicalPublicColumns0069.tables.every(
      (table) =>
        table.generation === 1 &&
        table.maxAttnum === table.columns.length &&
        table.droppedAttnums.length === 0 &&
        table.columns.every(
          (column, index) =>
            column.attnum === index + 1 &&
            column.identity === `${table.identity}.${column.name}`,
        ),
    );
  const journalExact =
    REVIEWED_MIGRATION_TAGS.length === 70 &&
    journal0069.entries.every(
      (entry, index) =>
        entry.idx === index &&
        entry.tag === REVIEWED_MIGRATION_TAGS[index] &&
        entry.tag.startsWith(String(index).padStart(4, "0") + "_"),
    ) &&
    REVIEWED_MIGRATION_TAGS.at(-1) === CURRENT_0069_REVIEWED_MIGRATION_TAG;
  if (
    !journalExact ||
    journalTagsDigest !== REVIEWED_0069_JOURNAL_TAGS_SHA256 ||
    !physicalManifestExact ||
    physicalManifestDigest !== REVIEWED_0069_PUBLIC_COLUMN_MANIFEST_SHA256 ||
    SNAPSHOT_PUBLIC_TABLES.length !== 125 ||
    SNAPSHOT_PUBLIC_TABLES.reduce(
      (count, table) => count + table.columns.length,
      0,
    ) !== 1_480 ||
    publicTables.length !== 127 ||
    publicColumns !== 1_489 ||
    CURRENT_INVENTORY.tables.length !== 128 ||
    digest !== REVIEWED_0069_TABLE_COLUMN_SHA256 ||
    CURRENT_INVENTORY.types.length !== 141 ||
    enums.length !== 13 ||
    enumLabelCount !== 78 ||
    fingerprintDatabaseRuntimeCapabilities(enums) !== REVIEWED_0069_ENUM_SHA256
  ) {
    throw new DatabaseRuntimeCapabilityValidationError(
      "the reviewed 0069 inventory pin does not match",
    );
  }
}

assertReviewed0069InventoryPins();

const MAIL_WORKER_OUTBOX_INSERT_COLUMNS = [
  "operation_id",
  "user_id",
  "delivery_scope_key",
  "to_email",
  "template",
  "template_version",
  "variables",
  "idempotency_key",
  "idempotency_authority_version",
  "status",
  "next_attempt_at",
];
const MAIL_APP_OUTBOX_INSERT_COLUMNS = [
  "id",
  ...MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
];
const MAIL_WORKER_OUTBOX_UPDATE_COLUMNS = [
  "status",
  "attempt_count",
  "claim_token",
  "claim_owner",
  "claim_version",
  "lease_expires_at",
  "provider_call_started",
  "provider_request_body_sha256",
  "provider_request_body_length",
  "adapter",
  "provider_message_id",
  "next_attempt_at",
  "sent_at",
  "quarantined_at",
  "last_error_code",
  "updated_at",
  "dispatch_binding_version",
  "dispatch_binding_sha256",
  "provider_correlation_version",
  "provider_evidence_version",
  "provider_evidence_sha256",
];
const MAIL_DELIVERY_RELEASE_RECEIPT_WORKER_SELECT_COLUMNS = [
  "outbox_id",
  "operation_id",
  "idempotency_authority_version",
  "idempotency_authority_sha256",
  "idempotency_original_payload_sha256",
  "release_version",
  "release_receipt_sha256",
];

function grant(objectKind, object, grantee, privilege) {
  return {
    objectKind,
    object,
    grantor: OWNER_ROLE,
    grantee,
    privilege,
    grantable: false,
  };
}

function ownerGrants(objectKind, objects, privileges) {
  return objects.flatMap((object) =>
    privileges.map((privilege) =>
      grant(objectKind, object.identity, OWNER_ROLE, privilege),
    ),
  );
}

const OWNER_GRANTS = [
  ...ownerGrants("database", CURRENT_INVENTORY.databases, [
    "CREATE",
    "CONNECT",
    "TEMPORARY",
  ]),
  ...ownerGrants("schema", CURRENT_INVENTORY.schemas, ["USAGE", "CREATE"]),
  ...ownerGrants("table", CURRENT_INVENTORY.tables, [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "MAINTAIN",
  ]),
  ...ownerGrants("sequence", CURRENT_INVENTORY.sequences, [
    "USAGE",
    "SELECT",
    "UPDATE",
  ]),
  ...ownerGrants("routine", CURRENT_INVENTORY.routines, ["EXECUTE"]),
  ...ownerGrants("type", CURRENT_INVENTORY.types, ["USAGE"]),
];

const DATABASE_GRANTS = LOGIN_ROLES.map((grantee) =>
  grant("database", "@database", grantee, "CONNECT"),
);

const SCHEMA_GRANTS = [
  APP_ROLE,
  WORKER_ROLE,
  OPS_ROLE,
  BACKUP_REPORTER_ROLE,
].map((grantee) => grant("schema", "public", grantee, "USAGE"));

const SPECIAL_RELATIONS = new Set([
  "public.email_outbox",
  "public.email_outbox_idempotency_authority",
  "public.mail_delivery_release_receipt",
  "public.backup_status_mail_authority",
  "public.backup_status_mail_admin_guard",
]);

const ORDINARY_TABLE_GRANTS = PUBLIC_TABLES.filter(
  (table) => !SPECIAL_RELATIONS.has(table.identity),
).flatMap((table) =>
  [APP_ROLE, WORKER_ROLE, OPS_ROLE].flatMap((grantee) =>
    ["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) =>
      grant("table", table.identity, grantee, privilege),
    ),
  ),
);

const EMAIL_OUTBOX_TABLE_GRANTS = [
  ...[APP_ROLE, WORKER_ROLE, OPS_ROLE].map((grantee) =>
    grant("table", "public.email_outbox", grantee, "SELECT"),
  ),
  ...[APP_ROLE, OPS_ROLE].map((grantee) =>
    grant("table", "public.email_outbox", grantee, "DELETE"),
  ),
];

function columnGrants(table, columns, grantee, privilege) {
  return columns.map((column) =>
    grant("column", `${table}.${column}`, grantee, privilege),
  );
}

const MAIL_COLUMN_GRANTS = [
  ...columnGrants(
    "public.email_outbox",
    MAIL_APP_OUTBOX_INSERT_COLUMNS,
    APP_ROLE,
    "INSERT",
  ),
  ...columnGrants(
    "public.email_outbox",
    MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
    WORKER_ROLE,
    "INSERT",
  ),
  ...columnGrants(
    "public.email_outbox",
    MAIL_WORKER_OUTBOX_UPDATE_COLUMNS,
    WORKER_ROLE,
    "UPDATE",
  ),
  ...columnGrants(
    "public.mail_delivery_release_receipt",
    MAIL_DELIVERY_RELEASE_RECEIPT_WORKER_SELECT_COLUMNS,
    WORKER_ROLE,
    "SELECT",
  ),
];

const TYPE_GRANTS = PUBLIC_TYPES.flatMap((type) =>
  [APP_ROLE, WORKER_ROLE, OPS_ROLE].map((grantee) =>
    grant("type", type.identity, grantee, "USAGE"),
  ),
);

const ROUTINE_ROLE_GRANTS = [
  [
    "enqueue_reward_jobs_for_attempt_v1(uuid,text,timestamp with time zone)",
    APP_ROLE,
  ],
  [
    "enqueue_reward_jobs_for_attempt_v1(uuid,text,timestamp with time zone)",
    WORKER_ROLE,
  ],
  [
    "enqueue_reward_jobs_for_mastery_scope_v1(uuid,text,timestamp with time zone)",
    APP_ROLE,
  ],
  [
    "enqueue_reward_jobs_for_mastery_scope_v1(uuid,text,timestamp with time zone)",
    WORKER_ROLE,
  ],
  ["release_email_outbox_delivery(uuid,uuid,text,text,text)", APP_ROLE],
  ["release_email_outbox_delivery(uuid,uuid,text,text,text)", WORKER_ROLE],
  ["verify_email_outbox_delivery_release(uuid,uuid,text,text,text)", APP_ROLE],
  ["backup_status_mail_authorized(uuid)", WORKER_ROLE],
  [
    "mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)",
    WORKER_ROLE,
  ],
  ["attest_email_outbox_delivery_release_lineage(text)", WORKER_ROLE],
  ["email_outbox_idempotency_coverage_authority(uuid[])", OPS_ROLE],
  [
    "redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)",
    OPS_ROLE,
  ],
  ["enqueue_backup_status_mail_authority(text,text)", BACKUP_REPORTER_ROLE],
].map(([signature, grantee]) =>
  grant("routine", `public.${signature}`, grantee, "EXECUTE"),
);

const CURRENT_GRANTS = [
  ...OWNER_GRANTS,
  ...DATABASE_GRANTS,
  ...SCHEMA_GRANTS,
  ...ORDINARY_TABLE_GRANTS,
  ...EMAIL_OUTBOX_TABLE_GRANTS,
  ...MAIL_COLUMN_GRANTS,
  ...TYPE_GRANTS,
  ...ROUTINE_ROLE_GRANTS,
];

function defaultAcl(
  creator,
  schema,
  objectKind,
  grantee,
  privilege,
  grantor = creator,
) {
  return {
    identity: [
      typeof creator === "string" ? creator : creator.kind,
      schema ?? "@global",
      objectKind,
      typeof grantee === "string" ? grantee : grantee.kind,
      privilege,
    ].join("|"),
    creator,
    schema,
    objectKind,
    grantor,
    grantee,
    privilege,
    grantable: false,
  };
}

function defaultAclRow(creator, schema, objectKind) {
  return {
    identity: [
      typeof creator === "string" ? creator : creator.kind,
      schema ?? "@global",
      objectKind,
    ].join("|"),
    creator,
    schema,
    objectKind,
  };
}

const CONTRACTED_DEFAULT_ACL_ROWS = [
  defaultAclRow(OWNER_ROLE, null, "routine"),
  defaultAclRow(OWNER_ROLE, null, "type"),
  defaultAclRow(BOOTSTRAP_SESSION_AUTHORITY, null, "routine"),
  defaultAclRow(BOOTSTRAP_SESSION_AUTHORITY, null, "type"),
];

const CURRENT_DEFAULT_ACL_ROWS = [
  ...CONTRACTED_DEFAULT_ACL_ROWS,
  defaultAclRow(OWNER_ROLE, "public", "table"),
  defaultAclRow(OWNER_ROLE, "public", "sequence"),
  defaultAclRow(OWNER_ROLE, "public", "type"),
];

const CONTRACTED_DEFAULT_ACLS = [
  defaultAcl(OWNER_ROLE, null, "routine", OWNER_ROLE, "EXECUTE"),
  defaultAcl(OWNER_ROLE, null, "type", OWNER_ROLE, "USAGE"),
  defaultAcl(
    BOOTSTRAP_SESSION_AUTHORITY,
    null,
    "routine",
    BOOTSTRAP_SESSION_AUTHORITY,
    "EXECUTE",
    BOOTSTRAP_SESSION_AUTHORITY,
  ),
  defaultAcl(
    BOOTSTRAP_SESSION_AUTHORITY,
    null,
    "type",
    BOOTSTRAP_SESSION_AUTHORITY,
    "USAGE",
    BOOTSTRAP_SESSION_AUTHORITY,
  ),
];

const CURRENT_DEFAULT_ACLS = [
  ...CONTRACTED_DEFAULT_ACLS,
  ...[APP_ROLE, WORKER_ROLE, OPS_ROLE].flatMap((grantee) =>
    ["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) =>
      defaultAcl(OWNER_ROLE, "public", "table", grantee, privilege),
    ),
  ),
  ...[APP_ROLE, WORKER_ROLE, OPS_ROLE].flatMap((grantee) =>
    ["USAGE", "SELECT", "UPDATE"].map((privilege) =>
      defaultAcl(OWNER_ROLE, "public", "sequence", grantee, privilege),
    ),
  ),
  ...[APP_ROLE, WORKER_ROLE, OPS_ROLE].map((grantee) =>
    defaultAcl(OWNER_ROLE, "public", "type", grantee, "USAGE"),
  ),
];

const CURRENT_PROVENANCE = {
  inventorySources: [
    {
      kind: "drizzle-snapshot",
      path: "drizzle/meta/0069_snapshot.json",
      publicTables: 125,
      publicColumns: 1_480,
      columnOrder: "migration-derived-pg-attribute-attnum-v1",
      physicalOrderSource: "drizzle/meta/0069_public_column_attnums.json",
      physicalOrderSha256: REVIEWED_0069_PUBLIC_COLUMN_MANIFEST_SHA256,
    },
    {
      kind: "reviewed-migration-overlay",
      path: "drizzle/0065_backup_status_mail_authority.sql",
      publicTables: 2,
      publicColumns: 9,
    },
    {
      kind: "drizzle-internal-contract",
      path: "drizzle/0069_mail_outbox_guarded_delivery_authority.sql",
      tables: 1,
      columns: 3,
      sequences: 1,
    },
  ],
  expected: {
    publicTables: 127,
    publicColumns: 1_489,
    publicTypes: 140,
    publicRoutines: 76,
    publicSequences: 0,
  },
};

function makePolicy({
  contract,
  phase,
  available,
  reviewedMigrationTail,
  requiredMigrationFile,
  reason,
  grants,
  defaultAclRows,
  defaultAcls,
}) {
  return {
    schemaVersion: DATABASE_RUNTIME_CAPABILITY_SCHEMA_VERSION,
    contract,
    phase,
    available,
    ledger: {
      reviewedMigrationTail,
      requiredMigrationFile,
      reason,
    },
    provenance: CURRENT_PROVENANCE,
    inventory: CURRENT_INVENTORY,
    roles: CURRENT_ROLES,
    memberships: CURRENT_MEMBERSHIPS,
    grants,
    defaultAclRows,
    defaultAcls,
  };
}

export const CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES = deepFreeze(
  makePolicy({
    contract: "codestead-database-runtime-capabilities-0069-current-v1",
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
    available: true,
    reviewedMigrationTail: CURRENT_0069_REVIEWED_MIGRATION_TAG,
    requiredMigrationFile:
      "drizzle/0069_mail_outbox_guarded_delivery_authority.sql",
    reason: null,
    grants: CURRENT_GRANTS,
    defaultAclRows: CURRENT_DEFAULT_ACL_ROWS,
    defaultAcls: CURRENT_DEFAULT_ACLS,
  }),
);

export const POST_CONTRACT_DATABASE_RUNTIME_CAPABILITIES = deepFreeze(
  makePolicy({
    contract: "codestead-database-runtime-capabilities-post-contract-v1",
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071,
    available: false,
    reviewedMigrationTail: "0071",
    requiredMigrationFile: null,
    reason:
      "Task 3 replacement identities and Task 4 capabilities are not yet reviewed; 0071 is unavailable",
    grants: CURRENT_GRANTS,
    defaultAclRows: CONTRACTED_DEFAULT_ACL_ROWS,
    defaultAcls: CONTRACTED_DEFAULT_ACLS,
  }),
);

export const PREDECESSOR_0070_DATABASE_RUNTIME_CAPABILITY_ALLOWANCE =
  deepFreeze({
    schemaVersion: DATABASE_RUNTIME_CAPABILITY_SCHEMA_VERSION,
    allowance: "codestead-database-runtime-predecessor-0070-v1",
    available: false,
    phase: DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070,
    validOnlyAtMigrationIndex: 70,
    expiresAtMigrationIndex: 71,
    reason:
      "The 0070 migration and Task 3 replacement identity delta are not yet reviewed",
    roles: [],
    memberships: [],
    grants: [],
    defaultAcls: [],
    defaultAclRows: [],
  });

const TOP_LEVEL_POLICY_KEYS = new Set([
  "schemaVersion",
  "contract",
  "phase",
  "available",
  "ledger",
  "provenance",
  "inventory",
  "roles",
  "memberships",
  "grants",
  "defaultAclRows",
  "defaultAcls",
]);

const POLICY_PHASE_DESCRIPTORS = Object.freeze({
  [DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069]: Object.freeze({
    contract: "codestead-database-runtime-capabilities-0069-current-v1",
    available: true,
    reviewedMigrationTail: CURRENT_0069_REVIEWED_MIGRATION_TAG,
    requiredMigrationFile:
      "drizzle/0069_mail_outbox_guarded_delivery_authority.sql",
    reason: null,
  }),
  [DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071]: Object.freeze({
    contract: "codestead-database-runtime-capabilities-post-contract-v1",
    available: false,
    reviewedMigrationTail: "0071",
    requiredMigrationFile: null,
    reason:
      "Task 3 replacement identities and Task 4 capabilities are not yet reviewed; 0071 is unavailable",
  }),
});

const INVENTORY_KEYS = Object.freeze([
  "databases",
  "schemas",
  "tables",
  "sequences",
  "types",
  "routines",
]);

const PRIVILEGES_BY_KIND = Object.freeze({
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
  type: new Set(["USAGE"]),
  routine: new Set(["EXECUTE"]),
});

function validationFailure(message) {
  throw new DatabaseRuntimeCapabilityValidationError(message);
}

function assertPlainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    validationFailure(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, keys, label) {
  assertPlainObject(value, label);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) validationFailure(`unknown ${label} key: ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key))
      validationFailure(`missing ${label} key: ${key}`);
  }
}

const ROLE_KEYS = Object.freeze([
  "identity",
  "name",
  "login",
  "superuser",
  "createDatabase",
  "createRole",
  "inherit",
  "replication",
  "bypassRls",
  "connectionLimit",
  "validUntil",
  "settings",
  "credential",
]);

const MEMBERSHIP_KEYS = Object.freeze([
  "identity",
  "role",
  "member",
  "grantor",
  "adminOption",
  "inheritOption",
  "setOption",
]);

function assertUnique(values, key, label) {
  const seen = new Set();
  for (const value of values) {
    assertPlainObject(value, `${label} entry`);
    const identity = key(value);
    if (seen.has(identity)) {
      validationFailure(`duplicate ${label}: ${identity}`);
    }
    seen.add(identity);
  }
}

function symbolicAuthority(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length === 1 &&
    value.kind === BOOTSTRAP_SESSION_AUTHORITY.kind
  );
}

function principalIdentity(value) {
  if (symbolicAuthority(value)) return "@bootstrap-session";
  if (value === "@bootstrap-session" || value === "bootstrap-session") {
    validationFailure("literal bootstrap-session authority is forbidden");
  }
  return value;
}

function defaultAclPrincipalLabel(value) {
  const principal = principalIdentity(value);
  return principal === "@bootstrap-session" ? "bootstrap-session" : principal;
}

function defaultAclRowIdentity(value) {
  return [
    defaultAclPrincipalLabel(value.creator),
    value.schema ?? "@global",
    value.objectKind,
  ].join("|");
}

function validateComparableDefaultAclRow(value, label = "default ACL row") {
  assertExactKeys(
    value,
    ["identity", "creator", "schema", "objectKind"],
    label,
  );
  const creator = defaultAclPrincipalLabel(value.creator);
  if (
    typeof creator !== "string" ||
    creator.length === 0 ||
    (value.schema !== null &&
      (typeof value.schema !== "string" || value.schema.length === 0)) ||
    typeof value.objectKind !== "string" ||
    value.objectKind.length === 0 ||
    value.identity !== defaultAclRowIdentity(value)
  ) {
    validationFailure(`invalid ${label}: ${value.identity}`);
  }
  return creator;
}

function validatePolicyDefaultAclRow(value, roleNames, phase) {
  const creator = validateComparableDefaultAclRow(value);
  const knownCreator =
    creator === "bootstrap-session" ? "@bootstrap-session" : creator;
  if (
    !new Set([...roleNames, "@bootstrap-session"]).has(knownCreator) ||
    !["table", "sequence", "routine", "type"].includes(value.objectKind) ||
    (value.schema !== null && value.schema !== "public")
  ) {
    validationFailure(`invalid default ACL row authority: ${value.identity}`);
  }
  if (
    phase === DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071 &&
    (value.schema !== null ||
      !["routine", "type"].includes(value.objectKind) ||
      ![OWNER_ROLE, "bootstrap-session"].includes(creator))
  ) {
    validationFailure(`broad post-contract default ACL row: ${value.identity}`);
  }
}

function assertDefaultAclTupleRows(defaultAcls, defaultAclRows, label) {
  const rowIdentities = new Set(defaultAclRows.map((entry) => entry.identity));
  for (const entry of defaultAcls) {
    const identity = defaultAclRowIdentity(entry);
    if (!rowIdentities.has(identity)) {
      validationFailure(
        `${label} tuple has no physical default ACL row: ${identity}`,
      );
    }
  }
}

function validateGrant(
  grantValue,
  { roleNames, objectIdentities, columnIdentities },
) {
  if (grantValue === null || typeof grantValue !== "object") {
    validationFailure("grant must be an object");
  }
  assertExactKeys(
    grantValue,
    ["objectKind", "object", "grantor", "grantee", "privilege", "grantable"],
    "grant",
  );
  const legalPrivileges = PRIVILEGES_BY_KIND[grantValue.objectKind];
  if (!legalPrivileges) {
    validationFailure(`unknown object kind: ${grantValue.objectKind}`);
  }
  if (
    typeof grantValue.object !== "string" ||
    grantValue.object.includes("*")
  ) {
    validationFailure("grant object must be an exact identity");
  }
  if (!legalPrivileges.has(grantValue.privilege)) {
    validationFailure(
      `unknown privilege ${grantValue.privilege} for ${grantValue.objectKind}`,
    );
  }
  if (grantValue.grantable !== false) {
    validationFailure("grant options are forbidden");
  }
  if (grantValue.grantee === "PUBLIC" || !roleNames.has(grantValue.grantee)) {
    validationFailure(`unknown or PUBLIC grantee: ${grantValue.grantee}`);
  }
  if (grantValue.grantor !== OWNER_ROLE) {
    validationFailure(`delegated grantor is forbidden: ${grantValue.grantor}`);
  }
  if (grantValue.objectKind === "database") {
    if (grantValue.object !== "@database") {
      validationFailure(`unknown database object: ${grantValue.object}`);
    }
  } else if (grantValue.objectKind === "column") {
    if (!columnIdentities.has(grantValue.object)) {
      validationFailure(`unknown column object: ${grantValue.object}`);
    }
  } else if (!objectIdentities[grantValue.objectKind].has(grantValue.object)) {
    validationFailure(
      `unknown ${grantValue.objectKind} object: ${grantValue.object}`,
    );
  }
}

function validateDefaultAcl(value, roleNames, phase) {
  if (value === null || typeof value !== "object") {
    validationFailure("default ACL must be an object");
  }
  assertExactKeys(
    value,
    [
      "identity",
      "creator",
      "schema",
      "objectKind",
      "grantor",
      "grantee",
      "privilege",
      "grantable",
    ],
    "default ACL",
  );
  const creator = principalIdentity(value.creator);
  const grantor = principalIdentity(value.grantor);
  const grantee = principalIdentity(value.grantee);
  const knownPrincipals = new Set([...roleNames, "@bootstrap-session"]);
  for (const [label, principal] of [
    ["creator", creator],
    ["grantor", grantor],
    ["grantee", grantee],
  ]) {
    if (!knownPrincipals.has(principal) || principal === "PUBLIC") {
      validationFailure(`unknown default ACL ${label}: ${principal}`);
    }
  }
  if (grantor !== creator) {
    validationFailure("delegated default ACL grantor is forbidden");
  }
  const expectedIdentity = [
    creator === "@bootstrap-session" ? "bootstrap-session" : creator,
    value.schema ?? "@global",
    value.objectKind,
    grantee === "@bootstrap-session" ? "bootstrap-session" : grantee,
    value.privilege,
  ].join("|");
  if (value.identity !== expectedIdentity) {
    validationFailure(`invalid default ACL identity: ${value.identity}`);
  }
  if (value.grantable !== false) {
    validationFailure("default ACL grant options are forbidden");
  }
  const legal = PRIVILEGES_BY_KIND[value.objectKind];
  if (
    !["table", "sequence", "routine", "type"].includes(value.objectKind) ||
    !legal?.has(value.privilege)
  ) {
    validationFailure("unknown default ACL kind or privilege");
  }
  if (value.schema !== null && value.schema !== "public") {
    validationFailure(`unknown default ACL schema: ${value.schema}`);
  }
  if (value.schema !== null && value.objectKind === "routine") {
    validationFailure("schema-local routine defaults are forbidden");
  }
  if (
    phase === DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071 &&
    (value.schema !== null ||
      !["routine", "type"].includes(value.objectKind) ||
      creator !== grantee)
  ) {
    validationFailure("broad post-contract default ACL is forbidden");
  }
}

export function validateDatabaseRuntimeCapabilities(value) {
  assertStrictJsonDomain(value);
  assertExactKeys(value, [...TOP_LEVEL_POLICY_KEYS], "capability manifest");
  if (value.schemaVersion !== DATABASE_RUNTIME_CAPABILITY_SCHEMA_VERSION) {
    validationFailure("unsupported capability schema version");
  }
  const descriptor = POLICY_PHASE_DESCRIPTORS[value.phase];
  if (descriptor === undefined) {
    validationFailure(`unavailable capability policy phase: ${value.phase}`);
  }
  if (
    value.contract !== descriptor.contract ||
    value.available !== descriptor.available
  ) {
    validationFailure("capability contract, phase, and availability disagree");
  }
  assertExactKeys(
    value.ledger,
    ["reviewedMigrationTail", "requiredMigrationFile", "reason"],
    "ledger",
  );
  if (
    value.ledger.reviewedMigrationTail !== descriptor.reviewedMigrationTail ||
    value.ledger.requiredMigrationFile !== descriptor.requiredMigrationFile ||
    value.ledger.reason !== descriptor.reason
  ) {
    validationFailure("capability phase is not bound to its exact migration");
  }
  if (value.available && value.ledger.reason !== null) {
    validationFailure("available policy must not carry an unavailable reason");
  }
  if (
    !value.available &&
    (typeof value.ledger.reason !== "string" ||
      value.ledger.reason.trim().length === 0)
  ) {
    validationFailure("unavailable policy must explain why it is unavailable");
  }
  assertPlainObject(value.provenance, "provenance");
  assertExactKeys(
    value.provenance,
    ["inventorySources", "expected"],
    "provenance",
  );
  if (!Array.isArray(value.provenance.inventorySources)) {
    validationFailure("provenance inventorySources must be an array");
  }
  assertPlainObject(value.provenance.expected, "provenance expected counts");
  for (const key of [
    "roles",
    "memberships",
    "grants",
    "defaultAcls",
    "defaultAclRows",
  ]) {
    if (!Array.isArray(value[key])) {
      validationFailure(`${key} must be an array`);
    }
  }
  assertExactKeys(value.inventory, INVENTORY_KEYS, "inventory");
  for (const key of INVENTORY_KEYS) {
    if (!Array.isArray(value.inventory[key])) {
      validationFailure(`inventory ${key} must be an array`);
    }
  }
  assertUnique(value.roles, (entry) => entry.identity, "role");
  const roleNames = new Set(value.roles.map((entry) => entry.name));
  for (const roleValue of value.roles) {
    assertExactKeys(roleValue, ROLE_KEYS, "role");
    if (
      roleValue.identity !== roleValue.name ||
      typeof roleValue.name !== "string" ||
      !/^[a-z][a-z0-9_]*$/u.test(roleValue.name) ||
      typeof roleValue.login !== "boolean" ||
      roleValue.superuser !== false ||
      roleValue.createDatabase !== false ||
      roleValue.createRole !== false ||
      roleValue.inherit !== false ||
      roleValue.replication !== false ||
      roleValue.bypassRls !== false ||
      roleValue.connectionLimit !== -1 ||
      roleValue.validUntil !== "infinity" ||
      !Array.isArray(roleValue.settings) ||
      roleValue.settings.length !== 0 ||
      roleValue.credential !== (roleValue.login ? "scram-managed" : "none")
    ) {
      validationFailure(`invalid role policy: ${roleValue.name}`);
    }
  }

  assertUnique(
    value.inventory.databases,
    (entry) => entry.identity,
    "inventory database",
  );
  for (const database of value.inventory.databases) {
    assertExactKeys(database, ["identity", "owner"], "database");
    if (database.identity !== "@database" || database.owner !== OWNER_ROLE) {
      validationFailure(`invalid database: ${database.identity}`);
    }
  }

  assertUnique(
    value.inventory.schemas,
    (entry) => entry.identity,
    "inventory schema",
  );
  for (const schema of value.inventory.schemas) {
    assertExactKeys(schema, ["identity", "name", "owner"], "schema");
    if (
      schema.identity !== schema.name ||
      !["public", "drizzle"].includes(schema.name) ||
      schema.owner !== OWNER_ROLE
    ) {
      validationFailure(`invalid schema: ${schema.identity}`);
    }
  }
  const schemaIdentities = new Set(
    value.inventory.schemas.map((entry) => entry.identity),
  );

  const tableIdentities = new Set();
  const columnIdentities = new Set();
  for (const table of value.inventory.tables) {
    assertExactKeys(
      table,
      ["identity", "schema", "name", "owner", "columns"],
      "table",
    );
    if (tableIdentities.has(table.identity)) {
      validationFailure(`duplicate table: ${table.identity}`);
    }
    tableIdentities.add(table.identity);
    if (
      table.identity !== `${table.schema}.${table.name}` ||
      !schemaIdentities.has(table.schema) ||
      table.owner !== OWNER_ROLE ||
      !/^[a-z_][a-z0-9_]*$/u.test(table.name) ||
      !Array.isArray(table.columns) ||
      table.columns.length === 0
    ) {
      validationFailure(`invalid table: ${table.identity}`);
    }
    const localColumns = new Set();
    const localOrdinals = new Set();
    for (const column of table.columns) {
      assertExactKeys(column, ["identity", "name", "ordinal"], "column");
      if (
        localColumns.has(column.identity) ||
        columnIdentities.has(column.identity)
      ) {
        validationFailure(`duplicate column: ${column.identity}`);
      }
      if (
        column.identity !== `${table.identity}.${column.name}` ||
        !/^[a-z_][a-z0-9_]*$/u.test(column.name) ||
        !Number.isSafeInteger(column.ordinal) ||
        column.ordinal < 1 ||
        localOrdinals.has(column.ordinal)
      ) {
        validationFailure(`dangling column: ${column.identity}`);
      }
      localColumns.add(column.identity);
      localOrdinals.add(column.ordinal);
      columnIdentities.add(column.identity);
    }
    if (
      Array.from(
        { length: table.columns.length },
        (_, index) => index + 1,
      ).some((ordinal) => !localOrdinals.has(ordinal))
    ) {
      validationFailure(`non-contiguous column ordinals: ${table.identity}`);
    }
  }
  for (const key of ["sequences", "types", "routines"]) {
    assertUnique(
      value.inventory[key],
      (entry) => entry.identity,
      `inventory ${key}`,
    );
    for (const entry of value.inventory[key]) {
      const commonKeys = ["identity", "schema", "name", "owner"];
      const allowedKeys =
        key === "sequences"
          ? commonKeys
          : key === "types"
            ? [
                ...commonKeys,
                "kind",
                ...(entry.kind === "enum" ? ["values"] : []),
              ]
            : ["identity", "schema", "signature", "kind", "owner"];
      assertExactKeys(entry, allowedKeys, key.slice(0, -1));
      const expectedIdentity =
        key === "routines"
          ? `${entry.schema}.${entry.signature}`
          : `${entry.schema}.${entry.name}`;
      if (
        entry.identity !== expectedIdentity ||
        !schemaIdentities.has(entry.schema) ||
        entry.owner !== OWNER_ROLE ||
        (key === "routines"
          ? typeof entry.signature !== "string" || entry.signature.length === 0
          : !/^[a-z_][a-z0-9_]*$/u.test(entry.name))
      ) {
        validationFailure(`invalid ${key} identity: ${entry.identity}`);
      }
      if (
        key === "types" &&
        (!["composite", "enum"].includes(entry.kind) ||
          (entry.kind === "enum" &&
            (!Array.isArray(entry.values) ||
              entry.values.some((item) => typeof item !== "string") ||
              new Set(entry.values).size !== entry.values.length)))
      ) {
        validationFailure(`invalid type policy: ${entry.identity}`);
      }
      if (key === "routines" && entry.kind !== "function") {
        validationFailure(`invalid routine policy: ${entry.identity}`);
      }
    }
  }

  assertUnique(value.memberships, (entry) => entry.identity, "membership");
  for (const membership of value.memberships) {
    assertExactKeys(membership, MEMBERSHIP_KEYS, "membership");
    if (
      !roleNames.has(membership.role) ||
      !roleNames.has(membership.member) ||
      membership.identity !== `${membership.role}->${membership.member}` ||
      !symbolicAuthority(membership.grantor) ||
      membership.adminOption !== false ||
      membership.inheritOption !== false ||
      membership.setOption !== true
    ) {
      validationFailure(`invalid membership: ${membership.identity}`);
    }
  }

  const objectIdentities = {
    schema: new Set(value.inventory.schemas.map((entry) => entry.identity)),
    table: tableIdentities,
    sequence: new Set(value.inventory.sequences.map((entry) => entry.identity)),
    type: new Set(value.inventory.types.map((entry) => entry.identity)),
    routine: new Set(value.inventory.routines.map((entry) => entry.identity)),
  };
  for (const grantValue of value.grants) {
    validateGrant(grantValue, {
      roleNames,
      objectIdentities,
      columnIdentities,
    });
  }
  assertUnique(
    value.grants,
    (entry) => canonicalDatabaseRuntimeCapabilitiesJson(entry),
    "grant tuple",
  );
  assertUnique(value.grants, grantAuthorityIdentity, "grant authority");
  for (const entry of value.defaultAclRows) {
    validatePolicyDefaultAclRow(entry, roleNames, value.phase);
  }
  assertUnique(
    value.defaultAclRows,
    (entry) => entry.identity,
    "default ACL row",
  );
  for (const entry of value.defaultAcls) {
    validateDefaultAcl(entry, roleNames, value.phase);
  }
  assertDefaultAclTupleRows(
    value.defaultAcls,
    value.defaultAclRows,
    "default ACL",
  );
  assertUnique(
    value.defaultAcls,
    (entry) => canonicalDatabaseRuntimeCapabilitiesJson(entry),
    "default ACL tuple",
  );
  const exactAuthority = {
    provenance: CURRENT_PROVENANCE,
    inventory: CURRENT_INVENTORY,
    roles: CURRENT_ROLES,
    memberships: CURRENT_MEMBERSHIPS,
    grants: CURRENT_GRANTS,
    defaultAclRows:
      value.phase === DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069
        ? CURRENT_DEFAULT_ACL_ROWS
        : CONTRACTED_DEFAULT_ACL_ROWS,
    defaultAcls:
      value.phase === DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069
        ? CURRENT_DEFAULT_ACLS
        : CONTRACTED_DEFAULT_ACLS,
  };
  for (const [key, expected] of Object.entries(exactAuthority)) {
    if (!isDeepEqual(value[key], expected)) {
      validationFailure(
        `${value.phase} ${key} differs from the reviewed closed-world authority`,
      );
    }
  }
  return value;
}

function canonicalTuple(value) {
  assertStrictJsonDomain(value);
  return canonicalDatabaseRuntimeCapabilitiesJsonUnchecked(value);
}

function exactSetDifference(left, right) {
  const rightCounts = new Map();
  for (const entry of right) {
    const key = canonicalTuple(entry);
    rightCounts.set(key, (rightCounts.get(key) ?? 0) + 1);
  }
  const difference = [];
  for (const entry of left) {
    const key = canonicalTuple(entry);
    const remaining = rightCounts.get(key) ?? 0;
    if (remaining > 0) {
      rightCounts.set(key, remaining - 1);
    } else {
      difference.push(entry);
    }
  }
  return difference.toSorted((leftEntry, rightEntry) =>
    compareCodePoints(canonicalTuple(leftEntry), canonicalTuple(rightEntry)),
  );
}

function sortByIdentity(entries, identity) {
  return entries.toSorted((left, right) =>
    compareCodePoints(identity(left), identity(right)),
  );
}

function assertUniqueIdentities(entries, identity, label) {
  const seen = new Set();
  for (const entry of entries) {
    const key = identity(entry);
    if (typeof key !== "string" || key.length === 0) {
      validationFailure(`${label} identity must be a non-empty string`);
    }
    if (seen.has(key)) {
      validationFailure(`duplicate ${label} identity: ${key}`);
    }
    seen.add(key);
  }
}

function keyedDelta(expected, observed, identity, label) {
  assertUniqueIdentities(expected, identity, `expected ${label}`);
  assertUniqueIdentities(observed, identity, `observed ${label}`);
  const expectedByIdentity = new Map(
    expected.map((entry) => [identity(entry), entry]),
  );
  const observedByIdentity = new Map(
    observed.map((entry) => [identity(entry), entry]),
  );
  return {
    missing: sortByIdentity(
      [...expectedByIdentity.entries()]
        .filter(([key]) => !observedByIdentity.has(key))
        .map(([, entry]) => entry),
      identity,
    ),
    extra: sortByIdentity(
      [...observedByIdentity.entries()]
        .filter(([key]) => !expectedByIdentity.has(key))
        .map(([, entry]) => entry),
      identity,
    ),
    paired: [...expectedByIdentity.entries()]
      .filter(([key]) => observedByIdentity.has(key))
      .map(([key, expectedEntry]) => ({
        identity: key,
        expected: expectedEntry,
        observed: observedByIdentity.get(key),
      }))
      .toSorted((left, right) =>
        compareCodePoints(left.identity, right.identity),
      ),
  };
}

function inventoryColumns(inventory) {
  return inventory.tables.flatMap((table) => table.columns);
}

function comparableColumnDefinition(value) {
  return {
    identity: value.identity,
    name: value.name,
    ordinal: value.ordinal,
  };
}

function comparableTableDefinition(value) {
  return {
    identity: value.identity,
    schema: value.schema,
    name: value.name,
    owner: value.owner,
    columns: value.columns.map(comparableColumnDefinition),
  };
}

function validateComparableGrant(
  grantValue,
  { roleNames, objectIdentities, columnIdentities },
) {
  assertExactKeys(
    grantValue,
    ["objectKind", "object", "grantor", "grantee", "privilege", "grantable"],
    "catalog grant",
  );
  const legalPrivileges = PRIVILEGES_BY_KIND[grantValue.objectKind];
  if (!legalPrivileges) {
    validationFailure(
      `unknown catalog grant object kind: ${grantValue.objectKind}`,
    );
  }
  if (
    typeof grantValue.object !== "string" ||
    grantValue.object.includes("*") ||
    !legalPrivileges.has(grantValue.privilege) ||
    typeof grantValue.grantable !== "boolean" ||
    grantValue.grantor !== OWNER_ROLE ||
    (grantValue.grantee !== "PUBLIC" && !roleNames.has(grantValue.grantee))
  ) {
    validationFailure("invalid catalog grant tuple");
  }
  if (grantValue.objectKind === "database") {
    if (grantValue.object !== "@database") {
      validationFailure(
        `unknown catalog database object: ${grantValue.object}`,
      );
    }
  } else if (grantValue.objectKind === "column") {
    if (!columnIdentities.has(grantValue.object)) {
      validationFailure(`unknown catalog column object: ${grantValue.object}`);
    }
  } else if (!objectIdentities[grantValue.objectKind].has(grantValue.object)) {
    validationFailure(
      `unknown catalog ${grantValue.objectKind} object: ${grantValue.object}`,
    );
  }
}

function validateComparableDefaultAcl(value, { roleNames, schemaIdentities }) {
  assertExactKeys(
    value,
    [
      "identity",
      "creator",
      "schema",
      "objectKind",
      "grantor",
      "grantee",
      "privilege",
      "grantable",
    ],
    "catalog default ACL tuple",
  );
  const creator = principalIdentity(value.creator);
  const grantor = principalIdentity(value.grantor);
  const grantee = principalIdentity(value.grantee);
  const knownPrincipals = new Set([...roleNames, "@bootstrap-session"]);
  if (
    typeof creator !== "string" ||
    !knownPrincipals.has(creator) ||
    creator === "PUBLIC" ||
    typeof grantor !== "string" ||
    !knownPrincipals.has(grantor) ||
    grantor !== creator ||
    typeof grantee !== "string" ||
    (grantee !== "PUBLIC" && !knownPrincipals.has(grantee)) ||
    typeof value.grantable !== "boolean" ||
    !["table", "sequence", "routine", "type"].includes(value.objectKind) ||
    !PRIVILEGES_BY_KIND[value.objectKind]?.has(value.privilege) ||
    (value.schema !== null && !schemaIdentities.has(value.schema))
  ) {
    validationFailure("invalid catalog default ACL tuple");
  }
  const expectedIdentity = [
    creator === "@bootstrap-session" ? "bootstrap-session" : creator,
    value.schema ?? "@global",
    value.objectKind,
    grantee === "@bootstrap-session" ? "bootstrap-session" : grantee,
    value.privilege,
  ].join("|");
  if (value.identity !== expectedIdentity) {
    validationFailure(
      `invalid catalog default ACL identity: ${value.identity}`,
    );
  }
}

function validateComparableCatalog(value, expected) {
  assertStrictJsonDomain(value);
  assertPlainObject(value, "catalog capabilities");
  assertExactKeys(value, [...TOP_LEVEL_POLICY_KEYS], "catalog capabilities");
  for (const key of [
    "schemaVersion",
    "contract",
    "phase",
    "available",
    "ledger",
    "provenance",
  ]) {
    if (!isDeepEqual(value[key], expected[key])) {
      validationFailure(`catalog metadata mismatch: ${key}`);
    }
  }
  assertExactKeys(value.inventory, INVENTORY_KEYS, "catalog inventory");
  for (const key of INVENTORY_KEYS) {
    if (!Array.isArray(value.inventory[key])) {
      validationFailure(`catalog inventory ${key} must be an array`);
    }
  }
  for (const key of [
    "roles",
    "memberships",
    "grants",
    "defaultAcls",
    "defaultAclRows",
  ]) {
    if (!Array.isArray(value[key])) {
      validationFailure(`catalog ${key} must be an array`);
    }
  }
  const roleNames = new Set([
    ...expected.roles.map((entry) => entry.name),
    ...value.roles.map((entry) => entry.name),
  ]);
  const identities = (key) =>
    new Set([
      ...expected.inventory[key].map((entry) => entry.identity),
      ...value.inventory[key].map((entry) => entry.identity),
    ]);
  const objectIdentities = {
    schema: identities("schemas"),
    table: identities("tables"),
    sequence: identities("sequences"),
    type: identities("types"),
    routine: identities("routines"),
  };
  for (const table of value.inventory.tables) {
    assertExactKeys(
      table,
      ["identity", "schema", "name", "owner", "columns"],
      "catalog table",
    );
    if (!Array.isArray(table.columns)) {
      validationFailure(
        `catalog table ${table.identity} columns must be an array`,
      );
    }
    for (const column of table.columns) {
      assertExactKeys(
        column,
        ["identity", "name", "ordinal"],
        "catalog column",
      );
    }
  }
  assertUniqueIdentities(
    inventoryColumns(value.inventory),
    (entry) => entry.identity,
    "observed column",
  );
  const columnIdentities = new Set([
    ...inventoryColumns(expected.inventory).map((entry) => entry.identity),
    ...inventoryColumns(value.inventory).map((entry) => entry.identity),
  ]);
  for (const grantValue of value.grants) {
    validateComparableGrant(grantValue, {
      roleNames,
      objectIdentities,
      columnIdentities,
    });
  }
  assertUnique(value.grants, canonicalTuple, "observed grant tuple");
  assertUnique(
    value.grants,
    grantAuthorityIdentity,
    "observed grant authority",
  );
  for (const row of value.defaultAclRows) {
    validateComparableDefaultAclRow(row, "catalog default ACL row");
  }
  assertUniqueIdentities(
    value.defaultAclRows,
    (entry) => entry.identity,
    "observed default ACL row",
  );
  for (const entry of value.defaultAcls) {
    validateComparableDefaultAcl(entry, {
      roleNames,
      schemaIdentities: objectIdentities.schema,
    });
  }
  assertUniqueIdentities(
    value.defaultAcls,
    (entry) => entry.identity,
    "observed default ACL tuple",
  );
  assertDefaultAclTupleRows(
    value.defaultAcls,
    value.defaultAclRows,
    "catalog default ACL",
  );
}

export function diffDatabaseRuntimeCapabilities(expected, observed) {
  validateDatabaseRuntimeCapabilities(expected);
  validateComparableCatalog(observed, expected);
  const databaseDelta = keyedDelta(
    expected.inventory.databases,
    observed.inventory.databases,
    (entry) => entry.identity,
    "database",
  );
  const tableDelta = keyedDelta(
    expected.inventory.tables,
    observed.inventory.tables,
    (entry) => entry.identity,
    "table",
  );
  const columnDelta = keyedDelta(
    inventoryColumns(expected.inventory).map(comparableColumnDefinition),
    inventoryColumns(observed.inventory).map(comparableColumnDefinition),
    (entry) => entry.identity,
    "column",
  );
  const sequenceDelta = keyedDelta(
    expected.inventory.sequences,
    observed.inventory.sequences,
    (entry) => entry.identity,
    "sequence",
  );
  const typeDelta = keyedDelta(
    expected.inventory.types,
    observed.inventory.types,
    (entry) => entry.identity,
    "type",
  );
  const routineDelta = keyedDelta(
    expected.inventory.routines,
    observed.inventory.routines,
    (entry) => entry.identity,
    "routine",
  );
  const schemaDelta = keyedDelta(
    expected.inventory.schemas,
    observed.inventory.schemas,
    (entry) => entry.identity,
    "schema",
  );
  const roleDelta = keyedDelta(
    expected.roles,
    observed.roles,
    (entry) => entry.identity,
    "role",
  );
  const membershipDelta = keyedDelta(
    expected.memberships,
    observed.memberships,
    (entry) => entry.identity,
    "membership",
  );
  const defaultAclRowDelta = keyedDelta(
    expected.defaultAclRows,
    observed.defaultAclRows,
    (entry) => entry.identity,
    "default ACL row",
  );
  const ownerPairs = [
    ...databaseDelta.paired,
    ...tableDelta.paired,
    ...sequenceDelta.paired,
    ...typeDelta.paired,
    ...routineDelta.paired,
    ...schemaDelta.paired,
  ].filter(({ expected: left, observed: right }) => left.owner !== right.owner);
  const mismatchedInventory = Object.fromEntries(
    [
      ["databases", databaseDelta],
      ["schemas", schemaDelta],
      ["tables", tableDelta],
      ["columns", columnDelta],
      ["sequences", sequenceDelta],
      ["types", typeDelta],
      ["routines", routineDelta],
    ].map(([key, delta]) => [
      key,
      key === "tables"
        ? delta.paired.filter(
            ({ expected: left, observed: right }) =>
              !isDeepEqual(
                comparableTableDefinition(left),
                comparableTableDefinition(right),
              ),
          )
        : delta.paired.filter(
            ({ expected: left, observed: right }) => !isDeepEqual(left, right),
          ),
    ]),
  );
  const mismatchedRoles = roleDelta.paired.filter(
    ({ expected: left, observed: right }) => !isDeepEqual(left, right),
  );
  const mismatchedMemberships = membershipDelta.paired.filter(
    ({ expected: left, observed: right }) => !isDeepEqual(left, right),
  );
  const missing = {
    inventory: {
      databases: databaseDelta.missing,
      tables: tableDelta.missing,
      columns: columnDelta.missing,
      sequences: sequenceDelta.missing,
      types: typeDelta.missing,
      routines: routineDelta.missing,
      schemas: schemaDelta.missing,
    },
    roles: roleDelta.missing,
    memberships: membershipDelta.missing,
    grants: exactSetDifference(expected.grants, observed.grants),
    defaultAclRows: defaultAclRowDelta.missing,
    defaultAcls: exactSetDifference(expected.defaultAcls, observed.defaultAcls),
  };
  const extra = {
    inventory: {
      databases: databaseDelta.extra,
      tables: tableDelta.extra,
      columns: columnDelta.extra,
      sequences: sequenceDelta.extra,
      types: typeDelta.extra,
      routines: routineDelta.extra,
      schemas: schemaDelta.extra,
    },
    roles: roleDelta.extra,
    memberships: membershipDelta.extra,
    grants: exactSetDifference(observed.grants, expected.grants),
    defaultAclRows: defaultAclRowDelta.extra,
    defaultAcls: exactSetDifference(observed.defaultAcls, expected.defaultAcls),
  };
  const mismatched = {
    owners: ownerPairs,
    inventory: mismatchedInventory,
    roles: mismatchedRoles,
    memberships: mismatchedMemberships,
    defaultAclRows: defaultAclRowDelta.paired.filter(
      ({ expected: left, observed: right }) => !isDeepEqual(left, right),
    ),
  };
  const nonEmpty = (value) =>
    Object.values(value).some((entry) =>
      Array.isArray(entry) ? entry.length > 0 : nonEmpty(entry),
    );
  return {
    matches: !nonEmpty(missing) && !nonEmpty(extra) && !nonEmpty(mismatched),
    missing,
    extra,
    mismatched,
  };
}

function isDeepEqual(left, right) {
  return canonicalTuple(left) === canonicalTuple(right);
}

const ALLOWANCE_KEYS = Object.freeze([
  "schemaVersion",
  "allowance",
  "available",
  "phase",
  "validOnlyAtMigrationIndex",
  "expiresAtMigrationIndex",
  "reason",
  "roles",
  "memberships",
  "grants",
  "defaultAcls",
  "defaultAclRows",
]);

export function validateDatabaseRuntimeCapabilityAllowance(
  value,
  pairedPolicy = null,
) {
  if (pairedPolicy !== null) {
    validateDatabaseRuntimeCapabilities(pairedPolicy);
  }
  assertStrictJsonDomain(value);
  assertExactKeys(value, ALLOWANCE_KEYS, "predecessor allowance");
  if (
    value.schemaVersion !== DATABASE_RUNTIME_CAPABILITY_SCHEMA_VERSION ||
    value.allowance !== "codestead-database-runtime-predecessor-0070-v1" ||
    value.phase !== DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070 ||
    value.validOnlyAtMigrationIndex !== 70 ||
    value.expiresAtMigrationIndex !== 71 ||
    typeof value.available !== "boolean"
  ) {
    validationFailure("invalid predecessor allowance identity or bounds");
  }
  for (const key of [
    "roles",
    "memberships",
    "grants",
    "defaultAcls",
    "defaultAclRows",
  ]) {
    if (!Array.isArray(value[key])) {
      validationFailure(`allowance ${key} must be an array`);
    }
  }
  if (
    value.available
      ? value.reason !== null
      : typeof value.reason !== "string" || value.reason.trim().length === 0
  ) {
    validationFailure("allowance availability and reason disagree");
  }
  if (
    !value.available &&
    ["roles", "memberships", "grants", "defaultAcls", "defaultAclRows"].some(
      (key) => value[key].length !== 0,
    )
  ) {
    validationFailure(
      "an unavailable allowance must not carry authority tuples",
    );
  }
  assertUnique(value.roles, (entry) => entry.identity, "allowance role");
  const roleNames = new Set(CURRENT_ROLES.map((entry) => entry.name));
  for (const roleValue of value.roles) {
    assertExactKeys(roleValue, ROLE_KEYS, "allowance role");
    if (
      roleValue.identity !== roleValue.name ||
      typeof roleValue.login !== "boolean" ||
      !/^[a-z][a-z0-9_]*$/u.test(roleValue.name) ||
      roleValue.superuser !== false ||
      roleValue.createDatabase !== false ||
      roleValue.createRole !== false ||
      roleValue.inherit !== false ||
      roleValue.replication !== false ||
      roleValue.bypassRls !== false ||
      roleValue.connectionLimit !== -1 ||
      roleValue.validUntil !== "infinity" ||
      !Array.isArray(roleValue.settings) ||
      roleValue.settings.length !== 0 ||
      roleValue.credential !== (roleValue.login ? "scram-managed" : "none")
    ) {
      validationFailure(`invalid allowance role: ${roleValue.identity}`);
    }
    roleNames.add(roleValue.name);
  }
  assertUnique(
    value.memberships,
    (entry) => entry.identity,
    "allowance membership",
  );
  for (const membership of value.memberships) {
    assertExactKeys(membership, MEMBERSHIP_KEYS, "allowance membership");
    if (
      membership.identity !== `${membership.role}->${membership.member}` ||
      !roleNames.has(membership.role) ||
      !roleNames.has(membership.member) ||
      membership.role === membership.member ||
      !symbolicAuthority(membership.grantor) ||
      membership.adminOption !== false ||
      membership.inheritOption !== false ||
      membership.setOption !== true
    ) {
      validationFailure(`invalid allowance membership: ${membership.identity}`);
    }
  }
  const objectIdentities = {
    schema: new Set(CURRENT_INVENTORY.schemas.map((entry) => entry.identity)),
    table: new Set(CURRENT_INVENTORY.tables.map((entry) => entry.identity)),
    sequence: new Set(
      CURRENT_INVENTORY.sequences.map((entry) => entry.identity),
    ),
    type: new Set(CURRENT_INVENTORY.types.map((entry) => entry.identity)),
    routine: new Set(CURRENT_INVENTORY.routines.map((entry) => entry.identity)),
  };
  const columnIdentities = new Set(
    inventoryColumns(CURRENT_INVENTORY).map((entry) => entry.identity),
  );
  for (const grantValue of value.grants) {
    validateGrant(grantValue, {
      roleNames,
      objectIdentities,
      columnIdentities,
    });
  }
  for (const row of value.defaultAclRows) {
    validateComparableDefaultAclRow(row, "allowance default ACL row");
  }
  assertUnique(
    value.defaultAclRows,
    (entry) => entry.identity,
    "allowance default ACL row",
  );
  for (const defaultAcl of value.defaultAcls) {
    validateDefaultAcl(
      defaultAcl,
      roleNames,
      DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070,
    );
  }
  for (const key of ["grants", "defaultAcls"]) {
    assertUnique(value[key], canonicalTuple, `allowance ${key} tuple`);
  }
  for (const key of [
    "roles",
    "memberships",
    "grants",
    "defaultAcls",
    "defaultAclRows",
  ]) {
    if (
      exactSetDifference(
        value[key],
        CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES[key],
      ).length !== 0
    ) {
      validationFailure(`allowance ${key} contains non-predecessor authority`);
    }
  }
  assertDefaultAclTupleRows(
    value.defaultAcls,
    pairedPolicy === null
      ? value.defaultAclRows
      : [...pairedPolicy.defaultAclRows, ...value.defaultAclRows],
    pairedPolicy === null
      ? "allowance default ACL"
      : "policy/allowance default ACL",
  );
  return value;
}

function classifyExactCollectionDelta({
  phase,
  expected,
  observed,
  allowanceEntries,
  identity = canonicalTuple,
}) {
  const grant = exactSetDifference(expected, observed);
  const extras = exactSetDifference(observed, expected);
  const allowanceCounts = new Map();
  for (const entry of allowanceEntries) {
    const key = canonicalTuple(entry);
    allowanceCounts.set(key, (allowanceCounts.get(key) ?? 0) + 1);
  }
  const reportOnly = [];
  const revoke = [];
  const forbidden = [];
  for (const entry of extras) {
    const key = canonicalTuple(entry);
    const remaining = allowanceCounts.get(key) ?? 0;
    const isAllowed = remaining > 0;
    if (isAllowed) allowanceCounts.set(key, remaining - 1);
    if (
      phase === DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070 &&
      isAllowed
    ) {
      reportOnly.push(entry);
    } else if (phase === DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069) {
      revoke.push(entry);
    } else {
      forbidden.push(entry);
    }
  }
  const deferredIdentities = new Set(reportOnly.map(identity));
  return {
    grant: grant.filter((entry) => !deferredIdentities.has(identity(entry))),
    revoke,
    reportOnly,
    forbidden,
  };
}

export function classifyDatabaseRuntimeCapabilityPredecessorDelta({
  phase,
  collection,
  expected,
  observed,
  allowance = null,
}) {
  if (
    ![
      "roles",
      "memberships",
      "grants",
      "defaultAcls",
      "defaultAclRows",
    ].includes(collection)
  ) {
    validationFailure(`unsupported predecessor collection: ${collection}`);
  }
  if (!Array.isArray(expected) || !Array.isArray(observed)) {
    validationFailure("predecessor delta inputs must be arrays");
  }
  if (
    ![
      DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
      DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070,
      DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071,
    ].includes(phase)
  ) {
    phaseFailure(`unsupported capability delta phase: ${phase}`);
  }
  if (phase === DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069) {
    if (allowance !== null) {
      phaseFailure("the 0069 current phase forbids predecessor allowances");
    }
  } else if (phase === DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070) {
    validateDatabaseRuntimeCapabilityAllowance(allowance);
    if (!allowance.available) {
      phaseFailure("the predecessor allowance is unavailable");
    }
  } else if (allowance !== null) {
    phaseFailure("the expired 0070 predecessor allowance is forbidden at 0071");
  }
  return classifyExactCollectionDelta({
    phase,
    expected,
    observed,
    allowanceEntries: allowance?.[collection] ?? [],
    identity:
      collection === "roles" ||
      collection === "memberships" ||
      collection === "defaultAclRows"
        ? (entry) => entry.identity
        : canonicalTuple,
  });
}

export function classifyDatabaseRuntimeCapabilityGrantDelta({
  phase,
  expectedGrants,
  observedGrants,
  allowance = null,
}) {
  return classifyDatabaseRuntimeCapabilityPredecessorDelta({
    phase,
    collection: "grants",
    expected: expectedGrants,
    observed: observedGrants,
    allowance,
  });
}

function mutation(action, collection, value, identity) {
  return {
    action,
    collection,
    ...(identity === undefined ? {} : { identity }),
    value,
  };
}

function plannerAuthorityFailure(message) {
  throw new DatabaseRuntimeCapabilityPhaseError(message);
}

function validatePlannerAuthority({ phase, policy, allowance }) {
  validateDatabaseRuntimeCapabilities(policy);
  if (policy.available !== true) {
    plannerAuthorityFailure(`capability policy ${policy.phase} is unavailable`);
  }
  if (phase !== policy.phase) {
    plannerAuthorityFailure(
      `planner phase ${phase} does not match policy phase ${policy.phase}`,
    );
  }
  if (phase === DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069) {
    if (allowance !== null) {
      plannerAuthorityFailure("the 0069 current phase forbids an allowance");
    }
    return;
  }
  if (
    phase !== DATABASE_RUNTIME_CAPABILITY_PHASES.EXPAND_PREPARE_0070 &&
    phase !== DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071
  ) {
    plannerAuthorityFailure(`unsupported planner phase: ${phase}`);
  }
  if (phase === DATABASE_RUNTIME_CAPABILITY_PHASES.CONTRACTED_0071) {
    if (allowance !== null) {
      plannerAuthorityFailure(
        "the expired 0070 predecessor allowance is forbidden at 0071",
      );
    }
  } else {
    validateDatabaseRuntimeCapabilityAllowance(allowance, policy);
    if (
      allowance.available !== true ||
      !isDeepEqual(
        allowance,
        PREDECESSOR_0070_DATABASE_RUNTIME_CAPABILITY_ALLOWANCE,
      )
    ) {
      plannerAuthorityFailure(
        "the checked-in predecessor allowance is unavailable or altered",
      );
    }
  }
  const allowanceCollections = allowance ?? {
    roles: [],
    memberships: [],
    grants: [],
    defaultAcls: [],
    defaultAclRows: [],
  };
  for (const key of [
    "roles",
    "memberships",
    "grants",
    "defaultAcls",
    "defaultAclRows",
  ]) {
    if (
      exactSetDifference(allowanceCollections[key], policy[key]).length !==
      allowanceCollections[key].length
    ) {
      plannerAuthorityFailure(
        `predecessor allowance overlaps post-contract ${key}`,
      );
    }
  }
}

function collapseIdentityReplacements(delta, mismatches, identity) {
  const reportOnlyIdentities = new Set(delta.reportOnly.map(identity));
  const replacements = mismatches.filter(
    (entry) => !reportOnlyIdentities.has(entry.identity),
  );
  const replacementIdentities = new Set(
    replacements.map((entry) => entry.identity),
  );
  return {
    ...delta,
    grant: delta.grant.filter(
      (entry) => !replacementIdentities.has(identity(entry)),
    ),
    revoke: delta.revoke.filter(
      (entry) => !replacementIdentities.has(identity(entry)),
    ),
    replacements,
  };
}

function appendMutations(target, action, collection, entries, identity) {
  for (const entry of entries) {
    target.push(
      mutation(
        action,
        collection,
        entry,
        identity === undefined ? undefined : identity(entry),
      ),
    );
  }
}

function grantAuthorityIdentity(value) {
  return canonicalTuple({
    objectKind: value.objectKind,
    object: value.object,
    grantor: value.grantor,
    grantee: value.grantee,
    privilege: value.privilege,
  });
}

function grantAdditionsAfterTableRevokes(policy, grantDelta) {
  const replacementGrantIdentities = new Set(
    grantDelta.grant.map(grantAuthorityIdentity),
  );
  const fullTableRevokeIdentities = new Set(
    grantDelta.revoke
      .filter(
        (entry) =>
          entry.objectKind === "table" &&
          !replacementGrantIdentities.has(grantAuthorityIdentity(entry)),
      )
      .map(grantAuthorityIdentity),
  );
  const additions = new Map(
    grantDelta.grant.map((entry) => [canonicalTuple(entry), entry]),
  );
  const tableIdentityByColumn = new Map(
    policy.inventory.tables.flatMap((table) =>
      table.columns.map((column) => [column.identity, table.identity]),
    ),
  );

  for (const entry of policy.grants) {
    if (entry.objectKind !== "column") continue;
    const tableIdentity = tableIdentityByColumn.get(entry.object);
    if (tableIdentity === undefined) {
      plannerAuthorityFailure(
        `column grant has no table identity: ${entry.object}`,
      );
    }
    const tableGrantIdentity = grantAuthorityIdentity({
      ...entry,
      objectKind: "table",
      object: tableIdentity,
    });
    if (fullTableRevokeIdentities.has(tableGrantIdentity)) {
      additions.set(canonicalTuple(entry), entry);
    }
  }

  return [...additions.values()].toSorted((left, right) =>
    compareCodePoints(canonicalTuple(left), canonicalTuple(right)),
  );
}

function partitionRepairableDefaultAclRowRevocations({
  policy,
  catalog,
  defaultAclDelta,
  defaultAclRowDelta,
}) {
  const knownCreators = new Set(
    policy.defaultAclRows.map((entry) =>
      defaultAclPrincipalLabel(entry.creator),
    ),
  );
  const knownSchemas = new Set(
    policy.inventory.schemas.map((entry) => entry.identity),
  );
  const revocableTuples = new Set(
    defaultAclDelta.revoke.map((entry) => canonicalTuple(entry)),
  );
  const tuplesByRow = new Map();
  for (const entry of catalog.defaultAcls) {
    const identity = defaultAclRowIdentity(entry);
    const rows = tuplesByRow.get(identity) ?? [];
    rows.push(entry);
    tuplesByRow.set(identity, rows);
  }
  const repairable = [];
  const forbidden = [];
  for (const row of defaultAclRowDelta.revoke) {
    const creator = defaultAclPrincipalLabel(row.creator);
    const tuples = tuplesByRow.get(row.identity) ?? [];
    const knownAuthority =
      knownCreators.has(creator) &&
      row.schema !== null &&
      knownSchemas.has(row.schema) &&
      ["table", "sequence", "routine", "type"].includes(row.objectKind);
    if (
      knownAuthority &&
      tuples.length > 0 &&
      tuples.every((entry) => revocableTuples.has(canonicalTuple(entry)))
    ) {
      repairable.push(row);
    } else {
      forbidden.push(row);
    }
  }
  return { repairable, forbidden };
}

export function planDatabaseRuntimeCapabilityReconciliation({
  phase,
  policy,
  catalog,
  allowance = null,
}) {
  validatePlannerAuthority({ phase, policy, allowance });
  const drift = diffDatabaseRuntimeCapabilities(policy, catalog);
  const allowanceCollections = allowance ?? {
    roles: [],
    memberships: [],
    grants: [],
    defaultAcls: [],
    defaultAclRows: [],
  };
  let roleDelta = classifyExactCollectionDelta({
    phase,
    expected: policy.roles,
    observed: catalog.roles,
    allowanceEntries: allowanceCollections.roles,
    identity: (entry) => entry.identity,
  });
  roleDelta = collapseIdentityReplacements(
    roleDelta,
    drift.mismatched.roles,
    (entry) => entry.identity,
  );
  if (phase === DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069) {
    roleDelta.forbidden.push(...roleDelta.revoke);
    roleDelta.revoke = [];
  }
  let membershipDelta = classifyExactCollectionDelta({
    phase,
    expected: policy.memberships,
    observed: catalog.memberships,
    allowanceEntries: allowanceCollections.memberships,
    identity: (entry) => entry.identity,
  });
  membershipDelta = collapseIdentityReplacements(
    membershipDelta,
    drift.mismatched.memberships,
    (entry) => entry.identity,
  );
  const grantDelta = classifyExactCollectionDelta({
    phase,
    expected: policy.grants,
    observed: catalog.grants,
    allowanceEntries: allowanceCollections.grants,
  });
  const grantAdditions = grantAdditionsAfterTableRevokes(policy, grantDelta);
  const defaultAclDelta = classifyExactCollectionDelta({
    phase,
    expected: policy.defaultAcls,
    observed: catalog.defaultAcls,
    allowanceEntries: allowanceCollections.defaultAcls,
  });
  const defaultAclRowDelta = classifyExactCollectionDelta({
    phase,
    expected: policy.defaultAclRows,
    observed: catalog.defaultAclRows,
    allowanceEntries: allowanceCollections.defaultAclRows,
    identity: (entry) => entry.identity,
  });
  const defaultAclRowRevocations =
    phase === DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069
      ? partitionRepairableDefaultAclRowRevocations({
          policy,
          catalog,
          defaultAclDelta,
          defaultAclRowDelta,
        })
      : { repairable: [], forbidden: defaultAclRowDelta.revoke };
  defaultAclRowDelta.forbidden.push(...defaultAclRowRevocations.forbidden);
  defaultAclRowDelta.revoke = [];
  const inventoryDrift =
    Object.values(drift.missing.inventory).some((entries) => entries.length) ||
    Object.values(drift.extra.inventory).some((entries) => entries.length) ||
    Object.values(drift.mismatched.inventory).some((entries) => entries.length);
  const forbiddenCollections = {
    roles: roleDelta.forbidden,
    memberships: membershipDelta.forbidden,
    grants: grantDelta.forbidden,
    defaultAcls: defaultAclDelta.forbidden,
    defaultAclRows: defaultAclRowDelta.forbidden,
  };
  const blocked =
    inventoryDrift ||
    Object.values(forbiddenCollections).some((entries) => entries.length);
  const proposedMutations = [];
  appendMutations(proposedMutations, "add", "roles", roleDelta.grant);
  appendMutations(
    proposedMutations,
    "replace",
    "roles",
    roleDelta.replacements.map((entry) => entry.expected),
    (entry) => entry.identity,
  );
  appendMutations(
    proposedMutations,
    "add",
    "memberships",
    membershipDelta.grant,
  );
  appendMutations(
    proposedMutations,
    "replace",
    "memberships",
    membershipDelta.replacements.map((entry) => entry.expected),
    (entry) => entry.identity,
  );
  appendMutations(proposedMutations, "add", "grants", grantAdditions);
  appendMutations(
    proposedMutations,
    "ensure",
    "defaultAclRows",
    defaultAclRowDelta.grant,
    (entry) => entry.identity,
  );
  appendMutations(
    proposedMutations,
    "add",
    "defaultAcls",
    defaultAclDelta.grant,
  );
  appendMutations(
    proposedMutations,
    "remove",
    "defaultAcls",
    defaultAclDelta.revoke,
  );
  appendMutations(proposedMutations, "remove", "grants", grantDelta.revoke);
  appendMutations(
    proposedMutations,
    "remove",
    "memberships",
    membershipDelta.revoke,
  );
  appendMutations(proposedMutations, "remove", "roles", roleDelta.revoke);
  return {
    blocked,
    mutations: blocked ? [] : proposedMutations,
    reports: {
      predecessor: {
        roles: roleDelta.reportOnly,
        memberships: membershipDelta.reportOnly,
        grants: grantDelta.reportOnly,
        defaultAcls: defaultAclDelta.reportOnly,
        defaultAclRows: defaultAclRowDelta.reportOnly,
      },
      forbidden: forbiddenCollections,
    },
    drift,
    policyFingerprint: fingerprintDatabaseRuntimeCapabilities(policy),
  };
}

function phaseFailure(message) {
  throw new DatabaseRuntimeCapabilityPhaseError(message);
}

export function resolveDatabaseRuntimeCapabilityPhase({
  journalPresent,
  reviewedMigrationTail,
  reviewedPrefixExact,
  reviewedMigrationCount,
  reviewedMigrationLedgerSha256,
  requestedPhase,
}) {
  if (
    typeof journalPresent !== "boolean" ||
    typeof reviewedPrefixExact !== "boolean" ||
    !Number.isSafeInteger(reviewedMigrationCount) ||
    reviewedMigrationCount < 0 ||
    reviewedMigrationCount > REVIEWED_MIGRATION_TAGS.length ||
    reviewedMigrationLedgerSha256 !== REVIEWED_0069_FULL_LEDGER_SHA256 ||
    journalPresent !== reviewedMigrationCount > 0 ||
    reviewedPrefixExact !== reviewedMigrationCount > 0
  ) {
    phaseFailure("migration ledger identity is invalid");
  }
  if (
    requestedPhase !== undefined &&
    !Object.values(DATABASE_RUNTIME_CAPABILITY_PHASES).includes(requestedPhase)
  ) {
    phaseFailure(`unknown requested capability phase: ${requestedPhase}`);
  }
  const exactTail =
    reviewedMigrationCount === 0
      ? null
      : REVIEWED_MIGRATION_TAGS[reviewedMigrationCount - 1];
  if (reviewedMigrationTail !== exactTail) {
    phaseFailure("migration ledger tail is not the exact reviewed prefix");
  }
  let resolved;
  if (reviewedMigrationCount === 0) {
    resolved = {
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION,
      policy: null,
      reconcileApplicationAcls: false,
    };
  } else if (reviewedMigrationCount === REVIEWED_MIGRATION_TAGS.length) {
    if (
      exactTail !== CURRENT_0069_REVIEWED_MIGRATION_TAG ||
      CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES.ledger
        .requiredMigrationFile !== `drizzle/${exactTail}.sql`
    ) {
      phaseFailure("current capability policy is not bound to its exact tail");
    }
    resolved = {
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.CURRENT_0069,
      policy: CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES,
      reconcileApplicationAcls: true,
    };
  } else {
    resolved = {
      phase: DATABASE_RUNTIME_CAPABILITY_PHASES.FOUNDATION,
      policy: null,
      reconcileApplicationAcls: false,
    };
  }
  if (requestedPhase !== undefined && requestedPhase !== resolved.phase) {
    phaseFailure(
      `requested capability phase ${requestedPhase} does not match ${resolved.phase}`,
    );
  }
  const ledgerIdentity = Object.freeze({
    journalPresent,
    appliedCount: reviewedMigrationCount,
    reviewedLedgerSha256: reviewedMigrationLedgerSha256,
  });
  return Object.freeze({
    ...resolved,
    ledgerIdentity,
  });
}

validateDatabaseRuntimeCapabilities(CURRENT_0069_DATABASE_RUNTIME_CAPABILITIES);
validateDatabaseRuntimeCapabilities(
  POST_CONTRACT_DATABASE_RUNTIME_CAPABILITIES,
);
validateDatabaseRuntimeCapabilityAllowance(
  PREDECESSOR_0070_DATABASE_RUNTIME_CAPABILITY_ALLOWANCE,
);
