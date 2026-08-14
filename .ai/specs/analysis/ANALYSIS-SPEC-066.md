# Pre-Implementation Analysis: Noli CRM Regression and Reply Quality

## Executive Summary

SPEC-066 is ready to implement. The audit found no backward-compatibility blocker because the planned harness is additive and the three route fixes preserve URLs and successful response shapes. Implementation must retain deterministic safety precedence, exact organization-plus-tenant scoping, and truthful unavailable responses.

## Backward Compatibility

### Violations Found

None.

| #   | Surface                    | Result                                    | Severity | Implementation constraint                             |
| --- | -------------------------- | ----------------------------------------- | -------- | ----------------------------------------------------- |
| 1   | Auto-discovery conventions | No file/export convention changes         | None     | Keep routes in their current module paths             |
| 2   | Types/interfaces           | Additive private harness schemas only     | None     | Do not narrow exported production types               |
| 3   | Function signatures        | Existing draft entry point remains stable | None     | Add pure helpers without changing required parameters |
| 4   | Import paths               | No moves/removals                         | None     | Keep existing path valid                              |
| 5   | Event IDs                  | No event changes                          | None     | N/A                                                   |
| 6   | Widget spot IDs            | No widget changes                         | None     | N/A                                                   |
| 7   | API route URLs             | URLs/methods/success fields preserved     | None     | Limit change to scope and failure honesty             |
| 8   | Database schema            | No schema or migration                    | None     | Use existing columns only                             |
| 9   | DI service names           | No change                                 | None     | N/A                                                   |
| 10  | ACL feature IDs            | No change                                 | None     | N/A                                                   |
| 11  | Notification IDs           | No change                                 | None     | N/A                                                   |
| 12  | CLI commands               | Additive package scripts                  | None     | Do not rename existing scripts                        |
| 13  | Generated contracts        | No change                                 | None     | Never edit generated files manually                   |

### Missing BC Section

The specification includes a complete `Migration & Backward Compatibility` section.

## Spec Completeness

### Missing Sections

None. TLDR, overview, problem, solution, architecture, data, API, UI, configuration, alternatives, migration/BC, risks, phases, integration tests, compliance, success metrics, open questions, and changelog are present.

### Incomplete Sections

None blocking. Exact implemented fixture counts, measured baseline, command output, and final commit/PR evidence will be added after verification.

## AGENTS.md Compliance

### Violations

None found.

| Rule                         | Evidence                                            | Required implementation behavior                         |
| ---------------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| Correct module location      | Existing Noli app modules own the routes/harness    | No files under raw `app/api` or generic core redesign    |
| Tenant security              | Spec requires org and tenant on every touched query | Tests assert both predicates                             |
| Runtime validation           | Fixtures/candidates are Zod contracts               | Reject malformed input before evaluation                 |
| No hand migrations/setup SQL | No persistent data                                  | Do not touch entities, migrations, or `setup-tables.sql` |
| Integration coverage         | Matrix covers every affected route/path             | Keep tests self-contained and credential-free            |
| UI conventions               | No UI change                                        | No i18n or form work needed                              |
| Commands/events              | No new production write or side effect              | Command/event requirements do not apply                  |

## Risk Assessment

### High Risks

| Risk                                            | Impact                               | Mitigation                                                                                      |
| ----------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Scored judgment hides hard failure              | Unsafe response appears acceptable   | Hard deterministic criteria remain blocking and cannot be overridden                            |
| Production data/provider access from evaluation | Privacy, cost, or real communication | Synthetic fixtures only; dry runner has no network path; dedicated non-production scored secret |

### Medium Risks

| Risk                                 | Impact                         | Mitigation                                                                     |
| ------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------ |
| Route mocks do not prove query scope | False confidence in isolation  | Assert exact `user_id`, `organization_id`, and `tenant_id` builder calls       |
| Setup consumer mishandles new 503    | UI may flatten outage to empty | Preserve successful shape and document typed unavailable contract/live handoff |
| Prompt extraction changes behavior   | Reply wording/quality drift    | Keep public entry signature and test semantic prompt clauses                   |

### Low Risks

| Risk           | Impact                 | Mitigation                                     |
| -------------- | ---------------------- | ---------------------------------------------- |
| Baseline drift | Regression not obvious | Checked-in baseline plus per-criterion delta   |
| CI runtime     | Slower normal gate     | Offline single-process fixture evaluation only |

## Gap Analysis

### Critical Gaps (Block Implementation)

None.

### Important Gaps (Should Address)

- Result directories must remain ignored and artifact uploads must run on failure.
- Missing scored credentials must write a machine-readable skip result.
- Model calls, fixtures, output tokens, and workflow duration require hard limits.
- Provider response parsing and contact/calendar/setup failures need explicit tests.

### Nice-to-Have Gaps

- Promote selected mocked routes to disposable-database integration tests after the current app test runtime is generalized.
- Calibrate subjective judge thresholds over multiple non-production runs before making them blocking.

## Remediation Plan

### Before Implementation (Must Do)

1. Complete the coverage matrix and route contracts in SPEC-066. **Done.**
2. Confirm no protected contract is removed or renamed. **Done.**
3. Separate broad consequential-action defects into follow-up scope. **Done.**

### During Implementation (Add to Spec)

1. Record final fixture count, criterion baseline, and verified commands.
2. Keep route fixes and their exact regressions isolated from harness/CI commits where practical.
3. Re-run the repository review gates in the mandated order.

### Post-Implementation (Follow Up)

1. Specify atomic approval/send and server-enforced MCP confirmation.
2. Specify pipeline/reminder/dedup integrity changes.
3. Execute only the bounded immutable-build/provider-sandbox checks through pinned Noli Tests.

## Recommendation

**Ready to implement.** No critical compatibility, specification, security, or repository-rule blocker remains.
