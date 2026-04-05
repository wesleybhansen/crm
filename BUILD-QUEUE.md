# CRM Build Queue

Comprehensive prioritized queue. Updated 2026-04-02.

---

## TOP PRIORITY

### A. Login / Signup Flow Redesign
Redesign login, signup, and password reset screens with branding. Remove tenant URL requirement (auto-detect from email or show picker). Add forgot password flow with email reset link. "Sign in" link on signup, "Create account" on login. Mobile-friendly. Dev mode: auto-verify email on signup. This is the first impression — it needs to look professional, not like boilerplate.

### B. AI Voice Assistant (Scout V2)
Expand the Scout AI assistant into a full voice-to-voice CRM control system. Users can manage their entire CRM through voice or text chat — add contacts, send messages, check reports, create deals, manage pipeline, send emails, create landing pages, check analytics, etc. The AI assistant does real work, not just answers questions.

**Key capabilities:**
- Voice-to-voice chat (browser SpeechRecognition API for input, TTS for output)
- Text chat (existing Scout, upgraded)
- Full CRM action execution: create/update/delete contacts, deals, tasks, notes, tags
- Send emails, create landing pages, manage funnels, check reports
- Natural language queries: "What deals are closing this week?", "Show me my hottest leads"
- Confirmation step before executing destructive/important actions
- Context-aware: knows what page the user is on, who they're looking at

### C. Full CRM API + MCP Server
Build a comprehensive REST API and MCP (Model Context Protocol) server so the CRM can be controlled by external AI agents (LaunchBot, custom agents, etc.).

**REST API:**
- Complete CRUD for all entities (contacts, deals, tasks, notes, tags, invoices, products, etc.)
- API key authentication (already exists, needs full endpoint coverage)
- Webhook subscriptions for real-time events
- OpenAPI spec auto-generated from routes
- Rate limiting per API key

**MCP Server:**
- Expose CRM capabilities as MCP tools
- Tools: search_contacts, create_contact, update_deal, send_email, get_pipeline, create_task, etc.
- Connectable from any MCP-compatible AI agent
- Authentication via API key or session token

### D. Blog-Ops Integration
Connect the CRM to the Automated Marketing System at `~/Desktop/blog-ops`. Blog-Ops handles content generation, email sequence creation, competitive intelligence, and paid ads. The CRM handles contacts, pipeline, and delivery.

**Integration points:**
- Contact sync (bidirectional) — new CRM contacts pushed to Blog-Ops, Blog-Ops lead data pulled into CRM
- Email sequence content import — Blog-Ops generates sequence copy, CRM imports and sends via connected email
- Content pipeline — Blog-Ops generates content, CRM surfaces it for review/approval
- Lead magnet delivery — Blog-Ops creates lead magnets (PDFs, etc.), CRM handles the funnel + form + delivery
- Campaign orchestration — Blog-Ops plans campaigns, CRM executes (emails, landing pages, funnels)
- Shared API key auth between systems

### E. Smarter Landing Pages
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

- Funnel system overhaul — all 4 patterns tested, 23/23 passing (2026-04-02)
- Inbox Intelligence — auto-scan inboxes, create contacts, update timeline/engagement (2026-04-02)
- Reports page fixed, dashboard quick actions, sidebar reorganized (2026-04-02)
- Email marketing — blasts, sequences, mailing lists, routing, tracking (2026-03-30-31)
- Landing page wizard v2 — 7-step guided flow, AI copywriting (2026-03-31)
- Funnels — multi-step, Stripe checkout, upsell/downsell, templates (2026-03-31)
- 25 gap features — all complete (sequences, surveys, chat widget, affiliates, etc.)
- Old build queue items 1-5, 7-15, 18-23 all fixed (from 2026-03-26 queue)
