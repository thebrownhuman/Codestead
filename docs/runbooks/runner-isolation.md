# Runner isolation runbook

User-submitted code is hostile by default. Docker limits reduce risk but do not create a sufficient trust boundary against kernel/container-runtime exploits. The runner therefore lives in a dedicated disposable KVM VM, never on the NUC that holds learner records and secrets.

The authoritative network contract attaches the `codestead-runner` domain to the libvirt `default` network on bridge `virbr0`. The reviewed DHCP reservation binds MAC `52:54:00:20:00:12` to guest `192.168.122.12`; the host side is `192.168.122.1`. `codestead-runner` is the VM domain and hostname, not a libvirt network name. Do not create a replacement custom bridge or use an older private address.

## VM boundary

- Separate virtual disk, private NIC/VLAN, OS identity, SSH host keys, and Docker daemon.
- No shared folders, Docker socket forwarding, host networking, USB passthrough, clipboard integration, or mounted NUC/backup storage.
- No database URL, auth/OAuth secret, credential master key, Cloudflare credential, backup/rclone credential, `age` identity, SMTP token, or admin session.
- One secret only: the dedicated app-to-runner HMAC/shared secret.
- Inbound 4100 only from the NUC private address; SSH only from the admin network.
- At most two concurrent jobs. Do not add autoscaling or extra workers for this ten-user deployment without another review.

## Install

Do not create the account, install packages, build images, or enable the service by hand. The exact manifest-bound procedure below makes the fixed `learncoding-runner` identity, installs only reviewed dependency pins, builds and scans the runtime set, installs both systemd units, enables the guest firewall first, and starts the service only after every gate passes. Docker group membership is root-equivalent inside this VM; that is precisely why the VM must remain disposable and isolated.

Build the five pinned runtime inputs and compiled harness on the disposable VM by following [`services/runner/runtime/README.md`](../../services/runner/runtime/README.md). Run `runtime:inspect`, all 17 real Docker contracts, and the SBOM/vulnerability gate. `runtime:record` publishes `dist/runtime-images.env` first and `dist/runtime-images.json` last; the JSON file is the commit marker. Never copy or accept only one file. The privileged guest installer verifies root ownership, single links, safe modes, the canonical JSON record ID, exact five-language order, immutable manifest/config/root digests, and a byte-exact environment projection before it compares those five references with `/etc/learncoding/runner.env`. A torn, stale, or mixed publication fails before service start. Blank values fail closed. The runner uses `--pull never`, so every exact digest must already exist locally before service start.

Treat `/opt/learncoding/RELEASE.SHA256SUMS` and its reviewed lowercase SHA-256 as the complete release-tree authorization, not as a partial file list. Invoke `infra/runner-vm/install-guest.sh` only through its privileged-mode shebang and supply all exact `RUNNER_*_PACKAGE_VERSION`, repository-key SHA-256, scanner version/archive SHA-256, and `RUNNER_RELEASE_MANIFEST_SHA256` inputs from the reviewed release record. The installer rejects extra, missing, symlinked, hard-linked, non-root-owned, group/world-writable, special, or concurrently changed release members. It enables `learncoding-runner-guest-firewall.service` before Docker/runtime gates and the runner service. On the NUC, `learncoding-runner-firewall.service` must be active before `learncoding-compose.service`; together the two nftables policies allow the reviewed app path to `192.168.122.12:4100` and reject every unreviewed IPv4/IPv6 route without flushing unrelated host rules.

The host and guest consume different forms of the same reviewed release. The NUC at `/opt/learncoding` remains a clean Git checkout with its `.git` directory; the four generated application/runtime record files and `RELEASE.SHA256SUMS` are ignored release evidence. The runner guest receives the Git-less, exact-tree artifact produced by `infra/ops/package-release-tree.py`. Never replace the host checkout with that guest artifact, and never copy a developer working tree into the guest.

From the clean reviewed checkout, after publishing both canonical application and runtime record pairs, create the guest artifact at a destination outside the checkout:

```bash
application_sha="$(sha256sum dist/application-images/application-images.json | cut -d' ' -f1)"
runtime_id="$(node -p "require('./services/runner/dist/runtime-images.json').recordId")"
python3.12 infra/ops/package-release-tree.py \
  --source "$PWD" \
  --destination "../learncoding-runner-release" \
  --application-image-json dist/application-images/application-images.json \
  --application-image-env dist/application-images/application-images.env \
  --application-image-record-sha256 "$application_sha" \
  --runner-runtime-json services/runner/dist/runtime-images.json \
  --runner-runtime-env services/runner/dist/runtime-images.env \
  --runner-runtime-record-id "$runtime_id"
```

The packager pins one immutable commit for the tree, member list, and archive; accepts only fresh canonical records bound to that commit; builds the complete checksum manifest; rechecks the source before and after destination publication; and publishes the identical source manifest last. A source change, existing destination, partial publication, or record mismatch fails without leaving a package. Transfer the completed destination as one artifact, verify the reported manifest SHA-256 out of band, install it root-owned on the guest, and pass that exact digest as `RUNNER_RELEASE_MANIFEST_SHA256`.

### Exact NUC-to-guest release handoff

