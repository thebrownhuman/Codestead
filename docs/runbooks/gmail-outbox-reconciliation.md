# Gmail outbox reconciliation

Use this procedure only for an `email_outbox` row that is quarantined after
the Gmail provider boundary with no `provider_message_id`. The command never
sends mail.

## Prerequisites

- Use the production database role and environment used by the mail worker.
- Set `MAIL_ADAPTER=gmail` and explicitly set
  `GMAIL_RECONCILIATION_ENABLED=true` for the operator session.
- The Gmail refresh token must authorize message list and metadata reads.
  A send-only token is insufficient. Do not use the `gmail.metadata` scope:
  Gmail does not permit the `q` search parameter with that scope. Use an
  approved read/modify/mail scope and keep the token restricted to the
  application sender mailbox.
- Obtain the immutable outbox `operation_id` through an approved database
  operator channel. Do not paste it into tickets or logs.

## Inspect without mutation

```text
npm run worker:email:reconcile -- --operation-id <operation-uuid>
```

The command first verifies the exact quarantined database fence. It then runs
one Gmail `rfc822msgid:<Message-ID>` search limited to two `SENT` messages. A
sole result is fetched once as metadata and must retain both the exact
`Message-ID` and the `SENT` label. Output contains only the outcome, never the
operation ID, correlation Message-ID, recipient, or Gmail provider ID.

`not-found` is not proof that Gmail did not accept the send. Search visibility
can lag. `not-found`, `ambiguous`, and failed verification leave the row
quarantined and must never trigger a resend.

## Apply a unique verified match

Repeat the same operation ID as an explicit mutation confirmation:

```text
npm run worker:email:reconcile -- --operation-id <operation-uuid> --apply --confirm-operation-id <same-operation-uuid>
```

The final update reacquires the same account/system delivery-scope advisory
lock and compare-and-sets the complete observed fence: row and operation IDs,
claim generation and owner/token state, scope, lease, provider-boundary time,
quarantine time, adapter, and error code. It persists and verifies the Gmail
provider ID before marking the row sent. A changed fence returns `fence-lost`
and performs no update.

## Retention warning

Unresolved provider-started rows must retain durable scope and idempotency
evidence. The current general quarantined-mail retention path must exclude
rows with a provider boundary and no provider ID, or replace them with a
durable redacted authority tombstone, before destructive retention is safe.
