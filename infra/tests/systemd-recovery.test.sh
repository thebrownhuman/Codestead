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
compose="$repo_root/compose.yaml"
compose_unit="$repo_root/infra/systemd/learncoding-compose.service"
retention_unit="$repo_root/infra/systemd/learncoding-retention.service"
recovery_service="$repo_root/infra/systemd/learncoding-recovery-check.service"
recovery_timer="$repo_root/infra/systemd/learncoding-recovery-check.timer"
firewall_service="$repo_root/infra/systemd/learncoding-runner-firewall.service"
installer="$repo_root/infra/ops/install-systemd.sh"
installer_shebang='#!/usr/bin/env bash'
installer_reviewed_sha256='7d5b66bdd81e339a8fe455c5d746f13369bc5c6ed0d5ceea99158f6f0ba5d01b'
package_json="$repo_root/package.json"
failures=()

fail() {
  failures+=("$1")
}

abort_contract() {
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



assert_source_identity_mutations() {
  local interpreter="$1" expected_shebang="$2"
  local safe_source="$parser_work/reviewed-source-safe.sh" mutated_source="$parser_work/reviewed-source-mutated.sh"
  local transformed="$parser_work/reviewed-source-transformed.sh" sentinel="$parser_work/reviewed-source.sentinel"
  local safe_sha256 label mutation
  printf '%s\n%s\n' "$expected_shebang" 'set -e' >"$safe_source"
  safe_sha256="$(sha256_file "$safe_source")" || abort_contract 'could not hash reviewed source mutation baseline'
  printf '%s' unchanged >"$sentinel"
  while IFS='|' read -r label mutation; do
    printf '%s\n%s\n%s\n%s\n' "$expected_shebang" 'set -e' "$mutation" \
      'printf reached >"$SOURCE_IDENTITY_SENTINEL"' >"$mutated_source"
    rm -f -- "$transformed"
    stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" &&
      abort_contract "reviewed source identity accepted $label mutation"
    [[ ! -e "$transformed" && "$(<"$sentinel")" == unchanged ]] || abort_contract "$label mutation escaped source verification"
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
  stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" && abort_contract 'accepted line-1 mutation'
  [[ ! -e "$transformed" && "$(<"$sentinel")" == unchanged ]] || abort_contract 'line-1 mutation escaped verification'
  printf '%s\n%s\n%s\n' "$expected_shebang" "$expected_shebang" 'set -e' >"$mutated_source"
  stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" && abort_contract 'accepted duplicate shebangs'
  printf '%s\r\n%s\r\n' "$expected_shebang" 'set -e' >"$mutated_source"
  stage_and_make_path_sealed_copy "$mutated_source" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" && abort_contract 'accepted CRLF source'
  rm -f -- "$parser_work/reviewed-source-symlink.sh"
  ln -s "$safe_source" "$parser_work/reviewed-source-symlink.sh"
  if [[ -L "$parser_work/reviewed-source-symlink.sh" ]]; then
    stage_and_make_path_sealed_copy "$parser_work/reviewed-source-symlink.sh" "$transformed" "$interpreter" "$expected_shebang" "$safe_sha256" && abort_contract 'accepted symlink source'
  fi
  rm -f -- "$parser_work/reviewed-source-symlink.sh"
}

assert_path_mutation_defenses() {
  local interpreter="$1"
  local mutation_source="$parser_work/path-mutation-source.sh"
  local sealed_mutation="$parser_work/path-mutation-sealed.sh"
  local mutation_bin="$parser_work/path-mutation-bin"
  local resolution="$parser_work/path-mutation-resolution"
  local sentinel="$parser_work/path-mutation-sentinel"
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
    source_manipulates_path "$mutation_source" || abort_contract "PATH static guard missed: $mutation"
    mutation_sha256="$(sha256_file "$mutation_source")" || abort_contract 'could not hash PATH mutation source'
    rm -f -- "$sealed_mutation" "$resolution"
    stage_and_make_path_sealed_copy "$mutation_source" "$sealed_mutation" "$interpreter" "#!$interpreter" "$mutation_sha256" ||
      abort_contract 'could not create reviewed PATH mutation copy'
    printf '%s' unchanged >"$sentinel"
    set +e
    "$env_bin" -i PATH="$mutation_bin" PATH_MUTATION_RESOLUTION="$resolution" \
      PATH_MUTATION_SENTINEL="$sentinel" "$interpreter" "$sealed_mutation" \
      >"$parser_work/path-mutation.stdout" 2>"$parser_work/path-mutation.stderr"
    mutation_status=$?
    set -e

    (( mutation_status != 0 )) || abort_contract "same-interpreter PATH mutation unexpectedly succeeded: $mutation"
    [[ ! -e "$resolution" ]] || abort_contract "PATH mutation resolved a host executable before rejection: $mutation"
    [[ "$(<"$sentinel")" == unchanged ]] || abort_contract "PATH mutation reached the outside sentinel: $mutation"
  done
}

systemd_syntax_is_canonical() {
  local file="$1"
  local line

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ -z "$line" ]]; then
      continue
    fi
    if [[ "$line" =~ ^[[:space:]] || "$line" =~ [[:space:]]$ ]]; then
      return 1
    fi
    if [[ "$line" == *\\* ]]; then
      return 1
    fi
    if [[ "$line" == \#* || "$line" == \;* ]]; then
      continue
    fi
    case "$line" in
      '[Unit]'|'[Service]'|'[Install]'|'[Timer]') continue ;;
    esac
    if [[ ! "$line" =~ ^[A-Za-z][A-Za-z0-9]*=([^[:space:]].*)?$ ]]; then
      return 1
    fi
  done <"$file"
}

