import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { addDays, addWeeks, addMonths, getDay, startOfDay } from 'date-fns'


export const metadata = {
  POST: { requireAuth: true, requireFeatures: ['calendar.manage'] },
}

type RecurrenceRule = {
  type: 'daily' | 'weekly' | 'biweekly' | 'monthly'
  days?: number[]
  endDate?: string
  count?: number
}

function generateOccurrences(
  start: Date,
  end: Date,
  rule: RecurrenceRule,
): { start: Date; end: Date }[] {
  const durationMs = end.getTime() - start.getTime()
  const occurrences: { start: Date; end: Date }[] = []

  // Determine the end boundary
  const defaultEndDate = addMonths(startOfDay(start), 3)
  let endBoundary: Date
  if (rule.endDate) {
    endBoundary = new Date(rule.endDate)
  } else {
    endBoundary = defaultEndDate
  }
  const maxCount = rule.count || 500

  const startHours = start.getHours()
  const startMinutes = start.getMinutes()

  if (rule.type === 'daily') {
    let current = new Date(start)
    while (current <= endBoundary && occurrences.length < maxCount) {
      const occStart = new Date(current)
      occurrences.push({ start: occStart, end: new Date(occStart.getTime() + durationMs) })
      current = addDays(current, 1)
    }
  } else if (rule.type === 'weekly' || rule.type === 'biweekly') {
    const weekIncrement = rule.type === 'biweekly' ? 2 : 1
    const targetDays = rule.days && rule.days.length > 0 ? rule.days : [getDay(start)]

    // Start from the beginning of the week containing the start date
    let weekStart = startOfDay(start)
    // Go back to Sunday of that week
    const dayOfWeek = getDay(weekStart)
    weekStart = addDays(weekStart, -dayOfWeek)

    while (weekStart <= endBoundary && occurrences.length < maxCount) {
      for (const targetDay of targetDays) {
        const candidate = addDays(weekStart, targetDay)
        // Set the time
        const occStart = new Date(candidate)
        occStart.setHours(startHours, startMinutes, 0, 0)

        if (occStart >= start && occStart <= endBoundary && occurrences.length < maxCount) {
          occurrences.push({ start: occStart, end: new Date(occStart.getTime() + durationMs) })
        }
      }
      weekStart = addWeeks(weekStart, weekIncrement)
    }

    // Sort by start time
    occurrences.sort((a, b) => a.start.getTime() - b.start.getTime())
  } else if (rule.type === 'monthly') {
    let current = new Date(start)
    while (current <= endBoundary && occurrences.length < maxCount) {
      const occStart = new Date(current)
      occurrences.push({ start: occStart, end: new Date(occStart.getTime() + durationMs) })
      current = addMonths(current, 1)
    }
  }

  return occurrences
}

export async function POST(req: Request, ctx: any) {
  const auth = ctx?.auth || await getAuthFromCookies()
  if (!auth?.orgId || !auth?.tenantId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { title, start, end, recurrence } = body

    if (!start || !end) {
      return NextResponse.json({ ok: false, error: 'start and end required' }, { status: 400 })
    }

    const startDate = new Date(start)
    const endDate = new Date(end)

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return NextResponse.json({ ok: false, error: 'Invalid date format' }, { status: 400 })
    }

    const crypto = require('crypto')

    // Ensure recurrence columns exist (safe migration)
    try {
      await knex.raw(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS recurrence_rule JSONB`)
      await knex.raw(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS recurrence_parent_id UUID REFERENCES bookings(id) ON DELETE CASCADE`)
    } catch {
      // Columns may already exist or DB doesn't support IF NOT EXISTS — ignore
    }

    if (recurrence && recurrence.type) {
      // Create recurring events
      const rule: RecurrenceRule = {
        type: recurrence.type,
        days: recurrence.days,
        endDate: recurrence.endDate,
        count: recurrence.count,
      }

      const occurrences = generateOccurrences(startDate, endDate, rule)

      if (occurrences.length === 0) {
        return NextResponse.json({ ok: false, error: 'No occurrences generated for the given recurrence rule' }, { status: 400 })
      }

      // Create parent booking (first occurrence)
      const parentId = crypto.randomUUID()
      const firstOcc = occurrences[0]

      await knex('bookings').insert({
        id: parentId,
        tenant_id: auth.tenantId,
        organization_id: auth.orgId,
        booking_page_id: null,
        guest_name: title || 'Blocked',
        guest_email: 'blocked@internal.local',
        start_time: firstOcc.start,
        end_time: firstOcc.end,
        status: 'blocked',
        meeting_type: null,
        notes: null,
        recurrence_rule: JSON.stringify(rule),
        recurrence_parent_id: null,
        created_at: new Date(),
      })

      // Create child occurrences (skip the first one which is the parent)
      const childIds: string[] = []
      for (let i = 1; i < occurrences.length; i++) {
        const occ = occurrences[i]
        const childId = crypto.randomUUID()
        childIds.push(childId)

        await knex('bookings').insert({
          id: childId,
          tenant_id: auth.tenantId,
          organization_id: auth.orgId,
          booking_page_id: null,
          guest_name: title || 'Blocked',
          guest_email: 'blocked@internal.local',
          start_time: occ.start,
          end_time: occ.end,
          status: 'blocked',
          meeting_type: null,
          notes: null,
          recurrence_rule: null,
          recurrence_parent_id: parentId,
          created_at: new Date(),
        })
      }

      // Create Google Calendar events for each occurrence if connected
      try {
        const { createGoogleCalendarEvent } = await import('@/modules/calendar/lib/google-calendar-service')
        for (const occ of occurrences) {
          try {
            await createGoogleCalendarEvent(auth.sub, {
              summary: title || 'Blocked',
              description: 'Recurring blocked time',
              startTime: occ.start,
              endTime: occ.end,
              meetingType: 'in_person',
            })
          } catch {
            // Individual Google event creation failed — continue
          }
        }
      } catch {
        // Google Calendar integration not available
      }

      return NextResponse.json({
        ok: true,
        data: {
          parentId,
          occurrenceCount: occurrences.length,
          childIds,
        },
      }, { status: 201 })
    }

    // Non-recurring: create a single blocked time slot
    const id = crypto.randomUUID()

    await knex('bookings').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      booking_page_id: null,
      guest_name: title || 'Blocked',
      guest_email: 'blocked@internal.local',
      start_time: startDate,
      end_time: endDate,
      status: 'blocked',
      meeting_type: null,
      notes: null,
      created_at: new Date(),
    })

    // Create Google Calendar event if connected
    try {
      const { createGoogleCalendarEvent } = await import('@/modules/calendar/lib/google-calendar-service')
      await createGoogleCalendarEvent(auth.sub, {
        summary: title || 'Blocked',
        description: 'Blocked time',
        startTime: startDate,
        endTime: endDate,
        meetingType: 'in_person',
      })
    } catch {
      // Google Calendar integration not available
    }

    return NextResponse.json({ ok: true, data: { id } }, { status: 201 })
  } catch (error) {
    console.error('[calendar.events.block]', error)
    return NextResponse.json({ ok: false, error: 'Failed to block time' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Calendar', summary: 'Block time on calendar',
  methods: {
    POST: { summary: 'Block a time slot on the calendar (supports recurring)', tags: ['Calendar'] },
  },
}
