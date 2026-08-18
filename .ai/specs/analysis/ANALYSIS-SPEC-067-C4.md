# Pre-Implementation Analysis: SPEC-067 C4 campaign control and mailbox capacity

## Executive summary

C1 made capacity allocation durable per campaign envelope and C2 added mailbox reputation, but the same mailbox can still be approved under different timezones or caps. That creates distinct local-day namespaces and can exceed the intended sender limit. Separately, the server has no operator command to pause, resume, or stop a live campaign; relying on reply/removal side effects is not an acceptable operator safety boundary. C4 fixes both in the GTM app module with additive schema and commands.

## Compatibility audit

| Surface | Impact | Treatment |
|---|---|---|
| Campaign state values | Uses already documented `paused` and `stopped`; adds internal attempt state `paused` | Existing terminal/provider states unchanged |
| Execution API | Adds three strict operations | Existing operations and fields unchanged |
| ACL | Reuses `gtm.launch` | No default role expansion |
| Data model | Adds one table and one index | Generator-owned, additive, no backfill required for an undeployed schema |
| Approval/launch/send | Adds policy comparison | Matching existing envelopes behave unchanged |
| Command registry | Adds lifecycle command ids | Writes and audits stay in the Command pattern |

## Risk assessment

| Risk | Mitigation |
|---|---|
| Pause races with a claimed send | Provider-start transaction re-locks/rechecks campaign; lifecycle command fences not-started attempts |
| Stop falsely cancels an in-flight provider call | Never rewrite `provider_started`; preserve receipt/ambiguity truth |
| Different timezones bypass mailbox cap | One immutable canonical mailbox policy; compare at approval, launch, and send |
| Resume reuses a stale capacity ordinal | Clear capacity key on pause and allocate again at send time |
| Concurrent first launches bind different policies | Serialize on the email connection lock, then create/read the unique policy row |
| Operator targets a stale approval | Require exact current content hash for every lifecycle command |

## Implementation plan

1. Add the canonical policy entity/helper and capacity-scan index.
2. Compare an existing policy at approval; bind or validate it at launch; validate it again under the provider-start transaction.
3. Add pause/resume/stop lifecycle service, registered commands, strict validators, route responses, and least-privilege tests.
4. Add deterministic send-race and real-PostgreSQL policy/capacity tests.
5. Generate/rehearse the migration, run the complete validation stack, then freeze a local commit and recovery artifact.

## Recommendation

Proceed. Both gaps are safety-critical and locally achievable. No external provider, mailbox, shared schema, deployment, or customer action is required.
