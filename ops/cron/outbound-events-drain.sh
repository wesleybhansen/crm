#!/bin/bash
# Cron wrapper: POST /api/internal/outbound-events/drain (Bearer $SEQUENCE_PROCESS_SECRET).
# Retries the cross-app outbox (closed deals and journey closings to the marketing app), every 5 minutes.
# Outcome (HTTP status, curl errors) is recorded by lib.sh: logs/, state/, and
# cron_health in /root/backups/status.json. Rewritten 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
. /root/crm-cron/secrets.env
cron_post outbound-events-drain /api/internal/outbound-events/drain "$SEQUENCE_PROCESS_SECRET" 280
