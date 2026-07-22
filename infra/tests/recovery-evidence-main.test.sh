#!/usr/bin/bash
set -Eeuo pipefail
umask 077

readonly PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

(( EUID == 0 )) || fail 'recovery evidence main behavior requires Linux root'
command -v bwrap >/dev/null || fail 'Bubblewrap is required'

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
collector="$repo_root/infra/ops/capture-recovery-evidence.sh"
helper="$repo_root/infra/ops/recovery-evidence.py"
fixture_contract="$repo_root/infra/tests/recovery-evidence-collection.test.py"
[[ -f "$collector" && -f "$helper" && -f "$fixture_contract" ]] || fail 'recovery production or fixture assets are missing'

work="$(mktemp -d /tmp/codestead-evidence-main.XXXXXX)"
cleanup() {
  [[ -d "$work" && ! -L "$work" && "$work" == /tmp/codestead-evidence-main.* ]] && rm -rf -- "$work"
}
trap cleanup EXIT HUP INT TERM
mkdir -p \
  "$work/release/dist/application-images" \
  "$work/release/infra/ops" \
  "$work/release/infra/runner-vm" \
  "$work/etc/learncoding" \
  "$work/evidence" \
  "$work/state/containers" \
  "$work/backup-state" \
  "$work/backup-full" \
  "$work/fakes"
cp -a -- /etc/. "$work/etc/"
cp -- "$collector" "$work/release/infra/ops/capture-recovery-evidence.sh"
cp -- "$helper" "$work/release/infra/ops/recovery-evidence.py"

python3 - "$work" "$fixture_contract" <<'PY'
import importlib.util
import datetime
import hashlib
from pathlib import Path
import sys

work = Path(sys.argv[1])
contract = Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("collection_fixture_builder", contract)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
host = module.FixtureHost()
active_bytes = host.files[module.helper.ACTIVE_RELEASE_PATH]
active = module.helper.parse_active_release(active_bytes)
inventory_path = module.helper.managed_inventory_path(active)
application_path = module.helper.application_image_record_path(active)
(work / "etc/learncoding/active-release.env").write_bytes(active_bytes)
(work / str(inventory_path).lstrip("/")).write_bytes(host.files[inventory_path])
(work / str(application_path).lstrip("/")).write_bytes(host.files[application_path])
(work / "release/RELEASE.SHA256SUMS").write_bytes(host.files[module.helper.RELEASE_MANIFEST_PATH])
(work / "release/dist/application-images/application-images.json").write_bytes(
    host.files[Path("/opt/learncoding/dist/application-images/application-images.json")]
)
(work / "release/infra/runner-vm/host-runner.nft").write_bytes(host.files[module.helper.FIREWALL_POLICY_PATH])
(work / "state/recovery.json").write_bytes(host.commands[module.helper.RECOVERY_COMMAND])
(work / "state/host-firewall.json").write_bytes(host.commands[module.helper.HOST_FIREWALL_COMMAND])
(work / "state/address.txt").write_bytes(host.commands[module.helper.RUNNER_ADDRESS_COMMAND])
(work / "state/application-mount.json").write_bytes(host.commands[module.helper.APPLICATION_MOUNT_COMMAND])
(work / "state/backup-mount.json").write_bytes(host.commands[module.helper.BACKUP_MOUNT_COMMAND])
(work / "state/application-block.json").write_bytes(
    host.commands[module.helper.lsblk_command("/dev/nvme0n1p2")]
)
(work / "state/backup-block.json").write_bytes(host.commands[module.helper.lsblk_command("/dev/sdb1")])
(work / "state/application-smart.json").write_bytes(
    host.commands[module.helper.smartctl_command("/dev/nvme0n1")]
)
(work / "state/backup-smart.json").write_bytes(host.commands[module.helper.smartctl_command("/dev/sdb")])
now = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
snapshot = now - datetime.timedelta(seconds=60)
completed = now - datetime.timedelta(seconds=30)
archive = f"learncoding-full-{snapshot.strftime('%Y%m%dT%H%M%SZ')}.tar.gz.age"
archive_bytes = b"encrypted-main-recovery-point-fixture\n"
digest = hashlib.sha256(archive_bytes).hexdigest()
(work / "backup-full" / archive).write_bytes(archive_bytes)
(work / "backup-full" / f"{archive}.sha256").write_text(
    f"{digest}  {archive}\n", encoding="ascii"
)
(work / "backup-state/local-last-success.env").write_text(
    f"SUCCESS_ARCHIVE={archive}\nSUCCESS_COMPLETED_UTC={completed.strftime('%Y%m%dT%H%M%SZ')}\nSUCCESS_SHA256={digest}\n",
    encoding="ascii",
)
(work / "state/guest-firewall.json").write_bytes(host.guest_commands[module.helper.GUEST_FIREWALL_COMMAND])
for service in module.SERVICES:
    command = module.helper.container_inspect_command(f"learncoding-{service}-1")
    (work / "state/containers" / f"learncoding-{service}-1.json").write_bytes(host.commands[command])