directive_is_exact() {
  local file="$1"
  local expected_section="$2"
  local key="$3"
  local expected_value="$4"
  local section=
  local line
  local parsed_key
  local parsed_value
  local matches=0
  local correct=0

  if ! systemd_syntax_is_canonical "$file"; then
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ -z "$line" || "$line" == \#* || "$line" == \;* ]]; then
      continue
    fi
    case "$line" in
      '[Unit]') section=Unit; continue ;;
      '[Service]') section=Service; continue ;;
      '[Install]') section=Install; continue ;;
      '[Timer]') section=Timer; continue ;;
    esac
    parsed_key="${line%%=*}"
    parsed_value="${line#*=}"
    if [[ "$parsed_key" == "$key" ]]; then
      matches=$((matches + 1))
      if [[ "$section" == "$expected_section" && "$parsed_value" == "$expected_value" ]]; then
        correct=$((correct + 1))
      fi
    fi
  done <"$file"

  (( matches == 1 && correct == 1 ))
}

expect_directive() {
  local file="$1"
  local expected_section="$2"
  local key="$3"
  local expected_value="$4"
  local label="$5"

  if ! directive_is_exact "$file" "$expected_section" "$key" "$expected_value"; then
    fail "$label"
  fi
}

expect_mutation_rejected() {
  local file="$1"
  local expected_section="$2"
  local key="$3"
  local expected_value="$4"
  local label="$5"

  if directive_is_exact "$file" "$expected_section" "$key" "$expected_value"; then
    fail "$label"
  fi
}

expect_contains() {
  local file="$1"
  local expected="$2"
  local label="$3"

  if ! grep -Fq -- "$expected" "$file"; then
    fail "$label"
  fi
}

directive_contains_tokens() {
  local file="$1"
  local expected_section="$2"
  local key="$3"
  shift 3
  local -a required_tokens=("$@")
  local section=
  local line
  local parsed_key
  local parsed_value
  local token
  local required
  local matches=0

  systemd_syntax_is_canonical "$file" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -n "$line" && "$line" != \#* && "$line" != \;* ]] || continue
    case "$line" in
      '[Unit]') section=Unit; continue ;;
      '[Service]') section=Service; continue ;;
      '[Install]') section=Install; continue ;;
      '[Timer]') section=Timer; continue ;;
    esac
    parsed_key="${line%%=*}"
    parsed_value="${line#*=}"
    if [[ "$parsed_key" == "$key" ]]; then
      matches=$((matches + 1))
      [[ "$section" == "$expected_section" ]] || return 1
      for required in "${required_tokens[@]}"; do
        local found=false
        for token in $parsed_value; do
          if [[ "$token" == "$required" ]]; then found=true; break; fi
        done
        [[ "$found" == true ]] || return 1
      done
    fi
  done <"$file"

  (( matches == 1 ))
}

expect_directive_tokens() {
  local file="$1"
  local expected_section="$2"
  local key="$3"
  local label="$4"
  shift 4

  if ! directive_contains_tokens "$file" "$expected_section" "$key" "$@"; then
    fail "$label"
  fi
}

expect_required_file() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    fail "Required later-task production asset is missing: ${file#"$repo_root/"}"
    return 1
  fi
}

expect_canonical_systemd_file() {
  local file="$1"

  if ! systemd_syntax_is_canonical "$file"; then
    fail "Owned systemd file must use canonical physical syntax: ${file#"$repo_root/"}"
  fi
}

expect_canonical_systemd_file "$compose_unit"
expect_canonical_systemd_file "$retention_unit"
for canonical_timer in \
  "$repo_root/infra/systemd/learncoding-backup.timer" \
  "$repo_root/infra/systemd/learncoding-backup-check.timer" \
  "$repo_root/infra/systemd/learncoding-retention.timer"; do
  expect_canonical_systemd_file "$canonical_timer"
done

expect_directive \
  "$compose_unit" \
  Unit \
  RequiresMountsFor \
  '/opt/learncoding /etc/learncoding /srv/learncoding' \
  'Compose startup must require exactly the application, configuration, and primary data mounts'
expect_directive_tokens \
  "$compose_unit" Unit After \
  'Compose startup ordering must include Docker, network-online, local filesystems, libvirt, and the runner firewall' \
  docker.service network-online.target local-fs.target libvirtd.service learncoding-runner-firewall.service
expect_directive "$compose_unit" Unit Requires docker.service 'Compose startup must require Docker'
expect_directive_tokens \
  "$compose_unit" Unit Wants \
  'Compose startup must want network-online, libvirt, and the runner firewall' \
  network-online.target libvirtd.service learncoding-runner-firewall.service
expect_directive \
  "$compose_unit" \
  Service \
  ExecStartPre \
  '/usr/bin/bash /opt/learncoding/infra/ops/validate-runtime.sh' \
  'Compose startup must retain runtime preflight'
expect_directive \
  "$compose_unit" \
  Service \
  ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'Compose startup must use explicit inputs without building or pulling'
expect_directive \
  "$compose_unit" \
  Service \
  ExecStartPost \
  '/usr/bin/bash /opt/learncoding/infra/ops/smoke-production.sh --startup-wait 600' \
  'Compose startup must run the bounded production smoke check'
expect_directive \
  "$compose_unit" \
  Service \
  ExecReload \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'Compose reload must use explicit inputs without building or pulling'
expect_directive \
  "$compose_unit" \
  Service \
  ExecStop \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml down --remove-orphans' \
  'Compose stop must preserve durable volumes'
