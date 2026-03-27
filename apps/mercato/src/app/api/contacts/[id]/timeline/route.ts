import { bootstrap } from '@/bootstrap'
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

    // 1. Email messages (by contact_id)
    const emails = await knex('email_messages')
      .where('contact_id', contactId)
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .catch(() => [])

    for (const email of emails) {
      events.push({
        type: 'email',
        title: email.direction === 'inbound' ? 'Received email' : 'Sent email',
        description: email.subject || undefined,
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

    // 2. Form submissions (by contact_id, join landing_pages for title)
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

    // 3. Customer activities (by entity_id)
    const activities = await knex('customer_activities')
      .where('entity_id', contactId)
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .catch(() => [])

    for (const activity of activities) {
      events.push({
        type: 'activity',
        title: activity.subject || 'Activity recorded',
        description: activity.activity_type || undefined,
        icon: 'Activity',
        timestamp: activity.created_at,
        metadata: { activityType: activity.activity_type },
      })
    }

    // 4. Contact notes (by contact_id via notes API pattern)
    const notes = await knex('contact_notes')
      .where('contact_id', contactId)
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .catch(() => [])

    for (const note of notes) {
      const preview = note.content?.length > 80
        ? note.content.substring(0, 80) + '...'
        : note.content
      events.push({
        type: 'note',
        title: 'Note added',
        description: preview || undefined,
        icon: 'StickyNote',
        timestamp: note.created_at,
      })
    }

    // 5. Tasks (by contact_id)
    const tasks = await knex('tasks')
      .where('contact_id', contactId)
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .catch(() => [])

    for (const task of tasks) {
      events.push({
        type: 'task',
        title: task.title || 'Task created',
        description: task.is_done ? 'Completed' : (task.due_date ? `Due ${new Date(task.due_date).toLocaleDateString()}` : 'Open'),
        icon: 'CheckSquare',
        timestamp: task.created_at,
        metadata: { isDone: task.is_done, dueDate: task.due_date },
      })
    }

    // 6. Invoices (by contact_id)
    const invoices = await knex('invoices')
      .where('contact_id', contactId)
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .catch(() => [])

    for (const inv of invoices) {
      events.push({
        type: 'invoice',
        title: `Invoice ${inv.invoice_number || ''}`.trim(),
        description: inv.total != null ? `$${Number(inv.total).toFixed(2)} - ${inv.status || 'draft'}` : inv.status || undefined,
        icon: 'DollarSign',
        timestamp: inv.created_at,
        metadata: { invoiceNumber: inv.invoice_number, total: inv.total, status: inv.status },
      })
    }

    // 7. Bookings (join via guest_email matching contact's primary_email)
    if (contact.primary_email) {
      const bookings = await knex('bookings')
        .where('guest_email', contact.primary_email)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'desc')
        .limit(50)
        .catch(() => [])

      for (const booking of bookings) {
        events.push({
          type: 'booking',
          title: 'Booking scheduled',
          description: booking.start_time
            ? `${new Date(booking.start_time).toLocaleString()} - ${booking.status || 'confirmed'}`
            : booking.status || undefined,
          icon: 'Calendar',
          timestamp: booking.created_at,
          metadata: { guestName: booking.guest_name, startTime: booking.start_time, status: booking.status },
        })
      }
    }

    // 8. SMS messages (by contact_id)
    const smsMessages = await knex('sms_messages')
      .where('contact_id', contactId)
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .catch(() => [])

    for (const sms of smsMessages) {
      const preview = sms.body?.length > 80
        ? sms.body.substring(0, 80) + '...'
        : sms.body
      events.push({
        type: 'sms',
        title: sms.direction === 'inbound' ? 'Received SMS' : 'Sent SMS',
        description: preview || undefined,
        icon: 'MessageSquare',
        timestamp: sms.created_at,
        metadata: { direction: sms.direction },
      })
    }

    // 9. Course enrollments (join via student_email matching contact's primary_email)
    if (contact.primary_email) {
      const enrollments = await knex('course_enrollments as ce')
        .leftJoin('courses as c', 'c.id', 'ce.course_id')
        .where('ce.student_email', contact.primary_email)
        .where('ce.organization_id', auth.orgId)
        .select('ce.id', 'ce.enrolled_at', 'ce.status', 'c.title as course_title')
        .orderBy('ce.enrolled_at', 'desc')
        .limit(50)
        .catch(() => [])

      for (const enrollment of enrollments) {
        events.push({
          type: 'course_enrollment',
          title: 'Enrolled in course',
          description: enrollment.course_title || undefined,
          icon: 'BookOpen',
          timestamp: enrollment.enrolled_at,
          metadata: { status: enrollment.status },
        })
      }
    }

    // 10. Customer tag assignments (join customer_tags for name)
    const tagAssignments = await knex('customer_tag_assignments as cta')
      .join('customer_tags as ct', 'ct.id', 'cta.tag_id')
      .where('cta.entity_id', contactId)
      .where('cta.organization_id', auth.orgId)
      .select('cta.id', 'cta.created_at', 'ct.name as tag_name')
      .orderBy('cta.created_at', 'desc')
      .limit(50)
      .catch(() => [])

    for (const tag of tagAssignments) {
      events.push({
        type: 'tag',
        title: 'Tag added',
        description: tag.tag_name || undefined,
        icon: 'Tag',
        timestamp: tag.created_at,
      })
    }

    // 11. Engagement events (by contact_id)
    const engagementEvents = await knex('engagement_events')
      .where('contact_id', contactId)
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')
      .limit(50)
      .catch(() => [])

    for (const event of engagementEvents) {
      events.push({
        type: 'engagement',
        title: `Engagement: ${event.event_type || 'event'}`,
        description: event.points ? `+${event.points} points` : undefined,
        icon: 'TrendingUp',
        timestamp: event.created_at,
        metadata: { eventType: event.event_type, points: event.points },
      })
    }

    // Sort all events by timestamp DESC and limit to 50
    events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    const limited = events.slice(0, 50)

    return NextResponse.json({ ok: true, data: limited })
  } catch (error) {
    console.error('[contacts.timeline]', error)
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
