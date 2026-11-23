#!/usr/bin/env bash
set -euo pipefail
message="E-BDRMS backup operation failed: project=${COMPOSE_PROJECT_NAME:-unknown} operation=${1:?}"
logger --priority daemon.err --tag ebdrms-backup -- "$message"
if [[ -n ${EBDRMS_BACKUP_NOTIFY:-} ]]; then
  [[ $EBDRMS_BACKUP_NOTIFY = /* && -x $EBDRMS_BACKUP_NOTIFY ]]
  "$EBDRMS_BACKUP_NOTIFY" "$message"
fi
