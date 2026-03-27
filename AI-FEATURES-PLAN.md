# AI Features Build Plan

## Architecture Principle

Every AI feature follows one rule: **configure during onboarding, review before applying, change later in settings.** Nothing is forced. The AI suggests, the user confirms.

---

## Tier 1: Transforms the Product

### T1.1 — AI Employee Persona (1-2 days)

**What:** The AI assistant becomes a configurable team member, not a generic chatbot. Users choose its personality during onboarding.

**Onboarding Step:**
- "How should your AI assistant communicate?"
- Options: Professional & Direct / Friendly & Casual / Minimal & Efficient
- User can name it (default suggestion based on business type, e.g., "Scout" for sales-heavy, "Sage" for coaching)
- Preview: show 3 sample messages in the chosen style so user sees the difference

**Where it surfaces:**
- Floating AI chat (already exists) — personality applied to system prompt
- Dashboard action items — tone matches persona
- Email drafts — style matches persona
- All AI-generated content — consistent voice

**Data model:**
- Add to business_profiles: ai_persona_name, ai_persona_style (professional/casual/minimal), ai_custom_instructions
- Settings page: change name, style, add custom instructions ("Never use exclamation marks", "Always mention our guarantee")

**Implementation:**
- Modify the AI system prompts across all endpoints to include persona config
- Load business_profile at the start of every AI call
- Persona name shown in the chat widget header

---

### T1.2 — Website-Scan Auto-Configure (1-2 days)

**What:** User pastes their website URL during onboarding. AI scrapes it and pre-fills business profile, brand colors, services, and CRM configuration.

**Onboarding Step:**
- "What's your website? (optional)" — single URL input
- AI scrapes the page (server-side fetch + parse HTML)
- Extracts: business name, tagline/description, services/products listed, brand colors (from CSS), contact info, social links, testimonials
- Pre-fills the business profile fields
- User reviews and edits before continuing

**What gets configured from the scan:**
- Business name, description, type (AI infers from content)
- Brand colors → applied to landing pages, email templates, chat widget
- Services/products → pre-populated in products catalog
- Testimonials found → suggested for landing page content
- Social links → stored in business profile for email footers

**Implementation:**
- New API endpoint: POST /api/ai/scan-website
- Server-side fetch of the URL, extract text + CSS
- Send to Gemini: "Analyze this website and extract structured business data"
- Return structured JSON that pre-fills onboarding fields
- No scraping libraries needed — just fetch + regex/DOM parsing for colors

---

### T1.3 — AI Email Intake (2 days)

**What:** When a user connects Gmail, AI can scan their inbox and suggest contacts to import, or auto-create contacts from incoming emails.

**Onboarding Step (after Gmail connect):**
- "Would you like AI to help manage your inbox?"
- Three options:
  - **Auto-import:** New people who email you are automatically added as contacts
  - **Suggest only:** AI identifies potential leads and lets you approve before adding
  - **Off:** No inbox scanning, just use Gmail for sending
- This preference stored in business_profiles: email_intake_mode (auto/suggest/off)

**How it works (ongoing):**
- Background task (cron or on-demand) scans recent Gmail messages
- For each unique sender not already in contacts:
  - Extract: name, email, company (from signature), phone (from signature)
  - AI classifies intent: lead/inquiry, support request, personal, spam/newsletter
  - If auto mode: create contact + add "gmail-import" tag + classify lifecycle stage
  - If suggest mode: queue suggestion for dashboard ("AI found 5 new contacts in your inbox")
- Contact timeline shows the original email thread

**Settings:**
- Change intake mode anytime
- Exclude list: domains/addresses to never import (e.g., newsletters, noreply@)
- Import history: see what was imported, undo if needed

**Implementation:**
- New API: GET /api/email/gmail-scan (polls Gmail API for recent messages)
- New API: POST /api/email/intake/process (runs the AI classification)
- New API: GET /api/email/intake/suggestions (pending suggestions for dashboard)
- New API: POST /api/email/intake/approve (approve/reject suggestions)
- Dashboard widget: "AI found X new contacts" with approve/dismiss
- Gmail API: messages.list with q="is:inbox newer_than:1d"

