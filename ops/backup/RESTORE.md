# CRM database: backup and restore

The CRM's Postgres runs in the `launchos-postgres` container on the Hetzner box
(`root@5.78.71.144`). Its data volume is `launchos-postgres-data`. Nothing in
this repository creates the schema (`setup-tables.sql` is empty of tables), so
the backups below are the rebuild path.

## What runs

| When | What | Where |
| --- | --- | --- |
| 03:00 UTC daily | `db-backup.sh`: `pg_dump -Fc` of `crm` + `pg_dumpall --globals-only`; 14 days kept | `/root/backups/db/crm-YYYY-MM-DD.dump` and `.globals.sql` |
| same run | encrypted copy (AES-256-CBC, PBKDF2 200k, key `/root/backups/crm-offsite.key`) shipped to the Hermes box over the `crm-offsite` forced-command SSH account; 30 days kept there; the Hermes box itself is snapshotted daily by `cos-backup.timer` | `hermes:/opt/backups/crm/` |
| 04:30 UTC, 1st of month | `restore-drill.sh`: restores the latest dump into `crm_restore_drill`, checks the table count against live, drops it | log `/root/backups/restore-drill.log` |
| after each run | `/root/backups/status.json` (`last_success`, `last_offsite_success`, `last_restore_drill`) mounted read-only into the app; the hub's `ops-health` cron alarms when any is stale | |

`schema-snapshot.sql` in this folder is `pg_dump --schema-only` of production,
refreshed by hand when the schema changes. It rebuilds an empty CRM on a fresh
Postgres without the data.

## The encryption key

`/root/backups/crm-offsite.key` exists only on the CRM box. **Keep a copy in the
password manager**: `ssh root@5.78.71.144 cat /root/backups/crm-offsite.key`.
Without it the copies on the Hermes box cannot be read. Never paste it into a
chat, a ticket, or a repository.

## Restore, same box (volume intact, bad data)

```bash
DUMP=/root/backups/db/crm-2026-09-11.dump   # pick the date
docker exec launchos-postgres psql -U crm -d postgres -c 'CREATE DATABASE crm_restored'
docker exec -i launchos-postgres pg_restore -U crm -d crm_restored --no-owner < "$DUMP"
# verify, then swap names inside a maintenance window:
docker compose -f docker-compose.prod.yml -f /root/releases/<release>/docker-compose.prod.yml stop app mcp gtm-mailbox-worker gtm-execution-worker gtm-auto-refill-worker scheduler-worker
docker exec launchos-postgres psql -U crm -d postgres -c 'ALTER DATABASE crm RENAME TO crm_broken; ALTER DATABASE crm_restored RENAME TO crm'
docker compose ... up -d app mcp gtm-mailbox-worker gtm-execution-worker gtm-auto-refill-worker scheduler-worker
```

## Restore, new box (volume or box lost)

1. Bring up the compose stack on the new box so `launchos-postgres` exists
   (empty database `crm`, user `crm`).
2. Fetch the newest copy from Hermes and decrypt it with the key from the
   password manager:
   ```bash
   scp hermes:/opt/backups/crm/crm-YYYY-MM-DD.dump.enc /root/
   scp hermes:/opt/backups/crm/crm-YYYY-MM-DD.globals.sql.enc /root/
   echo '<key from password manager>' > /root/crm-offsite.key && chmod 600 /root/crm-offsite.key
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in /root/crm-YYYY-MM-DD.dump.enc -out /root/crm.dump -pass file:/root/crm-offsite.key
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in /root/crm-YYYY-MM-DD.globals.sql.enc -out /root/globals.sql -pass file:/root/crm-offsite.key
   ```
3. Restore globals, then the database:
   ```bash
   docker exec -i launchos-postgres psql -U crm -d postgres < /root/globals.sql
   docker exec -i launchos-postgres pg_restore -U crm -d crm --no-owner < /root/crm.dump
   ```
4. Restart the app services. Point DNS at the new box. Re-run `db-backup.sh`
   once to confirm the chain works from the new box (it needs the SSH key
   `/root/.ssh/crm-offsite`; if that was lost, generate a new one and replace
   the line in `hermes:/home/crm-offsite/.ssh/authorized_keys`).

## The Hermes receiver

`ops/backup/crm-receive.sh` in the hermes-cos-control repository is installed
at `/opt/backups/crm-receive.sh` and is the forced command for the
`crm-offsite` account. It accepts only files named `crm-<date>.dump.enc` or
`crm-<date>.globals.sql.enc` on stdin and prunes copies older than 30 days.
