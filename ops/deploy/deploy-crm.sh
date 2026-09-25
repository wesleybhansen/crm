#!/usr/bin/env bash
# The one way to deploy crm.noliai.com. Run ON the box (root@5.78.71.144),
# from anywhere; it works in the production checkout.
#
#   ops/deploy/deploy-crm.sh [--ref <sha|branch>] [--no-cache] [--no-wait] [--dry-run]
#
#   --ref <x>    git fetch origin and check out <x> first (default: deploy HEAD as is)
#   --no-cache   rebuild the image without the Docker layer cache (only when a
#                dependency changed; a no-cache build on this 7.7 GB box takes
#                30+ min and can time the site out)
#   --no-wait    start the deploy unit and return; follow it with journalctl
#   --dry-run    print every command instead of running it (the busy-box check
#                still runs, it is read-only)
#
# What it guarantees, each learned the hard way:
#   1. BOTH compose files, always. Deploying with only docker-compose.prod.yml
#      drops the Vault overlay and the project drifts (2026-09-25).
#   2. Never two builds at once: refuses while any other crm-* systemd unit is
#      active. Two builds thrashed memory and took the site offline (2026-09-11).
#   3. The GTM preflight passes first: no deploy cuts a paid research run off.
#   4. A cached build by default.
#   5. The build runs under systemd-run, so it survives the SSH session; output
#      is in the journal of the printed unit.
#   6. It ends with one line: DEPLOY_DONE commit=<sha> rc=<code> unit=<unit>
#      (or DEPLOY_FAILED step=<step> rc=<code> before the build starts).
#
# Environment overrides (defaults are production):
#   CRM_REPO_DIR          /root/open-mercato
#   CRM_COMPOSE_BASE      /root/open-mercato/docker-compose.prod.yml
#   CRM_COMPOSE_OVERLAY   /root/releases/noli-v1-vault-c2ccad6e/docker-compose.prod.yml
#   CRM_BUILD_SERVICE     app
#   CRM_UP_SERVICES       app mcp gtm-mailbox-worker gtm-execution-worker gtm-auto-refill-worker scheduler-worker
#   CRM_PREFLIGHT_MINUTES 60
#
# GTM module migrations are NOT applied by the entrypoint: apply them by hand
# when a change carries one (see the deploy recipe in RESTORE.md).
set -euo pipefail

REPO_DIR="${CRM_REPO_DIR:-/root/open-mercato}"
COMPOSE_BASE="${CRM_COMPOSE_BASE:-/root/open-mercato/docker-compose.prod.yml}"
COMPOSE_OVERLAY="${CRM_COMPOSE_OVERLAY:-/root/releases/noli-v1-vault-c2ccad6e/docker-compose.prod.yml}"
BUILD_SERVICE="${CRM_BUILD_SERVICE:-app}"
UP_SERVICES="${CRM_UP_SERVICES:-app mcp gtm-mailbox-worker gtm-execution-worker gtm-auto-refill-worker scheduler-worker}"
PREFLIGHT_MINUTES="${CRM_PREFLIGHT_MINUTES:-60}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REF=""
NO_CACHE=0
WAIT=1
DRY_RUN=0
STEP="arguments"

fail() {
  local rc="$1"; shift
  echo "$*" >&2
  echo "DEPLOY_FAILED step=${STEP} rc=${rc}"
  trap - EXIT
  exit "$rc"
}
trap 'rc=$?; if [ "$rc" -ne 0 ]; then echo "DEPLOY_FAILED step=${STEP} rc=${rc}"; fi' EXIT

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref) [ "$#" -ge 2 ] || fail 64 "--ref needs a value"; REF="$2"; shift 2 ;;
    --no-cache) NO_CACHE=1; shift ;;
    --no-wait) WAIT=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; trap - EXIT; exit 0 ;;
    *) fail 64 "Unknown option: $1" ;;
  esac
done

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

