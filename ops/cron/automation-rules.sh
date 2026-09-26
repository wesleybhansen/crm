#!/bin/bash
# Cron wrapper: POST /api/sequences/automation-rules/run-scheduled (Bearer $SEQUENCE_PROCESS_SECRET).
# Scheduled automation rules of every tenant, then delayed automation steps, every 10 minutes.
# Outcome (HTTP status, curl errors) is recorded by lib.sh: logs/, state/, and
# cron_health in /root/backups/status.json. Rewritten 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
. /root/crm-cron/secrets.env
cron_post automation-rules /api/sequences/automation-rules/run-scheduled "$SEQUENCE_PROCESS_SECRET" 580
