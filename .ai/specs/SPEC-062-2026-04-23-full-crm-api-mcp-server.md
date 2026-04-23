# SPEC-062: Full CRM API + MCP Server (open the platform to third-party agents)

**Status:** Draft
**Owner:** Wesley Hansen
**Created:** 2026-04-23
**Driver:** Unblock LaunchBot + third-party AI agent integrations, provide a stable public REST API and MCP endpoint, land the hardening (rate limits, scoped keys) needed before we expose those surfaces to the internet.

## Problem

A comprehensive REST API and MCP server already exist internally but aren't safe or usable for third-party integration:

- **Webhooks don't fire.** Every module declares typed events (`customers.person.created`, `customers.deal.won`, `forms.submission.created`, etc.) and we have a fully-built `dispatchWebhook` function with HMAC signing, retries, and delivery logging — but **nothing connects events to dispatch**. Users can't subscribe to anything.
- **No rate limiting on API routes.** `rateLimiterService` exists but is only wired into 2 specialized endpoints (inbox webhook inbound, customer signup). A misbehaving or malicious API key can drive unbounded DB load.
- **MCP server is internal-only.** Runs on `:3001` inside the container. Third-party agents (Claude Desktop, OpenCode, LaunchBot) can't reach it from the public internet.
- **API keys are RBAC-only, not scoped.** A key either has a role's full permissions or it doesn't. "Read-only analytics key", "Invoice-send-only key", "Form-submission-only webhook key" aren't expressible today.

These gaps block three concrete product initiatives:
1. **LaunchBot CRM skill** — needs public MCP + narrow scopes so users trust a bot with a key.
2. **Zapier/n8n integrations** — need webhook subscriptions + rate-limited REST.
3. **Customer-facing public API** — need scoped keys + documented rate limits before we publish the API.

## Goals

- **Ship webhook subscriptions end-to-end** — user can register a webhook URL, pick events, and reliably receive signed POSTs when those events fire. Delivery log UI so users can see retries/failures.
- **Ship rate limiting on all API-key-authenticated routes** — transparent headers, sensible default tier, per-key override.
- **Expose MCP over public HTTPS** at a stable subdomain or path with API-key auth + CORS.
- **Ship scoped API keys** — granular per-resource/per-operation permissions on top of existing RBAC.
- **No regressions** on existing 40+ CRUD routes, existing API keys, the MCP server, or the 415 already-registered tools.

## Non-goals

- Don't rewrite the CRUD factory or MCP server.
- Don't add new entity types or REST routes (the 40+ existing endpoints + 405 dynamically-discovered MCP tools are sufficient for v1).
- Don't build SDK packages (raw HTTP is enough for launch; SDKs come after the API stabilizes).
- Don't build a public developer portal UI (the existing `api_docs` module serves the OpenAPI spec; that's good enough for v1).

## Audit summary — what exists today

| Area | State | Files |
|---|---|---|
| API key auth | ✅ bcrypt-hashed, tenant/org-scoped, role-scoped, session tokens | `packages/core/src/modules/api_keys/services/apiKeyService.ts` |
| CRUD coverage | ✅ 40+ routes across customers, sales, catalog, email, forms, landing pages, courses | `packages/core/src/modules/*/api/`, `apps/mercato/src/modules/*/api/` |
| OpenAPI | ✅ 314 routes export `openApi`, aggregated in `api_docs` module | `packages/core/src/modules/api_docs/` |
| MCP server | ✅ stdio + HTTP wrapper on :3001, 10 hand-written + 405 dynamic tools | `packages/ai-assistant/src/modules/ai_assistant/lib/mcp-server.ts`, `http-server.ts` |
| Webhook dispatch | ✅ HMAC, 3 retries, delivery log | `apps/mercato/src/modules/customers/api/webhooks/dispatch.ts` |
| Webhook subscriptions table | ✅ exists | `webhook_subscriptions`, `webhook_deliveries` |
| Webhook event fan-out | ❌ **no subscribers wire events to dispatch** | — |
| Rate-limit service | ✅ memory + Redis backends | `packages/shared/src/lib/ratelimit/service.ts` |
| Rate-limit middleware for CRUD | ❌ **not wrapped around routes** | — |
| Public MCP HTTPS endpoint | ❌ **internal only** | — |
| API key scopes (beyond RBAC) | ❌ **not implemented** | — |

The project is a wiring exercise, not a greenfield build.

---

## Phase 1 — Webhook event fan-out (detailed)

**Goal:** Users can subscribe a URL to any of a curated set of domain events. When the event fires, we POST an HMAC-signed payload to the URL with retries and a delivery log. Works for all modules that declare events.

