import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REVIEWED_0068_APPLICATION_FUNCTIONS,
  REVIEWED_0068_APPLICATION_TRIGGERS,
  REVIEWED_0069_APPLICATION_FUNCTIONS,
  REVIEWED_0069_APPLICATION_TRIGGERS,
  REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES,
} from "../../scripts/bootstrap-database-roles.mjs";
import {
  BACKUP_STATUS_AUTHORITY_0067_CONTRACT,
  BACKUP_STATUS_AUTHORITY_0069_CONTRACT,
} from "../../scripts/verify-backup-status-mail-authority.mjs";

test("reviewed mail authority catalog registers the exact guarded 0069 phase", () => {
  const phase0069 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === 69,
  );

  assert.deepEqual(
    phase0069
      ? {
          index: phase0069.index,
          createdAt: phase0069.createdAt,
          migrationFile: phase0069.migrationFile,
          migrationSha256: phase0069.migrationSha256,
          requiresWorkerContract: phase0069.requiresWorkerContract,
          requiresProviderEvidence: phase0069.requiresProviderEvidence,
          requiresReplayAuthority: phase0069.requiresReplayAuthority,
          requiresGuardedDelivery: phase0069.requiresGuardedDelivery,
        }
      : null,
    {
      index: 69,
      createdAt: "1785009372253",
      migrationFile: "0069_mail_outbox_guarded_delivery_authority.sql",
      migrationSha256:
        "cae4ad59e4058b60fa6e0a24704414b8a8b15575a302a65f1155ec04fa8fdcd7",
      requiresWorkerContract: true,
      requiresProviderEvidence: true,
      requiresReplayAuthority: true,
      requiresGuardedDelivery: true,
    },
  );
});

test("0067 delegated backup authority uses the reviewed durable-replay bytes", () => {
  const enqueue = BACKUP_STATUS_AUTHORITY_0067_CONTRACT.routines.find(
    ({ signature }) =>
      signature === "public.enqueue_backup_status_mail_authority(text,text)",
  );

  assert.equal(
    enqueue?.bodySha256,
    "ac406b4dff127c10f791267c1464faddbe93e8ce88faa0a52c215881ac1b7480",
  );
  assert.equal(enqueue?.definitionSha256, null);
});

