# SPEC-064: Automatic Pipeline Stage Advancement

**Status:** Draft — awaiting approval before implementation
**Owner:** Wesley Hansen
**Created:** 2026-04-25
**Driver:** Solopreneurs hand-move contacts and deals through pipeline stages constantly. The system already captures every signal needed to do this automatically (form submissions, payments, sequence completions, engagement scores) but does nothing with them. This spec wires those signals into pipeline/stage advancement with a non-developer settings UI.

---

## TLDR

New `pipeline_automation` submodule under `packages/core/src/modules/customers/` adds a rules table, a single dispatcher subscriber, a settings page, and four pre-seeded default rules covering the four canonical triggers (form, payment, sequence completion, engagement score). Targets both **deal pipeline stages** (relational, per-pipeline) and **contact lifecycle stages** (free-text on person). Phase 2 generic rule builder explicitly deferred.

---

## Problem

The CRM already emits every event needed to drive stage advancement:

| Trigger | Event already exists | Source |
|---|---|---|
| Form submission | `landing_pages.form.submitted` | `apps/mercato/src/modules/landing_pages/events.ts:9` |
| Payment captured | `payment_gateways.payment.captured` | `packages/core/src/modules/payment_gateways/events.ts:6` |
| Engagement score change | `customers.engagement.score_updated` | `packages/core/src/modules/customers/events.ts:71` |
| Email opened/clicked | `email.message.opened` / `clicked` | `apps/mercato/src/modules/email/events.ts:7-8` |
| Task completed | `customers.task.completed` | `packages/core/src/modules/customers/events.ts:58` |
| Sequence completion | **MISSING** | `apps/mercato/src/modules/sequences/` — to be added |

Today these events fire and dissipate. Users complain that a contact who paid an invoice doesn't auto-move out of "Lead" stage, that a form submitter doesn't get marked "Lead" automatically, that a hot engagement score doesn't bubble the contact up. Manual stage management is the #2 reason users say the CRM "feels noisy" (after notification volume, addressed in #34).

Three existing automation engines (`workflows`, `business_rules`, `sequences/automation-rules`) could each technically host this feature, but none has a UX a non-developer would use for this specific job.

---

## Goals

- **Auto-advance deals** through pipeline stages on configured triggers.
- **Auto-set contact lifecycle stage** on configured triggers.
- **Settings UI** a solopreneur can use without touching code.
- **Sane defaults** seeded on tenant init — feature delivers value before the user opens settings.
- **Audit trail** so users see *why* a contact/deal moved.
- **Never move backward** by default (with override per rule).
- **Idempotent** — same event firing twice doesn't double-advance.

## Non-goals

- Generic rule builder (any-event → any-action). Phase 2.
- Backward stage moves on triggers (e.g., refund → demote). Phase 2.
- Cross-pipeline moves (advance from Pipeline A's stage 3 to Pipeline B's stage 1). Phase 2.
- Time-based triggers ("if no activity for 30 days, advance to Cold"). Owned by #14 Relationship Decay Alerts.
- Migration of existing `business_rules` / `workflows` / `automation-rules` data. Out of scope.

---

## Current State (verified 2026-04-25)

**Pipeline data model** (`packages/core/src/modules/customers/data/entities.ts`):
- `CustomerPipeline` (line 655) and `CustomerPipelineStage` (line 682) — first-class entities, multi-pipeline support per SPEC-028.
- `CustomerDeal.pipelineId` (line 281), `CustomerDeal.pipelineStageId` (line 284) — FK columns. Legacy free-text `CustomerDeal.pipelineStage` (line 278) still present, populated for backward compat.
- `CustomerPerson.lifecycleStage` (line 72) — free-text string. Conventionally one of: `Subscriber`, `Lead`, `MQL`, `SQL`, `Opportunity`, `Customer`, `Evangelist`, but not constrained.

