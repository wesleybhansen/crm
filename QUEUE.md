# CRM Build Queue

Ordered by priority. Each item includes what it does for users and rough effort.

---

## Priority 1: Completed Features

All original MVP features are built. See CONTEXT.md for full list.

---

## Priority 2: Infrastructure & User-Connected Integrations

**Architecture decision (2026-03-26):** All external services (email, payments, SMS) are user-connected, not platform-level. Each user connects their own accounts. Platform pays $0 for these services.

### 2.1 Gemini Paid Tier (Wesley's action)
- [x] Upgrade Gemini API key to pay-as-you-go — DONE

### 2.2 Gmail Email Integration (2-3 days)
**Why:** Primary email sending for 90% of users. Send/receive through their real Gmail. No ESP needed.
- [ ] Extend existing Google OAuth to include email scopes (gmail.send, gmail.readonly, gmail.compose)
- [ ] email_connections table (org_id, user_id, provider, access_token, refresh_token, email_address, is_primary)
- [ ] Gmail send service: send email via Gmail API (appears in user's Sent folder)
- [ ] Gmail receive/sync: poll inbox for replies to CRM-sent emails, show in Unified Inbox
- [ ] Email sender router: check user's connected email → send via Gmail/Outlook/SMTP
- [ ] Update Email Compose modal to show "Sending as: jane@herbusiness.com"
- [ ] Update sequences/campaigns to use connected email as sender
- [ ] Handle Gmail rate limits (500/day personal, 2,000/day Workspace) with clear error messages
- [ ] Settings UI: "Connect Gmail" button with connected account display + disconnect

### 2.3 Outlook/Microsoft Email Integration (2 days)
**Why:** Covers users on Microsoft 365 / Outlook.
- [ ] Microsoft Graph OAuth flow (register app in Azure AD, get client ID/secret)
- [ ] OAuth scopes: Mail.Send, Mail.ReadWrite, User.Read
- [ ] Outlook send service: send via Microsoft Graph API
- [ ] Outlook receive/sync: poll for replies
- [ ] Store connection in same email_connections table (provider: 'microsoft')
- [ ] Settings UI: "Connect Outlook" button

### 2.4 Generic SMTP Connection (1 day)
**Why:** Fallback for users with Zoho, Yahoo Business, Fastmail, custom mail servers.
- [ ] SMTP connection form in Settings: host, port, username, password, from address
- [ ] Store encrypted in email_connections (provider: 'smtp')
- [ ] Send via nodemailer or direct SMTP
- [ ] Test connection button (sends test email to self)

### 2.5 Bulk ESP Integration — BYOK (1 day)
**Why:** For campaigns exceeding Gmail/Outlook daily limits. User brings their own ESP API key.
- [ ] esp_connections table (org_id, provider, api_key_encrypted, sending_domain, is_verified)
- [ ] Supported providers: Resend, SendGrid, Amazon SES, Mailgun
- [ ] Settings UI: select provider → enter API key → test connection
- [ ] Campaign send logic: if list size > Gmail limit OR user has ESP configured, route through ESP
- [ ] Auto-detect: warn user if campaign audience exceeds their email provider's daily limit
- [ ] Remove platform-level RESEND_API_KEY dependency

### 2.6 Stripe Connect — User Payments (2 days)
**Why:** Users receive payments from their own customers. Money goes to user's Stripe account.
- [ ] Register as Stripe Connect platform (Wesley's action: stripe.com/connect)
- [ ] Platform Stripe keys in .env: STRIPE_CONNECT_CLIENT_ID, STRIPE_SECRET_KEY
- [ ] Stripe Connect OAuth flow: user clicks "Connect Stripe" → authorizes → store connected account ID
- [ ] stripe_connections table (org_id, stripe_account_id, access_token, refresh_token, business_name)
- [ ] Update all payment code to use user's connected Stripe account:
  - Checkout sessions created on behalf of connected account
  - Payment links use connected account
  - Webhook handling routes to correct org by connected account
- [ ] Settings UI: "Connect Stripe" button, connected account display, disconnect
- [ ] Optional platform application fee (Wesley configurable, e.g., 2% per transaction)
- [ ] Handle users without Stripe connected (hide payment features, show "Connect Stripe to accept payments")

### 2.7 Twilio — User SMS Accounts (1 day)
**Why:** Each user sends SMS from their own number via their own Twilio account.
- [ ] twilio_connections table (org_id, account_sid, auth_token_encrypted, phone_number)
- [ ] Settings UI: enter Twilio credentials + phone number, test connection
- [ ] Update SMS sender to use per-user Twilio credentials
- [ ] Update SMS webhook to route inbound messages by phone number → org
- [ ] Handle users without Twilio connected (hide SMS features, show setup prompt)
- [ ] Remove platform-level TWILIO_* env vars

### 2.8 Google Calendar (after deploy)
- [ ] Create Google Cloud project (Wesley's action)
- [ ] Enable Calendar API + Gmail API + configure OAuth consent screen
- [ ] Create OAuth 2.0 Client ID (redirect URI: https://DOMAIN/api/google/callback)
- [ ] Add to .env: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET
- [ ] Single Google OAuth covers both Calendar sync AND Gmail email

### 2.9 Integration Settings Page (1 day)
**Why:** Unified place for users to manage all their connected services.
- [ ] New Settings → Integrations page (or update existing Settings page)
- [ ] Sections: Email (Gmail/Outlook/SMTP), Bulk Sending (ESP), Payments (Stripe), SMS (Twilio), Calendar (Google)
- [ ] Each section shows: connection status, connected account info, connect/disconnect buttons
- [ ] Connection health checks (test each connection on page load)

### 2.12 AI Features — Tier 1 (Transforms the Product)

Full spec: `/Users/wesleyhansen/Desktop/CRM/AI-FEATURES-PLAN.md`

**T1.1 AI Employee Persona (1-2 days)**
- [ ] Add ai_persona_name, ai_persona_style, ai_custom_instructions to business_profiles
- [ ] Persona selection in onboarding (Professional/Casual/Minimal + custom name)
- [ ] Apply persona to all AI system prompts (assistant, email drafts, landing pages, dashboard)
- [ ] Settings: change name, style, custom instructions
- [ ] Chat widget shows persona name in header

**T1.2 Website-Scan Auto-Configure (1-2 days)**
- [ ] POST /api/ai/scan-website — fetch URL, parse HTML/CSS, extract business data via Gemini
- [ ] Extract: business name, description, services, brand colors, social links, testimonials
- [ ] Pre-fill onboarding fields from scan results
- [ ] Auto-configure: brand colors for templates, products from services list
- [ ] Onboarding: URL input field, "Scanning..." state, pre-filled review

**T1.3 AI Email Intake (2 days)**
- [ ] email_intake_mode field on business_profiles (auto/suggest/off)
- [ ] POST /api/email/gmail-scan — poll Gmail inbox for recent messages
- [ ] POST /api/email/intake/process — AI classifies sender intent (lead/support/personal/spam)
- [ ] Auto mode: create contacts automatically with gmail-import tag
- [ ] Suggest mode: queue suggestions, show on dashboard "AI found X contacts"
- [ ] GET /api/email/intake/suggestions + POST /api/email/intake/approve
- [ ] Exclude list in settings (domains/addresses to skip)
- [ ] Onboarding: intake mode selection after Gmail connect

**T1.4 Brand Voice Engine (1-2 days)**
- [ ] POST /api/ai/learn-voice — fetch 20-30 sent Gmail emails, analyze style via Gemini
- [ ] Store brand_voice profile in business_profiles (JSONB: style summary, formality, greeting/closing style, sample phrases)
- [ ] Apply voice profile to all AI generation prompts
- [ ] Onboarding: "Learn my writing style?" after Gmail connect
- [ ] Settings: retrain button, manual style overrides
- [ ] Fallback: use persona style when not enough email data

**T1.5 Journey Mode / B2C Pipeline (2 days)**
- [ ] pipeline_mode field on business_profiles (deals/journey)
- [ ] Journey mode: pipeline page shows contacts by lifecycle_stage (not deals)
- [ ] Journey mode: Kanban board renders contacts directly
- [ ] Journey mode: hide Create Deal button, Deals tab, deal-related UI
- [ ] Journey mode: contact side panel shows stage prominently with change dropdown
- [ ] Journey mode: dashboard shows "Customer Journey" metrics
- [ ] Onboarding: "How do customers buy?" → auto-select mode
- [ ] Settings: switch modes with warning about hidden (not deleted) deals

**T1.6 Email Sentiment Monitor (1 day)**
- [ ] Sentiment classification on email ingest (positive/neutral/negative/urgent)
- [ ] POST /api/ai/classify-sentiment — Gemini classifies email body
- [ ] Dashboard: "Needs Attention" section for negative/urgent emails
- [ ] One-click actions: view email, draft response, create task
- [ ] "Not actually negative" dismiss button (feedback loop)
- [ ] Settings: toggle on/off

### 2.13 AI Features — Tier 2 (Deepens the Value)

**T2.1 Smart Digest / Weekly AI Review (1 day)**
- [ ] Cron: POST /api/ai/digest/generate — weekly business review
- [ ] Content: revenue trends, new leads, cold contacts, best emails, 3 action items
- [ ] Written in user's AI persona style
- [ ] Sent via user's connected email (to themselves)
- [ ] Settings: frequency (daily/weekly/off), delivery day

**T2.2 Meeting Prep Brief (1 day)**
- [ ] Cron checks upcoming calendar events (next 2 hours)
- [ ] Match attendee emails to CRM contacts
- [ ] Generate brief: contact summary, recent interactions, deal status, talking points
- [ ] Deliver as dashboard notification + optional email
- [ ] Settings: toggle on/off, lead time (1hr/2hr/morning)

**T2.3 AI Task Templates / Client Onboarding Checklists (1 day)**
- [ ] task_templates table (org_id, name, trigger, tasks_json)
- [ ] API: CRUD + trigger execution
- [ ] Onboarding: "What do you do after getting a new client?" → AI generates template
- [ ] Auto-trigger on deal won or stage change
- [ ] Contact side panel: checklist section with progress bar

**T2.4 Conversational CRM Updates (2 days)**
- [ ] Enhanced AI assistant: understands CRM commands in natural language
- [ ] AI returns structured actions: create_contact, move_deal, create_task, send_email
- [ ] Confirmation step: "I'll do these 3 things: [list]. Confirm?"
- [ ] Voice input: microphone button using browser SpeechRecognition API
- [ ] Graceful fallback for unsupported browsers

**T2.5 Relationship Decay Alerts (1 day)**
- [ ] Cron analyzes communication frequency per contact
- [ ] Flag contacts where gap > 2x their average frequency
- [ ] Dashboard: "Relationships needing attention" section
- [ ] AI drafts personalized check-in based on last interaction
- [ ] Severity levels: yellow (1.5x gap), red (2x+ gap)

### 2.14 Revised Onboarding Wizard
- [ ] Replace current 5-step wizard with AI-powered conversational setup
- [ ] Step 1: Business info + website URL (triggers scan) + AI persona selection
- [ ] Step 2: Pipeline mode (deals/journey) + stages + post-sale process description
- [ ] Step 3: Connect accounts (Gmail, Stripe, Twilio) + intake mode + voice learning
- [ ] Step 4: Review everything AI configured (editable before applying)
- [ ] Step 5: Action plan + first tasks + AI greeting

---

### 2.16 Polish Auth Screens (1-2 days)
**Why:** First impression matters. Signup, login, and password reset screens look like default boilerplate.
- [ ] Redesign signup/onboarding page — branded, clean, matches CRM aesthetic
- [ ] Redesign login page — branded, tenant auto-detection (no "use activation link" message)
- [ ] Add "Forgot Password" flow with email reset link
- [ ] Password reset page — enter new password
- [ ] Remove tenant URL requirement for login (auto-detect from email domain or show tenant picker)
- [ ] Dev mode: auto-verify email on signup (skip "check your inbox" entirely)
- [ ] Add "Sign in" link on signup page, "Create account" link on login page
- [ ] Mobile-friendly auth screens

### 2.10 Deploy to Hetzner
- [ ] Docker compose for CRM + PostgreSQL + Redis
- [ ] Nginx reverse proxy + SSL (Let's Encrypt)
- [ ] Domain configuration
- [ ] Run setup-tables.sql
- [ ] Verify everything works in production

### 2.17 Microsoft Azure Setup (Wesley's action — deferred)
**Blocked:** Azure Portal signup not working with wesley.b.hansen@outlook.com. Needs Azure free account setup first.
- [ ] Go to https://azure.microsoft.com/free/ → sign up with wesley.b.hansen@outlook.com
- [ ] Complete Azure free tier setup (creates a tenant/directory)
- [ ] Sign in to https://portal.azure.com
- [ ] Register app: App registrations → New registration → "CRM Platform"
- [ ] Supported account types: "Accounts in any org directory + personal Microsoft accounts" (3rd option)
- [ ] Redirect URIs: http://localhost:3000/api/microsoft/callback + https://crm.thelaunchpadincubator.com/api/microsoft/callback
- [ ] Copy Application (client) ID
- [ ] Certificates & secrets → New client secret → copy the Value (NOT Secret ID)
- [ ] API permissions → Microsoft Graph → Delegated: Mail.Send, Mail.ReadWrite, Calendars.ReadWrite, offline_access, User.Read
- [ ] Add MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET to .env
- [ ] Test: Connect Outlook in Settings → send test email → verify calendar sync

### 2.15 Update OAuth Redirect URIs (after deploy)
- [ ] Google Cloud Console → APIs & Services → Credentials → OAuth client → add production redirect URI: `https://YOUR_DOMAIN/api/google/callback`
- [ ] If Microsoft/Outlook configured: Azure AD → App registrations → add production redirect URI: `https://YOUR_DOMAIN/api/microsoft/callback`
- [ ] If Stripe Connect configured: Stripe Dashboard → Connect Settings → add production redirect URI: `https://YOUR_DOMAIN/api/stripe/connect-oauth/callback`
- [ ] Update APP_URL in .env.production to match the deployed domain

### 2.11 End-to-End Testing
- [ ] Signup → verify → login → dashboard
- [ ] Onboarding wizard → business profile saved
- [ ] Connect Gmail → send email → verify in Gmail Sent folder
- [ ] Create landing page → publish → submit form → contact created
- [ ] Connect Stripe → create product → payment link → test payment
- [ ] Create booking page → public page → book → conflict detection
- [ ] Connect Twilio → SMS send/receive
- [ ] Create sequence → enroll contact → verify steps execute
- [ ] Create campaign with template → send test → send to list

---

## Priority 3: Feature Gaps — ALL COMPLETE

All 25 gap features have been built:

- [x] 3.1 Drip / Follow-up Sequences (email, SMS, wait, condition, branch, goal steps)
- [x] 3.2 Mobile Responsive UI — deferred to testing phase (CSS pass)
- [x] 3.3 Quick Response Templates (saved templates in Email Compose)
- [x] 3.4 Lead Source Tracking / UTM Attribution (auto-capture on landing pages)
- [x] 3.5 Simple Automations / Rules Engine (9 triggers × 8 actions)
- [x] 3.6 Client Portal — covered by preference center + course enrollment + invoice payment
- [x] 3.7 Reminders & Follow-up Nudges (email notification, cron processor)
- [x] 3.8 Contact Activity Timeline (11 data sources, unified view)
- [x] 3.9 Cross-Entry Duplicate Detection & Merge
- [x] 3.10 Outbound Webhooks (9 events, HMAC, retry, delivery logs)
- [x] 3.11 File Attachments on Contacts
- [x] 3.12 Email Marketing Templates (10 styled + AI generator + template picker)
- [x] 3.13 Survey & Form Builder (12 field types, public pages, analytics)
- [x] 3.14 Unified Inbox (threaded email + SMS)
- [x] 3.15 Multi-Step Funnels (page chains, conversion analytics)
- [x] 3.16 Live Chat Widget (embeddable JS, chat inbox)
- [x] 3.17 Affiliate Manager (referral links, commissions, payouts, dashboard)
- [x] 3.18 Email Deliverability & Health (bounce/complaint handling, auto-suppression)
- [x] 3.19 Send Test Email
- [x] 3.20 Pre-Built Automation Recipes (8 templates)
- [x] 3.21 Automation Branching (if/else + goals)
- [x] 3.22 Contact Engagement Scoring (auto-score, Hot/Warm/Cold)
- [x] 3.23 Preference Center (category opt-down)
- [x] 3.24 Send Time Optimization (per-contact best hour)
- [x] 3.25 Subject Line Optimizer (AI scoring + alternatives)

_Detailed specs for each item preserved below for reference._

### 3.1 Drip / Follow-up Sequences (3-4 days)
**Why:** The #1 automation solopreneurs use. Without this, they manually send every follow-up email.
- [ ] Sequence builder: name, trigger (form submit / tag added / deal stage / manual), steps with delays
- [ ] Step types: email (with template), SMS, wait (hours/days), condition (tag/field check)
- [ ] Sequence execution engine: enroll contact → process steps on schedule
- [ ] Auto-enroll from landing page form submissions
- [ ] Pause/resume/remove contacts from sequences
- [ ] Sequence performance stats (sent, opened, clicked, completed, dropped)
- [ ] Pre-built templates: welcome sequence, follow-up after call, re-engagement
- [ ] Blog-Ops integration: import sequence content from Blog-Ops API

### 3.2 Mobile Responsive UI (2-3 days)
**Why:** Solopreneurs live on their phones. Checking leads between meetings is the core use case.
- [ ] Responsive sidebar (hamburger menu on mobile)
- [ ] Contacts list + side panel → stacked layout on mobile
- [ ] Pipeline Kanban → vertical list on mobile
- [ ] Dashboard cards stack vertically
- [ ] Email compose works on mobile
- [ ] Touch-friendly tap targets (44px minimum)
- [ ] PWA manifest + service worker for "Add to Home Screen"
- [ ] Push notifications for new leads / overdue tasks

### 3.3 Quick Response Templates (1 day)
**Why:** Solopreneurs send the same 10-15 messages repeatedly. This saves hours per week.
- [ ] response_templates table (org_id, name, subject, body, category)
- [ ] Create/edit/delete templates in Settings
- [ ] Insert template button in Email Compose modal (dropdown/search)
- [ ] Template variables: {{first_name}}, {{company}}, {{deal_name}}, etc.
- [ ] Pre-built starter templates (inquiry response, pricing, follow-up, thank you)
- [ ] AI: "Generate template from description" button

### 3.4 Lead Source Tracking / Attribution (1-2 days)
**Why:** Solopreneurs need to know which marketing channel is working so they invest time wisely.
- [ ] UTM parameter capture on landing page forms (utm_source, utm_medium, utm_campaign)
- [ ] Store source on contact record (auto-populated from UTM or landing page name)
- [ ] Referrer URL capture
- [ ] Source breakdown on Reports page (leads by source, conversion by source)
- [ ] Source filter on contacts list
- [ ] Landing page performance: views → submissions → deals → revenue attribution

### 3.5 Simple Automations / Rules Engine (2-3 days)
**Why:** Beyond stage automations, users need "when X happens, do Y" for other triggers.
- [ ] automation_rules table (org_id, name, trigger_type, trigger_config, action_type, action_config, is_active)
- [ ] Triggers: contact created, tag added/removed, invoice paid, form submitted, booking created, deal won/lost
- [ ] Actions: send email (template), send SMS, add tag, remove tag, move to pipeline stage, create task, enroll in sequence, webhook
- [ ] Simple UI: "When [trigger dropdown] → Then [action dropdown]" with config fields
- [ ] Rule execution engine (event-driven, processes on trigger)
- [ ] Activity log for rule executions (what fired, what happened)

### 3.6 Client Portal (3-4 days)
**Why:** Clients need self-service access to their invoices, bookings, and courses without calling/emailing.
- [ ] Public portal page per org (/portal/[org-slug])
- [ ] Client login via magic link (email-based, no password)
- [ ] Portal dashboard: upcoming bookings, outstanding invoices, enrolled courses
- [ ] Pay invoice directly from portal (Stripe checkout)
- [ ] View booking history, reschedule/cancel
- [ ] Access enrolled courses + lesson progress
- [ ] View sent invoices + payment receipts
- [ ] Branded with org's colors/logo

### 3.7 Reminders & Follow-up Nudges (1-2 days)
**Why:** Tasks exist but don't notify. Users forget follow-ups without prompts.
- [ ] "Remind me" button on contacts/deals/tasks with date/time picker
- [ ] reminder_queue table (org_id, user_id, entity_type, entity_id, remind_at, message, sent)
- [ ] Reminder delivery: email notification when due
- [ ] Dashboard: "Due Today" section in action items
- [ ] Booking reminders: auto-send email 24h before, SMS 1h before (configurable)
- [ ] Overdue task email digest (daily or weekly, user preference)

### 3.8 Contact Activity Timeline (1-2 days)
**Why:** "What's the full history with this person?" is the most common CRM question.
- [ ] Unified timeline tab on contact side panel (replaces or augments Details tab)
- [ ] Events: emails sent/received, forms submitted, deals created/won/lost, invoices sent/paid, bookings, notes added, tags changed, SMS sent/received, course enrolled
- [ ] Chronological order with icons per event type
- [ ] Collapsible detail (click to expand email body, invoice amount, etc.)
- [ ] Filter by event type
- [ ] Auto-populated from existing data (query across all tables by contact_id)

### 3.9 Cross-Entry Duplicate Detection & Merge (1-2 days)
**Why:** Same person submits 3 forms → 3 contacts. Data gets fragmented.
- [ ] On contact create (any entry point): check for existing contact by email
- [ ] If match found: merge instead of create duplicate (update existing, log as activity)
- [ ] Manual merge: select 2+ contacts → merge dialog → pick primary, combine data
- [ ] Merge keeps all notes, tasks, deals, emails, timeline events from both records
- [ ] Periodic duplicate scan: find contacts with same email/phone, suggest merges
- [ ] Apply to all entry points: form submissions, booking, course enrollment, Stripe payments, CSV import

### 3.10 Outbound Webhooks (1 day)
**Why:** Users need to connect to Zapier/Make/n8n for integrations we don't build.
- [ ] webhook_subscriptions table (org_id, event, target_url, secret, is_active)
- [ ] Settings page: add webhook URL + select events to subscribe
- [ ] Events: contact.created, contact.updated, deal.created, deal.stage_changed, deal.won, deal.lost, invoice.paid, form.submitted, booking.created
- [ ] POST payload: event type + full entity JSON + timestamp + HMAC signature
- [ ] Retry logic: 3 attempts with exponential backoff
- [ ] Delivery log: last 50 deliveries with status codes

### 3.11 File Attachments on Contacts (1 day)
**Why:** Service businesses attach contracts, proposals, receipts, photos to client records.
- [ ] contact_attachments table (org_id, contact_id, filename, file_url, file_size, mime_type, uploaded_by)
- [ ] Upload button in contact side panel (Files tab or within Details)
- [ ] File storage: local disk or S3-compatible (configurable via env)
- [ ] File preview for images/PDFs, download link for others
- [ ] Max file size: 10MB per file, 100MB per contact
- [ ] Show in activity timeline: "File attached: contract.pdf"

### 3.12 Email Marketing Templates & Campaigns — Mailchimp-Level (3-4 days)
**Why:** Plain text campaigns don't convert. Solopreneurs expect branded, styled emails like Mailchimp. This is table stakes for email marketing.

**Styled Email Templates:**
- [ ] email_style_templates table (org_id, name, html_template, thumbnail, category, is_default, created_by)
- [ ] 10-15 pre-built HTML email layouts: newsletter, announcement, promotion, welcome, product launch, event invite, recap/digest, testimonial spotlight, tips/education, seasonal/holiday
- [ ] Template picker in campaign creation (visual grid with thumbnails)
- [ ] CSS variable theming: brand colors, logo, fonts injected per org
- [ ] Template sections: header (logo + nav), hero (image + headline), body (rich text), CTA button, footer (social + unsubscribe)
- [ ] Responsive HTML (works on mobile email clients — inline CSS, table layout for Outlook)

**AI Template Creator:**
- [ ] "Create Custom Template" button → describe brand/style → AI generates HTML email template
- [ ] Inputs: brand colors, logo URL, tone (professional/casual/bold), layout preference
- [ ] AI generates complete responsive HTML email template
- [ ] Save as reusable template in user's library
- [ ] Edit template: swap colors, update logo, adjust layout sections

**Campaign Enhancements:**
- [ ] Campaign scheduling: "Send Now" or pick date/time with timezone
- [ ] scheduled_campaigns processing: cron job checks for due campaigns and sends
- [ ] A/B subject line testing: set 2 variants, send each to 15-20% of audience, auto-send winner to rest after X hours
- [ ] Campaign analytics dashboard: opens, clicks, unsubscribes, bounces per campaign with bar/line charts
- [ ] Per-recipient drill-down: who opened, who clicked which link, who unsubscribed
- [ ] Campaign cloning: duplicate a past campaign as starting point

**Smart Segments:**
- [ ] contact_segments table (org_id, name, rules_json, is_dynamic)
- [ ] Rule types: tag is/is not, source is, created after/before, opened last campaign, clicked in last N days, deal stage is, has/hasn't purchased
- [ ] Dynamic segments auto-update (re-evaluated at send time)
- [ ] Use segments as campaign audience (in addition to tags)
- [ ] Segment size preview ("243 contacts match")

**Embeddable Signup Forms:**
- [ ] signup_forms table (org_id, name, fields_config, tag_on_subscribe, redirect_url, style_config)
- [ ] Form builder: pick fields (email required, name, phone, custom), pick tag to auto-apply
- [ ] Generate embeddable HTML snippet (paste on any website)
- [ ] Hosted form page (/subscribe/[form-id]) for sharing as link
- [ ] Double opt-in option (confirmation email before adding to list)
- [ ] New subscribers auto-created as contacts with source "signup_form"

### 3.18 Email Deliverability & Health (1-2 days)
**Why:** Without bounce/complaint handling, your sending reputation degrades within weeks and emails start hitting spam. This is infrastructure, not optional.
- [ ] Bounce handling: Resend webhook for bounce events → hard bounce auto-suppresses contact (never email again), soft bounce retries 3x then suppresses
- [ ] Spam complaint handling: Resend forwards complaints → auto-unsubscribe contact, log event
- [ ] contact_email_status field: active, soft_bounced, hard_bounced, complained, unsubscribed
- [ ] Skip suppressed contacts at send time (campaign + sequence sends check status)
- [ ] Domain authentication dashboard in Settings: show SPF/DKIM/DMARC status with setup instructions
- [ ] Email health metrics: bounce rate, complaint rate, unsubscribe rate over last 30/60/90 days
- [ ] Warning banner when health metrics exceed safe thresholds (>2% bounce, >0.1% complaint)
- [ ] List hygiene: flag contacts who haven't opened any email in 90 days, suggest re-engagement or removal

### 3.19 Send Test Email (2 hours)
**Why:** Everyone wants to preview their email in a real inbox before sending to their full list. Without this, users either send blind or don't trust the tool.
- [ ] "Send Test" button on campaign compose (next to Send/Schedule)
- [ ] Sends to the logged-in user's own email address
- [ ] Uses the same styled template rendering as the real send
- [ ] Merge tags populated with sample data or the user's own contact record
- [ ] Success toast: "Test sent to your@email.com"

### 3.20 Pre-Built Automation Recipes (1 day)
**Why:** Solopreneurs don't know what a good email sequence looks like. One-click templates get them from zero to automated in minutes.
- [ ] Recipe library: 8-10 pre-built sequence templates with pre-written emails
- [ ] Recipes: Welcome Series (3 emails over 7 days), Follow-Up After Call (2 emails over 5 days), Post-Purchase Thank You (1 email + review request), Win-Back / Re-engagement (3 emails over 14 days), Booking Confirmation + Reminder, Course Drip (per module release), New Lead Nurture (5 emails over 21 days), Referral Request (after deal won)
- [ ] One-click install: pick recipe → customize emails → activate
- [ ] Each recipe includes: trigger, email content (AI-personalized to business profile), timing, subject lines
- [ ] User can edit everything after installing

### 3.21 Automation Branching (1-2 days)
**Why:** Linear sequences treat every contact the same. Branching makes sequences smart — opened → send offer, didn't open → try different subject line.
- [ ] Branch step type in sequence builder: "If [condition] → Path A, Else → Path B"
- [ ] Conditions: opened previous email, clicked link, has tag, deal stage is, replied, didn't open after N days
- [ ] Visual branch display: indented paths or simple flowchart
- [ ] Merge paths back together after branch
- [ ] Wait conditions: "wait until contact has tag X" or "wait until deal moves to stage Y" (not just time delays)
- [ ] Goal step: sequence ends when contact achieves goal (e.g., makes purchase, books call)
- [ ] Contacts can be on different paths simultaneously tracked in enrollment record

### 3.22 Contact Engagement Scoring (1 day)
**Why:** Solopreneurs don't have time to manually review who's engaged. Auto-scoring surfaces hot leads and cold contacts instantly.
- [ ] engagement_score field on contacts (integer, default 0)
- [ ] Scoring rules: +1 email opened, +3 link clicked, +5 form submitted, +5 booking made, +10 invoice paid, -1 email not opened (after 3 days), -5 unsubscribed, -3 no activity in 30 days
- [ ] Auto-recalculate on each event (increment/decrement, not full recompute)
- [ ] Score visible on contact list (sortable column) and side panel
- [ ] Dashboard widget: "Hottest Leads" (top 10 by score) and "Going Cold" (biggest score drops this week)
- [ ] AI action items integration: "5 contacts are going cold — consider a re-engagement email"
- [ ] Segment rule: filter by score range (e.g., "score > 20" for hot leads)

### 3.23 Preference Center (1 day)
**Why:** Binary unsubscribe loses contacts forever. Preference centers let people opt down instead of out — reduces unsubscribes by 30-40%.
- [ ] email_preferences table (contact_id, org_id, category, opted_in)
- [ ] Default categories: Product Updates, Newsletter, Promotions, Event Invitations, Tips & Education
- [ ] Custom categories: org can add their own
- [ ] Preference center page (/email/preferences/[contact-token]) — styled, lists categories with toggles
- [ ] Unsubscribe link in emails → goes to preference center instead of instant unsubscribe
- [ ] "Unsubscribe from all" option still available at bottom of preference center
- [ ] Campaign creation: assign category to each campaign
- [ ] Send logic: skip contacts who opted out of that category (but still subscribed to others)
- [ ] Re-subscribe: contacts can re-enable categories from preference center

### 3.24 Send Time Optimization (1 day)
**Why:** Sending at each contact's peak engagement time increases open rates 15-25%. Easy AI win using data we already collect.
- [ ] contact_open_times table or field: track hour-of-day for each email open per contact
- [ ] Build per-contact "best hour" profile after 5+ opens (mode of open hours, adjusted to their timezone)
- [ ] Campaign send option: "Send at each contact's optimal time" (checkbox alongside schedule)
- [ ] Stagger sends over 24 hours, each contact gets email at their peak hour
- [ ] Fallback for contacts without enough data: send at org's overall best hour (most common open hour across all contacts)
- [ ] Show "Optimal send time: ~2pm" on contact detail for transparency

### 3.25 Subject Line Optimizer (half day)
**Why:** Quick AI feature, high perceived value. Better subject lines = higher open rates = more business.
- [ ] "Optimize" button next to subject line field in campaign compose
- [ ] AI analyzes subject line and returns: score (1-10), suggestions for improvement, 3 alternative subject lines
- [ ] Checks for: spam trigger words, length (optimal 30-50 chars), personalization, urgency, clarity
- [ ] Click to use any suggestion (replaces subject line)
- [ ] Historical data: "Your best-performing subject lines averaged 8 words and used a question format"

### 3.13 Survey & Form Builder (2-3 days)
**Why:** Solopreneurs need feedback forms, intake questionnaires, and surveys beyond landing page forms.
- [ ] surveys table (org_id, title, description, slug, fields_json, thank_you_message, is_active)
- [ ] survey_responses table (org_id, survey_id, contact_id, responses_json, submitted_at)
- [ ] Field types: text, textarea, select, multi-select, radio, checkbox, rating (1-5 stars), NPS (0-10), date, file upload
- [ ] Drag-and-drop field ordering
- [ ] Conditional logic: show/hide fields based on previous answers
- [ ] Public survey page (/survey/[slug]) — styled, mobile-friendly
- [ ] Shareable link + embeddable HTML snippet
- [ ] Responses linked to contact (by email match or logged-in portal user)
- [ ] Response summary dashboard: aggregate stats, charts per question
- [ ] Export responses to CSV
- [ ] AI: "Generate survey from description" (e.g., "customer satisfaction survey for coaching clients")
- [ ] Trigger automations on submission (tag contact, enroll in sequence, create task)

### 3.14 Unified Inbox (2-3 days)
**Why:** Checking email, SMS, and chat separately wastes time. One view for all conversations with a contact.
- [ ] Inbox page in sidebar (replaces or augments Email page)
- [ ] Threaded conversation view: all messages with a contact in one stream
- [ ] Channel indicators: email, SMS, chat (icons per message)
- [ ] Reply inline: pick channel (email/SMS) from same thread
- [ ] Unread count badge on sidebar
- [ ] Search across all conversations
- [ ] Filter by channel, by tag, by read/unread
- [ ] Quick actions: add tag, create deal, create task from conversation
- [ ] Contact side panel alongside conversation (same pattern as contacts page)

### 3.15 Multi-Step Funnels (2-3 days)
**Why:** Single landing pages convert well, but upsells and multi-step opt-ins convert better.
- [ ] funnels table (org_id, name, slug, steps_json, is_published)
- [ ] funnel_steps table (funnel_id, step_order, page_id, step_type, next_step_config)
- [ ] Step types: opt-in (landing page), upsell, downsell, checkout (Stripe), thank-you, webinar registration
- [ ] Visual funnel builder: drag steps, connect with arrows
- [ ] Each step uses an existing landing page (pick from library)
- [ ] Conditional routing: if purchased → upsell page, if declined → downsell page
- [ ] Funnel analytics: visitors per step, drop-off rates, conversion rate, revenue per funnel
- [ ] Shareable funnel URL (/f/[slug]) enters at step 1
- [ ] Contact tracked through entire funnel journey

### 3.16 Live Chat Widget (2-3 days)
**Why:** Visitors on your website want to ask questions before buying. Real-time chat converts browsers into leads.
- [ ] chat_widgets table (org_id, name, config_json, greeting_message, auto_responses)
- [ ] chat_conversations table (org_id, widget_id, contact_id, status, started_at)
- [ ] chat_messages table (conversation_id, sender_type, message, sent_at)
- [ ] Embeddable JavaScript widget: generates <script> tag to paste on any website
- [ ] Widget customization: brand colors, position (bottom-right/left), greeting message, avatar
- [ ] Visitor-side: floating chat bubble → chat window → name/email capture on first message
- [ ] Business-side: chat inbox in CRM, real-time messages (SSE/polling)
- [ ] Auto-create contact from chat (by email)
- [ ] Offline mode: "We'll get back to you" → creates task for follow-up
- [ ] AI auto-reply option: AI answers common questions using business profile + FAQ
- [ ] Chat conversations show in contact timeline (3.8)

### 3.17 Affiliate Manager (2-3 days)
**Why:** Program members who sell courses or services need to track and pay affiliates/referral partners.
- [ ] affiliates table (org_id, contact_id, affiliate_code, commission_rate, commission_type, status)
- [ ] affiliate_referrals table (affiliate_id, referred_contact_id, referred_at, converted_at, order_value)
- [ ] affiliate_payouts table (affiliate_id, amount, period_start, period_end, status, paid_at)
- [ ] Affiliate signup: generate unique referral link per affiliate (/ref/[code])
- [ ] Cookie-based tracking: 30-day attribution window
- [ ] Commission types: percentage of sale, flat fee per referral, flat fee per conversion
- [ ] Affiliate dashboard (portal page): see referrals, earnings, payout history
- [ ] Admin view: see all affiliates, approve/reject, process payouts
- [ ] Stripe payouts integration (batch payout to affiliate's connected Stripe account)
- [ ] Affiliate leaderboard
- [ ] Reports: top affiliates, revenue by affiliate, conversion rates

---

## Priority 4: Integration & Automation

### 4.1 Blog-Ops Integration
- [ ] Define API contract between CRM and Blog-Ops
- [ ] Contact sync (bidirectional)
- [ ] Email sequence content import (Blog-Ops → CRM sequences)
- [ ] Content pull (Blog-Ops → CRM for review)

### 4.2 LaunchBot CRM Skill
- [ ] CRM skill definition for LaunchBot agents
- [ ] Agent can query contacts, deals, pipeline
- [ ] Agent can create contacts, log activities
- [ ] "Ask AI" button on contact pages → sends context to LaunchBot

---

## Priority 5: Growth Features (Future)

### 5.1 CRM Migration Assistant (2-3 days)
**Why:** The #1 barrier to CRM adoption is migration. Users have data in HubSpot, GHL, Salesforce, spreadsheets, etc. Making migration painless = more users.
- [ ] Migration wizard page accessible from onboarding + settings
- [ ] Supported sources:
  - **CSV/Excel upload** — universal fallback. AI maps columns to CRM fields automatically.
  - **Google Sheets** — connect via Google OAuth (already have it), pick sheet, AI maps columns
  - **HubSpot** — API integration. User enters API key → pull contacts, deals, notes, tasks, companies
  - **GoHighLevel** — API integration. User enters API key → pull contacts, opportunities, pipelines
  - **Salesforce** — API integration. OAuth → pull contacts, leads, opportunities, accounts, tasks
  - **Mailchimp** — API integration. User enters API key → pull subscribers, lists, tags, campaigns
  - **Notion/Airtable** — API key → pull database records, AI maps to CRM fields
- [ ] AI field mapping: AI analyzes source columns and auto-maps to CRM fields (name, email, phone, company, etc.)
- [ ] Preview before import: show first 10 rows, confirm mapping, fix any mismatches
- [ ] Dedup on import: check existing contacts by email, merge instead of creating duplicates
- [ ] Import pipeline/deal data: map source stages to CRM pipeline stages
- [ ] Import tags/lists: create tags from source segments/lists
- [ ] Import notes/activities: attach to the right contacts
- [ ] Progress indicator: "Importing 2,450 contacts... 67% complete"
- [ ] Import summary: "Imported 2,450 contacts, 89 deals, 1,230 notes. 45 duplicates merged."
- [ ] Undo: ability to roll back a migration within 24 hours (tag imported records, bulk delete by tag)

### 5.2 Reputation Management
- [ ] Auto-send review request after deal won (Google, Yelp)
- [ ] Review link generator
- [ ] Track review responses

### 5.2 Referral Tracking
- [ ] Referral source field on contacts
- [ ] "Referred by" linking between contacts
- [ ] Referral stats on Reports page

### 5.3 Microsoft 365 Calendar Sync
- [ ] Microsoft Graph API OAuth
- [ ] Two-way sync with Outlook/Microsoft 365 calendars
- [ ] Only if user demand warrants it (.ics feed covers Outlook personal)

### 5.4 Advanced Reporting
- [ ] Export reports to CSV/PDF
- [ ] Date range selector
- [ ] Funnel visualization (lead → contact → deal → won)
- [ ] Campaign ROI tracking

### 5.5 Weekly Summary Email
- [ ] Scheduled digest: new leads, deals closed, revenue, overdue tasks
- [ ] Configurable: daily/weekly/off
- [ ] Sent via user's connected email (not a platform ESP)

---

## Current Status

**All MVP + gap + AI features built.** Integrations (Gmail, Outlook, Stripe Connect, Twilio) built. Currently: AI Tier 1 features complete, building Tier 2. Next: deployment + testing.

---

## Priority 6: Pre-Launch Compliance

### 6.1 Google OAuth Verification (1-4 weeks review)
**Why:** Testing mode limits to 100 manually-added users with 7-day token expiry. Production requires Google verification.
- [ ] Prepare privacy policy page (required by Google)
- [ ] Prepare terms of service page (required by Google)
- [ ] Submit OAuth consent screen for verification in Google Cloud Console
- [ ] Provide: app homepage URL, privacy policy URL, authorized domains
- [ ] If using sensitive scopes (gmail.send): may require security assessment ($15-75K) or justify limited scope usage
- [ ] Alternative: apply for "Internal" app type if all users are Google Workspace users under same domain
- [ ] Timeline: verification takes 1-4 weeks, security assessment adds 4-6 weeks
- [ ] Can launch to test users (up to 100) immediately while verification is pending

### 6.2 Microsoft OAuth App Registration (if Outlook needed)
- [ ] Register app in Azure AD (portal.azure.com → App registrations)
- [ ] Configure redirect URIs
- [ ] Submit for admin consent if accessing organizational data
- [ ] Similar verification process to Google
