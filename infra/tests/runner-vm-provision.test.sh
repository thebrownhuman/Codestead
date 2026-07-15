#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/bin:/bin
export PATH

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
bash_bin=/usr/bin/bash
env_bin=/usr/bin/env
sha256_bin=/usr/bin/sha256sum
perl_bin=/usr/bin/perl
provisioner="$repo_root/infra/runner-vm/provision-host.sh"
provisioner_shebang='#!/usr/bin/env bash'
provisioner_reviewed_sha256='PENDING_REVIEW_WHEN_LATER_TASK_ASSET_LANDS'
network_xml="$repo_root/infra/runner-vm/codestead-runner-network.xml"
cloud_meta="$repo_root/infra/runner-vm/cloud-init/meta-data"
cloud_user="$repo_root/infra/runner-vm/cloud-init/user-data.template"

tmp_base="$(cd /tmp && pwd -P)"
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

render_path_sealed_copy() {
  local staged_source="$1" destination="$2" interpreter="$3" command_root="$4" command_name
  shift 4
  printf '#!%s\n' "$interpreter" >"$destination"
  if [[ -n "$command_root" ]]; then
    for command_name in "$@"; do
      [[ "$command_name" =~ ^[a-z][a-z0-9-]*$ ]] || return 1
      printf '%s() { %q/%s "$@"; }\n' "$command_name" "$command_root" "$command_name" >>"$destination"
    done
  fi
  printf '%s\n' 'PATH=' 'readonly PATH' >>"$destination"
  tail -n +2 "$staged_source" >>"$destination"
}

make_path_sealed_copy() {
  local staged_source="$1" destination="$2" interpreter="$3" expected_shebang="$4" expected_sha256="$5"
  local expected_file="$destination.expected" candidate="$destination.candidate" actual_sha256
  shift 5
  verify_exact_staged_shell_source "$staged_source" "$interpreter" "$expected_shebang" "$expected_sha256" || return 1
  rm -f -- "$expected_file" "$candidate" "$destination"
  render_path_sealed_copy "$staged_source" "$expected_file" "$interpreter" "${1:-}" "${@:2}" || return 1
  expected_transformed_sha256="$(sha256_file "$expected_file")" || return 1
  render_path_sealed_copy "$staged_source" "$candidate" "$interpreter" "${1:-}" "${@:2}" || return 1
  actual_sha256="$(sha256_file "$candidate")" || return 1
  [[ "$actual_sha256" == "$expected_transformed_sha256" ]] || return 1
  chmod 0500 "$candidate"
  mv -- "$candidate" "$destination"
  rm -f -- "$expected_file"
  verify_exact_staged_shell_source "$destination" "$interpreter" "#!$interpreter" "$expected_transformed_sha256"
}

sha256_file() {
  local source="$1"
  local digest_line
  local digest

  digest_line="$("$sha256_bin" -- "$source")" || return 1
  digest="${digest_line%% *}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$digest"
}

