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
- Added a 50-test focused CRM command plus the credential-free quality gate ahead of unrelated repository-wide gates in standard CI, and a separate manual/weekly scored workflow with always-uploaded results.
- Restored the documented fresh-database module order (`directory`, `auth`, then alphabetical) after the first hosted disposable run exposed an alphabetical-order startup failure.
- Generated the missing email campaign/recipient/message migration through a bounded CLI legacy-adoption option and verified the complete enabled migration graph on fresh PostgreSQL.
- Repaired the 28-item i18n sync drift and the generated catalog/sales, `server-only`, and app/core typecheck baselines.
- Added explicit Snapshot Release npm authentication plus a preflight that identifies a missing repository secret before publishing.

## Verification

Passing:

- `yarn install --immutable`
- `yarn build:packages` before and after generation: 16/16
- `yarn generate`
- App Jest: 19 suites, 156 tests
- `yarn test:crm-regression`: 50 tests across six suites
- `yarn test:crm-quality`: 28/28 fixtures, 18 criteria, 100%, delta 0
- Missing-key `yarn test:crm-quality:scored`: `credential_missing`, zero calls
- CLI migration command suite: 22 tests
- Shared model-default helper: 8 tests; UI AppShell: 4 tests
- Targeted ESLint and workflow YAML parsing
- `yarn build:app`
- `yarn i18n:check-sync`
- `yarn typecheck`: 16/16 workspace tasks
- `yarn test`: 16/16 workspace tasks; core 222 suites/2,142 tests
- Fresh PostgreSQL `yarn db:migrate`, clean second migration pass, and email-only no-diff generation
- Playwright discovery: 665 tests in 264 files
- Spec coverage mapping: 89/97 (91.75%), CRM 20/20

External follow-up:

- The machine has no Docker CLI/runtime, so the focused containerized integration remains a hosted-CI confirmation. The underlying migration graph now passes on a fresh local PostgreSQL cluster without frozen setup SQL.
- Snapshot workflow wiring is complete, but the repository has no `NPM_TOKEN` secret and the local npm client is unauthenticated.
- The dedicated non-production `CRM_AI_QUALITY_API_KEY` is absent, so the real scored evaluation cannot run; its machine-readable missing-key path makes zero calls.
- No QA deployment marker, exact image tag/digest, or reserved slot is recorded, so the pinned live Noli handoff must not start.

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
