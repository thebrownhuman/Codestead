# Codestead Backup and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every published Codestead backup crash-consistent, decrypt-verified, recoverable from Google Drive, and sufficient to restore encrypted provider credentials without keeping the disaster-recovery private identity on the NUC.

**Architecture:** Nightly backup enters a bounded maintenance window, stops only database-mutating application services, captures PostgreSQL and application objects as one recovery point, validates plaintext structure, encrypts to the offline recovery recipient plus an ephemeral verification recipient, decrypts and validates the candidate, and only then atomically publishes it and advances a success marker. Daily offsite upload has its own persistent systemd timer and publishes a remote success marker only after downloading and checksum-verifying the uploaded bytes. A separate fail-closed remote-retention transaction applies 7 daily/4 weekly/12 monthly selection without weakening or rolling back publication. Restore drills download the marked recovery point into an isolated PostgreSQL topology and prove schema, object, and credential-master-key recovery without modifying production.

**Tech Stack:** Bash 5, Docker Compose 5, PostgreSQL 17 tools, age/age-keygen, rclone Google Drive backend, systemd, Node.js/TypeScript, Vitest, shell integration tests.

## Global Constraints

- Retain 7 daily, 4 weekly, and 12 monthly recovery points in both the local archive and the active Google Drive recovery namespace.
- Pilot RPO objective is 24 hours; pilot RTO objective is 4 hours.
- The offline age recovery identity is never stored on the NUC, in Git, in an image, in a normal backup, or in Google Drive outside the separately wrapped recovery kit.
- A backup is not published, pruned, reported successful, or uploaded until decryption, archive-path validation, internal checksum validation, and manifest validation succeed.
- Backups contain PostgreSQL, non-secret release metadata, and application object data; they exclude provider plaintext, credential master key, OAuth/tunnel credentials, mailbox exports, and all other runtime secret files.
- The credential master key is recoverable only through a separately age-wrapped recovery kit stored on the 2 TB backup disk and emergency USB.
- Google Drive receives ciphertext, checksum sidecars, and non-secret success metadata only.
- All root-owned configuration/key files reject symlinks and require exact ownership and modes; scripts never print secret values or decrypted provider material.
- Backup/restore commands use `/opt/learncoding/compose.yaml` and `/etc/learncoding/compose.env` explicitly.
- Existing NUC services, existing cloudflared configuration, existing containers, and their backup state are out of scope.

---

## File Structure

- Modify `scripts/backup/common.sh`: secure-file/path helpers, atomic markers, and Compose quiesce/resume interfaces.
- Modify `scripts/backup/backup.sh`: consistent snapshot, ephemeral-recipient verification, atomic publication, and failure recovery.
- Create `scripts/backup/verify-archive.sh`: reusable decrypt/structure/checksum validator.
- Modify `scripts/backup/check-backups.sh`: marker-based local/offsite freshness and capacity checks.
- Modify `scripts/backup/offsite-sync.sh`: upload, re-download verification, and remote marker publication.
- Create `scripts/backup/fetch-offsite.sh`: verified retrieval of the remote marked recovery point.
- Create `scripts/backup/prune-offsite.sh`: independent fail-closed remote 7 daily/4 weekly/12 monthly retention.
- Modify `scripts/backup/restore.sh`: descendant-safe restore boundary and common verification.
- Modify `scripts/backup/restore-drill.sh`: offsite retrieval and isolated drill orchestration.
- Modify `scripts/backup/init-backup-target.sh`: initialize state and recovery-kit directories.
- Modify `scripts/backup/emergency-backup.sh`: validate-before-publish semantics.
- Create `scripts/backup/create-recovery-kit.sh`: separately wrapped credential/key recovery archive.
- Create `scripts/backup/verify-recovery-kit.sh`: safe recovery-kit decryption and inventory verification.
- Create `scripts/backup/create-credential-probe.ts`: seal a random probe under the live credential master key.
- Create `scripts/verify-restored-backup.ts`: verify restored schema, object archive, and sealed credential probe.
- Create `infra/restore/restore-drill.compose.yaml`: isolated temporary PostgreSQL and verification service.
- Modify `infra/env/backup.env.example`: exact new non-secret configuration.
- Create `infra/systemd/learncoding-offsite-sync.service` and `.timer`: independent persistent daily sync.
- Create `infra/systemd/learncoding-offsite-retention.service` and `.timer`: independent persistent remote retention.
- Modify backup/check/restore systemd services and `infra/ops/install-systemd.sh`.
- Create focused shell regression tests and extend existing backup tests.
- Update `docs/runbooks/backup-and-restore.md`, `docs/deployment.md`, and `docs/runbooks/logs-and-monitoring.md`.

### Task 1: Secure backup primitives and failing regression tests

**Files:**
- Create: `infra/tests/backup-consistency.test.sh`
- Create: `infra/tests/backup-publication.test.sh`
- Create: `infra/tests/restore-path-safety.test.sh`
- Modify: `infra/tests/backup-config.test.sh`
- Modify: `scripts/backup/common.sh`

