# CRM box scheduled jobs

Copies of what runs on the CRM box (`/root/crm-cron/` and root's crontab), kept here so they are versioned. The box is the source of truth; if you change a script, change it on the box and here in the same change.

Secrets are never in these files. The wrappers read `/root/crm-cron/secrets.env` (chmod 600: `SEQUENCE_PROCESS_SECRET`, `CRON_SECRET`) or `NOLI_INTERNAL_SERVICE_SECRET` from `/root/open-mercato/.env.production`. `crontab` here is the box crontab as installed.

## What runs when (UTC)

| When | Script | Calls |
|---|---|---|
| every minute | `reminders-process.sh` | `POST /api/reminders/process` (task reminders) |
| every 5 min | `sequences-process.sh` | `POST /api/sequences/process` (sequence steps, delayed steps) |
| every 5 min | `cs-scheduled-send.sh` | `POST /api/customer-service/scheduled-send` (held Customer Service auto-sends) |
| every 5 min | `outbound-events-drain.sh` | `POST /api/internal/outbound-events/drain` (closed deals and journey closings to the marketing app, retries) |
| every 5 min | `booking-reminders.sh` | `POST /api/calendar/reminders` (booking reminders, once per booking and window) |
| every 5 min | `event-reminders.sh` | `POST /api/crm-events/reminders` (event reminders, once per attendee and window) |
| every 10 min | `automation-rules.sh` | `POST /api/sequences/automation-rules/run-scheduled` (scheduled automations, delayed automation steps, then "Invoice Overdue" automations for newly overdue invoices) |
| every 15 min | `ai-customer-service.sh` | `POST /api/customer-service/process` (support inboxes: drafts, promises, alerts) |
| every 15 min | `ai-inbox.sh` | `POST /api/inbox/process` (personal Inbox drafts) |
| every 15 min | `personal-inbox-sync.sh` | `POST /api/internal/personal-inbox-sync` (service secret) |
| every 30 min | `email-intelligence.sh` | `POST /api/email/intelligence-cron` (Bearer `CRON_SECRET`, header only) |
| hourly :00 | `ai-classify-sentiment.sh` | `POST /api/ai/classify-sentiment` |
| hourly :17 | `cron-health.sh` | folds every job's outcome into `/root/backups/status.json` (`cron_health`) |
| 03:00 | `run.sh db-backup /root/backups/db-backup.sh` | nightly database backup (see `ops/backup/`) |
| 03:30 | `run.sh gtm-threads-tokens ...` | Threads OAuth token maintenance (CLI in the app container) |
| 04:37, 16:37 | `certbot-renew.sh` | TLS renewal for crm.noliai.com; reloads nginx when renewed |
| 12:00 | `ai-meeting-prep.sh` | `POST /api/ai/meeting-prep` |
| 13:00 | `ai-digest.sh` | `POST /api/ai/digest` (weekly digest; the route picks each org's day) |
| 14:00 | `ai-relationship-decay.sh` | `POST /api/ai/relationship-decay` |
| 04:30 on the 1st | `run.sh restore-drill /root/backups/restore-drill.sh` | monthly restore drill |

GTM retention is not on the box: the hub runs it daily (`apps/hub/vercel.json` in noli-platform).

## How failures are noticed

Every job sources `lib.sh`:

- each run appends a line to `/root/crm-cron/logs/runs-<date>.log` and overwrites `/root/crm-cron/state/<job>.status`;
- a failure (curl error, a non-2xx answer, or a non-zero exit) is also appended to `logs/failures-<date>.log`;
- `cron-health.sh` (hourly) writes `cron_health` (`failing`, `stale`, `failures_24h`, per-job last run) into `/root/backups/status.json` and `logs/failure-summary-<date>.txt`, and deletes logs older than 14 days.

`status.json` is served by the CRM's `POST /api/internal/backup-status`; the hub's daily `ops-health` cron reads it and emails the founders when a job failed its last run, has not run when expected, or `cron_health` stopped updating (the same alarm as a stale backup).

To check by hand on the box: `cat /root/crm-cron/logs/failure-summary-$(date -u +%F).txt`.
