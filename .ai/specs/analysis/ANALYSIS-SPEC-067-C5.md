# Pre-Implementation Analysis: SPEC-067 C5 truthful campaign completion

## Executive summary

The durable campaign model has always documented `completed`, but no safe transition can reach it. C5 adds one exact-envelope, launch-authorized command. It is intentionally conservative: completion is rejected while any email attempt is pre-dispatch, in flight, or ambiguous, or while any manual-social task for an active enrollment lacks an explicit user-recorded terminal outcome.

## Compatibility and safety audit

| Surface | Impact | Treatment |
|---|---|---|
| Campaign API | Adds strict `complete-campaign` operation | Existing operations remain unchanged |
| RBAC | Reuses `gtm.launch` | No role or feature expansion |
| Campaign state | Makes the documented `completed` state reachable | Only `active -> completed`; paused/stopped/draft states fail closed |
| Email truth | Accepts only definitive send-terminal states | `provider_started` and `ambiguous` block completion |
| Manual social truth | Requires `task_sent` or `task_skipped` for every active enrollment/task pair | Missing rows remain honestly pending |
| Enrollment state | Active enrollments become `completed` transactionally | Stopped enrollments remain stopped |
| Schema | No change | C5 is code/test/spec only |

## Acceptance plan

1. Validate the exact current campaign version and content hash under a pessimistic campaign lock.
2. Reject completion unless every current-version email attempt and every derived manual task is terminal.
3. Transition active enrollments and campaign atomically, write a bounded audit, and make exact replays idempotent.
4. Prove RBAC, strict input parsing, incomplete/ambiguous rejection, manual-task truth, enrollment transition, audit, and replay behavior with deterministic tests.
5. Re-run the complete GTM and repository validation stack with all external-effect gates off.

## Recommendation

Proceed. A modeled terminal state without a truthful transition is an operational gap. C5 closes it without schema, provider, mailbox, migration, deployment, or customer authority.
