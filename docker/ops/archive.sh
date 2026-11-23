# Backup and restore functions shared by the scheduled and release operations.
manifest() (
  cd -- "$1"
  local files=(database.dump api-image.tar.gz api-image.id postgres-image.id postgres-image.ref)
  if [[ -e external.tar.gz || -L external.tar.gz ]]; then files+=(external.tar.gz); fi
  if [[ -e configuration.tar.gz || -L configuration.tar.gz ]]; then files+=(configuration.tar.gz); fi
  local file
  for file in "${files[@]}"; do
    [[ -f $file && ! -L $file && -s $file ]] || fail "Missing or unsafe backup file: $file"
  done
  sha256sum -- "${files[@]}"
)

verify_bundle() {
  valid_id "$1" || fail 'Invalid backup identifier'
  bundle="$store/$1"
  [[ -d $bundle && ! -L $bundle && -f $bundle/SHA256SUMS && ! -L $bundle/SHA256SUMS ]] || fail 'Backup is missing or incomplete'
  local actual
  actual=$(manifest "$bundle") || fail 'Cannot read the backup manifest'
  [[ $actual == "$(cat "$bundle/SHA256SUMS")" ]] || fail "Checksum verification failed for $1"
  api_image=$(cat "$bundle/api-image.id")
  postgres_image=$(cat "$bundle/postgres-image.id")
  postgres_ref=$(cat "$bundle/postgres-image.ref")
  valid_image_id "$api_image" && valid_image_id "$postgres_image" || fail 'Invalid image IDs in backup'
  valid_image_ref "$postgres_ref" || fail 'Invalid PostgreSQL image reference in backup'
}

resolve_backup_tree() {
  local path=$1 mount=$2 bad_path
  [[ -n $path ]] || return 0
  [[ $path = /* && -d $path && ! -L $path ]] || fail 'Archive input must be an absolute directory'
  path=$(realpath -e -- "$path")
  [[ $path != / && $store != "$path" && $store != "$path/"* && $path != "$store/"* ]] || fail 'Archive inputs and backups must use separate directories'
  [[ $path != "$mount" && $path != "$mount/"* && $mount != "$path/"* ]] || fail 'Archive inputs must exclude the PostgreSQL volume'
  bad_path=$(find "$path" ! -type d ! -type f -print -quit)
  [[ -z $bad_path ]] || fail 'Archive inputs must contain only regular files and directories'
  printf '%s\n' "$path"
}

create_backup() {
  local external configuration api db mount days=${EBDRMS_BACKUP_RETENTION_DAYS:-14}
  [[ $days =~ ^[1-9][0-9]{0,2}$ ]] && (( days <= 365 )) || fail 'Retention must be 1–365 days'
  api=$(service_container api)
  db=$(service_container db)
  mount=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql"}}{{.Source}}{{end}}{{end}}' "$db")
  [[ -n $mount && $store != "$mount" && $store != "$mount/"* ]] || fail 'Keep backups outside the PostgreSQL volume'
  external=$(resolve_backup_tree "${EBDRMS_BACKUP_EXTERNAL_DIR:-}" "$mount")
  configuration=$(resolve_backup_tree "${EBDRMS_BACKUP_CONFIG_DIR:-}" "$mount")
  database_name=$(docker exec "$db" sh -ec 'printf "%s" "${POSTGRES_DB:?}"')
  docker exec -e "EBDRMS_EXPECTED_DATABASE=$database_name" "$api" node --input-type=module -e "$database_target_check"
  pending=$(mktemp -d "$store/.partial-XXXXXXXX")
  backup_id="backup-$(date -u +%Y%m%dT%H%M%SZ)-${pending##*-}"
  log "backup started id=$backup_id"

  docker inspect -f '{{.Image}}' "$api" > "$pending/api-image.id"
  docker inspect -f '{{.Image}}' "$db" > "$pending/postgres-image.id"
  docker inspect -f '{{.Config.Image}}' "$db" > "$pending/postgres-image.ref"
  valid_image_ref "$(cat "$pending/postgres-image.ref")" || fail 'PostgreSQL image must be pinned by digest'
  docker exec "$db" sh -ec '
    export PGPASSWORD="$POSTGRES_PASSWORD"
    pg_dump --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-password --format=custom
  ' > "$pending/database.dump"
  docker exec -i "$db" pg_restore --list < "$pending/database.dump" >/dev/null
  docker image save "$(cat "$pending/api-image.id")" | gzip -1 > "$pending/api-image.tar.gz"
  if [[ -n $external ]]; then tar -C "$external" -czf "$pending/external.tar.gz" -- .; fi
  if [[ -n $configuration ]]; then tar -C "$configuration" -czf "$pending/configuration.tar.gz" -- .; fi
  manifest "$pending" > "$pending/SHA256SUMS"
  sync -f "$pending"
  mv -T -- "$pending" "$store/$backup_id"
  pending=
  sync -f "$store"
  log "backup complete id=$backup_id"

  local expired modified cutoff=$(( $(date +%s) - days * 86400 ))
  for expired in "$store"/backup-*; do
    if [[ -d $expired && ! -L $expired && ${expired##*/} != "$backup_id" ]] && valid_id "${expired##*/}"; then
      modified=$(stat -c '%Y' -- "$expired")
      (( modified < cutoff )) || continue
      rm -r -- "$expired"
      log "backup expired id=${expired##*/}"
    fi
  done
}

