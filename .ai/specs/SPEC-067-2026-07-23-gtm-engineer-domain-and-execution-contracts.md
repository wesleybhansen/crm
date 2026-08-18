# SPEC-067: GTM Engineer durable domain, execution, and provider contracts

**Date:** 2026-07-23 PDT
**Status:** C0 current-main integration in progress. The module remains inert: no provider call, production migration, deployment, outreach, or customer exposure is authorized by this spec.
**Authority:** `~/dev/Noli AI/Software Strategy/gtm-engineer-build-plan-2026-07-23.md`. Companion: noli-platform `docs/specs/GTM-SPEC-01-2026-07-23-audience-plays-and-noli-core-credit-contracts.md` (Audience Plays engine, canonical noli-core credit ledger, Launchpad boundary).
**Launch classification:** optional-parallel, feature-flagged, OFF for the current Noli launch candidate.
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
- **Ambiguous-outcome inventory growth:** `ambiguous`/`reconciliation_required` rows require an operator surface (Usage/admin) - included in Tranche 6 scope; no automatic expiry, mirroring the OpenCode ambiguous-lease decision.
- **Residual:** reply correlation via headers is best-effort against mail clients that strip References; fallback matching (§9) narrows but cannot eliminate misses - accepted for V1 and surfaced honestly in the inbox.

## 16. Changelog

- 2026-07-23: Initial Tranche 0 contract freeze (documentation only; no implementation).
- 2026-08-02: Added accepted-yield sourcing, `fit-v3` criterion-aware qualification, funnel diagnostics, and authoritative provider billing/ambiguity rules. Implementation remains local, uncommitted, flag-off, and undeployed.
- 2026-08-17: Renumbered from SPEC-066 to SPEC-067 on the C0 current-main integration base (`7abd37f32da83c55c4eb46e68735e45a0fce62ed`). C0 is an inert integrity tranche only; it does not authorize provider access, sending, migration application, deployment, or customer exposure.
