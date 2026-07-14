# Codestead Backup and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every published Codestead backup crash-consistent, decrypt-verified, recoverable from Google Drive, and sufficient to restore encrypted provider credentials without keeping the disaster-recovery private identity on the NUC.

**Architecture:** Nightly backup enters a bounded maintenance window, stops only database-mutating application services, captures PostgreSQL and application objects as one recovery point, validates plaintext structure, encrypts to the offline recovery recipient plus an ephemeral verification recipient, decrypts and validates the candidate, and only then atomically publishes it and advances a success marker. Offsite upload has its own persistent systemd timer and publishes a remote success marker only after downloading and checksum-verifying the uploaded bytes. Restore drills download that marked recovery point into an isolated PostgreSQL topology and prove schema, object, and credential-master-key recovery without modifying production.

**Tech Stack:** Bash 5, Docker Compose 5, PostgreSQL 17 tools, age/age-keygen, rclone Google Drive backend, systemd, Node.js/TypeScript, Vitest, shell integration tests.

## Global Constraints

- Retain 7 daily, 4 weekly, and 12 monthly recovery points.
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
- Create `infra/systemd/learncoding-offsite-sync.service` and `.timer`: independent persistent weekly sync.
- Modify backup/check/restore systemd services and `infra/ops/install-systemd.sh`.
- Create five focused shell regression tests and extend existing backup tests.
- Update `docs/runbooks/backup-and-restore.md`, `docs/deployment.md`, and `docs/runbooks/logs-and-monitoring.md`.

### Task 1: Secure backup primitives and failing regression tests

**Files:**
- Create: `infra/tests/backup-consistency.test.sh`
- Create: `infra/tests/backup-publication.test.sh`
- Create: `infra/tests/offsite-recovery.test.sh`
- Create: `infra/tests/recovery-kit.test.sh`
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
- Modify: `infra/tests/offsite-recovery.test.sh`

**Interfaces:**
- Consumes: local success marker and secure-file validation from Tasks 1–2.
- Produces: remote `state/LAST_SUCCESS` and local `$BACKUP_ROOT/state/offsite-last-success.env` after upload and re-download verification.
- Produces: `fetch-offsite.sh DESTINATION`, placing the marked archive and sidecar in an empty protected destination and printing the archive path only.

- [ ] **Step 1: Write complete fake-rclone cases**

Test successful upload/download, tampered download, stale remote marker, missing sidecar, symlinked config, mode-0644 config, and the weekly gap where a newer local archive exists but the marked offsite archive is still within 192 hours.

- [ ] **Step 2: Run the offsite test**

```bash
bash infra/tests/offsite-recovery.test.sh
```

Expected: fail because current sync mirrors files and current health requires the newest local filename remotely.

- [ ] **Step 3: Implement offsite publication**

Require `/etc/learncoding/rclone.conf` to be a root-owned, non-symlink mode-0600 regular file. Upload only the marker-referenced archive and checksum. Download both to protected staging, call `verify_ciphertext_checksum`, write a temporary marker, upload it to `state/LAST_SUCCESS.pending-$timestamp`, promote with `rclone moveto`, then atomically write the local offsite marker. Never use `rclone sync` or delete remote data in this flow.

`fetch-offsite.sh` downloads remote `state/LAST_SUCCESS`, validates its strict fields, downloads its archive/sidecar, verifies bytes, and refuses a non-empty or live-root destination.

- [ ] **Step 4: Update freshness configuration and checker**

Add these exact defaults:

```bash
MAX_OFFSITE_AGE_HOURS=192
RESTORE_DRILL_SOURCE=offsite
RCLONE_REMOTE=gdrive:Codestead/backups
RCLONE_CONFIG=/etc/learncoding/rclone.conf
```

`check-backups.sh` measures the remote marker timestamp and validates that remote archive/sidecar exist. It must not compare the remote archive name to the newest local filename.

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

### Task 4: Separately wrapped credential recovery kit

**Files:**
- Create: `scripts/backup/create-recovery-kit.sh`
- Create: `scripts/backup/verify-recovery-kit.sh`
- Modify: `scripts/backup/init-backup-target.sh`
- Modify: `infra/tests/recovery-kit.test.sh`
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
- Produces: a checksummed restore report with source archive, source `offsite`, table count, object verification, credential recovery boolean, live-data-modified false, elapsed seconds, and measured RPO/RTO.
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
```

Assert the production database sentinel is unchanged and no drill container, network, database, plaintext directory, or key remains.

- [ ] **Step 2: Run the disposable drill**

```bash
docker compose -f infra/tests/backup-drill.compose.yaml \
  --env-file infra/tests/backup-drill.env up --build \
  --abort-on-container-exit --exit-code-from verify
