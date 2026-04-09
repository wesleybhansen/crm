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

## Changelog

- **2026-04-09** — Initial draft after the prod database bootstrap incident. Wrote the recipe, prioritized modules, sized the work, and added the guardrails (AGENTS.md forbidden-patterns section, deprecation banner on setup-tables.sql, pre-commit hook).