verify_exact_staged_shell_source() {
  local staged_source="$1"
  local interpreter="$2"
  local expected_shebang="$3"
  local expected_sha256="$4"
  local first_line
  local shebang_count=0
  local line
  local actual_sha256

  local metadata mode mode_value
  [[ -f "$staged_source" && ! -L "$staged_source" ]] || return 1
  metadata="$(/usr/bin/stat -L -c '%a' -- "$staged_source")" || return 1
  mode="${metadata##*:}"; [[ "$mode" =~ ^[0-7]{3,4}$ ]] || return 1; mode_value=$((8#$mode))
  (( (mode_value & 8#222) == 0 )) || return 1
  IFS= read -r first_line <"$staged_source" || return 1
  [[ "$first_line" == "$expected_shebang" && "$first_line" != *$'\r'* ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" != *$'\r'* ]] || return 1
    [[ "$line" == '#!'* ]] && shebang_count=$((shebang_count + 1))
  done <"$staged_source"
  (( shebang_count == 1 )) || return 1
  [[ "$expected_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  actual_sha256="$(sha256_file "$staged_source")" || return 1
  [[ "$actual_sha256" == "$expected_sha256" ]] || return 1
  "$interpreter" -n "$staged_source" >/dev/null 2>&1
}

initialize_source_stager() {
  source_stager="$source_staging_root/source-stager.pl"
  cat >"$source_stager" <<'PERL'
#!/usr/bin/perl
use strict;
use warnings;
use Fcntl qw(O_RDONLY O_WRONLY O_CREAT O_EXCL O_TRUNC O_NOFOLLOW SEEK_SET S_ISREG F_SETFD FD_CLOEXEC);

sub set_cloexec {
  my ($handle) = @_;
  fcntl($handle, F_SETFD, FD_CLOEXEC) or die "O_CLOEXEC setup failed: $!\n";
}

sub write_all {
  my ($handle, $bytes) = @_;
  my $offset = 0;
  while ($offset < length($bytes)) {
    my $written = syswrite($handle, $bytes, length($bytes) - $offset, $offset);
    die "write failed: $!\n" unless defined $written && $written > 0;
    $offset += $written;
  }
}

sub read_all {
  my ($handle) = @_;
  my $bytes = '';
  while (1) {
    my $count = sysread($handle, my $chunk, 65536);
    die "read failed: $!\n" unless defined $count;
    last if $count == 0;
    $bytes .= $chunk;
  }
  return $bytes;
}

sub copy_all {
  my ($input, $output) = @_;
  while (1) {
    my $count = sysread($input, my $chunk, 65536);
    die "read failed: $!\n" unless defined $count;
    last if $count == 0;
    write_all($output, $chunk);
  }
}

my ($source, $destination, $hook, $race_root) = @ARGV;
die "invalid arguments\n" unless defined $race_root && ($hook eq 'none' || $hook eq 'path-swap-restore' || $hook eq 'inplace-restore');
my $o_cloexec = eval { Fcntl::O_CLOEXEC() } || 0;
sysopen(my $input, $source, O_RDONLY | O_NOFOLLOW | $o_cloexec) or die "open source failed: $!\n";
set_cloexec($input);
# Perl stat(FILEHANDLE) is the exact-descriptor fstat identity check.
my @before = stat($input);
die "source is not regular\n" unless @before && S_ISREG($before[2]);
my @path_before = lstat($source);
die "source path identity changed\n" unless @path_before && S_ISREG($path_before[2]) && $path_before[0] == $before[0] && $path_before[1] == $before[1];
if ($hook ne 'none') {
  my $prefix = "$race_root/reviewed-source-";
  die "race hook escaped fixture\n" unless index($source, $prefix) == 0;
}
sysopen(my $output, $destination, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | $o_cloexec, 0400) or die "open stage failed: $!\n";
set_cloexec($output);
my ($backup, $original_bytes, $error);
eval {
  if ($hook eq 'path-swap-restore') {
    $backup = "$source.stage-race-backup";
    unlink($backup);
    rename($source, $backup) or die "rename source failed: $!\n";
    sysopen(my $attacker, $source, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or die "create attacker failed: $!\n";
    set_cloexec($attacker);
    write_all($attacker, "#!/usr/bin/env bash\nprintf compromised >\"\$SOURCE_IDENTITY_SENTINEL\"\n");
    close($attacker) or die "close attacker failed: $!\n";
  } elsif ($hook eq 'inplace-restore') {
    $original_bytes = read_all($input);
    sysseek($input, 0, SEEK_SET) or die "seek source failed: $!\n";
    sysopen(my $mutator, $source, O_WRONLY | O_TRUNC | O_NOFOLLOW) or die "open mutator failed: $!\n";
    set_cloexec($mutator);
    write_all($mutator, "#!/usr/bin/env bash\nprintf compromised >\"\$SOURCE_IDENTITY_SENTINEL\"\n");
    close($mutator) or die "close mutator failed: $!\n";
  }
  copy_all($input, $output);
  close($output) or die "close stage failed: $!\n";
  1;
} or $error = $@ || "staging failed\n";

if ($hook eq 'path-swap-restore' && defined $backup && -e $backup) {
  unlink($source);
  rename($backup, $source) or $error ||= "restore rename failed: $!\n";
} elsif ($hook eq 'inplace-restore' && defined $original_bytes) {
  if (sysopen(my $restorer, $source, O_WRONLY | O_TRUNC | O_NOFOLLOW)) {
    set_cloexec($restorer);
    eval { write_all($restorer, $original_bytes); close($restorer) or die "close restorer failed: $!\n"; 1 } or $error ||= $@;
  } else {
    $error ||= "open restorer failed: $!\n";
  }
}

my @after = stat($input);
my @path_after = lstat($source);
for my $index (0, 1, 2, 3, 4, 5, 6, 7) {
  $error ||= "descriptor identity changed\n" unless @after && $after[$index] == $before[$index];
}
$error ||= "source path was not restored\n" unless @path_after && S_ISREG($path_after[2]) && $path_after[0] == $before[0] && $path_after[1] == $before[1];
close($input) or $error ||= "close source failed: $!\n";
if ($error) {
  unlink($destination);
  die $error;
}
chmod(0400, $destination) == 1 or die "chmod stage failed: $!\n";
PERL
  chmod 0500 "$source_stager"
  source_stager_sha256="$(sha256_file "$source_stager")" || return 1
  "$perl_bin" -c "$source_stager" >/dev/null 2>&1 || return 1
}

stage_live_source_once() {
  local live_source="$1" staged_source="$2" hook="${3:-none}"
  [[ "$staged_source" == "$source_staging_root"/* && ! -e "$staged_source" ]] || return 1
  [[ "$(sha256_file "$source_stager")" == "$source_stager_sha256" ]] || return 1
  "$perl_bin" "$source_stager" "$live_source" "$staged_source" "$hook" "$source_staging_root"
}

stage_and_make_path_sealed_copy() {
  local live_source="$1" destination="$2"
  local staged_source="$destination.source-stage"
  shift 2
  rm -f -- "$staged_source"
  stage_live_source_once "$live_source" "$staged_source" || return 1
  make_path_sealed_copy "$staged_source" "$destination" "$@"
}

assert_source_race_mutations() {
  local interpreter="$1" expected_shebang="$2"
  local safe_source="$source_staging_root/reviewed-source-race.sh"
  local staged_source="$source_staging_root/reviewed-source-race.stage.sh"
  local transformed="$source_staging_root/reviewed-source-race.transformed.sh"
  local sentinel="$source_staging_root/reviewed-source-race.sentinel"
  local safe_sha256
  printf '%s\n%s\n' "$expected_shebang" 'set -e' >"$safe_source"
  safe_sha256="$(sha256_file "$safe_source")" || return 1
  printf '%s' unchanged >"$sentinel"

  rm -f -- "$staged_source" "$transformed"
  stage_live_source_once "$safe_source" "$staged_source" path-swap-restore || return 1
  make_path_sealed_copy "$staged_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" || return 1
  [[ "$(sha256_file "$safe_source")" == "$safe_sha256" && "$(<"$transformed")" != *compromised* ]] || return 1

  rm -f -- "$staged_source" "$transformed"
  stage_live_source_once "$safe_source" "$staged_source" inplace-restore || true
  if [[ -e "$staged_source" ]] && make_path_sealed_copy "$staged_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
    return 1
  fi
  [[ "$(sha256_file "$safe_source")" == "$safe_sha256" && ! -e "$transformed" && "$(<"$sentinel")" == unchanged ]]
}



source_staging_root="$work"
initialize_source_stager || fail 'could not initialize one-FD source stager'

assert_source_identity_mutations() {
  local interpreter="$1"
  local expected_shebang="$2"
  local safe_source="$work/reviewed-source-safe.sh"
  local mutated_source="$work/reviewed-source-mutated.sh"
  local transformed="$work/reviewed-source-transformed.sh"
  local outside_sentinel="$work/reviewed-source-outside.sentinel"
  local safe_sha256
  local label
  local mutation

  printf '%s\n%s\n' "$expected_shebang" 'set -e' >"$safe_source"
  safe_sha256="$(sha256_file "$safe_source")" || fail 'could not hash the reviewed source mutation baseline'
  printf '%s' unchanged >"$outside_sentinel"

  while IFS='|' read -r label mutation; do
    {
      printf '%s\n' "$expected_shebang"
      printf '%s\n' 'set -e'
      printf '%s\n' "$mutation"
      printf '%s\n' 'printf reached >"$SOURCE_IDENTITY_SENTINEL"'
    } >"$mutated_source"
    rm -f -- "$transformed"
    if stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
      fail "reviewed source identity accepted $label mutation"
    fi
    [[ ! -e "$transformed" ]] || fail "reviewed source identity transformed $label mutation"
    [[ "$(<"$outside_sentinel")" == unchanged ]] || fail "reviewed source identity reached the sentinel for $label mutation"
  done <<'EOF'
dynamic-command-p|opt=-p; builtin command "$opt" -v cp
dynamic-hash-p|opt=-p; d=/usr/bin; hash "$opt" "$d/cp" cp
assembled-absolute|d=/usr/bin; target="$d/cp"; command -v "$target"
new-shell|d=/usr/bin; shell="$d/sh"; "$shell" -c 'command -v cp'
dynamic-source|verb=source; "$verb" "$DYNAMIC_HELPER"
dynamic-dot-source|verb=.; "$verb" "$DYNAMIC_HELPER"
dynamic-env|verb=env; "$verb" command -v cp
dynamic-builtin|verb=builtin; "$verb" command -p -v cp
dynamic-exec|verb=exec; "$verb" /usr/bin/sh -c 'command -v cp'
EOF

  {
    printf '%s\n' '/usr/bin/cp -- "$SOURCE" "$DESTINATION"'
    printf '%s\n' 'set -e'
  } >"$mutated_source"
  if stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
    fail 'reviewed source identity accepted a line-1 absolute command'
  fi
  [[ ! -e "$transformed" && "$(<"$outside_sentinel")" == unchanged ]] ||
    fail 'line-1 mutation reached transformation or the outside sentinel'

  printf '%s\n%s\n%s\n' "$expected_shebang" "$expected_shebang" 'set -e' >"$mutated_source"
  if stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
    fail 'reviewed source identity accepted a duplicate shebang'
  fi
  printf '%s\r\n%s\r\n' "$expected_shebang" 'set -e' >"$mutated_source"
  if stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
    fail 'reviewed source identity accepted CRLF source'
  fi
  ln -s "$safe_source" "$work/reviewed-source-symlink.sh"
  if [[ -L "$work/reviewed-source-symlink.sh" ]]; then
    if stage_and_make_path_sealed_copy "$work/reviewed-source-symlink.sh" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256"; then
      fail 'reviewed source identity accepted a symlink source'
    fi
  fi
  rm -f -- "$work/reviewed-source-symlink.sh"
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
  local mutation_sha256

  mkdir -m 0700 "$mutation_bin"
  for mutation in \
    'PATH=/usr/bin:/bin' \
    'export PATH=/usr/bin:/bin' \
    'unset PATH' \
    'readonly PATH=/usr/bin:/bin'; do
    # command -v is a shell builtin; none of these probes executes cp.
    {
      printf '#!%s\n' "$interpreter"
      printf '%s\n' \
        'set -e' \
        "$mutation" \
        'command -v cp >"$PATH_MUTATION_RESOLUTION"' \
        'printf compromised >"$PATH_MUTATION_SENTINEL"'
    } >"$mutation_source"
    source_manipulates_path "$mutation_source" || fail "PATH static guard missed: $mutation"
    mutation_sha256="$(sha256_file "$mutation_source")" || fail 'could not hash PATH mutation source'
    rm -f -- "$sealed_mutation" "$resolution"
    stage_and_make_path_sealed_copy "$mutation_source" "$sealed_mutation" "$interpreter" "#!$interpreter" "$mutation_sha256" ||
      fail 'could not create reviewed PATH mutation copy'
    printf '%s' unchanged >"$sentinel"
    set +e
    "$env_bin" -i PATH="$mutation_bin" PATH_MUTATION_RESOLUTION="$resolution" \
      PATH_MUTATION_SENTINEL="$sentinel" "$interpreter" "$sealed_mutation" \
      >"$work/path-mutation.stdout" 2>"$work/path-mutation.stderr"
    mutation_status=$?
    set -e

    (( mutation_status != 0 )) || fail "same-interpreter PATH mutation unexpectedly succeeded: $mutation"
    [[ ! -e "$resolution" ]] || fail "PATH mutation resolved a host executable before rejection: $mutation"
    [[ "$(<"$sentinel")" == unchanged ]] || fail "PATH mutation reached the outside sentinel: $mutation"
  done
}

provisioner_stage="$work/provision-host.reviewed.stage.sh"
stage_live_source_once "$provisioner" "$provisioner_stage" ||
  fail 'could not open the provisioner exactly once with O_NOFOLLOW'
verify_exact_staged_shell_source "$provisioner_stage" "$bash_bin" "$provisioner_shebang" "$provisioner_reviewed_sha256" ||
  fail 'provisioner staged identity, shebang, regular-file, LF, or syntax contract is not reviewed'
assert_source_identity_mutations "$bash_bin" "$provisioner_shebang"
assert_source_race_mutations "$bash_bin" "$provisioner_shebang" || fail 'provisioner source race defenses failed'
if source_manipulates_path "$provisioner_stage"; then
  fail 'provisioner may not reference or mutate the harness-owned PATH'
fi
assert_path_mutation_defenses "$bash_bin"
provisioner_under_test="$work/provision-host.sealed.sh"
fake_bin="$work/bin"
provisioner_fake_commands=(id virsh qemu-img cloud-localds virt-install sha256sum install systemctl rm mv cp mkdir chmod chown \
  sync mktemp stat realpath readlink cat)
make_path_sealed_copy "$provisioner_stage" "$provisioner_under_test" "$bash_bin" "$provisioner_shebang" "$provisioner_reviewed_sha256" \
  "$fake_bin" "${provisioner_fake_commands[@]}" ||
  fail 'could not create the reviewed provisioner test copy'
grep -Fxq 'PATH=' "$provisioner_under_test" && grep -Fxq 'readonly PATH' "$provisioner_under_test" ||
  fail 'provisioner test copy did not seal PATH before the SUT body'
provisioner_under_test_sha256="$(sha256_file "$provisioner_under_test")" || fail 'could not hash transformed provisioner'
verify_exact_staged_shell_source "$provisioner_under_test" "$bash_bin" "#!$bash_bin" "$provisioner_under_test_sha256" ||
  fail 'transformed provisioner identity is not verified'

if tail -n +2 "$provisioner_stage" | grep -Eq '/(usr/)?(s?bin|libexec)/[A-Za-z0-9_.+-]+'; then
  fail 'provisioner hard-codes an executable path and can bypass the isolated fake PATH'
fi
if tail -n +2 "$provisioner_stage" | grep -Eq '\$BASH([^A-Za-z0-9_]|$)|\$\{BASH([^A-Za-z0-9_]|$)|(^|[;&|({])[[:space:]]*(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+|(^|[[:space:]])(if|then|while|until|do|else|!)[[:space:]]+(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+'; then
  fail 'provisioner can invoke an absolute executable or the ambient Bash interpreter outside the fake PATH'
fi
if tail -n +2 "$provisioner_stage" | grep -Eq 'command[[:space:]]+-p|enable[[:space:]]+-f|hash[[:space:]]+-p|/dev/(tcp|udp)/'; then
  fail 'provisioner can bypass fake command lookup'
fi
unsafe_absolute_redirects="$(tail -n +2 "$provisioner_stage" | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
if [[ -n "$unsafe_absolute_redirects" ]]; then
  fail 'provisioner redirects output to an absolute path other than /dev/null'
fi
redirect_prefix_probe="$(printf '%s\n' 'printf unsafe >/dev/null.evil' | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
[[ -n "$redirect_prefix_probe" ]] || fail 'provisioner redirect guard accepted a /dev/null prefix sibling'
if tail -n +2 "$provisioner_stage" | grep -Eq '(^|[;&|()[:space:]])(env|sh|bash|dash|zsh)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])(eval|source)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])\.[[:space:]]+/'; then
  fail 'provisioner can spawn or source an uninstrumented shell command'
fi
if tail -n +2 "$provisioner_stage" | grep -Eq '(^|[^<])<[[:space:]]*([^<(&]|$)'; then
  fail 'provisioner contains an uninstrumented shell file read'
fi
if grep -Eq 'SKIP_(ROOT|KVM|CHECK)|ALLOW_UNSAFE|FORCE_REPLACE' "$provisioner_stage"; then
  fail 'provisioner contains a permissive production safety bypass'
fi
grep -Fq 'RUNNER_PROVISION_TEST_ROOT' "$provisioner_stage" || fail 'provisioner is missing the single narrow test-root seam'
root_guard_line="$(grep -nEm1 'EUID|id[[:space:]]+-u' "$provisioner_stage" | cut -d: -f1 || true)"
kvm_guard_line="$(grep -nFm1 '/dev/kvm' "$provisioner_stage" | cut -d: -f1 || true)"
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
state_root="$work/provision-state-rw"
host_root="$work/host-root"
events="$work/events.log"
scenario_file="$work/provision-scenario"
domain_xml="$work/provision-domain.xml"
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
chmod 0555 "$fake_bin/fake-host-command"
for command_name in id virsh qemu-img cloud-localds virt-install sha256sum install systemctl rm mv cp mkdir chmod chown \
  sync mktemp stat realpath readlink cat; do
  cp "$fake_bin/fake-host-command" "$fake_bin/$command_name"
done
chmod 0555 "$fake_bin"/*
fake_host_command_sha256="$(sha256_file "$fake_bin/fake-host-command")" || fail 'could not hash strict provisioner fake command'
for command_name in "${provisioner_fake_commands[@]}"; do
  verify_exact_staged_shell_source "$fake_bin/$command_name" "$bash_bin" "#!$bash_bin" "$fake_host_command_sha256" ||
    fail "provisioner fake command identity is not verified: $command_name"
done

base_image="$work/ubuntu-base.img"
ssh_key="$work/runner-admin.pub"
expected_sha='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
privacy_canary='PROVISION_IMAGE_CANARY_6f2a79c1_DO_NOT_PRINT'
printf '%s' "$privacy_canary" >"$base_image"
printf '%s\n' 'ssh-ed25519 AAAAC3NzaFixtureOnly runner-contract' >"$ssh_key"
printf '%s' preflight >"$scenario_file"
chmod 0600 "$base_image" "$ssh_key"

cat >"$domain_xml" <<'XML'
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

verify_fixed_outer_binary() {
  local binary="$1" regular_only="${2:-false}" metadata owner group mode mode_value
  [[ "$binary" == /usr/bin/* && -f "$binary" && -x "$binary" ]] || return 1
  [[ "$regular_only" != true || ! -L "$binary" ]] || return 1
  metadata="$(/usr/bin/stat -L -c '%u:%g:%a' -- "$binary")" || return 1
  IFS=: read -r owner group mode <<<"$metadata"
  [[ "$owner" == 0 && "$group" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  mode_value=$((8#$mode)); (( (mode_value & 8#022) == 0 ))
}

resource_limit_args=(
  --nproc=64:64 --nofile=128:128 --core=0:0 --cpu=30:30
  --as=536870912:536870912 --fsize=1048576:1048576
  --data=268435456:268435456 --stack=16777216:16777216 --rss=268435456:268435456
)

assert_exact_resource_limits() {
  local -a candidate=("$@")
  local -a expected=(
    --nproc=64:64 --nofile=128:128 --core=0:0 --cpu=30:30
    --as=536870912:536870912 --fsize=1048576:1048576
    --data=268435456:268435456 --stack=16777216:16777216 --rss=268435456:268435456
  )
  local index
  (( ${#candidate[@]} == ${#expected[@]} )) || return 1
  for index in "${!expected[@]}"; do
    [[ "${candidate[$index]}" == "${expected[$index]}" ]] || return 1
  done
}

assert_resource_limit_mutations() {
  local missing_label weakened_label target weakened token
  local -a candidate=()
  while IFS='|' read -r missing_label weakened_label target weakened; do
    candidate=(); for token in "${resource_limit_args[@]}"; do [[ "$token" == "$target" ]] || candidate+=("$token"); done
    ! assert_exact_resource_limits "${candidate[@]}" || fail "resource mutation gate accepted $missing_label"
    candidate=(); for token in "${resource_limit_args[@]}"; do [[ "$token" == "$target" ]] && candidate+=("$weakened") || candidate+=("$token"); done
    ! assert_exact_resource_limits "${candidate[@]}" || fail "resource mutation gate accepted $weakened_label"
  done <<'EOF'
missing-address-space-limit|weakened-address-space-limit|--as=536870912:536870912|--as=1073741824:1073741824
missing-file-size-limit|weakened-file-size-limit|--fsize=1048576:1048576|--fsize=2097152:2097152
missing-data-limit|weakened-data-limit|--data=268435456:268435456|--data=536870912:536870912
missing-stack-limit|weakened-stack-limit|--stack=16777216:16777216|--stack=33554432:33554432
missing-rss-limit|weakened-rss-limit|--rss=268435456:268435456|--rss=536870912:536870912
missing-process-count-limit|weakened-process-count-limit|--nproc=64:64|--nproc=128:128
missing-file-descriptor-limit|weakened-file-descriptor-limit|--nofile=128:128|--nofile=256:256
missing-core-limit|weakened-core-limit|--core=0:0|--core=1:1
missing-cpu-limit|weakened-cpu-limit|--cpu=30:30|--cpu=60:60
EOF
  candidate=("${resource_limit_args[@]}" "${resource_limit_args[0]}")
  ! assert_exact_resource_limits "${candidate[@]}" || fail 'resource mutation gate accepted duplicate-resource-limit'
}

verify_minimal_runtime_file() {
  local source="$1" metadata owner group mode mode_value
  [[ "$source" == /* && "$source" != *'/../'* && "$source" != */.. && -f "$source" && -r "$source" ]] || return 1
  metadata="$(/usr/bin/stat -L -c '%u:%g:%a' -- "$source")" || return 1
  IFS=: read -r owner group mode <<<"$metadata"
  [[ "$owner" == 0 && "$group" == 0 && "$mode" =~ ^[0-7]{3,4}$ ]] || return 1
  mode_value=$((8#$mode)); (( (mode_value & 8#022) == 0 ))
}

prepare_minimal_runtime_mounts() {
  local binary ldd_output line first second third dependency
  local -A seen=()
  minimal_runtime_mounts=()
  verify_fixed_outer_binary /usr/bin/ldd true || return 1
  for binary in "$@"; do
    verify_minimal_runtime_file "$binary" || return 1
    if [[ -z "${seen[$binary]:-}" ]]; then minimal_runtime_mounts+=(--ro-bind "$binary" "$binary"); seen["$binary"]=1; fi
    ldd_output="$(/usr/bin/ldd -- "$binary")" || return 1
    [[ "$ldd_output" != *'not found'* ]] || return 1
    while IFS= read -r line; do
      read -r first second third _ <<<"$line"; dependency=
      if [[ "${first:-}" == /* ]]; then dependency="$first"; elif [[ "${second:-}" == '=>' && "${third:-}" == /* ]]; then dependency="$third"; fi
      [[ -n "$dependency" ]] || continue
      verify_minimal_runtime_file "$dependency" || return 1
      if [[ -z "${seen[$dependency]:-}" ]]; then minimal_runtime_mounts+=(--ro-bind "$dependency" "$dependency"); seen["$dependency"]=1; fi
    done <<<"$ldd_output"
  done
}

assert_resource_limit_mutations
assert_exact_resource_limits "${resource_limit_args[@]}" || fail 'canonical resource-limit vector is not exact'

assert_containment_gate_mutations() {
  local sentinel="$work/containment-gate.sentinel" rejected="$work/rejected-bwrap" candidate="$work/containment-candidate" status
  printf '%s' unchanged >"$sentinel"
  printf '#!%s\n%s\n' "$bash_bin" 'exit 77' >"$rejected"
  printf '#!%s\nprintf reached >%q\n' "$bash_bin" "$sentinel" >"$candidate"
  chmod 0700 "$rejected" "$candidate"
  verify_fixed_outer_binary "$work/missing-bwrap" true && fail 'missing Bubblewrap dependency was accepted'
  set +e
  "$env_bin" -i PATH= "$rejected" --unshare-user --unshare-pid --unshare-net -- "$candidate" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" == 77 && "$(<"$sentinel")" == unchanged ]] || fail 'rejected containment reached provisioner sentinel'
}

prepare_linux_containment() {
  local entry="$work/namespace-entry.sh"
  local outside="/tmp/learncoding-provisioner-outside-$$" binary probe_status index preflight_ro_probes
  [[ "$(/usr/bin/uname -s 2>/dev/null || true)" == Linux && "$EUID" == 0 ]] ||
    fail 'authoritative provisioner contract requires Ubuntu/Linux root with Bubblewrap user/mount/PID/network containment'
  for binary in /usr/bin/stat /usr/bin/uname /usr/bin/bash /usr/bin/env /usr/bin/sha256sum \
    /usr/bin/timeout /usr/bin/prlimit /usr/bin/setpriv /usr/bin/chown /usr/bin/ldd /usr/bin/cat \
    /usr/bin/grep /usr/bin/sed /usr/bin/mkdir /usr/bin/chmod /usr/bin/cp /usr/bin/rm /usr/bin/mv /usr/bin/mktemp; do
    verify_fixed_outer_binary "$binary" false || fail "containment dependency is not fixed root-owned and non-writable: $binary"
  done
  verify_fixed_outer_binary /usr/bin/bwrap true ||
    fail '/usr/bin/bwrap must be a regular root-owned non-writable authoritative test dependency'
  containment_probe_dir="$work/containment-output-probe"
  mkdir -m 0700 -p "$containment_probe_dir"
  {
    printf '%s\n' '#!/usr/bin/bash'
    printf 'readonly containment_probe_dir=%q\nreadonly containment_outside=%q\nreadonly containment_repo=%q\n' \
      "$containment_probe_dir" "$outside" "$repo_root"
    cat <<'EOF'
set -Eeuo pipefail
expected_uid="${CONTAINMENT_EXPECT_UID:-0}"
[[ "$expected_uid" =~ ^(0|65534)$ && "$EUID" == "$expected_uid" && "$$" == 1 ]] || exit 90
assert_exact_resource_limit() {
  local label="$1" expected_soft="$2" expected_hard="$3" line remainder soft hard units found=0
  while IFS= read -r line; do
    [[ "$line" == "$label"* ]] || continue
    remainder="${line#"$label"}"; read -r soft hard units <<<"$remainder"
    [[ "$soft" == "$expected_soft" && "$hard" == "$expected_hard" ]] || exit 96
    found=$((found + 1))
  done </proc/self/limits
  [[ "$found" == 1 ]] || exit 96
}
assert_exact_resource_limit 'Max processes' 64 64
assert_exact_resource_limit 'Max open files' 128 128
assert_exact_resource_limit 'Max core file size' 0 0
assert_exact_resource_limit 'Max cpu time' 30 30
assert_exact_resource_limit 'Max address space' 536870912 536870912
assert_exact_resource_limit 'Max file size' 1048576 1048576
assert_exact_resource_limit 'Max data size' 268435456 268435456
assert_exact_resource_limit 'Max stack size' 16777216 16777216
assert_exact_resource_limit 'Max resident set' 268435456 268435456
capability_set_count=0 no_new_privs=
while IFS=$'\t ' read -r key value _; do
  case "$key" in CapEff:|CapPrm:|CapInh:|CapBnd:|CapAmb:) [[ "$value" =~ ^0+$ ]] || exit 91; capability_set_count=$((capability_set_count + 1)) ;; Groups:) [[ -z "${value:-}" ]] || exit 91 ;; NoNewPrivs:) no_new_privs="$value" ;; esac
done </proc/self/status
[[ "$capability_set_count" == 5 && "$no_new_privs" == 1 ]] || exit 91
interface_count=0
while IFS= read -r line; do case "$line" in *:*) interface="${line%%:*}"; interface="${interface//[[:space:]]/}"; [[ "$interface" == lo ]] || exit 92; interface_count=$((interface_count + 1)) ;; esac; done </proc/net/dev
[[ "$interface_count" == 1 ]] || exit 92
[[ ! -e /run/docker.sock && ! -e /run/libvirt/libvirt-sock && ! -e /dev/kvm ]] || exit 93
repo_fixture_mounted=0
[[ -e "$containment_repo" ]] && repo_fixture_mounted=1
for protected_root in /bin /sbin /usr/local /boot /sys /var /etc /home /root; do
  if (( repo_fixture_mounted == 1 )) && { [[ "$containment_repo" == "$protected_root" ]] || [[ "$containment_repo" == "$protected_root"/* ]]; }; then continue; fi
  [[ ! -e "$protected_root" ]] || exit 94
done
[[ ! -e /etc/learncoding && ! -e /var/lib/learncoding ]] || exit 94
[[ ! -e "$containment_repo/.env" && ! -e "$containment_repo/.git" ]] || exit 94
if { : >"$containment_outside"; } 2>/dev/null; then exit 95; fi
IFS=: read -r -a containment_ro_probe_paths <<<"${CONTAINMENT_RO_PROBES:-}"
for protected_path in "${containment_ro_probe_paths[@]}"; do
  [[ -n "$protected_path" && -e "$protected_path" ]] || exit 97
  if [[ -d "$protected_path" ]]; then
    if { : >"$protected_path/.namespace-ro-mutation"; } 2>/dev/null; then exit 97; fi
  elif { printf x >>"$protected_path"; } 2>/dev/null; then exit 97
  fi
done
if [[ "$expected_uid" == 0 ]]; then : >"$containment_probe_dir/.namespace-write-probe"; fi
if [[ "${CONTAINMENT_EXPECT_REGULAR_OUTPUTS:-0}" == 1 ]]; then [[ -f /proc/self/fd/1 && -f /proc/self/fd/2 ]] || exit 98; fi
unset CONTAINMENT_EXPECT_UID
exec "$@"
EOF
  } >"$entry"
  chmod 0500 "$entry"
  containment_entry="$entry"
  containment_entry_sha256="$(sha256_file "$entry")" || fail 'could not hash namespace entry'
  verify_exact_staged_shell_source "$entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" || fail 'namespace entry identity is not verified'
  prepare_minimal_runtime_mounts /usr/bin/bash /usr/bin/cat /usr/bin/grep /usr/bin/sed /usr/bin/mkdir \
    /usr/bin/chmod /usr/bin/cp /usr/bin/rm /usr/bin/mv /usr/bin/mktemp /usr/bin/stat \
    /usr/bin/realpath /usr/bin/readlink ||
    fail 'could not assemble the minimal provisioner runtime'
  containment_ro_mounts=(
    --ro-bind "$entry" "$entry"
    --ro-bind "$provisioner_under_test" "$provisioner_under_test"
    --ro-bind "$fake_bin" "$fake_bin"
    --ro-bind "$network_xml" "$network_xml"
    --ro-bind "$cloud_meta" "$cloud_meta"
    --ro-bind "$cloud_user" "$cloud_user"
    --ro-bind "$base_image" "$base_image"
    --ro-bind "$ssh_key" "$ssh_key"
    --ro-bind "$scenario_file" "$scenario_file"
    --ro-bind "$domain_xml" "$domain_xml"
  )
  containment_rw_mounts=(--bind "$containment_probe_dir" "$containment_probe_dir")
  containment_command=(
    /usr/bin/timeout --signal=KILL --kill-after=5s 45s
    /usr/bin/prlimit "${resource_limit_args[@]}" --
    /usr/bin/setpriv --clear-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all
    /usr/bin/bwrap --die-with-parent --new-session --unshare-user --uid 0 --gid 0
    --unshare-pid --unshare-net --unshare-ipc --unshare-uts --disable-userns --cap-drop ALL --as-pid-1
    --tmpfs /
    "${minimal_runtime_mounts[@]}"
    --dir "$repo_root" --perms 0700 --dir "$host_root"
    --dir "$host_root/dev" --dir "$host_root/var/lib/libvirt/images" --dir "$host_root/var/lib/libvirt/boot"
    "${containment_ro_mounts[@]}"
    "${containment_rw_mounts[@]}"
    --proc /proc --dev /dev --remount-ro / --chdir "$containment_probe_dir" --
    /usr/bin/bash "$entry"
  )
  containment_nonroot_command=("${containment_command[@]}")
  for (( index=0; index<${#containment_nonroot_command[@]}; index++ )); do
    if [[ "${containment_nonroot_command[$index]}" == --uid ]]; then containment_nonroot_command[$((index + 1))]=65534; fi
    if [[ "${containment_nonroot_command[$index]}" == --gid ]]; then containment_nonroot_command[$((index + 1))]=65534; fi
  done
  preflight_ro_probes="$entry:$provisioner_under_test:$fake_bin:$network_xml:$cloud_meta:$cloud_user:$base_image:$ssh_key:$scenario_file:$domain_xml"
  set +e
  /usr/bin/env -i PATH= HOME="$containment_probe_dir" CONTAINMENT_EXPECT_UID=0 CONTAINMENT_RO_PROBES="$preflight_ro_probes" \
    "${containment_command[@]}" /usr/bin/bash -c ':' >/dev/null 2>"$work/containment-preflight.stderr"
  probe_status=$?
  set -e
  (( probe_status == 0 )) || fail 'Bubblewrap containment preflight or mandatory user namespace was rejected'
  [[ -f "$containment_probe_dir/.namespace-write-probe" && ! -e "$outside" ]] || fail 'containment did not prove fixture-only writes'
}

assert_provisioner_execution_identity() {
  local command_name
  verify_exact_staged_shell_source "$provisioner_stage" "$bash_bin" "$provisioner_shebang" "$provisioner_reviewed_sha256" || fail 'provisioner source stage changed after transformation'
  verify_exact_staged_shell_source "$provisioner_under_test" "$bash_bin" "#!$bash_bin" "$provisioner_under_test_sha256" || fail 'transformed provisioner changed before execution'
  verify_exact_staged_shell_source "$containment_entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" || fail 'namespace entry changed before execution'
  for command_name in "${provisioner_fake_commands[@]}"; do
    verify_exact_staged_shell_source "$fake_bin/$command_name" "$bash_bin" "#!$bash_bin" "$fake_host_command_sha256" || fail "provisioner fake changed before execution: $command_name"
  done
  verify_fixed_outer_binary /usr/bin/bwrap true || fail 'Bubblewrap changed before provisioner execution'
  assert_exact_resource_limits "${resource_limit_args[@]}" || fail 'provisioner resource-limit vector changed before execution'
  prepare_minimal_runtime_mounts /usr/bin/bash /usr/bin/cat /usr/bin/grep /usr/bin/sed /usr/bin/mkdir \
    /usr/bin/chmod /usr/bin/cp /usr/bin/rm /usr/bin/mv /usr/bin/mktemp /usr/bin/stat \
    /usr/bin/realpath /usr/bin/readlink ||
    fail 'provisioner minimal runtime changed before execution'
}

execute_provisioner() {
  local expected_uid="$1"
  shift
  local -a selected_containment=("${containment_command[@]}")
  local -a execution_containment=()
  local -a dynamic_mounts=(
    --bind "$state_root" "$state_root"
    --bind "$events" "$events"
    --bind "$host_root/var/lib/libvirt/images" "$host_root/var/lib/libvirt/images"
    --bind "$host_root/var/lib/libvirt/boot" "$host_root/var/lib/libvirt/boot"
  )
  local token
  local ro_probes="$containment_entry:$provisioner_under_test:$fake_bin:$network_xml:$cloud_meta:$cloud_user:$base_image:$ssh_key:$scenario_file:$domain_xml"
  [[ "$expected_uid" == 0 ]] || selected_containment=("${containment_nonroot_command[@]}")
  if [[ -e "$host_root/dev/kvm" ]]; then
    dynamic_mounts+=(--ro-bind "$host_root/dev/kvm" "$host_root/dev/kvm")
    ro_probes+=":$host_root/dev/kvm"
  fi
  for token in "${selected_containment[@]}"; do
    if [[ "$token" == --proc ]]; then execution_containment+=("${dynamic_mounts[@]}"); fi
    execution_containment+=("$token")
  done
  assert_provisioner_execution_identity
  /usr/bin/env -i HOME="$containment_probe_dir" PATH= CONTAINMENT_EXPECT_UID="$expected_uid" \
    CONTAINMENT_RO_PROBES="$ro_probes" CONTAINMENT_EXPECT_REGULAR_OUTPUTS=1 \
    RUNNER_PROVISION_TEST_ROOT="$host_root" RUNNER_BASE_IMAGE_PATH="$base_image" \
    RUNNER_BASE_IMAGE_SHA256="$expected_sha" RUNNER_ADMIN_SSH_PUBLIC_KEY_FILE="$ssh_key" \
    FAKE_EVENTS="$events" FAKE_STATE_ROOT="$state_root" FAKE_HOST_ROOT="$host_root" \
    FAKE_SCENARIO_FILE="$scenario_file" FAKE_NETWORK_XML="$network_xml" FAKE_DOMAIN_XML="$domain_xml" \
    FAKE_EXPECTED_SHA="$expected_sha" FAKE_BASE_IMAGE_PATH="$base_image" FAKE_SSH_KEY_PATH="$ssh_key" \
    FAKE_CLOUD_META="$cloud_meta" FAKE_CLOUD_USER="$cloud_user" \
    "${execution_containment[@]}" /usr/bin/bash "$provisioner_under_test" "$@"
}

assert_containment_gate_mutations
prepare_linux_containment

run_provisioner() {
  local output_file="$1"
  shift
  set +e
  execute_provisioner 0 "$@" >"$output_file.stdout" 2>"$output_file.stderr"
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
execute_provisioner 65534 >"$work/nonroot.stdout" 2>"$work/nonroot.stderr"
nonroot_status=$?
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
