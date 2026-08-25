# SPEC-067: GTM Engineer durable domain, execution, and provider contracts

**Date:** 2026-07-23 PDT
**Status:** C0-R39 is merged and owner-only dark-deployed through executable enrichment quote truth. The separate auto-refill runtime gate remains off, and no campaign schedule or cycle exists. DataForSEO and the exact selected Apify capabilities may run only through their separately gated quote/confirm contracts. Automated email execution, mailbox ingestion, LeadMagic, Bouncer, public GTM promotion, and customer exposure remain off.
**Authority:** `~/dev/Noli AI/Software Strategy/gtm-engineer-build-plan-2026-07-23.md`. Companion: noli-platform `docs/specs/GTM-SPEC-01-2026-07-23-audience-plays-and-noli-core-credit-contracts.md` (Audience Plays engine, canonical noli-core credit ledger, Launchpad boundary).
**Launch classification:** included in every paid Noli plan as of the AUG-18 product decision; fail-closed Hub and CRM runtime gates remain operational kill switches, not plan segmentation.
**Spec numbering note:** The July branch used SPEC-066. Current main now owns SPEC-066 for the AUG-04 CRM regression-quality program, so the GTM contract is reconciled as SPEC-067 without changing its product scope.

All citations verified against CRM `main` at `dfa6b3aa99e4a0580a15c88c2774975f6ac14c87` on 2026-07-23.

---

## 1. TLDR

CRM gains a new app-level `gtm` module owning ALL durable GTM Engineer state: workspaces, ICP/voice versions, plays, research runs, candidates, evidence, contact points, campaigns, immutable approval versions, enrollments, steps, rendered messages, send attempts, replies, suppression, provider-operation shadows, and audit events. It reuses ONLY the qualified mailbox transports (`email_connections` + `email-router`) behind a new durability layer. The legacy sequence/automation processors are explicitly not reused or extended. noli-core is the sole canonical pooled-credit ledger; the CRM stores a correlation shadow keyed to the noli-core operation id. Both correlated email replies and user-recorded social replies atomically stop all remaining mixed-channel steps. V1 is US B2B only and fails closed everywhere before paid sourcing, promotion, approval, or launch.

## 2. Problem statement

The build plan requires guarded, durable, approval-gated outbound email plus manual social tasks. The existing CRM machinery cannot provide this (evidence in §3): the sequence engine has claim-without-lease execution, fire-and-forget sends recorded as executed regardless of outcome, race-prone enrollment, and no suppression gate; reply correlation to a specific outbound send does not exist; suppression is a flat Resend-webhook-fed list enforced only in the campaign blast path; and there is no reservation/idempotency primitive for paid provider spend.

## 3. Code-grounded baseline (verified 2026-07-23)

### 3.1 Qualified transports (REUSE, behind the new durability layer)

