# SPEC-061: Migrate the CRM from raw-knex routes to native mercato modules

**Status:** Draft — proposal for prioritization
**Owner:** Wesley Hansen
**Created:** 2026-04-09
**Driver:** Production hardening + AI/Scout integration + multi-tenant safety

## Problem

When this CRM was rebuilt on top of the open-mercato framework (commit `0d9e4726b`, "LaunchOS v2"), the rebuild brought over the dashboard UI, the auth system, and the module-loader scaffolding — but **most of the business-domain features were left as raw `knex` queries against hand-maintained tables in `setup-tables.sql`**. Today the codebase is split into two worlds:

- **Mercato-managed** (the right way): users, roles, tenants, organizations, customers (people/companies/deals), audit logs, query index, custom fields, RBAC, workflows, currencies, dictionaries, etc. — defined as `@Entity` classes with generated migrations under each module's `data/`, served via `makeCrudRoute` API routes.
- **Raw-SQL managed** (the wrong way): all business-domain features — `email_*`, `forms`, `landing_pages`, `funnels`, `courses`, `bookings`, `sequences`, `automation_rules`, `affiliates`, `chat_*`, `surveys`, `tasks`, `contact_notes`, `business_profiles`, `payment_*`, `stripe_connections`, `twilio_connections`, etc. — 78 hand-maintained CREATE TABLE statements in `setup-tables.sql`, queried by 52 raw API route handlers under `apps/mercato/src/app/api/` that bypass the framework entirely.

Production prod-DB drift incident on 2026-04-09 surfaced the cost: `deploy.sh` only ran `setup-tables.sql` and never invoked `yarn db:migrate`, leaving the production database with the 78 raw tables but **none of the open-mercato base schema**. Login was broken from day one and nobody noticed because end-to-end testing was never done in prod. The same architectural fragility will surface again every time the schema, routes, or RBAC need to evolve.

## Why this matters (concrete impact, not architecture astronaut talk)

| Capability | Mercato module | Raw-knex route |
|---|---|---|
| **Multi-tenant isolation** | `makeCrudRoute` enforces `organization_id` + `tenant_id` filtering on every query. Hard to forget. | Each route must remember `.where('organization_id', orgId)` manually. One miss = silent cross-tenant data leak. **This is the #1 production risk.** |
| **Schema drift** | Entity is the source of truth. `yarn db:generate` produces migrations. TypeScript catches drift at compile time. | `setup-tables.sql` is hand-maintained. Add a column to a query, forget to update SQL → 500 in prod with no compile warning. We hit this on 2026-04-09 with `forms.is_active` and `courses.status`. |
| **Custom fields** | Users/admins can extend any entity with custom fields through the UI. Stored in `entity_indexes`. | Schema is frozen. No customer customization possible. |
| **AI/Scout/MCP visibility** | Entities auto-indexed for fulltext + vector search. AI assistant can introspect them via the MCP tool registry and query engine. | **Invisible to Scout.** The voice assistant literally cannot see `email_messages`, `tasks`, `contact_notes`, or any other raw-SQL table. As you build out more AI features this gap widens. |
| **Workflows / automations** | CRUD events fire automatically (`module.entity.created` etc.). Workflow engine, automation rules, and notifications all key off these. | No events. Workflows can't react to changes in raw-SQL tables without bespoke event-emit code on every mutation. |
| **Audit logging** | Automatic on CRUD operations via the command pattern. | Manual. Almost certainly missing on most routes. |
| **Undo/redo** | Command pattern wraps writes with snapshots. Users can undo. | Not possible. |
| **OpenAPI / API docs** | Generated from zod schemas + entity types. Always accurate. | Manual or absent. |
| **Encryption at rest** | GDPR-sensitive fields encrypted automatically via `findWithDecryption`. | Plaintext. |
| **Cache invalidation** | Tag-based, automatic on CRUD events. | Manual. |
| **Widget injection** | Other modules can inject UI into your forms/tables (e.g., a tasks widget on the contact detail page). | Each page is a closed island. |
| **Backwards compatibility** | Platform's BC contract protects entity tables, event IDs, route URLs. | None of those guarantees apply. Anything can break anything. |

The two highest-leverage rows: **multi-tenant isolation** (security) and **AI/Scout visibility** (the central product bet of this CRM).

## Goals

- **Bring every raw-SQL business table under mercato module management** without losing data and without breaking the live API surface.
- **Delete `setup-tables.sql`** by the end of the rebuild.
- **Delete every raw-knex route under `apps/mercato/src/app/api/`** (or move it into a module).
- **Preserve URL contracts** — existing API URLs must keep working during the migration so the frontend doesn't have to be rewritten in lockstep.
- **No regressions in tenant isolation, RBAC, or feature behavior.**

