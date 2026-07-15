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
node_bin=/usr/bin/node
collector="$repo_root/infra/ops/capture-recovery-evidence.sh"
collector_shebang='#!/usr/bin/env bash'
collector_reviewed_sha256='PENDING_REVIEW_WHEN_LATER_TASK_ASSET_LANDS'
tmp_base="$(cd /tmp && pwd -P)"
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

if [[ "$(/usr/bin/uname -s 2>/dev/null || true)" != Linux ]]; then
  echo 'FAIL: authoritative evidence contract requires Linux Bubblewrap containment' >&2
  exit 1
fi

if (( EUID != 0 )); then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    cleanup
    trap - EXIT
    exec sudo -n "$bash_bin" "$repo_root/infra/tests/power-evidence.test.sh"
  fi
  echo 'FAIL: power evidence contract requires passwordless sudo for root-owned fixture metadata' >&2
  exit 1
fi

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
[[ -f "$node_bin" && -x "$node_bin" ]] || fail 'fixed /usr/bin/node is required for evidence JSON validation'

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
  local source="$1" digest_line digest
  digest_line="$("$sha256_bin" -- "$source")" || return 1
  digest="${digest_line%% *}"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$digest"
}

verify_exact_staged_shell_source() {
  local staged_source="$1" interpreter="$2" expected_shebang="$3" expected_sha256="$4"
  local first_line line actual_sha256
  local metadata mode mode_value
  local shebang_count=0
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
  local interpreter="$1" expected_shebang="$2"
  local safe_source="$work/reviewed-source-safe.sh" mutated_source="$work/reviewed-source-mutated.sh"
  local transformed="$work/reviewed-source-transformed.sh" sentinel="$work/reviewed-source.sentinel"
  local safe_sha256 label mutation
  printf '%s\n%s\n' "$expected_shebang" 'set -e' >"$safe_source"
  safe_sha256="$(sha256_file "$safe_source")" || fail 'could not hash reviewed source mutation baseline'
  printf '%s' unchanged >"$sentinel"
  while IFS='|' read -r label mutation; do
    printf '%s\n%s\n%s\n%s\n' "$expected_shebang" 'set -e' "$mutation" \
      'printf reached >"$SOURCE_IDENTITY_SENTINEL"' >"$mutated_source"
    rm -f -- "$transformed"
    stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" &&
      fail "reviewed source identity accepted $label mutation"
    [[ ! -e "$transformed" && "$(<"$sentinel")" == unchanged ]] || fail "$label mutation escaped source verification"
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
  printf '%s\n%s\n' '/usr/bin/cp -- "$SOURCE" "$DESTINATION"' 'set -e' >"$mutated_source"
  rm -f -- "$transformed"
  stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" &&
    fail 'reviewed source identity accepted a line-1 absolute command'
  [[ ! -e "$transformed" && "$(<"$sentinel")" == unchanged ]] || fail 'line-1 mutation escaped verification'
  printf '%s\n%s\n%s\n' "$expected_shebang" "$expected_shebang" 'set -e' >"$mutated_source"
  stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" &&
    fail 'reviewed source identity accepted duplicate shebangs'
  printf '%s\r\n%s\r\n' "$expected_shebang" 'set -e' >"$mutated_source"
  stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" &&
    fail 'reviewed source identity accepted CRLF source'
  rm -f -- "$work/reviewed-source-symlink.sh"
  ln -s "$safe_source" "$work/reviewed-source-symlink.sh"
  if [[ -L "$work/reviewed-source-symlink.sh" ]]; then
    stage_and_make_path_sealed_copy "$work/reviewed-source-symlink.sh" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" &&
      fail 'reviewed source identity accepted a symlink'
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

collector_stage="$work/capture-recovery-evidence.reviewed.stage.sh"
stage_live_source_once "$collector" "$collector_stage" ||
  fail 'could not open the evidence collector exactly once with O_NOFOLLOW'
verify_exact_staged_shell_source "$collector_stage" "$bash_bin" "$collector_shebang" "$collector_reviewed_sha256" ||
  fail 'evidence collector staged identity, shebang, regular-file, LF, syntax, or SHA is not reviewed'
assert_source_identity_mutations "$bash_bin" "$collector_shebang"
assert_source_race_mutations "$bash_bin" "$collector_shebang" || fail 'evidence source race defenses failed'
if source_manipulates_path "$collector_stage"; then
  fail 'evidence collector may not reference or mutate the harness-owned PATH'
fi
assert_path_mutation_defenses "$bash_bin"
collector_under_test="$work/capture-recovery-evidence.sealed.sh"
fake_bin="$work/bin"
collector_fake_commands=(id systemctl virsh docker curl journalctl findmnt smartctl date git uname mktemp mv sync rm cat \
  stat realpath readlink sha256sum chmod chown mkdir mount umount wget nc ping dd truncate touch tee ln rsync sudo ssh scp socat install)
make_path_sealed_copy "$collector_stage" "$collector_under_test" "$bash_bin" "$collector_shebang" "$collector_reviewed_sha256" \
  "$fake_bin" "${collector_fake_commands[@]}" || fail 'could not create reviewed evidence collector test copy'
grep -Fxq 'PATH=' "$collector_under_test" && grep -Fxq 'readonly PATH' "$collector_under_test" ||
  fail 'evidence collector test copy did not seal PATH before the SUT body'
collector_under_test_sha256="$(sha256_file "$collector_under_test")" || fail 'could not hash transformed evidence collector'
verify_exact_staged_shell_source "$collector_under_test" "$bash_bin" "#!$bash_bin" "$collector_under_test_sha256" ||
  fail 'transformed evidence collector identity is not verified'

if tail -n +2 "$collector_stage" | grep -Eq '/(usr/)?(s?bin|libexec)/[A-Za-z0-9_.+-]+'; then
  fail 'evidence collector hard-codes an executable path and can bypass the isolated fake PATH'
fi
if tail -n +2 "$collector_stage" | grep -Eq '\$BASH([^A-Za-z0-9_]|$)|\$\{BASH([^A-Za-z0-9_]|$)|(^|[;&|({])[[:space:]]*(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+|(^|[[:space:]])(if|then|while|until|do|else|!)[[:space:]]+(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+'; then
  fail 'evidence collector can invoke an absolute executable or the ambient Bash interpreter outside the fake PATH'
fi
if tail -n +2 "$collector_stage" | grep -Eq 'command[[:space:]]+-p|enable[[:space:]]+-f|hash[[:space:]]+-p|/dev/(tcp|udp)/'; then
  fail 'evidence collector can bypass fake command lookup'
fi
unsafe_absolute_redirects="$(tail -n +2 "$collector_stage" | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
if [[ -n "$unsafe_absolute_redirects" ]]; then
  fail 'evidence collector redirects output to an absolute path other than /dev/null'
fi
redirect_prefix_probe="$(printf '%s\n' 'printf unsafe >/dev/null.evil' | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
[[ -n "$redirect_prefix_probe" ]] || fail 'evidence redirect guard accepted a /dev/null prefix sibling'
if tail -n +2 "$collector_stage" | grep -Eq '(^|[;&|()[:space:]])(env|sh|bash|dash|zsh)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])(eval|source)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])\.[[:space:]]+/'; then
  fail 'evidence collector can spawn or source an uninstrumented shell command'
fi
if tail -n +2 "$collector_stage" | grep -Eq '(^|[^<])<[[:space:]]*([^<(&]|$)'; then
  fail 'evidence collector contains an uninstrumented shell file read'
fi
if grep -Eiq '/etc/learncoding/secrets|/secrets/|runner_shared_secret|RUNNER_[A-Z0-9_]*SECRET' "$collector_stage"; then
  fail 'evidence collector references a runner or application secret path'
fi
grep -Fq 'RECOVERY_EVIDENCE_TEST_ROOT' "$collector_stage" || fail 'evidence collector is missing the single narrow test-root seam'
grep -Fq '/var/lib/learncoding/recovery-evidence' "$collector_stage" || fail 'evidence collector changed the fixed production root'

host_root="$work/host-root"
evidence_root="$host_root/var/lib/learncoding/recovery-evidence"
fake_bin="$work/bin"
state_root="$work/state"
curl_root="$state_root/curl"
events="$work/events.log"
scenario_file="$state_root/scenario"
compose_env_path="$host_root/etc/learncoding/compose.env"
mkdir -m 0700 -p "$evidence_root" "$fake_bin" "$state_root" "$curl_root" "$host_root/proc/sys/kernel" \
  "$host_root/proc" "$host_root/var/lib/learncoding-runner" "$host_root/etc/learncoding/secrets" \
  "$host_root/var/lib/learncoding/backups"
chown -R 0:0 "$host_root"
chmod 0700 "$evidence_root"
printf '%s' '11111111-2222-3333-4444-555555555555' >"$host_root/proc/sys/kernel/random/boot_id"
printf '%s' '3723.14 100.00' >"$host_root/proc/uptime"
printf '%s' 'backup-20260715T120000Z-fixture' >"$host_root/var/lib/learncoding/backups/last-success"
: >"$compose_env_path"
chown 0:0 "$compose_env_path"
chmod 0640 "$compose_env_path"

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
postgres_sql="SELECT name, setting FROM pg_settings WHERE name IN ('fsync', 'synchronous_commit', 'full_page_writes');"
printf '%s' "$runner_journal_canary" >"$host_root/var/lib/learncoding-runner/private-journal.json"
printf '%s' "$secret_canary" >"$host_root/etc/learncoding/secrets/runner_shared_secret"
chmod 0400 "$host_root/etc/learncoding/secrets/runner_shared_secret"

printf '#!%s\n' "$bash_bin" >"$fake_bin/fake-evidence-command"
cat >>"$fake_bin/fake-evidence-command" <<'FAKE'
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
  safe_under "$FAKE_HOST_ROOT" "$1"
}

