# SPEC-067: GTM Engineer durable domain, execution, and provider contracts

**Date:** 2026-07-23 PDT
**Status:** C1 inert lifecycle closeout and C2 dark mailbox lifecycle implemented and locally verified. The module remains inert: no provider call, shared or production migration, deployment, outreach, or customer exposure is authorized by this spec.
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
- Verification is address-scoped within the exact organization and tenant. Enrichment plan schema v3 quotes one call per normalized email address; an unambiguous existing terminal result is reused for duplicate contact-point rows with provenance, while conflicting historical states disable reuse and require reconciliation. Unidentified rows remain independently quoted.
- DataForSEO Maps defaults to a frozen depth of 100 results. An operator may explicitly lower or raise that ceiling only up to the provider maximum of 700; the quote and request use the same ceiling and 100-result billing blocks. Keywords over 700 characters and search operators that multiply the frozen base price are rejected before provider contact.

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

## 23. Changelog

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
- 2026-08-18: Completed C7 locally. CRM now enforces shared 64 KiB chat-content and 200-row read limits; Hub caps cumulative history, per-message/tool content, final output, and total tool requests without an extra model call. CRM passed 66 suites/704 tests and Hub passed 919 top-level/1,105 total tests plus TypeScript, lint, production build, and diff checks; every external-effect gate remained off.
