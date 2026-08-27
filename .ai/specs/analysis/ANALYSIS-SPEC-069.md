# Pre-Implementation Analysis: SPEC-069 GTM business and consumer leads

## Executive summary

Current GTM can describe B2C audience segments but cannot source consumer leads because the research planner requires the legacy B2B `execution_eligibility === executable` decision. Changing that enum would accidentally authorize campaign and send paths. The safe extension is a separate research policy, an explicit provider audience-rights contract, and a manual-only consumer artifact that never enters campaign or mailbox execution state.

## Code-grounded findings

| Surface | Current behavior | Required treatment |
|---|---|---|
| `lib/eligibility.ts` | Computes US-B2B email execution only | Preserve and add independent lead/research/outreach policy |
| `research/plan.ts` | Rejects every non-executable play before pricing | Gate on research policy and adapter audience rights instead |
| adapter descriptor | Export/display/outreach booleans do not distinguish business from consumer or manual from automated | Add optional explicit audience and outreach-mode fields; legacy defaults business-only |
| campaign create/approve/send | Recomputes B2B execution at multiple boundaries | Preserve and add explicit automated-email assertion for defense in depth |
| candidate export | Requires verified email and emits email | Keep B2B export; block it for consumer plays and expose consumer evidence/drafts only through the scoped responsive lead view |
| enrichment | Finds and verifies work email for accepted people | Deny email/phone enrichment for consumer plays |
| social tasks | Manual tasks belong to campaign versions | Do not reuse; consumer manual artifacts must remain outside campaigns |
| Hub People UI | B2B metrics, email column, wide fixed table, B2B-only footnote | Branch by lead mode, use responsive cards/table, manual profile/message actions for consumers |
| privacy/terms | State current automated sourcing/outreach is US B2B and prohibit consumer audiences | Draft additive consumer-research/manual-outreach disclosures for counsel re-review |

## Extension-mode decision

Implement as an app-level extension inside `apps/mercato/src/modules/gtm` and the existing Hub GTM surface. Do not modify core CRM customer, campaign, email, queue, or mailbox packages. Do not reuse legacy sequence automation. This preserves module ownership and prevents consumer artifacts from inheriting generic send behavior.

## Backward-compatibility audit

- No existing enum value, response field, route, table, or behavior is removed.
- Legacy `execution_eligibility` remains the authoritative automated-email scope decision.
- New policy columns are nullable and recomputed at every relevant boundary, so pre-migration/current rows retain valid behavior.
- Existing adapter descriptors are treated as business-only unless they explicitly opt into consumer rights.
- Existing v1 consumers can ignore additive response fields and operations.
- B2B campaign snapshots remain valid only while the existing current-play rechecks pass.

## Security and privacy audit

- Sensitive/minor targeting is blocked before quote, reserve, import, export, and draft.
- Consumer source rights require explicit customer display, export, DSR, finite retention, public-profile, and manual-outreach permission.
- Consumer artifacts contain no automated recipient address and never enter a send queue.
- Public destinations must be HTTPS and are returned only through an explicit user action; no server-side fetch or provider call is needed to open them.
- Manual-action audit records identifiers, hashes, action class, and time, not message or evidence content.
- All route queries bind organization and tenant and use opaque not-found behavior.

## Migration impact

One generator-owned GTM migration adds nullable play-policy columns and the new organization/tenant-scoped manual-draft table with indexes and uniqueness constraints. No existing column is retyped or backfilled in place. Rollback is gate-first; retained consumer data remains available for removal and DSR handling.

## Test and quality plan

1. Pure policy matrix and sensitive/minor adversarial tests.
2. Adapter rights and immutable plan-hash tests.
3. Fixture consumer research from quote through accepted named people and evidence.
4. Hard-block tests at enrichment, export, campaign, approval, launch, send, and social/mailbox boundaries.
5. Manual draft idempotency, metering, source-rights, and action-state tests.
6. Removal/retention cascade tests.
7. Hub parser, rendering, keyboard, copy/open action, and no-send-affordance tests.
8. GTM artifact-quality fixtures including a realtor use case and sensitive-target refusals.
9. Existing GTM module, whole-module typecheck, Noli Hub tests/typecheck/build, migration apply/reapply, and `git diff --check`.

## Recommendation

Proceed with the additive split. It is the smallest architecture that can produce true consumer leads without weakening the established B2B money, approval, identity, suppression, and execution spine.