Use two terminals: the first on the trusted NUC and the second connected to the dedicated guest. The NUC administrator must already have a verified, pinned guest host key in `/etc/learncoding/runner-known-hosts`; do not accept a changed SSH fingerprint during a release. The package report and manifest digest are non-secret release evidence. Never transfer the host Git checkout, a developer working tree, or any application secret other than the dedicated runner shared secret.

On the trusted NUC, package the clean reviewed checkout, parse the packager's canonical report, stream the root-owned tree over pinned-host-key SSH, and independently verify the received tree. This block refuses a moving or shortened Git identity and refuses to merge into an existing incoming path:

```bash
set -Eeuo pipefail
cd /opt/learncoding
RUNNER_GUEST='codestead-admin@192.168.122.12'
RUNNER_RELEASE_COMMIT="$(sudo git -C /opt/learncoding rev-parse HEAD)"
printf '%s\n' "$RUNNER_RELEASE_COMMIT" | grep -Eq '^[0-9a-f]{40}$'
test -z "$(sudo git -C /opt/learncoding status --porcelain=v1 --untracked-files=all)"
RUNNER_RELEASE_PARENT=/var/lib/learncoding/runner-releases
RUNNER_PACKAGE="$RUNNER_RELEASE_PARENT/release-$RUNNER_RELEASE_COMMIT"
RUNNER_PACKAGE_REPORT=/var/lib/learncoding/runner-releases/package-report.json
sudo install -d -o root -g root -m 0700 "$RUNNER_RELEASE_PARENT"
sudo test ! -e "$RUNNER_PACKAGE"
APPLICATION_RECORD_SHA256="$(sudo sha256sum /opt/learncoding/dist/application-images/application-images.json | cut -d' ' -f1)"
RUNNER_RUNTIME_RECORD_ID="$(sudo /usr/bin/node -p "require('/opt/learncoding/services/runner/dist/runtime-images.json').recordId")"
printf '%s\n' "$APPLICATION_RECORD_SHA256" | grep -Eq '^[0-9a-f]{64}$'
printf '%s\n' "$RUNNER_RUNTIME_RECORD_ID" | grep -Eq '^[0-9a-f]{64}$'
sudo install -o root -g root -m 0600 /dev/null "$RUNNER_PACKAGE_REPORT.new"
sudo -H /usr/bin/python3.12 /opt/learncoding/infra/ops/package-release-tree.py \
  --source /opt/learncoding \
  --destination "$RUNNER_PACKAGE" \
  --application-image-json /opt/learncoding/dist/application-images/application-images.json \
  --application-image-env /opt/learncoding/dist/application-images/application-images.env \
  --application-image-record-sha256 "$APPLICATION_RECORD_SHA256" \
  --runner-runtime-json /opt/learncoding/services/runner/dist/runtime-images.json \
  --runner-runtime-env /opt/learncoding/services/runner/dist/runtime-images.env \
  --runner-runtime-record-id "$RUNNER_RUNTIME_RECORD_ID" \
  | sudo tee "$RUNNER_PACKAGE_REPORT.new" >/dev/null
sudo mv -- "$RUNNER_PACKAGE_REPORT.new" "$RUNNER_PACKAGE_REPORT"
RUNNER_REPORTED_COMMIT="$(sudo jq -er '.git_commit' "$RUNNER_PACKAGE_REPORT")"
RUNNER_REPORTED_DESTINATION="$(sudo jq -er '.destination' "$RUNNER_PACKAGE_REPORT")"
RUNNER_MANIFEST_SHA256="$(sudo jq -er '.manifest_sha256' "$RUNNER_PACKAGE_REPORT")"
test "$RUNNER_REPORTED_COMMIT" = "$RUNNER_RELEASE_COMMIT"
test "$RUNNER_REPORTED_DESTINATION" = "$RUNNER_PACKAGE"
printf '%s\n' "$RUNNER_MANIFEST_SHA256" | grep -Eq '^[0-9a-f]{64}$'
RUNNER_INCOMING="/var/tmp/codestead-runner-release.$RUNNER_MANIFEST_SHA256"
sudo test -d "$RUNNER_PACKAGE" -a ! -L "$RUNNER_PACKAGE"
sudo tar --create --file=- --numeric-owner --owner=0 --group=0 \
  --directory="$RUNNER_RELEASE_PARENT" "$(basename "$RUNNER_PACKAGE")" \
  | ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes \
      -o UserKnownHostsFile=/etc/learncoding/runner-known-hosts "$RUNNER_GUEST" \
      "sudo test ! -e '$RUNNER_INCOMING' && sudo install -d -o root -g root -m 0755 '$RUNNER_INCOMING' && sudo tar --extract --file=- --directory='$RUNNER_INCOMING' --strip-components=1 --numeric-owner --same-owner --same-permissions"
ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/etc/learncoding/runner-known-hosts "$RUNNER_GUEST" \
  "sudo /usr/bin/python3.12 '$RUNNER_INCOMING/infra/runner-vm/verify-release-tree.py' '$RUNNER_INCOMING' '$RUNNER_MANIFEST_SHA256' >/dev/null"
printf 'runner_commit=%s\nrunner_manifest_sha256=%s\nrunner_incoming=%s\n' \
  "$RUNNER_RELEASE_COMMIT" "$RUNNER_MANIFEST_SHA256" "$RUNNER_INCOMING"
```

Stream the one permitted secret without writing a user-owned transfer copy. The command emits no secret bytes and installs the file with numeric GID `991`; the installer creates and validates the corresponding `learncoding-runner` group before reading it:

