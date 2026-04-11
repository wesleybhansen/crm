export const metadata = { path: '/affiliates/[id]', GET: { requireAuth: true }, POST: { requireAuth: true }, PUT: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { Affiliate, AffiliateReferral, AffiliatePayout } from '../../../data/schema'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const { id } = await params
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()

    const affiliate = await em.findOne(Affiliate, { id, organizationId: auth.orgId, tenantId: auth.tenantId })
    if (!affiliate) return NextResponse.json({ ok: false, error: 'Affiliate not found' }, { status: 404 })

    const referrals = await em.find(AffiliateReferral, { affiliateId: id }, { orderBy: { referredAt: 'desc' }, limit: 200 })
    const payouts = await em.find(AffiliatePayout, { affiliateId: id }, { orderBy: { createdAt: 'desc' }, limit: 100 })

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
    const em = (container.resolve('em') as EntityManager).fork()
    const body = await req.json()
    const { amount, periodStart, periodEnd } = body

    if (!amount || amount <= 0) return NextResponse.json({ ok: false, error: 'A positive payout amount is required' }, { status: 400 })

    const affiliate = await em.findOne(Affiliate, { id, organizationId: auth.orgId, tenantId: auth.tenantId })
    if (!affiliate) return NextResponse.json({ ok: false, error: 'Affiliate not found' }, { status: 404 })

    const now = new Date()
    const payout = em.create(AffiliatePayout, {
      affiliateId: id,
      amount: String(Number(amount)),
      periodStart: periodStart ? new Date(periodStart) : now,
      periodEnd: periodEnd ? new Date(periodEnd) : now,
    })
    em.persist(payout)
    await em.flush()

    return NextResponse.json({ ok: true, data: { id: payout.id } }, { status: 201 })
  } catch (error) {
    console.error('[affiliates.detail.POST] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to create payout' }, { status: 500 })
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const { id } = await params
    const container = await createRequestContainer()
    const em = (container.resolve('em') as EntityManager).fork()
    const body = await req.json()

    if (body.payoutId && body.action === 'mark_paid') {
      const payout = await em.findOne(AffiliatePayout, { id: body.payoutId })
      if (!payout) return NextResponse.json({ ok: false, error: 'Payout not found' }, { status: 404 })
      // Verify affiliate belongs to org
      const aff = await em.findOne(Affiliate, { id: payout.affiliateId, organizationId: auth.orgId })
      if (!aff) return NextResponse.json({ ok: false, error: 'Payout not found' }, { status: 404 })
      payout.status = 'paid'
      payout.paidAt = new Date()
      await em.flush()
      return NextResponse.json({ ok: true })
    }

    const affiliate = await em.findOne(Affiliate, { id, organizationId: auth.orgId, tenantId: auth.tenantId })
    if (!affiliate) return NextResponse.json({ ok: false, error: 'Affiliate not found' }, { status: 404 })

    if (body.name !== undefined) affiliate.name = body.name
    if (body.email !== undefined) affiliate.email = body.email
    if (body.commissionRate !== undefined) affiliate.commissionRate = String(body.commissionRate)
    if (body.commissionType !== undefined) affiliate.commissionType = body.commissionType
    if (body.status !== undefined) affiliate.status = body.status

    await em.flush()
    return NextResponse.json({ ok: true, data: affiliate })
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
