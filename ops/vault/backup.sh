#!/bin/sh
set -eu

umask 077

container="${VAULT_CONTAINER:-launchos-vault}"
token_file="${VAULT_BACKUP_TOKEN_FILE:-/root/.noli-vault/backup-token}"
backup_dir="${VAULT_BACKUP_DIR:-/root/noli-vault-backups}"
retention_days="${VAULT_BACKUP_RETENTION_DAYS:-30}"

if [ ! -s "$token_file" ]; then
  echo "Vault backup token is unavailable" >&2
  exit 1
fi

mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
container_snapshot="/tmp/noli-crm-vault-$stamp.snap"
host_snapshot="$backup_dir/noli-crm-vault-$stamp.snap"
token=$(tr -d '\r\n' < "$token_file")

cleanup() {
  docker exec "$container" rm -f "$container_snapshot" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker exec \
  -e VAULT_ADDR=http://127.0.0.1:8200 \
  -e VAULT_TOKEN="$token" \
  "$container" vault operator raft snapshot save "$container_snapshot" >/dev/null
docker cp "$container:$container_snapshot" "$host_snapshot" >/dev/null
chmod 600 "$host_snapshot"
sha256sum "$host_snapshot" > "$host_snapshot.sha256"
chmod 600 "$host_snapshot.sha256"

find "$backup_dir" -type f \( -name 'noli-crm-vault-*.snap' -o -name 'noli-crm-vault-*.snap.sha256' \) -mtime "+$retention_days" -delete
