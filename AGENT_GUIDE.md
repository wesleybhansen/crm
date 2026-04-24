# LaunchCRM Agent Integration Guide

**For AI agents, bots, and back-office automations that want to read or change data in a LaunchCRM tenant.**

This guide is written for the agent/integrator — not for CRM-repo contributors. If you're writing code that lives outside this repo and needs to talk to a LaunchCRM install, start here.

---

## 1. What you can do

LaunchCRM exposes three control surfaces. Most agents only need one or two.

| Surface | Transport | When to use |
|---|---|---|
| **REST API** | HTTPS + `x-api-key` | Classic backend-to-backend. You know the endpoint you want to call. |
| **MCP server** | HTTPS streamable HTTP + `x-api-key` + session token | AI agents that need to *discover* what's possible at runtime. 24 hand-curated tools + ~636 auto-discovered API endpoints exposed as tool calls. |
| **Outbound webhooks** | HTTPS POSTs from CRM → your server | Event-driven integrations. CRM pushes to you when domain events fire. |

You can mix: call REST for the fast path, subscribe to webhooks for real-time notifications, use MCP when the agent needs to decide what to call on the fly.

---

## 2. Base URL and authentication

**Production base URL:** `https://crm.thelaunchpadincubator.com`
(Self-hosted tenants: replace with whatever hostname the operator gave you.)

**Every request needs an API key.** Operators mint keys in the admin UI at `/backend/api-keys`. The key format is `omk_<prefix>_<secret>`. Pass it on every request:

```
x-api-key: omk_abc123_0123456789abcdef...
```

Or, equivalently, in the Authorization header:

```
Authorization: ApiKey omk_abc123_0123456789abcdef...
```

Treat the key like a password: store in a secret manager, never commit to git, never ship in a client-side bundle. If it leaks, rotate in the UI.

### Key scopes and tiers (ask your operator)

When you request a key, the operator picks two things that shape your key's behavior:

- **Rate-limit tier**: `default` (60 req/min, 1,000 req/hour), `pro` (300/min, 10,000/hour), or `unlimited`. A 429 response means you've hit the window. Respect the `Retry-After` header.
- **Scopes**: optional list like `["customers.people.view", "sales.invoices.send"]`. If scopes are set, the key can only call routes whose required feature matches one of the scopes. Wildcards supported: `customers.*` covers the whole customers module. No scopes = full role permissions.

If you're building a **public bot** (anyone can install it and enter an API key), tell your users to create a key with the narrowest scope that works. If you're the operator running an internal automation, an unscoped `unlimited` key is fine.

### Rate-limit headers on every response

```
RateLimit-Limit: 60
RateLimit-Remaining: 47
RateLimit-Reset: 23
RateLimit-Policy: tier=default; window=60; limit=60
```

On a 429 you additionally get `Retry-After: <seconds>`.

---

## 3. REST API quickstart

### List contacts

```bash
curl -sSk "https://crm.thelaunchpadincubator.com/api/customers/people?pageSize=10&search=jane" \
  -H "x-api-key: omk_xxx"
```

```json
{
  "items": [
    {
      "id": "uuid",
      "display_name": "Jane Doe",
      "primary_email": "jane@example.com",
      "primary_phone": "+1-555-0101",
      "source": "landing_page",
      "lifecycle_stage": "prospect",
      "created_at": "2026-04-20T18:23:44Z"
    }
  ],
  "total": 73,
  "page": 1,
  "pageSize": 10,
  "totalPages": 8
}
```

