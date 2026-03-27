import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'

function generateAffiliateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  const bytes = crypto.randomBytes(8)
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length]
  }
  return code
}

export async function GET(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const status = url.searchParams.get('status')

    let query = knex('affiliates')
      .where('organization_id', auth.orgId)
      .orderBy('created_at', 'desc')

    if (status) {
      query = query.where('status', status)
    }

    const affiliates = await query
    return NextResponse.json({ ok: true, data: affiliates })
  } catch (error) {
    console.error('[affiliates.GET] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to load affiliates' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { name, email, commissionRate, commissionType } = body

    if (!name || !email) {
      return NextResponse.json({ ok: false, error: 'name and email are required' }, { status: 400 })
    }

    // Generate unique affiliate code
    let affiliateCode = generateAffiliateCode()
    let attempts = 0
    while (attempts < 10) {
      const existing = await knex('affiliates')
        .where('organization_id', auth.orgId)
        .where('affiliate_code', affiliateCode)
        .first()
      if (!existing) break
      affiliateCode = generateAffiliateCode()
      attempts++
    }

    // Try to link to existing contact by email
    const contact = await knex('customer_entities')
      .where('primary_email', email)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()

    const id = crypto.randomUUID()
    await knex('affiliates').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      contact_id: contact?.id || null,
      name,
      email,
      affiliate_code: affiliateCode,
      commission_rate: commissionRate ?? 10.00,
      commission_type: commissionType || 'percentage',
      status: 'active',
      total_referrals: 0,
      total_conversions: 0,
      total_earned: 0,
      created_at: new Date(),
      updated_at: new Date(),
    })

    return NextResponse.json({ ok: true, data: { id, affiliateCode } }, { status: 201 })
  } catch (error) {
    console.error('[affiliates.POST] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to create affiliate' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    const body = await req.json()
    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) updates.name = body.name
    if (body.email !== undefined) updates.email = body.email
    if (body.commissionRate !== undefined) updates.commission_rate = body.commissionRate
    if (body.commissionType !== undefined) updates.commission_type = body.commissionType
    if (body.status !== undefined) updates.status = body.status

    await knex('affiliates').where('id', id).where('organization_id', auth.orgId).update(updates)
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[affiliates.PUT] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to update affiliate' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })

    await knex('affiliates')
      .where('id', id)
      .where('organization_id', auth.orgId)
      .update({ status: 'inactive', updated_at: new Date() })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[affiliates.DELETE] failed', error)
    return NextResponse.json({ ok: false, error: 'Failed to deactivate affiliate' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Affiliates',
  summary: 'Affiliate management',
  methods: {
    GET: { summary: 'List affiliates', tags: ['Affiliates'] },
    POST: { summary: 'Create affiliate', tags: ['Affiliates'] },
    PUT: { summary: 'Update affiliate', tags: ['Affiliates'] },
    DELETE: { summary: 'Deactivate affiliate', tags: ['Affiliates'] },
  },
}
