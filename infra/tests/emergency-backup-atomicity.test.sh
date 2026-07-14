#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
backup="$repo_root/scripts/backup/emergency-backup.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/bin" "$work/target/emergency" "$work/stage"
printf '%s\n' LEARNCODING_EMERGENCY_V1 >"$work/target/.learncoding-backup-root"
chmod 0600 "$work/target/.learncoding-backup-root"
printf '%s\n' age1testrecipient >"$work/recipient.txt"
chmod 0600 "$work/recipient.txt"

cat >"$work/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -eu
printf '%s' 'synthetic-postgres-custom-dump'
EOF

cat >"$work/bin/age" <<'EOF'
#!/usr/bin/env bash
set -eu
cat >/dev/null
printf '%s' 'synthetic-age-ciphertext'
EOF

cat >"$work/bin/sha256sum" <<'EOF'
#!/usr/bin/env bash
set -eu
count=0
[[ ! -f "$TEST_SHA_STATE" ]] || count="$(cat "$TEST_SHA_STATE")"
count=$((count + 1))
printf '%s' "$count" >"$TEST_SHA_STATE"
if (( count == 2 )); then
  exit 74
fi
exec /usr/bin/sha256sum "$@"
EOF
chmod 0755 "$work/bin/docker" "$work/bin/age" "$work/bin/sha256sum"

config="$work/backup.env"
cat >"$config" <<EOF
REPO_ROOT=$repo_root
COMPOSE_ENV_FILE=$work/missing-compose.env
EMERGENCY_BACKUP_ROOT=$work/target
BACKUP_STAGE_ROOT=$work/stage
BACKUP_LOCK_FILE=$work/backup.lock
AGE_RECIPIENT_FILE=$work/recipient.txt
EOF
chmod 0600 "$config"

if PATH="$work/bin:$PATH" TEST_SHA_STATE="$work/sha-count" BACKUP_CONFIG_FILE="$config" bash "$backup" >/dev/null 2>&1; then
  echo "emergency backup unexpectedly succeeded after checksum publication failure" >&2
  exit 1
fi

if find "$work/target/emergency" -mindepth 1 -print -quit | grep -q .; then
  echo "failed emergency publication left an archive, checksum, or temporary file" >&2
  exit 1
fi
if find "$work/stage" -mindepth 1 -print -quit | grep -q .; then
  echo "failed emergency publication left staged plaintext" >&2
  exit 1
fi

echo "emergency-backup-atomicity-tests-ok"
