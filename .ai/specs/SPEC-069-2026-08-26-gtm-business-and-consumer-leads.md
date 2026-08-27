# SPEC-069: GTM business leads and consumer demand opportunities

**Date:** 2026-08-26 PDT
**Status:** Implemented and locally validated on the dedicated current-main CRM and Noli branches. Production consumer sources and customer exposure remain separately fail-closed until their exact source contracts and release controls are verified.
**Authority:** Wesley Hansen's 2026-08-26 product decisions that GTM Engineer must support both B2B and true-consumer B2C demand discovery; that consumer work starts with the places, conversations, events, and engaged audiences where buyers gather; that named people are a useful optional second layer; and that automated cold outreach remains confined to the governed B2B lane while consumer participation or outreach is prepared for a human to perform manually.
**Companions:** SPEC-067 (durable GTM domain and B2B execution), GTM-SPEC-01 (Audience Plays contract), GTM-SPEC-02 (v1 facade), and GTM-SPEC-04 (GTM workspace).

## 1. TLDR

GTM Engineer must return actual leads as well as audience segments for business markets. For consumer markets, its primary work product is a map of actionable demand opportunities: communities, forums, groups, threads, posts, creators, audience hubs, and in-person or online events where likely buyers already gather or express intent. When an approved source can lawfully return public participants, organizers, authors, or engaged people, those named individuals are an optional second layer.

For the first real-estate vertical this means separate buyer-intent and seller-intent opportunities, such as local relocation conversations, home-search communities, first-time-buyer events, downsizing or home-preparation discussions, neighborhood groups, public housing questions, open-house or seminar audiences, and public posts whose engagement indicates a current housing need. The product must explain why the opportunity matters, show retained evidence and freshness, estimate audience or engagement honestly, and recommend a human participation path. It must not infer private intent from protected, distressed, or otherwise sensitive facts.

The existing `execution_eligibility` field remains the backward-compatible B2B automation decision. A new policy contract separates:

1. `research_eligibility`: whether a play may be researched with an approved provider, imported only, or not processed;
2. provider audience rights: whether one exact adapter contract permits customer display, export, retention, and manual outreach for business or consumer records; and
3. `outreach_mode`: whether Noli may use governed automated email, may only prepare a manual action, or must block outreach entirely.

For a non-sensitive United States consumer play, the product policy is `provider_runnable` research plus `manual_only` participation/outreach. A provider still fails closed unless its descriptor explicitly grants consumer customer-serving rights. Consumer records may expose public evidence, the public opportunity destination, grounded participation guidance, and optionally a public person/profile plus a draft the customer can copy. Noli does not send, post, call, text, join a group, register for an event, or simulate completion for the customer.

## 2. Problem statement

Current GTM logic equates “researchable” with “eligible for automated B2B email.” `computeExecutionEligibility` returns `strategy_only` for every consumer play, and research planning rejects every non-`executable` play before provider pricing. The UI therefore shows consumer ideas but cannot produce consumer leads. Reusing `executable` for consumers would be unsafe because campaign creation, approval, launch, and every send claim treat it as authorization for automated email.

The fix must be additive. Existing B2B clients, campaign snapshots, tests, and dark execution controls depend on `execution_eligibility`. They must not change meaning.

## 3. Product contract

### 3.1 Lead modes

- `business`: the buyer is acting in a professional or business capacity.
- `consumer`: the buyer is an individual acting in a personal capacity.
- `mixed`: the play has not been split into a single governed lead mode.

Mixed plays are useful strategy but are `import_only` and `manual_only` until the user creates separate business and consumer plays. Unknown market type is blocked.

### 3.2 Research eligibility

- `provider_runnable`: product policy permits paid sourcing, but only an adapter with an exact matching audience-rights contract may enter a quote.
- `import_only`: customer-owned or otherwise separately lawful records may be imported and reviewed; no sourcing provider may be called.
- `blocked`: no source, import, qualification, enrichment, export, or outreach artifact may be created.