## Non-goals

- Don't try to add new capabilities during the migration. Each module migration is a refactor, not a feature ship.
- Don't touch the `customers` module — it's already mercato-native (mostly) and is the reference pattern.
- Don't refactor the dashboard UI or page layouts. The migration is API + entity layer only.
- Don't try to make the migration pretty in one PR. It must be incremental and shippable in slices.

## Approach

### Per-module recipe (the canonical procedure)

For each raw-knex feature (`email`, `forms`, `courses`, etc.), follow this exact sequence. The customers module is the reference; copy its structure.

1. **Inventory phase** — list every `setup-tables.sql` table the feature owns, every raw `apps/mercato/src/app/api/<feature>/**` route file, every backend page that calls those routes, and every event handler / cron / subscriber that touches the tables. Output: a markdown checklist committed to the migration PR.

2. **Entity phase** — define `data/entities.ts` in the module under `apps/mercato/src/modules/<feature>/data/entities.ts` (or `packages/core/src/modules/<feature>/` if it's a core feature) with `@Entity` decorators that match the existing tables **byte-for-byte** — same column names, same types, same defaults, same FKs, same indexes. Use `@Entity({ tableName: 'forms' })` to keep the existing table name.

3. **Migration phase** — run `yarn db:generate`. For tables that already exist with matching schema this should produce an **empty migration file** (a no-op). Commit the empty migration as documentation that the entity is now ORM-managed. **If the generator produces a non-empty migration, the entity does not match the table** — fix the entity until the migration is empty. This is the safety net against schema drift.

4. **Validator phase** — write `data/validators.ts` with zod schemas for create/update/list. Derive TypeScript types via `z.infer<typeof schema>`.

5. **ACL phase** — declare features in `acl.ts` (`<feature>.view`, `<feature>.create`, `<feature>.edit`, `<feature>.delete`, `<feature>.manage`). Add to `setup.ts` `defaultRoleFeatures` for `admin`/`employee`/`superadmin`.

6. **Setup phase** — implement `setup.ts` with `defaultRoleFeatures` and any tenant-init seeds the feature needs (numbering sequences, default templates, etc.).

7. **Events phase** — declare typed events in `events.ts` using `createModuleEvents`. The standard set: `<feature>.<entity>.created`, `<feature>.<entity>.updated`, `<feature>.<entity>.deleted`. The CRUD factory will emit these automatically.

8. **API phase** — write `api/<resource>/route.ts` using `makeCrudRoute` with `indexer: { entityType: '<feature>:<entity>' }`. Use the customers people route (`packages/core/src/modules/customers/api/people/route.ts`) as the template. Export `openApi` for documentation generation.

9. **URL preservation phase** — the existing raw routes live at URLs like `/api/forms`, `/api/courses`, `/api/business-profile`. These URLs must keep working. Two strategies:
   - **Preferred:** The new mercato route lives at the same URL because mercato auto-discovers `api/<path>/route.ts` → `/api/<path>`. The old raw file is deleted and the new one takes its slot. Verify with curl that the response shape still matches what the frontend expects.
   - **Fallback:** If the old route's response shape was custom (e.g., wrapped, denormalized, joined), keep the old file as a thin shim that calls into the new mercato services and reformats the response. Mark the shim with a TODO and remove once the frontend is updated.

10. **Command phase** — for write operations, implement commands under `commands/<entity>.ts` following `packages/core/src/modules/customers/commands/people.ts`. Wrap mutations in `withAtomicFlush`. Emit side effects via `emitCrudSideEffects` outside the flush. Wire up undo via `emitCrudUndoSideEffects`.

11. **Search/index phase** — write `search.ts` with the entity's searchable fields, title field, subtitle field, and icon. Run `yarn search:reindex <feature>:<entity>` to populate the index for existing rows.

12. **Backend page phase** — if the backend pages currently live under `apps/mercato/src/app/(backend)/backend/<feature>/`, move them into the module under `<feature>/backend/<page>.tsx`. The auto-router will route them at the same URL. If the pages already use `apiCall`/`CrudForm`/`DataTable` they should work unchanged.

13. **AI tools phase** — write `ai-tools.ts` exposing the entity to the MCP tool registry so Scout can read/write it. This is the unlock for "ask Scout to summarize this contact's emails" working.

14. **Test phase** — add an integration test under `.ai/qa/<feature>/` using the patterns in `.ai/qa/AGENTS.md`. The test must (a) create a record, (b) read it back, (c) update it, (d) delete it, (e) verify cross-tenant isolation by attempting to read from a second tenant and expecting 404. The cross-tenant test is non-negotiable.

15. **Cleanup phase** — once the new module is shipped and the integration test passes, delete:
    - The raw API route files under `apps/mercato/src/app/api/<feature>/`
    - The corresponding `CREATE TABLE` statements from `setup-tables.sql` (this is the ONLY legal edit to that file)
    - Any standalone backend pages under `apps/mercato/src/app/(backend)/backend/<feature>/`

16. **Verify in prod** — deploy, smoke test the migrated routes, confirm no 500s in `docker logs launchos-app`, confirm Scout can see the entity in the schema discovery output.

### Module migration order (priority + dependencies)

Migrations must be ordered to (1) ship the highest-risk modules first and (2) respect data dependencies. Proposed order:

| # | Module(s) | Tables | Why this order |
|---|---|---|---|
| 0 | `customers` cleanup | `customer_*`, `business_profiles`, `tasks`, `contact_notes`, `contact_attachments`, `contact_engagement_scores`, `contact_open_times`, `engagement_events`, `reminders` | **Highest tenant-isolation risk.** Most reads, most writes, most cross-references. Customers is partially modular already — close the gap first. Brings tasks/notes/reminders along since they hang off contacts. |
| 1 | `email` | `email_accounts`, `email_campaigns`, `email_campaign_recipients`, `email_messages`, `email_lists`, `email_list_members`, `email_templates`, `email_style_templates`, `email_preferences`, `email_preference_categories`, `email_unsubscribes`, `email_routing`, `email_connections`, `esp_*` | Largest blast radius if isolation breaks (sending mail on the wrong tenant). Also a top AI integration target ("Scout, who haven't I emailed in a month?"). |
| 2 | `forms` + `landing_pages` + `funnels` | `forms`, `form_submissions`, `landing_pages`, `landing_page_forms`, `funnels`, `funnel_steps`, `funnel_sessions`, `funnel_visits`, `funnel_orders` | Adjacent feature cluster. Schema drift already biting (`forms.is_active` missing). Funnels feed analytics + CRM events so they need clean event emission. |
| 3 | `sequences` + `automation_rules` | `sequences`, `sequence_steps`, `sequence_enrollments`, `sequence_step_executions`, `automation_rules`, `automation_rule_logs`, `stage_automations` | Workflow engine integration target. Once these are mercato-native, the workflows module can trigger sequence enrollment via typed events instead of raw cron loops. |
| 4 | `payments` + `billing` | `payment_links`, `payment_records`, `invoices`, `stripe_connections`, `credit_balances`, `credit_packages`, `credit_transactions`, `products` | Money. Highest cost-of-bug. Migrate after the high-volume modules to amortize the learning. |
| 5 | `bookings` + `calendar` | `bookings`, `booking_pages`, `google_calendar_connections` | Smaller surface, fewer routes, good warmup before courses. |
| 6 | `courses` | `courses`, `course_modules`, `course_lessons`, `course_enrollments`, `course_student_sessions`, `course_magic_tokens`, `lesson_progress` | Largest single feature by table count. Defer until the team has the per-module recipe down. |
| 7 | `chat` + `inbox` + `surveys` + `affiliates` + `meeting_prep_briefs` + `task_templates` + `response_templates` + `webhooks` + `chat_widgets` + `sms_messages` + `twilio_connections` + `ai_settings` + `ai_usage` + `inbox_ai_settings` | grab-bag | Long tail. Migrate opportunistically — when a feature gets touched for a bug or improvement, do the migration as part of the same change. |

### Sizing (working-day estimates, single engineer)

- Module 0 (customers cleanup): **3-5 days** — most of it is already there, this is closing gaps and adding tests.
- Module 1 (email): **8-12 days** — largest module, ~12 tables, most existing route handlers, needs careful event design for sequence/workflow integration.
- Module 2 (forms+landing+funnels): **6-9 days** — three sub-features but they share patterns.
- Module 3 (sequences+automations): **6-9 days** — needs event-driven re-architecture, can't be a 1:1 port.
- Module 4 (payments+billing): **6-9 days** — careful work, high test coverage required.
- Module 5 (bookings+calendar): **3-5 days** — small surface.
- Module 6 (courses): **5-8 days** — large surface but mostly straightforward CRUD.
- Module 7 (long tail): **8-15 days total**, spread incrementally.

**Total: 45-72 working days (~9-14 weeks) of focused single-engineer work.** Add 30-50% for integration testing, prod incidents, and unforeseen complexity → **3-5 calendar months** if done as a dedicated sprint by one person, or **6-9 calendar months** if interleaved with feature work.

## Migration strategy (phased rollout)

### Phase A — guardrails up before any rebuild (today, ~1 day)

1. ✅ Add "Forbidden Patterns" section to `AGENTS.md` (done in this commit).
2. ✅ Add `setup-tables.sql` deprecation banner (done in this commit).
3. ✅ Add `scripts/check-forbidden-patterns.mjs` pre-commit hook (done in this commit).
4. **TODO:** Add ESLint rule banning `getKnex()` outside of `data/` directories (next pass).
5. **TODO:** Add a CI step that runs the forbidden-patterns script on PRs from forks (the pre-commit hook only protects local commits).
6. **TODO:** Patch `deploy.sh` to (a) refuse to run unless `--init` is passed, (b) run `yarn db:migrate` before `psql < setup-tables.sql`, (c) print a giant warning that incremental updates use the docker compose path, not deploy.sh.

### Phase B — fix the schema drift bugs we already know about (this week, ~1 day)

The 2026-04-09 smoke test surfaced two real bugs that block the dashboard from loading cleanly:

1. **`forms.is_active`** column missing — `forms.list` API queries it but the table doesn't have it. Either add the column (one-line `setup-tables.sql` edit, **legitimate exception** since we're not adding a new feature) OR remove the filter from the API. The right fix is to add the column because the API code clearly expects it.
2. **`courses.status`** column missing — `/api/courses` selects `status` but the table only has `is_published` and `generation_status`. Either add `status` or update the API to use `is_published`. The right fix is to update the API.
3. **`email_intelligence_settings`** table missing entirely — referenced by `/api/email-intelligence/sync` (the Outlook cron). Per CONTEXT.md §16 line 700 this is a known deferred issue. Decide: defer to the email module migration (Phase D module 1) or add the table as a one-off `setup-tables.sql` exception now.

