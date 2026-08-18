# Test Scenario: Fenced Mailbox Pause Clear

## Test ID
TC-GTM-C3-001

## Category
GTM - Operator Safety

## Priority
Critical

## Type
API and PostgreSQL Concurrency

## Description
Proves that a launch-authorized operator can clear exactly the currently observed paused mailbox and no stale, foreign, inactive, or replayed request can mutate it.

## Prerequisites
- GTM module enabled in an isolated environment
- Synthetic active mailbox and paused `gtm_mailbox_health` row at a known fence
- No real mailbox credentials or provider access

## Test Steps
| Step | Action | Expected Result |
|---|---|---|
| 1 | Read redacted cursor/health status | Response exposes status and fence but no credential/cursor value |
| 2 | Submit `clear-mailbox-pause` with the current fence and controlled reason | `paused -> warning`, reason/time cleared, fence increments, counts remain |
| 3 | Replay the old fence | `409 stale_fence`; row unchanged |
| 4 | Race twelve clears at the same fence in PostgreSQL | Exactly one row update wins |
| 5 | Repeat with a foreign tenant or inactive mailbox | Opaque `404`; row unchanged |

## Expected Results
- Pause recovery is explicit, audited, tenant-scoped, and fenced.
- Clearing never deletes complaint/bounce evidence or changes a feature gate.
