// ORM-SKIP: checkout_offers is a raw-knex table
import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import {
  defaultOfferHosts,
  itemMode,
  listOffers,
  offerView,
  resolveOfferItem,
  validateHosts,
  validateUpsells,
  type OfferInput,
  type Scope,
} from '../../services/checkout-offers'
import { isUuid } from '../../services/public-checkout'

/*
 * Offers the business's pages may sell through the public checkout
 * (POST /api/payments/public/offers/{id}/checkout). Owners create one per
 * product or course; the price always comes from that product or course.
 */
export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['payments.view'] },
  POST: { requireAuth: true, requireFeatures: ['payments.create'] },
  PUT: { requireAuth: true, requireFeatures: ['payments.manage'] },
}

function scopeOf(ctx: any): Scope | null {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return null
  return { organizationId: auth.orgId, tenantId: auth.tenantId }
}

async function knexOf() {
  const container = await createRequestContainer()
  return (container.resolve('em') as EntityManager).getKnex()
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json()
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null
  } catch {
    return null
  }
}

function nameOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null
}

export async function GET(_req: Request, ctx: any) {
  const scope = scopeOf(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const knex = await knexOf()
    return NextResponse.json({ ok: true, data: await listOffers(knex, scope), defaultHosts: await defaultOfferHosts(knex, scope) })
  } catch (error) {
    console.error('[payments.offers.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load offers' }, { status: 500 })
  }
}

export async function POST(req: Request, ctx: any) {
  const scope = scopeOf(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  const body = (await readJson(req)) as OfferInput | null
  if (!body) return NextResponse.json({ ok: false, error: 'Invalid request' }, { status: 400 })
  try {
    const knex = await knexOf()
    const item = await resolveOfferItem(knex, scope, body)
    if (!item.ok) return NextResponse.json({ ok: false, error: item.error }, { status: 400 })
    const hosts = body.successUrlHosts === undefined ? { ok: true as const, value: await defaultOfferHosts(knex, scope) } : validateHosts(body.successUrlHosts)
    if (!hosts.ok) return NextResponse.json({ ok: false, error: hosts.error }, { status: 400 })
    const upsells = body.allowedUpsellOfferIds === undefined ? { ok: true as const, value: [] as string[] } : await validateUpsells(knex, scope, body.allowedUpsellOfferIds, null)
    if (!upsells.ok) return NextResponse.json({ ok: false, error: upsells.error }, { status: 400 })

    const id = require('crypto').randomUUID()
    const now = new Date()
    await knex('checkout_offers').insert({
      id,
      organization_id: scope.organizationId,
      tenant_id: scope.tenantId,
      name: nameOf(body.name),
      product_id: item.value.productId,
      course_id: item.value.courseId,
      mode: itemMode(item.value.item),
      success_url_hosts: hosts.value,
      allowed_upsell_offer_ids: upsells.value,
      active: body.active === undefined ? true : body.active === true,
      created_at: now,
      updated_at: now,
    })
    const row = await knex('checkout_offers').where('id', id).first()
    return NextResponse.json({ ok: true, data: await offerView(knex, row) }, { status: 201 })
  } catch (error) {
    console.error('[payments.offers.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create offer' }, { status: 500 })
  }
}

export async function PUT(req: Request, ctx: any) {
  const scope = scopeOf(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  const body = (await readJson(req)) as (OfferInput & { id?: unknown }) | null
  if (!body || !isUuid(body.id)) return NextResponse.json({ ok: false, error: 'Offer id required' }, { status: 400 })
  try {
    const knex = await knexOf()
    const existing = await knex('checkout_offers')
      .where('id', body.id)
      .where('organization_id', scope.organizationId)
      .where('tenant_id', scope.tenantId)
      .first()
    if (!existing) return NextResponse.json({ ok: false, error: 'Offer not found' }, { status: 404 })

    const update: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) update.name = nameOf(body.name)
    if (body.active !== undefined) update.active = body.active === true
    if (body.productId !== undefined || body.courseId !== undefined) {
      const item = await resolveOfferItem(knex, scope, body)
      if (!item.ok) return NextResponse.json({ ok: false, error: item.error }, { status: 400 })
      update.product_id = item.value.productId
      update.course_id = item.value.courseId
      update.mode = itemMode(item.value.item)
    }
    if (body.successUrlHosts !== undefined) {
      const hosts = validateHosts(body.successUrlHosts)
      if (!hosts.ok) return NextResponse.json({ ok: false, error: hosts.error }, { status: 400 })
      update.success_url_hosts = hosts.value
    }
    if (body.allowedUpsellOfferIds !== undefined) {
      const upsells = await validateUpsells(knex, scope, body.allowedUpsellOfferIds, existing.id)
      if (!upsells.ok) return NextResponse.json({ ok: false, error: upsells.error }, { status: 400 })
      update.allowed_upsell_offer_ids = upsells.value
    }
    await knex('checkout_offers')
      .where('id', existing.id)
      .where('organization_id', scope.organizationId)
      .where('tenant_id', scope.tenantId)
      .update(update)
    const row = await knex('checkout_offers').where('id', existing.id).first()
    return NextResponse.json({ ok: true, data: await offerView(knex, row) })
  } catch (error) {
    console.error('[payments.offers.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update offer' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Payments',
  summary: 'Checkout offers',
  methods: {
    GET: { summary: 'List checkout offers', tags: ['Payments'] },
    POST: { summary: 'Create a checkout offer for a product or course', tags: ['Payments'] },
    PUT: { summary: 'Update a checkout offer (active, hosts, upsells, item)', tags: ['Payments'] },
  },
}
