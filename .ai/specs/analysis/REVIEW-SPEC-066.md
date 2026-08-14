# Code Review: Noli CRM Regression and Reply Quality

## Summary

The change adds tenant-safe internal CRM contracts, deterministic route regressions, a production-backed reply-prompt seam, a 28-case offline quality harness, bounded optional scoring, CI wiring, and delivery documentation. The in-scope diff has no unresolved architecture, security, compatibility, or test finding; the repository review cannot pass for merge because mandatory repository-wide gates are already red on the recorded base.

## CI/CD Verification

| Gate                            | Status | Notes                                                                                                                                        |
| ------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `yarn build:packages`           | PASS   | 16/16 package builds succeeded.                                                                                                              |
| `yarn generate`                 | PASS   | All generators completed; generated OpenAPI remained unchanged.                                                                              |
| `yarn build:packages` (rebuild) | PASS   | 16/16 package builds succeeded after generation.                                                                                             |
| `yarn i18n:check-sync`          | FAIL   | Existing baseline reports 28 locale-sync issues across eight modules; this change adds no locale or UI string.                               |
| `yarn i18n:check-usage`         | WARN   | Existing baseline reports 49 missing and 3,649 unused keys; CI marks this step `continue-on-error`.                                          |
| `yarn typecheck`                | FAIL   | Repository gate stops at `packages/cli/src/lib/testing/integration.ts:2130` because `NODE_ENV` is absent from the inferred environment type. |
| `yarn test`                     | FAIL   | Repository gate includes an existing shared OpenCode default-model assertion (`gpt-4o-mini` expected, `gpt-5-mini` received).                |
| `yarn build:app`                | PASS   | Next.js production build completed; it retained the existing unsupported `next.config.ts` ESLint warning.                                    |

Additional evidence:

- `yarn workspace @open-mercato/app test --runInBand`: PASS, 19 suites and 156 tests.
- Focused route/prompt/quality suite: PASS, 37 tests.
- `yarn test:crm-quality`: PASS, 28/28 fixtures, 18 criteria, 100% overall, baseline delta 0.
- Missing-credential scored path: PASS as an explicit `credential_missing` skip with zero calls.
- Targeted ESLint over every changed TypeScript file: PASS, with only the repository's pages-directory configuration notice.
- `yarn lint`: FAIL because the existing app script invokes removed Next.js 16 `next lint` behavior and resolves `apps/mercato/lint` as a directory.
- `yarn template:sync`: FAIL on an existing 585-file app/template drift set. Automatic synchronization would be broad, unrelated, and would incorrectly copy app-specific Noli code into the generic template.
- Playwright discovery: PASS, 665 tests in 264 files. Spec mapping: 89/97 scenarios (91.75%) and CRM 20/20.
- Focused disposable customer integration: BLOCKED before startup because no Docker CLI/runtime is installed; no shared environment fallback was used.

## Findings

### Critical

1. **Repository-wide typecheck gate is red.** The first reported error is outside this diff at `packages/cli/src/lib/testing/integration.ts:2130`. The code-review gate prohibits a passing or merge-ready conclusion until the repository baseline is repaired.
2. **Repository-wide unit-test gate is red.** The reproducible shared OpenCode model-default assertion is outside this diff, while the complete changed app suite passes. It remains a merge blocker under the repository review policy.
3. **Repository-wide i18n synchronization gate is red.** The 28 existing issues are outside this non-UI change, but the mandatory gate still prevents a passing review.
4. **Template parity gate is red.** The existing 585-file drift cannot be safely repaired inside this narrowly isolated Noli lane; broad template mutation would violate task scope.

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

Keep the pull request in draft. The scoped implementation is verified and suitable for review, but repository policy prohibits calling it merge-ready until the four Critical baseline blockers above are resolved in their owning lanes.
