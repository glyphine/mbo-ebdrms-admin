# Sourced by the operational entry points.
set -euo pipefail
umask 077

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
project=${COMPOSE_PROJECT_NAME:-}
pending=
restore_dir=

log() { printf '%s project=%s %s\n' "$(date -u +%FT%TZ)" "$project" "$*" >&2; }
fail() { log "ERROR $*"; exit 1; }

cleanup() {
  local result=$?
  if [[ -n $restore_dir ]]; then
    if [[ -s $restore_dir/container ]]; then
      docker rm -f "$(cat "$restore_dir/container")" >/dev/null || result=1
    fi
    rm -r -- "$restore_dir" || result=1
  fi
  if [[ -n $pending ]]; then rm -r -- "$pending" || result=1; fi
  if (( result != 0 )); then log "ERROR operation=${operation:-unknown} exit=$result"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

compose() {
  local env_files=(--env-file "${EBDRMS_COMPOSE_ENV_FILE:-/dev/null}")
  if [[ -n ${store:-} && -f $store/api-image.env ]]; then env_files+=(--env-file "$store/api-image.env"); fi
  docker compose --project-directory "$root" --project-name "$project" \
    "${env_files[@]}" "$@"
}

init_store() {
  [[ $project =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'Set an explicit COMPOSE_PROJECT_NAME'
  local base=${EBDRMS_BACKUP_DIR:-}
  [[ $base = /* && -d $base && ! -L $base ]] || fail 'Set EBDRMS_BACKUP_DIR to an existing private absolute directory'
  base=$(realpath -e -- "$base")
  [[ $base != / && $base != "$root" && $base != "$root/"* ]] || fail 'Keep backups outside the checkout'
  [[ $(stat -c '%u %a' -- "$base") == "$(id -u) 700" ]] || fail 'Backup directory must be owned by the operator and mode 0700'
  store="$base/$project"
  mkdir -p -- "$store"
  [[ ! -L $store && $(stat -c '%u %a' -- "$store") == "$(id -u) 700" ]] || fail 'Unsafe project backup directory'
  [[ ! -L $store/.lock ]] || fail 'Unsafe backup lock'
  exec 9>"$store/.lock"
  flock -n 9 || fail 'Another operation is using this backup store'
}

valid_id() { [[ $1 =~ ^backup-[0-9]{8}T[0-9]{6}Z-[a-zA-Z0-9]{8}$ ]]; }
valid_image_id() { [[ $1 =~ ^sha256:[a-f0-9]{64}$ ]]; }
valid_image_ref() { [[ $1 =~ ^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$ ]]; }

database_target_check='try {
  const url = new URL(process.env.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "db" ||
      !["", "5432"].includes(url.port) || url.search || url.hash ||
      decodeURIComponent(url.pathname.slice(1)) !== process.env.EBDRMS_EXPECTED_DATABASE) throw Error();
} catch {
  process.stderr.write("Expected DATABASE_URL for this Compose PostgreSQL database\n");
  process.exit(1);
}'

service_container() {
  local container
  container=$(compose ps -q "$1")
  [[ $container =~ ^[a-f0-9]{12,64}$ ]] || fail "Expected one running $1 container"
  printf '%s\n' "$container"
}
