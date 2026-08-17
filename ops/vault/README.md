# Production Vault operations

The production Compose stack runs a network-internal HashiCorp Vault instance with integrated Raft storage. CRM reads tenant DEKs from KV v2 through `VAULT_ADDR`, `VAULT_TOKEN`, and `VAULT_KV_PATH` in `.env.production`. Vault is not published on a host port.

## Key continuity migration

Existing installations that used `TENANT_DATA_ENCRYPTION_FALLBACK_KEY` must not let Vault generate replacement keys for tenants with encrypted data. Before enabling `VAULT_ADDR`, derive each tenant's current DEK with the implementation in `packages/shared/src/lib/encryption/kms.ts` and seed that exact base64 key at `secret/data/tenant_key_<tenant-id>`. Compare only SHA-256 fingerprints during verification; never print the DEK or fallback secret.

After seeding, restart every application and MCP replica to clear in-memory DEK caches. Verify that Vault and derived fingerprints match, run the read-only encryption checks, and confirm that application logs do not select the derived-key fallback.

## Recovery and backups

Production keeps unseal shares under `/root/.noli-vault/recovery` with mode `0400`. The unseal timer retries after host or container restarts. Least-privilege application and snapshot tokens are stored separately under `/root/.noli-vault`; a daily timer renews the periodic tokens. The backup timer writes encrypted Raft snapshots to `/root/noli-vault-backups` and keeps 30 days.

Install the units after copying this checkout into `/root/open-mercato`:

```sh
install -m 0644 ops/vault/noli-vault-unseal.service /etc/systemd/system/
install -m 0644 ops/vault/noli-vault-unseal.timer /etc/systemd/system/
install -m 0644 ops/vault/noli-vault-backup.service /etc/systemd/system/
install -m 0644 ops/vault/noli-vault-backup.timer /etc/systemd/system/
install -m 0644 ops/vault/noli-vault-renew-tokens.service /etc/systemd/system/
install -m 0644 ops/vault/noli-vault-renew-tokens.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now noli-vault-unseal.timer noli-vault-backup.timer noli-vault-renew-tokens.timer
```

Do not commit recovery shares, root tokens, application tokens, snapshots, or `.env.production`.
