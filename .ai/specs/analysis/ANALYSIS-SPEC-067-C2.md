# Pre-Implementation Analysis: SPEC-067 C2 dark mailbox lifecycle

## Executive Summary

SPEC-067 is ready for a local C2 implementation after an additive C2 contract is appended. The existing app-level `gtm` module is the correct extension boundary. No Open Mercato core contract needs to change. C2 must remain dark and must treat OAuth refresh, provider dispatch, cursor expiry, mailbox reputation, and telemetry durability as explicit state transitions rather than optimistic best effort.

The principal risks are unknown email-send outcomes, stale or replayed Gmail/Graph cursors, token refresh mutating an approval fingerprint, mailbox-event concurrency, and telemetry becoming a second billing ledger. The remediation is to keep external calls behind the existing execution gate plus a separate ingestion gate, use MIME for both Gmail and Graph so the approved RFC headers survive, store only opaque sealed cursors, make all schema changes additive and generator-owned, and keep telemetry observational and idempotent.

## Backward Compatibility

### Contract-surface audit

| # | Surface | C2 impact | Severity | Required treatment |
|---|---|---|---|---|
| 1 | Auto-discovery conventions | Add one `workers/` file using the existing export shape | None | Preserve `metadata` and default handler exports; run `yarn generate` |
| 2 | Types and interfaces | Add optional transport/telemetry fields and new local types | None | Do not remove or narrow existing fields |
| 3 | Function signatures | Existing public functions remain callable | None | Add optional dependencies/fields only; retain SMTP export |
| 4 | Import paths | No move or removal | None | Keep existing transport and cursor paths |
| 5 | Event IDs | No existing event changed | None | C2 uses durable rows/audits; any future event is additive |
| 6 | Widget spot IDs | Not affected | None | No UI replacement work in C2 |
| 7 | API route URLs | Existing internal routes receive additive operations/fields | None | Do not remove response fields or change methods |
| 8 | Database schema | New tables, indexes, and nullable/defaulted columns only | None | Generate one GTM-scoped migration and inspect it for unrelated churn |
| 9 | DI service names | No existing key changed | None | Worker resolves existing `em`; provider clients remain injected pure dependencies |
| 10 | ACL feature IDs | Existing `gtm.view`, `gtm.approve`, and `gtm.launch` reused | None | Do not rename or remove role features |
| 11 | Notification type IDs | Not affected | None | No notification contract in C2 |
| 12 | CLI commands | Not affected | None | No CLI contract in C2 |
| 13 | Generated contracts | Additive worker/route discovery only | None | Never hand-edit generated registries; require zero generated drift |

### Migration and backward compatibility

C2 is additive-only. It keeps the SMTP transport export and all C1 state values, routes, validators, and response fields. It accepts both historical `microsoft` and validator-era `outlook` provider labels. Existing C1 rows remain valid because new entity properties are nullable or defaulted. No backfill is required for an inert, unapplied GTM schema; target-schema inspection remains mandatory before any shared migration.

## Spec Completeness

### Missing C2 sections to add before implementation

| Section | Impact | Recommendation |
|---|---|---|
| C2 architecture and release boundary | Scope could be mistaken for send authority | State local-only authority and keep execution, ingestion, providers, and exposure off |
| Gmail/Graph transport contract | C1 only names SMTP | Require exact MIME headers/message id, known-failure vs ambiguous mapping, and transient token refresh |
| Provider cursor protocol | C1 has storage but no provider mapping | Define Gmail history and Outlook inbox-delta page semantics, 404/resync behavior, and URL allowlisting |
| Mailbox reputation policy | Bounce events do not aggregate into sender health | Define deterministic rolling-window thresholds and pause behavior |
| Diagnostics | Operator history is absent | Define redacted tenant-scoped provider, mailbox, cursor, and reconciliation summaries |
| Token/cost telemetry | Existing aggregate metering is insufficient | Define observational receipt schema, idempotency, component estimates, latency/failure capture, and nullable configured cost |
| Quality harness | Existing CRM AUG-04 harness does not cover GTM artifacts | Add versioned synthetic fixtures, hard-safety precedence, rubric thresholds, and baseline discipline |
| Integration coverage | C1 proved constraints but not application races | Add disposable PostgreSQL tests for capacity, cursor lease/page advancement, event dedupe, and health pause races |

## AGENTS.md Compliance

### Required implementation rules

| Rule | C2 application |
|---|---|
| App-specific module ownership | All CRM behavior remains under `apps/mercato/src/modules/gtm/` |
| No direct cross-module ORM relationships | Email mailbox/message references remain plain UUIDs; existing email entities are queried with full org and tenant scope |
| Tenant isolation | Every worker, route, service query, and dedupe key binds both organization and tenant |
| Zod validation | Additive route/job inputs live in `data/validators.ts` |
| Command writes | Operator state-changing actions remain commands; ingestion processing stays an idempotent worker/state-machine operation |
| Queue contract | Worker exports `WorkerMeta`, concurrency no greater than five, and is retry-idempotent |
| Migrations | Entity source first, then `yarn db:generate`; no handwritten CRM migration |
| OpenAPI | Existing internal routes retain `openApi`; additive operations are documented by their shared schemas |
| Secrets | No token, refresh token, SMTP password, raw cursor, or message body enters logs, receipts, diagnostics, or telemetry |
| External connectors | C2 extends the already-qualified app mailbox boundary; it does not create a new provider marketplace module or modify core provider packages |
| Generated files | Run `yarn generate`; do not edit `.mercato/generated` manually |
| Noli conventions | Any Noli-side test/harness change uses Node 22 and the required noreply commit identity |

