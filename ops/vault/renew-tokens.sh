#!/bin/sh
set -eu

umask 077

container="${VAULT_CONTAINER:-launchos-vault}"
token_dir="${VAULT_TOKEN_DIR:-/root/.noli-vault}"

for token_file in "$token_dir"/app-token "$token_dir"/backup-token; do
  if [ ! -s "$token_file" ]; then
    echo "Missing renewable Vault token: $token_file" >&2
    exit 1
  fi
  token=$(tr -d '\r\n' < "$token_file")
  docker exec \
    -e VAULT_ADDR=http://127.0.0.1:8200 \
    -e VAULT_TOKEN="$token" \
    "$container" vault token renew -self >/dev/null
done