```bash
set -Eeuo pipefail
RUNNER_GUEST='codestead-admin@192.168.122.12'
sudo dd if=/etc/learncoding/secrets/runner_shared_secret status=none \
  | ssh -T -o BatchMode=yes -o StrictHostKeyChecking=yes \
      -o UserKnownHostsFile=/etc/learncoding/runner-known-hosts "$RUNNER_GUEST" \
      "sudo install -d -o 0 -g 0 -m 0750 /etc/learncoding && sudo dd of=/etc/learncoding/runner-shared-secret status=none && sudo chown 0:991 /etc/learncoding/runner-shared-secret && sudo chmod 0440 /etc/learncoding/runner-shared-secret"
```

In the guest terminal, paste the manifest printed by the NUC, verify the staged tree again, and stage the exact non-secret installer pins reviewed for this release. Every `REPLACE_WITH_REVIEWED_*` value is intentionally invalid until replaced; the installer fails closed if any pin is missing or malformed:

```bash
set -Eeuo pipefail
RUNNER_MANIFEST_SHA256='REPLACE_WITH_REVIEWED_64_HEX_MANIFEST_SHA256'
printf '%s\n' "$RUNNER_MANIFEST_SHA256" | grep -Eq '^[0-9a-f]{64}$'
RUNNER_INCOMING="/var/tmp/codestead-runner-release.$RUNNER_MANIFEST_SHA256"
sudo /usr/bin/python3.12 "$RUNNER_INCOMING/infra/runner-vm/verify-release-tree.py" \
  "$RUNNER_INCOMING" "$RUNNER_MANIFEST_SHA256" >/dev/null
sudo install -d -o root -g root -m 0700 /var/lib/codestead-runner-releases
sudo install -o root -g root -m 0600 /dev/null /etc/learncoding/runner-install-pins.env
RUNNER_RELEASE_MANIFEST_SHA256="$RUNNER_MANIFEST_SHA256"
{
  printf 'RUNNER_RELEASE_MANIFEST_SHA256=%s\n' "$RUNNER_RELEASE_MANIFEST_SHA256"
  cat <<'PINS'
RUNNER_DOCKER_CE_PACKAGE_VERSION=REPLACE_WITH_REVIEWED_EXACT_VERSION
RUNNER_DOCKER_CLI_PACKAGE_VERSION=REPLACE_WITH_REVIEWED_EXACT_VERSION
RUNNER_CONTAINERD_PACKAGE_VERSION=REPLACE_WITH_REVIEWED_EXACT_VERSION
RUNNER_BUILDX_PACKAGE_VERSION=REPLACE_WITH_REVIEWED_EXACT_VERSION
RUNNER_COMPOSE_PACKAGE_VERSION=REPLACE_WITH_REVIEWED_EXACT_VERSION
RUNNER_NODEJS_PACKAGE_VERSION=REPLACE_WITH_REVIEWED_EXACT_VERSION
RUNNER_DOCKER_KEY_SHA256=REPLACE_WITH_REVIEWED_64_HEX_SHA256
RUNNER_NODESOURCE_KEY_SHA256=REPLACE_WITH_REVIEWED_64_HEX_SHA256
RUNNER_TRIVY_VERSION=REPLACE_WITH_REVIEWED_X_Y_Z
RUNNER_TRIVY_ARCHIVE_SHA256=REPLACE_WITH_REVIEWED_64_HEX_SHA256
RUNNER_SYFT_VERSION=REPLACE_WITH_REVIEWED_X_Y_Z
RUNNER_SYFT_ARCHIVE_SHA256=REPLACE_WITH_REVIEWED_64_HEX_SHA256
RUNNER_GRYPE_VERSION=REPLACE_WITH_REVIEWED_X_Y_Z
RUNNER_GRYPE_ARCHIVE_SHA256=REPLACE_WITH_REVIEWED_64_HEX_SHA256
PINS
} | sudo tee /etc/learncoding/runner-install-pins.env >/dev/null
sudo chown root:root /etc/learncoding/runner-install-pins.env
sudo chmod 0600 /etc/learncoding/runner-install-pins.env
```

After replacing every placeholder in the root-owned pin file, perform the bounded swap and install. The old tree is retained by its verified manifest digest; a failure leaves code execution stopped while the trusted learning application remains usable:

```bash
set -Eeuo pipefail
RUNNER_MANIFEST_SHA256='REPLACE_WITH_REVIEWED_64_HEX_MANIFEST_SHA256'
printf '%s\n' "$RUNNER_MANIFEST_SHA256" | grep -Eq '^[0-9a-f]{64}$'
RUNNER_INCOMING="/var/tmp/codestead-runner-release.$RUNNER_MANIFEST_SHA256"
sudo /usr/bin/python3.12 "$RUNNER_INCOMING/infra/runner-vm/verify-release-tree.py" \
  "$RUNNER_INCOMING" "$RUNNER_MANIFEST_SHA256" >/dev/null
if sudo test -d /opt/learncoding -a ! -L /opt/learncoding; then
  CURRENT_RUNNER_MANIFEST="$(sudo sha256sum /opt/learncoding/RELEASE.SHA256SUMS | cut -d' ' -f1)"
  printf '%s\n' "$CURRENT_RUNNER_MANIFEST" | grep -Eq '^[0-9a-f]{64}$'
  sudo /usr/bin/python3.12 /opt/learncoding/infra/runner-vm/verify-release-tree.py \
    /opt/learncoding "$CURRENT_RUNNER_MANIFEST" >/dev/null
  RUNNER_PREVIOUS=/opt/learncoding.previous."$CURRENT_RUNNER_MANIFEST"
  sudo test ! -e "$RUNNER_PREVIOUS"
  sudo systemctl stop learncoding-runner.service
  sudo mv -- /opt/learncoding "$RUNNER_PREVIOUS"
else
  CURRENT_RUNNER_MANIFEST=none
  sudo systemctl stop learncoding-runner.service 2>/dev/null || true
fi
sudo mv -- "$RUNNER_INCOMING" /opt/learncoding
sudo install -o 0 -g 991 -m 0640 /dev/null /etc/learncoding/runner.env
{
  sudo sed '/^RUNNER_IMAGE_/d' /opt/learncoding/infra/env/runner.env.example
  sudo cat /opt/learncoding/services/runner/dist/runtime-images.env
} | sudo tee /etc/learncoding/runner.env >/dev/null
sudo chown 0:991 /etc/learncoding/runner.env
sudo chmod 0640 /etc/learncoding/runner.env
sudo /usr/bin/bash --noprofile --norc <<'ROOT'
set -Eeuo pipefail
pins=/etc/learncoding/runner-install-pins.env
test "$(stat -c '%U:%G:%a:%h' -- "$pins")" = root:root:600:1
declare -A seen=()
pin_count=0
while IFS='=' read -r key value; do
  case "$key" in
    RUNNER_RELEASE_MANIFEST_SHA256|RUNNER_DOCKER_CE_PACKAGE_VERSION|RUNNER_DOCKER_CLI_PACKAGE_VERSION|RUNNER_CONTAINERD_PACKAGE_VERSION|RUNNER_BUILDX_PACKAGE_VERSION|RUNNER_COMPOSE_PACKAGE_VERSION|RUNNER_NODEJS_PACKAGE_VERSION|RUNNER_DOCKER_KEY_SHA256|RUNNER_NODESOURCE_KEY_SHA256|RUNNER_TRIVY_VERSION|RUNNER_TRIVY_ARCHIVE_SHA256|RUNNER_SYFT_VERSION|RUNNER_SYFT_ARCHIVE_SHA256|RUNNER_GRYPE_VERSION|RUNNER_GRYPE_ARCHIVE_SHA256) ;;
    *) printf 'unexpected runner install pin: %s\n' "$key" >&2; exit 1 ;;
  esac
  [[ ! -v "seen[$key]" ]] || { printf 'duplicate runner install pin: %s\n' "$key" >&2; exit 1; }
  seen["$key"]=1
  export "$key=$value"
  ((pin_count += 1))
done <"$pins"
((pin_count == 15)) || { printf 'runner install pin inventory is incomplete\n' >&2; exit 1; }
/opt/learncoding/infra/runner-vm/install-guest.sh
install -o root -g root -m 0600 "$pins" \
  "/var/lib/codestead-runner-releases/$RUNNER_RELEASE_MANIFEST_SHA256.env"
ROOT
sudo systemctl is-active --quiet learncoding-runner.service
printf 'previous_runner_manifest=%s\nactive_runner_manifest=%s\n' \
  "$CURRENT_RUNNER_MANIFEST" "$RUNNER_MANIFEST_SHA256"
```

### Exact runner rollback

Rollback is a guest-only maintenance action. Use the two manifest digests printed by the prior successful deployment; do not discover a target by modification time or guess a directory. The retained tree and its recorded pin file must both verify before the active tree moves. Replace both placeholders, then run in the guest:

```bash
set -Eeuo pipefail
FAILED_RUNNER_MANIFEST='REPLACE_WITH_FAILED_64_HEX_MANIFEST_SHA256'
PREVIOUS_RUNNER_MANIFEST='REPLACE_WITH_PREVIOUS_64_HEX_MANIFEST_SHA256'
printf '%s\n' "$FAILED_RUNNER_MANIFEST" | grep -Eq '^[0-9a-f]{64}$'
printf '%s\n' "$PREVIOUS_RUNNER_MANIFEST" | grep -Eq '^[0-9a-f]{64}$'
RUNNER_PREVIOUS=/opt/learncoding.previous."$PREVIOUS_RUNNER_MANIFEST"
RUNNER_FAILED=/opt/learncoding.failed."$FAILED_RUNNER_MANIFEST"
PREVIOUS_PINS="/var/lib/codestead-runner-releases/$PREVIOUS_RUNNER_MANIFEST.env"
sudo test -d "$RUNNER_PREVIOUS" -a ! -L "$RUNNER_PREVIOUS"
sudo test "$(sudo sha256sum /opt/learncoding/RELEASE.SHA256SUMS | cut -d' ' -f1)" = "$FAILED_RUNNER_MANIFEST"
sudo /usr/bin/python3.12 /opt/learncoding/infra/runner-vm/verify-release-tree.py \
  /opt/learncoding "$FAILED_RUNNER_MANIFEST" >/dev/null
sudo test ! -e "$RUNNER_FAILED"
sudo test "$(sudo sha256sum "$RUNNER_PREVIOUS/RELEASE.SHA256SUMS" | cut -d' ' -f1)" = "$PREVIOUS_RUNNER_MANIFEST"
sudo test "$(sudo stat -c '%U:%G:%a:%h' -- "$PREVIOUS_PINS")" = root:root:600:1
sudo /usr/bin/python3.12 "$RUNNER_PREVIOUS/infra/runner-vm/verify-release-tree.py" \
  "$RUNNER_PREVIOUS" "$PREVIOUS_RUNNER_MANIFEST" >/dev/null
sudo systemctl stop learncoding-runner.service
sudo mv -- /opt/learncoding "$RUNNER_FAILED"
sudo mv -- "$RUNNER_PREVIOUS" /opt/learncoding
sudo install -o 0 -g 991 -m 0640 /dev/null /etc/learncoding/runner.env
{
  sudo sed '/^RUNNER_IMAGE_/d' /opt/learncoding/infra/env/runner.env.example
  sudo cat /opt/learncoding/services/runner/dist/runtime-images.env
} | sudo tee /etc/learncoding/runner.env >/dev/null
sudo chown 0:991 /etc/learncoding/runner.env
sudo chmod 0640 /etc/learncoding/runner.env
sudo install -o root -g root -m 0600 "$PREVIOUS_PINS" /etc/learncoding/runner-install-pins.env
sudo /usr/bin/bash --noprofile --norc <<'ROOT'
set -Eeuo pipefail
pins=/etc/learncoding/runner-install-pins.env
test "$(stat -c '%U:%G:%a:%h' -- "$pins")" = root:root:600:1
declare -A seen=()
pin_count=0
while IFS='=' read -r key value; do
  case "$key" in
    RUNNER_RELEASE_MANIFEST_SHA256|RUNNER_DOCKER_CE_PACKAGE_VERSION|RUNNER_DOCKER_CLI_PACKAGE_VERSION|RUNNER_CONTAINERD_PACKAGE_VERSION|RUNNER_BUILDX_PACKAGE_VERSION|RUNNER_COMPOSE_PACKAGE_VERSION|RUNNER_NODEJS_PACKAGE_VERSION|RUNNER_DOCKER_KEY_SHA256|RUNNER_NODESOURCE_KEY_SHA256|RUNNER_TRIVY_VERSION|RUNNER_TRIVY_ARCHIVE_SHA256|RUNNER_SYFT_VERSION|RUNNER_SYFT_ARCHIVE_SHA256|RUNNER_GRYPE_VERSION|RUNNER_GRYPE_ARCHIVE_SHA256) ;;
    *) printf 'unexpected runner install pin: %s\n' "$key" >&2; exit 1 ;;
  esac
  [[ ! -v "seen[$key]" ]] || { printf 'duplicate runner install pin: %s\n' "$key" >&2; exit 1; }
  seen["$key"]=1
  export "$key=$value"
  ((pin_count += 1))
done <"$pins"
((pin_count == 15)) || { printf 'runner install pin inventory is incomplete\n' >&2; exit 1; }
test "$RUNNER_RELEASE_MANIFEST_SHA256" = "$(sha256sum /opt/learncoding/RELEASE.SHA256SUMS | cut -d' ' -f1)"
/opt/learncoding/infra/runner-vm/install-guest.sh
ROOT
sudo systemctl is-active --quiet learncoding-runner.service
```

If any verification, move, install, firewall, runtime-image, or service check fails, keep code execution disabled. Do not move the runner onto the trusted NUC, modify PostgreSQL, or start the service manually around a failed installer. Preserve the failed and previous trees for incident review; learning, authentication, and progress remain available without code execution.

Runner request authentication is a lockstep protocol with the trusted app. HMAC v2 binds the request ID and POST idempotency key in addition to method, path, timestamp, nonce, and raw-body hash. During an upgrade, stop app runner intake, deploy both client and runner, then resume; mixed HMAC-v1/v2 versions fail authentication by design.

The exact handoff above streams the shared secret directly to `/etc/learncoding/runner-shared-secret`; after account creation it must resolve to `root:learncoding-runner`, mode `0440`, and exactly match the NUC's mounted `runner_shared_secret`. After the installer reports success, verify state without manually starting around a failure:

```bash
sudo systemctl is-enabled --quiet docker.service learncoding-runner-guest-firewall.service learncoding-runner.service
sudo systemctl is-active --quiet docker.service learncoding-runner-guest-firewall.service learncoding-runner.service
sudo test "$(sudo stat -c '%U:%G:%a:%h' -- /etc/learncoding/runner-shared-secret)" = root:learncoding-runner:440:1
curl --fail --silent http://192.168.122.12:4100/healthz \
  | jq -e '.status == "ok" and .concurrency == 2 and .activeJobs == 0' >/dev/null
```

The reference unit creates `/var/lib/learncoding-runner` through systemd `StateDirectory` with mode `0700`; keep `RUNNER_STATE_ROOT` set to that exact path. The launcher takes a nonblocking kernel `flock` there before container or temporary-directory reconciliation and holds its file descriptor through `exec` for the entire Node lifetime. A second launcher must exit without removing containers or touching state; direct `node dist/index.js` startup is unsupported and rejected. The runner creates `runner-state-v1.json` with mode `0600` using atomic replacement and fsync. It contains only job identifiers, request hashes, idempotency bindings, and privacy-projected terminal evidence. Submitted source, stdin, test bodies, and execution output are forbidden from this journal. `RUNNER_TEMP_ROOT` defaults to `/var/lib/learncoding-runner/tmp`; before journal load the service validates its mode/owner/no-symlink boundary and removes only owned, non-symlink `job-*` trees left by a crash. The unit sets `LimitCORE=0` because process memory can contain learner source and test data. Do not put runner state on NFS, a shared folder, or the trusted NUC.

