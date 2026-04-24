# CRM Build Queue

Comprehensive prioritized queue. Updated 2026-04-23.

---

## TOP PRIORITY

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

### 4. Advanced Mode Audit
Go through the advanced settings and pages inherited from the Open Mercato fork. Verify what still works, what's broken, and what should be removed or simplified. The advanced mode (toggled in settings) exposes the full Open Mercato admin: users/roles management, system config, API keys, entity designer, query indexes, feature toggles, workflow builder, audit logs, etc. Audit each section — fix critical breakage, remove irrelevant enterprise features, ensure the toggle between simple/advanced mode works cleanly. This is about making the advanced mode a usable power-user experience, not a graveyard of broken framework pages.

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

### 22. Deploy to Hetzner
Docker compose for CRM + PostgreSQL + Redis. Nginx reverse proxy + SSL. Set APP_URL. Run setup-tables.sql. Switch Stripe to live keys. Update OAuth redirect URIs.

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

### 25. LaunchBot CRM Skill
CRM skill for LaunchBot agents. Query/create contacts, deals, pipeline. "Ask AI" on contact pages.

### 26. Google OAuth Verification
Submit for production verification. Privacy policy + terms pages. Security assessment if sensitive scopes. 100 test users while pending.

### 27. Custom Domain Landing Pages
Users publish on their own domain. CNAME/DNS setup, domain verification, SSL via Let's Encrypt/Cloudflare.

### 28. Data Enrichment
Extract business data from email signatures (company, title, phone, LinkedIn). Later: paid enrichment API (Clearbit, Hunter.io, Apollo).

### 29. Automatic Pipeline Stage Advancement
Auto-move contacts through stages based on events: sequence completion → advance, form submission → set stage, engagement threshold → advance, payment → move to Customer.

### 33. Terms — AI Token Overage Responsibility
**Priority:** quick fix — small text edit, blocks nothing. Should ship before any paid plan launches to protect against runaway AI cost liability.

Update the Terms of Service to make users explicitly responsible for AI token usage that exceeds their plan allotment. Currently the AI cost model is a system-wide cap (default 500 calls/month, admin adjustable) with BYOK (Bring Your Own Key) fallback — but the terms don't say what happens when usage exceeds the cap or who pays for it.

**Add language covering:**
- Each plan includes a fixed monthly AI token allotment
- Excess usage is either (a) paused until next billing cycle, (b) billed against the user's own API key if BYOK is enabled, or (c) charged as overage at a posted rate
- Users acknowledge they are responsible for monitoring their own usage in Settings → AI Usage
- The Launch Pad LLC reserves the right to throttle, pause, or charge for overage at its discretion to prevent abuse
- Specific carve-out for users on BYOK: their own API key bills go directly to whichever AI provider they connected; The Launch Pad LLC has no liability for those charges

**Files to update:**
- `apps/mercato/src/app/terms/page.tsx` (or wherever the terms component lives)
- Surface a one-line "AI usage policy" link from Settings → AI section so users can find it

### 34. Notification Center in Header
**Priority:** high — foundational UX. The "set it on autopilot" pitch only works if users can see what the AI is actually doing.

Build a notification center icon in the topbar that shows real-time updates of background activity, AI actions, and system events. This is the "what's the AI up to right now" panel — proof that the autonomous CRM is actually working autonomously.

**Surface notifications for:**
- **AI background tasks** — Brand Voice Engine analysis running, voice assistant action queued, sequence sending, automation rule triggered, email being drafted, contact enrichment in progress, AI summary generation
- **AI decisions** — "AI tagged Maria Chen as Hot Lead based on engagement", "AI moved deal to Negotiating stage", "AI drafted reply to John Doe (review before sending)"
- **System events** — new contact created, deal stage changed, payment received, form submission, booking made, course enrolled, survey response
- **Async job results** — CSV import complete, export ready, Gmail sync finished, sequence batch sent, automation execution finished
- **Errors** — Gmail token expired, sequence step failed, payment webhook missed, AI provider rate limited

**UX:**
- Bell icon in topbar with unread count badge
- Click to open dropdown panel anchored to the icon (≤480px wide, max 600px tall, scrollable)
- List of recent notifications grouped by time (Today / Yesterday / Earlier this week)
- Each notification: icon (per type), title, one-line description, timestamp, "go to" link to the affected entity
- Mark individually as read or "Mark all as read" button
- Filter pills at top: All / AI / System / Errors
- Empty state: "Nothing happening right now. Your business is on autopilot."
- Settings → Notifications: per-type toggles, browser push opt-in, email digest opt-in (daily/weekly)

