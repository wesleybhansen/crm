#!/bin/bash
# Cron wrapper: POST /api/customer-service/process (Bearer $SEQUENCE_PROCESS_SECRET).
# Customer Service: fetch support inboxes, draft replies, extract promises, alerts. Every 15 minutes.
# Outcome (HTTP status, curl errors) is recorded by lib.sh: logs/, state/, and
# cron_health in /root/backups/status.json. Rewritten 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
. /root/crm-cron/secrets.env
cron_post ai-customer-service /api/customer-service/process "$SEQUENCE_PROCESS_SECRET" 840