## Risk Assessment

### High risks

| Risk | Impact | Mitigation |
|---|---|---|
| Provider accepts mail but response is lost | Duplicate outreach if retried | Persist `provider_started` first; map timeout/429/5xx transport uncertainty to `ambiguous`; never auto-retry |
| OAuth refresh changes connection timestamps | Previously approved sender appears changed | Refresh access tokens transiently in the transport; do not mutate the connection or approved sender envelope in C2 |
| Graph MIME or Gmail raw encoding drops approved headers | Unsubscribe/correlation contract fails | One shared validated MIME builder; provider-specific encoding only; exact fixture assertions for Message-ID and RFC 8058 headers |
| Stale Gmail history or malformed Graph delta cursor | Events skipped or arbitrary URL fetched | Mark `resync_required`; allow only provider-owned HTTPS origins and expected mailbox paths; never silently jump cursor |
| Concurrent cursor workers | Duplicate side effects or cursor advancement past failed events | Fenced lease plus atomic persist/process/advance; expired owners cannot advance or fail the cursor |
| Reputation events race | Mail continues after complaint/bounce threshold | Serialize mailbox health updates and recheck health immediately before `provider_started` |

### Medium risks

| Risk | Impact | Mitigation |
|---|---|---|
| Inbound full-sync volume | Large mailbox backfill or cost | C2 does not auto-full-sync; resync requires explicit bounded authority |
| Outlook `202 Accepted` has no provider message id | Weak provider-id correlation | Persist the approved RFC Message-ID as canonical send correlation and record Graph acceptance without inventing an id |
| Telemetry double counts retries | Misleading cost diagnostics | Unique operation key; exact replay returns the existing observational receipt |
| Telemetry becomes billing truth | Money drift | Mark it observational; Noli Core remains the only credit ledger; rate-card version and nullable cost are explicit |
| Quality fixtures overfit wording | False confidence | Score semantic criteria and hard safety, not exact prose; separate deterministic dry-run from future model judging |

### Low risks

| Risk | Impact | Mitigation |
|---|---|---|
| Historical provider label drift | A valid Outlook mailbox is rejected | Normalize `outlook` and `microsoft` to one Graph adapter without rewriting stored rows |
| Diagnostics expose content | Privacy leak | Return counts, hashes, states, timestamps, and bounded reason codes only |

## Gap Analysis

### Critical gaps addressed by C2

- No Gmail/Graph GTM send adapter that preserves exact approved headers and Message-ID.
- No provider-specific incremental ingestion service or idempotent queue worker.
- No mailbox-wide reputation pause state checked by the send machine.
- No real-PostgreSQL application concurrency evidence for capacity, cursors, event dedupe, and health.
- No durable GTM token/component/latency/failure telemetry.

### Important gaps that remain after C2

- No real mailbox or provider call is authorized by this tranche.
- Google/Microsoft OAuth scopes, app verification, tenant consent, DKIM/SPF/DMARC, and account-specific rate limits require owner/provider evidence.
- A controlled owned-mailbox send, delivery, reply, bounce, complaint, unsubscribe, restart, and cleanup lifecycle remains a separate release gate.
- Provider sourcing rights, legal copy, prospect data, and customer exposure remain outside C2.

### Nice-to-have follow-up

- Operator UI over the redacted diagnostics APIs.
- Pub/Sub and Graph subscription wakeups; C2 correctness uses an idempotent queue job and opaque incremental cursors.
- Provider DSR execution once rights and contracts are approved.

## Remediation Plan

### Before implementation

1. Append a C2 contract to SPEC-067 with the additive schema, API, worker, transport, quality, and release boundaries.
2. Preserve app-level extension mode; do not modify core/provider packages.
3. Bind the implementation to official Gmail raw MIME/history and Microsoft Graph MIME/delta contracts without making provider calls.

### During implementation

1. Build shared validated MIME and provider HTTP seams with injected fetch.
2. Add fenced provider ingestion, mailbox health, redacted diagnostics, and observational telemetry.
3. Add unit, route-contract, queue-handler, quality-fixture, and disposable PostgreSQL race tests.
4. Generate and inspect one GTM-only CRM migration.

### Post-implementation

1. Run the full CI-equivalent gate and document every result.
2. Freeze recovery patches and hashes before local commits.
3. Keep all external effects disabled and carry forward the explicit release approvals.

## Recommendation

Ready to implement after the C2 spec amendment. The work is an external app-level module extension, not a core modification. No breaking compatibility action or deprecation bridge is required.
