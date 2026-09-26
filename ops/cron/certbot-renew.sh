#!/bin/bash
# TLS renewal for crm.noliai.com, twice a day (added 2026-09-26).
# The long-running certbot compose service stopped on 2026-08-12 and has no
# restart policy; it also never reloaded nginx, so a renewed certificate was
# not served until the next nginx restart. This runs certbot once (webroot
# challenge written to ./certbot/www, which nginx serves on port 80) and
# reloads nginx only when the certificate changed.
# crm.thelaunchpadincubator.com is left out on purpose: its DNS no longer
# points at this box, so its renewal can only fail (its cert expired 2026-09-02).
set -uo pipefail
. /root/crm-cron/lib.sh
JOB=certbot-renew
cd /root/open-mercato || { cron_record $JOB fail "no /root/open-mercato"; exit 1; }
CERT=certbot/conf/live/crm.noliai.com/cert.pem
before=$(openssl x509 -in "$CERT" -noout -fingerprint -sha256 2>/dev/null)
out=$(timeout 600 docker compose -f docker-compose.prod.yml run --rm --no-deps --entrypoint certbot certbot \
  renew --cert-name crm.noliai.com --non-interactive --no-random-sleep-on-renew 2>&1)
rc=$?
# A killed compose client leaves its container running; clean it up.
[ $rc -eq 124 ] && docker ps -q --filter name=open-mercato-certbot-run | xargs -r docker rm -f >/dev/null 2>&1
after=$(openssl x509 -in "$CERT" -noout -fingerprint -sha256 2>/dev/null)
expiry=$(openssl x509 -in "$CERT" -noout -enddate 2>/dev/null | cut -d= -f2)
days=$(( ( $(date -d "$expiry" +%s) - $(date +%s) ) / 86400 ))
if [ $rc -ne 0 ]; then
  cron_record $JOB fail "certbot exit $rc; cert expires $expiry ($days days): $(printf '%s' "$out" | grep -iE 'error|fail|problem|another instance' | head -2)"
  exit 1
fi
if [ "$before" != "$after" ]; then
  if docker exec launchos-nginx nginx -t >/dev/null 2>&1 && docker exec launchos-nginx nginx -s reload >/dev/null 2>&1; then
    cron_record $JOB ok "renewed, expires $expiry ($days days), nginx reloaded"
  else
    cron_record $JOB fail "renewed (expires $expiry) but the nginx reload failed; run: docker restart launchos-nginx"
    exit 1
  fi
elif [ $days -lt 14 ]; then
  cron_record $JOB fail "not renewed and the cert expires in $days days ($expiry)"
  exit 1
else
  cron_record $JOB ok "not due, expires $expiry ($days days)"
fi
