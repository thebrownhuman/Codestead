import process from "node:process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { Pool } from "pg";

import {
  BACKUP_STATUS_AUTHORITY_0065_CONTRACT,
  BACKUP_STATUS_AUTHORITY_0067_CONTRACT,
  verifyBackupStatusMailAuthorityObjects,
} from "./verify-backup-status-mail-authority.mjs";
import { verifyAppliedMigrationLedger as verifyAppliedMigrationLedgerContract } from "./lib/reviewed-migration-ledger.mjs";

export const DATABASE_ADMIN_LOCK_NAME = "codestead:database-administration:v1";
const OWNER_ROLE = "learncoding_owner";
const MIGRATOR_ROLE = "learncoding_migrator";
const APP_ROLE = "learncoding_app";
const WORKER_ROLE = "learncoding_worker";
const OPS_ROLE = "learncoding_ops";
const BACKUP_REPORTER_ROLE = "learncoding_backup_reporter";
const LOGIN_ROLES = [
  MIGRATOR_ROLE,
  APP_ROLE,
  WORKER_ROLE,
  OPS_ROLE,
  BACKUP_REPORTER_ROLE,
];

function reviewedRoutine(contract) {
  if (
    !/^[0-9a-f]{64}$/u.test(contract.bodySha256) ||
    (contract.definitionSha256 !== undefined &&
      !/^[0-9a-f]{64}$/u.test(contract.definitionSha256))
  ) {
    throw new Error("reviewed database routine digest is invalid");
  }
  return Object.freeze({
    cost: 100,
    rows: contract.returnsSet ? 1_000 : 0,
    supportFunction: null,
    transformTypes: Object.freeze([]),
    binary: null,
    sqlBody: null,
    definitionSha256: null,
    ...contract,
    configuration: Object.freeze([...contract.configuration]),
    allowedRoles: Object.freeze([...contract.allowedRoles]),
    argumentNames: Object.freeze([...contract.argumentNames]),
    argumentModes: Object.freeze([...contract.argumentModes]),
    argumentTypes: Object.freeze([...contract.argumentTypes]),
  });
}

const REVIEWED_0062_APPLICATION_FUNCTIONS = Object.freeze([
  reviewedRoutine({
    signature:
      "public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)",
    migrationFile: "0062_mail_outbox_retention_redaction.sql",
    owner: OWNER_ROLE,
    securityDefiner: true,
    configuration: ["search_path=pg_catalog"],
    allowedRoles: [OPS_ROLE],
    bodySha256:
      "bc69bc5bb45df3110589c7b63803a4a08eff37c0dfcd947b16fd360aab0625b2",
    language: "plpgsql",
    kind: "f",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: ["cutoff_at", "batch_limit", "id"],
    argumentModes: ["i", "i", "t"],
    argumentTypes: ["timestamp with time zone", "integer", "uuid"],
    inputArgumentCount: 2,
    argumentDefaultCount: 0,
    returnType: "uuid",
    returnsSet: true,
    variadic: false,
    definitionSha256:
      "d7911727c7fe0754544176ca4a63808700a697e469677f3cf8dea201e59492b0",
  }),
  reviewedRoutine({
    signature: "public.enforce_email_outbox_payload_immutable()",
    migrationFile: "0062_mail_outbox_retention_redaction.sql",
    owner: OWNER_ROLE,
    securityDefiner: false,
    configuration: ["search_path=pg_catalog"],
    allowedRoles: [],
    bodySha256:
      "9fe430001d1d205a34a9ed24127a11532c27db885219f28f0f887fce92298deb",
    language: "plpgsql",
    kind: "f",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: [],
    argumentModes: [],
    argumentTypes: [],
    inputArgumentCount: 0,
    argumentDefaultCount: 0,
    returnType: "trigger",
    returnsSet: false,
    variadic: false,
    definitionSha256:
      "5432a85d1feb92da8eac4b65aa8ee00552e8345a79f28336dbbe02f27505e3d6",
  }),
]);

const REVIEWED_0063_APPLICATION_FUNCTIONS = Object.freeze([
  reviewedRoutine({
    signature:
      "public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)",
    migrationFile: "0063_mail_outbox_redaction_fence_release.sql",
    owner: OWNER_ROLE,
    securityDefiner: true,
    configuration: ["search_path=pg_catalog"],
    allowedRoles: [OPS_ROLE],
    bodySha256:
      "b0ea5923720615a4b1de4df477a7905410cc7cabda7f613ccc88415501cb2469",
    language: "plpgsql",
    kind: "f",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: [
      "cutoff_at",
      "batch_limit",
      "disposition",
      "eligible",
      "transitioned",
    ],
    argumentModes: ["i", "i", "t", "t", "t"],
    argumentTypes: [
      "timestamp with time zone",
      "integer",
      "text",
      "bigint",
      "bigint",
    ],
    inputArgumentCount: 2,
    argumentDefaultCount: 0,
    returnType: "record",
    returnsSet: true,
    variadic: false,
    definitionSha256:
      "81ca308334c8297402ea1788c7fe3728277ddce891572fed6469ceae58e134bb",
  }),
  reviewedRoutine({
    signature:
      "public.classify_email_outbox_retention_redaction(public.email_outbox,timestamp with time zone)",
    migrationFile: "0063_mail_outbox_redaction_fence_release.sql",
    owner: OWNER_ROLE,
    securityDefiner: true,
    configuration: ["search_path=pg_catalog"],
    allowedRoles: [],
    bodySha256:
      "7c2d6df1168a89d63ed026c63bc390201a2a6b618e75967eddbe27c3d5bf672c",
    language: "plpgsql",
    kind: "f",
    volatility: "s",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: ["candidate", "cutoff_at"],
    argumentModes: [],
    argumentTypes: ["public.email_outbox", "timestamp with time zone"],
    inputArgumentCount: 2,
    argumentDefaultCount: 0,
    returnType: "text",
    returnsSet: false,
    variadic: false,
    definitionSha256:
      "43ea2a3bed7514efdb28ee52dfb128af57f39f525bb8842ce49c0eb4fa245466",
  }),
  reviewedRoutine({
    signature: "public.enforce_email_outbox_payload_immutable()",
    migrationFile: "0063_mail_outbox_redaction_fence_release.sql",
    owner: OWNER_ROLE,
    securityDefiner: false,
    configuration: ["search_path=pg_catalog"],
    allowedRoles: [],
    bodySha256:
      "8f78735c7181306c3bfe4f459eaf3f16b69ddbc3f9ea6ee27bb55cfd3dc7eef3",
    language: "plpgsql",
    kind: "f",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: [],
    argumentModes: [],
    argumentTypes: [],
    inputArgumentCount: 0,
    argumentDefaultCount: 0,
    returnType: "trigger",
    returnsSet: false,
    variadic: false,
    definitionSha256:
      "fe8117eea4298f330247789fb23f0ebe98b09c5184b7e00e29e4409843c83541",
  }),
]);

export const REVIEWED_0064_APPLICATION_FUNCTIONS = Object.freeze([
  ...REVIEWED_0063_APPLICATION_FUNCTIONS,
  reviewedRoutine({
    signature: "public.enforce_email_outbox_dispatch_binding()",
    migrationFile: "0064_mail_outbox_dispatch_binding.sql",
    owner: OWNER_ROLE,
    securityDefiner: false,
    configuration: ["search_path=pg_catalog"],
    allowedRoles: [],
    bodySha256:
      "e03d2be2455d53f9ddd0c0b7a8029efd07186a4d6804b86c2206b29031da7fdf",
    language: "plpgsql",
    kind: "f",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: [],
    argumentModes: [],
    argumentTypes: [],
    inputArgumentCount: 0,
    argumentDefaultCount: 0,
    returnType: "trigger",
    returnsSet: false,
    variadic: false,
    definitionSha256:
      "b3ba15cae78eaf8e3535b28c0764e9715683e15ab85b0814089e3e54715f4676",
  }),
]);
export const REVIEWED_0065_BACKUP_STATUS_AUTHORITY_ROUTINES =
  BACKUP_STATUS_AUTHORITY_0065_CONTRACT.routines;
export const REVIEWED_0065_APPLICATION_FUNCTIONS = Object.freeze([
  ...REVIEWED_0064_APPLICATION_FUNCTIONS,
  ...REVIEWED_0065_BACKUP_STATUS_AUTHORITY_ROUTINES,
]);
export const REVIEWED_0066_APPLICATION_FUNCTIONS = Object.freeze([
  ...REVIEWED_0065_APPLICATION_FUNCTIONS,
  reviewedRoutine({
    signature:
      "public.enforce_email_outbox_provider_correlation_evidence()",
    migrationFile: "0066_mail_outbox_provider_correlation_evidence.sql",
    owner: OWNER_ROLE,
    securityDefiner: false,
    configuration: ["search_path=pg_catalog"],
    allowedRoles: [],
    bodySha256:
      "62ff4885055979fb7eaf0fda3ae8170a14a430cb69d8f310e6aba742cf700e1a",
    language: "plpgsql",
    kind: "f",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: [],
    argumentModes: [],
    argumentTypes: [],
    inputArgumentCount: 0,
    argumentDefaultCount: 0,
    returnType: "trigger",
    returnsSet: false,
    variadic: false,
    definitionSha256:
      "afaab6796f97aa0294ff5a761679895f9ccfb78fea21e0be362979c5c4e5ab11",
  }),
]);
export const REVIEWED_0067_BACKUP_STATUS_AUTHORITY_ROUTINES =
  BACKUP_STATUS_AUTHORITY_0067_CONTRACT.routines;
const REVIEWED_0067_BACKUP_STATUS_ROUTINE_BY_SIGNATURE = new Map(
  REVIEWED_0067_BACKUP_STATUS_AUTHORITY_ROUTINES.map((routine) => [
    routine.signature,
    routine,
  ]),
);
const REVIEWED_0067_PRE_REPLAY_APPLICATION_FUNCTIONS = Object.freeze(
  REVIEWED_0066_APPLICATION_FUNCTIONS.map(
    (routine) =>
      REVIEWED_0067_BACKUP_STATUS_ROUTINE_BY_SIGNATURE.get(
        routine.signature,
      ) ?? routine,
  ),
);
export const REVIEWED_APPLICATION_FUNCTIONS = Object.freeze([
  ...REVIEWED_0067_PRE_REPLAY_APPLICATION_FUNCTIONS,
  reviewedRoutine({
    signature: "public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)",
    migrationFile: "0067_mail_outbox_durable_replay_authority.sql",
    owner: OWNER_ROLE,
    securityDefiner: true,
    configuration: ["search_path=pg_catalog, pg_temp"],
    allowedRoles: [],
    bodySha256:
      "6b7100af8bd25093520317e67d5a06b40848b192ca94eb4b6c63ef48adcf89a2",
    language: "sql",
    kind: "f",
    volatility: "i",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: [
      "input_user_id",
      "input_to_email",
      "input_template",
      "input_template_version",
      "input_variables",
    ],
    argumentModes: [],
    argumentTypes: ["text", "text", "text", "text", "jsonb"],
    inputArgumentCount: 5,
    argumentDefaultCount: 0,
    returnType: "text",
    returnsSet: false,
    variadic: false,
    definitionSha256:
      "35691db9ef3153adf2e19ebae539341797f7b4fd2a27aec1db215b9533636ed8",
  }),
  reviewedRoutine({
    signature: "public.email_outbox_event_sha256(text,text,text)",
    migrationFile: "0067_mail_outbox_durable_replay_authority.sql",
    owner: OWNER_ROLE,
    securityDefiner: true,
    configuration: ["search_path=pg_catalog, pg_temp"],
    allowedRoles: [],
    bodySha256:
      "dbb1e105e567de47875c1bdd433b61cc78745fc0bc7953daa68b6f3f2bf83315",
    language: "sql",
    kind: "f",
    volatility: "i",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: ["input_template", "input_scope", "input_event_id"],
    argumentModes: [],
    argumentTypes: ["text", "text", "text"],
    inputArgumentCount: 3,
    argumentDefaultCount: 0,
    returnType: "text",
    returnsSet: false,
    variadic: false,
    definitionSha256:
      "02d83d883c8f4c0b4fc22c460353834d27a67becdd96d81cee8b74609521f334",
  }),
  reviewedRoutine({
    signature: "public.claim_email_outbox_idempotency_authority()",
    migrationFile: "0067_mail_outbox_durable_replay_authority.sql",
    owner: OWNER_ROLE,
    securityDefiner: true,
    configuration: ["search_path=pg_catalog, pg_temp"],
    allowedRoles: [],
    bodySha256:
      "70e587220b716395c07d1efcabfb35aed45f9dccf23a0f2ed7e13791774b526c",
    language: "plpgsql",
    kind: "f",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: [],
    argumentModes: [],
    argumentTypes: [],
    inputArgumentCount: 0,
    argumentDefaultCount: 0,
    returnType: "trigger",
    returnsSet: false,
    variadic: false,
    definitionSha256:
      "4ddccd9ac5ee3bc0f217c13e146c2dd2ec313e4980c30de8a51deec3dc6088a4",
  }),
  reviewedRoutine({
    signature: "public.persist_email_outbox_idempotency_authority()",
    migrationFile: "0067_mail_outbox_durable_replay_authority.sql",
    owner: OWNER_ROLE,
    securityDefiner: true,
    configuration: ["search_path=pg_catalog, pg_temp"],
    allowedRoles: [],
    bodySha256:
      "43e5df19b455c36648574e1d7c33c10cb959fc3bddd83e6ed67035031f246cbd",
    language: "plpgsql",
    kind: "f",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: [],
    argumentModes: [],
    argumentTypes: [],
    inputArgumentCount: 0,
    argumentDefaultCount: 0,
    returnType: "trigger",
    returnsSet: false,
    variadic: false,
    definitionSha256:
      "4890f478c8d14811e7f6829a3a4977e0da3924c8e8c84b8ca89b64496ac40f53",
  }),
  reviewedRoutine({
    signature: "public.enforce_email_outbox_idempotency_metadata_immutable()",
    migrationFile: "0067_mail_outbox_durable_replay_authority.sql",
    owner: OWNER_ROLE,
    securityDefiner: true,
    configuration: ["search_path=pg_catalog, pg_temp"],
    allowedRoles: [],
    bodySha256:
      "9e953537c1fc8f4cdceda981731aa20c9412dbd46cefdcc71e433de3eced76c3",
    language: "plpgsql",
    kind: "f",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: [],
    argumentModes: [],
    argumentTypes: [],
    inputArgumentCount: 0,
    argumentDefaultCount: 0,
    returnType: "trigger",
    returnsSet: false,
    variadic: false,
    definitionSha256:
      "a26ccda1f7f4d623c7ea2b1611ff9f5c424cee386f79a7a8ffbf2a58c51ce2e9",
  }),
  reviewedRoutine({
    signature: "public.enforce_email_outbox_idempotency_append_only()",
    migrationFile: "0067_mail_outbox_durable_replay_authority.sql",
    owner: OWNER_ROLE,
    securityDefiner: true,
    configuration: ["search_path=pg_catalog, pg_temp"],
    allowedRoles: [],
    bodySha256:
      "164b71af1bca387a599b64246851b7ba3e66c8a9557a60581dec54eb4d757370",
    language: "plpgsql",
    kind: "f",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: [],
    argumentModes: [],
    argumentTypes: [],
    inputArgumentCount: 0,
    argumentDefaultCount: 0,
    returnType: "trigger",
    returnsSet: false,
    variadic: false,
    definitionSha256:
      "2ae733ebe79975ce70fa9427ccb92295ecf8acad75797e8541bbb15bd9318790",
  }),
  reviewedRoutine({
    signature: "public.email_outbox_idempotency_coverage_authority(uuid[])",
    migrationFile: "0067_mail_outbox_durable_replay_authority.sql",
    owner: OWNER_ROLE,
    securityDefiner: true,
    configuration: ["search_path=pg_catalog, pg_temp"],
    allowedRoles: [OPS_ROLE],
    bodySha256:
      "7957a8c6e5b5e1a87ef22f59b02cda7600c2f902ef2b78700600387ee33e8509",
    language: "plpgsql",
    kind: "f",
    volatility: "v",
    strict: false,
    parallel: "u",
    leakproof: false,
    argumentNames: ["candidate_ids"],
    argumentModes: [],
    argumentTypes: ["uuid[]"],
    inputArgumentCount: 1,
    argumentDefaultCount: 0,
    returnType: "boolean",
    returnsSet: false,
    variadic: false,
    definitionSha256:
      "6e7e07cb84083bef2bdf2dcf58578b7fb4e224494fe1a70ba33284bd76358da8",
  }),
]);

