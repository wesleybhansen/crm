// ORM-SKIP: aggregate read of customer-service draft proposal actions
export const metadata = {
  path: '/customer-service/analytics',
  GET: { requireAuth: true, requireFeatures: ['email.view'] },
}

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

type ChannelSplit = { email: number; sms: number; chat: number }
type Bucket = { total: number } & ChannelSplit

function emptyBucket(): Bucket {
  return { total: 0, email: 0, sms: 0, chat: 0 }
}

// GET: customer-service analytics for the org. Returns counts of draft_reply
// actions tagged feature_source='customer_service', grouped by status and split
// by channel (email vs sms), for both a recent period (default 30 days) and all
// time. Org-scoped from auth only; the client never supplies an org.
export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })

  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const url = new URL(req.url)
    const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30')))
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    // One grouped pass: status + channel + a flag for "within the period".
    // Channel comes from the action metadata; legacy rows with no channel are
    // treated as email. The period flag lets us derive period + all-time totals
    // in a single query.
    const rows = await knex('inbox_proposal_actions as a')
      .where('a.organization_id', auth.orgId)
      .where('a.tenant_id', auth.tenantId)
      .where('a.action_type', 'draft_reply')
      .whereRaw(`a.metadata->>'feature_source' = ?`, ['customer_service'])
      .select(
        'a.status as status',
        knex.raw(`COALESCE(NULLIF(a.metadata->>'channel', ''), 'email') as channel`),
        knex.raw(`(a.created_at >= ?) as in_period`, [since]),
      )
      .count('* as cnt')
      .groupBy('a.status', 'channel', 'in_period')

    // Build period + all-time tallies keyed by status.
    function newStatusMap() {
      return { drafted: emptyBucket(), sent: emptyBucket(), pending: emptyBucket(), dismissed: emptyBucket() }
    }
    const period = newStatusMap()
    const allTime = newStatusMap()

    for (const r of rows as any[]) {
      const count = Number(r.cnt) || 0
      if (count === 0) continue
      const channel: 'email' | 'sms' | 'chat' = r.channel === 'sms' ? 'sms' : r.channel === 'chat' ? 'chat' : 'email'
      // pg returns booleans as true/false (or 't'/'f' on some drivers).
      const inPeriod = r.in_period === true || r.in_period === 't' || r.in_period === 1

      const status: string = r.status
      // Every action is "drafted" regardless of its later status; sent/pending/
      // dismissed are the disposition buckets.
      const dispositions: Array<'drafted' | 'sent' | 'pending' | 'dismissed'> = ['drafted']
      if (status === 'sent') dispositions.push('sent')
      else if (status === 'pending') dispositions.push('pending')
      else if (status === 'dismissed') dispositions.push('dismissed')

      for (const key of dispositions) {
        allTime[key].total += count
        allTime[key][channel] += count
        if (inPeriod) {
          period[key].total += count
          period[key][channel] += count
        }
      }
    }

    return NextResponse.json({
      ok: true,
      data: {
        periodDays: days,
        period,
        allTime,
      },
    })
  } catch (error) {
    console.error('[customer-service.analytics]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load analytics' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Customer Service analytics',
  methods: {
    GET: { summary: 'Counts of customer-service draft replies by status and channel', tags: ['Customer Service'] },
  },
}