latest_backup() {
  local path latest=
  for path in "$store"/backup-*; do
    if [[ -d $path && ! -L $path ]] && valid_id "${path##*/}"; then latest=${path##*/}; fi
  done
  [[ -n $latest ]] || fail 'No completed backup found'
  printf '%s\n' "$latest"
}

# PostgreSQL is created from its recorded local image with fresh, disposable storage.
# There is deliberately no source database URL, production network, or host port.
restore_copy() {
  local id=$1 ready= container= attempt
  verify_bundle "$id"
  log "restore started id=$id"
  if ! docker image inspect "$postgres_image" >/dev/null 2>&1; then
    docker pull "$postgres_ref"
    [[ $(docker image inspect -f '{{.Id}}' "$postgres_ref") == "$postgres_image" ]] || fail 'PostgreSQL image differs from the recorded platform'
  fi
  if ! docker image inspect "$api_image" >/dev/null 2>&1; then
    docker image load -i "$bundle/api-image.tar.gz" >&2
    docker image inspect "$api_image" >/dev/null
  fi
  restore_dir=$(mktemp -d "$store/.restore-XXXXXXXX")
  docker run -d --cidfile "$restore_dir/container" --network none --user postgres \
    --label "ebdrms.restore.project=$project" --security-opt no-new-privileges=true --cap-drop ALL \
    --tmpfs /var/lib/postgresql:uid=999,gid=999,mode=0700 \
    -e POSTGRES_DB=ebdrms_restore_test -e POSTGRES_HOST_AUTH_METHOD=trust \
    "$postgres_image" -c listen_addresses=127.0.0.1 >/dev/null
  container=$(cat "$restore_dir/container")
  for ((attempt=0; attempt<60; attempt++)); do
    if docker exec "$container" psql -h 127.0.0.1 -U postgres -d ebdrms_restore_test -Atq -c 'select 1' >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 1
  done
  [[ $ready == 1 ]] || fail 'Disposable PostgreSQL did not become ready'
  docker exec -i "$container" pg_restore --exit-on-error --single-transaction --no-owner --no-privileges \
    -U postgres -d ebdrms_restore_test < "$bundle/database.dump"
  local migration
  migration=$(docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d ebdrms_restore_test -Atqc \
    'select 1 from drizzle.__drizzle_migrations limit 1')
  [[ $migration == 1 ]] || fail 'Restored migration journal is empty'
  if [[ -f $bundle/external.tar.gz ]]; then tar -tzf "$bundle/external.tar.gz" >/dev/null; fi
  if [[ -f $bundle/configuration.tar.gz ]]; then tar -tzf "$bundle/configuration.tar.gz" >/dev/null; fi
  log "database restored id=$id"
}

on_restore_copy() {
  local image=$1
  shift
  docker run --rm -i --init --network "container:$(cat "$restore_dir/container")" --shm-size 256m \
    --cap-drop ALL --security-opt no-new-privileges=true --security-opt "seccomp=$root/docker/chromium-seccomp.json" \
    -e DATABASE_URL=postgresql://postgres@127.0.0.1:5432/ebdrms_restore_test "$image" "$@"
}

check_restored_pdf() {
  on_restore_copy "$1" node --input-type=module < "$root/docker/ops/restore-pdf.mjs"
}
