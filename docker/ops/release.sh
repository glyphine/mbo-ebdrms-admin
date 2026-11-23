#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
source "$root/docker/ops/archive.sh"

operation=${1:-}
target=${2:-}
if [[ ! $operation =~ ^(deploy|rollback)$ ]] || ! valid_image_ref "$target" ||
  (( $# < 2 || $# > 3 )) || [[ -n ${3:-} && $3 != --apply ]]; then
  fail 'Usage: release.sh deploy|rollback REPOSITORY@sha256:DIGEST [--apply]'
fi
[[ $project =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'Set an explicit COMPOSE_PROJECT_NAME'
log "plan operation=$operation target=$target"
if [[ $operation == deploy ]]; then
  log 'Plan: verify a new backup, rehearse forward migrations on the restore, migrate live, then switch the API image'
else
  log 'Plan: verify a new backup, check the previous image against the restored current schema, then switch only the API image'
fi
[[ ${3:-} == --apply ]] || exit 0
[[ -t 0 ]] || fail 'Application requires an interactive terminal'
printf 'Confirm schema compatibility and type "%s %s" to proceed: ' "$operation" "$project" >&2
read -r confirmation
[[ $confirmation == "$operation $project" ]] || fail 'Confirmation did not match'

init_store
compose --profile maintenance config --quiet
current=$(service_container api)
previous=$(docker inspect -f '{{.Config.Image}}' "$current")
previous_id=$(docker inspect -f '{{.Image}}' "$current")
log "current image=$previous id=$previous_id"
if ! docker image inspect "$target" >/dev/null 2>&1; then docker pull "$target"; fi
create_backup
restore_copy "$backup_id"
check_restored_pdf "$api_image"
if [[ $operation == deploy ]]; then
  on_restore_copy "$target" node dist/db/migrate.js </dev/null
  check_restored_pdf "$api_image"
fi
check_restored_pdf "$target"

export EBDRMS_API_IMAGE=$target
if [[ $operation == deploy ]]; then
  compose run --rm --no-deps -e "EBDRMS_EXPECTED_DATABASE=$database_name" migrate \
    node --input-type=module -e "$database_target_check"$'\nawait import("/app/dist/db/migrate.js");'
fi
compose up -d --wait --wait-timeout 90 --no-deps --no-build --pull never api
compose exec -T api node --input-type=module -e '
  for (const path of ["/health/live", "/health/ready"]) {
    const response = await fetch(`http://127.0.0.1:3000${path}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Health check failed: ${path} ${response.status}`);
  }
'
pending=$(mktemp "$store/.image-XXXXXXXX")
printf 'EBDRMS_API_IMAGE=%s\n' "$target" > "$pending"
sync -f "$pending"
mv -T -- "$pending" "$store/api-image.env"
pending=
sync -f "$store"
log "release complete operation=$operation image=$target backup=$backup_id previous=$previous"