## Required per-job controls

Before release, inspect `services/runner/src/docker-executor.ts` and its tests for all of these:

- `--rm`, unique name, and bounded queue/idempotency behavior;
- `--pull never` and an image reference pinned by SHA-256;
- `--network none`, `--ipc none`, and no Docker socket/device mounts;
- read-only root, only bounded tmpfs work/tmp directories, and read-only source mount;
- all Linux capabilities dropped and `no-new-privileges`;
- unprivileged numeric user;
- wall-clock kill plus PID, memory, swap, CPU, file-size, open-file, and output limits;
- no log driver for job containers and no full source in service logs;
- server-side limit maxima; client input cannot raise them;
- exactly two concurrent jobs.

Any missing control blocks deployment.

## Operational checks

1. Submit infinite loop, fork/process storm, large allocation, oversized output, filesystem write, network/DNS, and timeout fixtures.
2. Confirm every job terminates within its server limit and leaves no container or job directory.
3. Confirm a job cannot reach NUC, metadata, LAN, internet, Docker socket, or another job.
4. Confirm image digest appears in the result and `--pull never` rejects an absent image.
5. Confirm queue overload returns a controlled response rather than consuming unbounded memory.
6. Reboot the VM and repeat a normal run.
7. During a deliberately interrupted run, restart the service and confirm signed GET returns FAILED with retryable `RUNNER_RESTART_RECOVERED`, while replaying the identical POST/key returns the same job and a changed body returns 409.

## Restart and journal recovery

The runner durably records QUEUED before execution and RUNNING before entering a learner container. After an unclean service or VM restart, any prior QUEUED/RUNNING job is converted before listen to a terminal FAILED record with `RUNNER_RESTART_RECOVERED`. This is an operational retry signal, not a learner failure. Existing terminal records remain GET-visible and exactly replayable only while their idempotency binding is unexpired (24 hours by default); startup and each new POST durably evict expired terminal job/binding pairs. An active job is retained even if its original binding crosses the TTL. Recovery renews that binding for one configured TTL from startup, ensuring the first exact replay returns the recovered job while a changed body remains 409; eviction begins only after this explicit recovery grace.

The journal keeps status, totals, timing, runtime/image/hash evidence, and feedback codes, but never execution text that could echo source, stdin, or expected output. It writes empty compiler/run stdout and stderr and omits actual/expected/stderr fields from every persisted test result, including visible tests. Full output remains available from the live process; after a rare restart, a recovered COMPLETED result can therefore have degraded output detail. Treat that as expected recovery behavior and use the trusted application's already-persisted response when available. The journal is capped at 128 MiB and 100,000 records per job/binding array.

Startup deliberately fails instead of ignoring a corrupt journal, unsafe ownership/mode, symlink, unsupported schema, or mismatched binding. Diagnose without printing or copying journal content:

```bash
sudo systemctl status learncoding-runner.service
sudo journalctl -u learncoding-runner.service --since -15m --no-pager
sudo stat -c '%F %U:%G %a %n' /var/lib/learncoding-runner \
  /var/lib/learncoding-runner/runner-state-v1.json
```

Expected values are a `learncoding-runner:learncoding-runner` directory at `700` and regular journal file at `600`. Correct only an independently verified ownership/mode drift while the service is stopped. Never hand-edit the JSON. For corruption or a schema/binding failure, keep the service stopped, preserve a VM/disk snapshot as hostile incident evidence, and determine the storage/root cause. Starting with an empty journal discards GET visibility and idempotent replay, so quarantine/replace it only under an explicit incident decision after the trusted application is prepared to retry unresolved submissions. Do not move the journal to the trusted host.

## Resolve a quarantined practice dispatch

This is the only operator path for the administrator action **Resolve quarantined practice run**. It applies only to a non-authoritative `server_compile` or `server_run` practice job. Never use it for an exam, hidden-test submission, assessment correction, or other official evidence. A quarantined application row means the trusted application cannot prove whether an earlier remote dispatch crossed the network boundary; changing that row before stopping the possible remote execution would create a race.

Normal recovery remains automatic and identity-preserving. A queued practice admission older than two minutes with no immutable dispatch snapshot, no remote ID, and no crossed dispatch boundary is safely failed as `PRACTICE_PRE_DISPATCH_STALE` without contacting the runner. A valid persisted snapshot is replayed with the original `runnerRequestId` as its remote idempotency key. An indeterminate remote result becomes `retry_wait` with exponential delay beginning at five seconds and capped at fifteen minutes, so it cannot hot-loop or starve later work. A corrupt snapshot or a persisted submission/job status mismatch becomes `quarantined`, receives no automatic retry, stays visible in mentor evidence, and blocks account deletion until this procedure succeeds. Every dispatch-begin, remote-ID record, and terminal-settlement transaction rechecks that state under the learner lock and rejects `quarantined` with `RECOVERY_QUARANTINED` before a new remote request or local result write. This durable fence remains in force while the administrator performs the ceremony. The mentor-evidence row exposes only bounded operator identifiers: the application runner-job ID, `runnerRequestId` idempotency/request key, and `remoteRunnerJobId` when one was durably received. It does not expose source, stdin, response streams, hidden tests, or request hashes.