**Interfaces:**
- Produces: `require_secure_regular_file PATH MODE OWNER_UID`, returning zero only for a non-symlink regular file with exact octal mode and owner.
- Produces: `path_is_within CANDIDATE ROOT`, returning zero for the root itself or any descendant after `realpath -m` normalization.
- Produces: `write_success_marker PATH ARCHIVE COMPLETED_UTC SHA256`, atomically replacing a mode-0600 marker.
- Produces: `read_success_marker PATH`, setting `SUCCESS_ARCHIVE`, `SUCCESS_COMPLETED_UTC`, and `SUCCESS_SHA256` after strict validation.
- Produces: `capture_running_mutators ARRAY_NAME`, `quiesce_mutators ARRAY_NAME`, and `resume_mutators ARRAY_NAME` using Bash namerefs and exact service allowlists.

- [ ] **Step 1: Write failing safety tests**

Add tests that create regular files, symlinks, wrong-owner/mode files, nested restore destinations, valid and malformed marker files, and a fake Docker executable. The core assertions must be:

```bash
require_secure_regular_file "$work/secure" 600 "$(id -u)"
if require_secure_regular_file "$work/link" 600 "$(id -u)"; then exit 1; fi
if require_secure_regular_file "$work/wide" 600 "$(id -u)"; then exit 1; fi

path_is_within /srv/learncoding /srv/learncoding
path_is_within /srv/learncoding/app-data/restore /srv/learncoding
if path_is_within /var/tmp/drill /srv/learncoding; then exit 1; fi

write_success_marker "$work/state/local.env" \
  learncoding-full-20260714T010203Z.tar.gz.age \
  20260714T010203Z \
  "$(printf 'a%.0s' {1..64})"
read_success_marker "$work/state/local.env"
[[ "$SUCCESS_ARCHIVE" == learncoding-full-20260714T010203Z.tar.gz.age ]]
```

The consistency test must fake `docker compose ps/stop/up` and prove `postgres` is never stopped, only the captured mutators are resumed, and the failure trap resumes them.

- [ ] **Step 2: Run tests and verify the new interfaces are missing**

Run:

```bash
bash infra/tests/backup-config.test.sh
bash infra/tests/backup-consistency.test.sh
bash infra/tests/restore-path-safety.test.sh
```

Expected: existing test passes; new tests fail because the secure-file, path-containment, marker, and quiesce helpers do not exist.

- [ ] **Step 3: Implement the primitives in `common.sh`**

Implement exact validation rather than permissive bit checks. Marker values accept only the full-backup filename pattern, UTC compact timestamp, and 64 lowercase hexadecimal characters. Marker replacement uses `mktemp` in the destination directory, `chmod 0600`, `fsync` when available, and `mv` on the same filesystem. The mutator allowlist is:

```bash
readonly BACKUP_MUTATING_SERVICES=(
  cloudflared app mail-worker reward-worker regrade-worker
  project-review-correction-worker exam-finalization-worker
  practice-runner-recovery-worker scan-worker
)
```

`capture_running_mutators` intersects that list with `compose_cmd ps --status running --services`; `resume_mutators` uses `compose_cmd up -d --no-deps --no-build --pull never` and starts `cloudflared` last.

- [ ] **Step 4: Run focused tests**

Run the three commands from Step 2.

Expected: all print their `*-tests-ok` sentinel and exit zero; the fake Docker log contains no `stop postgres` and no service that was not originally running.

- [ ] **Step 5: Commit**

```bash
git add scripts/backup/common.sh infra/tests/backup-config.test.sh \
  infra/tests/backup-consistency.test.sh infra/tests/restore-path-safety.test.sh
git commit -m "test(backup): enforce secure recovery primitives"
```

### Task 2: Consistent snapshot and decrypt-before-publish

**Files:**
- Create: `scripts/backup/verify-archive.sh`
- Create: `scripts/backup/create-credential-probe.ts`
- Modify: `scripts/backup/backup.sh`
- Modify: `scripts/backup/prune.sh`
- Modify: `scripts/backup/emergency-backup.sh`
- Modify: `infra/tests/backup-publication.test.sh`
- Modify: `infra/tests/emergency-backup-atomicity.test.sh`
- Modify: `package.json`

**Interfaces:**
- Consumes: secure helpers, markers, and quiesce functions from Task 1.
- Produces: `verify-archive.sh ARCHIVE IDENTITY_FILE DESTINATION`, exiting zero only after safe listing, extraction, manifest allowlist, and strict `SHA256SUMS` validation.
- Produces: `npm run backup:credential-probe -- OUTPUT_PATH KEY_FILE`, creating a mode-0600 JSON probe containing sealed fields and expected plaintext SHA-256, never plaintext.
- Produces: `$BACKUP_ROOT/state/local-last-success.env` only after full candidate verification.

- [ ] **Step 1: Complete the publication failure test**

Fake `docker`, `age`, `age-keygen`, `tar`, and `sha256sum` so each invocation can fail independently. For decrypt failure assert:

```bash
if TEST_FAIL_DECRYPT=1 BACKUP_CONFIG_FILE="$config" bash "$backup"; then exit 1; fi
[[ -z "$(find "$target/full" -mindepth 1 -print -quit)" ]]
[[ ! -e "$target/state/local-last-success.env" ]]
! grep -Fq 'prune' "$work/events"
! grep -Fq 'success-report' "$work/events"
grep -Fq 'resume:app' "$work/events"
```

Repeat for malformed archive paths, internal checksum failure, and manifest failure. Add a success fixture that proves the order `quiesce`, `dump`, `objects`, `encrypt`, `decrypt-verify`, `publish`, `marker`, `prune`, `resume`.

