export const metadata = { POST: { requireAuth: true } }

import { NextResponse } from 'next/server'
import { createRequestContainer } from '@open-mercato/shared/lib/di/container'
import type { EntityManager } from '@mikro-orm/postgresql'
import crypto from 'crypto'

export async function POST(req: Request) {
  try {
    const container = await createRequestContainer()
    const knex = (container.resolve('em') as EntityManager).getKnex()
    const body = await req.json()
    const { email, courseSlug } = body

    if (!email?.trim()) return NextResponse.json({ ok: false, error: 'Email is required' }, { status: 400 })

    // Find course by slug to get org
    let organizationId: string | null = null
    if (courseSlug) {
      const course = await knex('courses').where('slug', courseSlug).where('is_published', true).whereNull('deleted_at').first()
      if (course) organizationId = course.organization_id
    }
    if (!organizationId) {
      // Fallback: find any enrollment for this email
      const enrollment = await knex('course_enrollments').where('student_email', email.trim().toLowerCase()).where('status', 'active').first()
      if (enrollment) organizationId = enrollment.organization_id
    }
    if (!organizationId) {
      // Don't reveal if email exists — always return success
      return NextResponse.json({ ok: true })
    }

    // Verify email has at least one active enrollment
    const hasEnrollment = await knex('course_enrollments')
      .where('student_email', email.trim().toLowerCase())
      .where('organization_id', organizationId)
      .where('status', 'active')
      .first()

    if (!hasEnrollment) {
      return NextResponse.json({ ok: true }) // Don't reveal
    }

    // Generate token
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) // 1 year (effectively perpetual)

    await knex('course_magic_tokens').insert({
      id: crypto.randomUUID(),
      organization_id: organizationId,
      email: email.trim().toLowerCase(),
      token,
      expires_at: expiresAt,
      created_at: new Date(),
    })

    // Send email with magic link
    const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const magicLink = `${origin}/api/courses/student/verify?token=${token}`

    // Try Resend first, then email router
    const resendKey = process.env.RESEND_API_KEY
    if (resendKey) {
      try {
        const { Resend } = await import('resend')
        const resend = new Resend(resendKey)
        await resend.emails.send({
          from: process.env.EMAIL_FROM || 'noreply@localhost',
          to: [email.trim()],
          subject: 'Your Course Access Link',
          html: `
            <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:32px">
              <h2 style="margin:0 0 8px;font-size:20px">Access Your Courses</h2>
              <p style="color:#64748b;font-size:14px;line-height:1.6;margin-bottom:24px">Click the button below to log in and access your enrolled courses.</p>
              <a href="${magicLink}" style="display:inline-block;background:#6366f1;color:white;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">Open My Courses</a>
              <p style="color:#94a3b8;font-size:12px;margin-top:24px">If you didn't request this, you can safely ignore this email.</p>
            </div>`,
        })
      } catch (err) {
        console.error('[magic-link] Resend failed', err)
      }
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error('[courses.student.magic-link]', error)
    return NextResponse.json({ ok: false, error: 'Failed' }, { status: 500 })
  }
}
