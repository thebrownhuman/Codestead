import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAIL_WORKER_OUTBOX_COLUMNS,
  MAIL_WORKER_OUTBOX_INSERT_COLUMNS,
  MAIL_WORKER_OUTBOX_PRE_REPLAY_INSERT_COLUMNS,
  MAIL_WORKER_OUTBOX_UPDATE_COLUMNS,
  REVIEWED_APPLICATION_CONSTRAINTS,
  REVIEWED_APPLICATION_FUNCTIONS,
  REVIEWED_APPLICATION_TRIGGERS,
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES,
  REVIEWED_REPLAY_AUTHORITY_RELATIONAL_CONTRACT,
  mailReplayAuthorityPrivilegesSql,
} from "../../scripts/bootstrap-database-roles.mjs";
import {
  REVIEWED_MIGRATION_LEDGER,
} from "../../scripts/lib/reviewed-migration-ledger.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, "../..");
const read = (relativePath) =>
  readFileSync(path.join(repositoryRoot, relativePath), "utf8");
const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function migrationFunctionBody(source, signature) {
  const declaration = `CREATE FUNCTION ${signature}`;
  const declarationIndex = source.indexOf(declaration);
  assert.notEqual(
    declarationIndex,
    -1,
    `${signature} missing from migration`,
  );
  const delimiter = "AS $function$";
  const bodyStart = source.indexOf(delimiter, declarationIndex);
  assert.notEqual(bodyStart, -1, `${signature} body start missing`);
  const firstBodyByte = bodyStart + delimiter.length;
  const bodyEnd = source.indexOf("$function$", firstBodyByte);
  assert.notEqual(bodyEnd, -1, `${signature} body end missing`);
  return source.slice(firstBodyByte, bodyEnd);
}

function assertOrdered(source, markers, label) {
  let previous = -1;
  for (const marker of markers) {
    const current = source.indexOf(marker, previous + 1);
    assert.ok(
      current > previous,
      `${label}: ${JSON.stringify(marker)} must follow the prior marker`,
    );
    previous = current;
  }
}

const migration = read(
  "drizzle/0067_mail_outbox_durable_replay_authority.sql",
);
const backupAuthorityMigration0065 = read(
  "drizzle/0065_backup_status_mail_authority.sql",
);
const bootstrap = read("scripts/bootstrap-database-roles.mjs");
const verifier = read("scripts/verify-database-role-boundaries.mjs");
const integrationHarness = read(
  "infra/tests/mail-durable-replay-0067.impl.mjs",
);
const integrationEntrypoint = read(
  "infra/tests/mail-durable-replay-0067.integration.mjs",
);
const outboxRuntime = read("src/lib/notifications/outbox.ts");

const originalPayloadVectorBytes = readFileSync(
  path.join(
    repositoryRoot,
    "infra",
    "tests",
    "fixtures",
    "mail-original-payload-sha256-vectors.json",
  ),
);
const originalPayloadVectors = JSON.parse(
  originalPayloadVectorBytes.toString("utf8"),
);

const authorityColumns = [
  "idempotency_authority_version",
  "idempotency_authority_sha256",
  "idempotency_original_payload_sha256",
];

const routineContracts = new Map([
  [
    "public.claim_email_outbox_idempotency_authority()",
    {
      allowedRoles: [],
      bodySha256:
        "70e587220b716395c07d1efcabfb35aed45f9dccf23a0f2ed7e13791774b526c",
      definitionSha256:
        "4ddccd9ac5ee3bc0f217c13e146c2dd2ec313e4980c30de8a51deec3dc6088a4",
      language: "plpgsql",
      volatility: "v",
      argumentNames: [],
      argumentTypes: [],
      returnType: "trigger",
    },
  ],
  [
    "public.persist_email_outbox_idempotency_authority()",
    {
      allowedRoles: [],
      bodySha256:
        "43e5df19b455c36648574e1d7c33c10cb959fc3bddd83e6ed67035031f246cbd",
      definitionSha256:
        "4890f478c8d14811e7f6829a3a4977e0da3924c8e8c84b8ca89b64496ac40f53",
      language: "plpgsql",
      volatility: "v",
      argumentNames: [],
      argumentTypes: [],
      returnType: "trigger",
    },
  ],
  [
    "public.email_outbox_event_sha256(text,text,text)",
    {
      allowedRoles: [],
      bodySha256:
        "dbb1e105e567de47875c1bdd433b61cc78745fc0bc7953daa68b6f3f2bf83315",
      definitionSha256:
        "02d83d883c8f4c0b4fc22c460353834d27a67becdd96d81cee8b74609521f334",
      language: "sql",
      volatility: "i",
      argumentNames: ["input_template", "input_scope", "input_event_id"],
      argumentTypes: ["text", "text", "text"],
      returnType: "text",
    },
  ],
  [
    "public.email_outbox_idempotency_coverage_authority(uuid[])",
    {
      allowedRoles: ["learncoding_ops"],
      bodySha256:
        "7957a8c6e5b5e1a87ef22f59b02cda7600c2f902ef2b78700600387ee33e8509",
      definitionSha256:
        "6e7e07cb84083bef2bdf2dcf58578b7fb4e224494fe1a70ba33284bd76358da8",
      language: "plpgsql",
      volatility: "v",
      argumentNames: ["candidate_ids"],
      argumentTypes: ["uuid[]"],
      returnType: "boolean",
    },
  ],
  [
    "public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)",
    {
      allowedRoles: [],
      bodySha256:
        "6b7100af8bd25093520317e67d5a06b40848b192ca94eb4b6c63ef48adcf89a2",
      definitionSha256:
        "35691db9ef3153adf2e19ebae539341797f7b4fd2a27aec1db215b9533636ed8",
      language: "sql",
      volatility: "i",
      argumentNames: [
        "input_user_id",
        "input_to_email",
        "input_template",
        "input_template_version",
        "input_variables",
      ],
      argumentTypes: ["text", "text", "text", "text", "jsonb"],
      returnType: "text",
    },
  ],
  [
    "public.enforce_email_outbox_idempotency_append_only()",
    {
      allowedRoles: [],
      bodySha256:
        "164b71af1bca387a599b64246851b7ba3e66c8a9557a60581dec54eb4d757370",
      definitionSha256:
        "2ae733ebe79975ce70fa9427ccb92295ecf8acad75797e8541bbb15bd9318790",
      language: "plpgsql",
      volatility: "v",
      argumentNames: [],
      argumentTypes: [],
      returnType: "trigger",
    },
  ],
  [
    "public.enforce_email_outbox_idempotency_metadata_immutable()",
    {
      allowedRoles: [],
      bodySha256:
        "9e953537c1fc8f4cdceda981731aa20c9412dbd46cefdcc71e433de3eced76c3",
      definitionSha256:
        "a26ccda1f7f4d623c7ea2b1611ff9f5c424cee386f79a7a8ffbf2a58c51ce2e9",
      language: "plpgsql",
      volatility: "v",
      argumentNames: [],
      argumentTypes: [],
      returnType: "trigger",
    },
  ],
]);

test("0067 migration bytes and bootstrap column contracts are frozen", () => {
  assert.equal(
    sha256(migration),
    "ccb3e093847fb875ded41ec0c36d0ff8405c04d1546ba9dd21696e86a73a6817",
  );
  for (const column of authorityColumns) {
    assert.ok(MAIL_WORKER_OUTBOX_COLUMNS.includes(column));
  }
  assert.ok(
    MAIL_WORKER_OUTBOX_INSERT_COLUMNS.includes(
      "idempotency_authority_version",
    ),
  );
  assert.ok(
    !MAIL_WORKER_OUTBOX_INSERT_COLUMNS.includes(
      "idempotency_authority_sha256",
    ),
  );
  assert.ok(
    !MAIL_WORKER_OUTBOX_INSERT_COLUMNS.includes(
      "idempotency_original_payload_sha256",
    ),
  );
  for (const column of authorityColumns) {
    assert.ok(!MAIL_WORKER_OUTBOX_UPDATE_COLUMNS.includes(column));
    assert.ok(!MAIL_WORKER_OUTBOX_PRE_REPLAY_INSERT_COLUMNS.includes(column));
  }
  assert.match(
    bootstrap,
    /idempotency_authority_column_count\s+not\s+in\s+\(0,\s*3\)/u,
  );
  assert.match(bootstrap, /requiresReplayAuthority/u);
  assert.match(verifier, /requiresReplayAuthority/u);
});

test("0067 resists hostile temporary built-in types and search paths", () => {
  assertOrdered(
    migration,
    [
      "IN SHARE MODE NOWAIT;--> statement-breakpoint",
      "SET LOCAL search_path = pg_catalog, pg_temp;--> statement-breakpoint",
      "ALTER TABLE public.backup_status_mail_authority",
    ],
    "0067 migration search-path preamble",
  );
  assert.equal(
    [...migration.matchAll(
      /SET LOCAL search_path = pg_catalog, pg_temp;/gu,
    )].length,
    1,
  );

  const functionHeaders = [...migration.matchAll(
    /CREATE(?: OR REPLACE)? FUNCTION [\s\S]*?AS \$function\$/gu,
  )].map(([declaration]) => declaration);
  const definerHeaders = functionHeaders.filter((declaration) =>
    declaration.includes("SECURITY DEFINER"),
  );
  assert.equal(definerHeaders.length, 9);
  for (const declaration of definerHeaders) {
    assert.match(
      declaration,
      /SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp\s+AS \$function\$/u,
    );
    assert.doesNotMatch(
      declaration,
      /(?<!pg_catalog[.])\b(?:text|uuid|jsonb|boolean|integer|record|trigger|oid)\b/u,
      "persistent routine signatures must not resolve built-ins through a hostile pg_temp",
    );
  }

  for (const contract of [
    '"p_run_key" pg_catalog.text',
    '"authority_id" pg_catalog.uuid',
    "input_variables pg_catalog.jsonb",
    "RETURNS pg_catalog.trigger",
    "candidate_ids pg_catalog.uuid[]",
    "routine_oid pg_catalog.oid",
    "function_contract pg_catalog.record",
    "ARRAY[]::pg_catalog.text[]",
  ]) {
    assert.ok(
      migration.includes(contract),
      `${contract} must be schema-qualified`,
    );
  }

  const executableMigration = migration
    .replace(/--[^\n]*/gu, "")
    .replace(/'(?:''|[^'])*'/gu, "''");
  for (const unqualifiedType of [
    /::\s*(?!pg_catalog[.])(?:text|uuid|jsonb|boolean|bool|integer|int2|int4|int8|oid|record|trigger|interval|regclass|regtype)\b/u,
    /\bRETURNS\s+(?!pg_catalog[.])(?:text|uuid|jsonb|boolean|bool|integer|int2|int4|int8|oid|record|trigger|interval|regclass|regtype)\b/u,
    /^\s*"?[a-z_][a-z0-9_]*"?(?:\s+CONSTANT)?\s+(?!pg_catalog[.])(?:text|uuid|jsonb|boolean|bool|integer|int2|int4|int8|oid|record|trigger|interval|regclass|regtype)(?:\[\])?(?=\s*(?:[,;:=)]|PRIMARY\b|NOT\b|CHECK\b))/imu,
    /\binterval\s+'/iu,
  ]) {
    assert.doesNotMatch(
      executableMigration,
      unqualifiedType,
      `0067 contains an unqualified built-in type: ${unqualifiedType}`,
    );
  }

  const proofStart = integrationHarness.indexOf(
    "function proveHostileTemporaryTypeSearchPath",
  );
  const proofEnd = integrationHarness.indexOf(
    "async function proveUnknownTemplateCutoverRollback",
    proofStart,
  );
  assert.ok(proofStart >= 0 && proofEnd > proofStart);
  const proof = integrationHarness.slice(proofStart, proofEnd);
  for (const contract of [
    /CREATE DOMAIN pg_temp[.]"text" AS pg_catalog[.]int4/u,
    /CREATE DOMAIN pg_temp[.]"uuid" AS pg_catalog[.]int4/u,
    /CREATE TYPE pg_temp[.]"trigger" AS/u,
    /CREATE DOMAIN pg_temp[.]"regclass" AS pg_catalog[.]int4/u,
    /SET LOCAL search_path = pg_temp, public, pg_catalog/u,
    /[$][{]migration0067[}]/u,
    /routine[.]proallargtypes/u,
    /pg_catalog[.]pg_depend/u,
    /dependency[.]refclassid/u,
    /pg_catalog[.]pg_my_temp_schema[(][)]/u,
    /dropDisposableDatabase[(]port, database[)]/u,
    /hostile_temp_type_search_path:9:pass/u,
  ]) {
    assert.match(proof, contract);
  }
  assertOrdered(
    integrationHarness,
    [
      'phase: "0066"',
      'proveHostileTemporaryTypeSearchPath(port, "mail0067")',
      "await proveProductionMigrationFramework(",
    ],
    "hostile temporary type proof before ordinary 0067 migration",
  );
});

