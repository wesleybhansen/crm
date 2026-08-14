# Code Review: Noli CRM Regression and Reply Quality

## Summary

The change adds tenant-safe internal CRM contracts, deterministic route and credential regressions, a production-backed reply-prompt seam, a 28-case offline quality harness, bounded optional scoring, independently visible CI wiring, dependency-safe disposable-database migration ordering, and delivery documentation. The in-scope diff has no unresolved architecture, security, compatibility, or test finding; the repository review cannot pass for merge because mandatory repository-wide gates are already red on the recorded base.

## CI/CD Verification

| Gate                            | Status | Notes                                                                                                                                        |
| ------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn build:packages`           | PASS   | 16/16 package builds succeeded.                                                                                                              |
| `yarn generate`                 | PASS   | All generators completed; generated OpenAPI remained unchanged.                                                                              |
| `yarn build:packages` (rebuild) | PASS   | 16/16 package builds succeeded after generation.                                                                                             |
| `yarn i18n:check-sync`          | FAIL   | Existing baseline reports 28 locale-sync issues across eight modules; this change adds no locale or UI string.                               |
| `yarn i18n:check-usage`         | WARN   | Existing baseline reports 49 missing and 3,649 unused keys; CI marks this step `continue-on-error`.                                          |
| `yarn typecheck`                | FAIL   | The CLI environment type is repaired and CLI typecheck passes; repository typecheck retains generated disabled-module and core diagnostics. |
| `yarn test`                     | FAIL   | Shared/UI stale assertions are repaired; the repository run retains core generated-module and `server-only` Jest baseline failures.          |
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
- Focused disposable customer integration: local execution is blocked because no Docker CLI/runtime is installed. Hosted reruns confirmed the `directory`/`auth` repair and optional meeting-prep guard, then stopped in the app email module because `Migration20260409195545` alters `email_campaigns` although no module migration creates the entity table on greenfield.
- Initial PR snapshot publish: FAIL with npm `ENEEDAUTH`; this is an external workflow credential/configuration issue, not a CRM regression failure.

## Findings

### Critical

1. **Repository-wide typecheck gate is red.** The in-scope CLI diagnostic is fixed, but generated disabled-module and existing core diagnostics remain. The code-review gate prohibits a passing or merge-ready conclusion until the repository baseline is repaired.
2. **Repository-wide unit-test gate is red.** The stale shared/UI assertions and CRM credential time dependency are fixed, while core generated-module and `server-only` Jest configuration failures remain. They remain merge blockers under repository review policy.
3. **Repository-wide i18n synchronization gate is red.** The 28 existing issues are outside this non-UI change, but the mandatory gate still prevents a passing review.
4. **Template parity gate is red.** The existing 585-file drift cannot be safely repaired inside this narrowly isolated Noli lane; broad template mutation would violate task scope.
5. **Snapshot publishing lacks npm authentication.** The PR workflow cannot publish its snapshot without the repository-owned npm credential/configuration.
6. **Disposable integration is blocked by incomplete email schema ownership.** The SPEC-061 email module exposes `EmailCampaign`, but its migration assumes a legacy setup-SQL table. Repository rules require a proper generated module migration and prohibit hand-writing that schema or restoring the frozen setup table, so this belongs in the email migration lane.

No High, Medium, or Low finding remains in the in-scope diff.

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
- [x] No event, worker, subscriber, custom-field, entity, migration, cross-module relationship, ACL, search, form, table, or UI mutation
- [x] `yarn generate` completed after file additions
- [x] Existing DI/request-container pattern is preserved
- [x] Behavior changes have exact deterministic Jest coverage
- [x] No empty catch block was introduced
- [x] SPEC-066 is the unique next OSS spec ID; staged spec chains remain untouched
- [ ] `yarn template:sync` passes; blocked by the documented pre-existing 585-file drift set

## Recommendation

Keep the pull request in draft. The scoped CRM implementation and its independent hosted check are green and suitable for review, but repository policy prohibits calling it merge-ready until the email greenfield migration, baseline gates, and workflow credential are resolved in their owning lanes.
