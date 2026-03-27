import { bootstrap } from '@/bootstrap'
import { NextResponse } from 'next/server'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import crypto from 'crypto'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80)
}

export async function GET() {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const funnels = await knex('funnels')
      .select(
        'funnels.*',
        knex.raw('(SELECT COUNT(*) FROM funnel_steps WHERE funnel_steps.funnel_id = funnels.id)::int as step_count'),
        knex.raw('(SELECT COUNT(*) FROM funnel_visits WHERE funnel_visits.funnel_id = funnels.id)::int as total_visits'),
      )
      .where('funnels.organization_id', auth.orgId)
      .orderBy('funnels.created_at', 'desc')
      .limit(100)

    return NextResponse.json({ ok: true, data: funnels })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to load funnels' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { name, steps } = body

    if (!name?.trim()) return NextResponse.json({ ok: false, error: 'Name is required' }, { status: 400 })
    if (!Array.isArray(steps) || steps.length === 0) return NextResponse.json({ ok: false, error: 'At least one step is required' }, { status: 400 })

    const validStepTypes = ['page', 'checkout', 'thank_you']
    for (const step of steps) {
      if (!validStepTypes.includes(step.stepType)) {
        return NextResponse.json({ ok: false, error: `stepType must be one of: ${validStepTypes.join(', ')}` }, { status: 400 })
      }
      if (step.stepOrder == null) {
        return NextResponse.json({ ok: false, error: 'Each step must have a stepOrder' }, { status: 400 })
      }
    }

    const baseSlug = slugify(name)
    const suffix = crypto.randomUUID().substring(0, 8)
    const slug = `${baseSlug}-${suffix}`
    const funnelId = crypto.randomUUID()
    const now = new Date()

    await knex('funnels').insert({
      id: funnelId,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      name: name.trim(),
      slug,
      is_published: false,
      created_at: now,
      updated_at: now,
    })

    for (const step of steps) {
      const stepId = crypto.randomUUID()
      await knex('funnel_steps').insert({
        id: stepId,
        funnel_id: funnelId,
        step_order: step.stepOrder,
        step_type: step.stepType,
        page_id: step.pageId || null,
        config: JSON.stringify(step.config || {}),
        created_at: now,
      })
    }

    const funnel = await knex('funnels').where('id', funnelId).first()
    const insertedSteps = await knex('funnel_steps').where('funnel_id', funnelId).orderBy('step_order', 'asc')

    return NextResponse.json({ ok: true, data: { ...funnel, steps: insertedSteps } }, { status: 201 })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to create funnel' }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 })

    const existing = await knex('funnels').where('id', id).where('organization_id', auth.orgId).first()
    if (!existing) return NextResponse.json({ ok: false, error: 'Funnel not found' }, { status: 404 })

    const body = await req.json()
    const updates: Record<string, unknown> = { updated_at: new Date() }
    if (body.name !== undefined) updates.name = body.name.trim()
    if (body.isPublished !== undefined) updates.is_published = body.isPublished

    await knex('funnels').where('id', id).where('organization_id', auth.orgId).update(updates)

    if (Array.isArray(body.steps)) {
      await knex('funnel_steps').where('funnel_id', id).delete()
      const now = new Date()
      for (const step of body.steps) {
        const stepId = crypto.randomUUID()
        await knex('funnel_steps').insert({
          id: stepId,
          funnel_id: id,
          step_order: step.stepOrder,
          step_type: step.stepType,
          page_id: step.pageId || null,
          config: JSON.stringify(step.config || {}),
          created_at: now,
        })
      }
    }

    const funnel = await knex('funnels').where('id', id).first()
    const steps = await knex('funnel_steps').where('funnel_id', id).orderBy('step_order', 'asc')
    return NextResponse.json({ ok: true, data: { ...funnel, steps } })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to update funnel' }, { status: 500 })
  }
}

export async function DELETE(req: Request) {
  const auth = await getAuthFromCookies()
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const id = url.searchParams.get('id')
    if (!id) return NextResponse.json({ ok: false, error: 'id query param required' }, { status: 400 })

    const existing = await knex('funnels').where('id', id).where('organization_id', auth.orgId).first()
    if (!existing) return NextResponse.json({ ok: false, error: 'Funnel not found' }, { status: 404 })

    await knex('funnels').where('id', id).where('organization_id', auth.orgId).delete()
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: false, error: 'Failed to delete funnel' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Funnels', summary: 'Funnel CRUD',
  methods: {
    GET: { summary: 'List all funnels with step count and visit stats', tags: ['Funnels'] },
    POST: { summary: 'Create a funnel with steps', tags: ['Funnels'] },
    PUT: { summary: 'Update a funnel by ?id=', tags: ['Funnels'] },
    DELETE: { summary: 'Delete a funnel by ?id=', tags: ['Funnels'] },
  },
}