The search parameter matches name, email, or phone (decrypted in-memory when tenant encryption is on — you don't need to know anything about that).

### Create a contact

```bash
curl -sSk -X POST "https://crm.thelaunchpadincubator.com/api/customers/people" \
  -H "x-api-key: omk_xxx" \
  -H "content-type: application/json" \
  -d '{
    "firstName": "Jane",
    "lastName": "Doe",
    "displayName": "Jane Doe",
    "primaryEmail": "jane@example.com",
    "primaryPhone": "+1-555-0101",
    "source": "your_integration_name"
  }'
```

Response:
```json
{ "id": "uuid", "personId": "uuid" }
```

The `source` field gets auto-tagged so the operator can see where the contact came from in reports. Use a stable identifier for your integration (e.g., `"ams_blog_ops"`, `"zapier"`, `"launchbot"`).

### Other commonly-called endpoints

| Endpoint | What it does |
|---|---|
| `GET /api/customers/people?search=<q>` | Search people by name/email/phone |
| `POST /api/customers/people` | Create a contact |
| `PUT /api/customers/people` | Update a contact (body includes `id`) |
| `GET /api/customers/companies?search=<q>` | Search companies |
| `GET /api/customers/deals?search=<q>` | Search deals |
| `POST /api/customers/deals` | Create a deal |
| `POST /api/customers/tasks` | Create a task |
| `POST /api/customers/notes` | Add a note to a contact |
| `GET /api/contacts/:id/timeline` | Full interaction timeline for a contact |
| `POST /api/email/smtp` | Send an email through the CRM's email provider |
| `GET /api/landing_pages/pages` | List landing pages |
| `POST /api/landing_pages/pages` | Create a landing page |
| `GET /api/webhooks/events` | List every event you can subscribe to |

**Full list (636 endpoints):** the OpenAPI spec is served at `GET /api/docs/openapi` and regenerated on every deploy.

### Response envelope and pagination

Paginated list endpoints return:
```json
{ "items": [...], "total": N, "page": N, "pageSize": N, "totalPages": N }
```

Non-list endpoints typically return either the resource directly (`{ "id": ..., ... }`) or an `{ "ok": true, "data": ... }` envelope. Parse defensively.

### Error shape

```json
{ "ok": false, "error": "Rate limit exceeded", "retryAfterSeconds": 43, "limit": 60, "windowSeconds": 60 }
```

```json
{ "ok": false, "error": "This API key is not scoped for the requested action", "missingFeature": "customers.people.manage", "keyScopes": ["customers.people.view"] }
```

HTTP status codes:
- `200`/`201` — success
- `400` — validation error (bad input)
- `401` — missing/invalid API key
- `403` — key lacks the feature or scope for this route
- `404` — resource not found
- `409` — conflict (e.g., creating a resource with a duplicate unique field)
- `429` — rate limited
- `500` — server error (report with request id if in response headers)

---

## 4. MCP server quickstart

**Endpoint:** `https://crm.thelaunchpadincubator.com/mcp`
**Protocol:** MCP Streamable HTTP (JSON-RPC 2.0)
**Auth:** `x-api-key` header + `_sessionToken` in each tool-call's arguments

### Two-step session handshake

MCP needs a session token in addition to the API key. The token identifies the *user* the agent is acting on behalf of. Minting is a single HTTP call:

```bash
curl -sSk -X POST "https://crm.thelaunchpadincubator.com/api/ai_assistant/session-key" \
  -H "x-api-key: omk_xxx" \
  -H "content-type: application/json" \
  -d '{}'
```

```json
{ "sessionToken": "sess_a2b4cd75...", "expiresAt": "2026-04-24T02:41:53Z" }
```

Sessions last 2 hours. Refresh before expiry (or on 401/SESSION_EXPIRED) by minting a new one.

### Claude Desktop config

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "launchcrm": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://crm.thelaunchpadincubator.com/mcp",
        "--header",
        "x-api-key:omk_xxx"
      ]
    }
  }
}
```

Restart Claude Desktop. The agent will see the CRM's 24 tools. When it calls one, `mcp-remote` handles the streamable HTTP transport; you're responsible for session tokens only if you're writing the agent prompt yourself.

### Raw HTTP example (full agent-less test)

```bash
BASE="https://crm.thelaunchpadincubator.com"
KEY="omk_xxx"
TOKEN=$(curl -sSk -X POST "$BASE/api/ai_assistant/session-key" -H "x-api-key: $KEY" -H "content-type: application/json" -d '{}' | jq -r .sessionToken)

# 1) List available tools
curl -sSk -X POST "$BASE/mcp" \
  -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 2) Call a tool
curl -sSk -X POST "$BASE/mcp" \
  -H "x-api-key: $KEY" \
  -H "content-type: application/json" \
  -H "accept: application/json, text/event-stream" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"context_whoami\",\"arguments\":{\"_sessionToken\":\"$TOKEN\"}}}"
