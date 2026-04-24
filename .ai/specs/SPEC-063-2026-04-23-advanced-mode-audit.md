# SPEC-063: Advanced Mode Audit — turn the framework firehose into a power-user experience

**Status:** Draft — awaiting approval on Phase 1 hide-list before execution
**Owner:** Wesley Hansen
**Created:** 2026-04-23
**Driver:** Advanced mode currently shows ~70 pages from the Open Mercato framework on top of the curated CRM surface. Most are useful to power users, but a dozen are ops-only / confusing / duplicative and make the sidebar feel like a framework admin console instead of a CRM.

## Problem

Simple mode is curated (~15 pages, hand-picked in `filterForSimpleMode`). Advanced mode is "everything the modules register" minus a 4-path hardcoded filter (`dictionaries`, `currencies`, `query-indexes`, `config/attachments`). That filter is too narrow — it misses a dozen ops-only pages that leak through. Result: power users see the CRM commingled with Redis cache inspectors, workflow task queues, and enterprise concurrency tools they'll never touch.

We also have no way for an individual user in advanced mode to hide sections they don't use. Simple mode has a `crm_hidden_sidebar` cookie mechanism; advanced mode ignores it.

## Goals

- **Cut the framework noise** from advanced-mode sidebar by expanding the hide-list.
- **Verify every remaining advanced-mode page loads and renders usefully** — flag broken ones.
- **Let users in advanced mode customize their sidebar** (extend the existing per-user hide mechanism).
- **Don't break simple mode or any existing curated page.**

## Non-goals

- Don't add new pages. This is cleanup, not feature work.
- Don't redesign the sidebar UX. Keep the existing group + item structure.
- Don't touch simple mode.
- Don't delete any page source files — we hide from nav, not rm -rf. Code stays in case we want to expose it again.

## Current state (verified 2026-04-23)

**Enabled modules** (from `apps/mercato/src/modules.ts`):
`auth, directory, staff, configs, dictionaries, currencies, entities, query_index, audit_logs, attachments, feature_toggles, api_keys, api_docs, search, events, scheduler, progress, planner, customers, webhooks, dashboards, notifications, messages, workflows, customer_accounts, portal, onboarding, payment_gateways, gateway_stripe, landing_pages, email, payments, calendar, courses, integrations_api, billing, sequences, forms, ai_assistant, record_locks, system_status_overlays`

