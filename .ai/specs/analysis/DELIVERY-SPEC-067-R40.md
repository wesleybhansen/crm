# SPEC-067 R40 owner production pilot evidence

Date: 2026-08-24  
Scope: one owner-controlled recipient, one owner-controlled Gmail sender, one message, one reply, one unsubscribe, and no prospect outreach  
Authority: the owner explicitly approved completing the bounded lifecycle straight through with strict spend/send caps

## Release invariants

- This is a production control-plane pilot, not customer activation.
- The only campaign-ready recipient is an owner-controlled inbox attested by the owner and already proven reachable in the disposable R4 rehearsal. Its address is not copied into this artifact, an audit row, provider receipt, or application log.
- No real prospect contact point may be enrolled or sent during R40. The other 34 candidate identities currently visible to the campaign are excluded because they lack a verified contact point.
- LeadMagic and Bouncer remain excluded. DataForSEO and the contract-pinned Apify capabilities remain the only selected provider stack.
- Auto-refill may be frozen into the campaign approval, but its runtime gate and schedule remain off until the one-message lifecycle is completely reconciled.
- Public/customer GTM promotion remains off until the owner pilot has one definitive send, reply, suppression, and money outcome.

## Production preflight

| Boundary | Evidence | Result |
|---|---|---|
| CRM current main | Remote main `836e2cdc65f79e84ac8635f2db9e6eea69791fa8`; deployed source `ba6d8efaca839e4121258b5f86c871b17f8757c7`; merged-main CI run `32746816925` green | Pass |
| GTM schema | All 32 GTM tables exist, including mailbox, inbound, suppression, deletion, provider reconciliation, and auto-refill tables | Pass |
| Provider money | Every provider operation was terminal after the two R40 operator reconciliations; no automatic retry occurred | Pass |
| Sender | Exactly one active, primary, personal Gmail SMTP/IMAP connection is selected by id | Pass |
| Recipient | Exactly one verified, owner-controlled contact point is campaign-ready; 34 non-ready identities are excluded | Pass |
| Unsubscribe | Explicit `https://crm.noliai.com` public base, a new v2 rotatable keyring, and an active key id are configured; the legacy v1 secret remains verification-only | Pass |
| Execution controls | Execution, mailbox ingestion, auto-refill, LeadMagic, and Bouncer remain off | Pass |
| Postal footer | The owner authorized a clearly synthetic address for this owner-to-owner transport proof only. It is workspace-scoped and hash-bound; it is not valid for customer/prospect activation. | Pass for pilot only; blocked for wider activation |
| Worker registration | App-local worker files were omitted from generated registries because worker metadata discovery imported the wrong path/runtime graph | Corrected locally with generator regression coverage; deploy before ingestion |
| Queue isolation | The production global queue strategy and Redis URL were unset | GTM-only async strategy plus an internal persistent Redis and dedicated mailbox worker added locally; deploy before ingestion |

Local release validation for the worker/queue correction: 86 of 87 GTM suites passed with 908 of 915 tests passing and only the opt-in PostgreSQL suite/seven tests skipped; all 15 CLI suites passed with 180 runnable tests; CLI and CRM typechecks, focused lint (two unrelated pre-existing warnings), the complete package/application production build, YAML parsing, and `git diff --check` passed.

The production environment backup created before the unsubscribe configuration change is:

`/root/open-mercato/.env.production.bak-gtm-owner-pilot-20260824T164752Z`

The backup and active environment contain secrets and must never be attached to an issue, commit, or handoff.

## Source, qualification, and reconciliation evidence

The bounded source run is `77671077-41a9-4c56-8ede-e6cd291c5ede`.

