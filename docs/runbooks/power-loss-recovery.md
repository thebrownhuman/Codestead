# Power-loss recovery runbook

Use this runbook for a controlled reboot, an unexpected NUC restart, or the supervised AC-loss release gate. It covers automatic service recovery and evidence collection; it is not a substitute for restoring a damaged disk. The NUC has no UPS, so claims begin only after the server or browser has durably acknowledged a record.

## Fixed recovery contract

- Firmware setting **Restore on AC Power Loss: Power On** is enabled and recorded outside the NUC.
- Docker, libvirt, Cloudflare Tunnel, and the reviewed Codestead systemd units are enabled at boot.
- The `codestead-runner` VM domain attaches to the libvirt `default` network on bridge `virbr0`. The reviewed reservation is host `192.168.122.1`, guest `192.168.122.12`, MAC `52:54:00:20:00:12`.
- `/etc/learncoding/existing-containers.txt` is the pre-Codestead inventory of other running NUC services. It is a non-empty regular file owned by `root:root` with mode `0600`.
- `/etc/learncoding/active-release.env` selects immutable, hash-addressed managed-container and application-image records. Never hand-edit those release records.
- `/mnt/learncoding-backups` is a mounted, encrypted, separate physical disk with a current successful backup marker.
- `learncoding-recovery-check.timer` runs a bounded aggregate check after boot and every 15 minutes. Failure invokes the reviewed alert unit.

