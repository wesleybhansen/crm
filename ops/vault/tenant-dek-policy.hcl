path "secret/data/tenant_key_*" {
  capabilities = ["create", "read", "update"]
}

path "secret/metadata/tenant_key_*" {
  capabilities = ["read", "list"]
}
