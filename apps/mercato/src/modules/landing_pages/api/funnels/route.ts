import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['landing_pages.view'] },
  POST: { requireAuth: true, requireFeatures: ['landing_pages.create'] },
  PUT: { requireAuth: true, requireFeatures: ['landing_pages.edit'] },
  DELETE: { requireAuth: true, requireFeatures: ['landing_pages.delete'] },
}

function getScope(ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return null
  return { tenantId: auth.tenantId, orgId: auth.orgId, userId: auth.sub }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 100)
}

export async function GET(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const funnels = await knex('funnels')
      .where('tenant_id', scope.tenantId)
      .where('organization_id', scope.orgId)
      .orderBy('created_at', 'desc')

    const funnelIds = funnels.map((f: any) => f.id)
    let stepCounts: Record<string, number> = {}
    let visitCounts: Record<string, number> = {}

    if (funnelIds.length > 0) {
      const steps = await knex('funnel_steps')
        .select('funnel_id')
        .count('* as count')
        .whereIn('funnel_id', funnelIds)
        .groupBy('funnel_id')
      for (const row of steps) {
        stepCounts[row.funnel_id] = Number(row.count)
      }

      const visits = await knex('funnel_visits')
        .select('funnel_id')
        .count('* as count')
        .whereIn('funnel_id', funnelIds)
        .groupBy('funnel_id')
      for (const row of visits) {
        visitCounts[row.funnel_id] = Number(row.count)
      }
    }

    const data = funnels.map((f: any) => ({
      ...f,
      step_count: stepCounts[f.id] || 0,
      total_visits: visitCounts[f.id] || 0,
    }))

    return NextResponse.json({ ok: true, data })
  } catch (error) {
    console.error('[funnels.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to list funnels' }, { status: 500 })
  }
}

export async function POST(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()

    if (!body.name?.trim()) {
      return NextResponse.json({ ok: false, error: 'Name is required' }, { status: 400 })
    }

    const slug = slugify(body.name)
    const existing = await knex('funnels')
      .where('slug', slug)
      .where('organization_id', scope.orgId)
      .first()
    if (existing) {
      return NextResponse.json({ ok: false, error: 'A funnel with this slug already exists' }, { status: 409 })
    }

    const id = require('crypto').randomUUID()
    const now = new Date()

    await knex('funnels').insert({
      id,
      tenant_id: scope.tenantId,
      organization_id: scope.orgId,
      name: body.name.trim(),
      slug,
      is_published: false,
      created_at: now,
      updated_at: now,
    })

    if (Array.isArray(body.steps)) {
      for (const step of body.steps) {
        await knex('funnel_steps').insert({
          id: require('crypto').randomUUID(),
          funnel_id: id,
          step_order: step.stepOrder || 1,
          step_type: step.stepType || 'page',
          page_id: step.pageId || null,
          product_id: step.productId || null,
          name: step.name || null,
          on_accept_step_id: step.onAcceptStepId || null,
          on_decline_step_id: step.onDeclineStepId || null,
          config: JSON.stringify(step.config || {}),
          created_at: now,
        })
      }
    }

    const funnel = await knex('funnels').where('id', id).first()
    const steps = await knex('funnel_steps').where('funnel_id', id).orderBy('step_order')
    return NextResponse.json({ ok: true, data: { ...funnel, steps } }, { status: 201 })
  } catch (error) {
    console.error('[funnels.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create funnel' }, { status: 500 })
  }
}

export async function PUT(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'Missing funnel id' }, { status: 400 })

    const funnel = await knex('funnels')
      .where('id', id)
      .where('organization_id', scope.orgId)
      .first()
    if (!funnel) return NextResponse.json({ ok: false, error: 'Funnel not found' }, { status: 404 })

    const body = await req.json()
    const update: Record<string, any> = { updated_at: new Date() }

    if (body.name !== undefined) update.name = body.name.trim()
    if (body.isPublished !== undefined) update.is_published = body.isPublished

    await knex('funnels').where('id', id).update(update)

    if (Array.isArray(body.steps)) {
      await knex('funnel_steps').where('funnel_id', id).delete()
      const now = new Date()
      for (const step of body.steps) {
        await knex('funnel_steps').insert({
          id: require('crypto').randomUUID(),
          funnel_id: id,
          step_order: step.stepOrder || 1,
          step_type: step.stepType || 'page',
          page_id: step.pageId || null,
          product_id: step.productId || null,
          name: step.name || null,
          on_accept_step_id: step.onAcceptStepId || null,
          on_decline_step_id: step.onDeclineStepId || null,
          config: JSON.stringify(step.config || {}),
          created_at: now,
        })
      }
    }

    const updated = await knex('funnels').where('id', id).first()
    const steps = await knex('funnel_steps').where('funnel_id', id).orderBy('step_order')
    return NextResponse.json({ ok: true, data: { ...updated, steps } })
  } catch (error) {
    console.error('[funnels.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update funnel' }, { status: 500 })
  }
}

export async function DELETE(req: Request, ctx: any) {
  const scope = getScope(ctx)
  if (!scope) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()

    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'Missing funnel id' }, { status: 400 })

    // Verify ownership BEFORE deleting child rows — otherwise another tenant's
    // funnel_steps/funnel_visits get wiped while the org-scoped funnel delete no-ops.
    const funnel = await knex('funnels').where('id', id).where('organization_id', scope.orgId).first()
    if (!funnel) return NextResponse.json({ ok: false, error: 'Funnel not found' }, { status: 404 })

    await knex('funnel_steps').where('funnel_id', id).delete()
    await knex('funnel_visits').where('funnel_id', id).delete()
    await knex('funnels').where('id', id).where('organization_id', scope.orgId).delete()

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[funnels.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to delete funnel' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Funnels',
  summary: 'Funnel management',
  methods: {
    GET: { summary: 'List funnels', tags: ['Funnels'] },
    POST: { summary: 'Create a funnel', tags: ['Funnels'] },
    PUT: { summary: 'Update a funnel', tags: ['Funnels'] },
    DELETE: { summary: 'Delete a funnel', tags: ['Funnels'] },
  },
}