- [ ] **Step 2: Run the publication and emergency tests**

```bash
bash infra/tests/backup-publication.test.sh
bash infra/tests/emergency-backup-atomicity.test.sh
```

Expected: publication test fails on missing verification behavior; emergency test remains green until its new validation assertion is enabled.

- [ ] **Step 3: Implement archive verification and the credential probe**

`create-credential-probe.ts` must use `parseMasterKey` and `sealCredential` with this fixed context:

```ts
const context = {
  credentialId: "00000000-0000-4000-8000-000000000001",
  userId: "backup-recovery-probe",
  provider: "nvidia_nim",
  keyVersion: 1,
};
```

Generate 32 random bytes, encode as base64url, seal it, store `{ version: 1, context, sealed, plaintextSha256 }` atomically, zero key/plaintext buffers where possible, and print only `credential_probe_created=true`.

`verify-archive.sh` must reject absolute paths, traversal, links, devices, sockets, unknown top-level members, malformed checksums, missing `database.dump`, `repository.tar.gz`, `MANIFEST.txt`, `SHA256SUMS`, or `credential-probe.json`, and a manifest other than `format=learncoding-backup-v1` and `contains_secret_files=false`.

- [ ] **Step 4: Implement backup publication transaction**

In `backup.sh`:

1. Acquire the lock and capture running mutators.
2. Install an `EXIT` trap that always resumes captured services.
3. Quiesce them before `pg_dump` or app-data tar.
4. Add release image IDs and migration state to `MANIFEST.txt`.
5. Generate `credential-probe.json` using `/etc/learncoding/secrets/credential_master_key` without placing the key in staging.
6. Generate an ephemeral age identity and a recipient file containing the configured offline public recipient(s) plus the ephemeral public recipient.
7. Encrypt to a temporary file on the backup filesystem.
8. Run `verify-archive.sh` against that temporary ciphertext and ephemeral identity.
9. Generate checksum sidecar, atomically rename both, write local marker, then prune.
10. Destroy temporary identity, plaintext staging, and temporary ciphertext on every exit.

Update `prune.sh` to require a valid local marker and preserve its referenced archive. Apply the same validate-before-marker pattern to emergency backups.

- [ ] **Step 5: Run focused tests**

```bash
bash infra/tests/backup-publication.test.sh
bash infra/tests/backup-retention.test.sh
bash infra/tests/emergency-backup-atomicity.test.sh
npm run typecheck
```

Expected: all shell tests print their pass sentinel; TypeScript compiles without errors.

- [ ] **Step 6: Commit**

```bash
git add scripts/backup/backup.sh scripts/backup/verify-archive.sh \
  scripts/backup/create-credential-probe.ts scripts/backup/prune.sh \
  scripts/backup/emergency-backup.sh infra/tests/backup-publication.test.sh \
  infra/tests/backup-retention.test.sh infra/tests/emergency-backup-atomicity.test.sh package.json
git commit -m "feat(backup): verify recovery points before publication"
```

### Task 3: Verified Google Drive upload and retrieval

**Files:**
- Modify: `scripts/backup/offsite-sync.sh`
- Modify: `scripts/backup/check-backups.sh`
- Create: `scripts/backup/fetch-offsite.sh`
- Modify: `infra/env/backup.env.example`
- Create: `infra/tests/offsite-recovery.test.sh`
- Modify: `infra/tests/backup-config.test.sh`

**Interfaces:**
- Consumes: local success marker and secure-file validation from Tasks 1–2.
- Produces: an immutable remote `state/points/<archive>.env` success attestation, remote `state/LAST_SUCCESS`, and local `$BACKUP_ROOT/state/offsite-last-success.env` after upload and re-download verification.
- Produces: `fetch-offsite.sh DESTINATION`, placing the marked archive and sidecar in an empty protected destination and printing the archive path only.

- [ ] **Step 1: Write complete fake-rclone cases**

Test successful upload/download, tampered download, stale remote marker, missing sidecar, symlinked config, mode-0644 config, immutable point-attestation creation/read-back/idempotency/conflict, complete-but-unattested upload debris, and the normal daily gap where a newer local archive exists but the marked offsite archive remains within 36 hours by both snapshot and publication time. Advance the clock before a same-point retry and prove that it reuses the original attestation bytes and `SUCCESS_COMPLETED_UTC`, creates no new attestation/pointer revision, and cannot refresh freshness.

- [ ] **Step 2: Run the offsite test**

```bash
bash infra/tests/offsite-recovery.test.sh
```

Expected: fail because current sync mirrors files and current health requires the newest local filename remotely.

- [ ] **Step 3: Implement offsite publication**

Require `/etc/learncoding/rclone.conf` to be a root-owned, non-symlink mode-0600 regular file. Upload only the marker-referenced archive and checksum. Download both to protected staging and call `verify_ciphertext_checksum`. Before constructing a new marker, list the exact `state/points/<archive>.env` name. With zero existing attestations, write the strict three-line marker using the current verification-completion time and publish it immutably. With exactly one valid attestation for the same archive/hash, download, strictly parse, and reuse its exact bytes and original `SUCCESS_COMPLETED_UTC`; do not create a new revision or refresh the timestamp. A duplicate, malformed, different-hash, or otherwise conflicting attestation fails closed. Re-download and byte-compare every newly created attestation before use. Only after the immutable point attestation is verified may those exact bytes be uploaded to `state/LAST_SUCCESS.pending-$timestamp`, promoted with `rclone moveto`, read back, and atomically acknowledged locally. Never use `rclone sync` or delete remote data in this flow. A complete archive/sidecar pair without its verified immutable point attestation is upload debris, not a committed recovery point, and is never counted or automatically deleted.

