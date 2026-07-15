#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
bash_bin="$(command -v bash)"
env_bin="$(command -v env)"
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

source_manipulates_path() {
  local source="$1"
  local line
  local path_token_regex='(^|[^A-Za-z0-9_])PATH([^A-Za-z0-9_]|$)'

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" =~ $path_token_regex ]] && return 0
  done <"$source"
  return 1
}

make_path_sealed_copy() {
  local source="$1"
  local destination="$2"
  local interpreter="$3"

  {
    printf '#!%s\n' "$interpreter"
    printf '%s\n' 'readonly PATH'
    tail -n +2 "$source"
  } >"$destination"
  chmod 0700 "$destination"
}

assert_path_mutation_defenses() {
  local interpreter="$1"
  local mutation_source="$work/path-mutation-source.sh"
  local sealed_mutation="$work/path-mutation-sealed.sh"
  local mutation_bin="$work/path-mutation-bin"
  local resolution="$work/path-mutation-resolution"
  local sentinel="$work/path-mutation-sentinel"
  local mutation
  local mutation_status

  for mutation in \
    'PATH=/usr/bin:/bin' \
    'export PATH=/usr/bin:/bin' \
    'unset PATH' \
    'readonly PATH=/usr/bin:/bin'; do
    printf '#!%s\n%s\n' "$interpreter" "$mutation" >"$mutation_source"
    source_manipulates_path "$mutation_source" || fail "PATH static guard missed: $mutation"
  done

  # command -v is a shell builtin; this mutation probe never executes cp.
  {
    printf '#!%s\n' "$interpreter"
    printf '%s\n' \
      'set -e' \
      'PATH=/usr/bin:/bin' \
      'command -v cp >"$PATH_MUTATION_RESOLUTION"' \
      'printf compromised >"$PATH_MUTATION_SENTINEL"'
  } >"$mutation_source"
  make_path_sealed_copy "$mutation_source" "$sealed_mutation" "$interpreter"
  mkdir -m 0700 "$mutation_bin"
  printf '%s' unchanged >"$sentinel"
  set +e
  "$env_bin" -i PATH="$mutation_bin" PATH_MUTATION_RESOLUTION="$resolution" \
    PATH_MUTATION_SENTINEL="$sentinel" "$interpreter" "$sealed_mutation" \
    >"$work/path-mutation.stdout" 2>"$work/path-mutation.stderr"
  mutation_status=$?
  set -e

  (( mutation_status != 0 )) || fail 'same-interpreter PATH mutation unexpectedly succeeded'
  [[ ! -e "$resolution" ]] || fail 'PATH mutation resolved a host executable before rejection'
  [[ "$(<"$sentinel")" == unchanged ]] || fail 'PATH mutation reached the outside sentinel after changing command lookup'
}

if source_manipulates_path "$provisioner"; then
  fail 'provisioner may not reference or mutate the harness-owned PATH'
fi
assert_path_mutation_defenses "$bash_bin"
provisioner_under_test="$work/provision-host.sealed.sh"
make_path_sealed_copy "$provisioner" "$provisioner_under_test" "$bash_bin"
[[ "$(sed -n '2p' "$provisioner_under_test")" == 'readonly PATH' ]] ||
  fail 'provisioner test copy did not seal PATH before the SUT body'

if tail -n +2 "$provisioner" | grep -Eq '/(usr/)?(s?bin|libexec)/[A-Za-z0-9_.+-]+'; then
  fail 'provisioner hard-codes an executable path and can bypass the isolated fake PATH'
fi
if tail -n +2 "$provisioner" | grep -Eq '\$BASH([^A-Za-z0-9_]|$)|\$\{BASH([^A-Za-z0-9_]|$)|(^|[;&|({])[[:space:]]*(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+|(^|[[:space:]])(if|then|while|until|do|else|!)[[:space:]]+(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+'; then
  fail 'provisioner can invoke an absolute executable or the ambient Bash interpreter outside the fake PATH'
fi
if tail -n +2 "$provisioner" | grep -Eq 'command[[:space:]]+-p|enable[[:space:]]+-f|hash[[:space:]]+-p|/dev/(tcp|udp)/'; then
  fail 'provisioner can bypass fake command lookup'
fi
unsafe_absolute_redirects="$(tail -n +2 "$provisioner" | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
if [[ -n "$unsafe_absolute_redirects" ]]; then
  fail 'provisioner redirects output to an absolute path other than /dev/null'