expect_directive "$compose_unit" Service Type oneshot 'Compose unit must remain Type=oneshot'
expect_directive "$compose_unit" Service RemainAfterExit yes 'Compose unit must remain active after startup'
expect_directive "$compose_unit" Service Restart on-failure 'Compose startup must retry transient failures'
expect_directive "$compose_unit" Service RestartSec 15s 'Compose startup must use the final 15-second recovery retry delay'
expect_directive "$compose_unit" Service TimeoutStartSec 15min 'Compose startup must retain its 15-minute start budget'
expect_directive "$compose_unit" Service TimeoutStopSec 5min 'Compose shutdown must use the final five-minute stop budget'
expect_directive \
  "$compose_unit" \
  Unit \
  OnFailure \
  'learncoding-alert@%n.service' \
  'Compose startup exhaustion must trigger the existing alert unit'
expect_directive \
  "$compose_unit" \
  Unit \
  StartLimitIntervalSec \
  15min \
  'Compose startup retries must use the basic 15-minute limit window'
expect_directive "$compose_unit" Unit StartLimitBurst 5 'Compose startup retries must be bounded to five attempts'
expect_directive "$compose_unit" Install WantedBy multi-user.target 'Compose unit must remain enabled at normal boot'

expect_directive \
  "$retention_unit" \
  Unit \
  After \
  learncoding-compose.service \
  'Retention must run after the trusted Compose stack'
expect_directive \
  "$retention_unit" \
  Unit \
  Requires \
  learncoding-compose.service \
  'Retention must require the trusted Compose stack'
expect_directive \
  "$retention_unit" \
  Service \
  ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml --profile operations run --rm --no-deps lifecycle' \
  'Retention must use explicit Compose inputs and the isolated lifecycle invocation'
if grep -Fq -- '2026-07-14.v4' "$retention_unit"; then
  fail 'Retention systemd unit must consume the versioned Compose lifecycle command instead of duplicating its token'
fi

command_items() {
  awk '
    $0 == "    command:" { in_command = 1; next }
    in_command && /^      - / { sub(/^      - /, ""); print; next }
    in_command { exit }
  '
}

