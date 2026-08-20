# Test Scenario: GTM Synthetic No-Send Activation

## Test ID
TC-GTM-001

## Category
GTM Engineer

## Priority
High

## Description
Verify the complete synthetic Audience Play to launched-campaign path against a freshly migrated disposable CRM database while every external provider, mailbox-ingestion, and email-transport effect remains disabled.

## Prerequisites
- The repository ephemeral integration runner can start a disposable PostgreSQL database.
- `OM_TEST_MODE=1` and the explicit GTM fixture gate are set by the runner.
- Every real provider flag, `GTM_EXECUTION_ENABLED`, and `GTM_MAILBOX_INGESTION_ENABLED` are false.
- Only the loopback synthetic Noli identity fixture is available; no shared service or credential is configured.

## Test Steps

| Step | Action | Expected Result |
|---|---|---|
| 1 | Call Audience Play import without the internal secret. | The request is rejected with 401 and creates no state. |
| 2 | Import the synthetic US-B2B Audience Play with represented-user identity, then replay it. | One workspace and play are created; replay returns the same ids. |
| 3 | Price research, attempt stale create/execute hashes, then confirm and execute the exact plan. | Stale hashes return 409; fixture sourcing accepts at least one evidence-backed synthetic person. |
| 4 | Plan and run enrichment. | At least one synthetic email is verified with fixture-ledger reconciliation complete. |
| 5 | Create a synthetic credential-free mailbox and campaign, set the postal address, and inspect draft state. | The draft binds the expected mailbox, recipient, footer, step, and content hash. |
| 6 | Attempt stale approval, then approve the exact draft and launch it. | Stale approval returns 409; exact approval succeeds and scheduled attempts are materialized. |
| 7 | Tick execution and inspect campaign status. | Tick returns `dry_run=true`; all attempts remain approved and no transport is contacted. |
| 8 | Complete cleanup. | Synthetic GTM, mailbox, and represented-user state are removed with no shared-state mutation. |

## Expected Results
- The end-to-end no-send activation rehearsal passes deterministically.
- Authorization, tenant scope, immutable plan/approval hashes, durable state, and the execution kill switch are exercised through real application routes.
- No provider, mailbox provider, email transport, shared environment, customer data, or prospect data is touched.

## Edge Cases / Error Scenarios
- Missing internal authorization must fail before identity lookup.
- Stale research and approval hashes must not mutate durable state.
- Normal production posture must refuse fixture adapters and fixture credits even if one fixture variable is present.
- Production deployment manifests containing test mode or GTM fixture posture must fail the deployment-security check.
