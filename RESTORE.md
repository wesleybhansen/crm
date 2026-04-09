# Restore Procedure

How to revert the production CRM (`crm.thelaunchpadincubator.com`) to a known-good baseline if a tier migration breaks something irreparable.

This document is the **panic button**. If anything in tier 0 (or any future tier) goes wrong on prod, follow this procedure exactly. **Do not improvise.**

---

## Available checkpoints

| Label | Date | Git tag | DB dump (server) | DB dump (local) | SHA-256 |
|---|---|---|---|---|---|
| **Pre-tier-0 baseline** | 2026-04-09 | `checkpoint-pre-tier0-2026-04-09` | `/root/backups/db/checkpoint-pre-tier0-2026-04-09.sql.gz` | `~/Desktop/CRM-backups/checkpoint-pre-tier0-2026-04-09.sql.gz` | `397e1cb2b255641e0c55243229ffe91e2b402c56ba5978e1b690258e4d06a5f8` |

What this checkpoint contains:
- **Code:** commit `e7cdf730ef8c3f99f52947ab838bc0590b173683` on `main` (the "drift-prevention guardrails + mercato rebuild plan" commit). Login is functional. Landing page logo is correct. CLI in-container is functional.
- **Database:** 197 tables total (78 legacy from `setup-tables.sql` + 119 from open-mercato base migrations applied 2026-04-09). 1 admin user (`wesley.b.hansen@gmail.com`), seeded roles + features + dictionaries + currencies. The 78 legacy tables are empty of business data. 11,078 lines of SQL when uncompressed, ~40 KB compressed.

**Daily rolling backups** also exist at `/root/backups/db/crm-YYYY-MM-DD.sql.gz` (14-day retention, 03:00 UTC daily, runs via cron).

---

## When to restore

Restore from a checkpoint when **all** of these are true:
1. Production is broken in a way users would notice (login broken, dashboard 500s, data missing).
2. The break was caused by a deploy that you can't fix forward in under ~15 minutes.
3. You have evidence (or strong suspicion) that the database state is corrupted, not just the code.

If only the **code** is broken but the database is fine, do not restore the database — just `git revert` the bad commit, push, rebuild the container. Database restore is the heaviest possible action. Save it for actual data corruption.

---

## Restore procedure — code only (data is fine)

Use this when a tier migration deployed bad code but the schema/rows are still good.

```bash
# 1. From your laptop — find the bad commit
git log --oneline -10

# 2. Revert the bad commit (creates a new revert commit, doesn't rewrite history)
git revert <bad-commit-sha>
git push origin main

# 3. SSH in and rebuild
ssh root@5.78.71.144
cd /root/open-mercato
git pull origin main
docker compose -f docker-compose.prod.yml build app
docker compose -f docker-compose.prod.yml up -d --no-deps app

# 4. Verify
curl -sI https://crm.thelaunchpadincubator.com/ | head -3
curl -sI https://crm.thelaunchpadincubator.com/login | head -3
curl -sS -X POST https://crm.thelaunchpadincubator.com/api/auth/login \
  --data-urlencode 'email=wesley.b.hansen@gmail.com' \
  --data-urlencode 'password=<your-password>' \
  -o /dev/null -w 'HTTP %{http_code}\n'
# Expect HTTP 200
```

---

## Restore procedure — full database revert (data is corrupted)

Use this only when you've ruled out a code-only revert.

**WARNING:** This destroys all data created since the checkpoint was taken. There is no undo for the restore itself. Take a fresh dump of the current (broken) state first so you have something to forensic-debug from later.

### Step 1 — Snapshot the current broken state (so we can debug it later)

```bash
ssh root@5.78.71.144 'docker exec launchos-postgres pg_dumpall -U crm | gzip > /root/backups/db/broken-state-$(date +%Y-%m-%d-%H%M%S).sql.gz'
ssh root@5.78.71.144 'ls -lh /root/backups/db/broken-state-*'
```

### Step 2 — Stop the app so nothing writes to the DB during the restore

```bash
ssh root@5.78.71.144 'docker compose -f /root/open-mercato/docker-compose.prod.yml stop app'
```

### Step 3 — Drop and recreate the database from the checkpoint

`pg_dumpall` output is a "cluster dump" — it includes the role + database creation. To restore cleanly, drop the existing `crm` database first, then replay the dump as the `crm` user (which has CREATEDB rights).

```bash
ssh root@5.78.71.144

# Confirm the checkpoint is still on disk and matches the recorded SHA-256
shasum -a 256 /root/backups/db/checkpoint-pre-tier0-2026-04-09.sql.gz
# Expect: 397e1cb2b255641e0c55243229ffe91e2b402c56ba5978e1b690258e4d06a5f8

# Drop the existing database (must connect to a different db to issue DROP)
docker exec launchos-postgres psql -U crm -d postgres -c "DROP DATABASE IF EXISTS crm;"

# Replay the dump (creates the role + database + schema + data)
gunzip -c /root/backups/db/checkpoint-pre-tier0-2026-04-09.sql.gz | \
  docker exec -i launchos-postgres psql -U crm -d postgres

# Verify the database is back and has the expected number of tables
docker exec launchos-postgres psql -U crm -d crm -c "\dt" | wc -l
# Expect: ~204 (197 tables + headers)
```