fi
redirect_prefix_probe="$(printf '%s\n' 'printf unsafe >/dev/null.evil' | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
[[ -n "$redirect_prefix_probe" ]] || fail 'provisioner redirect guard accepted a /dev/null prefix sibling'
if tail -n +2 "$provisioner" | grep -Eq '(^|[;&|()[:space:]])(env|sh|bash|dash|zsh)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])(eval|source)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])\.[[:space:]]+/'; then
  fail 'provisioner can spawn or source an uninstrumented shell command'
fi
if tail -n +2 "$provisioner" | grep -Eq '(^|[^<])<[[:space:]]*([^<(&]|$)'; then
  fail 'provisioner contains an uninstrumented shell file read'
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

printf '#!%s\n' "$bash_bin" >"$fake_bin/fake-host-command"
cat >>"$fake_bin/fake-host-command" <<'FAKE'
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

safe_under() {
  local root="$1"
  local candidate="$2"
  local relative
  local cursor
  local component
  local -a components=()
  [[ "$candidate" == "$root" || "$candidate" == "$root"/* ]] || return 1
  relative="${candidate#"$root"}"
  relative="${relative#/}"
  [[ "/$relative/" != *'/../'* && "/$relative/" != *'/./'* && "$relative" != *'//'* ]] || return 1
  cursor="$root"
  [[ ! -L "$cursor" ]] || return 1
  IFS='/' read -r -a components <<<"$relative"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != . && "$component" != .. ]] || return 1
    cursor="$cursor/$component"
    [[ ! -L "$cursor" ]] || return 1
  done
}

inside_root() {
  safe_under "$FAKE_HOST_ROOT" "$1" || safe_under "$FAKE_STATE_ROOT" "$1"
}

inside_allowed_read() {
  case "$1" in
    "$FAKE_BASE_IMAGE_PATH"|"$FAKE_SSH_KEY_PATH"|"$FAKE_NETWORK_XML"|"$FAKE_CLOUD_META"|"$FAKE_CLOUD_USER"|"$FAKE_DOMAIN_XML")
      return 0
      ;;
  esac
  inside_root "$1"
}

bind_staging_identity() {
  local identity_file="$1"
  local candidate="$2"
  local required_directory="$3"
  local required_fragment="$4"
  local basename="${candidate##*/}"
  safe_under "$required_directory" "$candidate" || return 1
  [[ "$basename" == *codestead-runner* && "$basename" == *"$required_fragment"* ]] || return 1
  if [[ -e "$identity_file" ]]; then
    [[ "$(<"$identity_file")" == "$candidate" ]]
  else
    printf '%s' "$candidate" >"$identity_file"
  fi
}

staging_disk() {
  bind_staging_identity "$FAKE_STATE_ROOT/staging-disk-path" "$1" \
    "$FAKE_HOST_ROOT/var/lib/libvirt/images" 'staging'
}

staging_seed() {
  bind_staging_identity "$FAKE_STATE_ROOT/staging-seed-path" "$1" \
    "$FAKE_HOST_ROOT/var/lib/libvirt/boot" 'seed'
}

rendered_cloud_user() {
  local candidate="$1"
  local identity_file="$FAKE_STATE_ROOT/rendered-cloud-user-path"
  local rendered_data
  local ssh_key
  inside_root "$candidate" && [[ -f "$candidate" && ! -L "$candidate" ]] || return 1
  rendered_data="$(/usr/bin/cat -- "$candidate")"
  ssh_key="$(/usr/bin/cat -- "$FAKE_SSH_KEY_PATH")"
  [[ "$rendered_data" == *"$ssh_key"* && "$rendered_data" == *qemu-guest-agent* ]] || return 1
  printf '%s\n' "$rendered_data" | \
    /usr/bin/grep -Eq 'ssh_pwauth:[[:space:]]*false|PasswordAuthentication[[:space:]]+no' || return 1
  if [[ -e "$identity_file" ]]; then
    [[ "$(<"$identity_file")" == "$candidate" ]]
  else
    printf '%s' "$candidate" >"$identity_file"
  fi
}

reject_final_disk() {
  local final_disk="$FAKE_HOST_ROOT/var/lib/libvirt/images/codestead-runner.qcow2"
  [[ "$1" != "$final_disk" && "$final_disk" != "$1"/* ]]
}

does_not_replace_existing_final_disk() {
  local final_disk="$FAKE_HOST_ROOT/var/lib/libvirt/images/codestead-runner.qcow2"
  [[ "$1" != "$final_disk" || ! -e "$final_disk" ]]
}

inside_cleanup_path() {
  local candidate="$1"
  local basename="${candidate##*/}"
  if safe_under "$FAKE_STATE_ROOT" "$candidate"; then return 0; fi
  safe_under "$FAKE_HOST_ROOT/var/lib/libvirt/images" "$candidate" ||
    safe_under "$FAKE_HOST_ROOT/var/lib/libvirt/boot" "$candidate" || return 1
  [[ "$basename" == *codestead-runner* && ( "$basename" == *tmp* || "$basename" == *staging* ) ]]
}

scenario="$(<"$FAKE_SCENARIO_FILE")"
case "$command_name" in
  id)
    [[ "$#" == 1 && "$1" == -u ]] || exit 64
    printf '%s\n' "$EUID"
    ;;
  virsh)
    if [[ "${1:-}" == "--connect" && "${2:-}" == "qemu:///system" ]]; then shift 2; fi
    verb="${1:-}"
    object="${2:-}"
    [[ "$#" == 2 ]] || exit 64
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
          /usr/bin/cat -- "$FAKE_NETWORK_XML"
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
          /usr/bin/sed 's#codestead-runner.qcow2#some-other-disk.qcow2#' "$FAKE_DOMAIN_XML"
        else
          /usr/bin/cat -- "$FAKE_DOMAIN_XML"
        fi
        ;;
      domblklist:codestead-runner)
        if [[ "$scenario" == disk-mismatch ]]; then
          printf '%s\n' 'Target Source' 'vda /var/lib/libvirt/images/some-other-disk.qcow2'
        else
          printf '%s\n' 'Target Source' 'vda /var/lib/libvirt/images/codestead-runner.qcow2'
        fi
        ;;
      net-define:"$FAKE_NETWORK_XML") : >"$FAKE_STATE_ROOT/network-defined" ;;
      net-start:codestead-runner|net-autostart:codestead-runner) : ;;
      autostart:codestead-runner|start:codestead-runner) : ;;
      *) exit 64 ;;
    esac
    ;;
  qemu-img)
    case "${1:-}" in
      convert)
        [[ "$#" == 5 && "${2:-}" == -O && "${3:-}" == qcow2 && "${4:-}" == "$FAKE_BASE_IMAGE_PATH" ]] || exit 64
        destination="$5"
        staging_disk "$destination" && does_not_replace_existing_final_disk "$destination" || exit 97
        printf '%s' 'fixture-qcow2' >"$destination"
        ;;
      resize)
        [[ "$#" == 3 && "${3:-}" == 100G ]] || exit 64
        image="$2"
        staging_disk "$image" && reject_final_disk "$image" || exit 97
        printf '%s' 100G >"$FAKE_STATE_ROOT/disk-size"
        ;;
      info)
        [[ "$#" == 3 && "${2:-}" == --output=json ]] || exit 64
        [[ "$3" == "$FAKE_HOST_ROOT/var/lib/libvirt/images/codestead-runner.qcow2" ]] || staging_disk "$3" || exit 97
        printf '%s\n' '{"format":"qcow2","virtual-size":107374182400}'
        ;;
      *) exit 64 ;;
    esac
    ;;
  cloud-localds)
    [[ "$#" == 3 && "$3" == "$FAKE_CLOUD_META" ]] || exit 64
    staging_seed "$1" && rendered_cloud_user "$2" && does_not_replace_existing_final_disk "$1" || exit 97
    printf '%s' 'fixture-seed' >"$1"
    ;;
  virt-install)
    final_disk="$FAKE_HOST_ROOT/var/lib/libvirt/images/codestead-runner.qcow2"
    seed_path="$(<"$FAKE_STATE_ROOT/staging-seed-path")"
    expected=(
      --connect qemu:///system
      --name codestead-runner
      --virt-type kvm
      --vcpus 4
      --memory 8192
      --cpu host-passthrough
      --import
      --disk "path=$final_disk,bus=virtio,format=qcow2,cache=none"
      --disk "path=$seed_path,device=cdrom"
      --network 'network=codestead-runner,mac=52:54:00:20:00:12,model=virtio'
      --graphics none
      --noautoconsole
    )
    [[ "$#" == "${#expected[@]}" ]] || exit 64
    actual=("$@")
    for index in "${!expected[@]}"; do [[ "${actual[index]}" == "${expected[index]}" ]] || exit 64; done
    : >"$FAKE_STATE_ROOT/domain-defined"
    ;;
  sha256sum)
    [[ "$#" == 2 && "$1" == -- && "$2" == "$FAKE_BASE_IMAGE_PATH" ]] || exit 64
    if [[ "$scenario" == wrong-sha ]]; then
      printf '%s  %s\n' "$(printf '0%.0s' {1..64})" "$FAKE_BASE_IMAGE_PATH"
    else
      printf '%s  %s\n' "$FAKE_EXPECTED_SHA" "$FAKE_BASE_IMAGE_PATH"
    fi
    ;;
  install)
    directory_mode=false
    install_mode=
    operands=()
    while (( $# > 0 )); do
      case "$1" in
        -d) directory_mode=true; shift ;;
        -D) shift ;;
        -m|-o|-g) [[ $# -ge 2 ]] || exit 64; [[ "$1" != -m ]] || install_mode="$2"; shift 2 ;;
        --) shift; while (( $# > 0 )); do operands+=("$1"); shift; done ;;
        -*) exit 64 ;;
        *) operands+=("$1"); shift ;;
      esac
    done
    if [[ "$directory_mode" == true ]]; then
      (( ${#operands[@]} > 0 )) || exit 64
      for destination in "${operands[@]}"; do inside_root "$destination" || exit 97; done
      /usr/bin/mkdir -p -- "${operands[@]}"
      [[ -z "$install_mode" ]] || /usr/bin/chmod -- "$install_mode" "${operands[@]}"
    else
      (( ${#operands[@]} == 2 )) || exit 64
      source_path="${operands[0]}"
      destination="${operands[1]}"
      inside_allowed_read "$source_path" || exit 97
      inside_root "$destination" && does_not_replace_existing_final_disk "$destination" || exit 97
      /usr/bin/cp -- "$source_path" "$destination"
      [[ -z "$install_mode" ]] || /usr/bin/chmod -- "$install_mode" "$destination"
    fi
    ;;
  systemctl)
    [[ "$#" == 2 ]] || exit 64
    case "${1:-}:${2:-}" in
      is-active:libvirtd.service|is-enabled:libvirtd.service) printf '%s\n' active ;;
      *) exit 64 ;;
    esac
    ;;
  rm)
    rm_args=("$@")
    rm_targets=()
    parse_options=true
    for argument in "${rm_args[@]}"; do
      if [[ "$parse_options" == true ]]; then
        case "$argument" in
          --) parse_options=false; continue ;;
          -f|-r|-rf|-fr) continue ;;
          -*) exit 64 ;;
        esac
      fi
      rm_targets+=("$argument")
    done
    (( ${#rm_targets[@]} > 0 )) || exit 64
    for target in "${rm_targets[@]}"; do
      inside_cleanup_path "$target" && reject_final_disk "$target" || exit 97
    done
    /usr/bin/rm "${rm_args[@]}"
    ;;
  cp)
    cp_args=("$@")
    cp_operands=()
    parse_options=true
    for argument in "${cp_args[@]}"; do
      if [[ "$parse_options" == true ]]; then
        case "$argument" in
          --) parse_options=false; continue ;;
          -a|-f|-p|-R|-r|--reflink=auto|--reflink=always|--sparse=always) continue ;;
          -*) exit 64 ;;
        esac
      fi
      cp_operands+=("$argument")
    done
    (( ${#cp_operands[@]} >= 2 )) || exit 64
    destination="${cp_operands[${#cp_operands[@]} - 1]}"
    inside_root "$destination" && does_not_replace_existing_final_disk "$destination" || exit 97
    for (( index=0; index<${#cp_operands[@]}-1; index++ )); do
      inside_allowed_read "${cp_operands[$index]}" || exit 97
    done
    /usr/bin/cp "${cp_args[@]}"
    ;;
  mv)
    args=("$@")
    [[ "${args[0]:-}" == -- ]] && args=("${args[@]:1}")
    (( ${#args[@]} == 2 )) || exit 64
    inside_root "${args[0]}" && inside_root "${args[1]}" &&
      does_not_replace_existing_final_disk "${args[1]}" || exit 97
    /usr/bin/mv -- "${args[0]}" "${args[1]}"
    ;;
  mkdir)
    mkdir_args=("$@")
    mkdir_targets=()
    expect_mode=false
    for argument in "${mkdir_args[@]}"; do
      if [[ "$expect_mode" == true ]]; then expect_mode=false; continue; fi
      case "$argument" in
        -p|--) ;;
        -m) expect_mode=true ;;
        -*) exit 64 ;;
        *) mkdir_targets+=("$argument") ;;
      esac
    done
    [[ "$expect_mode" == false && ${#mkdir_targets[@]} -gt 0 ]] || exit 64
    for target in "${mkdir_targets[@]}"; do inside_root "$target" || exit 97; done
    /usr/bin/mkdir "${mkdir_args[@]}"
    ;;
  chmod)
    chmod_args=("$@")
    chmod_targets=()
    mode_seen=false
    for argument in "${chmod_args[@]}"; do
      [[ "$argument" == -- ]] && continue
      if [[ "$mode_seen" == false ]]; then
        [[ "$argument" =~ ^[0-7]{3,4}$ ]] || exit 64
        mode_seen=true
      else
        chmod_targets+=("$argument")
      fi
    done
    [[ "$mode_seen" == true && ${#chmod_targets[@]} -gt 0 ]] || exit 64
    for target in "${chmod_targets[@]}"; do inside_root "$target" || exit 97; done
    /usr/bin/chmod "${chmod_args[@]}"
    ;;
  chown)
    chown_targets=()
    owner_seen=false
    for argument in "$@"; do
      [[ "$argument" == -- ]] && continue
      if [[ "$owner_seen" == false ]]; then owner_seen=true; continue; fi
      [[ "$argument" == -* ]] && exit 64
      chown_targets+=("$argument")
    done
    [[ "$owner_seen" == true && ${#chown_targets[@]} -gt 0 ]] || exit 64
    for target in "${chown_targets[@]}"; do inside_root "$target" || exit 97; done
    ;;
  sync)
    sync_targets=()
    for argument in "$@"; do
      case "$argument" in -f|--file-system|--) ;; -*) exit 64 ;; *) sync_targets+=("$argument") ;; esac
    done
    (( ${#sync_targets[@]} > 0 )) || exit 64
    for target in "${sync_targets[@]}"; do inside_root "$target" || exit 97; done
    ;;
  mktemp)
    mktemp_args=("$@")
    template="${!#}"
    inside_root "$template" || exit 97
    expect_tmpdir=false
    for argument in "${mktemp_args[@]:0:${#mktemp_args[@]}-1}"; do
      if [[ "$expect_tmpdir" == true ]]; then inside_root "$argument" || exit 97; expect_tmpdir=false; continue; fi
      case "$argument" in
        -d) ;;
        -p|--tmpdir) expect_tmpdir=true ;;
        --tmpdir=*) inside_root "${argument#*=}" || exit 97 ;;
        -*) exit 64 ;;
        *) inside_root "$argument" || exit 97 ;;
      esac
    done
    [[ "$expect_tmpdir" == false ]] || exit 64
    /usr/bin/mktemp "${mktemp_args[@]}"
    ;;
  stat|realpath|readlink|cat)
    read_args=("$@")
    read_targets=()
    expect_format=false
    for argument in "${read_args[@]}"; do
      if [[ "$expect_format" == true ]]; then expect_format=false; continue; fi
      case "$argument" in
        -c|--format|--printf) expect_format=true ;;
        --|-e|-f|-m|-n|-q|-s|-v|--canonicalize-missing|--format=*|--printf=*) ;;
        -*) exit 64 ;;
        *) read_targets+=("$argument") ;;
      esac
    done
    [[ "$expect_format" == false && ${#read_targets[@]} -gt 0 ]] || exit 64
    for target in "${read_targets[@]}"; do inside_allowed_read "$target" || exit 97; done
    "/usr/bin/$command_name" "${read_args[@]}"
    ;;
  *) exit 64 ;;
esac
FAKE
chmod 0755 "$fake_bin/fake-host-command"
for command_name in id virsh qemu-img cloud-localds virt-install sha256sum install systemctl rm mv cp mkdir chmod chown \
  sync mktemp stat realpath readlink cat; do
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
  rm -f -- "$state_root/network-defined" "$state_root/domain-defined" "$state_root/disk-size" \
    "$state_root/staging-disk-path" "$state_root/staging-seed-path" "$state_root/rendered-cloud-user-path"
  printf '%s' "$scenario" >"$scenario_file"
}

run_provisioner() {
  local output_file="$1"
  shift
  set +e
  "$env_bin" -i \
    HOME="$work" \
    PATH="$fake_bin" \
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
    FAKE_BASE_IMAGE_PATH="$base_image" \
    FAKE_SSH_KEY_PATH="$ssh_key" \
    FAKE_CLOUD_META="$cloud_meta" \
    FAKE_CLOUD_USER="$cloud_user" \
    "$bash_bin" "$provisioner_under_test" "$@" >"$output_file.stdout" 2>"$output_file.stderr"
  run_status=$?
  set -e
  [[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
    fail 'provisioner modified the outside-fixture sentinel'
}

assert_no_mutation() {
  if grep -Eq '^(virsh (net-define|net-start|net-autostart|define|start|autostart)|qemu-img (convert|resize)|cloud-localds |virt-install |install( |$)|(cp|mv|rm|mkdir|chmod|chown|mktemp|sync)( |$))' "$events"; then
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

outside_sentinel="$work/outside-fake-roots.sentinel"
printf '%s' 'outside-fixture-sentinel-unchanged' >"$outside_sentinel"

prepare_case clean
: >"$events"
set +e
if (( EUID == 0 )); then
  command -v setpriv >/dev/null 2>&1 || fail 'setpriv is required to prove the normal non-root path'
  chown -R 65534:65534 "$work"
  setpriv --reuid=65534 --regid=65534 --clear-groups \
    "$env_bin" -i HOME="$work" PATH="$fake_bin" \
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
      FAKE_BASE_IMAGE_PATH="$base_image" \
      FAKE_SSH_KEY_PATH="$ssh_key" \
      FAKE_CLOUD_META="$cloud_meta" \
      FAKE_CLOUD_USER="$cloud_user" \
      "$bash_bin" "$provisioner_under_test" >"$work/nonroot.stdout" 2>"$work/nonroot.stderr"
  nonroot_status=$?
  chown -R 0:0 "$work"
else
  "$env_bin" -i HOME="$work" PATH="$fake_bin" \
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
    FAKE_BASE_IMAGE_PATH="$base_image" \
    FAKE_SSH_KEY_PATH="$ssh_key" \
    FAKE_CLOUD_META="$cloud_meta" \
    FAKE_CLOUD_USER="$cloud_user" \
    "$bash_bin" "$provisioner_under_test" >"$work/nonroot.stdout" 2>"$work/nonroot.stderr"
  nonroot_status=$?
fi
set -e
(( nonroot_status != 0 )) || fail 'normal non-root provisioning path unexpectedly succeeded'
grep -Eiq 'root|superuser' "$work/nonroot.stderr" || fail 'normal non-root path did not fail at the root boundary'
[[ ! -s "$events" ]] || fail 'normal non-root path invoked a host command before rejecting the caller'
assert_private_output "$work/nonroot"
[[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
  fail 'non-root provisioning path modified the outside-fixture sentinel'

set +e
PATH="$fake_bin" "$fake_bin/cat" -- "$outside_sentinel" >"$work/outside-read.stdout" 2>"$work/outside-read.stderr"
outside_read_status=$?
PATH="$fake_bin" "$fake_bin/cp" -- "$base_image" "$outside_sentinel" >"$work/outside-write.stdout" 2>"$work/outside-write.stderr"
outside_write_status=$?
PATH="$fake_bin" runner-contract-unknown-command >"$work/outside-unknown.stdout" 2>"$work/outside-unknown.stderr"
outside_unknown_status=$?
set -e
(( outside_read_status != 0 && outside_write_status != 0 && outside_unknown_status != 0 )) ||
  fail 'fake-only provisioning PATH allowed an unknown, outside read, or outside write command'
[[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
  fail 'outside-fixture provisioning sentinel was modified'

prepare_case clean
run_provisioner "$work/clean"
(( run_status == 0 )) || fail "clean-host fixture failed: $(<"$work/clean.stderr")"
expected_sha_event="$(printf 'sha256sum -- %q' "$base_image")"
[[ "$(grep -Fxc -- "$expected_sha_event" "$events" || true)" == 1 ]] ||
  fail 'clean provisioning must checksum exactly RUNNER_BASE_IMAGE_PATH exactly once'
checksum_line="$(grep -Fn -- "$expected_sha_event" "$events" | cut -d: -f1)"
first_mutation_line="$(grep -nE '^(virsh (net-define|net-start|net-autostart|autostart|start)|qemu-img (convert|resize)|cloud-localds |virt-install |install( |$)|(cp|mv|rm|mkdir|chmod|chown|mktemp|sync)( |$))' "$events" | head -n 1 | cut -d: -f1)"
[[ -n "$checksum_line" && -n "$first_mutation_line" && "$checksum_line" -lt "$first_mutation_line" ]] ||
  fail 'configured base-image checksum must complete before the first provisioning mutation'
grep -Eq '^virsh (.* )?net-define ' "$events" || fail 'clean host did not define the reviewed network'
grep -Fq 'virsh net-start codestead-runner' "$events" || fail 'clean host did not start the runner network'
grep -Fq 'virsh net-autostart codestead-runner' "$events" || fail 'clean host did not autostart the runner network'
staging_disk_path="$(<"$state_root/staging-disk-path")"
expected_convert_event="$(printf 'qemu-img convert -O qcow2 %q %q' "$base_image" "$staging_disk_path")"
expected_resize_event="$(printf 'qemu-img resize %q 100G' "$staging_disk_path")"
[[ "$(grep -Fxc -- "$expected_convert_event" "$events" || true)" == 1 ]] ||
  fail 'clean host did not convert exactly the configured base image to the one staging qcow2'
[[ "$(grep -Fxc -- "$expected_resize_event" "$events" || true)" == 1 ]] ||
  fail 'clean host did not resize exactly the converted staging qcow2 to 100G'
virt_install_event="$(grep -E '^virt-install ' "$events" || true)"
staging_seed_path="$(<"$state_root/staging-seed-path")"
rendered_cloud_user_path="$(<"$state_root/rendered-cloud-user-path")"
expected_cloud_localds_event="$(printf 'cloud-localds %q %q %q' "$staging_seed_path" "$rendered_cloud_user_path" "$cloud_meta")"
[[ "$(grep -Fxc -- "$expected_cloud_localds_event" "$events" || true)" == 1 ]] ||
  fail 'cloud-localds did not receive exactly the one bound seed, rendered user-data, and reviewed metadata path'
cloud_user_token="$(printf '%q' "$cloud_user")"
ssh_key_token="$(printf '%q' "$ssh_key")"
grep -E '^(cat|cp|install) ' "$events" | grep -Fq -- "$cloud_user_token" ||
  fail 'provisioner did not consume the reviewed cloud-init user-data template'
grep -E '^(cat|cp|install) ' "$events" | grep -Fq -- "$ssh_key_token" ||
  fail 'provisioner did not consume the configured SSH public key fixture'
expected_virt_install_argv=(
  --connect qemu:///system --name codestead-runner --virt-type kvm --vcpus 4 --memory 8192
  --cpu host-passthrough --import
  --disk "path=$host_root/var/lib/libvirt/images/codestead-runner.qcow2,bus=virtio,format=qcow2,cache=none"
  --disk "path=$staging_seed_path,device=cdrom"
  --network 'network=codestead-runner,mac=52:54:00:20:00:12,model=virtio'
  --graphics none --noautoconsole
)
expected_virt_install_event=virt-install
for argument in "${expected_virt_install_argv[@]}"; do
  printf -v escaped_argument '%q' "$argument"
  expected_virt_install_event+=" $escaped_argument"
done
[[ "$virt_install_event" == "$expected_virt_install_event" ]] ||
  fail 'virt-install did not use the one exact reviewed argv contract'
! grep -Eiq -- '--network (bridge|direct)=|br0|wlo1|hostdev|filesystem|source dir=' "$events" ||
  fail 'provisioning requested a public bridge, host device, or shared host path'
grep -Fq 'virsh autostart codestead-runner' "$events" || fail 'runner domain autostart was not requested'
assert_no_destructive_event
assert_private_output "$work/clean"

prepare_case wrong-sha
run_provisioner "$work/wrong-sha"
(( run_status != 0 )) || fail 'wrong base-image SHA unexpectedly succeeded'
[[ "$(grep -Fxc -- "$expected_sha_event" "$events" || true)" == 1 ]] ||
  fail 'wrong-SHA provisioning must checksum exactly RUNNER_BASE_IMAGE_PATH once'
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
