// ORM-SKIP: analytics/aggregation — complex GROUP BY/JSONB/multi-table joins better served by raw SQL
export const metadata = { path: '/contacts/[id]/summary', GET: { requireAuth: true }, POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

// GET — load saved summary (no generation)
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { id: contactId } = await params

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const contact = await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!contact) return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })

    if (contact.ai_summary) {
      return NextResponse.json({
        ok: true,
        data: {
          summary: contact.ai_summary,
          generatedAt: contact.ai_summary_at || null,
          isAi: true,
        },
      })
    }

    return NextResponse.json({ ok: true, data: null })
  } catch (error) {
    console.error('[contacts.summary.GET]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

// POST — generate (or regenerate) and save the summary
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { id: contactId } = await params

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const contact = await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!contact) return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })

    // Fetch all interaction data sources in parallel
    const [
      emails, comments, todoLinks, engagementRow,
      contactNotes, timelineEvents, eventRegistrations,
      courseEnrollments, contactTasks, bookings, deals,
    ] = await Promise.all([
      knex('email_messages')
        .where('contact_id', contactId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(10)
        .select('subject', 'direction', 'created_at', 'body_text')
        .catch(() => []),
      knex('customer_comments')
        .where('entity_id', contactId)
        .where('organization_id', auth.orgId)
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .limit(10)
        .select('body', 'created_at')
        .catch(() => []),
      knex('customer_todo_links')
        .where('entity_id', contactId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(5)
        .select('todo_source', 'created_at')
        .catch(() => []),
      knex('contact_engagement_scores')
        .where('contact_id', contactId)
        .where('organization_id', auth.orgId)
        .first()
        .catch(() => null),
      // Contact notes (our custom notes table)
      knex('contact_notes')
        .where('contact_id', contactId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(10)
        .select('content', 'created_at')
        .catch(() => []),
      // Custom timeline events (lifecycle changes, payments, etc.)
      knex('contact_timeline_events')
        .where('contact_id', contactId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(15)
        .select('event_type', 'title', 'description', 'created_at')
        .catch(() => []),
      // Event registrations
      knex('event_attendees as ea')
        .join('events as ev', 'ev.id', 'ea.event_id')
        .where('ea.contact_id', contactId)
        .where('ea.organization_id', auth.orgId)
        .select('ev.title as event_title', 'ea.status', 'ea.registered_at', 'ev.start_time')
        .orderBy('ea.registered_at', 'desc')
        .limit(10)
        .catch(() => []),
      // Course enrollments
      knex('course_enrollments as ce')
        .join('courses as c', 'c.id', 'ce.course_id')
        .where('ce.contact_id', contactId)
        .where('ce.organization_id', auth.orgId)
        .select('c.title as course_title', 'ce.status', 'ce.enrolled_at')
        .orderBy('ce.enrolled_at', 'desc')
        .limit(10)
        .catch(() => []),
      // Tasks
      knex('tasks')
        .where('contact_id', contactId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(10)
        .select('title', 'is_done', 'due_date', 'created_at')
        .catch(() => []),
      // Bookings
      knex('bookings')
        .where('contact_id', contactId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(5)
        .select('start_time', 'status', 'created_at')
        .catch(() => []),
      // Deals
      knex('customer_deal_people as cdp')
        .join('customer_deals as cd', 'cd.id', 'cdp.deal_id')
        .where('cdp.person_entity_id', contactId)
        .where('cd.organization_id', auth.orgId)
        .whereNull('cd.deleted_at')
        .select('cd.title', 'cd.status', 'cd.value_amount', 'cd.value_currency', 'cd.pipeline_stage', 'cd.created_at')
        .orderBy('cd.created_at', 'desc')
        .limit(5)
        .catch(() => []),
    ])

    const engagementScore = engagementRow?.score ?? 0
    const stage = contact.lifecycle_stage || 'unknown'

    const emailSummaries = emails.map((e: any) => {
      const preview = e.body_text?.substring(0, 100) || e.subject || 'No subject'
      return `${e.direction === 'inbound' ? 'Received' : 'Sent'}: "${preview}" (${formatDate(e.created_at)})`
    }).join('; ')

    const commentSummaries = comments.map((n: any) => {
      const preview = n.body?.length > 80 ? n.body.substring(0, 80) + '...' : n.body
      return `"${preview}" (${formatDate(n.created_at)})`
    }).join('; ')

    const todoSummaries = todoLinks.map((t: any) =>
      `${t.todo_source || 'Task'} (${formatDate(t.created_at)})`
    ).join('; ')

    const noteSummaries = contactNotes.map((n: any) => {
      const preview = n.content?.length > 80 ? n.content.substring(0, 80) + '...' : n.content
      return `"${preview}" (${formatDate(n.created_at)})`
    }).join('; ')

    const timelineSummaries = timelineEvents.map((te: any) =>
      `${te.title}${te.description ? ': ' + te.description : ''} (${formatDate(te.created_at)})`
    ).join('; ')

    const eventSummaries = eventRegistrations.map((r: any) =>
      `Registered for "${r.event_title}" on ${new Date(r.start_time).toLocaleDateString()} — ${r.status} (${formatDate(r.registered_at)})`
    ).join('; ')

    const courseSummaries = courseEnrollments.map((e: any) =>
      `Enrolled in "${e.course_title}" — ${e.status} (${formatDate(e.enrolled_at)})`
    ).join('; ')

    const taskSummaries = contactTasks.map((t: any) =>
      `${t.is_done ? '✓' : '○'} "${t.title}"${t.due_date ? ` due ${new Date(t.due_date).toLocaleDateString()}` : ''} (${formatDate(t.created_at)})`
    ).join('; ')

    const bookingSummaries = bookings.map((b: any) =>
      `Booking on ${new Date(b.start_time).toLocaleDateString()} — ${b.status} (${formatDate(b.created_at)})`
    ).join('; ')

    const dealSummaries = deals.map((d: any) => {
      const value = d.value_amount ? ` ${d.value_currency || '$'}${Number(d.value_amount).toFixed(0)}` : ''
      return `"${d.title}" — ${d.status}${d.pipeline_stage ? ` (${d.pipeline_stage})` : ''}${value} (${formatDate(d.created_at)})`
    }).join('; ')

    const allDates = [
      ...emails.map((e: any) => new Date(e.created_at).getTime()),
      ...comments.map((n: any) => new Date(n.created_at).getTime()),
      ...contactNotes.map((n: any) => new Date(n.created_at).getTime()),
      ...timelineEvents.map((te: any) => new Date(te.created_at).getTime()),
    ].filter(Boolean)
    const lastContactDate = allDates.length > 0 ? new Date(Math.max(...allDates)) : null

    let summary: string
    let isAi = false
    const aiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY

    if (aiKey) {
      const promptSections = [
        `Contact: ${contact.display_name}`,
        `Stage: ${stage}`,
        `Engagement score: ${engagementScore}/100`,
        `
Recent emails: ${emailSummaries || 'None'}`,
        `CRM notes/comments: ${commentSummaries || 'None'}`,
        noteSummaries ? `Contact notes: ${noteSummaries}` : null,
        timelineSummaries ? `Activity timeline: ${timelineSummaries}` : null,
        eventSummaries ? `Event registrations: ${eventSummaries}` : null,
        courseSummaries ? `Course enrollments: ${courseSummaries}` : null,
        taskSummaries ? `Tasks: ${taskSummaries}` : null,
        bookingSummaries ? `Bookings: ${bookingSummaries}` : null,
        dealSummaries ? `Deals: ${dealSummaries}` : null,
        todoSummaries ? `Linked tasks: ${todoSummaries}` : null,
      ].filter(Boolean).join('\n')

      const prompt = `Summarize this contact's relationship status based on their recent interactions. Be concise (3-4 sentences max). Focus on: relationship health, key activities and engagements, what's happening now, and any suggested next steps. Write in a natural, professional tone — no bullet points.

${promptSections}`

      try {
        const aiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${aiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { maxOutputTokens: 300 },
            }),
          },
        )
        const aiData = await aiRes.json()
        const aiText = aiData.candidates?.[0]?.content?.parts?.[0]?.text
        if (aiText) {
          summary = aiText.trim()
          isAi = true
        } else {
          summary = buildFallbackSummary(lastContactDate, emails.length, comments.length + contactNotes.length, stage, engagementScore, eventRegistrations.length, courseEnrollments.length, contactTasks.length, deals.length)
        }
      } catch {
        summary = buildFallbackSummary(lastContactDate, emails.length, comments.length + contactNotes.length, stage, engagementScore, eventRegistrations.length, courseEnrollments.length, contactTasks.length, deals.length)
      }
    } else {
      summary = buildFallbackSummary(lastContactDate, emails.length, comments.length + contactNotes.length, stage, engagementScore, eventRegistrations.length, courseEnrollments.length, contactTasks.length, deals.length)
    }

    // Save to DB
    const now = new Date()
    await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .update({ ai_summary: summary, ai_summary_at: now, updated_at: now })

    return NextResponse.json({
      ok: true,
      data: { summary, generatedAt: now.toISOString(), isAi },
    })
  } catch (error) {
    console.error('[contacts.summary.POST]', error)
    return NextResponse.json({ ok: false, error: 'Failed to generate summary' }, { status: 500 })
  }
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  const diffDays = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24))
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`
  return `${Math.floor(diffDays / 30)} months ago`
}

function buildFallbackSummary(
  lastContactDate: Date | null,
  emailCount: number,
  noteCount: number,
  stage: string,
  engagementScore: number,
  eventCount = 0,
  courseCount = 0,
  taskCount = 0,
  dealCount = 0,
): string {
  const parts: string[] = []
  if (lastContactDate) {
    const diffDays = Math.floor((Date.now() - lastContactDate.getTime()) / (1000 * 60 * 60 * 24))
    parts.push(diffDays === 0 ? 'Last contacted today.' : diffDays === 1 ? 'Last contacted yesterday.' : `Last contacted ${diffDays} days ago.`)
  } else {
    parts.push('No recent interactions recorded.')
  }
  const items = []
  if (emailCount > 0) items.push(`${emailCount} email${emailCount !== 1 ? 's' : ''}`)
  if (noteCount > 0) items.push(`${noteCount} note${noteCount !== 1 ? 's' : ''}`)
  if (eventCount > 0) items.push(`${eventCount} event registration${eventCount !== 1 ? 's' : ''}`)
  if (courseCount > 0) items.push(`${courseCount} course enrollment${courseCount !== 1 ? 's' : ''}`)
  if (taskCount > 0) items.push(`${taskCount} task${taskCount !== 1 ? 's' : ''}`)
  if (dealCount > 0) items.push(`${dealCount} deal${dealCount !== 1 ? 's' : ''}`)
  if (items.length > 0) parts.push(`${items.join(', ')} in recent history.`)
  const health = engagementScore >= 20 ? 'highly engaged' : engagementScore >= 5 ? 'moderately engaged' : 'low engagement'
  parts.push(`Stage: ${stage}, ${health} (score: ${engagementScore}).`)
  return parts.join(' ')
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Contacts',
  summary: 'AI-generated contact relationship summary',
  methods: {
    GET: { summary: 'Load saved relationship summary', tags: ['Contacts'] },
    POST: { summary: 'Generate and save AI relationship summary', tags: ['Contacts'] },
  },
}