(work / "state/guest-release.txt").write_bytes(host.guest_commands[module.helper.GUEST_RELEASE_IDENTITY_COMMAND])
(work / "state/guest-runtime.txt").write_bytes(host.guest_commands[module.helper.GUEST_RUNTIME_IDENTITY_COMMAND])
PY

cat >"$work/release/infra/ops/check-recovery.sh" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
printf 'check-recovery:%s\n' "$*" >>/run/fixture-state/commands
cat /run/fixture-state/recovery.json
EOF
cat >"$work/release/infra/ops/smoke-production.sh" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
[[ "$*" == '--phase full' ]] || exit 64
printf 'smoke:%s\n' "$*" >>/run/fixture-state/commands
printf '%s\n' smoke-ok
EOF

cat >"$work/fakes/docker" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
printf 'docker:%s\n' "$*" >>/run/fixture-state/commands
/usr/bin/env | /usr/bin/sort > /run/fixture-state/command-environment
[[ "$#" == 4 && "$1" == inspect && "$2" == --type && "$3" == container ]] || exit 64
cat "/run/fixture-state/containers/$4.json"
EOF
cat >"$work/fakes/findmnt" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
printf 'findmnt:%s\n' "$*" >>/run/fixture-state/commands
[[ "$#" == 5 && "$1" == --json && "$2" == --output && "$3" == TARGET,SOURCE,FSTYPE,OPTIONS && "$4" == --target ]] || exit 64
case "$5" in
  /srv/learncoding) cat /run/fixture-state/application-mount.json ;;
  /mnt/learncoding-backups) cat /run/fixture-state/backup-mount.json ;;
  *) exit 65 ;;
esac
EOF
cat >"$work/fakes/lsblk" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
printf 'lsblk:%s\n' "$*" >>/run/fixture-state/commands
[[ "$#" == 6 && "$1" == --json && "$2" == --paths && "$3" == --output && "$4" == NAME,TYPE,PKNAME && "$5" == --inverse ]] || exit 64
case "$6" in
  /dev/nvme0n1p2) cat /run/fixture-state/application-block.json ;;
  /dev/sdb1) cat /run/fixture-state/backup-block.json ;;
  *) exit 65 ;;
esac
EOF
cat >"$work/fakes/smartctl" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
printf 'smartctl:%s\n' "$*" >>/run/fixture-state/commands
[[ "$#" == 4 && "$1" == --json=c && "$2" == --health && "$3" == --attributes ]] || exit 64
case "$4" in
  /dev/nvme0n1) cat /run/fixture-state/application-smart.json ;;
  /dev/sdb) cat /run/fixture-state/backup-smart.json ;;
  *) exit 65 ;;
esac
EOF

cat >"$work/fakes/systemctl" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
printf 'systemctl:%s\n' "$*" >>/run/fixture-state/commands
if [[ "$(</run/fixture-state/scenario)" == output-overflow && "${1:-}" == is-enabled ]]; then
  printf '%05000d\n' 0
  exit 0
fi
case "${1:-}" in
  is-enabled) printf '%s\n' enabled ;;
  is-active) printf '%s\n' active ;;
  --failed) exit 0 ;;
  *) exit 64 ;;
esac
EOF
cat >"$work/fakes/nft" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
printf 'nft:%s\n' "$*" >>/run/fixture-state/commands
[[ "$*" == '--json list table inet codestead_runner' ]] || exit 64
cat /run/fixture-state/host-firewall.json
EOF
cat >"$work/fakes/virsh" <<'EOF'
#!/usr/bin/bash
set -Eeuo pipefail
printf 'virsh:%s\n' "$*" >>/run/fixture-state/commands
if [[ "$*" == 'domifaddr codestead-runner --source agent --full' ]]; then
  cat /run/fixture-state/address.txt
  exit 0
