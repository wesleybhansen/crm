#!/bin/bash
# Cron wrapper: POST /api/customer-service/scheduled-send (Bearer $SEQUENCE_PROCESS_SECRET).
# Held Customer Service auto-sends past their hold window (kill switch, rate cap, breaker), every 5 minutes.
# Outcome (HTTP status, curl errors) is recorded by lib.sh: logs/, state/, and
# cron_health in /root/backups/status.json. Rewritten 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
. /root/crm-cron/secrets.env
cron_post cs-scheduled-send /api/customer-service/scheduled-send "$SEQUENCE_PROCESS_SECRET" 280
