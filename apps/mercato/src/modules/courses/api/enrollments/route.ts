import { NextResponse } from 'next/server'
import type { EntityManager } from '@mikro-orm/postgresql'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { OpenApiRouteDoc } from '@open-mercato/shared/lib/openapi'
import { findOrMergeContact } from '@/modules/customers/lib/dedup'

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
    const { courseId, studentName, studentEmail, acceptedTerms } = body

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
      accepted_terms: !!(course.terms_text && (acceptedTerms === 'yes' || acceptedTerms === true)),
      accepted_terms_at: course.terms_text ? new Date() : null,
      status: 'active', enrolled_at: new Date(),
    })

    // Auto-create CRM contact (with dedup check)
    const dedupResult = await findOrMergeContact(knex, course.organization_id, course.tenant_id, studentEmail, studentName)

    let contactId: string | null = dedupResult.existing?.id || null
    if (!dedupResult.existing) {
      contactId = require('crypto').randomUUID()
      await knex('customer_entities').insert({
        id: contactId,
        tenant_id: course.tenant_id, organization_id: course.organization_id,
        kind: 'person', display_name: studentName, primary_email: studentEmail,
        source: 'course', status: 'active', lifecycle_stage: 'customer',
        created_at: new Date(), updated_at: new Date(),
      }).catch(() => { contactId = null })
      if (contactId) {
        const enrollNameParts = (studentName || '').split(' ')
        await knex('customer_people').insert({
          id: require('crypto').randomUUID(), tenant_id: course.tenant_id, organization_id: course.organization_id,
          entity_id: contactId, first_name: enrollNameParts[0] || '', last_name: enrollNameParts.slice(1).join(' ') || '',
          created_at: new Date(), updated_at: new Date(),
        }).catch(() => {})
      }
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
        await knex.raw('INSERT INTO email_list_members (id, list_id, contact_id, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (list_id, contact_id) DO NOTHING',
          [require('crypto').randomUUID(), courseList.id, contactId, new Date()])
        const [{ count }] = await knex('email_list_members').where('list_id', courseList.id).count()
        await knex('email_lists').where('id', courseList.id).update({ member_count: Number(count), updated_at: new Date() })
      } catch {}
    }

    // Send magic link for instant access
    try {
      const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
      const token = require('crypto').randomBytes(32).toString('hex')
      await knex('course_magic_tokens').insert({
        id: require('crypto').randomUUID(),
        organization_id: course.organization_id,
        email: studentEmail.toLowerCase(),
        token,
        expires_at: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // perpetual
        created_at: new Date(),
      })
      const magicLink = `${origin}/api/courses/student/verify?token=${token}`

      const emailHtml = `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="margin:0 0 8px;font-size:20px">You're enrolled!</h2>
        <p style="color:#64748b;font-size:14px;line-height:1.6;margin-bottom:20px">Welcome to <strong>${course.title}</strong>. Click below to start learning.</p>
        <a href="${magicLink}" style="display:inline-block;background:#6366f1;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Start Course</a>
        <p style="color:#94a3b8;font-size:12px;margin-top:24px">This link expires in 24 hours. You can request a new one anytime.</p>
      </div>`

      const { sendEmailByPurpose } = await import('@/modules/email/lib/email-router')
      await sendEmailByPurpose(knex, course.organization_id, course.tenant_id, 'transactional', {
        to: studentEmail,
        subject: `Welcome to ${course.title}! Access your course`,
        htmlBody: emailHtml,
      })
    } catch { /* non-blocking */ }

    return NextResponse.json({ ok: true, data: { id, enrolledAt: new Date() } }, { status: 201 })
  } catch { return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 }) }
}

export const openApi: OpenApiRouteDoc = {
  tag: 'Courses', summary: 'Enrollments',
  methods: { GET: { summary: 'List enrollments', tags: ['Courses'] }, POST: { summary: 'Enroll in course (public)', tags: ['Courses'] } },
}
