#!/bin/bash
# Cron wrapper: POST /api/sequences/process (Bearer $SEQUENCE_PROCESS_SECRET).
# Sequence steps (including delayed steps), every 5 minutes.
# Outcome (HTTP status, curl errors) is recorded by lib.sh: logs/, state/, and
# cron_health in /root/backups/status.json. Rewritten 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
. /root/crm-cron/secrets.env
cron_post sequences-process /api/sequences/process "$SEQUENCE_PROCESS_SECRET" 280