expect_sequence() {
  local label="$1"
  local actual_name="$2"
  shift 2
  local -n actual="$actual_name"
  local -a expected=("$@")
  local index

  if (( ${#actual[@]} != ${#expected[@]} )); then
    fail "$label"
    return
  fi
  for index in "${!expected[@]}"; do
    if [[ "${actual[$index]}" != "${expected[$index]}" ]]; then
      fail "$label"
      return
    fi
  done
}

postgres_section="$(sed -n '/^  postgres:/,/^  migrate:/p' "$compose" | tr -d '\r')"
mapfile -t postgres_command < <(command_items <<<"$postgres_section")
expect_sequence \
  'PostgreSQL command must contain only the three enabled durability settings' \
  postgres_command \
  postgres -c fsync=on -c synchronous_commit=on -c full_page_writes=on

lifecycle_section="$(sed -n '/^  lifecycle:/,/^  platform-seed:/p' "$compose" | tr -d '\r')"
mapfile -t lifecycle_command < <(command_items <<<"$lifecycle_section")
expect_sequence \
  'Compose lifecycle command must be the exact canonical v4 apply command' \
  lifecycle_command \
  node --import tsx /app/scripts/data-lifecycle.ts retention --apply --confirm 2026-07-14.v4
expect_contains \
  "$package_json" \
  '"worker:retention": "tsx scripts/data-lifecycle.ts retention --apply --confirm 2026-07-14.v4"' \
  'package.json worker:retention must use canonical retention version 2026-07-14.v4'

for timer in \
  "$repo_root/infra/systemd/learncoding-backup.timer" \
  "$repo_root/infra/systemd/learncoding-backup-check.timer" \
  "$repo_root/infra/systemd/learncoding-retention.timer"; do
  if [[ ! -f "$timer" ]]; then
    fail "Required persistent timer is missing: ${timer#"$repo_root/"}"
    continue
  fi
  expect_directive \
    "$timer" Timer Persistent true \
    "Timer must contain exactly one effective Persistent=true in [Timer]: ${timer#"$repo_root/"}"
done

if expect_required_file "$firewall_service"; then
  expect_canonical_systemd_file "$firewall_service"
fi
if expect_required_file "$recovery_service"; then
  expect_canonical_systemd_file "$recovery_service"
  expect_directive_tokens \
    "$recovery_service" Unit After \
    'Recovery checker must run after the trusted Compose unit' \
    learncoding-compose.service
  expect_directive_tokens \
    "$recovery_service" Unit Wants \
    'Recovery checker must want Compose so it can still report Compose failure' \
    learncoding-compose.service
  if directive_contains_tokens "$recovery_service" Unit Requires learncoding-compose.service; then
    fail 'Recovery checker must not require Compose'
  fi
  expect_directive \
    "$recovery_service" Unit OnFailure 'learncoding-alert@%n.service' \
    'Recovery checker failure must trigger the existing alert unit'
  expect_directive "$recovery_service" Service Type oneshot 'Recovery checker must be a oneshot service'
  expect_directive "$recovery_service" Service User root 'Recovery checker must run explicitly as root'
  expect_directive "$recovery_service" Service Group root 'Recovery checker must run with the root group'
  expect_directive \
    "$recovery_service" Service ExecStart \
    '/usr/bin/bash /opt/learncoding/infra/ops/check-recovery.sh' \
    'Recovery checker must invoke the reviewed root script'
fi
if expect_required_file "$recovery_timer"; then
  expect_canonical_systemd_file "$recovery_timer"
  expect_directive "$recovery_timer" Timer OnBootSec 2m 'Recovery timer must first run two minutes after boot'
  expect_directive "$recovery_timer" Timer OnUnitActiveSec 15m 'Recovery timer must repeat every fifteen minutes'
  expect_directive "$recovery_timer" Timer Persistent true 'Recovery timer must remain persistent'
  expect_directive \
    "$recovery_timer" Timer Unit learncoding-recovery-check.service \
    'Recovery timer must explicitly activate the recovery service'
  expect_directive "$recovery_timer" Install WantedBy timers.target 'Recovery timer must be installable at boot'
fi

tmp_base="$(cd /tmp && pwd -P)"
parser_work="$(mktemp -d "$tmp_base/systemd-recovery-parser.XXXXXX")"
parser_work="$(cd "$parser_work" && pwd -P)"
if [[ -L "$parser_work" || "$parser_work" != "$tmp_base"/* ]]; then
  echo 'FAIL: systemd parser fixture escaped its verified temporary root' >&2
  exit 1
fi
chmod 0700 "$parser_work"
cleanup_parser_work() {
  if [[ -d "$parser_work" && ! -L "$parser_work" && "$parser_work" == "$tmp_base"/* ]]; then
    rm -rf -- "$parser_work"
  fi
}
trap cleanup_parser_work EXIT

source_staging_root="$parser_work"
initialize_source_stager || abort_contract 'could not initialize one-FD source stager'

installer_root="$parser_work/installer-root"
installer_fake_bin="$parser_work/installer-bin"
installer_events="$parser_work/installer-events.log"
installer_under_test="$parser_work/install-systemd.sh"
mkdir -m 0700 -p "$installer_root/infra/systemd" "$installer_fake_bin"
cp "$compose" "$installer_root/compose.yaml"
cp "$repo_root"/infra/systemd/* "$installer_root/infra/systemd/"

installer_root_guard='[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "run as root" >&2; exit 1; }'
installer_stage="$parser_work/install-systemd.reviewed.stage.sh"
stage_live_source_once "$installer" "$installer_stage" ||
  abort_contract 'could not open the Systemd installer exactly once with O_NOFOLLOW'
verify_exact_staged_shell_source "$installer_stage" "$bash_bin" "$installer_shebang" "$installer_reviewed_sha256" ||
  abort_contract 'Systemd installer staged identity, shebang, regular-file, LF, syntax, or SHA is not reviewed'
assert_source_identity_mutations "$bash_bin" "$installer_shebang"
assert_source_race_mutations "$bash_bin" "$installer_shebang" || abort_contract 'Systemd installer source race defenses failed'
if [[ "$(grep -Fxc -- "$installer_root_guard" "$installer_stage" || true)" != 1 ]]; then
  abort_contract 'Systemd installer must retain one explicit root execution guard'
fi
if source_manipulates_path "$installer_stage"; then
  abort_contract 'Systemd installer may not reference or mutate the harness-owned PATH'
fi
assert_path_mutation_defenses "$bash_bin"
if tail -n +2 "$installer_stage" | grep -Eq '/(usr/)?(s?bin|libexec)/[A-Za-z0-9_.+-]+'; then
  abort_contract 'Systemd installer hard-codes an executable path and can bypass the isolated fake PATH'
fi
if tail -n +2 "$installer_stage" | grep -Eq '\$BASH([^A-Za-z0-9_]|$)|\$\{BASH([^A-Za-z0-9_]|$)|(^|[;&|({])[[:space:]]*(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+|(^|[[:space:]])(if|then|while|until|do|else|!)[[:space:]]+(exec[[:space:]]+|command[[:space:]]+)?["'"'"']?/[A-Za-z0-9_.+/-]+'; then
  abort_contract 'Systemd installer can invoke an absolute executable or the ambient Bash interpreter outside the fake PATH'
fi
if tail -n +2 "$installer_stage" | grep -Eq 'command[[:space:]]+-p|enable[[:space:]]+-f|hash[[:space:]]+-p|/dev/(tcp|udp)/'; then
  abort_contract 'Systemd installer can bypass fake command lookup'
fi
unsafe_absolute_redirects="$(tail -n +2 "$installer_stage" | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
if [[ -n "$unsafe_absolute_redirects" ]]; then
  abort_contract 'Systemd installer redirects output to an absolute path other than /dev/null'
fi
redirect_prefix_probe="$(printf '%s\n' 'printf unsafe >/dev/null.evil' | sed -E 's#(>>?&?|>\|)[[:space:]]*["'"'"']?/dev/null["'"'"']?([;&|)}[:space:]]|$)#\2#g' | grep -E '(>>?&?|>\|)[[:space:]]*["'"'"']?/' || true)"
[[ -n "$redirect_prefix_probe" ]] || abort_contract 'Systemd redirect guard accepted a /dev/null prefix sibling'
if tail -n +2 "$installer_stage" | grep -Eq '(^|[;&|()[:space:]])(env|sh|bash|dash|zsh)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])(eval|source)([;&|()[:space:]]|$)|(^|[;&|()[:space:]])\.[[:space:]]+/'; then
  abort_contract 'Systemd installer can spawn or source an uninstrumented shell command'
fi
if tail -n +2 "$installer_stage" | grep -Eq '(^|[^<])<[[:space:]]*([^<(&]|$)'; then
  abort_contract 'Systemd installer contains an uninstrumented shell file read'
fi
installer_fake_commands=(basename install systemctl)
make_path_sealed_copy "$installer_stage" "$installer_under_test" "$bash_bin" "$installer_shebang" "$installer_reviewed_sha256" \
  "$installer_fake_bin" "${installer_fake_commands[@]}" || abort_contract 'could not create reviewed Systemd installer test copy'
grep -Fxq 'PATH=' "$installer_under_test" && grep -Fxq 'readonly PATH' "$installer_under_test" ||
  abort_contract 'Systemd installer test copy did not seal PATH before the SUT body'
installer_under_test_sha256="$(sha256_file "$installer_under_test")" || abort_contract 'could not hash transformed Systemd installer'
verify_exact_staged_shell_source "$installer_under_test" "$bash_bin" "#!$bash_bin" "$installer_under_test_sha256" ||
  abort_contract 'transformed Systemd installer identity is not verified'

printf '#!%s\n' "$bash_bin" >"$installer_fake_bin/fake-installer-command"
cat >>"$installer_fake_bin/fake-installer-command" <<'FAKE'
set -Eeuo pipefail

command_name="${0##*/}"
{
  printf '%q' "$command_name"
  for argument in "$@"; do printf ' %q' "$argument"; done
  printf '\n'
} >>"$INSTALLER_EVENTS"

unit_source_is_exact() {
  local source="$1"
  local name="${source##*/}"
  [[ "$source" == "$INSTALLER_ROOT/infra/systemd/$name" && -f "$source" && ! -L "$source" &&
    "$name" =~ ^learncoding-[A-Za-z0-9@_.-]+\.(service|timer)$ ]]
}

case "$command_name" in
  basename)
    [[ "$#" == 2 && "$1" == -- ]] || exit 64
    unit_source_is_exact "$2" || exit 97
    printf '%s\n' "${2##*/}"
    ;;
  install)
    [[ "$#" == 8 && "$1" == -o && "$2" == root && "$3" == -g && "$4" == root &&
      "$5" == -m && "$6" == 0644 ]] || exit 64
    unit_source_is_exact "$7" || exit 97
    [[ "$8" == "/etc/systemd/system/${7##*/}" ]] || exit 97
    ;;
  systemctl)
    if [[ "$#" == 1 && "$1" == daemon-reload ]]; then :
    elif [[ "$#" == 3 && "$1" == enable && "$2" == --now &&
      ( "$3" == learncoding-runner-firewall.service || "$3" == learncoding-compose.service ||
        "$3" == learncoding-recovery-check.timer ) ]]; then :
    elif [[ "$#" == 5 && "$1" == enable && "$2" == --now &&
      "$3" == learncoding-backup.timer && "$4" == learncoding-backup-check.timer &&
      "$5" == learncoding-retention.timer ]]; then :
    else
      exit 64
    fi
    ;;
  *) exit 64 ;;
