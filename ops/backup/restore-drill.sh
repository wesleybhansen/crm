#!/bin/bash
# Restore drill: prove the latest dump restores. Restores into a scratch
# database inside the same Postgres container, compares the public table
# count with the live database, then drops the scratch database.
# Installed at /root/backups/restore-drill.sh; cron runs it monthly.
set -euo pipefail
LOG_FILE=/root/backups/restore-drill.log
STATUS_FILE=/root/backups/status.json
log() { echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"; }
LATEST=$(ls -1t /root/backups/db/crm-*.dump 2>/dev/null | head -1)
[ -n "$LATEST" ] || { log "FAILED: no dump found"; exit 1; }
log "drill starting with $LATEST"
docker exec launchos-postgres psql -U crm -d postgres -qc 'DROP DATABASE IF EXISTS crm_restore_drill' >>"$LOG_FILE" 2>&1
docker exec launchos-postgres psql -U crm -d postgres -qc 'CREATE DATABASE crm_restore_drill' >>"$LOG_FILE" 2>&1
if ! docker exec -i launchos-postgres pg_restore -U crm -d crm_restore_drill --no-owner --exit-on-error < "$LATEST" >>"$LOG_FILE" 2>&1; then
  log "FAILED: pg_restore"; docker exec launchos-postgres psql -U crm -d postgres -qc 'DROP DATABASE IF EXISTS crm_restore_drill' >/dev/null 2>&1; exit 1
fi
LIVE=$(docker exec launchos-postgres psql -U crm -d crm -tAc "select count(*) from information_schema.tables where table_schema='public'")
DRILL=$(docker exec launchos-postgres psql -U crm -d crm_restore_drill -tAc "select count(*) from information_schema.tables where table_schema='public'")
USERS=$(docker exec launchos-postgres psql -U crm -d crm_restore_drill -tAc "select count(*) from users")
docker exec launchos-postgres psql -U crm -d postgres -qc 'DROP DATABASE crm_restore_drill' >>"$LOG_FILE" 2>&1
if [ "$LIVE" != "$DRILL" ]; then log "FAILED: table count live=$LIVE drill=$DRILL"; exit 1; fi
log "drill ok: $DRILL tables restored, $USERS users; scratch database dropped"
python3 - "$STATUS_FILE" <<'PY'
import json, sys, datetime, os
p = sys.argv[1]
try: cur = json.load(open(p))
except Exception: cur = {}
cur["last_restore_drill"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
json.dump(cur, open(p + ".tmp", "w")); os.replace(p + ".tmp", p)
PY