export const REVIEWED_0064_APPLICATION_TRIGGERS = Object.freeze([
  Object.freeze({
    relation: "public.email_outbox",
    name: "email_outbox_payload_immutable",
    functionSignature: "public.enforce_email_outbox_payload_immutable()",
    enabled: "O",
    type: 19,
    predicate: null,
    arguments: Object.freeze([]),
    watchedColumns: Object.freeze([
      "user_id",
      "to_email",
      "template",
      "template_version",
      "variables",
      "idempotency_key",
      "operation_id",
      "delivery_scope_key",
    ]),
  }),
  Object.freeze({
    relation: "public.email_outbox",
    name: "email_outbox_dispatch_binding_guard",
    functionSignature: "public.enforce_email_outbox_dispatch_binding()",
    enabled: "O",
    type: 23,
    predicate: null,
    arguments: Object.freeze([]),
    watchedColumns: Object.freeze([]),
  }),
]);
export const REVIEWED_0065_BACKUP_STATUS_AUTHORITY_TRIGGERS =
  BACKUP_STATUS_AUTHORITY_0065_CONTRACT.triggers;
export const REVIEWED_0065_APPLICATION_TRIGGERS = Object.freeze([
  ...REVIEWED_0064_APPLICATION_TRIGGERS,
  ...REVIEWED_0065_BACKUP_STATUS_AUTHORITY_TRIGGERS,
]);
export const REVIEWED_0066_APPLICATION_TRIGGERS = Object.freeze([
  ...REVIEWED_0065_APPLICATION_TRIGGERS,
  Object.freeze({
    relation: "public.email_outbox",
    name: "email_outbox_provider_correlation_evidence_guard",
    functionSignature:
      "public.enforce_email_outbox_provider_correlation_evidence()",
    enabled: "O",
    type: 23,
    predicate: null,
    arguments: Object.freeze([]),
    watchedColumns: Object.freeze([]),
  }),
]);
export const REVIEWED_APPLICATION_TRIGGERS = Object.freeze([
  ...REVIEWED_0066_APPLICATION_TRIGGERS,
  Object.freeze({
    relation: "public.email_outbox",
    name: "email_outbox_idempotency_claim",
    functionSignature: "public.claim_email_outbox_idempotency_authority()",
    enabled: "A",
    type: 7,
    predicate: null,
    arguments: Object.freeze([]),
    watchedColumns: Object.freeze([]),
  }),
  Object.freeze({
    relation: "public.email_outbox",
    name: "00_email_outbox_idempotency_persist",
    functionSignature: "public.persist_email_outbox_idempotency_authority()",
    enabled: "A",
    type: 5,
    predicate: null,
    arguments: Object.freeze([]),
    watchedColumns: Object.freeze([]),
  }),
  Object.freeze({
    relation: "public.email_outbox",
    name: "email_outbox_idempotency_metadata_immutable",
    functionSignature:
      "public.enforce_email_outbox_idempotency_metadata_immutable()",
    enabled: "A",
    type: 19,
    predicate: null,
    arguments: Object.freeze([]),
    watchedColumns: Object.freeze([
      "idempotency_key",
      "idempotency_authority_version",
      "idempotency_authority_sha256",
      "idempotency_original_payload_sha256",
    ]),
  }),
  Object.freeze({
    relation: "public.email_outbox_idempotency_authority",
    name: "email_outbox_idempotency_append_only",
    functionSignature:
      "public.enforce_email_outbox_idempotency_append_only()",
    enabled: "A",
    type: 27,
    predicate: null,
    arguments: Object.freeze([]),
    watchedColumns: Object.freeze([]),
  }),
  Object.freeze({
    relation: "public.email_outbox_idempotency_authority",
    name: "email_outbox_idempotency_no_truncate",
    functionSignature:
      "public.enforce_email_outbox_idempotency_append_only()",
    enabled: "A",
    type: 34,
    predicate: null,
    arguments: Object.freeze([]),
    watchedColumns: Object.freeze([]),
  }),
]);

export const REVIEWED_0065_BACKUP_STATUS_AUTHORITY =
  BACKUP_STATUS_AUTHORITY_0065_CONTRACT;
export const REVIEWED_0067_BACKUP_STATUS_AUTHORITY =
  BACKUP_STATUS_AUTHORITY_0067_CONTRACT;
const EMAIL_OUTBOX_DISPATCH_BINDING_CONSTRAINT_NORMALIZED_EXPRESSION = [
  "provider_call_startedISNULLANDadapterISNULLANDprovider_message_idISNULL",
  "ANDdispatch_binding_versionISNULLANDdispatch_binding_sha256ISNULLOR",
  "provider_call_startedISNOTNULLAND(status=ANY(ARRAY[",
  "'sending'::public.notification_status,'sent'::public.notification_status,",
  "'failed'::public.notification_status,'quarantined'::public.notification_status]))AND(",
  "adapter='gmail'::textAND(dispatch_binding_versionISNULLAND",
  "dispatch_binding_sha256ISNULLOR",
  "dispatch_binding_version='gmail-raw-v1'::textAND",
  "dispatch_binding_sha256~'^[0-9a-f]{64}$'::text)OR",
  "adapter='console'::textAND(dispatch_binding_versionISNULLAND",
  "dispatch_binding_sha256ISNULLOR",
  "dispatch_binding_version='console-json-v1'::textAND",
  "dispatch_binding_sha256~'^[0-9a-f]{64}$'::text))",
].join("");
export const REVIEWED_APPLICATION_CONSTRAINTS = Object.freeze([
  Object.freeze({
    relation: "public.email_outbox",
    relationOwner: OWNER_ROLE,
    name: "email_outbox_variables_object_valid",
    type: "c",
    validated: true,
    noInherit: false,
    reviewedSqlExpressionSha256:
      "474e75e58049be566e89f5e17641091aebefb946928e5ed97987db96bb7d7e33",
    normalizedExpressionSha256:
      "9a0d45d473dbe0925bc515e3061a94f53cc9c4684e843565c7ee64946b2521ca",
    columns: Object.freeze(["variables"]),
  }),
  Object.freeze({
    relation: "public.email_outbox",
    relationOwner: OWNER_ROLE,
    name: "email_outbox_recipient_canonical_valid",
    type: "c",
    validated: true,
    noInherit: false,
    reviewedSqlExpressionSha256:
      "5a2426a2aafcdec419fc4d534d8558d82110e0759c1445a2c917bbf2ec27b447",
    normalizedExpressionSha256:
      "02ba45407386c19b742347bf29e39fa5a5d3d09b8cd8ca74a31bf1c1aeae8a0b",
    columns: Object.freeze(["to_email"]),
  }),
  Object.freeze({
    relation: "public.email_outbox",
    relationOwner: OWNER_ROLE,
    name: "email_outbox_dispatch_binding_valid",
    type: "c",
    validated: true,
    normalizedExpression:
      EMAIL_OUTBOX_DISPATCH_BINDING_CONSTRAINT_NORMALIZED_EXPRESSION,
    columns: Object.freeze([
      "adapter",
      "dispatch_binding_sha256",
      "dispatch_binding_version",
      "provider_call_started",
      "provider_message_id",
      "status",
    ]),
  }),
  Object.freeze({
    relation: "public.email_outbox",
    relationOwner: OWNER_ROLE,
    name: "email_outbox_provider_correlation_evidence_valid",
    type: "c",
    validated: true,
    normalizedExpressionSha256:
      "2594dd57e4115fe9296d03888d8d1771b98e90725bce7e0d66c753eb1f0dba82",
    columns: Object.freeze([
      "adapter",
      "claim_owner",
      "claim_token",
      "claim_version",
      "dispatch_binding_sha256",
      "dispatch_binding_version",
      "last_error_code",
      "lease_expires_at",
      "provider_call_started",
      "provider_correlation_version",
      "provider_evidence_sha256",
      "provider_evidence_version",
      "provider_message_id",
      "quarantined_at",
      "sent_at",
      "status",
    ]),
  }),
  Object.freeze({
    relation: "public.email_outbox",
    relationOwner: OWNER_ROLE,
    name: "email_outbox_idempotency_authority_valid",
    type: "c",
    validated: true,
    normalizedExpressionSha256:
      "3f32ee19567df8889a129cc1e2e95af9f70a8e4e5878c7f7930ec396259ceefc",
    columns: Object.freeze([
      "idempotency_authority_sha256",
      "idempotency_authority_version",
      "idempotency_key",
      "idempotency_original_payload_sha256",
    ]),
  }),
]);

export const REVIEWED_REPLAY_AUTHORITY_RELATIONAL_CONTRACT = Object.freeze({
  authority: Object.freeze({
    relation: "public.email_outbox_idempotency_authority",
    owner: OWNER_ROLE,
    columns: Object.freeze([
      Object.freeze({
        name: "idempotency_sha256",
        type: "pg_catalog.text",
        notNull: true,
      }),
      Object.freeze({
        name: "original_payload_sha256",
        type: "pg_catalog.text",
        notNull: true,
      }),
    ]),
    primaryKey: Object.freeze({
      name: "email_outbox_idempotency_authority_pkey",
      type: "p",
      validated: true,
      deferrable: false,
      initiallyDeferred: false,
      noInherit: true,
      columns: Object.freeze(["idempotency_sha256"]),
      index: Object.freeze({
        unique: true,
        valid: true,
        ready: true,
        live: true,
        immediate: true,
        partial: false,
        expression: false,
      }),
    }),
    checks: Object.freeze([
      Object.freeze({
        name: "email_outbox_idempotency_authority_digest_valid",
        type: "c",
        validated: true,
        noInherit: false,
        columns: Object.freeze(["idempotency_sha256"]),
        reviewedSqlExpressionSha256:
          "e49d21d5f96c0af1e2ddc33bb5c90d5649e9e8354ee8cf1e245fa0fe612ba7cf",
        normalizedExpressionSha256:
          "8e6471c0b1bf0fd09c9f9f37b6735e345030506017e78de7c2deba7f79bd6f6d",
      }),
      Object.freeze({
        name: "email_outbox_idempotency_authority_payload_valid",
        type: "c",
        validated: true,
        noInherit: false,
        columns: Object.freeze(["original_payload_sha256"]),
        reviewedSqlExpressionSha256:
          "28dc27e34f97a28cf404f373f75632bbb7a6541476dd1f59efe000b2c066b69b",
        normalizedExpressionSha256:
          "aca0ad0a3d605439d115ce9283ef22b98a28c71e85f4e7e89de406e90dee11e6",
      }),
    ]),
  }),
  deliveryScope: Object.freeze({
    relation: "public.email_outbox",
    name: "email_outbox_delivery_scope_valid",
    type: "c",
    validated: true,
    noInherit: false,
    columns: Object.freeze([
      "delivery_scope_key",
      "operation_id",
      "status",
      "template",
      "template_version",
      "to_email",
      "user_id",
      "variables",
    ]),
    reviewedSqlExpressionSha256:
      "20f31d55accb3d3e96816fd4f13cf8670eef2fd3746c414329c6f5ad9d12b3c7",
    normalizedExpressionSha256:
      "c904768e4ecc145fc108de90adf0d0b5373f3330fb706ec34ff4b07d2711b94f",
  }),
  triggerRelations: Object.freeze([
    "public.email_outbox",
    "public.email_outbox_idempotency_authority",
  ]),
  triggers: Object.freeze(
    REVIEWED_APPLICATION_TRIGGERS.filter(({ relation }) =>
      [
        "public.email_outbox",
        "public.email_outbox_idempotency_authority",
      ].includes(relation),
    ),
  ),
  routines: Object.freeze(
    REVIEWED_APPLICATION_FUNCTIONS.filter(
      ({ migrationFile }) =>
        migrationFile ===
        "0067_mail_outbox_durable_replay_authority.sql",
    ),
  ),
  lookupIndex: Object.freeze({
    relation: "public.email_outbox",
    name: "email_outbox_idempotency_authority_lookup_idx",
    accessMethod: "btree",
    columns: Object.freeze([
      "idempotency_authority_sha256",
      "id",
    ]),
    unique: false,
    valid: true,
    ready: true,
    live: true,
    immediate: true,
    partial: true,
    expression: false,
    normalizedPredicate: "idempotency_authority_sha256isnotnull",
  }),
  unique: Object.freeze({
    relation: "public.email_outbox_idempotency_authority",
    name: "email_outbox_idempotency_authority_payload_unique",
    type: "u",
    validated: true,
    deferrable: false,
    initiallyDeferred: false,
    noInherit: true,
    columns: Object.freeze([
      "idempotency_sha256",
      "original_payload_sha256",
    ]),
    index: Object.freeze({
      unique: true,
      valid: true,
      ready: true,
      partial: false,
      expression: false,
    }),
  }),
  foreignKey: Object.freeze({
    relation: "public.email_outbox",
    name: "email_outbox_idempotency_authority_fk",
    persistTriggerName: "00_email_outbox_idempotency_persist",
    type: "f",
    validated: true,
    columns: Object.freeze([
      "idempotency_authority_sha256",
      "idempotency_original_payload_sha256",
    ]),
    referencedRelation: "public.email_outbox_idempotency_authority",
    referencedColumns: Object.freeze([
      "idempotency_sha256",
      "original_payload_sha256",
    ]),
    deferrable: true,
    initiallyDeferred: true,
    noInherit: true,
    matchType: "s",
    updateAction: "r",
    deleteAction: "r",
  }),
});
function reviewedCatalogPhase({
  index,
  createdAt,
  migrationFile,
  migrationSha256,
  routines,
  triggers,
  requiresWorkerContract,
  requiresProviderEvidence = false,
  requiresReplayAuthority = false,
  backupStatusAuthority = null,
}) {
  return Object.freeze({
    index,
    createdAt,
    migrationFile,
    migrationSha256,
    routines,
    triggers,
    requiresWorkerContract,
    requiresProviderEvidence,
    requiresReplayAuthority,
    backupStatusAuthority,
  });
}

export const REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES = Object.freeze([
  reviewedCatalogPhase({
    index: 62,
    createdAt: "1784925600000",
    migrationFile: "0062_mail_outbox_retention_redaction.sql",
    migrationSha256:
      "98cd8b0fd5b57822bab9a3793094e738d926d5dab8a2dc700f89037bd0cbc13b",
    routines: REVIEWED_0062_APPLICATION_FUNCTIONS,
    triggers: Object.freeze([REVIEWED_0064_APPLICATION_TRIGGERS[0]]),
    requiresWorkerContract: false,
    requiresProviderEvidence: false,
  }),
  reviewedCatalogPhase({
    index: 63,
    createdAt: "1784929200000",
    migrationFile: "0063_mail_outbox_redaction_fence_release.sql",
    migrationSha256:
      "e945482f1311c88ee41bb13b12a566aab31a0e1aadd2a1d9ce98ac12acd5c63c",
    routines: REVIEWED_0063_APPLICATION_FUNCTIONS,
    triggers: Object.freeze([REVIEWED_0064_APPLICATION_TRIGGERS[0]]),
    requiresWorkerContract: false,
    requiresProviderEvidence: false,
  }),
  reviewedCatalogPhase({
    index: 64,
    createdAt: "1784932800000",
    migrationFile: "0064_mail_outbox_dispatch_binding.sql",
    migrationSha256:
      "5667b105cb1511cf2851c315959086ca49453be52db09a4b0ffc9844c966d1aa",
    routines: REVIEWED_0064_APPLICATION_FUNCTIONS,
    triggers: REVIEWED_0064_APPLICATION_TRIGGERS,
    requiresWorkerContract: true,
    requiresProviderEvidence: false,
  }),
  reviewedCatalogPhase({
    index: 65,
    createdAt: "1784936400000",
    migrationFile: "0065_backup_status_mail_authority.sql",
    migrationSha256:
      "1274dda8013fe80f09df63f7ddc73b24b0a9a482a40e5f5042eaef2373c14b3c",
    routines: REVIEWED_0065_APPLICATION_FUNCTIONS,
    triggers: REVIEWED_0065_APPLICATION_TRIGGERS,
    requiresWorkerContract: true,
    requiresProviderEvidence: false,
    backupStatusAuthority: REVIEWED_0065_BACKUP_STATUS_AUTHORITY,
  }),
  reviewedCatalogPhase({
    index: 66,
    createdAt: "1784997273087",
    migrationFile: "0066_mail_outbox_provider_correlation_evidence.sql",
    migrationSha256:
      "3d4962ed82c0209245ca7e0a0e9ea667001eab7ae864f89120894cc1fa915ec9",
    routines: REVIEWED_0066_APPLICATION_FUNCTIONS,
    triggers: REVIEWED_0066_APPLICATION_TRIGGERS,
    requiresWorkerContract: true,
    requiresProviderEvidence: true,
    requiresReplayAuthority: false,
    backupStatusAuthority: REVIEWED_0065_BACKUP_STATUS_AUTHORITY,
  }),
  reviewedCatalogPhase({
    index: 67,
    createdAt: "1785002172253",
    migrationFile: "0067_mail_outbox_durable_replay_authority.sql",
    migrationSha256:
      "ccb3e093847fb875ded41ec0c36d0ff8405c04d1546ba9dd21696e86a73a6817",
    routines: REVIEWED_APPLICATION_FUNCTIONS,
    triggers: REVIEWED_APPLICATION_TRIGGERS,
    requiresWorkerContract: true,
    requiresProviderEvidence: true,
    requiresReplayAuthority: true,
    backupStatusAuthority: REVIEWED_0067_BACKUP_STATUS_AUTHORITY,
  }),
]);
const REVIEWED_MAIL_AUTHORITY_CATALOG_PHASE_BY_INDEX = new Map(
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.map((phase) => [phase.index, phase]),
);

