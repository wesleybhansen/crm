// ORM-SKIP: AI generation/analysis — complex prompt construction, not CRUD
export const metadata = { path: '/ai/assistant', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import { buildPersonaPrompt, getPersonaForOrg } from '../persona'


const CRM_INSTRUCTIONS = `You are Scout, an AI assistant built into a CRM platform designed for solopreneurs and small businesses. You help users navigate the app, answer questions about their data, and take actions on their behalf.

COMPLETE FEATURE GUIDE:

1. **Dashboard** (sidebar → Dashboard)
   - Stats: inbox messages, total contacts, pipeline value, conversion rate
   - Recent leads and activity feed
   - Action items: unread inbox, upcoming bookings, open tasks, pending invoices
   - Quick links to all major sections

2. **Contacts** (sidebar → Contacts)
   - Three tabs: **People** | **Companies** | **Tasks**
   - **People**: Add/edit/delete contacts, track email, phone, tags, notes, lifecycle stage
   - **Companies**: Create companies, link employees to companies
   - **Tasks**: Create tasks with due dates, assign to contacts, mark complete
   - **Contact Detail Panel**: Click a contact to see timeline, notes, deals, company info, AI summary, tags
   - **Photo Scan**: Upload a business card or sign-in sheet photo → AI extracts contacts
   - **Import/Export**: CSV import and export
   - To add a contact: Contacts → "+" button or photo scan
   - To add a company: Contacts → Companies tab → "New Company"
   - To create a task: Contacts → Tasks tab → "New Task"

3. **Pipeline** (sidebar → Pipeline)
   - Visual Kanban board for deals/opportunities
   - Stages: Lead → Contacted → Qualified → Proposal → Won / Lost
   - Drag-and-drop between stages
   - Each deal has value, contact, expected close date
   - Pipeline analytics and conversion tracking

4. **Inbox** (sidebar → Inbox)
   - Unified inbox combining email and live chat conversations
   - Read, reply, and manage all messages in one place
   - Conversations linked to contacts automatically

5. **Email** (sidebar → Email)
   - Send and receive emails linked to contacts
   - Track opens and clicks
   - Connect Gmail, Outlook, or SMTP providers in Settings
   - Email templates and scheduling

6. **Live Chat** (sidebar → Chat)
   - Embeddable chat widget for your website
   - AI-powered chatbot (configurable knowledge base, personality, guardrails)
   - Real-time visitor conversations with agent handoff
   - Widget customization: colors, greeting, position

7. **Landing Pages** (sidebar → Landing Pages)
   - AI-generated landing pages with 3 style themes (warm, minimal, dark)
   - Form builder captures leads directly into contacts
   - Each page gets a public URL with your custom slug

8. **Courses** (sidebar → Courses)
   - Create and sell online courses
   - AI course content generator (from description or knowledge base)
   - Landing page per course with Stripe checkout for paid courses
   - Student enrollment tracking, progress, and completion
   - Magic link login for students

9. **Events** (sidebar → Events)
   - Create in-person, virtual, or hybrid events
   - 8 templates: Workshop, Webinar, Networking Mixer, Dinner/Gala, Open House, Product Launch, Training Session, Community Meetup
   - Public registration page with capacity limits and preapproved lists
   - Dependent registration fields (e.g., ticket quantity → guest detail groups)
   - Paid events with Stripe checkout
   - Email attendees, send reminders, cancel with notification
   - Recurring events with individual attendee lists

10. **Surveys** (sidebar → Surveys)
    - 10 templates: Customer Satisfaction (CSAT), NPS, Event Feedback, Onboarding, Product Feedback, Market Research, Employee Engagement, Website UX, Brand Perception, Service Quality
    - Custom fields: text, textarea, number, select, multi-select, rating, date
    - Public survey link, response tracking, CSV export
    - Responses linked to contacts when email is provided

11. **Payments** (sidebar → Payments)
    - Three tabs: **Products & Services** | **Invoices** | **Processed Payments**
    - Products: Create one-time or recurring products, set free trial period for subscriptions
    - Invoices: Create invoices with line items, send via email with payment link
    - Stripe Connect integration for accepting payments
    - Issue full or partial refunds, cancel subscriptions
    - Auto-receipt emails, affiliate tracking
    - Products can be linked to courses for auto-enrollment on purchase

12. **Automations** (sidebar → Automations)
    - Automation rules triggered by events (new contact, form submission, tag added, etc.)
    - Actions: send email, add tag, move pipeline stage, send SMS, wait/delay
    - Multi-step automation sequences

13. **Bookings** (sidebar → Bookings)
    - Appointment scheduling with calendar integration
    - Public booking pages customers can use to schedule

14. **Affiliates** (sidebar → Affiliates)
    - Affiliate program management
    - Track referrals, commissions, and payouts
    - Promo codes linked to Stripe

15. **Settings** (sidebar → Settings or gear icon)
    - Business profile (name, description, logo)
    - Connected integrations (Gmail, Outlook, Stripe, Calendar, Zapier)
    - Sidebar visibility (show/hide sections)
    - AI assistant persona (name, style, custom instructions)
    - Calendar feed URL for external calendar sync
    - Contact export

NAVIGATION:
- The sidebar on the left has all sections
- Click your profile icon (top right) for settings, theme, logout
- Settings page has all configuration options

DATA CONTEXT:
You have access to a snapshot of the user's CRM data (provided below the conversation). Use it to answer questions like "how many contacts do I have?", "what deals are in my pipeline?", "show me recent payments", etc. When data is provided, reference it directly — don't say "I don't have access to your data."

CRM ACTIONS:
When the user asks you to do something, respond with a JSON action block:
\`\`\`crm-action
{"type": "action_type", "data": {...}}
\`\`\`

Available action types:
- create_contact: { name, email, phone?, source? }
- create_task: { title, contactId?, dueDate? }
- add_note: { contactId, content }
- add_tag: { contactId, tagName }
- remove_tag: { contactId, tagName }
- create_deal: { title, contactId?, value? }
- send_email: { to, subject, body }
- move_deal_stage: { dealId, stage }
- create_invoice: { contactName?, items: [{name, price, quantity}], dueDate?, notes? }
- create_product: { name, description?, price, billingType?, trialDays? }
- set_reminder: { message, remindAt?, delayMinutes? } — Use for "remind me", "set a reminder", "follow up in X"
- create_booking_page: { title, duration }
- create_event: { title, date, duration, location?, eventType? }
- create_email_list: { name, description? }
- create_email_campaign: { name, subject, body }
- search_contacts: { query }
- delete_contact: { contactId }
- delete_event: { eventId }
- delete_task: { taskId }
- edit_event: { eventId, title?, duration?, date? }
- edit_task: { taskId, title?, dueDate?, markComplete? }
- complete_task: { taskId }

Always confirm what you'll do before including the action block. Only include ONE action per response.

NAVIGATION LINKS:
When directing the user to a page, include a markdown link so they can click directly to it. Use these exact paths:
- Dashboard: [Go to Dashboard](/backend/dashboards)
- Contacts: [Go to Contacts](/backend/customers/people)
- Pipeline: [Go to Pipeline](/backend/pipeline)
- Inbox: [Go to Inbox](/backend/inbox)
- Email: [Go to Email](/backend/email)
- Chat: [Go to Chat](/backend/chat)
- Landing Pages: [Go to Landing Pages](/backend/landing-pages)
- Courses: [Go to Courses](/backend/courses)
- Events: [Go to Events](/backend/my-events)
- Surveys: [Go to Surveys](/backend/surveys)
- Payments: [Go to Payments](/backend/payments)
- Automations: [Go to Automations](/backend/automations)
- Bookings: [Go to Bookings](/backend/bookings)
- Affiliates: [Go to Affiliates](/backend/affiliates)
- Settings: [Go to Settings](/backend/settings-simple)

Always include the navigation link when telling someone where to find something.

ANSWERING RULES:
- Be concise and friendly. These are busy entrepreneurs.
- When explaining how to do something, give step-by-step instructions and include a navigation link.
- If asked about data, use the data snapshot provided. Give specific numbers and names.
- If data shows zero results, suggest how to get started with that feature.
- Keep responses under 3-4 sentences unless the user asks for details.
- Use **bold** for button/section names.
- Don't make up data. Only reference what's in the snapshot.
- Use markdown: **bold**, *italic*, bullet lists with -, and [links](/path).`

// Query CRM data to give Scout context about the user's actual data
async function buildDataContext(knex: any, orgId: string): Promise<string> {
  const sections: string[] = []

  try {
    // Contact stats
    const [{ count: contactCount }] = await knex('customer_entities')
      .where('organization_id', orgId).where('kind', 'person').whereNull('deleted_at').count()
    const [{ count: companyCount }] = await knex('customer_entities')
      .where('organization_id', orgId).where('kind', 'company').whereNull('deleted_at').count()
    const recentContacts = await knex('customer_entities')
      .where('organization_id', orgId).where('kind', 'person').whereNull('deleted_at')
      .orderBy('created_at', 'desc').limit(5)
      .select('display_name', 'primary_email', 'lifecycle_stage', 'source', 'created_at')
    sections.push(`CONTACTS: ${contactCount} people, ${companyCount} companies`)
    if (recentContacts.length > 0) {
      sections.push('Recent contacts: ' + recentContacts.map((c: any) =>
        `${c.display_name}${c.primary_email ? ` (${c.primary_email})` : ''}${c.lifecycle_stage ? ` [${c.lifecycle_stage}]` : ''}`
      ).join('; '))
    }
  } catch {}

  try {
    // Pipeline/deals
    const deals = await knex('customer_deals')
      .where('organization_id', orgId).whereNull('deleted_at')
      .select('title', 'status', 'value_amount', 'pipeline_stage', 'created_at')
      .orderBy('created_at', 'desc').limit(10)
    if (deals.length > 0) {
      const totalValue = deals.reduce((sum: number, d: any) => sum + (Number(d.value_amount) || 0), 0)
      const openDeals = deals.filter((d: any) => d.status === 'open' || !d.status)
      sections.push(`PIPELINE: ${deals.length} deals (${openDeals.length} open), total value $${totalValue.toFixed(0)}`)
      sections.push('Deals: ' + deals.slice(0, 5).map((d: any) =>
        `"${d.title}" — ${d.pipeline_stage || d.status || 'open'}${d.value_amount ? ` ($${Number(d.value_amount).toFixed(0)})` : ''}`
      ).join('; '))
    } else {
      sections.push('PIPELINE: No deals yet')
    }
  } catch {}

  try {
    // Tasks
    const [{ count: openTasks }] = await knex('tasks')
      .where('organization_id', orgId).where('is_done', false).count()
    const [{ count: doneTasks }] = await knex('tasks')
      .where('organization_id', orgId).where('is_done', true).count()
    const upcomingTasks = await knex('tasks')
      .where('organization_id', orgId).where('is_done', false)
      .orderBy('due_date', 'asc').limit(5)
      .select('title', 'due_date', 'created_at')
    sections.push(`TASKS: ${openTasks} open, ${doneTasks} completed`)
    if (upcomingTasks.length > 0) {
      sections.push('Upcoming: ' + upcomingTasks.map((t: any) =>
        `"${t.title}"${t.due_date ? ` (due ${new Date(t.due_date).toLocaleDateString()})` : ''}`
      ).join('; '))
    }
  } catch {}

  try {
    // Invoices
    const invoices = await knex('invoices')
      .where('organization_id', orgId).whereNull('deleted_at')
      .select('invoice_number', 'status', 'total', 'created_at')
      .orderBy('created_at', 'desc').limit(5)
    if (invoices.length > 0) {
      const paid = invoices.filter((i: any) => i.status === 'paid')
      const pending = invoices.filter((i: any) => i.status === 'sent' || i.status === 'draft')
      sections.push(`INVOICES: ${invoices.length} total (${paid.length} paid, ${pending.length} pending)`)
    }
  } catch {}

  try {
    // Payment records
    const [{ count: paymentCount }] = await knex('payment_records')
      .where('organization_id', orgId).where('status', 'succeeded').count()
    const [{ sum: paymentTotal }] = await knex('payment_records')
      .where('organization_id', orgId).where('status', 'succeeded').sum('amount')
    if (Number(paymentCount) > 0) {
      sections.push(`PAYMENTS: ${paymentCount} successful payments, $${Number(paymentTotal || 0).toFixed(0)} total revenue`)
    }
  } catch {}

  try {
    // Products
    const products = await knex('products')
      .where('organization_id', orgId).whereNull('deleted_at').where('is_active', true)
      .select('name', 'price', 'billing_type', 'trial_days')
      .orderBy('created_at', 'desc').limit(10)
    if (products.length > 0) {
      sections.push('PRODUCTS: ' + products.map((p: any) =>
        `"${p.name}" $${Number(p.price).toFixed(0)}${p.billing_type === 'recurring' ? '/mo' : ''}${p.trial_days ? ` (${p.trial_days}-day trial)` : ''}`
      ).join('; '))
    }
  } catch {}

  try {
    // Events
    const events = await knex('events')
      .where('organization_id', orgId).whereNull('deleted_at')
      .whereIn('status', ['draft', 'published'])
      .select('title', 'status', 'start_time', 'attendee_count', 'capacity')
      .orderBy('start_time', 'asc').limit(5)
    if (events.length > 0) {
      sections.push('UPCOMING EVENTS: ' + events.map((e: any) =>
        `"${e.title}" — ${new Date(e.start_time).toLocaleDateString()} (${e.attendee_count}${e.capacity ? `/${e.capacity}` : ''} registered, ${e.status})`
      ).join('; '))
    }
  } catch {}

  try {
    // Courses
    const courses = await knex('courses')
      .where('organization_id', orgId).whereNull('deleted_at')
      .select('title', 'is_published', 'price')
      .orderBy('created_at', 'desc').limit(5)
    if (courses.length > 0) {
      sections.push('COURSES: ' + courses.map((c: any) =>
        `"${c.title}" — ${c.is_published ? 'published' : 'draft'}${c.price ? ` ($${Number(c.price).toFixed(0)})` : ' (free)'}`
      ).join('; '))
    }
  } catch {}

  try {
    // Surveys
    const surveys = await knex('surveys')
      .where('organization_id', orgId)
      .select('title', 'is_active', 'response_count')
      .orderBy('created_at', 'desc').limit(5)
    if (surveys.length > 0) {
      sections.push('SURVEYS: ' + surveys.map((s: any) =>
        `"${s.title}" — ${s.is_active ? 'active' : 'inactive'} (${s.response_count || 0} responses)`
      ).join('; '))
    }
  } catch {}

  try {
    // Automations
    const [{ count: autoCount }] = await knex('automation_rules')
      .where('organization_id', orgId).where('is_active', true).count()
    if (Number(autoCount) > 0) {
      sections.push(`AUTOMATIONS: ${autoCount} active rules`)
    }
  } catch {}

  try {
    // Chat widgets
    const [{ count: widgetCount }] = await knex('chat_widgets')
      .where('organization_id', orgId).where('is_active', true).count()
    if (Number(widgetCount) > 0) {
      sections.push(`LIVE CHAT: ${widgetCount} active widget(s)`)
    }
  } catch {}

  if (sections.length === 0) {
    return 'DATA SNAPSHOT: No data found yet — this is a fresh CRM. Help the user get started!'
  }

  return 'DATA SNAPSHOT:\n' + sections.join('\n')
}

// Search for specific contacts/deals when the user asks about someone by name
async function searchCrmData(knex: any, orgId: string, query: string): Promise<string> {
  if (!query || query.length < 2) return ''
  const sections: string[] = []
  const q = `%${query}%`

  try {
    const contacts = await knex('customer_entities')
      .where('organization_id', orgId).whereNull('deleted_at')
      .where(function(this: any) {
        this.whereILike('display_name', q).orWhereILike('primary_email', q)
      })
      .select('id', 'display_name', 'primary_email', 'primary_phone', 'kind', 'lifecycle_stage', 'source', 'created_at')
      .orderBy('created_at', 'desc').limit(10)

    if (contacts.length > 0) {
      sections.push(`SEARCH RESULTS for "${query}" — ${contacts.length} contact(s) found:`)
      for (const c of contacts) {
        const parts = [`**${c.display_name}**`]
        if (c.primary_email) parts.push(c.primary_email)
        if (c.primary_phone) parts.push(c.primary_phone)
        if (c.lifecycle_stage) parts.push(`stage: ${c.lifecycle_stage}`)
        if (c.source) parts.push(`source: ${c.source}`)
        parts.push(`(${c.kind}, added ${new Date(c.created_at).toLocaleDateString()})`)
        sections.push('- ' + parts.join(' | '))

        // Get deals for this contact
        const deals = await knex('customer_deal_people as cdp')
          .join('customer_deals as cd', 'cd.id', 'cdp.deal_id')
          .where('cdp.person_entity_id', c.id)
          .where('cd.organization_id', orgId).whereNull('cd.deleted_at')
          .select('cd.title', 'cd.status', 'cd.value_amount', 'cd.pipeline_stage')
          .limit(5).catch(() => [])
        if (deals.length > 0) {
          sections.push('  Deals: ' + deals.map((d: any) =>
            `"${d.title}" ${d.pipeline_stage || d.status || 'open'}${d.value_amount ? ` ($${Number(d.value_amount).toFixed(0)})` : ''}`
          ).join('; '))
        }

        // Get recent tasks
        const tasks = await knex('tasks')
          .where('contact_id', c.id).where('organization_id', orgId)
          .select('title', 'is_done', 'due_date')
          .orderBy('created_at', 'desc').limit(3).catch(() => [])
        if (tasks.length > 0) {
          sections.push('  Tasks: ' + tasks.map((t: any) =>
            `${t.is_done ? '[done]' : '[open]'} "${t.title}"${t.due_date ? ` (due ${new Date(t.due_date).toLocaleDateString()})` : ''}`
          ).join('; '))
        }

        // Get tags
        const tags = await knex('customer_tag_assignments as cta')
          .join('customer_tags as ct', 'ct.id', 'cta.tag_id')
          .where('cta.entity_id', c.id).where('cta.organization_id', orgId)
          .select('ct.name').limit(10).catch(() => [])
        if (tags.length > 0) {
          sections.push('  Tags: ' + tags.map((t: any) => t.name).join(', '))
        }
      }
    }
  } catch {}

  try {
    // Also search deals by title
    const deals = await knex('customer_deals')
      .where('organization_id', orgId).whereNull('deleted_at')
      .whereILike('title', q)
      .select('title', 'status', 'value_amount', 'pipeline_stage', 'created_at')
      .orderBy('created_at', 'desc').limit(5)
    if (deals.length > 0 && !sections.some(s => s.includes('SEARCH RESULTS'))) {
      sections.push(`SEARCH RESULTS for "${query}":`)
    }
    if (deals.length > 0) {
      sections.push('Matching deals: ' + deals.map((d: any) =>
        `"${d.title}" — ${d.pipeline_stage || d.status || 'open'}${d.value_amount ? ` ($${Number(d.value_amount).toFixed(0)})` : ''}`
      ).join('; '))
    }
  } catch {}

  return sections.join('\n')
}

// Extract a search intent from the latest user message
function extractSearchQuery(messages: Array<{ role: string; content: string }>): string | null {
  const lastMsg = messages[messages.length - 1]
  if (!lastMsg || lastMsg.role !== 'user') return null
  const text = lastMsg.content.toLowerCase()

  // Match patterns like "tell me about X", "find X", "look up X", "search for X", "who is X", "info on X"
  const patterns = [
    /(?:tell me about|find|look up|search for|who is|info on|details on|show me|what do (?:we|you|i) (?:know|have) about)\s+(.+)/i,
    /(?:find|search|look up)\s+(?:contact|person|company|deal)?\s*(?:named?|called)?\s+(.+)/i,
  ]
  for (const pattern of patterns) {
    const match = lastMsg.content.match(pattern)
    if (match) {
      return match[1].replace(/[?.!]$/, '').trim()
    }
  }
  return null
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { messages, currentPage } = body

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ ok: false, error: 'messages required' }, { status: 400 })
    }

    const geminiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY
    const openaiKey = process.env.OPENAI_API_KEY
    if (!geminiKey && !openaiKey) {
      return NextResponse.json({
        ok: true,
        message: "I'm Scout, your CRM assistant, but no AI API keys are configured. I can still help with basic navigation — what are you looking for?",
      })
    }

    // Load persona + data context
    let personaPrompt = ''
    let dataContext = ''
    let userInfoBlock = ''
    try {
      const auth = await getAuthFromCookies()
      if (auth?.orgId && auth?.sub) {
        const container = await createRequestContainer()
        const em = container.resolve('em') as EntityManager
        const knex = em.getKnex()
        const profile = await getPersonaForOrg(knex, auth.orgId)
        if (profile) {
          personaPrompt = buildPersonaPrompt(profile)
        }
        // Build data context for every request so Scout can answer data questions
        dataContext = await buildDataContext(knex, auth.orgId)

        // If the user is searching for a specific person/deal, add targeted search results
        const searchQuery = extractSearchQuery(messages)
        if (searchQuery) {
          const searchResults = await searchCrmData(knex, auth.orgId, searchQuery)
          if (searchResults) {
            dataContext = searchResults + '\n\n' + dataContext
          }
        }

        // Fetch the current user's name + email so email drafts sign with real
        // name. Without this Scout falls back to "[Your Name]" placeholder.
        try {
          const appUser = await knex('users').where('id', auth.sub).first()
          const userName = (appUser?.name || '').toString().trim()
          const userEmail = auth?.email || ''
          if (userName || userEmail) {
            userInfoBlock = `USER INFO:\nName: ${userName || '(unknown)'}\nEmail: ${userEmail || '(unknown)'}\n\nWhen signing emails on the user's behalf, use their real name. NEVER use placeholders like "[Your Name]", "[Your Email]", or "Best regards, [Name]". If unsure, use just their first name.`
          }
        } catch {}
      }
    } catch {}

    const systemParts = [personaPrompt, CRM_INSTRUCTIONS, userInfoBlock, dataContext].filter(Boolean)
    const systemPrompt = systemParts.join('\n\n')

    // Add page context to the conversation
    const contextMessage = currentPage
      ? `[The user is currently on the ${currentPage} page]`
      : ''

    const contextPrefixed = contextMessage && messages.length > 0
      ? [{ ...messages[0], content: `${contextMessage}\n\n${messages[0].content}` }, ...messages.slice(1)]
      : messages

    // Gemini first (preferred for cost), then OpenAI fallback if Gemini is
    // rate-limited, keyless, or otherwise unreachable. Either provider returns
    // plain text or throws a classified error for the caller to handle.
    let text: string | null = null
    let provider: 'gemini' | 'openai' | null = null
    let lastError: { provider: string; message: string } | null = null

    if (geminiKey) {
      try {
        text = await callGemini(geminiKey, systemPrompt, contextPrefixed)
        provider = 'gemini'
      } catch (err: any) {
        lastError = { provider: 'gemini', message: err?.message || String(err) }
        const retriable = err?.retriable !== false
        console.warn('[ai.assistant] Gemini failed', lastError.message, 'retriable:', retriable)
        if (!retriable) {
          // Non-retriable Gemini error (e.g. validation) — don't fall back, return it.
          return NextResponse.json({ ok: false, error: lastError.message }, { status: 500 })
        }
      }
    }

    if (text === null && openaiKey) {
      try {
        text = await callOpenAI(openaiKey, systemPrompt, contextPrefixed)
        provider = 'openai'
        console.log('[ai.assistant] Served via OpenAI fallback')
      } catch (err: any) {
        lastError = { provider: 'openai', message: err?.message || String(err) }
        console.error('[ai.assistant] OpenAI fallback failed', lastError.message)
      }
    }

    if (text !== null) {
      return NextResponse.json({ ok: true, message: text, provider })
    }

    // Both providers exhausted or unavailable
    if (lastError?.message?.toLowerCase().includes('resource exhausted') || lastError?.message?.toLowerCase().includes('rate limit') || lastError?.message?.toLowerCase().includes('quota')) {
      return NextResponse.json({
        ok: true,
        message: "Both AI providers are rate-limited right now. Try again in a minute, or use voice mode (mic button) which uses a separate OpenAI Realtime quota.",
      })
    }
    return NextResponse.json({ ok: false, error: lastError?.message || 'Assistant error' }, { status: 500 })
  } catch (error) {
    console.error('[ai.assistant]', error)
    return NextResponse.json({ ok: false, error: 'Assistant error' }, { status: 500 })
  }
}

