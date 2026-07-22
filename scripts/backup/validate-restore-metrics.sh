#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C

compact_epoch() {
  local value="${1:-}" normalized
  [[ "$value" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || return 1
  normalized="$(date -u -d \
    "${value:0:4}-${value:4:2}-${value:6:2} ${value:9:2}:${value:11:2}:${value:13:2} UTC" \
    '+%Y%m%dT%H%M%SZ' 2>/dev/null)" || return 1
  [[ "$normalized" == "$value" ]] || return 1
  date -u -d \
    "${value:0:4}-${value:4:2}-${value:6:2} ${value:9:2}:${value:11:2}:${value:13:2} UTC" +%s
}

case "${1:-}" in
  preflight)
    [[ $# -eq 5 ]] || exit 64
    snapshot_epoch="$(compact_epoch "$2")" || exit 65
    incident_epoch="$(compact_epoch "$3")" || exit 65
    recorded_epoch="$(compact_epoch "$4")" || exit 65
    approval_epoch="$(compact_epoch "$5")" || exit 65
    rpo_seconds=$((incident_epoch - snapshot_epoch))
    chronology_valid=false
    rpo_within_24h=false
    if ((snapshot_epoch <= incident_epoch && incident_epoch <= recorded_epoch \
      && recorded_epoch <= approval_epoch + 300 && rpo_seconds >= 0)); then
      chronology_valid=true
    fi
    if ((rpo_seconds >= 0 && rpo_seconds <= 86400)); then
      rpo_within_24h=true
    fi
    printf 'chronology_valid=%s\nrpo_seconds=%s\nrpo_within_24h=%s\n' \
      "$chronology_valid" "$rpo_seconds" "$rpo_within_24h"
    [[ "$chronology_valid" == true && "$rpo_within_24h" == true ]]
    ;;
  complete)
    [[ $# -eq 3 && "$2" =~ ^[0-9]+$ && "$3" =~ ^[0-9]+$ ]] || exit 64
    approval_ns="$2"
    smoke_ns="$3"
    rto_seconds=-1
    rto_within_4h=false
    if ((smoke_ns >= approval_ns)); then
      rto_seconds=$(((smoke_ns - approval_ns) / 1000000000))
      if ((rto_seconds <= 14400)); then rto_within_4h=true; fi
    fi
    printf 'rto_seconds=%s\nrto_within_4h=%s\n' "$rto_seconds" "$rto_within_4h"
    [[ "$rto_within_4h" == true ]]
    ;;
  *) exit 64 ;;
esac
