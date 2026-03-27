import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const affiliate = await knex('affiliates')
      .where('id', params.id)
      .where('organization_id', auth.orgId)
      .first()

    if (!affiliate) return NextResponse.json({ ok: false, error: 'Affiliate not found' }, { status: 404 })

    const referrals = await knex('affiliate_referrals')
      .where('affiliate_id', params.id)
      .orderBy('referred_at', 'desc')
      .limit(100)

    const payouts = await knex('affiliate_payouts')
      .where('affiliate_id', params.id)
      .orderBy('created_at', 'desc')
      .limit(50)

    return NextResponse.json({
      ok: true,
      data: {
        affiliate,
        referrals,
        payouts,
      },
    })
  } catch (error) {
    console.error('[affiliates.detail.GET] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to load affiliate' }, { status: 500 })
  }
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)

    // Check if this is a payout request
    const isPayout = url.pathname.endsWith('/payout')

    if (isPayout) {
      const body = await req.json()
      const { amount, periodStart, periodEnd } = body

      if (!amount || !periodStart || !periodEnd) {
        return NextResponse.json({ ok: false, error: 'amount, periodStart, and periodEnd are required' }, { status: 400 })
      }

      const affiliate = await knex('affiliates')
        .where('id', params.id)
        .where('organization_id', auth.orgId)
        .first()

      if (!affiliate) return NextResponse.json({ ok: false, error: 'Affiliate not found' }, { status: 404 })

      const payoutId = crypto.randomUUID()
      await knex('affiliate_payouts').insert({
        id: payoutId,
        affiliate_id: params.id,
        amount,
        period_start: new Date(periodStart),
        period_end: new Date(periodEnd),
        status: 'pending',
        created_at: new Date(),
      })

      return NextResponse.json({ ok: true, data: { id: payoutId } }, { status: 201 })
    }

    return NextResponse.json({ ok: false, error: 'Invalid action' }, { status: 400 })
  } catch (error) {
    console.error('[affiliates.detail.POST] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to process request' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Affiliates',
  summary: 'Affiliate detail and payout management',
  methods: {
    GET: { summary: 'Get affiliate detail with referrals and payouts', tags: ['Affiliates'] },
    POST: { summary: 'Create payout for affiliate', tags: ['Affiliates'] },
  },
}
