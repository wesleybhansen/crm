#!/bin/bash
# Cron wrapper: POST /api/inbox/process (Bearer $SEQUENCE_PROCESS_SECRET).
# Personal Inbox AI drafts, every 15 minutes.
# Outcome (HTTP status, curl errors) is recorded by lib.sh: logs/, state/, and
# cron_health in /root/backups/status.json. Rewritten 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
. /root/crm-cron/secrets.env
cron_post ai-inbox /api/inbox/process "$SEQUENCE_PROCESS_SECRET" 840