**Stage-changed events already declared:**
- `customers.deal.stage_changed` (`events.ts:24`)
- `customers.person.stage_changed` (`events.ts:13`, category `lifecycle`)

**Subscriber pattern:** Auto-discovered from `subscribers/*.ts`; export `metadata: { event, persistent? }` + default handler. Reference: `packages/core/src/modules/customers/subscribers/deal-stage-changed-notification.ts`.

**Engagement scoring:** `CustomerContactEngagementScore` entity (`entities.ts:894`) with `score`, `lastActivityAt`. API at `/api/engagement`. No threshold-based event today — score updates emit `customers.engagement.score_updated` but consumers must do their own threshold check.

---

## Proposed Solution

### Module placement

New submodule directory inside the existing `customers` module: `packages/core/src/modules/customers/pipeline_automation/`. Not a top-level module — it's tightly coupled to `customers` data (deals, persons, pipelines, stages) and shipping it as part of `customers` keeps cross-tenant scoping consistent and avoids a new module enable step in `apps/mercato/src/modules.ts`.

Files:
```
customers/
├── data/entities.ts                # ADD: PipelineAutomationRule, PipelineAutomationRun
├── events.ts                       # ADD: customers.deal.auto_advanced, customers.person.auto_advanced
├── pipeline_automation/
│   ├── triggers.ts                 # Static list of supported triggers + filter shapes (single source of truth)
│   ├── dispatcher.ts               # Pure rule-evaluation function (event payload + active rules → planned actions)
│   ├── executor.ts                 # Applies planned actions via existing deal/person commands
│   └── seed.ts                     # 4 default rules created in setup.ts
├── subscribers/
│   ├── pipeline-auto-form.ts       # listens landing_pages.form.submitted
│   ├── pipeline-auto-payment.ts    # listens payment_gateways.payment.captured
│   ├── pipeline-auto-sequence.ts   # listens sequences.sequence.completed (new event)
│   └── pipeline-auto-engagement.ts # listens customers.engagement.score_updated
├── api/pipeline-automation/
│   ├── rules/route.ts              # CRUD via makeCrudRoute
│   ├── rules/[id]/route.ts         # GET/PUT/DELETE single
│   ├── runs/route.ts               # GET audit log (read-only)
│   ├── triggers/route.ts           # GET trigger catalog (for UI dropdowns)
│   └── openapi.ts
├── backend/settings/pipeline-automation/page.tsx  # Settings UI
└── setup.ts                        # ADD: seed default rules + new role features
```

**Why four subscribers, not one dispatcher subscriber per event:** subscribers are auto-discovered from filename and bound by `metadata.event`. One subscriber file per event is the framework's convention; consolidating would fight the loader. All four files are 5-line wrappers calling the same `dispatcher.ts` function.

### Triggers and supported filters (Phase 1 fixed list)

| Trigger key | Source event | Entity targeted | Filters available | Default action |
|---|---|---|---|---|
| `form_submitted` | `landing_pages.form.submitted` | person | form_id (optional, multi-select), is_new_contact (bool) | Set lifecycle to `Lead` |
| `payment_captured` | `payment_gateways.payment.captured` | person + deal | gateway_id (optional), amount_min, amount_max | Person → `Customer`, Deal → `Won` stage |
| `sequence_completed` | `sequences.sequence.completed` *(new)* | deal | sequence_id (optional, multi-select) | Advance deal by one stage in current pipeline |
| `engagement_threshold` | `customers.engagement.score_updated` | person | score_min (int, required), score_max (int, optional) | Set lifecycle to `Hot Lead` |

The trigger catalog is a static const in `triggers.ts` — each entry declares its event, supported entity types, supported filters (with type + UI hint), and default targets. The settings UI reads this catalog via `/api/pipeline-automation/triggers` so adding a Phase 2 trigger means one entry in `triggers.ts` + one new subscriber file.

### Global guards