`fetch-offsite.sh` downloads remote `state/LAST_SUCCESS`, requires an exact byte-identical immutable point attestation, validates its strict fields, downloads its archive/sidecar, verifies bytes, and refuses a non-empty or live-root destination.

- [ ] **Step 4: Update freshness configuration and checker**

Add these exact defaults:

```bash
MAX_OFFSITE_AGE_HOURS=36
RESTORE_DRILL_SOURCE=offsite
RCLONE_REMOTE=gdrive:Codestead/backups
RCLONE_CONFIG=/etc/learncoding/rclone.conf
```

`check-backups.sh` validates both the remote marker completion age and the snapshot timestamp embedded in its strict archive basename, requires the matching immutable point attestation to be unique and byte-identical, then validates that the remote archive/sidecar exist. It must not compare the remote archive name to the newest local filename. `MAX_OFFSITE_AGE_HOURS=36` is an operational freshness gate; the RPO 24-hour objective is proven only by the measured snapshot age in the real isolated offsite restore drill.

- [ ] **Step 5: Run focused tests**

```bash
bash infra/tests/backup-config.test.sh
bash infra/tests/offsite-recovery.test.sh
```

Expected: both pass; a tampered downloaded archive exits nonzero without advancing either marker.

- [ ] **Step 6: Commit**

```bash
git add scripts/backup/offsite-sync.sh scripts/backup/check-backups.sh \
  scripts/backup/fetch-offsite.sh infra/env/backup.env.example \
  infra/tests/offsite-recovery.test.sh infra/tests/backup-config.test.sh
git commit -m "feat(backup): verify offsite recovery points"
```

### Task 3A: Fail-Closed Google Drive Retention

**Files:**
- Create: `scripts/backup/prune-offsite.sh`
- Create: `infra/tests/offsite-retention.test.sh`

**Interfaces:**
- Consumes: the unique, strict remote `state/LAST_SUCCESS`, immutable `state/points/<archive>.env` attestations, complete archive/sidecar pairs, and the bounded rclone/configuration primitives from Task 3.
- Produces: independent 7 daily/4 weekly/12 monthly retention in the active Google Drive recovery namespace without changing the publication marker, an immutable pending transaction journal while any exact triplet deletion is being reconciled, and an atomically written sanitized local retention report.

- [ ] **Step 1: Write complete fake-rclone retention cases**

Enumerate only committed recovery-point triplets: one strict immutable point attestation plus its unique archive and sidecar. Complete but unattested pairs and known pending-publication debris are never selected, counted, or deleted. A point attestation with a missing, duplicate, or mismatched pair is invalid committed state and blocks new selection.

Define selection deterministically as a set union: preserve `LAST_SUCCESS`; preserve the newest committed point in each of the seven most recent distinct non-empty UTC-date buckets; preserve the newest committed point in each of the four most recent distinct non-empty ISO-week buckets; and preserve the newest committed point in each of the twelve most recent distinct non-empty UTC-month buckets. If fewer buckets exist, preserve every available bucket. Snapshot timestamp from the strict archive basename orders points; the unique basename is the deterministic final key.

Before the first remote journal-upload call, malformed names or attestations, unexpected objects, duplicate/ambiguous or oversized listings, pointer inconsistency, timeout, or injected preflight/selection failure must cause zero remote mutation. Once that upload call begins, its result can be ambiguous: re-list the exact journal name. Exactly one valid byte-identical journal enters reconciliation, zero journals fails without trashing a target, and duplicate, conflicting, or ambiguous state fails closed. After a journal has been observed, an ambiguous or failed trash operation may leave a partial transaction; it must preserve all selected/protected points, retain the journal, report failure, and reconcile idempotently on the next run. Never claim remote rollback.

Prove that publication never invokes retention inline. Each exact obsolete triplet uses one bounded transaction journal under `state/retention/`, uploaded immutably and read back before mutation. Reconciliation checks which target objects still exist, then invokes exactly one `rclone deletefile <exact-object> --drive-use-trash=true` at a time, with the archive first, sidecar second, and point attestation last. After all three are proven absent, it trashes the exact journal. The CLI flag is mandatory even if configuration or environment tries to disable Drive trash. The transaction must never use `sync`, broad `delete`, `purge`, `cleanup`, automatic dedupe, permanent deletion, or cleanup of unattested debris.

- [ ] **Step 2: Run the retention test and capture RED**

```bash
bash infra/tests/offsite-retention.test.sh
```

Expected: fail because the independent remote-retention command does not exist.

- [ ] **Step 3: Implement the independent retention transaction**

Validate the secure rclone configuration and acquire the exclusive backup lock. If exactly one valid pending retention journal exists, reconcile only that journal before considering new selection; duplicates or malformed journals fail closed. Otherwise read and validate the unique remote pointer, its byte-identical immutable point attestation, and every bounded committed triplet; calculate the tier union without mutation; re-read and byte-compare `LAST_SUCCESS`; then publish and read back one immutable journal for one exact obsolete triplet.

