# Test Scenario: AI Token Usage Truth and Diagnostics

## Test ID
TC-GTM-C3-004

## Category
GTM - AI Metering

## Priority
High

## Type
API, Unit, and PostgreSQL

## Description
Verifies that absent provider usage is unknown rather than free and that diagnostics expose only bounded aggregates.

## Prerequisites
- Synthetic model responses and telemetry rows
- Configured synthetic rate card

## Test Steps
| Step | Action | Expected Result |
|---|---|---|
| 1 | Return both provider token counts | Receipt stores `token_usage_known=true` and configured cost |
| 2 | Return a partial/no usage block or throw before response | Receipt stores `token_usage_known=false`; estimated cost is null |
| 3 | Replay the operation key concurrently | Exactly one telemetry receipt persists |
| 4 | Read `ai-telemetry` diagnostics as a viewer | Known tokens/cost and unknown counts are separated |
| 5 | Search encoded response | No prompt, completion, evidence, operation key, request id, or secret appears |

## Expected Results
- Unknown usage never becomes zero-cost evidence.
- Telemetry remains observational and cannot mutate canonical credits.