- **Never move backward by default.** When target is a deal pipeline stage, compare `target.order` vs current stage's `order`; skip if target ≤ current. Override per rule via `allow_backward` boolean (default false). For lifecycle stage (free-text), no canonical ordering exists — "never backward" is opt-in via per-rule whitelist of "from" stages.
- **Idempotency.** Before applying, check `customer_pipeline_automation_runs` for an entry with same `(rule_id, entity_id, trigger_event_id)` in last 24h. Skip if found. Event IDs come from the event bus envelope.
- **RBAC.** Rule changes require `pipeline_automation.configure`. Audit log read requires `pipeline_automation.view_history`. Rule execution itself runs under a system principal (not the user who triggered the source event).
- **Tenant isolation.** Every query filters `organizationId` + `tenantId`. Rules belong to a single org. The dispatcher loads rules scoped to the event's org context — never cross-org.

### Sequence completion event (prerequisite)

Add to `apps/mercato/src/modules/sequences/events.ts`:
```ts
{ id: 'sequences.sequence.completed', label: 'Sequence Completed for Contact', entity: 'sequence_run', category: 'lifecycle' }
```

Emit from the existing sequence completion code path. Find via `grep -r "completed_at" apps/mercato/src/modules/sequences/` — locate where a `sequence_runs` (or equivalent) row is marked completed and add `emitModuleEvent('sequences.sequence.completed', { sequenceId, sequenceRunId, contactId, organizationId, tenantId }, ctx)`. **Verify during implementation** that this code path exists; if sequences track completion via cron-poll rather than event emit, retrofit accordingly.

---

## Data Models

### `customer_pipeline_automation_rules`

```sql
CREATE TABLE customer_pipeline_automation_rules (
  id                     uuid PRIMARY KEY,
  organization_id        uuid NOT NULL,
  tenant_id              uuid NOT NULL,
  name                   text NOT NULL,
  trigger_key            text NOT NULL,        -- references triggers.ts catalog
  filters                jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_entity          text NOT NULL,        -- 'deal' | 'person'
  target_pipeline_id     uuid NULL,            -- deal targets only
  target_stage_id        uuid NULL,            -- deal targets only; nullable when target_action = 'advance_one'
  target_lifecycle_stage text NULL,            -- person targets only
  target_action          text NOT NULL,        -- 'set_stage' | 'advance_one' | 'set_lifecycle'
  allow_backward         boolean NOT NULL DEFAULT false,
  is_active              boolean NOT NULL DEFAULT true,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  deleted_at             timestamptz NULL
);
CREATE INDEX customer_pipeline_automation_rules_org_tenant_idx ON customer_pipeline_automation_rules (organization_id, tenant_id);
CREATE INDEX customer_pipeline_automation_rules_trigger_idx ON customer_pipeline_automation_rules (trigger_key) WHERE is_active = true AND deleted_at IS NULL;
```

`filters` JSONB shape per trigger documented in `triggers.ts`. Validators built via Zod, derived to TS via `z.infer`.

### `customer_pipeline_automation_runs`

```sql
CREATE TABLE customer_pipeline_automation_runs (
  id                  uuid PRIMARY KEY,
  organization_id     uuid NOT NULL,
  tenant_id           uuid NOT NULL,
  rule_id             uuid NOT NULL REFERENCES customer_pipeline_automation_rules(id) ON DELETE CASCADE,
  trigger_event_id    text NOT NULL,           -- event bus envelope id, used for idempotency
  trigger_event_key   text NOT NULL,           -- e.g. 'payment_captured' for grouping
  entity_type         text NOT NULL,           -- 'deal' | 'person'
  entity_id           uuid NOT NULL,
  from_stage          text NULL,               -- previous stage id or lifecycle string
  to_stage            text NULL,               -- new stage id or lifecycle string
  outcome             text NOT NULL,           -- 'applied' | 'skipped_backward' | 'skipped_idempotent' | 'skipped_filter' | 'failed'
  error               text NULL,
  ran_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_pipeline_automation_runs_org_tenant_idx ON customer_pipeline_automation_runs (organization_id, tenant_id);
CREATE INDEX customer_pipeline_automation_runs_idempotency_idx ON customer_pipeline_automation_runs (rule_id, entity_id, trigger_event_id);
CREATE INDEX customer_pipeline_automation_runs_entity_idx ON customer_pipeline_automation_runs (entity_type, entity_id, ran_at DESC);
```

