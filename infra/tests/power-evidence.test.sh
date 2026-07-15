#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
collector="$repo_root/infra/ops/capture-recovery-evidence.sh"
tmp_base="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
work="$(mktemp -d "$tmp_base/power-evidence.XXXXXX")"
work="$(cd "$work" && pwd -P)"
[[ ! -L "$work" && "$work" == "$tmp_base"/* ]] || {
  echo 'FAIL: recovery evidence fixture escaped its verified temporary root' >&2
  exit 1
}
chmod 0700 "$work"
cleanup() {
  if [[ -n "${work:-}" && -d "$work" && ! -L "$work" && "$work" == "$tmp_base"/* ]]; then
    rm -rf -- "$work"
  fi
}
trap cleanup EXIT

if [[ ! -f "$collector" ]]; then
  echo 'power recovery evidence contract failed:' >&2
  echo '- missing later-task production asset: infra/ops/capture-recovery-evidence.sh' >&2
  exit 1
fi

if (( EUID != 0 )); then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    cleanup
    trap - EXIT
    exec sudo -n bash "$repo_root/infra/tests/power-evidence.test.sh"
  fi
  echo 'FAIL: power evidence contract requires passwordless sudo for root-owned fixture metadata' >&2
  exit 1
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if grep -Eq '/(usr/)?s?bin/(systemctl|virsh|docker|curl|journalctl|findmnt|smartctl|date|git|uname|mount|umount|wget|nc|ping|stat|realpath|readlink|sha256sum)([[:space:]"'\'']|$)' "$collector"; then
  fail 'evidence collector hard-codes a host command path and can bypass the isolated fake PATH'
fi
grep -Fq 'RECOVERY_EVIDENCE_TEST_ROOT' "$collector" || fail 'evidence collector is missing the single narrow test-root seam'
grep -Fq '/var/lib/learncoding/recovery-evidence' "$collector" || fail 'evidence collector changed the fixed production root'

host_root="$work/host-root"
evidence_root="$host_root/var/lib/learncoding/recovery-evidence"
fake_bin="$work/bin"
state_root="$work/state"
events="$work/events.log"
scenario_file="$state_root/scenario"
mkdir -m 0700 -p "$evidence_root" "$fake_bin" "$state_root" "$host_root/proc/sys/kernel" \
  "$host_root/proc" "$host_root/var/lib/learncoding-runner" "$host_root/etc/learncoding/secrets" \
  "$host_root/var/lib/learncoding/backups"
chown -R 0:0 "$host_root"
chmod 0700 "$evidence_root"
printf '%s' '11111111-2222-3333-4444-555555555555' >"$host_root/proc/sys/kernel/random/boot_id"
printf '%s' '3723.14 100.00' >"$host_root/proc/uptime"
printf '%s' 'backup-20260715T120000Z-fixture' >"$host_root/var/lib/learncoding/backups/last-success"

secret_canary='EVIDENCE_SECRET_CANARY_867ec16a_DO_NOT_PRINT'
learner_canary='EVIDENCE_LEARNER_CANARY_learner@example.invalid'
learner_id_canary='EVIDENCE_LEARNER_ID_CANARY_5b7bdb4e'
source_canary='EVIDENCE_SOURCE_CANARY_private_source_text'
stdin_canary='EVIDENCE_STDIN_CANARY_3efeaa55'
http_body_canary='EVIDENCE_HTTP_BODY_CANARY_0c09407f'
http_header_canary='EVIDENCE_HTTP_HEADER_CANARY_239ff961'
smart_serial_canary='EVIDENCE_SMART_SERIAL_CANARY_S3CR3T42'
runner_journal_canary='EVIDENCE_RUNNER_JOURNAL_CANARY_c80386e0'
raw_command_canary='EVIDENCE_RAW_COMMAND_CANARY_cc4af739'
printf '%s' "$runner_journal_canary" >"$host_root/var/lib/learncoding-runner/private-journal.json"
printf '%s' "$secret_canary" >"$host_root/etc/learncoding/secrets/runner_shared_secret"
chmod 0400 "$host_root/etc/learncoding/secrets/runner_shared_secret"

cat >"$fake_bin/fake-evidence-command" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

command_name="${0##*/}"
{
  printf '%q' "$command_name"
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$FAKE_EVENTS"
scenario="$(<"$FAKE_SCENARIO_FILE")"

inside_host_root() {
  [[ "$1" == "$FAKE_HOST_ROOT" || "$1" == "$FAKE_HOST_ROOT"/* ]]
}

inside_evidence_root() {
  [[ "$1" == "$FAKE_EVIDENCE_ROOT" || "$1" == "$FAKE_EVIDENCE_ROOT"/* ]]
}

case "$command_name" in
  systemctl)
    case "${1:-}:${2:-}" in
      is-active:*) printf '%s\n' active ;;
      is-enabled:*) printf '%s\n' enabled ;;
      show:*) printf '%s\n' 'NRestarts=1' ;;
      *) exit 64 ;;
    esac
    ;;
  virsh)
    if [[ "${1:-}" == --version ]]; then printf '%s\n' '10.0.0-fixture'; exit 0; fi
    if [[ "${1:-}" == --connect && "${2:-}" == qemu:///system ]]; then shift 2; fi
    case "${1:-}:${2:-}" in
      domstate:codestead-runner) printf '%s\n' running ;;
      dominfo:codestead-runner) printf '%s\n' 'Name: codestead-runner' 'Autostart: enable' ;;
      net-info:codestead-runner) printf '%s\n' 'Name: codestead-runner' 'Active: yes' 'Autostart: yes' ;;
      *) exit 64 ;;
    esac
    ;;
  docker)
    joined=" $* "
    if [[ "${1:-}" == version ]]; then printf '%s\n' '29.6.1-fixture'; exit 0; fi
    if [[ "${1:-}" == info ]]; then exit 0; fi
    if [[ "$joined" == *' pg_settings '* || "$joined" == *' synchronous_commit '* ]]; then
      printf '%s\n' 'fsync|on' 'synchronous_commit|on' 'full_page_writes|on' 'data_checksums|on'
      exit 0
    fi
    if [[ "$joined" == *' ps '* || "${1:-}" == ps ]]; then
      printf '%s\n' \
        "learncoding-postgres|running|1|sha256:$(printf 'a%.0s' {1..64})|$FAKE_RAW_COMMAND_CANARY" \
        "learncoding-app|running|0|sha256:$(printf 'b%.0s' {1..64})|$FAKE_LEARNER_CANARY" \
        "learncoding-mail-worker|running|0|sha256:$(printf 'c%.0s' {1..64})|$FAKE_SOURCE_CANARY" \
        "learncoding-reward-worker|running|0|sha256:$(printf 'd%.0s' {1..64})|$FAKE_LEARNER_ID_CANARY" \
        "learncoding-cloudflared|running|0|sha256:$(printf 'e%.0s' {1..64})|ok"
      exit 0
    fi
    exit 64
    ;;
  curl)
    output=
    headers=
    url=
    while (( $# > 0 )); do
      case "$1" in
        --output|-o) output="$2"; shift 2 ;;
        --dump-header|-D) headers="$2"; shift 2 ;;
        http://*|https://*) url="$1"; shift ;;
        *) shift ;;
      esac
    done
    [[ "$url" == https://pilot.example.test/health/ready ]] || exit 97
    body="{\"status\":\"ok\",\"private\":\"$FAKE_HTTP_BODY_CANARY\"}"
    header="HTTP/2 200
x-private-fixture: $FAKE_HTTP_HEADER_CANARY"
    if [[ -n "$output" ]]; then printf '%s' "$body" >"$output"; else printf '%s' "$body"; fi
    if [[ -n "$headers" ]]; then printf '%s\n' "$header" >"$headers"; fi
    ;;
  journalctl)
    printf '%s\n' "$FAKE_RUNNER_JOURNAL_CANARY"
    ;;
  findmnt)
    printf '%s\n' '/srv/learncoding|UUID=fixture-data|rw,nodev,nosuid'
    ;;
  smartctl)
    [[ "$scenario" != smart-fail ]] || exit 2
    printf '%s\n' \
      "Serial Number: $FAKE_SMART_SERIAL_CANARY" \
      'SMART overall-health self-assessment test result: PASSED' \
      'Critical Warning: 0x00' \
      'Media and Data Integrity Errors: 0'
    ;;
  date)
    case "$*" in
      '--utc +%Y-%m-%dT%H:%M:%SZ'|'-u +%Y-%m-%dT%H:%M:%SZ') printf '%s\n' '2026-07-15T12:00:00Z' ;;
      '+%s') printf '%s\n' 1784116800 ;;
      *) exit 64 ;;
    esac
    ;;
  git)
    [[ "$*" == 'rev-parse HEAD' ]] || exit 64
    printf '%s\n' '0123456789abcdef0123456789abcdef01234567'
    ;;
  uname)
    [[ "${1:-}" == -r ]] || exit 64
    printf '%s\n' '6.8.0-fixture'
    ;;
  mktemp)
    destination_hint="${!#}"
    tmpdir=
    for argument in "$@"; do
      case "$argument" in --tmpdir=*) tmpdir="${argument#--tmpdir=}" ;; esac
    done
    if [[ -n "$tmpdir" ]]; then
      inside_evidence_root "$tmpdir" || exit 97
    else
      inside_evidence_root "$destination_hint" || exit 97
    fi
    /usr/bin/mktemp "$@"
    ;;
  mv)
    args=("$@")
    [[ "${args[0]:-}" == -- ]] && args=("${args[@]:1}")
    (( ${#args[@]} == 2 )) || exit 64
    source_path="${args[0]}"
    destination_path="${args[1]}"
    inside_evidence_root "$source_path" && inside_evidence_root "$destination_path" || exit 97
    [[ "$(dirname -- "$source_path")" == "$(dirname -- "$destination_path")" ]] || exit 96
    /usr/bin/mv -- "$source_path" "$destination_path"
    ;;
  sync)
    target="${!#}"
    inside_evidence_root "$target" || exit 97
    /usr/bin/sync "$@"
    ;;
  rm)
    target="${!#}"
    inside_evidence_root "$target" || exit 97
    basename="${target##*/}"
    [[ "$basename" == .*tmp* || "$basename" == *.tmp.* ]] || exit 96
    /usr/bin/rm "$@"
    ;;
  cat)
    for path in "$@"; do
      [[ "$path" != *learncoding-runner* ]] || exit 97
      inside_host_root "$path" || exit 97
    done
    /usr/bin/cat "$@"
    ;;
  stat|realpath|readlink|sha256sum)
    target="${!#}"
    inside_host_root "$target" || exit 97
    "/usr/bin/$command_name" "$@"
    ;;
  mount|umount|wget|nc|ping)
    exit 97
    ;;
  *) exit 64 ;;
