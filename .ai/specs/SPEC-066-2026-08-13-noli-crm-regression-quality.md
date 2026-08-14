# SPEC-066: Noli CRM Regression and Reply Quality

**Status:** Implemented; local verification complete
**Owner:** AUG-04 isolated development lane
**Created:** 2026-08-13
**Base:** `origin/main` at `0bb650700f5fcc6576be2bcbee08c5ccd5b63e34`

## TLDR

Add focused, credential-free regression coverage for Noli-specific CRM boundaries and a versioned golden-task harness for customer-correspondence quality. Fast deterministic checks join normal CI; provider-scored evaluation remains bounded, synthetic-only, and manually or periodically invoked.

### Scope and Autonomous Assumptions

- Audit Noli customer, correspondence, calendar, integration, COS, MCP, entitlement, and health-projection surfaces.
- Add high-value deterministic contracts without duplicating generic Open Mercato CRUD coverage.
- Add versioned reply fixtures, rubrics, thresholds, deltas, diagnostics, offline dry-run, and optional scored execution.
- This is app-level Noli extension/testing work, not a core-platform redesign.
- Synthetic fixtures are the only evaluation data. Production data and credentials are prohibited.
- Deterministic safety failures always win; a judge cannot override them.
- Missing scored credentials produce an explicit skipped result, never a pass.
- Broad changes to transactional, entitlement, or approval semantics require separate follow-up specs.

## Overview

Noli builds customer-facing behavior on generic customer, message, inbox-operations, calendar, auth, and AI-assistant contracts. Existing framework suites protect broad CRUD behavior, while Noli-specific internal routes and reply generation have uneven protection. This specification adds a narrow app-owned quality layer without changing generic discovery, data models, or public APIs.

## Problem Statement

There is strong generic coverage for customers, messages, and inbox operations, but limited protection for Noli service identity, tenant-scoped calendar access, truthful health projections, and AI correspondence quality. A prompt can regress in grounding, consent, cross-tenant leakage, or draft-versus-send semantics without a deterministic pull-request signal.

## Coverage and Risk Inventory

| Surface                    | Action and expected behavior              | Important failure behavior                      | Existing coverage                        | Missing deterministic / AI quality              | Shared-live need        | Priority            |
| -------------------------- | ----------------------------------------- | ----------------------------------------------- | ---------------------------------------- | ----------------------------------------------- | ----------------------- | ------------------- |
| Contacts/companies         | Scoped CRUD, links, search                | Reject foreign IDs/invalid input                | Broad core API/UI                        | Noli imports; correct reply identity            | No                      | P1                  |
| Duplicate prevention       | Repeated capture reuses contact           | Phone-only, encrypted equivalents, rollback     | One-create app test                      | Real upsert idempotency; no invented history    | Disposable only         | P0 follow-up        |
| Deals/pipelines            | Stage belongs to pipeline                 | Reject mismatch/foreign stage atomically        | Broad core; mismatch currently permitted | Integrity and atomic reorder; real commitments  | No                      | P0 follow-up        |
| Activities/tasks/reminders | Scoped state, truthful delivery           | Provider failure remains retryable              | Core activities                          | Claim/delivery truth; no invented promises      | Provider sandbox        | P0 follow-up        |
| Search/filter/import       | Scoped, idempotent results                | Empty differs from unavailable/partial          | Generic coverage                         | Noli combined projections/mapping               | Disposable only         | P1                  |
| Calendar/booking           | Scoped connection, stable cursors         | Auth, 410, provider/malformed output typed      | No Noli route tests                      | Scope/pagination/failure; scheduling quality    | Google sandbox          | P0 in scope         |
| Correspondence/history     | Draft is not sent; persist after delivery | No double send; truthful provider failure       | Strong messages/inbox-ops                | Noli race/policy; grounding/tone/approval/edits | Controlled sink         | P0 quality in scope |
| Email desk                 | Scoped reply/archive/history              | Delivery failure is not `ok:true`               | Generic messages                         | Noli false-success/history                      | Email sandbox           | P1 follow-up        |
| Proactive follow-up        | Propose draft only                        | Visible dependency/entitlement errors           | Draft-only implementation                | Failure honesty; escalation/no-draft            | Provider sandbox        | P1                  |
| Customer-service queue     | Idempotent draft/approve                  | Concurrent send/claim recovers                  | Some atomic queue logic                  | Atomic approval; critic/approval quality        | Controlled sink         | P0 follow-up        |
| Templates/voice            | Scoped, validated preferences             | Reject poisoned/malformed feedback              | Little focused coverage                  | Tenant/provenance; brand/learned voice          | No                      | P1                  |
| Automation                 | Dry and real run distinct                 | Never claim unperformed execution               | Minimal                                  | False-success; approval                         | Sandbox                 | P0 follow-up        |
| Recent work                | Aggregate with health metadata            | Total outage returns unavailable                | Pure helper tests                        | Route auth/scope; grounded summary              | Pinned cross-product    | P1                  |
| Setup status               | Scoped setup facts                        | Absence differs from dependency outage          | None on base                             | Auth/scope/truthful 503                         | Pinned outage/recovery  | P0 in scope         |
| Usage/provider             | BYO isolation and entitlement policy      | Lapse/outage/rate-limit distinct                | Provider/provision tests                 | Atomic gate/meter; provider-failure no-send     | Noli Core/COS           | P0 follow-up        |
| COS/MCP/internal auth      | User-scoped least privilege               | Deny missing/foreign identity                   | Provision-key tests                      | Server confirmation and route contracts         | Pinned live wiring      | P0 follow-up        |
| Reply generation           | Grounded, concise, safe draft             | Abstain/clarify/escalate; malformed output safe | Provider-selection only                  | Pure prompt/envelope and all quality criteria   | Provider-scored sandbox | P0 in scope         |

