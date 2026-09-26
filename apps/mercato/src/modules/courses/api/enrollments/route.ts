import { NextResponse } from 'next/server'
import { createPersonContact } from '@/modules/customers/lib/contact-write'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOrMergeContact } from '@/modules/customers/lib/dedup'
import { sendEnrollmentEmailOnce } from '../../lib/enrollment-email'

export const metadata = {
  GET: { requireAuth: true, requireFeatures: ['courses.view'] },
  POST: { requireAuth: false, rateLimit: { points: 10, duration: 60, blockDuration: 300, keyPrefix: 'courses-enroll' } }, // Public enrollment
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
    const { courseId, studentName, acceptedTerms } = body
    // Stored lowercase, like the paid path and the magic-link tokens: the
    // student's course access matches enrollments on the token's (lowercase)
    // email, so a capitalised address here locked the student out.
    const studentEmail = typeof body.studentEmail === 'string' ? body.studentEmail.trim().toLowerCase() : ''

    if (!courseId || !studentName || !studentEmail) {
      return NextResponse.json({ ok: false, error: 'courseId, studentName, studentEmail required' }, { status: 400 })
    }

    const course = await knex('courses').where('id', courseId).where('is_published', true).whereNull('deleted_at').first()
    if (!course) return NextResponse.json({ ok: false, error: 'Course not found' }, { status: 404 })

    // Validate terms acceptance if course has terms
    if (course.terms_text && acceptedTerms !== 'yes' && acceptedTerms !== true) {
      return NextResponse.json({ ok: false, error: 'You must accept the terms and conditions' }, { status: 400 })
    }

    // Check if already enrolled
    const existing = await knex('course_enrollments')
      .where('tenant_id', course.tenant_id).where('organization_id', course.organization_id)
      // lower(): older free enrollments were stored as typed.
      .where('course_id', courseId).whereRaw('lower(student_email) = ?', [studentEmail]).first()
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
      accepted_terms: !!(course.terms_text && (acceptedTerms === 'yes' || acceptedTerms === true)),
      accepted_terms_at: course.terms_text ? new Date() : null,
      status: 'active', enrolled_at: new Date(),
    })

    // Auto-create CRM contact (with dedup check). em enables encrypted-email
    // fallback so we don't create duplicates for ORM-written contacts.
    const em = container.resolve('em') as EntityManager
    const dedupResult = await findOrMergeContact(knex, course.organization_id, course.tenant_id, studentEmail, studentName, undefined, em)

    let contactId: string | null = dedupResult.existing?.id || null
    if (!dedupResult.existing) {
      contactId = await createPersonContact(em, {
        organizationId: course.organization_id, tenantId: course.tenant_id,
        displayName: studentName, primaryEmail: studentEmail, source: 'course', lifecycleStage: 'customer',
      }).catch(() => null)
    }

    // First-touch source attribution — only tag newly-created contacts.
    if (contactId && !dedupResult.existing) {
      try {
        const { tagContactSource } = await import('@open-mercato/core/modules/customers/lib/sourceTagging')
        await tagContactSource(knex, { tenantId: course.tenant_id, organizationId: course.organization_id }, contactId, 'course', course.title || course.slug)
      } catch {}
    }

    // Link contact to enrollment + log timeline
    if (contactId) {
      await knex('course_enrollments').where('id', id).update({ contact_id: contactId }).catch(() => {})
      const { logTimelineEvent } = await import('@/lib/timeline')
      await logTimelineEvent(knex, {
        tenantId: course.tenant_id, organizationId: course.organization_id, contactId,
        eventType: 'course_enrollment', title: `Enrolled in ${course.title}`,
        description: course.is_free ? 'Free enrollment' : `Paid — $${Number(course.price).toFixed(2)}`,
        metadata: { courseId: course.id },
      })
    }

    // Fire course.enrollment.created webhook. Courses module has no events.ts
    // so we dispatch inline rather than via the generic subscriber pattern.
    try {
      const { dispatchWebhook } = await import('@open-mercato/core/modules/webhooks/lib/dispatch')
      dispatchWebhook(knex, course.organization_id, 'course.enrollment.created', {
        enrollmentId: id,
        courseId: course.id,
        courseTitle: course.title,
        courseSlug: course.slug,
        contactId,
        studentName,
        studentEmail,
        isFree: !!course.is_free,
        price: course.price ? Number(course.price) : null,
        currency: course.currency,
      }).catch(() => {})
    } catch {}

    // Add "Student" tag
    if (contactId) {
      try {
        let tag = await knex('customer_tags').where('label', 'Student').where('organization_id', course.organization_id).first()
        if (!tag) {
          const tagId = require('crypto').randomUUID()
          await knex('customer_tags').insert({ id: tagId, tenant_id: course.tenant_id, organization_id: course.organization_id, label: 'Student', slug: 'student', created_at: new Date(), updated_at: new Date() })
          tag = { id: tagId }
        }
        const existingLink = await knex('customer_entity_tags').where('entity_id', contactId).where('tag_id', tag.id).first()
        if (!existingLink) {
          await knex('customer_entity_tags').insert({ id: require('crypto').randomUUID(), entity_id: contactId, tag_id: tag.id, created_at: new Date() })
        }
      } catch { /* non-critical */ }
    }

    // Auto-add to course mailing list
    if (contactId) {
      try {
        let courseList = await knex('email_lists')
          .where('source_type', 'course').where('source_id', course.id)
          .where('organization_id', course.organization_id).first()
        if (!courseList) {
          const listId = require('crypto').randomUUID()
          await knex('email_lists').insert({
            id: listId, tenant_id: course.tenant_id, organization_id: course.organization_id,
            name: `Course: ${course.title}`, source_type: 'course', source_id: course.id,
            member_count: 0, created_at: new Date(),
          })
          courseList = { id: listId }
        }
        await knex.raw('INSERT INTO email_list_members (id, list_id, contact_id, added_at, tenant_id, organization_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (list_id, contact_id) DO NOTHING',
          [require('crypto').randomUUID(), courseList.id, contactId, new Date(), course.tenant_id, course.organization_id])
        const [{ count }] = await knex('email_list_members').where('list_id', courseList.id).count()
        await knex('email_lists').where('id', courseList.id).update({ member_count: Number(count), updated_at: new Date() })
      } catch {}
    }

    // "Course Enrolled" automations and course-enrollment sequences, once per
    // enrollment (the paid paths in the Stripe webhook do the same).
    try {
      const { dispatchCourseEnrolled } = await import('@/modules/sequences/lib/automation-dispatch')
      await dispatchCourseEnrolled(knex, {
        organizationId: course.organization_id,
        tenantId: course.tenant_id,
        enrollmentId: id,
        courseId: course.id,
        contactId,
        courseTitle: course.title ?? null,
        paid: false,
      })
    } catch (err) {
      console.error('[courses.enrollments] course_enrolled automations failed (non-fatal)', err)
    }

    // "You're enrolled!" email with a magic link for instant access. Same
    // email and once-per-enrollment guard as the paid path (Stripe webhook).
    try {
      const { sendEmailByPurpose } = await import('@/modules/email/lib/email-router')
      await sendEnrollmentEmailOnce(knex, {
        enrollmentId: id,
        tenantId: course.tenant_id,
        organizationId: course.organization_id,
        studentEmail,
        courseTitle: course.title,
        contactId,
      }, { send: sendEmailByPurpose })
    } catch { /* non-blocking */ }

    return NextResponse.json({ ok: true, data: { id, enrolledAt: new Date() } }, { status: 201 })
  } catch (err) {
    console.error('[courses.enrollments.POST]', err)
    const detail = err instanceof Error ? err.message : 'Failed to enroll'
    return NextResponse.json({ ok: false, error: `Failed to enroll: ${detail}` }, { status: 500 })
  }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Courses', summary: 'Enrollments',
  methods: { GET: { summary: 'List enrollments', tags: ['Courses'] }, POST: { summary: 'Enroll in course (public)', tags: ['Courses'] } },
}
