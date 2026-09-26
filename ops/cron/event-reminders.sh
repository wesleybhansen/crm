#!/bin/bash
# Cron wrapper: POST /api/crm-events/reminders (Bearer $SEQUENCE_PROCESS_SECRET).
# Event reminders to registered attendees (once per attendee and window), every 5 minutes.
# Outcome (HTTP status, curl errors) is recorded by lib.sh: logs/, state/, and
# cron_health in /root/backups/status.json. Rewritten 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
. /root/crm-cron/secrets.env
cron_post event-reminders /api/crm-events/reminders "$SEQUENCE_PROCESS_SECRET" 280