### 1.1 Data model

`webhook_subscriptions` table (confirm existing shape; add columns if needed):

```
id                uuid PK
tenant_id         uuid NOT NULL
organization_id   uuid NOT NULL
name              text NOT NULL                  -- user-friendly label
url               text NOT NULL                  -- target URL
events            jsonb NOT NULL                 -- array of event IDs ['customers.person.created', ...]
secret            text NOT NULL                  -- HMAC-SHA256 shared secret (stored plaintext; revoke by regenerating)
is_active         boolean NOT NULL DEFAULT true
headers           jsonb                          -- optional extra headers to send
description       text
created_at        timestamptz NOT NULL DEFAULT now()
updated_at        timestamptz NOT NULL DEFAULT now()
deleted_at        timestamptz
```

`webhook_deliveries` (existing):

```
id                uuid PK
subscription_id   uuid NOT NULL FK
event_id          text NOT NULL
payload           jsonb NOT NULL
response_status   int
response_body     text                           -- truncated to 4KB
attempt           int NOT NULL DEFAULT 1
delivered_at      timestamptz
error             text
created_at        timestamptz NOT NULL DEFAULT now()
```

If columns are missing, add via a MikroORM entity + migration. Do NOT hand-edit `setup-tables.sql`.

### 1.2 Event payload contract

Every webhook POST sends:

```json
{
  "id": "<delivery uuid>",
  "event": "customers.person.created",
  "occurredAt": "2026-04-23T12:34:56.789Z",
  "organizationId": "<uuid>",
  "tenantId": "<uuid>",
  "data": { ... event-specific payload ... }
}
```

Headers:

```
Content-Type: application/json
User-Agent: LaunchCRM-Webhooks/1
X-Webhook-Event: customers.person.created
X-Webhook-Delivery: <delivery uuid>
X-Webhook-Signature: sha256=<hex HMAC of raw body using subscription.secret>
```

Receivers verify by recomputing the HMAC over the raw body with their shared secret.

### 1.3 Events included in v1

Start with the high-value event set for automation:

| Event ID | `data` shape |
|---|---|
| `customers.person.created` | `{ id, displayName, primaryEmail, primaryPhone, source }` |
| `customers.person.updated` | `{ id, changedFields: [...] }` |
| `customers.deal.created` | `{ id, title, valueAmount, valueCurrency, pipelineStage }` |
| `customers.deal.stage_changed` | `{ id, previousStage, newStage, title }` |
| `customers.deal.won` | `{ id, title, valueAmount, valueCurrency }` |
| `customers.deal.lost` | `{ id, title, reason? }` |
| `customers.task.created` | `{ id, title, contactId?, dueDate? }` |
| `customers.task.completed` | `{ id, title }` |
| `forms.submission.created` | `{ submissionId, formId, formSlug, contactId?, data }` |
| `calendar.booking.created` | `{ bookingId, bookingPageSlug, guestEmail, guestName, startTime, endTime }` |
| `courses.enrollment.created` | `{ enrollmentId, courseId, courseTitle, studentEmail, studentName }` |
| `sales.invoice.created` | `{ invoiceId, invoiceNumber, totalAmount, currency, contactId? }` |
| `sales.invoice.paid` | `{ invoiceId, invoiceNumber, totalAmount, currency, paidAt }` |

Additional events can be added later by adding the event ID to the module's `events.ts` (or using an existing declared event) and registering a webhook subscriber for it.

### 1.4 Generic webhook subscriber pattern

Create a shared subscriber `packages/core/src/modules/webhooks/subscribers/dispatch-webhook-event.ts` that:

1. Listens to a curated event allow-list (defined in `webhooks/events-registry.ts`).
2. On event fire, queries `webhook_subscriptions` where `events @> '[<eventId>]'` and `is_active = true` and the subscription's `organization_id` matches.
3. For each match, inserts a `webhook_deliveries` row and calls `dispatchWebhook(...)`.
4. `dispatchWebhook` handles HMAC, retries, and log updates (existing function, move out of `customers/api/webhooks/dispatch.ts` into the new `webhooks` module as `lib/dispatch.ts`; re-export from old path for BC).

Subscriber metadata:

```ts
export const metadata = {
  event: '*',                 // special wildcard — handled by the event bus to invoke this for any declared event
  persistent: true,
  id: 'webhooks:dispatch-webhook-event',
}
```

If the event bus doesn't support `event: '*'`, register one subscriber per event ID in the allow-list (generated at module-load time from `events-registry.ts`). That's acceptable boilerplate for v1.

