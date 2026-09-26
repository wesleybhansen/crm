#!/bin/bash
# Cron wrapper: POST /api/email/intelligence-cron (Bearer $CRON_SECRET).
# Email intelligence sync for users who turned it on, every 30 minutes. Header auth only (the route refuses a query-string secret).
# Outcome (HTTP status, curl errors) is recorded by lib.sh: logs/, state/, and
# cron_health in /root/backups/status.json. Rewritten 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
. /root/crm-cron/secrets.env
cron_post email-intelligence /api/email/intelligence-cron "$CRON_SECRET" 1700
