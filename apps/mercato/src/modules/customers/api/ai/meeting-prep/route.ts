// ORM-SKIP: AI generation/analysis — complex prompt construction, not CRUD

import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { buildPersonaPrompt, getPersonaForOrg } from '../persona'
import { sendEmailByPurpose } from '@/modules/email/lib/email-router'
import { meterCustomersAi } from '@/lib/usage/meter'
import { checkCustomersAiAllowance } from '@/lib/usage/allowance'
import { listOpenCommitments, extractCommitmentsForContact, formatCommitmentsForBrief } from '../../../lib/commitments'
import { requireProcessAuth } from '@/lib/cron-auth'

export const metadata = { path: '/ai/meeting-prep',
  POST: { requireAuth: false },
}

// ── Types ────────────────────────────────────────────────────────────────────

interface CalendarEvent {
  id: string
  summary: string
  start: { dateTime?: string; date?: string }
  end: { dateTime?: string; date?: string }
  attendees?: Array<{ email: string; displayName?: string; responseStatus?: string }>
}

interface MeetingPrepResult {
  contact: {
    id: string
    displayName: string
    email: string
    lifecycleStage: string | null
    engagementScore: number | null
    source: string | null
  }
  brief: string
  upcomingEvent: {
    summary: string
    startTime: string
  } | null
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function refreshCalendarToken(knex: ReturnType<EntityManager['getKnex']>, connection: Record<string, unknown>): Promise<string> {
  const expiry = new Date(connection.token_expiry as string)
  if (expiry > new Date(Date.now() + 5 * 60 * 1000)) {
    return connection.access_token as string
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  if (!clientId || !connection.refresh_token) {
    throw new Error('Cannot refresh Google token')
  }

  const body: Record<string, string> = {
    client_id: clientId,
    refresh_token: connection.refresh_token as string,
    grant_type: 'refresh_token',
  }
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (clientSecret) body.client_secret = clientSecret

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  const tokens = await res.json()

  if (!tokens.access_token) {
    throw new Error('Token refresh failed')
  }

  await knex('google_calendar_connections').where('id', connection.id).update({
    access_token: tokens.access_token,
    token_expiry: new Date(Date.now() + (tokens.expires_in || 3600) * 1000),
    updated_at: new Date(),
  })

  return tokens.access_token
}

async function getUpcomingEvents(knex: ReturnType<EntityManager['getKnex']>, connection: Record<string, unknown>, hoursAhead: number): Promise<CalendarEvent[]> {
  const accessToken = await refreshCalendarToken(knex, connection)
  const calendarId = (connection.calendar_id as string) || 'primary'

  const now = new Date()
  const timeMax = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000)

  const params = new URLSearchParams({
    timeMin: now.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '10',
  })

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )

  if (!res.ok) {
    console.error('[meeting-prep] Calendar API error:', res.status)
    return []
  }

  const data = await res.json()
  return (data.items || []) as CalendarEvent[]
}

async function loadContactData(knex: ReturnType<EntityManager['getKnex']>, orgId: string, contactId: string) {
  const contact = await knex('customer_entities')
    .where('id', contactId)
    .where('organization_id', orgId)
    .whereNull('deleted_at')
    .select('id', 'display_name', 'primary_email', 'lifecycle_stage', 'source', 'created_at', 'updated_at')
    .first()

  if (!contact) return null

  // Load engagement score
  let engagementScore: number | null = null
  try {
    const score = await knex('contact_engagement_scores')
      .where('contact_id', contactId)
      .select('score')
      .first()
    engagementScore = score ? Number(score.score) : null
  } catch {}

  // Load last 5 interactions (notes + emails)
  const interactions: Array<{ type: string; content: string; date: string }> = []

  try {
    const notes = await knex('contact_notes')
      .where('contact_id', contactId)
      .where('organization_id', orgId)
      .orderBy('created_at', 'desc')
      .limit(5)
      .select('content', 'created_at')
    for (const note of notes) {
      interactions.push({ type: 'note', content: note.content?.substring(0, 200) || '', date: note.created_at })
    }
  } catch {}

  try {
    const emails = await knex('email_messages')
      .where('contact_id', contactId)
      .where('organization_id', orgId)
      .orderBy('created_at', 'desc')
      .limit(5)
      .select('subject', 'direction', 'created_at')
    for (const email of emails) {
      interactions.push({
        type: 'email',
        content: `${email.direction === 'outbound' ? 'Sent' : 'Received'}: ${email.subject}`,
        date: email.created_at,
      })
    }
  } catch {}

  // Sort by date desc and take top 5
  interactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  interactions.splice(5)

  // Load active deals. NOTE: deals link to contacts through customer_deal_people
  // (person_entity_id) — customer_deals has no contact_id column, and the stage
  // column is pipeline_stage. The old direct query threw on both and silently
  // returned [] via the catch, so briefs never saw deals.
  let deals: Array<{ title: string; value: number; status: string; stage: string | null; aiSummary?: string | null }> = []
  try {
    const rows = await knex('customer_deal_people as cdp')
      .join('customer_deals as cd', 'cd.id', 'cdp.deal_id')
      .where('cdp.person_entity_id', contactId)
      .where('cd.organization_id', orgId)
      .where('cd.status', 'open')
      .whereNull('cd.deleted_at')
      .select('cd.title', 'cd.value_amount', 'cd.status', 'cd.pipeline_stage', 'cd.ai_summary')
      .limit(5)
    deals = rows.map((d: any) => ({
      title: d.title,
      value: Number(d.value_amount || 0),
      status: d.status,
      stage: d.pipeline_stage,
      aiSummary: d.ai_summary || null,
    }))
  } catch {}

  // Open commitments, both directions — the "keep your promises" section.
  const commitments = await listOpenCommitments(knex, orgId, contactId)

  return { contact, engagementScore, interactions, deals, commitments }
}

