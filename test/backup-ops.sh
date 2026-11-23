#!/usr/bin/env bash
# Run only on a disposable local Docker host. Optional second argument is a test release digest.
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
export EBDRMS_API_IMAGE=${1:?Pass a locally built API image}
export test_previous="$EBDRMS_API_IMAGE" test_candidate=${2:-}
docker image inspect "$EBDRMS_API_IMAGE" >/dev/null
scratch=$(mktemp -d /tmp/ebdrms-ops-test-XXXXXXXX)
export COMPOSE_PROJECT_NAME="ebdrmsopsverify-${scratch##*-}"
export COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME,,}
export EBDRMS_COMPOSE_ENV_FILE=/dev/null EBDRMS_API_BIND=127.0.0.1 EBDRMS_API_PORT=0
export EBDRMS_API_ENV_FILE="$scratch/api" EBDRMS_DB_ENV_FILE="$scratch/db" EBDRMS_MAINTENANCE_ENV_FILE="$scratch/maintenance"
export EBDRMS_BACKUP_DIR="$scratch/storage" EBDRMS_BACKUP_EXTERNAL_DIR="$scratch/artifacts" EBDRMS_BACKUP_RETENTION_DAYS=14
export EBDRMS_BACKUP_CONFIG_DIR="$scratch/config"
compose() { docker compose --env-file /dev/null "$@"; }
cleanup() {
  local status=$? volume="${COMPOSE_PROJECT_NAME}_postgres-data"
  if (( status != 0 )); then compose logs --tail 25 db api >&2 || true; fi
  compose down >&2 || true
  if [[ $(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$volume" 2>/dev/null || true) == "$COMPOSE_PROJECT_NAME" ]]; then
    docker volume rm "$volume" >/dev/null
  fi
  rm -r -- "$scratch"
}
trap cleanup EXIT
mkdir -p "$EBDRMS_BACKUP_DIR/$COMPOSE_PROJECT_NAME/backup-20000101T000000Z-testOnly" "$EBDRMS_BACKUP_EXTERNAL_DIR" "$EBDRMS_BACKUP_CONFIG_DIR"
touch -d '20 days ago' "$EBDRMS_BACKUP_DIR/$COMPOSE_PROJECT_NAME/backup-20000101T000000Z-testOnly"
printf 'issued PDF test artifact\n' > "$EBDRMS_BACKUP_EXTERNAL_DIR/issued.pdf"
printf 'test setting\n' > "$EBDRMS_BACKUP_CONFIG_DIR/recovery.env"
password=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
printf 'POSTGRES_USER=ebdrms_fixture\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=ebdrms_ops_fixture\n' "$password" > "$EBDRMS_DB_ENV_FILE"
printf 'DATABASE_URL=postgresql://ebdrms_fixture:%s@db:5432/ebdrms_ops_fixture\n' "$password" > "$EBDRMS_MAINTENANCE_ENV_FILE"
cp -- "$EBDRMS_MAINTENANCE_ENV_FILE" "$EBDRMS_API_ENV_FILE"
printf 'AUTH_JWT_KEYS={"fixture":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}\nAUTH_JWT_ACTIVE_KID=fixture\n' >> "$EBDRMS_API_ENV_FILE"
compose up -d --wait --wait-timeout 60 db
compose run --rm migrate
compose up -d --wait --wait-timeout 60 --no-build api
digest=$(compose exec -T api node --input-type=module < test/fixtures/backup-history.mjs)
[[ $digest =~ ^[a-f0-9]{64}$ ]]

docker/ops/backup.sh create
store="$EBDRMS_BACKUP_DIR/$COMPOSE_PROJECT_NAME"
[[ ! -e $store/backup-20000101T000000Z-testOnly ]]
archives=("$store"/backup-*)
[[ ${#archives[@]} == 1 ]]
bundle=${archives[0]}
id=${bundle##*/}
docker/ops/backup.sh verify "$id"
tar -xOzf "$bundle/external.tar.gz" ./issued.pdf | cmp - "$EBDRMS_BACKUP_EXTERNAL_DIR/issued.pdf"
tar -xOzf "$bundle/configuration.tar.gz" ./recovery.env | cmp - "$EBDRMS_BACKUP_CONFIG_DIR/recovery.env"
restore_output=$(docker/ops/backup.sh test-restore "$id")
printf '%s\n' "$restore_output"
[[ $restore_output == *"PDF restored code=CAFOA superseded=true template_digest=$digest"* ]]
[[ $(compose exec -T db psql -Atq -U ebdrms_fixture -d ebdrms_ops_fixture -c 'select count(*) from template_versions') == 2 ]]

cp -- "$bundle/SHA256SUMS" "$scratch/manifest"
printf '\ncorrupted fixture\n' >> "$bundle/SHA256SUMS"
if docker/ops/backup.sh verify "$id"; then
  printf 'Expected a corrupt manifest to be rejected\n' >&2
  exit 1
fi
mv -- "$scratch/manifest" "$bundle/SHA256SUMS"
target="example.invalid/ebdrms@sha256:$(printf '%064d' 1)"
docker/ops/release.sh deploy "$target"
docker/ops/release.sh rollback "$target"
if docker/ops/release.sh deploy "$target" --apply </dev/null; then
  printf 'Expected non-interactive deployment to be rejected\n' >&2
  exit 1
fi
if [[ -n $test_candidate ]]; then
  printf 'deploy %s\n' "$COMPOSE_PROJECT_NAME" | script -q -e -c 'docker/ops/release.sh deploy "$test_candidate" --apply' /dev/null
  [[ $(docker inspect -f '{{.Config.Image}}' "$(compose ps -q api)") == "$test_candidate" ]]
  [[ $(cat "$store/api-image.env") == "EBDRMS_API_IMAGE=$test_candidate" ]]
  printf 'rollback %s\n' "$COMPOSE_PROJECT_NAME" | script -q -e -c 'docker/ops/release.sh rollback "$test_previous" --apply' /dev/null
  [[ $(docker inspect -f '{{.Config.Image}}' "$(compose ps -q api)") == "$test_previous" ]]
  [[ $(cat "$store/api-image.env") == "EBDRMS_API_IMAGE=$test_previous" ]]
  [[ $(compose exec -T db psql -Atq -U ebdrms_fixture -d ebdrms_ops_fixture -c 'select count(*) from template_versions') == 2 ]]
  printf 'Confirmed deployment and application-only rollback passed\n'
fi
printf 'Backup, retention, external artifact, restored historical PDF, checksum and release guard checks passed\n'