esac
FAKE
chmod 0755 "$fake_bin/fake-evidence-command"
for command_name in systemctl virsh docker curl journalctl findmnt smartctl date git uname mktemp mv sync rm cat \
  stat realpath readlink sha256sum \
  mount umount wget nc ping; do
  cp "$fake_bin/fake-evidence-command" "$fake_bin/$command_name"
done

run_collector() {
  local scenario="$1"
  local phase="$2"
  local destination="$3"
  local prefix="$4"
  printf '%s' "$scenario" >"$scenario_file"
  : >"$events"
  set +e
  printf '%s' "$stdin_canary" | env -i \
    HOME="$work" \
    PATH="$fake_bin:/usr/bin:/bin" \
    RECOVERY_EVIDENCE_TEST_ROOT="$host_root" \
    RECOVERY_PUBLIC_URL='https://pilot.example.test/health/ready' \
    FAKE_EVENTS="$events" \
    FAKE_SCENARIO_FILE="$scenario_file" \
    FAKE_HOST_ROOT="$host_root" \
    FAKE_EVIDENCE_ROOT="$evidence_root" \
    FAKE_SECRET_CANARY="$secret_canary" \
    FAKE_LEARNER_CANARY="$learner_canary" \
    FAKE_LEARNER_ID_CANARY="$learner_id_canary" \
    FAKE_SOURCE_CANARY="$source_canary" \
    FAKE_HTTP_BODY_CANARY="$http_body_canary" \
    FAKE_HTTP_HEADER_CANARY="$http_header_canary" \
    FAKE_SMART_SERIAL_CANARY="$smart_serial_canary" \
    FAKE_RUNNER_JOURNAL_CANARY="$runner_journal_canary" \
    FAKE_RAW_COMMAND_CANARY="$raw_command_canary" \
    bash "$collector" "$phase" "$destination" >"$prefix.stdout" 2>"$prefix.stderr"
  collector_status=$?
  set -e
}

