# Test Scenario: GTM Operator RBAC and Tenancy

## Test ID
TC-GTM-C3-005

## Category
GTM - Authorization

## Priority
Critical

## Type
API Security

## Description
Validates least-privilege mapping and tenant opacity for the C3 operator surfaces.

## Prerequisites
- Represented viewer, approver, and launcher roles in isolated fixtures
- Two synthetic tenants

## Test Steps
| Step | Action | Expected Result |
|---|---|---|
| 1 | Read AI telemetry and cursor diagnostics as viewer | Allowed; aggregate/redacted response only |
| 2 | Clear or enqueue as viewer/approver without launch | `403`; no mutation or queue construction |
| 3 | Clear or enqueue as launcher | Operation proceeds only within represented org/tenant |
| 4 | Present tenant A with tenant B mailbox id | Opaque `404` |
| 5 | Remove RBAC dependency or force it to throw | Request fails closed with `403` |

## Expected Results
- Read operations map to `gtm.view`; mailbox mutations map to `gtm.launch`.
- The service secret never substitutes for represented-user authorization.