### 1.5 Subscription CRUD API

New route `packages/core/src/modules/webhooks/api/subscriptions/route.ts` using `makeCrudRoute`:

- `GET /api/webhooks/subscriptions` — list org's subs
- `POST /api/webhooks/subscriptions` — create (auto-generates a secret)
- `PUT /api/webhooks/subscriptions` — update name/url/events/is_active
- `DELETE /api/webhooks/subscriptions` — soft delete
- `POST /api/webhooks/subscriptions/:id/rotate-secret` — generate new secret
- `POST /api/webhooks/subscriptions/:id/test` — send a test `webhooks.test` event to the URL

Guards: `requireAuth`, `requireFeatures: ['webhooks.manage']`.

OpenAPI export wired via `buildModuleCrudOpenApi` (standard pattern).

### 1.6 Delivery log API + UI

- `GET /api/webhooks/deliveries?subscriptionId=<id>&status=failed&page=1` — paginated list
- `POST /api/webhooks/deliveries/:id/retry` — re-enqueue a delivery

Backend page at `/backend/settings/webhooks` (lives in the webhooks module):
- List subscriptions with status badges (active/paused/erroring)
- Create/edit form (URL, events multi-select, secret reveal, test button)
- Delivery log panel with filter by status + retry action

### 1.7 Default role ACL

In `webhooks/setup.ts` `defaultRoleFeatures`:
- `superadmin: ['webhooks.*']`
- `admin: ['webhooks.*']`
- `employee: ['webhooks.view']` (can see delivery logs but not edit subscriptions)

### 1.8 Migration & BC

- New module → new entities → `yarn db:generate` → migration is purely additive.
- `customers/api/webhooks/dispatch.ts` re-exports from `webhooks/lib/dispatch.ts` for 1 minor version with `@deprecated` JSDoc.
- Existing `webhook_subscriptions` / `webhook_deliveries` tables (if present from earlier work) get adopted by the new ORM entity — verify byte-for-byte schema match per the SPEC-061 recipe. If the generator produces a non-empty migration, the entity is wrong.

### 1.9 Tests (integration)

Under `packages/core/src/modules/webhooks/__integration__/`:

1. `TC-WEBHOOKS-001-subscribe-and-receive.spec.ts` — create subscription, trigger `customers.person.created`, assert POST received with correct signature.
2. `TC-WEBHOOKS-002-retry-on-5xx.spec.ts` — subscriber URL returns 500 twice then 200, assert 3 delivery rows with incrementing `attempt`.
3. `TC-WEBHOOKS-003-secret-rotation.spec.ts` — rotate secret, assert old signature no longer validates.
4. `TC-WEBHOOKS-004-rbac.spec.ts` — employee cannot create subscription; admin can.
5. `TC-WEBHOOKS-005-tenant-isolation.spec.ts` — org A's subscription never receives org B's events.

All tests use a test HTTP server bound to a random port to receive the webhooks.

### 1.10 Deployment

- Standard deploy. Migration is additive.
- After deploy, smoke-test with a webhook.site URL for one of the 13 events.

---

## Phase 2 — Rate limiting on API routes (outline)

**Goal:** Every API-key-authenticated request passes through `rateLimiterService`. 429 with `Retry-After` when exceeded. Configurable per-key tier.

**Approach:**
- Add middleware in the route dispatcher (or a wrapper around `makeCrudRoute`) that reads `apiKey.id` from `ctx.auth`, calls `rateLimiterService.consume(apiKey.id, config)`, and either proceeds or returns 429 with the appropriate headers.
- Add `rate_limit_tier` column to `api_keys` (enum: `default`, `pro`, `unlimited`). Tier → config map in `api_keys/lib/rateLimitTiers.ts`.
- Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.
- Bypass for cookie-authenticated (UI) requests — the limits target programmatic clients.
- Default tier: 60 requests/minute, 1000/hour. Pro: 300/min, 10000/hour. Unlimited: no check.

**Known unknowns:**
- Does the rate-limit service need to be tenant-scoped or is per-key sufficient? (Start with per-key.)
- Redis vs memory in prod — prod has Redis configured? (Verify before deploy.)

**Tests:** Hit a CRUD endpoint 65× in a minute with a default-tier key, assert the 61st+ return 429 with `Retry-After`.

---

## Phase 3 — External MCP HTTPS endpoint (outline)

**Goal:** Third-party AI agents can connect to `https://mcp.launchcrm.com` (or `https://launchcrm.com/mcp`) with an API key and use all 415 MCP tools.