STEP="compose-files"
for file in "$COMPOSE_BASE" "$COMPOSE_OVERLAY"; do
  [ -f "$file" ] || fail 66 "Compose file missing: $file. Both files are required; refusing to deploy without the Vault overlay."
done
COMPOSE=(docker compose -f "$COMPOSE_BASE" -f "$COMPOSE_OVERLAY")

STEP="busy-check"
ACTIVE="$(systemctl list-units 'crm-*' --no-legend --plain --state=active,activating 2>/dev/null || true)"
if [ -n "$ACTIVE" ]; then
  fail 75 "Another CRM build or deploy unit is running; never overlap builds on this box:
$ACTIVE
Wait for it (systemctl is-active <unit>), then run this again."
fi
echo "load: $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo unknown)"

STEP="gtm-preflight"
if [ "$DRY_RUN" -eq 1 ]; then
  run sh "$SCRIPT_DIR/preflight-gtm-active-runs.sh" "$PREFLIGHT_MINUTES"
elif ! sh "$SCRIPT_DIR/preflight-gtm-active-runs.sh" "$PREFLIGHT_MINUTES"; then
  fail 75 "GTM preflight did not pass (a research run is executing, or the check could not run). Not deploying."
fi

STEP="checkout"
if [ -n "$REF" ]; then
  run git -C "$REPO_DIR" fetch -q origin
  run git -C "$REPO_DIR" checkout -q "$REF"
fi
COMMIT="$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
[ -n "$REF" ] && [ "$DRY_RUN" -eq 1 ] && COMMIT="$REF"

STEP="build"
BUILD_ARGS=(build)
[ "$NO_CACHE" -eq 1 ] && BUILD_ARGS+=(--no-cache)
BUILD_ARGS+=("$BUILD_SERVICE")
# shellcheck disable=SC2206 # UP_SERVICES is a space-separated list by design
UP_ARGS=(up -d --force-recreate $UP_SERVICES)

quote() { local out="" arg; for arg in "$@"; do out+=" $(printf '%q' "$arg")"; done; printf '%s' "${out# }"; }
INNER="$(quote "${COMPOSE[@]}" "${BUILD_ARGS[@]}") && $(quote "${COMPOSE[@]}" "${UP_ARGS[@]}"); rc=\$?; echo \"DEPLOY_DONE commit=${COMMIT} rc=\$rc\"; exit \$rc"
UNIT="crm-deploy-$(date +%s)"

if [ "$DRY_RUN" -eq 1 ]; then
  # The inner command printed as written, so it can be read and copied.
  printf '+ systemd-run --unit=%s --collect -p WorkingDirectory=%q sh -c %s\n' "$UNIT" "$REPO_DIR" "'$INNER'"
else
  systemd-run --unit="$UNIT" --collect -p WorkingDirectory="$REPO_DIR" sh -c "$INNER"
fi
echo "Deploy unit: $UNIT (commit $COMMIT, cache $([ "$NO_CACHE" -eq 1 ] && echo off || echo on))"
echo "Follow it:   journalctl -fu $UNIT -o cat"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DEPLOY_DONE commit=${COMMIT} rc=0 unit=${UNIT} dry-run=1"
  trap - EXIT
  exit 0
fi
if [ "$WAIT" -eq 0 ]; then
  trap - EXIT
  exit 0
fi

STEP="wait"
while systemctl is-active --quiet "$UNIT"; do sleep 15; done
LOG="$(journalctl -u "$UNIT" -o cat --no-pager 2>/dev/null || true)"
printf '%s\n' "$LOG" | tail -n 40
RC="$(printf '%s\n' "$LOG" | sed -n 's/^DEPLOY_DONE commit=[^ ]* rc=\([0-9]*\).*/\1/p' | tail -n 1)"
RC="${RC:-1}"
trap - EXIT
echo "DEPLOY_DONE commit=${COMMIT} rc=${RC} unit=${UNIT}"
exit "$RC"
