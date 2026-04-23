// ORM-SKIP: analytics/aggregation — complex GROUP BY/JSONB/multi-table joins better served by raw SQL
export const metadata = { path: '/contacts/[id]/timeline', GET: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'


type TimelineEvent = {
  type: string
  title: string
  description?: string
  icon: string
  timestamp: string
  metadata?: Record<string, unknown>
}

function isEncrypted(val: any): boolean {
  if (typeof val !== 'string') return false
  return /^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:v\d+$/.test(val)
}

function cleanStr(val: any): string | undefined {
  if (!val || isEncrypted(val)) return undefined
  return val
}

export async function GET(
  _req: Request,
  ctx: any,
) {
  const params = ctx?.params ? await ctx.params : undefined
  // Prefer ctx.auth (populated for x-api-key + cookies by the router)
  // and fall back to cookie-only resolution for legacy callers.
  const auth = ctx?.auth ?? (await getAuthFromCookies())
  console.log('[timeline] Auth:', auth ? `org=${auth.orgId}` : 'NULL')
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  const { id: contactId } = (params || {}) as { id: string }

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    // Verify the contact belongs to this organization
    const contact = await knex('customer_entities')
      .where('id', contactId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    if (!contact) {
      return NextResponse.json({ ok: false, error: 'Contact not found' }, { status: 404 })
    }

    const events: TimelineEvent[] = []

    // 1. Customer activities (by entity_id — customer_activities table)
    try {
      const activities = await knex('customer_activities')
        .where('entity_id', contactId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(50)
      for (const activity of activities) {
        const title = cleanStr(activity.subject) || 'Activity recorded'
        if (isEncrypted(title)) continue
        events.push({
          type: 'activity', title,
          description: cleanStr(activity.activity_type),
          icon: 'Activity', timestamp: activity.created_at,
          metadata: { activityType: activity.activity_type },
        })
      }
    } catch {}

    // 2. Customer comments / notes (by entity_id — customer_comments table)
    try {
      const comments = await knex('customer_comments')
        .where('entity_id', contactId)
        .where('organization_id', auth.orgId)
        .whereNull('deleted_at')
        .orderBy('created_at', 'desc')
        .limit(50)
      for (const comment of comments) {
        if (isEncrypted(comment.body)) continue
        const preview = comment.body?.length > 80 ? comment.body.substring(0, 80) + '...' : comment.body
        events.push({ type: 'note', title: 'Note added', description: preview || undefined, icon: 'StickyNote', timestamp: comment.created_at })
      }
    } catch {}

    // 3. Deals linked to this contact (via customer_deal_people junction)
    try {
    const dealLinks = await knex('customer_deal_people as cdp')
      .join('customer_deals as cd', 'cd.id', 'cdp.deal_id')
      .where('cdp.person_entity_id', contactId)
      .where('cd.organization_id', auth.orgId)
      .whereNull('cd.deleted_at')
      .select(
        'cd.id',
        'cd.title',
        'cd.status',
        'cd.value_amount',
        'cd.value_currency',
        'cd.pipeline_stage',
        'cd.created_at',
        'cdp.role as participant_role',
      )
      .orderBy('cd.created_at', 'desc')
      .limit(50)

    for (const deal of dealLinks) {
      if (isEncrypted(deal.title)) continue
      const valuePart = deal.value_amount
        ? ` — ${deal.value_currency || '$'}${Number(deal.value_amount).toFixed(2)}`
        : ''
      events.push({
        type: 'deal',
        title: `Deal: ${deal.title || 'Untitled'}`,
        description: `${deal.status || 'open'}${deal.pipeline_stage ? ` (${deal.pipeline_stage})` : ''}${valuePart}`,
        icon: 'Handshake',
        timestamp: deal.created_at,
        metadata: {
          dealId: deal.id,
          status: deal.status,
          valueAmount: deal.value_amount,
          valueCurrency: deal.value_currency,
          participantRole: deal.participant_role,
        },
      })
    }
    } catch {}

    // 4. Customer tag assignments (join customer_tags for name)
    try {
    const tagAssignments = await knex('customer_tag_assignments as cta')
      .join('customer_tags as ct', 'ct.id', 'cta.tag_id')
      .where('cta.entity_id', contactId)
      .where('cta.organization_id', auth.orgId)
      .select('cta.id', 'cta.created_at', 'ct.name as tag_name')
      .orderBy('cta.created_at', 'desc')
      .limit(50)

    for (const tag of tagAssignments) {
      events.push({
        type: 'tag',
        title: 'Tag added',
        description: tag.tag_name || undefined,
        icon: 'Tag',
        timestamp: tag.created_at,
      })
    }
    } catch {}

    // 5. Email messages (by contact_id — email_messages table, app module)
    const emails = await knex('email_messages')
      .where('contact_id', contactId)
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .catch(() => [])

    for (const email of emails) {
      if (isEncrypted(email.subject)) continue
      events.push({
        type: 'email',
        title: email.direction === 'inbound' ? 'Received email' : 'Sent email',
        description: cleanStr(email.subject),
        icon: 'Mail',
        timestamp: email.created_at,
        metadata: {
          direction: email.direction,
          status: email.status,
          opened_at: email.opened_at || undefined,
          clicked_at: email.clicked_at || undefined,
        },
      })
    }

    // 6. Form submissions (by contact_id — form_submissions table, app module)
    const submissions = await knex('form_submissions as fs')
      .leftJoin('landing_pages as lp', 'lp.id', 'fs.landing_page_id')
      .where('fs.contact_id', contactId)
      .where('fs.organization_id', auth.orgId)
      .select('fs.id', 'fs.created_at', 'lp.title as page_title')
      .orderBy('fs.created_at', 'desc')
      .limit(50)
      .catch(() => [])

    for (const sub of submissions) {
      events.push({
        type: 'form_submission',
        title: 'Form submitted',
        description: sub.page_title ? `On "${sub.page_title}"` : undefined,
        icon: 'FileText',
        timestamp: sub.created_at,
      })
    }

    // 7. Customer todo links (tasks linked to this contact)
    try {
      const todoLinks = await knex('customer_todo_links')
        .where('entity_id', contactId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(50)
      for (const todo of todoLinks) {
        events.push({
          type: 'task', title: 'Task linked',
          description: todo.todo_source || undefined,
          icon: 'CheckSquare', timestamp: todo.created_at,
          metadata: { todoId: todo.todo_id, todoSource: todo.todo_source },
        })
      }
    } catch {}

    // 8. Custom timeline events (pipeline changes, lifecycle changes, payments, etc.)
    try {
      const customEvents = await knex('contact_timeline_events')
        .where('contact_id', contactId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(50)
      for (const ce of customEvents) {
        const iconMap: Record<string, string> = {
          lifecycle_change: 'TrendingUp', pipeline_change: 'Activity', engagement_change: 'Flame',
          payment: 'DollarSign', survey_response: 'FileText', chat: 'MessageSquare',
          event_registration: 'CalendarCheck', course_enrollment: 'BookOpen', booking_created: 'CalendarDays',
        }
        const typeMap: Record<string, string> = {
          lifecycle_change: 'activity', pipeline_change: 'activity', engagement_change: 'engagement',
          payment: 'invoice', survey_response: 'form_submission', chat: 'note',
          event_registration: 'event', course_enrollment: 'course', booking_created: 'event',
        }
        events.push({
          type: typeMap[ce.event_type] || 'activity',
          title: ce.title,
          description: ce.description || undefined,
          icon: iconMap[ce.event_type] || 'Activity',
          timestamp: ce.created_at,
          metadata: ce.metadata ? (typeof ce.metadata === 'string' ? JSON.parse(ce.metadata) : ce.metadata) : undefined,
        })
      }
    } catch {}

    // 9. Contact notes (contact_notes table — our custom notes)
    try {
      const notes = await knex('contact_notes')
        .where('contact_id', contactId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(30)
      for (const note of notes) {
        if (isEncrypted(note.content)) continue
        const preview = note.content?.length > 80 ? note.content.substring(0, 80) + '...' : note.content
        events.push({ type: 'note', title: 'Note', description: preview, icon: 'StickyNote', timestamp: note.created_at })
      }
    } catch {}

    // 9. Event registrations
    try {
      const registrations = await knex('event_attendees as ea')
        .join('events as ev', 'ev.id', 'ea.event_id')
        .where('ea.contact_id', contactId)
        .where('ea.organization_id', auth.orgId)
        .select('ea.registered_at', 'ea.status', 'ea.ticket_quantity', 'ev.title as event_title', 'ev.start_time')
        .orderBy('ea.registered_at', 'desc')
        .limit(20)
      for (const reg of registrations) {
        events.push({
          type: 'event', title: `Registered for ${reg.event_title}`,
          description: `${new Date(reg.start_time).toLocaleDateString()}${reg.ticket_quantity > 1 ? ` · ${reg.ticket_quantity} tickets` : ''}`,
          icon: 'CalendarCheck', timestamp: reg.registered_at,
        })
      }
    } catch {}

    // 10. Course enrollments
    try {
      const enrollments = await knex('course_enrollments as ce')
        .join('courses as c', 'c.id', 'ce.course_id')
        .where('ce.contact_id', contactId)
        .where('ce.organization_id', auth.orgId)
        .select('ce.enrolled_at', 'ce.status', 'c.title as course_title')
        .orderBy('ce.enrolled_at', 'desc')
        .limit(20)
      for (const enr of enrollments) {
        events.push({
          type: 'course', title: `Enrolled in ${enr.course_title}`,
          description: enr.status === 'active' ? 'Active enrollment' : enr.status,
          icon: 'BookOpen', timestamp: enr.enrolled_at,
        })
      }
    } catch {}

    // 11. Bookings
    try {
      const bookings = await knex('bookings')
        .where('contact_id', contactId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(20)
      for (const booking of bookings) {
        events.push({
          type: 'booking', title: 'Booking',
          description: `${new Date(booking.start_time).toLocaleDateString()} · ${booking.status}`,
          icon: 'Calendar', timestamp: booking.created_at,
        })
      }
    } catch {}

    // 12. Tasks (our custom tasks table)
    try {
      const tasks = await knex('tasks')
        .where('contact_id', contactId)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(20)
      for (const task of tasks) {
        events.push({
          type: 'task', title: task.is_done ? 'Task completed' : 'Task created',
          description: task.title,
          icon: 'CheckSquare', timestamp: task.is_done ? task.completed_at || task.created_at : task.created_at,
        })
      }
    } catch {}

    // 13. Contact created
    events.push({
      type: 'contact_created', title: 'Contact added',
      description: contact.source ? `Source: ${contact.source}` : undefined,
      icon: 'UserPlus', timestamp: contact.created_at,
    })

    // Sort all events by timestamp DESC and limit to 50
    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    const limited = events.slice(0, 50)

    console.log(`[timeline] Contact ${contactId}: ${limited.length} events found`)
    return NextResponse.json({ ok: true, data: limited })
  } catch (error) {
    console.error('[contacts.timeline] CRASH:', error)
    return NextResponse.json({ ok: false, error: 'Failed to fetch timeline' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Contacts',
  summary: 'Unified contact activity timeline',
  methods: {
    GET: {
      summary: 'Get a unified timeline of all events for a contact',
      tags: ['Contacts'],
    },
  },
}