| Stage | Bound | Definitive outcome |
|---|---:|---|
| Apify company source | Target accepted 1; raw ceiling 5; quote 10,500 credits | Five raw rows; three accepted; two rejected; 10,500 credits charged; no ambiguity; no duplicate identity rows inserted |
| Decision-maker company 1 | One company; max 3 profiles; 25,000-credit ceiling | Two provider rows could not be bound to the frozen company and were withheld. Apify run `57hQmjJ0XkexHS6gM` finalized at `$0.026`; canonical operation reconciled to `partially_charged` at 13,000 credits. |
| Decision-maker company 2 | One company; max 3 profiles; 25,000-credit ceiling | Definitive no-result; 10,000 credits charged for the actor-start event; no person persisted. |
| Decision-maker company 3 | One company; max 3 profiles; 25,000-credit ceiling | One provider row could not be bound and was withheld. Apify run `CR5ylvUduUmWfkeDS` finalized at `$0.023`; canonical operation reconciled to `partially_charged` at 11,500 credits. |

The account-specific Apify receipts show that the current decision-maker Actor charges `$0.020` for the start and `$0.003` for each short profile. That is lower than the frozen conservative `$0.004` quote input, so the maximum authorization remained safe. The two schema-binding failures are product-quality evidence: Noli withheld ambiguous people rather than silently associating them with a company.

Because the selected source did not produce a trustworthy person, R40 uses a separately labeled owner-controlled pilot identity for the transport lifecycle. It is not represented as a provider-sourced lead, is retained for 14 days, has `owned_inbox_only=true`, and is covered by a PII-free `gtm.owner_pilot.recipient_seeded` audit event.

## Campaign envelope and budgets

Campaign: `19fb9bce-afeb-4132-8632-c9cdaec287ec`

Approved version: `a19b38ad-476c-401e-ab46-925513af2027`

Approved content hash: `ed1e0b37c044c3b7f8e0dd35a381178ee6e6da56340bf10fe19a466a710c5828`

- One email step; no social steps.
- Daily send cap: 1.
- Sender: the single active personal Gmail connection.
- Recipients: exactly 1 owner-controlled inbox.
- Duplicate override: false.
- Send window: 00:00-24:00 America/Los_Angeles, weekdays only, zero jitter for the controlled proof.
- Manually reviewed subject: `Owner-only GTM lifecycle check`.
- The body states that this is the single owner-authorized production lifecycle message and asks for one reply plus use of the unsubscribe link.
- Pre-address draft content hash after the budget configuration: `4bb7ac2fc1bcad2bc1d881eb1b87564a99590a25ee176c44a6c5a6b724b76120`; the approved post-fixture hash is recorded above.
- Auto-refill approval block: target 1 accepted per weekday, maximum 5 raw rows, maximum 25,000 credits (`$0.10`) per day, 09:00 America/Los_Angeles, exact source plan `66f70b4fef07810f45143fc7a40467e3c612928f3316b5b7a83712b4574551e5`.
- The exact current quote for that block is 10,500 credits (`$0.042`) and five raw rows. The larger 25,000-credit daily ceiling admits one batch but never a second batch.
- `GTM_AUTO_REFILL_ENABLED=false` remains authoritative until the owner pilot is clean.

## Owner and legal decisions

