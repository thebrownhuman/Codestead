#!/bin/sh
set -eu

file_env() {
  variable="$1"
  eval "value=\${$variable-}"
  eval "file=\${${variable}_FILE-}"

  if [ -n "$value" ] && [ -n "$file" ]; then
    echo "fatal: set either $variable or ${variable}_FILE, not both" >&2
    exit 64
  fi

  if [ -n "$file" ]; then
    if [ ! -f "$file" ] || [ ! -r "$file" ]; then
      echo "fatal: ${variable}_FILE must name a readable regular file" >&2
      exit 66
    fi
    value=$(cat -- "$file")
    if [ -n "$value" ]; then
      export "$variable=$value"
    else
      unset "$variable"
    fi
    unset "${variable}_FILE"
  fi
}

for variable in \
  DATABASE_URL \
  DATABASE_BOOTSTRAP_URL \
  DATABASE_APP_URL \
  DATABASE_MIGRATOR_URL \
  DATABASE_WORKER_URL \
  DATABASE_OPS_URL \
  BOOTSTRAP_ADMIN_PASSWORD \
  BETTER_AUTH_SECRET \
  LOST_DEVICE_PROOF_KEY \
  DELETION_TOMBSTONE_KEY \
  CREDENTIAL_MASTER_KEY \
  GOOGLE_CLIENT_SECRET \
  RUNNER_SHARED_SECRET \
  GMAIL_CLIENT_ID \
  GMAIL_CLIENT_SECRET \
  GMAIL_REFRESH_TOKEN
do
  file_env "$variable"
done

if [ "${NODE_ENV:-}" = "production" ]; then
  if [ -n "${DATABASE_BOOTSTRAP_URL:-}" ]; then
    for variable in DATABASE_APP_URL DATABASE_MIGRATOR_URL DATABASE_WORKER_URL DATABASE_OPS_URL; do
      eval "value=\${$variable-}"
      if [ -z "$value" ]; then
        echo "fatal: the complete database role credential set is required" >&2
        exit 64
      fi
    done
  elif [ -z "${DATABASE_URL:-}" ]; then
      echo "fatal: DATABASE_URL is required in production" >&2
      exit 64
  fi
  if [ "${REQUIRE_APP_SECRETS:-0}" = "1" ]; then
    auth_secret="${BETTER_AUTH_SECRET:-}"
    lost_device_proof_key="${LOST_DEVICE_PROOF_KEY:-}"
    runner_secret="${RUNNER_SHARED_SECRET:-}"
    if [ "${#auth_secret}" -lt 32 ]; then
      echo "fatal: BETTER_AUTH_SECRET must be at least 32 characters" >&2
      exit 64
    fi
    if [ "${#lost_device_proof_key}" -lt 32 ]; then
      echo "fatal: LOST_DEVICE_PROOF_KEY must be at least 32 characters" >&2
      exit 64
    fi
    if [ "${#runner_secret}" -lt 32 ]; then
      echo "fatal: RUNNER_SHARED_SECRET must be at least 32 characters" >&2
      exit 64
    fi
    if [ -z "${CREDENTIAL_MASTER_KEY:-}" ]; then
      echo "fatal: CREDENTIAL_MASTER_KEY is required" >&2
      exit 64
    fi
    deletion_key="${DELETION_TOMBSTONE_KEY:-}"
    if [ "${#deletion_key}" -lt 32 ]; then
      echo "fatal: DELETION_TOMBSTONE_KEY must be at least 32 characters" >&2
      exit 64
    fi
    node -e "const b=Buffer.from(process.env.CREDENTIAL_MASTER_KEY,'base64');if(b.length!==32)process.exit(64)" || {
      echo "fatal: CREDENTIAL_MASTER_KEY must decode to exactly 32 bytes" >&2
      exit 64
    }
  fi
  if [ "${REQUIRE_LOST_DEVICE_PROOF_KEY:-0}" = "1" ]; then
    lost_device_proof_key="${LOST_DEVICE_PROOF_KEY:-}"
    if [ "${#lost_device_proof_key}" -lt 32 ]; then
      echo "fatal: LOST_DEVICE_PROOF_KEY must be at least 32 characters" >&2
      exit 64
    fi
  fi
fi

exec "$@"
