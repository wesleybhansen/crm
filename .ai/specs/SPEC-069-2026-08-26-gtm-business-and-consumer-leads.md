# SPEC-069: GTM business leads and consumer demand opportunities

**Date:** 2026-08-26 PDT
**Status:** The additive B2B/B2C foundation, four governed consumer-opportunity adapters, MCP tools, customer release gate, and manual-only Hub surfaces are merged and deployed. Production remains unused for GTM consumer research (zero plays, research runs, candidates, and provider operations at the 2026-08-26 read-only audit). The quality-v2 closeout below is in implementation and remains a release gate for a paid consumer run.
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
| Apify X post search | Public, recent X posts with bounded buyer, seller, mixed, or local intent | `scraper_one/x-posts-search` build `0.0.153`; initialization and result-item events | `GTM_APIFY_X_OPPORTUNITY_ENABLED`, `GTM_APIFY_X_OPPORTUNITY_USE_APPROVED`, and exact rate version |
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

### 12.2 Quality-v2 retrieval and qualification closeout

Consumer-opportunity intent is evidence, not targeting metadata. An adapter may
use the frozen play and a source-specific query to retrieve candidates, but it
must classify `buyer_intent`, `seller_intent`, or `local_audience` only from the
returned row and retained evidence. The search query is recorded as targeting
provenance and may turn an otherwise ambiguous row into `unknown`; it can never
prove the row's intent. This applies uniformly to LinkedIn, Reddit, X,
DataForSEO, fixtures, imports, and future adapters.

The opportunity scorer advances additively to `fit-v7` and the frozen profile
to `qualification-profile-v4`. Earlier versions remain readable. `fit-v7`
evaluates the candidate against the exact play rather than awarding points for
field presence. Its criterion-level result covers:

- public and supported destination, access posture, and source evidence;
- play audience/topic fit with observed supporting terms;
- requested buyer, seller, or local-audience lane with evidence-only intent;
- play geography, with explicit contradiction, demonstrated match, or unknown;
- freshness and event timing relative to the run reference time;
- actionability and a venue-appropriate manual next action; and
- realtor false-positive exclusions, including property-listing inventory,
  agent recruiting, agent-to-agent lead sales, generic news, jobs, and unrelated
  promotional content.

Every criterion preserves expected values, observed evidence, and
`pass | fail | unknown | not_applicable`. Hard contradictions reject. Missing
proof remains explicit and cannot become a pass because a provider populated a
field. Acceptance requires demonstrated play relevance; an otherwise complete
but irrelevant opportunity cannot cross the threshold.

Retrieval uses a bounded, frozen set of source-specific query lanes instead of
silently selecting the first keyword. Buyer, seller, and local-audience work are
separate play lanes. Each adapter receives a small set of query variants suited
to its source syntax, with realtor exclusions where the provider supports them.
Every additional paid provider start or billable SERP is represented as a
separate quoted batch in the immutable plan, reservation, confirmation, plan
hash, receipt, and reconciliation. No adapter may fan out beyond the quote.

`opportunity-query-v18` keeps actor-native syntax explicit and separately quotes
three Reddit strategies: exact market/state community scope, broader
intent-community scope with the market embedded in the query, and one guarded
global Reddit search with no subreddit scope and actor auto-discovery disabled.
The global query must contain the requested market, is capped at ten rows, and
stays inside the frozen 30-day window. For buyer, seller, and mixed-intent
plays, the guarded global lane searches public comments so first-person demand
demonstrated while participating in an existing thread is not missed; the two
scoped lanes and local-audience global lane remain post searches. Post and
comment lanes are separately quoted because the actor's `both` mode can emit
twice the requested ceiling. Search scope and parent-post context never count
as intent or geography evidence; only the returned comment/post content can
prove the criterion. Exact-market lanes sort newest while broader intent and
global lanes retain relevance sort.
DataForSEO receives five separately quoted full market-and-state variants for
each buyer, seller, mixed, or local-audience play. Narrow queries target current
registrations, schedules, classes, public meetings, registries, and direct
consumer questions so broad stale pages do not compete with participation
surfaces inside one keyword. Supported realtor negative terms remain in every
organic lane. The organic normalizer consumes both ordinary organic rows and
the provider's structured
`discussions_and_forums`, `perspectives`, and direct-destination `events`
children. It preserves provider publication timestamps and discussion counts;
Google-hosted event-search redirects are not actionable destinations and are
discarded.

