# Test Scenario: Mailbox Re-Pause After Operator Clear

## Test ID
TC-GTM-C3-002

## Category
GTM - Sender Reputation

## Priority
Critical

## Type
Integration

## Description
Verifies that a clear is not a policy exemption and a later complaint or hard-bounce decision re-latches the mailbox before provider dispatch.

## Prerequisites
- Synthetic mailbox health and inbound-event fixtures
- Execution and ingestion gates off

## Test Steps
| Step | Action | Expected Result |
|---|---|---|
| 1 | Clear a paused mailbox at its current fence | Mailbox becomes `warning` |
| 2 | Persist a new synthetic complaint event | Event is tenant scoped and idempotent |
| 3 | Refresh mailbox health | Mailbox returns to indefinite `paused` with a higher fence |
| 4 | Evaluate send permission | Provider dispatch is denied with the new pause reason |

## Expected Results
- New safety evidence always wins over a prior operator clear.
- No external provider or mailbox is contacted.
