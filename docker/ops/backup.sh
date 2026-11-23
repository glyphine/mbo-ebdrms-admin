#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
source "$root/docker/ops/archive.sh"

operation=${1:-}
case "$operation:$#" in
  create:1|verify:2|test-restore:2|test-latest:1) ;;
  *) fail 'Usage: backup.sh create | verify BACKUP_ID | test-restore BACKUP_ID | test-latest' ;;
esac
init_store

case "$operation" in
  create) create_backup ;;
  verify)
    verify_bundle "$2"
    log "backup verified id=$2"
    ;;
  test-restore|test-latest)
    backup_id=${2:-$(latest_backup)}
    restore_copy "$backup_id"
    check_restored_pdf "$api_image"
    log "restore check passed id=$backup_id"
    ;;
esac
