import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['courses.view'] },
  POST: { requireAuth: true, requireFeatures: ['courses.manage'] },
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()

    const courses = await knex('courses')
      .where('organization_id', auth.orgId).whereNull('deleted_at')
      .orderBy('created_at', 'desc')

    // Get enrollment counts
    for (const course of courses) {
      const [{ count }] = await knex('course_enrollments').where('course_id', course.id).count()
      course.enrollment_count = Number(count)
    }

    return NextResponse.json({ ok: true, data: courses })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export async function POST(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.tenantId || !auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { title, description, slug, price, isFree } = body

    if (!title || !slug) return NextResponse.json({ ok: false, error: 'title and slug required' }, { status: 400 })

    const id = require('crypto').randomUUID()
    await knex('courses').insert({
      id, tenant_id: auth.tenantId, organization_id: auth.orgId,
      title, description: description || null, slug,
      price: isFree ? null : (price || null), is_free: !!isFree,
      currency: 'USD', is_published: false,
      created_at: new Date(), updated_at: new Date(),
    })

    return NextResponse.json({ ok: true, data: { id } }, { status: 201 })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Courses', summary: 'Courses',
  methods: { GET: { summary: 'List courses', tags: ['Courses'] }, POST: { summary: 'Create course', tags: ['Courses'] } },
}
