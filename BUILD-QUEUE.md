# CRM Build Queue

Comprehensive prioritized queue. Updated 2026-04-23.

---

## TOP PRIORITY

### B. Stripe Connect — Verification + Live Integration
Finish provisioning Stripe Connect so end users can actually accept payments. This is a two-step unlock — Stripe account verification (external, Wesley) and then one-time platform config on the server.

**Step 1 — Verify the Stripe platform account**
- Stripe requires the platform itself (The Launch Pad LLC) to be identity-verified before Connect OAuth can be enabled for other users. Submit business details, EIN, address, bank account, and any requested docs in the Stripe dashboard.
- Wait for Stripe to approve. Typical turnaround: a few hours to a few days.

**Step 2 — Enable OAuth for Standard accounts**
- In https://dashboard.stripe.com/settings/connect, set integration type to **Standard** (OAuth flow requires Standard — not Express or Custom).
- Go to the OAuth subsection (https://dashboard.stripe.com/settings/connect/onboarding-options/oauth) and toggle OAuth **on**.
- Add redirect URI exactly: `https://crm.thelaunchpadincubator.com/api/stripe/connect-oauth/callback`
- Copy the **Live mode** `ca_xxx` client ID (and optionally the Test mode one for staging).

**Step 3 — Platform env config on the server**
- SSH into the Hetzner box (`ssh root@5.78.71.144`).
- Edit `/root/open-mercato/.env.production` and add `STRIPE_CONNECT_CLIENT_ID=ca_xxx` (use live ID for prod).
- Also set live-mode `STRIPE_SECRET_KEY=sk_live_...` and `STRIPE_WEBHOOK_SECRET=whsec_...` in the same file (these replace the current sandbox values — see #23b).
- Restart: `docker compose -f /root/open-mercato/docker-compose.prod.yml up -d --no-deps app`

**Step 4 — Verify end-to-end**
- As a CRM user, click "Connect Stripe" on the payments settings page.
- Expect redirect to `connect.stripe.com/oauth/authorize?...` (no 500, no "not configured" error).
- Complete the connected-account OAuth flow, get redirected back to `/api/stripe/connect-oauth/callback`, confirm `acct_xxx` saved against your org in DB.
- Create a test invoice, pay with a real card (can refund $1 test charge right after), verify payment success webhook and the new `payments.payment.received` bell notification (see Recently Completed — notification center wiring).

**Why this matters:** Every other money-making feature (invoices, checkout, subscriptions, funnel payments, course payments) is dead-on-arrival until Connect OAuth works. Payment received/failed notifications were already wired in the 2026-04-23 notification pass and are waiting for real Stripe events to fire.

### A. Smarter Landing Pages
Upgrade the landing page system to be more intelligent and produce higher-converting pages:
- AI analyzes the user's business, audience, and offer to generate truly custom copy (not template-fill)
- Competitor analysis — AI researches competitor landing pages and incorporates winning patterns
- Conversion optimization suggestions — AI reviews draft pages and suggests improvements
- A/B testing built in — create variants, split traffic, auto-select winner
- Dynamic personalization — pages adapt based on visitor data (UTM source, location, returning vs new)
- More page types: case study pages, comparison pages, webinar registration, application/waitlist pages
- Better mobile rendering and faster page load times
- Analytics dashboard per page: traffic sources, scroll depth, form abandonment, time on page

---

## ~~Bugs~~ ✅ All Fixed

1. ~~Stripe payment success page~~ — Branded confirmation with amount, invoice number, business name
2. ~~Reminder notifications~~ — Fixed email lookup + only marks sent when delivery succeeds
3. ~~Dashboard "Follow up" button~~ — Now pre-fills contact name in email compose

---

## Build Queue

### 5. Brand Voice Engine
Analyze 20-30 of the user's sent Gmail emails → build a writing style profile → apply to all AI-generated content. "Learn my writing style" in onboarding + settings.

### 10. Revised Onboarding Wizard
AI-powered conversational setup: business info + website scan → pipeline mode + stages → connect accounts → voice learning → review → action plan.

### 11. Smart Digest / Weekly AI Review
Automated weekly business review: revenue trends, new leads, cold contacts, best emails, 3 action items. Written in persona style, sent via connected email.

### 13. Meeting Prep Brief
Check upcoming calendar events, match attendees to CRM contacts, generate brief: contact summary, interactions, deal status, talking points.

### 14. Relationship Decay Alerts
Analyze communication frequency per contact, flag gaps. Dashboard section with AI-drafted check-ins. Yellow (1.5x gap) and red (2x+ gap) severity.

### 15. Chat Widget Enhancements
- Typing indicators and read receipts
- File sharing in chat
- Conversation search
- Auto-close after inactivity
- Agent assignment/routing

### 16. Affiliate Enhancements
- Auto-conversion tracking tied to deals/invoices
- Automatic Stripe payouts
- Affiliate tiers/levels
- Refund tracking and commission clawback
- Email notifications to affiliates

### 17. Calendar Enhancements
- Availability configuration UI
- Booking management (edit/cancel/reschedule from CRM)
- Timezone support
- Calendar task integration (tasks shown alongside bookings)
- Confirmation email templates

### 18. Payments Enhancements
- Payment links management (table exists, no UI)
- Tax calculation (currently hardcoded to 0)
- Multi-currency support
- Subscription management dashboard (active subs, renewal dates)
- Payment status sync fallback (if webhook fails)

### 19. Mobile Responsive CSS Pass
Touch-friendly tap targets, stacked layouts on mobile. PWA manifest for "Add to Home Screen." Test across all major pages.

### 20. AI Voice Assistant (Scout V2)
Expand the Scout AI assistant into a full voice-to-voice CRM control system. Users can manage their entire CRM through voice or text chat — add contacts, send messages, check reports, create deals, manage pipeline, send emails, create landing pages, check analytics, etc. The AI assistant does real work, not just answers questions.

**Key capabilities:**
- Voice-to-voice chat (browser SpeechRecognition API for input, Web Speech API / TTS for output)
- Text chat (existing Scout, upgraded with full action execution)
- Full CRM action execution: create/update/delete contacts, deals, tasks, notes, tags
- Send emails, create landing pages, manage funnels, check reports
- Natural language queries: "What deals are closing this week?", "Show me my hottest leads"
- Confirmation step before executing destructive/important actions
- Context-aware: knows what page the user is on, who they're looking at
- Streams responses word-by-word for natural conversation feel

### 23. End-to-End Testing
Full flow: signup → onboarding → connect Gmail → send email → landing page → form → contact → Stripe → payment → sequence → verify.

### 23b. Post-Deploy Verification ✅ PARTIALLY DONE
After Hetzner deploy is live, verify these work in production:
- ✅ **SSL**: HTTPS live at https://crm.thelaunchpadincubator.com
- ✅ **Cron jobs**: Crontab set — reminders (1 min), sequences (5 min), email sync (30 min), automations (10 min)
- ✅ **Stripe webhook**: Endpoint configured (sandbox mode)
- ⬜ **Stripe live payments**: Switch from sandbox to live keys in Stripe dashboard. Update `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` on server. Create a test invoice/funnel and process a real $1 payment. Verify success page, webhook delivery, and payment record.
- ⬜ **Gmail OAuth**: Reconnect Gmail with production redirect URI (`https://crm.thelaunchpadincubator.com/api/google/callback`). Move Google Cloud project from Testing → Production so tokens don't expire after 7 days.
- ⬜ **Email delivery**: Send test email via Scout. Verify Gmail sends (not just Resend fallback). Verify sender name shows correctly.
- ⬜ **Brand Voice Engine**: Run voice analysis from Gmail. Verify profile saves. Send an AI draft and confirm it matches the voice.
- ⬜ **Voice Assistant**: Connect via voice. Test create contact, send email, create event, set reminder.
- ⬜ **Landing pages**: Create and publish a page. Verify public URL works on production domain.
- ⬜ **Booking pages**: Create a booking page. Verify public booking link works.
- **Landing pages**: Create and publish a page. Verify public URL works on production domain.
- **Booking pages**: Create a booking page. Verify public booking link works.
- **SSL/Domain**: Verify HTTPS works, no mixed content warnings.

### 24. CRM Migration Assistant
Import wizard: CSV/Excel with AI column mapping, Google Sheets, HubSpot/GHL/Salesforce API import. Dedup, pipeline mapping, notes/activities. Progress + undo.

### 26. Google OAuth Verification
Submit for production verification. Privacy policy + terms pages. Security assessment if sensitive scopes. 100 test users while pending.

### 27. Custom Domain Landing Pages
Users publish on their own domain. CNAME/DNS setup, domain verification, SSL via Let's Encrypt/Cloudflare.

### 28. Data Enrichment
Extract business data from email signatures (company, title, phone, LinkedIn). Later: paid enrichment API (Clearbit, Hunter.io, Apollo).

### 29. Automatic Pipeline Stage Advancement ✅ Phase 1 shipped 2026-04-25
Auto-move contacts through stages based on events: sequence completion → advance, form submission → set stage, engagement threshold → advance, payment → move to Customer. **See SPEC-064.** Integration tests deferred to Phase 1.5; deal-target seeded defaults deferred (users add deal rules via UI once they pick pipeline+stage).

### 36. Meeting Notes Upload to Knowledge Base
Allow users to upload meeting notes (text, transcripts, recordings, audio files) into the CRM knowledge base where Scout and other AI features can use them as context. Same upload + indexing pipeline as the existing knowledge base, scoped per contact, deal, or organization-wide.

**Capabilities:**
- Upload meeting notes via file (.txt, .md, .docx, .pdf), paste, or audio (auto-transcribe)
- Optional auto-transcribe for audio uploads via Whisper or equivalent
- Attach to a specific contact, deal, or company — surfaces in their timeline
- AI-extract: action items, decisions, follow-up dates, mentioned people, sentiment
- Auto-create follow-up tasks from extracted action items
- Searchable in Scout: "What did Maria say about the proposal in our last meeting?"
- Show meeting notes in Scout's context when answering questions about the related contact/deal
- Upload from CRM UI, email forward (`notes@in.thelaunchpadincubator.com`), or via API

**Why:** Meetings are where the actual decisions happen, but the knowledge stays trapped in the user's head or scattered across Notion/Notes/Otter. If the AI can read meeting notes, it can answer "what did we decide" / "what did I commit to" / "what's the next step" without the user having to dig through anything. Same pattern as the knowledge base, just scoped to meetings.

---

## Realtor Vertical

### 30. Realtor Package — Phase 1 (templates + config)
- Pre-built buyer/seller/rental pipeline templates (10 stages each with commission-based deal values)
- Real estate contact tags: Zillow, Open House, Sign Call, Referral, FSBO, Expired Listing, Farming
- Contact roles: Buyer, Seller, Investor, Past Client, SOI, Vendor
- 7+ pre-built email/SMS sequences: Speed-to-Lead, New Buyer (14 touches), Seller (7 touches), Open House Follow-Up, Past Client Anniversary, Expired Listing, FSBO
- Open House mode on Events: tablet sign-in form, QR code, auto-capture to CRM, auto-trigger follow-up within 1 hour
- Real estate landing page templates: Home Valuation, First-Time Buyer Guide, Neighborhood Guide, Coming Soon, Just Listed
- Real estate automation recipes: speed-to-lead (auto-text < 1 min), post-showing feedback, anniversary drip
- Property entity (basic): address, price, status, beds/baths/sqft, type, photos, linked to contacts/deals
- Buyer/seller questionnaire survey templates + post-closing review request

### 31. Realtor Package — Phase 2 (tool consolidation, replaces $80-180/mo)
- Transaction management: document checklists by type, key date tracker with countdown alerts (inspection, appraisal, closing), task templates per transaction type, status dashboard with red/yellow/green indicators
- Commission tracking: sale price x rate - splits - fees = net, configurable split types, annual GCI dashboard, expense tracking per deal, tax estimation
- Showing management: scheduling, route optimization, post-showing feedback capture, showing activity reports for sellers
- Referral tracking: agent-to-agent (25-35% fee), client referrals, vendor/partner exchange, agreement templates

### 32. Realtor Package — Phase 3 (premium differentiators)
- MLS/IDX data integration → **see #37 for full spec**
- Neighborhood market data + market snapshot email generator
- CMA builder (manual comps → branded PDF report, shareable link) → **see #39 for full spec**
- AI lead qualification bot (auto-text, qualifying questions, score/categorize)
- Property alert system for buyers (new listing matches criteria → auto-notify)
- "Farm area" management with market share tracking

---

## Realtor Vertical — ReChat Parity (added 2026-04-25)

These items close the gap with ReChat (the dominant brokerage-tier RE platform) so the solo-agent RE variant lands as a credible alternative. Sourced from `~/Desktop/ReChat_vs_Your_Stack_Analysis.docx` (Apr 24, 2026) and `~/Desktop/Rechat_Competitive_Analysis.docx` (Apr 1, 2026). Build order roughly follows Section 5 of the analysis: MLS first (blocks everything else), then quick wins (seller reports), then differentiators (Agent Network, CMA), then proactive AI, then mobile/integrations.

Strategic frame: ReChat won't sell to solo agents (15-seat minimum). We win the segment they refuse, with three demo proof points: **Agent Network done better** (#38), **gorgeous CMAs** (#39, attacking ReChat's acknowledged weakness), and **proactive AI** (#44). Suite integration is the moat — these features must feel like one product, not bundled.

### 37. MLS/IDX Integration (RESO Web API)

**Why:** Blocking dependency for #38–#46. Without MLS data, none of the RE-specific marketing, CMAs, agent-network, or property-site features can exist. ReChat's #1 unstated advantage is that brokerages set up MLS once and every agent benefits.

**Scope:**
- Use **RESO Web API** (modern OData-based standard) as primary; RETS legacy fallback only when MLS doesn't support RESO.
- Per-tenant MLS credentials (each agent sets up their MLS or inherits brokerage creds). Store encrypted in `mls_credentials` (org-scoped).
- Resync cadence: 5-minute polling for new/updated listings (matches ReChat); per-listing webhook if MLS supports it.
- Data model (new `realtor` module under `packages/core/src/modules/`): `mls_listings` (RESO standard fields: ListingKey, ListPrice, BedroomsTotal, BathroomsTotalInteger, LivingArea, PropertyType, StandardStatus, ListAgentMlsId, etc.), `mls_listing_photos`, `mls_listing_history` (price changes, status changes), `mls_offices`, `mls_agents`.
- Coming-Soon support: ingest CS status when MLS provides it; manual entry path for off-MLS pre-market listings.
- Saved searches: agent defines criteria (geo, price, beds, etc.); engine matches new/updated listings against saved searches and emits events.
- Events to emit (used by #38, #41, #43, #44): `realtor.listing.created`, `realtor.listing.updated`, `realtor.listing.status_changed`, `realtor.listing.price_changed`, `realtor.listing.photos_changed`, `realtor.saved_search.matched`.
- Error handling: rate-limit per MLS, exponential backoff, staleness alerts ("MLS sync failed for 1h — check creds"), notification-bell entry.
- Field mapping config per MLS (RESO is "standard" but every MLS has quirks). Admin UI under settings → Real Estate.

**Dependencies:** none (foundational). Use existing `packages/core` module patterns (`data/entities.ts`, `subscribers/`, `workers/`). Re-use `@open-mercato/queue` for sync workers, `@open-mercato/cache` for listing reads.

**Differentiator vs ReChat:** ReChat is brokerage-managed; ours is agent-managed (or brokerage-managed if shared). Self-serve onboarding flow ("Connect your MLS in 5 min") is the wedge.

### 38. Agent Network / Reverse Prospecting

**Why:** ReChat's single most-loved feature ("$10M deal attributed to it" in their materials, "cool since sliced bread" in demo notes). Brokerages choose ReChat *because* of this. It's their #1 moat — but it's data-mostly + UI, fully buildable on top of #37.

**Scope:**
- "Find buyer agents who recently transacted near my listing" workflow:
  - Input: a listing (your own MLS listing or any address)
  - Filters: radius slider 0.5–20mi, transaction side (buyer / seller / both), volume tier (1–5 sales / 6–15 / 16+ in window), time window (3 / 6 / 12 / 18 months), price band ±%
  - Source data: `mls_listings` where `StandardStatus IN ('Closed', 'Pending')` joined with `ListAgentMlsId` and `BuyerAgentMlsId`
- Result list: agent name, brokerage, email, phone, recent transaction count + volume, last transaction date, side mix
- Bulk-select → blast branded email via AMS:
  - Pre-formatted templates: Coming Soon, Just Listed, Open House, Price Reduced, Price Improvement, Just Sold (auto-pull listing photos/data via #46 token system)
  - Track per-recipient opens, clicks, replies
- Bulk-select → export to CRM contacts (with `Source: Agent Network — {listing address}` tag and dedup via existing source-tagging pipeline)
- "Saved networks": persist a filter set, re-run on new listings

**Beat ReChat:**
1. **SMS in addition to email** (most agents respond to text faster). Use #48 Twilio integration.
2. **Predictive matching**: rank agents by likelihood of bringing a buyer for *this* listing — features: recent buyer-side count in same price band/property type/neighborhood, response history if they're already in your CRM. Score 0–100, sort by default. Use existing AI infra (Scout / business-rules).
3. **AI-personalized outreach**: instead of identical blast, generate per-recipient subject + opening line referencing their recent transactions ("Saw you closed 4 condos in Brickell this quarter — got one priced for your buyers"). Brand Voice Engine (#5) keeps it on-brand.
4. **Reply tracking + auto-CRM**: when an agent replies, auto-create a deal in "Co-op opportunity" stage and notify via bell.

**Dependencies:** #37 (MLS), #46 (marketing token system), optionally #48 (SMS), #5 (voice engine for personalization).

### 39. CMA Builder v2 (premium, fully customizable)

**Why:** Section 3 of the analysis: "ReChat's weakest area, biggest opening." ReChat publicly admits one template, no custom templates, no full-page listing pages. Luxury agents need beautiful presentations and will switch platforms for them. This is the single best demo weapon we can build.

**Scope:**
- Auto-pull comparable sales from MLS based on subject property: same school/zip/neighborhood, similar beds/baths/sqft (configurable tolerance), sold within last 6 months. Manual add/remove/replace.
- Per-comp **adjustments**: $/sqft delta, lot size delta, condition delta, view, parking, beds/baths delta, time-of-sale (market drift). Per-feature dollar adjustments (configurable defaults + override per comp). Show adjusted price prominently.
- **Custom templates** (the killer feature): drag-drop layout editor with sections — cover, agent bio, market overview, subject details, comp grid, comp detail (full-page), pricing strategy, marketing plan, testimonials, signature page. Save / share templates within team.
- **Full-page individual listing pages** for hero comps (ReChat doesn't have this).
- Output formats: branded **interactive web** version (clickable, image galleries, embedded maps, scroll analytics) + **print-quality PDF** (vector, exportable to InDesign).
- Shareable link with view tracking (timeon-page, scroll depth, which comps got the most attention) — feeds back into Seller Activity Report (#40).
- Reuse AMS template engine + custom entities (already supports the layout/data/print pattern). New `cma` entity scoped to deal/listing.

**Dependencies:** #37 (MLS for comps), AMS template engine (already shipped). Optional: Brand Voice Engine (#5) for AI-drafted narrative copy.

### 40. Seller Activity Report

**Why:** Section 5 calls this "cheap, high-perceived-value." ReChat is *just* launching this in 2026 — we can ship it before they finish polishing. Sellers constantly ask "what have you done for my listing?" — automating the answer is a renewal/referral driver.

**Scope:**
- Per-listing aggregator that compiles all marketing activity:
  - Email sends (subject, recipients, opens, clicks) — from `email` module
  - Social posts (platform, post URL, reach if available) — from social module
  - Landing-page views + form submissions — from `landing_pages`
  - Open houses held + visitor counts — from #43 / `events`
  - Showings + agent feedback — from `bookings` / showing module
  - Calls + texts to inquiries — from #48
  - CMA views + Agent Network outreach (#38, #39)
- Time-range filter (week / month / since-listing).
- Output: branded one-page dashboard URL (shareable to seller) + downloadable PDF.
- Auto-send weekly/biweekly via email to seller (config per listing).
- "What's next this week" section: scheduled emails, upcoming open houses, planned price reduction (if set).
- Lives under deal/listing detail page; one-click "Send to seller" button.

**Dependencies:** #37 (so we know which CRM activity belongs to which listing). Reads existing event log + module data — mostly aggregation work, no new event capture needed.

### 41. Property Website Auto-Generator

**Why:** Section 5 step 6: "Easy once MLS exists plus AMS landing-page builder." ReChat does this via Lucy. Match-then-beat by personalizing copy in the agent's voice.

**Scope:**
- New listing in MLS → background worker generates a single-property landing page within 5 min.
- Pulls: photos (gallery + hero), description, features grid, video tour, virtual tour link, neighborhood data, school ratings, walk score (via free APIs), map.
- Branded with agent (logo, colors, headshot, contact info).
- AI-rewrites stale MLS description in agent's voice (#5 Brand Voice Engine) — keeps factual claims, improves prose.
- Lead capture: schedule-showing CTA (creates booking + CRM contact), "request info" form, mortgage calculator.
- Source-tagged leads (`Source: Property site — {address}`) routed to listing agent.
- Custom subdomain or path: `agent.com/123-main-st` (pairs with #27 Custom Domain Landing Pages).
- Auto-update when MLS data changes (price reduction → page refreshes + optional "Price Improvement" social post).
- Analytics: views, time-on-page, photo gallery engagement, lead conversions — fed into #40.

**Dependencies:** #37 (MLS), #5 (Brand Voice), AMS landing-page wizard v2 (TOP PRIORITY item A "Smarter Landing Pages"), optionally #27 (Custom Domain).

### 42. Buyer Tour Sheets (polished)

**Why:** ReChat's tour sheet is buggy ("being finicky" in demo, basic info only). A polished version is a daily-use feature for buyer agents. Section 2 calls it medium-effort, high-differentiation.

**Scope:**
- Create tour: select buyer contact(s), add agent participants (co-listing, showing agent), drag-drop list of properties.
- Search MLS to add properties (#37); also accept manual address entry for off-market.
- Map view with optimized driving route + estimated drive times between stops.
- Public client-facing tour page via magic-link auth (reuse the same pattern just fixed in `apps/mercato/src/modules/courses/api/student/verify`):
  - One-tap secure access from text/email
  - Per-property: full MLS detail (all photos, description, features, virtual tour, map)
  - Client adds: 👍/👎/❤️ react, free-text notes, photos they snap during showing
  - All client input syncs to CRM contact + appears in agent's view in real time
- Agent **private notes** per property (lockbox code, gate code, owner present, alarm, pet warning, listing agent's tip) — never shown to client.
- Reorder stops via drag (route auto-recalculates).
- Send tour: SMS (#48) + email link to client; ICS calendar invite.
- Mobile-optimized — agents drive between showings; one-thumb operation.
- Post-tour: AI summary of client reactions ("client liked the open kitchen and natural light, disliked busy street") saved to contact via #47 note-taker.

**Dependencies:** #37 (MLS), magic-link auth pattern (already in courses module — copy/adapt), #48 (SMS), #47 (post-tour summary).

### 43. Open House Auto-Detection + Marketing Pack

**Why:** Section 2 lists this as low-effort once MLS + AMS wired. ReChat auto-detects from MLS and creates marketing pack — table-stakes parity. Building blocks for the speed-to-lead automation in #30.

**Scope:**
- Background worker scans `mls_listings.OpenHouseStartTime` daily; auto-creates open-house event in agent's calendar (`events` module).
- For each detected open house, auto-generate a marketing pack:
  - Email blast template populated with listing details
  - Instagram post + Facebook post (image + caption)
  - Postcard PDF (mailable to farm area)
  - Sign rider design (printable)
  - Branded sign-in form (paper) + iPad/QR digital sign-in URL
- Daily 7am email digest: "Open houses this weekend — marketing packs ready" with one-click "Send all" / "Customize first" buttons.
- iPad sign-in mode (full-screen):
  - Visitor enters name/email/phone
  - Auto-creates CRM contact tagged `Source: Open House — {address}`, `Open House` tag
  - Triggers Speed-to-Lead sequence (already in #30): auto-text within 1 minute
- Post-open-house: automated visitor-count + leads-captured report appended to listing's #40 Seller Activity Report.

**Dependencies:** #37 (MLS), #30 (Open House mode is the precursor — this is the auto-detection + marketing-pack upgrade), #46 (marketing tokens), `events`/`bookings` modules.

### 44. Proactive RE AI Agent (overnight prep)

**Why:** Section 4 of the analysis: "Whoever nails proactive AI first wins the next generation of this market." ReChat is *promising* this with Lucy but hasn't shipped. We have the Inbox Ops + Scout + business-rules infra to ship a real proactive agent. This is the strategic differentiator.

**Scope:**
- Daemon/scheduled worker watches: new MLS listings (own + matching saved searches for buyers in CRM), price changes on listings the agent has shown, status changes (under contract / closed) on competing comps, new comps in farm areas (#32), inbox triage (extends existing Inbox Ops).
- Each morning at 6am, agent receives a single **briefing email** + bell notification:
  - "New listing matches Sarah's criteria — drafted a personal note" (link to approve/edit/skip)
  - "3 new comps in your Brickell farm — drafted a market-update email to your sphere"
  - "Coming Soon at 123 Main — drafted Just Listed package for Saturday's open house"
  - "Inbox: 12 emails triaged — 3 need response (drafts ready), 5 promo (auto-archived), 4 contacts (added to CRM)"
- Each item is a **proposal**, not an action — agent approves, edits, or dismisses. Already the Inbox Ops pattern (LLM proposes → human approves).
- Per-agent control panel: which triggers are on, draft tone, approval thresholds (auto-send if confidence > X%, otherwise queue).
- Audit log: every proposal + every decision, so the agent can see what the AI did/didn't do.

**Beat ReChat:** Ship the actual product while ReChat is still "working on it." Position publicly: "Your AI gets up at 4am so you don't have to."

**Dependencies:** #37 (MLS triggers), Inbox Ops (already shipped), #20 Scout V2 (action execution), #5 (Brand Voice), #46 (marketing tokens for drafted social/email).

### 45. E-Sign Integration (DocuSign + Dropbox Sign)

**Why:** Section 5 step 8: "Integrate, do not build." ReChat partnered with SkySlope + DocuSign. We do the same — both providers, since DocuSign is brand-leader and Dropbox Sign is cheaper for solo agents.

**Scope:**
- Two adapter packages: `packages/integration-docusign/` and `packages/integration-dropbox-sign/` (per AGENTS.md "every external integration provider in a dedicated npm workspace package"). Wire through Integration Marketplace (`packages/core/src/modules/integrations/`) and Data Sync hub (`packages/core/src/modules/data_sync/`).
- OAuth connect per agent (each carries their own e-sign account/billing).
- Pre-fill from CRM contact + deal data: buyer/seller name, address, listing data from MLS, agent info, brokerage info.
- Templates: purchase agreement, listing agreement, buyer rep agreement, disclosures, addenda, counter-offer (state-specific template library — start with CA/FL/TX/NY).
- Send envelope from deal detail page → status sync via webhook: `sent → viewed → signed → completed → declined → voided`.
- Signed PDFs auto-attached to deal record + filed in `documents` module.
- Notifications: signature requested / signed / declined → bell + optional email.

**Dependencies:** Integration Marketplace + Data Sync hub (both shipped). Optional: dedicated `realtor.deals` module (extension of `sales`) for state-specific contract templates.

### 46. MLS-Aware Marketing Auto-Population

**Why:** Section 7 of OLD analysis: "Marketing auto-population from MLS — table stakes." ReChat's templates auto-pull listing photos/data from MLS, what used to take days takes seconds. Foundation for #38, #41, #43.

**Scope:**
- Token system for AMS templates (email, landing page, social post, print): `{{listing.address}}`, `{{listing.price}}`, `{{listing.beds}}`, `{{listing.baths}}`, `{{listing.sqft}}`, `{{listing.lot}}`, `{{listing.year}}`, `{{listing.photos[0..N]}}`, `{{listing.virtual_tour_url}}`, `{{listing.video_url}}`, `{{listing.description}}`, `{{listing.features[]}}`, `{{listing.openhouse.next}}`, `{{listing.price_change}}` (with delta).
- Token resolver runs at send-time (not template-save-time), so price/photo updates auto-propagate.
- Pre-built RE template library auto-populated from a selected MLS listing:
  - Email: Coming Soon, Just Listed, Open House This Weekend, Price Reduced, Just Sold, Under Contract, Listing Anniversary
  - Social: Just Listed (carousel), Open House (story), Price Reduced (single), Just Sold (carousel), Coming Soon teaser
  - Print: postcard (front/back), flyer (one-page), brochure (tri-fold), sign rider, business card with QR to listing
- One-click "Create Just Listed package" workflow:
  - Pick listing → select template variants → AI fills tokens + drafts captions in agent voice → preview side-by-side (email + IG + FB + flyer) → approve → send/schedule
- Auto-rebuild trigger: MLS event (`listing.price_changed`, `listing.photos_changed`) → re-render any active drafts and queue notification "Listing changed — review marketing? [Update] [Skip]".

**Dependencies:** #37 (MLS), #5 (Brand Voice), AMS template engine (shipped), social-post infrastructure.

### 47. AI Note-Taker for Client Conversations (RE-tuned)

**Why:** ReChat's AI note-taker is a popular Lucy feature ("speak about a client, AI saves structured notes"). Scout V2 (#20) has the voice infra; this is RE-specific extraction + prompting. Cheap add-on once #20 ships.

**Scope:**
- One-tap voice capture button in Scout (mobile-first) for: post-showing debrief, listing-presentation recap, buyer consult, listing-appointment recap, open-house lead conversation.
- Whisper transcription → RE-tuned LLM prompt extracts structured fields:
  - **Buyer signals**: budget range, target neighborhoods, must-haves, deal-breakers, timeline ("ready in 30 days" / "watching for next 6 months"), financing status (cash / pre-approved / needs lender), buyer type (first-time / move-up / downsizer / investor), motivation level (1–5)
  - **Seller signals**: target list price, motivation, timeline to list, repairs/staging needed, current marketing concerns, competing agent interviews
  - **Showing feedback**: liked / disliked per property, deal-breaker callouts, would-revisit list
  - **Commitments**: "I'll send the disclosures Tuesday", "schedule second showing Saturday" → auto-task with due date + reminder
  - **Mentioned people**: spouse, parents, agent referral source → auto-create related contact suggestions
- All saved to contact's notes timeline + structured fields populate contact CRM panel (no manual data entry).
- Searchable in Scout: "What did the Hendersons say about the second floor?" → semantic retrieval of matching note chunks.

**Dependencies:** #20 Scout V2 (voice + action), Whisper or equivalent transcription, existing custom-fields infra for structured extraction storage.

### 48. Auto Call/Text Logging (Twilio)

**Why:** Section 2 lists as native-mobile feature in ReChat. RE workflow lives on phone — every call/text must auto-log against the contact. Also unblocks the speed-to-lead text in #30 (which today has no actual SMS infra) and #38/#42 SMS sends.

**Scope:**
- Provision Twilio number per agent (or BYO their existing number via Twilio porting). Cost-tier with markup, or pass-through.
- Outbound:
  - Click-to-call from contact card / deal page / tour sheet — opens softphone (Twilio Voice JS SDK) or rings agent's mobile then bridges
  - Send SMS from contact card with template picker
  - Bulk SMS for #38 Agent Network blasts and #43 Open House follow-up
- Inbound:
  - Calls forwarded to agent's mobile + recorded (with consent prompt per state law)
  - Voicemail transcription via Twilio + Whisper
  - Texts arrive in unified inbox (already shipped) — threaded per phone number, matched to contact
- Auto-match by phone number to existing CRM contact; if no match, create a "Stranger" contact + prompt agent to merge later
- Activity log: every call (duration, direction, recording link, transcription) and every SMS thread auto-logged on contact's timeline + counts toward "engagement" score
- Push notification on agent's mobile (PWA #50) for new SMS / missed call
- Compliance: TCPA-safe sending hours, opt-out keywords (STOP/UNSUBSCRIBE) auto-honored, consent capture at form submission

**Dependencies:** Twilio account + verified business profile (10DLC for SMS), unified inbox (shipped), `customer_accounts` for contact matching, #50 PWA for push.

### 49. Lucy-Style Real Estate Form Reading

**Why:** ReChat's Lucy "reads and interprets standard real estate documents, offers context-sensitive guidance — helps at 2am when managing broker isn't available." High agent-perceived AI value. We have PKB RAG + Scout — adding RE form templates is an extension, not a build-from-scratch.

**Scope:**
- Upload PDFs (purchase agreement, listing agreement, disclosures, addenda, counter-offer, inspection report, appraisal) → OCR + parse to structured form data + index in PKB.
- Agent asks Scout natural language: "What's the closing date?", "What contingencies?", "How much earnest money?", "Are there any unusual clauses?", "Compare this counter to the original offer."
- AI returns: cited answer (with page+line reference), highlighted PDF preview.
- Side-by-side compare: redline two versions (original vs counter, vs counter-counter) — visual diff of changed terms.
- Pre-built RE form templates per state (CAR, FAR, TREC, NYSAR top 4) — known-field extraction for closing date, EMD, contingencies (inspection / appraisal / financing / sale-of-buyer-home), price, seller concessions, included/excluded items, possession date.
- Risk flags: AI surfaces unusual clauses ("Buyer's earnest money is non-refundable after 3 days — atypical for this state"), missing standard clauses, dates in conflict (close date before financing contingency expiry), etc.
- "Ask the broker" escalation: send the form + AI summary + flagged clauses to managing broker via email with one click.

**Dependencies:** PKB module (RAG infra), Scout (#20), #45 (DocuSign for getting signed forms back into the system), state-specific form template library.

### 50. RE PWA Mobile Experience

**Why:** Section 5 step 9: "PWA before native." ReChat's biggest UX win is mobile-first. We can match parity via PWA in weeks; native iOS/Android is a year-2 bet. Generalizes #19 mobile pass with RE-specific surfaces.

**Scope:**
- Phone-optimized layouts (one-thumb workflows) for the surfaces RE agents use in the field: contact card, deal pipeline, calendar, today's open houses, MLS search, buyer tour creation/edit (#42), Scout voice (#47), unified inbox, sign-in mode (#43).
- "Add to Home Screen" prompt with branded icon/splash, full-screen mode (no browser chrome).
- Service worker offline cache: today's calendar, last 50 contacts, active deals, current tour sheets — read-only when offline; queued mutations sync on reconnect.
- Camera input flows: scan business card → OCR → new contact, snap document → OCR → attach to deal, snap property photo → attach to listing/showing note.
- Web push notifications: new SMS (#48), missed call, new lead from open-house sign-in, urgent inbox item, AI proposal needs approval (#44).
- Geolocation: "I'm here" check-in at showing/open house auto-logs activity + proximity-based listing suggestions.
- Performance budget: <2s TTI on 4G, <500KB initial JS, all images lazy-loaded.

**Dependencies:** #19 mobile responsive pass (foundation), #43 (sign-in mode), #44 (push for AI proposals), #48 (push for SMS/calls). Native iOS/Android explicitly **out of scope** — defer to year 2.

---

## Future (Lower Priority)

- Reputation management (auto-send review requests, track responses)
- Advanced reporting (export CSV/PDF, date ranges, funnel visualization, campaign ROI)
- Course enhancements (video CDN, quizzes, certificates, cohort-based drip, communities/discussions, analytics dashboard)
- Visual workflow builder (conditional branching, flowchart UI, execution analytics)
- Image/logo upload to cloud storage (currently saves to disk)
- Phone system (Twilio Voice)
- Vertical mode system (auto-configure for real estate, coaching, agency, etc.)
- Multiple email addresses per user (choose send-from, per-address signature/display name)
- Embeddable signup forms (hosted + HTML snippet, double opt-in)
- Smart segments (dynamic contact lists by rules, re-evaluated at send time)
- A/B subject line testing in campaigns
- DocuSign integration
- Microsoft 365 Calendar sync
- PKB access in all AI/upload flows (Personal Knowledge Base file selection)
- Resend API key setup guide (collapsible instructions in Settings)
- Form builder enhancements (conditional fields, analytics, multi-page, payment field)
- AI usage dashboard in settings (calls/month, per-feature breakdown, alerts at 80%/100%)
- Real-time chat via WebSocket/SSE (currently polling)
- Calendar drag-to-reschedule
- Apple Calendar / iCal sync testing

---

## LOW PRIORITY

### Scout Edit/Delete by Name
The AI voice assistant can create things reliably but struggles to edit/delete existing items by name. The AI either passes the wrong field name, sends `undefined`, or refuses to use the tool. Root cause: OpenAI Realtime API function calling doesn't reliably map spoken entity references to the correct tool parameters. Needs deeper investigation — possibly a two-step approach where the AI first calls a "find item" tool, then uses the returned ID to call the edit/delete tool. All the handler code and resolvers are already in place; the issue is purely on the AI tool-calling side.

---

## Recently Completed (Reference)

- **#22 Deploy to Hetzner** ✅ — Live at https://crm.thelaunchpadincubator.com. Docker compose (app + postgres + redis + nginx + certbot), SSL via Let's Encrypt, crontab for reminders/sequences/email-sync/automations, deploy flow documented in memory (`reference_deployment.md`). Subsequent hardening still lands through regular commits.
- **#25 LaunchBot CRM Skill** ✅ — Superseded by SPEC-062 (Full CRM API + MCP Server). Every CRM capability is now reachable via the public MCP endpoint at `/mcp` with 25 curated tools + 636 auto-discovered endpoints, HMAC-signed webhooks, per-key rate limiting, scoped API keys, and `AGENT_GUIDE.md` served through `get_agent_guide`. LaunchBot (and any other agent) connects the same way external integrators do — no CRM-specific skill needed.
- **#33 Terms — AI Token Overage** ✅ — Section 6.8 "AI Usage Limits and Overage Responsibility" shipped in `apps/mercato/src/app/terms/page.tsx`. Covers plan allotments, BYOK carve-out, Launch Pad's discretion to throttle/pause/charge overage at posted rates, user's duty to monitor Settings → AI Usage. Liability protection ready for paid-plan launch.
- **#35 Contact Source Tagging** ✅ — `packages/core/src/modules/customers/lib/sourceTagging.ts` provides `tagContactSource(knex, scope, contactId, category, detail)` and is wired into every creation path (forms, landing pages, funnels, bookings, courses, affiliates, CSV import, Scout, inbox extraction). First-touch attribution: only new contacts get tagged so re-submissions don't overwrite the original source. Reports → Sources reads these tags directly.
- **#34 Notification Center — CRM event wiring** ✅ — The notification center UI (bell icon, panel, SSE + polling hooks, unread badge, group dedup, per-type settings) already shipped with the Open Mercato framework and had several customers-module events wired to it (person.created, deal.stage_changed, deal.won/lost, scout.action). This pass wires the remaining CRM-specific events into the same bell so the "what's my CRM doing right now" promise is real: (1) `landing_pages.form.submitted` — new notification type in landing_pages app module + subscriber that decrypts the submitter name, looks up the page title, and skips when the submit also created a new contact (person.created already covers that case) to avoid doubling; also emits the previously declared-but-never-fired event from the public submit route. (2) `payments.payment.received` and `payments.payment.failed` — new types in the payments app module + subscribers on `payment_gateways.payment.captured`/`payment.failed` that fetch amount/currency from `gateway_transactions` and render a localized currency string. (3) `email.sync.failed` — new type in the email app module + subscriber on `data_sync.run.failed` that looks up the integration display name so the error points at the specific connection (Gmail, Outlook, etc.). All subscribers follow the existing `person-created-notification` template: decrypt-aware, owner/admin recipient resolution, groupKey for dedup, non-blocking error handling. `inbox_ops.proposal.created` was already wired via `packages/core/src/modules/inbox_ops/subscribers/proposalNotifier.ts`. `customers.reminder.fired` was skipped — event declared but never emitted; a separate item can wire the cron to emit first. (2026-04-23)
- **SPEC-063 — Advanced Mode Audit** ✅ — Phase 1: extended the hardcoded hide-list in `apps/mercato/src/app/(backend)/backend/layout.tsx` from 4 → 15 entries, removing ops-only infrastructure pages (Redis cache inspector, system-status, record-locks, raw file browser, planner availability rulesets, customer portal roles) and confusing/duplicate workflow-engine pages (/events, /instances, /tasks, /definitions) plus internal messaging. Phase 2: static code audit of every remaining advanced-mode page — zero RED findings, zero broken imports, zero missing endpoints, zero stale references. 7 YELLOW pages with complex client logic worth a live smoke test but not broken. Phase 3: confirmed the pre-existing DB-backed `/api/auth/sidebar/preferences` + "Customize sidebar" button in AppShell handles user-level hide/rename/reorder across both simple and advanced modes — no additional UI needed. Source files stay, direct URLs still resolve for every hidden path. Hover-to-hide EyeOff icon was built, tested, and reverted per user preference for the dedicated Customize button. (2026-04-23)
- **SPEC-062 — Full CRM API + MCP Server (4 phases)** ✅ — Public platform for third-party AI agents, bots, and automations. (1) Webhooks module: one-event-per-subscription CRUD, 7 event subscribers wiring module events → outbound HMAC-signed POSTs, delivery log with retries, test-delivery button, secret rotation; covers contact.created/updated, deal.created/stage_changed/won/lost, task.created/completed, form.submitted, booking.created, course.enrollment.created, invoice.created. (2) Per-API-key rate limiting: default (60/min, 1000/hr) / pro (300/min, 10k/hr) / unlimited tiers stored on api_keys.rate_limit_tier, IETF RateLimit-* headers on every response, Retry-After on 429s, cookie-auth bypass (UI unaffected), dual-window enforcement. (3) Public MCP HTTPS endpoint at /mcp: nginx-proxied x-api-key gate, dedicated launchos-mcp container running streamable HTTP transport on :3001, 25 tools (24 curated + get_agent_guide) plus 636 auto-discovered endpoints via call_api. (4) Scoped API keys: additive scopes column on api_keys, wildcard matcher (exact/entity/module/root), router narrows role permissions when scopes present, null preserves v1 behavior. Plus: AGENT_GUIDE.md integration doc (18KB, three control surfaces, auth, webhooks, recipes, BC contract) ships in the repo and at /app in prod; get_agent_guide MCP tool returns it with optional H2 section filter; bootstrap instructions auto-delivered in the MCP initialize response so every agent gets the primer in its system prompt at handshake time. End-to-end verified via agent simulation: initialize→find_api→call_api→customers_create_note→DB confirmation. Systemic fix: normalizeAuthorUserId applied across tier0 commands + 5 raw routes so API-key callers don't 500 on UUID columns. 30+ commits, all deployed, all verified in prod. (2026-04-23)
- **Scout V2 — AI Voice Assistant (5 phases + major reliability pass)** ✅ — Phase 1 multi-step reliability (system-prompt TOOL CALL DISCIPLINE block forbidding past-tense claims without matching tool calls, narrated execution labels with entity names, client-side reconciliation banner that compares transcript verbs vs actual function_call events and offers a Retry button); Phase 2 edit/delete by name (new `find_entity` tool routing to 12 entity search endpoints, fetch-and-filter fallback that works against encrypted display_name where ILIKE can't match, explicit NAME RESOLUTION prompt rule); Phase 3 destructive confirmation (19 tool+subaction combos intercepted — delete_contact, manage_deal/delete|close_lost, manage_invoice/delete, manage_event_advanced/delete|cancel, process_payment/refund|cancel_subscription, etc. — each gated by a Confirm/Cancel UI and a blocked Promise in handleRealtimeToolCall); Phase 4 context awareness (derivePageContext parses URL/referrer for known entity detail pages, passed to both realtime session and text assistant, CURRENT CONTEXT block in prompt defaults ambiguous references to the viewed entity); Phase 5 proactive open (greeting now leads with top action-items instead of generic "how can I help"). Bonus fixes during integration: OpenAI fallback when Gemini 429s, decryption in pipeline/journey + contact-detail slideout + Scout data context for both contacts and deals, company names exposed to Scout, missing action handlers (delete_company/delete_deal/delete_product/delete_task/remove_contact_from_pipeline/move_contact_stage) added across widget + full-page executors, create_contact validator fix (drop empty email), multi-step chain contact-id injection, assistant_conversations table created, auto-scroll, login autofill label overlap, pipeline journey hides null-stage + company entities, Appzi widget removed. API test harness at `/tmp/scout-test-harness.sh` validates 12 endpoints end-to-end and now catches regressions before the user does (2026-04-22)
- **Login / Signup flow — full overhaul (6 phases)** ✅ — (1) audited the custom signup/forgot/reset routes and found they were all broken against the encrypted-email production schema (raw SQL plaintext lookups, missing `email_hash`, bypassed `setupInitialTenant`, plus `requireAuth: true` blocking every POST); (2) rewrote all three to use `AuthService` + `setupInitialTenant` so encryption maps, role ACLs, and module `onTenantCreated` hooks fire properly; (3) confirmed signup already routes to `/backend/welcome` onboarding wizard; (4) ported auth polish to real pages — float-label inputs, traced-gradient submit button with spring hover, shake-on-error, scale-check-on-success, staggered org picker, 13 drifting particles, 6s card breathing glow, iOS no-zoom fix; (5) built Google OAuth — `users.google_sub` column + unique index, `/api/auth/google/start` with PKCE + state cookies, `/api/auth/google/callback` that finds/links/creates users via existing `GOOGLE_OAUTH_CLIENT_ID` creds, non-sensitive scopes (`openid email profile`) so no verification review needed; forgot-password silently skips Google-only accounts; (6) E2E tested all paths. Bonus: fixed onboarding `pipelineMode: 'journey'` validation bug that was silently failing + surfaced save errors via alert instead of swallowing; fixed reset-email sending to encrypted ciphertext instead of plaintext; ported the darker auth-page hero gradient + drifting particles to the landing page (2026-04-21)
- Blog-Ops / AMS integration ✅ — API-key auth, ext endpoints (`/api/ext/contacts|deals|dashboard/summary|pipeline/summary`), landing page signups create CRM contacts end-to-end, dedicated "AMS Integration" settings card that generates the CRM API key + step-by-step connection instructions (2026-04-20)
- Unified inbox bulk actions — Mark read, Close, Reopen, Delete with confirmation; backend PUT /api/inbox supports all four (2026-04-20)
- Funnel system overhaul — all 4 patterns tested, 23/23 passing (2026-04-02)
- Inbox Intelligence — auto-scan inboxes, create contacts, update timeline/engagement (2026-04-02)
- Reports page fixed, dashboard quick actions, sidebar reorganized (2026-04-02)
- Email marketing — blasts, sequences, mailing lists, routing, tracking (2026-03-30-31)
- Landing page wizard v2 — 7-step guided flow, AI copywriting (2026-03-31)
- Funnels — multi-step, Stripe checkout, upsell/downsell, templates (2026-03-31)
- 25 gap features — all complete (sequences, surveys, chat widget, affiliates, etc.)
- Old build queue items 1-5, 7-15, 18-23 all fixed (from 2026-03-26 queue)