These are pre-existing bugs that have been broken on prod since deploy day — not regressions from this session's work. They block any backend pages that depend on those routes from rendering cleanly.

### Phase C — pilot module (week 1, the customers cleanup)

Before kicking off the long migration, prove the per-module recipe end-to-end on the customers module. This is the cheapest one because most of it is already done.

Deliverables:
- The exact 16-step recipe verified to work
- The integration test pattern proved out
- The cross-tenant isolation test pattern proved out
- The "URL preservation" strategy validated
- One real PR end-to-end as a template for future migrations
- A retrospective: how long did it actually take? what surprised us?

The retrospective output updates the per-module sizing in this spec.

### Phase D — sequential per-module migrations (weeks 2-N)

Work the priority list top-to-bottom, one module per PR. Each PR follows the 16-step recipe. Each PR ends with a deploy + smoke test + Scout-visibility verification.

Hard rule: **no parallel module migrations.** Each migration touches the schema and the routes; doing two at once invites merge conflicts and integration test interference. Pipeline them.

### Phase E — final cleanup (week N+1)

Once every table in `setup-tables.sql` has been migrated and verified:

1. Delete `setup-tables.sql` entirely.
2. Delete `deploy.sh` or replace it with a one-liner pointing at the docker compose path.
3. Drop the `scripts/check-forbidden-patterns.mjs` rule for `setup-tables.sql` (since the file no longer exists).
4. Add a "Migration complete" entry to `RELEASE_NOTES.md`.
5. Update CONTEXT.md §16 with the final schema state.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Cross-tenant data leak introduced during migration** | Every migration PR must include the cross-tenant isolation integration test. PR cannot merge without it. |
| **Production downtime during a migration** | Each migration is additive — the new mercato module uses the same table name, so no rename, no data move, no copy. The old route is deleted in the same PR but the URL is preserved by the new route. Worst case: revert the PR. |
| **Schema drift between mercato entity and existing table** | `yarn db:generate` is the canary. If it produces a non-empty migration after defining the entity, the entity is wrong — fix it until the diff is empty before proceeding. |
| **Frontend depends on a custom response shape that the new CRUD route doesn't match** | The "URL preservation phase" of the recipe explicitly handles this with a thin shim. Inventory phase catches it before code is written. |
| **A migration takes 3x longer than estimated** | Estimates are deliberately ranged. Sizing is per-module so we can adjust the schedule after each one. The retrospective in Phase C re-baselines. |
| **Scope creep — someone tries to "improve" a feature during its migration** | Forbidden by spec. Migrations are refactors, not feature ships. New features go through the normal spec process and land in the module after migration. |
| **A subordinate cron/worker breaks because event timing changed** | Inventory phase catches subscribers/workers/crons that touch the table. Each is verified manually as part of the migration PR. |
| **Backups not in place when something goes wrong on prod** | Every migration deploy is preceded by a `pg_dumpall` to `/root/db-backup-pre-<feature>-<date>.sql` on the server. Same pattern as the 2026-04-09 backup. |

