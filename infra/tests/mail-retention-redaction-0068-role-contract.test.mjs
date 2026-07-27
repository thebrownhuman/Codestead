import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REVIEWED_APPLICATION_FUNCTIONS,
  REVIEWED_APPLICATION_TRIGGERS,
  REVIEWED_0068_APPLICATION_FUNCTIONS,
  REVIEWED_0068_APPLICATION_TRIGGERS,
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES,
} from "../../scripts/bootstrap-database-roles.mjs";

test("reviewed mail authority catalog registers the exact 0068 phase", () => {
  const phase0068 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === 68,
  );

  assert.deepEqual(
    phase0068
      ? {
          index: phase0068.index,
          createdAt: phase0068.createdAt,
          migrationFile: phase0068.migrationFile,
          migrationSha256: phase0068.migrationSha256,
          requiresWorkerContract: phase0068.requiresWorkerContract,
          requiresProviderEvidence: phase0068.requiresProviderEvidence,
          requiresReplayAuthority: phase0068.requiresReplayAuthority,
          requiresGuardedDelivery: phase0068.requiresGuardedDelivery,
        }
      : null,
    {
      index: 68,
      createdAt: "1785005772253",
      migrationFile: "0068_mail_outbox_quarantine_redaction_authority_v2.sql",
      migrationSha256:
        "1b9e669025e2dccb54099fd99adbf26c8c6eccf5a10a39f3319772b2fdef4b0f",
      requiresWorkerContract: true,
      requiresProviderEvidence: true,
      requiresReplayAuthority: true,
      requiresGuardedDelivery: false,
    },
  );
});

test("0068 has a distinct exact routine manifest", () => {
  const phase0068 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === 68,
  );
  assert.equal(phase0068?.routines, REVIEWED_0068_APPLICATION_FUNCTIONS);
  assert.notEqual(phase0068?.routines, REVIEWED_APPLICATION_FUNCTIONS);

  const bySignature = new Map(
    REVIEWED_0068_APPLICATION_FUNCTIONS.map((routine) => [
      routine.signature,
      routine,
    ]),
  );
  for (const retired of [
    "public.redact_unresolved_email_outbox_authority(timestamp with time zone,integer)",
    "public.classify_email_outbox_retention_redaction(public.email_outbox,timestamp with time zone)",
  ]) {
    assert.equal(bySignature.has(retired), false, retired);
  }
  assert.deepEqual(
    [...bySignature]
      .filter(([signature]) =>
        [
          "public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)",
          "public.enforce_email_outbox_payload_immutable()",
          "public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)",
          "public.enforce_email_outbox_delivery_hold()",
          "public.claim_email_outbox_idempotency_authority()",
          "public.email_outbox_idempotency_coverage_authority(uuid[])",
        ].includes(signature),
      )
      .map(([signature, routine]) => [
        signature,
        routine.bodySha256,
        routine.definitionSha256,
        routine.allowedRoles,
      ]),
    [
      [
        "public.claim_email_outbox_idempotency_authority()",
        "9b0b6468cb0aad890bd78ecfa68bdab9f476d5f93a9841d515e0cea019926499",
        "c5e22b06c168cb1aa4099f3b3c66cc959b4a0b116313d2bce8fa3a3d9d77197b",
        [],
      ],
      [
        "public.email_outbox_idempotency_coverage_authority(uuid[])",
        "417c8583bb2509354b89e63317718a14cd0afbf08e62d534cd64341acc290e48",
        "2efbc33e8ee9dd33402f11682697f4e522cd9e7e3c70c8bf820f533b37aec1ac",
        ["learncoding_ops"],
      ],
      [
        "public.enforce_email_outbox_delivery_hold()",
        "bf644f8a69cea40011d7268ac8f14d8775045fe923cb2ca5f06a9cd25a39c8e8",
        "9af2d218cd9a189c84db693acefefa10826d796058505cce85124d6830d6fe53",
        [],
      ],
      [
        "public.classify_email_outbox_quarantine_redaction_v2(public.email_outbox,timestamp with time zone)",
        "056ab5e7fdd72b643ba48d9fe6caf0e1c678f4c7e8afbdf8edf0c844e02f0424",
        "8331736656001b0bb0fa5d303667353846ea4ff39c3f5aeba71979141f2dc612",
        [],
      ],
      [
        "public.enforce_email_outbox_payload_immutable()",
        "bc7518bd7a4aaa294ac72945abc0b5001957f47a581f6e9b69037b82894528cb",
        null,
        [],
      ],
      [
        "public.redact_quarantined_email_outbox_authority_v2(timestamp with time zone,integer)",
        "5a10a9df1684cb1355941c456eb03e46309eb12fa4dcdcda4ecf5f942241ae7b",
        "29ee2d3b4bf45322c9c68a3bc612084a460bfca3e54e7c2c044081d195fbe2b7",
        ["learncoding_ops"],
      ],
    ],
  );
});

test("0068 has a distinct ALWAYS-trigger manifest", () => {
  const phase0068 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === 68,
  );
  assert.equal(phase0068?.triggers, REVIEWED_0068_APPLICATION_TRIGGERS);
  assert.notEqual(phase0068?.triggers, REVIEWED_APPLICATION_TRIGGERS);

  const payload = REVIEWED_0068_APPLICATION_TRIGGERS.find(
    ({ name }) => name === "email_outbox_payload_immutable",
  );
  assert.deepEqual(payload, {
    relation: "public.email_outbox",
    name: "email_outbox_payload_immutable",
    functionSignature: "public.enforce_email_outbox_payload_immutable()",
    enabled: "A",
    type: 19,
    predicate: null,
    arguments: [],
    watchedColumns: [
      "user_id",
      "to_email",
      "template",
      "template_version",
      "variables",
      "idempotency_key",
      "idempotency_authority_version",
      "idempotency_authority_sha256",
      "idempotency_original_payload_sha256",
      "delivery_hold_version",
      "operation_id",
      "delivery_scope_key",
    ],
  });
  const hold = REVIEWED_0068_APPLICATION_TRIGGERS.find(
    ({ name }) => name === "email_outbox_delivery_hold",
  );
  assert.equal(hold?.enabled, "A");
  assert.equal(hold?.type, 19);
  assert.deepEqual(hold?.watchedColumns, [
    "idempotency_authority_version",
    "idempotency_authority_sha256",
    "idempotency_original_payload_sha256",
    "status",
    "attempt_count",
    "claim_token",
    "claim_owner",
    "claim_version",
    "lease_expires_at",
    "provider_call_started",
    "adapter",
    "dispatch_binding_version",
    "dispatch_binding_sha256",
    "provider_correlation_version",
    "provider_evidence_version",
    "provider_evidence_sha256",
    "provider_message_id",
    "next_attempt_at",
    "sent_at",
    "quarantined_at",
    "last_error_code",
    "delivery_hold_version",
  ]);
});
