#!/bin/bash
# Cron: pull new incoming mail from every user's personal mailbox into the
# Unified Inbox. Service-secret authed (Bearer NOLI_INTERNAL_SERVICE_SECRET
# from .env.production). Every 15 minutes. Rewritten 2026-09-26 to record
# its outcome through lib.sh.
set -uo pipefail
. /root/crm-cron/lib.sh
SECRET=$(grep -E '^NOLI_INTERNAL_SERVICE_SECRET=' /root/open-mercato/.env.production | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//')
if [ -z "$SECRET" ]; then cron_record personal-inbox-sync fail "NOLI_INTERNAL_SERVICE_SECRET missing from .env.production"; exit 1; fi
cron_post personal-inbox-sync /api/internal/personal-inbox-sync "$SECRET" 840
