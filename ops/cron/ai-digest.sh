#!/bin/bash
# Cron wrapper: POST /api/ai/digest (Bearer $SEQUENCE_PROCESS_SECRET).
# Weekly digest (the route picks each org's day), daily at 13:00.
# Outcome (HTTP status, curl errors) is recorded by lib.sh: logs/, state/, and
# cron_health in /root/backups/status.json. Rewritten 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
. /root/crm-cron/secrets.env
cron_post ai-digest /api/ai/digest "$SEQUENCE_PROCESS_SECRET" 1700
