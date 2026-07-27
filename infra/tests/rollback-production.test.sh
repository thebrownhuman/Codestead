#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
rollback="$repo_root/infra/ops/rollback-production.sh"
release="$repo_root/infra/ops/release-production.sh"
fixture_generator="$repo_root/infra/tests/fixtures/create-release-tree-fixture.py"
ingress_control_script="$repo_root/infra/ops/ingress-control.py"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
[[ "$EUID" == 0 ]] || fail "release and rollback behavioral tests require root"
chmod 0700 "$work"
[[ ! -L "$work" && -d "$work" ]] || fail "test temporary root is not a real directory"
[[ "$(stat -c '%u:%a' -- "$work")" == "0:700" ]] || {
  fail "test temporary root is not private and root-owned"
}
[[ -z "${GIT_CONFIG_COUNT+x}" && -z "${GIT_CONFIG_PARAMETERS+x}" ]] || {
  fail "ambient Git configuration injection is forbidden"
}
source_git_config="$work/source-git.config"
(
  umask 077
  : >"$source_git_config"
)
[[ ! -L "$source_git_config" && -f "$source_git_config" ]] || {
  fail "source Git configuration is not a regular file"
}
[[ "$(stat -c '%u:%a' -- "$source_git_config")" == "0:600" ]] || {
  fail "source Git configuration is not private and root-owned"
}
export GIT_CONFIG_GLOBAL="$source_git_config"
export GIT_CONFIG_NOSYSTEM=1
git config --file "$source_git_config" --add safe.directory "$repo_root" || {
  fail "unable to trust the exact source repository"
}
mapfile -t source_safe_directories < <(
  git config --file "$source_git_config" --get-all safe.directory
)
[[ "${#source_safe_directories[@]}" == 1 \
  && "${source_safe_directories[0]}" == "$repo_root" ]] || {
  fail "source Git configuration does not contain only the exact repository"
}

mkdir -p "$work/bin" "$work/repo/infra/ops" "$work/repo/infra/runner-vm" \
  "$work/runtime-state" "$work/records/20260719T000000Z-1" "$work/records/20260719T000000Z-2"
chmod 0750 "$work/runtime-state"
touch "$work/repo/compose.yaml" "$work/compose.env"
printf '%s\n' 'APP_URL=https://pilot.example.test' >"$work/compose.env"
printf '%s\n' 'reviewed host firewall fixture' >"$work/repo/infra/runner-vm/host-runner.nft"
cp "$repo_root/infra/ops/package-release-tree.py" "$work/repo/infra/ops/package-release-tree.py"
cp "$ingress_control_script" "$work/repo/infra/ops/ingress-control.py"
chmod 0755 "$work/repo/infra/ops/package-release-tree.py"
chmod 0755 "$work/repo/infra/ops/ingress-control.py"
cat >"$work/repo/.gitignore" <<'EOF'
/RELEASE.SHA256SUMS
/dist
/services/runner/dist
EOF
git -C "$work/repo" init -q
git -C "$work/repo" config user.name 'Codestead rollback test'
git -C "$work/repo" config user.email 'rollback-test@codestead.invalid'
git -C "$work/repo" config core.autocrlf false
git -C "$work/repo" remote add origin https://github.com/example/codestead
git -C "$work/repo" add .gitignore compose.yaml infra/ops/package-release-tree.py infra/ops/ingress-control.py infra/runner-vm/host-runner.nft
git -C "$work/repo" commit -qm 'fixture rollback checkout'
retention_boundary_commit=18b2366db1347d7328d1ae85d7ee285c0fae4e5d
retention_boundary_tree=2fd3e0b2c4fe6bceb3a70755e2b4b951ada0fbed
dispatch_binding_boundary_commit=b73788a4b4d213e6423d737050b9e14c6a5d91b5
dispatch_binding_capability_path=infra/ops/mail-outbox-dispatch-binding-capability.env
dispatch_binding_capability_blob=ea707715f84608b1e1a33ac1832d533b878b6c07
dispatch_binding_runtime_capability=exact-adapter-payload-sha256-before-provider-call-v1
dispatch_binding_privilege_contract=owner-execute-worker-columns-update-only-no-grant-option-trigger-v1
dispatch_binding_registry_row="0064_mail_outbox_dispatch_binding|$dispatch_binding_boundary_commit|$dispatch_binding_capability_path|100644|$dispatch_binding_capability_blob|SCHEMA_VERSION=1|OUTBOX_WORKER_MODE=fenced-postgres-v1|DISPATCH_BINDING_RUNTIME=$dispatch_binding_runtime_capability|DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract"
guarded_delivery_boundary_commit=7eeafd73c5d41ea49526d908165e0a7cefa92097
guarded_delivery_capability_path=infra/ops/mail-outbox-guarded-delivery-capability.env
guarded_delivery_capability_blob=2b0cd7af4b6d7a39756e94485aa370abfb6e2acf
guarded_delivery_redaction_migration_path=drizzle/0068_mail_outbox_quarantine_redaction_authority_v2.sql
guarded_delivery_redaction_migration_blob=1188c910c5f89c902110349a1fc7564c6c9b1bfd
guarded_delivery_migration_path=drizzle/0069_mail_outbox_guarded_delivery_authority.sql
guarded_delivery_migration_blob=a957b7b13445fee8174677c69e7cedb542d74eee
guarded_delivery_runtime_capability=guarded-prepared-dispatch-tx1-tx2-exact-byte-v1
delivery_release_authority_contract=append-only-task7-release-receipt-v1
guarded_delivery_privilege_contract=owner-app-worker-release-receipt-least-privilege-v1
guarded_delivery_registry_row="0069_mail_outbox_guarded_delivery_authority|$guarded_delivery_boundary_commit|$guarded_delivery_capability_path|100644|$guarded_delivery_capability_blob|SCHEMA_VERSION=1|OUTBOX_WORKER_MODE=fenced-postgres-v1|GUARDED_DELIVERY_RUNTIME=$guarded_delivery_runtime_capability|DELIVERY_RELEASE_AUTHORITY=$delivery_release_authority_contract|GUARDED_DELIVERY_PRIVILEGE=$guarded_delivery_privilege_contract"
contract_required_commit=abe2a67ad20215bff64317182cc306b3329e5bed
contract_required_tree=6cf35f3a88e373e9cba13647d7be01265d21e0da
pre_contract_commit=c893132eb4f2778575d566957cbdb55626efc1fa
pre_contract_tree=908c86c0e5413fe2957fef119ab7946d4da2087f
older_pre_contract_commit=29cb5434ff816e2657c7c16c8359650b70f782b3
older_pre_contract_tree=ca3b8e5f61c1db0a7b42f0fdea791bd7c282aa67
pre_retention_commit=9ec43e87cc786ea73c0cd4eed3e7b9638e2cde89
pre_retention_tree=354bf1afe68f0e35582a52e5d9eebaf65be104c5
older_pre_retention_commit=6a0220b0c2ca9931461f59960282773daa0457a9
older_pre_retention_tree=99ce219eee07992a3dde57fa0a9895e9b770dce3
for capability_consumer in "$release" "$rollback"; do
  grep -Fq "$dispatch_binding_registry_row" "$capability_consumer" || {
    fail "release and rollback must share the exact pinned capability registry row"
  }
  grep -Fq "readonly mail_outbox_dispatch_binding_capability_blob=$dispatch_binding_capability_blob" \
    "$capability_consumer" || fail "capability consumer does not pin the reviewed Git blob"
  grep -Fq "$guarded_delivery_registry_row" "$capability_consumer" || {
    fail "release and rollback must share the exact pinned 0069 capability registry row"
  }
  grep -Fq "readonly mail_outbox_guarded_delivery_capability_blob=$guarded_delivery_capability_blob" \
    "$capability_consumer" || fail "capability consumer does not pin the reviewed 0069 Git blob"
done
grep -Fq "load_dispatch_binding_capability \"\$record_git_commit\" \"\$record_git_tree\" \"source image\"" \
  "$rollback" || fail "rollback capability is not bound to the recorded source tree"
grep -Fq "load_dispatch_binding_capability \"\$previous_git_commit\" \"\$previous_git_tree\" \"previous image\"" \
  "$rollback" || fail "rollback capability is not bound to the previous Git tree"
grep -Fq "load_guarded_delivery_capability \"\$record_git_commit\" \"\$record_git_tree\" \"source image\"" \
  "$rollback" || fail "guarded rollback capability is not bound to the recorded source tree"
grep -Fq "load_guarded_delivery_capability \"\$previous_git_commit\" \"\$previous_git_tree\" \"previous image\"" \
  "$rollback" || fail "guarded rollback capability is not bound to the previous Git tree"

declare -a source_git
if source_git_dir="$(
  git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null
)"; then
  source_git=(git -C "$repo_root")
else
  if ! command -v git.exe >/dev/null || ! command -v wslpath >/dev/null; then
    fail "source Git repository is unavailable"
  fi
  source_repo_windows="$(wslpath -w "$repo_root")"
  source_git=(git.exe -C "$source_repo_windows")
  source_git_dir_windows="$(
    "${source_git[@]}" rev-parse --path-format=absolute --git-common-dir | tr -d '\r'
  )"
  source_git_dir="$(wslpath -u "$source_git_dir_windows")"
fi
source_git_dir="$(realpath -e -- "$source_git_dir")" || {
  fail "source Git directory is unavailable"
}
[[ -d "$source_git_dir" ]] || fail "source Git directory is unavailable"
git config --file "$source_git_config" --add safe.directory "$source_git_dir" || {
  fail "unable to trust the exact source Git directory"
}
mapfile -t source_safe_directories < <(
  git config --file "$source_git_config" --get-all safe.directory
)
[[ "${#source_safe_directories[@]}" == 2 \
  && "${source_safe_directories[0]}" == "$repo_root" \
  && "${source_safe_directories[1]}" == "$source_git_dir" ]] || {
  fail "source Git configuration is not the exact closed trust set"
}
dispatch_binding_real_source_commit="$(
  "${source_git[@]}" rev-parse --verify \
    '76d2854b537aa9165083074e1c841f4f18ed84ce^{commit}' | tr -d '\r'
)"
dispatch_binding_real_source_tree="$(
  "${source_git[@]}" rev-parse --verify \
    "${dispatch_binding_real_source_commit}^{tree}" | tr -d '\r'
)"
dispatch_binding_real_capability_entry="$(
  "${source_git[@]}" ls-tree "$dispatch_binding_real_source_tree" -- \
    "$dispatch_binding_capability_path" | tr -d '\r'
)"
[[ "$dispatch_binding_real_capability_entry" == "100644 blob $dispatch_binding_capability_blob"$'\t'"$dispatch_binding_capability_path" ]] || {
  fail "the real source tree does not contain the exact reviewed 0064 capability blob"
}
dispatch_binding_real_target_commit=""
while IFS= read -r candidate_commit; do
  candidate_commit="${candidate_commit//$'\r'/}"
  candidate_tree="$(
    "${source_git[@]}" rev-parse --verify "${candidate_commit}^{tree}" | tr -d '\r'
  )"
  candidate_capability_entry="$(
    "${source_git[@]}" ls-tree "$candidate_tree" -- \
      "$dispatch_binding_capability_path" | tr -d '\r'
  )"
  if [[ "$candidate_capability_entry" == "100644 blob $dispatch_binding_capability_blob"$'\t'"$dispatch_binding_capability_path" ]]; then
    dispatch_binding_real_target_commit="$candidate_commit"
    dispatch_binding_real_target_tree="$candidate_tree"
    break
  fi
done < <("${source_git[@]}" rev-list --first-parent \
  "${dispatch_binding_real_source_commit}^")