```

### The tools you get for free

| Tool | What it does |
|---|---|
| `context_whoami` | Returns caller identity (tenant, org, user, features list) — useful for debugging |
| `discover_schema` | Semantic search over entity schemas — "what data exists for customers?" |
| `find_api` | Semantic search over API endpoints — returns matching paths with summaries |
| `call_api` | Execute any REST endpoint: `{ method, path, query?, body? }` (all values must be strings in `query`) |
| `search_query`, `search_get`, `search_aggregate`, `search_schema`, `search_status`, `search_reindex` | Tenant-wide vector + keyword search |
| `customers_list_tasks`, `customers_create_task`, `customers_complete_task` | Task management |
| `customers_list_notes`, `customers_create_note` | Contact notes |
| `customers_list_reminders`, `customers_create_reminder` | Reminders |
| `customers_get_business_profile` | Tenant's business profile |
| `customers_get_contact_engagement`, `customers_list_hottest_contacts` | Engagement scores and rankings |
| `email_list_campaigns`, `email_list_mailing_lists`, `email_list_templates`, `email_search_messages` | Email module read tools |

**For anything not listed**: use `find_api` to discover the endpoint, then `call_api` to execute.

### Calling `call_api` — the escape hatch

Every REST endpoint is accessible through `call_api`. Two gotchas:

1. **All `query` values are strings.** `pageSize: 10` → `pageSize: "10"`. Zod validation rejects numbers at this boundary.
2. **`body` is passed as an object**, not a JSON string.

```json
{
  "name": "call_api",
  "arguments": {
    "_sessionToken": "sess_...",
    "method": "POST",
    "path": "/api/customers/people",
    "body": {
      "firstName": "Jane",
      "lastName": "Doe",
      "displayName": "Jane Doe",
      "primaryEmail": "jane@example.com",
      "source": "my_bot"
    }
  }
}
```

Response shape:
```json
{ "success": true, "statusCode": 201, "data": { "id": "...", "personId": "..." } }
```

---

## 5. Outbound webhooks

If you want the CRM to *push* events to you, have the operator create a webhook subscription in the UI at `/backend/settings/webhooks` or via the API:

```bash
curl -sSk -X POST "https://crm.thelaunchpadincubator.com/api/webhooks/subscriptions" \
  -H "x-api-key: omk_xxx" \
  -H "content-type: application/json" \
  -d '{
    "event": "contact.created",
    "targetUrl": "https://your-server.example.com/hooks/crm"
  }'
```

The response includes a `secret` (starts with `whsec_`). Store it. Every POST the CRM sends to your URL is signed:

```
POST /hooks/crm HTTP/1.1
Content-Type: application/json
User-Agent: LaunchCRM-Webhooks/1
X-Webhook-Event: contact.created
X-Webhook-Delivery: <uuid>
X-Webhook-Signature: sha256=<hex>

{"event":"contact.created","data":{...},"timestamp":"2026-04-23T12:34:56Z"}
```

### Verify the signature (Node.js example)

```javascript
import crypto from 'node:crypto'

function verify(body, signatureHeader, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader))
}

// In your handler:
const rawBody = await req.text()  // IMPORTANT: signature is over the RAW body, pre-JSON-parse
if (!verify(rawBody, req.headers['x-webhook-signature'], process.env.CRM_WEBHOOK_SECRET)) {
  return res.status(401).send('bad signature')
}
const payload = JSON.parse(rawBody)
```

### Events you can subscribe to

| Event | Payload shape (summarized) |
|---|---|
| `contact.created` | `{ id, displayName, primaryEmail, primaryPhone, source }` |
| `contact.updated` | `{ id, changedFields }` |
| `deal.created` | `{ id, title, valueAmount, valueCurrency, pipelineStage }` |
| `deal.stage_changed` | `{ id, previousStage, newStage, title }` |
| `deal.won` | `{ id, title, valueAmount, valueCurrency }` |
| `deal.lost` | `{ id, title, reason? }` |
| `task.created` | `{ id, title, contactId?, dueDate? }` |
| `task.completed` | `{ id, title }` |
| `form.submitted` | `{ submissionId, formId, formSlug, contactId?, data }` |
| `booking.created` | `{ bookingId, bookingPageSlug, guestEmail, guestName, startTime, endTime }` |
| `course.enrollment.created` | `{ enrollmentId, courseId, courseTitle, studentEmail, studentName }` |
| `invoice.created` | `{ invoiceId, invoiceNumber, totalAmount, currency, contactId? }` |

Every event also includes top-level `organizationId` and `tenantId` so multi-tenant subscribers can route correctly.

### Retries + delivery log

The CRM retries non-2xx responses up to 3 times with 5-second backoff. Every attempt is logged at `/backend/settings/webhooks` so the operator can see what fired, what failed, and why. Return any 2xx status within 10s to acknowledge. Don't do heavy work in the handler — ack fast, process async.

---

## 6. Common recipes

### "Create a contact and log a custom interaction"

```javascript
// 1. Create or find the contact (dedup by email happens server-side)
const createRes = await fetch(`${BASE}/api/customers/people`, {
  method: 'POST',
  headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
  body: JSON.stringify({
    firstName: 'Jane', lastName: 'Doe',
    displayName: 'Jane Doe',
    primaryEmail: 'jane@example.com',
    source: 'my_integration',
  }),
})
const { id: contactId } = await createRes.json()