The journal strictly records a version, target archive, target SHA-256, point-attestation path, hash of the `LAST_SUCCESS` bytes, hash of the canonical protected selection, and creation time. Before each exact trash operation, re-read the pointer and refuse to trash its target. Failures before the first journal-upload call perform zero remote mutation. After any journal-upload attempt, re-list the exact name and apply the zero/one/ambiguous rule above before any trash call; never describe an ambiguous upload as rollback or zero mutation. A post-journal failure leaves a resumable journal and may leave only the target triplet partially trashed; it must never affect a protected point, refresh `LAST_SUCCESS`, or claim rollback. Process further obsolete triplets only through new one-triplet journals after the previous journal is proven absent.

After all transactions finish, use a bounded active listing plus a bounded `--drive-trashed-only=true` listing to verify the exact results, then atomically publish the root-owned, non-symlink mode-0600 `$BACKUP_ROOT/state/offsite-retention-last-report.txt`. The report contains a cryptographically random non-secret `run_id`, strict `completed_utc`, current `pointer_archive`, canonical active/trash listing SHA-256 digests, policy, counts, strict archive basenames, bucket memberships, exact trashed basenames, `pending_journal=false`, and `result=pass`; it never contains configuration, credentials, access tokens, ciphertext hashes, Drive IDs, or command output. The completion time is captured only after the final listings succeed and cannot be refreshed by a failed verification.

- [ ] **Step 4: Run focused verification**

```bash
bash -n scripts/backup/prune-offsite.sh infra/tests/offsite-retention.test.sh
bash infra/tests/offsite-recovery.test.sh
bash infra/tests/offsite-retention.test.sh
```

Expected: all pass; malformed or ambiguous preflight state performs no mutation, and every injected post-journal ambiguity is safely reconciled by an idempotent rerun.

- [ ] **Step 5: Commit**

```bash
git add scripts/backup/prune-offsite.sh infra/tests/offsite-retention.test.sh
git commit -m "feat(backup): retain verified offsite recovery points"
```

### Task 4: Separately wrapped credential recovery kit

**Files:**
- Create: `scripts/backup/create-recovery-kit.sh`
- Create: `scripts/backup/verify-recovery-kit.sh`
- Modify: `scripts/backup/init-backup-target.sh`
- Create: `infra/tests/recovery-kit.test.sh`
- Modify: `infra/env/backup.env.example`

**Interfaces:**
- Produces: `create-recovery-kit.sh DESTINATION...`, atomically writing one identical encrypted kit plus checksum to each initialized destination.
- Produces: `verify-recovery-kit.sh ARCHIVE IDENTITY_FILE DESTINATION`, validating exact inventory without printing contents.
- Consumes: a distinct public recipient in `RECOVERY_KIT_RECIPIENT_FILE`; its private identity is held outside the NUC/backup media.

- [ ] **Step 1: Run the failing recovery-kit test**

```bash
bash infra/tests/recovery-kit.test.sh
```

Expected: fail because the creation and verification commands do not exist.

- [ ] **Step 2: Implement kit creation**

The plaintext stage contains only:

```text
credential_master_key
backup-age-identity.txt
RECOVERY.md
MANIFEST.txt
SHA256SUMS
```

`RECOVERY.md` contains Cloudflare account/tunnel hostname and reissue procedure, Gmail OAuth project/account and reauthorization procedure, Git commit, image IDs, and identity storage location; it does not contain access tokens. The script validates source key modes, archive recipient mode, initialized destination markers, internal checksums, and destination capacity. It encrypts once, verifies with a temporarily attached wrapping identity when `RECOVERY_KIT_VERIFY_IDENTITY_FILE` is provided, copies atomically, verifies each copy checksum, and removes plaintext on every exit.

- [ ] **Step 3: Implement kit verification**

Reject unsafe paths/special files, require exact inventory and internal checksums, require the credential key to parse as exactly 32 base64-encoded bytes, require the backup identity to match an age secret-key format, and print only:

```text
recovery_kit_valid=true
```

- [ ] **Step 4: Run the recovery-kit test**

```bash
bash infra/tests/recovery-kit.test.sh
```

Expected: pass; injected encryption/copy/checksum failures leave no final kit or plaintext stage.

- [ ] **Step 5: Commit**

```bash
git add scripts/backup/create-recovery-kit.sh scripts/backup/verify-recovery-kit.sh \
  scripts/backup/init-backup-target.sh infra/tests/recovery-kit.test.sh \
  infra/env/backup.env.example
git commit -m "feat(recovery): add separately wrapped recovery kit"
```

### Task 5: Offsite isolated restore drill

**Files:**
- Create: `infra/restore/restore-drill.compose.yaml`
- Create: `scripts/verify-restored-backup.ts`
- Modify: `scripts/backup/restore.sh`
- Modify: `scripts/backup/restore-drill.sh`
- Modify: `infra/tests/verify-backup-drill.sh`
- Modify: `infra/tests/backup-drill.compose.yaml`
- Modify: `infra/tests/backup-drill.env`
- Modify: `package.json`