Perform the following procedure in an announced maintenance window. Keep a private incident note containing the application runner-job ID and the bounded mentor-evidence fields; do not paste identifiers into chat, tickets, shell commands, or service logs. The hostile runner and its Docker daemon remain on the **dedicated isolated runner VM, never on the trusted NUC**.

1. On the trusted NUC, stop every component that can create or recover runner work, including public ingress. Do not stop PostgreSQL:

   ```bash
   cd /opt/learncoding
   sudo docker compose stop cloudflared app regrade-worker exam-finalization-worker practice-runner-recovery-worker
   ```

   Wait for the commands to finish. Keep the three runner workers stopped until after the administrator resolution succeeds. If another runner-capable service is added later, this command and its documentation contract must be updated before deployment.

2. On the dedicated runner VM, restart the whole VM (not merely a learner container), wait for boot, and verify the systemd service. The boot path holds the single-writer lock, removes only labeled stale learner containers and private `job-*` directories, and converts journaled QUEUED/RUNNING records to retryable recovery failures before accepting traffic:

   ```bash
   sudo systemctl reboot
   # Reconnect to the dedicated runner VM after it boots.
   sudo systemctl is-active --quiet learncoding-runner.service \
     && printf 'runner_service_active=true\n' \
     || printf 'runner_service_active=false\n'
   ```

   A false result is a hard stop. Inspect only aggregate systemd status as described above; do not proceed to an administrator attestation.

3. Still on the dedicated runner VM, prove the public health response is healthy and idle. Set `RUNNER_URL` to the exact private `RUNNER_HOST` and `RUNNER_PORT` installed in `/etc/learncoding/runner.env`; the example below matches the reference private address. Do not substitute localhost when the service is bound only to its private NIC. This command discards the response and emits one boolean only:

   ```bash
   RUNNER_URL=http://192.168.122.12:4100
   if curl --fail --silent --show-error "$RUNNER_URL/healthz" 2>/dev/null \
     | jq -e 'type == "object" and .status == "ok" and .queueDepth == 0 and .activeJobs == 0 and .concurrency == 2' \
       >/dev/null 2>&1; then
     printf 'runner_health_idle=true\n'
   else
     printf 'runner_health_idle=false\n'
   fi
   ```

4. Independently verify the authenticated metrics endpoint. Run the following unchanged on the dedicated runner VM. It reads the shared secret from its mode-`0440` file, verifies the signed response, parses only the two named gauges, and prints one boolean; it never prints the secret, signature, metrics body, job data, or journal data:

   ```bash
   sudo -u learncoding-runner env \
     RUNNER_SHARED_SECRET_FILE=/etc/learncoding/runner-shared-secret \
     RUNNER_URL=http://192.168.122.12:4100 \
     /usr/bin/node <<'NODE'
   const { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
   const { readFileSync } = require("node:fs");

   const sha256 = (value) => createHash("sha256").update(value).digest("hex");
   // The production launcher uses command substitution, which removes trailing LF bytes.
   const secret = readFileSync(process.env.RUNNER_SHARED_SECRET_FILE, "utf8").replace(/\n+$/, "");
   const requestId = randomUUID();
   const timestamp = String(Math.floor(Date.now() / 1000));
   const nonce = randomBytes(24).toString("base64url");
   const canonical = [
     "LEARNCODING-RUNNER-HMAC-V2", "GET", "/metrics", timestamp,
     nonce, requestId, "", sha256(""),
   ].join("\n");
   const signature = `sha256=${createHmac("sha256", secret).update(canonical).digest("hex")}`;

   (async () => {
     const response = await fetch(`${process.env.RUNNER_URL}/metrics`, { headers: {
       "x-runner-timestamp": timestamp,
       "x-runner-nonce": nonce,
       "x-runner-signature": signature,
       "x-request-id": requestId,
     }});
     const body = await response.text();
     const supplied = response.headers.get("x-runner-response-signature") ?? "";
     const expected = `sha256=${createHmac("sha256", secret)
       .update(`${requestId}\n${response.status}\n${sha256(body)}`).digest("hex")}`;
     const signed = supplied.length === expected.length
       && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
     const gauge = (name) => {
       const match = body.match(new RegExp(`^${name} ([0-9]+(?:\\.[0-9]+)?)$`, "m"));
       return match ? Number(match[1]) : Number.NaN;
     };
     const idle = response.ok && signed
       && gauge("runner_queue_depth") === 0
       && gauge("runner_active_jobs") === 0;
     printf(idle);
   })().catch(() => printf(false));

   function printf(value) {
     process.stdout.write(`runner_metrics_idle=${value}\n`);
     if (!value) process.exitCode = 1;
   }
   NODE
   ```

   Both `runner_health_idle=true` and `runner_metrics_idle=true` are required. Any false, malformed, or missing result means stop and escalate.