fi
[[ "$#" == 3 && "$1" == qemu-agent-command && "$2" == codestead-runner ]] || exit 64
request="$3"
if [[ "$request" == *'"execute":"guest-exec-status"'* ]]; then
  last="$(</run/fixture-state/last-guest-request)"
  case "$last" in
    *'"arg":["is-enabled"'*) output_file=/run/fixture-state/enabled.txt ;;
    *'"arg":["is-active"'*) output_file=/run/fixture-state/active.txt ;;
    *'/opt/learncoding/RELEASE.SHA256SUMS'*) output_file=/run/fixture-state/guest-release.txt ;;
    *'/opt/learncoding/services/runner/dist/runtime-images.env'*) output_file=/run/fixture-state/guest-runtime.txt ;;
    *'codestead_runner_guest'*) output_file=/run/fixture-state/guest-firewall.json ;;
    *) exit 65 ;;
  esac
  encoded="$(base64 --wrap=0 <"$output_file")"
  printf '{"return":{"exitcode":0,"exited":true,"out-data":"%s"}}\n' "$encoded"
else
  [[ "$request" == *'"execute":"guest-exec"'* ]] || exit 66
  printf '%s' "$request" >/run/fixture-state/last-guest-request
  printf '%s\n' '{"return":{"pid":123}}'
fi
EOF
chmod 0555 "$work/fakes/"*
printf '%s\n' enabled >"$work/state/enabled.txt"
printf '%s\n' active >"$work/state/active.txt"
printf '%s\n' healthy >"$work/state/scenario"
: >"$work/state/commands"

mkdir -p "$work/usr-bin" "$work/usr-sbin"
cp -al -- /usr/bin/. "$work/usr-bin/"
cp -al -- /usr/sbin/. "$work/usr-sbin/"
for command_name in docker findmnt lsblk systemctl virsh; do
  rm -f -- "$work/usr-bin/$command_name"
  cp -- "$work/fakes/$command_name" "$work/usr-bin/$command_name"
done
rm -f -- "$work/usr-sbin/nft" "$work/usr-sbin/smartctl"
cp -- "$work/fakes/nft" "$work/usr-sbin/nft"
cp -- "$work/fakes/smartctl" "$work/usr-sbin/smartctl"

find "$work/release" "$work/etc/learncoding" "$work/state" "$work/backup-state" "$work/backup-full" -type d -exec chown 0:0 {} + -exec chmod 0700 {} +
find "$work/release" "$work/etc/learncoding" "$work/state" "$work/backup-state" "$work/backup-full" -type f -exec chown 0:0 {} + -exec chmod 0600 {} +
chmod 0755 \
  "$work/release/infra/ops/capture-recovery-evidence.sh" \
  "$work/release/infra/ops/recovery-evidence.py" \
  "$work/release/infra/ops/check-recovery.sh" \
  "$work/release/infra/ops/smoke-production.sh"
chmod 0644 "$work/release/RELEASE.SHA256SUMS" \
  "$work/release/dist/application-images/application-images.json" \
  "$work/release/infra/runner-vm/host-runner.nft"
find "$work/etc/learncoding" -type f -exec chmod 0644 {} +
chown 0:0 "$work/evidence"
chmod 0700 "$work/evidence"

run_collector() {
  local event="$1"
  set +e
  /usr/bin/env -i \
    HOME=/attacker/home \
    BASH_ENV=/attacker/bash-env \
    ENV=/attacker/env \
    DOCKER_CONFIG=/attacker/docker \
    COMPOSE_FILE=/attacker/compose.yml \
    http_proxy=http://attacker.invalid \
    HTTPS_PROXY=http://attacker.invalid \
    NO_PROXY=attacker.invalid \
    /usr/bin/bwrap --die-with-parent --new-session --unshare-pid --unshare-net --unshare-ipc --unshare-uts \
      --ro-bind / / \
      --bind "$work/usr-bin" /usr/bin \
      --bind "$work/usr-sbin" /usr/sbin \
      --bind "$work/etc" /etc \
      --tmpfs /opt --dir /opt/learncoding --ro-bind "$work/release" /opt/learncoding \
      --tmpfs /var --dir /var/lib --dir /var/lib/learncoding --dir /var/lib/learncoding/recovery-evidence \
      --bind "$work/evidence" /var/lib/learncoding/recovery-evidence \
      --tmpfs /mnt --dir /mnt/learncoding-backups --dir /mnt/learncoding-backups/state --dir /mnt/learncoding-backups/full \
      --ro-bind "$work/backup-full" /mnt/learncoding-backups/full \
      --ro-bind "$work/backup-state/local-last-success.env" /mnt/learncoding-backups/state/local-last-success.env \
      --tmpfs /run --dir /run/fixture-state --bind "$work/state" /run/fixture-state \
      --proc /proc --dev /dev --tmpfs /tmp --chdir / -- \
      /opt/learncoding/infra/ops/capture-recovery-evidence.sh pre \
        "/var/lib/learncoding/recovery-evidence/$event.pre.json" \
      >"$work/$event.stdout" 2>"$work/$event.stderr"
  collector_status=$?
  set -e
}

