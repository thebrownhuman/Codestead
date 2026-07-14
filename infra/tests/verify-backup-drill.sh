#!/usr/bin/env bash
set -Eeuo pipefail

source_file="${1:-/learn-data/app-data/objects/sentinel.txt}"
restore_root="${2:-/restore/manual}"
backup_root="${3:-/backup}"
source_hash="$(sha256sum "$source_file" | awk '{print $1}')"
restored_hash="$(tar -xOzf "$restore_root/app-data.tar.gz" app-data/objects/sentinel.txt | sha256sum | awk '{print $1}')"

[[ "$source_hash" == "$restored_hash" ]]
grep -Fxq 'format=learncoding-backup-v1' "$restore_root/MANIFEST.txt"
grep -Fxq 'app_data_included=true' "$restore_root/MANIFEST.txt"
grep -Fxq 'contains_secret_files=false' "$restore_root/MANIFEST.txt"
grep -Fxq 'contains_email_exports=false' "$restore_root/MANIFEST.txt"

report="$(find "$backup_root/restore-reports" -maxdepth 1 -type f -name 'restore-drill-*.txt' -print -quit)"
[[ -n "$report" ]]
(cd "$(dirname "$report")" && sha256sum --check --strict --quiet "$(basename "$report").sha256")
grep -Fxq 'result=pass' "$report"
grep -Fxq 'live_database_modified=false' "$report"
archive="$(find "$backup_root/full" -maxdepth 1 -type f -name 'learncoding-full-*.tar.gz.age' -print -quit)"
[[ -n "$archive" ]]
(cd "$(dirname "$archive")" && sha256sum --check --strict --quiet "$(basename "$archive").sha256")

printf 'app-data-sha256=%s\n' "$restored_hash"
printf 'backup-manifest-policy=pass\n'
printf 'restore-report-checksum=pass\n'
printf 'archive=%s\n' "$(basename "$archive")"
printf 'archive-bytes=%s\n' "$(stat -c %s "$archive")"
printf 'ciphertext-sha256=%s\n' "$(sha256sum "$archive" | awk '{print $1}')"
grep -E '^(public_table_count|live_database_modified)=' "$report"
