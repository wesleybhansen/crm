#!/bin/bash
# Cron wrapper: POST /api/ai/meeting-prep (Bearer $SEQUENCE_PROCESS_SECRET).
# Meeting-prep briefs, daily.
# Outcome (HTTP status, curl errors) is recorded by lib.sh: logs/, state/, and
# cron_health in /root/backups/status.json. Rewritten 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
. /root/crm-cron/secrets.env
cron_post ai-meeting-prep /api/ai/meeting-prep "$SEQUENCE_PROCESS_SECRET" 1700