Rows are normalized before qualification. Canonical destination identity strips
tracking parameters and fragments, normalizes source aliases, and collapses
repeated conversations across query lanes while preserving separately observed
evidence. Ranking is deterministic and evidence-aware: criterion fit,
freshness, access, specificity, and independent engagement signals contribute;
adapter-name or fixed default confidence does not. A model reranker may be
introduced only as a separately metered, quoted operation with a frozen prompt,
schema, model, and evaluation gate; it is not implicit in this closeout.

Requested geography is frozen targeting provenance, not returned evidence.
LinkedIn, Reddit, X, and organic-search adapters may retain that request as
`provider_location`, but populate the opportunity's `location` and receive a
location confidence contribution only when the returned post, author context,
community name, title/snippet, or URL independently names the requested market.
`fit-v7-quality-v3` keeps targeting-only geography explicit as unknown, rejects
a demonstrated contradictory state, and never accepts it as a location pass.

Realtor demand is also narrower than the presence of buyer/seller vocabulary.
Buyer and seller lanes require housing context plus a returned consumer
question/need or a relevant educational event. Local-audience lanes require a
housing/homeowner context and an actual participation surface. Agent promotion,
generic buyer/seller listicles, marketplace sellers, listing inventory, and
unrelated moving language are false positives.

Production destination checks fail closed on malformed/non-HTTPS URLs,
non-public access markers, archived or locked conversations, expired events,
unsupported hosts, and observations outside the play's recency window. Network
liveness is verified only through the controlled benchmark's bounded checker;
runtime qualification does not introduce an unquoted fetch or a DNS
resolve/connect TOCTOU boundary.

### 12.3 Realtor benchmark and frozen fixtures

The release benchmark contains twelve frozen plays: buyer intent, seller intent,
and local-audience discovery in four US markets. A controlled, quoted run labels
roughly 100–200 returned opportunities using a versioned human-review sheet.
Sanitized provider results become immutable regression fixtures; raw provider
payloads, personal contact fields, secrets, and provider-only identifiers do not
enter the repository.

The benchmark release thresholds are:

- precision at 10 at least 80 percent;
- geography correctness at least 95 percent;
- buyer/seller intent correctness at least 90 percent;
- live and publicly accessible destinations at least 95 percent;
- canonical duplicate rate no more than 10 percent;
- useful enough to act on at least 70 percent; and
- sensitive targeting and unsupported claims exactly zero.

An automated fixture result cannot substitute for the human labels. A missed
threshold keeps paid consumer expansion off and records the failing market,
lane, source, and reject reason for another bounded iteration.

### 12.4 Production quality diagnostics

Tenant-scoped diagnostics aggregate only retained application metadata and safe
review labels. Per source and in total they report useful accepted
opportunities, cost per useful opportunity, dead/stale destination rate,
parser/drop rate, canonical duplicate rate, human accept/reject reasons, and
provider pricing/schema version drift. Windows are explicitly capped and report
truncation. The response excludes provider payloads, prompts, secrets, personal
contact data, and unrestricted free text. Existing provider-operation and
candidate/evidence rows are sufficient; quality-v2 adds no database migration.

An adapter can be contract-approved yet operationally held when observed cost
per useful opportunity is unacceptable. The X source therefore additionally
fails closed unless `GTM_APIFY_X_OPPORTUNITY_ENABLED=true`. Its customer-use
approval and frozen rate version remain separate rights and pricing facts; the
operational switch does not rewrite either. Production keeps X held after the
owner benchmark returned one rejected row at 738,750 internal credits, while
leaving its adapter and exact billing contract available for a later bounded
retest on an improved account tier or actor contract.