inside_evidence_root() {
  safe_under "$FAKE_EVIDENCE_ROOT" "$1"
}

inside_curl_output_root() {
  local candidate="$1"
  local basename="${candidate##*/}"
  safe_under "$FAKE_CURL_ROOT" "$candidate" || {
    inside_evidence_root "$candidate" && [[ "$basename" == *tmp* ]]
  }
}

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

case "$command_name" in
  id)
    [[ "$#" == 1 && "$1" == -u ]] || exit 64
    printf '%s\n' "$EUID"
    ;;
  systemctl)
    case "${1:-}" in
      is-active)
        [[ "$#" == 2 && "$2" =~ ^(docker|libvirtd|learncoding-runner-firewall|learncoding-compose)\.service$ ]] || exit 64
        printf '%s\n' active
        ;;
      is-enabled)
        [[ "$#" == 2 && "$2" =~ ^learncoding-(backup|backup-check|retention|recovery-check)\.timer$ ]] || exit 64
        printf '%s\n' enabled
        ;;
      show)
        [[ "$#" == 4 && "$3" == --property=NRestarts && "$4" == --value ]] || exit 64
        [[ "$2" =~ ^learncoding-[A-Za-z0-9@_.-]+\.(service|timer)$ ]] || exit 64
        printf '%s\n' 1
        ;;
      *) exit 64 ;;
    esac
    ;;
  virsh)
    if [[ "${1:-}" == --version ]]; then printf '%s\n' '10.0.0-fixture'; exit 0; fi
    if [[ "${1:-}" == --connect && "${2:-}" == qemu:///system ]]; then shift 2; fi
    [[ "$#" == 2 ]] || exit 64
    case "${1:-}:${2:-}" in
      domstate:codestead-runner) printf '%s\n' running ;;
      dominfo:codestead-runner) printf '%s\n' 'Name: codestead-runner' 'Autostart: enable' ;;
      net-info:codestead-runner) printf '%s\n' 'Name: codestead-runner' 'Active: yes' 'Autostart: yes' ;;
      *) exit 64 ;;
    esac
    ;;
  docker)
    if [[ "$#" == 3 && "$1" == version && "$2" == --format && "$3" == '{{.Server.Version}}' ]]; then
      printf '%s\n' '29.6.1-fixture'
      exit 0
    fi
    if [[ "$#" == 1 && "$1" == info ]]; then exit 0; fi
    if [[ "$#" == 16 && "$1" == compose && "$2" == --env-file && "$3" == "$FAKE_COMPOSE_ENV" && \
      "$4" == -f && "$5" == "$FAKE_COMPOSE_FILE" && "$6" == exec && "$7" == -T && \
      "$8" == postgres && "$9" == psql && "${10}" == --username=learncoding && \
      "${11}" == --dbname=learncoding && "${12}" == --no-align && "${13}" == --tuples-only && \
      "${14}" == '--field-separator=|' && "${15}" == --command && "${16}" == "$FAKE_POSTGRES_SQL" ]]; then
      printf '%s\n' 'fsync|on' 'synchronous_commit|on' 'full_page_writes|on' 'data_checksums|on'
      exit 0
    fi
    if [[ "$#" == 3 && "$1" == ps && "$2" == --all && "$3" == --quiet ]]; then
      printf '%s\n' aaaaaaaaaaaa bbbbbbbbbbbb cccccccccccc dddddddddddd eeeeeeeeeeee
      printf 'private Docker diagnostic: %s %s %s %s\n' \
        "$FAKE_RAW_COMMAND_CANARY" "$FAKE_LEARNER_CANARY" "$FAKE_SOURCE_CANARY" "$FAKE_LEARNER_ID_CANARY" >&2
      exit 0
    fi
    if [[ "$#" == 4 && "$1" == inspect && "$2" == --format && \
      "$3" == '{{.Name}}|{{.State.Status}}|{{.RestartCount}}|{{.Image}}' ]]; then
      case "$4" in
        aaaaaaaaaaaa) printf '/learncoding-postgres|running|1|sha256:%s\n' "$(printf 'a%.0s' {1..64})" ;;
        bbbbbbbbbbbb) printf '/learncoding-app|running|0|sha256:%s\n' "$(printf 'b%.0s' {1..64})" ;;
        cccccccccccc) printf '/learncoding-mail-worker|running|0|sha256:%s\n' "$(printf 'c%.0s' {1..64})" ;;
        dddddddddddd) printf '/learncoding-reward-worker|running|0|sha256:%s\n' "$(printf 'd%.0s' {1..64})" ;;
        eeeeeeeeeeee) printf '/learncoding-cloudflared|running|0|sha256:%s\n' "$(printf 'e%.0s' {1..64})" ;;
        *) exit 64 ;;
      esac
      exit 0
    fi
    exit 64
    ;;
  curl)
    [[ "$#" == 11 && "$1" == --silent && "$2" == --show-error && "$3" == --fail && \
      "$4" == --max-time && "$5" == 10 && "$6" == --output && "$8" == --dump-header && \
      "${10}" == --url && "${11}" == https://pilot.example.test/health/ready ]] || exit 64
    output="$7"
    headers="$9"
    url="${11}"
    [[ "$url" == https://pilot.example.test/health/ready ]] || exit 97
    body="{\"status\":\"ok\",\"private\":\"$FAKE_HTTP_BODY_CANARY\"}"
    header="HTTP/2 200
x-private-fixture: $FAKE_HTTP_HEADER_CANARY"
    if [[ -n "$output" ]]; then
      inside_curl_output_root "$output" || exit 97
      printf '%s' "$body" >"$output"
    else
      printf '%s' "$body"
    fi
    if [[ -n "$headers" ]]; then
      inside_curl_output_root "$headers" || exit 97
      printf '%s\n' "$header" >"$headers"
    fi
    ;;
  journalctl)
    [[ "$#" == 0 ]] || exit 64
    printf '%s\n' "$FAKE_RUNNER_JOURNAL_CANARY"
    ;;
  findmnt)
    [[ "$#" == 5 && "$1" == --json && "$2" == --output && "$3" == TARGET,SOURCE,OPTIONS && \
      "$4" == --target && "$5" == /srv/learncoding ]] || exit 64
    printf '%s\n' '{"filesystems":[{"target":"/srv/learncoding","source":"UUID=fixture-data","options":"rw,nodev,nosuid"}]}'
    ;;
  smartctl)
    [[ "$#" == 3 && "$1" == --health && "$2" == --attributes && "$3" == /dev/nvme0n1 ]] || exit 64
    [[ "$scenario" != smart-fail ]] || exit 2
    printf '%s\n' \
      "Serial Number: $FAKE_SMART_SERIAL_CANARY" \
      'SMART overall-health self-assessment test result: PASSED' \
      'Critical Warning: 0x00' \
      'Media and Data Integrity Errors: 0'
    ;;
  date)
    case "$#:${1:-}:${2:-}" in
      '2:--utc:+%Y-%m-%dT%H:%M:%SZ') printf '%s\n' '2026-07-15T12:00:00Z' ;;
      '1:+%s:') printf '%s\n' 1784116800 ;;
      *) exit 64 ;;
    esac
    ;;
  git)
    [[ "$#" == 4 && "$1" == -C && "$2" == "$FAKE_REPO_ROOT" && "$3" == rev-parse && "$4" == HEAD ]] || exit 64
    printf '%s\n' '0123456789abcdef0123456789abcdef01234567'
    ;;
  uname)
    [[ "${1:-}" == -r ]] || exit 64
    printf '%s\n' '6.8.0-fixture'
    ;;
  mktemp)
    destination_hint="${!#}"
    tmpdir=
    expect_tmpdir=false
    for argument in "$@"; do
      if [[ "$expect_tmpdir" == true ]]; then tmpdir="$argument"; expect_tmpdir=false; continue; fi
      case "$argument" in
        -d) ;;
        -p|--tmpdir) expect_tmpdir=true ;;
        --tmpdir=*) tmpdir="${argument#--tmpdir=}" ;;
        -*) exit 64 ;;
        *) destination_hint="$argument" ;;
      esac
    done
    [[ "$expect_tmpdir" == false ]] || exit 64
    if [[ -n "$tmpdir" ]]; then
      inside_evidence_root "$tmpdir" || exit 97
      [[ -n "$destination_hint" && "$destination_hint" != */* && "$destination_hint" != . && "$destination_hint" != .. ]] || exit 97
      inside_evidence_root "$tmpdir/$destination_hint" || exit 97
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
    [[ "$(/usr/bin/dirname -- "$source_path")" == "$(/usr/bin/dirname -- "$destination_path")" ]] || exit 96
    /usr/bin/mv -- "$source_path" "$destination_path"
    ;;
  sync)
    sync_targets=()
    for argument in "$@"; do case "$argument" in -f|--file-system|--) ;; -*) exit 64 ;; *) sync_targets+=("$argument") ;; esac; done
    (( ${#sync_targets[@]} > 0 )) || exit 64
    for target in "${sync_targets[@]}"; do inside_evidence_root "$target" || exit 97; done
    ;;
  rm)
    rm_args=("$@")
    rm_targets=()
    for argument in "${rm_args[@]}"; do case "$argument" in --|-f) ;; -*) exit 64 ;; *) rm_targets+=("$argument") ;; esac; done
    (( ${#rm_targets[@]} > 0 )) || exit 64
    for target in "${rm_targets[@]}"; do
      inside_evidence_root "$target" || exit 97
      basename="${target##*/}"
      [[ "$basename" == .*tmp* || "$basename" == *.tmp.* ]] || exit 96
    done
    /usr/bin/rm "${rm_args[@]}"
    ;;
  cat)
    for path in "$@"; do
      [[ "$path" == -- ]] && continue
      [[ "$path" != *learncoding-runner* ]] || exit 97
      [[ "$path" != */secrets/* ]] || exit 97
      inside_host_root "$path" || exit 97
    done
    /usr/bin/cat "$@"
    ;;
  stat|realpath|readlink|sha256sum)
    read_targets=()
    expect_format=false
    for argument in "$@"; do
      if [[ "$expect_format" == true ]]; then expect_format=false; continue; fi
      case "$argument" in -c|--format|--printf) expect_format=true ;; --|-e|-f|-m|-n|-q|-s|-v|--check|--status|--strict|--format=*|--printf=*) ;; -*) exit 64 ;; *) read_targets+=("$argument") ;; esac
    done
    [[ "$expect_format" == false && ${#read_targets[@]} == 1 ]] || exit 64
    for target in "${read_targets[@]}"; do inside_host_root "$target" || exit 97; done
    "/usr/bin/$command_name" "$@"
    ;;
  chmod)
    chmod_args=("$@")
    [[ ${#chmod_args[@]} -ge 2 ]] || exit 64
    mode="${chmod_args[0]}"
    [[ "$mode" =~ ^[0-7]{3,4}$ ]] || exit 64
    for target in "${chmod_args[@]:1}"; do [[ "$target" == -- ]] || inside_evidence_root "$target" || exit 97; done
    /usr/bin/chmod "${chmod_args[@]}"
    ;;
  chown)
    chown_args=("$@")
    [[ ${#chown_args[@]} -ge 2 && "${chown_args[0]}" == 0:0 ]] || exit 64
    for target in "${chown_args[@]:1}"; do [[ "$target" == -- ]] || inside_evidence_root "$target" || exit 97; done
    ;;
  mkdir)
    mkdir_args=("$@")
    mkdir_targets=()
    expect_mode=false
    for argument in "${mkdir_args[@]}"; do
      if [[ "$expect_mode" == true ]]; then expect_mode=false; continue; fi
      case "$argument" in -p|--) ;; -m) expect_mode=true ;; -*) exit 64 ;; *) mkdir_targets+=("$argument") ;; esac
    done
    [[ "$expect_mode" == false && ${#mkdir_targets[@]} -gt 0 ]] || exit 64
    for target in "${mkdir_targets[@]}"; do inside_evidence_root "$target" || exit 97; done
    /usr/bin/mkdir "${mkdir_args[@]}"
    ;;
  mount|umount|wget|nc|ping|dd|truncate|touch|tee|ln|rsync|sudo|ssh|scp|socat|install)
    exit 97
    ;;
  *) exit 64 ;;
esac
FAKE
chmod 0555 "$fake_bin/fake-evidence-command"
for command_name in id systemctl virsh docker curl journalctl findmnt smartctl date git uname mktemp mv sync rm cat \
  stat realpath readlink sha256sum chmod chown mkdir \
  mount umount wget nc ping dd truncate touch tee ln rsync sudo ssh scp socat install; do
  cp "$fake_bin/fake-evidence-command" "$fake_bin/$command_name"
done
chmod 0555 "$fake_bin"/*
fake_evidence_sha256="$(sha256_file "$fake_bin/fake-evidence-command")" || fail 'could not hash strict evidence fake command'
for command_name in "${collector_fake_commands[@]}"; do
  verify_exact_staged_shell_source "$fake_bin/$command_name" "$bash_bin" "#!$bash_bin" "$fake_evidence_sha256" ||
    fail "evidence fake command identity is not verified: $command_name"
done

outside_sentinel="$work/outside-fake-roots.sentinel"
printf '%s' 'outside-fixture-sentinel-unchanged' >"$outside_sentinel"
printf '%s' success >"$scenario_file"
: >"$events"
set +e
"$env_bin" -i PATH="$fake_bin" FAKE_EVENTS="$events" FAKE_SCENARIO_FILE="$scenario_file" \
  FAKE_HOST_ROOT="$host_root" FAKE_EVIDENCE_ROOT="$evidence_root" FAKE_CURL_ROOT="$curl_root" \
  "$fake_bin/cat" -- "$outside_sentinel" >"$work/outside-read.stdout" 2>"$work/outside-read.stderr"
outside_read_status=$?
"$env_bin" -i PATH="$fake_bin" FAKE_EVENTS="$events" FAKE_SCENARIO_FILE="$scenario_file" \
  FAKE_HOST_ROOT="$host_root" FAKE_EVIDENCE_ROOT="$evidence_root" FAKE_CURL_ROOT="$curl_root" \
  "$fake_bin/cat" -- "$host_root/etc/learncoding/secrets/runner_shared_secret" \
  >"$work/secret-read.stdout" 2>"$work/secret-read.stderr"
secret_read_status=$?
PATH="$fake_bin" cp -- "$host_root/proc/uptime" "$outside_sentinel" >"$work/outside-write.stdout" 2>"$work/outside-write.stderr"
outside_write_status=$?
PATH="$fake_bin" evidence-contract-unknown-command >"$work/outside-unknown.stdout" 2>"$work/outside-unknown.stderr"
outside_unknown_status=$?
set -e
(( outside_read_status != 0 && secret_read_status != 0 && outside_write_status != 0 && outside_unknown_status != 0 )) ||
  fail 'fake-only evidence PATH allowed an unknown, secret/outside read, or outside write command'
[[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
  fail 'outside-fixture evidence sentinel was modified'
[[ ! -s "$work/secret-read.stdout" ]] || fail 'secret-read boundary returned secret bytes'

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
    candidate=()
    for token in "${resource_limit_args[@]}"; do [[ "$token" == "$target" ]] || candidate+=("$token"); done
    ! assert_exact_resource_limits "${candidate[@]}" || fail "resource mutation gate accepted $missing_label"
    candidate=()
    for token in "${resource_limit_args[@]}"; do [[ "$token" == "$target" ]] && candidate+=("$weakened") || candidate+=("$token"); done
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
  [[ "$status" == 77 && "$(<"$sentinel")" == unchanged ]] || fail 'rejected containment reached the evidence SUT sentinel'
}

prepare_linux_containment() {
  local entry="$work/namespace-entry.sh"
  local outside="/tmp/learncoding-power-evidence-outside-$$" binary probe_status preflight_ro_probes
  [[ "$(/usr/bin/uname -s 2>/dev/null || true)" == Linux && "$EUID" == 0 ]] ||
    fail 'authoritative evidence contract requires Ubuntu/Linux root with Bubblewrap user/mount/PID/network containment'
  for binary in /usr/bin/stat /usr/bin/uname /usr/bin/bash /usr/bin/env /usr/bin/sha256sum \
    /usr/bin/timeout /usr/bin/prlimit /usr/bin/setpriv /usr/bin/node /usr/bin/ldd /usr/bin/mktemp \
    /usr/bin/dirname /usr/bin/mv /usr/bin/rm /usr/bin/cat /usr/bin/realpath /usr/bin/readlink \
    /usr/bin/chmod /usr/bin/mkdir; do
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
[[ "$EUID" == 0 && "$$" == 1 ]] || exit 90
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
: >"$containment_probe_dir/.namespace-write-probe"
if [[ "${CONTAINMENT_EXPECT_REGULAR_OUTPUTS:-0}" == 1 ]]; then
  [[ -f /proc/self/fd/1 && -f /proc/self/fd/2 ]] || exit 98
fi
exec "$@"
EOF
  } >"$entry"
  chmod 0500 "$entry"
  containment_entry="$entry"
  containment_entry_sha256="$(sha256_file "$entry")" || fail 'could not hash namespace entry'
  verify_exact_staged_shell_source "$entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" || fail 'namespace entry identity is not verified'
  prepare_minimal_runtime_mounts /usr/bin/bash /usr/bin/mktemp /usr/bin/dirname /usr/bin/mv /usr/bin/rm \
    /usr/bin/cat /usr/bin/stat /usr/bin/realpath /usr/bin/readlink /usr/bin/sha256sum /usr/bin/chmod \
    /usr/bin/mkdir || fail 'could not assemble the minimal evidence runtime'
  containment_ro_mounts=(
    --ro-bind "$entry" "$entry"
    --ro-bind "$collector_under_test" "$collector_under_test"
    --ro-bind "$fake_bin" "$fake_bin"
    --ro-bind "$scenario_file" "$scenario_file"
    --ro-bind "$compose_env_path" "$compose_env_path"
    --ro-bind "$host_root/proc/sys/kernel/random/boot_id" "$host_root/proc/sys/kernel/random/boot_id"
    --ro-bind "$host_root/proc/uptime" "$host_root/proc/uptime"
    --ro-bind "$host_root/var/lib/learncoding/backups/last-success" "$host_root/var/lib/learncoding/backups/last-success"
    --ro-bind "$repo_root/compose.yaml" "$repo_root/compose.yaml"
  )
  containment_rw_mounts=(--bind "$containment_probe_dir" "$containment_probe_dir")
  evidence_execution_rw_mounts=(
    --bind "$evidence_root" "$evidence_root"
    --bind "$curl_root" "$curl_root"
    --bind "$events" "$events"
  )
  containment_command=(
    /usr/bin/timeout --signal=KILL --kill-after=5s 45s
    /usr/bin/prlimit "${resource_limit_args[@]}" --
    /usr/bin/setpriv --clear-groups --no-new-privs --bounding-set=-all --inh-caps=-all --ambient-caps=-all
    /usr/bin/bwrap --die-with-parent --new-session --unshare-user --uid 0 --gid 0
    --unshare-pid --unshare-net --unshare-ipc --unshare-uts --disable-userns --cap-drop ALL --as-pid-1
    --tmpfs /
    "${minimal_runtime_mounts[@]}"
    --perms 0700 --dir "$host_root"
    --dir "$host_root/proc/sys/kernel" --dir "$host_root/var/lib/learncoding/backups"
    --dir "$host_root/var/lib/learncoding/recovery-evidence" --dir "$host_root/etc/learncoding"
    --dir "$repo_root"
    "${containment_ro_mounts[@]}"
    "${containment_rw_mounts[@]}"
    --proc /proc --dev /dev --remount-ro / --chdir "$containment_probe_dir" --
    /usr/bin/bash "$entry"
  )
  preflight_ro_probes="$entry:$collector_under_test:$fake_bin:$scenario_file:$compose_env_path:$host_root/proc/sys/kernel/random/boot_id:$host_root/proc/uptime:$host_root/var/lib/learncoding/backups/last-success:$repo_root/compose.yaml"
  set +e
  /usr/bin/env -i PATH= HOME="$containment_probe_dir" CONTAINMENT_RO_PROBES="$preflight_ro_probes" \
    "${containment_command[@]}" /usr/bin/bash -c ':' >/dev/null 2>"$work/containment-preflight.stderr"
  probe_status=$?
  set -e
  (( probe_status == 0 )) || fail 'Bubblewrap containment preflight or mandatory user namespace was rejected'
  [[ -f "$containment_probe_dir/.namespace-write-probe" && ! -e "$outside" ]] || fail 'containment did not prove fixture-only writes'
}

assert_evidence_execution_identity() {
  local command_name
  verify_exact_staged_shell_source "$collector_stage" "$bash_bin" "$collector_shebang" "$collector_reviewed_sha256" || fail 'evidence source stage changed after transformation'
  verify_exact_staged_shell_source "$collector_under_test" "$bash_bin" "#!$bash_bin" "$collector_under_test_sha256" || fail 'transformed evidence collector changed before execution'
  verify_exact_staged_shell_source "$containment_entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" || fail 'namespace entry changed before execution'
  for command_name in "${collector_fake_commands[@]}"; do
    verify_exact_staged_shell_source "$fake_bin/$command_name" "$bash_bin" "#!$bash_bin" "$fake_evidence_sha256" || fail "evidence fake command changed before execution: $command_name"
  done
  verify_fixed_outer_binary /usr/bin/bwrap true || fail 'Bubblewrap changed before evidence collector execution'
  assert_exact_resource_limits "${resource_limit_args[@]}" || fail 'evidence resource-limit vector changed before execution'
  prepare_minimal_runtime_mounts /usr/bin/bash /usr/bin/mktemp /usr/bin/dirname /usr/bin/mv /usr/bin/rm \
    /usr/bin/cat /usr/bin/stat /usr/bin/realpath /usr/bin/readlink /usr/bin/sha256sum /usr/bin/chmod \
    /usr/bin/mkdir || fail 'evidence minimal runtime changed before execution'
}

assert_containment_gate_mutations
prepare_linux_containment

run_collector() {
  local scenario="$1"
  local phase="$2"
  local destination="$3"
  local prefix="$4"
  local token
  local -a execution_containment=()
  local ro_probes="$containment_entry:$collector_under_test:$fake_bin:$scenario_file:$compose_env_path:$host_root/proc/sys/kernel/random/boot_id:$host_root/proc/uptime:$host_root/var/lib/learncoding/backups/last-success:$repo_root/compose.yaml"
  printf '%s' "$scenario" >"$scenario_file"
  : >"$events"
  for token in "${containment_command[@]}"; do
    if [[ "$token" == --proc ]]; then execution_containment+=("${evidence_execution_rw_mounts[@]}"); fi
    execution_containment+=("$token")
  done
  set +e
  assert_evidence_execution_identity
  printf '%s' "$stdin_canary" | /usr/bin/env -i \
    HOME="$containment_probe_dir" \
    PATH= \
    CONTAINMENT_RO_PROBES="$ro_probes" \
    CONTAINMENT_EXPECT_REGULAR_OUTPUTS=1 \
    TMPDIR="$curl_root" \
    RECOVERY_EVIDENCE_TEST_ROOT="$host_root" \
    RECOVERY_PUBLIC_URL='https://pilot.example.test/health/ready' \
    FAKE_EVENTS="$events" \
    FAKE_SCENARIO_FILE="$scenario_file" \
    FAKE_HOST_ROOT="$host_root" \
    FAKE_EVIDENCE_ROOT="$evidence_root" \
    FAKE_CURL_ROOT="$curl_root" \
    FAKE_COMPOSE_ENV="$compose_env_path" \
    FAKE_COMPOSE_FILE="$repo_root/compose.yaml" \
    FAKE_POSTGRES_SQL="$postgres_sql" \
    FAKE_REPO_ROOT="$repo_root" \
    FAKE_SECRET_CANARY="$secret_canary" \
    FAKE_LEARNER_CANARY="$learner_canary" \
    FAKE_LEARNER_ID_CANARY="$learner_id_canary" \
    FAKE_SOURCE_CANARY="$source_canary" \
    FAKE_HTTP_BODY_CANARY="$http_body_canary" \
    FAKE_HTTP_HEADER_CANARY="$http_header_canary" \
    FAKE_SMART_SERIAL_CANARY="$smart_serial_canary" \
    FAKE_RUNNER_JOURNAL_CANARY="$runner_journal_canary" \
    FAKE_RAW_COMMAND_CANARY="$raw_command_canary" \
    "${execution_containment[@]}" /usr/bin/bash "$collector_under_test" "$phase" "$destination" >"$prefix.stdout" 2>"$prefix.stderr"
  collector_status=$?
  set -e
  [[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
    fail 'evidence collector modified the outside-fixture sentinel'
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

assert_no_secret_or_runner_read() {
  ! grep -Eiq '/etc/learncoding/secrets|/secrets/|runner_shared_secret|RUNNER_[A-Z0-9_]*SECRET|/var/lib/learncoding-runner' "$events" ||
    fail 'evidence collector attempted a secret or runner-private read'
}

validate_evidence_json() {
  local file="$1"
  local phase="$2"
  EVIDENCE_FILE="$file" EXPECTED_PHASE="$phase" "$node_bin" <<'NODE'
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
if (!/^[0-9a-f]{40}$/.test(value.gitCommit) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value.bootId)) process.exit(5);
if (!Number.isSafeInteger(value.uptimeSeconds) || value.uptimeSeconds < 0 || value.uptimeSeconds > 315576000) process.exit(6);
if (!exactKeys(value.services, ["compose", "docker", "firewall", "libvirt", "recoveryTimer"])) process.exit(7);
if (Object.values(value.services).some((entry) => typeof entry !== "boolean")) process.exit(8);
if (!exactKeys(value.containers, ["expected", "items", "running"]) || !Array.isArray(value.containers.items)) process.exit(9);
if (value.containers.items.length > 16) process.exit(10);
if (!Number.isSafeInteger(value.containers.expected) || !Number.isSafeInteger(value.containers.running) ||
    value.containers.expected < 0 || value.containers.running < 0 || value.containers.running > value.containers.expected ||
    value.containers.items.length !== value.containers.expected) process.exit(25);
for (const item of value.containers.items) {
  if (!exactKeys(item, ["imageId", "name", "restartCount", "status"])) process.exit(11);
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(item.name) || !/^sha256:[0-9a-f]{64}$/.test(item.imageId)) process.exit(12);
  if (!Number.isSafeInteger(item.restartCount) || item.restartCount < 0 || item.restartCount > 1000000) process.exit(13);
  if (!new Set(["running", "exited", "paused", "restarting"]).has(item.status)) process.exit(26);
}
if (value.containers.running !== value.containers.items.filter((item) => item.status === "running").length) process.exit(34);
if (!exactKeys(value.runner, ["domainActive", "domainAutostart", "networkActive", "networkAutostart"])) process.exit(14);
if (Object.values(value.runner).some((entry) => typeof entry !== "boolean")) process.exit(27);
if (!Array.isArray(value.mounts) || value.mounts.length < 1 || value.mounts.length > 3) process.exit(15);
const allowedMountTargets = new Set(["/etc/learncoding", "/opt/learncoding", "/srv/learncoding"]);
const observedMountTargets = new Set();
for (const mount of value.mounts) {
  if (!exactKeys(mount, ["options", "source", "target"])) process.exit(16);
  for (const field of ["options", "source", "target"]) {
    if (typeof mount[field] !== "string" || mount[field].length < 1 || mount[field].length > 256 || /[\r\n\0]/u.test(mount[field])) process.exit(28);
  }
  if (!allowedMountTargets.has(mount.target) || observedMountTargets.has(mount.target) ||
      !/^\/(?:etc|opt|srv)\/learncoding$/u.test(mount.target) ||
      !/^[A-Za-z0-9_.,=:/+-]+$/u.test(mount.source) || !/^[A-Za-z0-9_.,=:/+-]+$/u.test(mount.options)) process.exit(29);
  observedMountTargets.add(mount.target);
}
if (!exactKeys(value.postgres, ["checksums", "durability", "healthy"])) process.exit(17);
if (!exactKeys(value.postgres.durability, ["fsync", "fullPageWrites", "synchronousCommit"])) process.exit(18);
if (Object.values(value.postgres.durability).some((entry) => entry !== "on")) process.exit(19);
if (typeof value.postgres.checksums !== "boolean" || typeof value.postgres.healthy !== "boolean") process.exit(30);
if (!exactKeys(value.smart, ["criticalWarnings", "healthy", "mediaErrors"])) process.exit(20);
if (typeof value.smart.healthy !== "boolean" || !Number.isSafeInteger(value.smart.criticalWarnings) ||
    !Number.isSafeInteger(value.smart.mediaErrors) || value.smart.criticalWarnings < 0 ||
    value.smart.criticalWarnings > 255 || value.smart.mediaErrors < 0 || value.smart.mediaErrors > 1000000000) process.exit(31);
if (!exactKeys(value.backup, ["lastSuccessfulId"])) process.exit(21);
if (typeof value.backup.lastSuccessfulId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.backup.lastSuccessfulId)) process.exit(32);
if (!exactKeys(value.recovery, ["elapsedSeconds", "recovered", "timedOut"])) process.exit(22);
if (!Number.isSafeInteger(value.recovery.elapsedSeconds) || value.recovery.elapsedSeconds < 0 || value.recovery.elapsedSeconds > 900 ||
    typeof value.recovery.recovered !== "boolean" || typeof value.recovery.timedOut !== "boolean") process.exit(33);
if (value.recovery.recovered && value.recovery.timedOut) process.exit(35);
if (!exactKeys(value.versions, ["docker", "hostKernel", "libvirt"])) process.exit(23);
if (Object.values(value.versions).some((entry) => typeof entry !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(entry))) process.exit(24);
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
  assert_no_secret_or_runner_read
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
  assert_no_secret_or_runner_read
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
assert_no_secret_or_runner_read

echo 'power-evidence-tests-ok'