[[ -n "$dispatch_binding_real_target_commit" ]] || {
  fail "the real source lineage lacks two reviewed post-0064 capability trees"
}
"${source_git[@]}" merge-base --is-ancestor \
  "$dispatch_binding_boundary_commit" "$dispatch_binding_real_target_commit" || {
  fail "the real capability target does not descend from the 0064 boundary"
}
source_ref="$(
  "${source_git[@]}" for-each-ref --contains "$retention_boundary_commit" \
    --format='%(refname)' refs/heads refs/remotes | tr -d '\r' | sed -n '1p'
)"
[[ "$source_ref" == refs/* ]] || fail "0062 boundary is not reachable from a trusted source ref"
source_distance="$(
  "${source_git[@]}" rev-list --count "$contract_required_commit..$source_ref" | tr -d '\r'
)"
[[ "$source_distance" =~ ^[0-9]+$ ]] || fail "mail contract boundary source distance is invalid"
source_depth="$((source_distance + 3))"
git -C "$work/repo" remote add retention-boundary \
  "ext::git -c safe.directory=$source_git_dir -c uploadpack.allowFilter=true upload-pack $source_git_dir"
git -C "$work/repo" config extensions.partialClone retention-boundary
git -C "$work/repo" config remote.retention-boundary.promisor true
git -C "$work/repo" config remote.retention-boundary.partialclonefilter blob:none
git -c protocol.ext.allow=always -C "$work/repo" fetch --quiet --filter=blob:none \
  --depth="$source_depth" retention-boundary "$source_ref" 2>/dev/null || {
  fail "unable to import the complete 0062 boundary fixture"
}
dispatch_binding_source_ref="$(
  "${source_git[@]}" for-each-ref --contains "$dispatch_binding_real_source_commit" \
    --format='%(refname)' refs/heads refs/remotes | tr -d '\r' | sed -n '1p'
)"
[[ "$dispatch_binding_source_ref" == refs/* ]] || {
  fail "0064 boundary is not reachable from a trusted source ref"
}
"${source_git[@]}" merge-base --is-ancestor \
  "$older_pre_contract_commit" "$dispatch_binding_source_ref" || {
  fail "0064 fixture ref does not retain the complete legacy rollback ancestry"
}
dispatch_binding_source_distance="$(
  "${source_git[@]}" rev-list --count \
    "$older_pre_contract_commit..$dispatch_binding_source_ref" | tr -d '\r'
)"
[[ "$dispatch_binding_source_distance" =~ ^[0-9]+$ ]] || {
  fail "dispatch binding boundary source distance is invalid"
}
dispatch_binding_source_depth="$((dispatch_binding_source_distance + 1))"
git -C "$work/repo" remote add dispatch-binding-boundary \
  "ext::git -c safe.directory=$source_git_dir -c uploadpack.allowFilter=true upload-pack $source_git_dir"
git -C "$work/repo" config extensions.partialClone dispatch-binding-boundary
git -C "$work/repo" config remote.dispatch-binding-boundary.promisor true
git -C "$work/repo" config remote.dispatch-binding-boundary.partialclonefilter blob:none
git -c protocol.ext.allow=always -C "$work/repo" fetch --quiet --filter=blob:none \
  --depth="$dispatch_binding_source_depth" dispatch-binding-boundary \
  "$dispatch_binding_source_ref" 2>/dev/null || {
  fail "unable to import the complete 0064 boundary fixture"
}
dispatch_binding_real_repo="$work/dispatch-binding-real-repo"
mkdir -p "$dispatch_binding_real_repo"
git -C "$dispatch_binding_real_repo" init -q
git -C "$dispatch_binding_real_repo" remote add origin \
  https://github.com/example/codestead
git -C "$dispatch_binding_real_repo" remote add source \
  "ext::git -c safe.directory=$source_git_dir upload-pack $source_git_dir"
git -c protocol.ext.allow=always -C "$dispatch_binding_real_repo" fetch --quiet \
  --depth="$dispatch_binding_source_depth" source \
  "$dispatch_binding_source_ref" 2>/dev/null || {
  fail "unable to import the real post-0064 rollback source without a blob filter"
}
git -C "$dispatch_binding_real_repo" checkout --quiet --detach \
  "$dispatch_binding_real_source_commit" || {
  fail "unable to check out the real post-0064 rollback source"
}
dispatch_binding_imported_capability_blob="$(
  GIT_NO_LAZY_FETCH=1 "${source_git[@]}" cat-file blob \
    "$dispatch_binding_capability_blob" \
    | GIT_NO_LAZY_FETCH=1 git -C "$work/repo" hash-object \
        -t blob -w --stdin
)" || fail "unable to import the pinned 0064 capability blob"
[[ "$dispatch_binding_imported_capability_blob" == "$dispatch_binding_capability_blob" ]] || {
  fail "imported 0064 capability blob does not match the pinned identity"
}
git -C "$dispatch_binding_real_repo" remote remove source

dispatch_binding_boundary_tree="$(
  git -C "$work/repo" rev-parse --verify "${dispatch_binding_boundary_commit}^{tree}"
)"
dispatch_binding_pre_boundary_source_commit="$(
  git -C "$work/repo" rev-parse --verify "${dispatch_binding_boundary_commit}^"
)"
dispatch_binding_pre_boundary_source_tree="$(
  git -C "$work/repo" rev-parse --verify \
    "${dispatch_binding_pre_boundary_source_commit}^{tree}"
)"
dispatch_binding_pre_boundary_target_commit="$(
  git -C "$work/repo" rev-parse --verify \
    "${dispatch_binding_pre_boundary_source_commit}^"
)"
dispatch_binding_pre_boundary_target_tree="$(
  git -C "$work/repo" rev-parse --verify \
    "${dispatch_binding_pre_boundary_target_commit}^{tree}"
)"
git -C "$work/repo" merge-base --is-ancestor \
  "$dispatch_binding_pre_boundary_target_commit" \
  "$dispatch_binding_pre_boundary_source_commit" || {
  fail "pre-0064 fixture target is not an ancestor of its source"
}
dispatch_binding_pruned_source_commit="$(
  "${source_git[@]}" rev-parse --verify "${older_pre_contract_commit}^" | tr -d '\r'
)"
dispatch_binding_pruned_source_tree="$(
  "${source_git[@]}" rev-parse --verify \
    "${dispatch_binding_pruned_source_commit}^{tree}" | tr -d '\r'
)"
[[ "$dispatch_binding_pruned_source_commit" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ \
  && "$dispatch_binding_pruned_source_tree" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
  fail "pruned pre-0064 fixture evidence is malformed"
}
dispatch_binding_pruned_objects="$work/dispatch-binding-pruned-objects"
dispatch_binding_pruned_expected_objects="$work/dispatch-binding-pruned-expected.objects"
dispatch_binding_pruned_actual_objects="$work/dispatch-binding-pruned-actual.objects"
mkdir -p "$dispatch_binding_pruned_objects/pack"
GIT_NO_LAZY_FETCH=1 git -C "$work/repo" cat-file --batch-all-objects \
    --batch-check='%(objectname)' \
  | awk -v omitted="$dispatch_binding_pruned_source_commit" \
      '$1 != omitted { print $1 }' \
  | LC_ALL=C sort -u >"$dispatch_binding_pruned_expected_objects" || {
  fail "unable to enumerate the expected pruned pre-0064 object set"
}
[[ -s "$dispatch_binding_pruned_expected_objects" ]] || {
  fail "expected pruned pre-0064 object set is empty"
}
dispatch_binding_pruned_pack="$(
  GIT_NO_LAZY_FETCH=1 git -C "$work/repo" pack-objects \
    "$dispatch_binding_pruned_objects/pack/pack" \
    <"$dispatch_binding_pruned_expected_objects"
)" || fail "unable to create the pruned pre-0064 lineage fixture"
[[ "$dispatch_binding_pruned_pack" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
  fail "pruned pre-0064 lineage fixture pack identity is malformed"
}
GIT_OBJECT_DIRECTORY="$dispatch_binding_pruned_objects" GIT_NO_LAZY_FETCH=1 \
  git -C "$work/repo" cat-file --batch-all-objects \
    --batch-check='%(objectname)' \
  | LC_ALL=C sort -u >"$dispatch_binding_pruned_actual_objects" || {
  fail "unable to enumerate the isolated pruned pre-0064 object set"
}
cmp -s "$dispatch_binding_pruned_expected_objects" \
  "$dispatch_binding_pruned_actual_objects" || {
  fail "isolated pruned pre-0064 object set does not match the exact expected set"
}
for dispatch_binding_pruned_retained_object in \
    'HEAD^{commit}' 'HEAD^{tree}' \
    "${dispatch_binding_boundary_commit}^{commit}" \
    "${dispatch_binding_boundary_commit}^{tree}" \
    "${older_pre_contract_commit}^{commit}" \
    "${older_pre_contract_commit}^{tree}" \
    "$dispatch_binding_pruned_source_tree"; do
  GIT_OBJECT_DIRECTORY="$dispatch_binding_pruned_objects" GIT_NO_LAZY_FETCH=1 \
    git -C "$work/repo" cat-file -e \
      "$dispatch_binding_pruned_retained_object" >/dev/null 2>&1 || {
    fail "pruned pre-0064 fixture lost required local Git evidence"
  }
done
if GIT_OBJECT_DIRECTORY="$dispatch_binding_pruned_objects" GIT_NO_LAZY_FETCH=1 \
    git -C "$work/repo" cat-file -e \
      "${dispatch_binding_pruned_source_commit}^{commit}" >/dev/null 2>&1; then
  fail "pruned pre-0064 fixture unexpectedly retained its missing parent"
fi
dispatch_binding_compatible_source_commit="$dispatch_binding_real_source_commit"
dispatch_binding_compatible_tree="$dispatch_binding_real_source_tree"
dispatch_binding_compatible_target_commit="$dispatch_binding_real_target_commit"
dispatch_binding_compatible_target_tree="$dispatch_binding_real_target_tree"
for compatible_commit in "$dispatch_binding_compatible_source_commit" \
  "$dispatch_binding_compatible_target_commit"; do
  git -C "$work/repo" cat-file -e "${compatible_commit}^{commit}" 2>/dev/null || {
    fail "the real compatible post-0064 commit was not imported"
  }
done
git -C "$work/repo" merge-base --is-ancestor \
  "$dispatch_binding_compatible_target_commit" \
  "$dispatch_binding_compatible_source_commit" || {
  fail "the real compatible capability target is not an ancestor of its source"
}
guarded_delivery_boundary_tree="$(
  git -C "$work/repo" rev-parse --verify "${guarded_delivery_boundary_commit}^{tree}"
)"
guarded_delivery_index="$work/guarded-delivery.index"
guarded_delivery_actual_blob="$(
  git -C "$work/repo" hash-object -w -- \
    "$repo_root/$guarded_delivery_capability_path"
)"
[[ "$guarded_delivery_actual_blob" == "$guarded_delivery_capability_blob" ]] || {
  fail "checked-in guarded delivery capability does not match the reviewed blob"
}
GIT_INDEX_FILE="$guarded_delivery_index" \
  git -C "$work/repo" read-tree "$guarded_delivery_boundary_tree"
GIT_INDEX_FILE="$guarded_delivery_index" \
  git -C "$work/repo" update-index --add --cacheinfo \
    100644 "$guarded_delivery_capability_blob" "$guarded_delivery_capability_path"
guarded_delivery_stale_migration_tree="$(
  GIT_NO_LAZY_FETCH=1 GIT_INDEX_FILE="$guarded_delivery_index" \
    git -C "$work/repo" write-tree --missing-ok
)"
guarded_delivery_actual_redaction_migration_entry="$(
  git -C "$work/repo" ls-tree "$guarded_delivery_stale_migration_tree" -- \
    "$guarded_delivery_redaction_migration_path"
)"
[[ "$guarded_delivery_actual_redaction_migration_entry" == \
  "100644 blob $guarded_delivery_redaction_migration_blob"$'\t'"$guarded_delivery_redaction_migration_path" ]] || {
  fail "guarded delivery rollback fixture omits the reviewed 0068 migration blob"
}
guarded_delivery_actual_migration_blob="$(
  git -C "$work/repo" hash-object -w -- \
    "$repo_root/$guarded_delivery_migration_path"
)"
[[ "$guarded_delivery_actual_migration_blob" == "$guarded_delivery_migration_blob" ]] || {
  fail "checked-in guarded delivery migration does not match the reviewed blob"
}
GIT_INDEX_FILE="$guarded_delivery_index" \
  git -C "$work/repo" update-index --add --cacheinfo \
    100644 "$guarded_delivery_migration_blob" "$guarded_delivery_migration_path"
guarded_delivery_exact_tree="$(
  GIT_NO_LAZY_FETCH=1 GIT_INDEX_FILE="$guarded_delivery_index" \
    git -C "$work/repo" write-tree --missing-ok
)"
guarded_delivery_exact_target_commit="$(
  printf '%s\n' 'fixture exact 0069 guarded rollback target' \
    | git -C "$work/repo" commit-tree "$guarded_delivery_exact_tree" \
      -p "$guarded_delivery_boundary_commit"
)"
guarded_delivery_exact_source_commit="$(
  printf '%s\n' 'fixture exact 0069 guarded rollback source' \
    | git -C "$work/repo" commit-tree "$guarded_delivery_exact_tree" \
      -p "$guarded_delivery_exact_target_commit"
)"
guarded_delivery_stale_source_commit="$(
  printf '%s\n' 'fixture 0069 rollback source with stale guarded migration' \
    | git -C "$work/repo" commit-tree "$guarded_delivery_stale_migration_tree" \
      -p "$guarded_delivery_exact_target_commit"
)"
guarded_delivery_stale_target_commit="$(
  printf '%s\n' 'fixture 0069 rollback target with stale guarded migration' \
    | git -C "$work/repo" commit-tree "$guarded_delivery_stale_migration_tree" \
      -p "$guarded_delivery_boundary_commit"
)"
guarded_delivery_exact_over_stale_target_commit="$(
  printf '%s\n' 'fixture exact 0069 source over stale guarded migration target' \
    | git -C "$work/repo" commit-tree "$guarded_delivery_exact_tree" \
      -p "$guarded_delivery_stale_target_commit"
)"
GIT_INDEX_FILE="$guarded_delivery_index" \
  git -C "$work/repo" read-tree "$guarded_delivery_exact_tree"
GIT_INDEX_FILE="$guarded_delivery_index" \
  git -C "$work/repo" update-index --force-remove \
    "$guarded_delivery_capability_path"
guarded_delivery_missing_tree="$(
  GIT_NO_LAZY_FETCH=1 GIT_INDEX_FILE="$guarded_delivery_index" \
    git -C "$work/repo" write-tree --missing-ok
)"
guarded_delivery_missing_target_commit="$(
  printf '%s\n' 'fixture 0069 rollback target without guarded capability' \
    | git -C "$work/repo" commit-tree "$guarded_delivery_missing_tree" \
      -p "$guarded_delivery_boundary_commit"
)"
guarded_delivery_missing_source_commit="$(
  printf '%s\n' 'fixture 0069 rollback source without guarded capability' \
    | git -C "$work/repo" commit-tree "$guarded_delivery_missing_tree" \
      -p "$guarded_delivery_missing_target_commit"
)"
guarded_delivery_missing_previous_source_commit="$(
  printf '%s\n' 'fixture exact 0069 source over target without guarded capability' \
    | git -C "$work/repo" commit-tree "$guarded_delivery_exact_tree" \
      -p "$guarded_delivery_missing_target_commit"
)"
guarded_delivery_tampered_blob="$(
  printf '%s\n' \
    'SCHEMA_VERSION=1' \
    'OUTBOX_WORKER_MODE=fenced-postgres-v1' \
    "GUARDED_DELIVERY_RUNTIME=${guarded_delivery_runtime_capability}-tampered" \
    "DELIVERY_RELEASE_AUTHORITY=$delivery_release_authority_contract" \
    "GUARDED_DELIVERY_PRIVILEGE=$guarded_delivery_privilege_contract" \
    | git -C "$work/repo" hash-object -w --stdin
)"
GIT_INDEX_FILE="$guarded_delivery_index" \
  git -C "$work/repo" read-tree "$guarded_delivery_exact_tree"
GIT_INDEX_FILE="$guarded_delivery_index" \
  git -C "$work/repo" update-index --add --cacheinfo \
    100644 "$guarded_delivery_tampered_blob" "$guarded_delivery_capability_path"
guarded_delivery_tampered_tree="$(
  GIT_NO_LAZY_FETCH=1 GIT_INDEX_FILE="$guarded_delivery_index" \
    git -C "$work/repo" write-tree --missing-ok
)"
guarded_delivery_tampered_target_commit="$(
  printf '%s\n' 'fixture 0069 rollback target with tampered guarded capability' \
    | git -C "$work/repo" commit-tree "$guarded_delivery_tampered_tree" \
      -p "$guarded_delivery_boundary_commit"
)"
guarded_delivery_tampered_source_commit="$(
  printf '%s\n' 'fixture 0069 rollback source with tampered guarded capability' \
    | git -C "$work/repo" commit-tree "$guarded_delivery_tampered_tree" \
      -p "$guarded_delivery_tampered_target_commit"
)"
guarded_delivery_tampered_previous_source_commit="$(
  printf '%s\n' 'fixture exact 0069 source over target with tampered guarded capability' \
    | git -C "$work/repo" commit-tree "$guarded_delivery_exact_tree" \
      -p "$guarded_delivery_tampered_target_commit"
)"
for guarded_delivery_commit in \
    "$guarded_delivery_exact_source_commit" "$guarded_delivery_exact_target_commit" \
    "$guarded_delivery_stale_source_commit" "$guarded_delivery_stale_target_commit" \
    "$guarded_delivery_exact_over_stale_target_commit" \
    "$guarded_delivery_missing_source_commit" "$guarded_delivery_missing_target_commit" \
    "$guarded_delivery_missing_previous_source_commit" \
    "$guarded_delivery_tampered_source_commit" "$guarded_delivery_tampered_target_commit" \
    "$guarded_delivery_tampered_previous_source_commit"; do
  [[ "$(git -C "$work/repo" ls-tree -r --name-only "$guarded_delivery_commit" -- \
    "$guarded_delivery_migration_path")" == \
    "$guarded_delivery_migration_path" ]] || {
    fail "guarded delivery rollback fixture omits the reviewed 0069 migration"
  }
done
for guarded_delivery_exact_migration_commit in \
    "$guarded_delivery_exact_source_commit" "$guarded_delivery_exact_target_commit" \
    "$guarded_delivery_exact_over_stale_target_commit" \
    "$guarded_delivery_missing_source_commit" "$guarded_delivery_missing_target_commit" \
    "$guarded_delivery_missing_previous_source_commit" \
    "$guarded_delivery_tampered_source_commit" "$guarded_delivery_tampered_target_commit" \
    "$guarded_delivery_tampered_previous_source_commit"; do
  [[ "$(git -C "$work/repo" ls-tree "$guarded_delivery_exact_migration_commit" -- \
    "$guarded_delivery_migration_path")" == \
    "100644 blob $guarded_delivery_migration_blob"$'\t'"$guarded_delivery_migration_path" ]] || {
    fail "guarded delivery capability fixture does not retain the reviewed 0069 migration blob"
  }
done
rm -f -- "$guarded_delivery_index"
dispatch_binding_index="$work/dispatch-binding.index"
GIT_INDEX_FILE="$dispatch_binding_index" \
  git -C "$work/repo" read-tree "$dispatch_binding_compatible_tree"
dispatch_binding_unknown_capability_blob="$(
  printf '%s\n' \
    'SCHEMA_VERSION=2' \
    'OUTBOX_WORKER_MODE=fenced-postgres-v1' \
    "DISPATCH_BINDING_RUNTIME=$dispatch_binding_runtime_capability" \
    "DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract" \
    | git -C "$work/repo" hash-object -w --stdin
)"
GIT_INDEX_FILE="$dispatch_binding_index" \
  git -C "$work/repo" update-index --add --cacheinfo \
    100644 "$dispatch_binding_unknown_capability_blob" "$dispatch_binding_capability_path"
dispatch_binding_unknown_capability_tree="$(
  GIT_NO_LAZY_FETCH=1 GIT_INDEX_FILE="$dispatch_binding_index" git -C "$work/repo" write-tree --missing-ok
)"
dispatch_binding_unknown_capability_commit="$(
  printf '%s\n' 'fixture unknown future dispatch binding capability' \
    | git -C "$work/repo" commit-tree "$dispatch_binding_unknown_capability_tree" \
      -p "$dispatch_binding_compatible_target_commit"
)"
GIT_INDEX_FILE="$dispatch_binding_index" \
  git -C "$work/repo" read-tree "$dispatch_binding_compatible_tree"
GIT_INDEX_FILE="$dispatch_binding_index" \
  git -C "$work/repo" update-index --add --cacheinfo \
    100755 "$dispatch_binding_capability_blob" \
    "$dispatch_binding_capability_path"
dispatch_binding_wrong_mode_tree="$(
  GIT_NO_LAZY_FETCH=1 GIT_INDEX_FILE="$dispatch_binding_index" \
    git -C "$work/repo" write-tree --missing-ok
)"
dispatch_binding_wrong_mode_commit="$(
  printf '%s\n' 'fixture executable dispatch binding capability' \
    | git -C "$work/repo" commit-tree "$dispatch_binding_wrong_mode_tree" \
      -p "$dispatch_binding_compatible_target_commit"
)"

dispatch_binding_tampered_blob="$(
  printf '%s\n' \
    'SCHEMA_VERSION=1' \
    'OUTBOX_WORKER_MODE=fenced-postgres-v1' \
    "DISPATCH_BINDING_RUNTIME=${dispatch_binding_runtime_capability}-tampered" \
    "DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract" \
    | git -C "$work/repo" hash-object -w --stdin
)"
GIT_INDEX_FILE="$dispatch_binding_index" \
  git -C "$work/repo" read-tree "$dispatch_binding_compatible_tree"
GIT_INDEX_FILE="$dispatch_binding_index" \
  git -C "$work/repo" update-index --add --cacheinfo \
    100644 "$dispatch_binding_tampered_blob" \
    "$dispatch_binding_capability_path"
dispatch_binding_tampered_tree="$(
  GIT_NO_LAZY_FETCH=1 GIT_INDEX_FILE="$dispatch_binding_index" \
    git -C "$work/repo" write-tree --missing-ok
)"
dispatch_binding_tampered_commit="$(
  printf '%s\n' 'fixture tampered dispatch binding capability' \
    | git -C "$work/repo" commit-tree "$dispatch_binding_tampered_tree" \
      -p "$dispatch_binding_compatible_target_commit"
)"

dispatch_binding_unapproved_target_commit="$(
  git -C "$work/repo" rev-parse --verify HEAD
)"
dispatch_binding_unapproved_target_tree="$(
  git -C "$work/repo" rev-parse --verify 'HEAD^{tree}'
)"
dispatch_binding_unapproved_legacy_source_commit="$(
  printf '%s\n' 'fixture unapproved legacy image without 0064 migration' \
    | git -C "$work/repo" commit-tree "$dispatch_binding_unapproved_target_tree" \
      -p "$dispatch_binding_unapproved_target_commit"
)"
dispatch_binding_unapproved_migration_blob="$(
  printf '%s\n' '-- unapproved 0064 dispatch binding lineage fixture' \
    | git -C "$work/repo" hash-object -w --stdin
)"
GIT_INDEX_FILE="$dispatch_binding_index" \
  git -C "$work/repo" read-tree "$dispatch_binding_unapproved_target_tree"
GIT_INDEX_FILE="$dispatch_binding_index" \
  git -C "$work/repo" update-index --add --cacheinfo \
    100644 "$dispatch_binding_unapproved_migration_blob" \
    drizzle/0064_mail_outbox_dispatch_binding.sql
dispatch_binding_unapproved_source_tree="$(
  GIT_INDEX_FILE="$dispatch_binding_index" git -C "$work/repo" write-tree
)"
dispatch_binding_unapproved_source_commit="$(
  printf '%s\n' 'fixture unapproved dispatch binding lineage' \
    | git -C "$work/repo" commit-tree "$dispatch_binding_unapproved_source_tree" \
      -p "$dispatch_binding_unapproved_target_commit"
)"
rm -f -- "$dispatch_binding_index"
/usr/bin/python3 "$fixture_generator" \
  --source "$work/repo" \
  --packager "$work/repo/infra/ops/package-release-tree.py" \
  --destination "$work/release-package" \
  >/dev/null || fail "unable to generate canonical rollback fixture"
cp "$work/repo/RELEASE.SHA256SUMS" "$work/valid-release-manifest"
/usr/bin/python3 "$fixture_generator" \
  --source "$dispatch_binding_real_repo" \
  --packager "$dispatch_binding_real_repo/infra/ops/package-release-tree.py" \
  --destination "$work/dispatch-binding-real-release-package" \
  >/dev/null || fail "unable to generate canonical real post-0064 rollback fixture"

previous_commit="$dispatch_binding_pre_boundary_target_commit"
candidate_commit="$dispatch_binding_pre_boundary_source_commit"
previous_tree="$dispatch_binding_pre_boundary_target_tree"
candidate_tree="$dispatch_binding_pre_boundary_source_tree"
printf '%s\n' "$previous_commit" >"$work/records/20260719T000000Z-1/git-commit.txt"
printf '%s\n' "$previous_tree" >"$work/records/20260719T000000Z-1/git-tree.txt"
printf '%s\n' 'previous verified application image record bytes' \
  >"$work/records/20260719T000000Z-1/application-image-record.json"
previous_application_sha="$(sha256sum "$work/records/20260719T000000Z-1/application-image-record.json" | cut -d' ' -f1)"
printf '%s\n' "$previous_application_sha" >"$work/records/20260719T000000Z-1/application-image-record-sha256.txt"
printf '%s\n' 'result=completed' >"$work/records/20260719T000000Z-1/status.env"
printf '%s\n' '20260719T000000Z-1' >"$work/records/20260719T000000Z-2/previous-release-id.txt"
printf '%s\n' "$previous_commit" >"$work/records/20260719T000000Z-2/previous-git-commit.txt"
printf '%s\n' "$candidate_commit" >"$work/records/20260719T000000Z-2/git-commit.txt"
printf '%s\n' "$candidate_tree" >"$work/records/20260719T000000Z-2/git-tree.txt"
printf '%s\n' \
  'release_id=20260719T000000Z-2' \
  'result=failed' \
  'stage=public-readiness' \
  'exit_code=1' \
  'schema_rollback=not_attempted' >"$work/records/20260719T000000Z-2/status.env"
printf '%s\n' 'release_id=20260719T000000Z-1' "git_commit=$previous_commit" >"$work/records/current-release.env"
printf '%s\n' 'release_id=20260719T000000Z-2' "git_commit=$candidate_commit" >"$work/records/latest-candidate.env"
chmod 0600 "$work/records/current-release.env" "$work/records/latest-candidate.env"
{
  printf 'services:\n'
  for service in app runner-egress-gateway mail-worker reward-worker regrade-worker \
    exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker cloudflared; do
    printf '  %s:\n' "$service"
    printf '    image: "registry.example.test/codestead/previous-%s@sha256:%064d"\n' "$service" 7
  done
} >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
{
  for service in app runner-egress-gateway mail-worker reward-worker regrade-worker \
    exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker cloudflared; do
    printf '%s\tregistry.example.test/codestead/previous-%s@sha256:%064d\tsha256:%064d\n' \
      "$service" "$service" 7 8
  done
} >"$work/records/20260719T000000Z-2/previous-running-images.tsv"
{
  for service in app runner-egress-gateway mail-worker reward-worker regrade-worker \
    exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker cloudflared; do
    printf '%s\tregistry.example.test/codestead/previous-%s@sha256:%064d\tsha256:%064d\n' \
      "$service" "$service" 7 8
  done
} >"$work/records/20260719T000000Z-1/deployed-service-images.tsv"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"

cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail

authority_error() {
  echo "fake docker requires the fixed daemon endpoint and Compose project" >&2
  exit 64
}

[[ "${1:-}" == --host && "${2:-}" == unix:///var/run/docker.sock ]] || authority_error
shift 2
if [[ "${1:-}" == compose ]]; then
  [[ "${2:-}" == --project-name && "${3:-}" == learncoding ]] || authority_error
  shift 3
  set -- compose "$@"
fi

if [[ "${1:-}" != image ]]; then
  marker="$FAKE_CONTROL_ROOT/control/release-quarantine"
  [[ -f "$marker" && ! -L "$marker" && "$(cat "$marker")" == codestead-release-quarantine-v1 ]] || {
    echo "rollback mutation ran without durable quarantine" >&2
    exit 97
  }
fi
(
  printf '%s' "${1:-}"
  shift || true
  printf '\t%s' "$@"
  printf '\n'
) >>"$FAKE_DOCKER_LOG"

if [[ "${1:-}" == "image" && "${2:-}" == "inspect" && "${3:-}" == "--format" && "$#" == 5 ]]; then
  [[ "$5" == *@sha256:* ]] || exit 64
  printf 'sha256:%064d\n' 8
  exit 0
fi

if [[ "${1:-}" == "inspect" && "${2:-}" == "--format" && "$#" == 4 \
  && "$3" == '{{ index .Config.Labels "com.docker.compose.service" }}\t{{.Name}}\t{{.Config.Image}}\t{{.Image}}' ]]; then
  service="${4#restored-}"
  service="${service%-container}"
  case "$service" in
    app|cloudflared|exam-finalization-worker|mail-worker|practice-runner-recovery-worker|project-review-correction-worker|regrade-worker|reward-worker|runner-egress-gateway)
      if [[ "${FAKE_SCENARIO:-}" == legacy-gateway-transition && "$service" == runner-egress-gateway ]]; then
        printf '%s\t/learncoding-%s-1\tregistry.example.test/codestead/gateway@sha256:%064d\tsha256:%064d\n' \
          "$service" "$service" 9 8
      else
        printf '%s\t/learncoding-%s-1\tregistry.example.test/codestead/previous-%s@sha256:%064d\tsha256:%064d\n' \
          "$service" "$service" "$service" 7 8
      fi
      ;;
    postgres)
      printf 'postgres\t/learncoding-postgres-1\tregistry.example.test/codestead/postgres@sha256:%064d\tsha256:%064d\n' 6 6
      ;;
    *) exit 64 ;;
  esac
  exit 0
fi

[[ "${1:-}" == "compose" ]] || exit 64
shift
[[ "$1" == "--env-file" && "$2" == "$EXPECTED_COMPOSE_ENV" && "$3" == "-f" && "$4" == "$EXPECTED_COMPOSE_FILE" ]] || exit 64
shift 4
if [[ "${1:-}" == "-f" ]]; then
  [[ "$2" == "$EXPECTED_OVERRIDE" ]] || exit 64
  shift 2
fi
if [[ "$1" == "ps" && "$2" == "-q" && "$#" == 3 ]]; then
  printf 'restored-%s-container\n' "$3"
  exit 0
fi
if [[ "$1" == "stop" && "$2" == "--timeout" && "$3" == "30" && "$4" == "cloudflared" ]]; then
  stop_count="$(cat "$FAKE_QUARANTINE_STOP_COUNT")"
  stop_count="$((stop_count + 1))"
  printf '%s\n' "$stop_count" >"$FAKE_QUARANTINE_STOP_COUNT"
  if [[ "${FAKE_SCENARIO:-}" == quarantine-stop-failure && "$stop_count" -le 2 ]]; then
    exit 58
  fi
  if [[ "${FAKE_SCENARIO:-}" == signal-first-quarantine-stop && "$stop_count" == 1 ]]; then
    timeout_parent="$PPID"
    rollback_pid="$(/usr/bin/ps -o ppid= -p "$timeout_parent")"
    rollback_pid="${rollback_pid//[[:space:]]/}"
    [[ "$rollback_pid" =~ ^[1-9][0-9]*$ ]] || exit 59
    /bin/kill -TERM "$rollback_pid"
  fi
  if [[ "${FAKE_SCENARIO:-}" == repeated-signal-early-cleanup ]]; then
    timeout_parent="$PPID"
    rollback_pid="$(/usr/bin/ps -o ppid= -p "$timeout_parent")"
    rollback_pid="${rollback_pid//[[:space:]]/}"
    [[ "$rollback_pid" =~ ^[1-9][0-9]*$ ]] || exit 59
    case "$stop_count" in
      1)
        /bin/kill -TERM "$rollback_pid"
        exit 58
        ;;
      2)
        /bin/kill -HUP "$rollback_pid"
        /bin/kill -INT "$rollback_pid"
        exit 58
        ;;
    esac
  fi
  if [[ "${FAKE_SCENARIO:-}" == repeated-signal-late-cleanup && "$stop_count" == 2 ]]; then
    timeout_parent="$PPID"
    rollback_pid="$(/usr/bin/ps -o ppid= -p "$timeout_parent")"
    rollback_pid="${rollback_pid//[[:space:]]/}"
    [[ "$rollback_pid" =~ ^[1-9][0-9]*$ ]] || exit 59
    /bin/kill -TERM "$rollback_pid"
    /bin/kill -HUP "$rollback_pid"
    /bin/kill -INT "$rollback_pid"
    exit 58
  fi
  exit 0
fi
if [[ "$1" == "up" ]]; then
  [[ " $* " == *" --no-build "* && " $* " == *" --pull never "* ]] || exit 64
  exit 0
fi
exit 64
EOF
chmod 0755 "$work/bin/docker"

cat >"$work/bin/sync" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >>"$FAKE_SYNC_LOG"
if [[ "${FAKE_SCENARIO:-}" == "runtime-state-active-fsync-failure" ]]; then
  case "$*" in
    *"/.active-release."*".tmp") exit 62 ;;
  esac
fi
EOF
chmod 0755 "$work/bin/sync"

cat >"$work/bin/flock" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
swap_lock_path() {
  [[ -n "${FAKE_LOCK_SWAP_PATH:-}" ]] || exit 96
  mv -- "$FAKE_LOCK_SWAP_PATH" "$FAKE_LOCK_SWAP_PATH.detached"
  : >"$FAKE_LOCK_SWAP_PATH"
  chmod 0600 "$FAKE_LOCK_SWAP_PATH"
}
if [[ "${FAKE_SCENARIO:-}" == lock-path-swap-before-flock ]]; then
  swap_lock_path
fi
/usr/bin/flock "$@"
flock_status="$?"
if [[ "${FAKE_SCENARIO:-}" == lock-path-swap-after-flock ]]; then
  swap_lock_path
fi
exit "$flock_status"
EOF
chmod 0755 "$work/bin/flock"

cat >"$work/smoke-production.sh" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${DOCKER_HOST:-}" == unix:///var/run/docker.sock ]]
[[ "${COMPOSE_PROJECT_NAME:-}" == learncoding ]]
printf '%s\n' "$*" >>"$FAKE_SMOKE_LOG"
if [[ ("${FAKE_SCENARIO:-}" == "public-failure" \
  || "${FAKE_SCENARIO:-}" == "repeated-signal-late-cleanup") \
  && " $* " == *" --phase public "* ]]; then
  rm -f -- "$FAKE_CONTROL_ROOT/control/release-quarantine"
  exit 51
fi
EOF
chmod 0755 "$work/smoke-production.sh"

run_rollback() {
  local scenario="$1"
  shift
  local case_dir="$work/case-$scenario"
  local run_repo_root="${RUN_REPO_ROOT:-$work/repo}"
  local run_git_object_directory="${RUN_GIT_OBJECT_DIRECTORY:-$run_repo_root/.git/objects}"
  local run_stage_timeout="${RUN_STAGE_TIMEOUT:-5}"
  local lock_file="${RUN_LOCK_FILE:-$case_dir/release.lock}"
  mkdir -p "$case_dir"
  : >"$case_dir/docker.log"
  : >"$case_dir/smoke.log"
  : >"$case_dir/sync.log"
  : >"$case_dir/stdout"
  : >"$case_dir/stderr"
  printf '0\n' >"$case_dir/quarantine-stop.count"
  if [[ "${RUN_LOCK_PRECREATE:-true}" == true && ! -e "$lock_file" && ! -L "$lock_file" ]]; then
    : >"$lock_file"
    chmod 0600 "$lock_file"
  fi
  set +e
  REPO_ROOT="$run_repo_root" \
    GIT_OBJECT_DIRECTORY="$run_git_object_directory" \
    COMPOSE_ENV_FILE="$work/compose.env" \
    COMPOSE_FILE_PATH="$run_repo_root/compose.yaml" \
    RELEASE_LOCK_FILE="$lock_file" \
    RELEASE_RECORD_ROOT="$work/records" \
    RUNTIME_STATE_ROOT="$work/runtime-state" \
    SMOKE_PRODUCTION_SCRIPT="$work/smoke-production.sh" \
    FAKE_DOCKER_LOG="$case_dir/docker.log" \
    FAKE_SMOKE_LOG="$case_dir/smoke.log" \
    FAKE_SYNC_LOG="$case_dir/sync.log" \
    FAKE_SCENARIO="$scenario" \
    FAKE_LOCK_SWAP_PATH="${RUN_LOCK_SWAP_PATH:-}" \
    FAKE_QUARANTINE_STOP_COUNT="$case_dir/quarantine-stop.count" \
    FAKE_CONTROL_ROOT="$work" \
    EXPECTED_COMPOSE_ENV="$work/compose.env" \
    EXPECTED_COMPOSE_FILE="$run_repo_root/compose.yaml" \
    EXPECTED_OVERRIDE="$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
    bash "$rollback" --test-harness-root "$work" \
      --release-record "$work/records/20260719T000000Z-2" \
      --lock-timeout 1 --stage-timeout "$run_stage_timeout" --startup-wait 3 "$@" \
      >"$case_dir/stdout" 2>"$case_dir/stderr"
  ROLLBACK_STATUS=$?
  set -e
  ROLLBACK_CASE="$case_dir"
  ROLLBACK_REPO_ROOT_USED="$run_repo_root"
}

set_rollback_git_evidence() {
  local source_commit="$1" source_tree="$2" target_commit="$3" target_tree="$4"
  printf '%s\n' "$source_commit" >"$work/records/20260719T000000Z-2/git-commit.txt"
  printf '%s\n' "$source_tree" >"$work/records/20260719T000000Z-2/git-tree.txt"
  printf '%s\n' "$target_commit" >"$work/records/20260719T000000Z-2/previous-git-commit.txt"
  printf '%s\n' "$target_commit" >"$work/records/20260719T000000Z-1/git-commit.txt"
  printf '%s\n' "$target_tree" >"$work/records/20260719T000000Z-1/git-tree.txt"
  printf '%s\n' 'release_id=20260719T000000Z-1' "git_commit=$target_commit" \
    >"$work/records/current-release.env"
  printf '%s\n' 'release_id=20260719T000000Z-2' "git_commit=$source_commit" \
    >"$work/records/latest-candidate.env"
}

assert_only_quarantine_stops() {
  local log="$1" label="$2" line
  local command env_flag env_path file_flag file_path action timeout_flag seconds service extra
  local stop_count=0 marker="$work/control/release-quarantine"
  [[ -f "$marker" && ! -L "$marker" && "$(cat "$marker")" == codestead-release-quarantine-v1 ]] || {
    fail "$label did not retain an authentic durable quarantine"
  }
  while IFS= read -r line; do
    IFS=$'\t' read -r command env_flag env_path file_flag file_path action \
      timeout_flag seconds service extra <<<"$line"
    [[ "$command" == compose && "$env_flag" == --env-file \
      && "$env_path" == "$work/compose.env" && "$file_flag" == -f \
      && "$file_path" == "$ROLLBACK_REPO_ROOT_USED/compose.yaml" && "$action" == stop \
      && "$timeout_flag" == --timeout && "$seconds" == 30 \
      && "$service" == cloudflared && -z "$extra" ]] || {
      fail "$label performed Docker work beyond tunnel quarantine"
    }
    stop_count="$((stop_count + 1))"
  done <"$log"
  (( stop_count >= 1 )) || fail "$label omitted tunnel quarantine"
}

printf '%s\n' 'APP_URL=https://127.0.0.1' >"$work/compose.env"
run_rollback ipv4-public-origin --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted an IPv4 APP_URL as a public origin"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "invalid IPv4 APP_URL reached Docker"
grep -Fq 'canonical lowercase public HTTPS origin' "$ROLLBACK_CASE/stderr" || {
  fail "invalid IPv4 APP_URL rejection was not explicit"
}
printf '%s\n' 'APP_URL=https://pilot.example.test' >"$work/compose.env"
echo "ok - rollback rejects an IPv4 APP_URL before Docker"
mail_contract_path="$work/records/20260719T000000Z-2/mail-outbox-contract.env"
set_rollback_git_evidence \
  "$retention_boundary_commit" "$retention_boundary_tree" \
  "$pre_retention_commit" "$pre_retention_tree"
cat >"$mail_contract_path" <<'EOF'
SCHEMA_VERSION=1
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
STORE_CUTOVER=false
PREVIOUS_MAIL_OUTBOX_PHASE=dual-write-v1
PREVIOUS_OUTBOX_WORKER_MODE=fenced-postgres-v1
EOF
chmod 0600 "$mail_contract_path"
cp "$work/records/current-release.env" "$work/v1-contract-current-before.env"
cp "$work/records/latest-candidate.env" "$work/v1-contract-candidate-before.env"
run_rollback v1-contract-across-0062 --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a v1 fenced contract across 0062"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "v1 contract 0062 rollback refusal"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "v1 contract 0062 refusal reached smoke"
[[ ! -s "$ROLLBACK_CASE/stdout" ]] || fail "v1 contract 0062 refusal wrote stdout"
grep -Fq '0062_mail_outbox_retention_redaction' "$ROLLBACK_CASE/stderr" || {
  fail "v1 contract 0062 refusal did not name the boundary"
}
grep -Fq 'SCHEMA_VERSION=1' "$ROLLBACK_CASE/stderr" || {
  fail "v1 contract 0062 refusal did not identify the insufficient schema"
}
if grep -Fq 'previous verified application image record bytes' \
  "$ROLLBACK_CASE/stdout" "$ROLLBACK_CASE/stderr"; then
  fail "v1 contract 0062 refusal disclosed retained release evidence"
fi
cmp -s "$work/records/current-release.env" "$work/v1-contract-current-before.env" || {
  fail "v1 contract 0062 refusal changed the current pointer"
}
cmp -s "$work/records/latest-candidate.env" "$work/v1-contract-candidate-before.env" || {
  fail "v1 contract 0062 refusal changed the candidate pointer"
}
echo "ok - rollback refuses a v1 fenced contract across 0062"

set_rollback_git_evidence \
  "$pre_retention_commit" "$pre_retention_tree" \
  "$older_pre_retention_commit" "$older_pre_retention_tree"
cp "$work/records/current-release.env" "$work/v1-pre-retention-current-before.env"
cp "$work/records/latest-candidate.env" "$work/v1-pre-retention-candidate-before.env"
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
  "$work/v1-pre-retention-valid.override.yaml"
printf '%s\n' 'not-services:' >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
run_rollback v1-contract-wholly-pre-0062 --schema-backward-compatible
mv "$work/v1-pre-retention-valid.override.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "pre-0062 v1 gate fixture unexpectedly completed rollback"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "wholly pre-0062 v1 exception"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "wholly pre-0062 v1 exception reached smoke"
[[ ! -s "$ROLLBACK_CASE/stdout" ]] || fail "wholly pre-0062 v1 exception wrote stdout"
grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr" || {
  fail "exact wholly pre-0062 evidence did not pass the v1 contract gate"
}
if grep -Eq 'SCHEMA_VERSION=1 mail outbox contract evidence is insufficient|migration lineage' \
  "$ROLLBACK_CASE/stderr"; then
  fail "exact wholly pre-0062 evidence was rejected by the v1 contract gate"
fi
cmp -s "$work/records/current-release.env" "$work/v1-pre-retention-current-before.env" || {
  fail "wholly pre-0062 v1 exception changed the current pointer"
}
cmp -s "$work/records/latest-candidate.env" "$work/v1-pre-retention-candidate-before.env" || {
  fail "wholly pre-0062 v1 exception changed the candidate pointer"
}
echo "ok - rollback keeps the v1 contract gate strictly at 0062"

set_rollback_git_evidence \
  "$retention_boundary_commit" "$retention_boundary_tree" \
  "$pre_retention_commit" "$pre_retention_tree"
rm -f "$mail_contract_path"
cp "$work/records/current-release.env" "$work/missing-contract-current-before.env"
cp "$work/records/latest-candidate.env" "$work/missing-contract-candidate-before.env"
run_rollback missing-contract-across-0062 --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted an absent contract across 0062"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "absent contract 0062 rollback refusal"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "absent contract 0062 refusal reached smoke"
[[ ! -s "$ROLLBACK_CASE/stdout" ]] || fail "absent contract 0062 refusal wrote stdout"
grep -Fq '0062_mail_outbox_retention_redaction' "$ROLLBACK_CASE/stderr" || {
  fail "absent contract 0062 refusal did not name the boundary"
}
grep -Fq 'mail outbox contract evidence is absent' "$ROLLBACK_CASE/stderr" || {
  fail "absent contract 0062 refusal did not identify the missing evidence"
}
if grep -Fq 'previous verified application image record bytes' \
  "$ROLLBACK_CASE/stdout" "$ROLLBACK_CASE/stderr"; then
  fail "absent contract 0062 refusal disclosed retained release evidence"
fi
cmp -s "$work/records/current-release.env" "$work/missing-contract-current-before.env" || {
  fail "absent contract 0062 refusal changed the current pointer"
}
cmp -s "$work/records/latest-candidate.env" "$work/missing-contract-candidate-before.env" || {
  fail "absent contract 0062 refusal changed the candidate pointer"
}
echo "ok - rollback refuses an absent contract across 0062"

fixture_git_tree="$(git -C "$work/repo" rev-parse --verify 'HEAD^{tree}')"
forged_target_commit="$(
  printf '%s\n' 'forged graft target' | git -C "$work/repo" commit-tree "$fixture_git_tree"
)"
forged_source_commit="$(
  printf '%s\n' 'forged graft source' | \
    git -C "$work/repo" commit-tree "$fixture_git_tree" -p "$forged_target_commit"
)"
forged_graft_file="$work/forged-grafts"
printf '%s %s\n' "$contract_required_commit" "$forged_source_commit" >"$forged_graft_file"
set_rollback_git_evidence \
  "$forged_source_commit" "$fixture_git_tree" \
  "$forged_target_commit" "$fixture_git_tree"
cp "$work/records/current-release.env" "$work/forged-graft-current-before.env"
cp "$work/records/latest-candidate.env" "$work/forged-graft-candidate-before.env"
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
  "$work/forged-graft-valid.override.yaml"
printf '%s\n' 'not-services:' >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
for graft_mode in repository ambient; do
  case "$graft_mode" in
    ambient)
      GIT_GRAFT_FILE="$forged_graft_file" \
        run_rollback forged-ambient-graft --schema-backward-compatible
      ;;
    repository)
      cp "$forged_graft_file" "$work/repo/.git/info/grafts"
      run_rollback forged-repository-graft --schema-backward-compatible
      cmp -s "$forged_graft_file" "$work/repo/.git/info/grafts" || {
        fail "rollback modified repository graft evidence instead of safely ignoring it"
      }
      rm -f "$work/repo/.git/info/grafts"
      ;;
  esac
  [[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted $graft_mode forged Git ancestry"
  assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "$graft_mode graft refusal"
  [[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "$graft_mode graft refusal reached smoke"
  [[ ! -s "$ROLLBACK_CASE/stdout" ]] || fail "$graft_mode graft refusal wrote stdout"
  grep -Fq 'mail outbox contract evidence is absent' "$ROLLBACK_CASE/stderr" || {
    fail "$graft_mode forged ancestry was not rejected by the legacy contract gate"
  }
  grep -Fq 'SCHEMA_VERSION=1' "$ROLLBACK_CASE/stderr" || {
    fail "$graft_mode graft refusal did not name the required contract schema"
  }
  if grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr"; then
    fail "$graft_mode forged ancestry passed the legacy contract gate"
  fi
  if grep -Fq 'previous verified application image record bytes' \
    "$ROLLBACK_CASE/stdout" "$ROLLBACK_CASE/stderr" \
    || grep -Fq "$forged_source_commit" "$ROLLBACK_CASE/stdout" "$ROLLBACK_CASE/stderr" \
    || grep -Fq "$forged_target_commit" "$ROLLBACK_CASE/stdout" "$ROLLBACK_CASE/stderr"; then
    fail "$graft_mode graft refusal disclosed release evidence"
  fi
  cmp -s "$work/records/current-release.env" "$work/forged-graft-current-before.env" || {
    fail "$graft_mode graft refusal changed the current pointer"
  }
  cmp -s "$work/records/latest-candidate.env" "$work/forged-graft-candidate-before.env" || {
    fail "$graft_mode graft refusal changed the candidate pointer"
  }
done
mv "$work/forged-graft-valid.override.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
echo "ok - rollback rejects ambient and repository forged Git graft ancestry"

set_rollback_git_evidence \
  "$contract_required_commit" "$contract_required_tree" \
  "$pre_contract_commit" "$pre_contract_tree"
cp "$work/records/current-release.env" "$work/post-contract-current-before.env"
cp "$work/records/latest-candidate.env" "$work/post-contract-candidate-before.env"
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
  "$work/post-contract-valid.override.yaml"
printf '%s\n' 'not-services:' >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
run_rollback missing-contract-after-contract-requirement --schema-backward-compatible
mv "$work/post-contract-valid.override.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted an absent contract after contracts became mandatory"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "post-contract-requirement absent refusal"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "post-contract-requirement absent refusal reached smoke"
[[ ! -s "$ROLLBACK_CASE/stdout" ]] || fail "post-contract-requirement absent refusal wrote stdout"
grep -Fq 'mail outbox contract evidence is absent' "$ROLLBACK_CASE/stderr" || {
  fail "post-contract-requirement absent refusal did not identify the missing contract"
}
grep -Fq 'SCHEMA_VERSION=1' "$ROLLBACK_CASE/stderr" || {
  fail "post-contract-requirement absent refusal did not name the required contract schema"
}
if grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr"; then
  fail "post-contract-requirement absent evidence passed the legacy contract gate"
fi
if grep -Fq 'previous verified application image record bytes' \
  "$ROLLBACK_CASE/stdout" "$ROLLBACK_CASE/stderr"; then
  fail "post-contract-requirement absent refusal disclosed retained release evidence"
fi
cmp -s "$work/records/current-release.env" "$work/post-contract-current-before.env" || {
  fail "post-contract-requirement absent refusal changed the current pointer"
}
cmp -s "$work/records/latest-candidate.env" "$work/post-contract-candidate-before.env" || {
  fail "post-contract-requirement absent refusal changed the candidate pointer"
}
echo "ok - rollback refuses an absent contract after contracts became mandatory"

set_rollback_git_evidence \
  "$pre_retention_commit" "$pre_retention_tree" \
  "$older_pre_retention_commit" "$candidate_tree"
run_rollback missing-contract-untrusted-tree --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted mismatched pre-0062 Git tree evidence"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "mismatched pre-0062 tree refusal"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "mismatched pre-0062 tree refusal reached smoke"
[[ ! -s "$ROLLBACK_CASE/stdout" ]] || fail "mismatched pre-0062 tree refusal wrote stdout"
grep -Fq 'trusted release Git tree evidence does not match repository objects' \
  "$ROLLBACK_CASE/stderr" || {
  fail "mismatched pre-0062 tree refusal was not explicit"
}
if grep -Fq 'previous verified application image record bytes' \
  "$ROLLBACK_CASE/stdout" "$ROLLBACK_CASE/stderr"; then
  fail "mismatched pre-0062 tree refusal disclosed retained release evidence"
fi
echo "ok - rollback rejects mismatched pre-0062 Git tree evidence"

set_rollback_git_evidence \
  "$pre_contract_commit" "$pre_contract_tree" \
  "$older_pre_contract_commit" "$older_pre_contract_tree"
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
  "$work/pre-contract-valid.override.yaml"
printf '%s\n' 'not-services:' >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
run_rollback missing-contract-wholly-pre-contract --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "pre-contract gate fixture unexpectedly completed rollback"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "wholly pre-contract exception"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "wholly pre-contract exception reached smoke"
grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr" || {
  fail "exact wholly pre-contract evidence did not pass the legacy contract gate"
}
if grep -Eq 'contract evidence is absent|SCHEMA_VERSION=1|migration lineage' \
  "$ROLLBACK_CASE/stderr"; then
  fail "exact wholly pre-contract evidence was rejected by the legacy contract gate"
fi
mv "$work/pre-contract-valid.override.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
echo "ok - rollback permits the absent-contract gate only wholly before contracts became mandatory"

set_rollback_git_evidence \
  "$dispatch_binding_compatible_target_commit" "$dispatch_binding_compatible_target_tree" \
  "$dispatch_binding_boundary_commit" "$dispatch_binding_boundary_tree"
cat >"$mail_contract_path" <<'EOF'
SCHEMA_VERSION=2
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
STORE_CUTOVER=false
PREVIOUS_MAIL_OUTBOX_PHASE=dual-write-v1
PREVIOUS_OUTBOX_WORKER_MODE=fenced-postgres-v1
PREVIOUS_OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
PREVIOUS_RUNTIME_COMPATIBLE=true
FORWARD_ONLY_MIGRATION=none
EOF
chmod 0600 "$mail_contract_path"
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
  "$work/dispatch-binding-no-target-valid.override.yaml"
printf '%s\n' 'not-services:' >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
run_rollback dispatch-binding-no-target-capability --schema-backward-compatible
mv "$work/dispatch-binding-no-target-valid.override.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback restored an image without exact dispatch binding"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "0064 no-binding rollback refusal"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "0064 no-binding refusal reached smoke"
[[ ! -s "$ROLLBACK_CASE/stdout" ]] || fail "0064 no-binding refusal wrote stdout"
grep -Fq '0064_mail_outbox_dispatch_binding' "$ROLLBACK_CASE/stderr" || {
  fail "0064 no-binding rollback refusal did not name the authority boundary"
}
if grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr"; then
  fail "0064 no-binding rollback reached override execution evidence"
fi
if grep -Eq '[0-9a-f]{40}|[0-9a-f]{64}' "$ROLLBACK_CASE/stdout" "$ROLLBACK_CASE/stderr"; then
  fail "0064 no-binding rollback refusal disclosed Git or capability hashes"
fi
echo "ok - rollback refuses a pre-capability image after 0064 regardless of operator assertion"

dispatch_binding_boundary_tree_missing_objects="$work/dispatch-binding-boundary-tree-missing-objects"
mkdir -p "$dispatch_binding_boundary_tree_missing_objects/pack"
dispatch_binding_boundary_tree_missing_pack="$(
  GIT_NO_LAZY_FETCH=1 git -C "$work/repo" cat-file --batch-all-objects \
      --batch-check='%(objectname)' \
    | awk -v omitted="$dispatch_binding_boundary_tree" \
        '$1 != omitted { print $1 }' \
    | GIT_NO_LAZY_FETCH=1 git -C "$work/repo" pack-objects \
        "$dispatch_binding_boundary_tree_missing_objects/pack/pack"
)" || fail "unable to create the missing 0064 boundary-tree fixture"
[[ "$dispatch_binding_boundary_tree_missing_pack" =~ ^[0-9a-f]{40}([0-9a-f]{24})?$ ]] || {
  fail "missing 0064 boundary-tree fixture pack identity is malformed"
}
for dispatch_binding_local_evidence in \
    "${dispatch_binding_boundary_commit}^{commit}" \
    "${dispatch_binding_pre_boundary_source_commit}^{commit}" \
    "${dispatch_binding_pre_boundary_source_commit}^{tree}" \
    "${dispatch_binding_pre_boundary_target_commit}^{commit}" \
    "${dispatch_binding_pre_boundary_target_commit}^{tree}"; do
  GIT_OBJECT_DIRECTORY="$dispatch_binding_boundary_tree_missing_objects" \
    GIT_NO_LAZY_FETCH=1 git -C "$work/repo" cat-file -e \
      "$dispatch_binding_local_evidence" >/dev/null 2>&1 || {
    fail "missing 0064 boundary-tree fixture lost required local lineage evidence"
  }
done
if GIT_OBJECT_DIRECTORY="$dispatch_binding_boundary_tree_missing_objects" \
    GIT_NO_LAZY_FETCH=1 git -C "$work/repo" cat-file -e \
      "${dispatch_binding_boundary_commit}^{tree}" >/dev/null 2>&1; then
  fail "missing 0064 boundary-tree fixture unexpectedly retained the boundary tree"
fi

v2_dispatch_binding_lineage_failures=0
check_v2_dispatch_binding_lineage_refusal() {
  local scenario="$1" source_commit="$2" source_tree="$3"
  local target_commit="$4" target_tree="$5" expected_error="$6"
  local backup="$work/$scenario.valid.override.yaml" case_failed=false
  set_rollback_git_evidence \
    "$source_commit" "$source_tree" "$target_commit" "$target_tree"
  cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" "$backup"
  printf '%s\n' 'not-services:' \
    >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
  run_rollback "$scenario" --schema-backward-compatible
  mv "$backup" "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
  chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
  if [[ "$ROLLBACK_STATUS" == 0 ]]; then
    case_failed=true
  fi
  assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "$scenario refusal"
  [[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "$scenario refusal reached smoke"
  [[ ! -s "$ROLLBACK_CASE/stdout" ]] || fail "$scenario refusal wrote stdout"
  if ! grep -Fq "$expected_error" "$ROLLBACK_CASE/stderr"; then
    case_failed=true
  fi
  if grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr"; then
    case_failed=true
  fi
  if grep -Eq '[0-9a-f]{40}|[0-9a-f]{64}' \
    "$ROLLBACK_CASE/stdout" "$ROLLBACK_CASE/stderr"; then
    fail "$scenario refusal disclosed Git hashes"
  fi
  if [[ "$case_failed" == true ]]; then
    printf 'unsafe V2 dispatch-binding lineage case: %s\n' "$scenario" >&2
    v2_dispatch_binding_lineage_failures="$((v2_dispatch_binding_lineage_failures + 1))"
  fi
}

check_v2_dispatch_binding_lineage_refusal \
  dispatch-binding-v2-unrelated-no-migration \
  "$dispatch_binding_unapproved_legacy_source_commit" \
  "$dispatch_binding_unapproved_target_tree" \
  "$dispatch_binding_unapproved_target_commit" \
  "$dispatch_binding_unapproved_target_tree" \
  'legacy mail outbox contract evidence requires exact source and previous images strictly before 0064_mail_outbox_dispatch_binding'
check_v2_dispatch_binding_lineage_refusal \
  dispatch-binding-v2-unknown-source \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  "$dispatch_binding_pre_boundary_target_commit" \
  "$dispatch_binding_pre_boundary_target_tree" \
  'unable to verify the trusted 0064_mail_outbox_dispatch_binding lineage'
check_v2_dispatch_binding_lineage_refusal \
  dispatch-binding-v2-unknown-target \
  "$dispatch_binding_pre_boundary_source_commit" \
  "$dispatch_binding_pre_boundary_source_tree" \
  cccccccccccccccccccccccccccccccccccccccc \
  dddddddddddddddddddddddddddddddddddddddd \
  'unable to verify the trusted 0064_mail_outbox_dispatch_binding lineage'
RUN_GIT_OBJECT_DIRECTORY="$dispatch_binding_pruned_objects" \
  check_v2_dispatch_binding_lineage_refusal \
    dispatch-binding-v2-pruned-shallow-target \
    "$older_pre_contract_commit" "$older_pre_contract_tree" \
    "$dispatch_binding_pruned_source_commit" "$dispatch_binding_pruned_source_tree" \
    'unable to verify the trusted 0064_mail_outbox_dispatch_binding lineage'
RUN_GIT_OBJECT_DIRECTORY="$dispatch_binding_boundary_tree_missing_objects" \
  check_v2_dispatch_binding_lineage_refusal \
    dispatch-binding-v2-missing-boundary-tree \
    "$dispatch_binding_pre_boundary_source_commit" \
    "$dispatch_binding_pre_boundary_source_tree" \
    "$dispatch_binding_pre_boundary_target_commit" \
    "$dispatch_binding_pre_boundary_target_tree" \
    'unable to verify trusted 0064 release Git trees'
check_v2_dispatch_binding_lineage_refusal \
  dispatch-binding-v2-source-tree-mismatch \
  "$dispatch_binding_pre_boundary_source_commit" "$dispatch_binding_boundary_tree" \
  "$dispatch_binding_pre_boundary_target_commit" \
  "$dispatch_binding_pre_boundary_target_tree" \
  'trusted 0064 release Git tree evidence does not match repository objects'
check_v2_dispatch_binding_lineage_refusal \
  dispatch-binding-v2-target-tree-mismatch \
  "$dispatch_binding_pre_boundary_source_commit" \
  "$dispatch_binding_pre_boundary_source_tree" \
  "$dispatch_binding_pre_boundary_target_commit" "$dispatch_binding_boundary_tree" \
  'trusted 0064 release Git tree evidence does not match repository objects'
check_v2_dispatch_binding_lineage_refusal \
  dispatch-binding-v2-nonancestor \
  "$dispatch_binding_pre_boundary_target_commit" \
  "$dispatch_binding_pre_boundary_target_tree" \
  "$dispatch_binding_pre_boundary_source_commit" \
  "$dispatch_binding_pre_boundary_source_tree" \
  'the previous image is not an ancestor of the recorded source image'
(( v2_dispatch_binding_lineage_failures == 0 )) || {
  fail "$v2_dispatch_binding_lineage_failures unsafe V2 dispatch-binding lineage cases reached later rollback validation"
}
echo "ok - V2 rollback requires exact local strictly pre-0064 source and target lineage"

set_rollback_git_evidence \
  "$dispatch_binding_pre_boundary_source_commit" \
  "$dispatch_binding_pre_boundary_source_tree" \
  "$dispatch_binding_pre_boundary_target_commit" \
  "$dispatch_binding_pre_boundary_target_tree"
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
  "$work/dispatch-binding-v2-pre-boundary-valid.override.yaml"
printf '%s\n' 'not-services:' \
  >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
run_rollback dispatch-binding-v2-exact-pre-boundary --schema-backward-compatible
mv "$work/dispatch-binding-v2-pre-boundary-valid.override.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "exact pre-0064 V2 gate fixture unexpectedly completed rollback"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "exact pre-0064 V2 gate"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "exact pre-0064 V2 gate reached smoke"
grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr" || {
  fail "exact local pre-0064 V2 evidence did not pass the dispatch-binding lineage gate"
}
if grep -Eq '0064_mail_outbox_dispatch_binding|trusted 0064 release' \
  "$ROLLBACK_CASE/stderr"; then
  fail "exact local pre-0064 V2 evidence was rejected by the dispatch-binding lineage gate"
fi
echo "ok - rollback permits exact local V2 lineage only wholly before 0064"

set_rollback_git_evidence \
  "$dispatch_binding_unapproved_source_commit" "$dispatch_binding_unapproved_source_tree" \
  "$dispatch_binding_unapproved_target_commit" "$dispatch_binding_unapproved_target_tree"
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
  "$work/dispatch-binding-unapproved-lineage-valid.override.yaml"
printf '%s\n' 'not-services:' >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
run_rollback dispatch-binding-unapproved-lineage --schema-backward-compatible
mv "$work/dispatch-binding-unapproved-lineage-valid.override.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted 0064 outside its approved lineage"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "unapproved 0064 lineage refusal"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "unapproved 0064 lineage reached smoke"
[[ ! -s "$ROLLBACK_CASE/stdout" ]] || fail "unapproved 0064 lineage wrote stdout"
grep -Fq '0064_mail_outbox_dispatch_binding exists outside its approved Git lineage' \
  "$ROLLBACK_CASE/stderr" || {
  fail "unapproved 0064 lineage refusal was not explicit"
}
if grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr"; then
  fail "unapproved 0064 lineage reached override execution evidence"
fi
if grep -Eq '[0-9a-f]{40}|[0-9a-f]{64}' \
  "$ROLLBACK_CASE/stdout" "$ROLLBACK_CASE/stderr"; then
  fail "unapproved 0064 lineage refusal disclosed Git hashes"
fi
echo "ok - rollback rejects any 0064 migration outside its approved Git lineage"

set_rollback_git_evidence \
  "$dispatch_binding_compatible_source_commit" "$dispatch_binding_compatible_tree" \
  "$dispatch_binding_compatible_target_commit" "$dispatch_binding_compatible_target_tree"
cat >"$mail_contract_path" <<EOF
SCHEMA_VERSION=3
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
DISPATCH_BINDING_RUNTIME=$dispatch_binding_runtime_capability
DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract
STORE_CUTOVER=false
PREVIOUS_MAIL_OUTBOX_PHASE=dual-write-v1
PREVIOUS_OUTBOX_WORKER_MODE=fenced-postgres-v1
PREVIOUS_OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
PREVIOUS_DISPATCH_BINDING_RUNTIME=$dispatch_binding_runtime_capability
PREVIOUS_DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract
PREVIOUS_RUNTIME_COMPATIBLE=true
FORWARD_ONLY_MIGRATION=none
EOF
chmod 0600 "$mail_contract_path"
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
  "$work/dispatch-binding-compatible-valid.override.yaml"
printf '%s\n' 'not-services:' >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
RUN_REPO_ROOT="$dispatch_binding_real_repo" RUN_STAGE_TIMEOUT=30 \
  run_rollback dispatch-binding-compatible-fenced --schema-backward-compatible
unset RUN_REPO_ROOT RUN_STAGE_TIMEOUT
mv "$work/dispatch-binding-compatible-valid.override.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "compatible dispatch binding gate fixture unexpectedly completed rollback"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "compatible 0064 rollback gate"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "compatible 0064 gate reached smoke"
grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr" || {
  cat "$ROLLBACK_CASE/stderr" >&2
  fail "exact compatible fenced images did not pass the 0064 rollback gate"
}
if grep -Eq '0064_mail_outbox_dispatch_binding|dispatch binding capability' \
  "$ROLLBACK_CASE/stderr"; then
  fail "exact compatible fenced images were rejected by the 0064 rollback gate"
fi
echo "ok - rollback permits only exact compatible fenced dispatch binding images"

write_guarded_delivery_rollback_contract() {
  cat >"$mail_contract_path" <<EOF
SCHEMA_VERSION=4
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
DISPATCH_BINDING_RUNTIME=$dispatch_binding_runtime_capability
DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract
GUARDED_DELIVERY_RUNTIME=$guarded_delivery_runtime_capability
DELIVERY_RELEASE_AUTHORITY=$delivery_release_authority_contract
GUARDED_DELIVERY_PRIVILEGE=$guarded_delivery_privilege_contract
STORE_CUTOVER=false
PREVIOUS_MAIL_OUTBOX_PHASE=dual-write-v1
PREVIOUS_OUTBOX_WORKER_MODE=fenced-postgres-v1
PREVIOUS_OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
PREVIOUS_DISPATCH_BINDING_RUNTIME=$dispatch_binding_runtime_capability
PREVIOUS_DISPATCH_BINDING_PRIVILEGE=$dispatch_binding_privilege_contract
PREVIOUS_GUARDED_DELIVERY_RUNTIME=$guarded_delivery_runtime_capability
PREVIOUS_DELIVERY_RELEASE_AUTHORITY=$delivery_release_authority_contract
PREVIOUS_GUARDED_DELIVERY_PRIVILEGE=$guarded_delivery_privilege_contract
PREVIOUS_RUNTIME_COMPATIBLE=true
FORWARD_ONLY_MIGRATION=none
EOF
  chmod 0600 "$mail_contract_path"
}

set_rollback_git_evidence \
  "$guarded_delivery_exact_source_commit" "$guarded_delivery_exact_tree" \
  "$guarded_delivery_exact_target_commit" "$guarded_delivery_exact_tree"
write_guarded_delivery_rollback_contract
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
  "$work/guarded-delivery-exact-valid.override.yaml"
printf '%s\n' 'not-services:' >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
RUN_STAGE_TIMEOUT=30 \
  run_rollback guarded-delivery-exact-compatible --schema-backward-compatible
unset RUN_STAGE_TIMEOUT
mv "$work/guarded-delivery-exact-valid.override.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "exact 0069 capability fixture unexpectedly completed rollback"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "exact 0069 guarded delivery rollback gate"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "exact 0069 gate reached smoke"
grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr" || {
  cat "$ROLLBACK_CASE/stderr" >&2
  fail "exact source and previous 0069 capabilities did not pass the guarded rollback gate"
}
if grep -Eq '0069_mail_outbox_guarded_delivery_authority|guarded delivery capability' \
    "$ROLLBACK_CASE/stderr"; then
  fail "exact source and previous 0069 capabilities were rejected"
fi
echo "ok - rollback accepts exact compatible source and previous 0069 capability trees"

snapshot_guarded_delivery_evidence() {
  /usr/bin/sha256sum \
    "$work/records/20260719T000000Z-2/status.env" \
    "$work/records/20260719T000000Z-2/git-commit.txt" \
    "$work/records/20260719T000000Z-2/git-tree.txt" \
    "$work/records/20260719T000000Z-2/previous-release-id.txt" \
    "$work/records/20260719T000000Z-2/previous-git-commit.txt" \
    "$work/records/20260719T000000Z-2/previous-running-images.tsv" \
    "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
    "$mail_contract_path" \
    "$work/records/20260719T000000Z-1/status.env" \
    "$work/records/20260719T000000Z-1/git-commit.txt" \
    "$work/records/20260719T000000Z-1/git-tree.txt"
}

guarded_delivery_refusal_failures=0
check_guarded_delivery_refusal() {
  local scenario="$1" source_commit="$2" source_tree="$3"
  local target_commit="$4" target_tree="$5" expected_image="$6"
  local current_before="$work/$scenario.current-before.env"
  local candidate_before="$work/$scenario.candidate-before.env"
  local evidence_before="$work/$scenario.evidence-before.sha256"
  local evidence_after="$work/$scenario.evidence-after.sha256"
  local case_failed=false

  set_rollback_git_evidence \
    "$source_commit" "$source_tree" "$target_commit" "$target_tree"
  write_guarded_delivery_rollback_contract
  cp "$work/records/current-release.env" "$current_before"
  cp "$work/records/latest-candidate.env" "$candidate_before"
  snapshot_guarded_delivery_evidence >"$evidence_before"
  RUN_STAGE_TIMEOUT=30 \
    run_rollback "$scenario" --schema-backward-compatible
  unset RUN_STAGE_TIMEOUT

  [[ "$ROLLBACK_STATUS" != 0 ]] || case_failed=true
  assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "$scenario" || case_failed=true
  [[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || case_failed=true
  [[ ! -s "$ROLLBACK_CASE/stdout" ]] || case_failed=true
  cmp -s "$work/records/current-release.env" "$current_before" || case_failed=true
  cmp -s "$work/records/latest-candidate.env" "$candidate_before" || case_failed=true
  snapshot_guarded_delivery_evidence >"$evidence_after"
  cmp -s "$evidence_before" "$evidence_after" || case_failed=true
  grep -Eq '0069_mail_outbox_guarded_delivery_authority|guarded delivery (capability|migration)' \
    "$ROLLBACK_CASE/stderr" || case_failed=true
  grep -Fq "$expected_image" "$ROLLBACK_CASE/stderr" || case_failed=true
  if grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr" \
      || grep -Eq '[0-9a-f]{40}|[0-9a-f]{64}' \
        "$ROLLBACK_CASE/stdout" "$ROLLBACK_CASE/stderr"; then
    case_failed=true
  fi

  if [[ "$case_failed" == true ]]; then
    printf 'unsafe guarded delivery rollback case: %s\n' "$scenario" >&2
    guarded_delivery_refusal_failures="$((guarded_delivery_refusal_failures + 1))"
  fi
}

check_guarded_delivery_refusal guarded-delivery-capability-missing \
  "$guarded_delivery_missing_source_commit" "$guarded_delivery_missing_tree" \
  "$guarded_delivery_missing_target_commit" "$guarded_delivery_missing_tree" \
  'source image'
check_guarded_delivery_refusal guarded-delivery-capability-tampered \
  "$guarded_delivery_tampered_source_commit" "$guarded_delivery_tampered_tree" \
  "$guarded_delivery_tampered_target_commit" "$guarded_delivery_tampered_tree" \
  'source image'
check_guarded_delivery_refusal guarded-delivery-previous-capability-missing \
  "$guarded_delivery_missing_previous_source_commit" "$guarded_delivery_exact_tree" \
  "$guarded_delivery_missing_target_commit" "$guarded_delivery_missing_tree" \
  'previous image'
check_guarded_delivery_refusal guarded-delivery-previous-capability-tampered \
  "$guarded_delivery_tampered_previous_source_commit" "$guarded_delivery_exact_tree" \
  "$guarded_delivery_tampered_target_commit" "$guarded_delivery_tampered_tree" \
  'previous image'
check_guarded_delivery_refusal guarded-delivery-source-migration-stale \
  "$guarded_delivery_stale_source_commit" "$guarded_delivery_stale_migration_tree" \
  "$guarded_delivery_exact_target_commit" "$guarded_delivery_exact_tree" \
  'source image'
check_guarded_delivery_refusal guarded-delivery-previous-migration-stale \
  "$guarded_delivery_exact_over_stale_target_commit" "$guarded_delivery_exact_tree" \
  "$guarded_delivery_stale_target_commit" "$guarded_delivery_stale_migration_tree" \
  'previous image'

(( guarded_delivery_refusal_failures == 0 )) || {
  fail "$guarded_delivery_refusal_failures unsafe guarded delivery rollback cases reached mutation or lacked an explicit refusal"
}
echo "ok - rollback fails closed for stale migration, missing, or tampered source and previous 0069 evidence"
set_rollback_git_evidence \
  "$dispatch_binding_unknown_capability_commit" "$dispatch_binding_unknown_capability_tree" \
  "$dispatch_binding_compatible_target_commit" "$dispatch_binding_compatible_target_tree"
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
  "$work/dispatch-binding-unknown-valid.override.yaml"
printf '%s\n' 'not-services:' >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
run_rollback dispatch-binding-unknown-future-capability --schema-backward-compatible
mv "$work/dispatch-binding-unknown-valid.override.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted an unknown future capability version"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "unknown dispatch binding capability refusal"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "unknown capability refusal reached smoke"
[[ ! -s "$ROLLBACK_CASE/stdout" ]] || fail "unknown capability refusal wrote stdout"
grep -Fq 'absent, unknown, or mismatched version' "$ROLLBACK_CASE/stderr" || {
  fail "unknown future dispatch binding capability was not rejected explicitly"
}
if grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr"; then
  fail "unknown future dispatch binding capability reached override evidence"
fi
if grep -Eq '[0-9a-f]{40}|[0-9a-f]{64}' "$ROLLBACK_CASE/stdout" "$ROLLBACK_CASE/stderr"; then
  fail "unknown future dispatch binding capability refusal disclosed hashes"
fi
echo "ok - rollback fails closed for future capability versions until an exact boundary is approved"
set_rollback_git_evidence \
  "$dispatch_binding_wrong_mode_commit" "$dispatch_binding_wrong_mode_tree" \
  "$dispatch_binding_compatible_target_commit" "$dispatch_binding_compatible_target_tree"
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
  "$work/dispatch-binding-wrong-mode-valid.override.yaml"
printf '%s\n' 'not-services:' >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
run_rollback dispatch-binding-wrong-mode --schema-backward-compatible
mv "$work/dispatch-binding-wrong-mode-valid.override.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted an executable capability manifest"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "wrong-mode capability refusal"
[[ ! -s "$ROLLBACK_CASE/smoke.log" && ! -s "$ROLLBACK_CASE/stdout" ]] || {
  fail "wrong-mode capability refusal reached later rollback work"
}
grep -Fq 'not a canonical regular Git blob' "$ROLLBACK_CASE/stderr" || {
  fail "wrong-mode capability was not rejected explicitly"
}
if grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr"; then
  fail "wrong-mode capability reached override evidence"
fi
echo "ok - rollback rejects a mode-100755 capability before Docker work beyond quarantine"

set_rollback_git_evidence \
  "$dispatch_binding_tampered_commit" "$dispatch_binding_tampered_tree" \
  "$dispatch_binding_compatible_target_commit" "$dispatch_binding_compatible_target_tree"
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" \
  "$work/dispatch-binding-tampered-valid.override.yaml"
printf '%s\n' 'not-services:' >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
run_rollback dispatch-binding-tampered --schema-backward-compatible
mv "$work/dispatch-binding-tampered-valid.override.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a tampered capability manifest"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "tampered capability refusal"
[[ ! -s "$ROLLBACK_CASE/smoke.log" && ! -s "$ROLLBACK_CASE/stdout" ]] || {
  fail "tampered capability refusal reached later rollback work"
}
grep -Fq 'absent, unknown, or mismatched version' "$ROLLBACK_CASE/stderr" || {
  fail "tampered capability was not rejected explicitly"
}
if grep -Fq 'rollback override is malformed' "$ROLLBACK_CASE/stderr"; then
  fail "tampered capability reached override evidence"
fi
echo "ok - rollback rejects same-schema tampered capability content before later Docker work"

set_rollback_git_evidence \
  "$candidate_commit" "$candidate_tree" "$previous_commit" "$previous_tree"
cp "$work/records/current-release.env" "$work/mail-boundary-current-before.env"
cp "$work/records/latest-candidate.env" "$work/mail-boundary-candidate-before.env"
cat >"$mail_contract_path" <<'EOF'
SCHEMA_VERSION=1
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
STORE_CUTOVER=false
PREVIOUS_MAIL_OUTBOX_PHASE=legacy-v0
PREVIOUS_OUTBOX_WORKER_MODE=legacy-direct-v1
EOF
chmod 0600 "$mail_contract_path"
run_rollback fenced-worker-transition --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback restored the legacy direct mail claimant"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "fenced worker rollback refusal"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "fenced worker rollback refusal reached smoke"
grep -Fq 'legacy direct claimant cannot be restored' "$ROLLBACK_CASE/stderr" || {
  fail "fenced worker rollback refusal was not explicit"
}
cmp -s "$work/records/current-release.env" "$work/mail-boundary-current-before.env" || {
  fail "fenced worker rollback refusal changed the current release pointer"
}
cmp -s "$work/records/latest-candidate.env" "$work/mail-boundary-candidate-before.env" || {
  fail "fenced worker rollback refusal changed the candidate pointer"
}
echo "ok - rollback refuses fenced-postgres-v1 to legacy-direct-v1"

cat >"$mail_contract_path" <<'EOF'
SCHEMA_VERSION=2
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
STORE_CUTOVER=false
PREVIOUS_MAIL_OUTBOX_PHASE=dual-write-v1
PREVIOUS_OUTBOX_WORKER_MODE=fenced-postgres-v1
PREVIOUS_OUTBOX_RETENTION_AUTHORITY=legacy-direct-v1
PREVIOUS_RUNTIME_COMPATIBLE=false
FORWARD_ONLY_MIGRATION=0062_mail_outbox_retention_redaction
EOF
chmod 0600 "$mail_contract_path"
run_rollback retention-authority-transition --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback restored the pre-0062 retention authority"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "retention authority rollback refusal"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "retention authority rollback refusal reached smoke"
grep -Fq '0062_mail_outbox_retention_redaction' "$ROLLBACK_CASE/stderr" || {
  fail "retention authority rollback refusal did not name migration 0062"
}
cmp -s "$work/records/current-release.env" "$work/mail-boundary-current-before.env" || {
  fail "retention authority rollback refusal changed the current release pointer"
}
cmp -s "$work/records/latest-candidate.env" "$work/mail-boundary-candidate-before.env" || {
  fail "retention authority rollback refusal changed the candidate pointer"
}
echo "ok - rollback refuses the pre-0062 retention authority"

cat >"$work/records/20260719T000000Z-2/mail-outbox-contract.env" <<'EOF'
SCHEMA_VERSION=1
MAIL_OUTBOX_PHASE=store-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
STORE_CUTOVER=true
PREVIOUS_MAIL_OUTBOX_PHASE=dual-write-v1
PREVIOUS_OUTBOX_WORKER_MODE=fenced-postgres-v1
EOF
chmod 0600 "$work/records/20260719T000000Z-2/mail-outbox-contract.env"
run_rollback mail-store-cutover --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback restored the pre-cutover artifact across store cutover"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "mail store cutover rollback"
grep -Fq 'mail store cutover is forward-only' "$ROLLBACK_CASE/stderr" || {
  fail "mail store cutover rollback refusal was not explicit"
}
rm -f "$work/records/20260719T000000Z-2/mail-outbox-contract.env"
echo "ok - rollback refuses the pre-cutover artifact across mail store cutover"

authority_environment=(
  DOCKER_HOST
  DOCKER_CONTEXT
  DOCKER_CONFIG
  DOCKER_CERT_PATH
  DOCKER_TLS
  DOCKER_TLS_VERIFY
  DOCKER_API_VERSION
  DOCKER_DEFAULT_PLATFORM
  DOCKER_CUSTOM_HEADERS
  COMPOSE_FILE
  COMPOSE_PATH_SEPARATOR
  COMPOSE_PROJECT_NAME
  COMPOSE_PROFILES
  COMPOSE_ENV_FILES
  COMPOSE_DISABLE_ENV_FILE
  COMPOSE_CONVERT_WINDOWS_PATHS
  COMPOSE_IGNORE_ORPHANS
  COMPOSE_REMOVE_ORPHANS
  COMPOSE_PARALLEL_LIMIT
  COMPOSE_EXPERIMENTAL
  COMPOSE_BAKE
  COMPOSE_PROVIDER
)
for authority_variable in "${authority_environment[@]}"; do
  export "$authority_variable=attacker-controlled"
  run_rollback "ambient-${authority_variable,,}" --schema-backward-compatible
  unset "$authority_variable"
  [[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted ambient authority from $authority_variable"
  [[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "$authority_variable reached Docker"
  grep -Fq "$authority_variable is forbidden" "$ROLLBACK_CASE/stderr" || fail "$authority_variable rejection was not explicit"
done
echo "ok - rollback rejects ambient Docker and Compose authority before mutation"

grep -Fq -- '== /run/lock ]]; then' "$rollback" || {
  fail "rollback does not isolate the production /run/lock exception"
}
grep -Fq -- '== 0:0:1777 ]] || fatal "/run/lock must be exactly root:root mode 1777"' "$rollback" || {
  fail "rollback does not require exact root:root 1777 metadata for /run/lock"
}
echo "ok - rollback permits only the exact production /run/lock metadata contract"

# shellcheck disable=SC2016
grep -Fq '[[ -z "${RELEASE_LOCK_FILE+x}" ]] || fatal "RELEASE_LOCK_FILE is forbidden in production"' "$rollback" || {
  fail "rollback does not reject ambient production lock authority"
}

lock_attack_root="$work/lock-object-attacks"
mkdir -p "$lock_attack_root"
chmod 0700 "$lock_attack_root"

missing_lock="$lock_attack_root/missing.lock"
RUN_LOCK_FILE="$missing_lock" RUN_LOCK_PRECREATE=false \
  run_rollback success --schema-backward-compatible
unset RUN_LOCK_FILE RUN_LOCK_PRECREATE
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback created and accepted a missing lock object"
[[ ! -e "$missing_lock" && ! -L "$missing_lock" ]] || fail "rollback created the missing lock object"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "missing rollback lock reached Docker"

fifo_lock="$lock_attack_root/fifo.lock"
mkfifo "$fifo_lock"
exec 8<>"$fifo_lock"
RUN_LOCK_FILE="$fifo_lock" run_rollback success --schema-backward-compatible
unset RUN_LOCK_FILE
exec 8>&-
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a FIFO lock object"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "FIFO lock object reached Docker"

symlink_target="$lock_attack_root/symlink-target.lock"
printf '%s\n' lock >"$symlink_target"
chmod 0600 "$symlink_target"
ln -s "$symlink_target" "$lock_attack_root/symlink.lock"
RUN_LOCK_FILE="$lock_attack_root/symlink.lock" run_rollback success --schema-backward-compatible
unset RUN_LOCK_FILE
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a symlink lock object"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "symlink lock object reached Docker"

hardlink_target="$lock_attack_root/hardlink-target.lock"
printf '%s\n' lock >"$hardlink_target"
chmod 0600 "$hardlink_target"
ln "$hardlink_target" "$lock_attack_root/hardlink.lock"
RUN_LOCK_FILE="$lock_attack_root/hardlink.lock" run_rollback success --schema-backward-compatible
unset RUN_LOCK_FILE
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a multiply-linked lock object"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "multiply-linked lock object reached Docker"

wrong_mode_lock="$lock_attack_root/wrong-mode.lock"
printf '%s\n' lock >"$wrong_mode_lock"
chmod 0644 "$wrong_mode_lock"
RUN_LOCK_FILE="$wrong_mode_lock" run_rollback success --schema-backward-compatible
unset RUN_LOCK_FILE
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback repaired and accepted a wrong-mode lock object"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "wrong-mode lock object reached Docker"

wrong_owner_lock="$lock_attack_root/wrong-owner.lock"
printf '%s\n' lock >"$wrong_owner_lock"
chmod 0600 "$wrong_owner_lock"
chown 65534:65534 "$wrong_owner_lock"
RUN_LOCK_FILE="$wrong_owner_lock" run_rollback success --schema-backward-compatible
unset RUN_LOCK_FILE
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a wrong-owner lock object"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "wrong-owner lock object reached Docker"
chown "$EUID:$(stat -c '%g' "$work")" "$wrong_owner_lock"

swap_lock="$lock_attack_root/path-swap.lock"
printf '%s\n' lock >"$swap_lock"
chmod 0600 "$swap_lock"
RUN_LOCK_FILE="$swap_lock" RUN_LOCK_SWAP_PATH="$swap_lock" \
  run_rollback lock-path-swap-after-flock --schema-backward-compatible
unset RUN_LOCK_FILE RUN_LOCK_SWAP_PATH
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a lock path replaced after flock"
[[ -f "$swap_lock.detached" ]] || fail "rollback lock path-swap hook did not execute"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "split rollback lock reached Docker"

run_rollback quarantine-stop-failure --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted two failed initial tunnel stops"
[[ "$(cat "$ROLLBACK_CASE/quarantine-stop.count")" -ge 3 ]] || {
  fail "rollback EXIT trap did not retry tunnel quarantine after initial stop failure"
}
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "initial rollback tunnel-stop failure"

run_rollback signal-first-quarantine-stop --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "signalled rollback unexpectedly completed"
[[ "$(cat "$ROLLBACK_CASE/quarantine-stop.count")" -ge 2 ]] || {
  fail "rollback signal trap did not retry tunnel quarantine"
}
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "signalled initial rollback tunnel stop"

run_rollback repeated-signal-early-cleanup --schema-backward-compatible
[[ "$ROLLBACK_STATUS" == 143 ]] || fail "repeated early rollback signals did not preserve the first TERM status"
[[ "$(cat "$ROLLBACK_CASE/quarantine-stop.count")" -ge 3 ]] || {
  fail "repeated early rollback signals aborted the bounded quarantine retry"
}
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "repeated early rollback cleanup signals"

cat >"$mail_contract_path" <<'EOF'
SCHEMA_VERSION=2
MAIL_OUTBOX_PHASE=dual-write-v1
OUTBOX_WORKER_MODE=fenced-postgres-v1
OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
STORE_CUTOVER=false
PREVIOUS_MAIL_OUTBOX_PHASE=dual-write-v1
PREVIOUS_OUTBOX_WORKER_MODE=fenced-postgres-v1
PREVIOUS_OUTBOX_RETENTION_AUTHORITY=ops-owner-security-definer-v1
PREVIOUS_RUNTIME_COMPATIBLE=true
FORWARD_ONLY_MIGRATION=none
EOF
chmod 0600 "$mail_contract_path"

run_rollback repeated-signal-late-cleanup --schema-backward-compatible
[[ "$ROLLBACK_STATUS" == 51 ]] || fail "repeated late rollback signals did not preserve the smoke failure status"
[[ "$(cat "$ROLLBACK_CASE/quarantine-stop.count")" -ge 3 ]] || {
  fail "repeated late rollback signals aborted the bounded quarantine retry"
}

echo "ok - rollback rejects unsafe lock object types, links, ownership, and mode"
echo "ok - rollback arms fail-closed signal and EXIT traps before initial quarantine"

rm -f "$work/repo/RELEASE.SHA256SUMS"
run_rollback missing-release-manifest --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a missing source manifest"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "missing rollback manifest"
cp "$work/valid-release-manifest" "$work/repo/RELEASE.SHA256SUMS"

printf '%s\n' 'not a release manifest' >"$work/repo/RELEASE.SHA256SUMS"
run_rollback malformed-release-manifest --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a malformed source manifest"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "malformed rollback manifest"
grep -Fq 'release manifest' "$ROLLBACK_CASE/stderr" || {
  fail "malformed rollback manifest rejection was not explicit"
}
cp "$work/valid-release-manifest" "$work/repo/RELEASE.SHA256SUMS"

head -n 1 "$work/valid-release-manifest" >>"$work/repo/RELEASE.SHA256SUMS"
run_rollback extra-release-manifest-record --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted an extra manifest record"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "extra rollback manifest record"
cp "$work/valid-release-manifest" "$work/repo/RELEASE.SHA256SUMS"

{
  IFS= read -r first_manifest_record
  printf '0%s\n' "${first_manifest_record:1}"
  tail -n +2
} <"$work/valid-release-manifest" >"$work/repo/RELEASE.SHA256SUMS"
run_rollback tampered-release-manifest --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a tampered manifest digest"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "tampered rollback manifest"
cp "$work/valid-release-manifest" "$work/repo/RELEASE.SHA256SUMS"
echo "ok - rollback requires the exact canonical host release manifest under quarantine"

run_rollback missing-assertion
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted no schema compatibility assertion"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "unsafe rollback touched Docker"

chmod 0666 "$work/repo/compose.yaml"
run_rollback writable-compose --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a group/world-writable Compose file"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "writable Compose input reached Docker"
chmod 0644 "$work/repo/compose.yaml"

chmod 0775 "$work/smoke-production.sh"
run_rollback writable-smoke --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a group-writable root-executed smoke script"
[[ ! -s "$ROLLBACK_CASE/docker.log" ]] || fail "writable smoke input reached Docker"
chmod 0755 "$work/smoke-production.sh"

mv "$work/repo" "$work/real-repo"
ln -s "$work/real-repo" "$work/repo"
run_rollback symlinked-repo-parent --schema-backward-compatible
symlink_status="$ROLLBACK_STATUS"
symlink_case="$ROLLBACK_CASE"
rm "$work/repo"
mv "$work/real-repo" "$work/repo"
[[ "$symlink_status" != 0 ]] || fail "rollback accepted a repository path with a symlink component"
[[ ! -s "$symlink_case/docker.log" ]] || fail "symlinked rollback input reached Docker"

echo "ok - rollback rejects writable and symlinked root-executed inputs"

chown 65534:65534 "$work/repo/compose.yaml"
run_rollback wrong-owner-compose --schema-backward-compatible
wrong_owner_status="$ROLLBACK_STATUS"
wrong_owner_case="$ROLLBACK_CASE"
chown "$EUID:$(stat -c '%g' "$work")" "$work/repo/compose.yaml"
[[ "$wrong_owner_status" != 0 ]] || fail "rollback accepted a Compose file owned by another identity"
[[ ! -s "$wrong_owner_case/docker.log" ]] || fail "wrong-owner Compose input reached Docker"
grep -Eqi 'owned|dirty' "$wrong_owner_case/stderr" || {
  cat "$wrong_owner_case/stderr" >&2
  fail "wrong-owner rejection was not explicit"
}

echo "ok - rollback rejects root-executed input owned by another identity"

chmod 0666 "$work/records/20260719T000000Z-2/previous-running-images.tsv"
run_rollback writable-release-evidence --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted group/world-writable release evidence"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "writable release evidence"
chmod 0644 "$work/records/20260719T000000Z-2/previous-running-images.tsv"
grep -Fqi 'writable' "$ROLLBACK_CASE/stderr" || fail "writable evidence rejection was not explicit"
echo "ok - rollback rejects writable release evidence before rollback mutation"

printf '%s\n' 'result=failed' >"$work/records/20260719T000000Z-1/status.env"
run_rollback incomplete-previous --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted an incomplete previous release"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "incomplete previous release"
printf '%s\n' 'result=completed' >"$work/records/20260719T000000Z-1/status.env"
echo "ok - rollback requires a retained completed previous release"

cp "$work/records/20260719T000000Z-2/previous-running-images.tsv" "$work/previous-running-images.bound.tsv"
cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" "$work/previous-runtime.bound.yaml"
sed -i 's#/previous-#/swapped-#g' "$work/records/20260719T000000Z-2/previous-running-images.tsv"
sed -i 's#/previous-#/swapped-#g' "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
run_rollback swapped-reviewed-runtime --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted self-consistent runtime evidence not bound to the previous completed release"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "unbound rollback evidence"
mv "$work/previous-running-images.bound.tsv" \
  "$work/records/20260719T000000Z-2/previous-running-images.tsv"
mv "$work/previous-runtime.bound.yaml" \
  "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
echo "ok - rollback evidence is bound to the previous completed release inventory"

printf '%s\n' 'release_id=20260719T000000Z-9' 'git_commit=9999999999999999999999999999999999999999' \
  >"$work/records/latest-candidate.env"
run_rollback stale-release-record --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a release record that is not the latest candidate"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "stale release record"
printf '%s\n' 'release_id=20260719T000000Z-2' "git_commit=$candidate_commit" \
  >"$work/records/latest-candidate.env"

echo "ok - rollback rejects a stale release record before mutation"

cp "$work/records/current-release.env" "$work/rollback-pointer-before.env"
cp "$work/records/latest-candidate.env" "$work/rollback-candidate-before.env"
run_rollback runtime-state-active-fsync-failure --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback ignored active runtime state fsync failure"
[[ -f "$work/control/release-quarantine" ]] || fail "failed rollback did not leave durable quarantine"
cmp -s "$work/records/current-release.env" "$work/rollback-pointer-before.env" || {
  fail "rollback runtime state failure advanced the deployed pointer"
}
cmp -s "$work/records/latest-candidate.env" "$work/rollback-candidate-before.env" || {
  fail "rollback runtime state failure consumed the candidate pointer"
}
[[ ! -e "$work/runtime-state/active-release.env" ]] || {
  fail "rollback runtime state failure published an uncommitted active manifest"
}
[[ "$(grep -Fc $'stop\t--timeout\t30\tcloudflared' "$ROLLBACK_CASE/docker.log")" -ge 2 ]] || {
  fail "rollback runtime state failure did not re-quarantine the tunnel"
}
if find "$work/runtime-state" -mindepth 1 -maxdepth 1 -name '.*.tmp' -print -quit | grep -q .; then
  fail "rollback runtime state failure left a temporary publication artifact"
fi
echo "ok - rollback runtime state publication failure preserves the prior commit point"
rollback_application_blob="$work/runtime-state/application-images.${previous_application_sha}.json"
[[ -f "$rollback_application_blob" ]] || fail "failed rollback did not durably publish its pre-commit application record"
printf '%s\n' 'corrupted content-addressed rollback record' >"$rollback_application_blob"
run_rollback preexisting-runtime-state-corruption --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback overwrote a corrupted existing content-addressed record"
grep -Fq 'does not match its content address' "$ROLLBACK_CASE/stderr" || {
  fail "rollback content-address collision rejection was not explicit"
}
cmp -s "$work/records/current-release.env" "$work/rollback-pointer-before.env" || {
  fail "corrupted rollback content record advanced the deployed pointer"
}
cmp -s "$work/records/latest-candidate.env" "$work/rollback-candidate-before.env" || {
  fail "corrupted rollback content record consumed the candidate pointer"
}
[[ ! -e "$work/runtime-state/active-release.env" ]] || fail "corrupted rollback content record published an active manifest"
cat "$work/records/20260719T000000Z-1/application-image-record.json" >"$rollback_application_blob"
chmod 0644 "$rollback_application_blob"
echo "ok - rollback rejects a corrupted pre-existing content-addressed record"


run_rollback success --schema-backward-compatible
[[ "$ROLLBACK_STATUS" == 0 ]] || {
  cat "$ROLLBACK_CASE/stderr" >&2
  cat "$ROLLBACK_CASE/docker.log" >&2
  fail "valid rollback failed"
}
[[ ! -e "$work/control/release-quarantine" ]] || fail "successful rollback did not clear quarantine exactly once"
[[ "$(cat "$ROLLBACK_CASE/smoke.log")" == $'--phase internal --startup-wait 3\n--phase public --startup-wait 3' ]] || {
  fail "rollback did not smoke internal before public"
}
grep -Fq $'stop\t--timeout\t30\tcloudflared' "$ROLLBACK_CASE/docker.log" || fail "rollback did not quarantine tunnel first"
grep -Fq $'\t-f\t'"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"$'\tup\t-d\t--no-build\t--pull\tnever' \
  "$ROLLBACK_CASE/docker.log" || fail "rollback did not use recorded override with immutable flags"
if grep -Eq $'(^|\\t)(pull|build)(\\t|$)' "$ROLLBACK_CASE/docker.log"; then
  fail "rollback pulled or built an image"
fi
grep -Fxq 'release_id=20260719T000000Z-1' "$work/records/current-release.env" || fail "rollback pointer release id is wrong"
grep -Fxq "git_commit=$previous_commit" "$work/records/current-release.env" || fail "rollback pointer Git commit is wrong"
grep -Fq 'previous_runtime_restored' "$work/records/20260719T000000Z-2/rollback-executions.tsv" || fail "rollback audit evidence missing"
grep -Fxq 'release_id=20260719T000000Z-1' "$work/records/latest-candidate.env" || fail "latest candidate pointer did not advance after rollback"
grep -Fxq "git_commit=$previous_commit" "$work/records/latest-candidate.env" || fail "latest candidate Git pointer is wrong after rollback"
active_state="$work/runtime-state/active-release.env"
[[ -f "$active_state" && ! -L "$active_state" ]] || fail "rollback did not publish active release state"
active_managed_sha="$(sed -n 's/^MANAGED_INVENTORY_SHA256=//p' "$active_state")"
active_application_sha="$(sed -n 's/^APPLICATION_IMAGE_RECORD_SHA256=//p' "$active_state")"
managed_state="$work/runtime-state/managed-containers.${active_managed_sha}.tsv"
application_state="$work/runtime-state/application-images.${active_application_sha}.json"
[[ -f "$managed_state" && ! -L "$managed_state" ]] || fail "rollback did not publish content-addressed managed container state"
[[ -f "$application_state" && ! -L "$application_state" ]] || fail "rollback did not publish content-addressed application image state"
[[ "$(stat -c '%a' "$active_state")" == 644 \
  && "$(stat -c '%a' "$managed_state")" == 644 \
  && "$(stat -c '%a' "$application_state")" == 644 ]] || {
  fail "rollback runtime state does not have protected mode 0644"
}
cmp -s "$managed_state" "$work/records/20260719T000000Z-2/rollback-managed-containers.tsv" || {
  fail "rollback inventory is not retained in its execution record"
}
cmp -s "$application_state" "$work/records/20260719T000000Z-1/application-image-record.json" || {
  fail "rollback published the current checkout record instead of the previous retained application image record"
}
if cmp -s "$application_state" "$work/repo/dist/application-images/application-images.json"; then
  fail "rollback recovery state was rebound to the different current checkout record"
fi
cmp -s "$active_state" "$work/records/20260719T000000Z-2/rollback-active-release.env" || {
  fail "rollback active state is not retained in its execution record"
}
[[ ! -e "$work/runtime-state/managed-containers.tsv" && ! -e "$work/runtime-state/application-images.json" ]] || {
  fail "rollback left a mutable fixed evidence path"
}
mapfile -t rollback_services < <(cut -f1 "$managed_state")
expected_rollback_services=(
  app cloudflared exam-finalization-worker mail-worker postgres
  practice-runner-recovery-worker project-review-correction-worker regrade-worker reward-worker runner-egress-gateway
)
[[ "${rollback_services[*]}" == "${expected_rollback_services[*]}" ]] || fail "rollback inventory coverage is invalid"
while IFS=$'\t' read -r service container _image _identity extra; do
  [[ -n "$service" && -z "$extra" && "$container" == "learncoding-$service-1" ]] || {
    fail "rollback inventory row is malformed"
  }
done <"$managed_state"
managed_sha="$(sha256sum "$managed_state" | cut -d' ' -f1)"
manifest_sha="$(sha256sum "$work/repo/RELEASE.SHA256SUMS" | cut -d' ' -f1)"
firewall_sha="$(sha256sum "$work/repo/infra/runner-vm/host-runner.nft" | cut -d' ' -f1)"
runtime_sha="$(sha256sum "$work/repo/services/runner/dist/runtime-images.env" | cut -d' ' -f1)"
expected_active="$(printf '%s\n' \
  'SCHEMA_VERSION=1' "GIT_COMMIT=$previous_commit" "GIT_TREE=$previous_tree" \
  "RELEASE_MANIFEST_SHA256=$manifest_sha" \
  "APPLICATION_IMAGE_RECORD_SHA256=$previous_application_sha" \
  'COMPOSE_PROJECT=learncoding' 'COMPOSE_WORKDIR=/opt/learncoding' \
  'PUBLIC_ORIGIN=https://pilot.example.test' "MANAGED_INVENTORY_SHA256=$managed_sha" \
  "FIREWALL_POLICY_SHA256=$firewall_sha" "RUNNER_GUEST_RELEASE_SHA256=$manifest_sha" \
  "RUNNER_RUNTIME_IMAGES_SHA256=$runtime_sha")"
[[ "$(cat "$active_state")" == "$expected_active" ]] || fail "rollback active manifest is not consumer-compatible"
grep -Fq -- "$managed_state" "$ROLLBACK_CASE/sync.log" || fail "rollback inventory was not fsynced"
grep -Fq -- "$application_state" "$ROLLBACK_CASE/sync.log" || fail "rollback application image record was not fsynced"
grep -Fq -- "$active_state" "$ROLLBACK_CASE/sync.log" || fail "rollback active state was not fsynced"
echo "ok - paste-ready rollback restores only exact local images and advances the pointer"

run_rollback repeated-stale-record --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted an already-restored stale release record"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "already-restored stale release record"
echo "ok - successful rollback consumes the candidate state exactly once"

printf '%s\n' \
  'release_id=20260719T000000Z-2' \
  'result=completed' \
  'stage=complete' \
  'exit_code=0' \
  'schema_rollback=not_attempted' >"$work/records/20260719T000000Z-2/status.env"
printf '%s\n' 'release_id=20260719T000000Z-2' "git_commit=$candidate_commit" \
  >"$work/records/current-release.env"
printf '%s\n' 'release_id=20260719T000000Z-2' "git_commit=$candidate_commit" \
  >"$work/records/latest-candidate.env"
run_rollback public-failure --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted failed public smoke"
[[ -f "$work/control/release-quarantine" ]] || fail "failed public smoke did not recreate durable quarantine"
[[ "$(grep -Fc $'stop\t--timeout\t30\tcloudflared' "$ROLLBACK_CASE/docker.log")" -ge 2 ]] || {
  fail "failed rollback did not re-quarantine the tunnel"
}
grep -Fxq 'release_id=20260719T000000Z-2' "$work/records/current-release.env" || {
  fail "failed rollback changed the deployed release pointer"
}
echo "ok - failed rollback remains fail closed and preserves the current pointer"

run_rollback success --schema-backward-compatible
[[ "$ROLLBACK_STATUS" == 0 ]] || fail "rollback rerun did not recover from durable quarantine"
[[ ! -e "$work/control/release-quarantine" ]] || fail "successful rollback rerun did not clear durable quarantine"
echo "ok - failed rollback remains quarantined until a successful rerun"

cp "$work/records/20260719T000000Z-2/previous-runtime.override.yaml" "$work/bad.override"
sed -i '3c\    image: "registry.example.test/codestead/previous-app:mutable"' "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
run_rollback malformed --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted a mutable image override"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "mutable rollback image override"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "malformed rollback reached smoke"
mv "$work/bad.override" "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
echo "ok - rollback rejects modified or mutable image evidence before mutation"

cp "$work/records/20260719T000000Z-2/previous-running-images.tsv" "$work/previous-running-images.good.tsv"
sed -i '1s/sha256:0000000000000000000000000000000000000000000000000000000000000008$/sha256:0000000000000000000000000000000000000000000000000000000000000009/' \
  "$work/records/20260719T000000Z-2/previous-running-images.tsv"
run_rollback tampered-identity --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted image identity evidence that no longer matches local storage"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "tampered rollback image identity"
[[ ! -s "$ROLLBACK_CASE/smoke.log" ]] || fail "tampered identity evidence reached smoke"
mv "$work/previous-running-images.good.tsv" "$work/records/20260719T000000Z-2/previous-running-images.tsv"
echo "ok - rollback binds override references to recorded and local image identities"

printf '%s\n' \
  'release_id=20260719T000000Z-2' \
  'result=failed' \
  'stage=public-readiness' \
  'exit_code=1' \
  'schema_rollback=not_attempted' >"$work/records/20260719T000000Z-2/status.env"
printf '%s\n' 'release_id=20260719T000000Z-1' "git_commit=$previous_commit" \
  >"$work/records/current-release.env"
printf '%s\n' 'release_id=20260719T000000Z-2' "git_commit=$candidate_commit" \
  >"$work/records/latest-candidate.env"
grep -v '^runner-egress-gateway' "$work/records/20260719T000000Z-2/previous-running-images.tsv" \
  >"$work/legacy-previous-running-images.tsv"
mv "$work/legacy-previous-running-images.tsv" \
  "$work/records/20260719T000000Z-2/previous-running-images.tsv"
grep -v '^runner-egress-gateway' "$work/records/20260719T000000Z-1/deployed-service-images.tsv" \
  >"$work/legacy-deployed-service-images.tsv"
mv "$work/legacy-deployed-service-images.tsv" \
  "$work/records/20260719T000000Z-1/deployed-service-images.tsv"
{
  printf 'services:\n'
  for service in app runner-egress-gateway mail-worker reward-worker regrade-worker \
    exam-finalization-worker practice-runner-recovery-worker project-review-correction-worker cloudflared; do
    printf '  %s:\n' "$service"
    if [[ "$service" == runner-egress-gateway ]]; then
      printf '    image: "registry.example.test/codestead/gateway@sha256:%064d"\n' 9
    else
      printf '    image: "registry.example.test/codestead/previous-%s@sha256:%064d"\n' "$service" 7
    fi
  done
} >"$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime.override.yaml"
{
  printf '%s\n' \
    'SCHEMA_VERSION=1' \
    'MODE=legacy_pre_gateway' \
    'PREVIOUS_RELEASE_ID=20260719T000000Z-1' \
    'SOURCE_RELEASE_ID=20260719T000000Z-2' \
    "SOURCE_GIT_COMMIT=$candidate_commit" \
    'RETAINED_SERVICE=runner-egress-gateway' \
    "RETAINED_IMAGE=registry.example.test/codestead/gateway@sha256:$(printf '%064d' 9)" \
    "RETAINED_IDENTITY=sha256:$(printf '%064d' 8)"
} >"$work/records/20260719T000000Z-2/previous-runtime-transition.env"
chmod 0600 "$work/records/20260719T000000Z-2/previous-runtime-transition.env"
transition_path="$work/records/20260719T000000Z-2/previous-runtime-transition.env"
cp "$transition_path" "$work/valid-previous-runtime-transition.env"
sed -i "s/SOURCE_GIT_COMMIT=$candidate_commit/SOURCE_GIT_COMMIT=4444444444444444444444444444444444444444/" "$transition_path"
run_rollback tampered-legacy-transition --schema-backward-compatible
[[ "$ROLLBACK_STATUS" != 0 ]] || fail "rollback accepted transition evidence bound to another candidate"
assert_only_quarantine_stops "$ROLLBACK_CASE/docker.log" "unbound transition evidence"
grep -Fqi 'transition' "$ROLLBACK_CASE/stderr" || {
  fail "unbound transition evidence rejection was not explicit"
}
mv "$work/valid-previous-runtime-transition.env" "$transition_path"
chmod 0600 "$transition_path"
echo "ok - rollback rejects unbound pre-gateway transition evidence before rollback mutation"


run_rollback legacy-gateway-transition --schema-backward-compatible
[[ "$ROLLBACK_STATUS" == 0 ]] || {
  cat "$ROLLBACK_CASE/stderr" >&2
  fail "rollback rejected the exact versioned pre-gateway transition"
}
legacy_active="$work/runtime-state/active-release.env"
legacy_managed_sha="$(sed -n 's/^MANAGED_INVENTORY_SHA256=//p' "$legacy_active")"
legacy_managed="$work/runtime-state/managed-containers.${legacy_managed_sha}.tsv"
grep -Fq $'runner-egress-gateway\tlearncoding-runner-egress-gateway-1\tregistry.example.test/codestead/gateway@sha256:' \
  "$legacy_managed" || fail "legacy rollback inventory does not expose the retained gateway version"
grep -Fq 'previous_runtime_restored_legacy_gateway_retained' \
  "$work/records/20260719T000000Z-2/rollback-executions.tsv" || {
  fail "legacy rollback audit does not name the mixed transition"
}
echo "ok - rollback restores pre-gateway services while retaining the reviewed gateway with explicit evidence"

echo "rollback-production-tests-ok"
