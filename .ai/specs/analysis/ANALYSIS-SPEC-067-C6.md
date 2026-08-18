# Pre-Implementation Analysis: SPEC-067 C6 hard-gated execution queue target

## Executive summary

The execution service and manual `tick` route can safely claim and process due attempts, but the queue worker registry has no GTM execution target. C6 adds only that target. It creates no schedule, subscription, provider call, mailbox call, migration, deployment, or flag change. The worker returns before payload validation or dependency resolution unless both `GTM_ENGINEER_ENABLED` and `GTM_EXECUTION_ENABLED` are explicitly true.

## Compatibility and safety audit

| Surface | Impact | Treatment |
|---|---|---|
| Worker registry | Adds `gtm-execution-tick` target | No schedule is created; generic scheduler configuration remains a release-authority action |
| External effects | May reach the existing mailbox transport only when both gates are true | Gate check precedes payload parsing, ORM resolution, claims, and transport construction |
| Identity | Requires scoped organization, tenant, and requesting-user UUIDs | Queue context becomes the bounded GTM audit/request context; scheduler `_idempotencyKey` is accepted but ignored |
| Throughput | Parks expired post-dispatch work, claims at most 100 due attempts, and executes sequentially | Ambiguous work is never retried; DB CAS/fence rules remain authoritative across workers/processes |
| Schema | No change | C6 is source/test/spec only |

## Acceptance plan

1. Define a stable queue/payload contract compatible with the generic scheduler's scoped payload injection.
2. Prove both gates are required before parsing or resolving dependencies.
3. Isolate a pure processor and prove exact scope/limit forwarding and sequential outcome order with injected, network-free dependencies.
4. Re-run the complete GTM, TypeScript, lint, build, migration-replay, generator-drift, and security checks with all external-effect gates off.

## Recommendation

Proceed. This closes the local execution-wakeup plumbing gap without activating it. Creating or enabling a schedule remains a separate operational release decision.
