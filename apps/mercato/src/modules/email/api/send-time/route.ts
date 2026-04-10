export const metadata = { GET: { requireAuth: true } }
export const openApi = { summary: 'Optimal send time insights', methods: { GET: { summary: 'Optimal send time insights', tags: ['Email'] } } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function formatHour(hour: number): string {
  if (hour === 0) return '12:00 AM'
  if (hour === 12) return '12:00 PM'
  return hour < 12 ? `${hour}:00 AM` : `${hour - 12}:00 PM`
}

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const url = new URL(req.url)
    const contactId = url.searchParams.get('contactId')

    if (contactId) {
      return NextResponse.json({ ok: true, data: await getContactInsights(knex, auth.orgId, contactId) })
    }

    return NextResponse.json({ ok: true, data: await getOrgInsights(knex, auth.orgId) })
  } catch (error) {
    console.error('[email.send-time]', error)
    return NextResponse.json({ ok: false, error: 'Failed to compute send time insights' }, { status: 500 })
  }
}

async function getContactInsights(knex: ReturnType<EntityManager['getKnex']>, orgId: string, contactId: string) {
  const rows = await knex('contact_open_times')
    .where('organization_id', orgId)
    .where('contact_id', contactId)
    .select(
      knex.raw('hour_of_day, count(*)::int as opens')
    )
    .groupBy('hour_of_day')
    .orderBy('opens', 'desc')

  const totalDataPoints = rows.reduce((sum: number, r: { opens: number }) => sum + r.opens, 0)

  if (totalDataPoints < 5) {
    const orgData = await getOrgInsights(knex, orgId)
    return {
      bestHour: orgData.bestHour,
      dataPoints: totalDataPoints,
      recommendation: totalDataPoints === 0
        ? `Not enough open data for this contact. Using org-wide best time: ${formatHour(orgData.bestHour)}.`
        : `Only ${totalDataPoints} opens recorded. Using org-wide best time: ${formatHour(orgData.bestHour)}.`,
      fallbackToOrg: true,
    }
  }

  const bestHour = rows[0].hour_of_day as number
  return {
    bestHour,
    dataPoints: totalDataPoints,
    recommendation: `This contact is most active at ${formatHour(bestHour)}.`,
    fallbackToOrg: false,
  }
}

async function getOrgInsights(knex: ReturnType<EntityManager['getKnex']>, orgId: string) {
  const hourRows = await knex('contact_open_times')
    .where('organization_id', orgId)
    .select(knex.raw('hour_of_day, count(*)::int as opens'))
    .groupBy('hour_of_day')
    .orderBy('opens', 'desc')

  const dayRows = await knex('contact_open_times')
    .where('organization_id', orgId)
    .select(knex.raw('day_of_week, count(*)::int as opens'))
    .groupBy('day_of_week')
    .orderBy('opens', 'desc')

  const totalDataPoints = hourRows.reduce((sum: number, r: { opens: number }) => sum + r.opens, 0)

  if (totalDataPoints === 0) {
    return {
      bestHour: 10,
      bestDay: 2,
      contactInsights: [],
      totalDataPoints: 0,
      recommendation: 'No open data yet. Default recommendation: send at 10:00 AM on Tuesdays.',
    }
  }

  const bestHour = hourRows[0].hour_of_day as number
  const bestDay = dayRows.length > 0 ? (dayRows[0].day_of_week as number) : 2

  const topContacts = await knex('contact_open_times as cot')
    .where('cot.organization_id', orgId)
    .select(
      'cot.contact_id',
      knex.raw('count(*)::int as total_opens'),
      knex.raw('(array_agg(cot.hour_of_day order by cot.hour_of_day))[count(*) / 2 + 1] as median_hour'),
    )
    .groupBy('cot.contact_id')
    .orderBy('total_opens', 'desc')
    .limit(20)

  const contactInsights = await Promise.all(
    topContacts.map(async (row: { contact_id: string; total_opens: number }) => {
      const bestRow = await knex('contact_open_times')
        .where('organization_id', orgId)
        .where('contact_id', row.contact_id)
        .select(knex.raw('hour_of_day, count(*)::int as opens'))
        .groupBy('hour_of_day')
        .orderBy('opens', 'desc')
        .first()

      return {
        contactId: row.contact_id,
        totalOpens: row.total_opens,
        bestHour: bestRow?.hour_of_day ?? bestHour,
      }
    })
  )

  return {
    bestHour,
    bestDay,
    contactInsights,
    totalDataPoints,
    recommendation: `Your contacts are most active at ${formatHour(bestHour)} on ${DAY_NAMES[bestDay]}s.`,
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Email',
  summary: 'Send time optimization insights',
  methods: {
    GET: {
      summary: 'Get optimal send time insights based on contact open history',
      tags: ['Email'],
    },
  },
}
