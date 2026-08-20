# Pre-Implementation Analysis: SPEC-067 C3 dark operator controls

## Executive summary

C2 completed the local mailbox transport, incremental ingestion, reputation, diagnostics, telemetry, and deterministic quality foundations while deliberately leaving every external effect dark. C3 closes three locally actionable release-safety gaps: there is no explicit path to clear an indefinite mailbox safety pause, no safe operator trigger for the existing ingestion worker, and provider exceptions are represented as zero tokens without a machine-readable unknown-usage state. These are additive app-module changes and require no Open Mercato core modification.

## Backward compatibility

| Surface | C3 impact | Treatment |
|---|---|---|
| API routes | Add operations to existing internal execution/reconciliation routes | Preserve all existing methods, operations, fields, and opaque errors |
| ACL | Reuse `gtm.launch` for mutating mailbox controls and `gtm.view` for diagnostics | No new role or default grant |
| Command registry | Register mailbox-control commands in the GTM module | Additive ids only; writes stay in commands |
| Queue | Add an enqueuer for the existing `gtm-mailbox-ingest` worker | Require async strategy and the independent ingestion gate before construction |
| Data model | Add one defaulted non-null boolean to `gtm_ai_telemetry` | Generator-owned migration; old C2 rows default to known |
| Telemetry callback | Add an optional `tokenUsageKnown` field | Optional at the callback boundary; defaults true for compatibility |
| Diagnostics | Add one bounded aggregate response | No content, operation key, request id, raw cursor, or secret leaves storage |

## AGENTS.md compliance

- All behavior remains under `apps/mercato/src/modules/gtm/`.
- Route inputs are Zod-validated and exact identity is re-resolved server-side.
- Mailbox mutations are registered commands with bounded audit snapshots.
- Email-module entities remain cross-module queries with plain UUID ownership; no ORM relationship is added.
- The migration is generated from entity source and the module snapshot remains synchronized.
- No generated registry is edited by hand; the normal generation command is run after the worker/command additions.
- No provider, queue, shared database, mailbox, or production environment is contacted during deterministic tests.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Operator clears a newer pause decision | Mail may resume against fresh safety evidence | Required fence echo plus pessimistic row lock |
| Clear becomes a permanent policy override | New complaints fail to stop sending | Preserve counts and policy; refresh can immediately re-pause |
| Gate-off request still opens Redis | Dark launch leaks an external effect | Test and enforce gate/strategy checks before queue construction |
| Foreign mailbox id becomes enumerable | Tenant information leak | Exact org/tenant predicate and opaque not-found response |
| Queue payload leaks credentials | Secret exposure | Payload contains only four UUID scope/identity fields |
| Zero token provider failure is priced as free | Misleading economics | Explicit unknown flag; cost null; diagnostics split known from unknown |
| Diagnostics expose customer work product | Privacy/IP leak | Aggregate only and enforce a hard row window |

## Implementation plan

1. Extend the entity, callback, receipt writer, and model call sites with `tokenUsageKnown`.
2. Add a bounded AI telemetry aggregator and expose it as a `gtm.view` reconciliation operation.
3. Add a fenced mailbox-health clear service and registered command; expose it as a `gtm.launch` execution operation.
4. Add a pure, injectable mailbox-ingestion enqueue service and a registered command whose production adapter constructs only an async queue after the route gates pass.
5. Generate the additive migration, rehearse it on disposable PostgreSQL, then run focused and full validation with all effect gates off.

## Recommendation

Proceed. C3 is a necessary local integrity envelope and does not broaden release authority. Controlled mailbox traffic, provider access, shared migrations, deployment, legal publication, prospect/customer data, spend, and exposure remain external decision gates after C3.
