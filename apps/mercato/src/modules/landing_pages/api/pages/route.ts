import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import { createLandingPageSchema, listLandingPagesSchema } from '../../data/validators'
import { TemplateEngine } from '../../services/template-engine'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { normalizeAuthorUserId } from '@open-mercato/shared/lib/commands/helpers'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['landing_pages.view'] },
  POST: { requireAuth: true, requireFeatures: ['landing_pages.create'] },
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const url = new URL(req.url)
    const query = listLandingPagesSchema.parse(Object.fromEntries(url.searchParams))

    let q = knex('landing_pages')
      .where('tenant_id', auth.tenantId)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')

    if (query.status) q = q.where('status', query.status)
    if (query.search) {
      q = q.where(function() {
        this.where('title', 'ilike', `%${query.search}%`).orWhere('slug', 'ilike', `%${query.search}%`)
      })
    }

    const [{ count: total }] = await q.clone().count()
    const pages = await q
      .select('*')
      .orderBy(query.sort || 'created_at', query.order || 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)

    return NextResponse.json({
      ok: true,
      data: pages,
      pagination: { page: query.page, pageSize: query.pageSize, total: Number(total), totalPages: Math.ceil(Number(total) / query.pageSize) },
    })
  } catch (error) {
    console.error('[landing_pages.list]', error)
    return NextResponse.json({ ok: false, error: 'Failed to list pages' }, { status: 500 })
  }
}

export async function POST(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const container = await createRequestContainer()
    const em = container.resolve('em') as EntityManager
    const knex = em.getKnex()
    const body = await req.json()
    const parsed = createLandingPageSchema.parse(body)

    const existing = await knex('landing_pages')
      .where('slug', parsed.slug)
      .where('organization_id', auth.orgId)
      .whereNull('deleted_at')
      .first()
    if (existing) {
      return NextResponse.json({ ok: false, error: 'A page with this slug already exists' }, { status: 409 })
    }

    const id = require('crypto').randomUUID()
    const now = new Date()

    await knex('landing_pages').insert({
      id,
      tenant_id: auth.tenantId,
      organization_id: auth.orgId,
      title: parsed.title,
      slug: parsed.slug,
      template_id: parsed.templateId || null,
      template_category: parsed.templateCategory || null,
      config: parsed.config ? JSON.stringify(parsed.config) : null,
      status: 'draft',
      owner_user_id: normalizeAuthorUserId(null, auth),
      view_count: 0,
      submission_count: 0,
      created_at: now,
      updated_at: now,
    })

    // Create default form if template has one
    if (parsed.templateId) {
      const engine = new TemplateEngine()
      const templates = engine.listTemplates()
      const tmpl = templates.find((t) => t.id === parsed.templateId)
      if (tmpl?.hasForm) {
        await knex('landing_page_forms').insert({
          id: require('crypto').randomUUID(),
          tenant_id: auth.tenantId,
          organization_id: auth.orgId,
          landing_page_id: id,
          name: 'default',
          fields: JSON.stringify([
            { name: 'name', type: 'text', label: 'Name', required: true, placeholder: 'Your name' },
            { name: 'email', type: 'email', label: 'Email', required: true, placeholder: 'you@example.com' },
          ]),
          success_message: 'Thank you! We\'ll be in touch.',
          created_at: now,
          updated_at: now,
        })
      }
    }

    const page = await knex('landing_pages').where('id', id).first()
    return NextResponse.json({ ok: true, data: page }, { status: 201 })
  } catch (error) {
    console.error('[landing_pages.create]', error)
    const detail = error instanceof Error ? error.message : 'Failed to create page'
    return NextResponse.json({ ok: false, error: `Failed to create page: ${detail}` }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Landing Pages',
  summary: 'Landing page management',
  methods: {
    GET: { summary: 'List landing pages', tags: ['Landing Pages'] },
    POST: { summary: 'Create a landing page', tags: ['Landing Pages'] },
  },
}
