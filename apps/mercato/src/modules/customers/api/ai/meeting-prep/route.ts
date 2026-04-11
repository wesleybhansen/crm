
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { buildPersonaPrompt, getPersonaForOrg } from '../persona'

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

  // Load active deals
  let deals: Array<{ title: string; value: number; status: string; stage: string | null }> = []
  try {
    deals = await knex('customer_deals')
      .where('organization_id', orgId)
      .where('contact_id', contactId)
      .where('status', 'open')
      .whereNull('deleted_at')
      .select('title', 'value_amount', 'status', 'stage')
      .limit(5)
    deals = deals.map(d => ({
      title: d.title,
      value: Number(d.value_amount || 0),
      status: d.status,
      stage: d.stage,
    }))
  } catch {}

  return { contact, engagementScore, interactions, deals }
}

async function generateBrief(
  contactData: NonNullable<Awaited<ReturnType<typeof loadContactData>>>,
  eventSummary: string | null,
  personaPrompt: string,
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY
  if (!apiKey) {
    throw new Error('Gemini API key not configured')
  }

  const { contact, engagementScore, interactions, deals } = contactData

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
${deals.length > 0 ? deals.map(d => `- "${d.title}" — $${d.value.toLocaleString()}${d.stage ? ` (${d.stage})` : ''}`).join('\n') : 'No active deals'}
`

  const prompt = `${personaPrompt}

Generate a concise meeting prep brief in clean HTML format. Include:
- Key context about this person and the relationship
- Relationship status assessment
- 3-4 suggested talking points
- A recommended ask or next step

Format as HTML (no outer html/head/body tags). Use inline styles. Keep it scannable — this should be a quick read before the meeting.

DATA:
${dataSection}`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  return text.replace(/^```html?\n?/i, '').replace(/\n?```$/i, '').trim()
}

// ── GET — Generate meeting prep for upcoming events or specific contact ──────

export async function GET(req: Request) {
  try {
    const auth = await getAuthFromCookies()
    if (!auth?.tenantId || !auth?.orgId || !auth?.userId) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const url = new URL(req.url)
    const contactId = url.searchParams.get('contactId')

    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const persona = await getPersonaForOrg(knex, auth.orgId)
    const personaPrompt = persona ? buildPersonaPrompt(persona) : 'You are Scout, a professional business assistant.'

    // On-demand brief for a specific contact
    if (contactId) {
      const contactData = await loadContactData(knex, auth.orgId, contactId)
      if (!contactData) {
        return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })
      }

      const brief = await generateBrief(contactData, null, personaPrompt)

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

        const brief = await generateBrief(contactData, event.summary || 'Untitled Event', personaPrompt)

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

export async function POST(req: Request) {
  const secret = process.env.SEQUENCE_PROCESS_SECRET
  if (secret) {
    const authHeader = req.headers.get('authorization')
    if (authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }
  } else if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ ok: false, error: 'SEQUENCE_PROCESS_SECRET not configured' }, { status: 500 })
  }

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

    for (const connection of connections) {
      try {
        // Get the tenant_id from the connection's org
        const orgProfile = await knex('business_profiles')
          .where('organization_id', connection.organization_id)
          .select('tenant_id')
          .first()

        if (!orgProfile) {
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

        // Get events starting in 1-2 hours
        const events = await getUpcomingEvents(knex, connection, 2)
        const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000)

        const relevantEvents = events.filter(event => {
          const startTime = new Date(event.start.dateTime || event.start.date || '')
          return startTime >= oneHourFromNow
        })

        if (relevantEvents.length === 0) {
          skipped++
          continue
        }

        const persona = await getPersonaForOrg(knex, connection.organization_id)
        const personaPrompt = persona ? buildPersonaPrompt(persona) : 'You are Scout, a professional business assistant.'

        for (const event of relevantEvents) {
          if (!event.attendees || event.attendees.length === 0) continue

          const attendeeEmails = event.attendees
            .map(a => a.email?.toLowerCase())
            .filter(Boolean)

          const matchingContacts = await knex('customer_entities')
            .where('organization_id', connection.organization_id)
            .whereNull('deleted_at')
            .whereRaw('lower(primary_email) = ANY(?)', [attendeeEmails])
            .select('id')
            .limit(3)

          for (const mc of matchingContacts) {
            // Skip if already generated
            const existing = await knex('meeting_prep_briefs')
              .where('organization_id', connection.organization_id)
              .where('contact_id', mc.id)
              .where('event_start', event.start.dateTime || event.start.date)
              .first()

            if (existing) continue

            const contactData = await loadContactData(knex, connection.organization_id, mc.id)
            if (!contactData) continue

            const brief = await generateBrief(contactData, event.summary || 'Untitled Event', personaPrompt)

            await knex('meeting_prep_briefs').insert({
              tenant_id: connection.tenant_id,
              organization_id: connection.organization_id,
              user_id: connection.user_id,
              contact_id: mc.id,
              event_summary: event.summary || null,
              event_start: event.start.dateTime || event.start.date,
              brief_html: brief,
            })

            generated++
          }
        }
      } catch (err) {
        console.error(`[ai.meeting-prep] Cron error for connection ${connection.id}:`, err)
        failed++
      }
    }

    return NextResponse.json({ ok: true, data: { generated, skipped, failed } })
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