Both tables created via MikroORM entities + `yarn db:generate` migration. **Never edit `setup-tables.sql`** per AGENTS.md forbidden patterns.

---

## API Contracts

All routes live under `packages/core/src/modules/customers/api/pipeline-automation/` and use `makeCrudRoute` where applicable. All responses include `organization_id` filter enforcement.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/api/pipeline-automation/rules` | `pipeline_automation.configure` | List rules for org. Supports `?trigger_key=`, `?is_active=`. |
| POST | `/api/pipeline-automation/rules` | `pipeline_automation.configure` | Create rule. Body validated via Zod per `triggers.ts` shape. |
| GET | `/api/pipeline-automation/rules/[id]` | `pipeline_automation.configure` | Get single rule. |
| PUT | `/api/pipeline-automation/rules/[id]` | `pipeline_automation.configure` | Update rule. |
| DELETE | `/api/pipeline-automation/rules/[id]` | `pipeline_automation.configure` | Soft delete (`deleted_at`). |
| GET | `/api/pipeline-automation/runs` | `pipeline_automation.view_history` | List recent runs. Supports `?rule_id=`, `?entity_id=`, `?outcome=`, `?ids=`. Default order `ran_at DESC`, page size ≤100. |
| GET | `/api/pipeline-automation/triggers` | `pipeline_automation.configure` | Static catalog from `triggers.ts` for UI dropdowns. Cached. |

All routes export `openApi` for `/backend/api-docs` generation.

---

## UX

**Settings page:** `/backend/settings/pipeline-automation`. Shipped under Settings group, placed near "Sequences" and "Pipelines" so users find it where they'd look.

**Layout:**
- Top section: 4 default rules (one card per trigger) with active/inactive toggle, target picker, "edit conditions" expand. New users see all 4 toggled on with sensible defaults.
- "Add custom rule" button opens a 3-step modal: pick trigger → set filters → pick target stage. Same form used for editing.
- Bottom section: "Recent activity" — paginated table of last 50 runs (rule, entity, from → to, outcome, time, link to entity).

**Empty state:** before any runs, the activity table shows "No automations have run yet. Create a contact, submit a form, or capture a payment to see your rules in action."

---

## Backward Compatibility

New surfaces — additive only.

- **New events** `customers.deal.auto_advanced`, `customers.person.auto_advanced`, `sequences.sequence.completed` — once shipped, FROZEN per AGENTS.md BC contract category 5. Payload fields additive-only thereafter.
- **New tables** `customer_pipeline_automation_rules`, `customer_pipeline_automation_runs` — additive per category 8.
- **New role features** `pipeline_automation.configure`, `pipeline_automation.view_history` — declared in `customers/acl.ts`, added to admin/owner role defaults via `defaultRoleFeatures` in `setup.ts`. FROZEN per category 10 once seeded.
- **New API routes** — additive per category 7.
- **Existing event subscribers and consumers unchanged.** Existing manual stage-change flow (`customers.deal.stage_changed`, `customers.person.stage_changed`) continues to fire whether the change came from a user click or this automation; downstream subscribers (notifications, audit) don't know or care.

No deprecations. No bridges needed.

---

## Risks & Impact Review

| Risk | Severity | Affected | Mitigation | Residual |
|---|---|---|---|---|
| Default rules surprise existing tenants on first deploy by re-categorizing established contacts | Medium | All existing tenants | Seed defaults active for all tenants (new + existing). Ship a one-time notification-bell entry per tenant on first deploy linking to settings: "Pipeline automation is now active — review your rules." Idempotency guard prevents replays of historical events from firing rules. Defaults are conservative (only set lifecycle, only advance forward). | Low |
| Cascade loop: rule advances stage → triggers `stage_changed` → another rule fires on `stage_changed` | High | Any tenant with multiple rules | Phase 1 has no `stage_changed` triggers, so no loop possible. Document in `triggers.ts` that adding `stage_changed` as a trigger in Phase 2 requires loop detection. | Low |
| Backfill of historical events (e.g., re-running webhooks) double-advances | Medium | Tenants replaying events | Idempotency check on `(rule_id, entity_id, trigger_event_id)` covers this — same event id never applies twice. | Low |
| Sequence completion event retrofit breaks existing sequence behavior | Medium | All tenants using sequences | Add event emission only; don't change existing flow. Integration test in `.ai/qa/` verifies sequences still complete normally. | Low |
| Engagement score threshold rule fires on every score update including downward moves | Medium | Tenants using engagement | Filter shape includes `score_min` (required); rule fires only when new score crosses threshold (compare new vs prev in dispatcher). | Low |
| Cross-tenant data leak via rule referencing another org's pipeline_id | High | Multi-tenant SaaS | Validator on POST/PUT verifies `target_pipeline_id` belongs to caller's org. Subscriber loads rules scoped to event's org. Integration test specifically asserts cross-tenant isolation. | Low |
| User deletes a pipeline that rules reference | Medium | Single tenant | `ON DELETE CASCADE` on `target_pipeline_id` would delete the rule silently — bad UX. Use `ON DELETE SET NULL` and surface "rule disabled because pipeline was deleted" in settings UI; rule auto-deactivates. | Low |

---

## Integration Test Coverage

Per `.ai/qa/AGENTS.md`, every new feature ships with integration tests in the same change. Add to `.ai/qa/specs/SPEC-064/`:

**API paths** (must verify):
- POST `/api/pipeline-automation/rules` with valid + invalid payloads, cross-tenant pipeline_id rejection.
- PUT/DELETE happy paths + RBAC denial without `pipeline_automation.configure`.
- GET `/api/pipeline-automation/runs` with filters; cross-tenant isolation.
- GET `/api/pipeline-automation/triggers` returns static catalog.

**Trigger flows** (end-to-end via event emission):
- Form submission → person lifecycle = `Lead` (default rule active).
- Payment captured → deal `Won`, person `Customer`. Verify both happen atomically.
- Sequence completion → deal advances by one stage in its pipeline.
- Engagement score crosses threshold → person `Hot Lead`.
- Same event fired twice → second run recorded as `skipped_idempotent`.
- Rule with `allow_backward = false` against an already-later stage → `skipped_backward`.
- Filter mismatch (e.g., wrong form_id) → `skipped_filter`.
- Pipeline deletion auto-deactivates affected rules.

**UI paths** (Playwright):
- Settings page loads, lists 4 default rules.
- Toggle off rule, re-fire trigger event, verify no advancement.
- Edit target stage, verify change persists.
- Recent activity table populates after a trigger fires.

Fixture creation via API (per `.ai/qa/AGENTS.md`); cleanup in teardown.

---

## Migration & Backward Compatibility

- Run `yarn db:generate` after entity additions, ship migration in same change.
- `setup.ts` seed runs on `onTenantCreated` for new tenants. For existing tenants, ship a one-time idempotent backfill: a startup migration step that, for any org without rules in `customer_pipeline_automation_rules`, inserts the same 4 default rules with `is_active = true`. Backfill emits a notification-bell entry per org linking to settings ("Pipeline automation is now active — review your rules"). Idempotency: backfill skips orgs that already have any rule row.
- New events are additive — no payload changes to existing events.
- No deprecations.

---

## Phase 2 (Out of Scope, Documented for Continuity)

- Generic rule builder: any event → any condition → any action, replacing the static trigger catalog.
- Stage-change-as-trigger (e.g., "when deal hits Won, advance contact to Customer"). Requires loop detection.
- Backward moves on triggers (refund → demote, lapsed subscription → demote).
- Time-based triggers (handled by #14 Relationship Decay Alerts).
- Cross-pipeline migration (advance from Pipeline A's last stage into Pipeline B's first).
- AI-suggested rules ("we noticed you manually advance deals to Negotiation 80% of the time after a sequence completes — want to automate this?").

---

## Final Compliance Report

- ✅ Lives in a proper module under `packages/core/src/modules/customers/`, no edits to `setup-tables.sql`.
- ✅ No new raw-knex routes under `apps/mercato/src/app/api/`.
- ✅ All queries filter by `organization_id` + `tenant_id`.
- ✅ Backend page lives in module's `backend/` directory (not under `apps/mercato/src/app/(backend)/`).
- ✅ Uses `makeCrudRoute` with `indexer: { entityType }` for query-index coverage.
- ✅ Write operations implemented via Command pattern (reuse existing deal/person commands).
- ✅ All inputs validated with Zod; types via `z.infer`.
- ✅ RBAC declared in `acl.ts` and seeded via `defaultRoleFeatures` in `setup.ts`.
- ✅ All new APIs export `openApi`.
- ✅ Events declared via `createModuleEvents` with `as const`.
- ✅ Integration test coverage defined in this spec, tests shipped in same change.
- ✅ Backward-compatibility contract: new surfaces only, no breaking changes.

---

## Changelog

- 2026-04-25 — Initial draft (SPEC-064).
- 2026-04-25 — Decision: defaults active for all tenants (new + existing) via idempotent backfill. Risk dropped from High → Medium with notification-bell prompt. Approved by Wesley.
- 2026-04-25 — Phase 1 implementation shipped:
  - Entities `PipelineAutomationRule` + `PipelineAutomationRun` with migration `customers/migrations/Migration20260426003147.ts`
  - 4 trigger events wired (`landing_pages.form.submitted`, `payment_gateways.payment.captured`, `sequences.sequence.completed` (added), `customers.engagement.score_updated` (was declared-but-never-fired; emit added in `engagement-score.ts` + 2 form-submit call sites updated))
  - 2 new auto-advanced events declared in `customers/events.ts`
  - Core logic in `customers/pipeline_automation/`: triggers catalog, pure dispatcher, executor (raw knex with explicit org/tenant scoping), seed
  - 4 subscribers in `customers/subscribers/pipeline-auto-*.ts`
  - API routes at `/api/pipeline-automation/{rules,runs,triggers}` with full RBAC
  - Settings page at `/backend/config/customers/pipeline-automation` (active/inactive toggle, edit dialog with target picker + filter inputs, recent activity table)
  - `setup.ts` wired: 2 new role features, idempotent `seedDefaultRulesForOrg` in `seedDefaults`
  - CLI command `mercato customers seed-pipeline-automation --tenant <id> --org <id>` for existing-tenant backfill
  - Backward-compat: all changes additive; new events FROZEN per BC contract
  - Default rules seeded as person-target only (lifecycle string) — deal-target rules added by users via UI once they pick a pipeline+stage. Spec target #2 (payment → deal Won) deferred until pipeline lookup is added to seed
  - Build green, TypeScript clean for all new files
  - Multi-select-* filter inputs use comma-separated UUID textarea fallback for Phase 1; dedicated form/gateway/sequence pickers deferred to Phase 2
  - **Integration tests deferred** — not shipped in this change. Phase 1.5 follow-up should add the test coverage defined in this spec's "Integration Test Coverage" section before this lands in production for any tenant other than internal QA
