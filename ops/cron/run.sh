#!/bin/bash
# Run any command as a recorded cron job: run.sh <job name> <command...>
# Used for the jobs that are not an HTTP call (backups, restore drill, the
# Threads token CLI). Added 2026-09-26.
set -uo pipefail
. /root/crm-cron/lib.sh
job=$1
shift
cron_run "$job" "$@"