**NOT enabled** (pages don't appear in sidebar regardless): `business_rules`, `catalog`, `sales`, `resources`, `inbox_ops`, `integrations`, `data_sync`, `sso`, `translations`. No action needed on these.

**Current filter** in `apps/mercato/src/app/(backend)/backend/layout.tsx:352`:
```ts
const irrelevantPaths = ['/backend/dictionaries', '/backend/currencies', '/backend/query-indexes', '/backend/config/attachments']
```

## Decisions (propose and lock before executing)

### 1. Hide list (Phase 1 expansion)

**Bucket A — ops-only infrastructure, hide unconditionally:**

| Path | Module | What it is | Why hide |
|---|---|---|---|
| `/backend/config/cache` | configs | Redis cache inspector | Ops tool; still reachable via platform Admin Panel |
| `/backend/config/system-status` | configs | Health dashboard | Ops tool; super-admin sees it in Admin Panel |
| `/backend/settings/record-locks` | enterprise | Concurrency lock viewer | Typically empty; ops-level |
| `/backend/storage/attachments` | attachments | Raw file browser | Internal tool |
| `/backend/planner/availability-rulesets` | planner | Internal availability config | Used indirectly by staff scheduling; not a top-level nav item |
| `/backend/customer_accounts/roles` | customer_accounts | Customer portal RBAC | Super niche; keep the `customer_accounts` parent page for portal admin |

**Bucket B — confusing / duplicate naming, hide by default:**

| Path | Module | Why hide |
|---|---|---|
| `/backend/events` | workflows | "Events" collides with webhook events; workflow event log is technical |
| `/backend/instances` | workflows | Workflow instance viewer; technical |
| `/backend/tasks` | workflows | Name collides with customer tasks (`customers.tasks`); engine-level, not user-facing |
| `/backend/definitions` | workflows | Workflow visual-editor; Automations v2 covers user-level automation |
| `/backend/messages` | messages | Internal staff messaging; duplicates conversation UX |

**Rationale for B:** These are legit framework features, but for a CRM user in advanced mode they duplicate or confuse existing CRM concepts. Keep the source, hide the nav. Users who want them can un-hide via Phase 3.

**Bucket C — keep, explicitly don't hide:**

Audit logs, API keys, API docs, Webhooks, Users, Roles, Profile, Staff, Custom fields designer (entities), Directory (multi-org), Notifications config, AI assistant config, Customer accounts (portal admin, parent page only), Customer pipelines config.

### 2. Phase 2 live-audit criteria

A page "passes" if:
- Loads in under 3 seconds without a 500
- Renders its primary UI (not an empty shell, not a client-side JS error)
- Core action on the page works (can create/edit one record)

Failed pages → logged to the SPEC changelog, fixed in Phase 2b if trivial, or added to a follow-up build-queue item if non-trivial.

### 3. Phase 3 user-facing customize sidebar

- Extend `crm_hidden_sidebar` cookie logic to apply in advanced mode (currently simple-only).
- Add a small gear icon next to each sidebar group header → "Hide this section".
- Add a Settings page: `/backend/settings/sidebar` → checkbox list of every item, toggle visibility, "Reset to defaults" button.
- Storage: same cookie-based mechanism for consistency; optionally persist to `user_preferences` (JSONB column on `users`) so it survives cookie clearing. User-pref storage is follow-up if needed.

### 4. Risks

- **Users have bookmarks to hidden paths.** Bucket A/B pages still render when you URL-visit them; we only hide from nav. Zero blast radius.
- **Workflows power users lose easy access.** `/backend/definitions`/`/instances`/`/tasks`/`/events` are gone from nav. Mitigation: Phase 3 gives them a toggle. Also — document in release notes that these paths still work by direct URL.
- **Confusion from removing `/backend/messages`.** Staff messaging is a niche feature; if anyone relies on it, they'll notice. Mitigation: keep the module enabled, just hide from nav.

## Phased plan

### Phase 1 — Expand the hide-list *(15 min, zero user-visible risk)*

1. Edit `apps/mercato/src/app/(backend)/backend/layout.tsx` — extend `irrelevantPaths` from 4 to ~15 entries covering Buckets A + B.
2. Commit + deploy.
3. Smoke-test: log in to advanced mode, confirm Bucket A + B pages are gone from nav, confirm Bucket C pages still appear.

**Deliverable:** Leaner advanced-mode sidebar in prod.

### Phase 2 — Click-through live audit *(45 min)*

For each remaining advanced-mode page, visit it and record pass/fail against the criteria above. Output a table in the SPEC changelog:

| Path | Status | Notes |
|---|---|---|

Flag broken pages. Fix trivial ones (missing RBAC, missing DB column) in Phase 2b.

**Deliverable:** Status report; broken-page list becomes a build-queue sub-item.

### Phase 3 — User-controlled sidebar customization *(~1 session)*

- Extend simple-mode hide-cookie logic to advanced mode.
- Add per-group "Hide" icon + Settings page.
- Tests: hide a section, reload, verify it stays hidden; reset, verify it returns.

**Deliverable:** Any advanced-mode user can tailor their nav without code changes.

### Phase 4 — Optional polish *(defer unless needed)*

- Persist to DB (`user_preferences`) instead of cookie.
- Drag-to-reorder groups.
- Saved "layouts" (e.g., "Sales user", "Marketing user", "Operator") with one-click switch.

## Integration test coverage

- `TC-ADVANCED-001`: advanced mode shows Bucket C paths in sidebar
- `TC-ADVANCED-002`: advanced mode does NOT show Bucket A + B paths in sidebar
- `TC-ADVANCED-003`: simple mode unaffected (existing simple-mode test still passes)
- `TC-ADVANCED-004` (Phase 3): hide a section → cookie set → nav reflects it → reset returns default

## Backward compatibility

- URL stays valid for every hidden path — direct navigation / bookmarks / deep-link from emails still work.
- Simple mode filter unchanged.
- No DB schema changes in Phase 1 or 2. Phase 3 optional user_preferences column is additive.
- No event IDs / API URLs renamed.

## Migration

None required. Deploy is strictly additive to the filter list.

## Out of scope

- Redesigning any specific advanced-mode page (e.g., workflows visual editor UX improvements).
- Moving pages between modules.
- Rewriting inherited framework pages.
- Pruning unused modules from `modules.ts` (separate audit — touches migrations and setup).

---

## Changelog

- **2026-04-23** — Initial draft. Phase 1 hide-list proposed. Awaiting approval.
