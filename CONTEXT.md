# CRM Platform Build — Project Context

> This file captures all research, decisions, and plans from the initial exploration conversation (2026-03-24). Load this file in future conversations to resume from this exact point.

---

## 1. What We're Building

A standalone CRM platform built on **Open Mercato** (MIT license) that serves as the front door to Wesley's integrated platform for his entrepreneurship program. The CRM connects to two other systems Wesley is building:

- **Blog-Ops** (`~/Desktop/blog-ops`) — Automated marketing operations (content pipeline, email sequence generation, competitive intelligence, paid ads, multi-platform repurposing)
- **LaunchBot** (`~/Desktop/AI-Agent-Main`) — Multi-tenant AI agent platform built on OpenClaw. Each user gets their own AI assistant in a Docker container with switchable skill modes

**The value proposition:** Program members get a free/low-cost CRM that's dead simple to use, with integrated AI assistance (LaunchBot) and automated marketing (Blog-Ops). This combination doesn't exist as an off-the-shelf product.

---

## 2. Why Open Mercato

### What it is
Open-source CRM/ERP framework. MIT license. ~1,100 GitHub stars. Next.js App Router + MikroORM + PostgreSQL + Redis + Meilisearch + shadcn/ui.

**GitHub:** https://github.com/open-mercato/open-mercato
**Docs:** https://docs.openmercato.com/
**Demo:** https://demo.openmercato.com/ (password: `secret`)

### Why it was selected over alternatives

| Option | Why Not |
|--------|---------|
| **Twenty CRM** | Best UI/UX in the space, but AGPL license prevents proprietary whitelabeling. Used as **design reference only** — study the UI, implement your own code. Do NOT copy Twenty's source code. |
| **NextCRM** | MIT license, same-ish stack as Blog-Ops (Prisma/Next.js/shadcn), but messy codebase (3 toast libraries, 4 icon libraries, inconsistent naming), no multi-tenancy, beta quality. Cherry-pick Prisma schema concepts and UI component ideas only. |
| **erxes** | AGPL + explicit anti-competitive-SaaS clause. No multi-tenancy. MongoDB. Eliminated. |
| **Frappe CRM** | Python/Vue stack, AGPL. Wrong ecosystem. |
| **SaaS Boilerplate (ixartz)** | Good infra (Clerk auth, multi-tenancy, Stripe) but empty CRM — only 2 DB tables. Blog-Ops already provides what this offers. |
| **Atomic CRM** | MIT, very lean (15k LOC, React + Supabase), but too minimal as a starting point. Good reference for clean design. |
| **GoHighLevel** | Current solution ($497/mo whitelabel). Too complex for program members. No integration with Blog-Ops/LaunchBot. Commodity product. |

### What Open Mercato provides out of the box

**CRM Modules (already built):**
- **Customers** (16 tables) — People, companies, deals, pipelines (Kanban), activities, comments, tags, addresses, to-dos, dashboard widgets
- **Sales** (27 tables) — Quotes → Orders → Invoices → Payments lifecycle
- **Workflows** (6 tables) — Visual workflow editor, state machines, event triggers, user tasks
- **Dashboards** (3 tables) — Configurable dashboards with module-contributed widgets
- **Notifications** (1 table) — Real-time via SSE, severity levels, actions
- **Messages** (5 tables) — Internal messaging, threaded conversations, email forwarding
- **InboxOps** (5 tables) — AI-powered email ingestion via webhooks

**Infrastructure:**
- Multi-tenancy with hierarchical organizations (built-in, first-class)
- RBAC with two-layer permissions (role + user overrides)
- Stripe payment gateway (`gateway-stripe` package)
- Meilisearch integration (fulltext + vector search)
- Background job processing (BullMQ via Redis)
- Event system (pub/sub, async processing, SSE to browser)
- CLI tools for scaffolding, migrations, module management
- AI-native development (AGENTS.md files throughout, 60+ specs)

---

## 3. Open Mercato's Module System

### How it works
Each feature is a self-contained module folder with a standard structure. The framework auto-discovers and wires everything.

### Module file structure
```
src/modules/<module_id>/
  index.ts              # Metadata + command imports
  acl.ts                # RBAC feature declarations
  di.ts                 # Awilix dependency injection
  setup.ts              # Default role-feature mappings
  events.ts             # Event declarations
  ce.ts                 # Custom entity/field declarations
  data/
    entities.ts          # MikroORM entity classes
    validators.ts        # Zod schemas
    extensions.ts        # Entity extensions (add fields to other modules' entities)
    enrichers.ts         # Response enrichers for other modules' APIs
  services/              # Business logic
  commands/              # Command handlers (write operations)
  api/<path>/route.ts    # REST API endpoints
  backend/<path>/page.tsx    # Admin UI pages
  frontend/<path>.tsx        # Customer-facing pages
  widgets/
    injection/           # UI injected into other modules
    injection-table.ts   # Spot ID → Widget ID mappings
    dashboard/           # Dashboard KPI widgets
    components.ts        # Component overrides
  subscribers/           # Event subscriber handlers
  migrations/            # MikroORM migrations
  i18n/                  # Translations
```

### Key capabilities
- **Widget injection:** Module A injects UI into Module B without touching B's code. Injection spots: crud-form, data-table (header/footer/columns/row-actions/bulk-actions/filters), sidebar, topbar, layout.
- **Event system:** Modules communicate via events. CRUD factory auto-emits events. Subscribers can be inline or async (queued). SSE bridges events to browser.
- **Entity extensions:** Add data to another module's entities via separate extension tables + `defineLink()`. Core entities stay untouched.
- **CRUD factory:** `makeCrudRoute()` generates full REST API with multi-tenant scoping, Zod validation, RBAC, pagination, soft deletes, caching, event emission, search indexing, CSV/JSON/XML export.
- **Overlay system:** App-level files override package files at the same path. Customize any core module page/component without forking.
- **Commands:** Write operations go through command bus with audit logging.

### Creating a module
1. Create folder in `src/modules/<id>/`
2. Add `index.ts` with metadata
3. Add `acl.ts` with permissions
4. Enable in `src/modules.ts`
5. Run `yarn generate`
6. Add entities, API routes, pages, widgets as needed
7. Run `yarn db:generate && yarn db:migrate`

---

## 4. Feature Priorities

### Essential (MVP — Phases 1-2, ~9 weeks)

| Feature | Status in Open Mercato | What to Build |
|---------|----------------------|---------------|
| CRM & Contacts | **Exists** (customers module) | UI overhaul to Twenty aesthetic, cleanup |
| Email (full system) | **Partial** (messages + InboxOps) | New module: IMAP sync, Resend/Postmark sending, campaigns, tracking pixels, deliverability (SPF/DKIM/DMARC) |
| Landing Pages | **Not exists** | New module: Puck editor + Wesley's HTML templates as components, custom domain routing, form builder, form → contact creation |
| Multi-tenancy | **Exists** | Validate and customize onboarding flow |
| Blog-Ops Integration | **Not exists** | New module: REST API client to Blog-Ops, contact sync, email sequence triggering, content pull |
| LaunchBot Integration | **Not exists** | New module: REST API for agents to read/write CRM data, webhook receiver, "Ask AI" widget |
| Credit Billing | **Partial** (Stripe gateway exists) | Extend: credit balance system, usage metering, Stripe credit purchases |

