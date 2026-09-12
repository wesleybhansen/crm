# SPEC-070: Scout usage observations

## TLDR

Record provider-reported cache and reasoning counts in the existing successful Scout usage row, without changing generation, the complete customer-facing response, or allowance billing. This is local, app-owned measurement infrastructure, not a token-saving optimization or approval to deploy.

## Scope and autonomous assumptions

The user requires preserved final output, no quality/performance regression, the original aggregate $20 evaluation cap, and separate approval for production changes. Use the existing Noli customers app module; do not redesign Open Mercato core or add an external extension. No architectural choice needs another routine user pause. Baseline source is `a6e3a3228f0c27ecf66d401bc54f20ef80d1f330`, verified against remote main before creating the isolated checkout. Its production deployment is not yet attested.

## Implementation plan

1. Add a bounded, numeric-only parser and tests under the customers app module.
2. Attach observations to the existing final-success metering call. Preserve all legacy billing fields, provider request bytes, context, models, fallback, timeouts, response JSON and action blocks.
3. Differentially replay complete route responses against the pinned baseline with mocked providers and storage, review adversarially, and run repository verification. Do not infer generated-output equivalence, deployed behavior, savings, or complete workflow costs from replay.

## Known limits

Only the final usable provider response is observed. Failed attempts, all-failed requests, subsequent UI tool turns and dropped best-effort meter writes are not a complete workflow ledger. Missing/invalid counts are unknown, never an invented zero. No additional provider or database request is introduced.

## Overview

Operators need to distinguish recorded usage from provider-reported cache/reasoning counts before deciding whether any harness optimization is worthwhile. The app-owned Scout route is a bounded starting point. Existing reply-quality work in SPEC-066 remains separate and unchanged.

