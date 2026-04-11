// ORM-SKIP: needs entity definition — Phase 2 conversion
export const metadata = { path: '/affiliates/campaigns', GET: { requireAuth: true }, POST: { requireAuth: true }, PUT: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'
import Stripe from 'stripe'

function getStripe(stripeAccountId: string): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  return new Stripe(key, { apiVersion: '2024-12-18.acacia' as any })
}

// List campaigns
export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const campaigns = await knex('affiliate_campaigns')
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')

    // Get affiliate counts per campaign
    const affiliateCounts = await knex('affiliates')
      .where('organization_id', auth.orgId)
      .whereNotNull('campaign_id')
      .groupBy('campaign_id')
      .select('campaign_id')
      .count('* as count')

    const countMap: Record<string, number> = {}
    for (const row of affiliateCounts) countMap[row.campaign_id] = Number(row.count)

    // Get products for display
    const productIds = new Set<string>()
    for (const c of campaigns) {
      const ids = typeof c.product_ids === 'string' ? JSON.parse(c.product_ids) : (c.product_ids || [])
      for (const id of ids) productIds.add(id)
    }

    let products: Record<string, { id: string; name: string; price: number }> = {}
    if (productIds.size > 0) {
      const rows = await knex('products')
        .whereIn('id', Array.from(productIds))
        .where('organization_id', auth.orgId)
        .select('id', 'name', 'price')
      for (const r of rows) products[r.id] = r
    }

    const data = campaigns.map((c: any) => ({
      ...c,
      product_ids: typeof c.product_ids === 'string' ? JSON.parse(c.product_ids) : (c.product_ids || []),
      affiliate_count: countMap[c.id] || 0,
      products_info: (typeof c.product_ids === 'string' ? JSON.parse(c.product_ids) : (c.product_ids || []))
        .map((pid: string) => products[pid])
        .filter(Boolean),
    }))

    // Also return all org products for the campaign creation form
    const allProducts = await knex('products')
      .where('organization_id', auth.orgId)
      .where('is_active', true)
      .select('id', 'name', 'price', 'stripe_product_id')
      .orderBy('name', 'asc')

    return NextResponse.json({ ok: true, data, products: allProducts })
  } catch (error) {
    console.error('[affiliate_campaigns.GET]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load campaigns' }, { status: 500 })
  }
}

// Create campaign + Stripe coupon
export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()

    const { name, description, productIds, commissionRate, commissionType, customerDiscount, customerDiscountType, cookieDays, autoApprove, termsText } = body
    if (!name?.trim()) return NextResponse.json({ ok: false, error: 'Campaign name is required' }, { status: 400 })
    if (!productIds?.length) return NextResponse.json({ ok: false, error: 'Select at least one product' }, { status: 400 })

    // Create Stripe coupon on connected account if discount > 0
    let stripeCouponId: string | null = null
    const discount = Number(customerDiscount) || 0
    if (discount > 0) {
      const org = await knex('organizations').where('id', auth.orgId).first()
      const stripeAccountId = org?.stripe_account_id
      if (stripeAccountId) {
        const stripe = getStripe(stripeAccountId)
        if (stripe) {
          try {
            const couponParams: Stripe.CouponCreateParams = {
              duration: 'once',
              name: `${name} - Affiliate Discount`,
              metadata: { crm_campaign: 'true', organization_id: auth.orgId },
            }
            if ((customerDiscountType || 'percentage') === 'percentage') {
              couponParams.percent_off = discount
            } else {
              couponParams.amount_off = Math.round(discount * 100) // cents
              couponParams.currency = 'usd'
            }
            const coupon = await stripe.coupons.create(couponParams, { stripeAccount: stripeAccountId })
            stripeCouponId = coupon.id
          } catch (err) {
            console.error('[affiliate_campaigns] Stripe coupon creation failed', err)
            // Non-blocking — campaign still created without Stripe coupon
          }
        }
      }
    }

    const id = crypto.randomUUID()
    await knex('affiliate_campaigns').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      name: name.trim(),
      description: description?.trim() || null,
      product_ids: JSON.stringify(productIds),
      commission_rate: Number(commissionRate) || 10,
      commission_type: commissionType || 'percentage',
      customer_discount: discount,
      customer_discount_type: customerDiscountType || 'percentage',
      cookie_duration_days: Number(cookieDays) || 30,
      auto_approve: autoApprove ?? false,
      stripe_coupon_id: stripeCouponId,
      terms_text: termsText?.trim() || null,
      signup_page_enabled: true,
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    })

    const campaign = await knex('affiliate_campaigns').where('id', id).first()
    return NextResponse.json({ ok: true, data: campaign }, { status: 201 })
  } catch (error) {
    console.error('[affiliate_campaigns.POST]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create campaign' }, { status: 500 })
  }
}

// Update campaign
export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'Campaign ID required' }, { status: 400 })

    const body = await req.json()
    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) updates.name = body.name
    if (body.description !== undefined) updates.description = body.description
    if (body.status !== undefined) updates.status = body.status
    if (body.autoApprove !== undefined) updates.auto_approve = body.autoApprove
    if (body.signupPageEnabled !== undefined) updates.signup_page_enabled = body.signupPageEnabled

    await knex('affiliate_campaigns').where('id', id).where('organization_id', auth.orgId).update(updates)
    const campaign = await knex('affiliate_campaigns').where('id', id).first()
    return NextResponse.json({ ok: true, data: campaign })
  } catch (error) {
    console.error('[affiliate_campaigns.PUT]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update campaign' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Affiliates',
  summary: 'Affiliate campaign management',
  methods: {
    GET: { summary: 'List affiliate campaigns', tags: ['Affiliates'] },
    POST: { summary: 'Create affiliate campaign', tags: ['Affiliates'] },
    PUT: { summary: 'Update affiliate campaign', tags: ['Affiliates'] },
  },
}