### Step 4 — Roll the source code back to the matching checkpoint

The database schema only matches the code at the tagged commit. Mismatched code + DB will cause runtime errors.

```bash
ssh root@5.78.71.144
cd /root/open-mercato

# Check out the checkpoint tag (detached HEAD is fine for a revert)
git fetch --tags origin
git checkout checkpoint-pre-tier0-2026-04-09

# Rebuild the app from the checkpoint code
docker compose -f docker-compose.prod.yml build app
docker compose -f docker-compose.prod.yml up -d --no-deps app
```

### Step 5 — Verify

```bash
# Containers up?
docker compose -f /root/open-mercato/docker-compose.prod.yml ps

# App responding?
curl -sI https://crm.thelaunchpadincubator.com/ | head -3
curl -sI https://crm.thelaunchpadincubator.com/login | head -3

# Login working?
curl -sS -X POST https://crm.thelaunchpadincubator.com/api/auth/login \
  --data-urlencode 'email=wesley.b.hansen@gmail.com' \
  --data-urlencode 'password=<your-password>' \
  -o /dev/null -w 'HTTP %{http_code}\n'
# Expect HTTP 200

# No errors in app logs?
docker logs --tail 100 launchos-app 2>&1 | grep -iE 'error|⨯' | tail -20
```

### Step 6 — Get back on `main` (don't stay on a detached HEAD)

After the immediate fire is out, decide what to do:
- **If main is bad:** revert the bad commits on main first, then `git checkout main && git pull` on the server.
- **If main is fine and only the deploy was bad:** `git checkout main && git pull` on the server, rebuild, deploy.

Either way, do not leave the server on a detached HEAD long-term — the next `git pull` will fail loudly.

---

## Restore procedure — restore from the local laptop copy (server gone)

Use this only if the Hetzner box itself is destroyed and you're recovering on a new VPS.

```bash
# From your laptop, copy the checkpoint to the new server
scp ~/Desktop/CRM-backups/checkpoint-pre-tier0-2026-04-09.sql.gz \
  root@<new-server-ip>:/root/backups/db/

# Verify checksum on the new server
ssh root@<new-server-ip> 'shasum -a 256 /root/backups/db/checkpoint-pre-tier0-2026-04-09.sql.gz'
# Expect: 397e1cb2b255641e0c55243229ffe91e2b402c56ba5978e1b690258e4d06a5f8

# Then bootstrap the new server per SETUP-CHECKLIST.md and follow the
# "full database revert" procedure above starting from step 3.
```

---

## Pre-restore sanity checklist

Before running any of the procedures above, answer these:

- [ ] Is this actually a database problem, or is it a code problem? (If code, do the code-only revert.)
- [ ] Have I taken a snapshot of the current (broken) state for forensics? (Step 1 of the full revert.)
- [ ] Do I know which checkpoint I'm restoring to and why? (Look at the table at the top of this file.)
- [ ] Have I verified the checkpoint's SHA-256 matches what's recorded?
- [ ] Is anyone else working in the system right now whose changes I'd destroy?
- [ ] Have I told the team (if applicable) that I'm restoring?

If any of those is "no", **slow down and resolve it before touching anything.**

---

## Adding new checkpoints

Take a new labeled checkpoint **before each tier migration starts** so we always have a "last known good" close to the active work. The pattern:

```bash
ssh root@5.78.71.144 'docker exec launchos-postgres pg_dumpall -U crm | gzip > /root/backups/db/checkpoint-pre-tier<N>-$(date +%Y-%m-%d).sql.gz'

# Pull a copy locally
scp root@5.78.71.144:/root/backups/db/checkpoint-pre-tier<N>-*.sql.gz ~/Desktop/CRM-backups/

# Verify checksum matches
ssh root@5.78.71.144 'shasum -a 256 /root/backups/db/checkpoint-pre-tier<N>-*.sql.gz'
shasum -a 256 ~/Desktop/CRM-backups/checkpoint-pre-tier<N>-*.sql.gz

# Tag the source state in git
git tag -a checkpoint-pre-tier<N>-<date> -m "Pre-tier-<N> baseline. SHA-256 <sha>."
git push origin checkpoint-pre-tier<N>-<date>

# Add a row to the table at the top of this file
```

The daily cron at `03:00 UTC` writes rolling 14-day backups to `/root/backups/db/crm-YYYY-MM-DD.sql.gz`. Those are for routine recovery. The labeled checkpoints are for migration boundaries — they live forever, are tagged in git, and have an off-server copy.
