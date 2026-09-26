#!/bin/bash
# Cron wrapper: POST /api/reminders/process (Bearer $SEQUENCE_PROCESS_SECRET).
# Task reminders, every minute.
# Outcome (HTTP status, curl errors) is recorded by lib.sh: logs/, state/, and
# cron_health in /root/backups/status.json. Rewritten 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
. /root/crm-cron/secrets.env
cron_post reminders-process /api/reminders/process "$SEQUENCE_PROCESS_SECRET" 55
