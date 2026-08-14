# Noli CRM Testing and AI Reply Quality

This module owns deterministic regression coverage for Noli-specific CRM behavior and the synthetic reply-quality harness. It does not own production deployment, shared-live release certification, or the contracts implemented by Noli Core and other repositories.

## Ownership boundaries

| Owner                     | Covered here                                                                                                                                                                                                     | Not covered here                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| CRM                       | App-owned routes, tenant and organization scoping, failure honesty, provider routing, draft-versus-send policy, versioned synthetic reply fixtures, deterministic quality criteria, and bounded optional scoring | Noli Core entitlement authority, COS installation state, real provider delivery, and cross-product release certification |
| Noli Core / noli-platform | User identity, organization membership, CRM entitlement authority, product/service routing, and their side of provisioning contracts                                                                             | CRM persistence, CRM API authorization, reply generation, and CRM UI behavior                                            |
| Pinned Noli Tests         | Immutable deployed-build checks, authorized provider sandboxes, real infrastructure wiring, cross-product behavior, and shared-live release certification                                                        | Local unit, route, fixture, rubric, or disposable integration checks that CRM can run deterministically                  |

Generic Open Mercato customer, message, and inbox-operation suites remain the source of truth for their framework contracts. Noli tests should add coverage only where the app introduces a product workflow, boundary, integration, or failure mode.

## Commands

```bash
# App-owned Jest regressions
yarn workspace @open-mercato/app test --runInBand

# Focused CI-equivalent CRM route, credential, prompt, and quality regressions
yarn test:crm-regression

# One focused Jest file
yarn workspace @open-mercato/app test --runInBand --runTestsByPath <test-file>

# Credential-free fixture, rubric, threshold, and baseline validation
yarn test:crm-quality

# Optional bounded provider generation and judge scoring
CRM_AI_QUALITY_API_KEY=<dedicated-non-production-key> \
  CRM_AI_QUALITY_MODEL=<approved-low-cost-model> \
  CRM_AI_QUALITY_MAX_CASES=20 \
  yarn test:crm-quality:scored

# Discover disposable Playwright tests after packages are built
yarn build:packages
npx playwright test --config .ai/qa/tests/playwright.config.ts --list

# Focused disposable integration coverage
yarn test:integration:ephemeral --filter customers --no-screenshots

# Full CI integration and code-coverage path
yarn test:integration:coverage
```

Dry-run results are written to `.ai/qa/test-results/crm-quality/dry-run.json`. Scored results are written to `.ai/qa/test-results/crm-quality/scored.json`. The results directory is ignored by Git and uploaded by CI for diagnostics.

## Extending fixtures and rubrics

Versioned synthetic tasks live under `quality/reply-quality/fixtures/v1/`. Treat fixture and result schemas as contracts.

1. Add one focused task with a stable unique ID and a fully synthetic contact, organization, tenant, conversation, and grounded fact set. Never copy production text, identifiers, credentials, or customer data.
2. Include explicit consent, automation mode, expected disposition, recorded candidate, and relevant criterion IDs. Use canary values for the correct customer and tenant plus distinct canaries that must never leak from another scope.
3. Prefer semantic requirements over exact prose. Hard deterministic criteria must cover identity, tenant isolation, consent, approval/disposition, unsupported facts or promises, secret redaction, and safe handling of missing information where applicable.
4. Add or refine the rubric criterion separately from the fixture when the behavior is reusable. A model judge may supply evidence, but it must never override a deterministic hard failure.
5. Run `yarn test:crm-quality` and inspect every per-case and per-criterion result before requesting review.
6. Change a checked-in threshold or baseline only with an intentional rubric change, an explained regression delta, and review evidence. Do not update a baseline solely to make a failure pass.
7. Start a new fixture/schema version for incompatible field or scoring changes. Keep prior versions readable so historical results remain explainable.

## Scored evaluation safety and cost bounds

The normal pull-request gate is always credential-free. `.github/workflows/crm-ai-quality.yml` runs the same dry-run first, then scores only when the dedicated `CRM_AI_QUALITY_API_KEY` secret is present.