type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string }

async function callGemini(apiKey: string, systemPrompt: string, msgs: ChatMessage[]): Promise<string> {
  const model = process.env.AI_MODEL || 'gemini-2.0-flash'
  const contents = msgs.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  let res: Response
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 1500 },
        }),
        signal: controller.signal,
      }
    )
  } finally {
    clearTimeout(timeout)
  }

  const data = await res.json().catch(() => null) as any
  if (!res.ok || data?.error) {
    const msg: string = data?.error?.message || `HTTP ${res.status}`
    const err: any = new Error(msg)
    // Retriable: 429/5xx/timeout/resource-exhausted — worth trying another provider.
    err.retriable = res.status === 429 || res.status >= 500 || /resource exhausted|rate limit|quota/i.test(msg)
    throw err
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) {
    const err: any = new Error('Empty Gemini response')
    err.retriable = true
    throw err
  }
  return text
}

async function callOpenAI(apiKey: string, systemPrompt: string, msgs: ChatMessage[]): Promise<string> {
  const model = process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini'
  const openaiMessages = [
    { role: 'system', content: systemPrompt },
    ...msgs.map((m) => ({ role: m.role, content: m.content })),
  ]
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  let res: Response
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: openaiMessages,
        temperature: 0.7,
        max_tokens: 1500,
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }

  const data = await res.json().catch(() => null) as any
  if (!res.ok || data?.error) {
    throw new Error(data?.error?.message || `OpenAI HTTP ${res.status}`)
  }
  const text = data?.choices?.[0]?.message?.content
  if (!text) throw new Error('Empty OpenAI response')
  return text
}
