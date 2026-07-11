// ORM-SKIP: raw-knex affiliate tables (no mercato entity)
export const metadata = { path: '/affiliates/payouts/generate', POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'

// Semi-automated payout generation.
//
// Computes each affiliate's unpaid earned balance:
//   sum(commission_amount of CONVERTED referrals, optionally within a period)
//   minus sum(ALL existing payouts, regardless of status)
// and creates a pending affiliate_payouts row for every affiliate whose
// balance >= minAmount. Marking a payout paid stays manual: the automation is
// the calculation, not the money movement.
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    let body: Record<string, unknown> = {}
    try { body = await req.json() } catch { /* empty body is fine */ }
    const minAmount = Math.max(0, Number(body.minAmount) || 0)
    const periodStart = body.periodStart ? new Date(String(body.periodStart)) : null
    const periodEnd = body.periodEnd ? new Date(String(body.periodEnd)) : null
    if ((periodStart && isNaN(periodStart.getTime())) || (periodEnd && isNaN(periodEnd.getTime()))) {
      return NextResponse.json({ ok: false, error: 'Invalid period dates' }, { status: 400 })
    }

    // Earned per affiliate (converted referrals only, org-scoped via join).
    let earnedQuery = knex('affiliate_referrals as r')
      .join('affiliates as a', 'r.affiliate_id', 'a.id')
      .where('a.organization_id', auth.orgId)
      .where('r.converted', true)
      .groupBy('r.affiliate_id')
      .select('r.affiliate_id')
      .sum('r.commission_amount as earned')
    if (periodStart) earnedQuery = earnedQuery.where('r.converted_at', '>=', periodStart)
    if (periodEnd) earnedQuery = earnedQuery.where('r.converted_at', '<=', periodEnd)
    const earnedRows = await earnedQuery

    // Already-covered amounts: every existing payout counts (pending AND paid),
    // so re-running the generator never double-pays a period.
    const payoutRows = await knex('affiliate_payouts as p')
      .join('affiliates as a', 'p.affiliate_id', 'a.id')
      .where('a.organization_id', auth.orgId)
      .groupBy('p.affiliate_id')
      .select('p.affiliate_id')
      .sum('p.amount as paid')

    const paidMap = new Map<string, number>()
    for (const row of payoutRows) paidMap.set(String(row.affiliate_id), Number(row.paid) || 0)

    const affiliates = await knex('affiliates')
      .where('organization_id', auth.orgId)
      .select('id', 'name', 'email', 'status')
    const affMap = new Map<string, { id: string; name: string; email: string; status: string }>()
    for (const a of affiliates) affMap.set(String(a.id), a)

    const now = new Date()
    const created: Array<{ id: string; affiliateId: string; affiliateName: string; amount: number }> = []

    for (const row of earnedRows) {
      const affiliateId = String(row.affiliate_id)
      const affiliate = affMap.get(affiliateId)
      if (!affiliate) continue
      const earned = Number(row.earned) || 0
      const alreadyCovered = paidMap.get(affiliateId) || 0
      const balance = Math.round((earned - alreadyCovered) * 100) / 100
      if (balance <= 0 || balance < minAmount) continue

      const payoutId = crypto.randomUUID()
      await knex('affiliate_payouts').insert({
        id: payoutId,
        affiliate_id: affiliateId,
        amount: balance,
        period_start: periodStart || now,
        period_end: periodEnd || now,
        status: 'pending',
        created_at: now,
      })
      created.push({ id: payoutId, affiliateId, affiliateName: affiliate.name, amount: balance })
    }

    return NextResponse.json({ ok: true, data: { created, count: created.length } })
  } catch (error) {
    console.error('[affiliates.payouts.generate] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to generate payouts' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Affiliates',
  summary: 'Generate pending payouts from unpaid balances',
  methods: {
    POST: { summary: 'Create pending payouts for all affiliates with unpaid earned balance', tags: ['Affiliates'] },
  },
}