export function canonicalReviewedMailAuthorityCatalogPhase(phase) {
  if (phase === null) return null;
  const canonical = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASE_BY_INDEX.get(
    phase?.index,
  );
  if (canonical === undefined || canonical !== phase) {
    throw databaseRoleBootstrapInvariantError(
      "reviewed-mail-authority-catalog-phase-contract",
    );
  }
  return canonical;
}

function reviewedPhaseRoutines(phase) {
  return canonicalReviewedMailAuthorityCatalogPhase(phase)?.routines ?? [];
}

function reviewedSecurityDefinerFunctions(phase) {
  return reviewedPhaseRoutines(phase)
    .filter(({ securityDefiner }) => securityDefiner)
    .map(({ signature, configuration }) => ({ signature, configuration }));
}

export async function resolveReviewedMailAuthorityCatalogPhase(client) {
  const appliedPhases = await reviewedMigrationJournalState(client);
  return canonicalReviewedMailAuthorityCatalogPhase(
    appliedPhases.at(-1) ?? null,
  );
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function reviewedApplicationFunctionPrivilegesSql(phase) {
  return reviewedPhaseRoutines(phase).map((routine, routineIndex) => {
    const blockTag = `codestead_reviewed_function_${routineIndex}`;
    const restrictedRoles = [
      MIGRATOR_ROLE,
      APP_ROLE,
      WORKER_ROLE,
      OPS_ROLE,
      BACKUP_REPORTER_ROLE,
    ];
    const requiredRoles = [
      ...new Set([routine.owner, ...restrictedRoles, ...routine.allowedRoles]),
    ];
    const revokeSql = `revoke all on function ${routine.signature} from public, ${requiredRoles.join(", ")}`;
    const grants = [...new Set([routine.owner, ...routine.allowedRoles])]
      .map(
        (role) =>
          `execute ${sqlLiteral(
            `grant execute on function ${routine.signature} to ${role}`,
          )};`,
      )
      .join("\n        ");
    return `
      do $${blockTag}$
      begin
        if pg_catalog.to_regprocedure(${sqlLiteral(routine.signature)})
             is not null
           and ${requiredRoles
             .map(
               (role) =>
                 `pg_catalog.to_regrole(${sqlLiteral(role)}) is not null`,
             )
             .join("\n           and ")}
        then
          execute ${sqlLiteral(revokeSql)};
          ${grants}
        end if;
      end
      $${blockTag}$`;
  }).join(";\n");
}

export const MAIL_WORKER_OUTBOX_COLUMNS = Object.freeze([
  "id",
  "user_id",
  "to_email",
  "template",
  "template_version",
  "variables",
  "idempotency_key",
  "operation_id",
  "delivery_scope_key",
  "status",
  "attempt_count",
  "claim_token",
  "claim_owner",
  "claim_version",
  "lease_expires_at",
  "provider_call_started",
  "adapter",
  "provider_message_id",
  "next_attempt_at",
  "sent_at",
  "quarantined_at",
  "last_error_code",
  "created_at",
  "updated_at",
  "dispatch_binding_version",
  "dispatch_binding_sha256",
  "provider_correlation_version",
  "provider_evidence_version",
  "provider_evidence_sha256",
  "idempotency_authority_version",
  "idempotency_authority_sha256",
  "idempotency_original_payload_sha256",
]);
export const MAIL_WORKER_OUTBOX_INSERT_COLUMNS = Object.freeze([
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
]);
export const MAIL_WORKER_OUTBOX_UPDATE_COLUMNS = Object.freeze([
  "status",
  "attempt_count",
  "claim_token",
  "claim_owner",
  "claim_version",
  "lease_expires_at",
  "provider_call_started",
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
]);
const MAIL_WORKER_DISPATCH_BINDING_COLUMNS = Object.freeze([
  "dispatch_binding_version",
  "dispatch_binding_sha256",
]);
const MAIL_WORKER_PROVIDER_EVIDENCE_COLUMNS = Object.freeze([
  "provider_correlation_version",
  "provider_evidence_version",
  "provider_evidence_sha256",
]);
const MAIL_WORKER_IDEMPOTENCY_AUTHORITY_COLUMNS = Object.freeze([
  "idempotency_authority_version",
  "idempotency_authority_sha256",
  "idempotency_original_payload_sha256",
]);
export const MAIL_WORKER_OUTBOX_PRE_REPLAY_INSERT_COLUMNS = Object.freeze(
  MAIL_WORKER_OUTBOX_INSERT_COLUMNS.filter(
    (column) => !MAIL_WORKER_IDEMPOTENCY_AUTHORITY_COLUMNS.includes(column),
  ),
);
export const MAIL_WORKER_OUTBOX_PRE_EVIDENCE_UPDATE_COLUMNS = Object.freeze(
  MAIL_WORKER_OUTBOX_UPDATE_COLUMNS.filter(
    (column) => !MAIL_WORKER_PROVIDER_EVIDENCE_COLUMNS.includes(column),
  ),
);
export const MAIL_WORKER_OUTBOX_PRE_BINDING_UPDATE_COLUMNS = Object.freeze(
  MAIL_WORKER_OUTBOX_UPDATE_COLUMNS.filter(
    (column) =>
      !MAIL_WORKER_DISPATCH_BINDING_COLUMNS.includes(column)
      && !MAIL_WORKER_PROVIDER_EVIDENCE_COLUMNS.includes(column),
  ),
);

export function managedColumnAclScrubSql() {
  return `
    do $codestead_managed_column_acl_scrub$
    declare
      column_row record;
      grantee_row record;
      grantee_sql text;
    begin
      for column_row in
        select namespace.nspname as schema_name,
               relation.relname as relation_name,
               attribute.attname as column_name,
               attribute.attacl as column_acl
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace
            on namespace.oid = relation.relnamespace
          join pg_catalog.pg_attribute attribute
            on attribute.attrelid = relation.oid
           and attribute.attnum > 0
           and not attribute.attisdropped
         where namespace.nspname in ('public', 'drizzle')
           and relation.relkind in ('r', 'p', 'v', 'm', 'f')
           and attribute.attacl is not null
         order by relation.oid, attribute.attnum
      loop
        for grantee_row in
          select distinct access.grantee
            from pg_catalog.aclexplode(column_row.column_acl) access
           order by access.grantee
        loop
          if grantee_row.grantee = 0 then
            grantee_sql := 'PUBLIC';
          else
            select pg_catalog.format('%I', role.rolname)
              into grantee_sql
              from pg_catalog.pg_roles role
             where role.oid = grantee_row.grantee;
            if grantee_sql is null then
              raise exception 'managed column ACL grantee is unresolved'
                using errcode = '42704';
            end if;
          end if;
          execute pg_catalog.format(
            'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM %s CASCADE',
            column_row.column_name,
            column_row.schema_name,
            column_row.relation_name,
            grantee_sql
          );
        end loop;
      end loop;
    end
    $codestead_managed_column_acl_scrub$;
  `;
}

export function mailWorkerOutboxPrivilegesSql() {
  const insertColumns = MAIL_WORKER_OUTBOX_INSERT_COLUMNS.join(", ");
  const preReplayInsertColumns =
    MAIL_WORKER_OUTBOX_PRE_REPLAY_INSERT_COLUMNS.join(", ");
  const updateColumns = MAIL_WORKER_OUTBOX_UPDATE_COLUMNS.join(", ");
  const preEvidenceUpdateColumns =
    MAIL_WORKER_OUTBOX_PRE_EVIDENCE_UPDATE_COLUMNS.join(", ");
  const preBindingUpdateColumns =
    MAIL_WORKER_OUTBOX_PRE_BINDING_UPDATE_COLUMNS.join(", ");
  return `
    do $codestead_mail_worker_outbox$
    declare
      binding_column_count integer;
      binding_column_exact_count integer;
      provider_evidence_column_count integer;
      provider_evidence_column_exact_count integer;
      idempotency_authority_column_count integer;
      idempotency_authority_column_exact_count integer;
      existing_columns text;
    begin
      if pg_catalog.to_regrole('learncoding_worker') is not null
         and pg_catalog.to_regclass('public.email_outbox') is not null
      then
        select pg_catalog.count(*)::integer,
               pg_catalog.count(*) filter (
                 where attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
                   and attribute.atttypmod = -1
                   and not attribute.attnotnull
                   and not attribute.atthasdef
                   and attribute.attgenerated = ''
                   and attribute.attidentity = ''
                   and not attribute.attisdropped
               )::integer
          into binding_column_count, binding_column_exact_count
          from pg_catalog.pg_attribute attribute
         where attribute.attrelid =
                 pg_catalog.to_regclass('public.email_outbox')
           and attribute.attname in (
             'dispatch_binding_version',
             'dispatch_binding_sha256'
           )
           and attribute.attnum > 0;

        if binding_column_count not in (0, 2)
           or (
             binding_column_count = 2
             and binding_column_exact_count <> 2
           ) then
          raise exception 'email outbox dispatch binding column contract is invalid'
            using errcode = '23514';
        end if;

        select pg_catalog.count(*)::integer,
               pg_catalog.count(*) filter (
                 where attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
                   and attribute.atttypmod = -1
                   and not attribute.attnotnull
                   and not attribute.atthasdef
                   and attribute.attgenerated = ''
                   and attribute.attidentity = ''
                   and not attribute.attisdropped
               )::integer
          into provider_evidence_column_count,
               provider_evidence_column_exact_count
          from pg_catalog.pg_attribute attribute
         where attribute.attrelid =
                 pg_catalog.to_regclass('public.email_outbox')
           and attribute.attname in (
             'provider_correlation_version',
             'provider_evidence_version',
             'provider_evidence_sha256'
           )
           and attribute.attnum > 0;

        if provider_evidence_column_count not in (0, 3)
           or (
             provider_evidence_column_count = 3
             and provider_evidence_column_exact_count <> 3
           )
           or (
             binding_column_count <> 2
             and provider_evidence_column_count = 3
           ) then
          raise exception 'email outbox provider evidence column contract is invalid'
            using errcode = '23514';
        end if;

        select pg_catalog.count(*)::integer,
               pg_catalog.count(*) filter (
                 where attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
                   and attribute.atttypmod = -1
                   and (
                     (
                       attribute.attname = 'idempotency_authority_sha256'
                       and not attribute.attnotnull
                     )
                     or (
                       attribute.attname in (
                         'idempotency_authority_version',
                         'idempotency_original_payload_sha256'
                       )
                       and attribute.attnotnull
                     )
                   )
                   and not attribute.atthasdef
                   and attribute.attgenerated = ''
                   and attribute.attidentity = ''
                   and not attribute.attisdropped
               )::integer
          into idempotency_authority_column_count,
               idempotency_authority_column_exact_count
          from pg_catalog.pg_attribute attribute
         where attribute.attrelid =
                 pg_catalog.to_regclass('public.email_outbox')
           and attribute.attname in (
             'idempotency_authority_version',
             'idempotency_authority_sha256',
             'idempotency_original_payload_sha256'
           )
           and attribute.attnum > 0;

        if idempotency_authority_column_count not in (0, 3)
           or (
             idempotency_authority_column_count = 3
             and idempotency_authority_column_exact_count <> 3
           )
           or (
             idempotency_authority_column_count = 3
             and provider_evidence_column_count <> 3
           ) then
          raise exception 'email outbox idempotency authority column contract is invalid'
            using errcode = '23514';
        end if;

        select pg_catalog.string_agg(
                 pg_catalog.format('%I', attribute.attname),
                 ', ' order by attribute.attnum
               )
          into existing_columns
          from pg_catalog.pg_attribute attribute
         where attribute.attrelid =
                 pg_catalog.to_regclass('public.email_outbox')
           and attribute.attnum > 0
           and not attribute.attisdropped;

        execute ${sqlLiteral(
          "revoke all on table public.email_outbox from learncoding_worker",
        )};
        execute pg_catalog.format(
          'revoke all (%s) on table public.email_outbox from learncoding_worker',
          existing_columns
        );
        execute ${sqlLiteral(
          "grant select on table public.email_outbox to learncoding_worker",
        )};
        if idempotency_authority_column_count = 3 then
          execute ${sqlLiteral(
            `grant insert (${insertColumns}) on table public.email_outbox to learncoding_worker`,
          )};
          execute ${sqlLiteral(
            "grant insert (idempotency_authority_version) on table public.email_outbox to learncoding_app",
          )};
        else
          execute ${sqlLiteral(
            `grant insert (${preReplayInsertColumns}) on table public.email_outbox to learncoding_worker`,
          )};
        end if;
        if provider_evidence_column_count = 3 then
          execute ${sqlLiteral(
            `grant update (${updateColumns}) on table public.email_outbox to learncoding_worker`,
          )};
        elsif binding_column_count = 2 then
          execute ${sqlLiteral(
            `grant update (${preEvidenceUpdateColumns}) on table public.email_outbox to learncoding_worker`,
          )};
        else
          execute ${sqlLiteral(
            `grant update (${preBindingUpdateColumns}) on table public.email_outbox to learncoding_worker`,
          )};
        end if;
      end if;
    end
    $codestead_mail_worker_outbox$;
  `;
}

export function mailReplayAuthorityPrivilegesSql() {
  return `
    do $codestead_mail_replay_authority_acl$
    declare
      existing_columns text;
    begin
      if pg_catalog.to_regclass(
           'public.email_outbox_idempotency_authority'
         ) is not null
         and pg_catalog.to_regrole('learncoding_owner') is not null
      then
        select pg_catalog.string_agg(
                 pg_catalog.format('%I', attribute.attname),
                 ', ' order by attribute.attnum
               )
          into existing_columns
          from pg_catalog.pg_attribute attribute
         where attribute.attrelid = pg_catalog.to_regclass(
                 'public.email_outbox_idempotency_authority'
               )
           and attribute.attnum > 0
           and not attribute.attisdropped;
        execute 'revoke all on table public.email_outbox_idempotency_authority from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter';
        execute pg_catalog.format(
          'revoke all (%s) on table public.email_outbox_idempotency_authority from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter',
          existing_columns
        );
        execute 'grant all on table public.email_outbox_idempotency_authority to learncoding_owner';
      end if;
    end
    $codestead_mail_replay_authority_acl$;
  `;
}
export function backupStatusAuthorityPrivilegesSql() {
  return `
    revoke all on table
      public.backup_status_mail_authority,
      public.backup_status_mail_admin_guard
      from public, current_user, learncoding_migrator, learncoding_app,
           learncoding_worker, learncoding_ops, learncoding_backup_reporter;
    revoke all (
      id, run_key, outcome, outbox_id, operation_id, authority_epoch,
      created_at
    ) on table public.backup_status_mail_authority
      from public, current_user, learncoding_migrator, learncoding_app,
           learncoding_worker, learncoding_ops, learncoding_backup_reporter;
    revoke all (
      singleton, authority_epoch
    ) on table public.backup_status_mail_admin_guard
      from public, current_user, learncoding_migrator, learncoding_app,
           learncoding_worker, learncoding_ops, learncoding_backup_reporter;
  `;
}

export async function reconcileBackupStatusAuthorityPrivileges(client, phase) {
  const expectedContract =
    canonicalReviewedMailAuthorityCatalogPhase(phase)?.backupStatusAuthority
    ?? null;
  const presence = await client.query(
    `select
       to_regclass(
         'public.backup_status_mail_authority'
       ) is not null source_present,
       to_regclass(
         'public.backup_status_mail_admin_guard'
       ) is not null guard_present`,
  );
  const sourcePresent = presence.rows[0]?.source_present === true;
  const guardPresent = presence.rows[0]?.guard_present === true;
  if (
    sourcePresent !== guardPresent
    || sourcePresent !== (expectedContract !== null)
  ) {
    throw databaseRoleBootstrapInvariantError(
      "backup-status-authority-phase",
    );
  }
  if (!sourcePresent) return false;

  await client.query(backupStatusAuthorityPrivilegesSql());
  return true;
}

const MAX_LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 500;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const MAX_SESSION_DRAIN_MS = 5_000;
const SESSION_DRAIN_POLL_MS = 50;
const MIN_PASSWORD_BYTES = 32;
const MAX_PASSWORD_BYTES = 1024;

const ROLE_SPECS = [
  ["bootstrap", "databaseBootstrapUrl", null],
  ["app", "databaseAppUrl", APP_ROLE],
  ["migrator", "databaseMigratorUrl", MIGRATOR_ROLE],
  ["worker", "databaseWorkerUrl", WORKER_ROLE],
  ["ops", "databaseOpsUrl", OPS_ROLE],
  ["backupReporter", "databaseBackupReporterUrl", BACKUP_REPORTER_ROLE],
];

function invalidCredentialConfiguration() {
  return new Error("database credential configuration is invalid");
}

function unsafeOwnershipInventory() {
  return new Error("unsafe legacy ownership inventory");
}

function decodeUrlComponent(value) {
  const decoded = decodeURIComponent(value);
  if (!decoded || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    throw invalidCredentialConfiguration();
  }
  return decoded;
}

function defaultAclGranteeIdentityExact(entry) {
  if (entry.grantee === null) {
    return entry.grantee_oid === null && entry.is_public === null;
  }
  if (
    !Number.isInteger(entry.grantee_oid) ||
    entry.grantee_oid < 0 ||
    typeof entry.is_public !== "boolean"
  ) {
    return false;
  }
  if (entry.grantee_oid === 0) {
    return entry.is_public === true && entry.grantee === "PUBLIC";
  }
  return (
    entry.is_public === false &&
    entry.grantee !== "PUBLIC"
  );
}

export function validateDatabaseRoleUrls(input) {
  const parsed = {};
  const usernames = new Set();
  const passwords = new Set();

  try {
    if (
      !/^[a-z_][a-z0-9_]{0,62}$/u.test(input.postgresUser) ||
      input.postgresUser === OWNER_ROLE
    ) {
      throw invalidCredentialConfiguration();
    }
    if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(input.postgresDatabase)) {
      throw invalidCredentialConfiguration();
    }

    for (const [name, property, fixedUsername] of ROLE_SPECS) {
      const url = new URL(input[property]);
      const username = decodeUrlComponent(url.username);
      const password = decodeUrlComponent(url.password);
      const passwordBytes = Buffer.byteLength(password, "utf8");
      if (
        passwordBytes < MIN_PASSWORD_BYTES ||
        passwordBytes > MAX_PASSWORD_BYTES
      ) {
        throw invalidCredentialConfiguration();
      }
      const database = decodeUrlComponent(url.pathname.slice(1));
      const expectedUsername = fixedUsername ?? input.postgresUser;

      if (
        url.protocol !== "postgresql:" ||
        username !== expectedUsername ||
        url.hostname !== "postgres" ||
        (url.port !== "" && url.port !== "5432") ||
        database !== input.postgresDatabase ||
        url.pathname !== `/${encodeURIComponent(input.postgresDatabase)}` ||
        url.search !== "" ||
        url.hash !== "" ||
        usernames.has(username) ||
        passwords.has(password)
      ) {
        throw invalidCredentialConfiguration();
      }

      usernames.add(username);
      passwords.add(password);
      parsed[name] = {
        username,
        password,
        hostname: url.hostname,
        database,
        connectionString: url.href,
      };
    }
  } catch {
    throw invalidCredentialConfiguration();
  }

  return parsed;
}

