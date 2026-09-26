# Shared helpers for the /root/crm-cron jobs. Source it; do not run it.
# (added 2026-09-26)
#
# Every run appends one line to logs/runs-<UTC date>.log and overwrites
# state/<job>.status. A failure (curl error, non-2xx answer, or a non-zero
# exit) is also appended to logs/failures-<UTC date>.log. cron-health.sh
# (hourly) folds the state files into /root/backups/status.json -> cron_health,
# the same file the nightly backup reports through (the CRM's
# /api/internal/backup-status, read by the hub's ops-health cron).
# Nothing here prints or logs a secret.

CRON_DIR=/root/crm-cron
CRON_LOG_DIR=$CRON_DIR/logs
CRON_STATE_DIR=$CRON_DIR/state
mkdir -p "$CRON_LOG_DIR" "$CRON_STATE_DIR"

# cron_record <job> <ok|fail> <detail>
cron_record() {
  local job=$1 st=$2 detail now day
  detail=$(printf '%s' "${3:-}" | tr -d '\r' | tr '\n\t' '  ' | cut -c1-300)
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  day=$(date -u +%F)
  echo "$now $job $st $detail" >> "$CRON_LOG_DIR/runs-$day.log"
  echo "$now $st $detail" > "$CRON_STATE_DIR/$job.status"
  if [ "$st" != ok ]; then
    echo "$now $job $detail" >> "$CRON_LOG_DIR/failures-$day.log"
  fi
}

# cron_post <job> <path> <bearer secret> [max seconds]
# POSTs {} to the app on the box and records the outcome. Returns 0 on 2xx.
cron_post() {
  local job=$1 path=$2 secret=$3 max=${4:-290} tmp code rc
  tmp=$(mktemp)
  code=$(curl -sS -o "$tmp" -w '%{http_code}' --max-time "$max" -X POST "http://localhost:3000$path" \
    -H "Authorization: Bearer $secret" -H 'Content-Type: application/json' -d '{}' 2>>"$tmp")
  rc=$?
  if [ $rc -eq 0 ] && [ "${code:0:1}" = 2 ]; then
    cron_record "$job" ok "HTTP $code"
  else
    cron_record "$job" fail "curl exit $rc, HTTP ${code:-000}: $(head -c 200 "$tmp")"
  fi
  rm -f "$tmp"
  [ $rc -eq 0 ] && [ "${code:0:1}" = 2 ]
}

# cron_run <job> <command...>: runs a command, records exit status and the
# last output line (never the whole output).
cron_run() {
  local job=$1 out rc
  shift
  out=$("$@" 2>&1)
  rc=$?
  if [ $rc -eq 0 ]; then
    cron_record "$job" ok "exit 0: $(printf '%s' "$out" | tail -n 1 | cut -c1-200)"
  else
    cron_record "$job" fail "exit $rc: $(printf '%s' "$out" | tail -n 3 | cut -c1-200)"
  fi
  return $rc
}