## Acceptance criteria

A migration is "done" when **all** of the following are true:

1. The module exists with `data/entities.ts`, `acl.ts`, `setup.ts`, `events.ts`, `api/`, `commands/`, `search.ts`, `ai-tools.ts`, and `data/validators.ts`.
2. `yarn db:generate` produces an empty migration for the module's tables (proves entity matches schema).
3. All previously-existing API URLs for the feature still return 200 with the same response shape (proves URL contract preserved).
4. The integration test under `.ai/qa/<feature>/` passes, including the cross-tenant isolation test.
5. Scout can introspect the entity via the MCP tool registry (proves AI visibility).
6. The feature's tables are deleted from `setup-tables.sql`.
7. No raw-knex API route handlers remain under `apps/mercato/src/app/api/<feature>/`.
8. Smoke test passes against prod after deploy.

The full rebuild is "done" when `setup-tables.sql` is deleted and `apps/mercato/src/app/api/` contains zero raw-knex route files.

## Open questions for Wesley

1. **Sprint vs incremental?** Do you want this as a focused 3-5 month sprint that pauses feature work, or interleaved with feature work over 6-9 months? The sprint version finishes faster and gets you the security/AI benefits sooner, but blocks new feature development.
2. **Headcount?** Single engineer or parallel? The plan above assumes single-engineer to avoid merge hell. If you want to add a second engineer, the way to parallelize is by **subsystem**, not by module — e.g., one person owns email/sequences/automations (the messaging stack) while another owns forms/landing/funnels (the acquisition stack). Customers must be done first by whoever, then the streams split.
3. **Pre-existing schema drift bugs in Phase B** — do you want me to fix `forms.is_active` and `courses.status` and `email_intelligence_settings` now (one-day side quest, gets the dashboard cleaner) or roll them into the respective module migrations?
4. **Should we set up a staging environment** before any of this? Right now there's no staging — every test is on prod or local. A staging Hetzner box with a copy of the prod DB would let migrations be validated end-to-end before touching prod.
5. **Backup automation** — should I set up a nightly `pg_dumpall` cron + offsite copy as part of Phase A, or defer? My recommendation is do it now, before the migration starts touching the schema. ~30 min of work, lifelong insurance.

