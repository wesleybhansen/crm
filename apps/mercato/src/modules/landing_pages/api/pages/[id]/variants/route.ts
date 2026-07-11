import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { getAuthFromCookies } from '@open-mercato/shared/lib/auth/server'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['landing_pages.view'] },
  POST: { requireAuth: true, requireFeatures: ['landing_pages.edit'] },
  PATCH: { requireAuth: true, requireFeatures: ['landing_pages.edit'] },
  DELETE: { requireAuth: true, requireFeatures: ['landing_pages.edit'] },
}

const MISSING_TABLES_HINT = 'A/B testing tables are not provisioned yet. Apply scripts/sql/landing-ab-analytics.sql first.'

function isMissingRelation(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01' || (err as { code?: string })?.code === '42703'
}

async function loadScopedPage(knex: any, id: string, orgId: string) {
  return knex('landing_pages').where('id', id).where('organization_id', orgId).whereNull('deleted_at').first()
}

function clampWeight(value: unknown, fallback = 50): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(100, n))
}

export async function GET(req: Request, ctx: any) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const id = ctx?.params?.id

    const page = await loadScopedPage(knex, id, auth.orgId)
    if (!page) return NextResponse.json({ ok: false, error: 'Page not found' }, { status: 404 })

    const includeHtml = new URL(req.url).searchParams.get('includeHtml') === '1'
    let variants: any[] = []
    try {
      const columns = ['id', 'name', 'weight', 'status', 'view_count', 'submission_count', 'created_at', 'updated_at']
      if (includeHtml) columns.push('published_html')
      variants = await knex('landing_page_variants')
        .where('landing_page_id', page.id)
        .where('organization_id', auth.orgId)
        .orderBy('created_at', 'asc')
        .select(columns)
    } catch (err) {
      if (!isMissingRelation(err)) throw err
    }

    return NextResponse.json({
      ok: true,
      data: {
        abEnabled: !!page.ab_enabled,
        control: {
          viewCount: Number(page.view_count) || 0,
          submissionCount: Number(page.submission_count) || 0,
        },
        variants,
      },
    })
  } catch (error) {
    console.error('[landing_pages.variants.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to load variants' }, { status: 500 })
  }
}

export async function POST(req: Request, ctx: any) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const id = ctx?.params?.id
    const body = await req.json().catch(() => ({}))

    const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 100) : ''
    if (!name) return NextResponse.json({ ok: false, error: 'Variant name is required' }, { status: 400 })

    const page = await loadScopedPage(knex, id, auth.orgId)
    if (!page) return NextResponse.json({ ok: false, error: 'Page not found' }, { status: 404 })

    const variant = {
      id: require('crypto').randomUUID(),
      organization_id: page.organization_id,
      tenant_id: page.tenant_id,
      landing_page_id: page.id,
      name,
      // The variant starts as a copy of the current page (duplicate + edit).
      published_html: page.published_html ?? null,
      config: JSON.stringify(typeof page.config === 'string' ? JSON.parse(page.config || '{}') : (page.config ?? {})),
      weight: clampWeight(body?.weight),
      status: 'active',
      view_count: 0,
      submission_count: 0,
      created_at: new Date(),
      updated_at: new Date(),
    }

    try {
      await knex('landing_page_variants').insert(variant)
    } catch (err) {
      if (isMissingRelation(err)) return NextResponse.json({ ok: false, error: MISSING_TABLES_HINT }, { status: 409 })
      throw err
    }

    return NextResponse.json({ ok: true, data: { id: variant.id, name: variant.name, weight: variant.weight, status: variant.status } })
  } catch (error) {
    console.error('[landing_pages.variants.create]', error)
    return NextResponse.json({ ok: false, error: 'Failed to create variant' }, { status: 500 })
  }
}