**Interfaces:**
- Consumes: `fetch-offsite.sh`, `verify-archive.sh`, a temporarily attached backup recovery identity, and recovered credential master key.
- Produces: a checksummed restore report with source archive, source `offsite`, table count, object verification, credential recovery boolean, live-data-modified false, elapsed seconds, measured RPO/RTO seconds, and explicit threshold verdicts.
- Produces: `npm run backup:restore-smoke`, reading `RESTORE_DATABASE_URL`, `RESTORE_APP_DATA_ROOT`, `RESTORE_CREDENTIAL_PROBE`, and `CREDENTIAL_MASTER_KEY_FILE`.

- [ ] **Step 1: Extend the disposable drill test**

Require the final report to contain:

```text
result=pass
source=offsite
database_schema_valid=true
app_data_valid=true
credential_recovery=true
live_database_modified=false
cleanup_complete=true
rpo_seconds=<integer-from-0-through-86400>
rpo_within_24h=true
rto_seconds=<integer-from-0-through-14400>
rto_within_4h=true
```

Assert the production database sentinel is unchanged and no drill container, network, database, plaintext directory, or key remains. Using fixed wall and monotonic test clocks, a marked snapshot older than 24 hours, a snapshot after the declared incident, an incident after its pre-approval record time, a record time after restore approval beyond the five-minute allowed wall-clock skew, a negative RPO, or a simulated monotonic operator-approval-to-smoke interval over 4 hours must fail before `result=pass`. Threshold and chronology failures still run complete isolated-resource and plaintext cleanup. Inject teardown and protected-directory cleanup failures and require a non-pass report with `cleanup_complete=false`, a nonzero exit, and no checksum that can be mistaken for passing evidence.

- [ ] **Step 2: Run the disposable drill**

```bash
docker compose -f infra/tests/backup-drill.compose.yaml \
  --env-file infra/tests/backup-drill.env up --build \
  --abort-on-container-exit --exit-code-from verify
```

Expected: fail on the new offsite/isolation/credential requirements.

- [ ] **Step 3: Implement the isolated topology**

`infra/restore/restore-drill.compose.yaml` defines an internal-only temporary network, a digest-pinned PostgreSQL 17 container with tmpfs data, and a digest-pinned operations image. It publishes no ports, mounts only the extracted drill files read-only, uses `restart: "no"`, drops capabilities, and has no production Compose networks or secrets.

`restore-drill.sh` creates a unique Compose project and requires a pre-existing root-owned, non-symlink mode-0600 incident record containing strict `INCIDENT_UTC` and `RECORDED_UTC` fields. It records restore approval in both UTC and a monotonic-clock origin, requires `snapshot UTC <= INCIDENT_UTC <= RECORDED_UTC <= approval UTC + five-minute skew`, downloads offsite, decrypts/extracts safely, starts the drill database, applies `pg_restore`, and runs `backup:restore-smoke`. RPO is the nonnegative wall-clock interval from snapshot to incident. RTO is measured only with the monotonic clock from approval to passing smoke. It must exit nonzero and set the matching threshold or chronology verdict false when RPO exceeds 86,400 seconds, RTO exceeds 14,400 seconds, or chronology is invalid; recording a measurement alone never clears the release gate.

After smoke and measurement, the script always runs `docker compose down --volumes --remove-orphans`, removes every protected plaintext/key/staging directory, and proves their absence. Only after that cleanup succeeds may it atomically write and checksum a sanitized final report with `result=pass` and `cleanup_complete=true`. A teardown or cleanup failure writes a sanitized non-pass report with `cleanup_complete=false`, exits nonzero, and must not leave a checksum or earlier report that can be interpreted as passing evidence. The RTO endpoint remains the passing-smoke timestamp; post-smoke cleanup time is recorded separately and does not inflate RTO.

- [ ] **Step 4: Implement restore smoke verification**

`verify-restored-backup.ts` performs `SELECT count(*)` against public tables, verifies at least the expected migration table and core user/learning tables, opens `credential-probe.json` with `openCredential`, compares SHA-256 in constant time, verifies the app-data archive/object manifest, and emits booleans only.

- [ ] **Step 5: Run the drill and focused tests**

```bash
npm run typecheck
docker compose -f infra/tests/backup-drill.compose.yaml \
  --env-file infra/tests/backup-drill.env up --build \
  --abort-on-container-exit --exit-code-from verify
docker compose -f infra/tests/backup-drill.compose.yaml \
  --env-file infra/tests/backup-drill.env down --volumes --remove-orphans
bash infra/tests/restore-path-safety.test.sh
```

Expected: verify service exits zero only when RPO is at most 24 hours and RTO is at most 4 hours, report booleans are true, teardown leaves no drill resources, stale/slow fixtures fail closed, and restore path test passes.

- [ ] **Step 6: Commit**

```bash
git add infra/restore/restore-drill.compose.yaml scripts/verify-restored-backup.ts \
  scripts/backup/restore.sh scripts/backup/restore-drill.sh \
  infra/tests/verify-backup-drill.sh infra/tests/backup-drill.compose.yaml \
  infra/tests/backup-drill.env package.json
git commit -m "feat(recovery): prove offsite isolated restore"
```

### Task 6: Persistent systemd schedules and operator documentation