Existing reusable suites include 24 core customer integration specs, generic messages API/UI draft and delivery cases, extensive inbox-operations execution/provider tests, and app provider/provisioning/recent-work helper tests. The new cases do not duplicate them.

## Proposed Solution

1. Add route-level Jest contracts for internal calendar operations, setup-status health, and contact projection.
2. Make only narrow fixes proven by tests: require organization and tenant when selecting data, distinguish setup absence from outage, and use the actual primary contact columns.
3. Extract a versioned pure reply task/prompt contract used by production drafting and an offline evaluator.
4. Store synthetic JSON fixtures with input, recorded candidate, expected disposition, and criteria—not brittle exact prose.
5. Run deterministic assertions first, compare aggregate/per-criterion scores to a checked-in baseline, and emit JSON diagnostics.
6. Offer optional model scoring behind a dedicated non-production credential with strict case/call/token/time limits.

## Architecture

```text
synthetic v1 fixtures -> Zod task/candidate schema -> production prompt composer
                            |
                            v
                    deterministic evaluator -> baseline/delta -> JSON + CI exit
                            |
                            +-> optional bounded provider/judge -> scored JSON
```

The harness lives under `apps/mercato/src/modules/customers/quality/reply-quality/`, imports only pure app code, and performs no database or network request in dry-run mode. Results go to ignored `.ai/qa/test-results/crm-quality/`.

`ReplyTaskV1` contains a fixture ID, scenario, channel, trusted conversation, customer facts, organization/tenant canaries, grounded facts, voice, consent, automation mode, expected disposition, recorded candidate, and criteria. Hard criteria cover schema validity, identity/scope leakage, opt-out, approval/disposition, unsupported facts/promises, credential redaction, and insufficient-information handling. Quality criteria cover grounding, context use, concision, voice, escalation, review, edit preservation, and structured output.

## Data Models

No production database changes. Fixture objects plus baseline and result documents are versioned and validated with Zod. Generated JSON results are ignored.

## API Contracts

No routes are added or renamed. The three touched internal routes receive additive OpenAPI summaries.

- `POST /internal/calendar-events`: preserve success fields; select connection by resolved user, organization, and tenant; preserve pagination/410 semantics; return truthful `502` for successful provider output without an event ID.
- `POST /internal/setup-status`: preserve configured/unconfigured fields; missing Noli/Clerk identity remains `exists:false`; require organization and tenant; query both scopes; dependency failure becomes `503` with `{ exists:false, unavailable:true, error:"setup_status_unavailable" }`.
- `POST /internal/contact-context`: preserve auth/history/shape; populate contact `email`/`phone` from `primary_email`/`primary_phone`.

## UI/UX

No UI is added. Typed unavailable responses let existing consumers render truthfully. Immutable deployed-build behavior remains a pinned-Noli-Tests handoff.

## Configuration

| Variable                   | Required    | Purpose                                            |
| -------------------------- | ----------- | -------------------------------------------------- |
| `CRM_AI_QUALITY_API_KEY`   | Scored only | Dedicated non-production provider/judge credential |
| `CRM_AI_QUALITY_MODEL`     | No          | Low-cost model override                            |
| `CRM_AI_QUALITY_MAX_CASES` | No          | Hard-capped case count, never above 20             |

Scored mode permits at most 20 fixtures, two model calls per fixture, bounded output, deterministic temperature, and a 15-minute workflow. Missing credentials write `status:skipped, reason:credential_missing` and succeed. Dry-run needs no variables, network, database, or provider.

## Alternatives Considered

- Exact-string replies: too brittle and not safety-oriented.
- Judge in PR CI: nondeterministic, credentialed, and able to obscure hard failures.
- Broad generic CRM retest: duplicates mature framework coverage.
- Incidental redesign of all audited defects: consequential contract changes need dedicated specs.
- New evaluation dependency: unnecessary for a small repository-native schema/evaluator/JSON runner.