esac
FAKE
chmod 0555 "$installer_fake_bin/fake-installer-command"
for command_name in basename install systemctl; do
  cp "$installer_fake_bin/fake-installer-command" "$installer_fake_bin/$command_name"
done
chmod 0555 "$installer_fake_bin"/*
fake_installer_sha256="$(sha256_file "$installer_fake_bin/fake-installer-command")" || abort_contract 'could not hash strict installer fake command'
for command_name in "${installer_fake_commands[@]}"; do
  verify_exact_staged_shell_source "$installer_fake_bin/$command_name" "$bash_bin" "#!$bash_bin" "$fake_installer_sha256" ||
    abort_contract "installer fake command identity is not verified: $command_name"
done

: >"$installer_events"
installer_outside_sentinel="$parser_work/installer-outside.sentinel"
printf '%s' 'outside-fixture-sentinel-unchanged' >"$installer_outside_sentinel"
set +e
for rejected_installer_action in \
  'disable --now learncoding-compose.service' \
  'mask learncoding-compose.service' \
  'enable --now learncoding-restore-drill.service'; do
  read -r -a rejected_installer_argv <<<"$rejected_installer_action"
  "$env_bin" -i PATH="$installer_fake_bin" INSTALLER_EVENTS="$installer_events" \
    INSTALLER_ROOT="$installer_root" "$installer_fake_bin/systemctl" "${rejected_installer_argv[@]}" \
    >"$parser_work/rejected-installer.stdout" 2>"$parser_work/rejected-installer.stderr"
  rejected_installer_status=$?
  if (( rejected_installer_status == 0 )); then
    set -e
    fail "Systemd installer fake accepted unsafe action: $rejected_installer_action"
    break
  fi
done
set -e

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
    ! assert_exact_resource_limits "${candidate[@]}" || abort_contract "resource mutation gate accepted $missing_label"
    candidate=(); for token in "${resource_limit_args[@]}"; do [[ "$token" == "$target" ]] && candidate+=("$weakened") || candidate+=("$token"); done
    ! assert_exact_resource_limits "${candidate[@]}" || abort_contract "resource mutation gate accepted $weakened_label"
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
  ! assert_exact_resource_limits "${candidate[@]}" || abort_contract 'resource mutation gate accepted duplicate-resource-limit'
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
assert_exact_resource_limits "${resource_limit_args[@]}" || abort_contract 'canonical resource-limit vector is not exact'

assert_containment_gate_mutations() {
  local sentinel="$parser_work/containment-gate.sentinel" rejected="$parser_work/rejected-bwrap"
  local candidate="$parser_work/containment-candidate" status
  printf '%s' unchanged >"$sentinel"
  printf '#!%s\n%s\n' "$bash_bin" 'exit 77' >"$rejected"
  printf '#!%s\nprintf reached >%q\n' "$bash_bin" "$sentinel" >"$candidate"
  chmod 0700 "$rejected" "$candidate"
  verify_fixed_outer_binary "$parser_work/missing-bwrap" true && abort_contract 'missing Bubblewrap dependency was accepted'
  set +e
  "$env_bin" -i PATH= "$rejected" --unshare-user --unshare-pid --unshare-net -- "$candidate" >/dev/null 2>&1
  status=$?
  set -e
  [[ "$status" == 77 && "$(<"$sentinel")" == unchanged ]] || abort_contract 'rejected containment reached installer sentinel'
}

prepare_linux_containment() {
  local entry="$parser_work/namespace-entry.sh"
  local outside="/tmp/learncoding-systemd-installer-outside-$$" binary probe_status preflight_ro_probes
  [[ "$(/usr/bin/uname -s 2>/dev/null || true)" == Linux && "$EUID" == 0 ]] ||
    abort_contract 'authoritative Systemd installer contract requires Ubuntu/Linux root with Bubblewrap user/mount/PID/network containment'
  for binary in /usr/bin/stat /usr/bin/uname /usr/bin/bash /usr/bin/env /usr/bin/sha256sum \
    /usr/bin/timeout /usr/bin/prlimit /usr/bin/setpriv /usr/bin/ldd; do
    verify_fixed_outer_binary "$binary" false || abort_contract "containment dependency is not fixed root-owned and non-writable: $binary"
  done
  verify_fixed_outer_binary /usr/bin/bwrap true ||
    abort_contract '/usr/bin/bwrap must be a regular root-owned non-writable authoritative test dependency'
  containment_probe_dir="$parser_work/containment-output-probe"
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
if [[ "${CONTAINMENT_EXPECT_REGULAR_OUTPUTS:-0}" == 1 ]]; then [[ -f /proc/self/fd/1 && -f /proc/self/fd/2 ]] || exit 98; fi
exec "$@"
EOF
  } >"$entry"
  chmod 0500 "$entry"
  containment_entry="$entry"
  containment_entry_sha256="$(sha256_file "$entry")" || abort_contract 'could not hash namespace entry'
  verify_exact_staged_shell_source "$entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" || abort_contract 'namespace entry identity is not verified'
  prepare_minimal_runtime_mounts /usr/bin/bash || abort_contract 'could not assemble the minimal installer runtime'
  containment_ro_mounts=(
    --ro-bind "$entry" "$entry"
    --ro-bind "$installer_under_test" "$installer_under_test"
    --ro-bind "$installer_fake_bin" "$installer_fake_bin"
    --ro-bind "$installer_root" "$installer_root"
  )
  containment_rw_mounts=(--bind "$containment_probe_dir" "$containment_probe_dir")
  installer_execution_rw_mounts=(--bind "$installer_events" "$installer_events")
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
  preflight_ro_probes="$entry:$installer_under_test:$installer_fake_bin:$installer_root"
  set +e
  /usr/bin/env -i PATH= HOME="$containment_probe_dir" CONTAINMENT_RO_PROBES="$preflight_ro_probes" \
    "${containment_command[@]}" /usr/bin/bash -c ':' >/dev/null 2>"$parser_work/containment-preflight.stderr"
  probe_status=$?
  set -e
  (( probe_status == 0 )) || abort_contract 'Bubblewrap containment preflight or mandatory user namespace was rejected'
  [[ -f "$containment_probe_dir/.namespace-write-probe" && ! -e "$outside" ]] || abort_contract 'containment did not prove fixture-only writes'
}

assert_installer_execution_identity() {
  local command_name
  verify_exact_staged_shell_source "$installer_stage" "$bash_bin" "$installer_shebang" "$installer_reviewed_sha256" || abort_contract 'installer source stage changed after transformation'
  verify_exact_staged_shell_source "$installer_under_test" "$bash_bin" "#!$bash_bin" "$installer_under_test_sha256" || abort_contract 'transformed installer changed before execution'
  verify_exact_staged_shell_source "$containment_entry" /usr/bin/bash '#!/usr/bin/bash' "$containment_entry_sha256" || abort_contract 'namespace entry changed before execution'
  for command_name in "${installer_fake_commands[@]}"; do
    verify_exact_staged_shell_source "$installer_fake_bin/$command_name" "$bash_bin" "#!$bash_bin" "$fake_installer_sha256" || abort_contract "installer fake changed before execution: $command_name"
  done
  verify_fixed_outer_binary /usr/bin/bwrap true || abort_contract 'Bubblewrap changed before installer execution'
  verify_fixed_outer_binary /usr/bin/ldd true || abort_contract 'ldd changed before installer execution'
  assert_exact_resource_limits "${resource_limit_args[@]}" || abort_contract 'resource-limit vector changed before installer execution'
  prepare_minimal_runtime_mounts /usr/bin/bash || abort_contract 'minimal installer runtime changed before execution'
}

assert_containment_gate_mutations
prepare_linux_containment
assert_installer_execution_identity
: >"$installer_events"
execution_containment=()
for containment_token in "${containment_command[@]}"; do
  if [[ "$containment_token" == --proc ]]; then execution_containment+=("${installer_execution_rw_mounts[@]}"); fi
  execution_containment+=("$containment_token")
done
installer_ro_probes="$containment_entry:$installer_under_test:$installer_fake_bin:$installer_root"
set +e
/usr/bin/env -i HOME="$containment_probe_dir" PATH= REPO_ROOT="$installer_root" \
  INSTALLER_EVENTS="$installer_events" INSTALLER_ROOT="$installer_root" \
  CONTAINMENT_RO_PROBES="$installer_ro_probes" CONTAINMENT_EXPECT_REGULAR_OUTPUTS=1 \
  "${execution_containment[@]}" /usr/bin/bash "$installer_under_test" --enable \
  >"$parser_work/installer.stdout" 2>"$parser_work/installer.stderr"
installer_status=$?
set -e
[[ "$(<"$installer_outside_sentinel")" == 'outside-fixture-sentinel-unchanged' ]] ||
  fail 'Systemd installer modified the outside-fixture sentinel'
if (( installer_status != 0 )); then
  fail "Systemd installer did not execute inside the strict fake root: $(<"$parser_work/installer.stderr")"
else
  expected_installer_events=()
  for unit in "$installer_root"/infra/systemd/*; do
    printf -v basename_event 'basename -- %q' "$unit"
    expected_installer_events+=("$basename_event")
    printf -v install_event 'install -o root -g root -m 0644 %q %q' \
      "$unit" "/etc/systemd/system/${unit##*/}"
    expected_installer_events+=("$install_event")
  done
  expected_installer_events+=(
    'systemctl daemon-reload'
    'systemctl enable --now learncoding-runner-firewall.service'
    'systemctl enable --now learncoding-compose.service'
    'systemctl enable --now learncoding-recovery-check.timer'
    'systemctl enable --now learncoding-backup.timer learncoding-backup-check.timer learncoding-retention.timer'
  )
  mapfile -t actual_installer_events <"$installer_events"
  expect_sequence \
    'Systemd installer must behaviorally publish every mapped unit, reload, and enable only the reviewed ordered automatic set' \
    actual_installer_events "${expected_installer_events[@]}"
  if grep -Eq '^systemctl (disable|mask)|^systemctl .*learncoding-restore-drill\.service' "$installer_events"; then
    fail 'Systemd installer behavior must never disable, mask, or enable the restore drill'
  fi