| Topic | R40 decision | Public/customer activation gate |
|---|---|---|
| Prospect data | The production pilot uses no prospect address and retains only bounded public qualification evidence. | US B2B only; minimum necessary public/provider data; verified source rights and current suppression before every approval and send. |
| Automated outreach | One owner-controlled recipient and one message only. | Customer must explicitly approve the exact recipient, sender, content, footer, and schedule; no bulk or hidden auto-send. |
| Retention/deletion | Owner fixture expires after 14 days. Normal never-promoted candidates retain the existing 90-day ceiling. Unsubscribe suppresses immediately; deletion requests use the existing CRM/DSR path. | Public privacy and terms must describe provider processing, retention, deletion limitations, and customer obligations accurately. |
| Footer/address | The address belongs to the business/person whose commercial message is sent. The owner authorized one clearly synthetic fixture for the owner-controlled pilot only; it is hash-bound and must be removed after evidence capture. | Collect the sending customer's own valid business address during GTM setup, keep it editable in Settings, automatically footer-render it, and block approval/send when absent or changed. Never use the synthetic pilot fixture for customer or prospect email. |
| DataForSEO | Owner-provided written clarification authorizes customer display/export/retention, qualification evidence, and B2B-outreach support for the described workflow, subject to source-platform restrictions. Reviewed Terms version is 2026-06-12. Live Google Maps is `$0.002` per page up to 100 results without multipliers. Live results are not retained by DataForSEO; standard results are retained 30 days, HTML 7 days, screenshot links one day after capture. | Exact terms/price/retention gates remain fail-closed and must be re-reviewed after a provider change. |
| Apify | Owner approved Apify. Current official Actor Terms are effective 2026-07-09. Community Actors are not vetted by Apify, and the owner remains responsible for legal compliance and source-platform rights. Exact actor/build/price/retention gates remain required. | Only the selected, pinned capabilities may run. No arbitrary Actor override or claim of official LinkedIn affiliation. |
| LeadMagic/Bouncer | Excluded for cost and product reasons. | No activation; a future change requires a new explicit provider decision and contract. |

Primary sources:

- https://dataforseo.com/terms-of-service
- https://dataforseo.com/pricing/serp/google-maps-serp-api
- https://dataforseo.com/help-center/how-long-do-you-keep-results
- https://docs.apify.com/legal/general-terms-and-conditions
- https://docs.apify.com/legal/actor-terms-and-conditions
- https://docs.apify.com/legal/acceptable-use-policy
- https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- https://noliai.com/terms
- https://noliai.com/privacy

## Operator alerts and stop conditions

The Hub Usage screen is the operator alert surface. It reads the canonical provider history plus CRM shadows and visibly calls out `started`, `ambiguous`, `unknown`, invalid operator records, and truncated windows. Mailbox health separately stops dispatch on bounce/complaint policy breaches. Auto-refill blocks itself on identity/RBAC drift, plan drift, credit-ceiling drift, provider ambiguity, or unresolved ledger truth.

R40 must stop and keep execution/ingestion off if any of the following occurs:

- more than one recipient or due attempt;
- a recipient or sender differs from the exact approved snapshot;
- a missing or non-HTTPS unsubscribe URL;
- an address, footer, or content-hash mismatch;
- any unresolved provider operation or canonical-ledger discrepancy;
- SMTP ambiguity, duplicate dispatch, unrelated inbound mail inside the pilot cursor window, or reply-correlation ambiguity;
- any suppression, bounce, complaint, or mailbox pause before dispatch;
- daily source credits above 25,000 or sends above one.

## Remaining R40 sequence

1. Merge and deploy the app-worker discovery correction plus the isolated Redis-backed GTM mailbox worker.
2. Re-verify the approved version has one recipient, one rendered row, no missing fields, no quality issues, exact sender, one-send cap, and the frozen auto-refill block.
3. Baseline Gmail ingestion without reading history, enable execution and mailbox ingestion, launch, and run one tick.
4. Verify one SMTP acceptance and definitive delivery to the owned recipient.
5. Ingest one owner reply and prove exact correlation plus atomic enrollment stop.
6. Exercise the HTTPS unsubscribe POST, prove idempotent suppression/cancellation/audit, and prove a new campaign excludes the address.
7. Verify campaign analytics, provider history, mailbox health, token/spend telemetry, and canonical money reconciliation.
8. Clear the owner fixture through the deletion/retention path after evidence capture.
9. Add the customer-owned address input to GTM setup/onboarding and retain the campaign review/settings editor as a correction path.
10. Only after those checks are clean, activate the bounded auto-refill schedule and publish GTM onboarding to the smallest owner/customer cohort. Execution remains review-and-approve, never automatic enrollment or send.