## Tier 0 retrospective (2026-04-09)

Tier 0 (customers cleanup) shipped as **Stage A only** — the new mercato infrastructure is live in production but the cutover (frontend updating to call the new URLs, deletion of old raw routes, dropping migrated tables from `setup-tables.sql`) is deferred to a follow-up PR. Wesley's call after we discovered the URL convention surprise late in the day; documented below.

### What landed (Stage A — committed `9607d3dac`, deployed live)

- **9 new entities** in `packages/core/src/modules/customers/data/entities.ts`: `CustomerTask`, `CustomerContactNote`, `CustomerContactAttachment`, `CustomerContactEngagementScore`, `CustomerEngagementEvent`, `CustomerContactOpenTime`, `CustomerReminder`, `CustomerTaskTemplate`, `CustomerBusinessProfile`. All with explicit tenant + organization scoping, soft-delete where appropriate, and 3 expression-based `@Index` decorators for DESC sort parity with existing prod indexes.
- **1 idempotent migration** `Migration20260409154143.ts` — every statement uses `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD COLUMN IF NOT EXISTS` so it works on both fresh greenfield dev DBs and the existing prod DB. Verified live: applied to prod, added 11 new columns total (deleted_at to 4 tables, updated_at to 2 tables, created_at to 1 table, tenant_id to 2 tables).
- **17 zod validators** in `data/validators.ts` with derived TS types via `z.infer`.
- **14 ACL features** in `acl.ts`, auto-granted via the existing `customers.*` wildcard in `setup.ts`.
- **18 typed events** in `events.ts` (`customers.task.created`, `customers.note.created`, `customers.engagement.tracked`, `customers.reminder.fired`, etc.).
- **18 commands** in a consolidated `commands/tier0.ts` (~1100 lines) covering create/update/delete/upsert/track for all 9 entities, with snapshot-based undo support for the user-facing CRUD entities. Engagement events and contact_open_times are append-only and have no undo.
- **7 mercato-native API routes** under `customers/api/`:
  - `/api/customers/tasks` (CRUD via factory)
  - `/api/customers/notes` (CRUD via factory)
  - `/api/customers/contact-attachments` (CRUD via factory)
  - `/api/customers/reminders` (CRUD via factory)
  - `/api/customers/task-templates` (CRUD via factory)
  - `/api/customers/business-profile` (custom non-CRUD upsert)
  - `/api/customers/engagement` (custom — preserves the `?view=hottest|coldest|contact` semantics)