// 2. Log an interaction on their timeline
await fetch(`${BASE}/api/customers/notes`, {
  method: 'POST',
  headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
  body: JSON.stringify({
    contactId,
    content: 'Downloaded the product whitepaper',
  }),
})
```

### "Send an email from my bot"

```javascript
await fetch(`${BASE}/api/email/smtp`, {
  method: 'POST',
  headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
  body: JSON.stringify({
    to: 'jane@example.com',
    subject: 'Your report is ready',
    body: '<p>Hi Jane, here\'s the report you requested...</p>',
    contactId,  // optional — links the email to the contact's timeline
  }),
})
```

### "Listen for new leads and push to my CRM's lead queue"

1. Subscribe a webhook to `contact.created` pointing at your server
2. Verify signature on incoming POST
3. Route payload into your own system

### "Give my agent full API access but rate-limit it tightly"

Operator creates a key with `rateLimitTier: "default"` and no scopes. Agent respects 429 headers.

### "Give my agent read-only access to contacts only"

Operator creates a key with `scopes: ["customers.people.view", "customers.companies.view"]`. Any attempt to POST or access other modules returns 403.

---

## 7. Operational notes

### Idempotency
Most create endpoints are not idempotent. If you retry a POST after a timeout, you can end up with duplicates. Dedup by natural keys before creating:
- Contacts: search by email first
- Deals: check existing deals for the contact
- Tasks: include a stable `externalId` if you're re-syncing

### Timestamps
All timestamps are UTC ISO 8601. Timeline queries accept `from` and `to` ISO strings.

### Pagination
`pageSize` is capped at 100 per route. For large scans, use `page=1&pageSize=100` and walk.

### Tenant encryption
Some fields (contact name, email, phone) are stored encrypted. The API transparently decrypts on read. You never see ciphertext. You also can't run substring searches outside the provided `search=` parameter — don't try filtering by primary_email with wildcards through custom query params.

### Rate-limit etiquette
- Check `RateLimit-Remaining` before sending a burst.
- On 429, respect `Retry-After` to the second. Don't exponential-backoff from a different timer.
- If you routinely need more throughput, ask the operator to bump your key to `pro` tier.

### Observability
Every request carries an `x-request-id` header. If you hit a 500 or other unexpected error, pass that ID to the operator when reporting — they can find the full stack trace.

---

## 8. Backward-compatibility guarantees

LaunchCRM follows a strict BC contract for these surfaces:

- **API route URLs** never rename. New endpoints are additive.
- **Response fields** never remove, narrow, or change type. New fields are additive; your parser should ignore unknown keys.
- **Event IDs** (webhook events, MCP tool names) are frozen. New events/tools are additive.
- **Auth header name** (`x-api-key`) never changes.

You can safely pin your integration code to today's contract and assume it'll keep working for years. Watch `RELEASE_NOTES.md` in the CRM repo for any deprecation announcements (bridges are always provided for at least one minor version).

---

## 9. Quick reference — "I just want to..."

| Goal | Shortest path |
|---|---|
| Search contacts | `GET /api/customers/people?search=<q>` |
| Create contact | `POST /api/customers/people` |
| Send email | `POST /api/email/smtp` |
| Get a contact's full history | `GET /api/contacts/:id/timeline` |
| Listen for new contacts | Webhook subscription on `contact.created` |
| Know what tools/endpoints exist | `GET /api/webhooks/events`, `GET /api/docs/openapi`, or MCP `find_api` |
| Introspect schema at runtime | MCP `discover_schema` |
| Act on behalf of a user in AI chat | MCP with session token from `/api/ai_assistant/session-key` |

---

## 10. Getting help

- **Tool/endpoint doesn't work as documented** — file an issue with `x-request-id` from the response headers.
- **Need a new tool, event, or endpoint** — open a BUILD-QUEUE item in the CRM repo with the use case.
- **Security concern** — don't open a public issue; contact the operator privately.

---

**Changelog**
- 2026-04-23 — Initial guide. Covers REST, MCP, webhooks, auth, tiers, scopes. Written after SPEC-062 shipped all four phases.