**Files:**
- Create: `infra/systemd/learncoding-offsite-sync.service`
- Create: `infra/systemd/learncoding-offsite-sync.timer`
- Create: `infra/systemd/learncoding-offsite-retention.service`
- Create: `infra/systemd/learncoding-offsite-retention.timer`
- Modify: `infra/systemd/learncoding-backup.service`
- Modify: `infra/systemd/learncoding-backup-check.service`
- Modify: `infra/systemd/learncoding-restore-drill.service`
- Modify: `infra/ops/install-systemd.sh`
- Create: `infra/tests/systemd-backup.test.sh`
- Create: `scripts/backup/verify-recovery-evidence.sh`
- Create: `infra/tests/recovery-evidence-verifier.test.sh`
- Modify: `docs/runbooks/backup-and-restore.md`
- Modify: `docs/runbooks/logs-and-monitoring.md`
- Modify: `docs/deployment.md`

**Interfaces:**
- Produces: nightly local backup, daily persistent offsite sync, independent daily offsite retention, six-hour freshness check, and manual restore drill.
- Consumes: mounted 2 TB target at `/mnt/learncoding-backups`, root-owned `/etc/learncoding/backup.env`, and the trusted Compose unit.

- [ ] **Step 1: Write static systemd assertions**

Assert explicit `/opt/learncoding` paths, `OnFailure`, `Persistent=true`, no shell-dependent working directory, and these schedules: local backup 02:15 daily, offsite 04:15 UTC daily, offsite retention 05:15 UTC daily, and check every six hours. Assert the retention unit has a one-hour total start timeout, a bounded stop timeout, the same restrictive filesystem/device/process/network sandbox as offsite publication, and no broad or permanent-delete command. Assert restore drill is not enabled automatically.

- [ ] **Step 2: Run the test**

```bash
bash infra/tests/systemd-backup.test.sh
```

Expected: fail because the offsite publication and offsite retention service/timer pairs do not exist.

- [ ] **Step 3: Add and install units**

The offsite service runs `/usr/bin/bash /opt/learncoding/scripts/backup/offsite-sync.sh`, has `After=network-online.target learncoding-backup.service`, `RequiresMountsFor=/mnt/learncoding-backups`, restrictive systemd sandboxing, and four-hour timeout. Its timer uses `OnCalendar=*-*-* 04:15:00 UTC`, up to 20 minutes of randomized delay, and `Persistent=true`.

The retention service runs `/usr/bin/bash /opt/learncoding/scripts/backup/prune-offsite.sh` independently after the offsite publication unit. It has `OnFailure`, `TimeoutStartSec=1h`, a bounded `TimeoutStopSec`, restrictive systemd sandboxing, and the same secure rclone configuration boundary as publication. Every rclone listing/control call has a 120-second wall deadline and bounded output; each exact trash operation has its own bounded deadline. Its timer uses `OnCalendar=*-*-* 05:15:00 UTC`, randomized delay, and `Persistent=true`. Publication never invokes retention inline, and retention failure cannot roll back or invalidate a verified publication.

`verify-recovery-evidence.sh` is read-only. It requires the secure retention report, validates a unique `run_id`, requires `completed_utc` to be no more than six hours old with at most five minutes of future skew, and acquires the shared backup lock so local publication and retention cannot start during observation. It uses separately bounded active and `--drive-trashed-only=true` listings, independently validates the unique pointer and byte-identical point attestation, enumerates strict committed triplets, recomputes the deterministic 7/4/12 union, compares exact active/trashed basenames, canonical listing digests, pointer archive, and bucket membership with that same report, proves known unattested/pending debris remains untouched, and strictly validates the restore report chronology, threshold booleans, cleanup result, and checksum. Immediately before atomically writing evidence, it re-downloads and byte-compares the pointer and repeats both canonical listings; any pointer-byte or listing-digest change invalidates the observation. It writes one atomic sanitized evidence artifact containing the retention `run_id` and observation time, then releases the lock; it never emits config, credentials, tokens, ciphertext hashes, Drive IDs, or raw command output. Its fake-rclone test must prove report tamper, stale/future reports, missing/extra active or trashed objects, pointer/attestation mismatch, touched debris, invalid chronology, threshold false, cleanup false, duplicate listings, listing timeout, and concurrent pointer/listing mutation all fail without remote mutation.

Backup/check services declare `RequiresMountsFor=/srv/learncoding /mnt/learncoding-backups`. The optional disk uses `nofail,x-systemd.automount`; its absence fails the job and alerts but does not block boot.

- [ ] **Step 4: Update runbooks with exact ceremony**

Document stable-UUID mount, `age` identity separation, dedicated Google account/MFA, exact rclone mode, initial forced sync, offsite download drill, kit creation to both media, quarterly drill, RPO/RTO measurement, and incident behavior. Commands must use full paths and never email backup attachments.

- [ ] **Step 5: Run tests and render units**

```bash
bash infra/tests/systemd-backup.test.sh
bash infra/tests/recovery-evidence-verifier.test.sh
systemd-analyze verify infra/systemd/learncoding-backup.service \
  infra/systemd/learncoding-backup.timer \
  infra/systemd/learncoding-offsite-sync.service \
  infra/systemd/learncoding-offsite-sync.timer \
  infra/systemd/learncoding-offsite-retention.service \
  infra/systemd/learncoding-offsite-retention.timer \
  infra/systemd/learncoding-backup-check.service \
  infra/systemd/learncoding-backup-check.timer \
  infra/systemd/learncoding-restore-drill.service
```

