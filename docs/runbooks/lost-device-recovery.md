# Lost-device recovery

Use this ceremony only when a learner cannot reach the one active browser profile. It revokes that session; it never signs the learner in, resets a password or TOTP, reveals an authenticator seed, or regenerates recovery codes.

## Learner proof

1. Direct the learner to `/lost-device`. Do not submit the form for them.
2. The public response is deliberately identical for unknown, ineligible, eligible, and eligible-but-internally-failed requests. Do not confirm account existence from operator logs or database state.
3. An eligible learner receives a 15-minute, single-use mailbox link. The server stores only its hash. The mail worker derives the bearer in memory, places it in a URL fragment so it is absent from HTTP/access logs, and never writes the expanded URL back to the outbox.
4. Consuming the proof establishes control of the already verified mailbox and binds the request to the existing learner and active session. It does not establish enough identity to revoke by itself.

## Independent administrator confirmation

Before approving, use one channel that was established independently of this request: an in-person conversation with the known learner, a live voice/video callback through a contact route already used for the cohort, or another pre-recorded operator procedure approved before the incident. A new phone number, address, link, or contact supplied in the recovery request is not independent evidence.

Do not use dashboard facts, learning history, email contents, security questions, passwords, TOTP codes, authenticator seeds, unused recovery codes, OAuth tokens, or provider keys as a challenge. Never ask the learner to send a secret. If no independent channel is available, reject the request and escalate to the product owner; do not improvise an MFA reset.

## Decision

1. Open the verified pending request from the learner detail page. Confirm it is marked `mailbox proof verified`; an incomplete proof must never be decisionable.
2. Compare the bounded device label and request time with the learner's account context. Treat discrepancies as a reason to stop, not as an automatic accusation.
3. Enter a reason that names the approved confirmation category (for example, `Known learner confirmed on pre-existing cohort video channel`) without copying contact details or secrets.
4. Complete fresh administrator TOTP and approve or reject. The server re-reads the durable MFA timestamp, audits allowed/denied/success outcomes, and rejects replay or concurrent state changes.
5. Approval revokes only the proof-bound session and archives token-free history. Rejection leaves it active. Both decisions notify the learner by durable in-app/email events.
6. The learner must then use the normal primary factor and TOTP or an unused recovery code on the new browser. A missing authenticator and missing recovery codes are a separate, still-unapproved lost-factor procedure.

## Incident checks

- Investigate repeated rate-limit events, proof failures, unexpected new-device notices, or a learner denying the request. Logs must contain only stable event/error codes, never email addresses or bearer values.
- Rotating `LOST_DEVICE_PROOF_KEY` invalidates outstanding links. Wait for the 15-minute window or issue a new request after expiry; never recover a raw proof from storage.
- Account deletion removes a proof-backed request before its `RESTRICT`-bound proof row, then removes token-free history. Do not bypass the account-deletion command with ad hoc SQL.