## Migration & Backward Compatibility

This is additive test infrastructure/documentation plus narrow failure fixes. No route, success field, import, event, feature, DI name, generated contract, or schema is removed. Failure-only responses become more truthful without removing fields.

| Protected surface          | Impact                                             |
| -------------------------- | -------------------------------------------------- |
| Auto-discovery conventions | None                                               |
| Types/interfaces           | Additive internal harness types                    |
| Function signatures        | Additive helpers; production entry point preserved |
| Import paths               | None removed/moved                                 |
| Event IDs                  | None                                               |
| Widget spots               | None                                               |
| API URLs                   | Same URLs/methods/success shapes                   |
| Database schema            | None                                               |
| DI names                   | None                                               |
| ACL IDs                    | None                                               |
| Notification IDs           | None                                               |
| CLI commands               | Additive package scripts only                      |
| Generated contracts        | None                                               |

## Implementation Plan

### Phase A — Audit/readiness

1. Inventory surfaces, coverage, gaps, and shared-live ownership.
2. Complete this spec and `.ai/specs/analysis/ANALYSIS-SPEC-066.md`.

### Phase B — Deterministic regressions

1. Calendar route tests: auth, identity, scope, tokens, 410, provider failure, malformed upsert.
2. Setup tests: auth, identity, org+tenant scope, empty/configured, unavailable.
3. Contact test: primary contact projection and scoped history.
4. Apply the three small fixes in a distinct product-defect commit.

### Phase C — Reply quality

1. Add schema and pure prompt/task seam shared with production drafting.
2. Add v1 fixtures for every required scenario and deterministic criterion.
3. Add evaluator, baseline/deltas, JSON diagnostics, CLI, and tests.
4. Add bounded optional generation/judge mode with credential-safe skip.

### Phase D — CI/delivery

1. Add a focused deterministic CRM gate and dry-run before unrelated repository-wide gates in normal CI, then always upload diagnostics.
2. Add a separate manual/scheduled scored workflow.
3. Document commands, fixture extension, ownership, limitations, and handoff.
4. Verify, review, commit logically, push only this branch, and open a draft PR.

## Integration Test Coverage

| Path                 | Deterministic                         | Disposable integration           | Pinned shared-live                |
| -------------------- | ------------------------------------- | -------------------------------- | --------------------------------- |
| Calendar list/upsert | Mock auth/scope/tokens/provider       | Existing runtime only            | Google sandbox create/read/delete |
| Setup status         | Mock identity/counts/outage           | None needed                      | Noli Core outage/recovery         |
| Contact context      | Scoped query/projection/history       | Optional self-contained fixtures | COS display                       |
| Reply quality        | Offline synthetic recorded candidates | None                             | Provider draft/critic/approval    |
| Credentials          | Existing Jest                         | Existing runtime                 | Noli Core provision/auth          |

All added tests are self-contained, use no shared seeded data, and do not operate pinned Noli Tests.

## Risks & Impact Review

| Severity | Risk                                  | Mitigation                                                           |
| -------- | ------------------------------------- | -------------------------------------------------------------------- |
| High     | Judge masks safety regression         | Deterministic hard failures always win; scored flow separate         |
| High     | Evaluation sends/uses production data | Dry has no provider; scored uses synthetic fixtures/dedicated secret |
| Medium   | Query mocks diverge                   | Assert exact org+tenant predicates and route contracts               |
| Medium   | Consumer assumes setup 200 absence    | Preserve success shape; test/document typed 503                      |
| Medium   | Prompt extraction changes wording     | Semantic prompt tests; stable entry signature                        |
| Low      | Baseline drift hidden                 | Checked-in baseline and per-criterion deltas                         |
| Low      | CI runtime grows                      | One offline pass; model work excluded from PR CI                     |

Deferred high-risk findings: server-enforced MCP confirmation, atomic approval/send, auto-send policy, fail-open entitlement/metering, pipeline integrity, reminder delivery, production dedup, voice-feedback provenance, and broader false-success routes. Each changes consequential behavior or cross-module contracts.

## Success Metrics

- Dry-run needs no credentials/network and emits per-criterion JSON.
- Every required scenario has a synthetic v1 fixture.
- CI fails on thresholds or deterministic safety regressions.
- Scored CI skips truthfully without a credential and remains bounded with one.
- Route tests prove org+tenant scope and truthful failure.
- No production schema, deployment, or shared environment changes.

## Open Questions and Future Work

No blocking questions. Deferred consequential-action defects require dedicated specs. Pinned Noli Tests chooses authorized sandbox identities and immutable deployed image.

## Final Compliance Report