### Nice to Have — Tier 1 (Weeks 10-16)
- SMS (Twilio, 1 week)
- Pipeline enhancements (stage automations, conversion tracking, 1 week)
- Invoicing simplification (strip sales module to invoices + payment links, 1-2 weeks)
- AI features (email writer, lead scoring, landing page chatbot, 1-2 weeks)

### Nice to Have — Tier 2 (Weeks 17-24)
- Workflow templates and enhancements (2-3 weeks)
- Calendar & booking (2-3 weeks)
- Reporting & analytics (1-2 weeks)
- Reputation management (1-2 weeks)

### Nice to Have — Tier 3 (Weeks 25-30)
- Phone system with Twilio Voice (2-3 weeks)
- Courses & memberships (3-4 weeks)

### Excluded
- Social media (Wesley has a separate system)
- Documents & proposals
- Full agency whitelabel/reselling

---

## 5. UI Design Direction

**Reference:** Twenty CRM (https://twenty.com, demo available)
**Approach:** Study Twenty's UI in the browser. Implement the look using shadcn/ui + Tailwind. Do NOT copy Twenty's code (AGPL).

**Key patterns to implement:**
- Minimalist layout with generous whitespace
- Side panel (record detail alongside list view, not full-page navigation)
- Notion-like record pages (timeline, blocks of content)
- Command palette (Cmd+K) — Open Mercato may already have cmdk
- Keyboard shortcuts throughout
- Clean data tables with inline editing (TanStack Table)
- Kanban board for pipeline (dnd-kit or similar)
- Smooth transitions, skeleton loading states
- Dark mode
- Inter font family

**Implementation:** Use Open Mercato's overlay system — create app-level files that override core layout/page components.

---

## 6. Integration Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    USER'S WORKSPACE                       │
│                                                          │
│  ┌─────────────────┐    REST API       ┌──────────────┐  │
│  │   CRM            │◄───────────────►│  Blog-Ops     │  │
│  │  (Open Mercato)  │                  │  (Marketing)  │  │
│  │                  │  ┌───────────┐   │              │  │
│  │  • Contacts      │  │ LaunchBot │   │  • Content   │  │
│  │  • Deals         │◄►│ (AI Agent)│◄─►│  • Sequences │  │
│  │  • Landing Pages │  │           │   │  • Intel     │  │
│  │  • Email         │  └───────────┘   │  • Ads       │  │
│  │  • Workflows     │                  │              │  │
│  └────────┬─────────┘                  └──────────────┘  │
│           │                                              │
│     Stripe (Credits)                                     │
│     Twilio (SMS/Phone)                                   │
│     Resend (Email delivery)                              │
└──────────────────────────────────────────────────────────┘
```

**Key data flows:**
1. Landing page form → CRM contact → event → LaunchBot notified → Blog-Ops email sequence triggered
2. User asks LaunchBot "how are my leads?" → agent calls CRM API → pipeline summary
3. Blog-Ops generates content → surfaces in CRM for user review
4. Deal marked "Won" → workflow → review request email → reputation tracking
5. All usage (email, SMS, AI) → billing module deducts credits

**Blog-Ops integration module:**
- REST client calling Blog-Ops 176 endpoints
- Contact sync (bidirectional)
- Email sequence triggering
- Content pull for review/approval
- Event bridge via webhooks

**LaunchBot integration module:**
- REST API endpoints agents call: GET /api/launchbot/contacts, deals, pipeline-summary
- POST endpoints: activities, deal updates, email triggers
- Auth via per-tenant API key
- Webhook receiver for agent events (task complete, artifact generated)
- "Ask AI" widget injected into contact/deal detail pages

---

## 7. Billing Model

**Credit-based system:**
- Users add credits via Stripe (e.g., $10, $25, $50 increments)
- Usage deducted per action:
  - Email sent: ~$0.005
  - SMS sent: ~$0.02
  - Phone minute: ~$0.03
  - AI interaction: ~$0.05
  - Landing page hosting: included
  - CRM core features: included
- Low balance notifications
- Optional: free tier with monthly credit allowance

**Infrastructure costs:**
- 10 users: ~$60-80/mo
- 50 users: ~$80-120/mo
- 100 users: ~$120-200/mo
- 500 users: ~$300-500/mo
- Usage credits offset/exceed infra costs at ~50+ users

---

## 8. Strategy

1. **Keep GHL running** for current program members during build
2. **Build MVP** (Phases 1-2, ~9 weeks): CRM + landing pages + email + integrations + billing
3. **Beta test** with 5-10 program members
4. **Migrate** remaining members when stable
5. **Cancel GHL** after full migration
6. **Iterate** on Tier 1-3 nice-to-haves based on real user feedback, not assumptions

---

## 9. Open Mercato Validation Results (2026-03-24)

### Enterprise vs MIT — RESOLVED
All CRM-critical features are MIT-licensed. Enterprise package only contains: MFA/2FA, SAML/OIDC SSO, pessimistic record locking, system status overlays. None needed for MVP.

### Customers Module — VALIDATED
Production-grade. 16 entities, polymorphic contact model, rich fields (job title, seniority, LinkedIn, timezone), full deal tracking with participant roles, dictionary-driven picklists, 6 partial DB indexes, 224KB+ of CQRS business logic with undo/redo, 14 API resource directories, 4 dashboard widgets, 45KB of tests.

### Auth & Signup — VALIDATED
Two separate auth systems (staff + customer). Customer auth has: self-service signup, email verification, magic links, invitation flow, account lockout, CRM auto-linking. Portal module provides customer-facing dashboard. This is exactly what program members need.

### Deployment — VALIDATED
- Requires Node 24 + PostgreSQL 17 (minimum)
- Redis and Meilisearch optional with working fallbacks
- Cannot deploy on Vercel (needs persistent processes for workers)
- Single server deployment is fine for our scale
- Workers handle: search indexing, event processing, workflow execution, email operations, scheduled tasks

### Community — VALIDATED
- Founded by Piotr Karwatka (Vue Storefront founder, Y Combinator, raised $40M)
- 70 contributors, 5-8 regularly active, weekly releases
- Discord server active, issues triaged within 1-3 days
- Bus factor ~1.5 (mitigated by MIT license — we fork and own the code)
- Pre-v1.0 (v0.4.x) — breaking changes possible, but forking protects us

### Deployment Decision — Hetzner (same server as LaunchBot)
CRM will run as a Docker container on Wesley's existing Hetzner test server (8 vCPU / 16GB RAM, Ubuntu 24.04) alongside 2 LaunchBot test instances. CRM needs ~1.5-3GB RAM, leaving plenty of headroom.

```
Hetzner VPS (8 vCPU / 16GB RAM)
├── Docker: LaunchBot user containers (2 test instances)
├── Docker: CRM (Next.js app + workers)
├── Docker: PostgreSQL 17 + pgvector (shared)
├── Docker: Redis 7 (shared)
└── Nginx/Caddy reverse proxy
    ├── crm.domain.com → CRM
    ├── *.pages.domain.com → Landing pages
    └── LaunchBot routes → containers
```

## 10. Open Questions (Remaining)

- [ ] Auth strategy: CRM has its own auth (customer_accounts). Blog-Ops uses Supabase Auth. Do users need one login across systems or are they separate? Simplest: CRM is the only user-facing login, Blog-Ops is backend-only (API calls), LaunchBot provisioned via CRM signup.
- [ ] Landing page domain routing: Nginx wildcard vs Cloudflare Workers vs custom proxy on Hetzner
- [ ] Email architecture: Provider (Resend vs Postmark vs SES), shared vs per-tenant sending domain, IMAP sync vs webhook-based receiving
- [ ] Email handoff with Blog-Ops: Blog-Ops generates sequence content → CRM sends it? Or CRM has its own composition?
- [ ] Landing page templates: Need to review Wesley's HTML templates to determine Puck integration approach
- [ ] LaunchBot container provisioning: Does CRM signup auto-provision a LaunchBot container?
- [ ] Blog-Ops multi-tenancy: Does each CRM user get a Blog-Ops org, or is it service-level?
- [ ] User journey: What's the signup → onboarding → "aha moment" flow?
- [ ] Talk to program members: What GHL features do they actually use?
- [ ] Mobile experience: PWA sufficient or need native app?

---

## 10. Key Resources

| Resource | URL/Path |
|----------|----------|
| Open Mercato GitHub | https://github.com/open-mercato/open-mercato |
| Open Mercato Docs | https://docs.openmercato.com/ |
| Open Mercato Demo | https://demo.openmercato.com/ (password: `secret`) |
| Twenty CRM (design reference) | https://twenty.com |
| Puck Editor (landing pages) | https://github.com/puckeditor/puck |
| Blog-Ops codebase | /Users/wesleyhansen/Desktop/blog-ops |
| LaunchBot codebase | /Users/wesleyhansen/Desktop/AI-Agent-Main |
| Blog-Ops schema | /Users/wesleyhansen/Desktop/blog-ops/prisma/schema.prisma |
| Blog-Ops build queue | /Users/wesleyhansen/Desktop/blog-ops/docs/build-queue.md |
| Blog-Ops vision | /Users/wesleyhansen/Desktop/blog-ops/docs/vision-marketing-intelligence.md |
| LaunchBot modes | /Users/wesleyhansen/Desktop/AI-Agent-Main/launchbot/modes/ |
| LaunchBot admin | /Users/wesleyhansen/Desktop/AI-Agent-Main/launchbot/admin/ |
| NextCRM (reference) | https://github.com/pdovhomilja/nextcrm-app |
| Atomic CRM (reference) | https://github.com/marmelab/atomic-crm |

---

## 11. Pre-Planning Checklist

### Resolved
- [x] Open Mercato enterprise vs MIT — all CRM features are MIT
- [x] Customers module quality — production-grade, validated
- [x] Auth supports self-service signup — yes, customer_accounts module
- [x] Multi-tenancy works — hierarchical orgs, first-class
- [x] Deployment target — Hetzner VPS, Docker, same server as LaunchBot
- [x] Can deploy on Vercel? — No (needs persistent workers), using Hetzner instead
- [x] Community health — credible founder, active development, acceptable risk
- [x] Hands-on test — skipped, analysis sufficient per Wesley
- [x] HTML templates reviewed — 55 templates, self-contained HTML/CSS, CSS variable theming, simpler than expected
- [x] Auth strategy — separate logins for each system (CRM, Blog-Ops, LaunchBot), connected via API keys
- [x] Email architecture — Resend, shared sending domain for MVP, webhook-based receiving, CRM owns all sending
- [x] Blog-Ops API — defer to Phase 2, define interface now, build when Blog-Ops API is ready
- [x] LaunchBot provisioning — completely separate, users connect via API key in CRM settings

### Landing Page Approach — REVISED
**Template variable system instead of Puck editor.** Templates are so well-structured (CSS variables, consistent sections, built-in forms) that a simpler approach works better:
1. User picks template category (lead magnet, booking, services, etc.)
2. User picks style (bold, dark, minimal, warm, etc.)
3. User fills in content form (business name, headline, CTA, colors, logo, form fields)
4. System injects values into HTML template placeholders + CSS variables
5. User previews → publishes
Estimated effort: 1-2 weeks (vs 2-3 for Puck). Puck can be added later for power users.

### Email Handoff Model — DECIDED
Blog-Ops generates email content (subject, body, timing). CRM's email module is the sending engine. CRM receives content via API and delivers via Resend. Keeps deliverability in one place.

### Still to Decide (Can Iterate During Build)
- [ ] User journey mapping (signup → onboarding → aha moment)
- [ ] Talk to 3-5 program members about what they actually use in GHL
- [ ] Landing page domain routing approach (Nginx wildcard vs Cloudflare)
- [ ] Blog-Ops multi-tenancy model (per-user org or shared?)
- [ ] Mobile strategy (PWA vs native)
- [ ] Meilisearch vs skip for MVP
- [ ] Specific Stripe credit tier pricing
- [ ] Which workflow templates to pre-build

## 12. HTML Landing Page Templates

**Location:** /Users/wesleyhansen/Desktop/High level Templates/
**Count:** 55 templates across 8 categories

| Category | Templates | Purpose |
|----------|-----------|---------|
| lead-magnet-* | bold, dark, minimal, warm | Email capture for free resources |
| booking-* | bold, dark, minimal, noir, teal, warm | Consultation/appointment booking |
| webinar-* | bold, dark, noir, teal, warm | Event registration |
| saas-* | template-light, template-noir, terminal, vercel | Software product pages |
| services-* | art-deco, dark-luxe, stripe, superhuman, template-corporate, template-warm | Professional services |
| physical-product-* | apple, bold, nordic, shopify, warm | E-commerce products |
| info-product-* | editorial, glass, gumroad, notion, pastel | Digital products/courses |
| systems-* | brutalist, cyberpunk, figma, linear, noir | Unique themed pages |
| experiences-* | airbnb, editorial, organic, pastel, raycast | Experience-based pages |
| page-* / thank-you-* | booking, lead-magnet, privacy, terms, thank-you, waitlist, webinar | Utility pages |

**Structure (consistent across all):**
- Single self-contained `index.html` per template
- No external frameworks (no Tailwind, Bootstrap, React)
- CSS variables in `:root` for theming (colors, fonts, spacing, radius)
- Google Fonts loaded via CDN
- Semantic HTML sections: nav → hero → features/benefits → testimonials → CTA → FAQ → footer
- 30 of 55 have built-in forms (email + name fields, submit handling)
- All responsive with fluid typography (`clamp()`)
- Vanilla JS for mobile nav, smooth scroll, form handling

**Integration approach:** Template variable injection system, NOT drag-and-drop editor. Change `:root` CSS variables + inject text content into placeholder elements. Much simpler and better UX for non-technical users.

---

## 13. Build Progress

**Full detailed build plan:** `/Users/wesleyhansen/Desktop/CRM/BUILD-PLAN.md`

### Completed (2026-03-24)
- [x] 1.1 Fork & clone — github.com/wesleybhansen/crm (renamed 2026-04-07 from wesleybhansen/open-mercato), upstream remote set
- [x] 1.2 Strip modules — 43→32 modules (28 core + 4 custom), ~165 API routes
- [x] 1.5 Theme — Inter font, Twenty-inspired light mode, Twenty exact dark mode palette
- [x] 1.4 Self-service signup — branding updated, dev email bypass, login link added
- [x] 2.1 Landing Pages module — entities, template engine (55 templates), CRUD API, public serving, form submission API
- [x] 2.2 Email module — entities, Resend sender service, send/list API, open/click tracking endpoints
- [x] 2.3 Integration APIs module — ext contacts, deals, pipeline summary, dashboard KPIs
- [x] 2.4 Billing module — entities, credit service, balance/transactions API, 3 credit packages seeded
- [x] Database — all tables created (landing_pages, landing_page_forms, form_submissions, email_accounts, email_messages, email_templates, email_campaigns, email_campaign_recipients, email_unsubscribes, credit_balances, credit_transactions, credit_packages)

### Technical Notes
- App-level modules use Knex (raw SQL) instead of MikroORM entities due to Turbopack not supporting emitDecoratorMetadata. Entity schemas kept in data/schema.ts for reference.
- Entity files renamed to schema.ts to avoid MikroORM auto-discovery by the generator.
- Templates copied to apps/mercato/templates/ (55 HTML files)

### Also Completed
- [x] Auth context — all custom API routes now scope by tenant_id + organization_id from ctx.auth
- [x] Frontend pages — Landing Pages list + create (template picker + editor), Email inbox, Billing (balance + packages + transactions)
- [x] Ext API paths — routes at /api/integrations_api/ext/* (contacts, deals, pipeline/summary, dashboard/summary)

### ALL FEATURES BUILT (2026-03-25) — MVP + 25 GAP FEATURES

Every feature from the original vision PLUS 25 additional gap features are implemented.

**CRM Core:**
- [x] Contacts — merged People/Companies, side panel with Timeline/Details/Notes/Tasks tabs
- [x] Contact Activity Timeline — unified view from 11 data sources (emails, forms, notes, tasks, invoices, bookings, SMS, courses, tags, engagement)
- [x] Contact Engagement Scoring — auto-score (+1 open, +3 click, +5 form, +10 paid, -5 unsub), Hot/Warm/Cold labels, Hottest Leads dashboard widget
- [x] File Attachments on contacts — upload/download/delete
- [x] Reminders — "Remind Me" on contacts with date picker, email notification via cron
- [x] Cross-Entry Duplicate Detection — email-based dedup across all entry points, manual merge API
- [x] Pipeline — Kanban board, customizable stages per business type
- [x] Deals — create from contact side panel
- [x] Tags — colored, add/remove, auto-create
- [x] Contact import (paste CSV) + export (download CSV)
- [x] Lead Source Tracking — UTM param capture on landing pages, source breakdown API

**Automations:**
- [x] Stage automations — trigger email/task/update when deal moves
- [x] Simple Automations / Rules Engine — 9 trigger types × 8 action types, execution logging, UI builder
- [x] Drip/Follow-up Sequences — 6 step types (email, SMS, wait, condition, branch, goal)
- [x] Automation Branching — if opened/clicked/has tag → path A or B, goal tracking
- [x] Pre-Built Automation Recipes — 8 one-click templates with pre-written emails
- [x] Auto-enrollment triggers — wired into form submissions, tag assignments

**Email Marketing (Mailchimp-level):**
- [x] Email compose with AI drafts (6 purpose types) + Quick Response Templates
- [x] Email campaigns with 10 styled HTML templates + AI template generator
- [x] Template picker with visual grid, AI-generated custom templates
- [x] Subject Line Optimizer — AI scores 1-10, suggests 3 alternatives
- [x] Send Test Email — preview in your inbox before sending
- [x] Email Preference Center — category-based opt-down instead of binary unsubscribe
- [x] Email Deliverability & Health — bounce/complaint handling, auto-suppression, health metrics
- [x] Send Time Optimization — track open times, per-contact best hour
- [x] Unified Inbox — threaded email + SMS conversations, two-panel layout

**Marketing:**
- [x] AI Landing Page Builder — 49 templates, wizard, Gemini generates copy
- [x] Multi-Step Funnels — chain pages (opt-in → upsell → checkout → thank you), conversion analytics
- [x] SMS — Twilio send/receive from contact detail
- [x] Courses & memberships — modules, lessons, drip, public enrollment
- [x] Survey & Form Builder — 12 field types (incl. rating/NPS), public pages, response analytics, embeddable
- [x] Outbound Webhooks — 9 event types, HMAC signatures, retry logic, delivery logs (Zapier/Make compatible)

**Live Chat:**
- [x] Embeddable chat widget — JS snippet for any website, floating bubble, real-time messaging
- [x] Chat Inbox — two-panel UI, conversation management, auto-create contacts

**Affiliates:**
- [x] Affiliate Manager — referral links, 30-day cookie attribution, commission tracking, public dashboard, payouts, leaderboard

**Payments:**
- [x] Products/services catalog, Invoices with line items, Stripe checkout, payment links, invoice emails

**Calendar:**
- [x] Booking pages, public booking, conflict detection, Google Calendar OAuth, .ics feed

**AI:**
- [x] AI Assistant floating chat, AI dashboard action items + Hottest Leads widget
- [x] AI email drafts, Subject Line Optimizer, AI email template generator, AI survey generation
- [x] AI landing page generation, AI onboarding pipeline suggestions
- [x] AI usage cap (500/month) + BYOK fallback

**Infrastructure:**
- [x] Simple/Advanced mode toggle, Settings page, Business profile persistence
- [x] Reports page, Dark mode (Twenty palette), First-login redirect
- [x] ~60+ database tables (30+ custom + Open Mercato core)

### Current Sidebar (Simple Mode)
```
Dashboard          — AI action items, KPIs, Hottest Leads, activity feed
CRM
  → Contacts       — timeline, engagement scores, files, reminders, tags, import/export
  → Pipeline       — Kanban deal board
  → Payments       — Products & Invoices, Stripe
  → Calendar       — Booking pages, Google Calendar sync
  → Automations    — rules engine (when X → do Y)
  → Chat           — live chat inbox
  → Affiliates     — referral tracking, commissions
Marketing
  → Landing Pages  — AI builder, 49 templates
  → Funnels        — multi-step conversion funnels
  → Inbox          — unified email + SMS conversations
  → Campaigns      — styled email templates, AI drafts, testing
  → Courses        — courses, modules, lessons
  → Sequences      — drip sequences, branching, 8 recipes
  → Surveys        — form builder, public pages, analytics
Settings           — theme, mode, calendar, integrations, BYOK, AI usage
+ AI Assistant     — floating chat on every page
```

### Architecture Decision: User-Connected Integrations (2026-03-26)

**All external services are user-connected, not platform-level.** Each user connects their own accounts. Platform pays $0 for email, payments, or SMS infrastructure.

**Email — hybrid model (same as HubSpot/GHL):**
- **1:1 emails, sequences, invoices, booking confirmations** → sent through user's connected Gmail or Outlook (appears in their Sent folder, trusted sender reputation, zero deliverability management)
- **Bulk campaigns** → user brings their own ESP API key (Resend, SendGrid, SES, Mailgun) — only needed for lists exceeding Gmail/Outlook daily limits
- **Fallback** → generic SMTP connection for users with other providers

**Payments** → Stripe Connect (user connects their own Stripe account via OAuth, money goes directly to them, platform can take optional application fee)

**SMS** → user enters their own Twilio credentials (account SID, auth token, phone number)

**Calendar** → Google OAuth already built, covers both Calendar sync AND Gmail email with one connection

```
Settings → Integrations
  ├── Email
  │   ├── Gmail         [Connect via Google OAuth]
  │   ├── Outlook       [Connect via Microsoft OAuth]
  │   └── SMTP          [Enter server details]
  ├── Bulk Sending (optional)
  │   └── ESP Provider  [Resend/SendGrid/SES/Mailgun + API key]
  ├── Payments
  │   └── Stripe        [Connect via Stripe Connect OAuth]
  ├── SMS
  │   └── Twilio        [Enter credentials]
  └── Calendar
      └── Google        [Already connected via Gmail OAuth]
```

### Remaining Before Launch
1. [x] Gemini — upgraded to paid tier
2. [ ] Gmail email integration (extend OAuth, send/receive via Gmail API)
3. [ ] Outlook/Microsoft email integration (Graph API OAuth)
4. [ ] Generic SMTP connection
5. [ ] Bulk ESP BYOK (Resend/SendGrid/SES/Mailgun API key storage)
6. [ ] Stripe Connect integration (user connects own Stripe)
7. [ ] Twilio per-user integration (user enters own credentials)
8. [ ] Integration Settings page (unified connection management)
9. [ ] Google Cloud project for OAuth (Wesley's action — covers Calendar + Gmail)
10. [ ] Deploy to Hetzner with Docker/Nginx/SSL
11. [ ] End-to-end testing
12. [ ] Mobile responsive CSS pass
13. [ ] LaunchBot skill definition (deferred to last)

**Key documentation files:**
- `SETUP-CHECKLIST.md` — step-by-step deployment guide
- `setup-tables.sql` — all custom database tables (~30+ tables)
- `.env.production.example` — every env var with docs
- `QUEUE.md` — prioritized task queue (all Priority 3 complete, Priority 2 in progress)

**AI provider:** Configurable via AI_PROVIDER env var. Default: Gemini (google). Options: google, anthropic, openai.
**AI cost model:** System-wide monthly cap (default 500/month) + BYOK fallback for unlimited.
**Platform cost model:** $0 for email/SMS/payments — all user-connected. Platform only pays for AI (Gemini) + hosting (Hetzner).

---

## 14. Clarifications from Wesley (2026-03-24)

- Blog-Ops **creates** email sequences but does **not send them**. Email deliverability must be built into the CRM.
- Blog-Ops content generation is built, but **publishing is not** (it's in Blog-Ops build queue).
- Blog-Ops partnership outreach **only generates lists** of potential partners. No contract management or outreach tracking.
- Wesley wants the CRM as a **standalone app**, not embedded in Blog-Ops.
- Different tech stacks across services are acceptable since they connect via APIs.
- Wesley is considering making the CRM **free** as a lead magnet for his entrepreneurship program.
- Users may need to add credits for usage-based costs (email, SMS, AI), but the core CRM would be free or very low cost.

## 15. Session 2026-04-07 — Marketing landing page deployed

The marketing landing page at `https://crm.thelaunchpadincubator.com/` is **live**. Built across a multi-day sprint that started with three competing mockups (editorial / bold / dark-tech) and converged on the dark Orchestra-style direction. The page is served as a static HTML file from `apps/mercato/public/landing.html` via a `proxy.ts` rewrite of `/` → `/landing.html`. URL stays clean.

### What's live
- **Landing page** at `/` — 14 sections including a hero, video player, pain cards, three-ways escapes, marquee, **CRM product showcase**, **AMS marketing showcase** (added end of session), stats, comparison, command center, manifesto, waitlist, footer
- **Auth pages** at `/login`, `/signup`, `/forgot-password`, `/reset-password` — restyled with shared `auth-shell.css` to match the dark landing page aesthetic. All existing logic preserved (multi-tenant org picker, RBAC, error handling, etc.)
- **Repo renamed** from `wesleybhansen/open-mercato` → `wesleybhansen/crm`. Server's `origin` remote updated. Local clones should run `git remote set-url origin https://github.com/wesleybhansen/crm.git` if not already.

### Critical infrastructure fixes shipped this session
1. **Standalone bundle missing static dir** (commit `c201e1222`) — Dockerfile now copies `.mercato/next/static` and `public` into the standalone bundle path. Without this, every `/_next/static/*` request returned 404 and CSS chunks didn't load.
2. **`middleware.ts` deprecated → `proxy.ts`** (commit `8c03f3d47`) — Next.js 16.1.5 deprecated middleware.ts. The project's existing `apps/mercato/src/proxy.ts` now also handles the `/` → `/landing.html` rewrite.
3. **Hero gradient extends to section divider** (commit `6a83cdfb2`) — removed `margin-top: 60px` from `.video-section` that was creating a black gap between the hero and the next section.

### Build queue items added (see `BUILD-QUEUE.md` items 33-35)
- **33** — Terms page: AI token overage responsibility clause
- **34** — Notification center in header (auto-notify panel showing AI activity)
- **35** — Auto contact source tagging on creation + interaction

### Where the full state lives
- **Landing page details:** Claude memory `project_landing_page.md` — section structure, design system, copy, animations, file locations
- **Deploy mechanics:** Claude memory `reference_deployment.md` — exact SSH commands, gotchas, do-not-do list
- **Where we left off / what to do next:** Claude memory `project_session_handoff.md`

## 16. Session 2026-04-08 — Tier 1 OAuth code complete + comprehensive landing polish

This session was a major sprint focused on (1) preparing the codebase for Google OAuth Tier 1 verification by removing the restricted `gmail.readonly` scope and disabling all Gmail-read code paths, (2) a comprehensive `LaunchOS → Launch OS` rebrand sweep across the entire codebase for verification brand consistency, (3) restyling the compare section in the AMS pattern with capability descriptions instead of brand names (trademark-safe), and (4) a long tail of copy iterations and a favicon addition.

### Why we removed `gmail.readonly`

Wesley's app was using these Google OAuth scopes: `calendar.readonly`, `calendar.events`, `gmail.send` (all sensitive), and `gmail.readonly` (**RESTRICTED**). Restricted scopes require Google's CASA Tier 2 security assessment ($5-15k assessor fees, 2-6 weeks, annual recertification). For a pre-launch waitlist product, that's unjustifiable cost and timeline. Wesley decided to drop `gmail.readonly` and pursue **Tier 1 (sensitive-only) verification** instead, which is ~3-6 weeks with no CASA cost. The inbox-read feature will be re-added later via an App Password / IMAP fallback path post-verification.

### Code changes — gmail.readonly removal

1. `apps/mercato/src/app/api/google/auth/route.ts` — removed `gmail.readonly` from `EMAIL_SCOPES`. Only `gmail.send` remains.
2. `apps/mercato/src/app/api/email-intelligence/sync/route.ts` — commented out the Gmail branch of the cron. Outlook (Microsoft Graph) branch still active.
3. `apps/mercato/src/app/api/ai/learn-voice/route.ts` — early returns 503 with friendly message when source is `gmail | email | outlook`.
4. `apps/mercato/src/app/api/email/gmail-service.ts` — removed `messages/{id}/modify` call (required `gmail.modify`, also restricted).
5. `apps/mercato/src/app/privacy/page.tsx` — removed all `gmail.readonly` / "Inbox Intelligence" / "inbox scanning" references. Added explicit `We do not read messages in your inbox or sent folder with this scope.` disclosure on the gmail.send description (this exact language is what Google reviewers want to see).

### Comprehensive `LaunchOS → Launch OS` rebrand sweep

Brand consistency required for verification — Google reviewers cross-check the brand name on the OAuth consent screen against text on the linked privacy/terms pages and any publicly accessible URLs. Swept all i18n locale files (`apps/mercato/src/i18n/{en,es,de,pl}.json`, `apps/mercato/src/modules/example/i18n/`, `packages/core/src/modules/{auth,messages,sales,notifications,api_docs,staff}/i18n/`), plus all `.tsx`/`.ts` source files with hardcoded brand strings (welcome page, layout, invite, team route, reminder check, auth login, api_docs explorer/page, etc.). **Verified live:** zero `LaunchOS` (no space) instances on `/`, `/login`, `/signup`, `/forgot-password`, `/privacy`, `/terms`, `/docs/api`. Only `Launch OS` everywhere.

### Compare section restyled (AMS pattern, capability descriptions only)

The compare section right column previously had a single big "All of it. But on autopilot." pitch block. Now it shows a parallel checklist of 12 rows with gradient checkmark icons. **The right column uses capability descriptions instead of brand names** to avoid trademark trouble (Wesley's correct call). Brand names only appear on the LEFT column where it's nominative fair use:

| Right column "name" (capability) | "cat" (matching left column) |
|---|---|
| Sales pipeline & contacts | CRM |
| Email broadcasts & sequences | Email marketing |
| Social posts & threads | Content & social |
| Booking pages & calendars | Booking |
| Notes & knowledge base | Docs |
| Landing pages & funnels | Pages |
| Course hosting & delivery | Courses |
| Async video & screen recording | Video |
| Recurring billing & invoices | Payments |
| Workflow automation | Automation |
| Tasks & project tracking | Projects |
| Live chat & customer support | Chat support |

Right column also has `<h3>One Launch OS.</h3>`, `.replaced-extras` tagline (`All working together. No connecting. No syncing. No tabs.`), and `.compare-total` showing `Founding price` / `A fraction` (gradient text). New CSS for `.compare-row.replaced` (overrides left column strikethrough), `.compare-row .check` (gradient circle + checkmark SVG), `.replaced-extras`.

### Long-tail copy iterations (all live)

- AMS section completely rewritten as a flow section: `Your marketing. Built in. Already running.` (h2) / `The campaigns, already written. The content, already posted. The leads, already in your CRM — tagged, scored, ready to convert. All done automatically.` (sub) / `You're running your business. It's running your marketing.` (closer)
- Product showcase h2: `One workspace. Every move.` → `Your entire business. On one screen.`
- Product showcase sub: rewritten to clarify AI three ways: `A voice AI that actually does the work. Control your CRM with any AI agent. Workflows on autopilot. Everything you need, already connected, all in the one place.`
- Flow section eyebrow: `The loop that runs itself` → `The system that runs itself`
- Command center closer: dropped `One bill.` → `One workspace. One login. Running your business. So you don't have to.`
- Pain section: `The 12-tab tax.` → `The 12-tool tax.`
- Compare h2: `Your stack costs you $487 a month.` → `Your stack costs you $487+ a month.` (added the `+`)
- Compare-total: `$487` → `$487+`
- Compare subhead: `And your weekends. Here's exactly what Launch OS replaces…` → `Not to mention your evenings and weekends. Not only does Launch OS save you time, here's exactly what it replaces…`
- Manifesto h2: `The operator running everything deserves a tool built for them.` → first iteration `You run everything. You deserve a tool built for you.` → final `You deserve a CRM built for you.`
- Waitlist h2: `Become a founding operator.` → `Become a founding member.`
- Waitlist subcopy: → `Save your spot in line and get lifetime founder level pricing.`
- Login page: `Welcome back, operator.` → `Welcome back, rockstar.`
- Removed the inner card around the autopilot trigger/action/done tiles
- Agent section: `Use Claude, ChatGPT, or any AI tool you already love…` → `Use Claude, ChatGPT, OpenClaw, or any AI tool you already love…`
- Title tag: `Launch OS — The Demonstration` → `Launch OS — The CRM you don't have to use`
- Added meta description + Open Graph tags

### Favicon

Copied `~/Desktop/blog-ops/apps/dashboard/src/app/favicon.ico` (15086 bytes, multi-resolution Windows icon) → `apps/mercato/public/favicon.ico`. Added `<link rel="icon" type="image/x-icon" href="/favicon.ico">` to `landing.html` head. Updated `apps/mercato/src/app/layout.tsx` `icons.icon` from `/launchos-logo.png` → `/favicon.ico`. **Required container restart** for Next.js to pick up the new public file (worth remembering — `docker cp` of new files into `public/` may need a restart, while updating existing files doesn't).

### Auth pages logo + sizing

Logo on auth pages swapped from `/launchos-mark.png` (white-on-black stamp) → `/launchos-logo-white.png` (transparent white logo). Replaced `box-shadow` rings (which form around the bounding box) with `filter: drop-shadow` glow that respects the logo shape. `.auth-card-mark` shrunk from 64px → 40px (desktop) / 50px → 36px (mobile). `.auth-logo-mark` shrunk from 30px → 22px.

### Waitlist form persistence (temporary)

Wired up the form (was previously jumping to top of page on submit). Created `apps/mercato/src/app/api/waitlist/route.ts` — POST endpoint that validates email and logs structured `WAITLIST_SIGNUP {...JSON...}` to stdout (captured by `docker logs launchos-app | grep WAITLIST_SIGNUP`). Added `.waitlist-success` UI state with animated checkmark. **This is temporary.** Wesley accepted the trade-off: stdout logs for now, upgrade to Postgres-backed persistence later when we build the App Password / IMAP path post-verification.

### Build queue addition

- **#36 — Meeting Notes Upload to Knowledge Base**: lets users upload meeting notes (text, transcripts, audio with auto-transcribe) so Scout can answer questions about past meetings. Added to `BUILD-QUEUE.md` at Wesley's request.

### Two new deployment gotchas (added to `reference_deployment.md`)

1. **`docker cp` writes files as `root:root` with `0600`** but the app runs as `omuser`. Always follow `docker cp` with `chown omuser:omuser` and `chmod 644`. Symptom when missed: HEAD returns 200 but GET returns 500.
2. **NEW files in `public/` need a container restart** for Next.js to pick them up. Updates to existing files work without restart. Symptom when missed: file exists with correct permissions but `curl /file` returns 404.

### Production state at end of session

- Latest GitHub-pushed commit: `185094793` (last LaunchOS → Launch OS fix)
- Local commit ahead of GitHub: `d2f233f7d` (AMS-style compare + meeting notes in build queue) — `git push` failed with `pack-objects died of signal 10` (SIGBUS — macOS-side issue)
- Working tree has uncommitted changes (latest copy tweaks, favicon.ico, layout.tsx favicon path) that were deployed live via the `scp + docker cp + chown + chmod` fast path
- All site verification: HTTP 200 across all pages, brand consistency clean, favicon serving, all expected new copy strings present
- **Production is correct.** Git state is messy but the site is fully up to date.

### Pre-existing issue (not caused by this session, deferred)

The container has a pre-existing DB error `relation "email_intelligence_settings" does not exist` that fires on container startup. The migration that creates this table never ran in production. Defer until App Password / IMAP path work post-verification — we'll need this table working anyway.

### What's NEXT after this session

1. **Run Tests A–G** manually in browser — full walkthrough preserved in `project_session_handoff.md`. Validates that the gmail.readonly removal didn't break anything.
2. **Phase 1 of Google OAuth verification prep**: Search Console domain verification (`thelaunchpadincubator.com` apex via DNS TXT). Has DNS lag, so kick off first.
3. **Phase 2**: Complete OAuth consent screen fields in Google Cloud Console + remove `gmail.readonly` from declared scopes there (the code no longer requests it but it's still declared).
4. **Phase 3**: Record 3-5 min demo video for verification (the #1 cause of rejection if done wrong).
5. **Phase 4**: Submit OAuth verification application. Wait 3-6 weeks for Google review.
6. **After verification approved**: build App Password / IMAP fallback path for inbox sync. Behind an `EmailSource` interface so it's swappable later. ~1 week of work.

### Critical knowledge to carry forward

- `OpenClaw` not `OpenCode` — Wesley specifically wants `OpenClaw` in the Agent section. Don't second-guess this.
- Right column of compare section uses **capability descriptions only** — never brand names (trademark risk).
- App Passwords are NOT a TOS violation — they're an officially supported Google feature. Risks: Workspace admin disabling and possible future deprecation. Wesley accepted these for his small-team target.
- Gmail.readonly is REMOVED. Don't add it back without explicit Wesley request.
- macOS file system flakiness during sessions — file reads timing out, git push failing with SIGBUS — is a Mac-side issue, not corruption. Just retry.

## 17. Session 2026-04-09 — Production database bootstrap + mercato rebuild plan

This session uncovered and fixed a major undiagnosed prod issue, then put guardrails + a plan in place to retire the underlying tech debt that caused it.

### What was actually broken

Login on `crm.thelaunchpadincubator.com` had been broken **since deploy day** (2026-04-05). Nobody noticed because the only thing that had been tested on prod was the static landing page + auth pages (which don't touch the DB) and the waitlist form (which writes to stdout, not Postgres). End-to-end testing was unchecked in the launch checklist (CONTEXT.md §13 item 11). When Wesley tried to log in this session, every POST to `/api/auth/login` returned 500 with `relation "users" does not exist`.

**Root cause:** `deploy.sh` only ran `setup-tables.sql` (78 hand-maintained custom CRM tables) and never ran `yarn db:migrate`. The production database had the 78 legacy tables but **none of the open-mercato base schema** — no `users`, `roles`, `tenants`, `organizations`, `customer_*`, `query_index_*`, etc. The pre-existing `email_intelligence_settings does not exist` error noted in CONTEXT.md §16 line 700 was the same root cause: the migration that creates that table never ran.

The 78 legacy tables were all empty (verified via `business_profiles` and `contact_notes` row counts). Wesley's recollection of "extensive test user with lots of data" was from his **local dev environment**, not production. Prod has never had real data.

### What got fixed

1. **`apps/mercato/src/modules/integrations_api/subscribers/deal-stage-webhook.ts:2`** — replaced the `@/app/api/webhooks/dispatch` import alias with a relative path. The CLI (esbuild) does not resolve the `@/` alias the same way Next does, so the alias broke `node packages/cli/dist/bin.js` with `Cannot read file: /app/apps/mercato/app/api/webhooks/dispatch`. **Without this fix the in-container CLI cannot run, and without the CLI we cannot run `db:migrate` or `auth setup` against the running container.**

2. **`apps/mercato/public/landing.html` header logo** — switched from `launchos-mark.png` (dark stamp) to `launchos-logo-white.png` (transparent white) so it matches the auth-card logo. First attempt used `launchos-logo.png` which is the blue-tinted version — wrong, replaced with the transparent-white file.

3. **Bootstrapped the production database:**
   - `pg_dumpall -U crm | gzip > /root/db-backup-pre-migrate-2026-04-09.sql` — ad-hoc backup before any mutations.
   - `node packages/cli/dist/bin.js db migrate` inside `launchos-app` — applied 62 migrations across 26 modules. Tables went from 78 to ~196.
   - `node packages/cli/dist/bin.js auth setup --orgName "The Launch Pad" --email wesley.b.hansen@gmail.com --password test123 --skip-password-policy` — created the first tenant + organization + 3 users (wesley.b.hansen@gmail.com as superadmin, plus the boilerplate `admin@acme.com` and `employee@acme.com`).
   - `node packages/cli/dist/bin.js auth set-password --email wesley.b.hansen@gmail.com --password '<strong-password>'` — rotated `test123` to a 20-char generated password.

4. **End-to-end login verified.** `POST /api/auth/login` returns 200 with JWT token, role `superadmin`, redirect `/backend`. Backend dashboard renders 924 KB of React. Hit several backend pages and they all responded 200 (`/backend`, `/backend/email`, `/backend/courses`, `/backend/sequences`, `/backend/billing`, `/backend/dashboards`, `/backend/calendar`, `/backend/forms`).

### Pre-existing schema drift bugs found during smoke testing (rolled into module migrations per Wesley's call)

These are NOT regressions from this session — they have been broken since deploy day. They surfaced because the smoke test exercised more endpoints than ever before.

1. **`forms.is_active` column missing** — `/api/forms` returns 500. The API code queries `where is_active = ?` but the column doesn't exist in `setup-tables.sql`. Will be fixed as part of tier 2 (forms+landing+funnels) of the mercato rebuild.
2. **`courses.status` column missing** — `/api/courses` returns 500. The API code selects `status` but the table only has `is_published` and `generation_status`. Will be fixed as part of tier 6 (courses) of the mercato rebuild.
3. **`email_intelligence_settings` table missing entirely** — fires every minute when the Outlook cron runs. Same issue Wesley flagged in CONTEXT.md §16 line 700. Will be fixed as part of tier 1 (email) of the mercato rebuild.

### Drift-prevention guardrails (committed `e7cdf730e`)

Added three layers to make the same class of regression structurally impossible going forward:

1. **`AGENTS.md` "Forbidden Patterns" section** — top-level critical rules ban: (a) new tables/columns in `setup-tables.sql`, (b) new raw-knex routes under `apps/mercato/src/app/api/`, (c) multi-tenant queries without explicit `organization_id` + `tenant_id` filtering, (d) standalone backend pages outside the module system, (e) hand-rolling new modules (must use the scaffold generator). Future Claude reads this and refuses to reintroduce the patterns.

2. **`setup-tables.sql` deprecation banner** — big warning at the top of the file pointing at SPEC-061. The 78 hand-maintained CREATE TABLE statements are now frozen.

3. **`scripts/check-forbidden-patterns.mjs` pre-commit hook** — wired via `.husky/pre-commit`. Blocks: net additions to `setup-tables.sql`, new files under `apps/mercato/src/app/api/**` that import `knex` directly, new files under `apps/mercato/src/app/(backend)/backend/<feature>/`. Override is `FORBIDDEN_PATTERNS_OVERRIDE=1` (must be documented in commit message) — never `--no-verify`.

### The plan: SPEC-061 — full mercato rebuild

`.ai/specs/SPEC-061-2026-04-09-mercato-rebuild.md` lays out the full multi-month rebuild plan to retire `setup-tables.sql` and the 52 raw-knex routes by porting every business-domain feature into proper mercato modules. **Wesley greenlit the sprint version** (focused, single-engineer, ~9-14 weeks of work, 3-5 calendar months).

8 tiers in priority order:
- **Tier 0 — customers cleanup** (4-6 days): tasks, contact_notes, contact_attachments, contact_engagement_scores, contact_open_times, engagement_events, reminders, business_profiles. Pilot tier — proves the 16-step recipe.
- **Tier 1 — email** (8-12 days): the 15+ email_* and esp_* tables. Highest blast radius if isolation breaks. Includes the `email_intelligence_settings` fix.
- **Tier 2 — forms + landing pages + funnels** (6-9 days): includes the `forms.is_active` fix.
- **Tier 3 — sequences + automation rules** (6-9 days): needs event-driven re-architecture, may need to wrap rather than port the cron loop.
- **Tier 4 — payments + billing** (6-9 days): money. Migrated after high-volume modules to amortize learning.
- **Tier 5 — bookings + calendar** (3-5 days).
- **Tier 6 — courses** (5-8 days): includes the `courses.status` fix.
- **Tier 7 — long tail** (8-15 days, opportunistic): chat, surveys, affiliates, meeting briefs, sms, twilio, ai_settings, etc. Migrated as part of feature work, not a focused sprint.

Each tier follows the 16-step recipe documented in SPEC-061. Each tier ships as a single PR with a cross-tenant isolation integration test. No parallel tier migrations (avoids merge hell). No staging environment — Wesley is the test user, ships go straight to live.

### Backups + checkpoints (committed RESTORE.md)

- **Daily rolling backups:** `/root/backups/db-backup.sh` runs at 03:00 UTC via cron, writes gzipped `pg_dumpall` to `/root/backups/db/crm-YYYY-MM-DD.sql.gz`, 14-day retention, refuses dumps under 10 KB. Logs to `/root/backups/db-backup.log`.
- **Labeled checkpoint backups:** taken before each tier migration starts. Stored on the server AND copied to `~/Desktop/CRM-backups/` on Wesley's laptop. SHA-256 verified. Tagged in git.
- **First labeled checkpoint:** `checkpoint-pre-tier0-2026-04-09.sql.gz` — taken 2026-04-09 10:40 UTC, sha256 `397e1cb2b255641e0c55243229ffe91e2b402c56ba5978e1b690258e4d06a5f8`, 11,078 lines uncompressed, 197 tables, git tag `checkpoint-pre-tier0-2026-04-09` pointing at commit `e7cdf730ef8c3f99f52947ab838bc0590b173683`.
- **Restore procedure:** `RESTORE.md` at the repo root. Three procedures: code-only revert, full DB revert, restore from local laptop (server gone). **The panic button — read it before any tier migration ships.**

### Current production state at end of session

- Latest commit on `main`: `e7cdf730e` (drift-prevention guardrails + SPEC-061 rebuild plan)
- Login works. Wesley can log in with the strong password generated this session (he should rotate it on first login per session-end note).
- 196 tables in the prod DB (78 legacy + 118 from open-mercato migrations)
- 1 admin user (wesley.b.hansen@gmail.com), 2 boilerplate seed users (admin@acme.com, employee@acme.com)
- Tenant `f5e09094-5598-4f31-b7d1-d7cc029a3190` ("The Launch Pad"), org `267d8837-9433-45cb-9631-d49830bf7c8a`
- 3 known schema drift bugs deferred to module migrations
- Daily backups running, first labeled checkpoint on disk + offsite

### Next session opens with

1. Wesley rotates `wesley.b.hansen@gmail.com` password on first login.
2. Greenlight tier 0 — start with the inventory grep, post the checklist for sign-off, then begin entity work in `packages/core/src/modules/customers/data/entities.ts`.
3. Work the 16-step recipe end-to-end. ~4-6 working days. Single PR.
4. Tier 0 retrospective. Update SPEC-061 sizing for tiers 1-7.
5. Greenlight tier 1 (email).

### Critical knowledge for future sessions

- **`setup-tables.sql` is DEPRECATED.** Do not add tables, do not add columns. The pre-commit hook will reject. The only legitimate edit is **deletion** of a table that has been migrated into a mercato module.
- **No new raw-knex API routes.** Every new endpoint must be a proper mercato module with `makeCrudRoute`.
- **Every migration PR must include a cross-tenant isolation integration test.** Non-negotiable.
- **Take a labeled checkpoint backup before each tier migration starts.** Pattern is in RESTORE.md "Adding new checkpoints".
- **Production has no staging environment.** Wesley ships to live and tests there. Move carefully.
- **`deploy.sh` is the historical reason this incident happened.** It only runs `setup-tables.sql` and not `yarn db:migrate`. SPEC-061 Phase A includes a TODO to either patch or delete it. Until then, DO NOT run `./deploy.sh`. Use the docker compose path documented in `reference_deployment.md`.
- **The CLI in-container builds via esbuild and does NOT resolve the `@/` path alias the same way Next does.** Any new file with `import { foo } from '@/...'` outside Next route handlers will break the CLI. Use relative imports in subscribers, workers, and module code.
- **Cron tokens are visible in `crontab -l` on the server.** Flagged but not yet rotated. Should be moved to a secrets file as a separate quick task.