export function validateOwnershipInventory(input) {
  const allowedOwners = new Set([input.postgresUser, OWNER_ROLE]);
  const applicationSchemas = new Set(["public", "drizzle"]);
  const repairableGlobalDefaultAclKinds = new Set(["f", "T"]);
  const canonicalSystemDatabases = new Set([
    "postgres",
    "template0",
    "template1",
  ]);
  const target = input.databases.find(
    (database) => database.name === input.postgresDatabase,
  );
  const canonicalSystemTablespaces = new Set(["pg_default", "pg_global"]);
  const unsafeDatabase = input.databases.some(
    (database) =>
      allowedOwners.has(database.owner) &&
      database.name !== input.postgresDatabase &&
      !canonicalSystemDatabases.has(database.name),
  );
  const unsafeTablespace = input.tablespaces.some(
    (tablespace) =>
      allowedOwners.has(tablespace.owner) &&
      !canonicalSystemTablespaces.has(tablespace.name),
  );
  const unsafeSchema = input.schemas.some((schema) => {
    if (schema.name === "public") {
      return !new Set([...allowedOwners, "pg_database_owner"]).has(
        schema.owner,
      );
    }
    if (schema.name === "drizzle") return !allowedOwners.has(schema.owner);
    return allowedOwners.has(schema.owner);
  });
  const unsafeOwnedObject = [
    ...(input.objects ?? []),
    ...(input.routines ?? []),
    ...(input.types ?? []),
  ].some(
    (object) =>
      !applicationSchemas.has(object.schema) ||
      !allowedOwners.has(object.owner),
  );
  const allowedDefaultGrantees = new Set([
    ...allowedOwners,
    APP_ROLE,
    WORKER_ROLE,
    OPS_ROLE,
  ]);
  const allowedDirectGrantees = new Set([
    "PUBLIC",
    ...allowedDefaultGrantees,
    MIGRATOR_ROLE,
    BACKUP_REPORTER_ROLE,
    "pg_database_owner",
  ]);
  const unsafeDefaultAcl = (input.defaultAcls ?? []).some(
    (entry) => {
      const granteeIdentityExact =
        defaultAclGranteeIdentityExact(entry);
      const isRepairableGlobalDefaultAcl =
        entry.schema === "<global>" &&
        allowedOwners.has(entry.owner) &&
        repairableGlobalDefaultAclKinds.has(entry.kind);
      return (
        !granteeIdentityExact ||
        (!isRepairableGlobalDefaultAcl &&
        (!applicationSchemas.has(entry.schema) ||
          !allowedOwners.has(entry.owner) ||
          !(
            (entry.is_public === true && entry.grantee === "PUBLIC") ||
            allowedDefaultGrantees.has(entry.grantee)
          )))
      );
    },
  );

  const unsafeOwnerDependency =
    (input.unexpectedOwnerDependencies ?? []).length !== 0;
  const unsafeDirectAcl = (input.directAcls ?? []).some(
    (entry) =>
      !allowedDirectGrantees.has(entry.grantee) ||
      entry.isGrantable === true ||
      entry.is_grantable === true,
  );
  if (
    !target ||
    !allowedOwners.has(target.owner) ||
    unsafeDatabase ||
    unsafeTablespace ||
    unsafeSchema ||
    unsafeOwnedObject ||
    unsafeDefaultAcl ||
    unsafeOwnerDependency ||
    unsafeDirectAcl
  ) {
    throw unsafeOwnershipInventory();
  }
}

async function acquireAdministrationLock(
  client,
  timeoutMs = MAX_LOCK_TIMEOUT_MS,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      "database administration lock timeout must be positive and finite",
    );
  }
  const deadline = performance.now() + Math.min(timeoutMs, MAX_LOCK_TIMEOUT_MS);
  while (performance.now() < deadline) {
    const remainingMs = deadline - performance.now();
    let timeoutHandle;
    const query = Promise.resolve().then(() =>
      client.query(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) acquired",
        [DATABASE_ADMIN_LOCK_NAME],
      ),
    );
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error("database administration lock timeout")),
        remainingMs,
      );
    });
    let result;
    try {
      result = await Promise.race([query, timeout]);
      if (performance.now() >= deadline) {
        throw new Error("database administration lock timeout");
      }
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
    if (result.rows[0]?.acquired === true) return;
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(LOCK_POLL_MS, Math.max(1, deadline - performance.now())),
      ),
    );
  }
  throw new Error("database administration lock timeout");
}

async function loadOwnershipInventory(client, postgresUser, postgresDatabase) {
  const [
    databases,
    tablespaces,
    schemas,
    objects,
    routines,
    types,
    defaultAcls,
    unexpectedOwnerDependencies,
    directAcls,
  ] = [
    await client.query(
      `select d.datname name, pg_get_userbyid(d.datdba) owner
         from pg_database d
        where d.datname = current_database()
           or pg_get_userbyid(d.datdba) in ($1, 'learncoding_owner')
        order by d.datname`,
      [postgresUser],
    ),
    await client.query(
      `select t.spcname name, pg_get_userbyid(t.spcowner) owner
         from pg_tablespace t
        where pg_get_userbyid(t.spcowner) in ($1, 'learncoding_owner')
        order by t.spcname`,
      [postgresUser],
    ),
    await client.query(
      `select n.nspname name, pg_get_userbyid(n.nspowner) owner
         from pg_namespace n
        where n.nspname in ('public', 'drizzle')
           or (
             pg_get_userbyid(n.nspowner) in ($1, 'learncoding_owner')
             and n.nspname !~ '^pg_'
             and n.nspname <> 'information_schema'
           )
        order by n.nspname`,
      [postgresUser],
    ),
    await client.query(
      `select n.nspname schema, c.relname name, c.relkind::text kind,
              pg_get_userbyid(c.relowner) owner
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'S', 'v', 'm', 'f', 'c', 'i', 'I')
          and n.nspname !~ '^pg_'
          and n.nspname <> 'information_schema'
          and (
            n.nspname in ('public', 'drizzle')
            or pg_get_userbyid(c.relowner) in ($1, 'learncoding_owner')
          )
        order by n.nspname, c.relname`,
      [postgresUser],
    ),
    await client.query(
      `select n.nspname schema, p.proname name, p.prokind::text kind,
              pg_get_userbyid(p.proowner) owner
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname !~ '^pg_'
          and n.nspname <> 'information_schema'
          and (
            n.nspname in ('public', 'drizzle')
            or pg_get_userbyid(p.proowner) in ($1, 'learncoding_owner')
          )
        order by n.nspname, p.proname, p.oid`,
      [postgresUser],
    ),
    await client.query(
      `select n.nspname schema, t.typname name, t.typtype::text kind,
              pg_get_userbyid(t.typowner) owner
         from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
        where t.typtype in ('c', 'd', 'e', 'm', 'r')
          and n.nspname !~ '^pg_'
          and n.nspname <> 'information_schema'
          and (
            n.nspname in ('public', 'drizzle')
            or pg_get_userbyid(t.typowner) in ($1, 'learncoding_owner')
          )
        order by n.nspname, t.typname`,
      [postgresUser],
    ),
    await client.query(
      `select case when a.defaclnamespace = 0 then '<global>'
                   else n.nspname end schema,
              pg_get_userbyid(a.defaclrole) owner,
              case when privilege.grantee is null then null
                   when privilege.grantee = 0 then 'PUBLIC'
                   else pg_get_userbyid(privilege.grantee) end grantee,
              privilege.grantee grantee_oid,
              case when privilege.grantee is null then null
                   else privilege.grantee = 0 end is_public,
              a.defaclobjtype::text kind,
              privilege.privilege_type,
              privilege.is_grantable
         from pg_default_acl a
         left join pg_namespace n on n.oid = a.defaclnamespace
         left join lateral aclexplode(a.defaclacl) privilege on true
        order by 1, 2, 3, 4, 5, 6`,
    ),
    await client.query(
      `select catalog, object_id
         from (
           select 'pg_collation' catalog, oid::text object_id
             from pg_collation where oid >= 16384 and pg_get_userbyid(collowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_conversion', oid::text
             from pg_conversion where oid >= 16384 and pg_get_userbyid(conowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_event_trigger', oid::text
             from pg_event_trigger where oid >= 16384 and pg_get_userbyid(evtowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_extension', oid::text
             from pg_extension where oid >= 16384 and pg_get_userbyid(extowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_foreign_data_wrapper', oid::text
             from pg_foreign_data_wrapper where oid >= 16384 and pg_get_userbyid(fdwowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_foreign_server', oid::text
             from pg_foreign_server where oid >= 16384 and pg_get_userbyid(srvowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_language', oid::text
             from pg_language where oid >= 16384 and pg_get_userbyid(lanowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_largeobject_metadata', oid::text
             from pg_largeobject_metadata where oid >= 16384 and pg_get_userbyid(lomowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_opclass', oid::text
             from pg_opclass where oid >= 16384 and pg_get_userbyid(opcowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_operator', oid::text
             from pg_operator where oid >= 16384 and pg_get_userbyid(oprowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_opfamily', oid::text
             from pg_opfamily where oid >= 16384 and pg_get_userbyid(opfowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_publication', oid::text
             from pg_publication where oid >= 16384 and pg_get_userbyid(pubowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_statistic_ext', oid::text
             from pg_statistic_ext where oid >= 16384 and pg_get_userbyid(stxowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_subscription', oid::text
             from pg_subscription where oid >= 16384 and pg_get_userbyid(subowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_ts_config', oid::text
             from pg_ts_config where oid >= 16384 and pg_get_userbyid(cfgowner) in ($1, 'learncoding_owner')
           union all
           select 'pg_ts_dict', oid::text
             from pg_ts_dict where oid >= 16384 and pg_get_userbyid(dictowner) in ($1, 'learncoding_owner')
         ) unsupported
        order by catalog, object_id`,
      [postgresUser],
    ),
    await client.query(
      `select scope, grantee, privilege, is_grantable
         from (
           select 'database ' || d.datname scope,
                  case when acl.grantee = 0 then 'PUBLIC'
                       else pg_get_userbyid(acl.grantee) end grantee,
                   acl.privilege_type privilege,
                   acl.is_grantable
             from pg_database d
              cross join lateral aclexplode(d.datacl) acl
            where d.datname = $1
           union all
           select 'schema ' || n.nspname,
                  case when acl.grantee = 0 then 'PUBLIC'
                       else pg_get_userbyid(acl.grantee) end,
                   acl.privilege_type,
                   acl.is_grantable
             from pg_namespace n
              cross join lateral aclexplode(n.nspacl) acl
            where n.nspname in ('public', 'drizzle')
           union all
           select case when c.relkind = 'S' then 'sequence ' else 'relation ' end ||
                    n.nspname || '.' || c.relname,
                  case when acl.grantee = 0 then 'PUBLIC'
                       else pg_get_userbyid(acl.grantee) end,
                   acl.privilege_type,
                   acl.is_grantable
             from pg_class c
             join pg_namespace n on n.oid = c.relnamespace
              cross join lateral aclexplode(c.relacl) acl
            where n.nspname in ('public', 'drizzle')
           union all
           select 'routine ' || n.nspname || '.' || p.proname || '(' ||
                    pg_get_function_identity_arguments(p.oid) || ')',
                  case when acl.grantee = 0 then 'PUBLIC'
                       else pg_get_userbyid(acl.grantee) end,
                   acl.privilege_type,
                   acl.is_grantable
             from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
              cross join lateral aclexplode(p.proacl) acl
            where n.nspname in ('public', 'drizzle')
           union all
           select 'type ' || n.nspname || '.' || t.typname,
                  case when acl.grantee = 0 then 'PUBLIC'
                       else pg_get_userbyid(acl.grantee) end,
                   acl.privilege_type,
                   acl.is_grantable
             from pg_type t
             join pg_namespace n on n.oid = t.typnamespace
              cross join lateral aclexplode(t.typacl) acl
            where n.nspname in ('public', 'drizzle')
         ) direct_acl
        order by scope, grantee, privilege, is_grantable`,
      [postgresDatabase],
    ),
  ];
  return {
    postgresUser,
    postgresDatabase,
    databases: databases.rows,
    tablespaces: tablespaces.rows,
    schemas: schemas.rows,
    objects: objects.rows,
    routines: routines.rows,
    types: types.rows,
    defaultAcls: defaultAcls.rows,
    unexpectedOwnerDependencies: unexpectedOwnerDependencies.rows,
    directAcls: directAcls.rows,
  };
}

