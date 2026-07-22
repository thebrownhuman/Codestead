#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
create="$repo_root/scripts/backup/create-recovery-kit.sh"
verify="$repo_root/scripts/backup/verify-recovery-kit.sh"

[[ -f "$create" && -f "$verify" ]] || {
  echo "recovery-kit-test-failed: recovery-kit commands are missing" >&2
  exit 1
}

work="$(mktemp -d)"
cleanup() {
  rm -rf --one-file-system -- "$work"
}
trap cleanup EXIT

full="$work/full"
emergency="$work/emergency"
mkdir -p -m 0700 -- "$full/recovery-kits" "$emergency/recovery-kits"
printf '%s\n' LEARNCODING_BACKUP_V1 >"$full/.learncoding-backup-root"
printf '%s\n' LEARNCODING_EMERGENCY_V1 >"$emergency/.learncoding-backup-root"
chmod 0600 "$full/.learncoding-backup-root" "$emergency/.learncoding-backup-root"

backup_identity="$work/backup-age-identity.txt"
kit_identity="$work/recovery-kit-identity.txt"
kit_recipient="$work/recovery-kit-recipient.txt"
age-keygen -o "$backup_identity" >/dev/null 2>&1
age-keygen -o "$kit_identity" >/dev/null 2>&1
age-keygen -y "$kit_identity" >"$kit_recipient"
chmod 0600 "$backup_identity" "$kit_identity" "$kit_recipient"

credential_key="$work/credential_master_key"
printf '%s\n' 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=' >"$credential_key"
chmod 0440 "$credential_key"

metadata="$work/recovery-kit-metadata.env"
cat >"$metadata" <<'EOF'
CLOUDFLARE_ACCOUNT=codestead-admin
CLOUDFLARE_TUNNEL=codestead-production
CLOUDFLARE_HOSTNAME=learn.example.test
CLOUDFLARE_RECOVERY_PROCEDURE=Reissue tunnel credentials from the Cloudflare Zero Trust dashboard.
GMAIL_OAUTH_PROJECT=codestead-production
GMAIL_ACCOUNT=admin@example.test
GMAIL_REAUTHORIZATION_PROCEDURE=Create a replacement OAuth client and complete administrator consent again.
GIT_COMMIT=0123456789abcdef0123456789abcdef01234567
IMAGE_IDS=app@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,postgres@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
IDENTITY_STORAGE_LOCATION=Administrator offline recovery vault.
EOF
chmod 0600 "$metadata"

config="$work/backup.env"
cat >"$config" <<EOF
REPO_ROOT=$repo_root
LEARN_DATA_ROOT=$work/live-data
BACKUP_ROOT=$full
BACKUP_STAGE_ROOT=$work/stage
BACKUP_LOCK_FILE=$work/backup.lock
CREDENTIAL_MASTER_KEY_FILE=$credential_key
AGE_IDENTITY_FILE=$backup_identity
RECOVERY_KIT_RECIPIENT_FILE=$kit_recipient
RECOVERY_KIT_VERIFY_IDENTITY_FILE=$kit_identity
RECOVERY_KIT_METADATA_FILE=$metadata
RECOVERY_KIT_MIN_FREE_BYTES=1024
EOF
chmod 0600 "$config"
mkdir -m 0700 -- "$work/live-data"

BACKUP_CONFIG_FILE="$config" bash "$create" "$full" "$emergency"

