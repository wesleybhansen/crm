# Test Scenario: Dark Manual Mailbox Ingestion Enqueue

## Test ID
TC-GTM-C3-003

## Category
GTM - Mailbox Ingestion

## Priority
Critical

## Type
API and Queue Contract

## Description
Proves that an ingestion request constructs no queue while dark and, when explicitly enabled in an isolated async environment, enqueues only one credential-free scoped payload.

## Prerequisites
- Synthetic active Gmail, Outlook, or IMAP mailbox row
- Injected queue fake; no Redis or provider network

## Test Steps
| Step | Action | Expected Result |
|---|---|---|
| 1 | Request enqueue with ingestion gate off | `queued=false`; queue factory not called |
| 2 | Request with gate on and local queue strategy | `503`; queue factory not called |
| 3 | Request with gate on, async strategy, and launch permission | One payload contains only org, tenant, mailbox, and requesting user ids |
| 4 | Inspect payload and response | No token/password/email content; opaque job id returned |
| 5 | Fail enqueue and then fail close after an acknowledged enqueue | Failed enqueue closes and returns unavailable; acknowledged job remains success despite close failure |

## Expected Results
- Ingestion, execution, and module gates remain independent.
- The API never loads credentials or calls a mailbox provider inline.
