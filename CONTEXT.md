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
- [x] 1.1 Fork & clone — github.com/wesleybhansen/open-mercato, upstream remote set
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

### In Progress / Remaining
- [ ] **AI Landing Page Builder** — major feature, spec below. Conversational AI generates entire pages.
- [ ] End-to-end browser testing
- [ ] Login API debug (browser login works, API returns 500)
- [ ] UI polish (dark mode hovers, icon colors)
- [ ] Email compose UI
- [ ] Deploy to Hetzner

### AI Landing Page Builder Spec (REVISED — chat approach abandoned, wizard approach)
**User flow:** Pick template (visual) → Guided wizard form (AI pre-fills) → Live preview + AI revision → Publish

**Technical approach:**
1. Template parser: Extracts section schema from HTML (sections, fields, repeaters). BUILT — works.
2. Guided wizard form: Structured inputs based on template category. Fields: business name, offer, audience, CTA action, benefits (repeater), social proof (optional). AI "Generate Copy" button fills remaining fields via Gemini.
3. Content generation: Gemini takes wizard form data + template schema → generates all copy. BUILT — Gemini API works.
4. Template renderer: Injects content into template HTML. BUILT — works.
5. Live preview: Iframe showing rendered page. AI revision panel for tweaks. PARTIALLY BUILT — preview works, revision endpoint needs debug.
6. Publish: One button. BUILT — creates page + publishes.

**What's built and working:**
- Template picker with iframe previews (55 templates)
- Template parser service
- AI service (Gemini integration, multi-provider support)
- Content renderer
- API endpoints: /ai/chat, /ai/generate, /ai/revise, /templates, /templates/preview/[id]
- Form submission → auto-creates CRM contact + logs activity

**What's been rebuilt (2026-03-24 evening):**
- Step 2 UI: Replaced chat with 3-screen guided wizard (Basics → Offer → Social Proof)
- Split screen layout: form on left (420px), live preview on right
- Tone selector, benefits repeater, testimonial/stats optional inputs
- Smart CTA defaults per template category
- Publish flow updated: injects form action URLs, ensures form handler script is in HTML
- Form submissions on published pages → auto-create CRM contacts (verified working)

**Working as of 2026-03-25:**
- AI page generation works end-to-end (Gemini rewrites template body content)
- Wizard 3-step flow: pick template → fill form → generate → preview → publish
- Template path resolution fixed
- Token optimization: only body content sent to AI (60% reduction)
- 7 tone options including custom
- "Anything else?" catch-all input
- AI revision panel on preview (works but hits rate limits on free Gemini tier)

**Still needs:**
- Gemini paid tier for reliable AI usage (free tier rate limits too strict)
- Logo upload for landing pages
- End-to-end form submission → CRM contact test

**Completed:**
- Template-aware prompting (7 category-specific AI guides)
- Rate limit handling (15s cooldown, clear error messages)
- Sidebar branding (logo → blue C icon, name → CRM)

**Major Direction Change (2026-03-25):**
Pivoting from feature-building to UX simplification. See SIMPLIFICATION-PLAN.md for full plan.

Key insight: The app is too complex for solopreneurs. Open Mercato's enterprise UX overwhelms small business users.

### Simplification Progress (2026-03-25)
- [x] Phase 1: Sidebar simplification — simple mode (5 items) vs advanced (20+), cookie-based toggle
- [x] Phase 2: AI Assistant — floating chat widget on every page, Gemini-powered, CRM feature docs in system prompt
- [x] Phase 3: Dashboard — AI-generated action items, KPI stats, quick actions, recent activity
- [x] Phase 4: Contacts — merged People/Companies with tabs, side panel, search, email button
- [x] Phase 5: AI Email — compose modal with AI draft (6 purpose types), open/click tracking
- [x] Phase 6: AI Onboarding — 5-step welcome wizard (business, offer, sources, AI pipeline, next steps). Saves to business_profiles table.

### Additional Features Built (2026-03-25 afternoon)
- [x] Payments module — products catalog, invoices with line items, auto-numbering (INV-0001)
- [x] Notes & Tasks — tabbed side panel on contacts (Details/Notes/Tasks), overdue tasks in dashboard
- [x] Tags — add/remove colored tags on contacts, auto-create
- [x] Contact Import — paste CSV-like data, auto-parse, duplicate detection
- [x] Settings page — theme toggle, mode switch (simple/advanced), API keys, BYOK entry
- [x] AI Usage Cap + BYOK — ai_usage + ai_settings tables, 500 calls/month cap, admin adjustable, user BYOK fallback, usage meter in settings
- [x] Business profile persistence — onboarding saves to business_profiles table for AI context
- [x] Template preview — full-screen modal with "Use This Template" button
- [x] Template cleanup — removed 7 (privacy/terms/thank-you), reclassified 4, 49 remaining
- [x] Dashboard activity — shows contacts/deals instead of encrypted activity data

### Current Sidebar (Simple Mode)
```
Dashboard          — AI action items, KPIs, quick actions, activity feed
CRM
  → Contacts       — merged People/Companies, tabs, side panel (Details/Notes/Tasks), tags, import
  → Pipeline       — Kanban deal board
  → Payments       — Products & Services, Invoices
Marketing
  → Landing Pages  — AI-powered builder, 49 templates, wizard + preview
  → Email          — send/receive, AI drafts, tracking
Settings           — theme, mode, integrations, BYOK, AI usage meter
+ AI Assistant     — floating chat on every page
```

### Remaining Before Users Can Use It
1. Gemini paid tier (Wesley's action)
2. Resend API key + domain setup (Wesley's action)
3. End-to-end testing (create page → publish → form submit → contact created)
4. Deploy to Hetzner
5. Stripe Connect for actual payment processing

**AI provider:** Configurable via AI_PROVIDER env var. Default: Gemini. Options: google, anthropic, openai.
**AI cost model:** System-wide monthly cap (admin adjustable) + BYOK fallback for users who exceed cap.
**Form submissions → auto-create contacts:** Built (inline in submit endpoint).
**No Puck:** Templates stay as vanilla HTML. Gemini rewrites body content directly. Much simpler, preserves design fidelity.

### Remaining Phases
- Phase 2 (Weeks 4-9): Landing pages, email, integration APIs, credit billing — **MVP**
- Phase 3-5 (Weeks 10-30): SMS, pipeline, invoicing, AI, workflows, calendar, reporting, phone, courses

---

## 14. Clarifications from Wesley (2026-03-24)

- Blog-Ops **creates** email sequences but does **not send them**. Email deliverability must be built into the CRM.
- Blog-Ops content generation is built, but **publishing is not** (it's in Blog-Ops build queue).
- Blog-Ops partnership outreach **only generates lists** of potential partners. No contract management or outreach tracking.
- Wesley wants the CRM as a **standalone app**, not embedded in Blog-Ops.
- Different tech stacks across services are acceptable since they connect via APIs.
- Wesley is considering making the CRM **free** as a lead magnet for his entrepreneurship program.
- Users may need to add credits for usage-based costs (email, SMS, AI), but the core CRM would be free or very low cost.