mapfile -t full_archives < <(find "$full/recovery-kits" -maxdepth 1 -type f -name 'learncoding-recovery-kit-*.tar.gz.age' -print)
mapfile -t emergency_archives < <(find "$emergency/recovery-kits" -maxdepth 1 -type f -name 'learncoding-recovery-kit-*.tar.gz.age' -print)
[[ ${#full_archives[@]} -eq 1 && ${#emergency_archives[@]} -eq 1 ]]
full_archive="${full_archives[0]}"
emergency_archive="${emergency_archives[0]}"
cmp -s -- "$full_archive" "$emergency_archive"
cmp -s -- "${full_archive}.sha256" "${emergency_archive}.sha256"
[[ "$(stat -c '%a' "$full_archive")" == 600 ]]
[[ "$(stat -c '%a' "${full_archive}.sha256")" == 600 ]]

restore="$work/verified"
result="$(BACKUP_CONFIG_FILE="$config" bash "$verify" "$full_archive" "$kit_identity" "$restore")"
[[ "$result" == recovery_kit_valid=true ]]
mapfile -t inventory < <(find "$restore" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)
[[ "${inventory[*]}" == 'MANIFEST.txt RECOVERY.md SHA256SUMS backup-age-identity.txt credential_master_key' ]]
[[ "$(tr -d '\r\n ' <"$restore/credential_master_key" | base64 --decode | wc -c)" -eq 32 ]]
grep -Eq '^AGE-SECRET-KEY-1[A-Z0-9]+$' "$restore/backup-age-identity.txt"
if grep -Eqi 'access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|AGE-SECRET-KEY-' "$restore/RECOVERY.md"; then
  echo "recovery-kit-test-failed: recovery documentation exposed secret material" >&2
  exit 1
fi
rm -rf --one-file-system -- "$restore"

tampered="$work/tampered.tar.gz.age"
cp -- "$full_archive" "$tampered"
cp -- "${full_archive}.sha256" "${tampered}.sha256"
printf x >>"$tampered"
if BACKUP_CONFIG_FILE="$config" bash "$verify" "$tampered" "$kit_identity" "$work/tampered-output" >/dev/null 2>&1; then
  echo "recovery-kit-test-failed: tampered ciphertext was accepted" >&2
  exit 1
fi
[[ ! -e "$work/tampered-output" ]]

chmod 0644 "$kit_identity"
if BACKUP_CONFIG_FILE="$config" bash "$verify" "$full_archive" "$kit_identity" "$work/unsafe-output" >/dev/null 2>&1; then
  echo "recovery-kit-test-failed: unsafe recovery identity mode was accepted" >&2
  exit 1
fi
chmod 0600 "$kit_identity"

mkdir -m 0700 "$work/link-target"
ln -s "$work/link-target" "$work/link-output"
if BACKUP_CONFIG_FILE="$config" bash "$verify" "$full_archive" "$kit_identity" "$work/link-output" >/dev/null 2>&1; then
  echo "recovery-kit-test-failed: symlinked verification destination was accepted" >&2
  exit 1
fi

bad_key="$work/bad-key"
printf '%s\n' invalid >"$bad_key"
chmod 0440 "$bad_key"
sed "s|^CREDENTIAL_MASTER_KEY_FILE=.*|CREDENTIAL_MASTER_KEY_FILE=$bad_key|" "$config" >"$work/bad-key.env"
chmod 0600 "$work/bad-key.env"
before="$(find "$full/recovery-kits" "$emergency/recovery-kits" -maxdepth 1 -type f | wc -l)"
if BACKUP_CONFIG_FILE="$work/bad-key.env" bash "$create" "$full" "$emergency" >/dev/null 2>&1; then
  echo "recovery-kit-test-failed: invalid credential master key was accepted" >&2
  exit 1
fi
after="$(find "$full/recovery-kits" "$emergency/recovery-kits" -maxdepth 1 -type f | wc -l)"
[[ "$before" -eq "$after" ]]

fake_cp_bin="$work/fake-cp-bin"
mkdir -m 0700 "$fake_cp_bin"
cat >"$fake_cp_bin/cp" <<'EOF'
#!/bin/sh
for argument in "$@"; do
  case "$argument" in
    */emergency/recovery-kits/.learncoding-recovery-kit-*) exit 71 ;;
  esac
done
exec /bin/cp "$@"
EOF
chmod 0700 "$fake_cp_bin/cp"
sleep 1
before="$(find "$full/recovery-kits" "$emergency/recovery-kits" -maxdepth 1 -type f | wc -l)"
if PATH="$fake_cp_bin:$PATH" BACKUP_CONFIG_FILE="$config" \
  bash "$create" "$full" "$emergency" >/dev/null 2>&1; then
  echo "recovery-kit-test-failed: injected destination-copy failure succeeded" >&2
  exit 1
fi
after="$(find "$full/recovery-kits" "$emergency/recovery-kits" -maxdepth 1 -type f | wc -l)"
[[ "$before" -eq "$after" ]]
if find "$full/recovery-kits" "$emergency/recovery-kits" -maxdepth 1 -type f -name '.*.tmp.*' -print -quit | grep -q .; then
  echo "recovery-kit-test-failed: injected copy failure left a temporary destination object" >&2
  exit 1
fi

fake_age_bin="$work/fake-age-bin"
mkdir -m 0700 "$fake_age_bin"
real_age="$(command -v age)"
cat >"$fake_age_bin/age" <<EOF
#!/bin/sh
for argument in "\$@"; do
  if [ "\$argument" = --encrypt ]; then
    exit 72
  fi
done
exec "$real_age" "\$@"
EOF
chmod 0700 "$fake_age_bin/age"
sleep 1
before="$(find "$full/recovery-kits" "$emergency/recovery-kits" -maxdepth 1 -type f | wc -l)"
if PATH="$fake_age_bin:$PATH" BACKUP_CONFIG_FILE="$config" \
  bash "$create" "$full" "$emergency" >/dev/null 2>&1; then
  echo "recovery-kit-test-failed: injected encryption failure succeeded" >&2
  exit 1
fi
after="$(find "$full/recovery-kits" "$emergency/recovery-kits" -maxdepth 1 -type f | wc -l)"
[[ "$before" -eq "$after" ]]

if find "$work/stage" -mindepth 1 -print -quit 2>/dev/null | grep -q .; then
  echo "recovery-kit-test-failed: plaintext or encrypted staging residue remains" >&2
  exit 1
fi

echo recovery-kit-tests-ok