---

### T1.4 — Brand Voice Engine (1-2 days)

**What:** AI learns the user's writing style from their sent emails and uses it for all generated content.

**Onboarding Step:**
- After Gmail connect: "Can I learn your writing style from your sent emails?"
- Yes → AI reads 20-30 recent sent emails, extracts style characteristics
- No → AI uses the persona style selected in T1.1

**What it learns:**
- Formality level (contractions, slang, professional language)
- Sentence length patterns (short and punchy vs. detailed)
- Greeting/closing style ("Hey" vs "Dear" vs "Hi there")
- Emoji usage (yes/no, frequency)
- Signature style
- Common phrases and expressions
- Tone (warm, direct, enthusiastic, reserved)

**How it's stored:**
- New table or field: brand_voice_profile (JSONB on business_profiles)
- Contains: style_summary (text description for LLM), sample_phrases, formality_score, avg_sentence_length, uses_emoji, greeting_style, closing_style

**Where it's applied:**
- Email drafts (compose modal)
- Sequence email content
- Landing page copy generation
- AI chat responses
- Campaign content
- Any AI-generated text

**Implementation:**
- New API: POST /api/ai/learn-voice — fetches sent emails from Gmail, sends to Gemini with analysis prompt
- Returns style profile, stored in business_profiles.brand_voice
- All AI endpoints include the voice profile in their system prompts
- Settings: "Retrain voice" button, manual style notes ("I never use the word 'synergy'")

---

### T1.5 — Journey Mode (B2C Pipeline) (2 days)

**What:** For B2C businesses, the pipeline tracks contacts directly instead of separate deal objects. Simpler mental model.

**Onboarding Step:**
- AI auto-detects from business type, or asks: "How do your customers typically buy?"
  - "They go through a sales process (proposals, negotiations)" → Deal Mode
  - "They just buy/sign up directly" → Journey Mode
- Stored in business_profiles: pipeline_mode (deals/journey)

**What changes in Journey Mode:**
- Pipeline/Kanban shows contacts directly, not deals
- No "Create Deal" button — contacts just move through stages
- Stage labels change (Prospect → Customer → Repeat → VIP)
- Contact side panel: no Deals tab, stage is shown prominently in Details
- Dashboard: "Customer Journey" instead of "Sales Pipeline"
- Reports: customer lifecycle metrics instead of deal metrics
- Automations: triggers are stage-based on contacts, not deals

**What stays the same:**
- The pipeline_stages table/config — same data, different labels
- Tags, notes, tasks, timeline — all work the same
- Email, sequences, automations — all work the same
- Invoices, payments — work the same

**Implementation:**
- Read pipeline_mode from business_profiles at page load
- Contacts page: if journey mode, show stage column + allow drag to change stage
- Pipeline page: if journey mode, query contacts by lifecycle_stage instead of deals
- Kanban board: render contacts instead of deals
- Hide deal-related UI in journey mode (Create Deal button, Deals tab)
- Add lifecycle_stage management to contact detail panel

**Settings:**
- Switch between modes (with warning: "Switching modes won't delete your deals, but they'll be hidden")

---

### T1.6 — Email Sentiment Monitor (1 day)

**What:** AI reads incoming emails and flags negative sentiment on the dashboard.

**How it works:**
- When an email is received (Gmail sync or webhook), AI classifies sentiment: positive, neutral, negative, urgent
- Negative/urgent emails surface as priority action items on the dashboard
- "Warning: Mike's email sounds frustrated — he mentioned 'disappointed' and 'not what I expected'"
- One-click actions: "View email", "Draft response", "Create task"

**Implementation:**
- Extend the Gmail scan / email intake process
- Add sentiment field to email_messages table (or a separate email_sentiment table)
- New API: POST /api/ai/classify-sentiment — send email body to Gemini, get classification
- Dashboard: new "Needs Attention" section above action items for negative-sentiment emails
- Settings: toggle on/off

---

## Tier 2: Deepens the Value

### T2.1 — Smart Digest (Weekly AI Review) (1 day)

**What:** Weekly email/notification with AI-narrated business review.

