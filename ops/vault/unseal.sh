#!/bin/sh
set -eu

umask 077

container="${VAULT_CONTAINER:-launchos-vault}"
recovery_dir="${VAULT_RECOVERY_DIR:-/root/.noli-vault/recovery}"

if ! docker inspect "$container" >/dev/null 2>&1; then
  echo "Vault container is not available" >&2
  exit 1
fi

initialized=$(docker exec "$container" vault status -format=json 2>/dev/null | sed -n 's/.*"initialized"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p' || true)
sealed=$(docker exec "$container" vault status -format=json 2>/dev/null | sed -n 's/.*"sealed"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p' || true)

if [ "$initialized" != "true" ]; then
  echo "Vault is not initialized" >&2
  exit 1
fi

if [ "$sealed" = "false" ]; then
  exit 0
fi

for key_file in "$recovery_dir"/unseal-key-1 "$recovery_dir"/unseal-key-2 "$recovery_dir"/unseal-key-3; do
  if [ ! -s "$key_file" ]; then
    echo "Missing required unseal key file: $key_file" >&2
    exit 1
  fi
  docker exec -i "$container" vault operator unseal >/dev/null < "$key_file"
done

sealed=$(docker exec "$container" vault status -format=json 2>/dev/null | sed -n 's/.*"sealed"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p' || true)
if [ "$sealed" != "false" ]; then
  echo "Vault remained sealed after applying the configured key shares" >&2
  exit 1
fi
