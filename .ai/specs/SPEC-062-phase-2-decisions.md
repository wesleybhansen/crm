# SPEC-062 Phase 2 — decision memo

**Status:** Decisions locked 2026-04-23
**Scope:** Add per-API-key rate limiting on top of the existing catch-all router limiter.

## What's already there

The catch-all API router (`apps/mercato/src/app/api/[...slug]/route.ts`) already:
- Reads `methodMetadata.rateLimit` per route (opt-in per route)
- Keys limits by `clientIp` (via `getClientIp` + `trustProxyDepth`)
- Returns 429 with `checkRateLimit` helper (throws structured response)
- Emits `applicationLifecycleEvents.requestRateLimited` telemetry

The rate-limit service (`@open-mercato/shared/lib/ratelimit`) supports memory + Redis, exposes `consume/get/delete` with `{ allowed, remainingPoints, msBeforeNext, consumedPoints }`.

**Gap:** no default rate limit for API-key requests across the board. Routes must opt-in. Keys are all unthrottled unless the specific route declares a limit.

## Decisions

### 1. Scope
**API-key-authenticated requests only.** Cookie-auth requests (internal UI) are bypassed — they're fundamentally user-driven and the UI already throttles naturally. Public-unauthenticated routes (form submit, landing page submit, booking) remain IP-limited via the existing per-route opt-in; we don't add a global API-key limiter for those because there's no key to key by.

### 2. Identity key
**`apiKey.id`** when `ctx.auth.apiKeyId` is set. This is already populated by the auth resolution chain for x-api-key requests. We skip the global limiter entirely when `apiKeyId` is absent.

### 3. Tiers (v1)
Two tiers to start:
- **`default`** — 60 req/min, 1000 req/hour
- **`unlimited`** — no check

`pro` and higher tiers can be added later as additional rows in the tier map; the infrastructure won't need to change. Stored as `api_keys.rate_limit_tier text` (nullable, treated as `default` when null — full BC).

### 4. Backend
**Memory for v1.** Prod runs a single app container today; memory is sufficient. Switch to Redis when we scale to multi-instance — the `rateLimiterService` is already Redis-ready, only `globalConfig.strategy` flips. No code changes needed.

### 5. Response headers
Follow the **IETF draft** (most widely-supported — cloudflare, stripe, github all use variants of this):
```
RateLimit-Limit: 60
RateLimit-Remaining: 47
RateLimit-Reset: 23       ; seconds until window resets
```
Plus `Retry-After: 23` on 429 responses.

Skip the older `X-RateLimit-*` variants — everyone supports both but we only emit one.

### 6. 429 response body
```json
{
  "ok": false,
  "error": "Rate limit exceeded",
  "retryAfterSeconds": 23,
  "limit": 60,
  "windowSeconds": 60
}
```

### 7. Two-window check
Each API-key request consumes against **both** windows (per-minute and per-hour). Reject if either is exhausted. This matches what GitHub/Stripe do and prevents bursts from blowing the hourly budget in 30 seconds.

### 8. Order of operations in router
Insert **after** auth resolution, **before** feature check. Rationale: we want to rate-limit authenticated calls to reduce load on the RBAC check, but not pollute the limit counter with unauthenticated-401 probes.

### 9. Telemetry
Reuse existing `requestRateLimited` lifecycle event. Add `apiKeyId` to the payload.

### 10. Migration & BC
- New column `rate_limit_tier text NULL` on `api_keys`. Additive.
- Keys with `NULL` tier use `default`. No existing keys break.
- `api_keys` CRUD route + UI get an optional tier field (dropdown). Not required.
- No changes to existing per-route `metadata.rateLimit` opt-in behavior — those still run and are independent of the global API-key limiter.

### 11. Tests
1. `TC-RATELIMIT-001`: API-key caller hitting `/api/customers/people` 61× in one minute → 61st returns 429 with `Retry-After`
2. `TC-RATELIMIT-002`: Cookie-auth user makes 100 calls in a minute → all succeed (bypass)
3. `TC-RATELIMIT-003`: Key with `rate_limit_tier=unlimited` makes 100 calls → all succeed
4. Response headers present on every successful API-key call

### 12. Out of scope for Phase 2
- Per-route overrides beyond tier (keep the existing `metadata.rateLimit` opt-in for special cases)
- Cost weighting (treating heavy endpoints as consuming more points)
- Sliding-window algorithm (v1 uses fixed window, which is what `rate-limiter-flexible` defaults to)
- Admin UI for viewing current usage
- Public developer-facing docs about the limits

---

## Build steps

1. Add `rate_limit_tier` column migration — `yarn db:generate` after updating the ApiKey entity.
2. Create `packages/core/src/modules/api_keys/lib/rateLimitTiers.ts` with tier → config map.
3. Modify `apps/mercato/src/app/api/[...slug]/route.ts` to insert a global API-key limiter block after auth but before feature check, wrapping `rateLimiterService.consume(apiKey.id, tierConfig)` for both minute + hour windows.
4. Add response-header helper that attaches `RateLimit-*` to every response from rate-limited paths.
5. Extend `api_keys` UI to surface the tier (dropdown, default = "default").
6. Write 3 integration specs (TC-RATELIMIT-001/002/003).
7. Deploy. Smoke-test with a burst of 65 API calls from a test key.
