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

// Number of trailing weeks reported in the week-over-week trend.
const TREND_WEEKS = 8

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

    // ---- Flagged counts + reason breakdown ----
    // Flag data is written by the processor onto the draft_reply ACTION metadata
    // (not the proposal): metadata->>'flagged' is a JSON boolean and
    // metadata->'flagReasons' is an array of { key, label } objects. Confirmed in
    // customers/api/customer-service/process.ts (createDraftProposal /
    // createSmsDraftProposal both set metadata.flagged + metadata.flagReasons).
    // One grouped pass: flagged action count for period + all-time.
    const flaggedRows = await knex('inbox_proposal_actions as a')
      .where('a.organization_id', auth.orgId)
      .where('a.tenant_id', auth.tenantId)
      .where('a.action_type', 'draft_reply')
      .whereRaw(`a.metadata->>'feature_source' = ?`, ['customer_service'])
      .whereRaw(`a.metadata->>'flagged' = 'true'`)
      .select(knex.raw(`(a.created_at >= ?) as in_period`, [since]))
      .count('* as cnt')
      .groupBy('in_period')

    let flaggedPeriod = 0
    let flaggedAllTime = 0
    for (const r of flaggedRows as any[]) {
      const count = Number(r.cnt) || 0
      flaggedAllTime += count
      const inPeriod = r.in_period === true || r.in_period === 't' || r.in_period === 1
      if (inPeriod) flaggedPeriod += count
    }

    // Reason breakdown for the PERIOD only: unnest the flagReasons array and group
    // by reason label (fall back to the key when no label). One grouped query.
    const reasonRows = await knex('inbox_proposal_actions as a')
      .joinRaw(`CROSS JOIN LATERAL jsonb_array_elements(COALESCE(a.metadata->'flagReasons', '[]'::jsonb)) as fr(reason)`)
      .where('a.organization_id', auth.orgId)
      .where('a.tenant_id', auth.tenantId)
      .where('a.action_type', 'draft_reply')
      .whereRaw(`a.metadata->>'feature_source' = ?`, ['customer_service'])
      .whereRaw(`a.metadata->>'flagged' = 'true'`)
      .where('a.created_at', '>=', since)
      .select(knex.raw(`COALESCE(NULLIF(fr.reason->>'label', ''), fr.reason->>'key') as reason`))
      .count('* as cnt')
      .groupBy('reason')

    const reasons: Record<string, number> = {}
    for (const r of reasonRows as any[]) {
      const label = (r.reason || '').toString().trim()
      if (!label) continue
      reasons[label] = (reasons[label] || 0) + (Number(r.cnt) || 0)
    }

    // ---- Week-over-week trend (last TREND_WEEKS weeks, UTC) ----
    // Bucket draft_reply actions by ISO week (UTC) for the trailing window, split
    // into drafted (all actions) vs sent (status='sent'). One grouped query over
    // the window; we backfill any empty weeks client-side below.
    const trendSince = new Date(Date.now() - TREND_WEEKS * 7 * 24 * 60 * 60 * 1000)
    const trendRows = await knex('inbox_proposal_actions as a')
      .where('a.organization_id', auth.orgId)
      .where('a.tenant_id', auth.tenantId)
      .where('a.action_type', 'draft_reply')
      .whereRaw(`a.metadata->>'feature_source' = ?`, ['customer_service'])
      .where('a.created_at', '>=', trendSince)
      .select(
        knex.raw(`to_char(date_trunc('week', a.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') as week_start`),
        knex.raw(`(a.status = 'sent') as is_sent`),
      )
      .count('* as cnt')
      .groupBy('week_start', 'is_sent')

    // Collapse the rows into a map keyed by week start.
    const trendMap: Record<string, { drafted: number; sent: number }> = {}
    for (const r of trendRows as any[]) {
      const week = (r.week_start || '').toString()
      if (!week) continue
      const count = Number(r.cnt) || 0
      const isSent = r.is_sent === true || r.is_sent === 't' || r.is_sent === 1
      if (!trendMap[week]) trendMap[week] = { drafted: 0, sent: 0 }
      trendMap[week].drafted += count
      if (isSent) trendMap[week].sent += count
    }

    // Build the contiguous TREND_WEEKS series ending at the current week so the
    // client always gets exactly TREND_WEEKS entries (empty weeks zero-filled).
    const trend: Array<{ weekStart: string; drafted: number; sent: number }> = []
    const currentWeekStart = startOfUtcWeek(new Date())
    for (let i = TREND_WEEKS - 1; i >= 0; i--) {
      const d = new Date(currentWeekStart)
      d.setUTCDate(d.getUTCDate() - i * 7)
      const key = d.toISOString().slice(0, 10)
      const bucket = trendMap[key]
      trend.push({ weekStart: key, drafted: bucket?.drafted || 0, sent: bucket?.sent || 0 })
    }

    return NextResponse.json({
      ok: true,
      data: {
        periodDays: days,
        period,
        allTime,
        flagged: {
          period: flaggedPeriod,
          allTime: flaggedAllTime,
          reasons,
        },
        trend,
        // avgTimeToFirstDraftMins is intentionally omitted: the draft action does
        // not store the inbound message timestamp, and reconstructing it via
        // contact_id is unreliable across channels (email/sms/chat) and with
        // multiple inbound messages, so any value would be misleading.
      },
    })
  } catch (error) {
    console.error('[customer-service.analytics]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load analytics' }, { status: 500 })
  }
}

// Start of the UTC week for a date, Monday-based to match Postgres
// date_trunc('week', ...) so the JS-built week keys line up with the DB buckets.
function startOfUtcWeek(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  const dow = d.getUTCDay() // 0=Sun..6=Sat
  const diff = (dow + 6) % 7 // days since Monday
  d.setUTCDate(d.getUTCDate() - diff)
  return d
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Customer Service',
  summary: 'Customer Service analytics',
  methods: {
    GET: { summary: 'Counts of customer-service draft replies by status and channel', tags: ['Customer Service'] },
  },
}
