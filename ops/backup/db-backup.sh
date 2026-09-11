#!/bin/bash
# Nightly CRM Postgres backup. Installed at /root/backups/db-backup.sh on the
# CRM box; cron runs it at 03:00 UTC.
#
#   1. pg_dump (custom format, restorable into any database name) + globals.
#   2. Refuse a suspiciously small dump.
#   3. Encrypt a copy with /root/backups/crm-offsite.key (AES-256, PBKDF2) and
#      ship it to the Hermes box over a forced-command SSH account, so a lost
#      Docker volume or a lost box never means lost customer data.
#   4. Keep 14 days locally, write /root/backups/status.json for the hub's
#      freshness check.
set -euo pipefail

BACKUP_DIR=/root/backups/db
LOG_FILE=/root/backups/db-backup.log
STATUS_FILE=/root/backups/status.json
KEY_FILE=/root/backups/crm-offsite.key
SSH_KEY=/root/.ssh/crm-offsite
OFFSITE_HOST=${OFFSITE_HOST:-49.13.154.50}
OFFSITE_USER=crm-offsite
RETAIN_DAYS=14
STAMP=$(date -u +%Y-%m-%d)
DUMP="$BACKUP_DIR/crm-$STAMP.dump"
GLOBALS="$BACKUP_DIR/crm-$STAMP.globals.sql"

log() { echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"; }
write_status() {
  # $1 = last_success ISO or "", $2 = last_offsite_success ISO or "", $3 = message
  python3 - "$STATUS_FILE" "$1" "$2" "$3" <<'PY'
import json, sys, os, datetime
path, ok, off, msg = sys.argv[1:5]
cur = {}
try:
    cur = json.load(open(path))
except Exception:
    pass
if ok: cur["last_success"] = ok
if off: cur["last_offsite_success"] = off
cur["last_message"] = msg
cur["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
tmp = path + ".tmp"
json.dump(cur, open(tmp, "w"))
os.replace(tmp, path)
PY
}

log "starting backup -> $DUMP"
mkdir -p "$BACKUP_DIR"

if ! docker exec launchos-postgres pg_dump -U crm -d crm -Fc --no-owner 2>>"$LOG_FILE" > "$DUMP.tmp"; then
  log "FAILED: pg_dump exited non-zero"; rm -f "$DUMP.tmp"; write_status "" "" "pg_dump failed"; exit 1
fi
if ! docker exec launchos-postgres pg_dumpall -U crm --globals-only 2>>"$LOG_FILE" > "$GLOBALS.tmp"; then
  log "FAILED: pg_dumpall --globals-only exited non-zero"; rm -f "$DUMP.tmp" "$GLOBALS.tmp"; write_status "" "" "globals dump failed"; exit 1
fi
mv "$DUMP.tmp" "$DUMP"; mv "$GLOBALS.tmp" "$GLOBALS"
SIZE=$(stat -c%s "$DUMP")
log "wrote $DUMP ($SIZE bytes)"
if [ "$SIZE" -lt 1000000 ]; then
  log "FAILED: dump suspiciously small ($SIZE bytes); leaving file for inspection"; write_status "" "" "dump too small: $SIZE bytes"; exit 1
fi
NOW=$(date -u -Iseconds)
write_status "$NOW" "" "local backup ok ($SIZE bytes)"

# Off-box copy, encrypted. The key never leaves this box except into Wesley's
# password manager; without it the copy on Hermes is opaque.
if [ ! -s "$KEY_FILE" ] || [ ! -s "$SSH_KEY" ]; then
  log "offsite skipped: key material missing ($KEY_FILE / $SSH_KEY)"; exit 0
fi
ENC="$DUMP.enc"
if ! openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$DUMP" -out "$ENC" -pass "file:$KEY_FILE"; then
  log "FAILED: encryption"; rm -f "$ENC"; exit 1
fi
if ! openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$GLOBALS" -out "$GLOBALS.enc" -pass "file:$KEY_FILE"; then
  log "FAILED: globals encryption"; rm -f "$ENC" "$GLOBALS.enc"; exit 1
fi
ship() { # $1 local file, $2 remote name
  ssh -i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
    "$OFFSITE_USER@$OFFSITE_HOST" "$2" < "$1"
}
if ship "$ENC" "crm-$STAMP.dump.enc" && ship "$GLOBALS.enc" "crm-$STAMP.globals.sql.enc"; then
  log "offsite copy stored on $OFFSITE_HOST"
  write_status "" "$(date -u -Iseconds)" "offsite ok"
else
  log "FAILED: offsite copy"; write_status "" "" "offsite copy failed"; rm -f "$ENC" "$GLOBALS.enc"; exit 1
fi
rm -f "$ENC" "$GLOBALS.enc"

DELETED=$(find "$BACKUP_DIR" \( -name 'crm-*.dump' -o -name 'crm-*.globals.sql' -o -name 'crm-*.sql.gz' \) -mtime +$RETAIN_DAYS -print -delete | wc -l)
log "rotation: deleted $DELETED file(s) older than $RETAIN_DAYS days"
log "done"