assert_canaries_absent() {
  local prefix="$1"
  shift
  local file
  local canary
  for file in "$prefix.stdout" "$prefix.stderr" "$@"; do
    [[ -e "$file" ]] || continue
    for canary in "$secret_canary" "$learner_canary" "$learner_id_canary" "$source_canary" "$stdin_canary" \
      "$http_body_canary" "$http_header_canary" "$smart_serial_canary" "$runner_journal_canary" "$raw_command_canary"; do
      ! grep -Fq -- "$canary" "$file" || fail "privacy canary leaked through ${file##*/}: $canary"
    done
  done
}

validate_evidence_json() {
  local file="$1"
  local phase="$2"
  EVIDENCE_FILE="$file" EXPECTED_PHASE="$phase" node <<'NODE'
const fs = require("node:fs");
const value = JSON.parse(fs.readFileSync(process.env.EVIDENCE_FILE, "utf8"));
const exactKeys = (object, expected) =>
  JSON.stringify(Object.keys(object ?? {}).sort()) === JSON.stringify([...expected].sort());
if (!exactKeys(value, [
  "backup", "bootId", "capturedAtUtc", "containers", "gitCommit", "mounts", "phase",
  "postgres", "recovery", "runner", "schemaVersion", "services", "smart", "uptimeSeconds", "versions",
])) process.exit(2);
if (value.schemaVersion !== 1 || value.phase !== process.env.EXPECTED_PHASE) process.exit(3);
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value.capturedAtUtc)) process.exit(4);
if (!/^[0-9a-f]{40}$/.test(value.gitCommit) || typeof value.bootId !== "string") process.exit(5);
if (!Number.isSafeInteger(value.uptimeSeconds) || value.uptimeSeconds < 0) process.exit(6);
if (!exactKeys(value.services, ["compose", "docker", "firewall", "libvirt", "recoveryTimer"])) process.exit(7);
if (Object.values(value.services).some((entry) => typeof entry !== "boolean")) process.exit(8);
if (!exactKeys(value.containers, ["expected", "items", "running"]) || !Array.isArray(value.containers.items)) process.exit(9);
if (value.containers.items.length > 16) process.exit(10);
for (const item of value.containers.items) {
  if (!exactKeys(item, ["imageId", "name", "restartCount", "status"])) process.exit(11);
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(item.name) || !/^sha256:[0-9a-f]{64}$/.test(item.imageId)) process.exit(12);
  if (!Number.isSafeInteger(item.restartCount) || item.restartCount < 0) process.exit(13);
}
if (!exactKeys(value.runner, ["domainActive", "domainAutostart", "networkActive", "networkAutostart"])) process.exit(14);
if (!Array.isArray(value.mounts) || value.mounts.length > 8) process.exit(15);
for (const mount of value.mounts) if (!exactKeys(mount, ["options", "source", "target"])) process.exit(16);
if (!exactKeys(value.postgres, ["checksums", "durability", "healthy"])) process.exit(17);
if (!exactKeys(value.postgres.durability, ["fsync", "fullPageWrites", "synchronousCommit"])) process.exit(18);
if (Object.values(value.postgres.durability).some((entry) => entry !== "on")) process.exit(19);
if (!exactKeys(value.smart, ["criticalWarnings", "healthy", "mediaErrors"])) process.exit(20);
if (!exactKeys(value.backup, ["lastSuccessfulId"])) process.exit(21);
if (!exactKeys(value.recovery, ["elapsedSeconds", "recovered", "timedOut"])) process.exit(22);
if (!exactKeys(value.versions, ["docker", "hostKernel", "libvirt"])) process.exit(23);
if (Object.values(value.versions).some((entry) => typeof entry !== "string" || entry.length > 64)) process.exit(24);
NODE
}