- [x] Required sections, phases, risks, integration matrix, and changelog are present.
- [x] All 13 compatibility surfaces are addressed; no breaking change is planned.
- [x] Regression code stays in the existing app module; fresh-bootstrap repairs are additive, generator-owned migrations for already-declared entities.
- [x] New queries require both `organization_id` and `tenant_id`.
- [x] Fixtures are runtime validated; no new `any` is planned.
- [x] No raw app API, frozen setup SQL, event, ACL, notification, or widget contracts are changed; generated migrations follow the bounded legacy-adoption path.
- [x] Test scenarios are self-contained and exclude production/shared data and services.
- [x] External patterns were compared with [Promptfoo assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/), [machine outputs](https://www.promptfoo.dev/docs/configuration/outputs/), and [DeepEval datasets](https://deepeval.com/docs/evaluation-datasets); no dependency is added.

## Verification Record

Completed on 2026-08-13/14 against the recorded base SHA:

- App Jest: 19 suites and 156 tests passed, including 25 route/prompt regressions and 12 reply-quality harness tests.
- Focused CI command: 50 deterministic tests passed across the app-owned CRM contracts and core user-scoped credential contract.
- Dry quality gate: 28/28 fixtures passed, 18/18 criteria remained at their baseline, overall pass rate 100%, delta 0.
- Missing-credential scored path: explicit `credential_missing` skip, zero model calls.
- Scored-path mock: production-prompt generation, deterministic gates, and judge completed in two calls with a 512-token per-call cap.
- Package builds: 16/16 succeeded before and after module generation; production app build succeeded.
- Repository gates: `yarn i18n:check-sync`, `yarn typecheck`, and `yarn test` now pass. The latest test run completed all 16 workspace tasks, including 224 core suites and 2,146 core tests.
- CLI migration ordering tests passed and now enforce the documented dependency order (`directory`, then `auth`, then remaining modules). Hosted fresh-database runs confirmed that repair and the legacy meeting-prep compatibility guard.
- Generator-owned email migrations now create the missing campaign/message/account/template/unsubscribe tables with bounded legacy adoption. Missing billing, landing-page, and webhook entity tables also have generated additive migrations, including corrected billing numeric precision.
- Fresh initialization without frozen setup SQL applies every enabled migration, seeds workflows without requiring the disabled business-rules module, skips only SQLSTATE `42P01` legacy vector relations during init, rebuilds 122 enabled query-index entities, and completes. A second migration pass has no pending work.
- Targeted ESLint and workflow YAML parsing passed; Playwright discovery listed 665 tests in 264 files; spec coverage reported 89/97 scenarios (91.75%) and CRM 20/20.
- Disposable customer integration execution could not start because Docker CLI/runtime is absent. No shared environment fallback was attempted.
- The first hosted run exposed that the normal test job stopped at i18n drift before reaching CRM checks, so a separate focused deterministic and dry-quality job publishes an independent result and artifact. The 28-item locale drift and the generated catalog/sales plus `server-only` Jest/typecheck baselines are repaired. A later hosted disposable run exposed optional workflow seeding against disabled metadata; the local fresh-bootstrap proof now covers that repair and the complete generated migration graph.
- Snapshot publishing now has explicit npm registry/token wiring and an authentication preflight. The repository still requires an authorized owner to provision `NPM_TOKEN`; no credential was available locally or in repository secrets.

## Changelog

### 2026-08-13

- Added audit matrix, route scope, reply-quality design, CI plan, risk/compatibility review, and live ownership boundary.
- Created the AUG-04 specification with no blocking questions.
- Recorded the implemented 28-case/18-criterion harness, deterministic route fixes, and local verification results.

### 2026-08-14

- Added a single 50-test CRM regression command and made it an independently visible CI gate.
- Restored dependency-safe fresh-database migration ordering and added deterministic coverage for it.
- Removed time dependence from the legacy credential transition test and aligned two stale repository assertions with their shipped model and shell contracts.
- Made the old optional meeting-prep column migration tolerate a table that is intentionally absent from module-managed schema; recorded the separate generated email-migration blocker without editing frozen setup SQL or hand-writing schema.
- Generated the missing email campaign/recipient/message/account/template/unsubscribe migrations through a bounded CLI adoption option, plus missing billing, landing-page, and webhook migrations; verified them against fresh disposable PostgreSQL and a clean second pass.
- Repaired the 28-item i18n sync drift, generated-symbol/typecheck boundary, enabled-module query-index filtering, `server-only` Jest mapping, and the repository diagnostics they exposed.
- Made workflow example seeding metadata-aware and limited init-only vector missing-table tolerance to PostgreSQL SQLSTATE `42P01`; all other search failures remain fail-loud.
- Added Snapshot Release npm authentication wiring and a clear missing-secret preflight; live secret provisioning remains repository-owner work.