run_collector healthy
(( collector_status == 0 )) || fail "production collector rejected the healthy fixture: $(<"$work/healthy.stderr")"
[[ ! -s "$work/healthy.stdout" && ! -s "$work/healthy.stderr" ]] || fail 'collector emitted output'
python3 - "$work/evidence/healthy.pre.json" "$work/evidence/healthy.pre.json.sha256" \
  "$work/backup-state/local-last-success.env" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

payload = Path(sys.argv[1]).read_bytes()
value = json.loads(payload)
marker = dict(
    line.split("=", 1)
    for line in Path(sys.argv[3]).read_text(encoding="ascii").splitlines()
)
assert value["schemaVersion"] == 2
assert value["phase"] == "pre"
assert value["eventId"] == "healthy"
assert value["runner"]["representativeJobPassed"] is True
assert value["runner"]["address"] == "192.168.122.12/24"
assert len(value["containers"]) == 10
assert value["backup"]["archive"] == marker["SUCCESS_ARCHIVE"]
assert value["backup"]["sha256"] == marker["SUCCESS_SHA256"]
assert value["filesystems"]["backup"]["target"] == "/mnt/learncoding-backups"
assert value["host"]["uptimeSeconds"] >= 0
assert len(value["smart"]) == 2
assert all(item["healthy"] is True for item in value["smart"])
assert "must-not-be-published" not in payload.decode("ascii")
checksum = Path(sys.argv[2]).read_text(encoding="ascii")
assert checksum == f"{hashlib.sha256(payload).hexdigest()}  healthy.pre.json\n"
PY
for evidence_command in check-recovery smoke docker findmnt lsblk smartctl systemctl nft virsh; do
  grep -Eq "^${evidence_command}:" "$work/state/commands" || fail "collector did not execute $evidence_command evidence"
done
if grep -Eiq 'attacker|BASH_ENV=|ENV=|DOCKER_CONFIG=|COMPOSE_|(^|_)(http|https|all)_proxy=|NO_PROXY=' \
  "$work/state/command-environment"; then
  fail 'bounded collector command inherited a poisoned environment'
fi

python3 - "$work/state/containers/learncoding-app-1.json" <<'PY'
import json
from pathlib import Path
import sys
path = Path(sys.argv[1])
value = json.loads(path.read_text(encoding="ascii"))
value[0]["State"]["Health"]["Status"] = "unhealthy"
path.write_text(json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n", encoding="ascii")
PY
run_collector unhealthy
(( collector_status != 0 )) || fail 'collector accepted an unhealthy managed container'
[[ ! -e "$work/evidence/unhealthy.pre.json" && ! -e "$work/evidence/unhealthy.pre.json.sha256" ]] ||
  fail 'failed collection published an evidence commit'

python3 - "$work/state/containers/learncoding-app-1.json" <<'PY'
import json
from pathlib import Path
import sys
path = Path(sys.argv[1])
value = json.loads(path.read_text(encoding="ascii"))
value[0]["State"]["Health"]["Status"] = "healthy"
path.write_text(json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n", encoding="ascii")
PY
printf '%s\n' output-overflow >"$work/state/scenario"
run_collector output-overflow
(( collector_status != 0 )) || fail 'collector accepted command output beyond its fixed bound'
[[ ! -e "$work/evidence/output-overflow.pre.json" && ! -e "$work/evidence/output-overflow.pre.json.sha256" ]] ||
  fail 'oversized command output published an evidence commit'
printf '%s\n' healthy >"$work/state/scenario"

python3 - "$work/state/application-smart.json" <<'PY'
import json
from pathlib import Path
import sys
path = Path(sys.argv[1])
value = json.loads(path.read_text(encoding="ascii"))
value["nvme_smart_health_information_log"]["media_errors"] = 1
path.write_text(json.dumps(value, separators=(",", ":"), sort_keys=True) + "\n", encoding="ascii")
PY
run_collector smart-failure
(( collector_status != 0 )) || fail 'collector accepted a SMART media error'
[[ ! -e "$work/evidence/smart-failure.pre.json" && ! -e "$work/evidence/smart-failure.pre.json.sha256" ]] ||
  fail 'SMART failure published an evidence commit'

printf '%s\n' 'recovery-evidence-main-tests-ok'
