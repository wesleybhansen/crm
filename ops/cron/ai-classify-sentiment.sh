#!/bin/bash
# Cron wrapper: POST /api/ai/classify-sentiment (Bearer $SEQUENCE_PROCESS_SECRET).
# Inbound email sentiment, hourly.
# Outcome (HTTP status, curl errors) is recorded by lib.sh: logs/, state/, and
# cron_health in /root/backups/status.json. Rewritten 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
. /root/crm-cron/secrets.env
cron_post ai-classify-sentiment /api/ai/classify-sentiment "$SEQUENCE_PROCESS_SECRET" 1700
