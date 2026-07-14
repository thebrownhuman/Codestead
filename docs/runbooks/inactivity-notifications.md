# Inactivity notification operations

The email worker owns inactivity scheduling. Run `npm run worker:email`; the worker evaluates inactivity every `INACTIVITY_SCHEDULE_SECONDS` (default 60, allowed 10–3600) and then drains the transactional outbox. Run `npm run worker:email -- --once` for one scheduler/delivery pass during maintenance.

Policy `inactivity-2026-07.v2` is exact:

- 24 hours after the last meaningful activity: queue one generic learner reminder and one separate generic administrator notice.
- 72 hours after that activity: queue one final generic learner reminder. If the first reminder was operationally delayed, preserve at least 48 hours between learner reminders.
- Queue nothing else in that episode. Authoritative meaningful activity closes it; login, heartbeat, page view, ordinary chat, and replay do not.
- Require the latest `inactivity_mentor_notice` acknowledgment at the current enrollment-disclosure version before opening or delivering an episode.

The scheduler uses an advisory transaction lock, a unique open-episode index, and deterministic outbox keys. Multiple worker instances are safe, although one worker is sufficient for this pilot. Episode and outbox markers commit together. Do not manually reset queue timestamps to retry delivery; repair the terminal outbox row under the email incident procedure.

Quiet hours default to 22:00–08:00 in the learner's stored IANA timezone. The start is inclusive and the end exclusive. Equal start/end means quiet all day; disable the switch for no quiet hours. Invalid legacy timezone values safely use UTC and should be corrected in the learner profile. UTC is used for all persisted timestamps.

An administrator may pause for at most 30 days through `PATCH /api/admin/learners/{publicId}/inactivity-preference` with `expectedVersion`, an offset timestamp `pausedUntil` (or `null` to resume), and an 8–500 character reason. The mutation requires fresh MFA, creates pre/success audit events, uses optimistic concurrency, and notifies the learner in-app without the private reason. Do not edit the table directly during normal operation.

Operational checks:

1. Confirm exactly one active administrator and that the email worker reports `inactivity.schedule` events.
2. Inspect counts/statuses, not message variables: `email_outbox.template`, `status`, `attempt_count`, and timestamps are sufficient.
3. Alert on `adminUnavailable > 0`, a stopped worker, repeated outbox failures, or a host clock/time-sync fault.
4. Never place scores, mistakes, code, chat, provider details, API keys, raw study hours, learner identity in the administrator email, or an administrator pause reason in email.
5. After recovery, run one `--once` pass. Idempotency prevents duplicates. A first reminder recovered after the 72-hour point will not be paired with the final reminder in the same pass.

Before pilot launch, record a synthetic 24h/72h delivery, quiet-hour deferral, pause/resume audit, duplicate-worker test, Gmail bounce behavior, and meaningful-activity reactivation in the deployment evidence log.
