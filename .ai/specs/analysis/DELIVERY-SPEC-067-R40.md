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

R45's read-only receipt/dataset reconciliation confirmed that the parser was not the defect. Each provider row echoed the exact sole submitted company URL, but every returned current-position company differed from the frozen company; one row also carried a contradictory LinkedIn company URL and company id. The Short-mode rows therefore remain withheld. The replacement contract uses build `0.0.157` Full-mode current work history, a durable run id, and finalized account event prices (`$0.020` start and `$0.008` per full profile). It still requires the sole exact query echo plus independently matching current company URL/frozen numeric id/non-contradicted name; it does not weaken identity binding.

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

## Production deployment observation

PR `#82` merged as `3e687d9aecadbfa5b64d39eb4ed46b8f5b6041c9` after the CRM regression, full test, ephemeral integration, and Docker-image lanes passed. Production was fast-forwarded to that exact commit and built successfully. Execution, mailbox ingestion, and auto-refill were still unset during deployment, so no queue item, campaign launch, attempt, or provider call could occur.

The first dedicated worker start then failed closed because the production `yarn workspaces focus @open-mercato/app --production` layer omitted `imapflow`. The repository root declared the mail packages, but the app workspace that owns the GTM runtime did not. The full development install masked that packaging boundary. The worker was stopped before ingestion was enabled. The app itself remained healthy; Nginx needed one restart after the app container IP changed and then returned HTTP 200 again.

R41 makes `imapflow`, `mailparser`, and `nodemailer` direct app production dependencies and adds a manifest regression test. The worker must import and remain running from the rebuilt production image before mailbox ingestion is enabled. No GTM execution flag may change until that proof passes.

## R40 closeout status

1. **Complete:** the app-worker discovery correction, Redis-backed mailbox worker, and production runtime dependencies were merged and deployed. The app and dedicated worker remained healthy with zero restarts during the controlled lifecycle.
2. **Complete:** the approved version contained exactly one owner-controlled recipient, one rendered row, the frozen sender/footer/content hash, a one-send cap, and no missing or ambiguous review fields.
3. **Complete:** Gmail ingestion was baselined without a historical sweep. Execution and ingestion were enabled only for the bounded pilot, one attempt was claimed, and one provider transport was contacted.
4. **Complete:** the provider accepted exactly one SMTP submission and the owner confirmed delivery in the owned recipient inbox. No second send was authorized or attempted.
5. **Complete:** one owner reply was ingested and correlated by exact headers. The send attempt moved to `replied`, and the enrollment stopped atomically with reason `email_reply`.
6. **Complete:** the public HTTPS unsubscribe endpoint returned 200 for the first RFC 8058 POST and its replay. Exactly one durable suppression and one audit row exist; a new campaign draft excludes the address.
7. **Complete:** all 24 provider operations are terminal, none are unresolved, and the canonical ledger contains 16 charged, six partially charged, and two refunded outcomes. GTM AI telemetry contains no rows for this provider-only pilot. Execution, mailbox ingestion, and auto-refill were returned to `false` after observation.
8. **Complete:** the deletion request first anonymized the GTM candidate, evidence, contact point, rendered message, reply draft, and provider receipt, but correctly reported `partial` because the linked CRM `email_messages` row remained outside the old GTM deletion authority. R43 now anonymizes only the exact organization/tenant/message ids linked through the removed candidate's reply or inbound-event graph, severs those links, and resumes the existing `crm_email` DSR operation idempotently. Local validation passed: focused removal suite 15/15, complete GTM suite 87 suites and 911 tests with one opt-in suite/seven tests skipped, CRM typecheck, focused lint, and `git diff --check`. PR `#85` passed the CRM regression, full test/build, ephemeral integration, and Docker-image lanes; it merged and production was fast-forwarded to `9e0eed9f70a6421c6c64dc2b03386ac78772b4f6`. The exact original removal replay then completed once: global and tenant requests are `completed`, `crm_email` is `completed` with one attempt, one linked email row is address/content/metadata redacted and soft-deleted, reply/event links and residual message identifiers are null, and exactly one count-only completion audit exists.
9. **Complete:** CRM PR `#84` merged as `61be34a161f82fd06c33666160a0e09d304baf1c` after every CI lane passed and was deployed with all three runtime gates off. Hub PR `#263` merged as `29ebc177d265e01ec629732e11e92720e3a7155a`; its full local 1,270-test suite and typecheck passed, Vercel preview/production deployments passed, and GitHub's two zero-step jobs were unavailable only because of the account billing limit. GTM Setup now collects the sending customer's own mailing address; campaign review remains an editable correction path, and approval stays blocked when the address is absent or changed.
10. **Held outside this owner pilot:** auto-refill remains off, customer/public GTM promotion remains off, and execution remains review-and-approve. A synthetic footer address is not a customer default and cannot authorize prospect outreach. Wider activation requires a separate explicit release decision after R43 production replay is complete.

## Replay correction and recovery

The first R43 operator replay selected the wrong side of the inbound owner-to-owner message. It created one global suppression/intake for a second owner mailbox but had no tenant deletion request, DSR operation, candidate link, or customer/prospect record. The intended removal request was then resolved by matching both message endpoints to the pre-existing address hash entirely on the production host; no readable address was emitted. The intended replay and all redaction evidence above are definitive.

On 2026-08-24 the single unlinked suppression row was exported to the permission-restricted production backup directory `/root/open-mercato/private-backups/gtm-orphan-suppression-20260824` and deleted under guards requiring exactly one global suppression, zero tenant requests, and zero candidate links. The historical intake and audit rows were retained for traceability. Post-cleanup evidence: zero orphan suppressions remain, exactly one intended global suppression remains, and the intended tenant deletion status remains `completed`. Recovery requires inspecting the private one-row CSV and importing it only after confirming that no newer suppression exists for the same address hash.
