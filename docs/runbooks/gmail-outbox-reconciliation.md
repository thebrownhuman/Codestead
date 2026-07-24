# Gmail outbox reconciliation

Use this procedure only for an `email_outbox` row that is quarantined after
the Gmail provider boundary with no `provider_message_id`. The command never
sends mail.

## Prerequisites

- Use the production database role and environment used by the mail worker.
- Set `MAIL_ADAPTER=gmail` and explicitly set
  `GMAIL_RECONCILIATION_ENABLED=true` for the operator session.
- Set the non-secret `GMAIL_OAUTH_SCOPES` declaration to the exact comma- or
  space-separated scopes granted to the Gmail refresh token. Operator startup
  validates this contract before opening the database or calling Gmail.
- For the least-privilege combined sender/reconciliation grant, declare
  `https://www.googleapis.com/auth/gmail.send` plus
  `https://www.googleapis.com/auth/gmail.readonly`.
- The gate also accepts `https://www.googleapis.com/auth/gmail.modify` or
  `https://mail.google.com/`, although both are broader. It rejects
  `gmail.send` alone and `gmail.metadata`: Gmail does not permit the required
  `q` search parameter with the metadata-only scope. See Google's
  [messages.list authorization contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list).
- The declaration must match the provider-side grant; it never expands the
  refresh token's privileges. Keep that token restricted to the sender mailbox.
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

If the database commit acknowledgement is lost, rerun the same confirmed
command. An exact terminal Gmail row returns `already-applied` without another
Gmail lookup or database update.

## Retention warning

Unresolved provider-started rows must retain durable scope and idempotency
evidence. The current general quarantined-mail retention path must exclude
rows with a provider boundary and no provider ID, or replace them with a
durable redacted authority tombstone, before destructive retention is safe.