async function generateBrief(
  contactData: NonNullable<Awaited<ReturnType<typeof loadContactData>>>,
  eventSummary: string | null,
  personaPrompt: string,
  orgId?: string | null,
  byoApiKey?: string | null,
): Promise<string> {
  // Over-allowance orgs that gated through on a BYO key run on that key.
  const apiKey = byoApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!apiKey) {
    throw new Error('Gemini API key not configured')
  }

  const { contact, engagementScore, interactions, deals, commitments } = contactData as typeof contactData & { commitments?: Awaited<ReturnType<typeof listOpenCommitments>> }

  const dataSection = `
CONTACT: ${contact.display_name}
Email: ${contact.primary_email || 'N/A'}
Lifecycle Stage: ${contact.lifecycle_stage || 'Unknown'}
Engagement Score: ${engagementScore !== null ? engagementScore : 'N/A'}
Source: ${contact.source || 'Unknown'}
In CRM since: ${new Date(contact.created_at).toLocaleDateString()}
${eventSummary ? `\nMEETING: ${eventSummary}` : ''}

RECENT INTERACTIONS (last 5):
${interactions.length > 0 ? interactions.map(i => `- [${i.type}] ${new Date(i.date).toLocaleDateString()}: ${i.content}`).join('\n') : 'No recent interactions'}

ACTIVE DEALS:
${deals.length > 0 ? deals.map(d => `- "${d.title}" — $${d.value.toLocaleString()}${d.stage ? ` (${d.stage})` : ''}${d.aiSummary ? `\n  Status: ${String(d.aiSummary).slice(0, 300)}` : ''}`).join('\n') : 'No active deals'}
${formatCommitmentsForBrief(commitments ?? [])}`

  const prompt = `${personaPrompt}

Generate a concise meeting prep brief in clean HTML format. Include:
- Key context about this person and the relationship
- Relationship status assessment
- 3-4 suggested talking points
- Open commitments, both directions: lead with anything WE promised (deliver or acknowledge it), and gently follow up on anything THEY promised
- A recommended ask or next step

Format as HTML (no outer html/head/body tags). Use inline styles. Keep it scannable — this should be a quick read before the meeting.

DATA:
${dataSection}`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 1500 },
      }),
    },
  )

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({}))
    throw new Error(`Gemini API error (${res.status}): ${JSON.stringify(errorData)}`)
  }

  const result = await res.json()
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text || ''

  void meterCustomersAi({ orgId }, {
    model: 'gemini-3.5-flash',
    tokensIn: result?.usageMetadata?.promptTokenCount || 0,
    tokensOut: result?.usageMetadata?.candidatesTokenCount || 0,
    feature: 'meeting-prep',
    byoKey: !!byoApiKey,
  })

  return text.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim()
}

// ── GET — Generate meeting prep for upcoming events or specific contact ──────