**Sent every Monday morning (configurable):**
- Revenue this week vs last week
- New leads, deals won/lost
- Contacts going cold (relationship decay)
- Best-performing email/campaign
- 3 specific action items for the week
- Written in the user's AI persona style

**Implementation:**
- Cron job: POST /api/ai/digest/generate (runs weekly)
- Queries CRM data, sends to Gemini for narrative generation
- Sends via user's connected email (to themselves)
- Settings: frequency (daily/weekly/off), day of week

---

### T2.2 — Meeting Prep Brief (1 day)

**What:** Before any calendar event with a CRM contact, AI generates a prep brief.

**Triggers:** 1 hour before a calendar event that has an attendee matching a CRM contact

**Brief contains:**
- Contact summary (role, company, lifecycle stage, engagement score)
- Relationship timeline (last 5 interactions)
- Active deals/projects
- Last email exchange summary
- Talking points (AI-generated based on context)
- Suggested ask or next step

**Implementation:**
- Cron checks upcoming calendar events (next 2 hours)
- Match attendee emails to CRM contacts
- Generate brief via Gemini
- Deliver as: dashboard notification + optional email
- Settings: toggle on/off, delivery method, lead time

---

### T2.3 — AI Task Templates (Client Onboarding Checklists) (1 day)

**What:** When a deal is won or a customer reaches a certain stage, AI auto-creates a task checklist.

**Onboarding Step:**
- "What do you typically do after getting a new client?"
- User describes their process in free text
- AI converts to a reusable task template

**How it works:**
- task_templates table: org_id, name, trigger (deal_won/stage_change/manual), tasks_json
- When triggered: auto-create tasks linked to the contact with due dates relative to trigger date
- AI generates initial templates from business type + user description
- User can edit/add/remove tasks in the template

**Implementation:**
- New table: task_templates
- API: CRUD for templates + trigger execution
- Automation integration: add "create_task_template" as an action type
- Settings: manage templates

---

### T2.4 — Conversational CRM Updates (2 days)

**What:** User types or speaks a natural language update, AI parses it into CRM actions.

**Examples:**
- "Just met with Sarah, she wants the premium package by Friday" → updates contact, moves deal stage, creates task
- "Add John Smith, john@acme.com, he's interested in coaching" → creates contact, adds to pipeline
- "Send a follow-up to everyone who came to the webinar" → suggests/drafts campaign

**Where it lives:**
- The existing AI assistant floating chat — enhanced to understand CRM commands
- Future: voice input via Web Speech API (browser built-in, no cost)

**Implementation:**
- Enhanced AI system prompt with CRM action schema
- AI returns structured JSON: { actions: [{ type: "create_contact", data: {...} }, { type: "move_deal", data: {...} }] }
- Frontend parses actions, shows confirmation: "I'll do these 3 things: [list]. Confirm?"
- User confirms → actions execute via existing APIs
- Voice: add microphone button to chat, use browser SpeechRecognition API → text → same flow

---

### T2.5 — Relationship Decay Alerts (1 day)

**What:** AI monitors communication frequency and alerts when relationships are going cold.

**How it works:**
- For each contact with >3 past interactions, calculate average communication frequency
- If current gap exceeds 2x the average: flag as "going cold"
- Dashboard section: "Relationships needing attention" with draft follow-up button
- Severity: yellow (1.5x gap), red (2x+ gap)

**Implementation:**
- Cron job analyzes email_messages + contact_notes frequency per contact
- Stores decay score in contact_engagement_scores (new field: decay_risk)
- Dashboard widget queries contacts with high decay risk
- AI drafts personalized check-in based on last interaction context

---

### T2.6 — Client Onboarding Checklists (extends T2.3) (1 day)

**What:** Visual checklist UI on contact detail for post-sale workflows.

**How it surfaces:**
- Contact side panel: new "Checklist" section when a template is active
- Progress bar showing completion
- Due dates with overdue highlighting
- One-click task completion
- Auto-triggered when deal moves to "Won" or contact reaches target stage

---

## Onboarding Flow (Revised)

The new onboarding replaces the current 5-step wizard with an AI-powered conversational setup:

```
Step 1: "Tell me about your business"
  - Business name, type, description
  - Website URL (optional — triggers scan)
  - AI persona choice (name + style)
  [If website provided: AI scans and pre-fills]

Step 2: "How do you work with customers?"
  - Pipeline mode: sales process (deals) vs direct purchase (journey)
  - Pipeline stages: AI suggests based on business type, user edits
  - Client onboarding tasks: describe your post-sale process
  [AI generates pipeline + task templates]

Step 3: "Connect your accounts"
  - Connect Gmail (covers email + calendar)
  - Connect Stripe (for payments)
  - Connect Twilio (for SMS, optional)
  - Email intake preference: auto/suggest/off
  - Brand voice: learn from sent emails? yes/no
  [Connections happen via OAuth]

Step 4: "Review your setup"
  - Shows everything AI configured:
    - Pipeline stages
    - Automations created
    - Task templates
    - AI persona preview
    - Brand colors (from website)
  - User can edit any item before confirming
  - "Looks good" → applies everything

Step 5: "You're ready"
  - AI-generated action plan: 3-5 specific first tasks
  - If email intake is on: "I found X contacts in your inbox — review them?"
  - Quick links to key features
  - AI persona greets them by name in the chat
```

## UI/UX Integration

**Principle: AI is ambient, not in-your-face.**

The AI should feel like a helpful colleague who's always available but never interrupts unnecessarily. Here's how each feature integrates:

| Feature | Where It Lives | How User Discovers It |
|---|---|---|
| AI Persona | Chat widget, dashboard, all AI outputs | Set during onboarding, always present |
| Website Scan | Onboarding step 1 | Automatic when URL provided |
| Email Intake | Dashboard widget, background | Configured in onboarding, suggestions appear naturally |
| Brand Voice | Invisible (applied to all AI output) | Set during onboarding, "retrain" in settings |
| Journey Mode | Pipeline page, contact detail | Set during onboarding, switch in settings |
| Sentiment Monitor | Dashboard "Needs Attention" section | Appears automatically when negative emails arrive |
| Smart Digest | Email to user | Configured in settings, first one sent after 1 week |
| Meeting Prep | Notification before meetings | Automatic based on calendar |
| Task Templates | Contact side panel checklist | Created during onboarding, triggered automatically |
| Conversational Updates | AI chat widget | User discovers by chatting naturally |
| Relationship Decay | Dashboard + notifications | Appears automatically when relationships go cold |
| Onboarding Checklists | Contact detail panel | Auto-attached when deal won or stage reached |

**Nothing requires a new page or new navigation item.** Everything integrates into existing surfaces.

## Settings Page Updates

Add to existing Settings page:

```
AI & Automation
  ├── AI Persona: name, style, custom instructions
  ├── Brand Voice: retrain, manual style notes
  ├── Email Intake: mode (auto/suggest/off), exclude list
  ├── Sentiment Alerts: on/off
  ├── Smart Digest: frequency, delivery day
  ├── Meeting Prep Briefs: on/off, lead time
  └── Pipeline Mode: deals vs journey (with warning on switch)
```

## Gaps Identified

1. **No data enrichment source** — AI intake creates contacts from email but can't enrich them (company size, industry, LinkedIn) without a data provider API. For now: extract what we can from email signatures. Add paid enrichment later.

2. **Gmail polling frequency** — We need a cron job to poll Gmail. How often? Every 5 minutes is reasonable. Push notifications would require Google Pub/Sub setup (more complex, do later).

3. **Voice input browser support** — Web Speech API works in Chrome/Edge but not Firefox/Safari (Safari has partial support). Should degrade gracefully to text-only.

4. **Journey mode migration** — If a user switches from deal mode to journey mode, existing deals don't disappear but are hidden. Need clear messaging about this.

5. **Brand voice cold start** — New users without Gmail connected or with few sent emails won't have enough data. Fallback: use persona style + business type defaults until enough data accumulates.

6. **Sentiment false positives** — AI might flag sarcasm or casual negativity incorrectly. Include "Not actually negative" dismiss button and use that feedback to improve.