async function createAndResetRoles(client) {
  await client.query(`
    do $codestead$
    begin
      if not exists (select 1 from pg_roles where rolname = 'learncoding_owner') then
        create role learncoding_owner;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'learncoding_migrator') then
        create role learncoding_migrator login;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'learncoding_app') then
        create role learncoding_app login;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'learncoding_worker') then
        create role learncoding_worker login;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'learncoding_ops') then
        create role learncoding_ops login;
      end if;
      if not exists (select 1 from pg_roles where rolname = 'learncoding_backup_reporter') then
        create role learncoding_backup_reporter login;
      end if;
    end
    $codestead$`);

  await client.query(`
    alter role learncoding_owner nologin nosuperuser nocreatedb nocreaterole
      noinherit noreplication nobypassrls connection limit -1 password null valid until 'infinity';
    alter role learncoding_migrator login nosuperuser nocreatedb nocreaterole
      noinherit noreplication nobypassrls connection limit -1 valid until 'infinity';
    alter role learncoding_app login nosuperuser nocreatedb nocreaterole
      noinherit noreplication nobypassrls connection limit -1 valid until 'infinity';
    alter role learncoding_worker login nosuperuser nocreatedb nocreaterole
      noinherit noreplication nobypassrls connection limit -1 valid until 'infinity';
    alter role learncoding_ops login nosuperuser nocreatedb nocreaterole
      noinherit noreplication nobypassrls connection limit -1 valid until 'infinity';
    alter role learncoding_backup_reporter login nosuperuser nocreatedb nocreaterole
      noinherit noreplication nobypassrls connection limit -1 valid until 'infinity';
    alter role learncoding_owner reset all;
    alter role learncoding_migrator reset all;
    alter role learncoding_app reset all;
    alter role learncoding_worker reset all;
    alter role learncoding_ops reset all;
    alter role learncoding_backup_reporter reset all`);

  await client.query(`
    do $codestead$
    declare setting record;
    begin
      for setting in
        select roles.rolname, databases.datname
          from pg_db_role_setting configured
          join pg_roles roles on roles.oid = configured.setrole
          join pg_database databases on databases.oid = configured.setdatabase
         where roles.rolname in (
           'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
           'learncoding_worker', 'learncoding_ops', 'learncoding_backup_reporter'
         )
      loop
        execute format(
          'alter role %I in database %I reset all',
          setting.rolname,
          setting.datname
        );
      end loop;
    end
    $codestead$`);

  await client.query(`
    do $codestead$
    declare membership record;
    begin
      for membership in
        select granted.rolname granted_role, member.rolname member_role
          from pg_auth_members memberships
          join pg_roles granted on granted.oid = memberships.roleid
          join pg_roles member on member.oid = memberships.member
         where member.rolname in (
           'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
           'learncoding_worker', 'learncoding_ops', 'learncoding_backup_reporter'
         )
            or granted.rolname in (
              'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
              'learncoding_worker', 'learncoding_ops', 'learncoding_backup_reporter'
            )
      loop
        execute format('revoke %I from %I', membership.granted_role, membership.member_role);
      end loop;
    end
    $codestead$`);
  await client.query(
    "grant learncoding_owner to learncoding_migrator with admin false, inherit false, set true",
  );
}

async function rotatePasswords(client, roles) {
  await client.query("set local password_encryption = 'scram-sha-256'");
  for (const role of LOGIN_ROLES) {
    await client.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where usename = $1 and pid <> pg_backend_pid()",
      [role],
    );
    await client.query(
      "select set_config('codestead.role_password', $1, true)",
      [roles[role].password],
    );
    await client.query(`
      do $codestead$
      begin
        execute format(
          'alter role ${role} password %L',
          current_setting('codestead.role_password')
        );
      end
      $codestead$`);
  }
  const deadline = performance.now() + MAX_SESSION_DRAIN_MS;
  while (true) {
    await client.query("select pg_stat_clear_snapshot()");
    const remaining = await client.query(
      `select count(*)::integer remaining
         from pg_stat_activity
        where usename = any($1::text[])
          and pid <> pg_backend_pid()`,
      [LOGIN_ROLES],
    );
    if (remaining.rows[0]?.remaining === 0) break;
    if (performance.now() >= deadline) {
      throw new Error("database role sessions remain active");
    }
    await new Promise((resolve) => setTimeout(resolve, SESSION_DRAIN_POLL_MS));
  }
}

async function transferApplicationOwnership(client, phase) {
  const reviewedSignatures = reviewedPhaseRoutines(phase).map((routine) =>
    sqlLiteral(routine.signature),
  ).join(", ");
  await client.query(`
    do $codestead$
    declare object record;
    begin
      execute format('alter database %I owner to learncoding_owner', current_database());
      alter schema public owner to learncoding_owner;
      if exists (select 1 from pg_namespace where nspname = 'drizzle') then
        alter schema drizzle owner to learncoding_owner;
      end if;

      for object in
        select n.nspname, c.relname, c.relkind
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname in ('public', 'drizzle')
           and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f', 'c')
           and not (
             n.nspname = 'public'
             and c.relname = 'email_outbox'
             and c.relkind in ('r', 'p')
             and exists (
               select 1
                 from pg_catalog.pg_attribute reviewed_column
                where reviewed_column.attrelid = c.oid
                  and reviewed_column.attnum > 0
                  and not reviewed_column.attisdropped
                  and reviewed_column.attname like 'dispatch_binding_%'
             )
           )
         order by n.nspname, c.relname
      loop
        execute format(
          case object.relkind
            when 'S' then 'alter sequence %I.%I owner to learncoding_owner'
            when 'v' then 'alter view %I.%I owner to learncoding_owner'
            when 'm' then 'alter materialized view %I.%I owner to learncoding_owner'
            when 'f' then 'alter foreign table %I.%I owner to learncoding_owner'
            when 'c' then 'alter type %I.%I owner to learncoding_owner'
            else 'alter table %I.%I owner to learncoding_owner'
          end,
          object.nspname,
          object.relname
        );
      end loop;

      for object in
        select n.nspname, p.proname, p.prokind,
               pg_get_function_identity_arguments(p.oid) identity_arguments
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname in ('public', 'drizzle')
           and not exists (
             select 1
               from pg_catalog.unnest(
                 array[${reviewedSignatures}]::text[]
               ) reviewed(signature)
              where pg_catalog.to_regprocedure(reviewed.signature) = p.oid
           )
         order by n.nspname, p.proname, p.oid
      loop
        execute format(
          case object.prokind
            when 'p' then 'alter procedure %I.%I(%s) owner to learncoding_owner'
            when 'a' then 'alter aggregate %I.%I(%s) owner to learncoding_owner'
            else 'alter function %I.%I(%s) owner to learncoding_owner'
          end,
          object.nspname,
          object.proname,
          object.identity_arguments
        );
      end loop;

      for object in
        select n.nspname, t.typname
          from pg_type t
          join pg_namespace n on n.oid = t.typnamespace
         where n.nspname in ('public', 'drizzle')
           and t.typtype in ('d', 'e', 'r')
         order by n.nspname, t.typname
      loop
        execute format(
          'alter type %I.%I owner to learncoding_owner',
          object.nspname,
          object.typname
        );
      end loop;
    end
    $codestead$`);
}

async function reviewedMigrationJournalState(client) {
  const presence = await client.query(`
    select pg_catalog.to_regclass(
             'drizzle.__drizzle_migrations'
           ) is not null reviewed_migration_journal_present`);
  const journalPresent = presence.rows[0]?.reviewed_migration_journal_present;
  if (presence.rows.length !== 1 || typeof journalPresent !== "boolean") {
    throw databaseRoleBootstrapInvariantError(
      "reviewed-migration-journal-presence",
    );
  }
  if (!journalPresent) return [];

  const result = await client.query(
    `
    with reviewed(migration_index, created_at) as (
      select ($1::integer[])[position] migration_index,
             ($2::bigint[])[position] created_at
        from pg_catalog.generate_subscripts(
               $1::integer[],
               1
             ) position
    )
    select reviewed.migration_index,
           reviewed.created_at::text created_at,
           pg_catalog.count(journal.id)::integer applied_count,
           coalesce(
             pg_catalog.array_agg(journal.hash order by journal.id)
               filter (where journal.id is not null),
             '{}'::text[]
           ) applied_hashes
      from reviewed
      left join drizzle.__drizzle_migrations journal
        on journal.created_at = reviewed.created_at
     group by reviewed.migration_index, reviewed.created_at
     order by reviewed.migration_index`,
    [
      REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.map(({ index }) => index),
      REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.map(({ createdAt }) => createdAt),
    ],
  );
  if (result.rows.length !== REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.length) {
    throw databaseRoleBootstrapInvariantError(
      "reviewed-migration-journal-cardinality",
    );
  }

  const applied = [];
  let missingPredecessor = false;
  for (const phase of REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES) {
    const row = result.rows.find(
      ({ migration_index: migrationIndex }) => migrationIndex === phase.index,
    );
    if (
      row?.created_at !== phase.createdAt ||
      !Number.isInteger(row?.applied_count) ||
      !Array.isArray(row?.applied_hashes) ||
      row.applied_hashes.length !== row.applied_count ||
      ![0, 1].includes(row.applied_count)
    ) {
      throw databaseRoleBootstrapInvariantError(
        "reviewed-migration-journal-row",
      );
    }
    if (row.applied_count === 0) {
      missingPredecessor = true;
      continue;
    }
    if (missingPredecessor || row.applied_hashes[0] !== phase.migrationSha256) {
      throw databaseRoleBootstrapInvariantError(
        "reviewed-migration-journal-lineage",
      );
    }
    applied.push(phase);
  }
  return applied;
}

async function verifyBackupStatusAuthorityMigrationPhase(client, phase) {
  const presence = await client.query(`
    select (
      pg_catalog.to_regclass(
        'public.backup_status_mail_authority'
      ) is not null
      or pg_catalog.to_regclass(
        'public.backup_status_mail_admin_guard'
      ) is not null
      or pg_catalog.to_regprocedure(
        'public.reject_backup_status_mail_authority_mutation()'
      ) is not null
      or pg_catalog.to_regprocedure(
        'public.lock_backup_status_mail_admin_authority()'
      ) is not null
      or pg_catalog.to_regprocedure(
        'public.enqueue_backup_status_mail_authority(text,text)'
      ) is not null
      or pg_catalog.to_regprocedure(
        'public.backup_status_mail_authorized(uuid)'
      ) is not null
    ) backup_status_authority_present`);
  const present = presence.rows[0]?.backup_status_authority_present;
  const required =
    phase?.backupStatusAuthority !== null &&
    phase?.backupStatusAuthority !== undefined;
  if (
    presence.rows.length !== 1 ||
    typeof present !== "boolean" ||
    present !== required
  ) {
    throw databaseRoleBootstrapInvariantError(
      "backup-status-authority-migration-lineage",
    );
  }
  if (!required) return 0;
  try {
    await verifyBackupStatusMailAuthorityObjects(client, [
      MIGRATOR_ROLE,
      APP_ROLE,
      WORKER_ROLE,
      OPS_ROLE,
      BACKUP_REPORTER_ROLE,
    ], phase.backupStatusAuthority);
  } catch (error) {
    const invariant = databaseRoleBootstrapInvariantError(
      "backup-status-authority-migration-contract",
    );
    invariant.cause = error;
    throw invariant;
  }
  return 1;
}

export async function verifyPostMigrationReviewedContractsBeforeReconciliation(
  client,
  expectedPhase,
) {
  const canonicalExpectedPhase =
    canonicalReviewedMailAuthorityCatalogPhase(expectedPhase);
  const appliedPhases = await reviewedMigrationJournalState(client);
  const latestPhase = canonicalReviewedMailAuthorityCatalogPhase(
    appliedPhases.at(-1) ?? null,
  );
  if (latestPhase !== canonicalExpectedPhase) {
    throw databaseRoleBootstrapInvariantError(
      "reviewed-pre-reconciliation-phase-drift",
    );
  }
  const marker = await client.query(`
    select pg_catalog.count(*) filter (
             where attribute.attname in (
               'dispatch_binding_version',
               'dispatch_binding_sha256'
             )
           )::integer post_migration_binding_column_count,
           pg_catalog.count(*) filter (
             where attribute.attname in (
                     'dispatch_binding_version',
                     'dispatch_binding_sha256'
                   )
               and attribute.atttypid =
                     'pg_catalog.text'::pg_catalog.regtype
               and attribute.atttypmod = -1
               and not attribute.attnotnull
               and not attribute.atthasdef
               and attribute.attgenerated = ''
               and attribute.attidentity = ''
               and not attribute.attisdropped
           )::integer post_migration_binding_column_exact_count,
           pg_catalog.count(*) filter (
             where attribute.attname in (
               'provider_correlation_version',
               'provider_evidence_version',
               'provider_evidence_sha256'
             )
           )::integer post_migration_provider_column_count,
           pg_catalog.count(*) filter (
             where attribute.attname in (
                     'provider_correlation_version',
                     'provider_evidence_version',
                     'provider_evidence_sha256'
                   )
               and attribute.atttypid =
                     'pg_catalog.text'::pg_catalog.regtype
               and attribute.atttypmod = -1
               and not attribute.attnotnull
               and not attribute.atthasdef
               and attribute.attgenerated = ''
               and attribute.attidentity = ''
               and not attribute.attisdropped
           )::integer post_migration_provider_column_exact_count,
           pg_catalog.count(*) filter (
             where attribute.attname in (
               'idempotency_authority_version',
               'idempotency_authority_sha256',
               'idempotency_original_payload_sha256'
             )
           )::integer post_migration_replay_column_count,
           pg_catalog.count(*) filter (
             where attribute.attname in (
                     'idempotency_authority_version',
                     'idempotency_authority_sha256',
                     'idempotency_original_payload_sha256'
                   )
               and attribute.atttypid =
                     'pg_catalog.text'::pg_catalog.regtype
               and attribute.atttypmod = -1
               and (
                 (
                   attribute.attname = 'idempotency_authority_sha256'
                   and not attribute.attnotnull
                 )
                 or (
                   attribute.attname in (
                     'idempotency_authority_version',
                     'idempotency_original_payload_sha256'
                   )
                   and attribute.attnotnull
                 )
               )
               and not attribute.atthasdef
               and attribute.attgenerated = ''
               and attribute.attidentity = ''
               and not attribute.attisdropped
           )::integer post_migration_replay_column_exact_count
      from pg_catalog.pg_attribute attribute
     where attribute.attrelid =
             pg_catalog.to_regclass('public.email_outbox')
       and attribute.attnum > 0
       and attribute.attname in (
         'dispatch_binding_version',
         'dispatch_binding_sha256',
         'provider_correlation_version',
         'provider_evidence_version',
         'provider_evidence_sha256',
         'idempotency_authority_version',
         'idempotency_authority_sha256',
         'idempotency_original_payload_sha256'
       )`);

  const row = marker.rows[0];
  if (
    marker.rows.length !== 1 ||
    !Number.isInteger(row?.post_migration_binding_column_count) ||
    !Number.isInteger(row?.post_migration_binding_column_exact_count) ||
    !Number.isInteger(row?.post_migration_provider_column_count) ||
    !Number.isInteger(row?.post_migration_provider_column_exact_count) ||
    !Number.isInteger(row?.post_migration_replay_column_count) ||
    !Number.isInteger(row?.post_migration_replay_column_exact_count)
  )
    throw databaseRoleBootstrapInvariantError(
      "reviewed-pre-reconciliation-marker",
    );
  if (
    ![0, 2].includes(row.post_migration_binding_column_count) ||
    row.post_migration_binding_column_exact_count !==
      row.post_migration_binding_column_count ||
    ![0, 3].includes(row.post_migration_provider_column_count) ||
    row.post_migration_provider_column_exact_count !==
      row.post_migration_provider_column_count ||
    ![0, 3].includes(row.post_migration_replay_column_count) ||
    row.post_migration_replay_column_exact_count !==
      row.post_migration_replay_column_count ||
    (row.post_migration_provider_column_count === 3 &&
      row.post_migration_binding_column_count !== 2) ||
    (row.post_migration_replay_column_count === 3 &&
      row.post_migration_provider_column_count !== 3)
  )
    throw databaseRoleBootstrapInvariantError(
      "reviewed-pre-reconciliation-marker",
    );

  const verifier = await import("./verify-database-role-boundaries.mjs");
  if (latestPhase === null) {
    await verifyBackupStatusAuthorityMigrationPhase(client, null);
    await verifier.verifyReviewedMailAuthorityObjectFootprint(client, null);
    if (
      row.post_migration_binding_column_count !== 0
      || row.post_migration_provider_column_count !== 0
      || row.post_migration_replay_column_count !== 0
    ) {
      throw databaseRoleBootstrapInvariantError(
        "reviewed-pre-reconciliation-lineage",
      );
    }
    return 0;
  }
  if (
    (latestPhase.requiresWorkerContract &&
      row.post_migration_binding_column_count !== 2) ||
    (!latestPhase.requiresWorkerContract &&
      row.post_migration_binding_column_count !== 0) ||
    (latestPhase.requiresProviderEvidence &&
      row.post_migration_provider_column_count !== 3) ||
    (!latestPhase.requiresProviderEvidence &&
      row.post_migration_provider_column_count !== 0) ||
    (latestPhase.requiresReplayAuthority &&
      row.post_migration_replay_column_count !== 3) ||
    (!latestPhase.requiresReplayAuthority &&
      row.post_migration_replay_column_count !== 0)
  ) {
    throw databaseRoleBootstrapInvariantError(
      "reviewed-pre-reconciliation-lineage",
    );
  }
  await verifyBackupStatusAuthorityMigrationPhase(client, latestPhase);
  await verifier.verifyReviewedMailAuthorityObjectFootprint(
    client,
    latestPhase,
  );
  await verifier.verifyReviewedApplicationRoutines(
    client,
    latestPhase.routines,
  );
  await verifier.verifyReviewedApplicationTriggers(
    client,
    latestPhase.triggers,
  );
  await verifier.verifyMailWorkerOutboxContract(client, {
    requiresDispatchBinding: latestPhase.requiresWorkerContract,
    requiresProviderEvidence: latestPhase.requiresProviderEvidence,
    requiresReplayAuthority: latestPhase.requiresReplayAuthority,
  });
  return 1;
}