```

Expected: fail on the new offsite/isolation/credential requirements.

- [ ] **Step 3: Implement the isolated topology**

`infra/restore/restore-drill.compose.yaml` defines an internal-only temporary network, a digest-pinned PostgreSQL 17 container with tmpfs data, and a digest-pinned operations image. It publishes no ports, mounts only the extracted drill files read-only, uses `restart: "no"`, drops capabilities, and has no production Compose networks or secrets.

`restore-drill.sh` creates a unique Compose project, downloads offsite, decrypts/extracts safely, starts the drill database, applies `pg_restore`, runs `backup:restore-smoke`, writes/checksums the report, and always runs `docker compose down --volumes --remove-orphans` plus protected-directory cleanup.

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

Expected: verify service exits zero, report booleans are true, teardown leaves no drill resources, and restore path test passes.

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
- Modify: `infra/systemd/learncoding-backup.service`
- Modify: `infra/systemd/learncoding-backup-check.service`
- Modify: `infra/systemd/learncoding-restore-drill.service`
- Modify: `infra/ops/install-systemd.sh`
- Create: `infra/tests/systemd-backup.test.sh`
- Modify: `docs/runbooks/backup-and-restore.md`
- Modify: `docs/runbooks/logs-and-monitoring.md`
- Modify: `docs/deployment.md`

**Interfaces:**
- Produces: nightly local backup, weekly persistent offsite sync, six-hour freshness check, and manual restore drill.
- Consumes: mounted 2 TB target at `/mnt/learncoding-backups`, root-owned `/etc/learncoding/backup.env`, and the trusted Compose unit.

- [ ] **Step 1: Write static systemd assertions**

Assert explicit `/opt/learncoding` paths, `OnFailure`, `Persistent=true`, no shell-dependent working directory, and these schedules: local backup 02:15 daily, offsite Sunday 04:15 UTC, check every six hours. Assert restore drill is not enabled automatically.

- [ ] **Step 2: Run the test**

```bash
bash infra/tests/systemd-backup.test.sh
```

Expected: fail because the offsite unit/timer do not exist.

- [ ] **Step 3: Add and install units**

The offsite service runs `/usr/bin/bash /opt/learncoding/scripts/backup/offsite-sync.sh`, has `After=network-online.target learncoding-backup.service`, `RequiresMountsFor=/mnt/learncoding-backups`, restrictive systemd sandboxing, and four-hour timeout. Its timer uses `OnCalendar=Sun *-*-* 04:15:00 UTC`, randomized delay, and `Persistent=true`.

Backup/check services declare `RequiresMountsFor=/srv/learncoding /mnt/learncoding-backups`. The optional disk uses `nofail,x-systemd.automount`; its absence fails the job and alerts but does not block boot.

- [ ] **Step 4: Update runbooks with exact ceremony**

Document stable-UUID mount, `age` identity separation, dedicated Google account/MFA, exact rclone mode, initial forced sync, offsite download drill, kit creation to both media, quarterly drill, RPO/RTO measurement, and incident behavior. Commands must use full paths and never email backup attachments.

- [ ] **Step 5: Run tests and render units**

```bash
bash infra/tests/systemd-backup.test.sh
systemd-analyze verify infra/systemd/learncoding-backup.service \
  infra/systemd/learncoding-backup.timer \
  infra/systemd/learncoding-offsite-sync.service \
  infra/systemd/learncoding-offsite-sync.timer \
  infra/systemd/learncoding-backup-check.service \
  infra/systemd/learncoding-backup-check.timer \
  infra/systemd/learncoding-restore-drill.service
```

Expected: shell test passes and `systemd-analyze verify` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add infra/systemd infra/ops/install-systemd.sh infra/tests/systemd-backup.test.sh \
  docs/runbooks/backup-and-restore.md docs/runbooks/logs-and-monitoring.md docs/deployment.md
git commit -m "ops(backup): schedule verified local and offsite recovery"
```

### Task 7: Complete backup/recovery verification

**Files:**
- Modify only when a verification failure identifies a defect in files already listed in Tasks 1–6.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: a clean automated recovery gate ready for the real NUC evidence phase.

- [ ] **Step 1: Run all shell recovery tests**

```bash
bash infra/tests/backup-config.test.sh
bash infra/tests/backup-consistency.test.sh
bash infra/tests/backup-publication.test.sh
bash infra/tests/backup-retention.test.sh
bash infra/tests/emergency-backup-atomicity.test.sh
bash infra/tests/offsite-recovery.test.sh
bash infra/tests/recovery-kit.test.sh
bash infra/tests/restore-path-safety.test.sh
bash infra/tests/systemd-backup.test.sh
```

Expected: every command exits zero and prints its pass sentinel.

- [ ] **Step 2: Run application and static gates**

```bash
npm run lint
npm run typecheck
npm test
npm run build
node infra/tests/validate-static.mjs
node infra/tests/validate-compose.mjs
```

Expected: all exit zero.

- [ ] **Step 3: Run the disposable restore drill from a clean state**

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

- [ ] **Step 4: Inspect the diff and scan for incomplete text or secrets**

```bash
git diff --check
rg -n "FIXME|XXX|AGE-SECRET-KEY-|nvapi-|sk-ant-|sk-proj-" \
  scripts/backup infra docs/runbooks/backup-and-restore.md docs/deployment.md
```

Expected: `git diff --check` is clean; search finds no incomplete markers or credential material.

- [ ] **Step 5: Commit verification-only corrections if required**

```bash
git add scripts/backup infra docs package.json
git commit -m "test(recovery): close production recovery gate"
```

If Step 4 produces no corrective diff, do not create an empty commit.

## NUC Evidence Handoff

After this plan passes, the runner/NUC rollout plan installs the units and performs real evidence. Before learner invitations it must record:

```bash
sudo systemctl start learncoding-backup.service
sudo systemctl start learncoding-offsite-sync.service
sudo systemctl start learncoding-restore-drill.service
sudo systemctl status learncoding-backup.service \
  learncoding-offsite-sync.service learncoding-restore-drill.service --no-pager
```

Expected: all three oneshot services finish with `Result=success`; the restore report records `source=offsite`, `credential_recovery=true`, `live_database_modified=false`, and measured RPO/RTO. This evidence is deployment state and must not be claimed by repository tests.
