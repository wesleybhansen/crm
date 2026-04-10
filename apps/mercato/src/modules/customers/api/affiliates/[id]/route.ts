export const metadata = { GET: { requireAuth: true }, POST: { requireAuth: true }, PUT: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const { id } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const affiliate = await knex('affiliates').where('id', id).where('organization_id', auth.orgId).first()
    if (!affiliate) return NextResponse.json({ ok: false, error: 'Affiliate not found' }, { status: 404 })

    const referrals = await knex('affiliate_referrals').where('affiliate_id', id).orderBy('referred_at', 'desc').limit(200)
    const payouts = await knex('affiliate_payouts').where('affiliate_id', id).orderBy('created_at', 'desc').limit(100)

    return NextResponse.json({ ok: true, data: { affiliate, referrals, payouts } })
  } catch (error) {
    console.error('[affiliates.detail.GET] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to load affiliate' }, { status: 500 })
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const { id } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { amount, periodStart, periodEnd } = body

    if (!amount || amount <= 0) return NextResponse.json({ ok: false, error: 'A positive payout amount is required' }, { status: 400 })

    const affiliate = await knex('affiliates').where('id', id).where('organization_id', auth.orgId).first()
    if (!affiliate) return NextResponse.json({ ok: false, error: 'Affiliate not found' }, { status: 404 })

    const payoutId = crypto.randomUUID()
    const now = new Date()
    await knex('affiliate_payouts').insert({
      id: payoutId, affiliate_id: id, amount: Number(amount),
      period_start: periodStart ? new Date(periodStart) : now,
      period_end: periodEnd ? new Date(periodEnd) : now,
      status: 'pending', created_at: now,
    })

    return NextResponse.json({ ok: true, data: { id: payoutId } }, { status: 201 })
  } catch (error) {
    console.error('[affiliates.detail.POST] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to create payout' }, { status: 500 })
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const { id } = await params
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()

    if (body.payoutId && body.action === 'mark_paid') {
      // Verify the payout belongs to an affiliate in this org
      const payout = await knex('affiliate_payouts as ap')
        .join('affiliates as a', 'ap.affiliate_id', 'a.id')
        .where('ap.id', body.payoutId)
        .where('a.organization_id', auth.orgId)
        .select('ap.id')
        .first()
      if (!payout) return NextResponse.json({ ok: false, error: 'Payout not found' }, { status: 404 })
      await knex('affiliate_payouts').where('id', body.payoutId).update({ status: 'paid', paid_at: new Date() })
      return NextResponse.json({ ok: true })
    }

    const affiliate = await knex('affiliates').where('id', id).where('organization_id', auth.orgId).first()
    if (!affiliate) return NextResponse.json({ ok: false, error: 'Affiliate not found' }, { status: 404 })

    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) updates.name = body.name
    if (body.email !== undefined) updates.email = body.email
    if (body.commissionRate !== undefined) updates.commission_rate = body.commissionRate
    if (body.commissionType !== undefined) updates.commission_type = body.commissionType
    if (body.status !== undefined) updates.status = body.status

    await knex('affiliates').where('id', id).update(updates)
    const updated = await knex('affiliates').where('id', id).first()
    return NextResponse.json({ ok: true, data: updated })
  } catch (error) {
    console.error('[affiliates.detail.PUT] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to update' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Affiliates',
  summary: 'Affiliate detail and payout management',
  methods: {
    GET: { summary: 'Get affiliate detail with referrals and payouts', tags: ['Affiliates'] },
    POST: { summary: 'Create payout for affiliate', tags: ['Affiliates'] },
    PUT: { summary: 'Update affiliate or mark payout paid', tags: ['Affiliates'] },
  },
}