test("0067 adds canonical UUIDv4 backup identities without rewriting 0065", () => {
  const uuidV4 =
    "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
  const replacement = migration.match(
    /CREATE OR REPLACE FUNCTION "public"[.]"enqueue_backup_status_mail_authority"[\s\S]*?\$function\$;/u,
  );
  assert.notEqual(replacement, null);
  assert.match(
    replacement[0],
    /SECURITY DEFINER\s+SET search_path = pg_catalog, pg_temp/u,
  );
  assert.doesNotMatch(
    replacement[0],
    /SECURITY DEFINER\s+SET search_path = pg_catalog\s+AS/u,
  );
  assert.ok(migration.includes(
    "p_run_key !~ '^[0-9]{8}T[0-9]{6}Z$'",
  ));
  assert.ok(migration.includes(`p_run_key !~ '^${uuidV4}$'`));
  assert.ok(migration.includes(
    "NEW.idempotency_key ~ '^backup-status:v1:[0-9]{8}T[0-9]{6}Z$'",
  ));
  assert.ok(
    migration.replace(/\r\n?/gu, "\n").includes(
      `NEW.idempotency_key ~\n         '^backup-status:v1:${uuidV4}$'`,
    ),
  );
  assert.match(
    migration,
    /VALIDATE CONSTRAINT backup_status_mail_authority_run_key_uuid_v4_valid/u,
  );
  assert.match(
    backupAuthorityMigration0065,
    /CHECK \("run_key" ~ '\^\[0-9\]\{8\}T\[0-9\]\{6\}Z\$'\)/u,
  );
  assert.doesNotMatch(backupAuthorityMigration0065, /CREATE OR REPLACE FUNCTION/u);
  assert.match(integrationHarness, /BACKUP_UUID_COMPATIBILITY_RUN_KEY/u);
  assert.match(integrationHarness, /BACKUP_UUID_SECOND_RUN_KEY/u);
});

test("the shared writer targets exactly the worker-granted insert columns", () => {
  const statement = outboxRuntime.match(
    /INSERT INTO public[.]email_outbox\s*[(]([\s\S]*?)[)]\s*VALUES/u,
  );
  assert.ok(statement, "the central explicit outbox INSERT is missing");
  const targetColumns = statement[1]
    .split(",")
    .map((column) => column.trim());
  assert.deepEqual(targetColumns, MAIL_WORKER_OUTBOX_INSERT_COLUMNS);
  assert.equal(new Set(targetColumns).size, targetColumns.length);
  assert.doesNotMatch(outboxRuntime, /[.]insert[(]emailOutbox[)]/u);
  assert.match(
    outboxRuntime,
    /[$][{]JSON[.]stringify[(]row[.]variables[)][}]::pg_catalog[.]jsonb/u,
  );
  assert.match(
    outboxRuntime,
    /[$][{]row[.]idempotencyAuthorityVersion[}],[\s\S]*?'pending',[\s\S]*?pg_catalog[.]now[(][)]/u,
  );
  assert.match(
    outboxRuntime,
    /ON CONFLICT [(]idempotency_key[)] DO NOTHING/u,
  );
  assert.match(
    outboxRuntime,
    /await tx[.]execute[(]queuedEmailInsert[(]row[)][)]/u,
  );
  assert.match(
    outboxRuntime,
    /await db[.]execute[(]queuedEmailInsert[(]row[)][)]/u,
  );
});

test("the live harness proves the shared worker writer after final ACL reconciliation", () => {
  const functionStart = integrationHarness.indexOf(
    "async function proveWorkerRoleSharedWriter",
  );
  const functionEnd = integrationHarness.indexOf(
    "function createOwnedDatabase",
    functionStart,
  );
  assert.ok(functionStart >= 0, "live worker-writer proof is missing");
  assert.ok(functionEnd > functionStart);
  const proof = integrationHarness.slice(functionStart, functionEnd);

  assert.match(proof, /"learncoding_worker"/u);
  assert.match(
    proof,
    /operation_id,\s*user_id,\s*delivery_scope_key,\s*to_email,\s*template,\s*template_version,\s*variables,\s*idempotency_key,\s*idempotency_authority_version,\s*status,\s*next_attempt_at/u,
  );
  assert.match(proof, /ON CONFLICT [(]idempotency_key[)] DO NOTHING/u);
  assert.match(
    proof,
    /email_outbox_idempotency_authority[\s\S]*?original_payload_sha256/u,
  );
  assert.match(proof, /code:\s*"23505"/u);
  assert.match(
    proof,
    /constraint:\s*"email_outbox_idempotency_authority_pkey"/u,
  );
  assert.match(proof, /code:\s*"42501"/u);
  assert.match(proof, /idempotency_authority_sha256/u);

  const finalBootstrap = integrationHarness.indexOf(
    "await proveBootstrapReconciliation(port, \"mail0067\")",
  );
  const liveProof = integrationHarness.indexOf(
    "await proveWorkerRoleSharedWriter(port, \"mail0067\")",
  );
  assert.ok(finalBootstrap >= 0);
  assert.ok(
    liveProof > finalBootstrap,
    "the worker-role proof must run after final 0067 privilege reconciliation",
  );
});

test("0067 original-payload reviewed body hash follows the migration bytes", () => {
  const signature =
    "public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)";
  const expected = routineContracts.get(signature);
  assert.ok(expected, `${signature} missing from role contract`);
  const body = migrationFunctionBody(
    migration,
    "public.email_outbox_original_payload_sha256(",
  );

  assert.equal(
    sha256(body),
    expected.bodySha256,
    "reviewed body hash must be regenerated from the exact migration body",
  );
});