export function globalDefaultAclScrubSql() {
  return `
    do $codestead_global_default_acl$
    declare
      target record;
      grantee_index integer;
      grantee_oids oid[];
      grantee_is_public boolean[];
      grantee_names text[];
      quoted_grantee text;
    begin
      for target in
        select creator.oid creator_oid,
               creator.rolname creator_name,
               object_kind.object_type,
               object_kind.object_class,
               object_kind.owner_privilege
          from pg_catalog.pg_roles creator
          cross join (
            values
              ('f'::text, 'routines'::text, 'execute'::text),
              ('T'::text, 'types'::text, 'usage'::text)
          ) object_kind(
            object_type,
            object_class,
            owner_privilege
          )
         where creator.rolname in ('learncoding_owner', current_user)
         order by creator.rolname, object_kind.object_type
      loop
        select pg_catalog.array_agg(
                 observed.grantee_oid
                 order by observed.grantee_oid
               ),
               pg_catalog.array_agg(
                 observed.is_public
                 order by observed.grantee_oid
               ),
               pg_catalog.array_agg(
                 observed.grantee_name
                 order by observed.grantee_oid
               )
          into grantee_oids, grantee_is_public, grantee_names
          from (
            select access.grantee grantee_oid,
                   access.grantee = 0 is_public,
                   case when access.grantee = 0 then 'PUBLIC'
                        else pg_catalog.pg_get_userbyid(access.grantee)
                   end grantee_name
              from pg_catalog.pg_default_acl default_acl
              cross join lateral pg_catalog.aclexplode(
                default_acl.defaclacl
              ) access
             where default_acl.defaclrole = target.creator_oid
               and default_acl.defaclnamespace = 0
               and default_acl.defaclobjtype::text =
                     target.object_type
            union
            select 0::pg_catalog.oid, true, 'PUBLIC'
            union
            select target.creator_oid, false, target.creator_name
          ) observed;

        for grantee_index in 1..pg_catalog.array_length(grantee_oids, 1)
        loop
          quoted_grantee := case
            when grantee_is_public[grantee_index] then 'PUBLIC'
            else pg_catalog.format('%I', grantee_names[grantee_index])
          end;
          execute pg_catalog.format(
            'alter default privileges for role %I revoke all on %s from %s cascade',
            target.creator_name,
            target.object_class,
            quoted_grantee
          );
        end loop;

        execute pg_catalog.format(
          'alter default privileges for role %I grant %s on %s to %I',
          target.creator_name,
          target.owner_privilege,
          target.object_class,
          target.creator_name
        );
      end loop;
    end
    $codestead_global_default_acl$`;
}

export async function reconcileDatabaseRolePrivileges(client, phase) {
  const canonicalPhase = canonicalReviewedMailAuthorityCatalogPhase(phase);
  await verifyPostMigrationReviewedContractsBeforeReconciliation(
    client,
    canonicalPhase,
  );
  await client.query(globalDefaultAclScrubSql());
  await client.query(`
    do $codestead$
    begin
      execute format('revoke all on database %I from public', current_database());
      execute format('revoke all on database %I from learncoding_app', current_database());
      execute format('revoke all on database %I from learncoding_worker', current_database());
      execute format('revoke all on database %I from learncoding_ops', current_database());
      execute format('revoke all on database %I from learncoding_migrator', current_database());
      execute format('revoke all on database %I from learncoding_backup_reporter', current_database());
      execute format('revoke all on database %I from current_user', current_database());
      execute format(
        'grant connect on database %I to learncoding_app, learncoding_worker, learncoding_ops, learncoding_migrator, learncoding_backup_reporter',
        current_database()
      );
    end
    $codestead$;

    revoke all on schema public from public, pg_database_owner, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter;
    grant usage on schema public to learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter;
    revoke all on all tables in schema public from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter;
    grant select, insert, update, delete on all tables in schema public
      to learncoding_app, learncoding_worker, learncoding_ops;
    revoke all on all sequences in schema public from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter;
    grant usage, select, update on all sequences in schema public
      to learncoding_app, learncoding_worker, learncoding_ops;
    revoke execute on all routines in schema public from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter;
    do $codestead_types$
    declare object record;
    begin
      for object in
        select n.nspname, t.typname
          from pg_type t
          join pg_namespace n on n.oid = t.typnamespace
         where n.nspname = 'public'
           and t.typtype in ('c', 'd', 'e', 'r')
         order by t.oid
      loop
        execute format(
          'revoke usage on type %I.%I from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter',
          object.nspname,
          object.typname
        );
        execute format(
          'grant usage on type %I.%I to learncoding_app, learncoding_worker, learncoding_ops',
          object.nspname,
          object.typname
        );
      end loop;
    end
    $codestead_types$;

    alter default privileges for role learncoding_owner in schema public
      revoke all on tables from public, learncoding_owner, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
    alter default privileges for role learncoding_owner in schema public
      revoke all on sequences from public, learncoding_owner, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
    alter default privileges for role learncoding_owner in schema public
      revoke all on routines from public, learncoding_owner, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
    alter default privileges for role current_user in schema public revoke all on tables from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
    alter default privileges for role current_user in schema public revoke all on sequences from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
    alter default privileges for role current_user in schema public revoke execute on routines from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
    alter default privileges for role current_user in schema public revoke usage on types from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
    alter default privileges for role learncoding_owner in schema public
      revoke all on types from public, learncoding_owner, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
    alter default privileges for role learncoding_owner in schema public
      grant select, insert, update, delete on tables to learncoding_app, learncoding_worker, learncoding_ops;
    alter default privileges for role learncoding_owner in schema public
      grant usage, select, update on sequences to learncoding_app, learncoding_worker, learncoding_ops;
    alter default privileges for role learncoding_owner in schema public
      grant usage on types to learncoding_app, learncoding_worker, learncoding_ops`);

  await client.query(managedColumnAclScrubSql());
  await client.query(reviewedApplicationFunctionPrivilegesSql(canonicalPhase));

  const emailOutbox = await client.query(
    "select to_regclass('public.email_outbox') is not null present",
  );
  if (emailOutbox.rows[0]?.present === true) {
    await client.query(mailWorkerOutboxPrivilegesSql());
  }

  await client.query(mailReplayAuthorityPrivilegesSql());
  await reconcileBackupStatusAuthorityPrivileges(client, canonicalPhase);

  const drizzleExists = await client.query(
    "select exists(select 1 from pg_namespace where nspname = 'drizzle') present",
  );
  if (drizzleExists.rows[0]?.present === true) {
    await client.query(`
      revoke all on schema drizzle from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter;
      revoke all on all tables in schema drizzle from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter;
      revoke all on all sequences in schema drizzle from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter;
      revoke execute on all routines in schema drizzle from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter;
      do $codestead_types$
      declare object record;
      begin
        for object in
          select n.nspname, t.typname
            from pg_type t
            join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = 'drizzle'
             and t.typtype in ('c', 'd', 'e', 'r')
           order by t.oid
        loop
          execute format(
            'revoke usage on type %I.%I from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter',
            object.nspname,
            object.typname
          );
        end loop;
      end
      $codestead_types$;
      alter default privileges for role learncoding_owner in schema drizzle
        revoke all on tables from public, learncoding_owner, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
      alter default privileges for role learncoding_owner in schema drizzle
        revoke all on sequences from public, learncoding_owner, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
      alter default privileges for role learncoding_owner in schema drizzle
        revoke all on routines from public, learncoding_owner, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
      alter default privileges for role learncoding_owner in schema drizzle
        revoke all on types from public, learncoding_owner, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
      alter default privileges for role current_user in schema drizzle revoke all on tables from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
      alter default privileges for role current_user in schema drizzle revoke all on sequences from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
      alter default privileges for role current_user in schema drizzle revoke execute on routines from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade;
      alter default privileges for role current_user in schema drizzle revoke usage on types from public, current_user, learncoding_migrator, learncoding_app, learncoding_worker, learncoding_ops, learncoding_backup_reporter cascade`);
  }
}

function databaseRoleBootstrapInvariantError(section, details = []) {
  const detailSuffix = details.length > 0 ? `: ${details.join(",")}` : "";
  return new Error(
    `database role bootstrap invariant verification failed [${section}${detailSuffix}]`,
  );
}

async function verifyBackupStatusAuthorityAtBoundary(
  client,
  section,
  phase,
) {
  const contract =
    canonicalReviewedMailAuthorityCatalogPhase(phase)?.backupStatusAuthority
    ?? null;
  const presence = await client.query(`
    select (
      pg_catalog.to_regclass(
        'public.backup_status_mail_authority'
      ) is not null
      or pg_catalog.to_regclass(
        'public.backup_status_mail_admin_guard'
      ) is not null
      or pg_catalog.to_regprocedure(
        'public.reject_backup_status_mail_authority_mutation()'
      ) is not null
      or pg_catalog.to_regprocedure(
        'public.lock_backup_status_mail_admin_authority()'
      ) is not null
      or pg_catalog.to_regprocedure(
        'public.enqueue_backup_status_mail_authority(text,text)'
      ) is not null
      or pg_catalog.to_regprocedure(
        'public.backup_status_mail_authorized(uuid)'
      ) is not null
    ) present`);
  if (presence.rows.length !== 1) {
    throw databaseRoleBootstrapInvariantError(section);
  }
  const present = presence.rows[0]?.present;
  const required = contract !== null && contract !== undefined;
  if (typeof present !== "boolean" || present !== required) {
    throw databaseRoleBootstrapInvariantError(section);
  }
  if (!required) return false;

  try {
    await verifyBackupStatusMailAuthorityObjects(
      client,
      LOGIN_ROLES,
      contract,
    );
  } catch (error) {
    const invariant = databaseRoleBootstrapInvariantError(
      section,
    );
    invariant.cause = error;
    throw invariant;
  }
  return true;
}

export function verifyBackupStatusAuthorityBeforeRepair(client, phase) {
  return verifyBackupStatusAuthorityAtBoundary(
    client,
    "backup-status-authority-pre-repair",
    phase,
  );
}

export function verifyBackupStatusAuthorityAfterRepair(client, phase) {
  return verifyBackupStatusAuthorityAtBoundary(
    client,
    "backup-status-authority-post-repair",
    phase,
  );
}

function failedBooleanInvariantKeys(row) {
  return Object.entries(row ?? {})
    .filter(([, value]) => value !== true)
    .map(([key]) => key)
    .sort();
}
const DEFAULT_ACL_MANAGED_PRIVILEGES = Object.freeze({
  r: Object.freeze(["DELETE", "INSERT", "SELECT", "UPDATE"]),
  S: Object.freeze(["SELECT", "UPDATE", "USAGE"]),
  T: Object.freeze(["USAGE"]),
});
const DEFAULT_ACL_OWNER_PRIVILEGES = Object.freeze({
  f: "EXECUTE",
  T: "USAGE",
});

function defaultAclRowKey(owner, schema, kind) {
  return `${owner}|${schema}|${kind}`;
}

function defaultAclPrivilegeKey(entry) {
  return [
    entry.owner,
    entry.schema,
    entry.kind,
    entry.grantor,
    entry.grantee,
    entry.privilege_type,
    entry.is_grantable,
  ].join("|");
}

export function verifyDatabaseDefaultAclState({
  postgresUser,
  drizzleExists,
  entries,
}) {
  if (
    typeof postgresUser !== "string" ||
    postgresUser.length === 0 ||
    typeof drizzleExists !== "boolean" ||
    !Array.isArray(entries)
  ) {
    throw databaseRoleBootstrapInvariantError("default-acl-input");
  }

  void drizzleExists;
  const creators = [...new Set([OWNER_ROLE, postgresUser])];
  const expectedDefaultAclRows = new Set([
    defaultAclRowKey(OWNER_ROLE, "public", "r"),
    defaultAclRowKey(OWNER_ROLE, "public", "S"),
    defaultAclRowKey(OWNER_ROLE, "public", "T"),
    ...creators.flatMap((owner) =>
      Object.keys(DEFAULT_ACL_OWNER_PRIVILEGES).map((kind) =>
        defaultAclRowKey(owner, "<global>", kind),
      ),
    ),
  ]);
  const expectedPrivilegeKeys = new Set(
    [...expectedDefaultAclRows].flatMap((rowKey) => {
      const [owner, schema, kind] = rowKey.split("|");
      const privilege = DEFAULT_ACL_OWNER_PRIVILEGES[kind];
      return schema !== "<global>" || privilege === undefined
        ? []
        : [
            defaultAclPrivilegeKey({
              owner,
              schema,
              kind,
              grantor: owner,
              grantee: owner,
              privilege_type: privilege,
              is_grantable: false,
            }),
          ];
    }),
  );
  for (const grantee of [APP_ROLE, WORKER_ROLE, OPS_ROLE]) {
    for (const [kind, privileges] of Object.entries(
      DEFAULT_ACL_MANAGED_PRIVILEGES,
    )) {
      for (const privilege of privileges) {
        expectedPrivilegeKeys.add(
          defaultAclPrivilegeKey({
            owner: OWNER_ROLE,
            schema: "public",
            kind,
            grantor: OWNER_ROLE,
            grantee,
            privilege_type: privilege,
            is_grantable: false,
          }),
        );
      }
    }
  }

  const observedDefaultAclRows = new Set();
  const observedPrivilegeKeys = new Set();
  let exactPrivilegeCount = 0;
  for (const entry of entries) {
    if (!defaultAclGranteeIdentityExact(entry)) {
      throw databaseRoleBootstrapInvariantError(
        "default-acl-grantee-identity",
      );
    }
    const rowKey = defaultAclRowKey(entry.owner, entry.schema, entry.kind);
    if (!expectedDefaultAclRows.has(rowKey)) {
      throw databaseRoleBootstrapInvariantError("default-acl-rows", [rowKey]);
    }
    observedDefaultAclRows.add(rowKey);
    exactPrivilegeCount += 1;
    const privilegeKey = defaultAclPrivilegeKey(entry);
    if (
      !expectedPrivilegeKeys.has(privilegeKey) ||
      observedPrivilegeKeys.has(privilegeKey)
    ) {
      throw databaseRoleBootstrapInvariantError("default-acls-unexpected", [
        privilegeKey,
      ]);
    }
    observedPrivilegeKeys.add(privilegeKey);
  }
  if (
    observedDefaultAclRows.size !== expectedDefaultAclRows.size ||
    exactPrivilegeCount !== expectedPrivilegeKeys.size ||
    observedPrivilegeKeys.size !== expectedPrivilegeKeys.size
  ) {
    throw databaseRoleBootstrapInvariantError("default-acls-cardinality");
  }
}


