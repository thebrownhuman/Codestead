# Revocable mail source authority

This contract covers ordinary account mail whose permission can disappear after the outbox row is written: password resets, lost-device proofs, pending session-revocation requests, inactivity v2 notices, and smart reminders. System access-request mail and post-deletion capability mail use separate authority contracts.

## Central integration sequence

The central PostgreSQL store must treat `parseRevocableSourceVariables(...) === null`, a missing source row, more than one source row, or a zero-row authority query as suppression. It must never reconstruct a permit from malformed evidence.

Within the provider-boundary transaction, take locks in this canonical order:

1. The canonical account-scope advisory lock or locks, ordered by their signed lock key.
2. The fenced `email_outbox` row.
3. All affected user rows in ascending user ID order. This includes both the learner and administrator for an inactivity administrator notice.
4. Source rows in this fixed table order: `verification -> lost_device_proof -> session -> session_revocation_request -> inactivity_episode -> consent_record -> notification_preference -> smart_reminder_dispatch`.

Do not infer lock order from SQL join order or from the alias list in `FOR SHARE`; the planner does not provide that guarantee. Acquire the rows explicitly in the sequence above, then execute the predicate returned by `buildRevocableSourceAuthorityQuery`. Hold the advisory lock, row locks, database connection, and transaction through the one bounded provider call and its terminal state write.

The reset predicate carries the exact `reset-password:<token>` identifier only as a parameter. Never interpolate, serialize, log, or attach that parameter to an error. The persisted envelope contains the stable verification row ID plus the pre-existing delivery URL; it does not add another bearer copy. For lost-device proof mail, derive the expected proof hash in memory and pass only that hash to the predicate.

## Producer and template bindings

- `reset-password` v1: stable Better Auth verification row ID; the row must still bind the exact URL token to the same user and remain unexpired.
- `lost-device-proof` v1: proof UUID; owner, proof hash, session owner, session liveness, consumption, and both expiries remain authoritative.
- `session-revocation-requested` v1: pending request UUID; recipient must still be the current active, unbanned administrator.
- inactivity templates v2: open episode UUID and policy version; current activity, latest disclosed consent, pause, stage marker, learner recipient, and administrator recipient are revalidated.
- smart-reminder templates v1: dispatch UUID, kind, local period, policy, current account email, learning-email preference, and kind preference are revalidated.

Every producer uses the corresponding `create*SourceVariables` constructor. The constructors return frozen, exact-key string records. `requireRevocableSourceVariables` converts malformed producer input into a bounded code without including the input. The central store still reparses database JSON because a privileged or historical writer is not trusted.

## Known producer atomicity limits

Better Auth creates the verification row before invoking `sendResetPassword`. The callback then resolves the exact unexpired row and inserts the outbox row in a separate transaction. That is not atomic: an enqueue failure can leave a live token without mail. It fails closed for delivery because an outbox row is never authorized without the exact live verification row, but repository-wide integration should not claim atomic source/outbox creation.

The authenticated session-revocation route creates or locates its request first, then writes in-app notices and outbox rows outside that source transaction. A later failure can leave a pending request without every administrator notice. It cannot authorize forged mail because the provider boundary revalidates the request and administrator, but the route should eventually move request creation, notification writes, and outbox writes into one database transaction.

The lost-device proof producer, verified lost-device revocation producer, inactivity scheduler, and smart-reminder scheduler write their source evidence and outbox effects in their existing database transaction. Their provider authority is still revocable and must be checked again at dispatch.