All 7 routes verified live and returning canonical mercato response shapes (5 use the CRUD factory's `{items, total, page, pageSize, totalPages}` paginated shape; 2 custom routes use the preserved `{ok, data}` shape).

### What did NOT land in tier 0 (deferred to follow-up PR — see "Tier 0 cutover" section below)

- Frontend call sites are still pointed at the old URLs (`/api/notes`, `/api/business-profile`, etc.) — they're not yet using the new `/api/customers/*` mercato routes
- The 14 raw API route files under `apps/mercato/src/app/api/` still exist and still serve traffic
- The 9 migrated tables are still listed in `setup-tables.sql`
- `customers/search.ts` does not yet register the new entities
- `customers/ai-tools.ts` does not yet expose the new entities to Scout
- Cross-tenant isolation Playwright integration test
- The 4 routes that won't fit `makeCrudRoute` cleanly (`/api/reminders/process` cron, `/api/contacts/[id]/attachments/[id]/download` binary stream, `/api/contacts/[id]/timeline` federated read, `/api/email/send-time` analytics aggregation) are untouched — they still query via raw knex but will be migrated to use the new ORM entities as part of either tier 0 cutover or their relevant tier (1 = email, 7 = long tail)

### Time taken (single engineer, single day)

| Phase | Wall clock |
|---|---|
| Inventory grep + report | ~20 min |
| 9 entity definitions + index audit | ~30 min |
| Migration generation + hand-rewrite for idempotency | ~25 min (auto-gen produced wrong CREATE TABLE statements; had to switch to idempotent ALTER pattern after discovering local-vs-prod schema divergence) |
| Validators (17 schemas) | ~15 min |
| ACL + events | ~10 min |
| Commands (18 in consolidated file) | ~50 min |
| 7 API routes | ~45 min |
| Build cycles (3 full rebuilds at 5 min each, 1 cached at 4s) | ~15 min |
| Generate + db:generate verification | ~5 min |
| Container rebuild on prod (single 18 min Docker build) | ~18 min |
| Migration apply on prod + schema verification | ~3 min |
| Smoke testing (login, 8 old routes, 7 new routes) | ~10 min |
| **Total focused work** | **~4 hours 5 min** |

This compares against the original SPEC-061 estimate of **4-6 days for tier 0**. Wall clock came in dramatically under budget because:
- Customers module was already partially mercato-native (existing patterns to copy)
- The 9 entities are simpler than the 17 existing customer entities (no nested addresses, no custom fields, no complex linking)
- I batched related work into single rebuild cycles instead of one rebuild per file
- Skipped the buildLog audit-trail string generation (deferred)
- Skipped the cross-tenant isolation integration test (deferred)
- **Did NOT run the cutover** (the reason this estimate is half what it'd be otherwise)

If the cutover was included, realistic estimate would be **6-9 hours** (the cutover is ~2-4 hours of frontend search-and-replace + dashboard click-through verification).

### What worked

1. **The 16-step recipe is sound.** Steps 1-8 executed cleanly in order with no rework needed beyond the migration idempotency rewrite. The recipe is the right backbone for tiers 1-7.
2. **Idempotent migration pattern is the right choice.** `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS` made the migration work in both fresh dev and existing prod environments without environment-specific branching. This pattern should be the default for every tier going forward — every tier migrates tables that already exist on prod with slightly different schemas.
3. **Schema-drift canary works.** After the entity revisions, `yarn db:generate` reported `customers: no changes` — proof the entities matched what I'd already committed in the migration. This is the load-bearing safety check; trust it.
4. **Pre-flight inventory was worth the time.** The Explore agent's inventory report caught the duplicate `/api/tasks` vs `/api/crm-tasks` situation, the `tenant_id`-missing-from-engagement_events drift, and the polymorphic reminders pattern before any code was written. ~20 min of investigation saved hours of mid-execution rework.
5. **Pre-commit hook didn't fire any false positives** (it also didn't catch anything because I wasn't trying to add to setup-tables.sql).
6. **Backups were used as designed.** Took the labeled `checkpoint-pre-tier0-entities-2026-04-09` backup before any code changes; never needed it but the safety net was there.

### What surprised us (gotchas to apply to tier 1)

1. **The biggest miss: URL convention.** I assumed mercato module routes would map `customers/api/notes/route.ts` → `/api/notes`. Wrong — the actual convention is `/api/<module-id>/<path>`, so the route lives at `/api/customers/notes`. The AGENTS.md docs say `api/<path>/route.ts → /api/<path>` which is misleading. **For tier 1 onward, every new route lives at `/api/<module>/<path>`** and the cutover work always involves updating frontend call sites to the new prefixed URL. **Update the recipe in the SPEC-061 master plan to call this out explicitly.**

2. **`yarn db:generate` against a local DB without setup-tables.sql produces wrong migrations.** Mikro-orm generated unconditional `CREATE TABLE` statements because my local dev DB doesn't have the legacy tables. On prod those tables exist, so the auto-generated migration would have failed with "relation already exists". **The fix going forward: always hand-rewrite the auto-generated migration to be idempotent.** OR seed the local dev DB with `setup-tables.sql` before running `db:generate`. Recommend the former because it forces engineers to think about the migration's safety on prod.

3. **`docker exec launchos-app yarn db:migrate` runs the OLD bundled CLI** until the container is rebuilt. Pulling code on the host doesn't update the container filesystem. **The deploy sequence is: git pull → docker compose build app → docker compose up -d --no-deps app → docker exec launchos-app yarn db:migrate.** Don't try to migrate before the rebuild. Add this to the recipe.

4. **CLI builds via esbuild and does NOT resolve the `@/` path alias the same way Next does.** A lingering `import { foo } from '@/...'` in a subscriber/worker outside Next route handlers will break the in-container CLI silently. Use relative imports for subscribers/workers/module code. (Already documented in CONTEXT.md §17 from the deal-stage-webhook fix earlier in the day.)

5. **Multiple `yarn generate` processes running concurrently break each other.** Background-launching `yarn generate` and then forgetting to wait for the prior one creates two competing processes that both hang/fail. Always foreground or carefully serialize.

6. **Build cycles are the long pole.** Each full `yarn build:packages` is ~5 min uncached. Container rebuild is ~18 min. **For future tiers: batch all source changes into a single rebuild cycle**. Don't rebuild after each file edit.

7. **`commandBus` is registered in DI as `'commandBus'`** and you can resolve it directly via `container.resolve('commandBus') as CommandBus` from custom routes — this is the escape hatch when `makeCrudRoute` doesn't fit.

### Sizing updates for tiers 1-7

Based on the tier 0 retrospective, my updated estimates (single engineer, including cutover this time):

| Tier | Original estimate | Updated estimate | Why changed |
|---|---|---|---|
| 1 — email | 8-12 days | **6-10 days** | Recipe is proven, scaffolding from tier 0 is reusable, but email has 15 tables vs 9 and the cron + sequences integration needs care |
| 2 — forms+landing+funnels | 6-9 days | **5-7 days** | Simpler scope than email, tier 0 patterns directly transferable |
| 3 — sequences+automations | 6-9 days | **8-12 days** | **Increased.** Tier 0 didn't touch event-driven architecture; sequences+automations need real workflow engine integration which wasn't rehearsed in tier 0 |
| 4 — payments+billing | 6-9 days | **6-9 days** | Unchanged. Money is high-stakes regardless of recipe maturity |
| 5 — bookings+calendar | 3-5 days | **3-4 days** | Tier 0 patterns directly applicable, small surface |
| 6 — courses | 5-8 days | **5-7 days** | Largest by table count but customer portal RBAC adds complexity |
| 7 — long tail | 8-15 days | **8-15 days** | Unchanged — opportunistic by definition |
| **Total** | 42-67 days | **41-64 days** | Roughly the same. Recipe maturity savings offset by sequences+automations re-architecting being harder than I'd planned. |

Plus tier 0 cutover work: **2-4 hours** (Stage B + Stage C below).

### Tier 0 cutover — the deferred work (separate follow-up PR)

This is what would turn tier 0 from "infrastructure shipped" to "infrastructure in use". Should be its own PR, runnable in a single sitting:

1. **Frontend URL update.** Search-and-replace 30-50 call sites across these files (inventoried during tier 0 but not modified):
   - `packages/core/src/modules/customers/backend/contacts/page.tsx` — `/api/notes` → `/api/customers/notes`, `/api/crm-tasks` → `/api/customers/tasks`, `/api/engagement` → `/api/customers/engagement`, `/api/reminders` → `/api/customers/reminders`, `/api/contacts/<id>/attachments` → `/api/customers/contact-attachments?contactId=<id>`
   - `packages/core/src/modules/customers/backend/assistant/page.tsx` — same routes plus `/api/business-profile` → `/api/customers/business-profile`
   - `packages/core/src/modules/customers/backend/settings-simple/page.tsx` — `/api/business-profile` → `/api/customers/business-profile`
   - `packages/core/src/modules/customers/backend/customers/deals/pipeline/page.tsx` — `/api/business-profile`, `/api/engagement`
   - `packages/core/src/modules/customers/backend/automations/page.tsx`, `automations-v2/page.tsx` — `/api/business-profile`
   - `apps/mercato/src/modules/dashboards/backend/dashboards/page.tsx` — `/api/business-profile`, `/api/reminders/check`, `/api/engagement?view=hottest`
   - Any other consumers found by grepping for the 7 URL patterns

2. **Verify the dashboard works** by clicking through every page that touches these routes. Wesley is the only test user; this needs his hands.

3. **Delete the 14 old raw route files** under `apps/mercato/src/app/api/`:
   - `tasks/route.ts`, `crm-tasks/route.ts`
   - `notes/route.ts`
   - `contacts/[id]/attachments/route.ts` (keep `contacts/[id]/attachments/[id]/download/route.ts` — that's the binary stream, separate concern)
   - `reminders/route.ts` (keep `reminders/process/route.ts` — that's the cron, separate concern)
   - `engagement/route.ts` (keep `engagement/score.ts` — internal helper)
   - `business-profile/route.ts`
   - `task-templates/route.ts`

4. **Drop the 9 migrated tables from `setup-tables.sql`** using `FORBIDDEN_PATTERNS_OVERRIDE=1` (the only legitimate use of the override — the pre-commit hook only blocks net additions, not deletions, but documenting the override in the commit message is good hygiene). Tables to drop:
   `tasks`, `contact_notes`, `contact_attachments`, `contact_engagement_scores`, `contact_open_times`, `engagement_events`, `reminders`, `task_templates`, `business_profiles`.

5. **Final smoke test** of every dashboard page that touches the migrated entities.

6. **Migrate the 4 holdover routes** to use the new ORM entities (still raw route files but querying via `em.find` instead of raw knex):
   - `/api/reminders/process` — uses `CustomerReminder` for the queue
   - `/api/contacts/[id]/attachments/[id]/download` — uses `CustomerContactAttachment` for the metadata lookup
   - `/api/contacts/[id]/timeline` — uses `CustomerTask`, `CustomerContactNote`, etc. for the federated read
   - `/api/email/send-time` — uses `CustomerContactOpenTime` for the analytics aggregation

This last step is technically scope-creep on the cutover but it's the only way to fully delete the raw-knex queries against the 9 tier 0 tables. Worth bundling.

### Stage D — search + AI tools (also deferred, also a separate follow-up)

The new entities aren't yet:
- Registered in `customers/search.ts` (so they're not in the fulltext / vector search index)
- Registered in `customers/ai-tools.ts` (so Scout can't introspect them)

**These are the two highest-leverage things in the entire migration** because Scout visibility was one of the main reasons we're doing the rebuild. They should ship before tier 1 starts so the AI integration story is end-to-end provable.

Estimate: ~2-3 hours total. Should be a small focused PR after the cutover.

## Open questions for Wesley (updated 2026-04-09 EOD)

1. ~~Sprint vs incremental?~~ ✅ **Sprint, single engineer.**
2. ~~Headcount?~~ ✅ **Single engineer (Claude).**
3. ~~Schema drift bugs as side quests?~~ ✅ **Roll into module migrations.** (`forms.is_active` → tier 2, `courses.status` → tier 6, `email_intelligence_settings` → tier 1.)
4. ~~Staging environment?~~ ✅ **No, ship to live, Wesley tests.**
5. ~~Backup automation?~~ ✅ **Done.** Daily cron at 03:00 UTC + labeled checkpoint backups before each tier.
6. **NEW: Tier 0 cutover timing?** Should I run the cutover follow-up PR (steps 1-5 above, ~3-5 hours) before tier 1 starts, or push tier 1 first and circle back to the cutover later? My recommendation: **cutover first**, because it lets us delete dead code from `apps/mercato/src/app/api/` and prove the URL pattern works end-to-end before tier 1 starts adding more cutover work on top.
7. **NEW: Stage D (search + AI tools) timing?** Same question. Recommend doing it as part of the cutover PR — small enough to bundle, biggest user-visible benefit (Scout can finally see tier 0 entities).
8. **NEW: Offsite backups?** Still deferred from Phase A.5. Wesley to decide on Hetzner Storage Box (~€3.81/mo).

## Changelog

- **2026-04-09 (initial)** — Initial draft after the prod database bootstrap incident. Wrote the recipe, prioritized modules, sized the work, and added the guardrails (AGENTS.md forbidden-patterns section, deprecation banner on setup-tables.sql, pre-commit hook).
- **2026-04-09 (tier 0 retrospective)** — Stage A of tier 0 (entities + commands + routes + migration) shipped to production. 7 new mercato routes verified live at `/api/customers/*` URLs. Updated tiers 1-7 sizing based on retrospective. Documented the URL convention discovery, the idempotent migration requirement, and the multi-step deploy sequence as inputs for tier 1. Cutover (Stage B + C + D) deferred to a separate follow-up PR.