LinkedIn opportunity retrieval is independently operationally held unless
`GTM_APIFY_LINKEDIN_OPPORTUNITY_ENABLED=true`. The owner benchmark observed the
frozen Actor exceed its one-minute run limit after returning a charged post,
which made the run terminal but required operator reconciliation. Contract and
rate approval remain recorded, but a timed-out Actor is not placed into a new
customer quote until a bounded retest demonstrates terminal receipt behavior.

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
18. LinkedIn, Reddit, and X intent classification does not change when only the search query changes; returned evidence alone determines a demonstrated buyer/seller label.
19. `fit-v7` rejects a complete-looking but irrelevant result, preserves criterion-level unknowns, and accepts only a play-specific result with supported audience, geography, intent/lane, freshness, destination, and actionability.
20. Query-lane expansion is bounded and every added provider request is visible in the immutable quote, reservation, plan hash, receipt, and final reconciliation.
21. Canonicalization collapses tracking variants and repeated cross-query conversations without discarding separately observed evidence.
22. Adversarial artifact fixtures cover query leakage, wrong geography, stale/expired destinations, listing inventory, agent recruiting, generic news, inaccessible groups, duplicates, fixed-confidence inflation, and weak-but-plausible copy.
23. The twelve-play realtor benchmark meets every threshold in section 12.3 before paid customer consumer research is widened.
24. Tenant-scoped quality diagnostics expose every metric in section 12.4, finite windows, drift state, and no raw provider payload or personal data.
25. Signed-in Hub checks at 375, 768, 1024, and 1440 CSS pixels show no page-level horizontal overflow, clipped controls, consumer automation affordance, or touch target below 44 CSS pixels.
26. Counsel disposition is recorded specifically for the consumer provisions covering public communities/posts/events, optional public profiles, manual-only participation, no consent inference, sensitive/minor exclusions, 30-day draft retention, removal, and customer responsibility for platform/community rules; earlier GTM approval is not inferred to cover the August 26 delta.

## 14. Release and rollback

Quality-v2 adds no migration. Deployment order is CRM application with the consumer research gate false, deterministic and adversarial regression gates, Noli application, signed-in responsive validation, counsel disposition of the exact consumer-copy delta, then the quoted twelve-play owner benchmark. The gate may be enabled only for that bounded run; a missed benchmark threshold turns it off before any wider customer use. Rollback turns `GTM_CONSUMER_RESEARCH_ENABLED` false and rolls back the application versions; retained rows remain available for deletion/DSR. B2B remains unchanged, and rollback never deletes prospect/draft rows or suppression obligations.

## 15. Changelog