Expected: both shell tests pass and `systemd-analyze verify` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add infra/systemd infra/ops/install-systemd.sh infra/tests/systemd-backup.test.sh \
  scripts/backup/verify-recovery-evidence.sh infra/tests/recovery-evidence-verifier.test.sh \
  docs/runbooks/backup-and-restore.md docs/runbooks/logs-and-monitoring.md docs/deployment.md
git commit -m "ops(backup): schedule verified local and offsite recovery"
```

### Task 7: Complete backup/recovery verification

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `infra/tests/backup-ci-registration.test.mjs`
- Modify only when a verification failure identifies a defect in files already listed in Tasks 1–6.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: a clean automated recovery gate ready for the real NUC evidence phase.

- [ ] **Step 1: Register every recovery test in the independent Ubuntu gate**

Add `offsite-recovery.test.sh`, `offsite-retention.test.sh`, `recovery-kit.test.sh`, `restore-path-safety.test.sh`, `recovery-evidence-verifier.test.sh`, and `systemd-backup.test.sh` to the independent `backup-safety` job. Extend the dependency-free workflow registration verifier first so skipped, wrapped, duplicated, conditional, or reordered recovery commands fail closed.

```bash
node infra/tests/backup-ci-registration.test.mjs .github/workflows/ci.yml
```

Expected: pass and prove the exact unfiltered Ubuntu command order.

- [ ] **Step 2: Run all shell recovery tests**

```bash
bash infra/tests/backup-config.test.sh
bash infra/tests/backup-consistency.test.sh
bash infra/tests/backup-publication.test.sh
bash infra/tests/backup-retention.test.sh
bash infra/tests/emergency-backup-atomicity.test.sh
bash infra/tests/offsite-recovery.test.sh
bash infra/tests/offsite-retention.test.sh
bash infra/tests/recovery-kit.test.sh
bash infra/tests/restore-path-safety.test.sh
bash infra/tests/recovery-evidence-verifier.test.sh
bash infra/tests/systemd-backup.test.sh
```

Expected: every command exits zero and prints its pass sentinel.

- [ ] **Step 3: Run application and static gates**

```bash
npm run lint
npm run typecheck
npm test
npm run build
node infra/tests/validate-static.mjs
node infra/tests/validate-compose.mjs
```

Expected: all exit zero.

- [ ] **Step 4: Run the disposable restore drill from a clean state**

```bash
docker compose -f infra/tests/backup-drill.compose.yaml \
  --env-file infra/tests/backup-drill.env down --volumes --remove-orphans
docker compose -f infra/tests/backup-drill.compose.yaml \
  --env-file infra/tests/backup-drill.env up --build \
  --abort-on-container-exit --exit-code-from verify
docker compose -f infra/tests/backup-drill.compose.yaml \
  --env-file infra/tests/backup-drill.env down --volumes --remove-orphans
```

Expected: verification exits zero and final `docker compose ps -a` for the drill project is empty.

- [ ] **Step 5: Inspect the diff and scan for incomplete text or secrets**

```bash
git diff --check
rg -n "FIXME|XXX|AGE-SECRET-KEY-|nvapi-|sk-ant-|sk-proj-" \
  scripts/backup infra docs/runbooks/backup-and-restore.md docs/deployment.md
```

Expected: `git diff --check` is clean; search finds no incomplete markers or credential material.

- [ ] **Step 6: Commit verification-only corrections if required**

```bash
git add .github/workflows/ci.yml infra/tests/backup-ci-registration.test.mjs \
  scripts/backup infra docs package.json
git commit -m "test(recovery): close production recovery gate"
```

If Step 4 produces no corrective diff, do not create an empty commit.

## NUC Evidence Handoff

After this plan passes, the runner/NUC rollout plan installs the units and performs real evidence. Before learner invitations it must record:

```bash
sudo systemctl start learncoding-backup.service
sudo systemctl start learncoding-offsite-sync.service
sudo systemctl start learncoding-offsite-retention.service
sudo systemctl start learncoding-restore-drill.service
sudo systemctl show -p Result -p ExecMainStatus \
  learncoding-backup.service \
  learncoding-offsite-sync.service learncoding-offsite-retention.service \
  learncoding-restore-drill.service --no-pager
sudo bash /opt/learncoding/scripts/backup/verify-recovery-evidence.sh \
  --output /mnt/learncoding-backups/state/recovery-evidence-verification.txt
sudo test -s /mnt/learncoding-backups/state/recovery-evidence-verification.txt
sudo sed -n '1,240p' /mnt/learncoding-backups/state/recovery-evidence-verification.txt
sudo sha256sum /mnt/learncoding-backups/state/recovery-evidence-verification.txt
```

Expected: all four one-shot services show `Result=success` and `ExecMainStatus=0`. The read-only verifier independently recomputes and records the active committed union, exact trashed triplets, pointer/attestation identity, untouched known debris, report freshness, and 7/4/12 buckets; it also validates the checksummed restore report's source, credential recovery, live-data isolation, chronology, cleanup, nonnegative RPO/RTO, and threshold verdicts. The full sanitized verifier artifact and its hash are retained as deployment evidence. This evidence is deployment state and must not be claimed by repository tests.