test("the catalog reporter uses the production verifier normalization", () => {
  const reporterStart = integrationHarness.indexOf(
    "function reportReplayAuthorityConstraintCatalog",
  );
  const reporterEnd = integrationHarness.indexOf(
    "async function proveBootstrapReconciliation",
    reporterStart,
  );
  assert.ok(reporterStart >= 0 && reporterEnd > reporterStart);
  const reporter = integrationHarness.slice(reporterStart, reporterEnd);

  assertOrdered(
    reporter,
    [
      "SET search_path = pg_catalog, pg_temp;",
      "WITH reviewed AS (",
      "pg_catalog.pg_get_expr(",
    ],
    "trusted constraint catalog deparse",
  );
  for (const contract of [
    /pg_catalog[.]pg_get_expr[(]/u,
    /pg_catalog[.]regexp_replace[(]/u,
    /pg_catalog[.]sha256[(]/u,
    /normalized_expression_sha256/u,
  ]) {
    assert.match(reporter, contract);
  }
  assert.ok(
    reporter.includes(`'"?' || relation.relname || '"?[.]'`),
  );
  assert.ok(reporter.includes(`'[[:space:]"]'`));
  assert.doesNotMatch(
    reporter,
    /canonicalizePostgresStatement[(]reviewed[.]expression[)]/u,
  );
  assert.match(
    verifier,
    /pg_catalog[.]regexp_replace[(][\s\S]*?pg_catalog[.]pg_get_expr[(]/u,
  );
});

test("0067 exact routines are frozen with owner, body, definition, and ACL", () => {
  for (const [signature, expected] of routineContracts) {
    const routine = REVIEWED_APPLICATION_FUNCTIONS.find(
      (candidate) => candidate.signature === signature,
    );
    assert.ok(routine, `${signature} missing from reviewed manifest`);
    assert.deepEqual(
      {
        migrationFile: routine.migrationFile,
        owner: routine.owner,
        securityDefiner: routine.securityDefiner,
        configuration: routine.configuration,
        allowedRoles: routine.allowedRoles,
        bodySha256: routine.bodySha256,
        definitionSha256: routine.definitionSha256,
        language: routine.language,
        volatility: routine.volatility,
        argumentNames: routine.argumentNames,
        argumentTypes: routine.argumentTypes,
        returnType: routine.returnType,
      },
      {
        migrationFile: "0067_mail_outbox_durable_replay_authority.sql",
        owner: "learncoding_owner",
        securityDefiner: true,
        configuration: ["search_path=pg_catalog, pg_temp"],
        ...expected,
      },
    );
  }
});

test("0067 trigger and constraint manifests freeze the live PG18 catalog", () => {
  const expectedTriggers = [
    {
      relation: "public.email_outbox_idempotency_authority",
      name: "email_outbox_idempotency_append_only",
      functionSignature:
        "public.enforce_email_outbox_idempotency_append_only()",
      enabled: "A",
      type: 27,
      predicate: null,
      arguments: [],
      watchedColumns: [],
    },
    {
      relation: "public.email_outbox",
      name: "email_outbox_idempotency_claim",
      functionSignature:
        "public.claim_email_outbox_idempotency_authority()",
      enabled: "A",
      type: 7,
      predicate: null,
      arguments: [],
      watchedColumns: [],
    },
    {
      relation: "public.email_outbox",
      name: "00_email_outbox_idempotency_persist",
      functionSignature:
        "public.persist_email_outbox_idempotency_authority()",
      enabled: "A",
      type: 5,
      predicate: null,
      arguments: [],
      watchedColumns: [],
    },
    {
      relation: "public.email_outbox",
      name: "email_outbox_idempotency_metadata_immutable",
      functionSignature:
        "public.enforce_email_outbox_idempotency_metadata_immutable()",
      enabled: "A",
      type: 19,
      predicate: null,
      arguments: [],
      watchedColumns: [
        "idempotency_key",
        "idempotency_authority_version",
        "idempotency_authority_sha256",
        "idempotency_original_payload_sha256",
      ],
    },
    {
      relation: "public.email_outbox_idempotency_authority",
      name: "email_outbox_idempotency_no_truncate",
      functionSignature:
        "public.enforce_email_outbox_idempotency_append_only()",
      enabled: "A",
      type: 34,
      predicate: null,
      arguments: [],
      watchedColumns: [],
    },
  ];
  for (const expected of expectedTriggers) {
    const trigger = REVIEWED_APPLICATION_TRIGGERS.find(
      ({ name }) => name === expected.name,
    );
    assert.deepEqual(trigger ?? null, expected);
  }

  const constraint = REVIEWED_APPLICATION_CONSTRAINTS.find(
    ({ name }) => name === "email_outbox_idempotency_authority_valid",
  );
  assert.deepEqual(
    constraint
      ? {
          relation: constraint.relation,
          relationOwner: constraint.relationOwner,
          type: constraint.type,
          validated: constraint.validated,
          normalizedExpressionSha256:
            constraint.normalizedExpressionSha256,
          columns: constraint.columns,
        }
      : null,
    {
      relation: "public.email_outbox",
      relationOwner: "learncoding_owner",
      type: "c",
      validated: true,
      normalizedExpressionSha256:
        "3f32ee19567df8889a129cc1e2e95af9f70a8e4e5878c7f7930ec396259ceefc",
      columns: [
        "idempotency_authority_sha256",
        "idempotency_authority_version",
        "idempotency_key",
        "idempotency_original_payload_sha256",
      ],
    },
  );
  const {
    triggers: replayTriggers,
    routines: replayRoutines,
    ...replayRelationalContract
  } = REVIEWED_REPLAY_AUTHORITY_RELATIONAL_CONTRACT;
  assert.deepEqual(replayRelationalContract, {
    authority: {
      relation: "public.email_outbox_idempotency_authority",
      owner: "learncoding_owner",
      columns: [
        { name: "idempotency_sha256", type: "pg_catalog.text", notNull: true },
        {
          name: "original_payload_sha256",
          type: "pg_catalog.text",
          notNull: true,
        },
      ],
      primaryKey: {
        name: "email_outbox_idempotency_authority_pkey",
        type: "p",
        validated: true,
        deferrable: false,
        initiallyDeferred: false,
        noInherit: true,
        columns: ["idempotency_sha256"],
        index: {
          unique: true,
          valid: true,
          ready: true,
          live: true,
          immediate: true,
          partial: false,
          expression: false,
        },
      },
      checks: [
        {
          name: "email_outbox_idempotency_authority_digest_valid",
          type: "c",
          validated: true,
          noInherit: false,
          columns: ["idempotency_sha256"],
          reviewedSqlExpressionSha256:
            "e49d21d5f96c0af1e2ddc33bb5c90d5649e9e8354ee8cf1e245fa0fe612ba7cf",
          normalizedExpressionSha256:
            "8e6471c0b1bf0fd09c9f9f37b6735e345030506017e78de7c2deba7f79bd6f6d",
        },
        {
          name: "email_outbox_idempotency_authority_payload_valid",
          type: "c",
          validated: true,
          noInherit: false,
          columns: ["original_payload_sha256"],
          reviewedSqlExpressionSha256:
            "28dc27e34f97a28cf404f373f75632bbb7a6541476dd1f59efe000b2c066b69b",
          normalizedExpressionSha256:
            "aca0ad0a3d605439d115ce9283ef22b98a28c71e85f4e7e89de406e90dee11e6",
        },
      ],
    },
    deliveryScope: {
      relation: "public.email_outbox",
      name: "email_outbox_delivery_scope_valid",
      type: "c",
      validated: true,
      noInherit: false,
      columns: [
        "delivery_scope_key",
        "operation_id",
        "status",
        "template",
        "template_version",
        "to_email",
        "user_id",
        "variables",
      ],
      reviewedSqlExpressionSha256:
        "20f31d55accb3d3e96816fd4f13cf8670eef2fd3746c414329c6f5ad9d12b3c7",
      normalizedExpressionSha256:
        "c904768e4ecc145fc108de90adf0d0b5373f3330fb706ec34ff4b07d2711b94f",
    },
    triggerRelations: [
      "public.email_outbox",
      "public.email_outbox_idempotency_authority",
    ],
    lookupIndex: {
      relation: "public.email_outbox",
      name: "email_outbox_idempotency_authority_lookup_idx",
      accessMethod: "btree",
      columns: ["idempotency_authority_sha256", "id"],
      unique: false,
      valid: true,
      ready: true,
      live: true,
      immediate: true,
      partial: true,
      expression: false,
      normalizedPredicate: "idempotency_authority_sha256isnotnull",
    },
    unique: {
      relation: "public.email_outbox_idempotency_authority",
      name: "email_outbox_idempotency_authority_payload_unique",
      type: "u",
      validated: true,
      deferrable: false,
      initiallyDeferred: false,
      noInherit: true,
      columns: ["idempotency_sha256", "original_payload_sha256"],
      index: {
        unique: true,
        valid: true,
        ready: true,
        partial: false,
        expression: false,
      },
    },
    foreignKey: {
      relation: "public.email_outbox",
      name: "email_outbox_idempotency_authority_fk",
      persistTriggerName: "00_email_outbox_idempotency_persist",
      type: "f",
      validated: true,
      columns: [
        "idempotency_authority_sha256",
        "idempotency_original_payload_sha256",
      ],
      referencedRelation: "public.email_outbox_idempotency_authority",
      referencedColumns: [
        "idempotency_sha256",
        "original_payload_sha256",
      ],
      deferrable: true,
      initiallyDeferred: true,
      noInherit: true,
      matchType: "s",
      updateAction: "r",
      deleteAction: "r",
    },
  });
  assert.deepEqual(
    replayTriggers.map(({ name }) => name),
    [
      "email_outbox_payload_immutable",
      "email_outbox_dispatch_binding_guard",
      "email_outbox_provider_correlation_evidence_guard",
      "email_outbox_idempotency_claim",
      "00_email_outbox_idempotency_persist",
      "email_outbox_idempotency_metadata_immutable",
      "email_outbox_idempotency_append_only",
      "email_outbox_idempotency_no_truncate",
    ],
  );
  assert.match(
    verifier,
    /outbox_authority_trigger_order_exact/u,
  );
  assert.match(
    verifier,
    /reviewed_fk_trigger\.tgconstraint\s*=\s*reviewed_foreign_key\.oid/u,
  );
  assert.match(
    verifier,
    /pg_catalog\.convert_to\(\s*reviewed_persist_trigger\.tgname::text,\s*'UTF8'\s*\)/u,
  );
  assert.deepEqual(
    replayRoutines.map(({ signature }) => signature),
    [
      "public.email_outbox_original_payload_sha256(text,text,text,text,jsonb)",
      "public.email_outbox_event_sha256(text,text,text)",
      "public.claim_email_outbox_idempotency_authority()",
      "public.persist_email_outbox_idempotency_authority()",
      "public.enforce_email_outbox_idempotency_metadata_immutable()",
      "public.enforce_email_outbox_idempotency_append_only()",
      "public.email_outbox_idempotency_coverage_authority(uuid[])",
    ],
  );
  assert.match(
    verifier,
    /select\s+pg_catalog[.]count[(][*][)]\s*=\s*2\s*[+]\s*pg_catalog[.]jsonb_array_length[(][$]58::jsonb[)][\s\S]*?from\s+pg_catalog[.]pg_constraint\s+authority_constraint[\s\S]*?where\s+authority_constraint[.]conrelid[\s\S]*?and\s+authority_constraint[.]contype\s*<>\s*'n'/u,
    "PG18 derived NOT NULL catalog rows must not change the reviewed "
      + "PK/UNIQUE/CHECK constraint cardinality",
  );
  assert.ok(
    verifier.includes("attribute.attnotnull = ($43::boolean[])["),
    "NOT NULL authority remains verified through exact column metadata",
  );
});

test("0067 phase and replay authority reconciliation are exact and contiguous", () => {
  assert.deepEqual(
    REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.map(({ index }) => index),
    [62, 63, 64, 65, 66, 67],
  );
  assert.equal(
    REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.at(-2)?.createdAt,
    "1784997273087",
  );
  const phase = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.at(-1);
  assert.deepEqual(
    phase
      ? {
          index: phase.index,
          createdAt: phase.createdAt,
          migrationFile: phase.migrationFile,
          migrationSha256: phase.migrationSha256,
          requiresWorkerContract: phase.requiresWorkerContract,
          requiresProviderEvidence: phase.requiresProviderEvidence,
          requiresReplayAuthority: phase.requiresReplayAuthority,
        }
      : null,
    {
      index: 67,
      createdAt: "1785002172253",
      migrationFile: "0067_mail_outbox_durable_replay_authority.sql",
      migrationSha256:
        "ccb3e093847fb875ded41ec0c36d0ff8405c04d1546ba9dd21696e86a73a6817",
      requiresWorkerContract: true,
      requiresProviderEvidence: true,
      requiresReplayAuthority: true,
    },
  );
  assert.equal(phase?.routines, REVIEWED_APPLICATION_FUNCTIONS);
  assert.equal(phase?.triggers, REVIEWED_APPLICATION_TRIGGERS);

  const sql = mailReplayAuthorityPrivilegesSql();
  assert.match(
    sql,
    /revoke all on table public\.email_outbox_idempotency_authority/iu,
  );
  assert.match(
    sql,
    /grant all on table public\.email_outbox_idempotency_authority to learncoding_owner/iu,
  );
  assert.doesNotMatch(
    sql,
    /grant\s+(?:select|insert|update|delete|truncate)[\s\S]*?to\s+(?:learncoding_app|learncoding_worker|learncoding_ops)/iu,
  );
});
test("0067 live proof covers immediate constraint timing and same-statement conflicts", () => {
  const start = integrationHarness.indexOf(
    "async function proveSameStatementAuthority",
  );
  const end = integrationHarness.indexOf(
    "function proveNewReplayAndRollback",
    start,
  );
  assert.notEqual(start, -1, "same-statement live proof is missing");
  assert.notEqual(end, -1, "same-statement live proof boundary is missing");
  const proof = integrationHarness.slice(start, end);

  assert.match(proof, /constraint-immediate-novel/u);
  assert.match(
    proof,
    /BEGIN;\s*SET CONSTRAINTS email_outbox_idempotency_authority_fk IMMEDIATE;[\s\S]*?RETURNING id;\s*COMMIT;/u,
  );
  assert.match(proof, /same-statement-exact/u);
  assert.match(proof, /same-statement-divergent/u);
  assert.match(
    proof,
    /code:\s*"23505"[\s\S]*?constraint:\s*"email_outbox_idempotency_authority_pkey"/u,
  );

  assert.match(
    migration,
    /ADD CONSTRAINT email_outbox_idempotency_authority_fk[\s\S]*?FOREIGN KEY[\s\S]*?DEFERRABLE INITIALLY DEFERRED[\s\S]*?VALIDATE CONSTRAINT email_outbox_idempotency_authority_fk/u,
  );
  assert.doesNotMatch(
    migration,
    /DROP CONSTRAINT(?: IF EXISTS)? email_outbox_idempotency_authority_fk/u,
  );
});
test("0067 native harness is isolated, bounded, checksummed, and digest-pinned", () => {
  assert.match(integrationHarness, /function isolatedClientConfig\(/u);
  assert.doesNotMatch(integrationHarness, /new Client\(\{/u);
  for (const contract of [
    /password:\s*""/u,
    /ssl:\s*false/u,
    /options:\s*""/u,
    /connectionTimeoutMillis:\s*5_000/u,
    /query_timeout:\s*30_000/u,
    /statement_timeout:\s*25_000/u,
    /idle_in_transaction_session_timeout:\s*25_000/u,
    /PGCONNECT_TIMEOUT:\s*"5"/u,
    /PGOPTIONS:\s*"-c statement_timeout=25000 -c idle_in_transaction_session_timeout=25000"/u,
    /--data-checksums/u,
    /data_checksums'\);",\s*\),\s*"on"/u,
    /assertCandidateDigestMatchesReviewedLedger/u,
    /verifyExactClusterCleanup/u,
    /readTemporaryPostgresLog/u,
    /terminateAndVerify/u,
  ]) {
    assert.match(integrationHarness, contract);
  }
  assert.doesNotMatch(integrationHarness, /\.\.\.process\.env/u);
  assert.equal(
    sha256(migration),
    REVIEWED_MIGRATION_LEDGER[67]?.sqlSha256,
    "the 0067 candidate bytes must equal reviewed ledger entry 67",
  );
});

test("H1 isolates every libpq control and bounds asynchronous setup", () => {
  for (const environmentKey of [
    "PGGSSENCMODE",
    "PGGSSLIB",
    "PGKRBSRVNAME",
    "PGLOADBALANCEHOSTS",
    "PGLOCALEDIR",
    "PGREALM",
    "PGREQUIREAUTH",
    "PGSSLCRLDIR",
    "PGSSLNEGOTIATION",
    "PGSYSCONFDIR",
  ]) {
    assert.match(
      integrationHarness,
      new RegExp(`\"${environmentKey}\"`, "u"),
      `${environmentKey} must not leak into the disposable harness`,
    );
  }
  assert.match(
    integrationHarness,
    /await settleWithin\(\s*allocateDisposableLoopbackPort\(\),\s*"allocate disposable loopback port",\s*SETUP_TIMEOUT_MS,\s*\)/u,
  );
  assert.match(
    integrationHarness,
    /const SETUP_TIMEOUT_MS = 5_000;/u,
  );
});

test("H1 explicitly bounds every production migration invocation", () => {
  const invocations = [
    ...integrationHarness.matchAll(
      /runProductionMigration\(\{([\s\S]*?)\n\s*\}\);/gu,
    ),
  ];
  assert.equal(
    invocations.length,
    4,
    "the harness production-migration invocation inventory changed",
  );
  for (const [, options] of invocations) {
    assert.match(
      options,
      /operationTimeoutMs:\s*OPERATION_TIMEOUT_MS/u,
      "every production migration invocation must receive the shared operation deadline",
    );
  }
});

test("H1 polling consumes one monotonic remaining-time budget", () => {
  for (const contract of [
    /const OPERATION_TIMEOUT_MS = 55_000;/u,
    /const CLEANUP_TIMEOUT_MS = 5_000;/u,
    /const POLL_INTERVAL_MS = 25;/u,
    /function createOperationDeadline\(/u,
    /function remainingDeadlineMs\(/u,
    /performance[.]now/u,
    /function scalar\(\s*port,\s*database,\s*sql,\s*username = "postgres",\s*timeoutMs,/u,
    /timeoutMs,/u,
  ]) {
    assert.match(integrationHarness, contract);
  }

  for (const [startMarker, endMarker, label] of [
    [
      "async function waitForMarker",
      "async function waitForAdvisoryLockWaiter",
      "marker polling",
    ],
    [
      "async function waitForAdvisoryLockWaiter",
      "async function waitForCutoverTopology",
      "advisory-lock polling",
    ],
    [
      "async function waitForCutoverTopology",
      "async function waitForCutoverAdvisoryLockTopology",
      "topology polling",
    ],
  ]) {
    const start = integrationHarness.indexOf(startMarker);
    const end = integrationHarness.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `${label} slice is missing`);
    const polling = integrationHarness.slice(start, end);
    assert.match(
      polling,
      /deadline = createOperationDeadline\(OPERATION_TIMEOUT_MS\)/u,
      `${label} must accept one operation deadline`,
    );
    assert.match(
      polling,
      /remainingDeadlineMs\(\s*deadline/u,
      `${label} must compute its remaining budget`,
    );
    assert.match(
      polling,
      /Math[.]min\(\s*POLL_INTERVAL_MS,\s*remainingMs,\s*\)/u,
      `${label} sleep/probe must be capped to the remaining budget`,
    );
    assert.doesNotMatch(
      polling,
      /attempt < 240/u,
      `${label} must not use an attempt-count pseudo-deadline`,
    );
  }

  const topologyStart = integrationHarness.indexOf(
    "async function waitForCutoverTopology",
  );
  const topologyEnd = integrationHarness.indexOf(
    "async function waitForCutoverAdvisoryLockTopology",
    topologyStart,
  );
  const topology = integrationHarness.slice(topologyStart, topologyEnd);
  assert.match(
    topology,
    /Math[.]min\(\s*SETUP_TIMEOUT_MS,\s*remainingMs,\s*\)/u,
    "a probe may not outlive the aggregate polling deadline",
  );
});

test("H1 timeout races abort real work and observe its late outcome", () => {
  const settleStart = integrationHarness.indexOf(
    "async function settleWithin",
  );
  const settleEnd = integrationHarness.indexOf(
    "function observePromiseOutcome",
    settleStart,
  );
  assert.ok(settleStart >= 0 && settleEnd > settleStart);
  const settle = integrationHarness.slice(settleStart, settleEnd);
  for (const contract of [
    /abort/u,
    /const observed = observePromiseOutcome\(promise\)/u,
    /const abortObserved = observePromiseOutcome\(/u,
    /CLEANUP_TIMEOUT_MS/u,
    /const cleanupDeadline/u,
    /await waitForObservedOutcome\(/u,
  ]) {
    assert.match(settle, contract);
  }
  assert.doesNotMatch(settle, /Promise[.]race\(\[promise,\s*timeout\]\)/u);

  for (const helperName of ["connectClientWithin", "closeClientWithin"]) {
    const start = integrationHarness.indexOf(`async function ${helperName}`);
    const end = integrationHarness.indexOf("\n}", start) + 2;
    const helper = integrationHarness.slice(start, end);
    assert.match(helper, /abort:\s*async \(\) =>/u);
    assert.match(helper, /client[.]connection[?][.]stream[?][.]destroy\(\)/u);
  }

  const childStart = integrationHarness.indexOf("function spawnPsql");
  const childEnd = integrationHarness.indexOf(
    "async function waitForMarker",
    childStart,
  );
  const child = integrationHarness.slice(childStart, childEnd);
  assert.match(child, /await terminateAndVerify\(/u);
  assert.match(child, /const completed = observePromiseOutcome/u);
});

test("H1 hard-bounds Pool and Client lifecycles", () => {
  for (const contract of [
    /const CLIENT_CONNECT_TIMEOUT_MS = 5_000;/u,
    /const CLIENT_CLOSE_TIMEOUT_MS = 5_000;/u,
    /function isolatedPoolConfig/u,
    /allowExitOnIdle:\s*true/u,
    /idleTimeoutMillis:\s*5_000/u,
    /async function connectClientWithin/u,
    /async function closeClientWithin/u,
    /await settleWithin\(\s*client\.connect\(\),/u,
    /await settleWithin\(\s*client\.end\(\),/u,
    /cleanupTimeoutMs:\s*CLIENT_CLOSE_TIMEOUT_MS/u,
  ]) {
    assert.match(integrationHarness, contract);
  }
  assert.doesNotMatch(
    integrationHarness,
    /new Pool\(\s*\{/u,
    "every Pool must use the isolated bounded configuration",
  );
  assert.doesNotMatch(
    integrationHarness,
    /await [A-Za-z][A-Za-z0-9_]*\.connect\(\);/u,
    "raw awaited Client connections must use bounded helpers",
  );
  const directlyAwaitedEnds = [
    ...integrationHarness.matchAll(
      /await [A-Za-z][A-Za-z0-9_]*\.end\(\);/gu,
    ),
  ].map(([statement]) => statement);
  assert.deepEqual(
    directlyAwaitedEnds,
    ["await pool.end();"],
    "only the registry-owned Pool close may be directly awaited",
  );
  const cleanupStart = integrationHarness.indexOf(
    "async function cleanupTrackedResources",
  );
  const cleanupEnd = integrationHarness.indexOf(
    "function assertTrackedResourceRegistryEmpty",
    cleanupStart,
  );
  assert.match(
    integrationHarness.slice(cleanupStart, cleanupEnd),
    /await runCleanupStep\([\s\S]*?await pool\.end\(\);/u,
    "the sole directly awaited Pool close must remain inside bounded registry cleanup",
  );
});

test("H1 hard-bounds asynchronous child output and termination", () => {
  for (const contract of [
    /const CHILD_TIMEOUT_MS = 30_000;/u,
    /const CHILD_TERMINATION_TIMEOUT_MS = 5_000;/u,
    /const CHILD_OUTPUT_MAX_BYTES = 8 \* 1024 \* 1024;/u,
    /maxBuffer:\s*CHILD_OUTPUT_MAX_BYTES/u,
    /timeout:\s*options\.timeoutMs \?\? CHILD_TIMEOUT_MS/u,
    /Buffer\.byteLength\(chunk,\s*"utf8"\)/u,
    /outputBytes \+ chunkBytes > CHILD_OUTPUT_MAX_BYTES/u,
    /child\.kill\(\)/u,
    /child\.kill\("SIGKILL"\)/u,
    /function destroyChildStdio/u,
    /outputOverflow/u,
    /new AggregateError/u,
    /CHILD_TERMINATION_TIMEOUT_MS/u,
    /CHILD_TIMEOUT_MS/u,
  ]) {
    assert.match(integrationHarness, contract);
  }
  assert.doesNotMatch(
    integrationHarness,
    /live PostgreSQL child exceeded 30 seconds/u,
    "child deadline messages must derive from the enforced bound",
  );
});

test("B3 central registry owns every PostgreSQL child, Client, and Pool", () => {
  for (const contract of [
    /const trackedPsqlChildren = new Set\(\);/u,
    /const trackedClients = new Set\(\);/u,
    /const trackedPools = new Set\(\);/u,
    /function createTrackedClient\(/u,
    /function createTrackedPool\(/u,
    /function registerTrackedPsqlChild\(/u,
    /function unregisterTrackedPsqlChild\(/u,
    /async function cleanupTrackedResources\(/u,
    /function assertTrackedResourceRegistryEmpty\(/u,
  ]) {
    assert.match(integrationHarness, contract);
  }

  assert.equal(
    (integrationHarness.match(/\bnew Client\(/gu) ?? []).length,
    1,
    "Client construction must exist only inside createTrackedClient",
  );
  assert.equal(
    (integrationHarness.match(/\bnew Pool\(/gu) ?? []).length,
    1,
    "Pool construction must exist only inside createTrackedPool",
  );
  assert.equal(
    (integrationHarness.match(/\bspawn\(/gu) ?? []).length,
    1,
    "raw child spawning must exist only inside spawnPsql",
  );

  const childStart = integrationHarness.indexOf("function spawnPsql");
  const childEnd = integrationHarness.indexOf(
    "function createOperationDeadline",
    childStart,
  );
  assert.ok(childStart >= 0 && childEnd > childStart);
  const child = integrationHarness.slice(childStart, childEnd);
  assertOrdered(
    child,
    [
      "const child = spawn(",
      "registerTrackedPsqlChild(child)",
      "const completed = observePromiseOutcome",
      "unregisterTrackedPsqlChild(child)",
    ],
    "tracked psql child lifecycle",
  );
  assert.match(
    child,
    /completed[.]then\([\s\S]*?unregisterTrackedPsqlChild\(child\)/u,
    "the child stays registered until its observed close settles",
  );
});

test("B3 top-level cleanup drains one shared registry deadline before cluster stop", () => {
  const cleanupStart = integrationHarness.indexOf(
    "async function cleanupTrackedResources",
  );
  const cleanupEnd = integrationHarness.indexOf(
    "function assertTrackedResourceRegistryEmpty",
    cleanupStart,
  );
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart);
  const cleanup = integrationHarness.slice(cleanupStart, cleanupEnd);
  for (const contract of [
    /remainingDeadlineMs\(cleanupDeadline/u,
    /await runCleanupStep/u,
    /trackedPsqlChildren/u,
    /trackedClients/u,
    /trackedPools/u,
    /[.]terminate\(\)/u,
    /closeClientWithin/u,
    /[.]end\(\)/u,
  ]) {
    assert.match(cleanup, contract);
  }
  assert.doesNotMatch(cleanup, /Promise[.]allSettled/u);

  const mainStart = integrationHarness.indexOf(
    "export async function main()",
  );
  const main = integrationHarness.slice(mainStart);
  assertOrdered(
    main,
    [
      "} finally {",
      "const cleanupDeadline = createOperationDeadline(CLEANUP_TIMEOUT_MS)",
      "await cleanupTrackedResources",
      "assertTrackedResourceRegistryEmpty",
      'executable("pg_ctl")',
    ],
    "top-level registry cleanup",
  );
});

test("H1 observes asynchronous outcomes and preserves every cleanup failure", () => {
  assert.match(integrationHarness, /function observePromiseOutcome\(/u);
  assert.match(integrationHarness, /async function runCleanupStep\(/u);
  assert.doesNotMatch(
    integrationHarness,
    /[.]catch\(\(\) => undefined\)/u,
  );
  assert.doesNotMatch(integrationHarness, /Promise[.]allSettled/u);

  for (const [startMarker, endMarker, label] of [
    [
      "async function proveCutoverLockGate",
      "async function proveSourceFirstCutoverTopology",
      "cutover lock gate",
    ],
    [
      "async function proveSourceFirstCutoverTopology",
      "async function proveCutoverNowaitAndAtomicRetry",
      "source-first topology",
    ],
    [
      "const coverageSnapshotController",
      "  ownerSql(",
      "coverage snapshot",
    ],
  ]) {
    const start = integrationHarness.indexOf(startMarker);
    const end = integrationHarness.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `${label} slice is missing`);
    const proof = integrationHarness.slice(start, end);
    for (const contract of [
      /let operationError/u,
      /const cleanupFailures = \[\]/u,
      /observePromiseOutcome/u,
      /await runCleanupStep/u,
      /throw preserveOperationAndCleanupFailures\(/u,
    ]) {
      assert.match(proof, contract, `${label}: ${contract}`);
    }
    assertOrdered(
      proof,
      [
        "try {",
        "observePromiseOutcome",
        "} catch (error) {",
        "operationError = error",
        "} finally {",
        "await runCleanupStep",
        "throw preserveOperationAndCleanupFailures",
      ],
      label,
    );
  }
});

test("H1 query helpers keep the query/assertion primary when close also fails", () => {
  for (const [startMarker, endMarker, label] of [
    [
      "async function queryDatabase",
      "async function expectDatabaseError",
      "queryDatabase",
    ],
    [
      "async function expectDatabaseError",
      "function ownerSql",
      "expectDatabaseError",
    ],
  ]) {
    const start = integrationHarness.indexOf(startMarker);
    const end = integrationHarness.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `${label} slice is missing`);
    const helper = integrationHarness.slice(start, end);
    assert.match(helper, /let operationError/u);
    assert.match(helper, /const cleanupFailures = \[\]/u);
    assert.match(helper, /operationError = error/u);
    assert.match(helper, /await runCleanupStep/u);
    assert.match(
      helper,
      /throw preserveOperationAndCleanupFailures\(/u,
    );
  }

  const preserveStart = integrationHarness.indexOf(
    "function preserveOperationAndCleanupFailures",
  );
  const preserveEnd = integrationHarness.indexOf(
    "function readExactPostmasterPid",
    preserveStart,
  );
  assert.ok(preserveStart >= 0 && preserveEnd > preserveStart);
  const preserveSource = integrationHarness.slice(
    preserveStart,
    preserveEnd,
  );
  const preserve = Function(
    `"use strict"; ${preserveSource}; return preserveOperationAndCleanupFailures;`,
  )();
  const primary = new Error("primary-query-failure");
  const cleanup = new Error("secondary-close-failure");
  const combined = preserve(primary, [cleanup], "query and close failed");
  assert.ok(combined instanceof AggregateError);
  assert.equal(combined.cause, primary);
  assert.deepEqual(combined.errors, [primary, cleanup]);
});

test("H2 proves the real cutover relation-lock wait topology", () => {
  for (const contract of [
    /const CUTOVER_TOPOLOGY_MIGRATION_GATE/u,
    /const WAIT_TOPOLOGY_TIMEOUT_MS = 5_000;/u,
    /function migration0067WithOutboxGate/u,
    /async function waitForCutoverAdvisoryLockTopology/u,
    /async function waitForCutoverRelationLockTopology/u,
    /pg_catalog\.pg_blocking_pids\(producer\.pid\)/u,
    /waiting_outbox\.mode = 'RowExclusiveLock'/u,
    /waiting_outbox\.granted IS FALSE/u,
    /blocking_outbox\.mode = 'AccessExclusiveLock'/u,
    /blocking_outbox\.granted IS TRUE/u,
    /source_lock\.mode = 'RowExclusiveLock'/u,
    /source_lock\.granted IS TRUE/u,
    /assert\.deepEqual\(\s*topology\.blocker_pids\.map\(Number\),\s*\[Number\(topology\.migration_pid\)\]/u,
  ]) {
    assert.match(integrationHarness, contract);
  }

  const topologyProof = integrationHarness.slice(
    integrationHarness.indexOf("async function proveSourceFirstCutoverTopology"),
    integrationHarness.indexOf(
      "async function proveCutoverNowaitAndAtomicRetry",
    ),
  );
  const controllerGateAcquisitions = [
    ...topologyProof.matchAll(
      /await controller[.]query[(]\s*`SELECT pg_catalog[.]pg_advisory_lock[(]\s*[$][{](?:CUTOVER_TOPOLOGY_PRODUCER_GATE|CUTOVER_TOPOLOGY_MIGRATION_GATE)[}]/gu,
    ),
  ];
  assert.equal(
    controllerGateAcquisitions.length,
    2,
    "the controller must acquire exactly the producer and migration gates",
  );
  const advisoryTopologyWaits = [
    ...topologyProof.matchAll(
      /await waitForCutoverAdvisoryLockTopology[(]/gu,
    ),
  ];
  assert.equal(
    advisoryTopologyWaits.length,
    2,
    "both controller-gated waiters require exact advisory topology proof",
  );
  assert.match(
    topologyProof,
    /gateKey:\s*CUTOVER_TOPOLOGY_PRODUCER_GATE[\s\S]*?waiterApplicationName:\s*producerApplication/u,
  );
  assert.match(
    topologyProof,
    /gateKey:\s*CUTOVER_TOPOLOGY_MIGRATION_GATE[\s\S]*?waiterApplicationName:\s*migrationApplication/u,
  );
  assertOrdered(
    topologyProof,
    [
      "${CUTOVER_TOPOLOGY_PRODUCER_GATE}",
      "${CUTOVER_TOPOLOGY_MIGRATION_GATE}",
      "waitForCutoverAdvisoryLockTopology",
    ],
    "H2 controller-gate acquisition ordering",
  );
  const releaseProducer = topologyProof.indexOf(
    "CUTOVER_TOPOLOGY_PRODUCER_GATE",
    topologyProof.indexOf("releaseControllerGate"),
  );
  const observeRelation = topologyProof.indexOf(
    "waitForCutoverRelationLockTopology",
  );
  const releaseMigration = topologyProof.indexOf(
    "CUTOVER_TOPOLOGY_MIGRATION_GATE",
    topologyProof.indexOf("releaseControllerGate", observeRelation),
  );
  const assertLockUnavailable = topologyProof.indexOf(
    'assert.equal(migrationOutcome.error?.code, "55P03")',
  );
  assert.ok(releaseProducer >= 0);
  assert.ok(observeRelation > releaseProducer);
  assert.ok(releaseMigration > observeRelation);
  assert.ok(assertLockUnavailable > releaseMigration);
  assert.match(topologyProof, /assert\.notEqual\(\s*migrationOutcome\.error\?\.code,\s*"40P01"/u);
});

test("H3 proves live coverage timeout clamp and caller-setting restoration", () => {
  for (const contract of [
    /async function proveCoverageTimeoutSemantics/u,
    /const runCoverageBlockedProbe = async/u,
    /FOR UPDATE;/u,
    /WHEN lock_not_available THEN/u,
    /coverage authority did not restore lock_timeout/u,
    /callerTimeout:\s*"0"/u,
    /expectedSetting:\s*"0"/u,
    /holderSeconds:\s*7/u,
    /minimumMs:\s*4_000/u,
    /maximumMs:\s*6_500/u,
    /callerTimeout:\s*"125ms"/u,
    /expectedSetting:\s*"125ms"/u,
    /holderSeconds:\s*2/u,
    /minimumMs:\s*75/u,
    /maximumMs:\s*1_500/u,
  ]) {
    assert.match(integrationHarness, contract);
  }
  const coverageProof = integrationHarness.slice(
    integrationHarness.indexOf(
      "async function proveCoverageTimeoutSemantics",
    ),
    integrationHarness.indexOf(
      "async function proveCoverageLockAndTerminalReplay",
    ),
  );
  assert.match(
    coverageProof,
    /public\.email_outbox_idempotency_coverage_authority/u,
  );
  assert.match(
    integrationHarness,
    /await proveCoverageTimeoutSemantics\(port, database\);/u,
  );
});

test("H3 orders timeout, late-candidate, and divergent rollback/retry proofs", () => {
  const timeoutStart = integrationHarness.indexOf(
    "async function proveCoverageTimeoutSemantics",
  );
  const timeoutEnd = integrationHarness.indexOf(
    "async function proveCoverageLockAndTerminalReplay",
    timeoutStart,
  );
  assert.ok(timeoutStart >= 0 && timeoutEnd > timeoutStart);
  const timeoutProof = integrationHarness.slice(timeoutStart, timeoutEnd);
  assertOrdered(
    timeoutProof,
    [
      "const holder = spawnPsql",
      "await waitForMarker",
      "const startedAt = Date.now()",
      "observedSetting = scalar",
      "elapsedMs = Date.now() - startedAt",
      "holder.completed",
      "assert.equal(observedSetting, expectedSetting)",
      "public.email_outbox_idempotency_coverage_authority",
    ],
    "coverage timeout proof",
  );
  const timeoutHolderStart = timeoutProof.indexOf(
    "const holder = spawnPsql",
  );
  const timeoutHolderEnd = timeoutProof.indexOf(
    "await waitForMarker",
    timeoutHolderStart,
  );
  assert.ok(timeoutHolderStart >= 0 && timeoutHolderEnd > timeoutHolderStart);
  assertOrdered(
    timeoutProof.slice(timeoutHolderStart, timeoutHolderEnd),
    ["FOR UPDATE;", "SELECT pg_catalog.pg_sleep(${holderSeconds});"],
    "timeout holder row-lock-before-sleep ordering",
  );
  assert.match(
    timeoutProof,
    /elapsedMs >= minimumMs && elapsedMs <= maximumMs/u,
  );
  assert.match(
    timeoutProof,
    /callerTimeout:\s*"0"[\s\S]*?callerTimeout:\s*"125ms"/u,
  );

  const coverageStart = integrationHarness.indexOf(
    "async function proveCoverageLockAndTerminalReplay",
  );
  const coverageEnd = integrationHarness.indexOf(
    "function proveFailClosedAndMutationProtection",
    coverageStart,
  );
  assert.ok(coverageStart >= 0 && coverageEnd > coverageStart);
  const coverageProof = integrationHarness.slice(coverageStart, coverageEnd);
  assert.match(
    coverageProof,
    /const snapshotControllerApplication\s*=\s*"mail_0067_coverage_snapshot_controller";/u,
  );
  assert.match(
    coverageProof,
    /await coverageSnapshotController[.]query[(]\s*`SELECT pg_catalog[.]pg_advisory_lock[(]\s*[$][{]COVERAGE_SNAPSHOT_GATE[}]/u,
  );
  const snapshotHolderStart = coverageProof.indexOf(
    "snapshotHolder = spawnPsql",
  );
  const snapshotHolderEnd = coverageProof.indexOf(
    "snapshotHolderWork = observePromiseOutcome",
    snapshotHolderStart,
  );
  assert.ok(
    snapshotHolderStart >= 0 && snapshotHolderEnd > snapshotHolderStart,
  );
  assertOrdered(
    coverageProof.slice(snapshotHolderStart, snapshotHolderEnd),
    [
      "FOR UPDATE;",
      "pg_advisory_xact_lock(",
      "${COVERAGE_SNAPSHOT_GATE}",
    ],
    "late-candidate holder row/advisory gate ordering",
  );
  assert.match(
    coverageProof,
    /await waitForCutoverAdvisoryLockTopology[(]\s*coverageSnapshotController,[\s\S]*?controllerApplicationName:\s*snapshotControllerApplication,[\s\S]*?gateKey:\s*COVERAGE_SNAPSHOT_GATE,[\s\S]*?waiterApplicationName:\s*snapshotHolderApplication/u,
  );
  assert.match(
    coverageProof,
    /await waitForCoverageSnapshotTopology[(]\s*coverageSnapshotController,[\s\S]*?controllerApplicationName:\s*snapshotControllerApplication,[\s\S]*?gateKey:\s*COVERAGE_SNAPSHOT_GATE,[\s\S]*?holderApplicationName:\s*snapshotHolderApplication,[\s\S]*?waiterMarker:\s*snapshotWaiterMarker/u,
  );
  const snapshotLateInsertStart = coverageProof.indexOf(
    "const snapshotLateCommitted = scalar",
    snapshotHolderStart,
  );
  assert.ok(
    snapshotLateInsertStart > snapshotHolderStart,
    "late-candidate topology slice must precede the insert",
  );
  assert.doesNotMatch(
    coverageProof.slice(snapshotHolderStart, snapshotLateInsertStart),
    /await waitForAdvisoryLockWaiter[(]|await waitForMarker[(]/u,
    "late-candidate topology must not rely on generic waiter probes",
  );
  const coverageTopologyStart = integrationHarness.indexOf(
    "async function waitForCoverageSnapshotTopology",
  );
  const coverageTopologyEnd = integrationHarness.indexOf(
    "async function waitForCutoverRelationLockTopology",
    coverageTopologyStart,
  );
  assert.ok(
    coverageTopologyStart >= 0
      && coverageTopologyEnd > coverageTopologyStart,
  );
  const coverageTopology = integrationHarness.slice(
    coverageTopologyStart,
    coverageTopologyEnd,
  );
  for (const contract of [
    /pg_catalog[.]pg_blocking_pids[(]waiter[.]pid[)]/u,
    /pg_catalog[.]pg_blocking_pids[(]holder[.]pid[)]/u,
    /waiting_transaction[.]locktype = 'transactionid'/u,
    /waiting_transaction[.]granted IS FALSE/u,
    /blocking_transaction[.]mode = 'ExclusiveLock'/u,
    /blocking_transaction[.]granted IS TRUE/u,
    /waiting_gate[.]locktype = 'advisory'/u,
    /waiting_gate[.]objid = [$]4::pg_catalog[.]oid/u,
    /blocking_gate[.]pid = pg_catalog[.]pg_backend_pid[(][)]/u,
  ]) {
    assert.match(coverageTopology, contract);
  }

  assert.match(
    integrationHarness,
    /const COVERAGE_SNAPSHOT_TOPOLOGY_TIMEOUT_MS = 4_000;/u,
    "coverage topology must fail before the production function lock timeout",
  );
  assert.match(
    coverageTopology,
    /waitForCutoverTopology[(][\s\S]*?"coverage snapshot transaction\/advisory topology",\s*createOperationDeadline[(]\s*COVERAGE_SNAPSHOT_TOPOLOGY_TIMEOUT_MS\s*[)]\s*,\s*[)]/u,
    "coverage topology must pass its dedicated deadline to the shared poller",
  );
  assert.match(
    coverageTopology,
    /blocking_transaction[.]database\s+IS NOT DISTINCT FROM\s+waiting_transaction[.]database/u,
    "transactionid locks have nullable database identities on PostgreSQL 18",
  );
  assert.doesNotMatch(
    coverageTopology,
    /blocking_transaction[.]database\s*=\s*waiting_transaction[.]database/u,
    "nullable transactionid lock databases must not use ordinary equality",
  );
  assert.match(
    coverageTopology,
    /blocking_gate[.]database = waiting_gate[.]database/u,
    "the non-null advisory lock database join must remain exact equality",
  );
  assertOrdered(
    coverageProof,
    [
      "snapshotHolder = spawnPsql",
      "await waitForCutoverAdvisoryLockTopology",
      "snapshotCoverage = observePromiseOutcome",
      "await waitForCoverageSnapshotTopology",
      "const snapshotLateCommitted = scalar",
      "releaseControllerGate",
      "snapshotCoverageResult",
      "assert.equal(snapshotCoverageResult.rows[0]?.covered, false)",
    ],
    "coverage late-candidate proof",
  );

  const sameStatementStart = integrationHarness.indexOf(
    "async function proveSameStatementAuthority",
  );
  const sameStatementEnd = integrationHarness.indexOf(
    "function proveNewReplayAndRollback",
    sameStatementStart,
  );
  assert.ok(
    sameStatementStart >= 0 && sameStatementEnd > sameStatementStart,
  );
  const sameStatementProof = integrationHarness.slice(
    sameStatementStart,
    sameStatementEnd,
  );
  const exactStart = sameStatementProof.indexOf(
    "const exactFirst = newEventRow",
  );
  const exactEnd = sameStatementProof.indexOf(
    "const divergentFirst = newEventRow",
    exactStart,
  );
  assert.ok(exactStart >= 0 && exactEnd > exactStart);
  const exactProof = sameStatementProof.slice(exactStart, exactEnd);
  assert.match(
    exactProof,
    /SELECT pg_catalog[.]count[(][*][)]\s+FROM public[.]email_outbox\s+WHERE idempotency_key = '[$][{]exactFirst[.]key[}]'[\s\S]*?[)] = 1/u,
    "same-statement exact replay must finish with one outbox row",
  );
  assert.match(
    exactProof,
    /SELECT pg_catalog[.]count[(][*][)]\s+FROM public[.]email_outbox_idempotency_authority\s+WHERE idempotency_sha256 = '[$][{]exactFirst[.]key[}]'[\s\S]*?[)] = 1/u,
    "same-statement exact replay must finish with one authority row",
  );
  assertOrdered(
    sameStatementProof,
    [
      "const divergentFirst = newEventRow",
      "await expectDatabaseError",
      'constraint: "email_outbox_idempotency_authority_pkey"',
      "NOT EXISTS",
      '"a divergent multi-row statement must roll back its row and authority"',
      "const divergentRetry = {",
      "insertOutboxSql(divergentRetry",
      "divergentRetry.id",
    ],
    "same-statement divergent rollback/retry proof",
  );
  const divergentRetryStart = sameStatementProof.indexOf(
    "const divergentRetry = {",
  );
  assert.ok(divergentRetryStart >= 0);
  const divergentRetryProof = sameStatementProof.slice(
    divergentRetryStart,
  );
  assert.match(
    divergentRetryProof,
    /SELECT pg_catalog[.]count[(][*][)]\s+FROM public[.]email_outbox\s+WHERE idempotency_key = '[$][{]divergentRetry[.]key[}]'[\s\S]*?[)] = 1/u,
    "divergent retry must finish with exactly one outbox row",
  );
  assert.match(
    divergentRetryProof,
    /SELECT pg_catalog[.]count[(][*][)]\s+FROM public[.]email_outbox_idempotency_authority\s+WHERE idempotency_sha256 = '[$][{]divergentRetry[.]key[}]'[\s\S]*?[)] = 1/u,
    "divergent retry must finish with exactly one authority row",
  );
  assert.doesNotMatch(
    sameStatementProof.slice(
      sameStatementProof.indexOf("const divergentRetry = {"),
    ),
    /ON CONFLICT/iu,
  );
});

test("H3 exact multi-row proofs contain no ON CONFLICT escape hatch", () => {
  assert.match(
    integrationHarness,
    /function insertExactEventRowsSql\(rows\)/u,
  );
  const exactBuilder = integrationHarness.slice(
    integrationHarness.indexOf("function insertExactEventRowsSql"),
    integrationHarness.indexOf("function systemVariables"),
  );
  assert.doesNotMatch(exactBuilder, /ON CONFLICT/iu);

  const sameStatementProof = integrationHarness.slice(
    integrationHarness.indexOf("async function proveSameStatementAuthority"),
    integrationHarness.indexOf("function proveNewReplayAndRollback"),
  );
  assert.match(
    sameStatementProof,
    /insertExactEventRowsSql\(\[exactFirst, exactSecond\]\)/u,
  );
  assert.match(
    sameStatementProof,
    /insertExactEventRowsSql\(\[divergentFirst, divergentSecond\]\)/u,
  );
  assert.doesNotMatch(sameStatementProof, /ON CONFLICT/iu);
});

test("0067 original-payload vector fixture is byte-pinned and semantically explicit", () => {
  const fixtureSha256 = createHash("sha256")
    .update(originalPayloadVectorBytes)
    .digest("hex");
  assert.equal(
    fixtureSha256,
    "2f7d1794f671d75a92beed7bbc01ab1ee8f7c592a9fba8b2122f2d29f2ce9aa2",
  );
  assert.deepEqual(
    originalPayloadVectors.map(
      ({ name, canonicalPayloadJson, sha256: vectorSha256 }) => ({
        name,
        canonicalPayloadJson,
        sha256: vectorSha256,
      }),
    ),
    [
      {
        name: "nested-json",
        canonicalPayloadJson:
          "[\"mail-replay-conflict-v1\", \"storage-quota-changed\", \"a:mail-0067-vector-user\", \"vector@example.invalid\", \"1\", {\"aa\": {\"bb\": [\"x\", {\"cc\": true}]}, \"dd\": null}]",
        sha256: "5a6b0fd1e88e8f98d05804d90a5353362b5aa1c3e2c8e3fa3dd0b866b6929de2",
      },
      {
        name: "numeric-forms",
        canonicalPayloadJson:
          "[\"mail-replay-conflict-v1\", \"storage-quota-changed\", \"a:mail-0067-vector-user\", \"vector@example.invalid\", \"1\", {\"aa\": 42, \"bb\": 42.5, \"cc\": -7}]",
        sha256: "031175ce0821548428880c32a7e7b520adc693c1b68296202577a8905504f387",
      },
      {
        name: "unicode",
        canonicalPayloadJson:
          "[\"mail-replay-conflict-v1\", \"storage-quota-changed\", \"a:mail-0067-vector-user\", \"vector@example.invalid\", \"1\", {\"aa\": \"नमस्ते\", \"bb\": \"東京\", \"cc\": \"🙂\"}]",
        sha256: "b930c31033833bea1060632f31aacc031516dd99b34e2af9eedbb853e4955e5b",
      },
      {
        name: "system-envelope",
        canonicalPayloadJson:
          "[\"mail-replay-conflict-v1\", \"invitation\", \"s:access-request-approved:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:cccccccc-cccc-4ccc-8ccc-cccccccccccc\", \"system@example.invalid\", \"1\", {\"aa\": \"kept\", \"_mailProducer\": \"access-request-approved\", \"_mailSourceId\": \"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\", \"_mailAudienceId\": \"cccccccc-cccc-4ccc-8ccc-cccccccccccc\"}]",
        sha256: "b3c8de0ca119880b4cb0eedff6a73b626c3fa970e24d309d6ed329f8bfdb7be8",
      },
    ],
  );
  assert.match(integrationHarness, new RegExp(fixtureSha256, "u"));
});

test("0067 live proof pins payload digest vectors and conservative ASCII email policy", () => {
  const nearMissStart = integrationHarness.indexOf("function nearMissRows");
  const nearMissEnd = integrationHarness.indexOf(
    "function seedSources",
    nearMissStart,
  );
  assert.ok(nearMissStart >= 0 && nearMissEnd > nearMissStart);
  assert.doesNotMatch(
    integrationHarness.slice(nearMissStart, nearMissEnd),
    /reset-unsupported-non-ascii-email/u,
    "the successful legacy seed must contain only canonical recipients",
  );

  const classificationStart = integrationHarness.indexOf(
    "function proveLegacyClassification",
  );
  const classificationEnd = integrationHarness.indexOf(
    "async function proveBlockedRowsDoNotAliasNativeEvents",
    classificationStart,
  );
  assert.ok(
    classificationStart >= 0 && classificationEnd > classificationStart,
  );
  assert.doesNotMatch(
    integrationHarness.slice(classificationStart, classificationEnd),
    /reset-unsupported-non-ascii-email/u,
    "successful classification must not expect a row rejected by the cutover",
  );

  for (const marker of [
    "ORIGINAL_PAYLOAD_DIGEST_VECTORS",
    "mail-replay-conflict-v1",
    "nested-json",
    "numeric-forms",
    "unicode",
    "system-envelope",
    "proveOriginalPayloadDigestVectors",
    "proveReplayConflictFingerprintSemantics",
    "replay_fingerprint_matrix",
    "mail_outbox_historical_ascii_email",
    "reset-unsupported-non-ascii-email",
  ]) {
    assert.match(integrationHarness + migration, new RegExp(marker, "u"));
  }
});

test("0067 proves noncanonical rollback before unknown-template rollback and retry", () => {
  const functionStart = integrationHarness.indexOf(
    "async function proveUnknownTemplateCutoverRollback",
  );
  const functionEnd = integrationHarness.indexOf(
    "async function releaseControllerGate",
    functionStart,
  );
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const rollbackProof = integrationHarness.slice(functionStart, functionEnd);

  for (const contract of [
    /const nonAscii = \{/u,
    /reset-unsupported-non-ascii-email/u,
    /email outbox recipient must be canonical ASCII at idempotency authority cutover/u,
    /unknown email outbox template at idempotency authority cutover/u,
    /const ledgerBytesBefore = ledgerBytes\(\)/u,
    /const ledgerTailBefore = ledgerTail\(\)/u,
    /pg_catalog[.]row_to_json\(hostile\)/u,
    /23514 must roll back the ledger and every persistent 0067 object/u,
    /await migrateCandidate\(\)/u,
  ]) {
    assert.match(rollbackProof, contract);
  }
  assertOrdered(
    rollbackProof,
    [
      "await proveRejectedCutover(nonAscii",
      "email outbox recipient must be canonical ASCII at idempotency authority cutover",
      "await proveRejectedCutover(unknown",
      "unknown email outbox template at idempotency authority cutover",
      "await migrateCandidate()",
      "repaired clone must accept one clean framework migration retry",
    ],
    "noncanonical/unknown rollback phases and clean retry",
  );
});

test("0067 live payload proof uses the runtime recipient and PostgreSQL-native variable semantics", () => {
  assert.match(
    outboxRuntime,
    /const recipient = input\.to\.trim\(\)\.toLowerCase\(\);/u,
  );
  const vectorStart = integrationHarness.indexOf(
    "function proveOriginalPayloadDigestVectors",
  );
  const vectorEnd = integrationHarness.indexOf(
    "function proveOriginalPayloadVariableSemantics",
    vectorStart,
  );
  assert.notEqual(vectorStart, -1, "payload vector proof is missing");
  assert.notEqual(
    vectorEnd,
    -1,
    "payload variable-semantics proof boundary is missing",
  );
  const vectorProof = integrationHarness.slice(vectorStart, vectorEnd);
  assert.match(
    vectorProof,
    /const canonicalRecipient = vector\.toEmail\.trim\(\)\.toLowerCase\(\);/u,
  );
  assert.equal(
    [...vectorProof.matchAll(/sqlLiteral\(canonicalRecipient\)/gu)].length,
    2,
    "the helper input and expected canonical JSON must share one recipient",
  );
  assert.doesNotMatch(vectorProof, /sqlLiteral\(vector\.toEmail\)/u);
  assert.ok(
    vectorProof.indexOf("const canonicalRecipient") <
      vectorProof.indexOf("public.email_outbox_original_payload_sha256"),
    "recipient canonicalization must precede the SQL helper call",
  );

  const semanticsEnd = integrationHarness.indexOf(
    "function proveCompositeAuthorityBackstop",
    vectorEnd,
  );
  assert.notEqual(
    semanticsEnd,
    -1,
    "payload variable-semantics proof boundary is missing",
  );
  const semanticsProof = integrationHarness.slice(vectorEnd, semanticsEnd);
  for (const marker of [
    "nested-mail-preserved",
    "nested-mail-digest-distinct-from-empty-object",
    "variables-array",
    "variables-scalar",
    "variables-json-null",
    "variables-sql-null",
    "POSTGRES_NUMERIC_EDGE_PAIRS",
  ]) {
    assert.match(semanticsProof, new RegExp(marker, "u"), marker);
  }
  assert.match(
    semanticsProof,
    /"_mailOperationId":\s*"strip-top-level"[\s\S]*?"nested":\s*\{\s*"_mailOperationId":\s*"preserve-nested"/u,
  );
  assert.match(
    semanticsProof,
    /const nestedMailWithoutNestedOperation = \{\s*"nested": \{\},\s*\};/u,
  );
  assert.match(
    semanticsProof,
    /JSON\.stringify\(nestedMailExpected\)[\s\S]*?<>\s*public\.email_outbox_original_payload_sha256\([\s\S]*?JSON\.stringify\(nestedMailWithoutNestedOperation\)/u,
    "the nested reserved field must materially change the authoritative digest",
  );
  assert.match(
    semanticsProof,
    /"true",\s*"nested-mail-digest-distinct-from-empty-object"/u,
  );
  assert.match(
    semanticsProof,
    /constraint:\s*"email_outbox_variables_object_valid"/u,
  );
  assert.match(
    semanticsProof,
    /await expectDatabaseError\([\s\S]*?constraint:\s*invalidVariables[.]constraint/u,
  );
  assert.match(
    semanticsProof,
    /variablesSql:\s*"NULL"[\s\S]*?code:\s*"23502"/u,
  );
  const numericStart = semanticsProof.indexOf(
    "POSTGRES_NUMERIC_EDGE_PAIRS",
  );
  const numericEnd = semanticsProof.indexOf(
    "for (const invalidVariables",
    numericStart,
  );
  assert.ok(numericStart >= 0 && numericEnd > numericStart);
  const numericProof = semanticsProof.slice(numericStart, numericEnd);
  assert.match(numericProof, /123456789012345678901234567890[.]12345678901234567890/u);
  assert.match(numericProof, /1[.]2300e[+]10/iu);
  assert.match(numericProof, /1[.]23400e-19/iu);
  assert.doesNotMatch(numericProof, /JSON[.](?:parse|stringify)/u);
});

test("0067 validates replay identity before a prior fingerprint can suppress the row", () => {
  const claimStart = migration.toLowerCase().indexOf(
    "create function public.claim_email_outbox_idempotency_authority()",
  );
  const claimEnd = migration.toLowerCase().indexOf(
    "create function public.persist_email_outbox_idempotency_authority()",
    claimStart,
  );
  assert.ok(claimStart >= 0 && claimEnd > claimStart);
  const claim = migration.slice(claimStart, claimEnd).toLowerCase();
  const lookup = claim.indexOf("select authority.original_payload_sha256");
  const replayReturn = claim.lastIndexOf("return null");
  assert.ok(lookup >= 0 && replayReturn > lookup);
  for (const marker of [
    "replay variables must be a json object",
    "replay recipient must be canonical ascii",
    "replay envelope key casing is invalid",
    "account email outbox replay envelope is invalid",
    "system email outbox replay envelope is invalid",
    "new.delivery_scope_key is distinct from 'a:' || new.user_id",
    "'s:' || new.operation_id::pg_catalog.text",
    "new.variables ->> '_mailoperationid'",
    "new.variables ->> '_mailrecipient'",
    "new.variables ->> '_mailsourceid'",
    "new.variables ->> '_mailaudienceid'",
  ]) {
    const validation = claim.indexOf(marker);
    assert.ok(validation >= 0, marker);
    assert.ok(validation < lookup, `${marker} must precede authority lookup`);
    assert.ok(validation < replayReturn, `${marker} must precede replay return`);
  }
  assert.match(
    claim,
    /replay-conflict evidence only; not provider-delivery authorization/u,
  );

  const proofStart = integrationHarness.indexOf(
    "async function proveReplayConflictFingerprintSemantics",
  );
  const proofEnd = integrationHarness.indexOf(
    "function proveCompositeAuthorityBackstop",
    proofStart,
  );
  assert.ok(proofStart >= 0 && proofEnd > proofStart);
  const proof = integrationHarness.slice(proofStart, proofEnd);
  for (const marker of [
    "account-wrong-scope",
    "account-reserved-envelope",
    "account-case-colliding-envelope",
    "account-system-template",
    "account-noncanonical-recipient",
    "system-wrong-physical-scope",
    "system-missing-audience",
    "system-operation-mirror-mismatch",
    "system-recipient-mirror-mismatch",
    "system-template-producer-mismatch",
    "system-uppercase-source",
    "system-uppercase-audience",
    "system-case-colliding-envelope",
    "system-wrong-version",
    "email outbox idempotency event payload conflict",
    "invalid or divergent replays must leave one row and one authority",
  ]) {
    assert.match(proof, new RegExp(marker, "u"), marker);
  }
  assert.match(
    integrationHarness,
    /await proveReplayConflictFingerprintSemantics\(port, "mail0067"\)/u,
  );
});

test("0067 disposable root is covered by top-level cleanup from its first fallible use", () => {
  const mainStart = integrationHarness.indexOf(
    "export async function main()",
  );
  assert.ok(mainStart >= 0);
  const mainBody = integrationHarness.slice(mainStart);
  const rootIndex = mainBody.indexOf("const temporaryRoot = mkdtempSync");
  const tryIndex = mainBody.indexOf("try {", rootIndex);
  const rootStatementEnd = mainBody.indexOf(");", rootIndex) + 2;
  assert.ok(rootIndex >= 0 && tryIndex > rootIndex);
  assert.ok(rootStatementEnd > rootIndex);
  assert.equal(
    mainBody.slice(rootStatementEnd, tryIndex).trim(),
    "",
    "the top-level try must begin literally immediately after mkdtemp",
  );
  for (const fallibleMarker of [
    "diagnosticTemporaryRoot = temporaryRoot",
    "path.join(temporaryRoot, \"data\")",
    "path.join(temporaryRoot, \"postgres.log\")",
    "path.join(temporaryRoot, \"socket\")",
    "assertExactClusterPaths",
    "mkdirSync(socketDirectory)",
    "stagedMigrationsThrough(temporaryRoot, 66)",
    "allocateDisposableLoopbackPort()",
  ]) {
    const markerIndex = mainBody.indexOf(fallibleMarker, rootIndex);
    assert.ok(
      markerIndex > tryIndex,
      `${fallibleMarker} must be inside the top-level try/finally`,
    );
  }
  assert.match(
    integrationHarness,
    /function preserveOperationAndCleanupFailures\(/u,
  );
  assert.match(
    mainBody,
    /throw preserveOperationAndCleanupFailures\(\s*operationError,\s*cleanupFailures,/u,
  );
  assert.doesNotMatch(mainBody, /cleanup_error=/u);
});

test("0067 entrypoint fails closed with one fixed diagnostic", () => {
  assert.match(
    integrationEntrypoint,
    /const HARNESS_FAILURE =\s*"mail_durable_replay_0067_error=HARNESS_FAILED\\n";/u,
  );
  assert.match(
    integrationEntrypoint,
    /await import\("\.\/mail-durable-replay-0067[.]impl[.]mjs"\)/u,
  );
  assert.match(integrationEntrypoint, /catch \{/u);
  assert.match(
    integrationEntrypoint,
    /process[.]stderr[.]write\(HARNESS_FAILURE\)/u,
  );
  assert.doesNotMatch(
    integrationEntrypoint,
    /[.]stack|[.]message|[.]cause|formatHarnessFailure|String\(/u,
  );
  assert.match(
    integrationHarness,
    /export async function main\(\)/u,
  );
  assert.doesNotMatch(
    integrationHarness,
    /main\(\)[.]catch|formatHarnessFailure/u,
  );
  assert.doesNotMatch(
    integrationHarness,
    /isolated_root_token|isolated_port/u,
  );
  assert.match(
    integrationHarness,
    /mail_durable_replay_0067=constraint_catalog:pass/u,
  );
  assert.equal(
    integrationHarness.includes("constraint_catalog:${catalog}"),
    false,
  );

  const smoke = spawnSync(
    process.execPath,
    [
      path.join(
        repositoryRoot,
        "infra",
        "tests",
        "mail-durable-replay-0067.integration.mjs",
      ),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        HARNESS_DIAGNOSTIC_SECRET: "must-not-escape",
      },
    },
  );
  assert.equal(smoke.status, 1);
  assert.equal(smoke.stdout, "");
  assert.equal(
    smoke.stderr,
    "mail_durable_replay_0067_error=HARNESS_FAILED\n",
  );
});

test("A binds both pg constructors and executes the tracked factories", () => {
  const importStatement = integrationHarness.match(
    /^import \{[^}]*\} from "pg";$/mu,
  )?.[0];
  assert.ok(importStatement, "the harness pg import is missing");

  const clientFactory = integrationHarness.match(
    /function createTrackedClient\(config\) \{[\s\S]*?\n\}/u,
  )?.[0];
  const poolFactory = integrationHarness.match(
    /function createTrackedPool\(config\) \{[\s\S]*?\n\}/u,
  )?.[0];
  assert.ok(clientFactory, "the tracked Client factory is missing");
  assert.ok(poolFactory, "the tracked Pool factory is missing");

  const smokeSource = `
    ${importStatement}
    const trackedClients = new Set();
    const trackedPools = new Set();
    ${clientFactory}
    ${poolFactory}
    const client = createTrackedClient({});
    const pool = createTrackedPool({ allowExitOnIdle: true });
    if (!(client instanceof Client)) {
      throw new Error("tracked Client factory did not use the imported binding");
    }
    if (!(pool instanceof Pool)) {
      throw new Error("tracked Pool factory did not use the imported binding");
    }
    await pool.end();
  `;
  const smoke = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", smokeSource],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  assert.equal(smoke.status, 0, smoke.stderr || smoke.error?.message);
  assert.equal(importStatement, 'import { Client, Pool } from "pg";');
});

function evaluateHarnessFailurePreserver() {
  const preserveStart = integrationHarness.indexOf(
    "function preserveOperationAndCleanupFailures",
  );
  const preserveEnd = integrationHarness.indexOf(
    "function readExactPostmasterPid",
    preserveStart,
  );
  assert.ok(preserveStart >= 0 && preserveEnd > preserveStart);
  const preserveSource = integrationHarness.slice(
    preserveStart,
    preserveEnd,
  );
  return Function(
    `"use strict"; ${preserveSource}; return preserveOperationAndCleanupFailures;`,
  )();
}

function assertPrimaryAndCleanupPreserved(message) {
  const primary = new Error(`${message}:primary`);
  const cleanup = new Error(`${message}:cleanup`);
  const combined = evaluateHarnessFailurePreserver()(
    primary,
    [cleanup],
    message,
  );
  assert.ok(combined instanceof AggregateError);
  assert.equal(combined.cause, primary);
  assert.equal(combined.errors[0], primary);
  assert.equal(combined.errors[0].message, `${message}:primary`);
  assert.equal(combined.errors[1], cleanup);
}

test("C bootstrap pool ownership unregisters exactly once after success or failure", () => {
  const functionStart = integrationHarness.indexOf(
    "async function reconcileReviewedPrivileges",
  );
  const bootstrapStart = integrationHarness.indexOf(
    "const bootstrapPool = createTrackedPool",
    functionStart,
  );
  const bootstrapEnd = integrationHarness.indexOf(
    "const client = createTrackedClient",
    bootstrapStart,
  );
  assert.ok(functionStart >= 0 && bootstrapStart > functionStart);
  assert.ok(bootstrapEnd > bootstrapStart);
  const bootstrapOwnership = integrationHarness.slice(
    bootstrapStart,
    bootstrapEnd,
  );

  assert.equal(
    [...bootstrapOwnership.matchAll(
      /trackedPools[.]delete[(]bootstrapPool[)]/gu,
    )].length,
    1,
    "the bootstrap pool must be unregistered exactly once",
  );
  assert.doesNotMatch(
    bootstrapOwnership,
    /bootstrapPool[.]end[(]/u,
    "runDatabaseRoleBootstrap, not the harness, owns pool shutdown",
  );
  assert.match(
    bootstrapOwnership,
    /throw new Error[(][\s\S]*?\{ cause: error \},[\s\S]*?[)]/u,
    "the bootstrap failure must retain the original error as its cause",
  );
  assertOrdered(
    bootstrapOwnership,
    [
      "const bootstrapPool = createTrackedPool",
      "try {",
      "await runDatabaseRoleBootstrap",
      "} catch (error) {",
      "throw new Error(",
      "{ cause: error }",
      "} finally {",
      "trackedPools.delete(bootstrapPool)",
    ],
    "bootstrap pool ownership",
  );
});

test("C bootstraps 0065 then 0066 and rolls back a callback-only 0067 marker", () => {
  assertOrdered(
    integrationHarness,
    [
      "phase0065Migrations = stagedMigrationsThrough(temporaryRoot, 65)",
      "phase0066Migrations = stagedMigrationsThrough(temporaryRoot, 66)",
      "migrationsFolder: phase0065Migrations",
      'phase: "0065"',
      "migrationsFolder: phase0066Migrations",
      'phase: "0066"',
      'await proveBeforeCommitJournalMutationRollback(port, "mail0067")',
      "await proveProductionMigrationFramework(",
    ],
    "0065 to 0066 bootstrap and 0067 cutover order",
  );

  const proofStart = integrationHarness.indexOf(
    "async function proveBeforeCommitJournalMutationRollback",
  );
  const proofEnd = integrationHarness.indexOf(
    "async function proveBootstrapReconciliation",
    proofStart,
  );
  assert.ok(proofStart >= 0 && proofEnd > proofStart);
  const proof = integrationHarness.slice(proofStart, proofEnd);
  for (const contract of [
    /reviewedBootstrapPhaseSnapshot/u,
    /phaseIndex:\s*66/u,
    /beforeCommit:\s*async \(client\) =>/u,
    /INSERT INTO drizzle[.]__drizzle_migrations/u,
    /ccb3e093847fb875ded41ec0c36d0ff8405c04d1546ba9dd21696e86a73a6817/u,
    /failed post-callback phase verification must roll back the journal marker/u,
    /failed post-callback phase verification must roll back catalog and ACL state/u,
    /phase:\s*"0066-after-journal-mutation-rollback"/u,
    /mail_durable_replay_0067=bootstrap_journal_mutation_rollback:pass/u,
  ]) {
    assert.match(proof, contract);
  }
  assertOrdered(
    proof,
    [
      "const beforeMutationSnapshot = reviewedBootstrapPhaseSnapshot",
      "await assert.rejects(",
      "beforeCommit: async (client) =>",
      "INSERT INTO drizzle.__drizzle_migrations",
      "failed post-callback phase verification must roll back the journal marker",
      "reviewedBootstrapPhaseSnapshot(port, database)",
      'phase: "0066-after-journal-mutation-rollback"',
    ],
    "callback-only phase marker rollback proof",
  );
});
test("C live bootstrap rolls back post-hook ACL drift before commit", () => {
  const proofStart = integrationHarness.indexOf(
    "async function proveBootstrapReconciliation",
  );
  const proofEnd = integrationHarness.indexOf(
    "async function proveWorkerRoleSharedWriter",
    proofStart,
  );
  assert.ok(proofStart >= 0 && proofEnd > proofStart);
  const proof = integrationHarness.slice(proofStart, proofEnd);

  for (const contract of [
    /function bootstrapAclSnapshot[(]/u,
    /await assert[.]rejects[(]/u,
    /beforeCommit:\s*async [(]client[)] =>/u,
    /GRANT SELECT ON TABLE public[.]email_outbox TO learncoding_backup_reporter/u,
    /assert[.]equal[(]\s*bootstrapAclSnapshot[(][\s\S]*?beforeMutationSnapshot/u,
    /mail_durable_replay_0067=bootstrap_before_commit_rollback:pass/u,
  ]) {
    assert.match(proof, contract);
  }
  assertOrdered(
    proof,
    [
      "const beforeMutationSnapshot = bootstrapAclSnapshot",
      "await assert.rejects(",
      "beforeCommit: async (client) =>",
      "GRANT SELECT ON TABLE public.email_outbox TO learncoding_backup_reporter",
      "assert.equal(",
      "bootstrapAclSnapshot(port, database)",
      "beforeMutationSnapshot",
      "await reconcileReviewedPrivileges(port, database, {",
      'phase: "0067"',
    ],
    "transactional post-hook ACL rollback proof",
  );
});

test("C preserves catalog verification failure when client close also fails", () => {
  assertPrimaryAndCleanupPreserved("catalog verification and close failed");

  const functionStart = integrationHarness.indexOf(
    "async function reconcileReviewedPrivileges",
  );
  const clientStart = integrationHarness.indexOf(
    "const client = createTrackedClient",
    functionStart,
  );
  const functionEnd = integrationHarness.indexOf(
    "function reportReplayAuthorityConstraintCatalog",
    clientStart,
  );
  assert.ok(functionStart >= 0 && clientStart > functionStart);
  assert.ok(functionEnd > clientStart);
  const catalogVerification = integrationHarness.slice(
    clientStart,
    functionEnd,
  );
  for (const contract of [
    /let operationError/u,
    /const cleanupFailures = \[\]/u,
    /operationError = error/u,
    /await runCleanupStep\(/u,
    /closeClientWithin\(/u,
    /throw preserveOperationAndCleanupFailures\(/u,
  ]) {
    assert.match(catalogVerification, contract);
  }
  assertOrdered(
    catalogVerification,
    [
      "try {",
      "verifyReviewedMailAuthorityCatalogContracts",
      "} catch (error) {",
      "operationError = error",
      "} finally {",
      "await runCleanupStep",
      "throw preserveOperationAndCleanupFailures",
    ],
    "catalog verification primary/cleanup ordering",
  );
});

test("C preserves framework failure when disposable database drops also fail", () => {
  assertPrimaryAndCleanupPreserved("framework operation and drop failed");

  const functionStart = integrationHarness.indexOf(
    "async function proveProductionMigrationFramework",
  );
  const functionEnd = integrationHarness.indexOf(
    "function assertExactClusterPaths",
    functionStart,
  );
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const framework = integrationHarness.slice(functionStart, functionEnd);
  for (const contract of [
    /let operationError/u,
    /const cleanupFailures = \[\]/u,
    /operationError = error/u,
    /await runCleanupStep\(/u,
    /dropDisposableDatabase/u,
    /throw preserveOperationAndCleanupFailures\(/u,
  ]) {
    assert.match(framework, contract);
  }
  assert.equal(
    [...framework.matchAll(/await runCleanupStep\(/gu)].length,
    2,
    "both disposable databases must receive independent cleanup attempts",
  );
  assertOrdered(
    framework,
    [
      "try {",
      "} catch (error) {",
      "operationError = error",
      "} finally {",
      '"mail0067_framework_rollback"',
      '"mail0067_framework"',
      "throw preserveOperationAndCleanupFailures",
    ],
    "framework primary/drop ordering",
  );
});

test("C preserves unknown-template failure when rollback database drop also fails", () => {
  assertPrimaryAndCleanupPreserved(
    "unknown-template operation and drop failed",
  );

  const functionStart = integrationHarness.indexOf(
    "async function proveUnknownTemplateCutoverRollback",
  );
  const functionEnd = integrationHarness.indexOf(
    "async function releaseControllerGate",
    functionStart,
  );
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const rollbackProof = integrationHarness.slice(
    functionStart,
    functionEnd,
  );
  for (const contract of [
    /let operationError/u,
    /const cleanupFailures = \[\]/u,
    /operationError = error/u,
    /await runCleanupStep\(/u,
    /dropDisposableDatabase/u,
    /throw preserveOperationAndCleanupFailures\(/u,
  ]) {
    assert.match(rollbackProof, contract);
  }
  assert.equal(
    [...rollbackProof.matchAll(/await runCleanupStep\(/gu)].length,
    1,
    "the rollback database must receive one accumulated cleanup attempt",
  );
  assertOrdered(
    rollbackProof,
    [
      "try {",
      "} catch (error) {",
      "operationError = error",
      "} finally {",
      "await runCleanupStep",
      "dropDisposableDatabase",
      "throw preserveOperationAndCleanupFailures",
    ],
    "unknown-template primary/drop ordering",
  );
});