United States business and non-sensitive consumer plays may be `provider_runnable`. Non-US and mixed plays are `import_only` in this version. Missing geography or market type fails closed.

### 3.3 Outreach mode

- `automated_email`: available only to a non-sensitive, United States business play and still subject to all SPEC-067 campaign, approval, sender, suppression, and execution controls.
- `manual_only`: Noli may show public evidence, a public HTTPS destination, and grounded draft copy. The customer must perform the action outside Noli. No provider dispatch occurs.
- `blocked`: no outreach artifact or destination action is exposed.

Consumer and mixed plays can never receive `automated_email`, regardless of a caller field, stored legacy value, adapter descriptor, campaign version, or feature flag.

### 3.4 Consumer work product

An accepted consumer opportunity includes:

- a stable opportunity kind: `community`, `forum`, `group`, `thread`, `post`, `event`, `creator_audience`, or `other`;
- a clear title and platform or venue;
- a public HTTPS source or destination returned by an approved source;
- the public source and observation time;
- the audience, topic, location, buyer/seller intent, engagement or activity signal, and access posture that the source actually supports;
- a plain-language “why this opportunity” explanation grounded in retained evidence;
- confidence, contradictions, and unknowns;
- an honestly labeled audience or engagement estimate when available;
- a recommended human action, such as contribute a useful answer, attend, follow the conversation, contact the organizer, or review public participants;
- a grounded message angle that respects the venue's rules and does not recommend spam or deceptive participation; and
- an explicit `Manual only` status with `Open opportunity` and optional `Copy draft` actions.

When the same approved source returns a public author, organizer, moderator, attendee, follower, commenter, or other engaged person, Noli may retain that person as a separate candidate or as bounded public context on the opportunity. The person view preserves its own evidence and must not imply that group membership, a reaction, or a public profile is consent. Personal email and phone enrichment are not run for consumer plays in this version. Consumer exports omit email and phone.

### 3.5 Real-estate opportunity contract

The first vertical must cover both sides of the residential transaction without sensitive inference:

- `buyer_intent`: public questions or participation about buying, relocating, financing education, neighborhoods, schools as a place-selection topic rather than a protected-class proxy, open houses, new construction, first homes, investment education, and home-search events;
- `seller_intent`: public questions or participation about preparing, pricing, staging, renovating, downsizing in a non-age-targeted way, moving, listing, local market conditions, home-valuation education, and seller workshops;
- `local_audience`: neighborhood, relocation, homeownership, community, creator, newsletter, and event audiences whose topic and geography fit the play even when no individual has declared immediate intent; and
- `engaged_people`: optional public authors, organizers, commenters, followers, attendees, or other participants supported by exact retained evidence.

Foreclosure, bereavement, divorce, health, age, family status, ethnicity, religion, disability, immigration, debt distress, and other sensitive or protected targeting remain blocked even if a data source exposes them.

## 4. Sensitive-category and minor policy

The policy engine scans the complete bounded targeting contract, including audience, signal, source hint, why-now, recommended angle, and structured provider-query values. It blocks consumer or mixed targeting involving:

- minors or inferred youth status;
- health, disability, diagnosis, pregnancy, or mental-health status;
- race, ethnicity, religion, sexual orientation, gender identity, citizenship, or immigration status;
- bereavement, probate, divorce, foreclosure, bankruptcy, tax delinquency, liens, debt distress, or mortgage-payoff status;
- age, retirement, family status, or other sensitive life-stage targeting; and
- another criterion that is prohibited by the current reviewed policy version.

This is a hard product boundary, not a fit-score penalty. A public record does not make sensitive targeting acceptable. A professional B2B audience such as estate attorneys may be allowed when it does not name or infer an individual client's sensitive event.

Policy result includes finite `policy_flags`; customer-facing text uses safe category labels and never echoes sensitive provider rows.

## 5. Provider rights contract