- 2026-08-26: Initial additive B2B/B2C research and manual-consumer-outreach contract.
- 2026-08-26: Clarified the consumer product around demand surfaces, added the first-vertical realtor buyer/seller opportunity contract, made named people secondary, and added MCP and dedicated regression requirements after review of the saved Origami lead-magnet, data-source pricing, and realtor campaign experience.
- 2026-08-26: Implemented the additive policy, provider-rights contract, deterministic consumer adapter, named-person lifecycle, manual-draft route/data model, privacy/removal/retention handling, responsive Hub views, action-queue integration, and counsel-review disclosure drafts. Generated migration `Migration20260826221317` was rehearsed statement-for-statement against an isolated temporary PostgreSQL database with GTM prerequisites; the repository-wide empty-database migration chain remains blocked earlier by the documented unrelated auth baseline.
- 2026-08-26: Added exact, finalized-billing opportunity adapters for LinkedIn, Reddit, X, and DataForSEO organic search; separated public-opportunity rights from public-profile contact rights; added safe tenant-scoped GTM MCP tools; and made the named GTM regression gates required in CRM and Hub CI. Current local gates: CRM GTM 93 passing suites / 978 passing tests (one suite and seven tests intentionally skipped), Hub GTM regression 240/240, full Hub 1,441/1,441, marketing 29/29, and CRM, Hub, and marketing typechecks clean.
- 2026-08-26: Recorded the production audit after the foundation release (four adapters and customer release enabled, zero GTM production rows) and specified the additive quality-v2 closeout: evidence-only intent, play-specific `fit-v7`, bounded source-query lanes, canonical deduplication, freshness/access checks, calibrated ranking, twelve-play realtor benchmark, adversarial fixtures, responsive breakpoints, exact counsel delta, and tenant-scoped production quality diagnostics.
- 2026-08-27: The first two bounded realtor benchmark passes exposed synthetic geography (requested markets copied into social and organic rows), broad seller-word false positives, generic agent content, and noisy actor auto-discovery. Added the `fit-v7-quality-v3` revision marker, evidence-proven locality, wrong-state rejection, realtor consumer-demand suitability, source-specific query-v3 syntax, precise Reddit search without actor-generated subreddit expansion, honest provider claims, explicit event-date parsing, and adversarial fixtures for targeting-only geography, marketplace sellers, and agent listicles. Existing paid runs can be requalified without another provider call because idempotency now includes the scorer revision as well as `fit-v7`.
- 2026-08-27: Added an independent fail-closed X opportunity operational switch after production quality diagnostics showed one rejected result at 738,750 internal credits. Contract approval and rate truth remain intact; X stays held until a labeled benchmark and current account tier demonstrate acceptable quality and cost per useful opportunity.
- 2026-08-27: Added `opportunity-query-v4` source-native realtor queries and expanded DataForSEO normalization to retain structured discussion, perspective, and direct event destinations with their provider publication timestamps and discussion counts. Google event-search redirects remain excluded because they do not provide a stable destination for a manual customer action.
- 2026-08-27: The first query-v4 production pilot exposed a real-estate advertising case study as a false seller accept and a lane mismatch for useful sell-then-buy questions. Added `fit-v7-quality-v5`: marketing case studies and lead-generation performance content are hard realtor false positives; generic first-person prose no longer proves a consumer need; and demonstrated mixed buyer/seller language may satisfy the corresponding frozen buyer or seller lane without weakening locality, freshness, access, or noise gates.
- 2026-08-27: Requalification of the same paid pilot removed the advertising case study but exposed a completed-listing promotion as the remaining false accept. Added `fit-v7-quality-v6` and a sanitized live regression so completed `listed and sold` transaction promotions cannot qualify as current consumer seller demand.
- 2026-08-27: Human review of all 24 query-v4 accepted rows found that professional Q&A, listing inventory, client-success posts, realtor networking, generic advice, and a renter rejecting solicitation could still resemble demand. Added `fit-v7-quality-v7`: a question mark or possessive home reference is no longer evidence of consumer intent; buyer/seller events must be actual event destinations; local discovery requires a public participation venue or demonstrated consumer participation; and five sanitized live failure classes now remain in the artifact-quality regression suite.
- 2026-08-27: Zero-spend requalification reduced the same 226 query-v4 candidates to four accepts and exposed two final semantic errors: city-ranking lifestyle promotion could imitate a direct buyer question, and a bereavement-driven household-content liquidation request could imitate a home seller. Added `fit-v7-quality-v8`: buyer/seller terms are housing-bound, individual posts require demonstrated first-person demand, local discovery enforces its own intent lane, vulnerable personal-crisis content is excluded, and both sanitized failure classes remain in the artifact-quality regression suite.
- 2026-08-27: The query-v6 Austin benchmark exposed an identically named city leak (`Austin, MN` treated as Austin, Texas) and an honesty issue where requested provider targeting appeared beside observed geography. Added `fit-v7-quality-v9`: state names and postal abbreviations now reject demonstrated wrong-state results before locality credit, and criterion evidence reports only result-grounded locations while retaining requested geography solely as targeting provenance.
- 2026-08-27: The complete query-v6 four-market benchmark produced only 86 top-ten rows and left nine of twelve plays below the ten-row labeling floor. Provider receipts showed that exact-market Reddit scopes were frequently sparse or nonexistent while broad organic searches returned stale and promotional pages. Added `opportunity-query-v7`: three separately quoted Reddit scope strategies, bounded actor-native relevance discovery, state-qualified organic anchors, source-domain-specific buyer/seller/local queries, and stronger realtor promotional exclusions. Discovery scope remains targeting provenance and cannot prove locality or intent.
- 2026-08-27: The query-v7 recall pass exposed a planner/adapter contract defect: source-domain `site:` operators were frozen into organic queries even though the priced DataForSEO adapter correctly rejects operators that can multiply the base charge. Added `opportunity-query-v8`, which expresses the same Reddit, Facebook-group, Eventbrite, Meetup, and Nextdoor discovery intent with ordinary price-safe terms, plus a shared regression assertion that every planned organic realtor lane is accepted by the adapter's frozen-price operator contract.
- 2026-08-27: The query-v8 seller recall pass showed that long exact-phrase searches still produced fewer than ten unique rows and that DataForSEO task `40102` (No Search Results) and other definitive application errors carried a nonzero final task cost despite being treated as refunds. Added `opportunity-query-v9`: shorter seller-discovery queries with the required listing/recruiting/news exclusions, plus exact settlement from every explicit final DataForSEO task cost. `40102` is a charged `no_result`; other definitive errors remain failures but are charged when the provider receipt reports a nonzero cost. Missing or over-reservation billing remains ambiguous and fail-closed.
- 2026-08-27: The completed 120-row query-v6-through-v9 labeling pool met the twelve-play coverage floor but pre-label semantic review found stale 2004/2010/2013 pages, an inactive `No upcoming events` calendar, listing/rental/job noise, and unrelated association mentions retaining high numeric scores. Added `fit-v7-quality-v10`: content-derived relative and leading publication dates, content-derived event dates, explicit inactive-destination rejection, narrower local-participation proof, additional realtor noise exclusions, stronger deterministic reranking penalties, and verdict-aware score ceilings so rejected or unresolved rows cannot outrank accepted evidence. No provider call is required to requalify the frozen pool against this revision; human labels and every section 12.3 threshold remain release gates.
- 2026-08-27: Zero-spend quality-v10 requalification cleanly separated accepted, unresolved, and rejected rows but showed that broad query-v9 pages still left most top-ten slots irrelevant or stale. Added `opportunity-query-v10` with five separately billed organic lanes per realtor play focused on current registration, schedule, class, meeting, registry, and public-question surfaces; newest-first exact-market and auto-discovery Reddit lanes; and `fit-v7-quality-v11` date/liveness hardening for labeled numeric dates, leading month-year snippets, numeric event dates, and additional inactive-destination language. Explicit provider publication timestamps remain authoritative so a current post is not rejected merely for discussing older history.
- 2026-08-27: The frozen 120-row benchmark exposed residual high-scoring provider directories, event-search indexes, rental disputes, promotional testimonials, and one repeated conversation. `fit-v7-quality-v12` removes relocation alone as proof of buyer intent, hard-filters those demonstrated false-positive classes, and deduplicates strongly overlapping conversations across separately quoted source batches while preserving short or merely topical results as distinct. `opportunity-query-v11` removes renter-heavy relocation terms from buyer retrieval and replaces directory/index discovery with direct public-meeting, education, event, and question surfaces. Automated URL checks remain machine observations; human benchmark labels stay blank until a human reviewer completes them.
- 2026-08-27: The first query-v10 local-audience run proved two distinct billing outcomes. Finalized billed rows that fail safe opportunity normalization now settle as charged provider errors with zero retained candidates instead of creating false reconciliation work. Unknown billing still parks. The LinkedIn opportunity Actor separately exceeded its frozen one-minute run limit after billing a post, so LinkedIn now has an independent fail-closed operational switch while its rights and exact price contract remain intact.
- 2026-08-28: The final query-v13 benchmark exposed a separation-of-responsibility defect: safe public rows were being dropped inside source adapters for play mismatch, missing locality, or freshness before `fit-v7` could produce criterion-level rejections or a labelable benchmark pool. `opportunity-query-v14` broadens the five price-safe organic lanes without weakening returned-evidence requirements. Safe, non-sensitive, canonical public opportunities now reach qualification; fit-v7 remains the sole play-fit, locality, freshness, access, and actionability gate. Provider receipts separately record raw, returned, and parser-dropped counts so recall and parser loss remain observable.
- 2026-08-28: The capped query-v14 Austin feasibility sample proved that fit-v7 rejected all 53 irrelevant or inaccessible rows, but actor auto-discovery returned broad Reddit noise and generic public neighborhood-association websites were conflated with membership-gated social groups. `opportunity-query-v15` uses actor-supported Boolean phrases, fixed market and intent subreddit scopes, and no auto-discovery. Generic HTTPS association and club destinations are publicly viewable while Facebook, LinkedIn, and Nextdoor groups remain approval-required; participation is still manual and subject to the destination's current rules.
- 2026-08-28: The query-v15 feasibility sample reconciled cleanly and surfaced useful public Austin neighborhood associations, but evidence review found a cash-buyer promotion disguised as a seller question and a Chicago subreddit snippet borrowing an Austin comparison. `fit-v7-quality-v16` rejects those exact classes. `opportunity-query-v16` keeps fixed subreddit scopes while removing overly restrictive advice/help conjunctions that left two of three Reddit lanes empty.
- 2026-08-28: Zero-cost requalification exposed that the source provider truncated the cash-buyer title before its commission-avoidance suffix. `fit-v7-quality-v17` therefore treats the demonstrated second-person solicitation form (`looking to sell your home/house/property`) as promotional by itself while preserving genuine first-person consumer statements.
- 2026-08-28: The query-v16 Austin feasibility pass reconciled cleanly but returned only two Reddit rows across nine fixed-scope searches, with seller and local-audience Reddit lanes empty. `opportunity-query-v17` replaces the third fixed-scope lane with the actor's documented empty-scope global search while keeping subreddit auto-discovery off. The adapter refuses that lane before a paid call unless the query contains the requested market, the result cap is ten or fewer, and the recency window is no broader than 30 days. Returned evidence still independently proves geography, intent, freshness, access, and actionability through fit-v7.
- 2026-08-28: Review of the frozen query-v17 evidence found a current Austin buyer negotiation thread whose offer, counteroffer, appraisal, closing-cost question, public destination, geography, and freshness all passed, but the consumer-demand primitive did not recognize an in-progress transaction. `fit-v7-quality-v18` adds narrow first-person offer/transaction evidence and the demonstrated “what should my next move” form. It also recognizes home-buyer fairs and explicit community-conversation participation without turning static association pages, stale events, listings, or professional promotion into demand.
- 2026-08-28: The guarded query-v17 global Reddit post lane returned zero rows for all three Austin plays, while the actor's current first-party contract explicitly supports separately metered public comment search. `opportunity-query-v18` changes only the buyer, seller, and mixed-intent global lane to comments, preserves the two fixed post scopes and local-audience post discovery, caps each lane inside the immutable quote, and normalizes observed comment permalinks, timestamps, parent-post identifiers, activity, and public authors without treating the query or parent title as proof of intent.
- 2026-08-28: `realtor-opportunity-benchmark-v2` adds a strict independent-human import boundary. Review decisions must bind the frozen play, rank, and destination hash, attest `independent_human` / `HUMAN_REVIEWED`, include reasons for every negative or unsafe judgment, and cannot overwrite system evidence or disposition. The importer records reviewer names, review times, the frozen-source digest, and a deterministic decision digest. Partial batches remain HOLD under the existing 12-play, 100–200-row coverage gate.
- 2026-08-28: Customer-serving consumer research now requires three independent deployment controls: `GTM_CONSUMER_RESEARCH_ENABLED=true`, the exact August 26 counsel disposition in `GTM_CONSUMER_LEGAL_APPROVAL_VERSION=gtm-b2c-legal-2026-08-26-v1`, and a passing independently reviewed benchmark recorded as `GTM_CONSUMER_QUALITY_APPROVAL_VERSION=realtor-opportunity-benchmark-v2`. Missing, generic, or stale values fail closed before quote, run creation, or provider execution. These controls do not enable consumer automation; consumer participation and outreach remain manual-only.
