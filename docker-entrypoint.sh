#!/bin/sh
set -eu

SECRETS_DIR="/opt/app/secrets"
SERVICE_ACCOUNT_PATH="${SECRETS_DIR}/firebase-service-account.json"

mkdir -p "${SECRETS_DIR}"

if [ -n "${FCM_SERVICE_ACCOUNT_JSON_B64:-}" ]; then
  printf '%s' "${FCM_SERVICE_ACCOUNT_JSON_B64}" | base64 -d > "${SERVICE_ACCOUNT_PATH}"
  export FCM_SERVICE_ACCOUNT_JSON="${SERVICE_ACCOUNT_PATH}"
elif [ -n "${FCM_SERVICE_ACCOUNT_JSON_RAW:-}" ]; then
  printf '%s' "${FCM_SERVICE_ACCOUNT_JSON_RAW}" > "${SERVICE_ACCOUNT_PATH}"
  export FCM_SERVICE_ACCOUNT_JSON="${SERVICE_ACCOUNT_PATH}"
fi

exec "$@"