`AdapterLicenseConstraints` gains additive optional fields:

- `audience_modes: ('business' | 'consumer')[]`;
- `manual_outreach_allowed: boolean`;
- `automated_email_allowed: boolean`; and
- `public_profile_contact_allowed: boolean`; and
- `public_opportunity_use_allowed: boolean`.

Legacy descriptors with no new fields retain their current business behavior only. They never gain consumer rights by implication. Consumer planning requires all of:

- license status `approved` or deterministic `test_only`;
- exact non-empty terms version;
- `audience_modes` explicitly contains `consumer`;
- customer display and export are allowed;
- manual use is explicitly allowed;
- deletion/DSR is supported; and
- a finite retention period exists.

An `opportunity` additionally requires `public_opportunity_use_allowed`. A
`person` or `company` consumer result additionally requires
`public_profile_contact_allowed`. These are separate rights: permission to show
a public discussion or event does not imply permission to retain a participant
as a contact, and contact permission does not imply permission to automate any
consumer action.

The deterministic consumer fixture adapter satisfies these constraints for local tests only. No production adapter is marked consumer-approved merely because credentials exist.

## 6. Data model

### 6.1 Additive play policy columns

`GtmPlay` gains nullable columns so existing rows remain compatible:

- `lead_mode`;
- `research_eligibility`;
- `research_eligibility_reason`;
- `outreach_mode`;
- `outreach_policy_reason`;
- `policy_flags` JSONB; and
- `policy_evaluated_at`.

Every money, export, draft, campaign, and send boundary recomputes policy from the play's canonical targeting fields. Stored columns are display and audit truth, never the sole authorization.

### 6.2 Manual outreach drafts

New `gtm_manual_outreach_drafts` rows are organization- and tenant-scoped and contain:

- required workspace, play, candidate, and candidate-match references;
- channel (`linkedin`, `x`, or `public_profile`);
- exact public HTTPS destination;
- required plain-text body;
- content and evidence hashes;
- model/provenance metadata without prompts or provider payloads;
- a one-way idempotency-key hash unique within the organization;
- status (`draft`, `copied`, `opened`, `dismissed`) and bounded action timestamps;
- a 30-day retention expiry; and standard UUID/timestamp/soft-delete fields.

Rows are not sends, enrollments, tasks, delivery events, or consent records. `opened` means Noli returned the public destination to a user action; it does not claim the browser loaded it or that a message was sent.

### 6.3 Demand opportunities

The existing additive `gtm_candidates.entity_kind` text column gains the value `opportunity`; no destructive enum migration is required. Opportunity-specific fields live in the bounded identity JSON contract:

- `opportunity_kind`, `platform`, and `intent_kind`;
- `audience_description`, `activity_level`, and exact optional `member_count` or `engagement_count`;
- `access_type`, `event_start_at`, and structured public location when available;
- `participation_rules`, `recommended_action`, and `message_angle`; and
- optional `people_to_follow`, limited to public names, roles, and HTTPS profiles supported by retained evidence.

The canonical candidate URL is the deduplication identity for an opportunity. A source URL plus opportunity kind is the fallback. Opportunity candidates cannot enter enrichment, campaign, recipient, send, mailbox, or suppression execution paths.

## 7. API contract

### 7.1 Existing additive responses

Play summaries/details add the seven policy fields. Candidate list/detail adds the selected play's lead mode, research eligibility, outreach mode, and safe reasons. Existing fields remain present.

Research plan/create/execute uses `research_eligibility`, provider audience rights, and the immutable policy snapshot/hash. The legacy `play_not_executable` code remains for B2B campaign boundaries; research uses `play_not_researchable` when appropriate.

### 7.2 Manual-outreach operations

`POST /api/internal/gtm/manual-outreach` provides:

- `list`: returns the represented user's non-dismissed drafts within the exact workspace/play/candidate scope;
- `create`: requires candidate, match, play, workspace, channel, and an Idempotency-Key. The server selects the destination from retained candidate provenance, re-resolves all rows and rights, recomputes policy, requires an accepted person and eligible evidence, and returns the same stored draft on replay; and
- `mark`: records only `copied | opened | dismissed`. It never invokes a network provider or dispatch queue.

Consumer CSV export remains unavailable in this version. The responsive Opportunities screen presents public destinations, qualification explanations, evidence, activity, and recommended next actions directly. Its secondary People section presents optional public individuals and manual drafts. The B2B reviewed-lead export continues to require verified work email and rejects manual-only plays.

The Hub and v1 facade remain thin identity-stripping proxies. Mutating operations require Idempotency-Key.

### 7.3 MCP contract

GTM Engineer is discoverable through the existing Mercato MCP registry and therefore through Noli's unified MCP gateway. Its initial tools are safe, tenant-scoped primitives rather than a second execution surface:

- list GTM workspaces and plays available to the represented user;
- list and filter accepted or reviewable opportunities and leads by workspace, play, market, entity kind, intent kind, opportunity kind, and fit state;
- retrieve one opportunity or lead with evidence and public destinations; and
- record a human review decision through the same application service and audit boundary.

Every tool declares module `gtm`, required features, a bounded Zod schema, organization and tenant scope, finite pagination, and safe output. No MCP tool directly calls a paid source, enriches a consumer, creates or launches a campaign, sends or posts, or bypasses quote, confirmation, approval, suppression, or execution gates.

## 8. Hard execution boundaries

The following all recompute outreach policy and reject anything except `automated_email`:

1. consumer email/phone enrichment;
2. reviewed-lead email export;
3. campaign create/attach;
4. campaign approval freeze;
5. campaign launch;
6. every execution claim and provider-start transition;
7. mailbox enqueue or reply-send on behalf of a consumer lead; and
8. social task automation.

Opportunity candidates also fail closed at enrichment, export, campaign, enrollment, approval, execution, mailbox, and reply boundaries regardless of play policy or caller-supplied fields.

No call or text adapter/channel is introduced. Manual consumer actions never enter campaign, enrollment, send-attempt, mailbox, reply, or social-task tables.

## 9. UI/UX contract

The Opportunities screen uses progressive disclosure rather than one wide provider-shaped table:

- audience header shows `Business` or `Consumer` and a plain policy summary;
- consumer summary cards distinguish places to participate, active conversations, events, and optional people;
- consumer results prioritize scannable opportunity cards with kind, platform, buyer/seller intent, location, activity/freshness, why-it-fits evidence, audience estimate, access posture, recommended action, and an `Open opportunity` control;
- optional people appear in a secondary section and never visually replace the demand-surface result;
- real-estate plays expose buyer-intent, seller-intent, and local-audience filters in customer language;
- B2B summary cards retain sourced leads, accepted leads, evidence, and reachable work contacts;
- desktop uses a readable table; tablet/mobile use stacked lead cards with no page-level horizontal overflow;
- B2B rows retain verified-work-email controls;
- B2C rows show public profile, evidence, grounded why-them, `Manual only`, draft/copy/open controls, and no send/campaign CTA;
- source rights, missing public destination, unavailable drafting, and blocked policy each have distinct honest states; and
- every action has a 44-pixel target, visible focus, reduced-motion support, and existing Noli tokens/typography.

Strategist may plan and execute an eligible consumer research run only after the user confirms its immutable quote and only while the exact server consumer-research and provider-contract gates pass. It does not expose join, register, comment, post, approve, launch, send, call, text, or social-post tools for the resulting consumer opportunities or people, and explains that the user must review venue rules and participate manually.

## 10. Privacy, removal, and retention

Privacy and Terms drafts disclose business and consumer prospect research separately, manual-only consumer outreach, source/provenance retention, public-profile use, customer responsibilities, removal, suppression, and the prohibition on sensitive/minor targeting. The existing account-free removal route covers both lead modes.