export async function verifyDatabaseRoleBootstrapState(
  client,
  postgresDatabase,
  postgresUser,
  phase,
) {
  const canonicalPhase = canonicalReviewedMailAuthorityCatalogPhase(phase);
  const phaseRoutines = reviewedPhaseRoutines(canonicalPhase);
  const phaseSecurityDefiners = reviewedSecurityDefinerFunctions(
    canonicalPhase,
  );
  const roles = await client.query(`
    select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
           rolinherit, rolreplication, rolbypassrls, rolconnlimit,
           rolvaliduntil = 'infinity'::timestamptz valid_until_infinity,
           rolpassword is null password_is_null,
           coalesce(auth.rolpassword like 'SCRAM-SHA-256$%', false) password_is_scram,
           not exists (
             select 1 from pg_db_role_setting setting where setting.setrole = auth.oid
           ) role_settings_empty
      from pg_authid auth
     where rolname in (
       'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
       'learncoding_worker', 'learncoding_ops', 'learncoding_backup_reporter'
     )
     order by rolname`);
  if (roles.rows.length !== 6) {
    throw databaseRoleBootstrapInvariantError("roles-count");
  }
  for (const role of roles.rows) {
    const isOwner = role.rolname === OWNER_ROLE;
    if (
      role.rolcanlogin !== !isOwner ||
      role.rolsuper !== false ||
      role.rolcreatedb !== false ||
      role.rolcreaterole !== false ||
      role.rolinherit !== false ||
      role.rolreplication !== false ||
      role.rolbypassrls !== false ||
      role.rolconnlimit !== -1 ||
      role.valid_until_infinity !== true ||
      role.role_settings_empty !== true ||
      (isOwner
        ? role.password_is_null !== true
        : role.password_is_scram !== true)
    ) {
      throw databaseRoleBootstrapInvariantError("role-properties", [
        role.rolname,
      ]);
    }
  }

  const memberships = await client.query(`
    select granted.rolname granted_role, member.rolname member_role,
           membership.admin_option, membership.inherit_option,
           membership.set_option,
           pg_catalog.pg_has_role(
             member.oid, granted.oid, 'MEMBER'
           ) member_option,
           pg_catalog.pg_has_role(
             member.oid, granted.oid, 'USAGE'
           ) usage_option,
           pg_catalog.pg_has_role(
             member.oid, granted.oid, 'SET'
           ) role_set_option
      from pg_auth_members membership
      join pg_roles granted on granted.oid = membership.roleid
      join pg_roles member on member.oid = membership.member
     where granted.rolname in (
       'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
       'learncoding_worker', 'learncoding_ops', 'learncoding_backup_reporter'
     )
        or member.rolname in (
          'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
          'learncoding_worker', 'learncoding_ops', 'learncoding_backup_reporter'
        )
     order by granted.rolname, member.rolname`);
  const membership = memberships.rows[0];
  if (
    memberships.rows.length !== 1 ||
    membership?.granted_role !== OWNER_ROLE ||
    membership?.member_role !== MIGRATOR_ROLE ||
    membership?.admin_option !== false ||
    membership?.inherit_option !== false ||
    membership?.set_option !== true ||
    membership?.member_option !== true ||
    membership?.usage_option !== false ||
    membership?.role_set_option !== true
  ) {
    throw databaseRoleBootstrapInvariantError("memberships");
  }

  const databaseSettings = await client.query(`
    select count(*)::integer count
      from pg_db_role_setting configured
      join pg_roles roles on roles.oid = configured.setrole
     where roles.rolname in (
       'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
       'learncoding_worker', 'learncoding_ops', 'learncoding_backup_reporter'
     )`);
  if (databaseSettings.rows[0]?.count !== 0) {
    throw databaseRoleBootstrapInvariantError("role-settings");
  }

  const ownership = await client.query(
    `select
       (select pg_get_userbyid(datdba) = 'learncoding_owner'
          from pg_database where datname = $1) database_owned,
       (select count(*) = 3 and bool_and(pg_get_userbyid(datdba) = $2)
          from pg_database
         where datname in ('postgres', 'template0', 'template1')) canonical_databases_unchanged,
       not exists (
         select 1 from pg_database
          where pg_get_userbyid(datdba) in ($2, 'learncoding_owner')
            and datname not in ($1, 'postgres', 'template0', 'template1')
       ) no_unexpected_owned_database,
       (select count(*) = 2 and bool_and(pg_get_userbyid(spcowner) = $2)
          from pg_tablespace
         where spcname in ('pg_default', 'pg_global')) canonical_tablespaces_unchanged,
       not exists (
         select 1 from pg_tablespace
          where pg_get_userbyid(spcowner) in ($2, 'learncoding_owner')
            and spcname not in ('pg_default', 'pg_global')
       ) no_unexpected_owned_tablespace,
       (select pg_get_userbyid(nspowner) = 'learncoding_owner'
          from pg_namespace where nspname = 'public') public_schema_owned,
       case when exists(select 1 from pg_namespace where nspname = 'drizzle')
         then (select pg_get_userbyid(nspowner) = 'learncoding_owner'
                 from pg_namespace where nspname = 'drizzle')
         else true
       end drizzle_schema_owned,
       not exists (
         select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname in ('public', 'drizzle')
            and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f', 'c', 'i', 'I')
            and pg_get_userbyid(c.relowner) <> 'learncoding_owner'
       ) relations_owned,
       not exists (
         select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'drizzle')
            and pg_get_userbyid(p.proowner) <> 'learncoding_owner'
       ) routines_owned,
       not exists (
         select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
          where n.nspname in ('public', 'drizzle')
            and t.typtype in ('c', 'd', 'e', 'm', 'r')
            and pg_get_userbyid(t.typowner) <> 'learncoding_owner'
       ) types_owned`,
    [postgresDatabase, postgresUser],
  );
  if (Object.values(ownership.rows[0] ?? {}).some((value) => value !== true)) {
    throw databaseRoleBootstrapInvariantError(
      "ownership",
      failedBooleanInvariantKeys(ownership.rows[0]),
    );
  }

  const privileges = await client.query(
    `select
       not has_database_privilege(0, $1, 'CONNECT') public_connect_revoked,
       not has_database_privilege(0, $1, 'TEMP') public_temp_revoked,
       not has_database_privilege(0, $1, 'CREATE') public_create_revoked,
       has_database_privilege('learncoding_migrator', $1, 'CONNECT') migrator_connect,
       not has_database_privilege('learncoding_migrator', $1, 'TEMP') migrator_no_temp,
       not has_database_privilege('learncoding_migrator', $1, 'CREATE') migrator_no_create,
       not has_schema_privilege('learncoding_migrator', 'public', 'USAGE') migrator_no_schema_usage,
       not has_schema_privilege('learncoding_migrator', 'public', 'CREATE') migrator_no_schema_create,
       not has_schema_privilege(0, 'public', 'USAGE') public_schema_usage_revoked,
       not has_schema_privilege(0, 'public', 'CREATE') public_schema_create_revoked,
       not exists (
         select 1 from unnest(array['learncoding_app','learncoding_worker','learncoding_ops','learncoding_backup_reporter']) role_name
          where not has_database_privilege(role_name, $1, 'CONNECT')
             or has_database_privilege(role_name, $1, 'TEMP')
             or not has_schema_privilege(role_name, 'public', 'USAGE')
             or has_database_privilege(role_name, $1, 'CREATE')
             or has_schema_privilege(role_name, 'public', 'CREATE')
       ) runtime_database_schema_exact,
       case when exists(select 1 from pg_namespace where nspname = 'drizzle')
         then not exists (
           select 1 from unnest(array['learncoding_migrator','learncoding_app','learncoding_worker','learncoding_ops','learncoding_backup_reporter']) role_name
            where has_schema_privilege(role_name, 'drizzle', 'USAGE')
               or has_schema_privilege(role_name, 'drizzle', 'CREATE')
         )
         else true
       end drizzle_restricted,
       not exists (
         select 1
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           cross join unnest(array['learncoding_app','learncoding_ops']) role_name
          where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
            and c.relname not in (
              'backup_status_mail_authority',
              'backup_status_mail_admin_guard',
              'email_outbox_idempotency_authority'
            )
            and (
              not has_table_privilege(role_name, c.oid, 'SELECT')
              or not has_table_privilege(role_name, c.oid, 'INSERT')
              or not has_table_privilege(role_name, c.oid, 'UPDATE')
              or not has_table_privilege(role_name, c.oid, 'DELETE')
              or has_table_privilege(role_name, c.oid, 'TRUNCATE')
              or has_table_privilege(role_name, c.oid, 'REFERENCES')
              or has_table_privilege(role_name, c.oid, 'TRIGGER')
              or has_table_privilege(role_name, c.oid, 'MAINTAIN')
            )
       ) table_privileges_exact,
       not exists (
         select 1
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r','p','v','m','f')
            and c.relname not in (
              'email_outbox',
              'backup_status_mail_authority',
              'backup_status_mail_admin_guard',
              'email_outbox_idempotency_authority'
            )
            and (
              not has_table_privilege('learncoding_worker', c.oid, 'SELECT')
              or not has_table_privilege('learncoding_worker', c.oid, 'INSERT')
              or not has_table_privilege('learncoding_worker', c.oid, 'UPDATE')
              or not has_table_privilege('learncoding_worker', c.oid, 'DELETE')
              or has_table_privilege('learncoding_worker', c.oid, 'TRUNCATE')
              or has_table_privilege('learncoding_worker', c.oid, 'REFERENCES')
              or has_table_privilege('learncoding_worker', c.oid, 'TRIGGER')
              or has_table_privilege('learncoding_worker', c.oid, 'MAINTAIN')
            )
       ) worker_other_table_privileges_exact,
       case when to_regclass('public.email_outbox') is null then true
         else
           has_table_privilege(
             'learncoding_worker', 'public.email_outbox', 'SELECT'
           )
           and not has_table_privilege(
             'learncoding_worker', 'public.email_outbox', 'DELETE'
           )
           and not has_table_privilege(
             'learncoding_worker', 'public.email_outbox', 'TRUNCATE'
           )
           and not has_column_privilege(
             'learncoding_worker', 'public.email_outbox', 'variables', 'UPDATE'
           )
           and not has_column_privilege(
             'learncoding_worker', 'public.email_outbox', 'to_email', 'UPDATE'
           )
           and not has_column_privilege(
             'learncoding_worker', 'public.email_outbox', 'template', 'UPDATE'
           )
           and has_column_privilege(
             'learncoding_worker', 'public.email_outbox', 'variables', 'INSERT'
           )
           and has_column_privilege(
             'learncoding_worker', 'public.email_outbox', 'status', 'UPDATE'
           )
           and has_column_privilege(
             'learncoding_worker', 'public.email_outbox', 'updated_at', 'UPDATE'
           )
       end worker_outbox_privileges_exact,
       case
         when to_regclass(
           'public.backup_status_mail_authority'
         ) is null
         and to_regclass(
           'public.backup_status_mail_admin_guard'
         ) is null
           then true
         when to_regclass(
           'public.backup_status_mail_authority'
         ) is null
         or to_regclass(
           'public.backup_status_mail_admin_guard'
         ) is null
           then false
         else not exists (
           select 1
             from unnest(
               array[
                 'learncoding_migrator',
                 'learncoding_app',
                 'learncoding_worker',
                 'learncoding_ops',
                 'learncoding_backup_reporter'
               ]
             ) role_name
             cross join unnest(
               array[
                 'public.backup_status_mail_authority',
                 'public.backup_status_mail_admin_guard'
               ]
             ) relation_name
            where has_table_privilege(
                    role_name, relation_name, 'SELECT'
                  )
               or has_table_privilege(
                    role_name, relation_name, 'INSERT'
                  )
               or has_table_privilege(
                    role_name, relation_name, 'UPDATE'
                  )
               or has_table_privilege(
                    role_name, relation_name, 'DELETE'
                  )
               or has_table_privilege(
                    role_name, relation_name, 'TRUNCATE'
                  )
               or has_table_privilege(
                    role_name, relation_name, 'REFERENCES'
                  )
               or has_table_privilege(
                    role_name, relation_name, 'TRIGGER'
                  )
               or has_table_privilege(
                    role_name, relation_name, 'MAINTAIN'
                  )
               or has_any_column_privilege(
                    role_name, relation_name, 'SELECT'
                  )
               or has_any_column_privilege(
                    role_name, relation_name, 'INSERT'
                  )
               or has_any_column_privilege(
                    role_name, relation_name, 'UPDATE'
                  )
               or has_any_column_privilege(
                    role_name, relation_name, 'REFERENCES'
                  )
         )
       end backup_status_authority_table_restricted,
       not exists (
         select 1
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           cross join unnest(array['learncoding_app','learncoding_worker','learncoding_ops']) role_name
          where n.nspname = 'public' and c.relkind = 'S'
            and (
              not has_sequence_privilege(role_name, c.oid, 'USAGE')
              or not has_sequence_privilege(role_name, c.oid, 'SELECT')
              or not has_sequence_privilege(role_name, c.oid, 'UPDATE')
            )
       ) sequence_privileges_exact,
       not exists (
         select 1
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          cross join unnest(array['learncoding_migrator','learncoding_backup_reporter']) role_name
          where n.nspname in ('public', 'drizzle')
            and c.relkind in ('r','p','v','m','f')
            and (
              has_table_privilege(role_name, c.oid, 'SELECT')
              or has_table_privilege(role_name, c.oid, 'INSERT')
              or has_table_privilege(role_name, c.oid, 'UPDATE')
              or has_table_privilege(role_name, c.oid, 'DELETE')
              or has_table_privilege(role_name, c.oid, 'TRUNCATE')
              or has_table_privilege(role_name, c.oid, 'REFERENCES')
              or has_table_privilege(role_name, c.oid, 'TRIGGER')
              or has_table_privilege(role_name, c.oid, 'MAINTAIN')
            )
       ) migrator_table_restricted,
       not exists (
         select 1
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          cross join unnest(array['learncoding_migrator','learncoding_backup_reporter']) role_name
          where n.nspname in ('public', 'drizzle') and c.relkind = 'S'
            and (
              has_sequence_privilege(role_name, c.oid, 'USAGE')
              or has_sequence_privilege(role_name, c.oid, 'SELECT')
              or has_sequence_privilege(role_name, c.oid, 'UPDATE')
            )
       ) migrator_sequence_restricted,
       not exists (
         select 1
           from pg_type t
           join pg_namespace n on n.oid = t.typnamespace
           cross join unnest(array['learncoding_app','learncoding_worker','learncoding_ops']) role_name
          where n.nspname = 'public'
            and not has_type_privilege(role_name, t.oid, 'USAGE')
       ) runtime_type_usage,
       not exists (
         select 1
           from pg_type t
           join pg_namespace n on n.oid = t.typnamespace
          cross join unnest(array['learncoding_migrator','learncoding_backup_reporter']) role_name
          where n.nspname in ('public', 'drizzle')
            and has_type_privilege(role_name, t.oid, 'USAGE')
       ) migrator_type_restricted,
       not exists (
         select 1
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'drizzle')
            and (
              has_function_privilege(0, p.oid, 'EXECUTE')
              or exists (
                select 1
                  from unnest(array['learncoding_migrator','learncoding_app','learncoding_worker','learncoding_ops','learncoding_backup_reporter']) role_name
                 where has_function_privilege(role_name, p.oid, 'EXECUTE')
                       is distinct from exists (
                         select 1
                           from pg_catalog.jsonb_to_recordset($2::jsonb)
                                reviewed(
                                  signature text,
                                  allowed_role text
                                )
                          where reviewed.allowed_role = role_name
                            and p.oid =
                              pg_catalog.to_regprocedure(reviewed.signature)
                       )
              )
            )
       ) routine_execute_exact,
       not exists (
         select 1
           from pg_catalog.jsonb_to_recordset($3::jsonb)
                 expected(signature text, configuration text[])
           left join pg_catalog.pg_proc p
             on p.oid = pg_catalog.to_regprocedure(expected.signature)
           left join pg_catalog.pg_roles owner_role
             on owner_role.oid = p.proowner
          where p.oid is not null and (
                p.prokind <> 'f'
             or owner_role.rolname is distinct from 'learncoding_owner'
             or p.prosecdef is distinct from true
             or p.proconfig is distinct from expected.configuration
          )
       ) routine_security_exact,
       (
         with observed(
           routine_oid, grantor, grantee, privilege_type, is_grantable
         ) as (
           select p.oid,
                  acl.grantor,
                  acl.grantee,
                  acl.privilege_type,
                  acl.is_grantable
             from pg_catalog.pg_proc p
             join pg_catalog.pg_namespace n on n.oid = p.pronamespace
             cross join lateral pg_catalog.aclexplode(
               coalesce(p.proacl, acldefault('f', p.proowner))
             ) acl
            where n.nspname in ('public', 'drizzle')
              and acl.grantee <> p.proowner
         ),
         expected(
           routine_oid, grantor, grantee, privilege_type, is_grantable
         ) as (
           select target.oid,
                  target.proowner,
                  grantee.oid,
                  'EXECUTE'::text,
                  false
             from pg_catalog.jsonb_to_recordset($2::jsonb)
                  reviewed(signature text, allowed_role text)
             join pg_catalog.pg_proc target
               on target.oid =
                  pg_catalog.to_regprocedure(reviewed.signature)::oid
             join pg_catalog.pg_roles grantee
               on grantee.rolname = reviewed.allowed_role
         )
         select not exists (
           select 1
             from (
               (
                 select * from observed
                 except all
                 select * from expected
               )
               union all
               (
                 select * from expected
                 except all
                 select * from observed
               )
             ) difference
         )
       ) routine_direct_acl_exact,
       (
         with observed(
           type_oid, grantor, grantee, privilege_type, is_grantable
         ) as (
           select t.oid,
                  acl.grantor,
                  acl.grantee,
                  acl.privilege_type,
                  acl.is_grantable
             from pg_catalog.pg_type t
             join pg_catalog.pg_namespace n on n.oid = t.typnamespace
             cross join lateral pg_catalog.aclexplode(
               coalesce(t.typacl, acldefault('T', t.typowner))
             ) acl
            where n.nspname in ('public', 'drizzle')
              and not (
                t.typelem <> 0
                and t.typsubscript =
                  'pg_catalog.array_subscript_handler'::pg_catalog.regproc
              )
              and t.typtype <> 'm'
              and acl.grantee <> t.typowner
         ),
         expected(
           type_oid, grantor, grantee, privilege_type, is_grantable
         ) as (
           select t.oid,
                  t.typowner,
                  grantee.oid,
                  'USAGE'::text,
                  false
             from pg_catalog.pg_type t
             join pg_catalog.pg_namespace n on n.oid = t.typnamespace
             cross join unnest(
               array[
                 'learncoding_app',
                 'learncoding_worker',
                 'learncoding_ops'
               ]
             ) role_name
             join pg_catalog.pg_roles grantee
               on grantee.rolname = role_name
            where n.nspname = 'public'
              and not (
                t.typelem <> 0
                and t.typsubscript =
                  'pg_catalog.array_subscript_handler'::pg_catalog.regproc
              )
              and t.typtype <> 'm'
         )
         select not exists (
           select 1
             from (
               (
                 select * from observed
                 except all
                 select * from expected
               )
               union all
               (
                 select * from expected
                 except all
                 select * from observed
               )
             ) difference
         )
       ) type_direct_acl_exact`,
    [
      postgresDatabase,
      JSON.stringify(
        phaseRoutines.flatMap(({ signature, allowedRoles }) =>
          allowedRoles.map((allowedRole) => ({
            signature,
            allowed_role: allowedRole,
          })),
        ),
      ),
      JSON.stringify(phaseSecurityDefiners),
    ],
  );
  if (Object.values(privileges.rows[0] ?? {}).some((value) => value !== true)) {
    throw databaseRoleBootstrapInvariantError(
      "privileges",
      failedBooleanInvariantKeys(privileges.rows[0]),
    );
  }

  const unexpectedDirectAcls = await client.query(
    `select count(*)::integer count
       from (
         select case when acl.grantee = 0 then 'PUBLIC'
                     else pg_get_userbyid(acl.grantee) end grantee,
                acl.is_grantable = false grant_not_delegable
           from pg_database d
           cross join lateral aclexplode(d.datacl) acl
          where d.datname = $1
         union all
         select case when acl.grantee = 0 then 'PUBLIC'
                     else pg_get_userbyid(acl.grantee) end,
                acl.is_grantable = false
           from pg_namespace n
           cross join lateral aclexplode(n.nspacl) acl
          where n.nspname in ('public', 'drizzle')
         union all
         select case when acl.grantee = 0 then 'PUBLIC'
                     else pg_get_userbyid(acl.grantee) end,
                acl.is_grantable = false
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
           cross join lateral aclexplode(c.relacl) acl
          where n.nspname in ('public', 'drizzle')
         union all
         select case when acl.grantee = 0 then 'PUBLIC'
                     else pg_get_userbyid(acl.grantee) end,
                acl.is_grantable = false
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           cross join lateral aclexplode(
             coalesce(p.proacl, acldefault('f', p.proowner))
           ) acl
          where n.nspname in ('public', 'drizzle')
         union all
         select case when acl.grantee = 0 then 'PUBLIC'
                     else pg_get_userbyid(acl.grantee) end,
                acl.is_grantable = false
           from pg_type t
           join pg_namespace n on n.oid = t.typnamespace
           cross join lateral aclexplode(
             coalesce(t.typacl, acldefault('T', t.typowner))
           ) acl
          where n.nspname in ('public', 'drizzle')
            and not (
              t.typelem <> 0
              and t.typsubscript =
                'pg_catalog.array_subscript_handler'::pg_catalog.regproc
            )
            and t.typtype <> 'm'
       ) direct_acl
      where grantee not in (
        'learncoding_owner', 'learncoding_migrator', 'learncoding_app',
        'learncoding_worker', 'learncoding_ops', 'learncoding_backup_reporter'
      )
         or not grant_not_delegable`,
    [postgresDatabase],
  );
  if (unexpectedDirectAcls.rows[0]?.count !== 0) {
    throw databaseRoleBootstrapInvariantError("direct-acls");
  }

  const defaultAclSchemaState = await client.query(
    `select to_regnamespace('drizzle') is not null drizzle_exists`,
  );
  if (
    defaultAclSchemaState.rows.length !== 1 ||
    typeof defaultAclSchemaState.rows[0]?.drizzle_exists !== "boolean"
  ) {
    throw databaseRoleBootstrapInvariantError("default-acl-schema-state");
  }
  const defaultAcls = await client.query(
    `
    select case when a.defaclnamespace = 0 then '<global>'
                else n.nspname end schema,
           pg_get_userbyid(a.defaclrole) owner,
           case when privilege.grantor is null then null
                else pg_get_userbyid(privilege.grantor) end grantor,
           case when privilege.grantee is null then null
                when privilege.grantee = 0 then 'PUBLIC'
                else pg_get_userbyid(privilege.grantee) end grantee,
           privilege.grantee grantee_oid,
           case when privilege.grantee is null then null
                else privilege.grantee = 0 end is_public,
           a.defaclobjtype::text kind,
           privilege.privilege_type,
           privilege.is_grantable
      from pg_default_acl a
      left join pg_namespace n on n.oid = a.defaclnamespace
      left join lateral aclexplode(a.defaclacl) privilege on true
     order by 1, 2, 3, 4, 5, 6, 7`,
  );
  verifyDatabaseDefaultAclState({
    postgresUser,
    drizzleExists: defaultAclSchemaState.rows[0].drizzle_exists,
    entries: defaultAcls.rows,
  });

  const remainingSessions = await client.query(
    `select count(*)::integer count from pg_stat_activity
      where usename = any($1::text[]) and pid <> pg_backend_pid()`,
    [LOGIN_ROLES],
  );
  if (remainingSessions.rows[0]?.count !== 0) {
    throw databaseRoleBootstrapInvariantError("sessions");
  }

  const checks = {
    rolesExact: true,
    membershipsExact: true,
    ownershipExact: true,
    privilegesExact: true,
    defaultPrivilegesExact: true,
    sessionsTerminated: true,
  };
  if (Object.values(checks).some((value) => value !== true)) {
    throw databaseRoleBootstrapInvariantError("checks");
  }
  return checks;
}