assert_published() {
  local phase="$1"
  local name="$2"
  local prefix="$3"
  local json="$evidence_root/$name"
  local sidecar="$json.sha256"
  (( collector_status == 0 )) || fail "$phase evidence collection failed: $(<"$prefix.stderr")"
  for file in "$json" "$sidecar"; do
    [[ -f "$file" && ! -L "$file" ]] || fail "published evidence is not a regular non-symlink: $file"
    [[ "$(stat -c '%u:%g:%a' -- "$file")" == '0:0:600' ]] || fail "published evidence metadata is not root:root 0600: $file"
  done
  validate_evidence_json "$json" "$phase"
  sidecar_line="$(<"$sidecar")"
  [[ "$sidecar_line" =~ ^[0-9a-f]{64}[[:space:]][[:space:]]${name//./\.}$ ]] || fail 'checksum sidecar must name only the final basename'
  [[ "$sidecar_line" != *'/var/'* && "$sidecar_line" != *"$host_root"* ]] || fail 'checksum sidecar embedded an absolute path'
  (cd "$evidence_root" && sha256sum --check -- "$name.sha256" >/dev/null) || fail 'checksum does not verify the exact final JSON bytes'
  assert_canaries_absent "$prefix" "$json" "$sidecar" "$events"
  [[ ! -s "$prefix.stderr" ]] || fail 'successful evidence collection emitted raw stderr output'
  if find "$evidence_root" -maxdepth 1 -type f \( -name '*.tmp*' -o -name '.*.tmp*' \) -print -quit | grep -q .; then
    fail 'temporary evidence file remained after successful publication'
  fi
  mv_events="$(grep -c '^mv ' "$events" || true)"
  (( mv_events >= 2 )) || fail 'JSON and checksum were not atomically renamed from same-directory temporaries'
  sync_events="$(grep -c '^sync ' "$events" || true)"
  (( sync_events >= 2 )) || fail 'JSON and checksum temporaries were not flushed before publication'
  first_sync_line="$(grep -n '^sync ' "$events" | head -n 1 | cut -d: -f1)"
  first_mv_line="$(grep -n '^mv ' "$events" | head -n 1 | cut -d: -f1)"
  (( first_sync_line < first_mv_line )) || fail 'evidence was renamed before its temporary bytes were flushed'
}

run_collector success pre '/var/lib/learncoding/recovery-evidence/pre.json' "$work/pre"
assert_published pre pre.json "$work/pre"
run_collector success post '/var/lib/learncoding/recovery-evidence/post.json' "$work/post"
assert_published post post.json "$work/post"

expect_rejected_before_collection() {
  local label="$1"
  local phase="$2"
  local destination="$3"
  local prefix="$work/rejected-$label"
  run_collector invalid "$phase" "$destination" "$prefix"
  (( collector_status != 0 )) || fail "$label unexpectedly succeeded"
  assert_canaries_absent "$prefix" "$events"
  if grep -Eq '^(systemctl|virsh|docker|curl|journalctl|findmnt|smartctl|date|git|uname) ' "$events"; then
    fail "$label collected host evidence before rejecting its destination"
  fi
}

expect_rejected_before_collection bad-phase during '/var/lib/learncoding/recovery-evidence/bad.json'
expect_rejected_before_collection relative pre 'relative.json'
expect_rejected_before_collection traversal pre '/var/lib/learncoding/recovery-evidence/../escape.json'
expect_rejected_before_collection dot-alias pre '/var/lib/learncoding/recovery-evidence/./dot.json'
expect_rejected_before_collection prefix-sibling pre '/var/lib/learncoding/recovery-evidence-sibling/out.json'

mkdir -m 0600 "$evidence_root/non-regular.json"
expect_rejected_before_collection non-regular-destination pre '/var/lib/learncoding/recovery-evidence/non-regular.json'
rmdir "$evidence_root/non-regular.json"

mkdir -m 0600 "$evidence_root/non-regular-sidecar.json.sha256"
expect_rejected_before_collection non-regular-sidecar pre '/var/lib/learncoding/recovery-evidence/non-regular-sidecar.json'
rmdir "$evidence_root/non-regular-sidecar.json.sha256"

printf '%s' 'outside' >"$work/outside.json"
ln -s "$work/outside.json" "$evidence_root/symlink.json"
expect_rejected_before_collection symlink-destination pre '/var/lib/learncoding/recovery-evidence/symlink.json'
rm -- "$evidence_root/symlink.json"

ln -s "$work/outside.json" "$evidence_root/symlink-sidecar.json.sha256"
expect_rejected_before_collection symlink-sidecar pre '/var/lib/learncoding/recovery-evidence/symlink-sidecar.json'
rm -- "$evidence_root/symlink-sidecar.json.sha256"

mkdir -m 0700 "$evidence_root/component.real"
ln -s "$evidence_root/component.real" "$evidence_root/component"
expect_rejected_before_collection symlink-component pre '/var/lib/learncoding/recovery-evidence/component/out.json'
rm -- "$evidence_root/component"
rmdir "$evidence_root/component.real"

mv "$evidence_root" "$evidence_root.real"
ln -s "$evidence_root.real" "$evidence_root"
expect_rejected_before_collection symlink-root pre '/var/lib/learncoding/recovery-evidence/root-link.json'
rm -- "$evidence_root"
mv "$evidence_root.real" "$evidence_root"

learncoding_state_root="$host_root/var/lib/learncoding"
mv "$learncoding_state_root" "$learncoding_state_root.real"
ln -s "$learncoding_state_root.real" "$learncoding_state_root"
expect_rejected_before_collection symlink-parent-component pre '/var/lib/learncoding/recovery-evidence/parent-link.json'
rm -- "$learncoding_state_root"
mv "$learncoding_state_root.real" "$learncoding_state_root"

chown 65534:65534 "$evidence_root"
expect_rejected_before_collection non-root-owned-root pre '/var/lib/learncoding/recovery-evidence/wrong-owner.json'
chown 0:0 "$evidence_root"
chmod 0700 "$evidence_root"

run_collector smart-fail post '/var/lib/learncoding/recovery-evidence/interrupted.json' "$work/interrupted"
(( collector_status != 0 )) || fail 'collector published evidence after a collection command failed'
[[ ! -e "$evidence_root/interrupted.json" && ! -e "$evidence_root/interrupted.json.sha256" ]] ||
  fail 'collector published a partial result after failure'
if find "$evidence_root" -maxdepth 1 \( -name '*interrupted*tmp*' -o -name '.*interrupted*' \) -print -quit | grep -q .; then
  fail 'collector left its exact publication temporary after failure'
fi
assert_canaries_absent "$work/interrupted" "$events"

echo 'power-evidence-tests-ok'
