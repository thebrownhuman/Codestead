#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
provisioner="$repo_root/infra/runner-vm/provision-host.sh"
network_xml="$repo_root/infra/runner-vm/codestead-runner-network.xml"
cloud_meta="$repo_root/infra/runner-vm/cloud-init/meta-data"
cloud_user="$repo_root/infra/runner-vm/cloud-init/user-data.template"

tmp_base="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
work="$(mktemp -d "$tmp_base/runner-vm-provision.XXXXXX")"
work="$(cd "$work" && pwd -P)"
[[ ! -L "$work" && "$work" == "$tmp_base"/* ]] || {
  echo 'FAIL: runner provisioning fixture escaped its verified temporary root' >&2
  exit 1
}
chmod 0700 "$work"
cleanup() {
  if [[ -n "${work:-}" && -d "$work" && ! -L "$work" && "$work" == "$tmp_base"/* ]]; then
    rm -rf -- "$work"
  fi
}
trap cleanup EXIT

missing=()
for required in "$provisioner" "$network_xml" "$cloud_meta" "$cloud_user"; do
  [[ -f "$required" ]] || missing+=("${required#"$repo_root/"}")
done
if (( ${#missing[@]} > 0 )); then
  echo 'runner VM provisioning contract failed:' >&2
  for required in "${missing[@]}"; do
    printf -- '- missing later-task production asset: %s\n' "$required" >&2
  done
  exit 1
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

if grep -Eq '/(usr/)?s?bin/(virsh|qemu-img|cloud-localds|virt-install|sha256sum|install|systemctl|rm|mv|cp|mkdir|chmod|chown|sync|mktemp|stat|realpath|readlink)([[:space:]"'\'']|$)' "$provisioner"; then
  fail 'provisioner hard-codes a host command path and can bypass the isolated fake PATH'
fi
if grep -Eq 'SKIP_(ROOT|KVM|CHECK)|ALLOW_UNSAFE|FORCE_REPLACE' "$provisioner"; then
  fail 'provisioner contains a permissive production safety bypass'
fi
grep -Fq 'RUNNER_PROVISION_TEST_ROOT' "$provisioner" || fail 'provisioner is missing the single narrow test-root seam'
root_guard_line="$(grep -nEm1 'EUID|id[[:space:]]+-u' "$provisioner" | cut -d: -f1 || true)"
kvm_guard_line="$(grep -nFm1 '/dev/kvm' "$provisioner" | cut -d: -f1 || true)"
if [[ -z "$root_guard_line" || -z "$kvm_guard_line" || "$root_guard_line" -ge "$kvm_guard_line" ]]; then
  fail 'normal production root validation must precede every /dev/kvm access'
fi

assert_network_contract() {
  grep -Fq '<name>codestead-runner</name>' "$network_xml" || fail 'dedicated network name is missing'
  grep -Eq '<forward[[:space:]]+mode=["'\'']nat["'\'']' "$network_xml" || fail 'dedicated network must use NAT'
  grep -Eq '<bridge[[:space:]]+name=["'\'']virbr-cdst["'\'']' "$network_xml" || fail 'dedicated bridge must be virbr-cdst'
  grep -Eq '<ip[[:space:]][^>]*address=["'\'']10\.20\.0\.1["'\''][^>]*netmask=["'\'']255\.255\.255\.0["'\'']' "$network_xml" ||
    fail 'dedicated network must use host 10.20.0.1/24'
  grep -Eq '<host[[:space:]][^>]*mac=["'\'']52:54:00:20:00:12["'\''][^>]*ip=["'\'']10\.20\.0\.12["'\'']' "$network_xml" ||
    fail 'guest DHCP reservation is missing'
  grep -Eq '<range[[:space:]][^>]*start=["'\'']10\.20\.0\.100["'\''][^>]*end=["'\'']10\.20\.0\.200["'\'']' "$network_xml" ||
    fail 'dedicated network must retain its bounded DHCP range'
  ! grep -Eiq 'forward[^>]+mode=["'\''](bridge|route|open)["'\'']|br0|wlo1|hostdev|filesystem' "$network_xml" ||
    fail 'network XML exposes a forbidden bridge, device, or shared path'
  ! grep -Eiq '<port[[:space:]]|portgroup|forwardPort' "$network_xml" || fail 'network XML must not forward a public port'
}
assert_network_contract

grep -Eq '^local-hostname:[[:space:]]*codestead-runner[[:space:]]*$' "$cloud_meta" ||
  fail 'cloud-init metadata must use the fixed runner hostname'
grep -Eq 'ssh_pwauth:[[:space:]]*false|PasswordAuthentication[[:space:]]+no' "$cloud_user" ||
  fail 'cloud-init must disable password authentication'
grep -Fq 'qemu-guest-agent' "$cloud_user" || fail 'cloud-init must install qemu-guest-agent'
if grep -Eiq 'runner[_-]shared[_-]secret|database_url|better_auth|gmail|cloudflare|oauth|credential_master|BEGIN .*PRIVATE KEY' "$cloud_meta" "$cloud_user"; then
  fail 'cloud-init templates must remain secret-free'
fi

fake_bin="$work/bin"
state_root="$work/state"
host_root="$work/host-root"
events="$work/events.log"
scenario_file="$state_root/scenario"
mkdir -m 0700 "$fake_bin" "$state_root" "$host_root"
: >"$events"

cat >"$fake_bin/fake-host-command" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

command_name="${0##*/}"
record() {
  {
    printf '%q' "$command_name"
    local argument
    for argument in "$@"; do printf ' %q' "$argument"; done
    printf '\n'
  } >>"$FAKE_EVENTS"
}
record "$@"

inside_root() {
  [[ "$1" == "$FAKE_HOST_ROOT" || "$1" == "$FAKE_HOST_ROOT"/* || "$1" == "$FAKE_STATE_ROOT"/* ]]
}

inside_allowed_read() {
  inside_root "$1" || [[ "$1" == "$FAKE_WORK_ROOT"/* || "$1" == "$FAKE_REPO_ROOT"/* ]]
}

scenario="$(<"$FAKE_SCENARIO_FILE")"
case "$command_name" in
  virsh)
    if [[ "${1:-}" == "--connect" && "${2:-}" == "qemu:///system" ]]; then shift 2; fi
    verb="${1:-}"
    object="${2:-}"
    case "$verb:$object" in
      net-info:codestead-runner)
        [[ "$scenario" != clean && "$scenario" != wrong-sha && "$scenario" != missing-kvm ]] ||
          [[ -f "$FAKE_STATE_ROOT/network-defined" ]] || exit 1
        printf '%s\n' 'Name: codestead-runner' 'Active: yes' 'Autostart: yes'
        ;;
      net-dumpxml:codestead-runner)
        if [[ "$scenario" == incompatible-network ]]; then
          printf '%s\n' '<network><name>codestead-runner</name><bridge name="br0"/></network>'
        else
          /usr/bin/cat "$FAKE_NETWORK_XML"
        fi
        ;;
      dominfo:codestead-runner)
        [[ "$scenario" == compatible || "$scenario" == incompatible-domain || "$scenario" == disk-mismatch || -f "$FAKE_STATE_ROOT/domain-defined" ]] || exit 1
        printf '%s\n' 'Name: codestead-runner' 'State: running' 'Autostart: enable'
        ;;
      dumpxml:codestead-runner)
        if [[ "$scenario" == incompatible-domain ]]; then
          printf '%s\n' '<domain><name>codestead-runner</name><memory unit="MiB">4096</memory></domain>'
        elif [[ "$scenario" == disk-mismatch ]]; then
          sed 's#codestead-runner.qcow2#some-other-disk.qcow2#' "$FAKE_DOMAIN_XML"
        else
          /usr/bin/cat "$FAKE_DOMAIN_XML"
        fi
        ;;
      domblklist:codestead-runner)
        if [[ "$scenario" == disk-mismatch ]]; then
          printf '%s\n' 'Target Source' 'vda /var/lib/libvirt/images/some-other-disk.qcow2'
        else
          printf '%s\n' 'Target Source' 'vda /var/lib/libvirt/images/codestead-runner.qcow2'
        fi
        ;;
      net-define:*) touch "$FAKE_STATE_ROOT/network-defined" ;;
      net-start:codestead-runner|net-autostart:codestead-runner) : ;;
      autostart:codestead-runner|start:codestead-runner) : ;;
      *) exit 64 ;;
    esac
    ;;
  qemu-img)
    case "${1:-}" in
      convert)
        destination="${!#}"
        inside_root "$destination" || exit 97
        printf '%s' 'fixture-qcow2' >"$destination"
        ;;
      resize)
        [[ "${!#}" == 100G ]] || exit 64
        image="${@: -2:1}"
        inside_root "$image" || exit 97
        printf '%s' 100G >"$FAKE_STATE_ROOT/disk-size"
        ;;
      info)
        printf '%s\n' '{"format":"qcow2","virtual-size":107374182400}'
        ;;
      *) exit 64 ;;
    esac
    ;;
  cloud-localds)
    [[ $# -ge 2 ]] || exit 64
    inside_root "$1" || exit 97
    printf '%s' 'fixture-seed' >"$1"
    ;;
  virt-install)
    touch "$FAKE_STATE_ROOT/domain-defined"
    ;;
  sha256sum)
    if [[ "$scenario" == wrong-sha ]]; then
      printf '%s  %s\n' "$(printf '0%.0s' {1..64})" "${!#}"
    else
      printf '%s  %s\n' "$FAKE_EXPECTED_SHA" "${!#}"
    fi
    ;;
  install)
    if [[ " ${*} " == *' -d '* ]]; then
      destination="${!#}"
      inside_root "$destination" || exit 97
      /usr/bin/mkdir -p -- "$destination"
    else
      source_path="${@: -2:1}"
      destination="${!#}"
      inside_root "$destination" || exit 97
      /usr/bin/cp -- "$source_path" "$destination"
    fi
    ;;
  systemctl)
    case "${1:-}:${2:-}" in
      is-active:libvirtd.service|is-enabled:libvirtd.service) printf '%s\n' active ;;
      *) exit 64 ;;
    esac
    ;;
  rm)
    target="${!#}"
    inside_root "$target" || exit 97
    /usr/bin/rm "$@"
    ;;
  cp)
    source_path="${@: -2:1}"
    destination="${!#}"
    inside_allowed_read "$source_path" || exit 97
    inside_root "$destination" || exit 97
    /usr/bin/cp "$@"
    ;;
  mv)
    args=("$@")
    [[ "${args[0]:-}" == -- ]] && args=("${args[@]:1}")
    (( ${#args[@]} == 2 )) || exit 64
    inside_root "${args[0]}" && inside_root "${args[1]}" || exit 97
    /usr/bin/mv -- "${args[0]}" "${args[1]}"
    ;;
  mkdir)
    for argument in "$@"; do
      [[ "$argument" == -* ]] && continue
      inside_root "$argument" || exit 97
    done
    /usr/bin/mkdir "$@"
    ;;
  chmod)
    target="${!#}"
    inside_root "$target" || exit 97
    /usr/bin/chmod "$@"
    ;;
  chown)
    target="${!#}"
    inside_root "$target" || exit 97
    ;;
  sync)
    target="${!#}"
    inside_root "$target" || exit 97
    /usr/bin/sync "$@"
    ;;
  mktemp)
    template="${!#}"
    inside_root "$template" || exit 97
    /usr/bin/mktemp "$@"
    ;;
  stat|realpath|readlink|cat)
    target="${!#}"
    inside_allowed_read "$target" || exit 97
    "/usr/bin/$command_name" "$@"
    ;;
  docker|curl|wget|mount|umount|nft|systemd-analyze)
    exit 97
    ;;
  *) exit 64 ;;
esac
FAKE
chmod 0755 "$fake_bin/fake-host-command"
for command_name in virsh qemu-img cloud-localds virt-install sha256sum install systemctl rm mv cp mkdir chmod chown \
  sync mktemp stat realpath readlink cat \
  docker curl wget mount umount nft systemd-analyze; do
  cp "$fake_bin/fake-host-command" "$fake_bin/$command_name"
done

base_image="$work/ubuntu-base.img"
ssh_key="$work/runner-admin.pub"
expected_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
privacy_canary='PROVISION_IMAGE_CANARY_6f2a79c1_DO_NOT_PRINT'
printf '%s' "$privacy_canary" >"$base_image"
printf '%s\n' 'ssh-ed25519 AAAAC3NzaFixtureOnly runner-contract' >"$ssh_key"
chmod 0600 "$base_image" "$ssh_key"

cat >"$state_root/domain.xml" <<'XML'
<domain type='kvm'>
  <name>codestead-runner</name>
  <memory unit='MiB'>8192</memory>
  <vcpu>4</vcpu>
  <cpu mode='host-passthrough'/>
  <devices>
    <disk type='file' device='disk'><driver name='qemu' type='qcow2' cache='none'/><source file='/var/lib/libvirt/images/codestead-runner.qcow2'/><target dev='vda' bus='virtio'/></disk>
    <interface type='network'><mac address='52:54:00:20:00:12'/><source network='codestead-runner'/><model type='virtio'/></interface>
  </devices>
</domain>
XML

prepare_case() {
  local scenario="$1"
  rm -rf -- "$host_root"
  mkdir -m 0700 -p "$host_root/dev" "$host_root/var/lib/libvirt/images" "$host_root/var/lib/libvirt/boot"
  : >"$host_root/dev/kvm"
  : >"$events"
  rm -f -- "$state_root/network-defined" "$state_root/domain-defined" "$state_root/disk-size"
  printf '%s' "$scenario" >"$scenario_file"
}

run_provisioner() {
  local output_file="$1"
  shift
  set +e
  env -i \
    HOME="$work" \
    PATH="$fake_bin:/usr/bin:/bin" \
    RUNNER_PROVISION_TEST_ROOT="$host_root" \
    RUNNER_BASE_IMAGE_PATH="$base_image" \
    RUNNER_BASE_IMAGE_SHA256="$expected_sha" \
    RUNNER_ADMIN_SSH_PUBLIC_KEY_FILE="$ssh_key" \
    FAKE_EVENTS="$events" \
    FAKE_STATE_ROOT="$state_root" \
    FAKE_HOST_ROOT="$host_root" \
    FAKE_SCENARIO_FILE="$scenario_file" \
    FAKE_NETWORK_XML="$network_xml" \
    FAKE_DOMAIN_XML="$state_root/domain.xml" \
    FAKE_EXPECTED_SHA="$expected_sha" \
    FAKE_WORK_ROOT="$work" \
    FAKE_REPO_ROOT="$repo_root" \
    bash "$provisioner" "$@" >"$output_file.stdout" 2>"$output_file.stderr"
  run_status=$?
  set -e
}

assert_no_mutation() {
  if grep -Eq '^(virsh (net-define|net-start|net-autostart|define|start|autostart)|qemu-img (convert|resize)|cloud-localds |virt-install |install )' "$events"; then
    fail "scenario mutated host state before validation: $(<"$scenario_file")"
  fi
}

assert_no_destructive_event() {
  ! grep -Eq 'virsh (destroy|undefine|vol-delete)|--remove-all-storage|codestead-runner\.qcow2.*(^| )rm|rm .*codestead-runner\.qcow2' "$events" ||
    fail 'provisioner attempted destructive replacement or final-disk deletion'
}

assert_private_output() {
  local prefix="$1"
  for file in "$prefix.stdout" "$prefix.stderr" "$events"; do
    ! grep -Fq "$privacy_canary" "$file" || fail "provisioning leaked base-image content through ${file##*/}"
  done
}

prepare_case clean
: >"$events"
set +e
if (( EUID == 0 )); then
  command -v setpriv >/dev/null 2>&1 || fail 'setpriv is required to prove the normal non-root path'
  chown -R 65534:65534 "$work"
  setpriv --reuid=65534 --regid=65534 --clear-groups \
    env -i HOME="$work" PATH="$fake_bin:/usr/bin:/bin" \
      RUNNER_BASE_IMAGE_PATH="$base_image" \
      RUNNER_BASE_IMAGE_SHA256="$expected_sha" \
      RUNNER_ADMIN_SSH_PUBLIC_KEY_FILE="$ssh_key" \
      FAKE_EVENTS="$events" \
      FAKE_STATE_ROOT="$state_root" \
      FAKE_HOST_ROOT="$host_root" \
      FAKE_SCENARIO_FILE="$scenario_file" \
      FAKE_NETWORK_XML="$network_xml" \
      FAKE_DOMAIN_XML="$state_root/domain.xml" \
      FAKE_EXPECTED_SHA="$expected_sha" \
      FAKE_WORK_ROOT="$work" \
      FAKE_REPO_ROOT="$repo_root" \
      bash "$provisioner" >"$work/nonroot.stdout" 2>"$work/nonroot.stderr"
  nonroot_status=$?
  chown -R 0:0 "$work"
else
  env -i HOME="$work" PATH="$fake_bin:/usr/bin:/bin" \
    RUNNER_BASE_IMAGE_PATH="$base_image" \
    RUNNER_BASE_IMAGE_SHA256="$expected_sha" \
    RUNNER_ADMIN_SSH_PUBLIC_KEY_FILE="$ssh_key" \
    FAKE_EVENTS="$events" \
    FAKE_STATE_ROOT="$state_root" \
    FAKE_HOST_ROOT="$host_root" \
    FAKE_SCENARIO_FILE="$scenario_file" \
    FAKE_NETWORK_XML="$network_xml" \
    FAKE_DOMAIN_XML="$state_root/domain.xml" \
    FAKE_EXPECTED_SHA="$expected_sha" \
    FAKE_WORK_ROOT="$work" \
    FAKE_REPO_ROOT="$repo_root" \
    bash "$provisioner" >"$work/nonroot.stdout" 2>"$work/nonroot.stderr"
  nonroot_status=$?
fi
set -e
(( nonroot_status != 0 )) || fail 'normal non-root provisioning path unexpectedly succeeded'
grep -Eiq 'root|superuser' "$work/nonroot.stderr" || fail 'normal non-root path did not fail at the root boundary'
[[ ! -s "$events" ]] || fail 'normal non-root path invoked a host command before rejecting the caller'
assert_private_output "$work/nonroot"

prepare_case clean
run_provisioner "$work/clean"
(( run_status == 0 )) || fail "clean-host fixture failed: $(<"$work/clean.stderr")"
grep -Eq '^virsh (.* )?net-define ' "$events" || fail 'clean host did not define the reviewed network'
grep -Fq 'virsh net-start codestead-runner' "$events" || fail 'clean host did not start the runner network'
grep -Fq 'virsh net-autostart codestead-runner' "$events" || fail 'clean host did not autostart the runner network'
grep -Eq '^qemu-img resize .* 100G$' "$events" || fail 'clean host did not resize the staging qcow2 to 100G'
grep -Eq '^qemu-img convert .* -O qcow2 .*' "$events" || fail 'clean host did not create a thin qcow2 staging disk'
virt_install_event="$(grep -E '^virt-install ' "$events" || true)"
[[ "$virt_install_event" == *'--name codestead-runner'* && "$virt_install_event" == *'--vcpus 4'* &&
  "$virt_install_event" == *'--memory 8192'* && "$virt_install_event" == *'--cpu host-passthrough'* &&
  "$virt_install_event" == *'--network network=codestead-runner,mac=52:54:00:20:00:12'* &&
  "$virt_install_event" == *'bus=virtio'* && "$virt_install_event" == *'format=qcow2'* &&
  "$virt_install_event" == *'model=virtio'* && "$virt_install_event" == *'cache=none'* ]] ||
  fail 'virt-install did not encode the exact VM isolation contract'
! grep -Eiq -- '--network (bridge|direct)=|br0|wlo1|hostdev|filesystem|source dir=' "$events" ||
  fail 'provisioning requested a public bridge, host device, or shared host path'
grep -Fq 'virsh autostart codestead-runner' "$events" || fail 'runner domain autostart was not requested'
assert_no_destructive_event
assert_private_output "$work/clean"

prepare_case wrong-sha
run_provisioner "$work/wrong-sha"
(( run_status != 0 )) || fail 'wrong base-image SHA unexpectedly succeeded'
assert_no_mutation
assert_no_destructive_event

prepare_case missing-kvm
rm -f -- "$host_root/dev/kvm"
run_provisioner "$work/missing-kvm"
(( run_status != 0 )) || fail 'missing KVM fixture unexpectedly succeeded'
assert_no_mutation

for incompatible in incompatible-network incompatible-domain; do
  prepare_case "$incompatible"
  run_provisioner "$work/$incompatible"
  (( run_status != 0 )) || fail "$incompatible fixture unexpectedly succeeded"
  assert_no_mutation
  assert_no_destructive_event
done

prepare_case disk-mismatch
final_disk="$host_root/var/lib/libvirt/images/codestead-runner.qcow2"
printf '%s' 'existing-final-disk-must-survive' >"$final_disk"
run_provisioner "$work/disk-mismatch"
(( run_status != 0 )) || fail 'unattached existing final disk unexpectedly succeeded'
[[ "$(<"$final_disk")" == 'existing-final-disk-must-survive' ]] || fail 'existing final disk was overwritten'
assert_no_mutation
assert_no_destructive_event

prepare_case compatible
printf '%s' 'compatible-existing-final-disk' >"$host_root/var/lib/libvirt/images/codestead-runner.qcow2"
run_provisioner "$work/compatible-first"
(( run_status == 0 )) || fail 'compatible existing fixture failed its first inspection'
assert_no_mutation
run_provisioner "$work/compatible-second"
(( run_status == 0 )) || fail 'compatible existing fixture failed its second inspection'
assert_no_mutation
assert_no_destructive_event
[[ "$(<"$host_root/var/lib/libvirt/images/codestead-runner.qcow2")" == 'compatible-existing-final-disk' ]] ||
  fail 'idempotent inspection replaced the final disk'

echo 'runner-vm-provision-tests-ok'