class DatabaseBootstrapCleanupTimeoutError extends Error {
  constructor(phase) {
    super(`database bootstrap cleanup timed out during ${phase}`);
    this.name = "DatabaseBootstrapCleanupTimeoutError";
  }
}

class DatabaseBootstrapUnlockError extends Error {
  constructor() {
    super("PostgreSQL did not release the database administration lock");
    this.name = "DatabaseBootstrapUnlockError";
  }
}

function normalizeCleanupTimeoutMs(timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      "database bootstrap cleanup timeout must be positive and finite",
    );
  }
  return Math.min(timeoutMs, DEFAULT_CLEANUP_TIMEOUT_MS);
}

async function boundedCleanupOperation(operation, timeoutMs, phase) {
  const deadline = performance.now() + timeoutMs;
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new DatabaseBootstrapCleanupTimeoutError(phase)),
      timeoutMs,
    );
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(operation),
      timeout,
    ]);
    if (performance.now() >= deadline) {
      throw new DatabaseBootstrapCleanupTimeoutError(phase);
    }
    return result;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export async function cleanupDatabaseBootstrapResources({
  client,
  pool,
  transactionOpen,
  lockAcquired,
  destroyClient = false,
  timeoutMs = DEFAULT_CLEANUP_TIMEOUT_MS,
}) {
  const boundedTimeoutMs = normalizeCleanupTimeoutMs(timeoutMs);
  let cleanupError;
  let cleanupUnsafe = false;
  let destroy = destroyClient;

  if (client && transactionOpen) {
    try {
      await boundedCleanupOperation(
        () => client.query("rollback"),
        boundedTimeoutMs,
        "rollback",
      );
    } catch (error) {
      cleanupError = error;
      cleanupUnsafe = true;
      destroy = true;
    }
  }

  if (client && lockAcquired && !cleanupUnsafe) {
    try {
      const unlock = await boundedCleanupOperation(
        () =>
          client.query(
            "select pg_advisory_unlock(hashtextextended($1, 0)) released",
            [DATABASE_ADMIN_LOCK_NAME],
          ),
        boundedTimeoutMs,
        "advisory unlock",
      );
      if (unlock.rows[0]?.released !== true)
        throw new DatabaseBootstrapUnlockError();
    } catch (error) {
      cleanupError ??= error;
      destroy = true;
    }
  }

  if (client) {
    try {
      client.release(destroy || undefined);
    } catch (error) {
      cleanupError ??= error;
    }
  }

  try {
    await boundedCleanupOperation(
      () => pool.end(),
      boundedTimeoutMs,
      "pool shutdown",
    );
  } catch (error) {
    cleanupError ??= error;
  }
  if (cleanupError) throw cleanupError;
}

export async function runDatabaseRoleBootstrap(options) {
  const parsed = validateDatabaseRoleUrls(options);
  const verifyAppliedMigrationLedger =
    options.verifyAppliedMigrationLedger ??
    verifyAppliedMigrationLedgerContract;
  const requireCompleteMigrationLedger =
    options.requireCompleteMigrationLedger ?? false;
  if (typeof requireCompleteMigrationLedger !== "boolean") {
    throw new TypeError("requireCompleteMigrationLedger must be boolean");
  }
  const cleanupTimeoutMs = normalizeCleanupTimeoutMs(
    options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
  );
  const pool =
    options.pool ??
    new Pool({ connectionString: parsed.bootstrap.connectionString, max: 1 });
  let client;
  let lockAcquired = false;
  let transactionOpen = false;
  let destroyClient = false;

  try {
    client = await pool.connect();
    await client.query(
      "select pg_catalog.set_config('search_path', 'pg_catalog,pg_temp', false) trusted_search_path",
    );
    const identity = await client.query(
      `select current_user, current_database(), rolsuper
         from pg_roles
        where rolname = current_user`,
    );
    const identityRow = identity.rows[0];
    if (
      identityRow?.current_user !== options.postgresUser ||
      identityRow?.current_database !== options.postgresDatabase ||
      identityRow?.rolsuper !== true
    ) {
      throw new Error("database bootstrap authority verification failed");
    }

    await acquireAdministrationLock(client, options.lockTimeoutMs);
    lockAcquired = true;
    await client.query("begin");
    transactionOpen = true;
    await verifyAppliedMigrationLedger(client, {
      requireComplete: requireCompleteMigrationLedger,
    });
    const inventory = await loadOwnershipInventory(
      client,
      options.postgresUser,
      options.postgresDatabase,
    );
    validateOwnershipInventory(inventory);

    let reviewedPhase = await resolveReviewedMailAuthorityCatalogPhase(client);
    await verifyPostMigrationReviewedContractsBeforeReconciliation(
      client,
      reviewedPhase,
    );
    await verifyBackupStatusAuthorityBeforeRepair(client, reviewedPhase);
    await createAndResetRoles(client);
    const rolePasswords = {
      [MIGRATOR_ROLE]: parsed.migrator,
      [APP_ROLE]: parsed.app,
      [WORKER_ROLE]: parsed.worker,
      [OPS_ROLE]: parsed.ops,
      [BACKUP_REPORTER_ROLE]: parsed.backupReporter,
    };
    await rotatePasswords(client, rolePasswords);
    await transferApplicationOwnership(client, reviewedPhase);
    await reconcileDatabaseRolePrivileges(client, reviewedPhase);
    await verifyPostMigrationReviewedContractsBeforeReconciliation(
      client,
      reviewedPhase,
    );
    await verifyBackupStatusAuthorityAfterRepair(client, reviewedPhase);
    await verifyDatabaseRoleBootstrapState(
      client,
      options.postgresDatabase,
      options.postgresUser,
      reviewedPhase,
    );

    if (options.beforeCommit) {
      await options.beforeCommit(client);
      reviewedPhase = await resolveReviewedMailAuthorityCatalogPhase(client);
      await verifyPostMigrationReviewedContractsBeforeReconciliation(
        client,
        reviewedPhase,
      );
      await verifyBackupStatusAuthorityAfterRepair(client, reviewedPhase);
      await verifyDatabaseRoleBootstrapState(
        client,
        options.postgresDatabase,
        options.postgresUser,
        reviewedPhase,
      );
    }

    const preCommitPhase =
      await resolveReviewedMailAuthorityCatalogPhase(client);
    if (preCommitPhase !== reviewedPhase) {
      throw databaseRoleBootstrapInvariantError(
        "reviewed-pre-commit-phase-drift",
      );
    }
    await verifyPostMigrationReviewedContractsBeforeReconciliation(
      client,
      preCommitPhase,
    );
    await verifyBackupStatusAuthorityAfterRepair(client, preCommitPhase);
    await client.query("commit");
    transactionOpen = false;

    const committedPhase =
      await resolveReviewedMailAuthorityCatalogPhase(client);
    await verifyPostMigrationReviewedContractsBeforeReconciliation(
      client,
      committedPhase,
    );
    await verifyBackupStatusAuthorityAfterRepair(client, committedPhase);
    return await verifyDatabaseRoleBootstrapState(
      client,
      options.postgresDatabase,
      options.postgresUser,
      committedPhase,
    );  } catch (error) {
    destroyClient = true;
    throw error;
  } finally {
    await cleanupDatabaseBootstrapResources({
      client,
      pool,
      transactionOpen,
      lockAcquired,
      destroyClient,
      timeoutMs: cleanupTimeoutMs,
    });
  }
}

async function main() {
  const requireCompleteSetting =
    process.env.REQUIRE_COMPLETE_MIGRATION_LEDGER ?? "false";
  if (!/^(?:true|false)$/u.test(requireCompleteSetting)) {
    throw new Error("REQUIRE_COMPLETE_MIGRATION_LEDGER must be true or false");
  }
  const checks = await runDatabaseRoleBootstrap({
    postgresUser: process.env.POSTGRES_USER ?? "",
    postgresDatabase: process.env.POSTGRES_DB ?? "",
    databaseBootstrapUrl: process.env.DATABASE_BOOTSTRAP_URL ?? "",
    databaseAppUrl: process.env.DATABASE_APP_URL ?? "",
    databaseMigratorUrl: process.env.DATABASE_MIGRATOR_URL ?? "",
    databaseWorkerUrl: process.env.DATABASE_WORKER_URL ?? "",
    databaseOpsUrl: process.env.DATABASE_OPS_URL ?? "",
    databaseBackupReporterUrl:
      process.env.DATABASE_BACKUP_REPORTER_URL ?? "",
    requireCompleteMigrationLedger: requireCompleteSetting === "true",
  });
  console.info(
    JSON.stringify({
      event: "database.roles_bootstrapped",
      roles: [
        OWNER_ROLE,
        MIGRATOR_ROLE,
        APP_ROLE,
        WORKER_ROLE,
        OPS_ROLE,
        BACKUP_REPORTER_ROLE,
      ],
      checks,
    }),
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch(() => {
    console.error(
      JSON.stringify({
        event: "database.role_bootstrap_failed",
        code: "DATABASE_ROLE_BOOTSTRAP_FAILED",
      }),
    );
    process.exitCode = 1;
  });
}
