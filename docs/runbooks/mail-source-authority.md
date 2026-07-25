# Revocable mail source authority

This component covers ordinary account mail whose permission can disappear after an outbox row is written: password resets, lost-device proofs, pending session-revocation requests, inactivity v2 notices, and smart reminders. System access-request mail and post-deletion capability mail use separate contracts.

## Integration status

This component is not live authority. It supplies exact variable parsers, producer constructors, frozen in-memory lost-device evidence, parameterized SQL query plans, and a required lock-order specification. The production PostgreSQL store does not yet call these plans, so central TX1/TX2 integration is still pending. Current tests prove parsing and SQL shape; they do not prove that production acquires these locks, requires exactly one result, or suppresses revoked mail.

The shipped worker still calls the variables-only compatibility adapter. That adapter intentionally preserves the current runtime contract, but it does not consume the `authorityEvidence` envelope and therefore does not make the SQL plans authoritative.

## Required central integration sequence

The central PostgreSQL store must treat `parseRevocableSourceVariables(...) === null`, missing or forged lost-device evidence, a missing source row, more than one source row, or a zero-row authority result as suppression. It must never reconstruct a permit from malformed evidence.

Within the future provider-boundary transaction, acquire locks in this canonical order:

1. The canonical account-scope advisory lock or locks, ordered by their signed lock key.
2. The fenced `email_outbox` row.
3. All affected user rows in ascending user ID order. This includes both the learner and administrator for an inactivity administrator notice.
4. Source rows in this fixed table order: `verification -> lost_device_proof -> session -> session_revocation_request -> inactivity_episode -> consent_record -> notification_preference -> smart_reminder_dispatch`.

Do not infer lock order from SQL join order or an alias list in `FOR SHARE`; the planner does not provide that guarantee. Central integration must explicitly acquire rows in the sequence above, execute the query plan, require exactly one row, and hold the advisory lock, row locks, connection, and transaction through the bounded provider call and terminal write.

The reset query carries the exact `reset-password:<token>` identifier only as a parameter. Never interpolate, serialize, log, or attach that parameter to an error. Lost-device materialization returns one frozen envelope containing the rendered variables and opaque authority evidence computed from the same raw proof. Central dispatch must keep that envelope intact; it must not accept a caller-supplied proof hash or persist the evidence.

## Producer and template bindings

- `reset-password` v1: stable Better Auth verification row ID; the exact token row, owner, expiry, current email, and rendered live-user name are checked.
- `lost-device-proof` v1: proof UUID plus opaque in-memory evidence; owner, exact proof hash, session owner/liveness, consumption, expiries, current email, and rendered live-user name are checked.
- `session-revocation-requested` v1: pending request UUID and current active, unbanned administrator. Device wording is fixed generic copy because the schema has no immutable device-label evidence; mutable labels cannot become delivery authority.
- inactivity templates v2: open episode UUID and policy version; canonical current consent, activity, pause, coherent non-future stage markers, direct 48-hour separation between the durable learner markers, and learner/administrator recipient policy are checked.
- smart-reminder templates v1: dispatch UUID, kind, policy, current email/preferences, and stored timezone are checked.

For smart reminders, the period key is the immutable dispatch-time local period derived from `scheduled_for` in the dispatch row's stored IANA timezone. The query recomputes that key through `pg_timezone_names`; a timezone change revokes the queued reminder because the stored dispatch timezone must still equal the current preference timezone. Retries remain tied to the original dispatch period rather than being relabeled as the worker's current period. Date and ISO-week variables must represent real calendar periods.

Every producer uses its corresponding `create*SourceVariables` constructor. Constructors return frozen exact-key records, and `requireRevocableSourceVariables` replaces malformed producer input with a bounded non-sensitive error. Central integration must still reparse persisted JSON because historical or privileged writers are not trusted.

## Known producer atomicity limits

Better Auth creates the verification row before invoking `sendResetPassword`. The callback resolves that exact unexpired row and inserts the outbox row in a separate transaction. An enqueue failure can therefore leave a live token without mail. This does not provide live delivery authority until central integration is complete.

The authenticated session-revocation route creates or locates its request first, then writes in-app notices and outbox rows outside that source transaction. A later failure can leave a pending request without every administrator notice. The route should eventually move request creation, notification writes, and outbox writes into one database transaction.

The lost-device proof producer, verified lost-device revocation producer, inactivity scheduler, and smart-reminder scheduler write their source evidence and outbox effects in their existing database transaction. Their revocation checks still depend on the pending central TX1/TX2 integration described above.