export async function PATCH(req: Request, ctx: any) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const id = ctx?.params?.id
    const body = await req.json().catch(() => ({}))

    const page = await loadScopedPage(knex, id, auth.orgId)
    if (!page) return NextResponse.json({ ok: false, error: 'Page not found' }, { status: 404 })

    // Toggle the test on/off (no variantId in the payload).
    if (typeof body?.abEnabled === 'boolean' && !body?.variantId) {
      try {
        await knex('landing_pages').where('id', page.id).where('organization_id', auth.orgId).update({
          ab_enabled: body.abEnabled,
          updated_at: new Date(),
        })
      } catch (err) {
        if (isMissingRelation(err)) return NextResponse.json({ ok: false, error: MISSING_TABLES_HINT }, { status: 409 })
        throw err
      }
      return NextResponse.json({ ok: true, data: { abEnabled: body.abEnabled } })
    }

    const variantId = typeof body?.variantId === 'string' ? body.variantId : null
    if (!variantId) return NextResponse.json({ ok: false, error: 'variantId is required' }, { status: 400 })

    let variant: any = null
    try {
      variant = await knex('landing_page_variants')
        .where('id', variantId)
        .where('landing_page_id', page.id)
        .where('organization_id', auth.orgId)
        .first()
    } catch (err) {
      if (isMissingRelation(err)) return NextResponse.json({ ok: false, error: MISSING_TABLES_HINT }, { status: 409 })
      throw err
    }
    if (!variant) return NextResponse.json({ ok: false, error: 'Variant not found' }, { status: 404 })

    if (body?.action === 'promote') {
      // Promote winner: the variant's content becomes the main page, the test
      // is switched off, and the other arms are archived.
      await knex('landing_pages').where('id', page.id).where('organization_id', auth.orgId).update({
        published_html: variant.published_html ?? page.published_html,
        config: typeof variant.config === 'string' ? variant.config : JSON.stringify(variant.config ?? {}),
        ab_enabled: false,
        updated_at: new Date(),
      })
      await knex('landing_page_variants')
        .where('landing_page_id', page.id)
        .whereNot('id', variant.id)
        .update({ status: 'archived', updated_at: new Date() })
      await knex('landing_page_variants').where('id', variant.id).update({ status: 'promoted', updated_at: new Date() })
      return NextResponse.json({ ok: true, data: { promoted: variant.id } })
    }

    const update: Record<string, any> = { updated_at: new Date() }
    if (body?.weight !== undefined) update.weight = clampWeight(body.weight, Number(variant.weight) || 50)
    if (typeof body?.status === 'string' && ['active', 'paused', 'archived'].includes(body.status)) update.status = body.status
    if (typeof body?.name === 'string' && body.name.trim()) update.name = body.name.trim().slice(0, 100)
    if (typeof body?.publishedHtml === 'string') update.published_html = body.publishedHtml
    if (Object.keys(update).length === 1) {
      return NextResponse.json({ ok: false, error: 'Nothing to update' }, { status: 400 })
    }

    await knex('landing_page_variants').where('id', variant.id).update(update)
    const updated = await knex('landing_page_variants')
      .where('id', variant.id)
      .first('id', 'name', 'weight', 'status', 'view_count', 'submission_count')
    return NextResponse.json({ ok: true, data: updated })
  } catch (error) {
    console.error('[landing_pages.variants.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed to update variant' }, { status: 500 })
  }
}

export async function DELETE(req: Request, ctx: any) {
  const auth = await getAuthFromCookies()
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const id = ctx?.params?.id
    const body = await req.json().catch(() => ({}))
    const variantId = typeof body?.variantId === 'string' ? body.variantId : null
    if (!variantId) return NextResponse.json({ ok: false, error: 'variantId is required' }, { status: 400 })

    const page = await loadScopedPage(knex, id, auth.orgId)
    if (!page) return NextResponse.json({ ok: false, error: 'Page not found' }, { status: 404 })

    try {
      await knex('landing_page_variants')
        .where('id', variantId)
        .where('landing_page_id', page.id)
        .where('organization_id', auth.orgId)
        .delete()
    } catch (err) {
      if (isMissingRelation(err)) return NextResponse.json({ ok: false, error: MISSING_TABLES_HINT }, { status: 409 })
      throw err
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[landing_pages.variants.delete]', error)
    return NextResponse.json({ ok: false, error: 'Failed to delete variant' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Landing Pages',
  summary: 'A/B test variants',
  methods: {
    GET: { summary: 'List A/B variants for a page', tags: ['Landing Pages'] },
    POST: { summary: 'Create an A/B variant from the current page', tags: ['Landing Pages'] },
    PATCH: { summary: 'Update a variant, toggle the test, or promote a winner', tags: ['Landing Pages'] },
    DELETE: { summary: 'Delete a variant', tags: ['Landing Pages'] },
  },
}