5. Only after the service has successfully loaded and both idle checks pass, run the privacy projection below on the dedicated runner VM. The first command emits the accepted-schema boolean and active-job count only. The second is optional: silently enter the `remoteRunnerJobId` when mentor evidence has one and the `runnerRequestId` idempotency/request key when it is available. It emits only presence booleans and match counts; it never emits either supplied identifier or any journal field value.

   ```bash
   sudo -u learncoding-runner jq -c '
     {
       schemaVersionAccepted: (.schemaVersion == 1),
       activeJobCount: ([.jobs[] | select(.state == "QUEUED" or .state == "RUNNING")] | length)
     }
   ' /var/lib/learncoding-runner/runner-state-v1.json

   sudo -u learncoding-runner /bin/bash --noprofile --norc <<'BASH'
   STATE=/var/lib/learncoding-runner/runner-state-v1.json
   read -r -s -p 'remoteRunnerJobId (optional; input is hidden): ' REMOTE_JOB_ID
   printf '\n'
   read -r -s -p 'runnerRequestId/idempotency key (optional; input is hidden): ' REQUEST_KEY
   printf '\n'
   jq -c --arg remote "$REMOTE_JOB_ID" --arg requestKey "$REQUEST_KEY" '
     def remote_matches:
       if $remote == "" then [] else [.jobs[] | select(.jobId == $remote)] end;
     def key_matches:
       if $requestKey == "" then [] else [.idempotency[] | select(.key == $requestKey)] end;
     def binding_matches:
       if $remote == "" and $requestKey == "" then []
       else [
         .idempotency[] as $binding
         | .jobs[] as $job
         | select($binding.jobId == $job.jobId)
         | select(($remote == "" or $job.jobId == $remote)
           and ($requestKey == "" or $binding.key == $requestKey))
       ] end;
     {
       remoteJobIdSupplied: ($remote != ""),
       requestKeySupplied: ($requestKey != ""),
       remoteJobIdMatchCount: (remote_matches | length),
       idempotencyKeyMatchCount: (key_matches | length),
       sameBindingMatchCount: (binding_matches | length),
       allSuppliedIdentifiersMatch: (
         ($remote != "" or $requestKey != "")
         and ($remote == "" or (remote_matches | length) == 1)
         and ($requestKey == "" or (key_matches | length) == 1)
         and (binding_matches | length) == 1
       )
     }
   ' "$STATE"
   unset REMOTE_JOB_ID REQUEST_KEY STATE
   BASH
   ```

   `schemaVersionAccepted` must be `true` and `activeJobCount` must be `0`. When either identifier is supplied, `allSuppliedIdentifiersMatch` must be `true`; every supplied identifier must have exactly one match and the pair, when both are supplied, must resolve through exactly one idempotency binding. Zero, duplicate, cross-bound, or unexpected matches are not permission to guess. Stop, keep the quarantined application row unchanged, and escalate for incident review. Never use `cat`, `less`, `more`, `head`, `tail`, an unrestricted `jq`, or an editor on the journal. Never print, copy, upload, or move the journal. A service load failure or corruption finding cannot satisfy `journalReconciled`; preserve the runner VM/disk snapshot, keep execution disabled, and follow incident response.

6. Bring back only the trusted app and administrator-restricted ingress while the runner workers remain stopped. Before starting `cloudflared`, put the tunnel behind a maintenance Access policy that admits only the administrator identity; if that restriction is not already verified, keep `cloudflared` stopped and use the deployment's administrator-only local maintenance access instead. The database quarantine fence must still be present in freshly read evidence:

   ```bash
   cd /opt/learncoding
   sudo docker compose up -d app
   # Run only after the administrator-only maintenance Access policy is verified:
   sudo docker compose up -d cloudflared
   ```

   In the administrator mentor-evidence view, refresh the quarantined item and confirm it still reports `recoveryState=quarantined`; do not proceed if it does not. Complete fresh MFA, enter a specific 20–500 character reason, and select both attestations: `isolatedRunnerRestarted=true` and `journalReconciled=true`. Then choose **Resolve quarantined practice run**. A learner retry during this window is rejected by the durable `RECOVERY_QUARANTINED` dispatch fence and cannot cross to the runner. The action is rate-limited, immutable-audited, learner-notified, and changes only the non-authoritative practice job to cancelled; it must report `officialEvidenceChanged=false`. Never call the endpoint or set either attestation unless every preceding check passed in this same maintenance window.

7. Confirm the success audit `runner.practice.quarantine.resolve` and learner notification exist without exposing their bodies. Then restore the runner workers:

   ```bash
   cd /opt/learncoding
   sudo docker compose up -d regrade-worker exam-finalization-worker practice-runner-recovery-worker
   ```

   If the administrator action fails, keep the workers stopped, preserve the quarantine, and investigate the returned bounded error code. Do not update PostgreSQL manually and do not retry with invented identifiers or attestations.

## Compromise response

At the hypervisor, disconnect the runner NIC; do not log into a suspected VM before containment. Disable code execution in the app, rotate the runner shared secret on the NUC, preserve a VM snapshot only if incident analysis is needed, then rebuild a new VM from a clean image. Re-pull reviewed digests, install a new shared secret, rerun hostile fixtures, and only then update the deployment-level `RUNNER_BASE_URL` to the gateway's private upstream. Keep the app and worker effective container URL fixed at `http://runner-egress-gateway:4100`; do not connect them directly to the rebuilt VM.

Never promote a compromised runner disk back into service. Do not copy logs or job directories to the trusted host unless an incident lead has reviewed them as hostile evidence.