**Backend:**
- New `notifications` table: `id, user_id, organization_id, type, severity, title, description, link, metadata (jsonb), read_at, created_at`
- API routes: `GET /api/notifications`, `POST /api/notifications/:id/read`, `POST /api/notifications/mark-all-read`, `DELETE /api/notifications/:id`
- Server-side helper `createNotification(userId, type, payload)` mirroring the existing `logTimelineEvent` pattern — call it from every AI action handler and CRM event hook
- Real-time push: SSE endpoint `/api/notifications/stream` (or polling every 30s as the simpler v1)
- Auto-cleanup: drop notifications older than 30 days via a cron job

**Why:** Users need transparency into what the AI is doing on their behalf. "Set it on autopilot" requires trust, and trust requires visibility. The notification center is the proof that the AI is working — without it, users wonder if anything is happening at all and lose confidence in the autopilot pitch.

### 35. Contact Source Tagging (auto-tag on creation AND interaction)
**Priority:** high — foundational data quality. Without source attribution, the marketing reports lie.

Every contact in the CRM should carry a tag identifying where they came from, and existing contacts should be auto-tagged as they interact with new touchpoints. Attribution is the foundation of marketing analytics — users need to see "where did this lead come from?" without ever having to think about tagging manually.

**On contact CREATION, auto-tag with source:**

| Source | Tag format |
|---|---|
| Course enrollment | `Course: <course name>` |
| Form submission | `Form: <form name>` |
| Email reply (Inbox Intelligence) | `Source: Inbound Email` |
| Voice assistant | `Source: Voice Assistant` |
| Manual creation | `Source: Manual` |
| CSV import | `Import: <filename>` |
| API / integration | `API: <api key name>` |
| Booking page | `Booking: <page name>` |
| Funnel | `Funnel: <funnel name>` |
| Landing page | `Page: <page name>` |
| Survey response | `Survey: <survey name>` |
| Affiliate referral | `Affiliate: <affiliate name>` |
| Lead magnet download | `Lead Magnet: <name>` |
| Open House sign-in (realtor) | `Open House: <event name>` |
| Photo scan (business card) | `Source: Photo Scan` |
| Live chat | `Source: Live Chat` |

**On EXISTING contact interaction, add tags as they happen:**
- Existing contact enrolls in a course → add `Course: <name>`
- Existing contact submits a form → add `Form: <name>`
- Existing contact books a meeting → add `Booking: <page name>`
- Existing contact buys → add `Customer` + `Product: <name>`
- Existing contact joins a sequence → add `Sequence: <name>`
- Existing contact attends/registers for an event → add `Event: <name>`
- Existing contact completes a survey → add `Survey: <name>`
- Existing contact opens a lead magnet → add `Lead Magnet: <name>`

**Implementation:**
- Hook into the existing `logTimelineEvent` helper — every timeline event already knows the source entity, so the tagging logic can live alongside it
- Tags auto-create if they don't exist, with category-based color defaults (Course = purple, Form = blue, Booking = green, etc.)
- "Source-prefix" tags get a special visual treatment in the contact panel: small icon, slightly different shape, grouped separately from manual tags
- Tag picker UI groups source tags under a collapsed "Auto" section so they don't crowd the manual tag picker
- The existing Reports → Sources report should pull from these tags directly (verify after implementation)
- Migration: backfill source tags for existing contacts based on their `lead_source` column and any existing timeline events that reference a source entity

**Why:** Attribution is the foundation of every marketing decision. "Which campaigns work?" "Which lead magnets convert?" "Where is my best ROI?" None of those questions can be answered without source tags on every contact. Auto-tagging means users get clean attribution data without ever lifting a finger — and the data accumulates from day one instead of being a wishlist item people never get around to enforcing manually.

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
- MLS/IDX data integration
- Neighborhood market data + market snapshot email generator
- CMA builder (manual comps → branded PDF report, shareable link)
- AI lead qualification bot (auto-text, qualifying questions, score/categorize)
- Property alert system for buyers (new listing matches criteria → auto-notify)
- "Farm area" management with market share tracking

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