Consumer candidates retain the existing 90-day never-promoted ceiling unless the exact provider contract is shorter. Manual drafts expire after 30 days. Deletion removes drafts with the candidate. A one-way suppression/removal hash may remain where required to honor future requests.

These documents are prepared for counsel re-review. Code or prior counsel approval is not represented as approval of this new consumer scope.

## 11. Compatibility audit

- `execution_eligibility` keeps its exact meaning: governed US B2B automated execution only.
- Existing B2B plays recompute to `business`, `provider_runnable`, `automated_email`.
- Existing consumer person candidates remain readable and become the optional People layer; no stored person is converted into an opportunity.
- `opportunity` is additive to the text-backed candidate entity kind and is never treated as a recipient.
- Existing adapter descriptors default to business-only.
- Existing research and campaign response fields are preserved; new policy fields are additive.
- Existing campaign snapshots and send attempts remain valid only under their original B2B rechecks.
- Existing v1 clients may ignore the new fields. No existing enum value is removed or renamed.
- New schema is additive and nullable/default-safe. Rollback disables the consumer runtime gate and leaves retained rows available for deletion/DSR.

## 12. Feature gates and rollout

- `GTM_CONSUMER_RESEARCH_ENABLED`: exact true, false by default. Checked before quote and again before provider reserve.
- Adapter-specific existing gates still apply.
- No consumer-specific execution gate exists because consumer execution is structurally absent.
- Customer exposure follows the existing GTM customer-release posture. Paid consumer sourcing additionally remains impossible until the exact `GTM_CONSUMER_RESEARCH_ENABLED` gate and a separately consumer-approved production adapter contract are both present.

Local fixture tests may enable consumer research without enabling any production adapter or external effect. A deterministic demand-surface fixture covers a realtor buyer/seller play across community, post/thread, event, and optional public-person results.

### 12.1 Implemented production-source contracts

The current implementation provides four consumer-opportunity source adapters.
Every adapter is separately gated, metered, bounded, evidence-bearing, and
manual-only. A credential alone never activates one.

| Source | Product use | Frozen contract | Required approval and price truth |
|---|---|---|---|
| Apify LinkedIn post search | Public LinkedIn posts with buyer, seller, or local-audience demand | `harvestapi/linkedin-post-search` build `0.0.104`; start, post, and no-result events; comments, reactions, and nested profile enrichment off | Exact actor/build rate version plus consumer-opportunity approval |
| Apify Reddit search | Public, non-sensitive Reddit threads; locked, archived, NSFW, quarantined, and sensitive results dropped | `clearpath/reddit-search-scraper` build `0.0.66`; actor-start, dataset-item, and result-scraped events | `GTM_APIFY_REDDIT_OPPORTUNITY_USE_APPROVED` plus exact rate version |
| Apify X post search | Public, recent X posts with bounded buyer, seller, mixed, or local intent | `scraper_one/x-posts-search` build `0.0.153`; initialization and result-item events | `GTM_APIFY_X_OPPORTUNITY_USE_APPROVED` plus exact rate version |
| DataForSEO organic Live Advanced | Public indexed communities, forums, events, discussions, creator pages, and other demand destinations | `/v3/serp/google/organic/live/advanced`; `$0.002` per ten organic results; depth at most 50; price-multiplying operators refused | `GTM_DATAFORSEO_CONSUMER_OPPORTUNITY_USE_APPROVED`, exact terms/retention, and exact organic price version |

Apify Google Maps and the governed business-source adapters remain available for
their existing business/company contracts. Direct Instagram, TikTok, Threads,
and creator-network adapters are not represented as implemented merely because
Origami lists those sources. The organic adapter may discover publicly indexed
destinations on those networks, but exact direct-source parity remains a
separate adapter-contract task requiring a frozen build, account-tier rate card,
customer-serving rights, bounded inputs, and authoritative settlement evidence.
No source adapter joins, follows, registers, posts, comments, sends a direct
message, or claims that opening a destination completed an action.