test("0069 has a distinct exact guarded-delivery routine manifest", () => {
  const phase0069 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === 69,
  );
  assert.equal(phase0069?.routines, REVIEWED_0069_APPLICATION_FUNCTIONS);
  assert.notEqual(phase0069?.routines, REVIEWED_0068_APPLICATION_FUNCTIONS);

  const guarded = REVIEWED_0069_APPLICATION_FUNCTIONS.filter(
    ({ migrationFile }) =>
      migrationFile === "0069_mail_outbox_guarded_delivery_authority.sql",
  );
  const expected = new Map([
    [
      "public.mail_delivery_release_receipt_sha256(uuid,uuid,text,text,text,text)",
      [
        "95169176e113b1a65fe08428dbec49e0b943b41a03867c3ed309141b3d011676",
        "63614be0762f14c3593ef05fc9f5f440a67a65bec27e703b59a18cd60273057d",
        ["learncoding_worker"],
      ],
    ],
    [
      "public.enforce_email_outbox_delivery_release_insert_xid()",
      [
        "a76581c119a10ce8943cd7a60e674938d7163f8a3fe444e83f49751a7c116e46",
        "b766a3512540a3d511a8126d87e9cbcd40847a87ea82ce27bdb2838290d97ec3",
        [],
      ],
    ],
    [
      "public.enforce_email_outbox_delivery_release_identity()",
      [
        "fcceb4bb8d7e434188d871fe0eda17976c833a128e67f67f9b753393daca9c0c",
        "150ec4c692f4f6c6247fce236d2ec7ea1b65f4b1f2864e201345867b814e9f60",
        [],
      ],
    ],
    [
      "public.enforce_email_outbox_delivery_release_insert_final()",
      [
        "42283dadeb5bed965d91ae3ff385d471295e5eb93f45b1598c9c2268cba20081",
        null,
        [],
      ],
    ],
    [
      "public.enforce_mail_delivery_release_receipt_append_only()",
      [
        "ba3b8d7a3dd78f927778d41856c8c57430d188de2c3b05f8a7c3173776bed131",
        "88e9e02ba13bfd210a724e56e6216c9e0375c046b6d904307d51c50cbae4cd3a",
        [],
      ],
    ],
    [
      "public.enforce_mail_delivery_release_receipt_insert()",
      [
        "5214d841459e6be0d0ab80d2a61299ddee7669d535814c287dfbc3b91c6b8225",
        "295db3f75181663dd4491b4a84d53617179965e2a0a156995b721e53ab9c5fb1",
        [],
      ],
    ],
    [
      "public.release_email_outbox_delivery(uuid,uuid,text,text,text)",
      [
        "b90df49087aa1ca69e80fc18a4963d5fc724d91db8612b338c2d2b98f2a3db0f",
        "9516f96ef9133bdf61f6db352422d521cf4616c6bd5b365888f1c614670ed409",
        ["learncoding_app", "learncoding_worker"],
      ],
    ],
    [
      "public.verify_email_outbox_delivery_release(uuid,uuid,text,text,text)",
      [
        "b3277feeb2ed099406e17a3fe548bae580f978f5cd94a7f55f28687c81d9042c",
        "8e50e51aae34e3657a6a2d9d90fc546025512f2678b083e824a5cc0f8457ee5f",
        ["learncoding_app"],
      ],
    ],
    [
      "public.attest_email_outbox_delivery_release_lineage(text)",
      [
        "5963663f65d5be7e4e44c1ab1b1daa17a04d4bd711a9af9abc5bf2d1bb62bd91",
        "261d8137a8ad635af563b6e5478ad3ebc7579c68c5693ff87a7e2fe517e5dbbf",
        ["learncoding_worker"],
      ],
    ],
    [
      "public.enforce_email_outbox_delivery_release_commit_exact()",
      [
        "27f8e42eb07338f1a543c7aec686c75d393a3fb7fb75501e576172ddf635c144",
        null,
        [],
      ],
    ],
    [
      "public.enforce_mail_delivery_release_receipt_delete_exact()",
      [
        "39aa24c40d6dc950b15722006552a3180a80ad1345bc6450e7880a500129f0b6",
        null,
        [],
      ],
    ],
    [
      "public.enforce_email_outbox_delivery_release_delete_exact()",
      [
        "81f7777b8fa44b02aa45f2d92a5a6219c15109a8b99eabab9ecff1190cf3e8df",
        null,
        [],
      ],
    ],
    [
      "public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)",
      [
        "ac406b4dff127c10f791267c1464faddbe93e8ce88faa0a52c215881ac1b7480",
        "30138cd5d305d74407dc3f294177d4ea9fa7155672d1dcf089b44fe010dd2b59",
        [],
      ],
    ],
    [
      "public.enqueue_backup_status_mail_authority(text,text)",
      [
        "2cc0bf920b31af64566f1eb0352bd63f078bcccab3d064748ba5af226805c81b",
        "6d944b1dd9ef5cfaa4371d204569f27134bf2431dd61a078b0722a3a782da6b6",
        ["learncoding_backup_reporter"],
      ],
    ],
    [
      "public.enforce_email_outbox_provider_request_body_immutable()",
      [
        "a7a9a6c120a0e32410e620bb745d65b53d0d0b8429467faf74e8c62c08cc5b5f",
        "ca95ebd3100dca787652477a7d0a3b63282a616777b44069557f503a7952a0f2",
        [],
      ],
    ],
    [
      "public.enforce_email_outbox_delivery_hold()",
      [
        "7636ab37cc17692c0c31d160dc5d7f0421d6660c0da2dfb6a2d8cae4501ea4e1",
        "8504298d876a6fe1256f13441fe84681d0f8f47fe29cac2d42763c068e98ee7d",
        [],
      ],
    ],
    [
      "public.enforce_email_outbox_payload_immutable()",
      [
        "fa3762c9faff6d8c6c3b6f1f67483ba9a888a02cfff32b29b04d6b8603e7c9fe",
        "a29a285813afa8d466198900f29680f46be35ec4c511fbcf656c78fcb9b21844",
        [],
      ],
    ],
  ]);
  assert.deepEqual(
    guarded.map(({ signature }) => signature).sort(),
    [...expected.keys()].sort(),
  );
  for (const routine of guarded) {
    assert.deepEqual(
      [routine.bodySha256, routine.definitionSha256, routine.allowedRoles],
      expected.get(routine.signature),
      routine.signature,
    );
  }

  const hash = guarded.find(({ signature }) =>
    signature.startsWith("public.mail_delivery_release_receipt_sha256("),
  );
  assert.equal(hash?.language, "sql");
  assert.equal(hash?.volatility, "i");
  assert.equal(hash?.strict, true);
  assert.equal(hash?.parallel, "s");
  const receiptInsert = guarded.find(
    ({ signature }) =>
      signature === "public.enforce_mail_delivery_release_receipt_insert()",
  );
  assert.equal(receiptInsert?.securityDefiner, false);
  const attestor = guarded.find(
    ({ signature }) =>
      signature === "public.attest_email_outbox_delivery_release_lineage(text)",
  );
  assert.equal(attestor?.volatility, "s");
  assert.equal(attestor?.returnsSet, true);
});