**Approach:**
- Reverse proxy rule in whatever fronts prod today (nginx / Caddy / Vercel / Cloudflare). Path: `/mcp/*` → container `:3001`.
- TLS via Let's Encrypt (already handled by the prod proxy).
- Enforce `x-api-key` header on the proxy path (reject if missing before it hits the MCP server).
- CORS: allow `https://claude.ai`, `https://opencode.ai`, `*` for initial public launch with the expectation that the API key is the real auth boundary.
- Connection doc: one-page markdown in `apps/docs` showing Claude Desktop config snippet + raw HTTP example.

**Known unknowns:**
- Prod proxy — nginx config file location on the Hetzner box? (From memory: SSH to 5.78.71.144, check `/etc/nginx/sites-available/` or the docker-compose proxy service.)
- Does MCP stdio-over-HTTP use SSE? If so, the proxy needs SSE-friendly buffering disabled.

**Tests:** curl the public URL with a valid key, expect the MCP handshake response. With an invalid key, expect 401 before reaching the MCP server.

---

## Phase 4 — API key scopes (outline)

**Goal:** A key can be narrowed to specific resources + operations beyond its role's permissions. "Invoice-reminder-bot" key gets `sales.invoices.send` and nothing else.

**Approach:**
- Add `scopes text[]` column on `api_keys`. Null/empty = "use role permissions as-is" (full BC).
- Scope format: `<module>.<entity>.<operation>` (e.g. `customers.people.read`, `sales.invoices.send`, `webhooks.*`).
- Middleware: when a key has non-empty `scopes`, the CRUD factory checks the scope against the route's declared feature on every call. Scope check runs in addition to the role-based feature check (intersection, not replacement) — so you can't escalate beyond your role.
- UI: key-create form gets a scope selector (tree view of modules/entities/operations).
- Backward compat: existing keys have `scopes = NULL` → behaves exactly as today.

**Known unknowns:**
- Scope-to-feature mapping: most routes already guard with `requireFeatures: ['<module>.<action>']`. Scope check can piggyback on that by comparing the scope array against the required features. Worth prototyping early.
- Do we need wildcard scopes (`customers.*`)? Probably yes for usability.

**Tests:** Create a key scoped to `customers.people.read`, hit `GET /api/customers/people` (200), hit `POST /api/customers/people` (403), hit `GET /api/customers/deals` (403).

---

## Optional polish (cherry-pick after Phase 4)

- **Public OpenAPI viewer** at `/api/docs` (Swagger UI or Redoc). The `api_docs` module already aggregates the spec; this is a 1-hour UI add.
- **Affiliates REST route** — currently only accessed via the affiliates backend page; no public CRUD. Add a module route for completeness.
- **Webhook DLQ** — after N retries, mark delivery `dead_lettered` and surface in the delivery log filter.
- **MCP tool usage metrics** — per-tool call counts per API key, to inform scope UX and pricing tiers.

---

## Risks

| Risk | Mitigation |
|---|---|
| Webhook subscribers cause event bus slowdown | Subscribers are `persistent: true` → go to the persistent queue → don't block event emission. Worker processes them async. |
| Rate limits break the CRM's own UI | UI uses cookie auth; middleware bypasses cookie-authenticated requests. Only API-key requests are rate-limited. |
| Public MCP exposes all 415 tools to anyone with a valid key | API keys are RBAC-scoped. Phase 4 adds per-key scopes on top. Initial launch = existing RBAC boundary, same as today's authenticated frontend. |
| Event allow-list becomes stale | `webhooks/events-registry.ts` is the single source of truth. Adding an event = 1 line change + test. |

## Migration & Backward Compatibility

- All new tables/columns are additive.
- No existing routes change URL, input schema, or response schema.
- Existing API keys work unchanged until Phase 4, where `scopes=NULL` preserves today's behavior.
- `customers/api/webhooks/dispatch.ts` re-exports from the new location during a 1-minor-version window with `@deprecated` JSDoc.
- No event IDs rename.
- No breaking changes to the MCP tool protocol.

## Integration test coverage

- **Phase 1:** 5 webhook specs (listed above)
- **Phase 2:** 2 specs — rate limit enforcement + cookie-auth bypass
- **Phase 3:** 2 specs — public endpoint auth gate + tool listing over HTTPS
- **Phase 4:** 3 specs — scoped key allow/deny + NULL scope preserves behavior + wildcard scope

## Out of scope (deferred)

- SDK packages (TS, Python)
- Developer portal UI
- Per-key billing / usage metering for commercial API tiers
- GraphQL layer

---

## Changelog

- **2026-04-23** — Initial draft. Phase 1 detailed, Phases 2-4 outlined. Wesley + Claude.
