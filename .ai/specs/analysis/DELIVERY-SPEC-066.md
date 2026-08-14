# Noli CRM Regression and Reply Quality

## Base and scope

- Exact base: `0bb650700f5fcc6576be2bcbee08c5ccd5b63e34` (`origin/main` when the AUG-04 lane was initialized)
- Branch: `codex/crm-regression-quality`
- Spec: `.ai/specs/SPEC-066-2026-08-13-noli-crm-regression-quality.md`

This draft adds focused Noli CRM boundary coverage without retesting the complete generic Open Mercato framework or accessing shared/live systems.

## What changed

- Hardened calendar connection lookup with user, organization, and tenant scope; preserved cursor and stale-sync-token behavior; made malformed successful provider output a truthful gateway failure.
- Made setup-status counts organization-and-tenant scoped and changed dependency/count failures from false empty success to a typed unavailable response.
- Corrected contact-context projection to use the canonical primary email and phone columns while preserving scoped correspondence history.
- Added Zod request contracts plus deterministic auth, input, isolation, pagination, provider, malformed-output, empty/configured, and outage tests for all three routes.
- Extracted the production CRM reply prompt into a pure seam and added conservative grounding, consent, cross-customer, secret, unsupported-commitment, approval, and structured-output rules.
- Added 28 versioned synthetic reply fixtures, 18 explicit deterministic criteria, checked-in thresholds/baselines, per-case JSON diagnostics, and regression deltas.
- Added an optional synthetic-only scored mode with a dedicated secret, at most 20 cases, two calls per case, 512 output tokens per call, 30-second request timeouts, and explicit zero-call credential-missing skips.
- Added the credential-free quality gate to standard CI and a separate manual/weekly scored workflow with always-uploaded results.

## Verification

Passing:

- `yarn install --immutable`
- `yarn build:packages` before and after generation: 16/16
- `yarn generate`
- App Jest: 19 suites, 156 tests
- Focused changed suite: 37 tests
- `yarn test:crm-quality`: 28/28 fixtures, 18 criteria, 100%, delta 0
- Missing-key `yarn test:crm-quality:scored`: `credential_missing`, zero calls
- Targeted ESLint and workflow YAML parsing
- `yarn build:app`
- Playwright discovery: 665 tests in 264 files
- Spec coverage mapping: 89/97 (91.75%), CRM 20/20

Blocked or baseline-red:

- Disposable customer integration could not start because the local machine has no Docker CLI/runtime. No shared test environment was used.
- Repository `yarn typecheck`, `yarn test`, `yarn i18n:check-sync`, `yarn lint`, and `yarn template:sync` retain failures outside this diff. Exact evidence and merge-blocker classification are in `.ai/specs/analysis/REVIEW-SPEC-066.md`.

## Important deferred findings

The audit found broader consequential behavior requiring dedicated designs: server-enforced MCP confirmation, atomic approval/send, auto-send policy enforcement, entitlement/metering atomicity, deal-stage/pipeline integrity, reminder delivery truth, phone-only/transactional deduplication, feedback provenance, and false-success behavior in other provider/automation routes. They are documented rather than incidentally redesigned here because they affect public behavior, persistence, or cross-module ownership.

## Scored activation

Use only a dedicated non-production evaluation key:

```bash
CRM_AI_QUALITY_API_KEY=<dedicated-non-production-key> \
CRM_AI_QUALITY_MODEL=<approved-low-cost-model> \
CRM_AI_QUALITY_MAX_CASES=20 \
yarn test:crm-quality:scored
```

No production data, credentials, provider sinks, or shared services are permitted.

## Pinned Noli Tests handoff

The live owner must first record the exact commit SHA, deployed image tag and digest, QA slot, deployment marker, synthetic identities, sandbox destinations, prerequisites, expected results, evidence, cleanup, and stop conditions. Then run only:

1. Noli Core/COS user-scoped provision/reprovision and authoritative lapse-versus-outage behavior.
2. Live COS/MCP authentication and cross-tenant denial.
3. Provider-sandbox reply/critic/human-approval separation using a controlled sink only.
4. Calendar sandbox create/read/page/delete.
5. Recent-work and setup-status outage/recovery truthfulness.

The executable handoff record, exact pass conditions, image-marker checks, cleanup, and abort conditions are in `apps/mercato/src/modules/customers/TESTING.md`. No local deterministic regression belongs in that live handoff.
