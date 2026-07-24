#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
PATH=/usr/bin:/bin
export PATH

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash_bin=/usr/bin/bash
env_bin=/usr/bin/env
sha256_bin=/usr/bin/sha256sum
perl_bin=/usr/bin/perl
validator="$repo_root/infra/ops/validate-runtime.sh"
validator_shebang='#!/usr/bin/env bash'
validator_reviewed_sha256='ca635db9105e002c0c1a101ffa4d88ece4c146e3e84f49a2cc0b8aa1eb4e13c5'

if [[ "$(/usr/bin/uname -s 2>/dev/null || true)" != Linux ]]; then
  echo 'FAIL: authoritative runtime contract requires Linux Bubblewrap containment' >&2
  exit 1
fi

if (( EUID != 0 )); then
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    exec sudo -n "$bash_bin" "$repo_root/infra/tests/runtime-config.test.sh"
  fi

  echo "sudo bash infra/tests/runtime-config.test.sh" >&2
  exit 1
fi

tmp_base="$(cd /tmp && pwd -P)"
work="$(mktemp -d "$tmp_base/runtime-config.XXXXXX")"
work="$(cd "$work" && pwd -P)"
[[ ! -L "$work" && "$work" == "$tmp_base"/* ]] || {
  echo 'runtime config fixture escaped its verified temporary root' >&2
  exit 1
}
chmod 0700 "$work"
cleanup() {
  if [[ -d "$work" && ! -L "$work" && "$work" == "$tmp_base"/* ]]; then
    rm -rf -- "$work"
  fi
}
trap cleanup EXIT

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
  local staged_source="$1" destination="$2" interpreter="$3"
  printf '#!%s\n' "$interpreter" >"$destination"
  printf '%s\n' 'PATH=' 'readonly PATH' >>"$destination"
  tail -n +2 "$staged_source" >>"$destination"
}

make_path_sealed_copy() {
  local staged_source="$1" destination="$2" interpreter="$3" expected_shebang="$4" expected_sha256="$5"
  local expected_file="$destination.expected" candidate="$destination.candidate" actual_sha256
  verify_exact_staged_shell_source "$staged_source" "$interpreter" "$expected_shebang" "$expected_sha256" || return 1
  rm -f -- "$expected_file" "$candidate" "$destination"
  render_path_sealed_copy "$staged_source" "$expected_file" "$interpreter" || return 1
  expected_transformed_sha256="$(sha256_file "$expected_file")" || return 1
  render_path_sealed_copy "$staged_source" "$candidate" "$interpreter" || return 1
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
  stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" && fail 'accepted line-1 mutation'
  [[ ! -e "$transformed" && "$(<"$sentinel")" == unchanged ]] || fail 'line-1 mutation escaped verification'
  printf '%s\n%s\n%s\n' "$expected_shebang" "$expected_shebang" 'set -e' >"$mutated_source"
  stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" && fail 'accepted duplicate shebangs'
  printf '%s\r\n%s\r\n' "$expected_shebang" 'set -e' >"$mutated_source"
  stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" && fail 'accepted CRLF source'
  rm -f -- "$work/reviewed-source-symlink.sh"
  ln -s "$safe_source" "$work/reviewed-source-symlink.sh"
  if [[ -L "$work/reviewed-source-symlink.sh" ]]; then
    stage_and_make_path_sealed_copy "$work/reviewed-source-symlink.sh" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" && fail 'accepted symlink source'
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

readonly secrets_gid=2000
readonly secret_canary='RUNTIME_SECRET_CANARY_4f5de90a_DO_NOT_PRINT'
readonly database_canary='RUNTIME_DATABASE_CANARY_8b172e3c_DO_NOT_PRINT'
readonly digest_a='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
readonly digest_b='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
readonly digest_c='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
readonly digest_d='dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
readonly digest_e='eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
readonly digest_f='ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
readonly digest_1='1111111111111111111111111111111111111111111111111111111111111111'
readonly digest_2='2222222222222222222222222222222222222222222222222222222222222222'
readonly digest_3='3333333333333333333333333333333333333333333333333333333333333333'
readonly pilot_clamav='clamav/clamav:pilot-disabled'
readonly postgres_probe_sql="SELECT name, setting FROM pg_settings WHERE name IN ('fsync', 'synchronous_commit', 'full_page_writes');"

validator_stage="$work/validate-runtime.reviewed.stage.sh"
stage_live_source_once "$validator" "$validator_stage" ||
  fail 'could not open the runtime validator exactly once with O_NOFOLLOW'
verify_exact_staged_shell_source "$validator_stage" "$bash_bin" "$validator_shebang" "$validator_reviewed_sha256" ||
  fail 'runtime validator staged identity, shebang, regular-file, LF, syntax, or SHA is not reviewed'
assert_source_identity_mutations "$bash_bin" "$validator_shebang"
assert_source_race_mutations "$bash_bin" "$validator_shebang" || fail 'runtime validator source race defenses failed'
if source_manipulates_path "$validator_stage"; then
  fail 'runtime validator may not reference or mutate the harness-owned PATH'
fi
assert_path_mutation_defenses "$bash_bin"

trusted_stat_assignment_count="$(grep -Fxc 'readonly trusted_stat_bin="/usr/bin/stat"' "$validator_stage" || true)"
trusted_realpath_assignment_count="$(grep -Fxc 'readonly trusted_realpath_bin="/usr/bin/realpath"' "$validator_stage" || true)"
trusted_node_resolution_count="$(grep -Fxc 'resolved_node_bin="$(type -P node || true)"' "$validator_stage" || true)"
trusted_bash_syntax_count="$(grep -Fxc '  /usr/bin/bash -n "$postgres_storage_preparer" >/dev/null || {' "$validator_stage" || true)"
if [[ "$trusted_stat_assignment_count" != 1 || "$trusted_realpath_assignment_count" != 1 ||
  "$trusted_node_resolution_count" != 1 || "$trusted_bash_syntax_count" != 1 ]]; then
  echo 'FAIL: runtime validator trusted metadata-tool boundary changed unexpectedly' >&2
  exit 1
fi
unexpected_absolute_commands="$(tail -n +2 "$validator_stage" | \
  grep -E '/(usr/)?(s?bin|libexec)/[A-Za-z0-9_.+-]+' | \
  grep -Fv 'readonly trusted_stat_bin="/usr/bin/stat"' | \
  grep -Fv 'readonly trusted_realpath_bin="/usr/bin/realpath"' | \
  grep -Fv '      --entrypoint /usr/bin/getent "$POSTGRES_IMAGE" passwd postgres' | \
  grep -Fv '  /usr/bin/bash -n "$postgres_storage_preparer" >/dev/null || {' || true)"
if [[ -n "$unexpected_absolute_commands" ]]; then
  echo 'FAIL: runtime validator can bypass the isolated command root with an absolute executable' >&2
  exit 1
fi
if tail -n +2 "$validator_stage" | grep -Fv '  /usr/bin/bash -n "$postgres_storage_preparer" >/dev/null || {' | grep -Eq '\$BASH([^A-Za-z0-9_]|$)|\$\{BASH([^A-Za-z0-9_]|$)|(^|[;&|({])[[:space:]]*(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+|(^|[[:space:]])(if|then|while|until|do|else|!)[[:space:]]+(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+'; then
  echo 'FAIL: runtime validator can invoke an absolute executable or the ambient Bash interpreter outside the fake PATH' >&2
  exit 1
fi
if tail -n +2 "$validator_stage" | grep -Eq 'command[[:space:]]+-p|enable[[:space:]]+-f|hash[[:space:]]+-p|/dev/(tcp|udp)/'; then
  echo 'FAIL: runtime validator can bypass fake command lookup' >&2
  exit 1
fi
unsafe_absolute_redirects="$(tail -n +2 "$validator_stage" | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
if [[ -n "$unsafe_absolute_redirects" ]]; then
  echo 'FAIL: runtime validator redirects output to an absolute path other than /dev/null' >&2
  exit 1
fi
redirect_prefix_probe="$(printf '%s\n' 'printf unsafe >/dev/null.evil' | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
if [[ -z "$redirect_prefix_probe" ]]; then
  echo 'FAIL: runtime redirect guard accepted a /dev/null prefix sibling' >&2
  exit 1
fi
if tail -n +2 "$validator_stage" | grep -Eq '(^|[;&|()[:space:]])(env|sh|bash|dash|zsh)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])eval([;&|()[:space:]]|$)'; then
  echo 'FAIL: runtime validator can spawn an uninstrumented shell command' >&2
  exit 1
fi
runtime_source_count="$(grep -Fxc 'source "$compose_env"' "$validator_stage" || true)"
all_runtime_source_count="$(tail -n +2 "$validator_stage" | grep -Ec '(^|[;&|()[:space:]])source([;&|()[:space:]]|$)|(^|[;&|()[:space:]])\.[[:space:]]+/' || true)"
if [[ "$runtime_source_count" != 1 || "$all_runtime_source_count" != 1 ]]; then
  echo 'FAIL: runtime validator may source only the already-validated Compose environment file' >&2
  exit 1
fi
runtime_input_redirects="$(tail -n +2 "$validator_stage" | grep -E '(^|[^<])<[[:space:]]*([^<(&]|$)' || true)"
expected_runtime_input_redirects="$(printf '%s\n' \
  '  done <"$config_path"' \
  'cloudflare_credentials="$(<"$secrets_dir/cloudflare_tunnel_credentials.json")"' \
  '  tr -d '\''[:space:]'\'' <"$file" | wc -c' \
  'decoded_key_bytes="$(tr -d '\''\r\n '\'' <"$secrets_dir/credential_master_key" | base64 --decode 2>/dev/null | wc -c)" || {')"
if [[ "$runtime_input_redirects" != "$expected_runtime_input_redirects" ]]; then
  echo 'FAIL: runtime validator contains an uninstrumented input redirection outside the approved config and validated secret reads' >&2
  exit 1
fi

render_runtime_validator_copy() {
  local source="$1" destination="$2" case_root="$3"
  local canonical_stat='readonly trusted_stat_bin="/usr/bin/stat"'
  local canonical_realpath='readonly trusted_realpath_bin="/usr/bin/realpath"'
  local canonical_docker='resolved_docker_bin="$(type -P docker || true)"'
  local canonical_node='resolved_node_bin="$(type -P node || true)"'
  local canonical_bash_syntax='  /usr/bin/bash -n "$postgres_storage_preparer" >/dev/null || {'
  local line command_name
  local line_number=0

  {
    printf '#!%s\n' "$bash_bin"
    for command_name in grep mktemp rm tr wc base64; do
      printf '%s() { %q/bin/%s "$@"; }\n' "$command_name" "$case_root" "$command_name"
    done
    printf '%s\n' 'PATH=' 'readonly PATH'
    while IFS= read -r line || [[ -n "$line" ]]; do
      line_number=$((line_number + 1))
      (( line_number == 1 )) && continue
      case "$line" in
        "$canonical_stat") printf 'readonly trusted_stat_bin=%q\n' "$case_root/bin/trusted-stat" ;;
        "$canonical_realpath") printf 'readonly trusted_realpath_bin=%q\n' "$case_root/bin/trusted-realpath" ;;
        "$canonical_docker") printf 'resolved_docker_bin=%q\n' "$case_root/bin/docker" ;;
        "$canonical_node") printf 'resolved_node_bin=%q\n' "$case_root/bin/node" ;;
        "$canonical_bash_syntax") printf '  %q -n "$postgres_storage_preparer" >/dev/null || {\n' "$case_root/bin/bash" ;;
        *) printf '%s\n' "$line" ;;
      esac
    done <"$source"
  } >"$destination"
}

make_runtime_validator_copy() {
  local staged_source="$1" destination="$2" expected_sha256="$3" case_root="$4"
  local canonical_stat='readonly trusted_stat_bin="/usr/bin/stat"'
  local canonical_realpath='readonly trusted_realpath_bin="/usr/bin/realpath"'
  local canonical_docker='resolved_docker_bin="$(type -P docker || true)"'
  local canonical_node='resolved_node_bin="$(type -P node || true)"'
  local canonical_bash_syntax='  /usr/bin/bash -n "$postgres_storage_preparer" >/dev/null || {'
  local expected_file="$destination.expected" candidate="$destination.candidate"
  local line actual_sha256
  local stat_count=0 realpath_count=0 docker_count=0 node_count=0 bash_syntax_count=0

  verify_exact_staged_shell_source "$staged_source" "$bash_bin" "$validator_shebang" "$expected_sha256" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" == "$canonical_stat" ]] && stat_count=$((stat_count + 1))
    [[ "$line" == "$canonical_realpath" ]] && realpath_count=$((realpath_count + 1))
    [[ "$line" == "$canonical_docker" ]] && docker_count=$((docker_count + 1))
    [[ "$line" == "$canonical_node" ]] && node_count=$((node_count + 1))
    [[ "$line" == "$canonical_bash_syntax" ]] && bash_syntax_count=$((bash_syntax_count + 1))
  done <"$staged_source"
  (( stat_count == 1 && realpath_count == 1 && docker_count == 1 && node_count == 1 && bash_syntax_count == 1 )) || return 1

  rm -f -- "$expected_file" "$candidate" "$destination"
  render_runtime_validator_copy "$staged_source" "$expected_file" "$case_root" || return 1
  expected_transformed_sha256="$(sha256_file "$expected_file")" || return 1
  render_runtime_validator_copy "$staged_source" "$candidate" "$case_root" || return 1
  actual_sha256="$(sha256_file "$candidate")" || return 1
  [[ "$actual_sha256" == "$expected_transformed_sha256" ]] || return 1
  chmod 0500 "$candidate"
  mv -- "$candidate" "$destination"
  rm -f -- "$expected_file"
  [[ "$(grep -Fxc -- "readonly trusted_stat_bin=$case_root/bin/trusted-stat" "$destination" || true)" == 1 ]] || return 1
  [[ "$(grep -Fxc -- "readonly trusted_realpath_bin=$case_root/bin/trusted-realpath" "$destination" || true)" == 1 ]] || return 1
  [[ "$(grep -Fxc -- "resolved_docker_bin=$case_root/bin/docker" "$destination" || true)" == 1 ]] || return 1
  [[ "$(grep -Fxc -- "resolved_node_bin=$case_root/bin/node" "$destination" || true)" == 1 ]] || return 1
  [[ "$(grep -Fxc -- "  $case_root/bin/bash -n \"\$postgres_storage_preparer\" >/dev/null || {" "$destination" || true)" == 1 ]] || return 1
  ! grep -Fq -- "$canonical_stat" "$destination" || return 1
  ! grep -Fq -- "$canonical_realpath" "$destination" || return 1
  ! grep -Fq -- "$canonical_docker" "$destination" || return 1
  ! grep -Fq -- "$canonical_node" "$destination" || return 1
  ! grep -Fq -- "$canonical_bash_syntax" "$destination" || return 1
  verify_exact_staged_shell_source "$destination" "$bash_bin" "#!$bash_bin" "$expected_transformed_sha256"
}

write_runtime_site_mutation() {
  local mutation="$1" destination="$2"
  local canonical_stat='readonly trusted_stat_bin="/usr/bin/stat"'
  local canonical_realpath='readonly trusted_realpath_bin="/usr/bin/realpath"'
  local canonical_docker='resolved_docker_bin="$(type -P docker || true)"'
  local canonical_node='resolved_node_bin="$(type -P node || true)"'
  local canonical_bash_syntax='  /usr/bin/bash -n "$postgres_storage_preparer" >/dev/null || {'
  local target changed line
  case "$mutation" in
    missing-stat|duplicate-stat|changed-stat) target="$canonical_stat"; changed='readonly trusted_stat_bin="/bin/stat"' ;;
    missing-realpath|duplicate-realpath|changed-realpath) target="$canonical_realpath"; changed='readonly trusted_realpath_bin="/bin/realpath"' ;;
    missing-docker|duplicate-docker|changed-docker) target="$canonical_docker"; changed='resolved_docker_bin="$(command -v docker || true)"' ;;
    missing-node|duplicate-node|changed-node) target="$canonical_node"; changed='resolved_node_bin="$(command -v node || true)"' ;;
    missing-bash-syntax|duplicate-bash-syntax|changed-bash-syntax) target="$canonical_bash_syntax"; changed='  bash -n "$postgres_storage_preparer" >/dev/null || {' ;;
    *) return 1 ;;
  esac
  : >"$destination"
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$target" ]]; then
      case "$mutation" in
        missing-*) continue ;;
        duplicate-*) printf '%s\n%s\n' "$line" "$line" >>"$destination"; continue ;;
        changed-*) printf '%s\n' "$changed" >>"$destination"; continue ;;
      esac
    fi
    printf '%s\n' "$line" >>"$destination"
  done <"$validator_stage"
}

assert_runtime_site_mutations() {
  local mutation mutated="$work/runtime-site-mutated.sh" staged="$work/runtime-site-mutated.stage.sh"
  local transformed="$work/runtime-site-transformed.sh"
  local sentinel="$work/runtime-site.sentinel" mutation_sha256
  printf '%s' unchanged >"$sentinel"
  for mutation in missing-stat duplicate-stat changed-stat missing-realpath duplicate-realpath changed-realpath \
    missing-docker duplicate-docker changed-docker missing-node duplicate-node changed-node \
    missing-bash-syntax duplicate-bash-syntax changed-bash-syntax; do
    write_runtime_site_mutation "$mutation" "$mutated"
    mutation_sha256="$(sha256_file "$mutated")" || fail "could not hash runtime $mutation site mutation"
    rm -f -- "$staged" "$transformed"
    stage_live_source_once "$mutated" "$staged" || fail "could not stage runtime $mutation site mutation"
    make_runtime_validator_copy "$staged" "$transformed" "$mutation_sha256" "$work/runtime-site-root" &&
      fail "runtime transformer accepted $mutation command-site mutation"
    [[ ! -e "$transformed" && "$(<"$sentinel")" == unchanged ]] || fail "$mutation runtime site mutation escaped transformation"
  done
}

assert_runtime_site_mutations

case_number=0
case_dir=
config=
secrets=
fake_stat_target=
fake_runner_url=
fake_runner_client_url=
fake_runner_client_subnet=
fake_runner_gateway_source=
fake_runner_subnet=
fake_runner_bridge=
fake_app_image=
fake_long_restart=
fake_cloudflared_restart=
fake_oneshot_restart=
ambient_postgres_image=
ambient_postgres_uid=
ambient_postgres_gid=
fake_postgres_config_user=
fake_postgres_passwd_entry=
fake_postgres_fsync=
fake_postgres_sync_commit=
fake_postgres_full_page_writes=
fake_node_object_check_status=
fake_bash_preparer_check_status=
fake_host_port=false
fake_live_fsync=
fake_live_sync_commit=
fake_live_full_page_writes=
fake_docker_log=
fake_mutate_service=
fake_mutate_field=
fake_mutate_value=
validator_under_test=
case_repo=
runtime_config_stage=
runtime_config_sha256=
runtime_config_invocation=0

make_fixture() {
  local label="$1"
  case_number=$((case_number + 1))
  case_dir="$work/$case_number-$label"
  config="$case_dir/compose.env"
  secrets="$case_dir/secrets"
  fake_stat_target=
  fake_runner_url='http://192.168.122.12:4100'
  fake_runner_client_url='http://runner-egress-gateway:4100'
  fake_runner_client_subnet='172.29.41.0/24'
  fake_runner_client_internal='true'
  fake_runner_gateway_source='172.29.40.2'
  fake_runner_subnet='172.29.40.0/24'
  fake_runner_bridge='cdst-run0'
  fake_app_image="registry.example.test/codestead/runtime@sha256:$digest_a"
  fake_long_restart='unless-stopped'
  fake_cloudflared_restart='on-failure:5'
  fake_oneshot_restart='no'
  ambient_postgres_image="postgres:17-bookworm@sha256:$digest_2"
  ambient_postgres_uid=999
  ambient_postgres_gid=999
  fake_postgres_config_user='postgres'
  fake_postgres_passwd_entry='postgres:x:999:999:PostgreSQL:/var/lib/postgresql:/bin/sh'
  fake_postgres_fsync='on'
  fake_postgres_sync_commit='on'
  fake_postgres_full_page_writes='on'
  fake_node_object_check_status=0
  fake_bash_preparer_check_status=0
  fake_host_port=false
  fake_live_fsync='on'
  fake_live_sync_commit='on'
  fake_live_full_page_writes='on'
  fake_docker_log="$case_dir/docker.log"
  fake_mutate_service=
  fake_mutate_field=
  fake_mutate_value=
  validator_under_test="$case_dir/validate-runtime.sh"
  case_repo="$case_dir/repo"

  mkdir -p \
    "$case_dir/bin" \
    "$case_repo/infra/ops" \
    "$secrets" \
    "$case_dir/data/postgres" \
    "$case_dir/data/next-cache" \
    "$case_dir/data/app-data" \
    "$case_dir/data/uploads" \
    "$case_dir/data/clamav"
  printf '%s\n' 'export {};' >"$case_repo/infra/ops/prepare-object-storage.mjs"
  cat >"$case_repo/infra/ops/prepare-postgres-control-socket.sh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
EOF
  printf '%s\n' 'export {};' >"$case_repo/infra/ops/validate-database-secrets.mjs"
  chown 0:0 \
    "$case_repo" \
    "$case_repo/infra" \
    "$case_repo/infra/ops" \
    "$case_repo/infra/ops/prepare-object-storage.mjs" \
    "$case_repo/infra/ops/prepare-postgres-control-socket.sh" \
    "$case_repo/infra/ops/validate-database-secrets.mjs"
  chmod 0700 "$case_repo" "$case_repo/infra" "$case_repo/infra/ops"
  chmod 0644 "$case_repo/infra/ops/prepare-object-storage.mjs" "$case_repo/infra/ops/validate-database-secrets.mjs"
  chmod 0755 "$case_repo/infra/ops/prepare-postgres-control-socket.sh"

  printf '%s\n' 'services: {}' >"$case_repo/compose.yaml"
  chmod 0400 "$case_repo/compose.yaml"

  printf '#!%s\n' "$bash_bin" >"$case_dir/bin/docker"
  cat >>"$case_dir/bin/docker" <<'EOF'
set -Eeuo pipefail

{
  printf 'docker'
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$FAKE_DOCKER_LOG"

if [[ "$#" == 2 && "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  exit 0
fi

if [[ "$#" == 1 && "${1:-}" == "info" ]]; then
  exit 0
fi

if [[ "$#" == 5 && "$1" == image && "$2" == inspect && "$3" == --format && \
  "$4" == '{{.Config.User}}' && "$5" == "$FAKE_POSTGRES_IMAGE" ]]; then
  printf '%s\n' "$FAKE_POSTGRES_CONFIG_USER"
  exit 0
fi

if [[ "$#" == 16 && "$1" == run && "$2" == --rm && "$3" == --pull && "$4" == never && \
  "$5" == --network && "$6" == none && "$7" == --read-only && "$8" == --cap-drop && \
  "$9" == ALL && "${10}" == --security-opt && "${11}" == no-new-privileges && \
  "${12}" == --entrypoint && "${13}" == /usr/bin/getent && "${14}" == "$FAKE_POSTGRES_IMAGE" && \
  "${15}" == passwd && "${16}" == postgres ]]; then
  printf '%s\n' "$FAKE_POSTGRES_PASSWD_ENTRY"
  exit 0
fi

if [[ "$#" == 19 && "$1" == compose && "$2" == --env-file && "$3" == "$FAKE_EXPECTED_COMPOSE_ENV" && \
  "$4" == -f && "$5" == "$FAKE_EXPECTED_COMPOSE_FILE" && "$6" == exec && "$7" == -T && \
  "$8" == postgres && "$9" == psql && "${10}" == --host=/run/learncoding-postgres && \
  "${11}" == --username=learncoding && "${12}" == --dbname=learncoding && \
  "${13}" == --no-psqlrc && "${14}" == --quiet && "${15}" == --no-align && \
  "${16}" == --tuples-only && "${17}" == '--field-separator=|' && \
  "${18}" == --command && "${19}" == "$FAKE_EXPECTED_POSTGRES_SQL" ]]; then
  printf '%s|%s\n' \
    fsync "$FAKE_LIVE_FSYNC" \
    synchronous_commit "$FAKE_LIVE_SYNC_COMMIT" \
    full_page_writes "$FAKE_LIVE_FULL_PAGE_WRITES"
  exit 0
fi

value_for() {
  local service="$1"
  local field="$2"
  local default="$3"
  if [[ "$FAKE_MUTATE_SERVICE" == "$service" && "$FAKE_MUTATE_FIELD" == "$field" ]]; then
    printf '%s' "$FAKE_MUTATE_VALUE"
  else
    printf '%s' "$default"
  fi
}

emit_host_port() {
  local service="$1"
  if [[ "$FAKE_HOST_PORT" == true && "$service" == app ]] ||
    [[ "$FAKE_MUTATE_SERVICE" == "$service" && "$FAKE_MUTATE_FIELD" == host-port ]]; then
    printf '%s\n' '    ports:' '      - 127.0.0.1:3000:3000'
  fi
}

if [[ "${1:-}" == "compose" ]]; then
  operations_profile=false
  if [[ "$#" == 6 && "${2:-}" == --env-file && "${3:-}" == "$FAKE_EXPECTED_COMPOSE_ENV" &&
    "${4:-}" == -f && "${5:-}" == "$FAKE_EXPECTED_COMPOSE_FILE" && "${6:-}" == config ]]; then
    :
  elif [[ "$#" == 8 && "${2:-}" == --env-file && "${3:-}" == "$FAKE_EXPECTED_COMPOSE_ENV" &&
    "${4:-}" == -f && "${5:-}" == "$FAKE_EXPECTED_COMPOSE_FILE" &&
    "${6:-}" == --profile && "${7:-}" == operations && "${8:-}" == config ]]; then
    operations_profile=true
  else
    exit 64
  fi
  postgres_image="$(value_for postgres image 'registry.example.test/postgres@sha256:2222222222222222222222222222222222222222222222222222222222222222')"
  postgres_restart="$(value_for postgres restart unless-stopped)"
  postgres_stop="$(value_for postgres stop-grace 2m)"
  printf '%s\n' 'services:' '  postgres:' \
    "    image: $postgres_image" \
    "    restart: $postgres_restart" \
    "    stop_grace_period: $postgres_stop" \
    '    environment:' \
    '      POSTGRES_INITDB_ARGS: --data-checksums' \
    '    command:' \
    '      - postgres' \
    '      - -c' \
    "      - fsync=$FAKE_POSTGRES_FSYNC" \
    '      - -c' \
    "      - synchronous_commit=$FAKE_POSTGRES_SYNC_COMMIT" \
    '      - -c' \
    "      - full_page_writes=$FAKE_POSTGRES_FULL_PAGE_WRITES"
  emit_host_port postgres
  app_image="$(value_for app image "$FAKE_APP_IMAGE")"
  app_restart="$(value_for app restart "$FAKE_LONG_RESTART")"
  app_stop="$(value_for app stop-grace 1m)"
  printf '%s\n' '  app:' \
    "    image: $app_image" \
    "    restart: $app_restart" \
    "    stop_grace_period: $app_stop" \
    '    environment:' \
    "      RUNNER_BASE_URL: $FAKE_RUNNER_CLIENT_URL" \
    '    networks:' \
    '      - data' \
    '      - frontend' \
    '      - runner-client'
  emit_host_port app
  for service in mail-worker reward-worker regrade-worker exam-finalization-worker \
    practice-runner-recovery-worker project-review-correction-worker file-erasure-worker scan-worker; do
    service_image="$(value_for "$service" image 'registry.example.test/worker@sha256:3333333333333333333333333333333333333333333333333333333333333333')"
    service_restart="$(value_for "$service" restart unless-stopped)"
    service_stop="$(value_for "$service" stop-grace 1m)"
    printf '%s\n' \
      "  $service:" \
      "    image: $service_image" \
      "    restart: $service_restart" \
      "    stop_grace_period: $service_stop"
    emit_host_port "$service"
    case "$service" in
      regrade-worker|exam-finalization-worker|practice-runner-recovery-worker)
        printf '%s\n' \
          '    environment:' \
          "      RUNNER_BASE_URL: $FAKE_RUNNER_CLIENT_URL" \
          '    networks:' \
          '      - data' \
          '      - runner-client'
        ;;
    esac
  done
  cloudflared_image="$(value_for cloudflared image 'registry.example.test/cloudflared@sha256:3333333333333333333333333333333333333333333333333333333333333333')"
  cloudflared_restart="$(value_for cloudflared restart "$FAKE_CLOUDFLARED_RESTART")"
  cloudflared_stop="$(value_for cloudflared stop-grace 30s)"
  printf '%s\n' \
    '  cloudflared:' \
    "    image: $cloudflared_image" \
    "    restart: $cloudflared_restart" \
    "    stop_grace_period: $cloudflared_stop" \
    '    secrets:' \
    '      - source: cloudflare_tunnel_credentials' \
    '        target: cloudflare_tunnel_credentials'
  emit_host_port cloudflared
  if [[ "$operations_profile" == true ]]; then
    for service in database-role-bootstrap database-negative-probes database-boundary-verifier \
      migrate lifecycle platform-seed admin-bootstrap; do
      service_image="$(value_for "$service" image 'registry.example.test/operations@sha256:1111111111111111111111111111111111111111111111111111111111111111')"
      service_restart="$(value_for "$service" restart "$FAKE_ONESHOT_RESTART")"
      printf '%s\n' \
        "  $service:" \
        '    profiles:' \
        '      - operations' \
        "    image: $service_image" \
        "    restart: $service_restart"
      emit_host_port "$service"
    done
  fi
  gateway_image="$(value_for runner-egress-gateway image "$FAKE_APP_IMAGE")"
  gateway_restart="$(value_for runner-egress-gateway restart unless-stopped)"
  gateway_stop="$(value_for runner-egress-gateway stop-grace 15s)"
  printf '%s\n' \
    '  runner-egress-gateway:' \
    "    image: $gateway_image" \
    "    restart: $gateway_restart" \
    "    stop_grace_period: $gateway_stop" \
    '    environment:' \
    "      RUNNER_GATEWAY_UPSTREAM: $FAKE_RUNNER_URL" \
    '    networks:' \
    '      runner-client:' \
    '        ipv4_address: 172.29.41.2' \
    '        interface_name: runner-client' \
    '      runner-egress:' \
    '        gw_priority: 100' \
    '        interface_name: runner-egress' \
    "        ipv4_address: $FAKE_RUNNER_GATEWAY_SOURCE"
  emit_host_port runner-egress-gateway
  printf '%s\n' \
    'networks:' \
    '  runner-client:' \
    '    driver: bridge' \
    "    internal: $FAKE_RUNNER_CLIENT_INTERNAL" \
    '    ipam:' \
    '      config:' \
    "        - subnet: $FAKE_RUNNER_CLIENT_SUBNET" \
    '  runner-egress:' \
    '    driver: bridge' \
    '    driver_opts:' \
    "      com.docker.network.bridge.name: $FAKE_RUNNER_BRIDGE" \
    '    ipam:' \
    '      config:' \
    "        - subnet: $FAKE_RUNNER_SUBNET"
  exit 0
fi

exit 64
EOF
  chmod 0555 "$case_dir/bin/docker"
  printf '#!%s\n' "$bash_bin" >"$case_dir/bin/timeout"
  cat >>"$case_dir/bin/timeout" <<'EOF'
set -Eeuo pipefail
{
  printf 'timeout'
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$FAKE_DOCKER_LOG"
[[ "$#" == 21 && "${1:-}" == 30s ]] || exit 64
shift
[[ "${1:-}" == "$FAKE_DOCKER_BINARY" ]] || exit 64
shift
exec "$FAKE_DOCKER_BINARY" "$@"
EOF
  chmod 0555 "$case_dir/bin/timeout"
  printf '#!%s\n' "$bash_bin" >"$case_dir/bin/node"
  cat >>"$case_dir/bin/node" <<'EOF'
set -Eeuo pipefail
{
  printf 'node'
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$FAKE_DOCKER_LOG"
if [[ "$#" == 2 && "$1" == --check && "$2" == "$FAKE_EXPECTED_OBJECT_PREPARER" ]]; then
  exit "$FAKE_NODE_OBJECT_CHECK_STATUS"
fi
if [[ "$#" == 9 && "$1" == "$FAKE_EXPECTED_DATABASE_VALIDATOR" && \
  "$2" == learncoding && "$3" == learncoding && \
  "$4" == "$FAKE_EXPECTED_SECRETS_DIR/postgres_password" && \
  "$5" == "$FAKE_EXPECTED_SECRETS_DIR/database_bootstrap_url" && \
  "$6" == "$FAKE_EXPECTED_SECRETS_DIR/database_url" && \
  "$7" == "$FAKE_EXPECTED_SECRETS_DIR/database_migrator_url" && \
  "$8" == "$FAKE_EXPECTED_SECRETS_DIR/database_worker_url" && \
  "$9" == "$FAKE_EXPECTED_SECRETS_DIR/database_ops_url" ]]; then
  printf '%s\n' 'database secret topology valid'
  exit 0
fi
exit 64
EOF
  printf '#!%s\n' "$bash_bin" >"$case_dir/bin/bash"
  cat >>"$case_dir/bin/bash" <<'EOF'
set -Eeuo pipefail
{
  printf 'bash'
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$FAKE_DOCKER_LOG"
[[ "$#" == 2 && "$1" == -n && "$2" == "$FAKE_EXPECTED_POSTGRES_PREPARER" ]] || exit 64
exit "$FAKE_BASH_PREPARER_CHECK_STATUS"
EOF
  chmod 0555 "$case_dir/bin/node" "$case_dir/bin/bash"
  mkdir -m 0700 "$case_dir/tmp"
  printf '#!%s\n' "$bash_bin" >"$case_dir/bin/fake-safe-command"
  cat >>"$case_dir/bin/fake-safe-command" <<'EOF'
set -Eeuo pipefail

command_name="${0##*/}"
has_fixture_prefix() {
  local candidate="$1"
  [[ "$candidate" == "$FAKE_CASE_ROOT" || "$candidate" == "$FAKE_CASE_ROOT"/* ]]
}
contained_fixture_path() {
  local candidate="$1"
  local relative
  local cursor="$FAKE_CASE_ROOT"
  local component
  local resolved
  local -a components=()
  has_fixture_prefix "$candidate" || return 1
  relative="${candidate#"$FAKE_CASE_ROOT"}"
  relative="${relative#/}"
  [[ "/$relative/" != *'/../'* && "/$relative/" != *'/./'* && "$relative" != *'//'* ]] || return 1
  [[ ! -L "$cursor" ]] || return 1
  [[ -n "$relative" ]] || return 0
  IFS='/' read -r -a components <<<"$relative"
  for component in "${components[@]}"; do
    [[ -n "$component" && "$component" != . && "$component" != .. ]] || return 1
    cursor="$cursor/$component"
    if [[ -L "$cursor" ]]; then
      resolved="$(/usr/bin/realpath --canonicalize-missing -- "$cursor")" || return 1
      has_fixture_prefix "$resolved" || return 1
    fi
  done
}
safe_fixture_path() {
  local candidate="$1"
  local relative
  local cursor="$FAKE_CASE_ROOT"
  local component
  local -a components=()
  contained_fixture_path "$candidate" || return 1
  relative="${candidate#"$FAKE_CASE_ROOT"}"
  relative="${relative#/}"
  [[ -n "$relative" ]] || return 0
  IFS='/' read -r -a components <<<"$relative"
  for component in "${components[@]}"; do
    cursor="$cursor/$component"
    [[ ! -L "$cursor" ]] || return 1
  done
}
realpath_input_is_contained() {
  local candidate="$1"
  local resolved
  has_fixture_prefix "$candidate" || return 1
  resolved="$(/usr/bin/realpath --canonicalize-missing -- "$candidate")" || return 1
  has_fixture_prefix "$resolved"
}

case "$command_name" in
  trusted-stat)
    [[ "$#" == 4 && "$1" == -c && "$3" == -- && ( "$2" == '%u:%g:%a' || "$2" == '%u:%g:%a:%h' || "$2" == '%a' || "$2" == '%u' ) ]] || exit 64
    safe_fixture_path "$4" || exit 97
    stat_output="$(/usr/bin/stat -c "$2" -- "$4")" || exit 97
    if [[ "$2" == '%u:%g:%a' || "$2" == '%u:%g:%a:%h' ]]; then
      IFS=: read -r stat_uid stat_gid stat_mode stat_links <<<"$stat_output"
      if [[ "$stat_gid" == "$RUNTIME_NAMESPACE_OVERFLOW_GID" ]]; then
        stat_gid="$FAKE_EXPECTED_SECRET_GID"
      fi
      if [[ "$2" == '%u:%g:%a:%h' ]]; then
        printf '%s:%s:%s:%s\n' "$stat_uid" "$stat_gid" "$stat_mode" "$stat_links"
      else
        printf '%s:%s:%s\n' "$stat_uid" "$stat_gid" "$stat_mode"
      fi
    else
      printf '%s\n' "$stat_output"
    fi
    ;;
  trusted-realpath)
    [[ "$#" == 4 && ( "$1" == --canonicalize-missing || "$1" == --canonicalize-existing ) && "$2" == --no-symlinks && "$3" == -- ]] || exit 64
    realpath_input_is_contained "$4" || exit 97
    resolved="$(/usr/bin/realpath "$1" --no-symlinks -- "$4")" || exit 97
    has_fixture_prefix "$resolved" || exit 97
    printf '%s\n' "$resolved"
    ;;
  grep)
    [[ "$#" == 3 && "$1" == -Eq ]] || exit 64
    safe_fixture_path "$3" || exit 97
    exec /usr/bin/grep -Eq -- "$2" "$3"
    ;;
  mktemp)
    [[ "$#" == 0 ]] || exit 64
    exec /usr/bin/mktemp "$FAKE_TMPDIR/runtime-render.XXXXXX"
    ;;
  rm)
    [[ "$#" == 3 && "$1" == -f && "$2" == -- ]] || exit 64
    safe_fixture_path "$3" || exit 97
    exec /usr/bin/rm -f -- "$3"
    ;;
  tr)
    [[ "$#" == 2 && "$1" == -d && ( "$2" == '[:space:]' || "$2" == $'\r\n ' ) ]] || exit 64
    exec /usr/bin/tr -d "$2"
    ;;
  wc)
    [[ "$#" == 1 && "$1" == -c ]] || exit 64
    exec /usr/bin/wc -c
    ;;
  base64)
    [[ "$#" == 1 && "$1" == --decode ]] || exit 64
    exec /usr/bin/base64 --decode
    ;;
  *) exit 64 ;;
esac
EOF
  chmod 0555 "$case_dir/bin/fake-safe-command"
  for command_name in trusted-stat trusted-realpath grep mktemp rm tr wc base64; do
    cp "$case_dir/bin/fake-safe-command" "$case_dir/bin/$command_name"
  done
  chmod 0555 "$case_dir/bin"/*
  fake_docker_sha256="$(sha256_file "$case_dir/bin/docker")" || fail 'could not hash strict fake Docker command'
  fake_timeout_sha256="$(sha256_file "$case_dir/bin/timeout")" || fail 'could not hash strict fake timeout command'
  fake_node_sha256="$(sha256_file "$case_dir/bin/node")" || fail 'could not hash strict fake Node command'
  fake_bash_sha256="$(sha256_file "$case_dir/bin/bash")" || fail 'could not hash strict fake Bash command'
  fake_safe_sha256="$(sha256_file "$case_dir/bin/fake-safe-command")" || fail 'could not hash strict safe-command wrapper'
  verify_exact_staged_shell_source "$case_dir/bin/docker" "$bash_bin" "#!$bash_bin" "$fake_docker_sha256" || fail 'fake Docker identity is not verified'
  verify_exact_staged_shell_source "$case_dir/bin/timeout" "$bash_bin" "#!$bash_bin" "$fake_timeout_sha256" || fail 'fake timeout identity is not verified'
  verify_exact_staged_shell_source "$case_dir/bin/node" "$bash_bin" "#!$bash_bin" "$fake_node_sha256" || fail 'fake Node identity is not verified'
  verify_exact_staged_shell_source "$case_dir/bin/bash" "$bash_bin" "#!$bash_bin" "$fake_bash_sha256" || fail 'fake Bash identity is not verified'
  for command_name in trusted-stat trusted-realpath grep mktemp rm tr wc base64; do
    verify_exact_staged_shell_source "$case_dir/bin/$command_name" "$bash_bin" "#!$bash_bin" "$fake_safe_sha256" ||
      fail "runtime safe command identity is not verified: $command_name"
  done

  make_runtime_validator_copy "$validator_stage" "$validator_under_test" "$validator_reviewed_sha256" "$case_dir" ||
    fail 'could not create exact reviewed runtime validator transformation'
  grep -Fxq 'PATH=' "$validator_under_test" && grep -Fxq 'readonly PATH' "$validator_under_test" || {
    echo 'FAIL: runtime validator test copy did not seal PATH before the SUT body' >&2
    exit 1
  }
  grep -Fxq "readonly trusted_stat_bin=$case_dir/bin/trusted-stat" "$validator_under_test" || {
    echo 'FAIL: runtime test did not instrument trusted stat' >&2
    exit 1
  }
  grep -Fxq "readonly trusted_realpath_bin=$case_dir/bin/trusted-realpath" "$validator_under_test" || {
    echo 'FAIL: runtime test did not instrument trusted realpath' >&2
    exit 1
  }
  grep -Fxq "resolved_docker_bin=$case_dir/bin/docker" "$validator_under_test" || fail 'runtime test did not instrument exact Docker resolution site'
  grep -Fxq "resolved_node_bin=$case_dir/bin/node" "$validator_under_test" || fail 'runtime test did not instrument exact Node resolution site'
  grep -Fxq "  $case_dir/bin/bash -n \"\$postgres_storage_preparer\" >/dev/null || {" "$validator_under_test" || \
    fail 'runtime test did not instrument exact Bash syntax-check site'
  validator_under_test_sha256="$(sha256_file "$validator_under_test")" || fail 'could not hash transformed runtime validator'
  verify_exact_staged_shell_source "$validator_under_test" "$bash_bin" "#!$bash_bin" "$validator_under_test_sha256" ||
    fail 'transformed runtime validator identity is not verified'
  : >"$fake_docker_log"

  cat >"$case_dir/cloudflare.yml" <<'EOF'
tunnel: 11111111-1111-4111-8111-111111111111
credentials-file: /run/secrets/cloudflare_tunnel_credentials
ingress:
  - hostname: pilot.example.test
    service: http://app:3000
  - service: http_status:404
EOF
  chown 0:0 "$case_dir/cloudflare.yml"
  chmod 0640 "$case_dir/cloudflare.yml"

  cat >"$config" <<EOF
APP_URL=https://pilot.example.test
SOURCE_CODE_URL=https://code.example.test/learncoding
APP_RUNTIME_IMAGE=registry.example.test/codestead/runtime@sha256:$digest_a
APP_TOOLING_IMAGE=registry.example.test/codestead/tooling@sha256:$digest_b
APP_WORKER_IMAGE=registry.example.test/codestead/worker@sha256:$digest_c
APP_REGRADE_WORKER_IMAGE=registry.example.test/codestead/regrade-worker@sha256:$digest_d
APP_PROJECT_REVIEW_WORKER_IMAGE=registry.example.test/codestead/project-review-worker@sha256:$digest_e
APP_SCANNER_WORKER_IMAGE=registry.example.test/codestead/scanner-worker@sha256:$digest_f
APP_OPERATIONS_IMAGE=registry.example.test/codestead/operations@sha256:$digest_1
DEPLOY_PLATFORM=linux/amd64
UPLOADS_ENABLED=false
COMPOSE_PROFILES=
SECRETS_GID=$secrets_gid
POSTGRES_IMAGE=postgres:17-bookworm@sha256:$digest_2
POSTGRES_UID=999
POSTGRES_GID=999
CLOUDFLARED_IMAGE=cloudflare/cloudflared:2026.1.0@sha256:$digest_3
CLAMAV_IMAGE=$pilot_clamav
REQUIRE_BOOTSTRAP_ADMIN_SECRET=false
MAIL_ADAPTER=console
MAIL_FROM=
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
GOOGLE_CLIENT_ID=
SECRETS_DIR=$secrets
CLOUDFLARE_CONFIG_FILE=$case_dir/cloudflare.yml
LEARN_DATA_ROOT=$case_dir/data
VALIDATION_MODE=pilot
RUNNER_BASE_URL=http://192.168.122.12:4100
EOF
  chown 0:0 "$config"
  chmod 0640 "$config"

  printf '%s' "postgres-$secret_canary" >"$secrets/postgres_password"
  printf '%s' "postgresql://learncoding:postgres-$secret_canary@postgres/learncoding" >"$secrets/database_bootstrap_url"
  printf '%s' "postgresql://learncoding_app:app-$database_canary@postgres/learncoding" >"$secrets/database_url"
  printf '%s' "postgresql://learncoding_migrator:migrator-$database_canary@postgres/learncoding" >"$secrets/database_migrator_url"
  printf '%s' "postgresql://learncoding_worker:worker-$database_canary@postgres/learncoding" >"$secrets/database_worker_url"
  printf '%s' "postgresql://learncoding_ops:ops-$database_canary@postgres/learncoding" >"$secrets/database_ops_url"
  printf '%s' 'better-auth-secret-at-least-thirty-two-bytes' >"$secrets/better_auth_secret"
  printf '%s' 'lost-device-proof-key-at-least-thirty-two-bytes' >"$secrets/lost_device_proof_key"
  printf '%s' 'deletion-tombstone-key-at-least-thirty-two-bytes' >"$secrets/deletion_tombstone_key"
  printf '%s' 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=' >"$secrets/credential_master_key"
  printf '%s' 'runner-shared-secret-at-least-thirty-two-bytes' >"$secrets/runner_shared_secret"
  printf '%s' '{"AccountTag":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","TunnelSecret":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=","TunnelID":"11111111-1111-4111-8111-111111111111"}' >"$secrets/cloudflare_tunnel_credentials.json"
  : >"$secrets/google_client_secret"
  : >"$secrets/gmail_client_id"
  : >"$secrets/gmail_client_secret"
  : >"$secrets/gmail_refresh_token"

  chown 0:"$secrets_gid" "$secrets"
  chmod 0750 "$secrets"
  chown 0:"$secrets_gid" "$secrets"/*
  chmod 0440 "$secrets"/*
  prepare_runtime_containment
}

set_config() {
  local key="$1"
  local value="$2"
  sed -i "s|^${key}=.*$|${key}=${value}|" "$config"
  chown 0:0 "$config"
  chmod 0640 "$config"
}

add_bootstrap_secret() {
  local value='temporary-admin-password-123'
  (( $# == 0 )) || value="$1"
  printf '%s' "$value" >"$secrets/bootstrap_admin_password"
  chown 0:"$secrets_gid" "$secrets/bootstrap_admin_password"
  chmod 0440 "$secrets/bootstrap_admin_password"
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
    candidate=()
    for token in "${resource_limit_args[@]}"; do
      [[ "$token" == "$target" ]] || candidate+=("$token")
    done
    ! assert_exact_resource_limits "${candidate[@]}" || fail "resource mutation gate accepted $missing_label"
    candidate=()
    for token in "${resource_limit_args[@]}"; do
      [[ "$token" == "$target" ]] && candidate+=("$weakened") || candidate+=("$token")
    done
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
    if [[ -z "${seen[$binary]:-}" ]]; then
      minimal_runtime_mounts+=(--ro-bind "$binary" "$binary")
      seen["$binary"]=1
    fi
    ldd_output="$(/usr/bin/ldd -- "$binary")" || return 1
    [[ "$ldd_output" != *'not found'* ]] || return 1
    while IFS= read -r line; do
      read -r first second third _ <<<"$line"
      dependency=
      if [[ "${first:-}" == /* ]]; then
        dependency="$first"
      elif [[ "${second:-}" == '=>' && "${third:-}" == /* ]]; then
        dependency="$third"
      fi
      [[ -n "$dependency" ]] || continue
      verify_minimal_runtime_file "$dependency" || return 1
      if [[ -z "${seen[$dependency]:-}" ]]; then
        minimal_runtime_mounts+=(--ro-bind "$dependency" "$dependency")
        seen["$dependency"]=1
      fi
    done <<<"$ldd_output"
  done
}

assert_containment_gate_mutations() {
  local sentinel="$work/containment-gate.sentinel" rejected="$work/rejected-bwrap"
  local containment_candidate="$work/containment-candidate" status
  printf '%s' unchanged >"$sentinel"
  printf '#!%s\n%s\n' "$bash_bin" 'exit 77' >"$rejected"
  printf '#!%s\nprintf reached >%q\n' "$bash_bin" "$sentinel" >"$containment_candidate"
  chmod 0700 "$rejected" "$containment_candidate"
  verify_fixed_outer_binary "$work/missing-bwrap" true && fail 'missing Bubblewrap dependency was accepted'
  set +e
  "$env_bin" -i PATH= "$rejected" --unshare-user --unshare-pid --unshare-net -- "$containment_candidate" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" == 77 && "$(<"$sentinel")" == unchanged ]] || fail 'rejected containment reached runtime SUT sentinel'
}

prepare_runtime_containment() {
  local entry="$case_dir/namespace-entry.sh"
  local outside="/tmp/learncoding-runtime-outside-$$-$case_number" binary probe_status preflight_ro_probes
  local token
  local -a preflight_containment=()
  [[ "$(/usr/bin/uname -s 2>/dev/null || true)" == Linux ]] ||
    fail 'authoritative runtime contract requires Linux Bubblewrap user/mount/PID/network containment'
  for binary in /usr/bin/stat /usr/bin/uname /usr/bin/bash /usr/bin/env /usr/bin/sha256sum \
    /usr/bin/timeout /usr/bin/prlimit /usr/bin/setpriv /usr/bin/ldd /usr/bin/readlink; do
    verify_fixed_outer_binary "$binary" false || fail "containment dependency is not fixed root-owned and non-writable: $binary"
  done
  verify_fixed_outer_binary /usr/bin/bwrap true ||
    fail '/usr/bin/bwrap must be a regular root-owned non-writable authoritative test dependency'
  containment_probe_dir="$case_dir/containment-output-probe"
  mkdir -m 0700 "$containment_probe_dir"
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
    remainder="${line#"$label"}"
    read -r soft hard units <<<"$remainder"
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
  if (( repo_fixture_mounted == 1 )) && { [[ "$containment_repo" == "$protected_root" ]] || [[ "$containment_repo" == "$protected_root"/* ]]; }; then
    continue
  fi
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
  elif { printf x >>"$protected_path"; } 2>/dev/null; then
    exit 97
  fi
done
: >"$containment_probe_dir/.namespace-write-probe"
if [[ "${CONTAINMENT_EXPECT_REGULAR_OUTPUTS:-0}" == 1 ]]; then
  [[ -f /proc/self/fd/1 && -f /proc/self/fd/2 ]] || exit 98
fi
IFS= read -r RUNTIME_NAMESPACE_OVERFLOW_GID </proc/sys/kernel/overflowgid
[[ "$RUNTIME_NAMESPACE_OVERFLOW_GID" =~ ^[0-9]+$ ]] || exit 96
export RUNTIME_NAMESPACE_OVERFLOW_GID
if [[ -n "${RUNTIME_CONFIG_VERIFY_PATH:-}" || -n "${RUNTIME_CONFIG_VERIFY_SHA256:-}" ]]; then
  [[ -f "$RUNTIME_CONFIG_VERIFY_PATH" && ! -L "$RUNTIME_CONFIG_VERIFY_PATH" && "$RUNTIME_CONFIG_VERIFY_SHA256" =~ ^[0-9a-f]{64}$ ]] || exit 96
  digest_line="$(/usr/bin/sha256sum -- "$RUNTIME_CONFIG_VERIFY_PATH")" || exit 96
  [[ "${digest_line%% *}" == "$RUNTIME_CONFIG_VERIFY_SHA256" ]] || exit 96
  unset RUNTIME_CONFIG_VERIFY_PATH RUNTIME_CONFIG_VERIFY_SHA256
fi
exec "$@"
EOF
  } >"$entry"
  chmod 0500 "$entry"
  containment_entry="$entry"
  containment_entry_sha256="$(sha256_file "$entry")" || fail 'could not hash namespace entry'
  verify_exact_staged_shell_source "$entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" || fail 'namespace entry identity is not verified'
  prepare_minimal_runtime_mounts /usr/bin/bash /usr/bin/stat /usr/bin/realpath /usr/bin/grep \
    /usr/bin/mktemp /usr/bin/rm /usr/bin/tr /usr/bin/wc /usr/bin/base64 /usr/bin/sha256sum ||
    fail 'could not assemble the minimal runtime-validator filesystem'
  containment_ro_mounts=(
    --ro-bind "$entry" "$entry"
    --ro-bind "$validator_under_test" "$validator_under_test"
    --ro-bind "$case_dir/bin" "$case_dir/bin"
    --ro-bind "$config" "$config"
    --ro-bind "$case_dir/cloudflare.yml" "$case_dir/cloudflare.yml"
    --ro-bind "$case_dir/data" "$case_dir/data"
    --ro-bind "$case_repo/compose.yaml" "$case_repo/compose.yaml"
    --ro-bind "$case_repo/infra" "$case_repo/infra"
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
    "${containment_ro_mounts[@]}"
    "${containment_rw_mounts[@]}"
    --proc /proc --dev /dev --remount-ro / --chdir "$containment_probe_dir" --
    /usr/bin/bash "$entry"
  )
  preflight_ro_probes="$entry:$validator_under_test:$case_dir/bin:$config:$secrets:$case_dir/cloudflare.yml:$case_dir/data:$case_repo/compose.yaml:$case_repo/infra"
  for token in "${containment_command[@]}"; do
    if [[ "$token" == --proc ]]; then
      preflight_containment+=(--ro-bind "$secrets" "$secrets")
    fi
    preflight_containment+=("$token")
  done
  set +e
  /usr/bin/env -i PATH= HOME="$containment_probe_dir" CONTAINMENT_RO_PROBES="$preflight_ro_probes" \
    "${preflight_containment[@]}" /usr/bin/bash -c ':' >/dev/null 2>"$case_dir/containment-preflight.stderr"
  probe_status=$?
  set -e
  if (( probe_status != 0 )); then
    [[ -s "$case_dir/containment-preflight.stderr" ]] && /usr/bin/cat -- "$case_dir/containment-preflight.stderr" >&2
    fail 'Bubblewrap containment preflight or mandatory user namespace was rejected'
  fi
  [[ -f "$containment_probe_dir/.namespace-write-probe" && ! -e "$outside" ]] || fail 'containment did not prove fixture-only writes'
}

assert_resource_limit_mutations
assert_exact_resource_limits "${resource_limit_args[@]}" || fail 'canonical resource-limit vector is not exact'

verify_compose_env_metadata() {
  local metadata
  if [[ -L "$config" ]]; then
    echo "fatal: compose environment file must not be a symlink: $config" >&2
    return 1
  fi
  [[ -f "$config" ]] || { echo 'fatal: compose environment file missing' >&2; return 1; }
  metadata="$(/usr/bin/stat -L -c '%u:%g:%a' -- "$config")" || return 1
  if [[ "$metadata" != 0:0:640 ]]; then
    echo "fatal: compose environment file must be owned by root:root with mode 640: $config" >&2
    return 1
  fi
}

verify_compose_env_fixture() {
  local staged_config="${1:-$config}"
  local line key
  local -A seen=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" != *$'\r'* && "$line" =~ ^[A-Z][A-Z0-9_]*=[A-Za-z0-9_./:@,+-]*$ ]] || {
      echo 'FAIL: Compose environment must contain only strict data assignments before source' >&2
      return 1
    }
    key="${line%%=*}"
    [[ -z "${seen[$key]:-}" ]] || { echo 'FAIL: Compose environment contains a duplicate assignment' >&2; return 1; }
    seen["$key"]=1
  done <"$staged_config"
}

verify_staged_runtime_config() {
  local metadata actual_sha256
  [[ -f "$runtime_config_stage" && ! -L "$runtime_config_stage" ]] || return 1
  metadata="$(/usr/bin/stat -L -c '%u:%g:%a' -- "$runtime_config_stage")" || return 1
  [[ "$metadata" == 0:0:640 ]] || return 1
  [[ "$runtime_config_sha256" =~ ^[0-9a-f]{64}$ ]] || return 1
  actual_sha256="$(sha256_file "$runtime_config_stage")" || return 1
  [[ "$actual_sha256" == "$runtime_config_sha256" ]]
}

stage_runtime_config_once() {
  verify_compose_env_metadata || return 1
  runtime_config_invocation=$((runtime_config_invocation + 1))
  runtime_config_stage="$source_staging_root/runtime-config-$case_number-$BASHPID-$runtime_config_invocation.stage"
  [[ ! -e "$runtime_config_stage" ]] || return 1
  stage_live_source_once "$config" "$runtime_config_stage" || return 1
  chmod 0640 "$runtime_config_stage"
  runtime_config_sha256="$(sha256_file "$runtime_config_stage")" || return 1
  verify_staged_runtime_config
}

prepare_runtime_secret_mounts() {
  local alias_path target
  runtime_secret_mounts=()
  runtime_secret_ro_probes=()
  if [[ -L "$secrets" ]]; then
    target="$(/usr/bin/readlink -- "$secrets")" || return 1
    [[ "$target" == "$case_dir"/* && -d "$target" && ! -L "$target" ]] || return 1
    runtime_secret_mounts+=(--ro-bind "$target" "$target" --symlink "$target" "$secrets")
    runtime_secret_ro_probes+=("$target" "$secrets")
  elif [[ -d "$secrets" ]]; then
    runtime_secret_mounts+=(--ro-bind "$secrets" "$secrets")
    runtime_secret_ro_probes+=("$secrets")
  fi
  for alias_path in "$case_dir/path-alias" "$case_dir/a/link"; do
    [[ -L "$alias_path" ]] || continue
    target="$(/usr/bin/readlink -- "$alias_path")" || return 1
    [[ "$target" == "$case_dir" || "$target" == "$case_dir"/* ]] || return 1
    if [[ "$target" != "$case_dir" ]]; then
      runtime_secret_mounts+=(--dir "$target")
    fi
    runtime_secret_mounts+=(--symlink "$target" "$alias_path")
    runtime_secret_ro_probes+=("$alias_path")
  done
}

assert_runtime_execution_identity() {
  local command_name
  local secret_fixture
  verify_exact_staged_shell_source "$validator_stage" "$bash_bin" "$validator_shebang" "$validator_reviewed_sha256" || fail 'runtime source stage changed after transformation'
  verify_exact_staged_shell_source "$validator_under_test" "$bash_bin" "#!$bash_bin" "$validator_under_test_sha256" || fail 'transformed runtime validator changed before execution'
  verify_exact_staged_shell_source "$containment_entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" || fail 'namespace entry changed before runtime execution'
  verify_exact_staged_shell_source "$case_dir/bin/docker" "$bash_bin" "#!$bash_bin" "$fake_docker_sha256" || fail 'fake Docker changed before runtime execution'
  verify_exact_staged_shell_source "$case_dir/bin/timeout" "$bash_bin" "#!$bash_bin" "$fake_timeout_sha256" || fail 'fake timeout changed before runtime execution'
  verify_exact_staged_shell_source "$case_dir/bin/node" "$bash_bin" "#!$bash_bin" "$fake_node_sha256" || fail 'fake Node changed before runtime execution'
  verify_exact_staged_shell_source "$case_dir/bin/bash" "$bash_bin" "#!$bash_bin" "$fake_bash_sha256" || fail 'fake Bash changed before runtime execution'
  for command_name in trusted-stat trusted-realpath grep mktemp rm tr wc base64; do
    verify_exact_staged_shell_source "$case_dir/bin/$command_name" "$bash_bin" "#!$bash_bin" "$fake_safe_sha256" || fail "runtime safe command changed before execution: $command_name"
  done
  if [[ -e "$secrets" || -L "$secrets" ]]; then
    for secret_fixture in "$secrets" "$secrets"/*; do
      [[ "$(/usr/bin/stat -L -c '%u:%g' -- "$secret_fixture")" == "0:$secrets_gid" ]] ||
        fail "runtime secret fixture ownership changed before execution: $secret_fixture"
    done
  fi
  verify_fixed_outer_binary /usr/bin/bwrap true || fail 'Bubblewrap changed before runtime execution'
  verify_fixed_outer_binary /usr/bin/ldd true || fail 'ldd changed before runtime execution'
  assert_exact_resource_limits "${resource_limit_args[@]}" || fail 'runtime resource-limit vector changed before execution'
  prepare_minimal_runtime_mounts /usr/bin/bash /usr/bin/stat /usr/bin/realpath /usr/bin/grep \
    /usr/bin/mktemp /usr/bin/rm /usr/bin/tr /usr/bin/wc /usr/bin/base64 /usr/bin/sha256sum ||
    fail 'minimal runtime-validator filesystem changed before execution'
  verify_staged_runtime_config || fail 'one-FD staged Compose environment changed before execution'
}

run_validator() {
  local validation_mode="${1:-pilot}"
  local validator_status token
  local runtime_stdout="$case_dir/runtime-validator.stdout"
  local runtime_stderr="$case_dir/runtime-validator.stderr"
  local ro_probes
  local -a execution_containment=() runtime_execution_rw_mounts=() runtime_secret_mounts=() runtime_secret_ro_probes=()
  shift || true
  stage_runtime_config_once || return 99
  if source_manipulates_path "$runtime_config_stage"; then
    echo 'FAIL: Compose environment may not reference or mutate the harness-owned PATH' >&2
    return 98
  fi
  verify_compose_env_fixture "$runtime_config_stage" || return 99
  prepare_runtime_secret_mounts || return 99
  assert_runtime_execution_identity
  : >"$runtime_stdout"
  : >"$runtime_stderr"
  runtime_execution_rw_mounts=(
    --bind "$case_dir/tmp" "$case_dir/tmp"
    --bind "$fake_docker_log" "$fake_docker_log"
  )
  for token in "${containment_command[@]}"; do
    if [[ "$token" == --proc ]]; then
      execution_containment+=("${runtime_secret_mounts[@]}")
      execution_containment+=(--ro-bind "$runtime_config_stage" "$config")
      execution_containment+=("${runtime_execution_rw_mounts[@]}")
    fi
    execution_containment+=("$token")
  done
  ro_probes="$containment_entry:$validator_under_test:$case_dir/bin:$config:$case_dir/cloudflare.yml:$case_dir/data:$case_repo/compose.yaml:$case_repo/infra"
  for token in "${runtime_secret_ro_probes[@]}"; do ro_probes+=":$token"; done
  if /usr/bin/env -i \
    HOME="$containment_probe_dir" \
    PATH= \
    TMPDIR="$case_dir/tmp" \
    REPO_ROOT="$case_repo" \
    COMPOSE_ENV_FILE="$config" \
    VALIDATION_MODE="$validation_mode" \
    POSTGRES_IMAGE="$ambient_postgres_image" \
    POSTGRES_UID="$ambient_postgres_uid" \
    POSTGRES_GID="$ambient_postgres_gid" \
    FAKE_STAT_TARGET="$fake_stat_target" \
    FAKE_DOCKER_LOG="$fake_docker_log" \
    FAKE_DOCKER_BINARY="$case_dir/bin/docker" \
    FAKE_CASE_ROOT="$case_dir" \
    FAKE_TMPDIR="$case_dir/tmp" \
    FAKE_EXPECTED_COMPOSE_ENV="$config" \
    FAKE_EXPECTED_COMPOSE_FILE="$case_repo/compose.yaml" \
    FAKE_RUNNER_URL="$fake_runner_url" \
    FAKE_RUNNER_CLIENT_URL="$fake_runner_client_url" \
    FAKE_RUNNER_CLIENT_SUBNET="$fake_runner_client_subnet" \
    FAKE_RUNNER_CLIENT_INTERNAL="$fake_runner_client_internal" \
    FAKE_RUNNER_GATEWAY_SOURCE="$fake_runner_gateway_source" \
    FAKE_RUNNER_SUBNET="$fake_runner_subnet" \
    FAKE_RUNNER_BRIDGE="$fake_runner_bridge" \
    FAKE_APP_IMAGE="$fake_app_image" \
    FAKE_LONG_RESTART="$fake_long_restart" \
    FAKE_CLOUDFLARED_RESTART="$fake_cloudflared_restart" \
    FAKE_ONESHOT_RESTART="$fake_oneshot_restart" \
    FAKE_POSTGRES_IMAGE="$ambient_postgres_image" \
    FAKE_POSTGRES_CONFIG_USER="$fake_postgres_config_user" \
    FAKE_POSTGRES_PASSWD_ENTRY="$fake_postgres_passwd_entry" \
    FAKE_POSTGRES_FSYNC="$fake_postgres_fsync" \
    FAKE_POSTGRES_SYNC_COMMIT="$fake_postgres_sync_commit" \
    FAKE_POSTGRES_FULL_PAGE_WRITES="$fake_postgres_full_page_writes" \
    FAKE_EXPECTED_OBJECT_PREPARER="$case_repo/infra/ops/prepare-object-storage.mjs" \
    FAKE_EXPECTED_POSTGRES_PREPARER="$case_repo/infra/ops/prepare-postgres-control-socket.sh" \
    FAKE_EXPECTED_DATABASE_VALIDATOR="$case_repo/infra/ops/validate-database-secrets.mjs" \
    FAKE_EXPECTED_SECRETS_DIR="$secrets" \
    FAKE_NODE_OBJECT_CHECK_STATUS="$fake_node_object_check_status" \
    FAKE_BASH_PREPARER_CHECK_STATUS="$fake_bash_preparer_check_status" \
    FAKE_HOST_PORT="$fake_host_port" \
    FAKE_LIVE_FSYNC="$fake_live_fsync" \
    FAKE_LIVE_SYNC_COMMIT="$fake_live_sync_commit" \
    FAKE_LIVE_FULL_PAGE_WRITES="$fake_live_full_page_writes" \
    FAKE_MUTATE_SERVICE="$fake_mutate_service" \
    FAKE_MUTATE_FIELD="$fake_mutate_field" \
    FAKE_MUTATE_VALUE="$fake_mutate_value" \
    FAKE_EXPECTED_POSTGRES_SQL="$postgres_probe_sql" \
    FAKE_EXPECTED_SECRET_GID="$secrets_gid" \
    RUNTIME_CONFIG_VERIFY_PATH="$config" \
    RUNTIME_CONFIG_VERIFY_SHA256="$runtime_config_sha256" \
    CONTAINMENT_RO_PROBES="$ro_probes" \
    CONTAINMENT_EXPECT_REGULAR_OUTPUTS=1 \
    "${execution_containment[@]}" /usr/bin/bash "$validator_under_test" "$@" \
    >"$runtime_stdout" 2>"$runtime_stderr"; then
    validator_status=0
  else
    validator_status=$?
  fi
  [[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] || {
    echo 'FAIL: runtime validator modified the outside-fixture sentinel' >&2
    return 97
  }
  [[ -s "$runtime_stdout" ]] && /usr/bin/cat -- "$runtime_stdout"
  [[ -s "$runtime_stderr" ]] && /usr/bin/cat -- "$runtime_stderr" >&2
  return "$validator_status"
}

assert_canary_absent() {
  local label="$1"
  local output="$2"

  if [[ "$output" == *"$secret_canary"* || "$output" == *"$database_canary"* ]]; then
    echo "FAIL: $label printed secret contents" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

expect_success() {
  local label="$1"
  local validation_mode="${2:-pilot}"
  local -a selector_args=("${@:3}")
  local output
  local status

  set +e
  if (( ${#selector_args[@]} > 0 )); then
    output="$(run_validator "$validation_mode" "${selector_args[@]}" 2>&1)"
  else
    output="$(run_validator "$validation_mode" 2>&1)"
  fi
  status=$?
  set -e

  assert_canary_absent "$label" "$output"
  if (( status != 0 )) || [[ "$output" != 'runtime validation passed' ]]; then
    echo "FAIL: $label expected runtime validation success" >&2
    printf 'status: %s\noutput:\n%s\n' "$status" "$output" >&2
    exit 1
  fi

  echo "ok - $label"
}

expect_preprivileged_success() {
  local label="$1"
  local output
  local status

  set +e
  output="$(run_validator pilot --pre-privileged 2>&1)"
  status=$?
  set -e

  assert_canary_absent "$label" "$output"
  if (( status != 0 )) || [[ "$output" != 'pre-privileged runtime validation passed' ]]; then
    echo "FAIL: $label expected pre-privileged runtime validation success" >&2
    printf 'status: %s\noutput:\n%s\n' "$status" "$output" >&2
    exit 1
  fi

  local inspect_count identity_count
  inspect_count="$(grep -Ec '^docker image inspect([[:space:]]|$)' "$fake_docker_log" || true)"
  identity_count="$(grep -Ec '^docker run([[:space:]]|$)' "$fake_docker_log" || true)"
  [[ "$inspect_count" == 1 && "$identity_count" == 1 ]] || {
    echo "FAIL: $label must perform exactly one bounded image-user inspection and one isolated postgres identity lookup" >&2
    exit 1
  }

  echo "ok - $label"
}

expect_failure() {
  local label="$1"
  local expected_fatal="$2"
  local validation_mode="${3:-pilot}"
  local -a selector_args=("${@:4}")
  local output
  local status
  local -a fatal_lines=()

  set +e
  if (( ${#selector_args[@]} > 0 )); then
    output="$(run_validator "$validation_mode" "${selector_args[@]}" 2>&1)"
  else
    output="$(run_validator "$validation_mode" 2>&1)"
  fi
  status=$?
  set -e

  assert_canary_absent "$label" "$output"
  if (( status == 0 )); then
    echo "FAIL: $label expected runtime validation failure" >&2
    printf 'output:\n%s\n' "$output" >&2
    exit 1
  fi

  mapfile -t fatal_lines < <(printf '%s\n' "$output" | grep '^fatal:' || true)
  if (( ${#fatal_lines[@]} != 1 )) || [[ "${fatal_lines[0]:-}" != "$expected_fatal" ]]; then
    echo "FAIL: $label expected exactly one fatal line" >&2
    printf 'expected: %s\nactual output:\n%s\n' "$expected_fatal" "$output" >&2
    exit 1
  fi

  echo "ok - $label"
}

run_fake_docker_contract() {
  "$env_bin" -i \
    PATH="$case_dir/bin" \
    FAKE_DOCKER_LOG="$fake_docker_log" \
    FAKE_EXPECTED_COMPOSE_ENV="$config" \
    FAKE_EXPECTED_COMPOSE_FILE="$repo_root/compose.yaml" \
    FAKE_POSTGRES_IMAGE="$ambient_postgres_image" \
    FAKE_POSTGRES_CONFIG_USER="$fake_postgres_config_user" \
    FAKE_POSTGRES_PASSWD_ENTRY="$fake_postgres_passwd_entry" \
    FAKE_EXPECTED_POSTGRES_SQL="$postgres_probe_sql" \
    FAKE_LIVE_FSYNC=on \
    FAKE_LIVE_SYNC_COMMIT=on \
    FAKE_LIVE_FULL_PAGE_WRITES=on \
    "$case_dir/bin/docker" "$@"
}

expect_fake_probe_rejected() {
  local label="$1"
  shift
  set +e
  run_fake_docker_contract "$@" >"$case_dir/$label.stdout" 2>"$case_dir/$label.stderr"
  local status=$?
  set -e
  (( status != 0 )) || {
    echo "FAIL: exact PostgreSQL fake accepted $label" >&2
    exit 1
  }
}

assert_containment_gate_mutations
make_fixture exact-postgres-probe-fake
postgres_probe_argv=(
  compose --env-file "$config" -f "$repo_root/compose.yaml" exec -T postgres
  psql --host=/run/learncoding-postgres --username=learncoding --dbname=learncoding
  --no-psqlrc --quiet --no-align --tuples-only '--field-separator=|'
  --command "$postgres_probe_sql"
)
run_fake_docker_contract "${postgres_probe_argv[@]}" >/dev/null || {
  echo 'FAIL: exact PostgreSQL fake rejected the canonical probe' >&2
  exit 1
}
expect_fake_probe_rejected extra-compose-command \
  compose --env-file "$config" -f "$repo_root/compose.yaml" --profile operations exec -T postgres \
  psql --host=/run/learncoding-postgres --username=learncoding --dbname=learncoding \
  --no-psqlrc --quiet --no-align --tuples-only '--field-separator=|' \
  --command "$postgres_probe_sql"
expect_fake_probe_rejected extra-psql-command \
  compose --env-file "$config" -f "$repo_root/compose.yaml" exec -T postgres \
  psql --host=/run/learncoding-postgres --username=learncoding --dbname=learncoding \
  --no-psqlrc --quiet --no-align --tuples-only '--field-separator=|' --list \
  --command "$postgres_probe_sql"
expect_fake_probe_rejected extra-sql-command \
  compose --env-file "$config" -f "$repo_root/compose.yaml" exec -T postgres \
  psql --host=/run/learncoding-postgres --username=learncoding --dbname=learncoding \
  --no-psqlrc --quiet --no-align --tuples-only '--field-separator=|' \
  --command "$postgres_probe_sql SELECT 1;"

outside_sentinel="$work/outside-runtime-case.sentinel"
printf '%s' 'outside-fixture-sentinel-unchanged' >"$outside_sentinel"
outside_sentinel_link="$case_dir/outside-sentinel-link"
ln -s "$outside_sentinel" "$outside_sentinel_link"
set +e
"$env_bin" -i PATH="$case_dir/bin" FAKE_CASE_ROOT="$case_dir" FAKE_TMPDIR="$case_dir/tmp" \
  "$case_dir/bin/grep" -Eq sentinel "$outside_sentinel" >"$case_dir/outside-read.stdout" 2>"$case_dir/outside-read.stderr"
outside_read_status=$?
"$env_bin" -i PATH="$case_dir/bin" FAKE_CASE_ROOT="$case_dir" FAKE_TMPDIR="$case_dir/tmp" \
  "$case_dir/bin/grep" -Eq sentinel "$outside_sentinel_link" \
  >"$case_dir/symlink-read.stdout" 2>"$case_dir/symlink-read.stderr"
symlink_read_status=$?
"$env_bin" -i PATH="$case_dir/bin" FAKE_CASE_ROOT="$case_dir" FAKE_TMPDIR="$case_dir/tmp" \
  "$case_dir/bin/trusted-realpath" --canonicalize-missing --no-symlinks -- "$outside_sentinel_link" \
  >"$case_dir/symlink-realpath.stdout" 2>"$case_dir/symlink-realpath.stderr"
symlink_realpath_status=$?
PATH="$case_dir/bin" cp -- "$config" "$outside_sentinel" >"$case_dir/outside-write.stdout" 2>"$case_dir/outside-write.stderr"
outside_write_status=$?
PATH="$case_dir/bin" runtime-contract-unknown-command >"$case_dir/outside-unknown.stdout" 2>"$case_dir/outside-unknown.stderr"
outside_unknown_status=$?
set -e
rm -- "$outside_sentinel_link"
(( outside_read_status != 0 && symlink_read_status != 0 && symlink_realpath_status != 0 &&
   outside_write_status != 0 && outside_unknown_status != 0 )) || {
  echo 'FAIL: fake-only runtime PATH allowed an unknown, direct/symlink outside read, or outside write command' >&2
  exit 1
}
[[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] || {
  echo 'FAIL: outside-fixture runtime sentinel was modified' >&2
  exit 1
}

for path_mutation_case in \
  'assignment|PATH=/usr/bin:/bin' \
  'export|export PATH=/usr/bin:/bin' \
  'unset|unset PATH' \
  'readonly|readonly PATH=/usr/bin:/bin'; do
  path_mutation_label="${path_mutation_case%%|*}"
  path_mutation_line="${path_mutation_case#*|}"
  make_fixture "sourced-path-$path_mutation_label"
  printf '%s\n' "$path_mutation_line" >>"$config"
  set +e
  path_mutation_output="$(run_validator pilot 2>&1)"
  path_mutation_status=$?
  set -e
  [[ "$path_mutation_status" == 98 ]] ||
    fail "sourced PATH $path_mutation_label mutation was not rejected before the SUT"
  [[ "$path_mutation_output" == 'FAIL: Compose environment may not reference or mutate the harness-owned PATH' ]] ||
    fail "sourced PATH $path_mutation_label mutation produced an unexpected diagnostic"
  [[ ! -s "$fake_docker_log" ]] ||
    fail "sourced PATH $path_mutation_label mutation reached a fake runtime command"
  [[ "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
    fail "sourced PATH $path_mutation_label mutation changed the outside sentinel"
done

while IFS='|' read -r sourced_mutation_label sourced_mutation_line; do
  make_fixture "sourced-code-$sourced_mutation_label"
  printf '%s\n' "$sourced_mutation_line" >>"$config"
  set +e
  sourced_mutation_output="$(run_validator pilot 2>&1)"
  sourced_mutation_status=$?
  set -e
  [[ "$sourced_mutation_status" == 99 ]] || fail "sourced code $sourced_mutation_label mutation was not rejected before the SUT"
  [[ "$sourced_mutation_output" == 'FAIL: Compose environment must contain only strict data assignments before source' ]] ||
    fail "sourced code $sourced_mutation_label mutation produced an unexpected diagnostic"
  [[ ! -s "$fake_docker_log" && "$(<"$outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
    fail "sourced code $sourced_mutation_label mutation reached a command or sentinel"
done <<'EOF'
dynamic-command|DYNAMIC_COMMAND=$(command -p -v cp)
assembled-absolute|D=/usr/bin; TARGET="$D/cp"
new-shell|SHELL=/usr/bin/sh; "$SHELL" -c true
dynamic-source|VERB=source; "$VERB" "$DYNAMIC_HELPER"
EOF

make_fixture sourced-duplicate-assignment
printf '%s\n' 'APP_URL=https://duplicate.example.test' >>"$config"
set +e
duplicate_assignment_output="$(run_validator pilot 2>&1)"
duplicate_assignment_status=$?
set -e
[[ "$duplicate_assignment_status" == 99 && "$duplicate_assignment_output" == 'FAIL: Compose environment contains a duplicate assignment' ]] ||
  fail 'duplicate sourced assignment was not rejected before the SUT'

make_fixture valid-pilot
expect_success 'valid pilot fixture'
if grep -Eq '(^|[[:space:]])exec([[:space:]]|$)' "$fake_docker_log"; then
  echo 'FAIL: zero-argument preflight contacted the live PostgreSQL container' >&2
  exit 1
fi

while IFS='|' read -r label alternate_url; do
  make_fixture "runner-url-$label"
  fake_runner_url="$alternate_url"
  expect_failure \
    "runner URL $label" \
    'fatal: runner URL must be exactly http://192.168.122.12:4100'
done <<'EOF'
other-rfc1918|http://10.20.0.13:4100
other-rfc1918-172|http://172.29.40.12:4100
other-rfc1918-192|http://192.168.1.12:4100
localhost|http://127.0.0.1:4100
wildcard|http://0.0.0.0:4100
hostname|http://runner.internal:4100
public-https|https://runner.example.test
wrong-port|http://192.168.122.12:4101
userinfo|http://operator@192.168.122.12:4100
path|http://192.168.122.12:4100/healthz
query|http://192.168.122.12:4100?verbose=true
fragment|http://192.168.122.12:4100#runner
EOF

make_fixture wrong-runner-client-subnet
fake_runner_client_subnet='172.29.44.0/24'
expect_failure \
  'wrong runner-client subnet' \
  'fatal: runner-client subnet must be exactly 172.29.41.0/24'

make_fixture non-internal-runner-client
fake_runner_client_internal='false'
expect_failure \
  'non-internal runner-client network' \
  'fatal: runner-client network must be internal'

make_fixture wrong-runner-gateway-stop-grace
fake_mutate_service=runner-egress-gateway
fake_mutate_field=stop-grace
fake_mutate_value=30s
expect_failure \
  'wrong runner gateway stop grace period' \
  'fatal: rendered runner gateway stop budget must be exactly fifteen seconds'

make_fixture wrong-runner-subnet
fake_runner_subnet='172.29.41.0/24'
expect_failure \
  'wrong runner-egress subnet' \
  'fatal: runner-egress subnet must be exactly 172.29.40.0/24'

make_fixture wrong-runner-bridge
fake_runner_bridge='bridge0'
expect_failure \
  'wrong runner-egress bridge' \
  'fatal: runner-egress bridge must be exactly cdst-run0'

make_fixture wrong-runner-client-url
fake_runner_client_url='http://192.168.122.12:4100'
expect_failure \
  'runner client bypass URL' \
  'fatal: runner client URL must be exactly http://runner-egress-gateway:4100'

pilot_rendered_services=(
  postgres app mail-worker reward-worker regrade-worker exam-finalization-worker
  practice-runner-recovery-worker project-review-correction-worker file-erasure-worker scan-worker cloudflared runner-egress-gateway
)
internal_long_running_services=(
  postgres app mail-worker reward-worker regrade-worker exam-finalization-worker
  practice-runner-recovery-worker project-review-correction-worker file-erasure-worker scan-worker runner-egress-gateway
)
operations_services=(
  database-role-bootstrap database-negative-probes database-boundary-verifier
  migrate lifecycle platform-seed admin-bootstrap
)
one_shot_services=("${operations_services[@]}")

for service in "${pilot_rendered_services[@]}"; do
  make_fixture "host-port-$service"
  fake_mutate_service="$service"
  fake_mutate_field=host-port
  expect_failure \
    "rendered Compose host port on $service" \
    'fatal: trusted Compose stack must not publish host ports'
  make_fixture "mutable-image-$service"
  fake_mutate_service="$service"
  fake_mutate_field=image
  fake_mutate_value='registry.example.test/codestead/mutable:latest'
  expect_failure \
    "rendered mutable image on $service" \
    'fatal: rendered Compose services must use immutable sha256 image references'
done

for service in "${operations_services[@]}"; do
  make_fixture "operations-host-port-$service"
  fake_mutate_service="$service"
  fake_mutate_field=host-port
  expect_failure \
    "rendered operations host port on $service" \
    'fatal: trusted Compose stack must not publish host ports' \
    operations
  make_fixture "operations-mutable-image-$service"
  fake_mutate_service="$service"
  fake_mutate_field=image
  fake_mutate_value='registry.example.test/codestead/mutable:latest'
  expect_failure \
    "rendered operations mutable image on $service" \
    'fatal: rendered Compose services must use immutable sha256 image references' \
    operations
done

for service in "${internal_long_running_services[@]}"; do
  make_fixture "wrong-long-restart-$service"
  fake_mutate_service="$service"
  fake_mutate_field=restart
  fake_mutate_value=always
  expect_failure \
    "wrong long-running restart class on $service" \
    'fatal: rendered internal long-running services must restart unless-stopped'
done

for cloudflared_restart_drift in always unless-stopped on-failure on-failure:4 on-failure:6 no; do
  make_fixture "wrong-cloudflared-restart-$cloudflared_restart_drift"
  fake_mutate_service=cloudflared
  fake_mutate_field=restart
  fake_mutate_value="$cloudflared_restart_drift"
  expect_failure \
    "wrong cloudflared restart class $cloudflared_restart_drift" \
    'fatal: rendered cloudflared must use restart on-failure:5'
done

for service in "${one_shot_services[@]}"; do
  make_fixture "wrong-one-shot-restart-$service"
  fake_mutate_service="$service"
  fake_mutate_field=restart
  fake_mutate_value=on-failure
  expect_failure \
    "wrong one-shot restart class on $service" \
    'fatal: rendered one-shot services must use restart no' \
    operations
done

for setting in fsync synchronous_commit full_page_writes; do
  make_fixture "rendered-postgres-$setting-off"
  case "$setting" in
    fsync) fake_postgres_fsync=off ;;
    synchronous_commit) fake_postgres_sync_commit=off ;;
    full_page_writes) fake_postgres_full_page_writes=off ;;
  esac
  expect_failure \
    "rendered PostgreSQL $setting disabled" \
    'fatal: rendered PostgreSQL command must enforce fsync=on, synchronous_commit=on, and full_page_writes=on'
done

make_fixture invalid-selector
expect_failure \
  'unsupported runtime validation selector' \
  'fatal: usage: validate-runtime.sh [--post-start|--pre-privileged]' \
  pilot \
  --unexpected

make_fixture invalid-bare-post-start-selector
expect_failure \
  'bare post-start selector' \
  'fatal: usage: validate-runtime.sh [--post-start|--pre-privileged]' \
  pilot \
  post-start

make_fixture post-start-extra-argument
expect_failure \
  'post-start selector with an extra argument' \
  'fatal: usage: validate-runtime.sh [--post-start|--pre-privileged]' \
  pilot \
  --post-start \
  extra

make_fixture valid-pre-privileged
expect_preprivileged_success 'valid root-owned privileged preparers and pinned PostgreSQL identity'

make_fixture missing-object-storage-preparer
rm "$case_repo/infra/ops/prepare-object-storage.mjs"
expect_failure \
  'missing object-storage preparer' \
  'fatal: object storage preparer is missing or unsafe' \
  pilot \
  --pre-privileged

make_fixture missing-postgres-storage-preparer
rm "$case_repo/infra/ops/prepare-postgres-control-socket.sh"
expect_failure \
  'missing PostgreSQL storage preparer' \
  'fatal: PostgreSQL storage preparer is missing or unsafe' \
  pilot \
  --pre-privileged

make_fixture non-executable-postgres-storage-preparer
chmod 0644 "$case_repo/infra/ops/prepare-postgres-control-socket.sh"
expect_failure \
  'non-executable PostgreSQL storage preparer' \
  'fatal: PostgreSQL storage preparer is missing or unsafe' \
  pilot \
  --pre-privileged

make_fixture wrong-object-storage-preparer-mode
chmod 0600 "$case_repo/infra/ops/prepare-object-storage.mjs"
expect_failure \
  'wrong object-storage preparer mode' \
  'fatal: object storage preparer must be root:root mode 644 with one link' \
  pilot \
  --pre-privileged

make_fixture wrong-postgres-storage-preparer-mode
chmod 0700 "$case_repo/infra/ops/prepare-postgres-control-socket.sh"
expect_failure \
  'wrong PostgreSQL storage preparer mode' \
  'fatal: PostgreSQL storage preparer must be root:root mode 755 with one link' \
  pilot \
  --pre-privileged

make_fixture writable-preparer-ancestry
chmod 0720 "$case_repo/infra"
expect_failure \
  'group-writable privileged preparer ancestry' \
  'fatal: privileged preparer ancestry must not be group/world writable' \
  pilot \
  --pre-privileged

make_fixture invalid-object-storage-preparer-syntax
fake_node_object_check_status=1
expect_failure \
  'invalid object-storage preparer syntax' \
  'fatal: object storage preparer syntax validation failed' \
  pilot \
  --pre-privileged

make_fixture invalid-postgres-storage-preparer-syntax
fake_bash_preparer_check_status=1
expect_failure \
  'invalid PostgreSQL storage preparer syntax' \
  'fatal: PostgreSQL storage preparer syntax validation failed' \
  pilot \
  --pre-privileged

make_fixture noncanonical-postgres-uid
ambient_postgres_uid=0999
expect_failure \
  'noncanonical PostgreSQL UID' \
  'fatal: POSTGRES_UID must be a canonical positive integer' \
  pilot \
  --pre-privileged

make_fixture postgres-image-identity-mismatch
ambient_postgres_uid=998
expect_failure \
  'configured PostgreSQL identity differs from pinned image' \
  'fatal: POSTGRES_UID/POSTGRES_GID do not match the pinned PostgreSQL image' \
  pilot \
  --pre-privileged

make_fixture malformed-postgres-image-identity
fake_postgres_passwd_entry='postgres:x:999:not-a-gid:PostgreSQL:/var/lib/postgresql:/bin/sh'
expect_failure \
  'malformed postgres identity from pinned image' \
  'fatal: pinned PostgreSQL image postgres identity is invalid' \
  pilot \
  --pre-privileged

make_fixture conflicting-postgres-config-user
fake_postgres_config_user=root
expect_failure \
  'pinned PostgreSQL image has a conflicting Config.User' \
  'fatal: pinned PostgreSQL image Config.User conflicts with its postgres identity' \
  pilot \
  --pre-privileged

make_fixture valid-post-start
expect_success 'valid post-start PostgreSQL durability fixture' pilot --post-start
postgres_invocations="$(grep -Ec '^docker .* exec([[:space:]]|$)' "$fake_docker_log" || true)"
if [[ "$postgres_invocations" != 1 ]]; then
  echo 'FAIL: post-start validation must use exactly one bounded fake-Docker PostgreSQL invocation' >&2
  exit 1
fi
timeout_invocations="$(grep -c '^timeout ' "$fake_docker_log" || true)"
if [[ "$timeout_invocations" != 1 ]]; then
  echo 'FAIL: post-start PostgreSQL validation must be bounded by one 1-30 second timeout' >&2
  exit 1
fi
postgres_event="$(grep -E '^docker .* exec([[:space:]]|$)' "$fake_docker_log")"
current_postgres_probe_argv=(
  compose --env-file "$config" -f "$case_repo/compose.yaml" exec -T postgres
  psql --host=/run/learncoding-postgres --username=learncoding --dbname=learncoding
  --no-psqlrc --quiet --no-align --tuples-only '--field-separator=|'
  --command "$postgres_probe_sql"
)
expected_postgres_event=docker
for argument in "${current_postgres_probe_argv[@]}"; do
  printf -v escaped_argument '%q' "$argument"
  expected_postgres_event+=" $escaped_argument"
done
if [[ "$postgres_event" != "$expected_postgres_event" ]]; then
  echo 'FAIL: post-start validation must use the exact canonical read-only PostgreSQL argv and SQL' >&2
  exit 1
fi
timeout_event="$(grep '^timeout ' "$fake_docker_log")"
printf -v escaped_duration '%q' 30s
printf -v escaped_docker_path '%q' "$case_dir/bin/docker"
expected_timeout_event="timeout $escaped_duration $escaped_docker_path"
for argument in "${current_postgres_probe_argv[@]}"; do
  printf -v escaped_argument '%q' "$argument"
  expected_timeout_event+=" $escaped_argument"
done
if [[ "$timeout_event" != "$expected_timeout_event" ]]; then
  echo 'FAIL: post-start timeout must wrap only the exact fake-Docker Compose invocation' >&2
  exit 1
fi

for setting in fsync synchronous_commit full_page_writes; do
  make_fixture "live-postgres-$setting-off"
  case "$setting" in
    fsync) fake_live_fsync=off ;;
    synchronous_commit) fake_live_sync_commit=off ;;
    full_page_writes) fake_live_full_page_writes=off ;;
  esac
  expect_failure \
    "live PostgreSQL $setting disabled" \
    'fatal: live PostgreSQL durability settings must be exactly on/on/on' \
    pilot \
    --post-start
done

make_fixture valid-operations
set_config REQUIRE_BOOTSTRAP_ADMIN_SECRET true
add_bootstrap_secret
expect_success 'caller operations mode overrides sourced pilot value' operations
operations_render_argv=(
  compose --env-file "$config" -f "$case_repo/compose.yaml" --profile operations config
)
expected_operations_render_event=docker
for argument in "${operations_render_argv[@]}"; do
  printf -v escaped_argument '%q' "$argument"
  expected_operations_render_event+=" $escaped_argument"
done
operations_render_count="$(grep -Fxc -- "$expected_operations_render_event" "$fake_docker_log" || true)"
[[ "$operations_render_count" == 1 ]] || fail 'operations validation must render exactly once with the explicit operations CLI profile'

make_fixture valid-uploads
set_config UPLOADS_ENABLED true
set_config COMPOSE_PROFILES uploads
set_config CLAMAV_IMAGE "clamav/clamav:1.4.3_base@sha256:$digest_c"
expect_success 'uploads profile accepts an immutable ClamAV digest without operations validation'

make_fixture forbidden-operations-profile
set_config COMPOSE_PROFILES operations
expect_failure \
  'operations profile cannot be activated by the Compose environment' \
  'fatal: UPLOADS_ENABLED=false requires COMPOSE_PROFILES to be empty'

make_fixture forbidden-profile-token
set_config COMPOSE_PROFILES operations-notuploads
expect_failure \
  'unreviewed profile token is rejected' \
  'fatal: UPLOADS_ENABLED=false requires COMPOSE_PROFILES to be empty'

make_fixture forbidden-mixed-uploads-profile
set_config UPLOADS_ENABLED true
set_config COMPOSE_PROFILES operations,uploads
set_config CLAMAV_IMAGE "clamav/clamav:1.4.3_base@sha256:$digest_c"
expect_failure \
  'uploads cannot smuggle the operations profile through the environment' \
  'fatal: UPLOADS_ENABLED=true requires COMPOSE_PROFILES=uploads exactly'

make_fixture caller-ambient-profile-is-cleared
export COMPOSE_PROFILES=operations
expect_success 'caller ambient Compose profiles are not inherited by the validator sandbox'
unset COMPOSE_PROFILES

make_fixture valid-repeated-trailing-slashes
set_config SECRETS_DIR "$case_dir//secrets///"
expect_success 'valid secrets directory accepts repeated and trailing slashes'

make_fixture config-symlink
mv "$config" "$case_dir/compose.env.real"
ln -s "$case_dir/compose.env.real" "$config"
expect_failure \
  'symlinked compose environment file' \
  "fatal: compose environment file must not be a symlink: $config"

make_fixture config-mode
chmod 0600 "$config"
expect_failure \
  'compose environment mode 0600' \
  "fatal: compose environment file must be owned by root:root with mode 640: $config"

make_fixture directory-symlink
mv "$secrets" "$case_dir/secrets.real"
ln -s "$case_dir/secrets.real" "$secrets"
expect_failure \
  'symlinked secrets directory' \
  "fatal: secrets directory must not be a symlink: $secrets"

make_fixture directory-symlink-trailing-slash
mv "$secrets" "$case_dir/secrets.real"
ln -s "$case_dir/secrets.real" "$secrets"
set_config SECRETS_DIR "$secrets/"
expect_failure \
  'symlinked secrets directory with a trailing slash' \
  "fatal: secrets directory must not be a symlink: $secrets"

make_fixture directory-symlink-before-parent
mkdir -p "$case_dir/a" "$case_dir/x/y"
mv "$secrets" "$case_dir/a/secrets"
ln -s "$case_dir/x/y" "$case_dir/a/link"
symlink_before_parent_dir="$case_dir/a/link/../secrets"
set_config SECRETS_DIR "$symlink_before_parent_dir"
expect_failure \
  'symlink before a parent path component' \
  'fatal: secrets directory path must be canonical'

make_fixture directory-symlink-dot-alias
mv "$secrets" "$case_dir/secrets.real"
ln -s "$case_dir/secrets.real" "$secrets"
set_config SECRETS_DIR "$secrets/."
expect_failure \
  'symlinked secrets directory with a dot alias' \
  'fatal: secrets directory path must be canonical'

make_fixture directory-nested-symlink
ln -s "$case_dir" "$case_dir/path-alias"
nested_secrets_dir="$case_dir/path-alias/secrets"
set_config SECRETS_DIR "$nested_secrets_dir"
expect_failure \
  'secrets directory below a symlinked path component' \
  "fatal: secrets directory must not be a symlink: $nested_secrets_dir"

make_fixture directory-parent-alias
mkdir "$case_dir/path-segment"
ln -s "$case_dir" "$case_dir/path-alias"
parent_alias_secrets_dir="$case_dir/path-segment/../path-alias/secrets"
set_config SECRETS_DIR "$parent_alias_secrets_dir"
expect_failure \
  'parent alias cannot hide a symlinked path component' \
  'fatal: secrets directory path must be canonical'

make_fixture directory-relative-path
set_config SECRETS_DIR relative/secrets
expect_failure \
  'relative secrets directory path' \
  'fatal: secrets directory path must be absolute'

make_fixture directory-mode
chmod 0700 "$secrets"
expect_failure \
  'secrets directory mode 0700' \
  "fatal: secrets directory must be owned by root:2000 with mode 750: $secrets"

for bad_mode in 0400 0444; do
  make_fixture "secret-mode-$bad_mode"
  chmod "$bad_mode" "$secrets/postgres_password"
  expect_failure \
    "secret mode $bad_mode" \
    "fatal: secret must be owned by root:2000 with mode 440: $secrets/postgres_password"
done

make_fixture untrusted-path-stat
chmod 0400 "$secrets/postgres_password"
fake_stat_target="$secrets/postgres_password"
printf '#!%s\n' "$bash_bin" >"$case_dir/bin/stat"
cat >>"$case_dir/bin/stat" <<'EOF'
set -eu

target="${!#}"
if [[ "$target" == "$FAKE_STAT_TARGET" ]]; then
  printf '%s\n' '0:2000:440'
  exit 0
fi

exit 97
EOF
chmod 0755 "$case_dir/bin/stat"
expect_failure \
  'caller PATH cannot forge secret metadata' \
  "fatal: secret must be owned by root:2000 with mode 440: $secrets/postgres_password"

make_fixture secret-symlink
rm "$secrets/postgres_password"
ln -s "$secrets/database_url" "$secrets/postgres_password"
expect_failure \
  'symlinked secret' \
  "fatal: secret must not be a symlink: $secrets/postgres_password"

for missing_secret in lost_device_proof_key deletion_tombstone_key; do
  make_fixture "missing-$missing_secret"
  rm "$secrets/$missing_secret"
  expect_failure \
    "missing $missing_secret" \
    "fatal: required secret is missing: $secrets/$missing_secret"
done

for cloudflare_case in missing-tunnel-id extra-field malformed-account invalid-secret; do
  make_fixture "cloudflare-$cloudflare_case"
  case "$cloudflare_case" in
    missing-tunnel-id)
      printf '%s' '{"AccountTag":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","TunnelSecret":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}' >"$secrets/cloudflare_tunnel_credentials.json"
      ;;
    extra-field)
      printf '%s' '{"AccountTag":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","TunnelSecret":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=","TunnelID":"11111111-1111-4111-8111-111111111111","extra":true}' >"$secrets/cloudflare_tunnel_credentials.json"
      ;;
    malformed-account)
      printf '%s' '{"AccountTag":"not-an-account","TunnelSecret":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=","TunnelID":"11111111-1111-4111-8111-111111111111"}' >"$secrets/cloudflare_tunnel_credentials.json"
      ;;
    invalid-secret)
      printf '%s' '{"AccountTag":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","TunnelSecret":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB=","TunnelID":"11111111-1111-4111-8111-111111111111"}' >"$secrets/cloudflare_tunnel_credentials.json"
      ;;
  esac
  expect_failure \
    "invalid Cloudflare credential: $cloudflare_case" \
    'fatal: cloudflare tunnel credentials'
done

make_fixture invalid-uploads-boolean
set_config UPLOADS_ENABLED yes
expect_failure \
  'non-literal uploads boolean' \
  'fatal: UPLOADS_ENABLED must be literal true or false'

make_fixture uploads-without-profile
set_config UPLOADS_ENABLED true
expect_failure \
  'uploads enabled without uploads profile' \
  'fatal: UPLOADS_ENABLED=true requires COMPOSE_PROFILES=uploads exactly'

make_fixture disabled-with-uploads-profile
set_config COMPOSE_PROFILES uploads
expect_failure \
  'uploads profile while uploads are disabled' \
  'fatal: UPLOADS_ENABLED=false requires COMPOSE_PROFILES to be empty'

make_fixture uploads-without-digest
set_config UPLOADS_ENABLED true
set_config COMPOSE_PROFILES uploads
expect_failure \
  'uploads profile without immutable ClamAV digest' \
  'fatal: CLAMAV_IMAGE must be pinned by sha256 digest when uploads are enabled'

make_fixture operations-without-bootstrap
set_config REQUIRE_BOOTSTRAP_ADMIN_SECRET true
expect_failure \
  'explicitly required bootstrap password is missing' \
  "fatal: required secret is missing: $secrets/bootstrap_admin_password" \
  operations

make_fixture bootstrap-present-without-requirement
add_bootstrap_secret
expect_failure \
  'bootstrap password present without explicit requirement' \
  'fatal: bootstrap_admin_password must be absent unless explicitly required'

make_fixture empty-bootstrap
set_config REQUIRE_BOOTSTRAP_ADMIN_SECRET true
add_bootstrap_secret ''
expect_failure \
  'explicitly required bootstrap password is empty' \
  "fatal: required secret is empty: $secrets/bootstrap_admin_password"

make_fixture whitespace-bootstrap
set_config REQUIRE_BOOTSTRAP_ADMIN_SECRET true
add_bootstrap_secret $' \t\n '
expect_failure \
  'explicitly required bootstrap password is only whitespace' \
  'fatal: bootstrap_admin_password must contain at least 16 non-whitespace characters'

make_fixture short-bootstrap
set_config REQUIRE_BOOTSTRAP_ADMIN_SECRET true
add_bootstrap_secret 'short password'
expect_failure \
  'explicitly required bootstrap password is too short' \
  'fatal: bootstrap_admin_password must contain at least 16 non-whitespace characters'

make_fixture invalid-bootstrap-requirement
set_config REQUIRE_BOOTSTRAP_ADMIN_SECRET yes
expect_failure \
  'non-literal bootstrap requirement flag' \
  'fatal: REQUIRE_BOOTSTRAP_ADMIN_SECRET must be literal true or false'

for image_variable in \
  APP_RUNTIME_IMAGE \
  APP_TOOLING_IMAGE \
  APP_WORKER_IMAGE \
  APP_REGRADE_WORKER_IMAGE \
  APP_PROJECT_REVIEW_WORKER_IMAGE \
  APP_SCANNER_WORKER_IMAGE \
  APP_OPERATIONS_IMAGE \
  POSTGRES_IMAGE \
  CLOUDFLARED_IMAGE; do
  make_fixture "non-digest-$image_variable"
  set_config "$image_variable" 'registry.example.test/codestead/image:latest'
  expect_failure \
    "non-digest $image_variable reference" \
    "fatal: $image_variable must be pinned by sha256 digest"
done

make_fixture digest-trailing-data
set_config APP_RUNTIME_IMAGE "registry.example.test/runtime@sha256:${digest_a}trailing"
expect_failure \
  'digest reference with trailing data' \
  'fatal: APP_RUNTIME_IMAGE must be pinned by sha256 digest'

make_fixture digest-empty-name
set_config APP_RUNTIME_IMAGE "@sha256:$digest_a"
expect_failure \
  'digest reference with an empty image name' \
  'fatal: APP_RUNTIME_IMAGE must be pinned by sha256 digest'

make_fixture invalid-validation-mode
expect_failure \
  'invalid caller validation mode' \
  'fatal: VALIDATION_MODE must be pilot or operations' \
  release

make_fixture invalid-mail-outbox-phase
set_config MAIL_OUTBOX_PHASE legacy-v0
expect_failure \
  'unreviewed mail outbox phase' \
  'fatal: MAIL_OUTBOX_PHASE and OUTBOX_WORKER_MODE do not name an allowed claimant pair'

make_fixture legacy-outbox-worker-mode
set_config OUTBOX_WORKER_MODE legacy-direct-v1
expect_failure \
  'legacy outbox worker mode' \
  'fatal: MAIL_OUTBOX_PHASE and OUTBOX_WORKER_MODE do not name an allowed claimant pair'

make_fixture google-secret-required
set_config GOOGLE_CLIENT_ID google-client-id.apps.example.test
expect_failure \
  'Google client ID without Google client secret' \
  "fatal: required secret is empty: $secrets/google_client_secret"

make_fixture gmail-secrets-required
set_config MAIL_ADAPTER gmail
set_config MAIL_FROM noreply@example.test
expect_failure \
  'Gmail adapter without Gmail client ID' \
  "fatal: required secret is empty: $secrets/gmail_client_id"

if grep -R -F -l --include='docker.log' "$secret_canary" "$work" >/dev/null 2>&1 ||
  grep -R -F -l --include='docker.log' "$database_canary" "$work" >/dev/null 2>&1; then
  echo 'FAIL: fake-Docker event logs captured secret or database connection material' >&2
  exit 1
fi

bash "$repo_root/infra/tests/cloudflare-runtime-config.test.sh"

echo 'runtime-config-tests-ok'
