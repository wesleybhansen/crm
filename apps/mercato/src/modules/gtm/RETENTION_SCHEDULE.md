# GTM retention schedule

The GTM retention sweep (`lib/retention/sweep.ts`) is exposed at the
process-secret route `POST /api/internal/gtm/retention` (module path
`/internal/gtm/retention`). It is body-less, global, and authenticated with
the same fail-closed `NOLI_INTERNAL_SERVICE_SECRET` bearer as the box's other
process routes (`apps/mercato/src/lib/cron-auth.ts`).

Nothing else in this repo calls the route. Until the hub scheduler owns it,
the CRM box crontab must run it once a day. Add this line to the crontab
section of `apps/mercato/deploy.sh` (step 5, next to the other process
routes) and to the live crontab on the box:

```
15 3 * * * curl -s -X POST http://localhost:3000/api/internal/gtm/retention -H 'Authorization: Bearer YOUR_NOLI_INTERNAL_SERVICE_SECRET'
```

What one run does (all idempotent, counts-only audit rows):

- hard-deletes expired, never-promoted, never-enrolled candidates with their
  evidence, contact points, matches, relations, and manual drafts;
- anonymizes contact points, rendered subject/body, and identity for enrolled
  candidates whose every enrollment finished more than 90 days ago
  (bounded to `POST_CAMPAIGN_BATCH` rows per run, so a backlog drains over
  several days rather than in one long transaction);
- hard-deletes expired manual outreach drafts regardless of candidate state
  (bounded to `MANUAL_DRAFT_BATCH` rows per run);
- skips every candidate covered by a non-completed legal-hold deletion
  request (`/internal/gtm/privacy` ops `set-legal-hold` / `clear-legal-hold`).

`lib/__tests__/retention-route.test.ts` asserts the route accepts the process
secret, refuses anything else, and runs the sweep.