Do not enable the timer until the baseline creation procedure in [Deployment](../deployment.md#capture-the-pre-existing-container-recovery-baseline) has succeeded.

## Verify the boot prerequisites

Run these commands from the trusted NUC. They print service, network, and file metadata only; they do not print application secrets:

```bash
sudo stat -c '%F %U:%G %a %n' /etc/learncoding/existing-containers.txt
sudo test -s /etc/learncoding/existing-containers.txt
sudo virsh --connect qemu:///system net-info default
sudo virsh --connect qemu:///system dominfo codestead-runner
sudo virsh --connect qemu:///system domifaddr codestead-runner --source agent --full
sudo systemctl is-enabled docker.service libvirtd.service learncoding-compose.service \
  learncoding-recovery-check.timer
sudo systemctl is-active docker.service libvirtd.service learncoding-compose.service
sudo systemctl is-active learncoding-runner-firewall.service
```

Required results:

- the baseline is a regular `root:root` file at mode `600`, is non-empty, and every secret-free record matches the running container’s immutable image ID, configuration fingerprint, approved restart policy, and required health state;
- the `default` network is active, persistent, and autostarted on `virbr0`;
- the `codestead-runner` domain is active and autostarted, and its guest-agent address is `192.168.122.12`;
- Docker, libvirt, the host firewall, and the Codestead Compose unit are active; and
- the recovery timer is enabled.

A missing or different value is a hard stop. Do not create a second libvirt network, change the guest address, bypass the firewall, or add a failed container to the baseline.

## Run the bounded recovery check

The timer invokes the same production entrypoint as this manual check:

```bash
sudo /opt/learncoding/infra/ops/check-recovery.sh
```

Success is exit status zero and one bounded JSON object with `schemaVersion: 1`, `recovered: true`, `timedOut: false`, every health field true, and equal `existingContainersExpected` and `existingContainersRunning`. The checker has a 900-second global deadline. It validates Docker and every pre-existing container’s image/configuration/restart/health identity, PostgreSQL durability, managed app/workers, the tunnel and public HTTPS path, timers, nftables policy, libvirt, and the signed two-slot runner response.

Do not pipe a failure through a command that hides the checker exit status. Do not retry repeatedly until a transient green result appears; retain the first failure time and investigate it.

## Unexpected restart triage

After reconnecting, record the UTC time and boot identity, then inspect only bounded operational status:

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
cat /proc/sys/kernel/random/boot_id
sudo systemctl status --no-pager --full learncoding-compose.service \
  learncoding-recovery-check.service learncoding-recovery-check.timer
sudo journalctl -b -u learncoding-compose.service -u learncoding-recovery-check.service \
  --since -20m --no-pager
sudo docker compose --env-file /etc/learncoding/compose.env \
  -f /opt/learncoding/compose.yaml ps --all
sudo virsh --connect qemu:///system net-info default
sudo virsh --connect qemu:///system dominfo codestead-runner
```

Then run `check-recovery.sh` once. If it passes within 15 minutes of restored power and public HTTPS is healthy, retain the aggregate result with the incident record. If it fails:

1. Keep public learner access closed if state is uncertain.
2. Identify the failed aggregate health field and inspect only its reviewed service logs.
3. Confirm the backup mount and latest success marker before any repair.
4. Never run `docker compose down -v`, delete volumes, rerun bootstrap, improvise reverse SQL, or weaken PostgreSQL durability.
5. Never edit `existing-containers.txt` to conceal a pre-existing service that failed to return.
6. If storage or database integrity is uncertain, stop ordinary recovery and follow [Backup and restore](backup-and-restore.md).

## Supervised physical AC-loss gate

This is the final human-supervised release gate, not routine testing. Announce the maintenance window, use dedicated rehearsal learner/admin accounts, confirm a same-day verified local and offsite recovery point, and ensure no real learner exam or unrelated administrator mutation is active. One operator physically removes/restores AC; a second observer keeps the private event ledger and reads a synchronized UTC clock.

### Reviewed two-request hold controller

The root-only controller arms exactly one bounded event for exactly two distinct active learner accounts. Each learner then submits one ordinary authenticated practice run in the real UI. The API durably creates the normal admission and immutable dispatch snapshot, claims that learner's pre-authorized slot, and returns only the local request ID, submission ID, and safe slot state **without crossing the remote runner boundary**. The internal event and runner-job IDs remain available only through the root-only controller. An active event continues to hold its exact rows even after expiry; it never silently dispatches. The operator must explicitly release a filled, unexpired event or abort an empty, partial, or full event.

The controller runs only as UID/EUID 0 in the reviewed production operations image. It verifies the active administrator and both learner roles inside a serialized PostgreSQL transaction, appends the immutable audit chain in that transaction, and prints only safe IDs, states, and timestamps. It never prints email, source, request bodies, credentials, or the operator justification. Direct SQL writes, gateway races, process suspension, fixture rows, and manual queue rewinds remain forbidden.

Set these variables to internal database user IDs from the approved private rehearsal-account record. Do not use email addresses. Generate UUIDs on the NUC and arm the event once:

```bash
admin_id='ACTUAL_ACTIVE_ADMIN_INTERNAL_ID'
learner_one_id='ACTUAL_ACTIVE_REHEARSAL_LEARNER_INTERNAL_ID_1'
learner_two_id='ACTUAL_ACTIVE_REHEARSAL_LEARNER_INTERNAL_ID_2'
runner_event_id="$(tr -d '\n' </proc/sys/kernel/random/uuid)"

sudo /opt/learncoding/infra/ops/runner-power-rehearsal-control.sh arm \
  --actor-id "$admin_id" \
  --event-id "$runner_event_id" \
  --learner-one-id "$learner_one_id" \
  --learner-two-id "$learner_two_id" \
  --reason 'Supervised physical power-loss recovery rehearsal for the pilot release.' \
  --expires-in-minutes 120
```

Require exit status zero, the exact event ID, `state: "armed"`, `expired: false`, two distinct learner IDs, and both slots `bound: false`. If the command fails, an old event is active, either account is ineligible, or the output differs, record `EXT-PHYSICAL-AC-LOSS = NOT_RUN`; do not submit runner markers.

In two separately authenticated browser profiles, have learner one and learner two each submit one harmless bounded practice run through the ordinary production Code lab or lesson UI. A held response must report `status: "rehearsal_held"`, the expected learner slot, request ID, and submission ID. It must not expose the event ID or runner-job ID, and it must not claim compile or run output. Then inspect the root-only safe status:

```bash
sudo /opt/learncoding/infra/ops/runner-power-rehearsal-control.sh status \
  --actor-id "$admin_id" \
  --event-id "$runner_event_id"
```

Require `state: "filled"`, `expired: false`, and exactly two `bound: true` slots with distinct request/submission/job IDs. Match each controller request/submission pair to its browser response; obtain the internal runner-job IDs only from this controller output. Copy only those IDs and states to the private ledger. If zero or one slot is bound, a response crossed the remote boundary, a browser request/submission ID differs from controller status, the event expired, or status is not filled, abort and record `NOT_RUN` **before** removing AC:

```bash
abort_command_id="$(tr -d '\n' </proc/sys/kernel/random/uuid)"
sudo /opt/learncoding/infra/ops/runner-power-rehearsal-control.sh abort \
  --actor-id "$admin_id" \
  --event-id "$runner_event_id" \
  --command-id "$abort_command_id" \
  --reason 'Abort the supervised power-loss gate because both exact runner holds were not ready.'
```

An abort must report `state: "aborted"`, `successfulRehearsal: false`, and `recoveryJobsMadeDue` equal to the number of bound slots. It releases only those existing rows to the normal recovery worker. If abort cannot confirm that state, keep public access closed and investigate; do not create another event.

After the actual cut, restored power, and successful bounded boot check, release the filled event exactly once with a new command UUID. Repeating the identical command is an idempotent status replay; reusing its UUID with changed input fails closed:

```bash
release_command_id="$(tr -d '\n' </proc/sys/kernel/random/uuid)"
sudo /opt/learncoding/infra/ops/runner-power-rehearsal-control.sh release \
  --actor-id "$admin_id" \
  --event-id "$runner_event_id" \
  --command-id "$release_command_id" \
  --reason 'Release both exact runner holds to recovery after restored power and the bounded boot check.'
```

Require `state: "released"`, `recoveryJobsMadeDue: 2`, both original bound slot IDs, and `expired: false`. Release updates the two existing jobs to immediate recovery eligibility; it does not create, replace, or directly execute a queue row. A release response is **not** proof that the physical gate passed.

Decision boundary:

- Before AC removal, missing tooling, an arm/hold/status/abort error, an expired event, a remote dispatch, an incomplete pair, or any ID mismatch is `NOT_RUN`. Abort any confirmed bound rows and stop.
- After AC removal, a readiness timeout, missing marker, release/recovery error, duplicate effect, or evidence failure is `FAIL`, not `NOT_RUN` and not a reason to start a new event.
- `PASS` is allowed only after every acceptance item at the end of this runbook is satisfied with the original two IDs. Repository tests and a controller `released` state alone can never produce `PASS`.

### 1. Open the event and capture the healthy technical baseline

Record the final Git commit/tree, release manifest hash, image digests, VM identity, firmware setting, operator, observer, approved window, dedicated account IDs, and the existing-container baseline hash in the private ledger. Then capture the healthy pre-boot evidence before intentionally holding any queue worker:

```bash
sudo install -d -o root -g root -m 0700 /var/lib/learncoding/recovery-evidence
event="hardcut-$(date -u +%Y%m%dT%H%M%SZ)"
marker_started_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'event_id=%s\nmarker_started_utc=%s\n' "$event" "$marker_started_utc"
sudo /opt/learncoding/infra/ops/capture-recovery-evidence.sh pre \
  "/var/lib/learncoding/recovery-evidence/${event}.pre.json"
```

The pre collector must pass once. Do not repeatedly retry until it turns green. Preserve its checksum and boot ID.

### 2. Create and identify every server-side marker

Use the real production UI/API with the dedicated rehearsal accounts. Keep browser DevTools Network **Preserve log** enabled, but keep cookies, bodies, learner text, email addresses, and tokens out of the operator record.
Do not start account deletion for either rehearsal account while the controller is `armed` or `filled`: deletion fails closed until the root operator completes `release` or `abort`. Deleting either account later removes the terminal controller row before its submission/job references; retain the separate sanitized external-gate record required below.

1. In a published lesson, enter a unique private draft marker containing the event ID. Wait for the exact UI state `Saved to Codestead.` Capture the `PUT /api/drafts` request UUID and returned draft ID/row version.
2. Start and submit one harmless practice attempt with a new stable `idempotencyKey` that is recorded in the private ledger. Capture that exact key, the attempt ID returned by `POST /api/learning/attempts`, and its terminal submit status. Record any resulting reward-ledger count; do not create a second attempt to make a failed check look green.
3. Change one harmless notification preference on the rehearsal learner and leave that value in place. Capture the returned row version. This real operation creates the `notification_preferences.updated` audit marker; identify it with the read-only query below.
4. After the healthy pre snapshot, stop only the Codestead mail worker, then use the ordinary Forgot Password flow once for the rehearsal learner. This leaves one real outbox item pending without editing the database:

   ```bash
   sudo docker compose --env-file /etc/learncoding/compose.env \
     -f /opt/learncoding/compose.yaml stop --timeout 30 mail-worker
   ```

   Capture the outbox ID and idempotency key with the read-only query. Never record `to_email`, reset URLs, or `variables`.
5. With the root controller already armed, submit one bounded, harmless production practice request from each eligible rehearsal learner, using two distinct stable `clientRequestId` UUIDs. Capture each held response's request ID, submission ID, and slot, then require controller status to be `filled` and unexpired. Match the two browser request/submission pairs to controller status and take the internal runner-job IDs only from that root-only output. Both existing rows must remain leased by the rehearsal hold immediately before the cut, with one row per request ID and no remote runner dispatch. If either hold is unavailable, mismatched, expired, or terminal, abort the event and mark the gate `NOT_RUN`; do not use SQL to manufacture or rewind state.

Set these shell variables from the actual responses and query results; never invent an ID:

```bash
learner_id='ACTUAL_REHEARSAL_LEARNER_ID'
draft_request_id='ACTUAL_DRAFT_REQUEST_UUID'
attempt_id='ACTUAL_ATTEMPT_UUID'
attempt_idempotency_key='ACTUAL_ATTEMPT_IDEMPOTENCY_KEY'
runner_request_1='ACTUAL_RUNNER_REQUEST_UUID_1'
runner_request_2='ACTUAL_RUNNER_REQUEST_UUID_2'
```

Run the following read-only transaction. It emits identifiers, state, hashes, and counts only:

```bash
sudo docker compose --env-file /etc/learncoding/compose.env \
  -f /opt/learncoding/compose.yaml exec -T postgres \
  psql --username=learncoding --dbname=learncoding --no-psqlrc \
    --set=ON_ERROR_STOP=1 --set=learner_id="$learner_id" \
    --set=draft_request_id="$draft_request_id" --set=attempt_id="$attempt_id" \
    --set=marker_started_utc="$marker_started_utc" \
    --set=runner_request_1="$runner_request_1" --set=runner_request_2="$runner_request_2" <<'SQL'
BEGIN TRANSACTION READ ONLY;
SELECT 'draft' AS marker, d.id, d.row_version, m.request_id,
       m.resulting_row_version, count(*) OVER () AS matching_rows
  FROM learner_draft_mutation m
  JOIN learner_draft d ON d.id = m.draft_id
 WHERE d.user_id = :'learner_id'
   AND m.request_id = :'draft_request_id'::uuid;
SELECT 'progress' AS marker, a.id, a.status, a.passed,
       count(r.id) FILTER (WHERE r.event_kind = 'grant') AS reward_grants,
       coalesce(sum(r.xp_delta), 0) AS xp_delta
  FROM attempt a
  LEFT JOIN reward_ledger r ON r.attempt_id = a.id
 WHERE a.user_id = :'learner_id' AND a.id = :'attempt_id'::uuid
 GROUP BY a.id, a.status, a.passed;
SELECT 'audit' AS marker, id, correlation_id, event_hash, outcome,
       count(*) OVER () AS matching_rows
  FROM audit_event
 WHERE actor_user_id = :'learner_id'
   AND action = 'notification_preferences.updated'
   AND occurred_at >= :'marker_started_utc'::timestamptz
 ORDER BY occurred_at, id;
SELECT 'mail' AS marker, id, idempotency_key, status, attempt_count, sent_at,
       count(*) OVER () AS matching_rows
  FROM email_outbox
 WHERE user_id = :'learner_id' AND template = 'reset-password'
   AND created_at >= :'marker_started_utc'::timestamptz
 ORDER BY created_at, id;
SELECT 'runner' AS marker, s.request_id, s.id AS submission_id,
       j.id AS runner_job_id, s.status AS submission_status,
       j.status AS runner_status, j.recovery_state,
       (j.dispatch_request IS NOT NULL) AS dispatch_snapshot_present,
       (j.lease_owner IS NULL) AS remote_runner_job_absent,
       count(*) OVER (PARTITION BY s.request_id) AS rows_for_request
  FROM code_submission s
  JOIN runner_job j ON j.submission_id = s.id
 WHERE s.request_id IN (:'runner_request_1', :'runner_request_2')
 ORDER BY s.request_id;
COMMIT;
SQL
```

Require exactly one draft receipt, one progress attempt, one audit event, one pending mail row with `attempt_count = 0`, and exactly two runner rows with `rows_for_request = 1`. For both runner rows, require both runner and submission statuses `leased`, `recovery_state` equal to `ready`, `dispatch_snapshot_present` true, and `remote_runner_job_absent` true. Any different value means the remote boundary may have been crossed: abort the event and record `NOT_RUN` before AC removal. Copy only the printed identifiers/state/counts into the private marker ledger.

### 3. Create both browser-durable outbox markers and close/reopen

Use one named, persistent browser profile on the same device that will be reopened after recovery. Load the lesson and a dedicated rehearsal learner's non-production exam session while online. Then switch DevTools Network to **Offline** before editing.

Before switching Offline, inspect the scoped records in database `codestead-browser-outbox-v1`, object store `entries`, and require zero lesson/exam records for these rehearsal scopes. If old records exist, keep the browser Online and let the supported UI reconcile them; do not delete them in DevTools or start the gate until a close/reopen still shows zero.

1. Edit the lesson draft and wait for the exact state `Saved locally on this browser. Codestead will retry automatically.`
2. Edit one rehearsal exam answer and wait for the exact state `Saved locally; Codestead will retry.` Do not submit or finalize the exam.
3. In DevTools Application, inspect database `codestead-browser-outbox-v1`, object store `entries`. Record only the lesson record's `requestId`, the exam record's `clientMutationId`, the exam session/item IDs, and that there is exactly one record of kind `draft` and one of kind `exam-answer`. Do not copy `payload`, draft text, answer text, namespace, cookies, or screenshots containing them.
4. Close every window of that browser, reopen the same persistent profile while Network remains Offline, and verify the same two IDs and local values reappear before any request is sent. Close the browser again before the cut.

A missing record, an IndexedDB error, a changed ID, or a UI claim made before the IndexedDB transaction completes is `FAIL`.

### 4. Perform the physical cut and record the two timing observations

Confirm the private ledger is complete, all marker IDs are distinct where required, the mail row is still pending, and both runner rows still have the exact pre-cut pristine values required in step 2; “non-terminal” alone is insufficient. Confirm no real learner activity is occurring. Record the UTC cut time, then the administrator physically removes AC. A software reboot, CI job, VM reset, or switched network connection is not a substitute.

When AC is restored, the observer records `power_restored_utc` from an independently synchronized clock at the **first successful firmware power-on**. Do not reconstruct it later from host `date`, `/proc/uptime`, journal timestamps, or the collector. The value must be canonical UTC such as `2026-07-20T10:15:00Z`.

From an approved external device, observe the public `/health/ready` endpoint. At the first successful HTTPS 200 response whose JSON status is `ready`, immediately record `public_ready_utc` from the same synchronized clock. If no success occurs within 900 seconds of `power_restored_utc`, the gate is `FAIL` even if the site later recovers.

### 5. Reconcile exact effects before post capture

Reconnect without manually bypassing systemd or changing the release. Run the bounded checker once:

```bash
sudo /opt/learncoding/infra/ops/check-recovery.sh
```

Restore `admin_id` and `runner_event_id` from the private ledger, generate a fresh `release_command_id`, and execute the exact `release` command documented above. Require the original event and both slot IDs, `state: "released"`, `recoveryJobsMadeDue: 2`, and `expired: false`. A different or indeterminate response is `FAIL`; do not start a replacement event.

Before allowing browser synchronization, reopen the same persistent profile with Network still Offline. Require the exact pre-cut lesson `requestId` and exam `clientMutationId` and their local values. Then switch Online and:

- wait for both exact records to reach `Saved to Codestead.`;
- require the matching `entries` records to be removed only after acknowledgment;
- close/reopen once more and require the server values to remain while those two outbox records stay absent;
- replay `POST /api/learning/attempts` with the exact original body and `idempotencyKey`; require `idempotent: true` and the original attempt ID rather than a new row;
- replay each ambiguous runner request with its identical body and original `clientRequestId`; require the same submission/job identities rather than new rows; and
- confirm the mail worker recovered automatically and the single reset message reached the controlled mailbox once. Record only the provider message ID/hash, not subject/body/address.

Restore `marker_started_utc`, `learner_id`, `draft_request_id`, `attempt_id`, `attempt_idempotency_key`, `runner_request_1`, and `runner_request_2` from the private ledger in the new shell, then repeat the exact read-only SQL transaction from step 2. Require one row for every original idempotency key, both runner jobs terminal/reconciled under their original IDs, no second reward grant, one unchanged audit-event hash, one mail row now sent, and no duplicate XP, email, assessment, draft, or evidence effect. Any indeterminate result is `FAIL`; never retry with a new ID.

### 6. Take the immediate verified encrypted backup, then capture post evidence

Reconciliation must finish first. Start the reviewed backup unit immediately and require its successful result; the post collector will independently require a newer marker than the pre evidence, hash the referenced encrypted archive, and recheck the separate disk and SMART state:

```bash
sudo systemctl start learncoding-backup.service
test "$(sudo systemctl show --property=Result --value learncoding-backup.service)" = success
sudo test -s /mnt/learncoding-backups/state/local-last-success.env
```

Restore the exact event and the two manually observed UTC values in the new shell. Missing, malformed, future-dated, reversed, clock-inconsistent, or more-than-900-second observations cause the collector to fail without publishing a post pair:

```bash
event='hardcut-YYYYMMDDTHHMMSSZ'
power_restored_utc='YYYY-MM-DDTHH:MM:SSZ'
public_ready_utc='YYYY-MM-DDTHH:MM:SSZ'
sudo /opt/learncoding/infra/ops/capture-recovery-evidence.sh post \
  "/var/lib/learncoding/recovery-evidence/${event}.post.json" \
  "$power_restored_utc" \
  "$public_ready_utc"
sudo /usr/bin/env EVENT_ID="$event" /usr/bin/bash -ceu '
  cd /var/lib/learncoding/recovery-evidence
  /usr/bin/sha256sum --check -- \
    "${EVENT_ID}.pre.json.sha256" \
    "${EVENT_ID}.post.json.sha256"
'
```

The post JSON binds `operatorObservedPowerRestoredAtUtc`, `operatorObservedPublicReadyAtUtc`, and `publicReadinessSecondsFromPowerRestoration`; `targetSeconds` is `900`. It also records `collectorVerifiedPhysicalPowerCycle: false` because software cannot prove that a person removed AC.

The collector publishes append-only JSON and checksum files only after every technical check passes. It requires a changed boot ID, a newer current backup marker, healthy separate storage, exact release/image/container evidence, healthy timers/firewalls, and a healthy runner guest. It deliberately excludes secrets, learner source, runner journals, email content, and raw application data.

## Acceptance and evidence boundary

The gate passes only when all of the following are recorded:

- the pre and post checksum verification succeeds;
- the bound operator observations show public readiness no later than 900 seconds after first successful firmware power-on;
- every baseline and managed container is healthy with its reviewed image;
- PostgreSQL durability, filesystems, SMART, and the public HTTPS path are healthy;
- the runner domain, guest agent, firewall, exact runtime record, and signed two-slot health are healthy;
- the pre-cut runner query proves both exact held rows were leased with durable snapshots, `recovery_state = ready`, and no remote runner identity;
- the acknowledged draft/progress/audit markers and both browser-local markers survive;
- the original mail and two runner requests reconcile under their original identities;
- exact counts prove no duplicate XP, email, assessment, draft, audit, runner, or evidence effect; and
- the immediate encrypted backup completes, advances the success marker, and is bound into post evidence.

The JSON proves technical consistency of manually supplied observations; it does not prove operator identity, clock custody, a physical power cut, browser actions, or external delivery. Keep observer/approver identities, announcement, cut/restoration/readiness observations, firmware setting, marker ledger, redacted query output, provider receipt, and artifact hashes in the private external-gate record. Never claim this gate passed from CI, a synthetic test, a normal reboot, repository fixtures, or fabricated timestamps.

## Changing the pre-existing inventory

Change `/etc/learncoding/existing-containers.txt` only after an intentional, reviewed change to the non-Codestead services. Use a maintenance window, stop the Codestead Compose stack, make every retained pre-existing service healthy, then run `sudo /usr/bin/python3 -B /opt/learncoding/infra/ops/capture-existing-containers.py --replace`. Restart Codestead and require `check-recovery.sh` to pass before reopening public access. Preserve the change reason and before/after aggregate counts; never place container inspection output or raw configuration in a public ticket.