Market reference: the existing Open Mercato app/module extension layout is retained; a new metrics backend, tracing vendor or shared billing redesign is unnecessary. Provider references: [Gemini UsageMetadata](https://ai.google.dev/api/generate-content#UsageMetadata), [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), and [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning). These define observations, not new prices or billing rules.

## Problem Statement

Scout drops cache and reasoning details while its existing meter records only the final usable provider result. The shared logger already accepts cached input for price calculation, but forwarding it through the wrapper would change customer allowance charges. Counting only successful final calls also cannot establish total cost per acceptable customer result.

## Proposed Solution

Add an app-local parser for the two existing provider usage objects. Store a versioned `scout_usage_observation` object inside the existing meter's metadata. Preserve all legacy fields exactly. Mark the scope as `final_response_only` and workflow coverage as incomplete. Keep finite safe nonnegative integer observations; missing counts remain null and malformed fields are identified without retaining arbitrary response content. Flag inconsistent count relationships rather than silently correcting provider evidence.

No optimization, prompt compression, tool pruning, model migration, request caching, changed token limits, pricing, billing, new writes, new calls, deployment or flags is in scope. No production credentials or paid evaluation are needed for this candidate.

## Architecture

Provider response → existing text validation → existing billing counts plus isolated numerical observation → existing success-only meter → existing shared logger metadata. The HTTP success/error response is unchanged. Existing provider-access, auth, tenant resolution and best-effort metering remain in place. No hooks/interceptors can recover the discarded provider usage without changing this app-owned call boundary; the parser lives under the existing customers module, not core.

Gemini output is candidate tokens; thought tokens are separately reported. OpenAI completion tokens already include reasoning, so they must not be added again. Cache counts are subsets of input, not additional input. The observation makes these semantics explicit and is not a billing calculator.

## Data Models

No entity, migration, index, backfill or new table. Existing JSON metadata gains one bounded object with schema version, fixed provider/scope/coverage labels, nullable token counts, reasoning inclusion semantics and fixed-name invalid/inconsistent field lists. Zod validates numeric observations; arbitrary strings, unknown objects, prompts, responses, IDs and credentials are excluded. There is no unbounded per-attempt array or shared cross-tenant memory.

## API Contracts

Existing `POST /api/ai/assistant` request, route metadata, status codes and complete JSON bodies are unchanged. Success remains `{ok:true,message,provider}`; no observation field reaches clients. Existing 400, 402, 500, keyless and quota-message paths remain unchanged. Add an OpenAPI summary only, consistent with existing route requirements. No new public route or required field.

## UI/UX and Internationalization

No UI or i18n changes. The mounted `customers/backend/assistant/page.tsx` consumes `message`, parses action blocks, renders prose and performs subsequent read-only tool turns. Exact response preservation is required for those consumers. Full browser/tool execution and production attestation are not proven by mocked route replay.

## Migration & Backward Compatibility

All 13 contract categories checked: discovery exports, public types, signatures, import paths, event IDs, widget spots, route URLs, schema, DI names, ACL IDs, notification IDs, CLI commands and generated contracts are retained. Only app-internal provider results gain a field; existing metadata accepts additive values. No charge field, billing implementation or request identity changes. Rollback is removal of the additive observer; historical metadata remains ignorable.

## Integration Test Coverage

Credential-free route differential replay must compare identical baseline/candidate inputs, full provider request bodies/headers/order, allowance/auth queries, timer boundaries, response status/headers/JSON bytes and legacy meter fields. Cover Gemini/OpenAI, platform/BYO, missing/malformed/contradictory usage, multi-part and multi-choice output selection, errors/empty bodies/transport failures, blocked fallback, keyless and invalid requests, metering outage, long multi-turn messages and action fences. Exercise the real wrapper/logger against mocked storage to prove unchanged row counts, attribution, costs and credits. No seeded/live data.

Replay with injected responses proves compatibility for those fixtures, not that fresh stochastic generations are identical. No real token saving is claimed. Full CI/type/build and eventual deployed UI verification remain release gates.

## Risks & Impact Review

#### Billing drift
- **Scenario**: Cache/reasoning observations accidentally replace legacy billing fields.
- **Severity**: High
- **Affected area**: Allowance, credits, BYO attribution.
- **Mitigation**: Metadata-only attachment, exact meter and database row comparisons, no shared billing edits.
- **Residual risk**: A future consumer could misuse observations; scope and semantics are explicit.

#### Misleading savings from partial observations
- **Scenario**: Missing failed attempts or meter writes are treated as free usage.
- **Severity**: High
- **Affected area**: Efficiency decisions.
- **Mitigation**: Explicit incomplete-workflow scope; no aggregate savings or qualification claim.
- **Residual risk**: Full attempt accounting needs a separately designed non-billing observer.

#### Parser, latency or output regression
- **Scenario**: Malformed usage throws, adds latency, changes fallback or alters action fences.
- **Severity**: Medium
- **Affected area**: Scout response reliability and downstream actions.
- **Mitigation**: Constant-size parsing, no I/O, no output rewrites, malformed tests and differential route replay; preserve existing timer boundary.
- **Residual risk**: Offline timings are not deployed latency evidence; release performance gate remains open.

#### Sensitive data or tenancy leak
- **Scenario**: Raw usage/provider response metadata leaks customer text or credentials.
- **Severity**: High
- **Affected area**: Existing tenant-scoped usage row.
- **Mitigation**: Fixed numeric whitelist and enum labels only; existing auth/org mapping unchanged, no new queries or caches.
- **Residual risk**: Existing storage access policies are unchanged, not newly audited here.

#### Best-effort write loss and operational coverage
- **Scenario**: Response succeeds while the existing meter fails or process exits before writing.
- **Severity**: Medium
- **Affected area**: Observation completeness.
- **Mitigation**: Preserve existing failure isolation and explicitly exclude complete cost accounting claims. No retries, extra rows or transactions.
- **Residual risk**: Lost observations remain possible; retaining output behavior takes precedence.

## Final Compliance Report — 2026-09-11

### AGENTS.md Files Reviewed

Root, `.ai/specs`, shared, core, core/customers and ai-assistant guides. OpenCode/MCP instructions apply to that separate package; this candidate does not restore retired OpenCode or change its stack.

### Compliance Matrix

| Rule source | Rule | Status | Notes |
| --- | --- | --- | --- |
| Root | App-owned modules; spec first; typed validation | Compliant design | Existing customers extension, numeric Zod parser |
| Core | Route metadata/OpenAPI | Compliant design | Preserve auth metadata; add documentation only |
| Root/shared | Tenant isolation and core independence | Compliant design | Existing meter unchanged; no new core dependency |
| Backward compatibility | Preserve 13 surfaces | Compliant design | Additive metadata/internal result only |
| Spec/checklist | Writes, cache, commands, scale, i18n | N/A for new domain operations | No new domain mutation/query/cache/UI; existing usage write documented above |
| Code review | Full CI and template synchronization before approval | Pending | Cannot claim release approval from focused tests |

### Internal Consistency Check

Data/API/UI agree: only existing metadata changes. Risks cover the single existing write. Commands, new queries/indexes, batching, workers, pagination and cache invalidation are N/A because none are introduced. No user-controlled SQL, HTML, URLs or secret logging is added.

### Non-Compliant Items

No design blocker identified. Full verification remains pending and blocks release qualification. Existing route implementation outside the observer is not redesigned.

### Verdict

Ready for bounded local implementation, not publication, deployment or savings claims.

## Changelog

### 2026-09-11
- Initial specification and source-bound compatibility plan.
- Review — Agent: security, cache, command and compatibility design passed; performance/output behavior requires testing; no release approval.

## Implementation Status

Parser and route integration implemented locally. Focused suites: 32 passing tests, including 28 cache/BYO/write-mode combinations through the native wrapper and real billing logger with mocked storage, plus failure isolation. Full TypeScript and application build pass; root tests pass (5,613 passed, eight skipped). Package builds/generation, dependency/deployment-security checks and 54 CRM regression tests pass. Reply-quality dry run passes 28 fixtures; it is not scored generation evidence.

Repository release gates remain blocked: translation sync fails identically on clean baseline; template sync reports 976 differences versus 973 on clean baseline (three new observer/test files add to existing drift). No bulk synchronization or translation edits were authorized/applied. i18n usage also reports seven missing and 3,650 unused keys (advisory gate). Differential source-bound route replay passes 47 comparisons, 55 provider requests/48 HTTP responses per version and 16 comparator negative controls. Independent review finds no candidate-specific generation/fallback/billing regression. Production-source attestation, browser/tool execution and real latency/savings qualification remain unproven.

Reproduce the offline differential checks with `node scripts/check-scout-usage-compatibility.mjs [output-directory]`; default output is the ignored `.ai/qa/test-results/scout-usage-compatibility` directory. Baseline source is pinned Git content, not a candidate with edits removed. The script validates unchanged supporting source and detects source mutation during execution. No model credentials or network are needed.
