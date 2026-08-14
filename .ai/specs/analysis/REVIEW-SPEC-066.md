# Code Review: Noli CRM Regression and Reply Quality

## Summary

The change adds tenant-safe internal CRM contracts, deterministic route and credential regressions, a production-backed reply-prompt seam, a 28-case offline quality harness, bounded optional scoring, independently visible CI wiring, dependency-safe disposable-database migration ordering, a generated email greenfield migration, and delivery documentation. Repository i18n, typecheck, and unit-test gates now pass. Remaining work requires repository-owned credentials or a pinned live QA deployment rather than additional local code.

## CI/CD Verification

| Gate                            | Status | Notes                                                                                                                                        |
| ------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn build:packages`           | PASS   | 16/16 package builds succeeded.                                                                                                              |
| `yarn generate`                 | PASS   | All generators completed; generated OpenAPI remained unchanged.                                                                              |
| `yarn build:packages` (rebuild) | PASS   | 16/16 package builds succeeded after generation.                                                                                             |
| `yarn i18n:check-sync`          | PASS   | 47 modules and 309 keys are synchronized; the prior 28-item drift is repaired.                                                              |
| `yarn i18n:check-usage`         | WARN   | Existing baseline reports 49 missing and 3,649 unused keys; CI marks this step `continue-on-error`.                                          |
| `yarn typecheck`                | PASS   | All 16 workspace typecheck tasks pass, including app, core, CLI, and UI.                                                                     |
| `yarn test`                     | PASS   | All 16 workspace test tasks pass; core completed 222 suites and 2,142 tests.                                                                 |
| `yarn build:app`                | PASS   | Next.js production build completed; it retained the existing unsupported `next.config.ts` ESLint warning.                                    |

Additional evidence:

- `yarn workspace @open-mercato/app test --runInBand`: PASS, 19 suites and 156 tests.
- `yarn test:crm-regression`: PASS, 50 tests across six suites.
- `yarn test:crm-quality`: PASS, 28/28 fixtures, 18 criteria, 100% overall, baseline delta 0.
- Missing-credential scored path: PASS as an explicit `credential_missing` skip with zero calls.
- CLI migration command suite: PASS, 22 tests, including immutable `directory`/`auth` dependency ordering.
- Shared OpenCode helper and UI AppShell focused suites: PASS, 8 and 4 tests respectively.
- Targeted ESLint over every changed TypeScript file: PASS, with only the repository's pages-directory configuration notice.
- `yarn lint`: FAIL because the existing app script invokes removed Next.js 16 `next lint` behavior and resolves `apps/mercato/lint` as a directory.
- `yarn template:sync`: FAIL on an existing 585-file app/template drift set. Automatic synchronization would be broad, unrelated, and would incorrectly copy app-specific Noli code into the generic template.
- Playwright discovery: PASS, 665 tests in 264 files. Spec mapping: 89/97 scenarios (91.75%) and CRM 20/20.
- Focused disposable customer integration: local Docker execution is unavailable, but the complete enabled migration graph passes against a fresh local PostgreSQL cluster. A second migration pass is clean and email-only generation reports no diff. Hosted CI still needs to confirm the containerized path.
- Snapshot workflow authentication is configured through setup-node, `NODE_AUTH_TOKEN`/`YARN_NPM_AUTH_TOKEN`, and an explicit `npm whoami` preflight. Publishing remains blocked until a repository owner provisions `NPM_TOKEN`.

## Findings

### Critical

No in-scope critical code finding remains.

### External prerequisites

1. **Snapshot publishing needs an authorized token.** Workflow wiring and failure diagnostics are complete; the repository has no `NPM_TOKEN`, and no local npm session is authenticated.
2. **Real scored evaluation needs its dedicated non-production key.** `CRM_AI_QUALITY_API_KEY` is absent locally and from repository secrets, so only the zero-call machine-readable skip can run.
3. **Pinned live Noli validation needs an immutable deployment record.** No reserved QA slot, deployment marker, exact image tag/digest, or synthetic sandbox identities are recorded. The handoff must abort rather than infer or replace shared state.

The existing broad template parity drift and removed Next.js `next lint` script behavior are outside this CRM regression finish-line change and are not part of the normal CI test job.

## Backward Compatibility

- [x] No contract surface removed or renamed without a deprecation bridge
- [x] No event IDs renamed or removed
- [x] No widget injection spot IDs renamed or removed
- [x] No API route URLs renamed or removed
- [x] No existing response schema fields removed
- [x] No database columns/tables renamed or removed
- [x] No DI service names renamed or removed
- [x] No ACL feature IDs renamed or removed
- [x] No public import paths removed without a re-export bridge
- [x] No required type fields removed or narrowed
- [x] No function signatures changed in a breaking way
- [x] Deprecation protocol is not applicable; SPEC-066 includes migration and compatibility analysis

## Checklist

- [x] No `any` types introduced
- [x] All touched API routes export `openApi`
- [x] Touched request validators live in `integrations_api/data/validators.ts`
- [x] Tenant isolation: every touched query filters by both `organization_id` and `tenant_id`
- [x] No new user-facing UI strings
- [x] CRUD factory is not applicable to these existing internal projection/provider routes
- [x] The new email migration is generator-owned, additive, and verified on fresh and repeat migration paths; frozen setup SQL remains untouched
- [x] `yarn generate` completed after file additions
- [x] Existing DI/request-container pattern is preserved
- [x] Behavior changes have exact deterministic Jest coverage
- [x] No empty catch block was introduced
- [x] SPEC-066 is the unique next OSS spec ID; staged spec chains remain untouched
- [ ] `yarn template:sync` passes; blocked by the documented pre-existing 585-file drift set

## Recommendation

The repository-side CRM regression build is ready for hosted CI review. Do not call the scored/live acceptance complete until an owner supplies the dedicated evaluation key, npm token, and immutable QA deployment record.
