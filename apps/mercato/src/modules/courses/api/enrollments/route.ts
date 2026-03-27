import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOrMergeContact } from '../../../../app/api/contacts/dedup'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['courses.view'] },
  POST: { requireAuth: false }, // Public enrollment
}

export async function GET(req: Request, ctx: any) {
  const auth = ctx?.auth
  if (!auth?.orgId) return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const url = new URL(req.url)
    const courseId = url.searchParams.get('courseId')

    let query = knex('course_enrollments').where('organization_id', auth.orgId).orderBy('enrolled_at', 'desc')
    if (courseId) query = query.where('course_id', courseId)

    const enrollments = await query.limit(100)
    return NextResponse.json({ ok: true, data: enrollments })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { courseId, studentName, studentEmail } = body

    if (!courseId || !studentName || !studentEmail) {
      return NextResponse.json({ ok: false, error: 'courseId, studentName, studentEmail required' }, { status: 400 })
    }

    const course = await knex('courses').where('id', courseId).where('is_published', true).whereNull('deleted_at').first()
    if (!course) return NextResponse.json({ ok: false, error: 'Course not found' }, { status: 404 })

    // Check if already enrolled
    const existing = await knex('course_enrollments')
      .where('course_id', courseId).where('student_email', studentEmail).first()
    if (existing) return NextResponse.json({ ok: true, data: existing, message: 'Already enrolled' })

    // If course is paid and no payment, return checkout info
    if (!course.is_free && course.price > 0) {
      return NextResponse.json({
        ok: false,
        error: 'Payment required',
        requiresPayment: true,
        price: course.price,
        currency: course.currency,
      }, { status: 402 })
    }

    const id = require('crypto').randomUUID()
    await knex('course_enrollments').insert({
      id, tenant_id: course.tenant_id, organization_id: course.organization_id,
      course_id: courseId, student_name: studentName, student_email: studentEmail,
      status: 'active', enrolled_at: new Date(),
    })

    // Auto-create CRM contact (with dedup check)
    const dedupResult = await findOrMergeContact(knex, course.organization_id, course.tenant_id, studentEmail, studentName)

    if (!dedupResult.existing) {
      await knex('customer_entities').insert({
        id: require('crypto').randomUUID(),
        tenant_id: course.tenant_id, organization_id: course.organization_id,
        kind: 'person', display_name: studentName, primary_email: studentEmail,
        source: 'course', status: 'active', lifecycle_stage: 'customer',
        created_at: new Date(), updated_at: new Date(),
      }).catch(() => {})
    }

    return NextResponse.json({ ok: true, data: { id, enrolledAt: new Date() } }, { status: 201 })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Courses', summary: 'Enrollments',
  methods: { GET: { summary: 'List enrollments', tags: ['Courses'] }, POST: { summary: 'Enroll in course (public)', tags: ['Courses'] } },
}