export async function GET(req: Request) {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.tenantId || !auth?.orgId || !auth?.userId) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    // Gate before generating any brief (interactive path was ungated).
    const gate = await checkCustomersAiAllowance(auth)
    if (!gate.allowed) return NextResponse.json({ ok: false, error: gate.message }, { status: 402 })

    const url = new URL(req.url)
    const contactId = url.searchParams.get('contactId')

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const persona = await getPersonaForOrg(knex, auth.orgId)
    const personaPrompt = persona ? buildPersonaPrompt(persona) : 'You are Scout, a professional business assistant.'

    // On-demand brief for a specific contact
    if (contactId) {
      // Refresh commitment extraction for this contact before the brief —
      // bounded cost (one flash call, only when there's new mail). Caller
      // meters per the ai-summaries house rule.
      try {
        const extractKey = gate.byoApiKey || process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY
        if (extractKey) {
          const ext = await extractCommitmentsForContact(knex, extractKey, auth.orgId, auth.tenantId ?? null, contactId)
          if (ext.tokensIn > 0) {
            void meterCustomersAi(auth, { model: ext.model, tokensIn: ext.tokensIn, tokensOut: ext.tokensOut, feature: 'commitments-extract', byoKey: !!gate.byoApiKey })
          }
        }
      } catch { /* non-fatal */ }
      const contactData = await loadContactData(knex, auth.orgId, contactId)
      if (!contactData) {
        return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })
      }

      const brief = await generateBrief(contactData, null, personaPrompt, auth.orgId, gate.byoApiKey)

      const result: MeetingPrepResult = {
        contact: {
          id: contactData.contact.id,
          displayName: contactData.contact.display_name,
          email: contactData.contact.primary_email || '',
          lifecycleStage: contactData.contact.lifecycle_stage,
          engagementScore: contactData.engagementScore,
          source: contactData.contact.source,
        },
        brief,
        upcomingEvent: null,
      }

      return NextResponse.json({ ok: true, data: [result] })
    }

    // Calendar-based: upcoming events in the next 2 hours
    const calConnection = await knex('google_calendar_connections')
      .where('user_id', auth.userId)
      .where('is_active', true)
      .first()

    if (!calConnection) {
      return NextResponse.json({
        ok: true,
        data: [],
        message: 'No Google Calendar connected. Connect in Settings to get automatic meeting prep.',
      })
    }

    const events = await getUpcomingEvents(knex, calConnection, 2)
    const briefs: MeetingPrepResult[] = []

    for (const event of events) {
      if (!event.attendees || event.attendees.length === 0) continue

      // Match attendees to CRM contacts
      const attendeeEmails = event.attendees
        .map(a => a.email?.toLowerCase())
        .filter(Boolean)

      if (attendeeEmails.length === 0) continue

      const matchingContacts = await knex('customer_entities')
        .where('organization_id', auth.orgId)
        .whereNull('deleted_at')
        .whereRaw('lower(primary_email) = ANY(?)', [attendeeEmails])
        .select('id')
        .limit(3)

      for (const mc of matchingContacts) {
        // Check if we already have a cached brief
        const cached = await knex('meeting_prep_briefs')
          .where('organization_id', auth.orgId)
          .where('contact_id', mc.id)
          .where('event_start', event.start.dateTime || event.start.date)
          .where('created_at', '>', new Date(Date.now() - 4 * 60 * 60 * 1000)) // Cache for 4 hours
          .first()

        if (cached) {
          const contactData = await loadContactData(knex, auth.orgId, mc.id)
          if (contactData) {
            briefs.push({
              contact: {
                id: contactData.contact.id,
                displayName: contactData.contact.display_name,
                email: contactData.contact.primary_email || '',
                lifecycleStage: contactData.contact.lifecycle_stage,
                engagementScore: contactData.engagementScore,
                source: contactData.contact.source,
              },
              brief: cached.brief_html,
              upcomingEvent: {
                summary: event.summary || 'Untitled Event',
                startTime: event.start.dateTime || event.start.date || '',
              },
            })
          }
          continue
        }

        const contactData = await loadContactData(knex, auth.orgId, mc.id)
        if (!contactData) continue

        const brief = await generateBrief(contactData, event.summary || 'Untitled Event', personaPrompt, auth.orgId, gate.byoApiKey)

        // Cache the brief
        try {
          await knex('meeting_prep_briefs').insert({
            tenant_id: auth.tenantId,
            organization_id: auth.orgId,
            user_id: auth.userId,
            contact_id: mc.id,
            event_summary: event.summary || null,
            event_start: event.start.dateTime || event.start.date,
            brief_html: brief,
          })
        } catch {}

        briefs.push({
          contact: {
            id: contactData.contact.id,
            displayName: contactData.contact.display_name,
            email: contactData.contact.primary_email || '',
            lifecycleStage: contactData.contact.lifecycle_stage,
            engagementScore: contactData.engagementScore,
            source: contactData.contact.source,
          },
          brief,
          upcomingEvent: {
            summary: event.summary || 'Untitled Event',
            startTime: event.start.dateTime || event.start.date || '',
          },
        })
      }
    }

    return NextResponse.json({ ok: true, data: briefs })
  } catch (error) {
    console.error('[ai.meeting-prep] GET error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to generate meeting prep' }, { status: 500 })
  }
}