## 13. Acceptance tests

1. US B2B remains provider-runnable and automated-email eligible.
2. Safe US B2C is provider-runnable and manual-only.
3. Mixed/non-US is import-only/manual-only; unknown or sensitive/minor targeting is blocked.
4. A legacy descriptor cannot enter a consumer quote; an explicit test-only consumer descriptor can.
5. Plan hash changes when policy, terms, audience rights, or limits change.
6. Direct campaign create/approve/launch/send attempts for a B2C play fail before mutation/provider contact.
7. Consumer enrichment never requests email or phone.
8. Consumer opportunity and person views and manual drafts contain no email/phone field and require display/manual-use rights on every evidence source; consumer CSV export remains unavailable.
9. Manual draft replay returns one stored artifact and one metered model operation; no provider dispatch occurs.
10. Copy/open actions update only the manual draft and audit state.
11. Cross-tenant and malformed IDs are opaque; all queries bind organization and tenant.
12. Removal and retention delete consumer candidates, evidence, public contact points, and drafts.
13. Opportunity URL identity deduplicates repeated sightings while preserving separately observed evidence; an opportunity cannot enter any recipient or execution table.
14. The Hub responsive source contract requires stacked mobile cards, a desktop-only overflow-contained B2B table, no page-level horizontal scroll, and no consumer send/post affordance. Authenticated visual checks at 375, 768, 1024, and 1440 CSS pixels remain a release-gate check once the dark consumer fixture is deployed.
15. Versioned artifact-quality fixtures cover B2B, a realtor buyer-intent community, a realtor seller-intent conversation, a local event, optional public people, sensitive refusals, manual copy, evidence honesty, and failure honesty.
16. GTM has a named regression command and required CI job covering unit, integration-contract, MCP scoping/schema, fixture quality, Hub rendering/source-contract, and the unchanged B2B execution boundary.
17. MCP listing/detail/review tools enforce required features and organization plus tenant scope, paginate finitely, and expose no paid-provider or execution side effect.

## 14. Release and rollback

Deployment order is generated CRM migration, CRM application with the consumer research gate false, Noli application with manual-only UI inert until a consumer play is present, deterministic fixture/browser validation, exact production-source contract verification, counsel review of changed disclosures, then a bounded customer cohort. Rollback turns `GTM_CONSUMER_RESEARCH_ENABLED` false and rolls back the application version; the additive table and nullable columns may remain so removal, retention, and suppression obligations continue to work. B2B remains unchanged, and rollback never deletes prospect/draft rows or suppression obligations.

## 15. Changelog

- 2026-08-26: Initial additive B2B/B2C research and manual-consumer-outreach contract.
- 2026-08-26: Clarified the consumer product around demand surfaces, added the first-vertical realtor buyer/seller opportunity contract, made named people secondary, and added MCP and dedicated regression requirements after review of the saved Origami lead-magnet, data-source pricing, and realtor campaign experience.
- 2026-08-26: Implemented the additive policy, provider-rights contract, deterministic consumer adapter, named-person lifecycle, manual-draft route/data model, privacy/removal/retention handling, responsive Hub views, action-queue integration, and counsel-review disclosure drafts. Generated migration `Migration20260826221317` was rehearsed statement-for-statement against an isolated temporary PostgreSQL database with GTM prerequisites; the repository-wide empty-database migration chain remains blocked earlier by the documented unrelated auth baseline.
- 2026-08-26: Added exact, finalized-billing opportunity adapters for LinkedIn, Reddit, X, and DataForSEO organic search; separated public-opportunity rights from public-profile contact rights; added safe tenant-scoped GTM MCP tools; and made the named GTM regression gates required in CRM and Hub CI. Current local gates: CRM GTM 93 passing suites / 978 passing tests (one suite and seven tests intentionally skipped), Hub GTM regression 240/240, full Hub 1,441/1,441, marketing 29/29, and CRM, Hub, and marketing typechecks clean.
