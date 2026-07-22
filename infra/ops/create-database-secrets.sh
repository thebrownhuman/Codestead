#!/usr/bin/env bash
set -Eeuo pipefail

# This initial-creation ceremony is intentionally silent on every path.
exec >/dev/null 2>&1

default_secrets_dir='/etc/learncoding/secrets'
secrets_dir="${CODESTEAD_SECRETS_DIR:-$default_secrets_dir}"
test_group="${CODESTEAD_SECRETS_TEST_GROUP:-}"
target_group='codestead-secrets'
current_uid=''
script_dir=''
validator=''
lock_candidate=''
lock_dir=''
staging_dir=''
success='0'
created_finals=()
secret_names=(
  postgres_password
  database_bootstrap_url
  database_url
  database_migrator_url
  database_worker_url
  database_ops_url
)
postgres_password=''
app_password=''
migrator_password=''
worker_password=''
ops_password=''

cleanup() {
  local status="$?"
  local name final staged
  trap - EXIT HUP INT TERM

  if [[ "$success" != '1' ]]; then
    for final in "${created_finals[@]}"; do
      rm -f -- "$final" || true
    done

    # Covers a signal delivered after an atomic link but before array tracking.
    if [[ -n "$staging_dir" ]]; then
      for name in "${secret_names[@]}"; do
        staged="$staging_dir/$name"
        final="$secrets_dir/$name"
        if [[ -e "$staged" && -e "$final" && "$staged" -ef "$final" ]]; then
          rm -f -- "$final" || true
        fi
      done
    fi
  fi

  [[ -z "$staging_dir" ]] || rm -rf -- "$staging_dir" || true
  [[ -z "$lock_dir" ]] || rmdir -- "$lock_dir" || true
  unset postgres_password app_password migrator_password worker_password ops_password
  unset name final staged created_finals secret_names success staging_dir lock_dir lock_candidate
  unset validator script_dir current_uid target_group test_group secrets_dir default_secrets_dir
  unset CODESTEAD_SECRETS_DIR CODESTEAD_SECRETS_TEST_GROUP
  exit "$status"
}

abort() {
  exit 1
}

trap cleanup EXIT
trap abort HUP INT TERM

generate_password() {
  local generated_password
  generated_password="$(openssl rand -hex 32)"
  [[ "$generated_password" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$generated_password"
  unset generated_password
}

write_secret() {
  local secret_name="$1"
  local secret_value="$2"
  printf '%s' "$secret_value" >"$staging_dir/$secret_name"
  unset secret_name secret_value
}

current_uid="$(id -u)"
if [[ "$secrets_dir" == "$default_secrets_dir" ]]; then
  [[ "$current_uid" == '0' && -z "$test_group" ]] || exit 1
  install -d -o root -g codestead-secrets -m 0750 "$secrets_dir"
else
  if [[ -n "$test_group" ]]; then
    target_group="$test_group"
  fi
  if [[ "$current_uid" == '0' ]]; then
    install -d -o root -g "$target_group" -m 0750 "$secrets_dir"
  else
    install -d -m 0750 "$secrets_dir"
  fi
fi

lock_candidate="$secrets_dir/.database-secret-ceremony.lock"
trap '' HUP INT TERM
if mkdir -m 0700 -- "$lock_candidate"; then
  lock_dir="$lock_candidate"
else
  trap abort HUP INT TERM
  exit 1
fi
trap abort HUP INT TERM

for name in "${secret_names[@]}"; do
  [[ ! -e "$secrets_dir/$name" && ! -L "$secrets_dir/$name" ]] || exit 1
done

staging_dir="$(mktemp -d "$secrets_dir/.database-secret-ceremony.stage.XXXXXXXX")"
chmod 0700 "$staging_dir"
umask 077

postgres_password="$(generate_password)"
app_password="$(generate_password)"
migrator_password="$(generate_password)"
worker_password="$(generate_password)"
ops_password="$(generate_password)"

[[ "$postgres_password" != "$app_password" &&
  "$postgres_password" != "$migrator_password" &&
  "$postgres_password" != "$worker_password" &&
  "$postgres_password" != "$ops_password" &&
  "$app_password" != "$migrator_password" &&
  "$app_password" != "$worker_password" &&
  "$app_password" != "$ops_password" &&
  "$migrator_password" != "$worker_password" &&
  "$migrator_password" != "$ops_password" &&
  "$worker_password" != "$ops_password" ]] || exit 1

write_secret postgres_password "$postgres_password"
write_secret database_bootstrap_url \
  "postgresql://learncoding:$postgres_password@postgres:5432/learncoding"
write_secret database_url \
  "postgresql://learncoding_app:$app_password@postgres:5432/learncoding"
write_secret database_migrator_url \
  "postgresql://learncoding_migrator:$migrator_password@postgres:5432/learncoding"
write_secret database_worker_url \
  "postgresql://learncoding_worker:$worker_password@postgres:5432/learncoding"
write_secret database_ops_url \
  "postgresql://learncoding_ops:$ops_password@postgres:5432/learncoding"

if [[ "$current_uid" == '0' ]]; then
  if [[ "$secrets_dir" == "$default_secrets_dir" ]]; then
    chown root:codestead-secrets "$staging_dir"/*
  else
    chown root:"$target_group" "$staging_dir"/*
  fi
fi
chmod 0440 "$staging_dir"/*

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
validator="$script_dir/validate-database-secrets.mjs"
/usr/bin/node "$validator" \
  learncoding learncoding \
  "$staging_dir/postgres_password" \
  "$staging_dir/database_bootstrap_url" \
  "$staging_dir/database_url" \
  "$staging_dir/database_migrator_url" \
  "$staging_dir/database_worker_url" \
  "$staging_dir/database_ops_url"

for name in "${secret_names[@]}"; do
  staged="$staging_dir/$name"
  final="$secrets_dir/$name"
  ln -- "$staged" "$final"
  created_finals+=("$final")
done

for name in "${secret_names[@]}"; do
  rm -- "$staging_dir/$name"
done
rmdir -- "$staging_dir"
staging_dir=''
rmdir -- "$lock_dir"
lock_dir=''
success='1'
exit 0