- **`EmailConnection` -> `email_connections`** (`apps/mercato/src/modules/email/data/schema.ts:424-497`): uuid PK; `tenant_id`, `organization_id`, `user_id` (per-user mailbox); `provider` free-form text, router switches on `'gmail' | 'microsoft' | 'smtp'` (`email-router.ts:76`); SMTP/IMAP app-password fields (`smtp_pass` shared with IMAP per comment at :468); `purpose` null = personal inbox, `'customer_service'` = CS desk; `is_primary`, `is_active`, `deleted_at`. **No health/error/last-sync columns on the connection**; sync health lives on `email_intelligence_settings` (:687-742).
- **`EspConnection` -> `esp_connections`** (schema.ts:499-541) with `api_key` **plaintext (known security gap flagged in-code at :514-517)**.
- **Send orchestrator `email/lib/email-router.ts`**: `sendEmailByPurpose(knex, orgId, tenantId, purpose, params)` (:312-392) resolves provider and dispatches Gmail/Outlook/SMTP/ESP; returns `{ ok, messageId?, sentVia?, fromAddress?, error? }`; never throws; **writes no durable send row** (persistence is the caller's job). `sendViaSMTP` (`smtp-service.ts:20-51`) and `sendViaESP` (`esp-service.ts:14-34`) return provider message-id only - **no delivery receipt**. Delivery/bounce/complaint feedback exists **only for Resend** via the Svix-verified webhook (`email/api/webhook/route.ts:15-34`), not for Gmail/Outlook/SMTP sends.
- A second, org-agnostic Resend stack exists (`email/services/email-sender.ts`, global env keys). The GTM layer standardizes on the router + `email_connections`/`esp_connections`; `email-sender.ts` is not a GTM transport.

### 3.2 Legacy sequence/automation engine (DO NOT REUSE OR EXTEND - evidence)

- Tables `sequences, sequence_steps, sequence_enrollments, sequence_step_executions, automation_rules, automation_scheduled_steps, automation_rule_logs` are **raw-knex with no ORM entity and no in-repo migration** (`modules/sequences/data/` is empty; no `migrations/` dir); schema is not authoritative in the repo.
- Enrollment (`sequences/api/[id]/enroll/route.ts:40-90`): duplicate-enroll check is SELECT-then-INSERT with no unique constraint - race-prone.
- Processor (`sequences/api/process/route.ts`): cron-poll (`SEQUENCE_PROCESS_SECRET`, :38), claims via `UPDATE ... WHERE status='scheduled' SET status='processing'` (:73-76) but has **no lease/timeout/heartbeat** - a crashed `processing` row is stuck forever, never re-selected, no `attempts`, no reclaim. Sends insert `email_messages` `status='queued'` (:194-207), call `sendEmailByPurpose` best-effort, `console.error` on failure (:216-221), and **mark the execution `executed` regardless** (:223-227); the queued row is never updated and never retried - success and failure are indistinguishable. **No suppression/unsubscribe/preference check** before sending.
- `automation-execute.ts` header: "Called fire-and-forget from various routes" (:15); `processScheduledSteps` (:588-641) repeats the same claim-without-lease pattern.

### 3.3 Reply/threading reality

- Inbound mail dedupe key is `email_messages.metadata->>'provider_message_id'` - a JSONB lookup with **no unique index** (`inbox-ingest.ts:154-158`, `personal-inbox-sync.ts:112-116`).
- Threading is a header-derived `thread_id` string (`threadRef = refList[0] || inReplyTo || rawMessageId`, `imap-service.ts:227-228`); `email_messages.thread_id` is text, not an FK; there is no threads table. **No linkage exists from an inbound reply to a specific outbound send row** - campaign/sequence reply correlation is unimplemented today.

### 3.4 Suppression reality

- `EmailUnsubscribe` -> `email_unsubscribes` (schema.ts:261-281): flat org-scoped list; the ORM entity lacks the `reason` column the webhook writes (route.ts:88,141) - a raw legacy column. `customer_entities.email_status` is likewise a raw column absent from the ORM entity.
- Enforcement exists **only in the campaign blast path** (`campaigns-send/route.ts:62-88`); sequence and automation sends check nothing.
- Outbound **RFC 8058 one-click `List-Unsubscribe`/`List-Unsubscribe-Post` headers are not implemented** (the header is only read on inbound for bulk detection, `imap-service.ts:42-54`). Unsubscribe links use a signed HMAC preference-center token (`unsubscribe/[contactId]/route.ts:9-26`).

### 3.5 Contacts

- `CustomerEntity` -> `customer_entities` (`packages/core/src/modules/customers/data/entities.ts:17-134`), person/company via `kind`; `primary_email` nullable with **no unique constraint** - dedupe is lowercase match in application code (`inbox-ingest.ts:69-75`). Two parallel timeline stores exist: ORM `customer_activities` (:370-418) and raw `contact_timeline_events` (via `apps/mercato/src/lib/timeline.ts`).

### 3.6 Internal endpoint + identity pattern (reference for all new GTM internal routes)

`integrations_api/api/internal/provision-key/route.ts`: `metadata = { path, POST: { requireAuth: false } }` (:17-20); length-guarded `crypto.timingSafeEqual` against `Bearer ${NOLI_INTERNAL_SERVICE_SECRET}` (:23-33); `findNoliUserById(noliUserId)` -> `resolveClerkUserToAuthContext(clerk_user_id)` which gates on the `crm` entitlement and yields `{ userId, orgId, tenantId }` (:47-67). Every GTM internal route mirrors this exactly and self-scopes every query by `organization_id` + `tenant_id`.

### 3.7 Module conventions binding this spec

Per root `AGENTS.md` + `packages/core/AGENTS.md` + `packages/cli/AGENTS.md`: new module at `apps/mercato/src/modules/gtm/` with `data/entities.ts`; migrations generated by `yarn db:generate` into the module's `migrations/` (never hand-written; keep the snapshot in sync); tables plural snake_case with module prefix, uuid PKs, `organization_id` + `tenant_id` NOT NULL, `created_at`/`updated_at`, `deleted_at` for soft delete; CRUD via `makeCrudRoute` with `indexer`, writes via the Command pattern, `openApi` exports, ACL features `gtm.*` in `acl.ts` mirrored in `setup.ts`; no new raw-knex routes under `apps/mercato/src/app/api/`; registry is baked at build time; production migrations are applied manually by idempotent psql as a separately authorized step.

---

## 4. New module `gtm`: durable entity catalog (Tranche 2 generation target)

All tables: uuid PK `id`, `organization_id uuid NOT NULL`, `tenant_id uuid NOT NULL`, `created_at`, `updated_at`, `deleted_at` (soft delete), composite index `(organization_id, tenant_id, ...)`. Names frozen now; column lists are the implementation baseline (additive drift allowed at generation time, subtractive drift is a spec change).

| Entity | Table | Key columns beyond the standard set |
|---|---|---|
| `GtmWorkspace` | `gtm_workspaces` | `name`, `status(draft\|active\|archived)`, `business_context jsonb`, `settings jsonb` |
| `GtmIcpVersion` | `gtm_icp_versions` | `workspace_id FK`, `version int`, `content jsonb`, `locked bool`, `locked_by_user_id`, `locked_at`, `provenance jsonb (author: user\|agent, source refs)`; **unique `(workspace_id, version)`; rows immutable after insert** |
| `GtmVoiceVersion` | `gtm_voice_versions` | same shape as ICP versions; `derived_from jsonb` (website/sent-mail/pasted/social provenance) |
| `GtmPlay` | `gtm_plays` | `workspace_id FK`, `source(imported\|authored)`, `imported_report_token_hash`, typed play fields per GTM-SPEC-01 §3.5 (`market_type`, `audience`, `signal`, `source_hint`, `geography`, `recency_window`, `why_now`, `recommended_angle`, `supported_channels jsonb`, `estimated_size jsonb`, `entity_unit`, `estimate_method`, `confidence`), `execution_eligibility(executable\|strategy_only\|unsupported)`, `eligibility_reason`, `eligibility_evaluated_at` |
| `GtmResearchRun` | `gtm_research_runs` | `workspace_id FK`, `play_id FK`, `input_snapshot jsonb`, `provider_plan jsonb`, `limits jsonb (target_accepted, max_raw_candidates, max_candidates compatibility alias, max_credits)`, `status(planned\|priced\|running\|completed\|failed\|cancelled)`, `estimated_credits`, `reconciled_credits`, `started_at`, `completed_at` |
| `GtmCandidate` | `gtm_candidates` | `research_run_id FK`, `workspace_id FK`, `entity_kind(person\|company)`, `identity jsonb (name, company, title, urls)`, `dedupe_key text` (normalized identity hash; **unique `(organization_id, workspace_id, dedupe_key)`**), `fit_status(unscored\|accepted\|review\|rejected)`, `fit_score numeric`, `reject_reason`, `qualification jsonb`, `qualification_version`, `retention_expires_at`, `promoted_contact_id uuid null -> customer_entities.id` |
| `GtmEvidence` | `gtm_evidence` | `candidate_id FK`, `claim`, `source_url`, `provider_ref jsonb (provider, record id, query snapshot)`, `observed_at`, `confidence`, `license jsonb (export/display constraints)` |
| `GtmContactPoint` | `gtm_contact_points` | `candidate_id FK`, `channel(email\|linkedin\|x)`, `value` (email addr / profile URL), `verification_state(found\|verified\|risky\|catch_all\|not_found\|provider_ambiguous)`, `provider_operation_id FK null`, `provenance jsonb`, `verified_at` |
| `GtmCampaign` | `gtm_campaigns` | `workspace_id FK`, `play_id FK`, `name`, `status(draft\|in_review\|approved\|launching\|active\|paused\|stopped\|completed)`, `current_version_id FK null`, `channel_mix jsonb`, `settings jsonb (daily cap, send window, timezone, jitter)` |
| `GtmCampaignVersion` | `gtm_campaign_versions` | `campaign_id FK`, `version int` (**unique `(campaign_id, version)`**), `snapshot jsonb` (full recipient/step/schedule/exclusion/sender/cap/projected-credit freeze), `content_hash text` (SHA-256 of canonical snapshot), `approved_by_user_id`, `approved_at`, `invalidated_at null`, `invalidated_reason`; **immutable after approval** |
| `GtmEnrollment` | `gtm_enrollments` | `campaign_id FK`, `campaign_version_id FK`, `candidate_id FK`, `contact_id uuid null`, `status(active\|stopped\|completed)`, `stop_reason(email_reply\|social_reply\|unsubscribe\|bounce\|complaint\|manual\|campaign_stopped) null`, `stopped_at`; **unique `(campaign_id, candidate_id)`** |
| `GtmStep` | `gtm_steps` | `campaign_version_id FK`, `order int`, `channel(email\|linkedin\|x)`, `mode(automated_email\|manual_social)`, `delay_days`, `send_window jsonb`, `depends_on_step_id FK null` + `dependency_kind(none\|linkedin_connection_accepted) ` |
| `GtmRenderedMessage` | `gtm_rendered_messages` | `campaign_version_id FK`, `enrollment_id FK`, `step_id FK`, `subject`, `body_html`, `body_text`, `content_hash`, `edited_by_user_id null`; **frozen at approval; unique `(enrollment_id, step_id)`** |
| `GtmSendAttempt` | `gtm_send_attempts` | `enrollment_id FK`, `step_id FK`, `rendered_message_id FK`, `campaign_version_id FK`, `mailbox_connection_id uuid -> email_connections.id`, `state` (§6 machine), `claim_token uuid null`, `claim_expires_at timestamptz null`, `fence int`, `attempt_no int`, `idempotency_key text` (**unique `(organization_id, idempotency_key)`**), `provider_message_id`, `rfc_message_id text` (our generated Message-ID), `provider_receipt jsonb`, `ambiguous_at`, `scheduled_for`, `sent_at`, terminal timestamps |
| `GtmReply` | `gtm_replies` | `enrollment_id FK`, `send_attempt_id FK null` (email) , `step_id FK null` (social, user-recorded), `channel`, `direction(inbound)`, `email_message_id uuid null -> email_messages.id`, `classification(interested\|neutral_question\|not_now\|referral\|unsubscribe\|wrong_person\|negative)`, `classification_source(model\|user_override)`, `draft_response jsonb`, `draft_status(none\|drafted\|approved\|sent)` |
| `GtmSuppression` | `gtm_suppressions` | `scope(org\|global)`, `channel(email\|linkedin\|x\|all)`, `address_hash text` (SHA-256 lowercase), `address_display`, `reason(unsubscribe\|hard_bounce\|complaint\|manual\|duplicate\|legal)`, `source jsonb`, `expires_at null`; **unique `(organization_id, channel, address_hash)`** plus a global-scope partial unique |
| `GtmProviderOperation` | `gtm_provider_operations` | `noli_core_operation_id uuid NOT NULL` (**unique**), `research_run_id FK null`, `candidate_id FK null`, `kind`, `provider`, `local_status_mirror`, `receipt jsonb`, `requested_at`, `settled_at`; **shadow only - never a balance, never a source of charge truth** |
| `GtmAuditEvent` | `gtm_audit_events` | `actor(user_id\|system\|agent)`, `action`, `object_type`, `object_id`, `object_version`, `request_id`, `metadata jsonb` (redacted) |

Retention: `gtm_candidates.retention_expires_at` defaults to 90 days for never-promoted candidates (product-confirmable; open question); a sweep job hard-deletes expired candidates + their evidence/contact points and writes an audit event. Rejected candidates never become CRM contacts (`promoted_contact_id` stays null).

## 5. Identity, tenancy, RBAC

- Internal routes (hub proxy targets) all follow §3.6: `/internal/gtm/import-audience-play`, `/internal/gtm/workspace`, `/internal/gtm/plays`, `/internal/gtm/research-runs`, `/internal/gtm/candidates`, `/internal/gtm/campaigns`, `/internal/gtm/approvals`, `/internal/gtm/inbox`, `/internal/gtm/senders`, `/internal/gtm/suppressions`, `/internal/gtm/usage`, `/internal/gtm/tasks` (manual social). Exact list finalized in Tranche 2; every route re-resolves `noliUserId -> {userId, orgId, tenantId}` and self-scopes.
- ACL features: `gtm.view`, `gtm.edit`, `gtm.approve`, `gtm.launch` (approve and launch are distinct); declared in `acl.ts`, defaults in `setup.ts`. Server-to-server callers carry the resolved user's roles (provision-key precedent §3.6).
- The GTM feature is additionally gated on the `crm` entitlement plus `features.gtm === true` (GTM-SPEC-01 §6); flag-off = fail-closed at the dispatcher-facing routes.

## 6. Email execution state machine (frozen)

States: `planned -> rendered -> reviewed -> approved -> claimed -> provider_started -> accepted | failed | ambiguous`, then post-send transitions `accepted -> delivered | bounced | complained | replied` where transport feedback exists (Resend webhook; Gmail/Outlook/SMTP sends stay `accepted` unless a correlated bounce message arrives).

Rules (each is a test target in §12):

1. **Claim = CAS with lease and fence.** A worker claims a due attempt with `UPDATE ... WHERE state='approved' AND scheduled_for <= now() AND (claim_expires_at IS NULL OR claim_expires_at < now()) SET state='claimed', claim_token=gen_random_uuid(), claim_expires_at = now() + lease, fence = fence + 1` using **database time only**. Every subsequent write for that attempt must present the claim token and current fence (SPEC-065 lesson: DB-time CAS + fencing, no application clocks).
2. **Pre-send recheck inside the claim, immediately before provider contact:** current suppression (§8), recipient eligibility + `execution_eligibility` of the play (§7), campaign `current_version_id` equals the attempt's `campaign_version_id` and that version is approved and not invalidated, enrollment still `active`, sender connection `is_active` and healthy, daily cap headroom for the mailbox (counted from `gtm_send_attempts` in the current send window), and exact org/tenant identity. Any failure -> `failed` with reason, never silent skip.
3. **Provider contact:** transition `claimed -> provider_started` is durably written BEFORE the SMTP/API call. Our own RFC `Message-ID` is generated and persisted first (`rfc_message_id`) and set on the outgoing message so replies correlate (§9).
4. **Outcome:** provider success -> `accepted` with `provider_message_id` + receipt. A thrown/failed call -> `failed` (retryable only from `failed` with a NEW attempt row and the same idempotency scope rules). **A timeout/unknown outcome after `provider_started` -> `ambiguous`: never automatically retried**, parked for reconciliation (at-most-one provider attempt per rendered message while ambiguous). A provider exception can never mark the attempt executed (the legacy engine's exact defect, §3.2).
5. **Stuck-claim recovery:** a lease-expired `claimed` row (crash before `provider_started`) is reclaimable by CAS with fence increment. A lease-expired `provider_started` row is NOT reclaimable - it degrades to `ambiguous`.
6. **Scheduling** uses DB-time due queries over `gtm_send_attempts` (no external cron dependency for correctness; the trigger cadence may be cron, but every operation is safe under overlap, replay, and delay). Send windows are timezone-aware with jitter, all computed at claim time.

## 7. US-B2B scope enforcement (fail-closed ladder, frozen)

`execution_eligibility` is evaluated server-side and re-evaluated at EVERY money- or contact-adjacent boundary; a non-`executable` play fails closed at each of:

1. research-run pricing/creation (before any reserve);
2. provider reserve (the noli-core RPC call is never issued for non-executable plays);
3. candidate promotion to prospect/contact;
4. campaign attach and approval freeze (an approval snapshot embeds the eligibility evaluation; a play edit that changes geography/market invalidates dependent research-run plans and campaign versions - `invalidated_reason='scope_change'`);
5. launch;
6. every send claim (§6 rule 2).

Direct API calls, raw IDs, retries, agent prompts, and previously approved versions cannot bypass this: the check binds to the play row's current computed state, not to caller input. Non-US, B2C, mixed, housing-consumer, and ambiguous plays remain viewable as `strategy_only` and can never reach a reserve call or an approval snapshot.

## 8. Suppression and compliance (frozen)

- `gtm_suppressions` is the GTM enforcement table; writes flow in from: GTM unsubscribe events, hard bounces, complaints, manual suppression, duplicate protection, and a one-way import of existing `email_unsubscribes` rows at campaign build time (the legacy list keeps its own semantics; GTM never writes back).
- Enforcement points: candidate qualification (annotate), rendering (exclude), approval snapshot (excluded list frozen and visible), claim-time recheck (§6 rule 2 - the race-closing check), and reply-classification `unsubscribe` (stop + suppress atomically).
- GTM outbound email REQUIRES: accurate sender identity/subject, the org's configured physical postal address, a working unsubscribe link, and **RFC 8058 one-click `List-Unsubscribe` + `List-Unsubscribe-Post` headers (net-new; §3.4)**. The unsubscribe token is a signed HMAC token (existing `signEmailToken` precedent) hitting a GTM endpoint that writes `gtm_suppressions` + stops enrollments atomically.
- Duplicate protection: an address (hash) active in any other GTM campaign of the org cannot be enrolled without explicit override (`reason='duplicate'` suppression consulted at build + approval + claim).
- Resend is not a GTM cold-outreach transport (build plan §9.2); GTM sends go through user-connected mailboxes/ESP per §3.1.

## 9. Reply correlation and atomic stop (frozen)

- Correlation is net-new (§3.3): inbound ingestion gains a GTM hook that matches `In-Reply-To`/`References` header values against `gtm_send_attempts.rfc_message_id` (indexed). Fallback match: same mailbox + same counterparty address + thread ref of a GTM send. A match creates `GtmReply` linked to the enrollment and send attempt.
- **Atomic stop:** in ONE transaction: set `gtm_enrollments.status='stopped'`, `stop_reason`, `stopped_at`; cancel every remaining non-terminal `gtm_send_attempts` row of the enrollment (`approved/planned -> failed(reason='stopped')`, claimed rows are fenced out at their next write); mark pending manual steps cancelled; THEN commit the reply row in the same transaction. The reply is never surfaced before the stop state is durable.
- **User-recorded social replies take the identical transaction path** (a manual-task "mark replied" action), satisfying the non-negotiable that both reply kinds atomically stop all remaining mixed-channel steps.
- Classification into `interested|neutral_question|not_now|referral|unsubscribe|wrong_person|negative` runs after commit; `unsubscribe` additionally writes `gtm_suppressions`. Response drafting produces `draft_response` requiring explicit user approval before any send (which is itself a new `gtm_send_attempts` row through the full machine).

## 10. Mixed-channel manual tasks (frozen)

- `mode='manual_social'` steps surface the exact approved message + direct profile URL; the user marks `sent`, `skipped`, or `replied` (user-recorded state only; the UI never implies synchronization).
- LinkedIn connect-first: step A `send_connection_request` (user-recorded `requested`/`accepted`), step B with `depends_on_step_id=A, dependency_kind='linkedin_connection_accepted'` stays locked until A is `accepted` or an explicit user override is recorded (`gtm_audit_events` row). No browser automation, no Zernio involvement (Zernio provides no LinkedIn DM/connect capability and is unqualified for GTM in V1).
- Manual steps live on the same campaign timeline and the same enrollment stop semantics (§9).

## 11. Provider adapter capability contracts and fixtures (Tranche 0/3 design, frozen shape)

### 11.1 Capability contract

Every adapter (source, enrichment, verification, sending) declares a static descriptor consumed by planning/pricing and enforced at run time:

```
{
  adapter_id, layer: source|enrich|verify|send,
  capabilities: [{ signal_kind, entity_units, geographies, channels }],
  constraints: { license: { export, customer_display, outreach_allowed }, rate_limits, max_batch },
  cost_model: { unit, quoted_credits_per_unit, pay_on_found: bool },
  ambiguity_contract: { timeout_is_ambiguous: bool, receipt_fields: [...] },
  dsr: { deletion_supported: bool }
}
```

A requested signal with no covering capability **fails closed at plan time** ("unsupported dimension" shown before any spend); a contract-disabled capability cannot run even by direct call (checked again inside the adapter invoke path).

### 11.2 Adapter invocation rule (credit-coupled)

Adapter invoke is wrapped: (1) noli-core `provider_op_reserve` (org-scoped idempotency key = `research_run_id + adapter_id + batch fingerprint`); (2) shadow row `gtm_provider_operations` with the returned canonical id; (3) `provider_op_start`; (4) provider call; (5) `provider_op_settle` with charged units + receipt, or `provider_op_mark_ambiguous` on unknown outcome (never a replacement operation, never a local charge inference). Webhook/delayed completions look up the shadow by `noli_core_operation_id` and settle the SAME operation. Full RPC contract: GTM-SPEC-01 §4.

The represented Noli Core organization and user UUIDs, not the provisioned CRM organization/user UUIDs, are bound to every canonical provider reservation because canonical headroom and charged `ai_usage` settlement belong to Noli Core identities. Noli Core rejects provider-operation writes unless that organization exists and the represented user is an active member. Immediately after a provider response, CRM durably writes the bounded provider receipt, observed adapter status, intended ledger action, intended charge, and observation time to the shadow before invoking canonical settle/mark-ambiguous. A canonical failure leaves the same operation at `provider_started`, keeps its reservation escrowed, marks the run/candidate reconciliation-required, withholds unsettled provider output, and never contacts the provider again. CRM actor/audit fields continue using the CRM organization/user UUIDs.

### 11.3 Deterministic fixtures

- A `fixture` adapter implements every layer from versioned JSON fixture files (checked into the `gtm` module test tree in Tranche 2+): seeded, deterministic, replayable; each fixture row carries the same receipt/ambiguity fields a real provider would return, including crafted `timeout`, `partial`, `no_result`, `invalid_schema`, `rate_limit`, `5xx`, `delayed_completion`, `webhook_replay`, and `ambiguous_acceptance` cases so every §12 test runs with zero provider calls.
- Fixture identities are synthetic or Noli-owned only; no real prospect data enters fixtures.

### 11.4 Capped benchmark protocol (bake-off; execution separately authorized)

100-200 synthetic/owned/internal test targets across the five cohorts (local B2B services; professional services; B2B SaaS; ecommerce suppliers; solo consultants selling B2B). Candidates: `Crustdata + DataForSEO` (recommended default), Apollo-reseller alternative, Bright Data broad-source alternative; FullEnrich only on rows where the primary source fails to yield an acceptable verified contact. Measured per build plan §6.4 (precision after human review, coverage/freshness, provenance quality, verified-email yield, false-match/dupe rate, latency + failure/ambiguity behavior, cost per qualified/contactable prospect, DSR support, OEM/display/export rights). Hard caps: per-provider spend ceiling agreed before the run, batch sizes <= 25, kill switch, no outreach of any kind, and every operation through the §11.2 reserve path. Output: written decision matrix appended to the build plan (via the progress-doc amendment process, not by editing the plan mid-tranche).

### 11.5 Accepted-yield sourcing and criterion-aware qualification (amended 2026-08-02)

- A research run targets `target_accepted`, not raw inserted rows. `max_raw_candidates` and `max_credits` are independent, user-visible ceilings. The existing `maxCandidates` request and response field remains as an additive compatibility alias for `max_raw_candidates`.
- Planning prices every eligible source lane up to the confirmed maximum. Execution calls lanes in deterministic order, evaluates each unique row against the frozen play qualification profile, and skips all remaining provider calls as soon as `target_accepted` is met.
- The qualification profile is derived deterministically from `provider_query`, play geography, and `recency_window`. It evaluates account criteria, person criteria, geography, signal recency, and explicit exclusions. A hard contradiction rejects. Missing proof for a hard positive or exclusion routes the row to `review`, never to accepted.
- Qualification version `fit-v3` persists the frozen profile, per-criterion pass/fail/unknown result, score breakdown, unknowns, contradictions, and evidence issues on the candidate.
- The run execution JSON records the funnel `raw_candidates_found -> unique_candidates_inserted -> evidence_qualified -> accepted`, plus review/rejected counts, acceptance rate, reason distribution, target state, and stop reason. This is additive JSON and requires no new migration.
- A non-timeout transport failure after any real provider request is dispatched is ambiguous because billing cannot be proven. Unreadable successful response bodies are ambiguous for the same reason. They retain the reservation for reconciliation and are never silently refunded.
- Provider settlement uses authoritative provider billing fields when the provider exposes them. LeadMagic discovery uses `credits_consumed`; DataForSEO uses task/root USD cost against the frozen account rate. A missing or over-ceiling billing receipt is ambiguous.
- Verification is address-scoped within the exact organization and tenant. Enrichment plan schema v3 quotes one call per normalized email address; an unambiguous existing terminal result is reused for duplicate contact-point rows with provenance, while conflicting historical states disable reuse and require reconciliation. Unidentified rows remain independently quoted.
- Contact enrichment and verification operate on accepted person candidates only. Accepted company identities are account evidence for decision-maker resolution; they cannot enter a contact-enrichment quote, consume an enrichment reservation, or become an email recipient.
- DataForSEO Maps is frozen to one Live Advanced task of at most 100 results at `$0.002`. Legacy rate and depth environment variables are compatibility no-ops; a larger depth or changed rate requires a new reviewed contract/version and code change. Keywords over 700 characters and search operators that multiply the frozen base price are rejected before provider contact.
- DataForSEO receives one ranked Maps keyword and an exact canonical US location name. The adapter expands state abbreviations, removes display-only comma spacing, appends `United States`, and rejects an incomplete city/county without a state before provider contact. Provider receipts preserve both root and task status; a failed task code takes precedence over a successful envelope code. A run where every contacted provider returns a definitive application error is `failed`, not `completed` or `sources_exhausted`, while its reservation is still refunded from authoritative zero-cost evidence.
- DataForSEO activation requires exact reviewed terms and price versions plus the exact 30-day provider JSON-retention value. Unknown or mismatched retention remains provisional and disabled; it must never inherit Noli's separate 90-day candidate-retention default.
- Research plan schema v5 may quote multiple pages from the same source only when its descriptor declares deterministic offset pagination. Each page has a separate reserve/start/settle operation and immutable offset. A short/no-result page skips later offsets; an ambiguous page blocks them for reconciliation. Opaque provider cursors are not persisted or replayed.
- Fit-v6 / qualification-profile-v3 treats company-size evidence as tri-state: an exact count takes precedence over a conflicting provider bucket; otherwise a provider bucket fully contained by an approved range passes, a disjoint bucket fails, and partial overlap routes to review. Source plan schema v7 binds that rubric version and the search-versus-qualification split so stale plan approvals fail closed.

## 12. Acceptance tests (focused; implemented alongside their tranches)

Identity/tenancy: wrong user/org/tenant/campaign/sender/provider-account IDs rejected on every internal route; raw IDs and agent prompts cannot cross tenants; `gtm.approve` vs `gtm.launch` role separation enforced; server-to-server calls re-resolve identity (never trust caller-supplied ownership).

Scope: the §7 ladder - each of the six boundaries independently blocks a `strategy_only` play including via direct API, retry, and a previously-approved-then-invalidated version; geography/market edit invalidates plans + versions before any provider or sender contact.

Approval/invalidation: no send without an exact current approved version (`content_hash` verified at claim); any edit/regenerate/exclude/reorder invalidates the prior version; double-approve is idempotent; approving a stale draft (concurrent edit) fails.

Credits: reserve idempotency under concurrency; insufficient-credit fail-closed BEFORE provider contact; exactly-once settle under double-settle/webhook replay; ambiguous parks and never auto-retries; delayed settle lands on the original operation; shadow row can never mutate a balance (no write path exists).

Send machine: double-click launch, concurrent workers claiming the same attempt (one wins by CAS), crash after `provider_started` (-> ambiguous, no duplicate send), crash after accepted (receipt preserved), delayed writer fenced out after lease expiry, stuck-claim reclaim before provider contact, daily-cap boundary, send-window boundary.

Replies/races: email reply racing a scheduled send (stop wins; claimed attempt fenced); user-recorded social reply racing a send (same); unsubscribe racing a send; reply arriving for an already-stopped enrollment (idempotent); classification override; drafted response cannot send without approval.

Suppression: one-click header present on every GTM send; unsubscribe token tamper rejected; suppression added mid-campaign blocks at claim; duplicate-across-campaigns protection; legacy `email_unsubscribes` import respected.

Candidates: dedupe-key uniqueness under concurrent sourcing; hard criterion mismatch and exclusion cases reject; unknown hard criteria route to review; stale signals reject; accepted target stops later provider calls; poor-fit first-source rows trigger the next source lane; rejected candidates never promote; retention sweep deletes only expired never-promoted candidates and audits the deletion.

## 13. Cross-app boundaries owned elsewhere (pointers)

- Audience Plays import: hub calls `/internal/gtm/import-audience-play`; contract in GTM-SPEC-01 §3.1(6).
- Knowledge mirror: KB has **no document lock primitive** (verified net-new); lock semantics therefore live HERE - `gtm_icp_versions`/`gtm_voice_versions` immutable+locked rows are canonical, and KB receives read-only mirror notes via the existing `pkb_` agent-documents API tagged `source='gtm'`. A KB-side lock is not required for V1 and is not assumed.
- AMS assets: request/attach contract in blog-ops `docs/gtm-asset-handoff-contract-2026-07-23.md`; GTM stores only asset references, never regenerates AMS capability.
- COS orchestration: hermes-cos-control `docs/gtm-cos-orchestration-contract-2026-07-23.md`; the agent proposes, humans approve - the COS carries no capability to bypass §6/§7/§8 (it acts through the same internal routes with the same gates, mirroring the `cos_approvals` pending->approved->execute pattern in `apps/hub/src/lib/cos/approvals.ts`).

## 14. Later-tranche inventory for the CRM (identified now, NOT created in Tranche 0)

| Tranche | Artifact |
|---|---|
| 2 | Module scaffold `apps/mercato/src/modules/gtm/` (via `yarn mercato generate module gtm`); `data/entities.ts` with §4 catalog; **one generated migration set** via `yarn db:generate` (+ snapshot); `acl.ts`/`setup.ts`; workspace/ICP/voice/play CRUD routes (makeCrudRoute + commands); `/internal/gtm/import-audience-play` + workspace internal routes; fixture adapter skeleton |
| 3 | Source/qualification adapters + capability registry; research-run pricing/planning routes; candidate dedupe/fit/reject commands; evidence capture |
| 4 | Enrichment/verification adapters; §11.2 reserve-wrapped invoker; `gtm_provider_operations` writers; retention sweep worker |
| 5 | Campaign wizard routes; rendering pipeline; approval freeze command (+ invalidation); exclusion/cap/projection computation |
| 6 | Send-attempt scheduler/claimer worker; transport bridge onto `email-router`; RFC message-id generation; inbound GTM reply hook in `inbox-ingest`; one-click unsubscribe endpoint + headers; reply classification + response drafting; unified GTM inbox internal routes |
| 7 | Manual social task routes + connect-first dependency handling; AMS asset reference fields; KB mirror push |

Migration application to production remains a separately authorized manual psql step per repo convention; nothing in this spec authorizes it.

## 15. Risks and impact review

- **Plaintext mailbox/ESP credentials (§3.1)** predate GTM; GTM increases their blast radius. Mitigation queued as a cross-cutting hardening item (progress doc); GTM does not add new plaintext secret columns.
- **Registry/migration operational risk:** new module routes do not exist until a no-cache rebuild; migrations are manual. Both are existing repo invariants; every GTM tranche exit includes registry + schema verification.
- **Ambiguous-outcome inventory growth:** `ambiguous`/`reconciliation_required` rows require explicit operator evidence and canonical Noli Core reconciliation. C1 adds the protected boundary, but its flag-off local verification is not release authority or production reconciliation proof.
- **Residual:** exact reply correlation still depends on provider/RFC identifiers. Mailbox-and-counterparty fallback refuses ambiguity but cannot eliminate unmatched mail; unmatched confidence remains visible and causes no stop side effect.

## 16. C1 inert lifecycle closeout (approved 2026-08-17)

### 16.1 Extension and release decision

C1 remains an app-level `apps/mercato/src/modules/gtm` module extension. It does not move GTM into Open Mercato core. Existing CRM routes, status values, fields, and imports remain valid; CRM database work is additive and generator-owned. The coordinated Noli Core change is one additive service-role-only canonical reconciliation RPC and decision binding. C1 authorizes local implementation and local commits only. Provider access, email transport, shared or production migrations, flags, deployment, prospect data, and customer exposure remain separately gated.

### 16.2 Sequence, sender, and capacity contract

- Every automated email step has its own authored artifact. The model receives the frozen step order, purpose, prior-step summaries, and approved evidence; the stored subject/body/content hash must be step-specific. Identical normalized bodies across two automated steps fail approval.
- Generated email bodies are deterministically bounded to 130 words and replies to 120 words. A model or template result outside the bound is degraded or rejected, never silently presented as approved-quality work.
- Approval binds recipient contact-point id and normalized-address hash; mailbox id, provider kind, normalized from address, owning user, purpose, connection-update version and fingerprint; postal footer; unsubscribe mode; campaign/version/step; and each rendered content hash. The current EmailConnection contract has no separate reply-to/display-name/health-generation fields, so C1 does not claim them.
- Claim-time execution revalidates the frozen sender envelope and recipient address. Any drift fails closed before `provider_started`.
- Scheduling allocates mailbox capacity by local business day and send window. Capacity exhaustion reschedules to the next eligible window rather than failing an attempt. Claim-time capacity is reserved with a durable slot key so concurrent workers cannot exceed the mailbox/day limit.

### 16.3 Provider reconciliation contract

- `gtm_provider_reconciliation_actions` is tenant-scoped with immutable decision identity and a one-way pending-to-completed/rejected lifecycle. It records a unique operator idempotency key, expected canonical status, decision, evidence hash, redacted evidence, actor, and resulting canonical status.
- A local shadow never changes balance truth. Resolving an actionable operation calls the atomic `provider_op_reconcile` RPC on the original Noli Core operation with the full decision/evidence/audit/timestamp binding. A reserved operation may be explicitly released; a proven no-charge post-start outcome settles as `refunded` with zero credits. Missing or contradictory evidence remains unresolved.
- Repeated decisions with the same key return and reverify the canonical recorded result; conflicting decisions, amounts, evidence, actors, timestamps, or stale expected states fail closed. Canonical success is recorded before the local action is finalized.

### 16.4 Durable inbound and delivery contract

- `gtm_mailbox_cursors` stores per-mailbox provider cursor metadata, cursor hash, optional tenant-encrypted sealed cursor, and a fenced lease. Cursor advancement is compare-and-set and monotonic; a losing/replayed worker cannot skip or regress events.
- `gtm_inbound_events` is the dedupe and evidence boundary for replies, delivered, hard-bounce, complaint, out-of-office, and auto-reply events. The durable key binds organization, tenant, mailbox, provider and provider-event identity; evidence is redacted and body content stays in `email_messages`.
- Event disposition is determined before enrollment stop. Human replies stop atomically and may be classified/drafted. Hard bounces and complaints suppress and stop without creating a reply draft. Out-of-office and auto-reply events do not masquerade as human replies; they defer eligible future attempts and never create a CTA draft.
- Correlation persists `exact_header`, `provider_message_id`, `mailbox_counterparty`, or `unmatched` confidence. Low-confidence fallback never binds when more than one live enrollment is eligible.

### 16.5 Removal, retention, DSR, and key rotation contract

- `gtm_deletion_requests` is the durable removal lifecycle. It records only normalized hashes and redacted scope, tracks legal hold, and is idempotent per request key.
- Local execution anonymizes/deletes reachable candidate, evidence, contact-point, rendered-message, reply, and chat payload data while retaining the minimum suppression hash, count-only audit, immutable money/approval evidence required by policy, and records blocked legal-hold rows explicitly.
- `gtm_dsr_operations` tracks one idempotent provider/local erasure operation per deletion request and adapter. Unsupported provider deletion is an explicit `not_supported`/owner-review outcome, not success. Retries retain receipts and never call a provider without separate provider authority.
- Unsubscribe tokens carry a key id. A configured keyring verifies current and retained prior keys; legacy single-secret tokens remain verifiable during the documented bridge. Rotation never invalidates a still-valid issued token merely because the active signing key changed.

### 16.6 Additive API operations

- Execution adds inert mailbox-event reconciliation operations and cursor status without enabling a mailbox provider call.
- Inbox responses expose event kind and correlation confidence additively.
- A protected reconciliation endpoint lists ambiguous provider shadows and applies an exact, idempotent operator decision.
- Removal status exposes deletion/DSR state by opaque request id; it never returns an address or provider credential.

### 16.7 C1 acceptance gates

- Three email steps produce three materially distinct bodies and hashes; repeat generation with one idempotency key does not re-meter.
- Sender/from/reply-to/footer/recipient/credential-generation drift fails before provider contact; concurrent claims cannot exceed mailbox/day capacity; exhausted capacity reschedules.
- Ambiguous provider operation settles exactly once from authoritative evidence; stale/conflicting decisions fail; zero-charge requires an explicit refunded receipt.
- Cursor lease overlap, restart at each boundary, duplicate provider event, cursor regression, ambiguous fallback, and event replay cannot skip, duplicate, or misbind an inbound event.
- Human reply, bounce, complaint, OOO, and auto-reply each take their distinct stop/suppress/defer/draft path.
- Removal is idempotent, preserves suppression, respects legal hold, anonymizes the local graph, and records provider DSR unsupported/retry/receipt truthfully.
- Current-main full migrations plus the generated GTM migration apply on an empty disposable database; a second migrate and generator run report no drift.
- Unit, route-contract, module typecheck, whole-repository typecheck, lint, and diff checks pass with all external adapters and transports faked or disabled.

### 16.8 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| C1-A - Sequence/sender/capacity | Done locally | 2026-08-17 | Distinct step artifacts, exact approval binding, mailbox lock + durable local-day slots; execution remains hard-off |
| C1-B - Provider reconciliation | Done locally | 2026-08-17 | Full canonical decision binding and operator evidence; no provider calls |
| C1-C - Durable inbound/delivery | Done locally | 2026-08-17 | Fenced cursor/event/reply fixtures only; no mailbox provider ingestion enabled |
| C1-D - Removal/DSR/key rotation | Done locally | 2026-08-17 | Local graph anonymization and explicit unsupported/blocked DSR states; no live DSR calls |
| C1-E - Migration/eval/closeout | Done locally | 2026-08-17 | Empty disposable CRM migration/reapply/no-drift plus disposable Noli RPC exact-replay rehearsal |

## 17. C2 dark mailbox lifecycle (approved 2026-08-17)

### 17.1 Extension and release decision

C2 continues the app-level `apps/mercato/src/modules/gtm` extension selected for C1. It adds no Open Mercato core contract and does not create a provider marketplace package. Gmail and Microsoft are implementations of the already-qualified per-user `email_connections` mailbox seam, not new sourcing providers. Existing SMTP, API, route, state, ACL, and import surfaces remain valid.

C2 authorizes local implementation, deterministic tests, disposable PostgreSQL concurrency tests, generated CRM migration artifacts, local recovery patches, and local commits only. `GTM_EXECUTION_ENABLED`, the new `GTM_MAILBOX_INGESTION_ENABLED`, every sourcing-provider gate, and customer exposure remain off. No real mailbox/provider call, email send, shared migration, deployment, secret inspection, or production mutation is authorized.

### 17.2 Gmail and Microsoft transport contract

- One validated MIME builder freezes the approved `From`, `To`, `Subject`, `Message-ID`, `List-Unsubscribe`, `List-Unsubscribe-Post`, text, and HTML parts. It rejects CR/LF header injection, malformed message IDs, and provider/header drift before dispatch.
- Gmail sends the RFC message as base64url in the `users.messages.send` `raw` field. Microsoft Graph sends the same RFC message as base64 MIME with `Content-Type: text/plain` to `/v1.0/me/sendMail`. Graph's `202 Accepted` is recorded as provider acceptance without inventing a provider message id; the pre-persisted RFC Message-ID remains the correlation key.
- Both transports accept an injected HTTP client for deterministic tests. They classify an observed 4xx validation/auth response as a known failure. A timeout, aborted connection, 408, 429, or 5xx after dispatch is an unknown outcome and therefore `ambiguous`, never auto-retried.
- OAuth access tokens are read only inside the gated transport. If a stored access token is near expiry, C2 may obtain a transient access token from the official token endpoint using the existing refresh token, but it does not mutate the mailbox connection or log/store any token. This avoids making routine access-token rotation invalidate the frozen sender envelope.
- Historical mailbox labels `outlook` and `microsoft` both resolve to the Microsoft Graph adapter. SMTP remains available through the existing C1 transport. No ESP/Resend transport is added for GTM outreach.

Official protocol sources checked 2026-08-17: Google Gmail raw MIME send and history-list documentation, and Microsoft Graph v1.0 MIME sendMail and inbox-message delta documentation.

### 17.3 Incremental mailbox ingestion contract

- Gmail consumes `users.history.list` pages after the sealed history id, fetches only referenced added inbox messages, and advances to the returned mailbox history id only after the page's messages and GTM dispositions commit. An expired/invalid history id (HTTP 404) sets `resync_required`; C2 never performs an unbounded full sync automatically.
- Microsoft consumes the exact opaque `@odata.nextLink` until a page returns `@odata.deltaLink`; only the final delta link becomes the durable next-round cursor. Every cursor URL must be HTTPS on `graph.microsoft.com` and stay within `/v1.0/me/mailFolders/inbox/messages/delta`; arbitrary URLs and path changes fail closed.
- Provider pages normalize only the message id, RFC/thread references, sender/recipient, subject, bounded text/HTML, event hints, and timestamps required by the C1 inbound-event pipeline. OAuth tokens and raw provider cursors never enter message metadata, logs, diagnostics, or audit events.
- Queue `gtm-mailbox-ingest` processes one explicit organization/tenant/mailbox job at concurrency five. The handler re-resolves the fully scoped active mailbox, acquires the C1 fenced cursor lease, fetches one bounded page, persists deduped inbound mail/events, runs dispositions, then atomically advances or fails the cursor. Retry is idempotent.
- The worker refuses all provider IO unless `GTM_MAILBOX_INGESTION_ENABLED === 'true'`. Fixture clients remain available when the gate is off; no scheduler, webhook subscription, Pub/Sub watch, or Graph subscription is enabled by C2.

### 17.4 Mailbox reputation and operator diagnostics

- New `gtm_mailbox_health` is unique per organization/tenant/mailbox and stores only policy version, status (`healthy|warning|paused`), bounded counters, rolling-window start, pause reason/until, last event, and a fence. It stores no credential or message content.
- Health is evaluated from the tenant-scoped durable send/event history in a seven-day window. One complaint pauses indefinitely; three hard bounces pause, and a hard-bounce rate of at least five percent pauses once at least twenty accepted/delivered outcomes exist. Five soft bounces or a fifteen-percent soft-bounce rate at the same minimum volume creates a 24-hour pause. Delivery does not erase an existing complaint pause.
- The send machine rechecks health under the mailbox lock immediately before `provider_started`. A temporary pause reschedules at or after `pause_until`; an indefinite complaint pause returns a non-sending blocked outcome. No automatic resume weakens an indefinite pause.
- Existing protected internal routes add redacted, tenant-scoped diagnostics for mailbox health/cursor state, send outcomes, provider-operation yield/ambiguity/reconciliation state, and observational AI use. Responses expose counts, bounded reason codes, hashes, and timestamps, never prospect content, provider rows, cursor values, or secrets.

### 17.5 GTM AI telemetry and AUG-04 quality contract

- New `gtm_ai_telemetry` is observational, not a balance or invoice. A unique operation key makes retries idempotent. It stores surface, model, actual provider input/output tokens, estimated component breakdown (system, tool schema, history, evidence, provider rows, durable summary), latency, retries, success/failure, bounded failure code, optional configured rate-card version, optional estimated micro-USD, and request id. No prompt, model output, evidence text, provider row, or secret is stored.
- Cost remains null unless an explicit versioned local rate card is configured. Noli Core remains the only canonical customer credit ledger. Telemetry failure cannot authorize or hide a model call; route-level metering and the local receipt are both awaited.
- A versioned deterministic GTM quality harness covers Audience Play/lead-magnet structure, qualification explanations, research plans, multi-step outreach, reply drafts, and failure honesty. Hard safety for tenant/scope leakage, opt-out, unsupported claims/promises, credential leakage, insufficient evidence, and wrong-recipient handling takes precedence over a numeric score.
- Checked-in fixtures are synthetic. Threshold or baseline changes require an intentional rubric-version change and recorded delta; a dry-run fixture does not claim current provider/model quality.

### 17.6 Additive data model and API contract

`GtmMailboxHealth` adds table `gtm_mailbox_health`; `GtmAiTelemetry` adds table `gtm_ai_telemetry`. Both use the standard UUID, organization, tenant, timestamps, soft-delete, and composite index contract. Existing entities receive only nullable/defaulted fields if generation proves them necessary. One generator-owned GTM migration and synchronized snapshot are required; no CRM migration is handwritten.

Execution gains additive operations for one gated mailbox-ingestion page and mailbox diagnostics. Reconciliation gains an additive provider-history operation. AI-using routes write telemetry through an injected awaited sink. All inputs are additive Zod schemas in `data/validators.ts`, every query binds organization and tenant, and existing response fields remain present.

### 17.7 C2 acceptance gates

- Gmail and Graph fixture requests contain the exact approved RFC Message-ID and RFC 8058 headers; Graph uses MIME and never invents a provider id. Known failure and ambiguous outcome fixtures take distinct terminal paths.
- Gmail history pagination/replay/404 and Graph next/delta/replay/foreign-URL cases cannot skip, duplicate, regress, or exfiltrate cursor state.
- Local and async queue-strategy handler contracts are retry-idempotent with a network-denied fixture client.
- Complaint, hard-bounce, soft-bounce, delivery, pause expiry, and concurrent reputation updates produce deterministic health and block/reschedule behavior.
- Provider/mailbox/AI diagnostics are tenant-isolated and redact message, cursor, provider-row, and credential content.
- Telemetry exact replay produces one receipt; success, parse failure, provider failure, and retry record honest tokens/latency/status without changing customer credit truth.
- The versioned GTM quality fixtures pass hard-safety and threshold checks; intentional adversarial mutations fail the expected criterion.
- Disposable PostgreSQL races prove one capacity claim, one cursor-page advancement, one inbound-event side effect, and one mailbox pause decision under concurrency.
- Current-main plus C0/C1/C2 generated migrations apply to an empty disposable database; second migrate/generate reports no GTM drift.
- Full unit, route-contract, queue-handler, typecheck, lint, build, contract, security, diff, and original-custody checks pass with network denied.

### 17.8 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| C2-A - MIME/OAuth transports | Completed locally | 2026-08-17 | Gmail/Graph/SMTP fixture coverage only; execution gate remains off |
| C2-B - Incremental ingestion worker | Completed locally | 2026-08-17 | Message, disposition, and sealed cursor commit atomically; separate ingestion gate remains off; no scheduler/subscription |
| C2-C - Reputation and diagnostics | Completed locally | 2026-08-17 | Send-time mailbox pause and bounded/redacted provider/cursor/health diagnostics |
| C2-D - Telemetry and quality | Completed locally | 2026-08-17 | Awaited observational success/failure receipts and synthetic versioned CRM/Noli fixtures only |
| C2-E - PostgreSQL races and closeout | Completed locally | 2026-08-17 | Full migration apply/reapply and four disposable PostgreSQL race/atomicity cases; no shared database touched |

### 17.9 Integration scenarios

- `TC-GTM-C2-001`: Gmail page replay and worker retry preserve one email/event/disposition and advance the cursor once.
- `TC-GTM-C2-002`: Graph next-link replay and final delta-link restart preserve order and reject foreign cursor URLs.
- `TC-GTM-C2-003`: concurrent capacity claim, inbound reply, and complaint pause prevent a later provider dispatch.
- `TC-GTM-C2-004`: non-admin diagnostics are view-only, cross-tenant ids are opaque, and every response remains redacted.
- `TC-GTM-C2-005`: telemetry replay and failure paths produce one observational receipt and do not change the Noli Core ledger shadow.

## 18. C3 dark operator controls and telemetry truth (approved 2026-08-17)

### 18.1 Extension and release decision

C3 closes the operator-control gaps left by C2 without enabling a customer release. It adds only protected, tenant-scoped control and diagnostic surfaces: an explicit fenced mailbox-pause clear, an explicitly requested asynchronous mailbox-ingestion enqueue, and bounded observational AI telemetry diagnostics. `GTM_EXECUTION_ENABLED`, `GTM_MAILBOX_INGESTION_ENABLED`, every provider adapter, customer exposure, and all shared or production schema remain off and separately authorized.

### 18.2 Mailbox pause recovery contract

- A pause can be cleared only through a registered command invoked by a represented user with `gtm.launch`.
- The command locks the exact `(organization_id, tenant_id, mailbox_connection_id)` health row and requires the operator to echo its current `fence`. A stale fence, foreign row, inactive mailbox, or non-paused row fails closed and does not mutate state.
- The command records a bounded operator reason in the command audit log but does not store credentials, recipient data, message content, or raw provider responses.
- A successful clear changes `paused -> warning`, clears the active pause reason/time, increments the fence, and leaves the rolling counts intact. A later refresh or new complaint/bounce may immediately pause the mailbox again; clearing is never a policy exemption.

### 18.3 Manual mailbox-ingestion enqueue contract

- A protected execution operation may enqueue one exact active Gmail, Microsoft/Outlook, IMAP, or SMTP mailbox for the represented organization and tenant. Unsupported, inactive, foreign, or deleted mailboxes are opaque.
- Enqueue requires both `GTM_MAILBOX_INGESTION_ENABLED === 'true'` and `QUEUE_STRATEGY === 'async'`. When either is absent, no queue is constructed and no job is written.
- The operation places only `{organizationId, tenantId, mailboxConnectionId, requestedByUserId}` on `gtm-mailbox-ingest`; credentials are never loaded by the route or placed in the job. The worker re-resolves the connection and credentials under the same scope.
- Enqueue is an operator request, not evidence that ingestion or provider access succeeded. It returns only the opaque queue job id and never calls a mailbox provider inline.

### 18.4 AI token-usage truth and diagnostics contract

- Every GTM AI receipt carries `token_usage_known`. Provider exceptions before an authoritative usage response set it false; successful provider responses and local validation failures after a response set it true. Zero tokens with `token_usage_known=false` means unknown, never free.
- Estimated cost is null when token usage is unknown or the configured versioned rate card is incomplete. Telemetry remains observational and cannot alter Noli Core credit truth.
- A `gtm.view` diagnostic operation returns bounded, tenant-scoped aggregates by surface/model/status: operations, known/unknown usage counts, known input/output tokens, failed operations, retries, latency, configured estimated cost, and a truncated-window marker. It returns no prompts, completions, evidence, provider rows, operation keys, request ids, or credential material.

### 18.5 Additive schema and compatibility

- Add `gtm_ai_telemetry.token_usage_known boolean NOT NULL DEFAULT true` with a generator-owned migration and synchronized snapshot.
- Existing C2 receipts remain truthful under the default because all committed C2 success/local-validation paths had authoritative model responses; only new provider-exception writes explicitly store false.
- Existing API operations and response fields remain unchanged. The new execution and reconciliation operations are additive.

### 18.6 C3 acceptance gates

- Unit and route-contract tests prove RBAC separation, tenant opacity, gate-before-queue behavior, supported-provider validation, queue close on success/failure, pause-clear fencing, and re-pause behavior.
- Telemetry tests prove unknown usage cannot acquire a cost, diagnostics are bounded/redacted, duplicate operation receipts remain idempotent, and known tokens aggregate without content.
- A disposable PostgreSQL database applies current-main plus C0/C1/C2/C3 migrations, re-applies with no pending migration, and proves stale pause-clear fences and telemetry uniqueness/usage truth under real constraints.
- Full GTM, typecheck, lint, build, generated-contract, security, diff, and custody checks pass with external effects disabled.

### 18.7 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| C3-A - pause recovery command | Completed locally | 2026-08-17 | Fenced, audited, launch-authorized operator action; no policy exemption |
| C3-B - manual ingestion enqueue | Completed locally | 2026-08-17 | Async queue only; separate ingestion gate remains off by default |
| C3-C - telemetry truth and diagnostics | Completed locally | 2026-08-17 | Observational, bounded, content-free, canonical ledger unchanged |
| C3-D - migration and closeout | Completed locally | 2026-08-17 | Generator-owned migration; 63 suites/684 unit tests and 6/6 disposable PostgreSQL cases |

### 18.8 Integration scenarios

- `TC-GTM-C3-001`: a launch-authorized operator clears exactly the paused mailbox at the echoed fence; stale, foreign, inactive, and replayed clears do not mutate it.
- `TC-GTM-C3-002`: an operator clear restores only a warning state; the next complaint refresh re-latches an indefinite pause before provider dispatch.
- `TC-GTM-C3-003`: ingestion gate-off and local-queue configurations construct no queue; gate-on async mode enqueues one scoped credential-free payload and closes the queue.
- `TC-GTM-C3-004`: provider failure records unknown token usage and null cost; known local-validation failure records authoritative tokens; diagnostics expose aggregates only.
- `TC-GTM-C3-005`: non-launch users cannot enqueue or clear, view users can read redacted diagnostics, and cross-tenant mailbox ids remain opaque.

## 19. C4 campaign control and canonical mailbox capacity (approved 2026-08-17)

### 19.1 Safety decision

C4 closes two local release blockers without enabling execution: a user with `gtm.launch` needs durable pause/resume/stop controls, and one mailbox must not apply conflicting campaign-local daily-cap or timezone policies. These controls are enforced in CRM state and remain reachable only through the existing dark internal execution surface. They do not grant mailbox, provider, send, migration, deployment, or customer authority.

### 19.2 Canonical mailbox policy

- Add one `gtm_mailbox_policies` row per `(organization_id, tenant_id, mailbox_connection_id)` with policy version, daily cap, send-window hours, timezone, fence, and the first binding campaign version.
- The first launch under the locked mailbox binds the canonical policy from the exact approved envelope. Every later approval, launch, scheduling allocation, and send-time provider-start boundary must match it exactly or fail closed with `mailbox_policy_conflict`.
- Capacity slot keys continue to bind mailbox + canonical local day + ordinal. Because every campaign on that mailbox uses one timezone and daily cap, different campaigns cannot manufacture independent local days or larger ordinal ranges.
- Add a mailbox/state/scheduled-time index for bounded capacity scans. The policy is additive and inert; C4 adds no API for widening it. A future policy change requires a separately designed fenced migration of pending schedules and approvals.

### 19.3 Campaign lifecycle commands

- `pause-campaign`, `resume-campaign`, and `stop-campaign` require `gtm.launch`, the exact current campaign id, and the exact approved content hash.
- Every command pessimistically locks the campaign, revalidates org/tenant/version/hash, is idempotent only when the requested target state already holds with the same version, and writes a bounded command audit.
- Pause changes `active -> paused`, moves not-started `approved` and `claimed` attempts to `paused`, clears claims/capacity reservations, and increments their fences. A `provider_started` attempt is never rewritten or presented as cancelled.
- Resume changes `paused -> active`, returns paused attempts to `approved` with no capacity reservation, and lets the send-time canonical allocator choose a current valid slot.
- Stop changes `approved|active|paused -> stopped`, stops active enrollments with `campaign_stopped`, and fails every not-started attempt. Provider-started/terminal/ambiguous truth is preserved for reconciliation.
- Immediately before `provider_started`, the send transaction takes a read lock on the campaign and rechecks `active`, current version/hash, and canonical mailbox policy. If pause/stop won the lock race, transport is never contacted; if provider-start won, the later lifecycle command preserves that in-flight truth.

### 19.4 C4 acceptance gates

- Unit tests prove exact hash binding, RBAC, state/idempotency rules, pause/resume/stop transitions, fence invalidation, enrollment stop, and preservation of provider-started rows.
- Deterministic race tests prove pause/stop before provider-start prevents the injected transport and a stale claimed writer is fenced out.
- Real PostgreSQL proves one canonical policy row and one mailbox-local capacity namespace under concurrency.
- The generator emits only the new policy table/index and the capacity-scan index; full current-main+C0-C4 migrations apply/reapply with no GTM drift.

### 19.5 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| C4-A - canonical mailbox policy | Completed locally | 2026-08-18 | First-launch binding; immutable in C4 |
| C4-B - campaign lifecycle commands | Completed locally | 2026-08-18 | Pause/resume/stop only; execution stays dark |
| C4-C - race and migration proof | Completed locally | 2026-08-18 | Deterministic plus seven disposable PostgreSQL cases |

## 20. C5 truthful campaign completion (approved 2026-08-18)

### 20.1 Completion contract

- `complete-campaign` requires `gtm.launch`, the exact current campaign id, and the exact approved content hash. It shares the C4 pessimistic campaign lock and command audit boundary.
- Only `active -> completed` is legal. A paused, stopped, draft, invalidated, or stale-envelope campaign fails closed; an exact replay of an already-completed current envelope is idempotent.
- Every current-version automated-email attempt must be definitive: `accepted|delivered|bounced|complained|replied|failed`. Pre-dispatch, claimed, `provider_started`, and `ambiguous` states block completion. An accepted provider handoff counts as send completion even if a later delivery event refines it.
- For every active enrollment and every current-version manual-social step, the derived task row must contain the explicit user-recorded terminal state `task_sent` or `task_skipped`. Missing, requested, accepted, or locked tasks remain incomplete. Stopped enrollments keep their stopped truth and do not manufacture task outcomes.
- A successful transaction changes active enrollments to `completed`, changes the campaign to `completed`, and records bounded counts. No attempt, provider receipt, reply, stopped enrollment, or suppression truth is rewritten.

### 20.2 C5 acceptance gates

- Strict validator and RBAC tests prove no privilege expansion or force field.
- Deterministic lifecycle tests prove incomplete email/manual work and ambiguous outcomes cannot complete, while a fully terminal exact envelope transitions once and replays idempotently.
- C5 adds no schema or migration. The complete GTM, TypeScript, lint, build, migration-replay, generator-drift, and security gates must remain green with execution, ingestion, providers, and exposure off.

### 20.3 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| C5-A - exact completion service | Completed locally | 2026-08-18 | Code/test/spec only; no schema |
| C5-B - complete validation and freeze | Completed locally | 2026-08-18 | 65 suites/694 deterministic tests; TypeScript, lint, and diff checks green; all external-effect gates remain off |

## 21. C6 hard-gated execution queue target (approved 2026-08-18)

### 21.1 Queue contract

- Register `gtm-execution-tick` as a queue target only. C6 does not create a scheduler row, recurring job, provider subscription, deployment, or flag change.
- The worker returns before payload validation, ORM/dependency resolution, claiming, or transport construction unless both `GTM_ENGINEER_ENABLED=true` and `GTM_EXECUTION_ENABLED=true`.
- The payload requires exact organization, tenant, and requesting-user UUIDs, accepts the scheduler-injected `_idempotencyKey`, and caps each tick at 100 attempts.
- Enabled processing first parks lease-expired `provider_started` rows as ambiguous, then reuses the existing DB-time CAS claim, fencing, exact approval/sender/suppression/capacity checks, and mailbox transport. Ambiguous rows are never retried. Attempts execute sequentially so one queue job cannot manufacture parallel pressure on a mailbox.
- Multi-worker safety remains a database claim/fence property; queue concurrency is one per worker process and does not replace the canonical mailbox policy.

### 21.2 C6 acceptance gates

- Deterministic tests prove metadata, both-gates-first behavior, no dependency or payload access while dark, exact scope/limit forwarding, and sequential outcomes with an injected transport.
- C6 adds no schema or migration. No schedule may be created and no real transport may be exercised during validation.

### 21.3 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| C6-A - queue contract and dark worker | Completed locally | 2026-08-18 | No schedule, schema, provider, or mailbox effect |
| C6-B - complete validation and freeze | Completed locally | 2026-08-18 | 66 suites/702 deterministic tests; TypeScript, lint, and diff checks green; all external-effect gates remain off |

## 22. C7 bounded Strategist context (approved 2026-08-18)

### 22.1 Persistence and read bounds

- CRM rejects a chat content object whose serialized UTF-8 representation exceeds 64 KiB. The internal route validator and chat store both enforce the same shared constant, so a direct service caller cannot bypass the boundary.
- Thread message reads select the newest requested window and return it in chronological order. The default and hard maximum are 200 rows; Hub requests its smaller model-context window.
- Durable history is not deleted, summarized, or rewritten by this limit. Older rows remain available to a separately designed paginated archive surface.

### 22.2 Model-context and tool bounds

- Each turn uses at most 24 prior user/assistant rows, 8,000 characters per row, and 32,000 prior-history characters total. The current user message remains capped at 20,000 characters.
- Tool results are framed as untrusted data and capped at 8,000 characters. Across the existing maximum six model iterations, at most eight model-requested tools may execute. Excess requests receive an explicit non-executing `tool_limit_reached` event.
- The final assistant text is capped at 20,000 characters before persistence. C7 does not add a summarizer call, change the model, or alter token metering; actual provider token usage remains the observational truth.

### 22.3 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| C7-A - CRM persistence/read bounds | Completed locally | 2026-08-18 | Code/test/spec only; no schema |
| C7-B - Hub model/tool bounds | Completed locally | 2026-08-18 | Deterministic fake-model coverage; no model or provider call |
| C7-C - complete validation and freeze | Completed locally | 2026-08-18 | CRM 66 suites/704 tests; Hub 919 top-level/1,105 total tests; TypeScript, lint, builds, and diff checks green |

## 23. R2 synthetic no-send activation rehearsal (approved 2026-08-19)

### 23.1 Release gate

R2 adds one executable, disposable integration scenario that exercises the real CRM route, identity, tenancy, authorization, persistence, pricing, qualification, enrichment, immutable approval, scheduling, and execution-gate boundaries. It does not contact Noli Core, a sourcing or verification provider, a mailbox provider, or an email transport. It does not use shared services, customer or prospect data, credentials, or a production database.

The harness starts a loopback-only, read-only synthetic Noli identity/entitlement service and enables the deterministic fixture source, enrichment, verification, and ledger only when both `OM_TEST_MODE=1` and the explicit fixture gate are present. Production deployment manifests fail security validation if test mode or fixture execution is configured. Every real provider flag remains false, mailbox ingestion remains false, and `GTM_EXECUTION_ENABLED` remains false.

### 23.2 Acceptance scenario

- `TC-GTM-001`: an unauthorized import is rejected; an authorized synthetic Audience Play import and exact replay resolve one durable workspace/play; stale research plan hashes fail; the confirmed plan sources, qualifies, and enriches at least one verified synthetic person; stale campaign approval fails; exact approval freezes recipient, sender, footer, step, and content truth; launch materializes scheduled attempts; execution tick reports `dry_run=true`; and every attempt remains approved with no transport dispatch.
- The scenario runs against a freshly migrated disposable PostgreSQL database and cleans its synthetic GTM, mailbox, and represented-user state.
- A newly created workspace and play must have application-visible UUIDs before the first flush, so the first import can bind the play to its workspace transactionally. Exact replay remains idempotent.

### 23.3 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R2-A - isolated identity/fixture harness | Completed locally | 2026-08-20 | Loopback/read-only/synthetic; production manifests reject fixture posture |
| R2-B - audience-to-launched no-send scenario | Completed locally | 2026-08-20 | Fresh PostgreSQL; no provider, mailbox, transport, or shared-service call |
| R2-C - first-import persistence correction | Completed locally | 2026-08-20 | Workspace/play UUIDs are assigned before first flush; replay remains exact |

## 24. R3 Gemini 3.7 drafting contract (approved 2026-08-20)

### 24.1 Runtime and usage truth

- GTM voice, campaign-message, and reply drafting use the GA `gemini-3.7-flash` model. This changes no non-GTM CRM AI surface.
- Drafting uses low thinking for bounded-latency writing work, keeps structured JSON output and the existing 4,000-token response ceiling, and sends none of the deprecated `temperature`, `top_p`, `top_k`, or thinking-budget controls.
- Provider output usage is `candidatesTokenCount + thoughtsTokenCount`; usage remains authoritative only when prompt and candidate counts are present. Thought parts are excluded from customer-visible JSON.
- Observational cost remains null unless operators configure an explicit rate version plus both rates. The documented introductory standard rates are `$0.75 / 1M` input and `$3.75 / 1M` output through 2026-12-31 and must be revalidated before activation.

### 24.2 Acceptance and release posture

- Network-free tests freeze the default model id, low thinking level, deprecated-field absence, thought filtering, thinking-token accounting, known/unknown usage behavior, and HTTP failure honesty.
- This is a dark code change only. It does not enable GTM, execution, mailbox ingestion, a provider adapter, a model call, or customer exposure.

## 25. R4 owned-mailbox activation rehearsal (approved 2026-08-20)

### 25.1 Authority and isolation

- R4 may send exactly one campaign email from a user-owned Gmail mailbox to one user-owned Yahoo or Proton mailbox and ingest exactly one user-authored reply. This two-message ceiling is a hard stop, not a batch size.
- The rehearsal runs only in a fresh loopback-only application and disposable PostgreSQL database. Production GTM remains dark; no shared-live lane, customer/prospect identity, production row, deployment flag, provider adapter, or paid sourcing call is used.
- Mailbox credentials are entered by the owner into a loopback-only form, held only in process memory and the disposable database, never written to source, command history, logs, screenshots, traces, or test artifacts. The form submission is the action-time confirmation for the one outbound message.
- All sourcing, enrichment, verification, and ledger activity remains deterministic fixture-only. The verified recipient contact point is replaced with the explicitly supplied owned recipient only inside the disposable rehearsal.
- The harness is inert by default and requires `OM_GTM_OWNED_MAILBOX_E2E_ENABLED=1`. Normal CI and the standard integration command must skip it.

### 25.2 Personal-inbox privacy boundary

- A first IMAP cursor page establishes a metadata-only baseline at the mailbox's current `UIDVALIDITY` and highest allocated UID. It fetches and persists no historical message body, subject, sender, or recipient.
- Only messages assigned a later UID are eligible after the baseline. The owner should use a dedicated or quiet Gmail inbox and reply immediately; any unrelated mail arriving inside that narrow window remains out of scope and aborts the rehearsal rather than being treated as GTM evidence.
- Gmail API history and IMAP baselines have equivalent no-history semantics. Cursor advancement remains sealed, scoped, monotonic, and transactional.

### 25.3 Acceptance and cleanup

- `TC-GTM-002`: the harness proves one exact approved sender/recipient/footer/step/content envelope, one SMTP acceptance receipt and RFC Message-ID, one reply bearing the expected correlation header, durable inbound cursor advancement, exact reply correlation, and the transactionally coupled enrollment stop. Suppression, reputation, unsubscribe execution, and metering remain separate acceptance surfaces.
- Before dispatch, the harness verifies one recipient, one due attempt, execution enabled only in the disposable process, and a zero send counter. It refuses any replay after the counter reaches one.
- Cleanup runs in `finally`: the disposable application, fixture identity service, and database container stop; the in-memory credential object is released; no recovery patch or artifact may contain an address or secret.

### 25.4 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R4-A - no-history IMAP baseline | Completed | 2026-08-20 | Metadata-only first cursor; no historical message parsing |
| R4-B - guarded owned-mailbox harness | Completed | 2026-08-20 | Loopback form, explicit confirmation, no retries, disposable DB only |
| R4-C - controlled lifecycle evidence | Completed | 2026-08-20 | Gmail SMTP accepted delivery to owned Yahoo; exact-header Yahoo reply produced one cursor, inbound event, reply, and atomic `email_reply` stop |

## 26. R5 disposable public-unsubscribe integration (approved 2026-08-20)

### 26.1 Scope and safety boundary

- R5 closes the remaining credential-free route-integration gap for the public GTM unsubscribe endpoint. It adds no product API, entity, migration, worker, provider adapter, mailbox capability, or production configuration.
- The standard disposable integration runtime supplies a deterministic, test-only v2 unsubscribe keyring and its loopback public base URL. The runtime already requires `OM_TEST_MODE=1`, uses a freshly migrated disposable PostgreSQL database, disables real email delivery, keeps execution and mailbox ingestion off, and keeps every real provider off.
- The test creates its own synthetic Audience Play, research, enrichment, mailbox identity, campaign, approval, enrollment, and attempts through the real internal routes. It contains no customer/prospect identity and contacts no external provider or transport.

### 26.2 Acceptance scenario

- `TC-GTM-003`: a tampered v2 token is opaque; a valid token renders the public confirmation form with `List-Unsubscribe=One-Click`; the public POST atomically creates one org-scoped suppression, stops the exact enrollment with `stop_reason='unsubscribe'`, cancels every not-yet-contacted attempt, and writes one audit event; exact replay remains 200 and creates no duplicate side effect.
- The scenario cleans all synthetic GTM and mailbox rows after the test. Normal integration teardown removes the application and database.
- This proves the real HTTP handler plus durable database effects in isolation. It does not prove production key custody/rotation, a mailbox provider's external HTTPS POST, or prospect-outreach compliance; those remain activation evidence gates.

### 26.3 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R5-A - disposable keyring/base URL | Completed locally | 2026-08-20 | Test runtime only; production manifests remain unchanged |
| R5-B - public GET/POST lifecycle | Completed locally | 2026-08-20 | Real route and disposable PostgreSQL; TC-GTM-003 passed; no external effect |

## 27. R6 selected provider routing (approved 2026-08-21)

### 27.1 Selected stack

- DataForSEO is the selected provider for US local-company and location discovery. Eligibility still requires its credential, enable switch, customer-use approval, frozen terms and price versions, and the reviewed 30-day provider-retention contract.
- Apify is the selected provider for separately eligible public social-signal sourcing and profile enrichment. Every actor remains independently gated by the existing Apify customer-use, frozen terms, frozen price, invoice/spend-cap, and capability checks.
- LeadMagic and Bouncer are owner-excluded from the active product plan. Their historical adapter source and network-free contract tests may remain for custody and future comparison, but no production or development runtime registry may select them from environment configuration.
- R6 selects no independent real-email verifier. Deterministic fixture verification remains restricted to the isolated test harness. A future verifier requires a new explicit provider decision and contract amendment.

### 27.2 Migration and backward compatibility

R6 changes no API route, exported adapter implementation, entity, migration, stored row, ACL feature, queue, or generated contract. Existing LeadMagic and Bouncer environment variables are retained as documented no-ops for compatibility, so a stale deployment configuration cannot activate an excluded provider. DataForSEO and Apify retain their existing additive configuration and fail-closed eligibility contracts.

### 27.3 Acceptance gates

- Production-mode registry tests enable complete synthetic LeadMagic and Bouncer configurations and prove neither source, enrichment, nor verification registry includes them.
- Production-mode registry tests prove only fully eligible DataForSEO and Apify adapters enter the selected stack; fixture adapters remain impossible outside the explicit ephemeral test harness.
- Full GTM tests, TypeScript, lint, and diff checks pass with external network access denied and no provider, mailbox, migration, or shared-service call.

### 27.4 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R6-A - closed provider registry | Completed locally | 2026-08-21 | DataForSEO + eligible Apify selected; LeadMagic/Bouncer registry activation removed |
| R6-B - validation and freeze | Completed locally | 2026-08-21 | 66/67 suites and 727 tests passed; the one skipped suite is the opt-in PostgreSQL concurrency harness; no provider call or configuration change occurred |

## 28. R7 complete represented-user RBAC (approved 2026-08-21)

### 28.1 Security contract

The shared Noli service secret authenticates the calling application only. Every internal GTM route that carries a represented `noliUserId` must additionally resolve and enforce the least-privilege `gtm.view`, `gtm.edit`, `gtm.approve`, or `gtm.launch` feature in the exact organization and tenant before loading or mutating GTM rows.

- Read-only lists, detail, status, plan, history, and timeline operations require `gtm.view`.
- Workspace, strategy, chat, candidate-review, manual-task, draft, attachment, and import mutations require `gtm.edit`.
- Campaign approval and external AMS asset requests require `gtm.approve`.
- Paid provider execution, enrichment execution, retention sweeping, dependency overrides that can unblock execution, approved-reply sending, campaign lifecycle, transport execution, and mailbox controls require `gtm.launch`.
- The account-free public removal request is the sole internal-dispatch exception because it intentionally has no represented user. It retains its shared-secret, opacity, suppression, and tenant-resolution contract.
- Dependency absence, denial, or RBAC failure returns `403 Forbidden` before entity, provider, ledger, mailbox, model, or handoff access.

### 28.2 Migration and backward compatibility

R7 adds no route, field, entity, migration, feature id, queue, or generated contract. It enforces the ACL features already declared since the original spec. Admin and superadmin behavior remains compatible because both already receive all four GTM features; employee defaults remain read-only as documented. Any caller that previously depended on service-secret possession while lacking the represented user's feature was relying on an authorization defect and now fails closed.

### 28.3 Acceptance gates

- Pure mapping tests cover every operation family and prove paid provider work and reply dispatch require `gtm.launch`.
- A source-level security invariant enumerates every internal GTM route and fails unless all represented-user routes call `hasGtmFeature`; only the public removal route is exempt.
- Full GTM Jest, TypeScript, focused lint, diff, and existing disposable integration gates remain green with all external-effect switches off.

### 28.4 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R7-A - route authorization closure | Completed locally | 2026-08-21 | Least-privilege mappings and pre-entity enforcement added to all represented-user routes |
| R7-B - validation and freeze | Completed locally | 2026-08-21 | 67/68 suites and 730 tests passed; the one skipped suite is the opt-in PostgreSQL concurrency harness; provider and execution configuration remain unchanged |

## 29. R8 current Apify contract closure (approved 2026-08-21)

### 29.1 Selected actors and capability boundary

- The production source descriptor admits only `harvestapi/linkedin-post-comments`. Its input and output shapes have a retained redacted live fixture, and its current Free/Starter rate is `$2 / 1,000` comment results.
- `harvestapi/linkedin-profile-scraper` remains the sole enrichment actor, at the current published `$4 / 1,000` profile-details rate or `$10 / 1,000` profile-details-plus-email-search rate.
- LinkedIn post search, standalone reactions, X engagement, fallback actors, and arbitrary actor overrides are not selectable. Their parsers and historical fixtures may remain for custody, but no broad Apify switch can expose them.
- Post search remains closed because its current rate card separately bills posts, optional main/full profiles, nested reactions/comments, zero-result queries, and actor starts, while the synchronous dataset endpoint supplies no run id or authoritative finalized charge. It requires a two-step run/receipt contract before activation.

### 29.2 Version and rights posture

- Customer-use eligibility requires the exact supported Apify Actor Terms version `apify-actor-terms-2026-07-09` and selected-stack price version `harvestapi-selected-stack-2026-08-21`; arbitrary nonempty strings fail closed.
- The selected source/profile rates are code-bound to that price version. Legacy per-result/per-profile environment values are compatibility no-ops and cannot silently mutate a frozen quote.
- The selected Actors are Community Actors. Apify does not vet or guarantee their legal compliance, and the owner remains responsible for source-platform rights, privacy, output handling, and customer-serving use. Therefore the deployment gate remains off until that independent approval is recorded.
- Credentials alone never grant capability, customer-use, terms, price, export, display, retention, or outreach authority.

### 29.3 Acceptance and release posture

- Network-free tests prove only the selected comments capability enters the source descriptor, stale contract versions fail, unselected capabilities make zero provider calls, and actor overrides make zero provider calls.
- Existing profile-enrichment tests prove an override cannot inherit the selected actor's contract.
- R8 changes no entity, migration, route, queue, customer data, production configuration, or provider state. Apify remains disabled in production.

### 29.4 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R8-A - selected actor/capability closure | Completed locally | 2026-08-21 | Comments + selected profile actor only; search/reactions/X/overrides fail closed |
| R8-B - current price/version freeze | Completed locally | 2026-08-21 | Exact terms/price versions and current published selected-actor rates |
| R8-C - validation and freeze | Completed locally | 2026-08-21 | 67/68 suites and 730 tests passed; the one skipped suite is the opt-in PostgreSQL concurrency harness; TypeScript, focused lint, and diff checks passed |

## 30. R9 current DataForSEO contract closure (approved 2026-08-21)

### 30.1 Rights, price, and retention boundary

- The owner-provided DataForSEO clarification permits customer display/export/retention of API output, qualification evidence, audience qualification, and B2B-outreach support for the described workflow without a separate DataForSEO addendum, subject to the DataForSEO Terms and source-platform restrictions.
- Eligibility requires the exact reviewed Terms version `dataforseo-tos-2026-06-12`, exact price version `google-maps-live-advanced-2026-08-21`, explicit owner customer-use approval, credentials, and a conservative provider JSON-retention ceiling of 30 days from the owner-provided support clarification. The current help page says Live results are not retrievable after the response; the 30-day value is intentionally the stricter maximum until DataForSEO resolves that wording. HTML/screenshot retention is outside this adapter because it requests and stores neither artifact.
- Source-platform restrictions and Noli's independent legal basis, minimization, suppression, deletion, and outreach duties remain applicable. The adapter declares provider DSR deletion unsupported and does not treat the provider clarification as resolving every subprocessor/DSR question.

### 30.2 Money and capability boundary

- The selected capability is US Google Maps Live Advanced company/location discovery only. One provider call is capped at `depth: 100`, with no price-multiplying search operators or rectangle calculation, at a code-bound `$0.002` maximum task rate.
- The API-returned task/root USD cost remains authoritative. Missing cost, unreadable post-dispatch responses, or cost above the one-task reservation remain ambiguous for operator reconciliation.
- Every successfully processed duplicate request is billable. The adapter relies on the canonical provider-operation `started_now` single-flight boundary before dispatch; duplicate-task dashboard limits are defense in depth, not correctness.
- The published account maximum may exceed Noli's descriptor, but Noli retains a lower 120-request/minute and five-concurrent safety ceiling. Account configuration never widens the frozen per-operation contract.

### 30.3 Acceptance and release posture

- Network-free tests prove stale terms/price labels and wrong retention fail closed; legacy rate/depth overrides cannot mutate the frozen quote or request; unsupported price-multiplying queries make zero provider calls; authoritative receipts and ambiguity behavior remain intact.
- R9 makes no provider call, entity, migration, route, queue, customer-data, production-configuration, or flag change. DataForSEO remains disabled until a later controlled activation step.

### 30.4 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R9-A - exact rights/price/retention closure | Completed locally | 2026-08-21 | Exact versions + 30-day JSON retention; one `$0.002`/100-result task |
| R9-B - validation and freeze | Completed locally | 2026-08-21 | 67/68 suites and 730 tests passed; one opt-in PostgreSQL suite skipped; TypeScript, focused lint, and diff checks passed |

## 31. R16 accepted-yield Apify company source (approved 2026-08-22)

### 31.1 Customer-work-product contract

- `harvestapi/linkedin-company-search` is an additive company source for the `firmographic_match` signal. It supplies the industry, employee count/range, public company URL, website, and structured US location fields required to move otherwise-valid company candidates from `review` to an evidence-supported `accepted` or `rejected` decision.
- The frozen actor/build is `harvestapi/linkedin-company-search` `0.0.17`. The only supported mode is `full`; each request binds a bounded query, at most 20 locations, exact supported company-size buckets, a deterministic page, and at most 100 rows.
- Provider output is evidence, not truth by declaration. A usable row requires a public LinkedIn company URL and name; parser drift that leaves no usable identity is ambiguous, not free. Qualification remains deterministic `fit-v6` and retains criterion-level observed evidence and unknowns. `source_search_keywords` may broaden provider discovery, but only the separate `company_keywords`, industry, exclusion, size, and location criteria may establish fit. Frozen provider location is retained as targeting provenance and can soften an otherwise unprovable local-boundary mismatch to review; it never proves the result-level location by itself.
- This source does not find or verify personal email, send outreach, ingest mailboxes, or make a campaign public. LeadMagic and Bouncer remain excluded.

### 31.2 Money, rights, and activation boundary

- The conservative Free/Bronze quote is code-bound to `$0.004` per full-company result plus one `$0.001` actor-start event per run. The fixed start is represented as `0.25` full-company units so quote, reservation, provider cap, settlement, and reconciliation share one unit vocabulary.
- A company-source quote reserves the maximum row events plus the start event and sends the reservation-derived `maxTotalChargeUsd` to Apify. Empty definitive runs charge only the start event. Timeout, transport uncertainty, or unusable billed rows park the operation as ambiguous and never trigger a silent retry.
- Eligibility requires the existing exact Apify customer-use, terms, and selected-stack price gates plus `GTM_APIFY_COMPANY_PRICE_VERSION=harvestapi-linkedin-company-search-0.0.17-free-bronze-2026-08-22`. An optional actor override is accepted only when it equals the frozen actor id. A token or broad Apify flag cannot activate this capability by itself.
- The owner approved Apify for this workflow. Because this is a Community Actor, Noli still owns source-platform compliance, minimization, evidence retention, suppression, deletion, and outreach decisions. Credentials and technical success do not delegate those duties to Apify.

### 31.3 Acceptance and release posture

- Network-free tests cover exact gate failure, actor override refusal, frozen input construction, quote arithmetic including the start event, firmographic normalization, URL validation, definitive empty billing, transport ambiguity, and no-call behavior while ineligible.
- Research-plan tests freeze firmographic filters, price version, descriptor hash, and the actor-start charge into the immutable quote before any provider call.
- R16 may deploy dark with the company-specific gate absent. Owner-only activation and one bounded golden motion may follow only after the merged artifact is running and existing execution, mailbox-ingestion, and public-promotion gates remain off.

### 31.4 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R16-A - company-source contract | Completed locally | 2026-08-22 | Exact actor/build, input, output, evidence, rights, and event-price contract |
| R16-B - validation and freeze | Completed locally | 2026-08-22 | 70/71 suites and 758 tests passed; one opt-in PostgreSQL suite and its seven tests skipped; whole-repository TypeScript, lint (zero errors), production build, deployment-security, and diff checks green |
| R16-C - owner-only golden motion | Completed | 2026-08-22 | One exact 10-row owner-only run reconciled 20,500 credits; 4 new workspace identities produced 1 accepted / 3 rejected, no contact, campaign, mailbox, or send work |

## 32. R19 contextual candidate qualification (approved 2026-08-22)

### 32.1 Identity and qualification contract

- `gtm_candidates` remains the workspace-wide identity and contact-data record, with its existing unique `(organization_id, workspace_id, dedupe_key)` constraint. A later source run never creates a second person/company row merely to express a different audience decision.
- `gtm_candidate_matches` is the run/play-specific junction and fit snapshot. It binds one candidate to one frozen research run, play, provider operation, evidence-quality assessment, fit score/verdict/reason, criterion record, and scorer version. `(research_run_id, candidate_id)` is unique, so a same-run duplicate remains suppressed while a later run can reuse the identity without losing its own qualification.
- New evidence records bind to `research_run_id`. Legacy evidence remains valid through a nullable compatibility field and is backfilled from its candidate's original run during the controlled migration.
- Run status, requalification, manual review, selected-play People lists, enrichment selection, and campaign recipient approval consume contextual matches. Legacy candidate-level fields remain a compatibility fallback only; review of a contextual row never overwrites another play's decision.

### 32.2 Migration and release contract

- The entity change is represented by generator-owned `Migration20260822155644_gtm` plus the synchronized GTM snapshot. The migration adds only the junction table, its indexes/foreign keys, and nullable evidence run binding.
- Existing rows are copied idempotently into one match per candidate/original run and legacy evidence is bound to that run after schema application. Replaying the backfill inserts/updates zero rows.
- Rollback is the GTM/UI flags plus the prior app image. The additive table/column remain inert; no destructive rollback/drop is required.
- Execution, mailbox ingestion, public GTM promotion, LeadMagic, and Bouncer remain off. This correctness tranche does not authorize outreach or broaden customer exposure.

### 32.3 Acceptance gates

- Cross-run tests prove the same workspace identities produce independent matches/evidence and count toward the later run's accepted-yield funnel; same-run duplicates remain suppressed.
- Campaign approval, enrichment, requalification, and manual-review tests prove they use the contextual verdict while leaving the candidate identity verdict unchanged.
- Full current-main migrations plus R19 apply to an empty disposable database; a second migrate has no pending work and a second generator pass reports no GTM drift. The legacy-row backfill is idempotent and preserves fit-v6 truth.
- The Hub People screen requires an Audience Play context and sends its match id for detail/review. Hub typecheck and its complete deterministic suite remain green.

## 33. R21 accepted-company decision-maker resolution (approved 2026-08-22)

### 33.1 Product and identity contract

- R21 closes the missing company-to-person bridge in the golden GTM motion. It takes accepted company matches from one frozen research run and resolves a bounded set of current decision-makers through the separately contracted `harvestapi/linkedin-company-employees` Actor.
- A resolved person is a normal workspace-deduplicated `gtm_candidates` row and receives a run/play-specific `gtm_candidate_matches` row. Company fit is never copied blindly: a person is accepted only when the parent company match is accepted and the returned current title deterministically matches a title in the frozen resolution plan; uncertain roles remain `review` and contradictory/non-decision-maker roles are rejected.
- LinkedIn may represent one company with both a human-readable slug URL and a numeric canonical URL. Plan schema v3 freezes numeric company ids from the upstream company-search evidence alongside the submitted slug. A returned current position with a URL is accepted only when that URL equals the frozen slug or its numeric id equals a frozen source id; a matching display name never overrides a contradictory URL. Rows for other current companies remain rejected even when the Actor echoes the submitted query.
- `gtm_candidate_relations` is an additive tenant-scoped evidence junction. It binds parent company candidate + contextual match, child person candidate, play, research run, provider operation, relationship kind (`current_employee`), observed title, confidence, and observed time. The unique run/company/person/kind key makes replay idempotent while allowing one person to relate to more than one company or to change companies over time.
- Person evidence is deliberately minimal: public LinkedIn profile URL, observed current company/title, provider/operation identity, and observation time. R45 fetches only identity, location, current-position, current-work-history, and query-echo fields from the Full dataset. Biographies, skills, education, photos, raw response bodies, and provider emails are neither fetched from the dataset nor retained.

### 33.2 Frozen provider and money contract

- The selected Actor is `harvestapi/linkedin-company-employees`, pinned to build `0.0.157`. R45 supersedes the R21 runtime contract with `Full ($8 per 1k)`: the account-specific finalized event map is `$0.020` per all-at-once Actor start and `$0.008` per full profile. The live Actor metadata declares a `$0.05` minimum `maxTotalChargeUsd`, so quotes reserve the greater of that floor or start plus the maximum full-profile events. The contract version is `harvestapi-linkedin-company-employees-full-0.0.157-finalized-events-2026-08-24`; a changed actor, build, mode, event map, minimum cap, or dataset contract requires a new reviewed version.
- One operation accepts exactly one frozen LinkedIn company URL, uses `companyBatchMode=all_at_once`, and returns at most 25 profiles. Every accepted row must echo that sole URL in `_meta.query.currentCompanies` and independently prove a current position through the exact frozen company URL, a frozen numeric company id, or an exact non-contradicted company name. Full-mode work history is current only when its end date is `Present` (or an explicit current flag is true). A missing/different/multi-company echo, ended role, or contradictory company URL/id is withheld. The quote reserves the fixed start event plus the maximum profile events, and the reservation-derived `maxTotalChargeUsd` is sent to Apify.
- Execution uses the two-step Actor run contract, not the legacy synchronous dataset endpoint: it retains the durable run id, waits for finalized billing, validates the exact pay-per-event map and provider total, then reads a bounded field projection from the dataset. A definitive empty result settles the exact finalized start charge; returned rows settle the exact finalized provider total, including rows the parser withholds. Missing or changed billing evidence is ambiguous and exposes no person.
- Eligibility requires the existing exact Apify customer-use/terms/selected-stack gates plus `GTM_APIFY_COMPANY_EMPLOYEES_PRICE_VERSION` matching the R21 contract. An optional actor override is accepted only when it equals the frozen Actor id. This capability is not added to the general source registry and cannot be activated by the broad Apify switch alone.
- Reserve/start/single-flight/receipt-first/settle-or-ambiguous semantics are identical to section 11.2. The immutable plan hash binds run, play, company candidate and match ids, exact company URLs, title filters, profile cap, descriptor hash, price/terms versions, and quoted fixed/per-profile units. Unknown provider or canonical-ledger outcomes expose no person output and never auto-retry.

### 33.3 Reachability and release boundary

- Decision-maker resolution does not request or create email contact points. A resolved person is therefore visible and research-ready but not sendable; campaign approval still requires a separately verified email contact point.
- The existing selected Apify profile-enrichment adapter may later search for an address for a resolved person, but its result remains `found`. R6 selected no independent real-email verifier, so automated email execution stays blocked even when profile enrichment finds an address.
- R21 grants no email execution, mailbox ingestion, campaign launch, public GTM promotion, or public provider capability. It may deploy owner-only and dark with the new exact price-version gate absent. A later owner-only golden motion is limited to one bounded resolution operation and no outreach.

### 33.4 API and UI contract

- New internal operation `/internal/gtm/decision-makers` supports `plan`, `run`, and `status`. It re-resolves the represented Noli user, enforces `gtm.view` for plan/status and `gtm.launch` for paid execution, and scopes every row by organization and tenant. `run` requires the exact current `plan_hash` and returns `409 plan_changed` before reserve when inputs drift.
- The Hub Research/People experience exposes the frozen company count, role filters, maximum people, maximum credits, and actual resolved/reused/review counts. It must say that people are resolved from accepted companies and that email verification is a separate step; it must not imply that a name alone is campaign-ready.
- Integration coverage includes wrong-user/cross-tenant opacity, non-accepted-company exclusion, plan drift, exact role/title binding, concurrent replay single-flight, parser drift/partial rows, provider ambiguity, canonical settlement failure, relation replay, person dedupe, and a no-send campaign approval check.

### 33.5 Migration and rollback

- ORM entities are the source of truth. The additive relation table and indexes are emitted by `yarn db:generate` with the synchronized GTM snapshot; no migration SQL is hand-written.
- Disposable empty-database apply/reapply/no-drift and current-schema upgrade rehearsals are mandatory before merge. Rollback is the new capability gate plus the prior CRM/Hub image; the additive relation table remains inert and is not dropped.

### 33.6 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R21-A - provider/identity/API contract | Completed locally | 2026-08-22 | Exact actor, conservative Basic/Short price/start events, company/person relation and plan hash frozen |
| R21-B - deterministic implementation and migration | Completed locally | 2026-08-22 | 73 GTM suites / 789 tests, TypeScript, lint, CRM and Hub production builds, Hub 1,226 tests, and disposable migration apply/reapply green; no external call made |
| R21-C - owner-only golden motion | Completed | 2026-08-22 | The final single-company run cost `$0.029`, returned three rows, safely dropped two unrelated rows, persisted one company-bound person and relation, and settled as partially charged. The person remains `review`; no email, campaign, mailbox, or send work occurred. Plan schema v3 binds the Actor's numeric canonical company URL only through the frozen upstream company id. |
| R45 - full-profile employment and finalized billing | Completed locally | 2026-08-24 | Short-mode R40 contradictions remain withheld. Build `0.0.157`, Full-mode current work history, exact frozen company binding, durable run ids, finalized `$0.020` start/`$0.008` profile events, bounded dataset fields/bytes, and fail-closed billing drift are covered by the complete GTM suite and typecheck; owner-only production validation remains pending. |

## 34. R24 progressive decision-maker continuation (approved 2026-08-22)

### 34.1 Continuation and money contract

- A decision-maker operation remains bounded to one accepted company. The next plan chooses the earliest eligible company in the frozen accepted-match order that has not already reached a definitive `charged` or `partially_charged` canonical mirror with a durable settlement timestamp. A charged operator reconciliation advances the company even when the original provider observation was ambiguous; a refunded reconciliation leaves it eligible for an explicit retry.
- `provider_started` and `reconciliation_required` are unresolved money truth. Either state blocks every later company plan or run until the existing operation is reconciled; the workflow never skips an ambiguous provider outcome to spend on another company.
- A refunded or otherwise non-processed company remains eligible. Plan schema v4 binds a monotonically increasing per-company attempt to the immutable plan hash so an explicitly retried operation cannot alias an earlier quote or provider operation.
- Legacy schema-v3 single-company results count as processed only when the local canonical mirror is terminal, settlement is not pending, and the receipt identifies exactly one company. Multi-company legacy receipts never advance the runway.

### 34.2 Owner UI and release boundary

- Status and plan responses add eligible, processed, remaining, and current company-position fields without removing existing fields. The Hub presents these as a compact lead runway and previews one bounded company at a time before exact quote confirmation.
- Completion means every currently eligible accepted company was checked; it does not mean every company produced a person, that every person qualified, or that any email address is available or verified.
- R24 adds no entity, migration, provider capability, flag, public promotion, mailbox ingestion, or email execution. The deployed experience remains owner-only; validating the next-company preview does not authorize another provider call.

### 34.3 Acceptance and rollback

- Deterministic tests prove settled success/no-result progression, unresolved-operation blocking, refunded retry attempts, stable accepted-match ordering, immutable attempt hashing, and the completed-run state.
- Rollback is the prior CRM and Hub images. No database rollback or destructive migration is required.

### 34.4 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R24-A - continuation contract | Completed locally | 2026-08-22 | Plan schema v4 freezes one-company rank, progress, and retry attempt; unresolved canonical money truth blocks continuation |
| R24-B - lead-runway UI and validation | Completed locally | 2026-08-22 | 73/74 GTM suites and 799 tests pass (only the opt-in PostgreSQL suite skipped); CRM/Hub typechecks and production builds pass; Hub 1,228 tests pass; no provider call, schema, flag, mailbox, or email change |

## 35. R25 selected Apify email verification (approved 2026-08-23)

### 35.1 Provider and confidence contract

- R25 supersedes only R6's “no independent real-email verifier” decision. LeadMagic and Bouncer remain excluded. The selected verifier is `automation-lab/email-enrichment`, pinned to build `0.1.49`, behind `GTM_APIFY_EMAIL_VERIFY_ENABLED` and the exact price contract `automation-lab-email-enrichment-0.1.49-free-0.001-start-0.003-per-row-observed-2026-08-23` in addition to the existing Apify token, customer-use, terms, and selected-stack gates.
- One operation accepts exactly one normalized address and requests SMTP depth, catch-all detection, and domain-deliverability checks. A response binds only when exactly one schema-valid row echoes the requested address. Actor overrides, extra rows, mismatched addresses, schema drift, timeouts, transport uncertainty, and provider 5xx outcomes fail closed or enter canonical reconciliation; none is silently retried.
- Only `isVerified=true`, `verificationMethod=smtp`, confidence at least 80, and a non-catch-all, non-disposable, non-free, non-role address becomes `verified`. Catch-all becomes `catch_all`; disposable, free-provider, and role addresses become `risky`; explicit bad syntax or absent MX becomes `not_found`; MX-only and every other incomplete proof becomes `unknown`.
- The frozen Free-tier prices are `$0.001` per Actor start plus `$0.003` for the result event. Apify's catalog metadata labels the result event as confidence at least 50, but the first owner-only live run charged `$0.004` total for a schema-valid row with confidence 5. Therefore every emitted row settles the start-plus-result amount; only a true no-row response settles start-only. Because Apify enforces a `$0.01` minimum `maxTotalChargeUsd`, the plan reserves that one-run provider ceiling. The actor build and observed-billing price version are immutable quote material. A changed build, actor, event behavior, event price, or provider cap requires a new contract version.

### 35.2 Data, API, UI, and release boundary

- `VerifyRequest.max_charge_usd` and `VerificationOutcome.detail` are optional additive fields. The existing enrichment route passes its reservation-derived provider cap into verification and stores only redacted verification method, confidence, provider category, deliverability grade, and risk flags on contact provenance. The normalized address is represented in the canonical fingerprint only by SHA-256; provider receipts never copy it.
- Existing `POST /internal/gtm/enrich` status, plan, and run operations remain backward compatible. Plans show one separately priced verification row per unresolved normalized address. The run retains the existing accepted-candidate, tenant, idempotency, reserve/start/settle-or-reconcile, duplicate-address reuse, and stop-at-first-verified rules.
- The Hub People path continues to quote before provider spend, but labels selected capabilities in product language and reports the actual post-run state instead of promising that every found address will verify.
- R25 may deploy owner-only and dark. Automated email execution, mailbox ingestion, LeadMagic, Bouncer, and public GTM promotion remain off. Enabling the new exact verifier gate authorizes only one-address verification inside the existing owner-only quote/confirm flow; it does not authorize an email send.

### 35.3 Acceptance, golden evidence, and rollback

- Deterministic adapter tests cover every gate, actor/build/input/cap binding, no-secret/no-address receipt posture, exact verified proof, catch-all/risky/not-found/unknown mappings, event-sensitive settlement units, output-address mismatch, schema drift, and ambiguity. Existing enrichment-waterfall tests prove the provider cap reaches the verifier and route-level fixture integration continues to cover plan/run persistence and verified-contact promotion.
- Hub contract coverage proves quote, provider-label, state-count, and failure-honesty copy on the People path. CRM and Hub TypeScript, lint where supported, production builds, full relevant tests, and `git diff --check` are required before merge.
- After dark deployment, one user-owned address may be checked through the production owner-only flow under the `$0.01` provider cap. The evidence must record whether SMTP proof was actually available and must not reinterpret MX-only proof as verified. No message is sent.
- Rollback is the capability gate off plus the prior CRM/Hub images. R25 adds no entity or migration; existing contact rows and provider-operation evidence remain inert and auditable.

### 35.4 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R25-A - exact verifier contract | Completed and dark-deployed | 2026-08-23 | Apify actor/build/rate, conservative proof mapping, canonical spend cap, and redacted evidence frozen; merged in CRM PR #65 and corrected in PR #66 |
| R25-B - deterministic implementation | Completed and dark-deployed | 2026-08-23 | 74/75 CRM GTM suites and 816 tests pass (only the opt-in PostgreSQL suite skipped); CRM/Hub typechecks and production builds pass; Hub 1,229 tests pass; no schema, mailbox, or email-send change |
| R25-C - owner-only golden motion | Completed dark | 2026-08-23 | A corrected rerun on one owned Gmail address returned the expected conservative risky/free-provider result with SMTP method and confidence 5. Apify charged `$0.004`; the canonical ledger reserved 5,000 credits and charged 2,000 after the 2x markup. Transitions were `reserved` -> `provider_started` -> `charged`; the durable receipt contained no raw address, no message was sent, and all product-facing fixture rows were soft-deleted after verification. |

## 36. R26 actionable reviewed-lead surface (approved 2026-08-23)

### 36.1 Qualification diagnostics

- The play-scoped candidate list returns the latest contextual verdict for each candidate plus an additive, count-only qualification diagnostic: total scored, accepted, review, rejected, unscored, qualification rate, and rejected rows grouped by the stored deterministic reason code. Counts are computed before the visible table filter so changing the filter cannot rewrite the funnel.
- The Hub may explain the largest recorded filters and link the user back to the Strategist, but it must not claim that loosening a criterion will improve quality or yield unless the user explicitly edits and reruns the frozen play. Missing reasons remain `unspecified`; the UI never invents a cause.

### 36.2 Reviewed-lead export

- `POST /internal/gtm/candidates` gains the exact `export` operation. It requires server-resolved tenant identity, the `gtm.edit` role, an explicit workspace and play, and an Idempotency-Key supplied by the Hub proxy. Caller-supplied org, tenant, and user identity remain stripped.
- The export is intentionally narrower than a raw table dump: only the latest play-contextual `accepted` **person** rows are considered; only a non-deleted `verified` email may be exported; current GTM/global suppressions and legacy unsubscribes exclude the address at export time; and provider evidence must carry explicit customer-export permission. A missing permission, suppressed address, absent verified mailbox, company row, or stale/deleted record is skipped and counted by reason.
- Export rows contain only the reviewed work product needed for customer action: name, title, company, LinkedIn/profile URL when grounded, verified work email, fit score/status, the stored “why them” explanation, permitted source URLs, latest observation date, and verification state. They contain no provider credential, raw provider response, operation receipt, internal org/tenant/user id, suppression hash, model prompt, or unreviewed address.
- The response is capped at 1,000 rows and reports `considered`, `exported`, `skipped_by_reason`, and whether additional accepted identities exceeded the cap. The Hub generates UTF-8 CSV locally with RFC-style quoting and spreadsheet-formula neutralization, presents the exact exported/skipped counts, and starts the download only after an explicit user action.
- Every export writes a redacted `gtm.candidates.exported` audit row containing the workspace/play ids, schema version, row counts, skipped counts, a hash of exported candidate ids, and a hash of the Idempotency-Key. No name, title, company, URL, email, or evidence text enters audit metadata or application logs.
- R26 changes no entity or migration and makes no provider/model/mailbox/email call. Deployment remains owner-only dark; automated execution, mailbox ingestion, LeadMagic, Bouncer, public GTM promotion, and customer exposure remain off.

### 36.3 Acceptance and rollback

- Deterministic tests cover tenant isolation, latest-context selection, accepted-person-only scope, explicit evidence-export permission, verified-email selection, suppression and legacy-unsubscribe exclusion, cap truth, redacted audit metadata, formula neutralization, CSV quoting/newlines, diagnostic counts, and honest empty/error UI states.
- Rollback is the prior CRM and Hub artifacts. Because there is no schema or external effect, disabling the GTM module or reverting the application removes the surface without data rollback.

### 36.4 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R26-A - export and diagnostics contract | Completed locally | 2026-08-23 | Count-only qualification diagnostics and the audited, suppression-aware export are implemented without a provider, mailbox, send, schema, flag, or exposure change |
| R26-B - deterministic verification | Completed locally | 2026-08-23 | CRM focused tests pass 16/16; the full GTM baseline remains 75 passing suites plus one opt-in PostgreSQL suite skipped, with 825 tests passing and 7 skipped. Hub focused tests pass 28/28 and the full Hub baseline remains 1,234/1,234. Both typechecks and production builds pass. |

## 37. R27 person-only enrichment scope (approved 2026-08-23)

### 37.1 Golden-motion correction

- The owner-only dental golden motion produced accepted company accounts before resolving people. The existing enrichment quote counted all accepted identities while runtime capability checks skipped company calls, inflating a one-person authorization to the full account set.
- Enrichment plans and the direct waterfall now admit accepted person candidates only. Company contact points are excluded from quote identity and verification counts, so a company cannot inflate the ceiling or consume a provider reservation even when a test adapter technically supports company enrichment.
- This is a narrowing safety correction to an owner-only dark operation, not an API, schema, provider, mailbox, execution, or exposure change. Existing request and response fields remain intact.

### 37.2 Acceptance and rollback

- Deterministic plan and waterfall tests must prove an accepted company and any company contact point are excluded while the accepted person remains quoted and processed.
- Rollback is the prior CRM artifact. No data migration or external configuration change is required.

### 37.3 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R27-A - person-only quote and waterfall | Completed and dark-deployed | 2026-08-23 | 23 focused tests and the full GTM baseline of 75 suites/826 tests pass; TypeScript, focused lint, production build, and diff checks are clean. No migration or external call was added. |

## 38. R28 finalized Apify profile-enrichment settlement (approved 2026-08-23)

### 38.1 Golden-motion correction

- The first R27 one-person owner-only enrichment run returned one profile row with no email. Apify's finalized run showed `chargedEventCounts={profile:1,profile_with_email:0}` and `$0.004` total cost. The prior synchronous dataset contract returned no run id and conservatively settled the full `$0.01` email-search ceiling, charging 5,000 Noli credits after the 2x markup instead of the exact 2,000-credit charge.
- HarvestAPI's current actor pricing is adaptive pay per event: `profile` costs `$0.004`; `profile_with_email` costs `$0.01`. A missing email is not enough to infer which event occurred. Settlement must use the finalized event map from the exact run, not the requested mode, returned-row count, or timestamp matching.
- The historical owner-dark operation remains immutable under the existing canonical settled-operation contract and carries a recorded 3,000-credit discrepancy. It must be corrected through an additive canonical adjustment/compensation contract before customer billing is enabled; mutating the original settled receipt or silently editing balances is forbidden.

### 38.2 Durable run and billing contract

- Profile enrichment uses `POST /v2/actors/{actorId}/runs` with the existing reservation-derived `maxTotalChargeUsd`, one-item ceiling, and bounded `waitForFinish`. The returned run id is persisted on every post-dispatch outcome.
- After a successful terminal run, CRM waits the provider-documented ten-second finalization interval, reads that exact run, and requires `PAY_PER_EVENT`, the frozen `$0.004`/`$0.01` event prices, non-negative integer event counts, and a matching finalized total at or below the reserved provider cap. Unknown events, changed prices, missing totals, non-terminal state, receipt failure, or contradictory totals are ambiguous and expose no provider output.
- Only after billing truth is final does CRM read the exact run dataset. A missing/unreadable/oversized dataset remains ambiguous on the same run and is never retried automatically. A returned email additionally requires one `profile_with_email` charge event; a profile-only event cannot authorize an address even if a drifting actor row contains one.
- The customer quote remains the maximum `$0.01` profile-plus-email ceiling (5,000 Noli credits at 2x). Exact settlement is `$0.004` / 2,000 credits for one profile-only event, `$0.01` / 5,000 credits for one email-search event, and zero/refunded for an authoritative zero-event run. Provider event counts, exact cost, pricing model, billing-contract version, and run id are durable redacted receipt fields.

### 38.3 Release, acceptance, and rollback

- R28 changes no route, entity, migration, flag, provider capability, mailbox capability, execution state, or public exposure. The exact profile adapter remains owner-only and quote/confirm gated; automated execution and mailbox ingestion remain off.
- Deterministic tests prove the profile-only 2,000-credit settlement, email-search 5,000-credit ceiling, zero-event refund, run-id retention, price drift parking, returned-email/event contradiction parking, token redaction, and no dataset access before finalized billing.
- Rollback is the prior CRM image. No schema or configuration rollback is required. The old synchronous path remains available to other independently contracted Apify adapters; only profile enrichment moves to the finalized two-step contract.

### 38.4 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R28-A - durable run and finalized-event client | Completed locally | 2026-08-23 | Exact run id, ten-second billing finalization, frozen event-price verification, capped dataset read, and ambiguity handling implemented without a provider call |
| R28-B - exact adaptive settlement | Completed locally | 2026-08-23 | Profile-only miss settles 2,000 credits after markup; email-search event remains capped at 5,000; zero-event run refunds; full GTM suite passes 76 suites/835 tests with one opt-in PostgreSQL suite skipped |

## 39. R30 bounded public-website contact discovery (approved 2026-08-23)

### 39.1 Product boundary and provider contract

- When the selected profile-enrichment actor returns no address for an accepted person, CRM may try one separately gated, source-backed fallback against the person's company website. It does not guess email patterns, use a people-data broker, or convert a generic role address into person-level proof. Every discovered address remains `found` until the independent verifier classifies it.
- The provider contract is frozen to Apify's maintained `apify/website-content-crawler` actor, build `0.3.94`. The request uses the raw-HTTP Cheerio crawler, at most five pages, depth one, concurrency one, 15 seconds per page, robots enforcement, no proxy, no sitemap expansion, no files, screenshots, HTML, Markdown, or AI summary, 1,024 MiB memory, and a `$0.01` total-provider-charge ceiling.
- Crawl scope is the exact normalized company apex plus its `www` alias. Redirected or returned rows outside that scope are ignored; malformed rows make the billed result ambiguous. The dataset projection is only `url,crawl,text`, capped at one MiB before parsing. Only syntactically valid, same-company-domain addresses are retained, with `no-reply`, `test`, and `example` locals excluded. Person-name matches rank before other addresses and role mailboxes; at most five unique addresses survive.
- Contact provenance contains the public source URL, observation time, SHA-256 of the observed page text, normalized company domain, and match kind. Durable provider receipts contain only hashes, counts, actor/run/build/billing fields, and crawl controls; no address, raw domain, page body, credential, or provider body snippet is stored in the receipt.

### 39.2 Identity, quote, money, and idempotency

- Decision-maker plan schema v5 freezes each normalized parent-company domain. A safely resolved child person inherits that domain in its candidate identity. For pre-existing relations, the enrichment route may derive the domain from exactly one current parent-company relation without mutating stored identity; zero or conflicting parent domains fail closed.
- Enrichment plan schema v4 freezes the normalized company domain per unresolved person, counts provider units only for candidates the adapter can actually serve, and reserves verification for the largest contact-point yield any winning adapter can expose. Changing the domain changes the quote hash. The execution idempotency key additionally binds a one-way domain fingerprint, so a later corrected company domain cannot replay a prior crawl receipt.
- The exact website crawl reserves a maximum `$0.01` provider charge. CRM starts the pinned run, waits for finalized billing, requires Apify's `FREE` pricing model with no charged events, and settles the exact `usageTotalUsd`; drift, missing billing, a cost above the cap, or an unreadable/oversized dataset is ambiguous and requires operator reconciliation. The normal 2x customer-credit markup remains canonical and no local balance is created.

### 39.3 Rights, retention, release, and rollback

- This capability inherits the already approved Apify customer-use/terms/selected-stack gates and adds `GTM_APIFY_WEBSITE_EMAIL_ENABLED`, an exact account-retention gate of `7` days, and the exact price-contract version `apify-website-content-crawler-0.3.94-free-usage-cap-0.01-retention-7d-2026-08-23`. An arbitrary actor override, stale price version, mismatched retention, missing token, or disabled broad gate cannot register or call it.
- Public-page observation is evidence, not permission to send. Campaign eligibility still requires accepted fit, an independently `verified` address, current suppression checks, exact approval binding, and every execution gate. Role or risky addresses do not become campaign-ready merely because they were published.
- The provider declares no supported DSR deletion API for this adapter. CRM retains only the bounded evidence and contact record under its existing deletion/retention paths. A read-only account probe on 2026-08-23 verified a 7-day dataset-retention setting for the configured Apify account; registration now requires that exact frozen value. A changed account setting requires a new reviewed contract or a crash-safe cleanup contract before activation.
- R30 adds no entity, migration, route shape removal, mailbox capability, send capability, or public exposure. The optional adapter methods are backward-compatible; plan-version changes intentionally invalidate stale quotes. Rollback is the prior CRM image plus the website-email gate off. Any already-started canonical provider operation must be reconciled before retry.

### 39.4 Acceptance and implementation status

- Deterministic acceptance covers exact gate registration, normalized/inherited domains, quote/hash changes, maximum contact-yield verification ceiling, unsupported-candidate zero reservation, bounded actor input, same-domain filtering, address ranking, redacted receipts, exact finalized-usage settlement/refund, pricing drift, malformed/off-scope rows, dataset byte ceiling, and canonical idempotency.
- No provider call, email, mailbox ingestion, migration, production flag change, or customer exposure is part of the code tranche. One owner-only quote/confirm golden may follow dark deployment only after a read-only account-retention and exact actor/build/pricing recheck.

| Phase | Status | Date | Notes |
|---|---|---|---|
| R30-A - domain custody and bounded website adapter | Completed locally | 2026-08-23 | Parent-domain propagation, plan/hash binding, exact pinned crawl, same-domain evidence, and finalized usage settlement are implemented behind a separate dark gate |
| R30-B - deterministic verification | Completed locally | 2026-08-23 | Focused tests pass 52/52; the full GTM baseline passes 78 suites/856 tests with one opt-in PostgreSQL suite and seven tests skipped. TypeScript and focused lint pass; no provider call occurred |
| R30-C - account-retention closure | Completed locally | 2026-08-23 | Read-only account metadata verified 7-day dataset retention and exact successful actor build `0.3.94`; eligibility and descriptor now fail closed on the frozen 7-day contract |
| R30-D - dark deployment and surrounding golden | Completed dark | 2026-08-23 | Exact CRM main `08a135a478ce4d9479c8fa0b5db7f04b355c8b22` is deployed with the separately gated adapter owner-only. A one-company resolver plus one-person enrichment golden settled 12,000 + 5,000 + 2,000 credits through canonical transitions with no ambiguity. Profile discovery found one address, so the website fallback correctly did not run; execution, mailbox ingestion, and public GTM promotion remained off. |

## 40. R31 exact lead-table email readiness (approved 2026-08-23)

### 40.1 Read model and customer boundary

- The candidate list must not collapse every non-verified contact into one `Not verified` boolean. `found`, `risky`, `catch_all`, `provider_ambiguous`, `unknown`, and `not_found` each imply a different owner action and remain distinct in the People table.
- The existing two-query candidate rollup reads all live scoped email contact points, returns an additive `email_verification_state` plus `email_contact_count`, and retains `has_verified_email` for rolling-deploy compatibility. No address value is added to the list response.
- When multiple addresses exist, the summary selects the safest actionable state in this order: `verified`, `found`, `risky`, `catch_all`, `provider_ambiguous`, `unknown`, `not_found`. The source drawer remains authoritative for every individual address. An unrecognized stored state maps to `unknown`, never `verified`.
- Hub labels the exact state in customer language and states the action: verification pending, do not auto-send, resolve the provider result, or delivery unproven. `Verified` means eligible for review, not permission to send.

### 40.2 Release and acceptance

- R31 is an additive read-contract and UI change only. It adds no entity, migration, provider call, model call, mailbox capability, execution capability, public GTM promotion, or customer exposure.
- Deterministic acceptance covers honest zero/found/verified rollups, multi-address precedence, unknown future-state fail-closed behavior, non-email isolation, no N+1 query regression, and every Hub readiness label.
- Rollout order is CRM before Hub so the UI receives exact state immediately; the boolean fallback exists only to keep a mixed-version deployment readable. Rollback is the prior Hub and CRM images with no data change.

### 40.3 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R31-A - exact candidate email rollup | Completed and dark-deployed | 2026-08-23 | Additive state/count projection and deterministic precedence tests implemented with the existing two grouped queries; exact CRM main `3a8e5937940ab9dc5d50531e7b7ba0a2ed038dda` is deployed app-only with no migration or flag change |
| R31-B - actionable People-table state | Completed and dark-deployed | 2026-08-23 | Exact customer labels and public-website provider name are deployed on exact Hub main `c7079fbdd184a09f361219209da266fb912eaf7c`; signed-out GTM access remains protected and verification remains a separate safety gate |

## 41. R32 exact recipient-by-step campaign review (approved 2026-08-23)

### 41.1 Approval read contract

- The campaign draft response must preserve every frozen recipient-by-email-step artifact required to understand the exact approval envelope. Each rendered row exposes additive `step_key`, `step_order`, `content_hash`, `word_count`, and `quality_issues` fields alongside the existing recipient, subject, body, missing-field, provenance, and review truth.
- `content_hash` is the immutable rendered-message hash already consumed by campaign approval and execution; the read route does not synthesize or recompute it. Step identity/order come from the frozen campaign draft and cannot be inferred from array position.
- The additive fields do not remove or reinterpret any existing response field. A rolling Hub deployment remains readable against the CRM-first rollout order.

### 41.2 Origami-style review and safety boundary

- Hub groups rendered rows by recipient without overwriting later steps, sorts them by frozen step order/key, and displays the sequence map, delay, provenance, word count, deterministic quality findings, exact subject/body/footer, and a short display of the exact step hash.
- The Review stage reports recipient count, email steps per recipient, and exact rendered-message coverage. Approval fails closed in the UI when any recipient-by-email-step row is absent or any rendered row needs review; CRM's existing authoritative approval checks remain unchanged.
- R32 adds no entity, migration, provider/model call, mailbox capability, execution capability, configuration/flag change, public GTM promotion, or customer exposure. Rollback is the prior Hub and CRM applications with no data change.

### 41.3 Acceptance

- CRM route-shape coverage proves that two rendered rows for the same recipient retain distinct step identity, order, hash, word count, and quality findings.
- Hub contract coverage proves rows are grouped rather than overwritten, the full sequence map and exact recipient-by-step review are present, and incomplete or quality-invalid sequences block the approval control.
- Full CRM GTM and Hub suites, both typechecks, focused CRM lint, Hub production build, and `git diff --check` must pass before merge. Roll out CRM first, dark-deploy app-only, then merge/deploy Hub. External-effect gates remain off.

### 41.4 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R32-A - additive exact-step response | Completed and dark-deployed | 2026-08-23 | Exact CRM main `513991019dcd0404c60fcf9e58a7012b16febf31` is deployed app-only as image `sha256:3e64d70313670caa836dfeadf239912f65d60d2ca5af216697865b05bc3f51b5`; no migration or flag changed |
| R32-B - exact sequence approval review | Completed and dark-deployed | 2026-08-23 | Exact Hub main `ea7a8366c2ba76f7bdcc6a52d69b8c0f44080170` is live on `app.noliai.com`; Hub and platform exact-main regression suites and production build passed; signed-out GTM access remains protected |

## 42. R33 deterministic exact-step manual editing (approved 2026-08-23)

### 42.1 API and storage contract

- Add campaign operation `update-message` for one exact draft recipient and one exact automated email step. The request binds `campaignId`, `candidateId`, `step_key`, the current 64-character `expected_content_hash`, the current 64-character `expected_message_hash`, `subject`, and core `body_text`.
- The operation is a registered command requiring `gtm.edit`. It re-resolves the represented user and exact organization/tenant scope through the existing internal route boundary. Candidate or message absence remains opaque; stale draft or message hashes return `409 stale_draft` before mutation.
- Manual copy is stored additively under `gtm_campaigns.channel_mix.message_overrides[candidateId][stepKey]`; no table, column, migration, provider call, or model call is added. Rendering precedence is manual override, then stored AI draft, then deterministic template. A later successful explicit AI redraft clears that recipient's manual overrides so the newly requested artifact becomes visible.
- The command takes a pessimistic write lock on the scoped campaign row before recomputing either hash. Concurrent editors serialize; after the first commit, the loser observes a different draft hash and fails stale instead of overwriting the first edit.
- The draft response adds `body_text_core` and extends display-only provenance with `manual`. The exact frozen `body_text`, HTML, footer, message hash, approval hash, and approval/execution contracts remain authoritative and unchanged.

### 42.2 Safety and product behavior

- Manual editing is available only while `campaign.status='draft'` and `current_version_id` is absent. An approved or launched version is never mutated or implicitly invalidated; the user must explicitly invalidate it before editing.
- The server trims and bounds subject/body, normalizes line endings, rejects template and compliance-footer tokens, and accepts only 12-130 core words. The postal address and one-click unsubscribe footer remain system-owned and are appended through the existing deterministic renderer.
- Before persistence, the server renders the prospective exact row and rejects any deterministic quality issue or copy that is not materially distinct from another automated email step for the same recipient.
- The write and a GTM audit event commit in one transaction. The audit contains only campaign/candidate/step identifiers, source/result hashes, and word count; it never stores subject, body, address, or recipient email.
- Hub exposes `Edit step` from both People preview and exact Review. The inline editor shows core word count, states that no AI/provider call occurs, displays the locked-footer boundary, supports Cmd/Ctrl+Enter and Escape, and echoes both captured hashes on save. A stale response cancels the editor, reloads truth, and requires a new review.

### 42.3 Acceptance

- CRM deterministic coverage proves exact-step isolation, new draft/message hashes, manual provenance, stale-hash refusal, approved-version immutability, token/footer/length refusal, cross-step distinctness, and PII-free audit metadata.
- Route-shape and authorization coverage prove additive `body_text_core`, manual provenance, and least-privilege `gtm.edit`. Existing campaign render, approval, and AI-draft suites must remain green.
- Hub contract and proxy coverage prove the exact request fields, locked-footer UI, manual provenance, no-model copy, and mandatory idempotency header. Full CRM GTM and Hub suites, both typechecks, focused CRM lint, Hub production build, and `git diff --check` must pass before merge.

### 42.4 Migration and backward compatibility

- This is additive API and JSON-draft state only. Existing callers may ignore `body_text_core` and the new `manual` provenance value; no field, URL, method, command, entity, column, or stored enum is removed or narrowed.
- Deploy CRM before Hub. An older Hub ignores the additive response. If Hub rolls back after CRM, saved manual overrides continue rendering safely. If CRM rolls back, the unknown JSON field remains inert and the draft safely reverts to existing AI/template rendering until CRM is restored; no approved artifact is altered because R33 refuses edits after approval.
- Rollback is the prior CRM and Hub applications with all execution, ingestion, provider, and public-exposure gates unchanged.

### 42.5 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R33-A - exact manual edit command | Completed and dark-deployed | 2026-08-24 | Exact CRM main `bf89b955768ddad09f4e95859fceddafe167095c` is deployed app-only as image `sha256:ab8e80f2b404dc459802679733ef7e078df6797ecff4fa6752d39916dee0aa65`; no migration, external call, or flag changed |
| R33-B - Hub exact-step editor | Completed and dark-deployed | 2026-08-24 | Exact Hub main `5707e386d58f1fcd7ed98f6f1fd567ffe53b20ed` is live on `app.noliai.com`; exact-main regressions passed and signed-out GTM access remains protected |

## 43. R34 editable sequence and delivery envelope (approved 2026-08-24)

### 43.1 Problem and proposed solution

- The five-stage campaign builder can review the exact recipient-by-step batch, but its sequence map and delivery settings are read-only after draft creation. That prevents the owner from operating the Origami-style Template and Settings stages without discarding and rebuilding the campaign.
- Add `update-sequence` and `update-settings` campaign operations. Both require `gtm.edit`, a Hub `Idempotency-Key`, and the exact current 64-character draft content hash. Both take a pessimistic write lock, recompute current truth, and return `409 stale_draft` before mutation when another edit won.
- Add read-only `list-senders`, scoped to the represented user's active, personal `email_connections` rows. It returns only id, provider, address, primary status, and update time. OAuth, SMTP, and IMAP credentials never leave CRM.

### 43.2 Canonical sequence and settings contracts

- Editable sequence input contains one to three email steps, one absolute day offset per email, and optional manual LinkedIn connect/follow-up and X direct-message tasks. Email 1 is day 0; later offsets must be strictly increasing whole days through day 30. The server derives stable step keys, order, mode, dependency, and social-action fields instead of accepting arbitrary executable shapes.
- Removing an email step prunes its stored AI and manual copy. Retained stable email keys retain their reviewed copy. This prevents removed copy from silently reappearing if a step is added again later.
- Editable settings contain the one-to-50 daily cap, whole-hour local send window, valid IANA timezone, zero-to-120-minute deterministic jitter ceiling, optional represented-user personal mailbox id, and explicit duplicate override. Monday through Friday remains the already-enforced scheduler rule and is displayed honestly rather than exposed as a control that the scheduler cannot honor.
- Sequence, settings, selected sender material, recipients, exact rendered messages, compliance footer, and projected cost remain bound into the existing canonical approval hash. Approved versions are immutable; the owner must explicitly invalidate before either new write is accepted.

### 43.3 Risks and impact review

| Failure scenario | Severity | Mitigation | Residual risk |
|---|---|---|---|
| Concurrent editor overwrites reviewed timing or sender | High | Campaign row lock plus exact draft-hash comparison | A user must reload and intentionally reapply a stale edit |
| Removed step copy returns after a later add | High | Prune removed step keys from both AI drafts and manual overrides in the same transaction | Retained stable steps intentionally keep their copy |
| Caller selects another user's mailbox or obtains credentials | Critical | Exact org, tenant, user, active, personal-mailbox query; metadata-only response | Organization-wide sender pooling remains unsupported |
| Duplicate override widens recipient overlap unintentionally | High | Conservative false default and explicit warning in Settings | An authorized editor can intentionally enable the override |
| UI implies configurable weekdays that runtime ignores | Medium | Surface the authoritative Monday-through-Friday rule as read-only copy | Custom weekday sets remain future scope |

### 43.4 Acceptance, integration coverage, and compliance

- CRM deterministic tests cover canonical timing validation, removed-step pruning, hash changes, stale refusal, approved-version immutability, represented-user sender scoping, credential non-disclosure, exact settings binding, redacted audits, route schemas, and least-privilege feature mapping.
- Hub contract and proxy tests cover the operable Template and Settings stages, exact-hash requests, mandatory idempotency, sender metadata read, Monday-through-Friday truth, and explicit duplicate override. Hub typecheck, production build, full tests, and diff check must pass.
- CRM full GTM tests, typecheck, focused lint, and diff check must pass. R34 adds no entity, column, migration, provider/model/mailbox call, send capability, ingestion capability, flag change, public promotion, or customer exposure.

### 43.5 Migration, rollout, and rollback

- R34 is additive API and existing JSON-draft state only. Existing callers can ignore the new operations and sender response. No durable schema contract is narrowed.
- Deploy CRM before Hub. Older Hub code ignores the new operations; the new Hub must not deploy against a CRM that lacks them. Rollback is the immediately prior CRM and Hub applications. Unknown JSON remains inert, while every approved version remains immutable.
- Keep `GTM_EXECUTION_ENABLED`, mailbox ingestion, LeadMagic, Bouncer, and public GTM promotion off. R34 does not authorize an email or provider call.

### 43.6 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R34-A - exact sequence/settings commands and sender catalog | Completed locally | 2026-08-24 | CRM passes 81/82 suites and 879/886 tests with only the opt-in PostgreSQL suite and seven tests skipped; typecheck, focused lint, and diff check pass; no migration or external effect |
| R34-B - operable Template and Settings stages | Completed locally | 2026-08-24 | Hub passes 1,241/1,241 tests, typecheck, production build, and diff check using the Noli design system with Origami workflow parity as the interaction reference |

## 44. R36 honest campaign outcome analytics (approved 2026-08-24)

### 44.1 Problem and proposed solution

- The owner can operate research, people, campaigns, inbox, senders, and provider usage, but cannot yet see campaign outcomes in one truthful read model. Provider acceptance, delivery confirmation, delivery failures, and human replies must not collapse into one success metric.
- Add read-only campaign operation `analytics` for one represented-user workspace. It returns count-only current-version outcomes across at most the newest 50 live campaigns and requires only `gtm.view`.
- Add a separate Hub Analytics screen. Existing Usage remains the money, provider-operation, and AI-cost surface; Analytics is the campaign-outcome surface.

### 44.2 Truth and privacy contract

- Provider-accepted recipients are unique current-version enrollments with an accepted timestamp or an accepted-chain state. This proves provider acceptance, not inbox placement or human attention.
- Confirmed-delivered recipients require a durable delivered timestamp or delivered state. Bounced and complained recipients remain separate. Opens and clicks are absent because GTM does not possess authoritative events for them.
- Human reply recipients require an inbound durable reply explicitly typed `human_reply` or `social_reply`. Delivery-system events and legacy rows without a human event kind do not count. Positive recipients are the unique subset classified `interested` or `referral`; unknown classifications remain explicitly unclassified.
- The response contains campaign identity and counts only. It never returns recipient addresses, message bodies, evidence, provider receipts, mailbox credentials, or reply content. Every query filters exact organization, tenant, workspace, soft-delete state, and current campaign version.

### 44.3 Risks and impact review

| Failure scenario | Severity | Mitigation | Residual risk |
|---|---|---|---|
| SMTP acceptance is displayed as delivery | High | Distinct `provider_accepted_recipients` and `confirmed_delivered_recipients` fields plus explicit UI copy | Provider delivery events remain dependent on mailbox/provider ingestion |
| Retries inflate recipient outcomes | High | Recipient metrics deduplicate by current-version enrollment while attempt totals remain explicit | A person enrolled in two campaigns counts once in each campaign |
| Old campaign versions contaminate the current report | High | Enrollment and attempt reads bind the campaign's exact current version | Historical-version analytics remain future scope |
| Delivery events are mistaken for human replies | High | Only explicit human or social reply event kinds enter reply metrics | Legacy untyped replies are conservatively omitted |
| Cross-tenant or content leakage | Critical | Exact org and tenant predicates on every query; count-only projection; deterministic isolation and non-disclosure tests | Campaign names remain owner-authored display labels |
| Large workspaces create unbounded reads | Medium | Newest 50 campaigns, one extra row only for truncation truth, then bounded enrollment/attempt/reply reads | Older campaigns require a future paginated history surface |

### 44.4 API, acceptance, and backward compatibility

- `POST /internal/gtm/campaigns` accepts additive body `{op:'analytics', noliUserId, workspaceId}`. Existing operations and response fields remain unchanged. The response reports `scope='current_campaign_versions'`, `campaign_limit`, and `truncated` so the Hub cannot imply complete history when the bound is reached.
- Deterministic CRM coverage proves org, tenant, workspace, soft-delete, and current-version isolation; unique-recipient deduplication; accepted-versus-delivered truth; human-versus-system reply separation; positive and unclassified outcomes; response non-disclosure; limit/truncation; schema validation; and least-privilege authorization.
- Hub coverage must prove the first-class Analytics navigation, honest labels, count-only response validation, bounded-history disclosure, loading/error/empty states, and the absence of invented open/click metrics.
- R36 adds no entity, column, migration, write command, provider call, model call, mailbox call, email, feature flag, public promotion, or customer exposure. Deploy CRM before Hub. Rollback is the immediately prior CRM and Hub applications.

### 44.5 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R36-A - count-only CRM analytics | Completed locally | 2026-08-24 | 82/83 GTM suites and 883/890 tests pass with only the opt-in PostgreSQL suite and seven tests skipped; TypeScript, focused lint, and diff checks pass; no migration or external effect |
| R36-B - Hub Analytics screen | Completed and dark-deployed | 2026-08-24 | CRM PR #78 and Hub PR #259 are merged and deployed owner-only; Analytics remains count-only and Usage remains separate |

## 45. R37 persisted Strategist continuity (completed 2026-08-24)

### 45.1 Product and safety contract

- The Hub Strategist resumes the latest persisted workspace thread, lists bounded recent conversations, and starts an explicit new chat without changing CRM chat storage or model authority.
- The Hub parser accepts at most 50 threads and 200 messages, validates workspace/thread identity and strict ordering, drops unknown/internal fields, hides tool rows, and preserves only the existing human-confirmed `confirm_research_run` action.
- Request fencing prevents stale workspace or thread responses from replacing the current selection. Existing quote/confirm/provider gates remain authoritative; resuming a conversation never executes a tool or provider call by itself.

### 45.2 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R37-A - bounded persisted chat continuity | Completed and dark-deployed | 2026-08-24 | Hub PR #260 merged as `2989b0111eefd713d895d1abb1dfccb440137bca`; 1,256 Hub tests, typecheck, production build, exact-main regressions, and signed-out access checks passed |

## 46. R38 bounded campaign auto-refill (approved 2026-08-24)

### 46.1 Product boundary and Origami parity

- R38 adds the missing Origami-style campaign auto-refill control: while active, Noli runs one bounded weekday research cycle for the campaign's exact Audience Play and places newly accepted identities into People for review.
- Auto-refill never edits an approved campaign version, creates or repoints an enrollment, drafts or approves a recipient message, launches a campaign, claims a send attempt, opens a mailbox, or sends an email. Adding any newly found person to outreach still requires a fresh exact recipient-by-step campaign approval.
- Campaign draft settings carry a canonical `auto_refill` block with `enabled`, `target_accepted_per_day`, `max_raw_candidates_per_day`, `max_credits_per_day`, `run_hour_local`, and the exact source `plan_hash`. Disabled is the backward-compatible default.
- The Hub must show both the accepted-person target and raw/credit ceilings. It must describe the outcome as people queued for review, not automatically contacted leads.

### 46.2 Immutable policy, schedule, and daily cycle

- Enabling the draft setting does not spend. Approval freezes the exact block inside the existing campaign content hash. A separate `gtm.launch` activation requires the current approved campaign-version hash and the same source-plan hash.
- `gtm_auto_refill_policies` is the durable standing authorization. It binds exact organization, tenant, workspace, play, campaign, campaign version, represented Noli user, resolved CRM user, Noli organization, policy hash, plan hash, limits, timezone, local run hour, status, fence, and last-cycle truth. One live row exists per campaign.
- Activation registers one organization-scoped platform schedule at `0 <run_hour_local> * * 1-5` in the frozen campaign timezone, targeting the `gtm-auto-refill` queue and requiring `gtm.launch`. The schedule id is deterministic from the policy id. Pausing first changes the policy status/fence, then unregisters the schedule; a scheduler failure therefore cannot authorize provider work.
- `gtm_auto_refill_cycles` is the run claim and history. The unique `(policy_id, local_date)` boundary permits at most one cycle per campaign-local weekday even under duplicate scheduler delivery. Each cycle freezes policy/version/plan hashes, links at most one normal `GtmResearchRun`, and stores only bounded count/status/credit diagnostics.
- A campaign-version invalidation blocks the associated policy in the same CRM transaction. An already claimed bounded provider cycle may finish, but no later cycle may start until the owner approves and reactivates a current version.

### 46.3 Identity, money, and failure contract

- `GTM_AUTO_REFILL_ENABLED` is a separate off-by-default runtime gate. The worker returns before reading its payload, resolving dependencies, loading credentials, reserving credits, or constructing an adapter unless both the GTM module and auto-refill gates are true.
- On every cycle the worker re-resolves the represented Noli user and primary Noli organization, maps the Clerk identity back to the exact stored CRM user/org/tenant, and rechecks `gtm.launch`. Identity, entitlement, or role drift blocks the policy before spend.
- Before claiming a cycle the worker rebuilds the current source plan from the current play and eligible adapter descriptors. Any play, geography, provider, rights, terms, price, capability, limit, or plan-hash drift blocks the policy and creates no provider operation.
- The normal canonical Noli Core quote/reserve/start/single-flight/settle-or-reconcile research path remains the only money path. The per-day credit ceiling must admit at least one quoted batch, and no cycle can reserve beyond the frozen limit.
- A cycle that reaches unresolved provider or ledger truth becomes `reconciliation_required` and blocks the policy. It is never retried automatically. A deterministic pre-provider failure records a failed/blocked cycle without provider output; the next day remains disabled until the owner explicitly repairs and reactivates safety-sensitive failures.

### 46.4 API, acceptance, migration, and release

- Add an internal auto-refill API with `plan`, `status`, `activate`, and `pause`. It uses shared-secret application authentication plus represented-user resolution, requires `gtm.view` for reads and `gtm.launch` for activation/pause, scopes every row by organization and tenant, and returns no credential, provider body, person data, or represented-user identifier.
- Deterministic coverage must prove canonical setting normalization; exact plan/content-hash activation; stale/foreign/version-invalid refusal; scheduler registration and pause ordering; gate-before-payload/dependency behavior; identity/RBAC revalidation; policy and local-date idempotency; plan drift; raw/credit ceilings; reconciliation blocking; redacted diagnostics; and zero enrollment/send mutation.
- ORM entities are source of truth. Generate one additive GTM migration plus synchronized snapshot; apply/reapply it on a disposable full current-main database and require a second generator pass with no GTM drift.
- R38 may merge and deploy owner-only dark with `GTM_AUTO_REFILL_ENABLED=false`. No provider call is part of local verification. A later controlled owner-only cycle requires the exact gate, a current approved policy, an explicit bounded daily budget, and execution/mailbox/public-promotion gates still off.
- Rollback is the auto-refill gate off, every policy paused, scheduler records unregistered, and the prior CRM/Hub applications. Additive policy/cycle tables and historical research/provider evidence remain inert and are not dropped.

### 46.5 Implementation status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R38-A - immutable settings/policy/cycle contract | Completed and dark-deployed | 2026-08-24 | CRM PR #79 merged as `b33921882b857df94747ee9cd528a125986d8fdd`; the exact generated schema was already present on the controlled host, so migration `Migration20260824081513_gtm` was adopted in the ledger only after exact read-only schema proof. Source and ledger both contain eight GTM migrations. |
| R38-B - Hub settings and review-queue UX | Completed and dark-deployed | 2026-08-24 | Hub PR #261 merged on main `ac47506df9afb5983341cda2aa74bce6be7a9867`; production deployment `dpl_SNfd8Ycx3MuTSi7cY6Za3rUfyQnU` is ready on `app.noliai.com`; 1,268 Hub tests, typecheck, production build, and diff checks passed. |
| R38-C - owner-only dark validation | Completed dark | 2026-08-24 | The runtime gate remains off. Production has zero auto-refill policy rows, zero cycle rows, and zero `gtm-auto-refill` schedules. The deployed owner UI exposes bounded settings and queues future findings for review; no cycle, provider call, enrollment, mailbox action, or send was created. |

## 47. R39 executable enrichment quote truth (approved 2026-08-24)

### 47.1 Problem and invariant

- Owner-only dark validation found a 10,000-credit enrichment preview for one accepted person even though that person's exact non-fingerprinted Apify profile-enrichment operation was already terminal and the execution waterfall would deterministically make no provider call.
- A quote must describe executable work. The user must not be asked to approve a charge ceiling for an operation that the canonical idempotency boundary will necessarily suppress.

### 47.2 Contract

- Enrichment plan schema v5 reads tenant-scoped `contact_enrich` shadow projections for the selected candidates and freezes their provider/status truth into the plan hash.
- Candidate-level suppression applies only when the adapter's operation key is exactly candidate plus adapter. Adapters with an additional request fingerprint remain eligible because the existing shadow does not retain enough identity to distinguish old input from corrected input.
- `reserved` remains executable. Terminal/released operations are omitted from provider units and reported through `operations_already_consumed`. `provider_started`, `reconciliation_required`, missing mirrors, and other unresolved pre-terminal states are omitted and reported through `operations_requiring_reconciliation`; they are never silently retried.
- The route rebuilds this plan immediately before execution, so any operation-state drift invalidates the approved hash. The execution waterfall and canonical ledger remain the authoritative single-flight and money boundaries.
- R39 adds no entity, migration, provider capability, flag, mailbox capability, send capability, or public exposure. It makes no external provider call.

### 47.3 Acceptance and status

- Deterministic coverage proves consumed suppression, reserved continuation, unresolved-operation parking, and non-inference for request-fingerprinted adapters.
- The full GTM baseline passes 86/87 suites and 907/914 tests with only the opt-in PostgreSQL suite and seven tests skipped. Mercato typecheck, focused lint, focused quote tests, full package/application production build, and `git diff --check` pass.

| Phase | Status | Date | Notes |
|---|---|---|---|
| R39-A - executable quote truth | Completed locally | 2026-08-24 | Migration-free CRM route/plan/test correction; no provider, mailbox, email, flag, schedule, or production state changed. |
| R39-B - current-main release and owner-only read validation | Completed and dark-deployed | 2026-08-24 | CRM PR #80 merged and deployed as exact main `ba6d8efaca839e4121258b5f86c871b17f8757c7`; Hub PR #262 deployed as exact main `6a5dd933297e6652915cf367c563fcae56d35e81`. The owner refreshed the same selected-play plan and received an already-checked state with no confirm/run action. Provider-operation rows remained exactly 20 with the same latest timestamp, while auto-refill policies, cycles, and send attempts remained zero. |

## 48. R40 bounded owner production lifecycle (approved 2026-08-24)

### 48.1 Authority and hard boundary

- R40 is authorized to complete one production lifecycle with one owner-controlled sender, one owner-controlled recipient, one message, one reply, one unsubscribe, and exact reconciliation. It authorizes no prospect email, bulk outreach, public customer promotion, or hidden widening.
- The owner-controlled transport identity must be explicitly labeled and audited. It must never be represented as a provider-sourced lead, included in an export, or retained past the bounded pilot evidence window.
- LeadMagic and Bouncer remain excluded. DataForSEO and contract-pinned Apify capabilities remain the selected source stack.

### 48.2 Budgets and activation order

- The campaign daily cap is one and duplicate override is false. The only auto-refill block authorized for approval is one accepted identity, five raw rows, and 25,000 credits per weekday at 09:00 America/Los_Angeles. The current exact source quote is 10,500 credits for five rows.
- Auto-refill may be frozen into the immutable campaign approval, but its runtime gate and schedule remain off until the send, reply, suppression, and money lifecycle is clean.
- Execution and mailbox ingestion may be enabled only after a current v2 unsubscribe keyring, an explicit HTTPS public base, exactly one recipient, and exact approval are all present. Customer/prospect email additionally requires the sending customer's valid physical postal address; R40 alone permits the owner-authorized synthetic fixture for its owner-to-owner transport proof.

### 48.3 Provider outcome honesty

- The first R40 source run returned five company rows, accepted three, rejected two, charged 10,500 credits, and created no duplicate identity. Three bounded decision-maker resolutions created no trustworthy person: one definitive no-result and two schema-binding failures that exposed no person output.
- The two ambiguous provider operations were reconciled against exact Apify account run ledgers, at `$0.026`/13,000 credits and `$0.023`/11,500 credits after markup. No operation was retried, every canonical/local shadow is terminal, and unusable rows remain withheld.
- Full PII-free evidence, exact production ids, owner/legal decisions, budgets, stop conditions, and the remaining lifecycle sequence are recorded in `analysis/DELIVERY-SPEC-067-R40.md`.

### 48.4 Current status

| Phase | Status | Date | Notes |
|---|---|---|---|
| R40-A - production preflight and unsubscribe key rotation | Completed | 2026-08-24 | CRM/schema/sender/provider posture verified; explicit HTTPS base and v2 rotatable key configured from a recovery-backed environment edit |
| R40-B - bounded source and provider reconciliation | Completed | 2026-08-24 | Five-row source batch plus three one-company resolution attempts are terminal; ambiguous rows were withheld and exact account charges reconciled |
| R40-C - one-recipient approval envelope | Completed for owner pilot only | 2026-08-24 | Version `a19b38ad-476c-401e-ab46-925513af2027` freezes one owner-controlled recipient, one manually reviewed step, a one-send cap, exact auto-refill limits, and the owner-authorized synthetic footer; customer/prospect activation remains blocked on a real sender address |
| R40-D - production worker discovery and isolated mailbox queue | Completed locally | 2026-08-24 | Both generated registries contain all three GTM workers; 86/87 GTM suites and 908/915 tests pass with only the opt-in PostgreSQL suite/seven tests skipped; all 15 CLI suites/180 runnable tests, CLI and CRM typechecks, focused lint, full production build, YAML parse, and diff checks pass |

### 48.5 Production worker registration and isolated queue

- The owner authorized a clearly synthetic postal fixture for the owner-to-owner transport proof only. The fixture must never be reused for prospect/customer outreach or treated as a compliance-ready customer address. Customer activation still requires the sending customer to provide their own valid business postal address during setup; the workspace-scoped value is automatically footer-rendered, approval-hash-bound, and rechecked before dispatch.
- Production inspection found that app-local worker convention files were discovered but silently omitted from both generated registries. `processWorkers` tested `metadata` by dynamically importing a generated relative path from the generator module, so app-local imports resolved from the wrong directory or failed on runtime-only dependencies. The generator now statically verifies the named `metadata` export in the exact discovered source file and emits the normal worker import unchanged.
- Regression coverage requires an app-local worker with a deliberately unavailable generation-time dependency to appear in both the server and CLI registries. A regenerated CRM artifact must contain the GTM mailbox-ingest, execution-tick, and auto-refill workers.
- Production mailbox ingestion uses a GTM-only queue strategy override and one dedicated Redis-backed `gtm-mailbox-ingest` worker at concurrency one. The global queue strategy remains unchanged, so enabling the pilot cannot silently move unrelated events, schedules, payments, search, or workflow jobs to BullMQ.
- Redis is network-internal, persistent with append-only logging, health-checked, and not host-published. The application remains available if Redis is unhealthy; the mailbox enqueue boundary instead fails closed. The worker waits for application, database, and Redis readiness.

### 48.6 Customer release, address, metering, and retention boundary

- Prospect sourcing, qualification, and enrichment do not require a postal address. The sending customer's valid physical postal address becomes mandatory only at campaign approval and is frozen into the exact approved footer. Dispatch rechecks that binding before transport.
- Every selected paid provider path uses the canonical quote, reserve, start, settle or ambiguity flow. Provider settlement writes the charged amount into the shared pooled-credit usage ledger. The anonymous Audience Plays generator is Noli-funded acquisition spend until a report enters an authenticated workspace.
- Paid-plan entitlement reconciliation grants `features.gtm=true`. The Hub and CRM release flags remain independent fail-closed gates, so the entitlement bit alone cannot expose the product. Provider credentials, provider execution, mailbox ingestion, campaign execution, and auto-refill retain their independent gates.
- The public prospect-removal path is part of customer release. It deletes any matching prospect rows, stops queued outreach, and writes platform-wide suppression without disclosing whether a row existed.
- The service-only `POST /internal/gtm/retention` process route runs the existing global 90-day candidate sweep under `NOLI_INTERNAL_SERVICE_SECRET`. The caller cannot supply an organization, cutoff, or actor. The route returns count-only results and must be scheduled daily before the public privacy disclosure can claim routine deletion.

## 49. AUG-18 shared-context onboarding and first value

- The Noli Hub's owner-confirmed Intel Hub context may create the organization's default GTM workspace during the existing service-authenticated CRM profile seed. Identity is still re-resolved through the CRM entitlement boundary, `gtm.edit` is rechecked, and every read/write remains scoped by organization plus tenant.
- The seed stores the confirmed business context with `source=noli_intel_hub`, a bounded context version, and explicit verification status. It creates at most one unlocked version-one ICP starter and one unlocked version-one voice starter only when no live version exists. Both carry agent provenance and `status=unverified` / `needs_review`; inferred content is never locked or represented as customer-confirmed.
- Repeated seed calls merge the newest confirmed Intel Hub block into workspace context but never overwrite an existing ICP/voice version, approved campaign, play, provider result, mailbox, enrollment, or app-owned CRM customization. The CRM standalone onboarding flag is completed because Hub context already supplied the shared questions; genuinely CRM-specific setup remains just in time.
- The response distinguishes setup from value: CRM returns a configured-pipeline/follow-up-draft receipt and GTM returns workspace/starter creation truth. No model, provider, credit, mailbox, campaign, enrollment, send, public-promotion, or auto-refill action occurs in this path.
- Rollback is the CRM deployment plus either runtime gate off. Existing additive workspace/version/audit rows remain inert and reviewable; no schema rollback is required.

## 50. Changelog

- 2026-07-23: Initial Tranche 0 contract freeze (documentation only; no implementation).
- 2026-08-02: Added accepted-yield sourcing, `fit-v3` criterion-aware qualification, funnel diagnostics, and authoritative provider billing/ambiguity rules. Implementation remains local, uncommitted, flag-off, and undeployed.
- 2026-08-17: Renumbered from SPEC-066 to SPEC-067 on the C0 current-main integration base (`7abd37f32da83c55c4eb46e68735e45a0fce62ed`). C0 is an inert integrity tranche only; it does not authorize provider access, sending, migration application, deployment, or customer exposure.
- 2026-08-17: Added the approved C1 inert lifecycle closeout for distinct sequences, sender/capacity binding, provider reconciliation, durable inbound/delivery events, deletion/DSR, and unsubscribe key rotation. External effects remain disabled and separately gated.
- 2026-08-17: Completed the local C1 implementation and disposable verification. Added generated CRM migration `Migration20260818052128_gtm`, additive Noli Core `provider_op_reconcile`, and 25-table GTM schema verification. No external effect or release gate was opened.
- 2026-08-17: Added the approved C2 dark mailbox-lifecycle contract for Gmail/Graph MIME transport, incremental cursors, an idempotent gated worker, reputation pauses, redacted diagnostics, observational token/cost telemetry, GTM AUG-04 fixtures, and disposable PostgreSQL race evidence. No external effect is authorized.
- 2026-08-17: Completed the local C2 implementation and verification: 58 GTM suites/671 unit tests plus four disposable PostgreSQL cases, full CRM typecheck/lint/build/generate/i18n gates, and Noli Hub 1098 tests/typecheck. Added generator-owned `Migration20260818061808_gtm`. Gmail/Graph/provider fixtures were network-injected; no external provider, mailbox, email, or shared database was contacted.
- 2026-08-17: Approved the C3 dark operator-control tranche: fenced mailbox-pause recovery, gate-before-queue manual ingestion, explicit token-usage truth, and bounded AI telemetry diagnostics. No execution, ingestion, provider, migration, deployment, or customer authority was opened.
- 2026-08-17: Completed C3 locally. Added generator-owned `Migration20260818064623_gtm`, five deterministic operator/telemetry suites, five QA scenarios, and two additional PostgreSQL race/truth cases. The disposable database applied the migration once, re-migrated with nothing pending, and generated no GTM drift; all external-effect gates remained off.
- 2026-08-17: Approved C4 to close the remaining local campaign-control and cross-campaign mailbox-capacity gaps. C4 remains an inert code/schema tranche and grants no external-effect authority.
- 2026-08-18: Completed C4 locally. Added generator-owned `Migration20260818070046_gtm`, exact-hash pause/resume/stop commands, pre-dispatch lifecycle fencing, and one immutable policy/capacity namespace per mailbox. All 65 normal GTM suites (693 tests) and seven disposable PostgreSQL cases passed; migration replay reported no pending work and the generator reported no GTM drift. External-effect gates remained off.
- 2026-08-18: Approved C5 to make the documented campaign `completed` state reachable only after exact-envelope, definitive email and explicit manual-task truth checks. C5 is code/test/spec only and grants no external-effect authority.
- 2026-08-18: Completed C5 locally. Exact replay-safe completion now requires terminal current-version email attempts and explicit terminal outcomes for every derived manual-social task, completes active enrollments transactionally, and preserves ambiguous/in-flight work as a blocking truth state. Full GTM verification passed 65 suites/694 deterministic tests with TypeScript, lint, and diff checks green; no schema, provider, mailbox, deployment, or exposure action occurred.
- 2026-08-18: Approved C6 to register a hard-gated execution queue target without creating a schedule or changing any flag. Both GTM and execution gates must be true before payload/dependency access; C6 grants no provider, mailbox, migration, deployment, or customer authority.
- 2026-08-18: Completed C6 locally. Registered a single-concurrency execution queue target that returns before payload/dependency access unless both gates are true, parks expired post-dispatch work as ambiguous, and sequentially reuses the existing database claim/fence and transport boundaries. Full GTM verification passed 66 suites/702 deterministic tests with TypeScript, lint, and diff checks green; no schedule or external effect was created.
- 2026-08-18: Approved C7 to bound Strategist persistence, history, tool results, and tool-call fanout deterministically. C7 adds no schema, model call, provider call, flag, deployment, or customer authority.
- 2026-08-19: Added the R1 offline provider-contract integrity tranche. Enrichment quote schema v3 deduplicates exact normalized email verification, and DataForSEO depth/keyword/price-multiplier constraints now fail closed before provider contact. Deterministic fixtures only; all provider gates remain off.
- 2026-08-19: Added R1b deterministic same-provider continuation. Source plan schema v5 freezes bounded offsets and skips later pages after exhaustion or ambiguity; LeadMagic remains dark and no provider call was made.
- 2026-08-19: Added R1c fit-v4 company-size semantics. Partial provider-bucket overlap now requires review, disjoint ranges reject, and plan schema v6 invalidates stale qualification approvals. Deterministic fixtures only.
- 2026-08-18: Completed C7 locally. CRM now enforces shared 64 KiB chat-content and 200-row read limits; Hub caps cumulative history, per-message/tool content, final output, and total tool requests without an extra model call. CRM passed 66 suites/704 tests and Hub passed 919 top-level/1,105 total tests plus TypeScript, lint, production build, and diff checks; every external-effect gate remained off.
- 2026-08-20: Added R2's executable synthetic no-send activation rehearsal and fixed first-import UUID visibility before the initial ORM flush. The disposable scenario passes Audience Play import through launched campaign state while the execution tick remains a dry run; all identities and provider rows are synthetic and every external-effect gate remains off.
- 2026-08-20: Added the R3 Gemini 3.7 GTM-only drafting contract with low thinking, deprecated-parameter removal, thought-token accounting, and a dated observational price boundary. No flag or external-effect authority changed.
- 2026-08-20: Verified one authorized synthetic DataForSEO Live Advanced request at an exact `$0.002` root/task charge and corrected the dark adapter contract to require explicit provider-retention truth before eligibility. No provider flag, customer-use approval, prospect data, outreach, deployment, or customer exposure changed.
- 2026-08-20: Approved R4 for one user-owned Gmail-to-Yahoo/Proton campaign message and one owned reply in a disposable loopback environment. Added the no-history IMAP baseline and an opt-in, two-message rehearsal contract; production and shared-live posture remain dark.
- 2026-08-20: Completed R4 with owner-confirmed Gmail-to-Yahoo delivery and a Yahoo reply. The second disposable run recorded one SMTP-accepted attempt, one sealed IMAP cursor, one exact-header inbound event, one durable reply, and the transactionally coupled `email_reply` enrollment stop. Two stale harness-only state labels (`sent` vs `accepted`, `reply` vs `email_reply`) were corrected; no production or shared-live state changed.
- 2026-08-20: Added R5's disposable public RFC 8058 route scenario. A deterministic test-only v2 keyring crosses the actual GET/POST handler and verifies opaque tamper handling, atomic suppression/stop/cancellation/audit, and replay idempotency without email, mailbox ingestion, provider access, or production state.
- 2026-08-21: Completed R6 runtime provider selection around DataForSEO and eligible Apify. LeadMagic and Bouncer remain auditable source/tests but their environment variables cannot register them; no real-email verifier is selected. Full GTM validation passed 66/67 suites and 727 tests, with only the opt-in PostgreSQL concurrency harness skipped.
- 2026-08-21: Completed R7 represented-user authorization across every internal GTM route. The service secret remains application authentication only; paid provider work, reply sending, execution, and safety-sensitive controls require the represented user's `gtm.launch` feature. Full GTM validation passed 67/68 suites and 730 tests, with only the opt-in PostgreSQL concurrency harness skipped.
- 2026-08-21: Completed R8 around the current eligible Apify actor stack. Only LinkedIn post comments and exact profile enrichment are selectable; post search, reactions, X, and arbitrary actor overrides fail closed. Current exact terms/price versions and code-bound selected-actor rates are required, and Apify remains disabled.
- 2026-08-21: Added R9 around the written DataForSEO rights/rate/retention clarification. Eligibility now requires exact June 12 terms, exact current price version, 30-day JSON retention, and one code-bound `$0.002` Live Advanced task capped at 100 rows; no provider call or production configuration changed.
- 2026-08-22: Corrected the production-proven DataForSEO Maps location contract to emit canonical US location names, retain task-level validation truth, and fail a run honestly when every provider batch errors. The observed rejected task was authoritatively zero-cost and fully refunded; this correction makes no provider call by itself.
- 2026-08-22: Added R16's exact Apify LinkedIn company-search contract for accepted-yield firmographics. It freezes the actor/build, supported filters, public evidence shape, `$0.004` full-company event, `$0.001` actor-start event, and a separate exact price-version gate; no R16 provider call or exposure change occurred in this code tranche.
- 2026-08-22: Completed one owner-only R16 company-source golden motion and removed response-body snippets from the company adapter's durable receipts. The exact run reconciled 20,500 credits for 10 raw rows and produced one accepted of four new identities; no contact, campaign, mailbox, or send work occurred.
- 2026-08-22: Added R19 contextual candidate matches after the golden run proved workspace identity dedupe could otherwise suppress a later play's fit verdict. Candidate identity remains deduplicated; run/play qualification, evidence, review, enrichment, and campaign selection are now contextual and independently auditable.
- 2026-08-22: Approved R21's accepted-company decision-maker resolver. The tranche freezes a Basic/Short Apify company-employees contract, additive company/person relation evidence, exact quote confirmation, and owner-only UI while keeping email verification, execution, mailbox ingestion, and public GTM promotion off.
- 2026-08-22: Completed R21 locally with a conservative `$0.004`-per-profile quote while the Actor's public pricing table and input label differ. Added deterministic company-to-person evidence, privacy/retention handling, canonical-ledger single-flight, owner-only Hub quote/confirm controls, and generator-owned `Migration20260822181927_gtm`; all local gates passed without a provider or email call.
- 2026-08-22: The R21 owner-only provider run returned the current plural `currentPositions[].title` shape and charged `$0.029`, but its batch echo could not safely bind any of three rows to one of ten submitted companies. No person, contact point, or relation was persisted. Plan schema v2 now permits exactly one frozen company per operation and requires the row's single `_meta.query.currentCompanies` URL to match it before persistence; plural and legacy position shapes remain covered without name-only guessing.
- 2026-08-22: Completed the R21 owner-only golden motion with one safely company-bound person from a bounded three-row response; the other two rows were withheld and the operation reconciled as partially charged. Added R24 progressive one-company continuation and the owner lead runway without opening another provider, mailbox, email, or public GTM gate.
- 2026-08-22: The first schema-v2 single-company run returned three profiles for one submitted company. Two current positions belonged to unrelated companies and were correctly withheld. The third named the submitted company but used LinkedIn's numeric canonical company URL already present as `linkedin_company_id` in the upstream source evidence, so all three were conservatively parked. Plan schema v3 freezes that id and accepts only the exact slug or exact frozen numeric alias while preserving fail-closed behavior for contradictory URLs.
- 2026-08-24: R40 production receipts proved that single-company Short-mode query echoes are not sufficient current-employer evidence: all three returned positions named other companies, and one carried a contradictory LinkedIn company URL/id. R45 pins build `0.0.157`, switches to bounded Full-mode work history, requires a current exact URL/frozen-id/name binding in addition to the sole query echo, and settles only from a durable run id plus finalized `$0.020` start/`$0.008` full-profile events. The default three-profile authorization remains capped by the provider's `$0.05` minimum.
- 2026-08-23: Approved R25's exact Apify email-verification contract. The selected build can promote only explicit non-catch-all SMTP proof; incomplete results stay honestly risky, not-found, or unknown. LeadMagic/Bouncer and every email execution or ingestion gate remain off.
- 2026-08-23: Completed R25-A/B locally. Added the separately gated Apify verifier, immutable provider cap and event settlement, redacted provenance, selected-provider catalog disclosure, and customer-language Hub results; all deterministic validation passed without a provider call.
- 2026-08-23: The first owner-only R25 golden returned a conservative risky/free-provider result with explicit SMTP method, build `0.1.49`, no ambiguity, and no email send. Apify's run ledger charged `$0.004` despite confidence 5, contradicting the published event-threshold description; Noli initially settled only the `$0.001` start event before markup. The capability was disabled immediately and the contract was version-bumped to charge every emitted row before any rerun.
- 2026-08-23: Completed the corrected R25 owner-only golden. The same pinned build returned the expected conservative risky/free-provider classification for one owned address and again billed `$0.004`; Noli reserved 5,000 credits and settled exactly 2,000 after markup. The canonical transitions were `reserved` -> `provider_started` -> `charged`, the durable provider receipt remained address-redacted, no email was sent, and the disposable product rows were soft-deleted. The exact verifier gate is on only for the owner-only dark flow; execution, mailbox ingestion, LeadMagic, Bouncer, and public GTM promotion remain off.
- 2026-08-23: Approved R26's actionable reviewed-lead surface: count-only qualification diagnostics plus an explicit, audited, suppression-aware CSV export of accepted people with verified work email and export-permitted evidence. No provider, schema, mailbox, send, flag, or exposure authority changed.
- 2026-08-23: Completed R26 locally. Export permission is fail-closed across every contextual evidence row; current suppression and legacy unsubscribe checks run immediately before export; deterministic audit idempotency binds the exact result fingerprint without recording PII; and the Hub validates the complete response, neutralizes spreadsheet formulas, and generates the CSV only on an explicit click. Deterministic tests, typechecks, and both production builds pass. Deployment remains owner-only dark and changes no provider, mailbox, send, schema, flag, or public exposure posture.
- 2026-08-23: Added R27's person-only enrichment scope after the owner golden exposed that accepted company accounts inflated a one-person contact quote. Plans and direct waterfall execution now exclude companies and company contact points before any reservation; no provider, mailbox, send, schema, flag, or exposure gate changed.
- 2026-08-23: Added R28 after the exact R27 Apify run proved adaptive event billing: one `$0.004` profile event and zero `$0.01` email-search events. Profile enrichment now preserves a durable run id, waits for finalized event counts, validates the frozen price map and total before reading output, and settles exact cost or parks ambiguity. The historical owner-only operation's 3,000-credit overcharge remains explicitly recorded for a future additive canonical compensation; no email, verifier, mailbox, execution, schema, or public-exposure gate changed.
- 2026-08-23: Completed R29 outside CRM with one additive, replay-safe 3,000-credit Noli Core adjustment for the immutable R27 overcharge. The original operation and usage rows remain unchanged; the adjustment was read-verified and replay-verified before R30 began.
- 2026-08-23: Added R30's bounded public-company-website contact fallback. The exact Apify website crawler is separately dark-gated, quote/confirm capped, same-domain only, receipt-redacted, and billed from finalized platform usage. It produces source-backed `found` addresses only; independent verification and all campaign/send gates remain unchanged and off.
- 2026-08-23: Dark-deployed the R30 retention-bound contract and completed one bounded surrounding golden motion. The accepted-company resolver created one accepted person; exact profile enrichment found one work address; verification stayed honestly `unknown`; canonical Noli Core charged 12,000, 5,000, and 2,000 credits with no ambiguity. The earlier profile short-circuited the website fallback as designed, and no email, mailbox ingestion, execution, or public GTM promotion occurred.
- 2026-08-23: Added R31's exact candidate email-readiness projection and People-table labels so found, risky, catch-all, unknown, ambiguous, and absent contact states no longer collapse into `Not verified`. This is additive read/UI work only and changes no external-effect gate.
- 2026-08-23: Dark-deployed R31 CRM-first, then Hub, with no migration or flag change. Added R32's exact recipient-by-step campaign read model and approval review so later sequence steps can no longer be hidden by recipient-level row collapse. External-effect gates remain off.
- 2026-08-23: Dark-deployed R32 CRM-first, then Hub, with no migration or flag change. Added R33's double-hash-bound manual editor for one recipient and one email step; the system-owned footer, immutable approval boundary, and every external-effect gate remain unchanged.
- 2026-08-24: Dark-deployed R33 CRM-first, then Hub, on exact current-main artifacts. Completed R34's migration-free sequence, delivery-settings, and represented-user sender editing contract locally; every external-effect gate remains unchanged and off.
- 2026-08-24: Approved R36's count-only current-version campaign analytics contract. Provider acceptance, confirmed delivery, delivery failures, human replies, and positive/referral outcomes remain separate; no external-effect gate changes.
- 2026-08-24: Dark-deployed R36 CRM-first and Hub second, then dark-deployed R37's bounded persisted Strategist continuity. Signed-out GTM access remains opaque and no external-effect gate changed.
- 2026-08-24: Approved R38's bounded campaign auto-refill foundation. Auto-refill may source at most one frozen weekday research cycle per campaign-local date and queues results for review; it cannot enroll recipients or send, and its separate runtime gate remains off.
- 2026-08-24: Completed R38-A locally with a generator-owned additive migration, exact policy and plan hashes, tenant-scoped weekday scheduling, duplicate-cycle prevention, represented-user reauthorization, count-only outcomes, and explicit no-enrollment/no-send tests. The runtime gate remains off pending dark release and Hub controls.
- 2026-08-24: Dark-deployed R38 CRM and Hub, adopted the already-proven production schema in the migration ledger, and verified zero policy rows, cycles, or schedules while the runtime gate remained off. Added R39 after the owner-only People flow exposed a quote for an already-consumed enrichment operation; plan schema v5 now omits exact non-fingerprinted terminal work and parks unresolved operations before confirmation.
- 2026-08-24: Dark-deployed R39 CRM-first and Hub second on exact current-main artifacts. The same owner-only enrichment preview now reports that the accepted people were already checked, exposes no confirm/run action, and creates no provider operation, auto-refill policy/cycle, or send attempt. Execution, mailbox ingestion, auto-refill, LeadMagic, Bouncer, and public GTM promotion remain off.
- 2026-08-24: Approved and began R40's bounded owner production lifecycle. Production preflight, v2 unsubscribe rotation, one capped source batch, exact provider-ledger reconciliation, and a one-recipient/one-message approval envelope are complete; the valid physical sender postal address remains the only approval/send gate, and every execution, ingestion, auto-refill, and public-promotion control remains off.
- 2026-08-24: The owner authorized a synthetic address for the owner-to-owner transport proof only, and campaign version `a19b38ad-476c-401e-ab46-925513af2027` was approved with one recipient. R40 also corrected the generator defect that omitted every app-local worker and added an isolated Redis-backed GTM mailbox worker without changing the global queue strategy. No message was launched or sent by this code change.
- 2026-08-24: Added R47's customer-release boundary: paid-plan GTM entitlement propagation, prospecting-before-address semantics, public removal disclosure, canonical provider metering language, and a shared-secret global retention process route. Provider, mailbox, execution, and auto-refill activation remain independently gated.
- 2026-08-25: Added AUG-18 shared-context onboarding. Hub-confirmed context now completes the duplicate CRM welcome gate and creates an idempotent, unlocked, explicitly unverified GTM ICP/voice starter without any model, provider, credit, campaign, enrollment, mailbox, or send side effect. GTM is included in every paid Noli plan; feature flags remain fail-closed operational controls.