- Use only a dedicated non-production evaluation key. Do not expose or reuse production application/provider credentials.
- Use only committed synthetic fixtures. The scored runner must not query a database, CRM API, shared environment, or customer-data store.
- `CRM_AI_QUALITY_MODEL` may select an approved low-cost model. The repository or workflow default should remain low cost.
- `CRM_AI_QUALITY_MAX_CASES` is capped at 20. The scored run permits at most two model calls per fixture and 512 output tokens per call, and the workflow stops after 15 minutes.
- Scoring must not send email, SMS, chat, calendar invitations, webhooks, or any other outbound customer action.
- When the credential is absent, the workflow succeeds with `scored.json` containing `status: "skipped"` and `reason: "credential_missing"`. A skip is not a quality pass.
- Both dry and scored runs retain machine-readable results for 30 days in the workflow artifact.

## Known limitations

- Dry-run recorded candidates validate deterministic rules, rubrics, thresholds, and result reporting; they do not measure current provider behavior.
- Model output and judge scoring can vary even with conservative settings. Deterministic safety failures and minimum thresholds remain authoritative.
- Mocks cannot certify deployed identity wiring, provider availability, real calendar behavior, delivery persistence, or cross-product recovery.
- The harness does not prove that a draft was persisted, approved, or delivered exactly once. Those transactional boundaries need their own deterministic coverage or the bounded live checks below.
- Passing this suite is not shared-live release certification.

## Pinned Noli Tests handoff

This development lane must not deploy, reserve a shared slot, use a provider credential, or operate the pinned Noli Tests environment. The pinned owner fills every placeholder below and performs only the checks that require live wiring.

### Immutable build and slot record

```text
Pull request: <PR URL>
Commit SHA: <full 40-character SHA>
Image tag: <ghcr.io/owner/repository:slot-sha7>
Image digest: <sha256:digest>
QA slot: <qa1|qa2>
QA URL: <slot URL>
Deployment workflow run: <GitHub Actions run URL>
Marker comment URL: <PR comment URL>
Expected marker: <!-- dokploy-qa slot=<qa1|qa2> image=<exact image tag> -->
Authorized sandbox identities: <synthetic user/org IDs only>
Provider sinks/calendars: <authorized sandbox resources only>
```

The named QA slots are replaceable. Before the first case, before every consequential sandbox action, and after the final case, verify that the slot's current Dokploy `dockerImage` exactly matches the marker comment and recorded image tag/digest. Abort immediately if the marker is absent, the digest cannot be established, or the slot image changes. Do not redeploy or repair the slot from this handoff; return it to its owner.

### Live-only cases

| ID          | Check                                                                                                                                                        | Pass condition                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LIVE-CRM-01 | Provision two synthetic users in one Noli organization through Noli Core/COS; retry one user; simulate authoritative lapse separately from dependency outage | Same-user retry returns the stable credential, the teammate remains valid, only positive lapse returns the durable removal signal, and outage never requests removal |
| LIVE-CRM-02 | Use the user-scoped credential through COS/MCP and attempt a foreign organization/tenant request                                                             | In-scope request succeeds with the expected user; foreign scope is denied without data disclosure                                                                    |
| LIVE-CRM-03 | Generate a provider-sandbox reply and critic result for a synthetic contact                                                                                  | Output is grounded and remains a draft; sensitive/unsafe output requires human approval; no message is sent except to an explicitly authorized controlled sink       |
| LIVE-CRM-04 | Create, read, page, and delete an event in an authorized calendar sandbox                                                                                    | Cursor and event contracts are preserved, cleanup succeeds, and no non-sandbox attendee is notified                                                                  |
| LIVE-CRM-05 | Observe recent-work and setup-status projections while Noli Core is available, unavailable, and restored                                                     | Healthy, partial/unavailable, and recovered states are truthful and never appear as false success or entitlement removal                                             |

For each case, record the build identity, UTC timestamps, synthetic fixture IDs, redacted request/response evidence, expected versus actual result, and cleanup result. Never record raw API keys, access tokens, customer content, or provider secrets.

### Cleanup and stop conditions

- Delete sandbox events, messages, contacts, and other temporary records created by the live cases.
- Revoke temporary credentials only through the approved coordinated cleanup path; do not revoke shared or platform-managed credentials ad hoc.
- Stop if a real customer, production resource, unapproved destination, unexpected tenant, shared test record, or changed slot image appears.
- Stop if completing a case would require modifying Noli Core, COS, Hermes, provider configuration, or production/shared infrastructure.
- Report incomplete cleanup or infrastructure failure as a blocked live check, not as a product pass.