fi

installer_loop_count="$(grep -Fxc 'for unit in "$repo_root"/infra/systemd/*; do' "$installer_stage" || true)"
installer_publish_count="$(grep -Fxc '  install -o root -g root -m 0644 "$unit" "/etc/systemd/system/$(basename -- "$unit")"' "$installer_stage" || true)"
if [[ "$installer_loop_count" != 1 || "$installer_publish_count" != 1 ]]; then
  fail 'Systemd installer must publish every owned unit exactly once as root:root mode 0644'
fi
required_enable_units=(
  learncoding-runner-firewall.service
  learncoding-compose.service
  learncoding-recovery-check.timer
  learncoding-backup.timer
  learncoding-backup-check.timer
  learncoding-retention.timer
)
actual_enable_units=()
while IFS= read -r enable_line || [[ -n "$enable_line" ]]; do
  enable_line="${enable_line%$'\r'}"
  trimmed_enable_line="${enable_line#"${enable_line%%[![:space:]]*}"}"
  [[ -n "$trimmed_enable_line" && "$trimmed_enable_line" != \#* ]] || continue
  if [[ ! "$trimmed_enable_line" =~ systemctl[[:space:]]+enable([[:space:]]|$) ]]; then continue; fi
  [[ "$enable_line" =~ ^[[:space:]]*systemctl[[:space:]]+enable[[:space:]]+--now[[:space:]]+ ]] || {
    fail 'Systemd installer contains a non-canonical enable command'
    continue
  }
  read -r -a enable_words <<<"$enable_line"
  [[ "${enable_words[0]:-}" == systemctl && "${enable_words[1]:-}" == enable && "${enable_words[2]:-}" == --now ]] || {
    fail 'Systemd installer contains a non-canonical enable command'
    continue
  }
  for enabled_unit in "${enable_words[@]:3}"; do actual_enable_units+=("$enabled_unit"); done
done <"$installer_stage"
if (( ${#actual_enable_units[@]} != ${#required_enable_units[@]} )); then
  fail 'Systemd installer must enable exactly the reviewed automatic units'
else
  for required_unit in "${required_enable_units[@]}"; do
    count=0
    for enabled_unit in "${actual_enable_units[@]}"; do [[ "$enabled_unit" == "$required_unit" ]] && count=$((count + 1)); done
    (( count == 1 )) || fail "Systemd installer must enable exactly once: $required_unit"
  done
fi
for enabled_unit in "${actual_enable_units[@]}"; do
  [[ "$enabled_unit" != learncoding-restore-drill.service ]] || fail 'Systemd installer must never enable the manual restore-drill service'
done

mutated_compose_unit="$parser_work/learncoding-compose.service"
mutated_timer="$parser_work/learncoding-backup.timer"
comment_mutated_compose_unit="$parser_work/comment-override-compose.service"
comment_mutated_timer="$parser_work/comment-override-backup.timer"
spaced_section_unit="$parser_work/spaced-section.service"
padded_assignment_unit="$parser_work/padded-assignment.service"
trailing_whitespace_unit="$parser_work/trailing-whitespace.service"
odd_backslash_unit="$parser_work/odd-backslash.service"
even_backslash_unit="$parser_work/even-backslash.service"
standalone_comment_backslash_unit="$parser_work/standalone-comment-backslash.service"
hidden_exec_unit="$parser_work/hidden-exec.service"
hidden_restart_unit="$parser_work/hidden-restart.service"
hidden_persistent_timer="$parser_work/hidden-persistent.timer"
unterminated_restart_unit="$parser_work/unterminated-restart.service"
unterminated_persistent_timer="$parser_work/unterminated-persistent.timer"
cp "$compose_unit" "$mutated_compose_unit"
cp "$repo_root/infra/systemd/learncoding-backup.timer" "$mutated_timer"
cp "$compose_unit" "$comment_mutated_compose_unit"
cp "$repo_root/infra/systemd/learncoding-backup.timer" "$comment_mutated_timer"
printf '%s\n' \
  '' \
  ' [Service]' \
  ' ExecStart = /usr/bin/docker compose \' \
  '   --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build' \
  ' ExecReload = /usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build' \
  ' ExecStop = /usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml down --volumes' \
  ' Restart = no' >>"$mutated_compose_unit"
printf '%s\n' '' ' [Timer]' ' Persistent = false' >>"$mutated_timer"
printf '%s\n' \
  '' \
  ' [Service]' \
  '# harmless recovery comment \' \
  ' ExecReload = /usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build' \
  ' ; harmless restart comment \' \
  ' Restart = no' >>"$comment_mutated_compose_unit"
printf '%s\n' \
  '' \
  ' [Timer]' \
  '# harmless timer comment \' \
  ' Persistent = false' >>"$comment_mutated_timer"
printf '%s\n' \
  '[ Service ]' \
  'ExecStart=/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' >"$spaced_section_unit"
printf '%s\n' \
  '[Service]' \
  ' ExecStart = /usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' >"$padded_assignment_unit"
printf '%s\n' \
  '[Service] ' \
  'ExecStart=/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans ' >"$trailing_whitespace_unit"
printf '%s\n' \
  '[Service]' \
  'Restart=on-failure\   ' >"$odd_backslash_unit"
printf '%s\n' \
  '[Service]' \
  'Restart=on-failure\\   ' >"$even_backslash_unit"
printf '%s\n' \
  '[Service]' \
  '# standalone comment backslash \' \
  'Restart=on-failure' >"$standalone_comment_backslash_unit"
cp "$compose_unit" "$hidden_exec_unit"
printf '%s\n' \
  '' \
  '[Service]' \
  'Description=noncanonical continuation \' \
  '# ignored comment block' \
  'ExecStart=/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --build' >>"$hidden_exec_unit"
cp "$compose_unit" "$hidden_restart_unit"
printf '%s\n' \
  '' \
  '[Service]' \
  'Description=noncanonical continuation \' \
  '; ignored comment block' \
  'Restart=no' >>"$hidden_restart_unit"
cp "$repo_root/infra/systemd/learncoding-backup.timer" "$hidden_persistent_timer"
printf '%s\n' \
  '' \
  '[Timer]' \
  'Description=noncanonical continuation \' \
  '# ignored comment block' \
  'Persistent=false' >>"$hidden_persistent_timer"
cp "$compose_unit" "$unterminated_restart_unit"
printf '%s' $'\n[Service]\nRestart=no' >>"$unterminated_restart_unit"
cp "$repo_root/infra/systemd/learncoding-backup.timer" "$unterminated_persistent_timer"
printf '%s' $'\n[Timer]\nPersistent=false' >>"$unterminated_persistent_timer"

expect_mutation_rejected \
  "$spaced_section_unit" Service ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser accepted a section header with internal padding'
expect_mutation_rejected \
  "$padded_assignment_unit" Service ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser accepted leading and around-equals assignment whitespace'
expect_mutation_rejected \
  "$trailing_whitespace_unit" Service ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser accepted trailing physical-line whitespace'
expect_mutation_rejected \
  "$odd_backslash_unit" Service Restart on-failure \
  'systemd parser accepted an odd trailing backslash followed by spaces'
expect_mutation_rejected \
  "$even_backslash_unit" Service Restart 'on-failure\' \
  'systemd parser accepted even trailing backslashes followed by spaces'
expect_mutation_rejected \
  "$standalone_comment_backslash_unit" Service Restart on-failure \
  'systemd parser accepted a standalone comment containing a backslash'
expect_mutation_rejected \
  "$hidden_exec_unit" Service ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser hid an unsafe ExecStart after a continuation/comment block'
expect_mutation_rejected \
  "$hidden_restart_unit" Service Restart on-failure \
  'systemd parser hid an unsafe Restart after a continuation/comment block'
expect_mutation_rejected \
  "$hidden_persistent_timer" Timer Persistent true \
  'systemd parser hid an unsafe Persistent value after a continuation/comment block'
expect_mutation_rejected \
  "$unterminated_restart_unit" Service Restart on-failure \
  'systemd parser skipped an unsafe unterminated final Restart directive'
expect_mutation_rejected \
  "$unterminated_persistent_timer" Timer Persistent true \
  'systemd parser skipped an unsafe unterminated final Persistent directive'

expect_mutation_rejected \
  "$mutated_compose_unit" Service ExecStart \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser accepted a whitespace-indented continued ExecStart build override'
expect_mutation_rejected \
  "$mutated_compose_unit" Service ExecReload \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser accepted a whitespace-around-equals ExecReload build override'
expect_mutation_rejected \
  "$mutated_compose_unit" Service ExecStop \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml down --remove-orphans' \
  'systemd parser accepted a whitespace-around-equals volume-removing ExecStop override'
expect_mutation_rejected \
  "$mutated_compose_unit" Service Restart on-failure \
  'systemd parser accepted a whitespace-around-equals Restart override'
expect_mutation_rejected \
  "$mutated_timer" Timer Persistent true \
  'systemd parser accepted a whitespace-around-equals Persistent override'
expect_mutation_rejected \
  "$comment_mutated_compose_unit" Service ExecReload \
  '/usr/bin/docker compose --env-file /etc/learncoding/compose.env -f /opt/learncoding/compose.yaml up -d --no-build --pull never --remove-orphans' \
  'systemd parser accepted an ExecReload build override after a backslash comment'
expect_mutation_rejected \
  "$comment_mutated_compose_unit" Service Restart on-failure \
  'systemd parser accepted a Restart override after a backslash semicolon comment'
expect_mutation_rejected \
  "$comment_mutated_timer" Timer Persistent true \
  'systemd parser accepted a Persistent override after a backslash comment'
if (( ${#failures[@]} > 0 )); then
  echo 'systemd recovery contract failed:' >&2
  for failure in "${failures[@]}"; do
    printf -- '- %s\n' "$failure" >&2
  done
  exit 1
fi

echo 'systemd-recovery-tests-ok'
