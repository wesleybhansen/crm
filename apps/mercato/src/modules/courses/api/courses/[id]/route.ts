import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['courses.view'] },
  PUT: { requireAuth: true, requireFeatures: ['courses.manage'] },
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const id = ctx.params?.id

    const course = await knex('courses').where('id', id).where('organization_id', auth.orgId).whereNull('deleted_at').first()
    if (!course) return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 })

    const modules = await knex('course_modules').where('course_id', id).orderBy('sort_order')
    for (const mod of modules) {
      mod.lessons = await knex('course_lessons').where('module_id', mod.id).orderBy('sort_order')
    }
    course.modules = modules

    const [{ count }] = await knex('course_enrollments').where('course_id', id).count()
    course.enrollment_count = Number(count)

    return NextResponse.json({ ok: true, data: course })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export async function PUT(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const id = ctx.params?.id
    const body = await req.json()

    const update: Record<string, any> = { updated_at: new Date() }
    if (body.title !== undefined) update.title = body.title
    if (body.description !== undefined) update.description = body.description
    if (body.price !== undefined) update.price = body.price
    if (body.isFree !== undefined) update.is_free = body.isFree
    if (body.isPublished !== undefined) update.is_published = body.isPublished

    // Add/update modules and lessons
    if (body.modules && Array.isArray(body.modules)) {
      for (let i = 0; i < body.modules.length; i++) {
        const mod = body.modules[i]
        if (mod.id) {
          await knex('course_modules').where('id', mod.id).update({ title: mod.title, description: mod.description, sort_order: i })
        } else {
          const modId = require('crypto').randomUUID()
          await knex('course_modules').insert({ id: modId, course_id: id, title: mod.title, description: mod.description || null, sort_order: i })
          mod.id = modId
        }

        if (mod.lessons && Array.isArray(mod.lessons)) {
          for (let j = 0; j < mod.lessons.length; j++) {
            const lesson = mod.lessons[j]
            if (lesson.id) {
              await knex('course_lessons').where('id', lesson.id).update({
                title: lesson.title, content: lesson.content || null, content_type: lesson.contentType || 'text',
                video_url: lesson.videoUrl || null, sort_order: j, drip_days: lesson.dripDays || null,
              })
            } else {
              await knex('course_lessons').insert({
                id: require('crypto').randomUUID(), module_id: mod.id,
                title: lesson.title, content: lesson.content || null, content_type: lesson.contentType || 'text',
                video_url: lesson.videoUrl || null, sort_order: j, drip_days: lesson.dripDays || null,
              })
            }
          }
        }
      }
    }

    await knex('courses').where('id', id).where('organization_id', auth.orgId).update(update)
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[courses.update]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Courses', summary: 'Course detail',
  methods: { GET: { summary: 'Get course with modules/lessons', tags: ['Courses'] }, PUT: { summary: 'Update course', tags: ['Courses'] } },
}
