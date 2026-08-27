# Pre-Implementation Analysis: SPEC-069 B2C Quality V2

## Executive Summary

The requested quality tranche is ready to implement as an additive extension of the existing app-level `gtm` module. The current consumer safety and execution boundaries are sound, but opportunity intent classification, fit scoring, query diversity, semantic quality regression, production monitoring, and live-output evidence are insufficient to support an outcome-quality parity claim. No destructive schema, API, event, ACL, import-path, or generated-contract change is required.

The approved placement is the existing app-level module at `apps/mercato/src/modules/gtm`. This is the external-extension path for this application and avoids changes to Open Mercato core packages.

## Backward Compatibility

### Violations Found

No required breaking change was identified. Implementation must remain additive under the constraints below.

| # | Surface | Issue | Severity | Proposed Fix |
|---|---|---|---|---|
| 1 | Type definitions | `FitResult.version` and `QualificationProfile.version` are exported unions that do not yet include the new versions. | Warning | Add `fit-v7` and `qualification-profile-v4` to the unions; retain every existing value. |
| 2 | Function signatures | The existing `FitScorer.score(candidate, play, evidence)` contract is already sufficient. | None | Keep the signature unchanged and implement play-aware opportunity scoring behind it. |
| 3 | API routes | Monitoring may be exposed through an additive operation on an existing internal route or a new route. | Warning | Preserve every existing operation and response field; validate any new operation through the central zod schemas and existing feature guards. |
| 4 | Database schema | Human review and provider-operation tables already contain the fields needed to compute quality metrics. | None | Do not add or alter tables unless implementation proves an essential missing datum. Prefer aggregate reads over new durable state. |

### All 13 Contract Surfaces

| Surface | Impact |
|---|---|
| Auto-discovery conventions | No rename, removal, or convention change. |
| Public types and interfaces | Additive version values and optional quality fields only. |
| Function signatures | Existing scorer and adapter signatures remain unchanged. |
| Import paths | No move or removal. |
| Event IDs | No event rename or removal; no new event is currently required. |
| Widget spot IDs | No impact. |
| API URLs | Existing URLs and methods remain; any monitoring contract is additive. |
| Database schema | No schema change planned. |
| DI service names | No impact. |
| ACL feature IDs | Reuse `gtm.view` and existing operator features; no rename/removal. |
| Notification type IDs | No impact unless a provider-drift alert is added later; any type must be additive. |
| CLI commands | No rename/removal. A benchmark command, if added, is additive and test-safe. |
| Generated files | No export or bootstrap contract change. |

### Missing BC Section

SPEC-069 has a compatibility audit but does not use the repository-standard heading `Migration & Backward Compatibility`. The quality-v2 addendum must add that heading and state explicitly that all changes are additive and require no migration.

## Spec Completeness

### Missing Sections

| Section | Impact | Recommendation |
|---|---|---|
| Quality-v2 architecture | Current spec describes the output contract but not query planning, evidence-only intent classification, semantic reranking, or calibrated fit. | Add a bounded planner and scorer architecture with deterministic safety filters before any model-assisted ranking. |
| Quality benchmark | No production-output benchmark, labeling protocol, or pass thresholds are specified. | Add the approved 12-play realtor benchmark, metrics, labeling rules, and sanitized-fixture retention contract. |
| Production monitoring | No source-yield, relevance, dead-destination, duplicate, or provider-drift aggregate is specified. | Add tenant-scoped aggregate metrics computed from existing GTM rows and human review outcomes. |
| Phasing and implementation plan | Existing release order predates the deployed production state. | Add quality-v2 phases and current production truth. |
| Risks and impact review | Existing safety boundaries are strong, but semantic false accepts, query leakage, model instability, and URL validation risk are not cataloged. | Add concrete risks, mitigations, and residual risk. |
| Final compliance report | Not present as a standalone section. | Add it after implementation with exact test evidence. |

### Incomplete Sections

| Section | Gap | Recommendation |
|---|---|---|
| Acceptance tests | Structural fixtures do not measure semantic relevance, locality, current intent, actionability, freshness, or false positives. | Add adversarial and human-labeled examples plus metric thresholds. |
| Source contracts | Each social adapter selects one query and some classifiers combine the query with result text. | Require source-specific multi-query lanes and evidence-only intent classification. |
| UI release gate | The four required viewport checks remain unrecorded. | Capture signed-in evidence at 375, 768, 1024, and 1440 CSS pixels. |
| Legal release gate | Drafts are present but the new consumer language has no separately recorded counsel disposition. | Produce an exact section-level review packet and record whether the prior approval covered these paragraphs. |
| Changelog/status | The status still says production exposure is fail-closed and the test count is stale. | Update after deployment verification. |

## AGENTS.md Compliance

### Violations

No code violation exists yet. The implementation must observe these constraints:

| Rule | Location | Fix |
|---|---|---|
| App-specific feature placement | Quality logic belongs to `apps/mercato/src/modules/gtm`. | Do not modify core packages for GTM domain behavior. |
| Backward compatibility | Version types and API responses are stable contracts. | Add values and fields only; preserve old versions and response shapes. |
| Tenant isolation | Monitoring reads span candidate, match, evidence, run, play, and operation rows. | Bind every aggregate to both organization and tenant. |
| Input validation | Benchmark/monitoring inputs require bounds. | Define zod schemas in `data/validators.ts`. |
| UI primitives | Any CRM UI change must use established primitives. | Do not add raw buttons or hand-built tables. |
| Integration coverage | Behavioral and UI changes require module-local integration tests. | Extend `apps/mercato/src/modules/gtm/__integration__` with self-contained fixtures. |

## Risk Assessment

### High Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Query leakage into classification | A result inherits buyer or seller intent from the query even when its content does not support it. | Classify only from returned evidence; use the query solely as expected context and route missing proof to review. |
| Structural false accepts | A complete but irrelevant opportunity can cross the current fit threshold. | Implement play-specific `fit-v7` criteria for intent, geography, audience, recency, destination, access, and evidence. |
| Arbitrary URL validation | Fetching provider-returned URLs can create SSRF, DNS rebinding, oversized response, redirect, and provider-terms risk. | Keep runtime validation metadata-first. Any controlled benchmark fetch must use public-address validation, redirect revalidation, strict time/byte ceilings, and no authentication. Do not silently introduce a generic crawler. |
| Model-assisted reranking drift | An unbounded or opaque model score can vary, leak scope, or override safety. | Apply deterministic policy and evidence gates first; use a bounded structured schema, low temperature, retained rubric version, and deterministic fallback. Never let the model upgrade missing evidence to pass. |

### Medium Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Query multiplication | Multiple lanes can increase provider spend. | Freeze lane count, per-lane raw ceiling, per-source quote, total plan hash, and canonical ledger reservation before calls. |
| Duplicate candidates across lanes | Yield and cost metrics become misleading. | Canonicalize destinations before persistence and preserve each sighting as evidence on one candidate. |
| Benchmark overfitting | A small realtor corpus may look good without generalizing. | Use four markets with different density and three intent modes, retain adversarial negatives, and keep holdout fixtures. |
| Provider drift | Actor schema, pricing, or access behavior changes after release. | Record exact contract/rate versions and alert on parser drops, rate mismatches, and no-yield runs. |
| Review-label ambiguity | Human acceptance can mean relevance, usefulness, or mere plausibility. | Require reason-coded labels and a concise labeling guide. |

### Low Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Documentation drift | Operators see obsolete deployment and test truth. | Update status, rollout, benchmark results, and exact test counts in the same PR. |
| Responsive regressions | Opportunity cards may overflow or become hard to operate at smaller widths. | Verify all four widths, keyboard focus, 44-pixel targets, and page-level overflow. |

## Gap Analysis

### Critical Gaps (Block Outcome-Quality Completion)

- Evidence-only intent attribution is missing for LinkedIn, Reddit, and X opportunity normalizers.
- Opportunity qualification does not compare a row to the frozen play contract.
- No real production B2C run or labeled benchmark exists.
- Current quality fixtures establish safety and shape, not usefulness or relevance.

### Important Gaps (Should Address)

- Query planning uses one selected keyword instead of bounded source-specific lanes.
- Destination freshness/currentness and event expiry are not evaluated consistently.
- Production aggregates do not expose cost per useful opportunity, parser drops, stale destinations, duplicates, or review reasons.
- Four-width signed-in verification and a current counsel-review disposition are not recorded.

### Nice-to-Have Gaps

- Direct Instagram, TikTok, Threads, creator-network, Meetup, and Eventbrite adapters.
- Consumer opportunity export without personal contact fields.
- Workspace-specific learned reranking after enough reason-coded review data exists.

## Remediation Plan

### Before Implementation (Must Do)

1. Add a quality-v2 architecture, risk, benchmark, monitoring, and compatibility addendum to SPEC-069.
2. Freeze the benchmark markets, play templates, label schema, metric formulas, lane limits, and provider-spend ceilings.
3. Preserve every existing B2B and consumer execution boundary.

### During Implementation (Add to Spec)

1. Add evidence-only intent attribution and `fit-v7` criterion behavior.
2. Add bounded source-specific query lanes, deterministic validation/deduplication, and calibrated confidence.
3. Add semantic quality fixtures and tenant-scoped monitoring aggregates.
4. Record benchmark and responsive evidence as generated artifacts that contain no secrets or unnecessary personal data.

### Post-Implementation (Follow Up)

1. Run focused, GTM regression, integration, typecheck, build, and template-parity gates.
2. Run the controlled production benchmark only after quote confirmation and within the approved cap.
3. Merge, deploy, confirm exact commit/image/deployment identity, then re-check production aggregates and UI.
4. Record counsel's disposition for the exact privacy and terms paragraphs; do not infer legal approval from code deployment.

## Recommendation

Ready to implement after the SPEC-069 quality-v2 addendum is written. No backward-compatibility blocker or migration is required. The highest-priority acceptance gate is the controlled labeled benchmark, because the current production database contains no plays, research runs, candidates, or provider operations and therefore provides no live quality evidence.