test("0069 has a distinct exact ALWAYS and constraint-trigger manifest", () => {
  const phase0069 = REVIEWED_MAIL_AUTHORITY_CATALOG_PHASES.find(
    ({ index }) => index === 69,
  );
  assert.equal(phase0069?.triggers, REVIEWED_0069_APPLICATION_TRIGGERS);
  assert.notEqual(phase0069?.triggers, REVIEWED_0068_APPLICATION_TRIGGERS);

  const byName = new Map(
    REVIEWED_0069_APPLICATION_TRIGGERS.map((trigger) => [
      trigger.name,
      trigger,
    ]),
  );
  for (const name of [
    "email_outbox_dispatch_binding_guard",
    "email_outbox_provider_correlation_evidence_guard",
    "email_outbox_delivery_release_insert_xid",
    "email_outbox_delivery_release_insert_xid_immutable",
    "zz_email_outbox_delivery_release_identity",
    "zz_email_outbox_delivery_release_insert_final",
    "email_outbox_provider_request_body_immutable",
    "email_outbox_delivery_hold",
    "email_outbox_delivery_hold_final",
    "mail_delivery_release_receipt_insert_authority",
    "mail_delivery_release_receipt_append_only",
    "mail_delivery_release_receipt_no_truncate",
    "email_outbox_delivery_release_commit_exact",
    "mail_delivery_release_receipt_delete_exact",
    "email_outbox_delivery_release_delete_exact",
  ]) {
    assert.equal(byName.get(name)?.enabled, "A", name);
  }
  assert.deepEqual(
    byName.get("email_outbox_delivery_release_insert_xid_immutable")
      ?.watchedColumns,
    [
      "delivery_release_insert_xid",
      "delivery_release_insert_system_identifier",
      "created_at",
    ],
  );
  assert.deepEqual(
    byName.get("email_outbox_provider_request_body_immutable")?.watchedColumns,
    [
      "provider_call_started",
      "provider_request_body_sha256",
      "provider_request_body_length",
    ],
  );
  assert.deepEqual(byName.get("email_outbox_delivery_hold")?.watchedColumns, [
    "id",
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
    "provider_request_body_sha256",
    "provider_request_body_length",
    "next_attempt_at",
    "sent_at",
    "quarantined_at",
    "last_error_code",
    "delivery_hold_version",
  ]);
  for (const [name, type] of [
    ["email_outbox_delivery_release_commit_exact", 5],
    ["mail_delivery_release_receipt_delete_exact", 9],
    ["email_outbox_delivery_release_delete_exact", 9],
  ]) {
    const trigger = byName.get(name);
    assert.equal(trigger?.type, type, name);
    assert.equal(trigger?.constraint, true, name);
    assert.equal(trigger?.deferrable, true, name);
    assert.equal(trigger?.initiallyDeferred, true, name);
  }
});

test("0069 backup authority contract freezes the internal and released wrappers", () => {
  assert.equal(BACKUP_STATUS_AUTHORITY_0069_CONTRACT.phase, 69);
  const bySignature = new Map(
    BACKUP_STATUS_AUTHORITY_0069_CONTRACT.routines.map((routine) => [
      routine.signature,
      routine,
    ]),
  );
  assert.equal(
    bySignature.has(
      "public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)",
    ),
    true,
  );
  assert.deepEqual(
    bySignature.get(
      "public.enqueue_backup_status_mail_authority_unreleased_0067(text,text)",
    )?.allowedRoles,
    [],
  );
  assert.deepEqual(
    bySignature.get("public.enqueue_backup_status_mail_authority(text,text)")
      ?.allowedRoles,
    ["learncoding_backup_reporter"],
  );
  assert.equal(
    bySignature.get("public.enqueue_backup_status_mail_authority(text,text)")
      ?.bodySha256,
    "2cc0bf920b31af64566f1eb0352bd63f078bcccab3d064748ba5af226805c81b",
  );
});