// ── POST — Cron-triggered: generate briefs for all orgs ──────────────────────

// A single meeting + brief queued for the owner summary email.
interface BriefForEmail {
  briefId: string | null
  eventSummary: string
  startTime: string
  contactName: string
  briefHtml: string
}

function buildMeetingPrepEmailHtml(briefs: BriefForEmail[]): string {
  const sorted = [...briefs].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  )
  const items = sorted
    .map((b) => {
      const when = b.startTime ? new Date(b.startTime).toLocaleString() : 'Soon'
      return `
        <div style="margin:0 0 28px 0;padding:0 0 24px 0;border-bottom:1px solid #eee;">
          <div style="font-size:16px;font-weight:600;color:#111;margin-bottom:2px;">${b.eventSummary}</div>
          <div style="font-size:13px;color:#666;margin-bottom:12px;">${when} with ${b.contactName}</div>
          <div style="font-size:14px;color:#222;line-height:1.5;">${b.briefHtml}</div>
        </div>`
    })
    .join('')
  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:640px;">
      <h2 style="font-size:20px;color:#111;margin:0 0 4px 0;">Today's meeting prep</h2>
      <p style="font-size:14px;color:#666;margin:0 0 24px 0;">You have ${sorted.length} upcoming ${sorted.length === 1 ? 'meeting' : 'meetings'} with people in your CRM. Here is a quick brief for each.</p>
      ${items}
    </div>`
}

export async function POST(req: Request) {
  const denied = requireProcessAuth(req, process.env.SEQUENCE_PROCESS_SECRET)
  if (denied) return denied

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Find all orgs with Google Calendar connections
    const connections = await knex('google_calendar_connections')
      .where('is_active', true)
      .select('id', 'user_id', 'organization_id', 'access_token', 'refresh_token', 'token_expiry', 'calendar_id')

    let generated = 0
    let skipped = 0
    let failed = 0
    let emailed = 0

    for (const connection of connections) {
      try {
        // Per-org opt-in. business_profiles.meeting_prep_enabled defaults on;
        // treat a missing column/row as enabled so the feature is default-on.
        let orgProfile = await knex('business_profiles')
          .where('organization_id', connection.organization_id)
          .select('tenant_id', 'meeting_prep_enabled')
          .first()
          .catch(() => null as { tenant_id?: string; meeting_prep_enabled?: boolean } | null)

        if (orgProfile && orgProfile.meeting_prep_enabled === false) {
          skipped++
          continue
        }

        if (!orgProfile?.tenant_id) {
          // Try email_connections for tenant_id
          const emailConn = await knex('email_connections')
            .where('organization_id', connection.organization_id)
            .select('tenant_id')
            .first()

          if (!emailConn) {
            skipped++
            continue
          }
          connection.tenant_id = emailConn.tenant_id
        } else {
          connection.tenant_id = orgProfile.tenant_id
        }

        // Get events in the next 24 hours so the daily prep email covers the day.
        const events = await getUpcomingEvents(knex, connection, 24)
        const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000)

        const relevantEvents = events.filter(event => {
          const startTime = new Date(event.start.dateTime || event.start.date || '')
          return startTime >= oneHourFromNow
        })

        if (relevantEvents.length === 0) {
          skipped++
          continue
        }

        // Skip orgs over their AI allowance — briefs are AI-generated.
        const capGate = await checkCustomersAiAllowance({ orgId: connection.organization_id })
        if (!capGate.allowed) {
          skipped++
          continue
        }

        const persona = await getPersonaForOrg(knex, connection.organization_id)
        const personaPrompt = persona ? buildPersonaPrompt(persona) : 'You are Scout, a professional business assistant.'

        // Collect every brief for an upcoming meeting (newly generated + cached)
        // so the owner email is a complete picture of the day.
        const briefsForEmail: BriefForEmail[] = []

        for (const event of relevantEvents) {
          if (!event.attendees || event.attendees.length === 0) continue

          const attendeeEmails = event.attendees
            .map(a => a.email?.toLowerCase())
            .filter(Boolean)

          const matchingContacts = await knex('customer_entities')
            .where('organization_id', connection.organization_id)
            .whereNull('deleted_at')
            .whereRaw('lower(primary_email) = ANY(?)', [attendeeEmails])
            .select('id', 'display_name')
            .limit(3)

          for (const mc of matchingContacts) {
            const eventStart = event.start.dateTime || event.start.date
            // Reuse the cached brief if we already generated one for this meeting.
            const existing = await knex('meeting_prep_briefs')
              .where('organization_id', connection.organization_id)
              .where('contact_id', mc.id)
              .where('event_start', eventStart)
              .first()

            if (existing) {
              briefsForEmail.push({
                briefId: existing.id,
                eventSummary: event.summary || 'Untitled Event',
                startTime: eventStart || '',
                contactName: mc.display_name || existing.event_summary || 'a contact',
                briefHtml: existing.brief_html,
              })
              continue
            }

            const contactData = await loadContactData(knex, connection.organization_id, mc.id)
            if (!contactData) continue

            const brief = await generateBrief(contactData, event.summary || 'Untitled Event', personaPrompt, connection.organization_id, capGate.byoApiKey)

            const briefId = crypto.randomUUID()
            await knex('meeting_prep_briefs').insert({
              id: briefId,
              tenant_id: connection.tenant_id,
              organization_id: connection.organization_id,
              user_id: connection.user_id,
              contact_id: mc.id,
              event_summary: event.summary || null,
              event_start: eventStart,
              brief_html: brief,
            })

            generated++
            briefsForEmail.push({
              briefId,
              eventSummary: event.summary || 'Untitled Event',
              startTime: eventStart || '',
              contactName: contactData.contact.display_name || 'a contact',
              briefHtml: brief,
            })
          }
        }

        if (briefsForEmail.length === 0) {
          skipped++
          continue
        }

        // Idempotency: only email briefs we have not already emailed (tracked
        // via meeting_prep_briefs.emailed_at). A re-run the same day re-sends
        // nothing because every brief is already marked emailed.
        const unEmailed: BriefForEmail[] = []
        for (const b of briefsForEmail) {
          if (!b.briefId) { unEmailed.push(b); continue }
          const row = await knex('meeting_prep_briefs')
            .where('id', b.briefId)
            .select('emailed_at')
            .first()
            .catch(() => null as { emailed_at?: string | null } | null)
          // If the column is missing the row read still succeeds (no emailed_at
          // key) -> treat as not yet emailed. If present and set, skip it.
          if (!row || !row.emailed_at) unEmailed.push(b)
        }

        if (unEmailed.length === 0) {
          skipped++
          continue
        }

        // Owner-only delivery: send to the org's active email connection.
        const emailConnection = await knex('email_connections')
          .where('organization_id', connection.organization_id)
          .where('is_active', true)
          .orderBy('is_primary', 'desc')
          .first()

        if (!emailConnection) {
          skipped++
          continue
        }

        const html = buildMeetingPrepEmailHtml(unEmailed)
        const sendResult = await sendEmailByPurpose(
          knex,
          connection.organization_id,
          connection.tenant_id,
          'transactional',
          {
            to: emailConnection.email_address,
            subject: `Today's meeting prep (${unEmailed.length})`,
            htmlBody: html,
          },
        )

        if (sendResult.ok) {
          emailed++
          // Mark these briefs emailed so re-runs are idempotent. Best-effort:
          // if the emailed_at column is not present yet the update is a no-op.
          const ids = unEmailed.map(b => b.briefId).filter((x): x is string => !!x)
          if (ids.length > 0) {
            await knex('meeting_prep_briefs')
              .whereIn('id', ids)
              .update({ emailed_at: new Date() })
              .catch(() => {})
          }
        } else {
          failed++
        }
      } catch (err) {
        console.error(`[ai.meeting-prep] Cron error for connection ${connection.id}:`, err)
        failed++
      }
    }

    return NextResponse.json({ ok: true, data: { generated, emailed, skipped, failed } })
  } catch (error) {
    console.error('[ai.meeting-prep] POST error:', error)
    return NextResponse.json({ ok: false, error: 'Failed to process meeting prep' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'AI',
  summary: 'Meeting Prep Brief',
  methods: {
    GET: { summary: 'Generate meeting prep briefs for upcoming calendar events or a specific contact', tags: ['AI'] },
    POST: { summary: 'Generate and cache meeting prep briefs for all orgs (cron)', tags: ['AI'] },
  },
}
