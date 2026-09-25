#!/usr/bin/env sh
# Read-only deploy preflight for crm.noliai.com (run ON the box, before any
# `docker compose build` / `up`): refuses to proceed while a GTM research run
# is executing, so a deploy does not cut a paid run off mid-flight.
#
# Why: on 2026-09-25 a CRM rebuild took the app down for ~6 minutes while a
# Launch Pad member's included first run was sourcing; the hub's second batch
# failed to import and the run stopped for good. The hub now retries transient
# CRM failures with backoff, so a deploy during a run is survivable, but a run
# that is mid-execute still loses its in-flight provider call. Wait for this
# to pass (runs finish in minutes), then deploy.
#
# Also check /proc/loadavg and `systemctl list-units "crm-*"` first: never
# overlap builds, and always pass BOTH compose files (the Vault overlay).
#
# Usage:  sh ops/deploy/preflight-gtm-active-runs.sh [minutes]   (default 60)
# Exit:   0 = no active runs, 1 = active runs (do not deploy), 2 = query failed.
set -eu

WINDOW_MINUTES="${1:-60}"
case "$WINDOW_MINUTES" in
  ''|*[!0-9]*) echo "minutes must be a whole number" >&2; exit 2 ;;
esac
CONTAINER="${CRM_POSTGRES_CONTAINER:-launchos-postgres}"

echo "load: $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo unknown)"
if command -v systemctl >/dev/null 2>&1; then
  BUILDS="$(systemctl list-units 'crm-*' --no-legend --state=active 2>/dev/null || true)"
  if [ -n "$BUILDS" ]; then
    echo "Another CRM build/deploy unit is active; do not overlap builds:"
    echo "$BUILDS"
    exit 1
  fi
fi

SQL="BEGIN TRANSACTION READ ONLY;
SELECT id, workspace_id, play_id, started_at
FROM gtm_research_runs
WHERE status = 'running' AND deleted_at IS NULL
  AND started_at > now() - interval '${WINDOW_MINUTES} minutes'
ORDER BY started_at;
ROLLBACK;"

if ! OUT="$(docker exec -i "$CONTAINER" sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F " | "' <<SQLEOF
$SQL
SQLEOF
)"; then
  echo "Could not query $CONTAINER; not safe to assume the box is idle." >&2
  exit 2
fi
ROWS="$(printf '%s\n' "$OUT" | grep -v -e '^BEGIN$' -e '^ROLLBACK$' -e '^$' || true)"
if [ -n "$ROWS" ]; then
  echo "GTM research runs are executing (started in the last ${WINDOW_MINUTES} min). Wait before deploying:"
  printf '%s\n' "$ROWS"
  exit 1
fi
echo "No GTM research run executing in the last ${WINDOW_MINUTES} min. OK to deploy."
