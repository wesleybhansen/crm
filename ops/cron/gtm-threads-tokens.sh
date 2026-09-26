#!/bin/bash
# Daily Threads OAuth token maintenance for GTM keyword search (mercato gtm social:refresh-threads-tokens).
set -euo pipefail
cd /root/open-mercato
exec docker compose -f docker-compose.prod.yml exec -T app node /app/packages/cli/dist/bin.js gtm social:refresh-threads-tokens
