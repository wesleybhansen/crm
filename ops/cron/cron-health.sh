#!/bin/bash
# Hourly: fold the cron jobs' outcomes (state/*.status, logs/failures-*.log)
# into /root/backups/status.json -> cron_health, the file the nightly backup
# reports through (CRM /api/internal/backup-status, read by the hub's
# ops-health cron). Also writes logs/failure-summary-<UTC date>.txt and drops
# logs older than 14 days. Added 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
python3 - "$CRON_STATE_DIR" "$CRON_LOG_DIR" /root/backups/status.json <<'PY'
import json, os, sys, glob, datetime, fcntl
state_dir, log_dir, status_path = sys.argv[1:4]
now = datetime.datetime.now(datetime.timezone.utc)
# Longest normal gap between two runs of each job (hours); older = stale.
max_gap_h = {
  'reminders-process': 0.25, 'sequences-process': 0.5, 'cs-scheduled-send': 0.5,
  'outbound-events-drain': 0.5, 'booking-reminders': 0.5, 'event-reminders': 0.5,
  'automation-rules': 0.75, 'ai-customer-service': 1, 'ai-inbox': 1, 'personal-inbox-sync': 1,
  'email-intelligence': 1.5, 'ai-classify-sentiment': 2, 'certbot-renew': 14,
  'ai-meeting-prep': 26, 'ai-relationship-decay': 26, 'ai-digest': 26,
  'gtm-threads-tokens': 26, 'db-backup': 26, 'restore-drill': 24 * 32,
}
jobs, failing, stale = {}, [], []
for path in sorted(glob.glob(os.path.join(state_dir, '*.status'))):
    job = os.path.basename(path)[:-len('.status')]
    try:
        line = open(path).read().strip()
    except Exception:
        continue
    parts = line.split(' ', 2)
    at, st = parts[0], (parts[1] if len(parts) > 1 else '?')
    detail = parts[2] if len(parts) > 2 else ''
    jobs[job] = {'status': st, 'at': at, 'detail': detail[:200]}
    if st != 'ok':
        failing.append(job)
    try:
        age_h = (now - datetime.datetime.fromisoformat(at.replace('Z', '+00:00'))).total_seconds() / 3600
        if job in max_gap_h and age_h > max_gap_h[job] * 2:
            stale.append(job)
    except Exception:
        pass
cutoff = now - datetime.timedelta(hours=24)
failures_24h = {}
for path in glob.glob(os.path.join(log_dir, 'failures-*.log')):
    for line in open(path, errors='replace'):
        parts = line.split(' ', 2)
        if len(parts) < 2:
            continue
        try:
            t = datetime.datetime.fromisoformat(parts[0].replace('Z', '+00:00'))
        except Exception:
            continue
        if t >= cutoff:
            failures_24h[parts[1]] = failures_24h.get(parts[1], 0) + 1
health = {'checked_at': now.isoformat(), 'failing': failing, 'stale': stale, 'failures_24h': failures_24h, 'jobs': jobs}
# Daily summary, rewritten each hour.
day = now.strftime('%Y-%m-%d')
with open(os.path.join(log_dir, f'failure-summary-{day}.txt'), 'w') as f:
    f.write(f'Cron failure summary {day} (as of {now.strftime("%H:%M")} UTC)\n')
    f.write('Failing now: ' + (', '.join(failing) or 'none') + '\n')
    f.write('Stale (no run when expected): ' + (', '.join(stale) or 'none') + '\n')
    f.write('Failures in the last 24h: ' + (', '.join(f'{k} x{v}' for k, v in sorted(failures_24h.items())) or 'none') + '\n')
    for job in failing:
        f.write(f'  {job}: {jobs[job]["at"]} {jobs[job]["detail"]}\n')
# Merge into status.json under a lock (the backup writes it at 03:00; this runs at :17).
lock = open(status_path + '.lock', 'w')
fcntl.flock(lock, fcntl.LOCK_EX)
cur = {}
try:
    cur = json.load(open(status_path))
except Exception:
    pass
cur['cron_health'] = health
tmp = status_path + '.tmp'
json.dump(cur, open(tmp, 'w'))
os.replace(tmp, status_path)
fcntl.flock(lock, fcntl.LOCK_UN)
print(f'failing={len(failing)} stale={len(stale)} failures_24h={sum(failures_24h.values())}')
PY
rc=$?
find "$CRON_LOG_DIR" -type f -mtime +14 -delete 2>/dev/null
exit $rc
